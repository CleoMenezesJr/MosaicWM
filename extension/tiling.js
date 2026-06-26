// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Core mosaic tiling algorithm and layout management

import Clutter from 'gi://Clutter'; // Used for Enums (AnimationMode, etc)
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import * as WindowState from './windowState.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    MINIATURE_TARGET_POS,
    MINIATURE_EXT_LEFT,
    MINIATURE_EXT_TOP,
    MINIATURE_OVERLAY,
    ANIMATING_MINIATURE,
} from './windowState.js';
import { getMiniatureSize, applyMiniatureActorState, animateMiniatureToTarget } from './miniature.js';
import { isWindowAlive } from './liveness.js';
import { getSlowDownFactor } from './timing.js';

const POSITION_STABILITY_WEIGHT = 40;
// High enough to beat the other terms combined (they max out at 140), so
// keeping a window's column/shelf wins unless that option would overflow.
const GROUP_STABILITY_WEIGHT = 150;

// Keyed by window ID internally to survive GI reference churn; API mirrors WeakMap
const _computedLayouts = new Map();
export const ComputedLayouts = {
    get(mw) {
        const id = mw?.get_id?.();
        return id !== undefined ? _computedLayouts.get(id) : undefined;
    },
    set(mw, layout) {
        const id = mw?.get_id?.();
        if (id !== undefined) _computedLayouts.set(id, layout);
    },
    delete(mw) { const id = mw?.get_id?.(); if (id !== undefined) _computedLayouts.delete(id); },
    deleteById(id) { _computedLayouts.delete(id); },
    clear() { _computedLayouts.clear(); },
};

export const TilingManager = GObject.registerClass({
    GTypeName: 'MosaicTilingManager',
    Signals: {
        'mosaic-changed': { param_types: [GObject.TYPE_OBJECT] }, // Emitted when layout changes (param: workspace)
    },
}, class TilingManager extends GObject.Object {
    _init(_extension) {
        super._init();
        this.masks = new Set();
        this.tmp_swap = [];
        this.isDragging = false;
        this.dragRemainingSpace = null;
        
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
        this._extension = null;
        
        // Flag to block overflow decisions during smart resize
        this._isSmartResizingBlocked = false;
        // Window ID being restored from miniature; shields it from the overflow handler
        this._restoringWindowId = null;

        // Layout cache to avoid redundant O(n!) permutation calculations
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
        this._lastTiledOrder = null;
        // windowId -> levelIndex from the last committed tile pass
        this._lastGroupAssignment = null;
        this._skipStabilityForNextTile = false;

        // Swap/reorder operations live per workspace, keyed by Meta.Workspace via WeakMap
        // to avoid monkey-patching native GObjects (same reason windowState.js exists).
        this._workspaceSwaps = new WeakMap();
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }
    
    setExtension(extension) {
        this._extension = extension;
    }

    setDrawingManager(manager) {
        this._drawingManager = manager;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    // Smart Resize sites only ever change width/height at the window's current
    // position, so x/y always come from the frame already read at the call site.
    // A first placement window doesn't have a real position yet, only wherever
    // Mutter happened to spawn it, so applying that here would move_resize_frame
    // it to that meaningless spot.
    //
    // deferToRetile: tryFitWithResize and rebalanceSmartResize both call this and
    // then immediately call tileWorkspaceWindows in the same tick, which does its
    // own move_resize_frame combining the same size with the window's real tiled
    // position. Animating here too means two separate Wayland geometry requests
    // for the same window back to back: the first commit shows the resize at the
    // old spot, the second shows the push, reading as two sequential animations
    // instead of one. Skip the actual move+ease here and let that next pass be
    // the only one that touches the frame, since it already has the right size
    // (read from targetSmartResizeSize, set independently of this call).
    _animateResize(window, frame, width, height, deferToRetile = false) {
        if (deferToRetile || WindowState.get(window, 'pendingFirstPlacement')) return;
        this._animationsManager?.animateWindow(window, { x: frame.x, y: frame.y, width, height });
    }

    // Whichever window happens to be "newWindow" for a given tryFitWithResize call
    // isn't necessarily the most recently opened one - a sibling's miniature-restore
    // runs its own pass with itself as newWindow. addedTime is the one signal that
    // survives regardless of who's driving the current call.
    _isRecentlyAdded(window) {
        const addedTime = WindowState.get(window, 'addedTime');
        return !!addedTime && (Date.now() - addedTime) < constants.NEW_WINDOW_MINIATURIZE_PROTECTION_MS;
    }

    setWindowingManager(manager) {
        this._windowingManager = manager;
    }

    // Effective size: pending async sizes → frame rect → saved sizes → fallback
    getEffectiveWindowSize(window) {
        const miniSize = getMiniatureSize(window);
        if (miniSize) return miniSize;

        const smartSize = WindowState.get(window, 'targetSmartResizeSize');
        if (smartSize) {
            return { width: smartSize.width, height: smartSize.height };
        }

        const restoredSize = WindowState.get(window, 'targetRestoredSize');
        if (restoredSize) {
            return { width: restoredSize.width, height: restoredSize.height };
        }

        const frame = window.get_frame_rect();
        if (frame.width > 0 && frame.height > 0) {
            return { width: frame.width, height: frame.height };
        }

        const preferred = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
        if (preferred) {
            return { width: preferred.width, height: preferred.height };
        }

        // Final fallback (should rarely happen for managed windows)
        return {
            width: constants.SMART_RESIZE_MIN_WINDOW_WIDTH,
            height: constants.SMART_RESIZE_MIN_WINDOW_HEIGHT,
        };
    }

    // Native minimum size via Mutter 50+ get_min_size(), with fallback.
    // Also checks cached actual minimums discovered from client-side clamping
    // (e.g., libadwaita apps report 100px via get_min_size but enforce 360px).
    getWindowMinimumSize(window) {
        let baseW = constants.SMART_RESIZE_MIN_WINDOW_WIDTH;
        let baseH = constants.SMART_RESIZE_MIN_WINDOW_HEIGHT;

        if (window.get_min_size) {
            const [hasHint, minW, minH] = window.get_min_size();
            if (hasHint) {
                baseW = Math.max(minW, baseW);
                baseH = Math.max(minH, baseH);
            }
        }

        const actualMinW = WindowState.get(window, 'actualMinWidth');
        const actualMinH = WindowState.get(window, 'actualMinHeight');
        if (actualMinW) baseW = Math.max(actualMinW, baseW);
        if (actualMinH) baseH = Math.max(actualMinH, baseH);

        return { width: baseW, height: baseH };
    }

    // Native maximum size via Mutter 50+ get_max_size()
    getWindowMaximumSize(window) {
        if (window.get_max_size) {
            const [hasHint, maxW, maxH] = window.get_max_size();
            if (hasHint && maxW > 0 && maxH > 0)
                return { width: maxW, height: maxH };
        }
        return null;
    }

    // Check if a window is already at (or below) its minimum size
    isWindowAtMinimum(window, tolerance = 10) {
        const currentSize = this.getEffectiveWindowSize(window);
        const minSize = this.getWindowMinimumSize(window);
        return currentSize.width <= minSize.width + tolerance &&
               currentSize.height <= minSize.height + tolerance;
    }

    // Try gain factors from 1.0→0.1 and return the best one that fits without overflow
    findBestRestorationGain(windows, shrunkWindows, workArea) {
        for (let gainFactor = 1.0; gainFactor >= 0.1; gainFactor -= 0.1) {
            const simulatedWindows = windows.map(w => {
                const shrunk = shrunkWindows.find(sw => sw.id === w.get_id());
                if (!shrunk) {
                    // Miniatures sit at their scaled slot size, so use getMiniatureSize to match WindowDescriptor.
                    const miniSize = getMiniatureSize(w);
                    if (miniSize) return { id: w.get_id(), width: miniSize.width, height: miniSize.height };
                    // Use targetSmartResizeSize when present since WindowDescriptor uses the same
                    // value during actual tiling, and diverging here would make simulations inconsistent.
                    const smartResizeSize = WindowState.get(w, 'targetSmartResizeSize');
                    if (smartResizeSize)
                        return { id: w.get_id(), width: smartResizeSize.width, height: smartResizeSize.height };
                    const f = w.get_frame_rect();
                    return { id: w.get_id(), width: f.width, height: f.height };
                }

                const f = w.get_frame_rect();
                let nw = Math.floor(f.width + (shrunk.widthDeficit * gainFactor));
                let nh = Math.floor(f.height + (shrunk.heightDeficit * gainFactor));

                // Clamp to opening size and native maximum
                nw = Math.min(nw, shrunk.openingWidth);
                nh = Math.min(nh, shrunk.openingHeight);
                const maxSize = this.getWindowMaximumSize(w);
                if (maxSize) {
                    nw = Math.min(nw, maxSize.width);
                    nh = Math.min(nh, maxSize.height);
                }

                return { id: w.get_id(), width: nw, height: nh };
            });

            const tile_result = this._tile(simulatedWindows, workArea, true);
            if (!tile_result.overflow) {
                Logger.log(`findBestRestorationGain: Found workable factor ${gainFactor.toFixed(1)}`);
                return { gain: gainFactor, layout: simulatedWindows };
            }
        }
        return null;
    }

    createMask(window) {
        const id = window.id !== undefined ? window.id : (window.get_id ? window.get_id() : null);
        if (id !== null) {
            this.masks.add(id);
        }
    }

    destroyMasks() {
        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }
        // Clear logical masks only when not dragging; recycle boxes otherwise.
        if (!this.isDragging) {
            this.masks.clear();
        }
    }

    getMask(window) {
        const id = window.id !== undefined ? window.id : (window.get_id ? window.get_id() : null);
        if(id !== null && this.masks.has(id))
            return new Mask(window);
        return window;
    }

    enableDragMode(remainingSpace = null) {
        this.isDragging = true;
        this.dragRemainingSpace = remainingSpace;
    }

    disableDragMode() {
        this.isDragging = false;
        this.dragRemainingSpace = null;
        this.invalidateLayoutCache();
    }

    setDragRemainingSpace(space) {
        this.dragRemainingSpace = space;
    }

    clearDragRemainingSpace() {
        this.dragRemainingSpace = null;
    }
    
    setExcludedWindow(window) {
        this._excludedWindow = window;
    }
    
    clearExcludedWindow() {
        this._excludedWindow = null;
    }
    
    // Invalidate the layout cache when windows change
    invalidateLayoutCache() {
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
    }
    
    // Get the cached layout result (array of {id, x, y, width, height})
    getCachedLayout() {
        return this._cachedTileResult?.windows || null;
    }

    // Extract per-window positions from tile_info levels
    _extractLayoutPositions(tile_info, work_area) {
        const positions = [];

        if (!tile_info.vertical) {
            let y = tile_info.y;
            for (const level of tile_info.levels) {
                let x = level.x;
                for (const win of level.windows) {
                    const center_offset = (work_area.height / 2 + work_area.y) - (y + win.height / 2);
                    let y_offset = 0;
                    if (center_offset > 0)
                        y_offset = Math.min(center_offset, level.height - win.height);

                    positions.push({ id: win.id, x: x, y: y + y_offset, width: win.width, height: win.height });
                    x += win.width + constants.WINDOW_SPACING;
                }
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = tile_info.x;
            for (const level of tile_info.levels) {
                let y = level.y;
                for (const win of level.windows) {
                    const drawX = win.targetX !== undefined ? win.targetX : x;
                    const drawY = win.targetY !== undefined ? win.targetY : y;

                    positions.push({ id: win.id, x: drawX, y: drawY, width: win.width, height: win.height });
                    y += win.height + constants.WINDOW_SPACING;
                }
                x += level.width + constants.WINDOW_SPACING;
            }
        }

        return positions;
    }

    // Pre-compute all valid mosaic layouts for a drag session
    computeDragLayouts(windowDescriptors, workArea, draggedId) {
        const spacing = constants.WINDOW_SPACING;

        let maxHeight = 0, maxWidth = 0;
        for (const w of windowDescriptors) {
            maxHeight = Math.max(maxHeight, w.height);
            maxWidth = Math.max(maxWidth, w.width);
        }
        const isNarrow = workArea.width < workArea.height;
        const tooWide = maxWidth > workArea.width * 0.9;
        const tooTall = maxHeight > workArea.height * 0.65;
        const useVertical = tooTall || isNarrow || tooWide;
        const tilingFn = useVertical ? this._verticalShelves : this._horizontalShelves;

        const perms = this._generatePermutations(windowDescriptors);
        const layouts = [];
        const seenPositions = new Set();

        for (const perm of perms) {
            const result = tilingFn.call(this, perm, workArea, spacing);
            if (result.overflow) continue;

            const positions = this._extractLayoutPositions(result, workArea);
            const draggedPos = positions.find(p => p.id === draggedId);
            if (!draggedPos) continue;

            // De-duplicate by 50px grid snap
            const snapKey = `${Math.round(draggedPos.x / 50)},${Math.round(draggedPos.y / 50)}`;
            if (seenPositions.has(snapKey)) continue;
            seenPositions.add(snapKey);

            layouts.push({
                draggedRect: draggedPos,
                positions: positions,
                permOrder: perm.map(w => w.id)
            });
        }

        Logger.log(`computeDragLayouts: ${perms.length} permutations → ${layouts.length} unique positions for window ${draggedId}`);
        return layouts;
    }

    // Compute which windows would be miniaturized and at what slot positions
    // when the remaining space triggers overflow. Used to preview the mini layout.
    // Returns [{win, slot, scale}] for the windows that must be miniaturized.
    computePreviewMiniSlots(mosaicWindows, remainingSpace) {
        if (!mosaicWindows.length || !remainingSpace) return [];

        const miniTarget = constants.MINIATURE_TARGET_SIZE_PX;
        const sorted = [...mosaicWindows].sort((a, b) => {
            const fa = a.get_frame_rect();
            const fb = b.get_frame_rect();
            return (fa.width * fa.height) - (fb.width * fb.height);
        });

        const miniIds = new Set();
        let lastTileResult = null;

        for (const candidate of sorted) {
            miniIds.add(candidate.get_id());

            const descriptors = mosaicWindows.map((w, i) => {
                if (miniIds.has(w.get_id())) {
                    const f = w.get_frame_rect();
                    const s = miniTarget / Math.max(f.width, f.height);
                    return { index: i, id: w.get_id(), width: Math.round(f.width * s), height: Math.round(f.height * s) };
                }
                const f = w.get_frame_rect();
                return { index: i, id: w.get_id(), width: f.width, height: f.height };
            });

            lastTileResult = this._tile(descriptors, remainingSpace, true);
            if (!lastTileResult.overflow) break;
        }

        if (!lastTileResult) return [];

        const allPositions = this._extractLayoutPositions(lastTileResult, remainingSpace);
        return allPositions
            .filter(pos => miniIds.has(pos.id))
            .map(pos => {
                const win = mosaicWindows.find(w => w.get_id() === pos.id);
                if (!win) return null;
                const f = win.get_frame_rect();
                const scale = miniTarget / Math.max(f.width, f.height);
                return { win, slot: pos, scale };
            })
            .filter(Boolean);
    }

    // Apply a pre-computed layout during drag
    applyDragLayout(positions, workspace, monitor) {
        const meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }

        for (const pos of positions) {
            const isMask = this.masks.has(pos.id);

            if (isMask) {
                if (this._drawingManager) {
                    this._drawingManager.rect(pos.x, pos.y, pos.width, pos.height);
                }
            } else {
                const window = meta_windows.find(w => w.get_id() === pos.id);
                if (!window) continue;

                if (WindowState.get(window, IS_MINIATURE)) {
                    const actor = window.get_compositor_private();
                    if (actor && !actor.is_destroyed()) {
                        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
                        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                        animateMiniatureToTarget(actor, window, sc, extL, extT, pos.x, pos.y,
                            constants.ANIMATION_DURATION_MS);
                        WindowState.get(window, MINIATURE_OVERLAY)?.animateToPosition(constants.ANIMATION_DURATION_MS);
                    }
                    // MosaicLayoutStrategy reads ComputedLayouts for the overview slot, so keep it in sync.
                    ComputedLayouts.set(window, { x: pos.x, y: pos.y, width: pos.width, height: pos.height });
                    continue;
                }

                const currentRect = window.get_frame_rect();
                const posChanged = Math.abs(currentRect.x - pos.x) > 5 || Math.abs(currentRect.y - pos.y) > 5;
                const sizeChanged = Math.abs(currentRect.width - pos.width) > 5 || Math.abs(currentRect.height - pos.height) > 5;

                if (posChanged || sizeChanged) {
                    WindowState.set(window, 'isConstrainedByMosaic', true);
                    window.move_resize_frame(false, pos.x, pos.y, pos.width, pos.height);
                    const actor = window.get_compositor_private();
                    if (actor && !actor.is_destroyed()) {
                        actor.set_translation(currentRect.x - pos.x, currentRect.y - pos.y, 0);
                        actor.ease({
                            translation_x: 0,
                            translation_y: 0,
                            opacity: 255,
                            duration: Math.ceil(constants.ANIMATION_DURATION_MS * getSlowDownFactor()),
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD
                        });
                    }
                }
            }
        }
    }

    // Stage a pairwise swap to be applied on the next workspace tile.
    // No-op if the same pair was just staged in reverse order (toggle protection).
    setTmpSwap(id1, id2) {
        if (id1 === id2 || (this.tmp_swap[0] === id2 && this.tmp_swap[1] === id1))
            return;
        this.tmp_swap = [id1, id2];
    }

    clearTmpSwap() {
        this.tmp_swap = [];
    }

    applyTmpSwap(workspace) {
        if (!this._workspaceSwaps.has(workspace))
            this._workspaceSwaps.set(workspace, []);

        if (this.tmp_swap.length !== 0)
            this._workspaceSwaps.get(workspace).push(this.tmp_swap);
    }

    applySwaps(workspace, array) {
        const swaps = this._workspaceSwaps.get(workspace);
        if (!swaps || swaps.length === 0) return;

        const getId = w => w.id !== undefined ? w.id : w.get_id();
        for (const op of swaps) {
            if (Array.isArray(op) && op[0] === 'order') {
                const order = op[1];
                array.sort((a, b) => {
                    const idxA = order.indexOf(getId(a));
                    const idxB = order.indexOf(getId(b));
                    return (idxA === -1 ? Infinity : idxA) - (idxB === -1 ? Infinity : idxB);
                });
            } else {
                this._swapElements(array, op[0], op[1]);
            }
        }

        // Compact to a single order op, since replaying all swaps per tile grows unbounded over a session.
        if (swaps.length > constants.SWAP_OPS_COMPACT_THRESHOLD) {
            this._workspaceSwaps.set(workspace, [['order', array.map(getId)]]);
        }
    }

    applyTmp(array) {
        if(this.tmp_swap.length !== 0) {
            this._swapElements(array, this.tmp_swap[0], this.tmp_swap[1]);
        }
    }

    applyOrderOp(workspace, permOrder) {
        if (!this._workspaceSwaps.has(workspace))
            this._workspaceSwaps.set(workspace, []);
        const swaps = this._workspaceSwaps.get(workspace);
        const filtered = swaps.filter(op => !(Array.isArray(op) && op[0] === 'order'));
        filtered.push(['order', permOrder]);
        this._workspaceSwaps.set(workspace, filtered);
        // Pre-drag positions still in snapshot next call; stability heuristic would revert this order.
        this._skipStabilityForNextTile = true;
    }

    _swapElements(array, id1, id2) {
        const index1 = array.findIndex(w => w.id === id1);
        const index2 = array.findIndex(w => w.id === id2);
        
        if (index1 === -1 || index2 === -1)
            return;
        
        const tmp = array[index1];
        array[index1] = array[index2];
        array[index2] = tmp;
    }

    checkValidity(monitor, workspace, window, strict) {
        if (monitor !== null &&
            window.wm_class !== null &&
            isWindowAlive(window) &&
            workspace.list_windows().length !== 0 &&
            (strict ? !window.is_hidden() : !window.minimized)
        ) {
            return true;
        } else {
            return false;
        }
    }

    _createDescriptor(meta_window, monitor, index, reference_window) {
        if(reference_window)
            if(meta_window.get_id() === reference_window.get_id())
                return new WindowDescriptor(meta_window, index);
        
        if( this._windowingManager.isExcluded(meta_window) ||
            meta_window.get_monitor() !== monitor ||
            this._windowingManager.isMaximizedOrFullscreen(meta_window))
            return false;
        return new WindowDescriptor(meta_window, index);
    }

    windowsToDescriptors(meta_windows, monitor, reference_window) {
        const descriptors = [];
        for(let i = 0; i < meta_windows.length; i++) {
            const descriptor = this._createDescriptor(meta_windows[i], monitor, i, reference_window);
            if(descriptor)
                descriptors.push(descriptor);
        }
        return descriptors;
    }

    // Generate limited permutations for performance
    _generatePermutations(arr, maxPermutations = 120) {
        if (arr.length <= 1) return [arr];
        if (arr.length === 2) return [arr, [arr[1], arr[0]]];
        
        // Use heuristic orderings for 6+ windows
        if (arr.length >= 6) {
            const byAreaDesc = [...arr].sort((a, b) => (b.width * b.height) - (a.width * a.height));
            const byAreaAsc = [...arr].sort((a, b) => (a.width * a.height) - (b.width * b.height));
            const byWidthDesc = [...arr].sort((a, b) => b.width - a.width);
            const byHeightDesc = [...arr].sort((a, b) => b.height - a.height);
            const candidates = [arr, byAreaDesc, byAreaAsc, byWidthDesc, byHeightDesc];
            if (this._positionSnapshot) {
                const byPosX = [...arr].sort((a, b) => {
                    const sa = this._positionSnapshot.get(a.id);
                    const sb = this._positionSnapshot.get(b.id);
                    return (sa?.cx ?? 0) - (sb?.cx ?? 0);
                });
                candidates.push(byPosX);
            }
            return candidates;
        }
        
        // Generate all permutations using Heap's algorithm
        const result = [];
        const heap = (n, arr) => {
            if (n === 1) {
                result.push([...arr]);
                return;
            }
            for (let i = 0; i < n; i++) {
                heap(n - 1, arr);
                if (result.length >= maxPermutations) return;
                if (n % 2 === 0) {
                    [arr[i], arr[n - 1]] = [arr[n - 1], arr[i]];
                } else {
                    [arr[0], arr[n - 1]] = [arr[n - 1], arr[0]];
                }
            }
        };
        heap(arr.length, [...arr]);
        return result;
    }

    // Score a layout result - higher is better
    // Prioritizes: no overflow, compactness, centralization
    _scoreLayout(tileResult, workArea) {
        if (!tileResult || tileResult.overflow) return -Infinity;
        
        // Calculate bounding box of all windows
        let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
        let totalArea = 0;
        
        for (const level of tileResult.levels) {
            for (const w of level.windows) {
                const x = w.targetX || level.x;
                const y = w.targetY || level.y;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + w.width);
                maxY = Math.max(maxY, y + w.height);
                totalArea += w.width * w.height;
            }
        }
        
        if (minX === Infinity) return -Infinity;
        
        const bboxWidth = maxX - minX;
        const bboxHeight = maxY - minY;
        const bboxArea = bboxWidth * bboxHeight;
        
        // Score components
        // 1. Compactness: ratio of window area to bounding box area (0-1)
        const compactness = totalArea / Math.max(bboxArea, 1);
        
        // 2. Centralization: how close is the bbox center to workArea center
        const bboxCenterX = minX + bboxWidth / 2;
        const bboxCenterY = minY + bboxHeight / 2;
        const workCenterX = workArea.x + workArea.width / 2;
        const workCenterY = workArea.y + workArea.height / 2;
        const centerDist = Math.sqrt(
            Math.pow(bboxCenterX - workCenterX, 2) + 
            Math.pow(bboxCenterY - workCenterY, 2)
        );
        const maxDist = Math.sqrt(Math.pow(workArea.width, 2) + Math.pow(workArea.height, 2)) / 2;
        const centralization = 1 - (centerDist / maxDist);
        
        // 3. Size efficiency: smaller bounding box is better
        const sizeEfficiency = 1 - (bboxArea / (workArea.width * workArea.height));
        
        // Weighted score (compactness is most important)
        let score = compactness * 50 + centralization * 30 + sizeEfficiency * 20;

        // Position stability: prefer permutations where windows stay close to current positions
        if (this._positionSnapshot) {
            let totalDisp = 0;
            let count = 0;
            for (const level of tileResult.levels) {
                for (const w of level.windows) {
                    const snap = this._positionSnapshot.get(w.id);
                    if (!snap) continue;
                    const px = (w.targetX ?? level.x) + w.width / 2;
                    const py = (w.targetY ?? level.y) + w.height / 2;
                    totalDisp += Math.hypot(px - snap.cx, py - snap.cy);
                    count++;
                }
            }
            if (count > 0) {
                const maxDiag = Math.hypot(workArea.width, workArea.height);
                const normalized = Math.min(1, totalDisp / (count * maxDiag));
                score += (1 - normalized) * POSITION_STABILITY_WEIGHT;
            }
        }

        // Grouping stability: prefer permutations where windows stay in the same column/shelf as last time
        if (this._lastGroupAssignment) {
            let regrouped = 0;
            let trackedCount = 0;
            for (let levelIdx = 0; levelIdx < tileResult.levels.length; levelIdx++) {
                for (const w of tileResult.levels[levelIdx].windows) {
                    const prevLevelIdx = this._lastGroupAssignment.get(w.id);
                    if (prevLevelIdx === undefined) continue;
                    trackedCount++;
                    if (prevLevelIdx !== levelIdx) regrouped++;
                }
            }
            if (trackedCount > 0) {
                const regroupedFraction = regrouped / trackedCount;
                score += (1 - regroupedFraction) * GROUP_STABILITY_WEIGHT;
            }
        }

        return score;
    }

    // Find optimal ordering via permutations (with stability bonus for current order)
    _findOptimalOrder(windows, workArea, tilingFn) {
        if (windows.length <= 1) return windows;

        const startTime = Date.now();
        const permutations = this._generatePermutations(windows);
        const currentIds = this._lastTiledOrder ?? windows.map(w => w.id);

        let bestOrder = windows;
        let bestScore = -Infinity;

        for (const perm of permutations) {
            const result = tilingFn.call(this, perm, workArea, constants.WINDOW_SPACING);
            let score = this._scoreLayout(result, workArea);

            // Prefer current order (+5) to avoid unnecessary visual swaps
            if (score > -Infinity) {
                const isSameOrder = perm.length === currentIds.length &&
                    perm.every((w, i) => w.id === currentIds[i]);
                if (isSameOrder) score += 5;
            }

            if (score > bestScore) {
                bestScore = score;
                bestOrder = perm;
            }
        }

        const elapsed = Date.now() - startTime;
        Logger.log(`_findOptimalOrder: ${windows.length} windows, ${permutations.length} permutations, ${elapsed}ms`);

        return bestOrder;
    }

    // Order-sensitive hash: different input orders must never share a cache entry.
    _getLayoutHash(windows, work_area) {
        // Snap to 8px grid to reduce cache invalidation during resize
        const snap = v => Math.round(v / 8) * 8;
        const parts = windows.map(w => `${w.id}:${snap(w.width)}x${snap(w.height)}`);
        return `${snap(work_area.width)}x${snap(work_area.height)}|${parts.join(',')}`;
    }

    // Tile windows with dynamic orientation and optimal search
    _tile(windows, work_area, isSimulation = false) {
        if (!windows || windows.length === 0) return { levels: [], vertical: false, overflow: false };

        const hash = this._getLayoutHash(windows, work_area);
        // Skip cache during drag (order changes but hash doesn't)
        if (this._cachedTileResult && this._lastLayoutHash === hash && !isSimulation && !this.isDragging) {
            Logger.log('_tile: Cache hit, reusing layout');
            return this._cachedTileResult;
        }
        
        const spacing = constants.WINDOW_SPACING;
        
        // Check if any window is taller than 50% of workspace height
        let maxHeight = 0;
        let maxWidth = 0;
        for (const w of windows) {
            maxHeight = Math.max(maxHeight, w.height);
            maxWidth = Math.max(maxWidth, w.width);
        }
        
        const isNarrowWorkspace = work_area.width < work_area.height;
        const windowTooWide = maxWidth > work_area.width * 0.9;
        const windowTooTall = maxHeight > work_area.height * 0.65;
        const useVerticalShelves = windowTooTall || isNarrowWorkspace || windowTooWide;
        
        // Select tiling function based on orientation
        const tilingFn = useVerticalShelves ? this._verticalShelves : this._horizontalShelves;

        const currentResult = tilingFn.call(this, windows, work_area, spacing);
        let result;

        // Simulations (binary-search in tryFitWithResize) skip stability scoring for performance.
        const shouldOptimize = currentResult.overflow || (this._positionSnapshot && !isSimulation);

        if (!shouldOptimize) {
            result = currentResult;
            Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, stable order`);
        } else if (this.isDragging && !isSimulation) {
            result = currentResult;
            Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, overflow (drag, no permute)`);
        } else {
            const optimalWindows = this._findOptimalOrder(windows, work_area, tilingFn);
            result = tilingFn.call(this, optimalWindows, work_area, spacing);
            Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, ${currentResult.overflow ? 'reordered (overflow fallback)' : 'stability-checked'}`);
        }

        // Don't cache during drag or simulation
        if (!isSimulation && !this.isDragging) {
            this._lastLayoutHash = hash;
            this._cachedTileResult = result;
        }

        return result;
    }
    
    // Vertical shelves layout - windows stack in columns side by side.
    _verticalShelves(windows, work_area, spacing) {
        // For 1-2 windows, use simple centered column
        if (windows.length <= 2) {
            return this._simpleCenteredColumn(windows, work_area, spacing);
        }
        
        // Bin packing without height sorting to preserve swap order
        const columns = []; // Each column: { windows: [], height: 0, width: 0 }

        for (const w of windows) {
            let placed = false;

            // Try to fit in existing column (simple first-fit decreasing height)
            for (const col of columns) {
                const newHeight = col.height + (col.height > 0 ? spacing : 0) + w.height;
                if (newHeight <= work_area.height) {
                    col.windows.push(w);
                    col.height = newHeight;
                    col.width = Math.max(col.width, w.width);
                    placed = true;
                    break;
                }
            }

            // If doesn't fit anywhere, create new column
            if (!placed) {
                const totalWidth = columns.reduce((s, c) => s + c.width, 0) + 
                                   (columns.length > 0 ? columns.length * spacing : 0) + w.width;
                
                if (totalWidth <= work_area.width || columns.length === 0) {
                    columns.push({ windows: [w], height: w.height, width: w.width });
                } else {
                    // Force into column with most space (overflow case)
                    let bestCol = columns[0];
                    let minHeight = columns[0].height;
                    for (const col of columns) {
                        if (col.height < minHeight) {
                            minHeight = col.height;
                            bestCol = col;
                        }
                    }
                    bestCol.windows.push(w);
                    bestCol.height += spacing + w.height;
                    bestCol.width = Math.max(bestCol.width, w.width);
                }
            }
        }
        
        // Convert columns to levels for rendering
        const levels = [];
        let totalWidth = 0;
        let overflow = false;
        
        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const level = new Level(work_area);
            
            // Recalculate height for this column's windows
            let colHeight = 0;
            for (const w of col.windows) {
                level.windows.push(w);
                if (colHeight > 0) colHeight += spacing;
                colHeight += w.height;
                level.width = Math.max(level.width, w.width);
            }
            level.height = colHeight;
            
            // Check if column overflows height
            if (level.height > work_area.height) {
                overflow = true;
            }
            
            // Center column vertically
            level.y = (work_area.height - level.height) / 2 + work_area.y;
            
            // Check width overflow
            if (totalWidth + level.width + spacing > work_area.width && c > 0) {
                overflow = true;
            }
            
            if (c > 0) totalWidth += spacing;
            totalWidth += level.width;
            
            levels.push(level);
        }
        
        // Calculate horizontal centering, clamped so no column starts left of work area
        const startX = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);
        const levelCount = levels.length;
        const centerColIndex = (levelCount - 1) / 2; // e.g., 0.5 for 2 cols, 1 for 3 cols
        
        // Set X positions for each column with CENTER-POINTING alignment
        let xPos = startX;
        for (let colIdx = 0; colIdx < levelCount; colIdx++) {
            const level = levels[colIdx];
            level.x = xPos;
            
            // Determine horizontal alignment based on column position
            let alignMode = 'center';
            if (levelCount > 1) {
                if (colIdx < centerColIndex) {
                    alignMode = 'right'; // Left column → push windows right
                } else if (colIdx > centerColIndex) {
                    alignMode = 'left';  // Right column → push windows left
                }
            }
            
            // Stack windows vertically (packed, centered vertically)
            let totalColHeight = 0;
            for (const win of level.windows) {
                totalColHeight += win.height;
            }
            totalColHeight += (level.windows.length - 1) * spacing;
            
            let yPos = Math.max(work_area.y, (work_area.height - totalColHeight) / 2 + work_area.y);

            for (const win of level.windows) {
                // Apply horizontal alignment within column
                if (alignMode === 'left') {
                    win.targetX = xPos; // Align to left edge of column
                } else if (alignMode === 'right') {
                    win.targetX = xPos + level.width - win.width; // Align to right edge
                } else {
                    win.targetX = xPos + (level.width - win.width) / 2; // Centered
                }
                win.targetY = yPos;
                yPos += win.height + spacing;
            }
            
            xPos += level.width + spacing;
        }

        return {
            x: startX,
            y: work_area.y,
            overflow: overflow,
            vertical: true,
            levels: levels,
            windows: windows
        };
    }
    
    // Helper for 1-2 windows in vertical mode.
    _simpleCenteredColumn(windows, work_area, spacing) {
        // Calculate total height if stacked
        let totalHeight = 0;
        let maxWidth = 0;
        for (const w of windows) {
            if (totalHeight > 0) totalHeight += spacing;
            totalHeight += w.height;
            maxWidth = Math.max(maxWidth, w.width);
        }
        
        // If windows DON'T fit when stacked, put them side by side in separate columns
        if (totalHeight > work_area.height && windows.length === 2) {
            // Create 2 columns side by side
            const totalWidth = windows[0].width + spacing + windows[1].width;
            const startX = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);
            
            const levels = [];
            let xPos = startX;
            
            for (const w of windows) {
                const level = new Level(work_area);
                level.windows.push(w);
                level.width = w.width;
                level.height = w.height;
                level.x = xPos;
                level.y = Math.max(work_area.y, (work_area.height - w.height) / 2 + work_area.y);
                
                w.targetX = level.x;
                w.targetY = level.y;
                
                levels.push(level);
                xPos += w.width + spacing;
            }
            
            const overflow = totalWidth > work_area.width;
            
            return {
                x: startX,
                y: work_area.y,
                overflow: overflow,
                vertical: true,
                levels: levels,
                windows: windows
            };
        }
        
        // Windows FIT when stacked - use single column
        const level = new Level(work_area);
        for (const w of windows) {
            level.windows.push(w);
        }

        level.width = maxWidth;
        level.height = totalHeight;
        level.x = Math.max(work_area.x, (work_area.width - maxWidth) / 2 + work_area.x);
        level.y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);

        // Set target positions for each window
        let yPos = level.y;
        for (const w of level.windows) {
            w.targetX = level.x + (maxWidth - w.width) / 2;
            w.targetY = yPos;
            yPos += w.height + spacing;
        }

        const overflow = totalHeight > work_area.height || maxWidth > work_area.width;

        return {
            x: level.x,
            y: level.y,
            overflow: overflow,
            vertical: true,
            levels: [level],
            windows: windows
        };
    }
    
    // Horizontal shelves layout: windows pack into rows stacked top-to-bottom.
    _horizontalShelves(windows, work_area, spacing) {
        // For 1-2 windows, use simple centered row
        if (windows.length <= 2) {
            return this._simpleCenteredRow(windows, work_area, spacing);
        }
        // Calculate optimal grid dimensions
        const { rows: numRows, windowsPerRow } = this._calculateOptimalGrid(
            windows,
            work_area
        );
        
        // Distribute windows across rows
        const levels = [];
        let windowIndex = 0;
        let totalHeight = 0;
        let overflow = false;
        
        for (let r = 0; r < numRows; r++) {
            const level = new Level(work_area);
            const windowsInThisRow = windowsPerRow[r];
            
            for (let i = 0; i < windowsInThisRow && windowIndex < windows.length; i++) {
                const w = windows[windowIndex++];
                if (level.width + w.width + (level.width > 0 ? spacing : 0) > work_area.width) {
                    overflow = true;
                }
                
                level.windows.push(w);
                if (level.width > 0) level.width += spacing;
                level.width += w.width;
                level.height = Math.max(level.height, w.height);
            }
            
            level.x = Math.max(work_area.x, (work_area.width - level.width) / 2 + work_area.x);
            if (totalHeight + level.height + spacing > work_area.height && r > 0) {
                overflow = true;
            }
            
            if (r > 0) totalHeight += spacing;
            totalHeight += level.height;
            
            levels.push(level);
        }
        
        const y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);

        // Set targetX/targetY for each window in each level
        let levelY = y;
        for (const level of levels) {
            level.y = levelY;
            let xPos = level.x;
            for (const w of level.windows) {
                w.targetX = xPos;
                w.targetY = levelY + (level.height - w.height) / 2; // Center vertically within row
                xPos += w.width + spacing;
            }
            levelY += level.height + spacing;
        }
        
        return {
            x: work_area.x,
            y: y,
            overflow: overflow,
            vertical: false,
            levels: levels,
            windows: windows
        };
    }

    // Helper for 1-2 windows, simple centered row.
    _simpleCenteredRow(windows, work_area, spacing) {
        const level = new Level(work_area);
        let totalWidth = 0;
        let maxHeight = 0;

        for (const w of windows) {
            if (totalWidth > 0) totalWidth += spacing;
            totalWidth += w.width;
            maxHeight = Math.max(maxHeight, w.height);
            level.windows.push(w);
        }

        level.width = totalWidth;
        level.height = maxHeight;
        level.x = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);

        const y = Math.max(work_area.y, (work_area.height - maxHeight) / 2 + work_area.y);
        level.y = y;

        let xPos = level.x;
        for (const w of level.windows) {
            w.targetX = xPos;
            w.targetY = y + (maxHeight - w.height) / 2; // Center vertically within row
            xPos += w.width + spacing;
        }

        return {
            x: work_area.x,
            y: y,
            overflow: totalWidth > work_area.width || maxHeight > work_area.height,
            vertical: false,
            levels: [level],
            windows: windows
        };
    }
    
    // Calculate optimal grid dimensions using actual window sizes
    _calculateOptimalGrid(windows, work_area) {
        const windowCount = windows.length;
        if (windowCount <= 0) return { rows: 0, windowsPerRow: [] };
        if (windowCount === 1) return { rows: 1, windowsPerRow: [1] };
        if (windowCount === 2) return { rows: 1, windowsPerRow: [2] };
        
        const spacing = constants.WINDOW_SPACING;
        const workspaceAspect = work_area.width / work_area.height;
        
        let bestRows = 1;
        let bestScore = Infinity;
        let bestOverflow = true; // Start assuming everything overflows
        
        // Try different row counts
        for (let rows = 1; rows <= windowCount; rows++) {
            const cols = Math.ceil(windowCount / rows);
            
            // Distribute windows logic (symmetric)
            const windowsPerRow = new Array(rows).fill(0);
            const basePerRow = Math.floor(windowCount / rows);
            let remainder = windowCount % rows;

            for (let r = 0; r < rows; r++) windowsPerRow[r] = basePerRow;

            if (remainder > 0) {
                const centerIndex = Math.floor(rows / 2);
                let left = centerIndex;
                let right = centerIndex;
                
                while (remainder > 0) {
                    if (left >= 0 && left < rows) { windowsPerRow[left]++; remainder--; }
                    if (remainder > 0 && right !== left && right >= 0 && right < rows) { windowsPerRow[right]++; remainder--; }
                    left--;
                    right++;
                }
            }
            
            // SIMULATE ACTUAL PLACEMENT to check fit
            let totalHeight = 0;
            let maxRowWidth = 0;
            let windowIndex = 0;
            let currentRowHeight = 0;
            let currentRowWidth = 0;
            let overflow = false;
            
            for (let r = 0; r < rows; r++) {
                currentRowHeight = 0;
                currentRowWidth = 0;
                const count = windowsPerRow[r];
                
                for (let i = 0; i < count; i++) {
                    if (windowIndex < windows.length) {
                        const w = windows[windowIndex++];
                        currentRowWidth += w.width + (currentRowWidth > 0 ? spacing : 0);
                        currentRowHeight = Math.max(currentRowHeight, w.height);
                    }
                }
                
                if (currentRowWidth > work_area.width + 5) overflow = true;
                maxRowWidth = Math.max(maxRowWidth, currentRowWidth);
                
                totalHeight += currentRowHeight + (r > 0 ? spacing : 0);
            }
            
            if (totalHeight > work_area.height + 5) overflow = true;
            
            // Calculate score (Aspect ratio + Empty spaces)
            const layoutWidth = maxRowWidth;
            const layoutHeight = totalHeight;
            const layoutAspect = layoutWidth / layoutHeight;
            const aspectDiff = Math.abs(layoutAspect - workspaceAspect);
            const emptySpaces = rows * cols - windowCount;
            // Heavily penalize overflow
            const score = aspectDiff + emptySpaces * 0.3 + (overflow ? 1000 : 0);
            
            // Prefer valid layouts over invalid ones
            if (!overflow && bestOverflow) {
                // Found first valid layout!
                bestScore = score;
                bestRows = rows;
                bestOverflow = false;
            } else if (overflow === bestOverflow) {
                // Determine best among same validity status
                if (score < bestScore) {
                    bestScore = score;
                    bestRows = rows;
                }
            }
        }
        
        // Re-generate windowsPerRow for the best result
        const windowsPerRow = new Array(bestRows).fill(0);
        const basePerRow = Math.floor(windowCount / bestRows);
        let remainder = windowCount % bestRows;

        for (let r = 0; r < bestRows; r++) windowsPerRow[r] = basePerRow;

        if (remainder > 0) {
            const centerIndex = Math.floor(bestRows / 2);
            let left = centerIndex;
            let right = centerIndex;
            
            while (remainder > 0) {
                if (left >= 0 && left < bestRows) { windowsPerRow[left]++; remainder--; }
                if (remainder > 0 && right !== left && right >= 0 && right < bestRows) { windowsPerRow[right]++; remainder--; }
                left--;
                right++;
            }
        }
        
        return { rows: bestRows, windowsPerRow };
    }

    _getWorkingInfo(workspace, window, _monitor, excludeFromTiling = false) {
        let current_monitor = _monitor;
        if(current_monitor === undefined)
            current_monitor = window.get_monitor();

        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, current_monitor);

        // Filter out excluded windows (always on top, sticky, etc.)
        meta_windows = meta_windows.filter(w => !this._windowingManager.isExcluded(w));

        // Filter out windows still pending in the evaluation queue, since they haven't been processed yet
        meta_windows = meta_windows.filter(w => !WindowState.get(w, 'pendingInQueue'));
        
        // Exclude the reference window only if explicitly requested (for overflow scenarios)
        if (window && excludeFromTiling) {
            const windowId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== windowId);
        }
        
        if (this.isDragging && this.dragRemainingSpace && window) {
            const draggedId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== draggedId);
        }
        
        // Exclude window marked as overflow (won't fit in mosaic)
        if (this._excludedWindow) {
            const excludedId = this._excludedWindow.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== excludedId);
        }
        
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, current_monitor);
        }
        
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        const nonEdgeTiledMetaWindows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));

        const windowsForSwaps = edgeTiledWindows.length > 0 ? nonEdgeTiledMetaWindows : meta_windows;

        for (const win of meta_windows) {
            if (this._windowingManager.isMaximizedOrFullscreen(win))
                return false;
        }

        const _windows = this.windowsToDescriptors(windowsForSwaps, current_monitor, window);
        
        this.applySwaps(workspace, _windows);
        this.applyTmp(_windows);
        
        const windows = [];
        for(const w of _windows)
            windows.push(this.getMask(w));

        const work_area = this._clampedWorkArea(workspace, current_monitor);
        if(!work_area) return false;

        return {
            monitor: current_monitor,
            meta_windows: meta_windows,
            windows: windows,
            work_area: work_area
        };
    }

    _drawTile(tile_info, work_area, meta_windows, dryRun = false, slotsOut = null) {
        const levels = tile_info.levels;
        const _x = tile_info.x;
        const _y = tile_info.y;
        if(!tile_info.vertical) {
            let y = _y;
            for(const level of levels) {
                Logger.log(`Drawing horizontal level at y=${y}, width=${level.width}, height=${level.height}`);
                level.draw_horizontal(meta_windows, work_area, y, this.masks, this.isDragging, this._drawingManager, dryRun, slotsOut);
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = _x;
            for(const level of levels) {
                Logger.log(`Drawing vertical level at x=${x}, width=${level.width}, height=${level.height}`);
                level.draw_vertical(meta_windows, x, this.masks, this.isDragging, this._drawingManager, dryRun, slotsOut);
                x += level.width + constants.WINDOW_SPACING;
            }
        }
    }

    _animateTileLayout(workspace, tile_info, work_area, meta_windows, draggedWindow = null, slotsOut = null) {
        if (this._animationsManager) {
            const resizingWindowId = this._animationsManager.getResizingWindowId();
            const pendingMiniIds = new Set(
                (this._pendingMiniatureWindows ?? []).map(p => p.window.get_id())
            );

            const levels = tile_info.levels;
            const _y = tile_info.y;

            const windowLayouts = [];
            // Pending miniature windows are kept out of windowLayouts (createMiniature
            // owns their visual animation), but a first placement sibling still needs
            // to know they're there to compute a slide-in direction against. Tracked
            // separately so animateReTiling can see them without animating them.
            const miniLayouts = [];

            if (!tile_info.vertical) {
                let y = _y;
                for (const level of levels) {
                    let x = level.x;
                    for (const windowDesc of level.windows) {
                        const center_offset = (work_area.height / 2 + work_area.y) - (y + windowDesc.height / 2);
                        let y_offset = 0;
                        if (center_offset > 0)
                            y_offset = Math.min(center_offset, level.height - windowDesc.height);
                        
                        const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                        if (window) {
                            if (WindowState.get(window, IS_MINIATURE)) {
                                // Do NOT move_frame for miniatures (Mutter may reject)
                                const actor = window.get_compositor_private();
                                const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
                                const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                                const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                                const tx = x;
                                const ty = y + y_offset;
                                if (actor && !actor.is_destroyed()) {
                                    animateMiniatureToTarget(actor, window, sc, extL, extT, tx, ty,
                                        constants.ANIMATION_DURATION_MS);
                                    WindowState.get(window, MINIATURE_OVERLAY)?.animateToPosition(constants.ANIMATION_DURATION_MS);
                                }
                                // MosaicLayoutStrategy reads ComputedLayouts for the overview slot, so keep it in sync.
                                const miniSlot = { x: tx, y: ty, width: windowDesc.width, height: windowDesc.height };
                                ComputedLayouts.set(window, miniSlot);
                                if (slotsOut) slotsOut.set(window.get_id(), miniSlot);
                                Logger.log(`[MINIATURE] animateTile H ${window.get_id()}: target=(${tx},${ty}) scale=${sc.toFixed(4)} extLeft=${extL} extTop=${extT} size=${windowDesc.width}x${windowDesc.height}`);
                            } else if (windowDesc.id === resizingWindowId) {
                                window.move_frame(false, x, y + y_offset);
                            } else if (pendingMiniIds.has(window.get_id())) {
                                // Pending miniature: capture slot, but skip animateReTiling.
                                // createMiniature handles all visual animation; concurrent
                                // move_resize_frame would shift actor mid-animation.
                                const slot = { x, y: y + y_offset, width: windowDesc.width, height: windowDesc.height };
                                ComputedLayouts.set(window, slot);
                                if (slotsOut) slotsOut.set(window.get_id(), slot);
                                miniLayouts.push({ window, rect: slot });
                                Logger.log(`[LAYOUT] H pending-mini ${window.get_id()}: slot=(${slot.x},${slot.y}) size=${slot.width}x${slot.height}`);
                            } else {
                                Logger.log(`[LAYOUT] H window ${window.get_id()}: target=(${x},${y + y_offset}) size=${windowDesc.width}x${windowDesc.height}`);
                                const slot = { x, y: y + y_offset, width: windowDesc.width, height: windowDesc.height };
                                ComputedLayouts.set(window, slot);
                                if (slotsOut) slotsOut.set(window.get_id(), slot);
                                windowLayouts.push({ window, rect: slot });
                            }
                        }
                        x += windowDesc.width + constants.WINDOW_SPACING;
                    }
                    y += level.height + constants.WINDOW_SPACING;
                }
            } else {
                // Vertical layout: each level is a column
                let x = tile_info.x;
                for (const level of levels) {
                    let y = level.y;
                    for (const windowDesc of level.windows) {
                        // Use targetX/targetY if set, otherwise calculate
                        const targetX = windowDesc.targetX !== undefined ? windowDesc.targetX : x;
                        const targetY = windowDesc.targetY !== undefined ? windowDesc.targetY : y;
                        
                        const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                        if (window) {
                            if (WindowState.get(window, IS_MINIATURE)) {
                                // Do NOT move_frame for miniatures (Mutter may reject)
                                const actor = window.get_compositor_private();
                                const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
                                const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                                const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                                if (actor && !actor.is_destroyed()) {
                                    animateMiniatureToTarget(actor, window, sc, extL, extT, targetX, targetY,
                                        constants.ANIMATION_DURATION_MS);
                                    WindowState.get(window, MINIATURE_OVERLAY)?.animateToPosition(constants.ANIMATION_DURATION_MS);
                                }
                                // MosaicLayoutStrategy reads ComputedLayouts for the overview slot, so keep it in sync.
                                const miniSlot = { x: targetX, y: targetY, width: windowDesc.width, height: windowDesc.height };
                                ComputedLayouts.set(window, miniSlot);
                                if (slotsOut) slotsOut.set(window.get_id(), miniSlot);
                                Logger.log(`[MINIATURE] animateTile V ${window.get_id()}: target=(${targetX},${targetY}) scale=${sc.toFixed(4)} extLeft=${extL} extTop=${extT} slotSize=${windowDesc.width}x${windowDesc.height}`);
                            } else if (windowDesc.id === resizingWindowId) {
                                window.move_frame(false, targetX, targetY);
                            } else if (pendingMiniIds.has(window.get_id())) {
                                // Pending miniature: capture slot, but skip animateReTiling.
                                // createMiniature handles all visual animation; concurrent
                                // move_resize_frame would shift actor mid-animation.
                                const slot = { x: targetX, y: targetY, width: windowDesc.width, height: windowDesc.height };
                                ComputedLayouts.set(window, slot);
                                if (slotsOut) slotsOut.set(window.get_id(), slot);
                                miniLayouts.push({ window, rect: slot });
                                Logger.log(`[LAYOUT] V pending-mini ${window.get_id()}: slot=(${slot.x},${slot.y}) size=${slot.width}x${slot.height}`);
                            } else {
                                Logger.log(`[LAYOUT] V window ${window.get_id()}: target=(${targetX},${targetY}) size=${windowDesc.width}x${windowDesc.height}`);
                                const slot = { x: targetX, y: targetY, width: windowDesc.width, height: windowDesc.height };
                                ComputedLayouts.set(window, slot);
                                if (slotsOut) slotsOut.set(window.get_id(), slot);
                                windowLayouts.push({ window, rect: slot });
                            }
                        }
                        y += windowDesc.height + constants.WINDOW_SPACING;
                    }
                    x += level.width + constants.WINDOW_SPACING;
                }
            }
            
            this._animationsManager.animateReTiling(windowLayouts, draggedWindow, miniLayouts);
        }

        // Release workspace lock after signals from move_resize have likely fired.
        // We use a safe delay matching the animation duration.
        if (this._extension && this._extension.windowHandler) {
            if (this._extension._timeoutRegistry) {
                this._extension._timeoutRegistry.add(constants.ANIMATION_DURATION_MS + 100, () => {
                    this._extension.windowHandler.unlockWorkspace(workspace);
                }, 'unlockWorkspace');
            } else {
                // No registry, so unlock immediately (extension is likely disabling)
                this._extension.windowHandler.unlockWorkspace(workspace);
            }
        }

        return true;
    }

    cascadeWorkspaceWindows(workspace) {
        if (!workspace || workspace.index() < 0) return;

        const nMonitors = global.display.get_n_monitors();
        for (let monitor = 0; monitor < nMonitors; monitor++) {
            this._cascadeMonitorWindows(workspace, monitor);
        }
    }

    _cascadeMonitorWindows(workspace, monitor) {
        const workArea = this._clampedWorkArea(workspace, monitor);
        if (!workArea || workArea.width <= 0) return;

        const windows = this._windowingManager
            ?.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this._windowingManager.isMaximizedOrFullscreen(w)) ?? [];

        if (windows.length === 0) return;

        windows.sort((a, b) => {
            const fa = a.get_frame_rect(), fb = b.get_frame_rect();
            return (fb.width * fb.height) - (fa.width * fa.height);
        });

        const OFFSET = 56;

        const frames = windows.map(w => w.get_frame_rect());
        const relPositions = frames.map((f, i) => ({ x: i * OFFSET, y: i * OFFSET, w: f.width, h: f.height }));

        const groupW = Math.max(...relPositions.map(p => p.x + p.w));
        const groupH = Math.max(...relPositions.map(p => p.y + p.h));

        const originX = workArea.x + Math.max(0, Math.round((workArea.width  - groupW) / 2));
        const originY = workArea.y + Math.max(0, Math.round((workArea.height - groupH) / 2));

        Logger.log(`[CASCADE] workArea=(${workArea.x},${workArea.y} ${workArea.width}x${workArea.height}) group=(${groupW}x${groupH}) origin=(${originX},${originY}) windows=${windows.length}`);

        const layouts = windows.map((w, i) => {
            const p = relPositions[i];
            const x = Math.min(originX + p.x, workArea.x + workArea.width  - p.w);
            const y = Math.min(originY + p.y, workArea.y + workArea.height - p.h);
            Logger.log(`[CASCADE] w=${w.get_id()} frame=(${frames[i].x},${frames[i].y} ${p.w}x${p.h}) -> (${x},${y})`);
            return { window: w, rect: { x, y, width: p.w, height: p.h } };
        });

        // Raise from largest (back) to smallest (front) to establish visual stacking order.
        for (const w of windows) {
            w.raise();
        }
        // Focus the smallest window so it appears on top and is ready to interact with.
        windows[windows.length - 1].activate(global.get_current_time());

        this._animationsManager?.animateReTiling(layouts);
    }

    // Re-apply mosaic from scratch with smart-resize + miniaturization. Used by
    // extension enable and Quick Settings toggle-on, since tileWorkspaceWindows's
    // overflow path needs a "newly added" reference window and can't handle this.
    enforceWorkspaceFit(workspace, monitor) {
        if (!workspace || workspace.index() < 0) return;
        if (this._extension && !this._extension.isMosaicEnabledForWorkspace(workspace)) return;

        const workArea = this._clampedWorkArea(workspace, monitor);
        if (!workArea || workArea.width <= 0 || workArea.height <= 0) return;

        const allWindows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this._windowingManager.isExcluded(w)
                && !this._windowingManager.isMaximizedOrFullscreen(w)
                && !this._extension?.edgeTilingManager?.isEdgeTiled?.(w));

        if (allWindows.length === 0) return;

        // Pick the most recently focused as the protected "newcomer". Without one,
        // every window is an equal miniaturization candidate, which is jarring on re-enable.
        const tabList = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);
        const reference = tabList.find(w => allWindows.some(aw => aw.get_id() === w.get_id()))
            ?? allWindows[0];
        const others = allWindows.filter(w => w.get_id() !== reference.get_id());

        const resizeResult = this.tryFitWithResize(reference, others, workArea, reference);

        if (resizeResult?.success) {
            this._isSmartResizingBlocked = true;
            try {
                this._pendingMiniatureWindows = resizeResult.pendingWindows ?? [];
                this.tileWorkspaceWindows(workspace, null, monitor, false);
            } finally {
                this._isSmartResizingBlocked = false;
            }
        } else {
            // Couldn't smart-resize to fit, so degrade to oversized tiling rather than crash.
            this.tileWorkspaceWindows(workspace, null, monitor, true);
        }
    }

    // Releases a lock acquired by tileWorkspaceWindows for paths that bail out
    // before reaching _animateTileLayout (which normally owns the deferred unlock).
    _unlockWorkspaceEarlyReturn(workspace) {
        if (this._extension && this._extension.windowHandler) {
            this._extension.windowHandler.unlockWorkspace(workspace);
        }
    }

    tileWorkspaceWindows(workspace, reference_meta_window, _monitor, keep_oversized_windows, excludeFromTiling = false, dryRun = false, isRecursive = false) {
        if (!workspace || workspace.index() < 0) {
            Logger.log(`tileWorkspaceWindows: Invalid workspace (index=${workspace?.index?.() ?? 'null'}) - skipping`);
            return { overflow: false, layout: null };
        }

        if (this._extension && !this._extension.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log(`Mosaic disabled for workspace ${workspace.index()} - skipping tiling`);
            return { overflow: false, layout: null };
        }

        Logger.log(`tileWorkspaceWindows: Starting for workspace ${workspace.index()} (isRecursive=${isRecursive})`);

        // Clear previous masks before drawing; recycle boxes if dragging.
        if (!isRecursive && !dryRun) {
            this.destroyMasks();
        }

        // LOCK: Prevent spurious overflow detection during tiling shifts
        if (this._extension && this._extension.windowHandler) {
            this._extension.windowHandler.lockWorkspace(workspace);
        }

        // Auto-detect monitors: if no monitor specified and no reference window,
        // iterate over all monitors to ensure complete tiling coverage
        if (_monitor === null || _monitor === undefined) {
            if (!reference_meta_window) {
                const nMonitors = global.display.get_n_monitors();
                if (nMonitors > 1) {
                    Logger.log(`Auto-tiling workspace ${workspace.index()} across ${nMonitors} monitors`);
                }
                for (let m = 0; m < nMonitors; m++) {
                    this.tileWorkspaceWindows(workspace, null, m, keep_oversized_windows, excludeFromTiling, dryRun, true);
                }
                
                // UNLOCK: The recursive calls will handle their own monitor-specific locks,
                // but we need to ensure the final state is unlocked after a safe delay.
                if (this._extension && this._extension.windowHandler) {
                    if (this._extension._timeoutRegistry) {
                        this._extension._timeoutRegistry.add(constants.ANIMATION_DURATION_MS + 50, () => {
                            this._extension.windowHandler.unlockWorkspace(workspace);
                        }, 'unlockWorkspaceRecursive');
                    } else {
                        // No registry, so unlock immediately (extension is likely disabling)
                        this._extension.windowHandler.unlockWorkspace(workspace);
                    }
                }
                return { overflow: false, layout: null };
            } else {
                _monitor = reference_meta_window.get_monitor();
            }
        }
        
        // Invalidate window list cache for this operation
        if (this._windowingManager) {
            this._windowingManager.invalidateWindowsCache();
        }
        
        const working_info = this._getWorkingInfo(workspace, reference_meta_window, _monitor, excludeFromTiling);
        if(!working_info) {
            this._unlockWorkspaceEarlyReturn(workspace);
            return { overflow: false, layout: null };
        }
        let meta_windows = working_info.meta_windows;
        const windows = working_info.windows;
        let work_area = working_info.work_area;
        const monitor = working_info.monitor;

        const workspace_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            Logger.log(`tileWorkspaceWindows: Found ${edgeTiledWindows.length} edge-tiled windows`);
        }
        
        if (edgeTiledWindows.length > 0) {
            Logger.log(`Found ${edgeTiledWindows.length} edge-tiled window(s)`);
            
            // Check if we have 2 half-tiles (left + right = fully occupied)
            const zones = edgeTiledWindows.map(w => w.zone);
            Logger.log(`Edge tile zones detected: [${zones.join(', ')}]`);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
            const hasRightQuarters = zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
            
            Logger.log(`Zone check: leftFull=${hasLeftFull}, rightFull=${hasRightFull}, leftQuarters=${hasLeftQuarters}, rightQuarters=${hasRightQuarters}`);
            
            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                // Don't move windows during drag - just show preview
                if (this.isDragging) {
                    Logger.log('Both sides edge-tiled - deferring overflow until drag ends');
                    this._unlockWorkspaceEarlyReturn(workspace);
                    return { overflow: false, layout: null }; // Let preview show but don't move windows
                }
                
                Logger.log('Both sides edge-tiled - workspace fully occupied');
                
                // GUARD: Only trigger mass expulsion if the change was caused by an edge-tiled window (completing the wall)
                // If a normal window is added to a full workspace, ONLY expel that window.
                const edgeTiledIds = edgeTiledWindows.map(w => w.window.get_id());
                const isReferenceEdgeTiled = reference_meta_window && edgeTiledIds.includes(reference_meta_window.get_id());
                
                const nonEdgeTiledMeta = this._edgeTilingManager.getNonEdgeTiledWindows(workspace, monitor);
                
                // Move non-edge-tiled windows to new workspace
                for (const window of nonEdgeTiledMeta) {
                    const isRef = reference_meta_window && window.get_id() === reference_meta_window.get_id();
                    
                    // Expel if:
                    // 1. It's the reference window (the newcomer trying to squeeze in)
                    // 2. OR the reference window IS an edge tile (meaning we just closed the wall on existing windows)
                    if (isRef || isReferenceEdgeTiled) {
                        if (!this._windowingManager.isExcluded(window) && !this._windowingManager.isMaximizedOrFullscreen(window)) {
                            Logger.log(`Expelling non-edge-tiled window ${window.get_id()} (RefEdgeTiled=${isReferenceEdgeTiled}, IsRef=${isRef})`);
                            this._windowingManager.moveOversizedWindow(window).catch(e =>
                                Logger.error(`Overflow expel failed for ${window.get_id()}: ${e}`));
                        }
                    }
                }
                
                this._unlockWorkspaceEarlyReturn(workspace);
                return { overflow: false, layout: null }; // Don't tile, edge-tiled windows stay in place
            }
            
            // Single tile or quarter tiles - calculate remaining space
            const remainingSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
            const nonEdgeTiledCount = workspace_windows.filter(w => !edgeTiledIds.includes(w.get_id())).length;
            if (this.dragRemainingSpace) {
                Logger.log(`Reusing drag remaining space: x=${this.dragRemainingSpace.x}, w=${this.dragRemainingSpace.width}`);
                // If we have a cached remaining space from drag, use it
                work_area = this.dragRemainingSpace;
            } else {
                Logger.log(`Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
                Logger.log(`Total workspace windows: ${workspace_windows.length}, Non-edge-tiled: ${nonEdgeTiledCount}`);
                
                // Filter out edge-tiled windows from tiling
                meta_windows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
                Logger.log(`After filtering edge-tiled: ${meta_windows.length} windows to tile`);
                
                // Also filter out maximized/fullscreen windows (SACRED - never touch them)
                const beforeMaxFilter = meta_windows.length;
                meta_windows = meta_windows.filter(w => !this._windowingManager.isMaximizedOrFullscreen(w));
                if (meta_windows.length < beforeMaxFilter) {
                    Logger.log(`Filtered ${beforeMaxFilter - meta_windows.length} maximized/fullscreen (sacred) windows`);
                }
                
                // Set work_area to remaining space for tiling calculations
                work_area = remainingSpace;
                
                // If no non-edge-tiled windows, nothing to tile
                if (meta_windows.length === 0) {
                    Logger.log('No non-edge-tiled windows to tile');
                    this._unlockWorkspaceEarlyReturn(workspace);
                    return { overflow: false, layout: null };
                }
            }
        }
        
        // Only reset if not already populated (to survive recursive calls from tryFitWithResize)
        if (!this._pendingMiniatureWindows) {
            this._pendingMiniatureWindows = [];
        }

        // Pre-apply mini sizes so the initial _tile sees the correct footprint.
        // Without this, pendingMiniature windows still have their full frame size,
        // which causes spurious overflow and fires the no-ref overflow block as a
        // second independent miniaturizer alongside tryFitWithResize.
        for (const pm of this._pendingMiniatureWindows) {
            if (!pm.miniSize) continue;
            const desc = windows.find(d => d.id === pm.window.get_id());
            if (desc) {
                desc.width = pm.miniSize.width;
                desc.height = pm.miniSize.height;
            }
        }

        // Computed slots from this pass, returned to the caller so it can find
        // miniature positions without depending on the ComputedLayouts side-channel.
        const computedSlots = new Map();

        const tileArea = this.isDragging && this.dragRemainingSpace ? this.dragRemainingSpace : work_area;

        this._positionSnapshot = new Map();
        for (const w of meta_windows) {
            const f = w.get_frame_rect();
            this._positionSnapshot.set(w.get_id(), { cx: f.x + f.width / 2, cy: f.y + f.height / 2 });
        }

        // Zero-displacement bias makes stability scoring revert explicit drag order; suppress once.
        if (this._skipStabilityForNextTile) {
            this._skipStabilityForNextTile = false;
            this._positionSnapshot = null;
        }

        let tile_info = this._tile(windows, tileArea, dryRun);
        let overflow = tile_info.overflow;
        
        if (workspace_windows.length <= 1) {
            overflow = false;
        } else {
            for(const window of workspace_windows)
                if(this._windowingManager.isMaximizedOrFullscreen(window))
                    overflow = true;
        }
        
        // DRY RUN: If dryRun flag is set, return overflow without moving anything
        if (dryRun) {
            this._positionSnapshot = null;
            this._unlockWorkspaceEarlyReturn(workspace);
            return { overflow, layout: this._cachedTileResult?.windows || null };
        }

        // Block expulsion if edge-tiled (except non-edge ref); defer if dragging.
        const hasEdgeTiledWindows = edgeTiledWindows && edgeTiledWindows.length > 0;
        const referenceIsEdgeTiled = reference_meta_window && 
            edgeTiledWindows?.some(s => s.window.get_id() === reference_meta_window.get_id());
        const canOverflow = !hasEdgeTiledWindows || !referenceIsEdgeTiled;
        
        if(overflow && !keep_oversized_windows && reference_meta_window && canOverflow && !this.isDragging) {
            // SAFETY: Only overflow windows that are genuinely new (added within last 2 seconds)
            // This prevents incorrectly expelling existing windows during resize retiling
            const addedTime = WindowState.get(reference_meta_window, 'addedTime');
            const isNewlyAdded = addedTime && (Date.now() - addedTime) < constants.NEW_WINDOW_MINIATURIZE_PROTECTION_MS;
            
            if (!isNewlyAdded && !WindowState.get(reference_meta_window, 'forceOverflow') && !WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                Logger.log(`Skipping overflow for ${reference_meta_window.get_id()} - not a new window`);
            } else if (WindowState.get(reference_meta_window, 'isSmartResizing') || WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                Logger.log(`Skipping overflow for ${reference_meta_window.get_id()} - smart resize/sacred restore in progress`);
                
                // FORCE RESIZE ATTEMPT IF NEEDED
                // If it's a sacred return, we MUST try to fit it, even if it means squishing everyone.
                if (WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                    const workArea = this.getUsableWorkArea(workspace, monitor);
                    // windows here are descriptors; re-fetch MetaWindows for tryFitWithResize
                    const realExisting = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(w => w.get_id() !== reference_meta_window.get_id() && !this._windowingManager.isExcluded(w));
                                          
                    // Only try resize if we haven't already (to avoid loops)
                    if (!WindowState.get(reference_meta_window, 'isSmartResizing')) {
                        Logger.log('Triggering Smart Resize for returning sacred window');
                        const resizeResult = this.tryFitWithResize(reference_meta_window, realExisting, workArea);
                        if (!resizeResult?.success) {
                            Logger.log('Smart resize could not fit sacred window');
                            this._positionSnapshot = null;
                            this._unlockWorkspaceEarlyReturn(workspace);
                            return { overflow: true, layout: null };
                        }
                        // Use the tile_info from tryFitWithResize (computed with miniature sizes)
                        tile_info = resizeResult.tileInfo;
                        // Preserve any pending miniatures discovered during this resize pass
                        if (resizeResult.pendingWindows?.length > 0) {
                            this._pendingMiniatureWindows = resizeResult.pendingWindows;
                        }
                    }
                }
            } else {
                // Match by descriptor id, since descriptor.index drifts after edge-tiled/sacred windows are filtered.
                const id = reference_meta_window.get_id();
                const _windows = windows;
                for(let i = 0; i < _windows.length; i++) {
                    if(_windows[i].id === id) {
                        _windows.splice(i, 1);
                        break;
                    }
                }
                this._windowingManager.moveOversizedWindow(reference_meta_window).catch(e =>
                    Logger.error(`Overflow move failed for ref window: ${e}`));
                tile_info = this._tile(_windows, tileArea);
            }
        }

        // No reference window means nothing to eject, so try miniaturizing candidates to reclaim space.
        if (overflow && !reference_meta_window && !this.isDragging && this._extension?.miniatureManager) {
            const focusedId = global.display.focus_window?.get_id();

            const overflowCandidates = meta_windows
                .filter(w =>
                    !WindowState.get(w, IS_MINIATURE) &&
                    w.get_id() !== focusedId &&
                    w.get_id() !== (this._restoringWindowId ?? null) &&
                    !this._windowingManager.isMaximizedOrFullscreen(w)
                )
                .sort((a, b) => (WindowState.get(a, 'addedTime') ?? 0) - (WindowState.get(b, 'addedTime') ?? 0));

            let overflowResolved = false;

            // Accumulate mini sizes across iterations so multiple windows can stack to resolve overflow.
            const cumulativeSim = new Map(meta_windows.map(w => {
                if (WindowState.get(w, IS_MINIATURE)) {
                    const ms = getMiniatureSize(w);
                    const f = w.get_frame_rect();
                    return [w.get_id(), ms ? { width: ms.width, height: ms.height } : { width: f.width, height: f.height }];
                }
                const f = w.get_frame_rect();
                return [w.get_id(), { width: f.width, height: f.height }];
            }));
            const pendingMinis = [];

            for (const candidate of overflowCandidates) {
                const frame = candidate.get_frame_rect();
                // Scale from current frame so the visual fills the slot.
                const scale = constants.MINIATURE_TARGET_SIZE_PX / Math.max(frame.width, frame.height);
                const miniW = Math.round(frame.width * scale);
                const miniH = Math.round(frame.height * scale);

                cumulativeSim.set(candidate.get_id(), { width: miniW, height: miniH });
                pendingMinis.push({ candidate, frame, miniW, miniH });

                const simSizes = [...cumulativeSim.entries()].map(([id, s]) => ({ id, width: s.width, height: s.height }));

                if (!this._tile(simSizes, tileArea, true).overflow) {
                    Logger.log(`[OVERFLOW] No-ref overflow resolved by miniaturizing ${pendingMinis.length} window(s)`);
                    if (!this._pendingMiniatureWindows) this._pendingMiniatureWindows = [];
                    for (const { candidate: c, frame: f, miniW: mW, miniH: mH } of pendingMinis) {
                        Logger.log(`[OVERFLOW] Miniaturizing ${c.get_id()} (${mW}x${mH})`);
                        this._pendingMiniatureWindows.push({ window: c, preSize: { x: f.x, y: f.y, width: f.width, height: f.height } });
                        const desc = windows.find(w => w.id === c.get_id());
                        if (desc) { desc.width = mW; desc.height = mH; }
                    }
                    this.invalidateLayoutCache();
                    tile_info = this._tile(windows, tileArea);
                    overflow = tile_info.overflow;
                    overflowResolved = true;
                    break;
                }
            }

            if (!overflowResolved)
                Logger.log('[OVERFLOW] No-ref overflow: miniaturizing all candidates still overflows, applying clamped positions');
        }

        this._positionSnapshot = null;
        if (tile_info?.levels?.length > 0) {
            this._lastTiledOrder = tile_info.levels.flatMap(l => l.windows).map(w => w.id);
            const newGroupAssignment = new Map();
            tile_info.levels.forEach((level, levelIdx) => {
                for (const w of level.windows) newGroupAssignment.set(w.id, levelIdx);
            });
            this._lastGroupAssignment = newGroupAssignment;
            Logger.log(`[GROUP STABILITY] Recorded assignment: ${[...newGroupAssignment].map(([id, idx]) => `${id}->col${idx}`).join(', ')}`);
        }
        Logger.log(`Drawing tiles - isDragging: ${this.isDragging}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`);
        
        // ANIMATIONS
        let animationsHandledPositioning = false;
        if (!this.isDragging && tile_info && tile_info.levels && tile_info.levels.length > 0) {
            const draggedWindow = reference_meta_window;
            
            // Allow animation for windows returning from excluded state
            if (reference_meta_window && WindowState.get(reference_meta_window, 'justReturnedFromExclusion')) {
                Logger.log(`Allowing animation for returning excluded window ${reference_meta_window.get_id()}`);
                WindowState.remove(reference_meta_window, 'justReturnedFromExclusion');
            }
            
            animationsHandledPositioning = this._animateTileLayout(workspace, tile_info, tileArea, meta_windows, draggedWindow, computedSlots);
        }

        if (!animationsHandledPositioning) {
            // Only call drawTile if animations didn't handle positioning
            Logger.log('Animations did not handle positioning, calling drawTile');
            this._drawTile(tile_info, tileArea, meta_windows, false, computedSlots);
            // _animateTileLayout owns the deferred unlock; since it didn't run,
            // release the lock now that positioning is done synchronously.
            this._unlockWorkspaceEarlyReturn(workspace);
        } else {
            Logger.log('Animations handled positioning, skipping drawTile');
        }

        // Create miniatures for pending windows. Top-level only, not inside recursive tryFitWithResize.
        if (!isRecursive) {
            if (this._pendingMiniatureWindows?.length > 0 && this._extension?.miniatureManager) {
                for (const { window: win, preSize } of this._pendingMiniatureWindows) {
                    // Skip if already miniaturized, since an earlier tile call may have created it first.
                    if (WindowState.get(win, IS_MINIATURE)) continue;
                    const slot = computedSlots.get(win.get_id());
                    Logger.log(`[MINIATURE] Creating ${win.get_id()} with stored preSize=${preSize?.width}x${preSize?.height}`);
                    if (slot) {
                        Logger.log(`[MINIATURE] Creating miniature for window ${win.get_id()} at slot (${slot.x},${slot.y}) size (${slot.width}x${slot.height})`);
                        this._extension.miniatureManager.createMiniature(win, slot, preSize);
                    } else {
                        Logger.warn(`[MINIATURE] No computed slot for window ${win.get_id()}, using workArea`);
                        this._extension.miniatureManager.createMiniature(win, { x: tileArea.x, y: tileArea.y, width: tileArea.width, height: tileArea.height }, preSize);
                    }
                }
            }
        }

        const result = { overflow, layout: this._cachedTileResult?.windows || null, computedSlots };
        this.emit('mosaic-changed', workspace);

        // Clean up pending list after use (only on top-level call)
        if (!isRecursive) {
            this._pendingMiniatureWindows = [];
        }

        return result;
    }

    canFitWindow(window, workspace, monitor, relaxed = false, overrideSize = null) {
        if (this._extension && !this._extension.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log('canFitWindow: Workspace has mosaic disabled - always fits');
            return true;
        }

        Logger.log(`canFitWindow: Checking if window can fit in workspace ${workspace.index()} (relaxed=${relaxed})`);
        
        // Excluded windows (Always on Top, Sticky) coexist with sacred windows and don't participating in tiling.
        if (this._windowingManager.isExcluded(window)) {
            Logger.log('canFitWindow: Window is excluded - always fits (not tiled)');
            return true;
        }
        
        const isIncomingSacred = this._windowingManager.isMaximizedOrFullscreen(window);
        const currentWindows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !WindowState.get(w, 'pendingInQueue'));
        const otherWindows = currentWindows.filter(w => w.get_id() !== window.get_id());
        const hasExistingSacred = otherWindows.some(w => this._windowingManager.isMaximizedOrFullscreen(w));

        // Symmetric Isolation Policy:
        // 1. Sacred windows (Incoming) ONLY fit in workspaces with 0 other windows.
        if (isIncomingSacred) {
            if (otherWindows.length > 0) {
                Logger.log(`canFitWindow: Incoming window is sacred but workspace ${workspace.index()} is occupied - blocked`);
                return false;
            }
            Logger.log('canFitWindow: Window is sacred and workspace is empty - fits');
            return true;
        }

        // 2. Normal windows (Incoming) ONLY fit in workspaces with 0 sacred windows.
        if (hasExistingSacred) {
            Logger.log(`canFitWindow: Incoming normal window blocked - workspace ${workspace.index()} has a sacred window`);
            return false;
        }

        const working_info = this._getWorkingInfo(workspace, window, monitor);
        if (!working_info) {
            Logger.log('canFitWindow: No working info - cannot fit');
            return false;
        }

        for (const existing_window of working_info.meta_windows) {
            if(this._windowingManager.isMaximizedOrFullscreen(existing_window)) {
                Logger.log('canFitWindow: Workspace has maximized window - cannot fit');
                return false;
            }
        }

        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }
        
        let availableSpace = working_info.work_area;
        const newWindowId = window.get_id();

        
        if (edgeTiledWindows.length > 0) {
            const otherEdgeTiles = edgeTiledWindows.filter(w => w.window.get_id() !== window.get_id());
            const zones = otherEdgeTiles.map(w => w.zone);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
            const hasRightQuarters = zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
            
            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                Logger.log('canFitWindow: Workspace fully occupied by edge tiles - cannot fit');
                return false;
            }
            
            availableSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            Logger.log(`canFitWindow: Using remaining space after snap: ${availableSpace.width}x${availableSpace.height}`);
        }

        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        
        const windows = working_info.windows.filter(w => 
            !edgeTiledIds.includes(w.id)
        );
        
        // targetSmartResizeSize takes priority: preferredSize holds the pre-resize original, which would falsely report overflow.
        const workspaceWindows = workspace.list_windows();

        for (const w of windows) {
            const realWindow = workspaceWindows.find(win => win.get_id() === w.id);
            if (realWindow && !WindowState.get(realWindow, IS_MINIATURE)) {
                const restoredSize = WindowState.get(realWindow, 'targetRestoredSize');
                const smartResizeSize = WindowState.get(realWindow, 'targetSmartResizeSize');
                const isConstrained = WindowState.get(realWindow, 'isConstrainedByMosaic');
                const preferredSize = WindowState.get(realWindow, 'preferredSize')
                    || WindowState.get(realWindow, 'openingSize');

                if (restoredSize) {
                    w.width = restoredSize.width;
                    w.height = restoredSize.height;
                } else if (smartResizeSize) {
                    // Resize still pending, target not reached yet
                    w.width = smartResizeSize.width;
                    w.height = smartResizeSize.height;
                } else if (isConstrained) {
                    // targetSmartResizeSize gets cleared once the frame settles, so use the
                    // actual frame here instead of preferredSize.
                    const realFrame = realWindow.get_frame_rect();
                    w.width = realFrame.width;
                    w.height = realFrame.height;
                } else if (preferredSize) {
                    w.width = preferredSize.width;
                    w.height = preferredSize.height;
                } else {
                    const realFrame = realWindow.get_frame_rect();
                    w.width = realFrame.width;
                    w.height = realFrame.height;
                }
            }
        }
        
        const windowAlreadyInWorkspace = windows.some(w => w.id === newWindowId);
        
        if (!windowAlreadyInWorkspace) {
            let realWidth, realHeight;

            if (overrideSize) {
                realWidth = overrideSize.width;
                realHeight = overrideSize.height;
                Logger.log(`canFitWindow: Using overrideSize ${realWidth}x${realHeight}`);
            } else {
                const smartResizeSize = WindowState.get(window, 'targetSmartResizeSize');
                const preferredSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
                const frame = window.get_frame_rect();

                if (smartResizeSize) {
                    realWidth = smartResizeSize.width;
                    realHeight = smartResizeSize.height;
                } else {
                    // Use the actual frame dimensions instead of a hardcoded fallback
                    realWidth = preferredSize ? preferredSize.width : frame.width;
                    realHeight = preferredSize ? preferredSize.height : frame.height;
                }
            }
            
            Logger.log(`canFitWindow: Window not in workspace - adding with size ${realWidth}x${realHeight} (preferred=${!!overrideSize || !!WindowState.get(window, 'preferredSize')})`);
            
            const newWindowDescriptor = new WindowDescriptor(window, windows.length);
            newWindowDescriptor.width = realWidth;
            newWindowDescriptor.height = realHeight;
            
            windows.push(newWindowDescriptor);
        }
        
        if (windowAlreadyInWorkspace) {
            Logger.log('canFitWindow: Window already in workspace - checking current layout');
            // Update descriptor size to match reality or override
            const existingDescriptor = windows.find(w => w.id === newWindowId);
            if (existingDescriptor) {
                if (overrideSize) {
                    existingDescriptor.width = overrideSize.width;
                    existingDescriptor.height = overrideSize.height;
                } else {
                    // Skip constrained windows since their frame was already set above;
                    // preferredSize is pre-constraint and would wrongly report overflow.
                    const preferred = WindowState.get(window, 'preferredSize');
                    const isConstrained = WindowState.get(window, 'isConstrainedByMosaic');
                    const isMaximized = window.is_maximized();
                    if (preferred && !window.is_fullscreen() && !isMaximized && !isConstrained) {
                        existingDescriptor.width = preferred.width;
                        existingDescriptor.height = preferred.height;
                    }
                }
            }
        }
        
        // Try to tile with these windows
        const layout = this._tile(windows, availableSpace, relaxed);
        return !layout.overflow;
    }

    // Restore a window's size to its preferred/original dimensions
    restorePreferredSize(window) {
        if (!window) return;
        
        const preferredSize = WindowState.get(window, 'preferredSize') ||
                              WindowState.get(window, 'openingSize');
                              
        if (preferredSize) {
            Logger.log(`restorePreferredSize: Restoring window ${window.get_id()} to ${preferredSize.width}x${preferredSize.height}`);
            const frame = window.get_frame_rect();
            window.move_resize_frame(false, frame.x, frame.y, preferredSize.width, preferredSize.height);
            
            // Clear constraint flags
            WindowState.set(window, 'isSmartResizing', false);
            WindowState.set(window, 'targetSmartResizeSize', null);
        } else {
            Logger.log(`restorePreferredSize: No preferred size found for ${window.get_id()}`);
        }
    }

    // Save original size of a window before resizing
    saveOriginalSize(window) {
        if (!WindowState.has(window, 'originalSize')) {
            const frame = window.get_frame_rect();
            WindowState.set(window, 'originalSize', { width: frame.width, height: frame.height });
            Logger.log(`saveOriginalSize: Saved ${window.get_id()} as ${frame.width}x${frame.height}`);
        }
    }

    // Save the preferred size of a window (called once when window first appears or user manually resizes)
    // This is the TARGET size the window wants to be
     
    savePreferredSize(window) {
        // Skip - smart resize sets preferredSize in commitResizes()
        if (WindowState.get(window, 'isSmartResizing') || WindowState.get(window, 'isReverseSmartResizing')) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - during (reverse) smart resize`);
            return;
        }

        // Skip - smart resize already set preferredSize (don't override)
        if (WindowState.get(window, 'isConstrainedByMosaic')) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - already constrained by smart resize`);
            return;
        }

        // Skip sacred windows - managed by maximizedUndoInfo
        if (this._windowingManager.isMaximizedOrFullscreen(window)) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - sacred window (managed by maximizedUndoInfo)`);
            return;
        }

        // Skip windows that opened maximized and haven't settled yet
        if (WindowState.get(window, 'openedMaximized')) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - opened maximized, not yet settled`);
            return;
        }

        // Get frame size (window is not sacred here)
        const frame = window.get_frame_rect();
        const size = { width: frame.width, height: frame.height };
        // Defense-in-depth: reject monitor-sized dimensions during transitions
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (workspace && monitor !== null && monitor !== undefined) {
            const workArea = this._clampedWorkArea(workspace, monitor);
            if (workArea && size.width >= workArea.width && size.height >= workArea.height) {
                Logger.log(`savePreferredSize: Rejected monitor-sized dimensions ${size.width}x${size.height} for ${window.get_id()}`);
                return;
            }
        }
                               
        if (size && size.width > 10 && size.height > 10) {
            // Block save during maximize/fullscreen transitions
            if (WindowState.get(window, 'isEnteringSacred')) {
                Logger.log(`savePreferredSize: Save blocked by sacred transition flag for ${window.get_id()}`);
                return;
            }

            const current = WindowState.get(window, 'preferredSize');
            
            if (!current) {
                WindowState.set(window, 'preferredSize', size);
                Logger.log(`savePreferredSize: [INITIAL] Window ${window.get_id()} set to ${size.width}x${size.height}`);
            } else {
                const isExpansion = (size.width > current.width + 5) || (size.height > current.height + 5);
                const isContraction = (size.width < current.width - 5) || (size.height < current.height - 5);
                const isSmallChange = Math.abs(size.width - current.width) <= 2 && Math.abs(size.height - current.height) <= 2;

                if (isExpansion || isContraction) {
                    WindowState.set(window, 'preferredSize', size);
                    const label = isExpansion ? 'EXPANSION' : 'CONTRACTION';
                    Logger.log(`savePreferredSize: [${label}] Window ${window.get_id()} updated ${current.width}x${current.height} -> ${size.width}x${size.height}`);
                } else if (!isSmallChange) {
                    Logger.log(`savePreferredSize: [SKIP] Window ${window.get_id()} size ${size.width}x${size.height} within threshold of ${current.width}x${current.height}`);
                }
            }
        } else {
            Logger.log(`savePreferredSize: Could not determine valid preferred size for ${window.get_id()}`);
        }
    }
    
    // Clear preferred size when window is destroyed
     
    clearPreferredSize(window) {
        if (WindowState.has(window, 'preferredSize')) {
            WindowState.remove(window, 'preferredSize');
            Logger.log(`clearPreferredSize: Removed ${window.get_id()}`);
        }
    }

    getPreferredSize(window) {
        return WindowState.get(window, 'preferredSize') || null;
    }

    // Mirrors tryFitWithResize's binary search + miniature-threshold heuristic - a plain
    // "fits at minimum size" check isn't enough, since Smart Resize's real pass also
    // re-miniaturizes anything landing below half its min/max range even if it
    // geometrically fits. A looser gate here just restores it and watches Smart Resize
    // mini it right back (visible as a blink).
    canRestoreMiniature(candidateMini, remainingWindows, workArea) {
        const isResizable = w => w.allows_resize && w.allows_resize();
        const currentSizeOf = w => {
            if (w !== candidateMini && WindowState.get(w, IS_MINIATURE)) {
                const ms = getMiniatureSize(w);
                if (ms) return ms;
            }
            const pref = WindowState.get(w, 'preferredSize') || WindowState.get(w, 'openingSize');
            if (pref) return { width: pref.width, height: pref.height };
            const frame = w.get_frame_rect();
            return { width: frame.width, height: frame.height };
        };

        const descriptors = remainingWindows.map(w => {
            const current = currentSizeOf(w);
            const fixed = w !== candidateMini && WindowState.get(w, IS_MINIATURE);
            const resizable = !fixed && isResizable(w);
            const rawMin = resizable ? this.getWindowMinimumSize(w) : current;
            const min = { width: Math.min(rawMin.width, current.width), height: Math.min(rawMin.height, current.height) };
            return { window: w, current, min, resizable };
        });

        const sizeAt = (d, t) => d.resizable
            ? { width: Math.round(d.min.width + (d.current.width - d.min.width) * t),
                height: Math.round(d.min.height + (d.current.height - d.min.height) * t) }
            : d.current;

        const buildSim = (t) => descriptors.map(d => {
            const size = sizeAt(d, t);
            return { id: d.window.get_id(), width: size.width, height: size.height };
        });

        const preferredSim = buildSim(1.0);
        const result = this._tile(preferredSim, workArea, true);
        Logger.log(`canRestoreMiniature: candidate=${candidateMini.get_id()}, sim=${preferredSim.map(s => `${s.id}:${s.width}x${s.height}`).join(', ')}, overflow=${result.overflow}`);
        if (!result.overflow) return true;

        if (this._tile(buildSim(0.0), workArea, true).overflow) {
            Logger.log(`canRestoreMiniature: candidate=${candidateMini.get_id()} doesn't fit even at minimum sizes`);
            return false;
        }

        let lo = 0.0, hi = 1.0;
        for (let i = 0; i < 15; i++) {
            const mid = (lo + hi) / 2;
            if (!this._tile(buildSim(mid), workArea, true).overflow) lo = mid;
            else hi = mid;
        }

        const candidateDesc = descriptors.find(d => d.window === candidateMini);
        const simAtLo = sizeAt(candidateDesc, lo);
        const maxSize = this.getWindowMaximumSize(candidateMini);
        const thresholdW = (candidateDesc.min.width + (maxSize?.width || workArea.width)) / 2;
        const thresholdH = (candidateDesc.min.height + (maxSize?.height || workArea.height)) / 2;
        const wouldStayMini = simAtLo.width < thresholdW || simAtLo.height < thresholdH;

        Logger.log(`canRestoreMiniature: candidate=${candidateMini.get_id()} doesn't fit at preferred size, optimal scale=${lo.toFixed(4)} → ${simAtLo.width}x${simAtLo.height} (threshold ${Math.round(thresholdW)}x${Math.round(thresholdH)}), wouldStayMini=${wouldStayMini}`);
        return !wouldStayMini;
    }

    tryRestoreWindowSizes(windows, workArea, freedWidth, _freedHeight, _workspace, _monitor) {
        
        // Find windows that were shrunk (current size < preferred size)
        const shrunkWindows = [];
        for (const window of windows) {
            if (WindowState.get(window, IS_MINIATURE)) continue;
            const preferredSize = WindowState.get(window, 'preferredSize');
            if (!preferredSize) continue;
            
            const frame = window.get_frame_rect();
            const widthDiff = preferredSize.width - frame.width;
            const heightDiff = preferredSize.height - frame.height;
            
            Logger.log(`tryRestoreWindowSizes: Check ${window.get_id()}: frame=${frame.width}x${frame.height}, pref=${preferredSize.width}x${preferredSize.height}, diff=${widthDiff}x${heightDiff}`);
            
            // Window was shrunk if it's smaller than opening size (2px threshold for rounding)
            if (widthDiff > 2 || heightDiff > 2) {
                shrunkWindows.push({
                    window,
                    id: window.get_id(),
                    currentWidth: frame.width,
                    currentHeight: frame.height,
                    openingWidth: preferredSize.width,
                    openingHeight: preferredSize.height,
                    widthDeficit: Math.max(0, widthDiff),
                    heightDeficit: Math.max(0, heightDiff)
                });
            }
        }
        
        if (shrunkWindows.length === 0) {
            Logger.log('tryRestoreWindowSizes: No shrunk windows to restore (0/3 windows had deficits > 2px)');
            return false;
        }
        
        Logger.log(`tryRestoreWindowSizes: Found ${shrunkWindows.length} shrunk windows`);
        
        // Check if we have valid freed dimensions, otherwise calculate them
        if (freedWidth === null || freedWidth === undefined || isNaN(freedWidth)) {
            Logger.log('tryRestoreWindowSizes: Calculating available space from work area...');
            
            // Calculate currently used space by remaining windows (at their current sizes)
            let _usedWidth = 0;
            let _usedHeight = 0;
            
            if (windows.length > 0) {
                for (const w of windows) {
                    const f = w.get_frame_rect();
                    // In Mosaic, typically windows are side-by-side or stacked.
                    // A simple bbox approach is a good proxy for "available incremental space"
                    _usedWidth += f.width;
                    _usedHeight += f.height;
                }
            }
            
            // Use simulation to determine fit
            freedWidth = workArea.width; 
            _freedHeight = workArea.height;
        }

        // Calculate total deficits
        const totalWidthDeficit = shrunkWindows.reduce((sum, w) => sum + w.widthDeficit, 0);
        const totalHeightDeficit = shrunkWindows.reduce((sum, w) => sum + w.heightDeficit, 0);
        
        Logger.log(`tryRestoreWindowSizes: Total deficits: W=${totalWidthDeficit}px, H=${totalHeightDeficit}px`);

        if (totalWidthDeficit <= 0 && totalHeightDeficit <= 0) {
            Logger.log('tryRestoreWindowSizes: No deficit to fill');
            return false;
        }
        
        const result = this.findBestRestorationGain(windows, shrunkWindows, workArea);

        if (result) {
            const { gain: bestGain, layout: bestLayout } = result;
            // Success! Apply the restoration.
            Logger.log(`tryRestoreWindowSizes: Applying ${Math.round(bestGain * 100)}% restoration`);
            
            for (const sim of bestLayout) {
                const w = windows.find(win => win.get_id() === sim.id);
                if (w) {
                    if (WindowState.get(w, IS_MINIATURE)) continue;
                    WindowState.set(w, 'isReverseSmartResizing', true);

                    const frame = w.get_frame_rect();
                    this._animateResize(w, frame, sim.width, sim.height);

                    const shrunk = shrunkWindows.find(sw => sw.id === w.get_id());
                    if (shrunk) {
                        // If fully restored (allow for small pixel rounding errors), remove constraint
                        if (sim.width >= shrunk.openingWidth - 2 && sim.height >= shrunk.openingHeight - 2) {
                            Logger.log(`tryRestoreWindowSizes: Window ${sim.id} fully restored!`);
                            WindowState.set(w, 'isConstrainedByMosaic', false);
                            WindowState.set(w, 'targetSmartResizeSize', null);
                        } else {
                            // Still constrained, but update mask
                            WindowState.set(w, 'targetSmartResizeSize', { width: sim.width, height: sim.height });
                        }
                    }
                }
            }
            return true;
        } else {
            Logger.log('tryRestoreWindowSizes: Restoration would cause overflow even at 10% - waiting');
            for (const w of windows) {
                WindowState.remove(w, 'isReverseSmartResizing');
            }
            return false;
        }
    }
    // Calculate window area as ratio of workspace area
     
    getWindowAreaRatio(frame, workArea) {
        const windowArea = frame.width * frame.height;
        const workspaceArea = workArea.width * workArea.height;
        return windowArea / workspaceArea;
    }

    // get_work_area_for_monitor can overshoot physical bounds in some display setups.
    _clampedWorkArea(workspace, monitor) {
        const area = workspace.get_work_area_for_monitor(monitor);
        if (!area) return null;
        const geom = global.display.get_monitor_geometry(monitor);
        const maxW = geom.x + geom.width - area.x;
        const maxH = geom.y + geom.height - area.y;
        if (area.width <= maxW && area.height <= maxH) return area;
        return { x: area.x, y: area.y, width: Math.min(area.width, maxW), height: Math.min(area.height, maxH) };
    }

    // Helper to get usable work area considering edge tiles
    getUsableWorkArea(workspace, monitor) {
        if (this._edgeTilingManager) {
            const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            if (edgeTiledWindows.length > 0) {
                // If the workspace is fully occupied (left + right), return zero/empty rect
                const zones = edgeTiledWindows.map(w => w.zone);
                const hasLeft = zones.some(z => [TileZone.LEFT_FULL, TileZone.TOP_LEFT, TileZone.BOTTOM_LEFT].includes(z));
                const hasRight = zones.some(z => [TileZone.RIGHT_FULL, TileZone.TOP_RIGHT, TileZone.BOTTOM_RIGHT].includes(z));

                if (hasLeft && hasRight) {
                    return { x: 0, y: 0, width: 0, height: 0 };
                }

                return this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            }
        }
        return this._clampedWorkArea(workspace, monitor);
    }

    // Calculate layouts without moving windows (for Overview)
    calculateLayoutsOnly(targetWorkspace = null, targetMonitor = null) {
        const workspace = targetWorkspace || global.workspace_manager.get_active_workspace();
        
        // Handle monitor index or object
        let monitorIndex = global.display.get_primary_monitor();
        if (targetMonitor !== null && targetMonitor !== undefined) {
            monitorIndex = typeof targetMonitor === 'number' ? targetMonitor : targetMonitor.index;
        } else {
            const focusMon = global.display.get_focus_window()?.get_monitor();
            if (focusMon !== undefined && focusMon !== null)
                monitorIndex = focusMon;
        }
        
        // Pass excludeFromTiling=false to ensure we consider the new window
        const working_info = this._getWorkingInfo(workspace, null, monitorIndex, false);
        if(!working_info) return;

        const meta_windows = working_info.meta_windows;
        const windows = working_info.windows;
        const work_area = working_info.work_area;

        // Populate ComputedLayouts cache without moving windows (dryRun=true)
        // Must perform the tiling calculation first
        const tile_info = this._tile(windows, work_area);
        
        // Then run the draw phase in dryRun mode to just populate the cache
        this._drawTile(tile_info, work_area, meta_windows, true);
    }

    tryFitWithResize(newWindow, windows, workArea, focusedWindowOverride = null) {
        if (this._isSmartResizingBlocked) {
            Logger.log('[SMART RESIZE] tryFitWithResize BLOCKED by _isSmartResizingBlocked');
            return { success: false };
        }
        this._isSmartResizingBlocked = true;

        // Reset rebalance counter for this new smart resize cycle
        this._extension?.resizeHandler?.resetConstraintRebalanceCount();

        try {
            const allResizable = [];
            const allWindows = [];
            const windowData = new Map();

            // Collect data for all windows (deduplicated)
            for (const w of [...windows, newWindow]) {
                if (allWindows.some(aw => aw.get_id() === w.get_id())) continue;

                // Skip destroyed windows, since get_frame_rect on a disposed MetaWindow segfaults libmutter.
                if (!isWindowAlive(w)) {
                    Logger.log(`[SMART RESIZE] Skipping destroyed window ${w?.get_id?.() ?? '?'}`);
                    continue;
                }

                // Already-miniaturized: include as non-resizable fixed participants so the simulation
                // accounts for the space they occupy. Must come before the uninitialized check, since
                // minis never get isConstrainedByMosaic (they skip that branch in drawTile) and
                // may lack preferredSize, so they'd otherwise get filtered out as uninitialized.
                if (WindowState.get(w, IS_MINIATURE)) {
                    const ms = getMiniatureSize(w);
                    if (ms) {
                        allWindows.push(w);
                        windowData.set(w.get_id(), { window: w, current: ms, min: ms, isResizable: false });
                    }
                    continue;
                }

                // Skip uninitialized windows, since unreliable geometry corrupts the binary search
                if (w.get_id() !== newWindow.get_id()
                    && !WindowState.get(w, 'preferredSize')
                    && !WindowState.get(w, 'openingSize')
                    && !WindowState.get(w, 'isConstrainedByMosaic')) {
                    Logger.log(`[SMART RESIZE] Skipping uninitialized window ${w.get_id()}`);
                    continue;
                }

                allWindows.push(w);

                // Use preferred size as ceiling for deterministic binary search
                const preferred = WindowState.get(w, 'preferredSize') || WindowState.get(w, 'openingSize');
                const current = preferred || this.getEffectiveWindowSize(w);
                const min = this.getWindowMinimumSize(w);
                const isResizable = w.allows_resize && w.allows_resize();

                windowData.set(w.get_id(), { window: w, current, preferred, min, isResizable });
                if (isResizable) allResizable.push(w);
            }

            if (allResizable.length === 0) return { success: false };

            Logger.log(`[SMART RESIZE] tryFitWithResize: ${allWindows.length} windows (${allResizable.length} resizable), workArea: ${workArea.width}×${workArea.height}`);
            for (const [id, d] of windowData) {
                Logger.log(`[SMART RESIZE]   ${id}(${d.window.get_wm_class()}): current=${d.current.width}×${d.current.height}, min=${d.min.width}×${d.min.height}, resizable=${d.isResizable}, addedTime=${WindowState.get(d.window, 'addedTime')}`);
            }

            // Interpolate between min and current sizes at factor t (1=current, 0=min)
            // If window is marked pendingMiniature, use its miniature size instead of current
            const buildSimulated = (t) => allWindows.map(w => {
                const d = windowData.get(w.get_id());
                if (!d.isResizable)
                    return { id: w.get_id(), width: d.current.width, height: d.current.height };

                // If this window is pending miniature, use miniature size (not interpolated)
                if (d.pendingMiniature && d.miniSize) {
                    Logger.log(`[SMART RESIZE] buildSimulated: ${w.get_id()} using MINI SIZE ${d.miniSize.width}x${d.miniSize.height}`);
                    return { id: w.get_id(), width: d.miniSize.width, height: d.miniSize.height };
                }

                const effMinW = Math.min(d.min.width, d.current.width);
                const effMinH = Math.min(d.min.height, d.current.height);
                return {
                    id: w.get_id(),
                    width: Math.round(effMinW + (d.current.width - effMinW) * t),
                    height: Math.round(effMinH + (d.current.height - effMinH) * t),
                };
            });

            // Step 1: Natural fit check (current sizes)
            if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Natural fit, no resize needed');
                return { success: true, tileInfo: null, pendingWindows: [] };
            }

            // Step 2: minimum fit check, if it doesn't fit at minimums try miniaturization
            if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Overflow inevitable, windows don\'t fit even at minimums');

                const ext0 = this._extension;
                if (ext0?.miniatureManager) {
                    const focusedId0 = (focusedWindowOverride ?? global.display.focus_window)?.get_id();

                    // Oldest first: whichever window has been open longest is the
                    // best candidate to sacrifice, regardless of which window's
                    // pass happens to be running right now.
                    const orderedWindows0 = [...allWindows].sort((a, b) =>
                        (WindowState.get(a, 'addedTime') ?? 0) - (WindowState.get(b, 'addedTime') ?? 0));

                    for (const w of orderedWindows0) {
                        const d = windowData.get(w.get_id());
                        if (!d || d.pendingMiniature) continue;
                        if (w.get_id() === focusedId0 || this._isRecentlyAdded(w)) continue;
                        if (WindowState.get(w, IS_MINIATURE)) continue;
                        if (this._windowingManager.isMaximizedOrFullscreen(w)) continue;
                        if (!d.isResizable) continue;

                        const nonMiniCount = allWindows.filter(aw =>
                            !WindowState.get(aw, IS_MINIATURE) && !windowData.get(aw.get_id())?.pendingMiniature
                        ).length;
                        if (nonMiniCount <= 1) break;

                        const frame  = w.get_frame_rect();
                        // Scale from current frame so the visual fills the slot.
                        const scale  = constants.MINIATURE_TARGET_SIZE_PX / Math.max(frame.width, frame.height);
                        d.pendingMiniature = true;
                        d.miniSize         = { width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) };
                        d.pendingPreSize   = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
                        Logger.log(`[SMART RESIZE] ${w.get_id()}: miniaturizing to make room (${d.miniSize.width}x${d.miniSize.height})`);

                        if (!this._tile(buildSimulated(0.0), workArea, true).overflow) break;
                    }
                }

                if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                    Logger.log('[SMART RESIZE] Still overflow after miniaturization, applying overflow logic');
                    return { success: false, tileInfo: null, pendingWindows: [] };
                }
            }

            // Step 3: Binary search for optimal scale factor
            let lo = 0.0, hi = 1.0;
            for (let i = 0; i < 15; i++) {
                const mid = (lo + hi) / 2;
                if (!this._tile(buildSimulated(mid), workArea, true).overflow)
                    lo = mid;
                else
                    hi = mid;
            }

            Logger.log(`[SMART RESIZE] Optimal scale factor: ${lo.toFixed(4)}`);

            // Step 4a: Iterative miniaturization (before applying final sizes)
            const ext = this._extension;
            if (ext?.miniatureManager) {
                // focusedWindowOverride lets callers (e.g. mini-restore) treat a
                // specific window as the user-active one when Mutter's focus hasn't
                // shifted yet. Without it, restoring a miniature while focus sits on
                // the other window would exclude both, leaving no miniaturization candidate.
                const focusedId = (focusedWindowOverride ?? global.display.focus_window)?.get_id();

                const getMiniatureThreshold = (w) => {
                    const min        = this.getWindowMinimumSize(w);
                    const maxSize    = this.getWindowMaximumSize(w);
                    const effectiveMaxW = maxSize?.width  || workArea.width;
                    const effectiveMaxH = maxSize?.height || workArea.height;
                    return {
                        thresholdW: (min.width  + effectiveMaxW) / 2,
                        thresholdH: (min.height + effectiveMaxH) / 2,
                    };
                };

                for (let iter = 0; iter < allWindows.length; iter++) {
                    const candidates = buildSimulated(lo).filter(sim => {
                        const d = windowData.get(sim.id);
                        if (!d) return false;
                        if (d.pendingMiniature) return false;
                        if (sim.id === focusedId || this._isRecentlyAdded(d.window)) return false;
                        if (WindowState.get(d.window, IS_MINIATURE)) return false;
                        if (this._windowingManager.isMaximizedOrFullscreen(d.window)) return false;
                        const { thresholdW, thresholdH } = getMiniatureThreshold(d.window);
                        return sim.width < thresholdW || sim.height < thresholdH;
                    });

                    if (candidates.length === 0) break;

                    // Oldest first: the longest-open window is the best one to sacrifice,
                    // regardless of which window's pass happens to be running right now.
                    candidates.sort((a, b) =>
                        (WindowState.get(windowData.get(a.id).window, 'addedTime') ?? 0) -
                        (WindowState.get(windowData.get(b.id).window, 'addedTime') ?? 0));
                    const candidateSim  = candidates[0];
                    const candidateData = windowData.get(candidateSim.id);

                    // Guard 1: never miniaturize the last visible (non-miniature, non-pending) window
                    const nonMiniatureCount = allWindows.filter(w =>
                        !WindowState.get(w, IS_MINIATURE) && !windowData.get(w.get_id())?.pendingMiniature
                    ).length;
                    if (nonMiniatureCount <= 1) {
                        Logger.log(`[MINIATURE] Guard 1: refusing to miniaturize last non-miniature window ${candidateSim.id}`);
                        break;
                    }

                    candidateData.pendingMiniature = true;
                    candidateData.miniatureTargetSlot = null;
                    Logger.log(`[MINIATURE] Marking ${candidateSim.id}(${candidateData.window.get_wm_class()}) as PENDING miniature (will be created after layout)`);

                    const frame4a   = candidateData.window.get_frame_rect();
                    // Scale from current frame so the visual fills the slot.
                    const natural4a = candidateData.preferred || candidateData.current;
                    const scale     = constants.MINIATURE_TARGET_SIZE_PX / Math.max(frame4a.width, frame4a.height);
                    const miniSize  = { width: Math.round(frame4a.width * scale), height: Math.round(frame4a.height * scale) };
                    candidateData.miniSize       = miniSize;
                    candidateData.pendingPreSize = { x: frame4a.x, y: frame4a.y, width: frame4a.width, height: frame4a.height };
                    Logger.log(`[MINIATURE] ${candidateSim.id} PENDING at frame=${frame4a.width}x${frame4a.height} restore=${natural4a.width}x${natural4a.height} → miniSize: ${miniSize.width}x${miniSize.height} scale: ${scale}`);

                    // Do NOT remove from allWindows/allResizable yet, keep it for layout computation
                    // (the window will be treated as miniature-sized in buildSimulated)

                    if (allResizable.length === 0) break;

                    // Check if remaining windows now fit naturally.
                    // Lock lo at 1.0 so Step 4 applies preferred sizes. Without this,
                    // lo would stay at the pre-mini scale and the freed space
                    // wouldn't be reclaimed by the non-mini siblings.
                    if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                        lo = 1.0;
                        break;
                    }

                    // Binary search on remaining windows
                    lo = 0.0;
                    let hiNew = 1.0;
                    for (let i = 0; i < 15; i++) {
                        const mid = (lo + hiNew) / 2;
                        if (!this._tile(buildSimulated(mid), workArea, true).overflow) lo = mid;
                        else hiNew = mid;
                    }
                }
            }

            // Step 4: Apply final sizes (factor lo = largest that fits)
            const finalSizes = buildSimulated(lo);
            const pendingWindows = [];
            const grownWindows = [];
            for (const sim of finalSizes) {
                const d = windowData.get(sim.id);
                if (!d.isResizable) continue;

                const w = d.window;
                const frame = w.get_frame_rect();

                // sim ≥ preferred means the algorithm decided this window can sit at
                // (or above) its preferred size. If the actual frame is smaller
                // (left over from a previous smart-resize we now have space to undo),
                // grow it back so siblings reclaim the freed space.
                if (sim.width >= d.current.width && sim.height >= d.current.height) {
                    if (frame.width < d.current.width - 2 || frame.height < d.current.height - 2) {
                        WindowState.set(w, 'isConstrainedByMosaic', false);
                        WindowState.set(w, 'targetSmartResizeSize', null);
                        WindowState.set(w, 'targetRestoredSize', { width: d.current.width, height: d.current.height });
                        this._animateResize(w, frame, d.current.width, d.current.height, true);
                        grownWindows.push(w);
                        Logger.log(`[SMART RESIZE] ${sim.id}: grow back ${frame.width}×${frame.height} → ${d.current.width}×${d.current.height}`);
                    }
                    continue;
                }

                if (!WindowState.has(w, 'preferredSize'))
                    WindowState.set(w, 'preferredSize', { width: d.current.width, height: d.current.height });
                WindowState.set(w, 'originalSize', { width: d.current.width, height: d.current.height });
                WindowState.set(w, 'isConstrainedByMosaic', true);
                WindowState.set(w, 'targetSmartResizeSize', { width: sim.width, height: sim.height });

                if (d.pendingMiniature) {
                    const storedPreSize = d.pendingPreSize || d.current;
                    pendingWindows.push({ window: w, miniSize: d.miniSize, preSize: storedPreSize });
                    Logger.log(`[MINIATURE] ${w.get_id()} stored in pendingWindows: preSize=${storedPreSize.width}x${storedPreSize.height}, SKIPPING move_resize_frame (will be miniaturized)`);
                    continue;
                }
                this._animateResize(w, frame, sim.width, sim.height, true);
                Logger.log(`[SMART RESIZE] ${sim.id}: ${d.current.width}×${d.current.height} → ${sim.width}×${sim.height}`);
            }

            // Clear targetRestoredSize bridge after Wayland frame settles. Until
            // then WindowDescriptor reads this value instead of the stale frame.
            if (grownWindows.length > 0 && this._extension?._timeoutRegistry) {
                this._extension._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                    for (const gw of grownWindows) {
                        WindowState.remove(gw, 'targetRestoredSize');
                    }
                    return false;
                }, 'tryFitWithResize_growSettle');
            }

            // Build final tile_info with current sizes for subsequent draw phase
            const finalTileInfo = this._tile(windows, workArea);

            Logger.log(`[TRYFIT] Returning pendingWindows len=${pendingWindows.length}`);
            return { success: true, tileInfo: finalTileInfo, pendingWindows };
        } finally {
            this._isSmartResizingBlocked = false;
        }
    }

    // Re-run binary search with corrected minimums after client-side clamping detection.
    // Uses preferredSize (original pre-smart-resize) as ceiling for full interpolation range.
    rebalanceSmartResize(workspace, monitor) {
        if (this._isSmartResizingBlocked) {
            Logger.log('[SMART RESIZE] Rebalance blocked');
            return;
        }
        this._isSmartResizingBlocked = true;

        try {
            const workArea = this.getUsableWorkArea(workspace, monitor);
            const allWindows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                .filter(w => !WindowState.get(w, 'pendingInQueue') &&
                             !this._edgeTilingManager?.isEdgeTiled(w) &&
                             !this._windowingManager.isMaximizedOrFullscreen(w));

            if (allWindows.length === 0) return;

            const windowData = new Map();
            const allResizable = [];

            for (const w of allWindows) {
                // Use preferred/original size as ceiling (the size before smart resize)
                const preferred = WindowState.get(w, 'preferredSize') || WindowState.get(w, 'originalSize');
                const current = preferred || this.getEffectiveWindowSize(w);
                const min = this.getWindowMinimumSize(w);
                const isResizable = w.allows_resize?.();

                windowData.set(w.get_id(), { window: w, current, min, isResizable });
                if (isResizable) allResizable.push(w);
            }

            if (allResizable.length === 0) return;

            Logger.log(`[SMART RESIZE] Rebalancing ${allWindows.length} windows, workArea: ${workArea.width}×${workArea.height}`);
            for (const [id, d] of windowData) {
                Logger.log(`[SMART RESIZE]   Rebal ${id}: ceiling=${d.current.width}×${d.current.height}, min=${d.min.width}×${d.min.height}`);
            }

            const buildSimulated = (t) => allWindows.map(w => {
                const d = windowData.get(w.get_id());
                if (!d.isResizable)
                    return { id: w.get_id(), width: d.current.width, height: d.current.height };
                const effMinW = Math.min(d.min.width, d.current.width);
                const effMinH = Math.min(d.min.height, d.current.height);
                return {
                    id: w.get_id(),
                    width: Math.round(effMinW + (d.current.width - effMinW) * t),
                    height: Math.round(effMinH + (d.current.height - effMinH) * t),
                };
            });

            // Natural fit: all at preferred sizes
            if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Rebalance: natural fit, restoring preferred sizes');
                for (const w of allWindows) {
                    const d = windowData.get(w.get_id());
                    if (!d.isResizable) continue;
                    const frame = w.get_frame_rect();
                    WindowState.set(w, 'isSmartResizing', true);
                    this._animateResize(w, frame, d.current.width, d.current.height, true);
                    WindowState.set(w, 'isSmartResizing', false);
                    WindowState.set(w, 'targetSmartResizeSize', null);
                    WindowState.set(w, 'isConstrainedByMosaic', false);
                }
                this.invalidateLayoutCache();
                this.tileWorkspaceWindows(workspace, null, monitor, true);
                return;
            }

            // Overflow inevitable at corrected minimums
            if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Rebalance: overflow inevitable at corrected minimums');
                // Clear smart resize state and let normal overflow handle it
                for (const w of allWindows) {
                    WindowState.set(w, 'targetSmartResizeSize', null);
                    WindowState.set(w, 'isConstrainedByMosaic', false);
                }

                // Find newest window and overflow it
                const newest = allWindows.reduce((n, w) => {
                    const t1 = WindowState.get(w, 'addedTime') || 0;
                    const t2 = WindowState.get(n, 'addedTime') || 0;
                    return t1 > t2 ? w : n;
                }, allWindows[0]);

                Logger.log(`[SMART RESIZE] Overflowing newest window ${newest.get_id()}`);
                this._windowingManager.moveOversizedWindow(newest).then(() => {
                    this.invalidateLayoutCache();
                    this.tileWorkspaceWindows(workspace, null, monitor, true);
                }).catch(e => Logger.error(`Rebalance overflow failed: ${e}`));
                return;
            }

            // Binary search with corrected minimums
            let lo = 0.0, hi = 1.0;
            for (let i = 0; i < 15; i++) {
                const mid = (lo + hi) / 2;
                if (!this._tile(buildSimulated(mid), workArea, true).overflow)
                    lo = mid;
                else
                    hi = mid;
            }

            Logger.log(`[SMART RESIZE] Rebalance scale factor: ${lo.toFixed(4)}`);

            const finalSizes = buildSimulated(lo);
            for (const sim of finalSizes) {
                const d = windowData.get(sim.id);
                if (!d.isResizable) continue;
                if (sim.width >= d.current.width && sim.height >= d.current.height) continue;

                const w = d.window;
                const frame = w.get_frame_rect();
                WindowState.set(w, 'targetSmartResizeSize', { width: sim.width, height: sim.height });
                WindowState.set(w, 'isConstrainedByMosaic', true);

                this._animateResize(w, frame, sim.width, sim.height, true);
                Logger.log(`[SMART RESIZE] Rebal ${sim.id}: → ${sim.width}×${sim.height}`);
            }

            this.invalidateLayoutCache();
            // Save pending miniatures before recursive call (which resets the array)
            const savedPending = this._pendingMiniatureWindows;
            this.tileWorkspaceWindows(workspace, null, monitor, true);
            // Restore after recursive tiling completes
            this._pendingMiniatureWindows = savedPending;
        } finally {
            this._isSmartResizingBlocked = false;
        }
    }

    destroy() {
        this.destroyMasks();
        ComputedLayouts.clear();
        this._isSmartResizingBlocked = false;
        this._restoringWindowId = null;
        this._lastTiledOrder = null;
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
        this._pendingMiniatureWindows = null;
        this._workspaceSwaps = null;
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
        this._extension = null;
    }
});

class WindowDescriptor {
    constructor(meta_window, index) {
        const frame = meta_window.get_frame_rect();

        this.index = index;
        this.x = frame.x;
        this.y = frame.y;
        this.metaWindow = meta_window;

        // Miniature size takes first priority
        const miniSize = getMiniatureSize(meta_window);
        this.isMiniature = !!miniSize;
        if (miniSize) {
            this.width  = miniSize.width;
            this.height = miniSize.height;
            Logger.log(`WindowDescriptor: Using miniatureSize ${this.width}x${this.height} for ${meta_window.get_id()}`);
        } else {
            // Use target dimensions if unmaximizing, as physical frame might still be maximized.
            const targetSize = WindowState.get(meta_window, 'targetRestoredSize');
            // Use smart resize target dims if move_resize_frame hasn't completed yet.
            const smartResizeSize = WindowState.get(meta_window, 'targetSmartResizeSize');

            if (targetSize) {
                this.width = targetSize.width;
                this.height = targetSize.height;
                Logger.log(`WindowDescriptor: Using targetRestoredSize ${this.width}x${this.height} for ${meta_window.get_id()}`);
            } else if (smartResizeSize) {
                this.width = smartResizeSize.width;
                this.height = smartResizeSize.height;
                Logger.log(`WindowDescriptor: Using targetSmartResizeSize ${this.width}x${this.height} for ${meta_window.get_id()}`);
            } else {
                // Use the actual frame dimensions instead of a hardcoded fallback
                this.width = frame.width > 0 ? frame.width : 1;
                this.height = frame.height > 0 ? frame.height : 1;
            }
        }

        this.id = meta_window.get_id();
    }
    
    draw(meta_windows, x, y, masks, isDragging, drawingManager, dryRun = false) {
        const window = meta_windows.find(w => w.get_id() === this.id);
        if (window) {
        // If dry run, just return - the layout cache was already updated in the caller
            if (dryRun) return;

            const isMask = masks.has(this.id);
        
            if (isDragging) {
                if (isMask) {
                // This is the dragged window - draw preview at its target position
                    if (drawingManager) {
                        drawingManager.rect(x, y, this.width, this.height);
                    }
                } else {
                // This is NOT the dragged window - reposition it
                    const isMiniature = WindowState.get(window, IS_MINIATURE);
                    if (isMiniature) {
                        // Miniatures use actor transforms, since move_resize_frame would shrink the frame and compound the scale.
                        const windowActor = window.get_compositor_private();
                        if (windowActor && !windowActor.is_destroyed()) {
                            const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
                            const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                            const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                            animateMiniatureToTarget(windowActor, window, sc, extL, extT, x, y,
                                constants.ANIMATION_DURATION_MS);
                            WindowState.get(window, MINIATURE_OVERLAY)?.animateToPosition(constants.ANIMATION_DURATION_MS);
                        }
                    } else {
                        const currentRect = window.get_frame_rect();
                        const windowActor = window.get_compositor_private();
                        const currentScale = (windowActor && !windowActor.is_destroyed()) ? windowActor.scale_x : 1;
                        const hasPreviewTransforms = Math.abs(currentScale - 1.0) > 0.01;

                        Logger.log(`draw (drag): id=${this.id}, target=(${x},${y}), current=(${currentRect.x},${currentRect.y}), scale=${currentScale.toFixed(3)}`);

                        if (hasPreviewTransforms && windowActor && !windowActor.is_destroyed()) {
                            // actor.x changes after move_resize_frame; read all state first.
                            const extLeft = currentRect.x - windowActor.x;
                            const extTop = currentRect.y - windowActor.y;
                            const [actorW, actorH] = windowActor.get_size();
                            const [cpx, cpy] = windowActor.get_pivot_point();
                            const visualX = windowActor.x + cpx * actorW * (1 - currentScale) + windowActor.translation_x + extLeft * currentScale;
                            const visualY = windowActor.y + cpy * actorH * (1 - currentScale) + windowActor.translation_y + extTop * currentScale;
                            WindowState.set(window, 'isConstrainedByMosaic', true);
                            window.move_resize_frame(false, x, y, this.width, this.height);
                            const actor_x_new = x - extLeft;
                            const actor_y_new = y - extTop;
                            const dw = actorW * (1 - currentScale);
                            const dh = actorH * (1 - currentScale);
                            const px = dw > 0 ? Math.max(0, Math.min(1, (visualX - actor_x_new - extLeft * currentScale) / dw)) : 0;
                            const py = dh > 0 ? Math.max(0, Math.min(1, (visualY - actor_y_new - extTop * currentScale) / dh)) : 0;
                            const startTx = visualX - actor_x_new - px * dw - extLeft * currentScale;
                            const startTy = visualY - actor_y_new - py * dh - extTop * currentScale;
                            windowActor.set_pivot_point(px, py);
                            // Same leak as miniature.js's createMiniature: a tile animation may
                            // still be in flight here, and nothing else would clear it from
                            // AnimationsManager's tracking once this preview-undo ease takes over.
                            this._extension?.animationsManager?.removeAnimatingWindow(window.get_id());
                            windowActor.remove_all_transitions();
                            windowActor.set_scale(currentScale, currentScale);
                            windowActor.set_translation(startTx, startTy, 0);
                            windowActor.ease({
                                scale_x: 1,
                                scale_y: 1,
                                translation_x: 0,
                                translation_y: 0,
                                opacity: 255,
                                duration: Math.ceil(constants.ANIMATION_DURATION_MS * getSlowDownFactor()),
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                        } else {
                            const positionChanged = Math.abs(currentRect.x - x) > 5 || Math.abs(currentRect.y - y) > 5;
                            const sizeChanged = Math.abs(currentRect.width - this.width) > 5 || Math.abs(currentRect.height - this.height) > 5;
                            if (positionChanged || sizeChanged) {
                                WindowState.set(window, 'isConstrainedByMosaic', true);
                                window.move_resize_frame(false, x, y, this.width, this.height);
                                if (windowActor && !windowActor.is_destroyed()) {
                                    const translateX = currentRect.x - x;
                                    const translateY = currentRect.y - y;
                                    windowActor.set_translation(translateX, translateY, 0);
                                    windowActor.ease({
                                        translation_x: 0,
                                        translation_y: 0,
                                        opacity: 255,
                                        duration: Math.ceil(constants.ANIMATION_DURATION_MS * getSlowDownFactor()),
                                        mode: Clutter.AnimationMode.EASE_OUT_QUAD
                                    });
                                }
                            }
                        }
                    }
                }
            } else {
                const isMiniature = WindowState.get(window, IS_MINIATURE);
                if (isMiniature) {
                    // Do NOT move_frame for miniatures (Mutter may reject)
                    const windowActor = window.get_compositor_private();
                    if (windowActor && !windowActor.is_destroyed()) {
                        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
                        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                        if (WindowState.get(window, ANIMATING_MINIATURE)) {
                            WindowState.set(window, MINIATURE_TARGET_POS, { x, y });
                        } else {
                            applyMiniatureActorState(windowActor, sc, extL, extT, x, y);
                            WindowState.set(window, MINIATURE_TARGET_POS, { x, y });
                        }
                        WindowState.get(window, MINIATURE_OVERLAY)?.updatePosition();
                        Logger.log(`[MINIATURE] draw ${window.get_id()}: target=(${x},${y}) scale=${sc.toFixed(4)} extLeft=${extL} extTop=${extT} size=${this.width}x${this.height}`);
                    }
                } else {
                    WindowState.set(window, 'isConstrainedByMosaic', true);
                    window.move_resize_frame(false, x, y, this.width, this.height);
                    Logger.log(`[LAYOUT] draw ${window.get_id()}: target=(${x},${y}) size=${this.width}x${this.height}`);
                }
            }
        } else {
            Logger.warn(`Could not find window with ID ${this.id} for drawing`);
        }
    }
}

class Level {
    constructor(work_area) {
        this.x = 0;
        this.y = 0;
        this.width = 0;
        this.height = 0;
        this.windows = [];
        this.work_area = work_area;
    }

    draw_horizontal(meta_windows, work_area, y, masks, isDragging, drawingManager, dryRun = false, slotsOut = null) {
        let x = this.x;
        for(const window of this.windows) {
            const center_offset = (work_area.height / 2 + work_area.y) - (y + window.height / 2);
            let y_offset = 0;
            if(center_offset > 0)
                y_offset = Math.min(center_offset, this.height - window.height);

            // Use targetX/targetY if set (for center-gravity alignment), otherwise use calculated position
            const drawX = window.targetX !== undefined ? window.targetX : x;
            const drawY = window.targetY !== undefined ? window.targetY : y + y_offset;

            if (!dryRun)
                Logger.log(`Window ${window.id} target: ${drawX},${drawY} (${window.width}x${window.height})`);

            if (window.metaWindow) {
                const slot = { x: drawX, y: drawY, width: window.width, height: window.height };
                ComputedLayouts.set(window.metaWindow, slot);
                if (slotsOut) slotsOut.set(window.metaWindow.get_id(), slot);
            }

            window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
            x += window.width + constants.WINDOW_SPACING;
        }
    }

    draw_vertical(meta_windows, x, masks, isDragging, drawingManager, dryRun = false, slotsOut = null) {
        let y = this.y;
        for(const window of this.windows) {
            // Use targetX/targetY if set (for center-gravity alignment), otherwise use calculated position
            const drawX = window.targetX !== undefined ? window.targetX : x;
            const drawY = window.targetY !== undefined ? window.targetY : y;

            if (!dryRun)
                Logger.log(`Window ${window.id} target: ${drawX},${drawY} (${window.width}x${window.height})`);

            if (window.metaWindow) {
                const slot = { x: drawX, y: drawY, width: window.width, height: window.height };
                ComputedLayouts.set(window.metaWindow, slot);
                if (slotsOut) slotsOut.set(window.metaWindow.get_id(), slot);
            }

            window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
            y += window.height + constants.WINDOW_SPACING;
        }
    }
}

class Mask {
    constructor(window) {
        // window can be a MetaWindow or a WindowDescriptor
        this.id = window.id !== undefined ? `mask_${window.id}` : `mask_${window.get_id()}`;
        this.x = window.x;
        this.y = window.y;
        this.width = window.width;
        this.height = window.height;
    }
    draw(_, x, y, _masks, _isDragging, drawingManager) {
        if (drawingManager) {
            // DO NOT call removeBoxes here - it's called once in destroyMasks() at start of tiling
            drawingManager.rect(x, y, this.width, this.height);
        }
    }
}

