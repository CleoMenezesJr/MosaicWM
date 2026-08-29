// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Core mosaic tiling algorithm and layout management

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import { TileZone, ZONE_SIDE } from './constants.js';
import * as WindowState from './windowState.js';
import { ComputedLayouts, MosaicModel } from './mosaicModel.js';
import { MosaicConstraints } from './mosaicConstraint.js';
import { rectOf } from './mosaicTileGroup.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    MINIATURE_TARGET_POS,
    MINIATURE_EXT_LEFT,
    MINIATURE_EXT_TOP,
    MINIATURE_OVERLAY,
    ANIMATING_MINIATURE,
    PENDING_MINIATURE,
} from './windowState.js';
import { getMiniatureSize, applyMiniatureActorState, animateMiniatureToTarget } from './miniature.js';
import { isWindowAlive } from './liveness.js';
import { getSlowDownFactor, monotonicNow } from './timing.js';

const POSITION_STABILITY_WEIGHT = 40;
// These two only ever compete with each other. Nothing outscores the layout that reproduces
// the previous one, so the unscaled +5 in _scoreOrder only ever breaks an exact tie.
const GROUP_STABILITY_WEIGHT = 150;
// Geometry gaps narrower than this are noise, so stability picks instead. Worth 2% of the
// work area in bounding box, about a 200px square.
const STABILITY_TIE_BAND = 0.4;

// Every ordered composition of n into 1..n groups (n=3 gives [3],[2,1],[1,2],[1,1,1]).
// A lazy generator on purpose: the count is 2^(n-1), so callers iterate under a time
// budget and stop early instead of materializing all of it for a huge window count.
export function* generateRowCompositions(n) {
    if (n <= 0) return;
    if (n === 1) { yield [1]; return; }

    function* build(remaining, groupsLeft, acc) {
        if (remaining === 0) {
            yield acc.slice();
            return;
        }
        if (groupsLeft === 0) return;
        // Reserve at least one window per remaining group so we never overshoot.
        const maxFirst = groupsLeft === 1 ? remaining : remaining - (groupsLeft - 1);
        for (let first = 1; first <= maxFirst; first++) {
            acc.push(first);
            yield* build(remaining - first, groupsLeft - 1, acc);
            acc.pop();
        }
    }
    for (let groups = 1; groups <= n; groups++)
        yield* build(n, groups, []);
}

// Mutter will not place a window outside the work area; it silently clamps. Land on the same
// spot it would, or the layout believes the window is somewhere it never was.
function clampToWorkArea(x, y, width, height, bounds) {
    if (!bounds) return { x, y };
    return {
        x: Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - width)),
        y: Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - height)),
    };
}

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
        // Live for the whole grab, unlike isDragging/masks, which only exist once startDrag runs. The
        // edge tile exit tiles before that point, and the layout can't move what the cursor is holding.
        this._grabbedWindowId = null;
        this.dragRemainingSpace = null;
        this._dragMiniaturizationAllowed = true;
        // During a drag the drag layouts are the single source of truth for geometry: the cursor
        // picks one and the drop pins it, so a tile that places windows on its own fights them.
        this._dragLayoutHint = null;

        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
        this._extension = null;

        this._isSmartResizingBlocked = false;
        // Window ID being restored from miniature; shields it from the overflow handler
        this._restoringWindowId = null;

        // Composition (windows-per-row shape) a deliberate drag/keyboard action pinned
        // per workspace, so a non-default layout survives the next re-tile. WeakMap since
        // it is keyed by workspace GObjects that come and go (like _workspaceSwaps).
        this._pinnedComposition = new WeakMap();
        this._activePinnedShape = null;
        this._activePinnedWorkspace = null;

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
    // isn't necessarily the arriving one (a sibling's miniature-restore runs its
    // own pass with itself as newWindow), so the shield lives on the window itself
    // and drops the moment its arrival evaluation resolves placement.
    _isArrivalPending(window) {
        return WindowState.get(window, 'arrivalPending') === true;
    }

    setWindowingManager(manager) {
        this._windowingManager = manager;
    }

    // Effective size: pending async sizes → model region → frame rect → saved sizes → fallback
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

        const modelOrFrameSize = this._getSizeFromModelOrFrame(window);
        if (modelOrFrameSize) {
            return modelOrFrameSize;
        }

        const preferred = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
        if (preferred) {
            return { width: preferred.width, height: preferred.height };
        }

        return {
            width: constants.SMART_RESIZE_MIN_WINDOW_WIDTH,
            height: constants.SMART_RESIZE_MIN_WINDOW_HEIGHT,
        };
    }

    // With the overview open Mutter drops our moves, so the frame is stale by
    // construction; the last computed region is what the layout actually decided.
    _getSizeFromModelOrFrame(window) {
        const region = MosaicModel.regionFor(window);
        if (region && region.width > 0 && region.height > 0) {
            return { width: region.width, height: region.height };
        }

        const frame = window.get_frame_rect();
        if (frame.width > 0 && frame.height > 0) {
            return { width: frame.width, height: frame.height };
        }

        return null;
    }

    // Libadwaita apps report 100px via get_min_size but enforce 360px.
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

    // Stamp when a shrink target is applied so the clamp detector can tell "hasn't shrunk yet"
    // (transient) from "won't shrink" (a real minimum), keyed off the target, not the window's age.
    _setSmartResizeTarget(window, size) {
        WindowState.set(window, 'targetSmartResizeSize', { width: size.width, height: size.height });
        WindowState.set(window, 'targetSmartResizeSetAt', monotonicNow());
    }

    getWindowMaximumSize(window) {
        if (window.get_max_size) {
            const [hasHint, maxW, maxH] = window.get_max_size();
            if (hasHint && maxW > 0 && maxH > 0)
                return { width: maxW, height: maxH };
        }
        return null;
    }

    isWindowAtMinimum(window, tolerance = 10) {
        const currentSize = this.getEffectiveWindowSize(window);
        const minSize = this.getWindowMinimumSize(window);
        return currentSize.width <= minSize.width + tolerance &&
               currentSize.height <= minSize.height + tolerance;
    }

    findBestRestorationGain(windows, shrunkWindows, workArea) {
        for (let gainFactor = 1.0; gainFactor >= 0.1; gainFactor -= 0.1) {
            const simulatedWindows = windows.map(w => {
                const shrunk = shrunkWindows.find(sw => sw.id === w.get_id());
                if (!shrunk) {
                    // Miniatures sit at their scaled region size, so use getMiniatureSize to match WindowDescriptor.
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
        this._dragMiniaturizationAllowed = true;
    }

    setDragMiniaturizationAllowed(allowed) {
        this._dragMiniaturizationAllowed = allowed;
    }

    setGrabbedWindow(window) {
        this._grabbedWindowId = window ? window.get_id() : null;
    }

    disableDragMode() {
        this.isDragging = false;
        this.dragRemainingSpace = null;
        this._dragMiniaturizationAllowed = true;
        this._dragLayoutHint = null;
        this.invalidateLayoutCache();
    }

    setDragLayoutHint(layout) {
        this._dragLayoutHint = layout?.permOrder?.length
            ? { order: layout.permOrder, shape: layout.shape }
            : null;
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

    invalidateLayoutCache() {
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
    }

    getCachedLayout() {
        return this._cachedTileResult?.windows || null;
    }

    _extractLayoutPositions(tile_info) {
        const positions = [];

        if (!tile_info.vertical) {
            let y = tile_info.y;
            for (const level of tile_info.levels) {
                let x = level.x;
                for (const win of level.windows) {
                    const drawX = win.targetX !== undefined ? win.targetX : x;
                    const drawY = win.targetY !== undefined ? win.targetY : y;

                    positions.push({ id: win.id, x: drawX, y: drawY, width: win.width, height: win.height });
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

    // Stack the drag layout vertically once a window is too tall/wide to sit in a row, or on
    // a portrait work area where columns fit better than rows.
    _useVerticalForDrag(windowDescriptors, workArea) {
        let maxHeight = 0, maxWidth = 0;
        for (const w of windowDescriptors) {
            maxHeight = Math.max(maxHeight, w.height);
            maxWidth = Math.max(maxWidth, w.width);
        }
        const isNarrow = workArea.width < workArea.height;
        const tooWide = maxWidth > workArea.width * 0.9;
        const tooTall = maxHeight > workArea.height * 0.65;
        return tooTall || isNarrow || tooWide;
    }

    computeDragLayouts(windowDescriptors, workArea, draggedId) {
        const spacing = constants.WINDOW_SPACING;
        const startTime = GLib.get_monotonic_time();

        const useVertical = this._useVerticalForDrag(windowDescriptors, workArea);

        const n = windowDescriptors.length;
        const dragged = windowDescriptors.find(w => w.id === draggedId);
        if (!dragged) return [];
        const others = windowDescriptors.filter(w => w.id !== draggedId);

        const layouts = [];
        const seenPositions = new Set();
        let shapeCount = 0;

        outer:
        for (const shape of generateRowCompositions(n)) {
            // Budget check per shape too, since the generator is lazy and stopping here
            // caps generation (2^(n-1)) not just the inner loop.
            if ((GLib.get_monotonic_time() - startTime) / 1000 > constants.DRAG_LAYOUT_TIME_BUDGET_MS)
                break;
            shapeCount++;
            // Put the dragged window at each position; keep the others in their stable order.
            for (let pos = 0; pos < n; pos++) {
                const ordered = [...others];
                ordered.splice(pos, 0, dragged);

                const result = this._placeByShape(ordered, workArea, spacing, shape, useVertical);
                if (result.overflow) continue;

                const positions = this._extractLayoutPositions(result);
                const draggedPos = positions.find(p => p.id === draggedId);
                if (!draggedPos) continue;

                const snapKey = `${Math.round(draggedPos.x / 50)},${Math.round(draggedPos.y / 50)}`;
                if (seenPositions.has(snapKey)) continue;
                seenPositions.add(snapKey);

                layouts.push({
                    draggedRect: draggedPos,
                    positions,
                    permOrder: ordered.map(w => w.id),
                    shape,
                });

                if (layouts.length >= constants.MAX_DRAG_LAYOUTS) break outer;
            }
        }

        Logger.log(`computeDragLayouts: ${shapeCount} shapes, ${layouts.length} unique positions for window ${draggedId} in ${((GLib.get_monotonic_time() - startTime) / 1000).toFixed(1)}ms`);
        return layouts;
    }

    applyDragLayout(positions, workspace, monitor) {
        const meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }

        for (const pos of positions) {
            if (this.masks.has(pos.id)) {
                if (this._drawingManager) {
                    this._drawingManager.rect(pos.x, pos.y, pos.width, pos.height);
                }
                continue;
            }

            const window = meta_windows.find(w => w.get_id() === pos.id);
            if (!window) continue;

            if (WindowState.get(window, IS_MINIATURE)) {
                this._applyDragLayoutMiniature(window, pos);
            } else {
                this._applyDragLayoutWindow(window, pos);
            }
        }
    }

    _applyDragLayoutMiniature(window, pos) {
        const actor = window.get_compositor_private();
        if (actor && !actor.is_destroyed()) {
            const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
            const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
            const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
            animateMiniatureToTarget(actor, window, sc, extL, extT, pos.x, pos.y,
                constants.ANIMATION_DURATION_MS);
            WindowState.get(window, MINIATURE_OVERLAY)?.animateToPosition(constants.ANIMATION_DURATION_MS);
        }
        // MosaicLayoutStrategy reads ComputedLayouts for the overview region, so keep it in sync.
        ComputedLayouts.set(window, { x: pos.x, y: pos.y, width: pos.width, height: pos.height });
    }

    _applyDragLayoutWindow(window, pos) {
        const currentRect = window.get_frame_rect();
        const posChanged = Math.abs(currentRect.x - pos.x) > 5 || Math.abs(currentRect.y - pos.y) > 5;
        const sizeChanged = Math.abs(currentRect.width - pos.width) > 5 || Math.abs(currentRect.height - pos.height) > 5;
        if (!posChanged && !sizeChanged) return;

        WindowState.set(window, 'isConstrainedByMosaic', true);
        // Same actor-measured continuity as WindowDescriptor.draw: start the ease from
        // where the window really is, and end it where mutter really put it.
        const actor = window.get_compositor_private();
        const alive = actor && !actor.is_destroyed();
        const visualX = alive ? actor.x + actor.translation_x : 0;
        const visualY = alive ? actor.y + actor.translation_y : 0;
        Logger.log(`applyDragLayout: id=${pos.id}, target=(${pos.x},${pos.y}), current=(${currentRect.x},${currentRect.y})`);
        window.move_frame(false, pos.x, pos.y);
        MosaicConstraints.commitRegion(window, { x: pos.x, y: pos.y, width: pos.width, height: pos.height });
        if (actor && !actor.is_destroyed()) {
            actor.set_translation(visualX - actor.x, visualY - actor.y, 0);
            actor.ease({
                translation_x: 0,
                translation_y: 0,
                opacity: 255,
                duration: Math.ceil(constants.ANIMATION_DURATION_MS * getSlowDownFactor()),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
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

    // Persist a chosen composition for the workspace. Ordering rides the existing order-op
    // path; only the shape is new. Honored by _tile until the window count changes or the
    // shape stops fitting.
    pinComposition(workspace, shape, order) {
        this._pinnedComposition.set(workspace, { count: order.length, shape });
        Logger.log(`pinComposition: pinned shape [${shape.join(',')}] for ${order.length} windows`);
        this.applyOrderOp(workspace, order);
    }

    // Pick the composition that moves the focused window's center farthest in `direction`.
    // Returns { shape, order, displacement } or null if nothing beats the min threshold.
    // Only mosaic windows take part; edge-tiled ones keep their fixed regions and would
    // otherwise inflate n and make the real tile's window count mismatch the pin. The mosaic
    // lives in the space the edge tiles leave over, so measure against that.
    _mosaicWindowsAndArea(workspace, monitor) {
        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        let workArea = workspace.get_work_area_for_monitor(monitor);
        if (this._edgeTilingManager) {
            const edgeTiled = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            if (edgeTiled.length > 0) {
                const edgeIds = edgeTiled.map(s => s.window.get_id());
                meta_windows = meta_windows.filter(w => !edgeIds.includes(w.get_id()));
                workArea = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            }
        }
        return { meta_windows, workArea };
    }

    bestRecomposition(workspace, monitor, focusedWindow, direction) {
        const startTime = GLib.get_monotonic_time();
        const { meta_windows, workArea } = this._mosaicWindowsAndArea(workspace, monitor);

        const descriptors = this.windowsToDescriptors(meta_windows, monitor, focusedWindow);
        const n = descriptors.length;
        if (n < 2) return null;

        const useVertical = this._useVerticalForDrag(descriptors, workArea);

        const focused = descriptors.find(w => w.id === focusedWindow.get_id());
        if (!focused) return null;
        const others = descriptors.filter(w => w.id !== focusedWindow.get_id());
        const f0 = focusedWindow.get_frame_rect();
        const sign = direction === 'right' || direction === 'down' ? 1 : -1;
        const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
        const originCenter = axis === 'x' ? f0.x + f0.width / 2 : f0.y + f0.height / 2;

        return this._searchRecomposition({
            focusedId: focusedWindow.get_id(), focused, others, workArea, useVertical,
            n, sign, axis, originCenter, startTime,
        });
    }

    _searchRecomposition({ focusedId, focused, others, workArea, useVertical, n, sign, axis, originCenter, startTime }) {
        const spacing = constants.WINDOW_SPACING;
        let best = null;

        for (const shape of generateRowCompositions(n)) {
            // Same budget as the drag path, since the generator is lazy and n can be large.
            if ((GLib.get_monotonic_time() - startTime) / 1000 > constants.DRAG_LAYOUT_TIME_BUDGET_MS)
                break;
            for (let pos = 0; pos < n; pos++) {
                const ordered = [...others];
                ordered.splice(pos, 0, focused);
                const result = this._placeByShape(ordered, workArea, spacing, shape, useVertical);
                if (result.overflow) continue;
                const positions = this._extractLayoutPositions(result);
                const fp = positions.find(p => p.id === focusedId);
                if (!fp) continue;
                const center = axis === 'x' ? fp.x + fp.width / 2 : fp.y + fp.height / 2;
                const disp = sign * (center - originCenter);
                if (disp >= constants.KEYBOARD_RECOMPOSE_MIN_DISPLACEMENT_PX && (!best || disp > best.displacement))
                    best = { shape, order: ordered.map(w => w.id), displacement: disp };
            }
        }
        return best;
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

    _scoreLayout(tileResult, workArea) {
        if (!tileResult || tileResult.overflow) return -Infinity;

        let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;

        for (const level of tileResult.levels) {
            for (const w of level.windows) {
                const x = w.targetX || level.x;
                const y = w.targetY || level.y;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + w.width);
                maxY = Math.max(maxY, y + w.height);
            }
        }

        if (minX === Infinity) return -Infinity;

        const bboxWidth = maxX - minX;
        const bboxHeight = maxY - minY;
        const bboxArea = bboxWidth * bboxHeight;

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

        const sizeEfficiency = 1 - (bboxArea / (workArea.width * workArea.height));

        // Don't be tempted to also charge dead space inside a level. The window set is fixed
        // across the orders being compared, so a tighter box already is less dead space, and an
        // intra-level charge reads the gap beside a short row as waste when that gap is the point.
        return centralization * 30 + sizeEfficiency * 20;
    }

    // Reward a layout that leaves windows near where they already sat, so a retile doesn't
    // shuffle everything for a marginal geometric gain.
    _positionStabilityBonus(tileResult, workArea) {
        if (!this._positionSnapshot) return 0;

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
        if (count === 0) return 0;

        const maxDiag = Math.hypot(workArea.width, workArea.height);
        const normalized = Math.min(1, totalDisp / (count * maxDiag));
        return (1 - normalized) * POSITION_STABILITY_WEIGHT;
    }

    // Pairs, not level indices: a column inserted at the front renumbers everyone and fakes a regroup.
    _coMembershipPairs(levels, allowed = null) {
        const pairs = new Set();
        for (const level of levels) {
            const ids = level.windows.map(w => w.id)
                .filter(id => !allowed || allowed.has(id))
                .sort((a, b) => a - b);
            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++)
                    pairs.add(`${ids[i]}:${ids[j]}`);
            }
        }
        return pairs;
    }

    _survivingPairs(pairs, alive) {
        const kept = new Set();
        for (const p of pairs) {
            const [a, b] = p.split(':');
            if (alive.has(Number(a)) && alive.has(Number(b))) kept.add(p);
        }
        return kept;
    }

    // Prefer permutations where windows stay in the same column/shelf as last time.
    _groupStabilityBonus(tileResult) {
        if (!this._lastGroupAssignment) return 0;

        // Only windows on both sides can regroup; charging a newcomer's pairs makes the sparsest join cheapest.
        const tracked = this._lastGroupAssignment.ids;
        const alive = new Set(tileResult.levels
            .flatMap(l => l.windows.map(w => w.id))
            .filter(id => tracked.has(id)));
        if (alive.size < 2) return 0;

        const now = this._coMembershipPairs(tileResult.levels, alive);
        // Nothing closed, so every recorded pair still has both ends and needs no filtering.
        const prev = alive.size === tracked.size
            ? this._lastGroupAssignment.pairs
            : this._survivingPairs(this._lastGroupAssignment.pairs, alive);

        let changed = 0;
        for (const p of prev) if (!now.has(p)) changed++;
        for (const p of now) if (!prev.has(p)) changed++;

        // Both sets are subsets of the pairs over alive, so the clamp is just belt and braces.
        const totalPairs = (alive.size * (alive.size - 1)) / 2;
        return (1 - Math.min(1, changed / totalPairs)) * GROUP_STABILITY_WEIGHT;
    }

    // Distance from the restored window's center to the region its miniature held (Infinity if absent).
    _restoreDisplacement(tileResult) {
        if (!this._restoreAnchor) return 0;
        for (const level of tileResult.levels) {
            for (const w of level.windows) {
                if (w.id !== this._restoreAnchor.id) continue;
                const px = (w.targetX ?? level.x) + w.width / 2;
                const py = (w.targetY ?? level.y) + w.height / 2;
                return Math.hypot(px - this._restoreAnchor.cx, py - this._restoreAnchor.cy);
            }
        }
        return Infinity;
    }

    _scoreOrder(perm, workArea, tilingFn, currentIds) {
        const result = tilingFn.call(this, perm, workArea, constants.WINDOW_SPACING);
        const geom = this._scoreLayout(result, workArea);
        const fits = geom > -Infinity;

        let stability = 0;
        if (fits) {
            stability = this._positionStabilityBonus(result, workArea) +
                this._groupStabilityBonus(result);
            // Prefer current order (+5) to avoid unnecessary visual swaps
            const isSameOrder = perm.length === currentIds.length &&
                perm.every((w, i) => w.id === currentIds[i]);
            if (isSameOrder) stability += 5;
        }

        // A just-restored window makes proximity the primary pick, with geometry and stability breaking ties inside the tolerance bucket.
        const bucket = this._restoreAnchor
            ? Math.round(this._restoreDisplacement(result) / constants.RESTORE_PROXIMITY_TOLERANCE_PX)
            : 0;

        return { geom, stability, bucket, fits };
    }

    _findOptimalOrder(windows, workArea, tilingFn) {
        if (windows.length <= 1) return windows;

        const startTime = monotonicNow();
        const permutations = this._generatePermutations(windows);
        const currentIds = this._lastTiledOrder ?? windows.map(w => w.id);

        const scored = permutations.map(perm =>
            ({ perm, ...this._scoreOrder(perm, workArea, tilingFn, currentIds) }));

        // An overflowing pick lands out of bounds and Mutter clamps it onto its neighbor, so anything that fits outranks everything else.
        const fitting = scored.filter(s => s.fits);
        const pool = fitting.length > 0 ? fitting : scored;

        // Proximity to where a restored window's miniature sat comes next.
        const minBucket = Math.min(...pool.map(s => s.bucket));
        const inBucket = pool.filter(s => s.bucket === minBucket);

        // The band hangs off the best geometry on offer, not off a running best: chained
        // in-band hops walk the pick downhill and make it depend on the scan order.
        const floor = Math.max(...inBucket.map(s => s.geom)) - STABILITY_TIE_BAND;

        let bestOrder = windows;
        let bestStability = -Infinity;
        for (const s of inBucket) {
            if (s.geom < floor) continue;
            if (s.stability > bestStability) {
                bestStability = s.stability;
                bestOrder = s.perm;
            }
        }

        const elapsed = Math.round(monotonicNow() - startTime);
        Logger.log(`_findOptimalOrder: ${windows.length} windows, ${permutations.length} permutations, ${elapsed}ms${this._restoreAnchor ? ` (restore anchor ${this._restoreAnchor.id})` : ''}`);

        return bestOrder;
    }

    // Order-sensitive hash: different input orders must never share a cache entry.
    _getLayoutHash(windows, work_area) {
        // Snap to 8px grid to reduce cache invalidation during resize
        const snap = v => Math.round(v / 8) * 8;
        const parts = windows.map(w => `${w.id}:${snap(w.width)}x${snap(w.height)}`);
        return `${snap(work_area.width)}x${snap(work_area.height)}|${parts.join(',')}`;
    }

    _tile(windows, work_area, isSimulation = false) {
        if (!windows || windows.length === 0) return { levels: [], vertical: false, overflow: false };

        const hash = this._getLayoutHash(windows, work_area);
        if (this._isTileCacheHit(hash, isSimulation)) {
            Logger.log('_tile: Cache hit, reusing layout');
            return this._cachedTileResult;
        }

        const spacing = constants.WINDOW_SPACING;
        const useVerticalShelves = this._useVerticalForDrag(windows, work_area);
        const tilingFn = useVerticalShelves ? this._verticalShelves : this._horizontalShelves;

        const forced = this._tryForcedShape(windows, work_area, spacing, useVerticalShelves, isSimulation, hash);
        if (forced) return forced;

        let result = this._chooseTileResult(windows, work_area, spacing, tilingFn, useVerticalShelves, isSimulation);
        if (result.overflow)
            result = this._tryOppositeOrientation(windows, work_area, spacing, tilingFn, useVerticalShelves, isSimulation, result);

        if (!isSimulation && !this.isDragging) {
            this._lastLayoutHash = hash;
            this._cachedTileResult = result;
        }

        return result;
    }

    // A window as wide as the work area leaves no room for a second column, yet the same set fits
    // as rows. Overflow costs a miniaturization or a push to the next workspace, so it's worth a
    // second pass in the other orientation before paying that.
    _tryOppositeOrientation(windows, work_area, spacing, tilingFn, useVerticalShelves, isSimulation, primary) {
        if (this.isDragging && !isSimulation) return primary;

        const altVertical = !useVerticalShelves;
        const altFn = altVertical ? this._verticalShelves : this._horizontalShelves;
        const alt = this._chooseTileResult(windows, work_area, spacing, altFn, altVertical, isSimulation);
        if (!alt.overflow) {
            Logger.log(`_tile: overflow on vertical=${useVerticalShelves}, switched to vertical=${altVertical}`);
            return alt;
        }

        // The alt pass wrote its own targets onto the descriptors, and the preferred result's
        // levels point at those same objects, so replay it before handing it back.
        const replay = tilingFn.call(this, primary.windows, work_area, spacing);
        replay.orderOptimized = primary.orderOptimized;
        return replay;
    }

    // Skip cache during drag (order changes but hash doesn't) and while a pin is active, since
    // the hash ignores shape so a new pin would hit a stale cached layout and revert.
    _isTileCacheHit(hash, isSimulation) {
        if (!this._cachedTileResult || this._lastLayoutHash !== hash) return false;
        if (isSimulation || this.isDragging || this._activePinnedShape) return false;

        // The hash covers ids and sizes, not how hard we looked for an order. Without this the
        // fit check, which runs first and can't rank, gets to decide the layout for good.
        return this._cachedTileResult.orderOptimized === true ||
            !this._ranksOrders(this._cachedTileResult.overflow, isSimulation);
    }

    // A pinned composition or an in-flight drag hint wins over the auto-chosen grid, but only
    // for the real apply (not simulations) and only while it fits; an overflow falls through so
    // overflow -> miniaturization still runs. Returns the forced layout, or null to continue.
    _tryForcedShape(windows, work_area, spacing, useVerticalShelves, isSimulation, hash) {
        if (this._activePinnedShape && !isSimulation && !this.isDragging) {
            const pinned = this._placeByShape(windows, work_area, spacing, this._activePinnedShape, useVerticalShelves);
            if (!pinned.overflow) {
                this._lastLayoutHash = hash;
                this._cachedTileResult = pinned;
                Logger.log(`_tile: ${windows.length} windows honoring pinned shape [${this._activePinnedShape.join(',')}]`);
                return pinned;
            }
            // A shape that stopped fitting is dead, not paused. Leaving it in the map makes every
            // later retile place it, fail, and fall through again.
            this._pinnedComposition.delete(this._activePinnedWorkspace);
            this._activePinnedShape = null;
            Logger.log('_tile: pinned shape overflows, dropping it');
        }

        if (this._dragLayoutHint?.shape && this.isDragging && !isSimulation) {
            const hinted = this._placeByShape(windows, work_area, spacing, this._dragLayoutHint.shape, useVerticalShelves);
            if (!hinted.overflow) {
                Logger.log(`_tile: ${windows.length} windows honoring drag layout [${this._dragLayoutHint.shape.join(',')}]`);
                return hinted;
            }
            Logger.log('_tile: drag layout overflows, dropping to auto-layout');
        }

        return null;
    }

    // Simulations (binary-search in tryFitWithResize) skip stability scoring for performance.
    // canFitWindow runs before _prepareTilePass takes the snapshot, so it ranks nothing either.
    _ranksOrders(overflow, isSimulation) {
        return overflow || (!!this._positionSnapshot && !isSimulation);
    }

    _chooseTileResult(windows, work_area, spacing, tilingFn, useVerticalShelves, isSimulation) {
        const currentResult = tilingFn.call(this, windows, work_area, spacing);
        const wantOptimal = this._ranksOrders(currentResult.overflow, isSimulation);

        if (!wantOptimal || (this.isDragging && !isSimulation)) {
            const reason = wantOptimal ? 'overflow (drag, no permute)' : 'stable order';
            Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, ${reason}`);
            currentResult.orderOptimized = false;
            return currentResult;
        }

        const optimalWindows = this._findOptimalOrder(windows, work_area, tilingFn);
        const result = tilingFn.call(this, optimalWindows, work_area, spacing);
        Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, ${currentResult.overflow ? 'reordered (overflow fallback)' : 'stability-checked'}`);
        result.orderOptimized = true;
        return result;
    }

    _verticalShelves(windows, work_area, spacing) {
        if (windows.length <= 2) {
            return this._simpleCenteredColumn(windows, work_area, spacing);
        }

        // First-fit is greedy, so a free row join can starve a later window of the column it
        // needed. Packing both ways and keeping the tighter box means rows only ever win.
        const packings = [false, true].map(allowRows => {
            const columns = this._binPackColumns(windows, work_area, spacing, allowRows);
            return this._buildColumnLevels(columns, work_area, spacing);
        });

        const { levels, totalWidth, overflow } = this._tighterPacking(packings);

        const startX = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);
        this._positionColumnWindows(levels, work_area, spacing, startX);

        return {
            x: startX,
            y: work_area.y,
            overflow: overflow,
            vertical: true,
            levels: levels,
            windows: windows
        };
    }

    // Bin packing without height sorting to preserve swap order. A window that fits no column
    // opens a new one, or (when there's no width left) is forced into the shortest column.
    _binPackColumns(windows, work_area, spacing, allowRows) {
        const columns = [];

        for (const w of windows) {
            if (this._placeInExistingColumn(columns, w, work_area, spacing, allowRows)) continue;

            const totalWidth = columns.reduce((s, c) => s + c.width, 0) +
                               (columns.length > 0 ? columns.length * spacing : 0) + w.width;

            if (totalWidth <= work_area.width || columns.length === 0) {
                const col = { rows: [], height: 0, width: 0 };
                this._openRow(col, w, spacing);
                columns.push(col);
            } else {
                this._forceIntoShortestColumn(columns, w, spacing, allowRows);
            }
        }

        return columns;
    }

    _placeInExistingColumn(columns, w, work_area, spacing, allowRows) {
        // A join is free while some other column is already taller, but once it makes this one
        // the tallest, the box grows more in height than a new column would cost in width.
        const tallest = columns.reduce((h, c) => Math.max(h, c.height), 0);

        for (const col of columns) {
            if (allowRows && this._joinRow(col, w, spacing, tallest)) return true;

            if (col.height + spacing + w.height <= work_area.height) {
                this._openRow(col, w, spacing);
                return true;
            }
        }
        return false;
    }

    // Never widening the column is the whole difference between this and a free 2D packer: the
    // layout stays a shelf model while two miniatures share the vertical space one normal
    // window would have taken alone.
    _joinRow(col, w, spacing, maxHeight) {
        for (const row of col.rows) {
            if (row.used + spacing + w.width > col.width) continue;

            const grown = Math.max(row.height, w.height);
            if (col.height - row.height + grown > maxHeight) continue;

            col.height += grown - row.height;
            row.height = grown;
            row.used += spacing + w.width;
            row.windows.push(w);
            return true;
        }
        return false;
    }

    _openRow(col, w, spacing) {
        col.height += (col.rows.length > 0 ? spacing : 0) + w.height;
        col.width = Math.max(col.width, w.width);
        col.rows.push({ windows: [w], used: w.width, height: w.height });
    }

    _forceIntoShortestColumn(columns, w, spacing, allowRows) {
        let bestCol = columns[0];
        let minHeight = columns[0].height;
        for (const col of columns) {
            if (col.height < minHeight) {
                minHeight = col.height;
                bestCol = col;
            }
        }
        // The height budget is already blown, so only the never-widen rule still has a say.
        if (!allowRows || !this._joinRow(bestCol, w, spacing, Infinity))
            this._openRow(bestCol, w, spacing);
    }

    // Ties keep the row-free packing, so a layout only ever changes when rows genuinely shrink it.
    _tighterPacking([plain, rows]) {
        if (plain.overflow !== rows.overflow)
            return plain.overflow ? rows : plain;

        return this._packingArea(rows) < this._packingArea(plain) ? rows : plain;
    }

    _packingArea({ levels, totalWidth }) {
        return totalWidth * levels.reduce((h, lv) => Math.max(h, lv.height), 0);
    }

    _buildColumnLevels(columns, work_area, spacing) {
        const levels = [];
        let totalWidth = 0;
        let overflow = false;

        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const level = new Level(work_area);

            let colHeight = 0;
            for (const row of col.rows) {
                if (colHeight > 0) colHeight += spacing;
                colHeight += row.height;
                level.width = Math.max(level.width, row.used);
                for (const w of row.windows)
                    level.windows.push(w);
            }
            level.height = colHeight;
            level.rows = col.rows;

            if (level.height > work_area.height) {
                overflow = true;
            }

            level.y = (work_area.height - level.height) / 2 + work_area.y;

            if (totalWidth + level.width + spacing > work_area.width && c > 0) {
                overflow = true;
            }

            if (c > 0) totalWidth += spacing;
            totalWidth += level.width;

            levels.push(level);
        }

        return { levels, totalWidth, overflow };
    }

    // Columns fan out from center: those left of center pull right, those right pull left, so
    // the gap always falls on the outer edges rather than between neighbours. A row leans the
    // same way inside its column, and a short window inside its row.
    _positionColumnWindows(levels, work_area, spacing, startX) {
        const originX = work_area.x + work_area.width / 2;
        const originY = work_area.y + work_area.height / 2;

        let xPos = startX;
        for (const level of levels) {
            level.x = xPos;

            let yPos = Math.max(work_area.y, (work_area.height - level.height) / 2 + work_area.y);

            for (const row of level.rows) {
                let rowX = xPos + outwardOffset(xPos, level.width, row.used, originX);

                for (const win of row.windows) {
                    win.targetX = rowX;
                    win.targetY = yPos + outwardOffset(yPos, row.height, win.height, originY);
                    rowX += win.width + spacing;
                }

                yPos += row.height + spacing;
            }

            xPos += level.width + spacing;
        }
    }

    _simpleCenteredColumn(windows, work_area, spacing) {
        let totalHeight = 0;
        let maxWidth = 0;
        for (const w of windows) {
            if (totalHeight > 0) totalHeight += spacing;
            totalHeight += w.height;
            maxWidth = Math.max(maxWidth, w.width);
        }

        if (totalHeight > work_area.height && windows.length === 2) {
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

        const level = new Level(work_area);
        for (const w of windows) {
            level.windows.push(w);
        }

        level.width = maxWidth;
        level.height = totalHeight;
        level.x = Math.max(work_area.x, (work_area.width - maxWidth) / 2 + work_area.x);
        level.y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);

        const origin = work_area.x + work_area.width / 2;
        let yPos = level.y;
        for (const w of level.windows) {
            w.targetX = level.x + outwardOffset(level.x, maxWidth, w.width, origin);
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

    _horizontalShelves(windows, work_area, spacing) {
        if (windows.length <= 2) {
            return this._simpleCenteredRow(windows, work_area, spacing);
        }
        const { rows: numRows, windowsPerRow } = this._calculateOptimalGrid(windows, work_area);
        const { levels, totalHeight, overflow } =
            this._buildShelfRows(windows, work_area, spacing, numRows, windowsPerRow);

        const y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);
        this._positionShelfWindows(levels, y, spacing, work_area);

        return {
            x: work_area.x,
            y: y,
            overflow: overflow,
            vertical: false,
            levels: levels,
            windows: windows
        };
    }

    // Fill each row up to its window count, centering it horizontally; overflow flags either a
    // row too wide for the work area or the stack of rows growing past its height.
    _buildShelfRows(windows, work_area, spacing, numRows, windowsPerRow) {
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

        return { levels, totalHeight, overflow };
    }

    _positionShelfWindows(levels, y, spacing, work_area) {
        const origin = work_area.y + work_area.height / 2;
        let levelY = y;
        for (const level of levels) {
            level.y = levelY;
            let xPos = level.x;
            for (const w of level.windows) {
                w.targetX = xPos;
                w.targetY = levelY + outwardOffset(levelY, level.height, w.height, origin);
                xPos += w.width + spacing;
            }
            levelY += level.height + spacing;
        }
    }

    // Force windows into an explicit shape instead of the auto-chosen grid (drag/keyboard/pin).
    _placeByShape(windows, work_area, spacing, shape, vertical) {
        const groups = this._groupByShape(windows, shape);
        return vertical
            ? this._placeVerticalGroups(groups, work_area, spacing, windows)
            : this._placeHorizontalGroups(groups, work_area, spacing, windows);
    }

    _groupByShape(windows, shape) {
        const groups = [];
        let idx = 0;
        for (const count of shape) {
            const g = [];
            for (let i = 0; i < count && idx < windows.length; i++) g.push(windows[idx++]);
            groups.push(g);
        }
        return groups;
    }

    _placeHorizontalGroups(groups, work_area, spacing, windows) {
        const levels = [];
        let overflow = false;
        let totalHeight = 0;

        for (let r = 0; r < groups.length; r++) {
            const level = new Level(work_area);
            for (const w of groups[r]) {
                level.windows.push(w);
                if (level.width > 0) level.width += spacing;
                level.width += w.width;
                level.height = Math.max(level.height, w.height);
            }
            if (level.width > work_area.width) overflow = true;
            level.x = Math.max(work_area.x, (work_area.width - level.width) / 2 + work_area.x);
            if (r > 0) totalHeight += spacing;
            totalHeight += level.height;
            levels.push(level);
        }
        if (totalHeight > work_area.height) overflow = true;

        const y = Math.max(work_area.y, (work_area.height - totalHeight) / 2 + work_area.y);
        const origin = work_area.y + work_area.height / 2;
        let levelY = y;
        for (const level of levels) {
            level.y = levelY;
            let xPos = level.x;
            for (const w of level.windows) {
                w.targetX = xPos;
                w.targetY = levelY + outwardOffset(levelY, level.height, w.height, origin);
                xPos += w.width + spacing;
            }
            levelY += level.height + spacing;
        }
        return { x: work_area.x, y, overflow, vertical: false, levels, windows };
    }

    _placeVerticalGroups(groups, work_area, spacing, windows) {
        const levels = [];
        let overflow = false;
        let totalWidth = 0;

        for (let c = 0; c < groups.length; c++) {
            const level = new Level(work_area);
            for (const w of groups[c]) {
                level.windows.push(w);
                if (level.height > 0) level.height += spacing;
                level.height += w.height;
                level.width = Math.max(level.width, w.width);
            }
            if (level.height > work_area.height) overflow = true;
            if (c > 0) totalWidth += spacing;
            totalWidth += level.width;
            levels.push(level);
        }
        if (totalWidth > work_area.width) overflow = true;

        const x = Math.max(work_area.x, (work_area.width - totalWidth) / 2 + work_area.x);
        const origin = work_area.x + work_area.width / 2;
        let levelX = x;
        for (const level of levels) {
            level.x = levelX;
            const colHeight = level.windows.reduce((s, w, i) => s + w.height + (i > 0 ? spacing : 0), 0);
            let yPos = Math.max(work_area.y, (work_area.height - colHeight) / 2 + work_area.y);
            for (const w of level.windows) {
                w.targetX = levelX + outwardOffset(levelX, level.width, w.width, origin);
                w.targetY = yPos;
                yPos += w.height + spacing;
            }
            levelX += level.width + spacing;
        }
        return { x, y: work_area.y, overflow, vertical: true, levels, windows };
    }

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

        const origin = work_area.y + work_area.height / 2;
        let xPos = level.x;
        for (const w of level.windows) {
            w.targetX = xPos;
            w.targetY = y + outwardOffset(y, maxHeight, w.height, origin);
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

        for (let rows = 1; rows <= windowCount; rows++) {
            const cols = Math.ceil(windowCount / rows);
            const windowsPerRow = this._distributeWindowsPerRow(windowCount, rows);
            const { overflow, layoutWidth, layoutHeight } = this._measureGrid(windows, windowsPerRow, work_area, spacing);

            const aspectDiff = Math.abs(layoutWidth / layoutHeight - workspaceAspect);
            const emptySpaces = rows * cols - windowCount;
            // Heavily penalize overflow
            const score = aspectDiff + emptySpaces * 0.3 + (overflow ? 1000 : 0);

            if (!overflow && bestOverflow) {
                bestScore = score;
                bestRows = rows;
                bestOverflow = false;
            } else if (overflow === bestOverflow && score < bestScore) {
                bestScore = score;
                bestRows = rows;
            }
        }

        return { rows: bestRows, windowsPerRow: this._distributeWindowsPerRow(windowCount, bestRows) };
    }

    // Spread the leftover windows outward from the center row, so an uneven grid stays
    // visually balanced instead of piling the extras onto the first rows.
    _distributeWindowsPerRow(windowCount, rows) {
        const windowsPerRow = new Array(rows).fill(Math.floor(windowCount / rows));
        let remainder = windowCount % rows;
        if (remainder === 0) return windowsPerRow;

        const centerIndex = Math.floor(rows / 2);
        let left = centerIndex;
        let right = centerIndex;
        while (remainder > 0) {
            if (left >= 0 && left < rows) { windowsPerRow[left]++; remainder--; }
            if (remainder > 0 && right !== left && right >= 0 && right < rows) { windowsPerRow[right]++; remainder--; }
            left--;
            right++;
        }
        return windowsPerRow;
    }

    _measureGrid(windows, windowsPerRow, work_area, spacing) {
        let totalHeight = 0;
        let maxRowWidth = 0;
        let windowIndex = 0;
        let overflow = false;

        for (let r = 0; r < windowsPerRow.length; r++) {
            let currentRowHeight = 0;
            let currentRowWidth = 0;
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

        return { overflow, layoutWidth: maxRowWidth, layoutHeight: totalHeight };
    }

    _eligibleTileWindows(workspace, monitor, window, excludeFromTiling) {
        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this._windowingManager.isExcluded(w))
            .filter(w => !WindowState.get(w, 'pendingInQueue'));

        if (window && excludeFromTiling) {
            const windowId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== windowId);
        }

        if (this.isDragging && this.dragRemainingSpace && window) {
            const draggedId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== draggedId);
        }

        if (this._excludedWindow) {
            const excludedId = this._excludedWindow.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== excludedId);
        }

        return meta_windows;
    }

    // Not persisted into the swaps: an aborted drag must not leave a reorder behind.
    _applyDragLayoutHintOrder(_windows) {
        if (!this._dragLayoutHint) return;

        const order = this._dragLayoutHint.order;
        _windows.sort((a, b) => {
            const ia = order.indexOf(a.id);
            const ib = order.indexOf(b.id);
            return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
        });
    }

    _getWorkingInfo(workspace, window, _monitor, excludeFromTiling = false) {
        let current_monitor = _monitor;
        if(current_monitor === undefined)
            current_monitor = window.get_monitor();

        const meta_windows = this._eligibleTileWindows(workspace, current_monitor, window, excludeFromTiling);

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

        this._applyDragLayoutHintOrder(_windows);

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

    _drawTile(workspace, monitor, tile_info, meta_windows, dryRun = false, regionsOut = null, bounds = null) {
        const levels = tile_info.levels;
        const _x = tile_info.x;
        const _y = tile_info.y;
        if(!tile_info.vertical) {
            let y = _y;
            for(const level of levels) {
                Logger.log(`Drawing horizontal level at y=${y}, width=${level.width}, height=${level.height}`);
                level.draw_horizontal(workspace, monitor, meta_windows, y, this.masks, this.isDragging, this._drawingManager, dryRun, regionsOut, bounds);
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = _x;
            for(const level of levels) {
                Logger.log(`Drawing vertical level at x=${x}, width=${level.width}, height=${level.height}`);
                level.draw_vertical(workspace, monitor, meta_windows, x, this.masks, this.isDragging, this._drawingManager, dryRun, regionsOut, bounds);
                x += level.width + constants.WINDOW_SPACING;
            }
        }
    }

    _animateTileLayout(workspace, monitor, tile_info, work_area, meta_windows, draggedWindow = null, regionsOut = null, bounds = null) {
        // Nothing below can place a window without the manager, so let _drawTile do it.
        if (!this._animationsManager) return false;

        // Windows this pass places but must not touch: pending miniatures (createMiniature owns
        // their visual animation) and whatever is under the grab (the cursor owns its position).
        // A first placement sibling still needs to know they're there to compute a slide-in
        // direction against, so animateReTiling sees them without animating them.
        const ctx = {
            resizingWindowId: this._animationsManager.getResizingWindowId(),
            pendingMiniIds: new Set((this._pendingMiniatureWindows ?? []).map(p => p.window.get_id())),
            regionsOut,
            bounds,
            windowLayouts: [],
            miniLayouts: [],
            workspace,
            monitor,
        };

        if (!tile_info.vertical) {
            this._placeHorizontalAnimated(tile_info, meta_windows, ctx);
        } else {
            this._placeVerticalAnimated(tile_info, meta_windows, ctx);
        }

        this._syncGroupBounds(workspace, monitor, work_area);

        this._animationsManager.animateReTiling(ctx.windowLayouts, draggedWindow, ctx.miniLayouts);
        this._scheduleWorkspaceUnlock(workspace);

        return true;
    }

    // work_area is only the mosaic's leftover once edge tiles claimed their side, but the
    // group holds those tiles too, so bounding it by the leftover flags every one of them.
    _syncGroupBounds(workspace, monitor, work_area) {
        const bounds = this._clampedWorkArea(workspace, monitor) ?? work_area;
        const group = MosaicModel.store.groupFor(workspace.index(), monitor);
        if (group) group.workArea = rectOf(bounds);

        // The clamp upstream should make this unreachable; logging it is how we find out it
        // did not, instead of discovering it as a window half off the screen.
        for (const violation of group?.partitionViolations(w => WindowState.get(w, IS_MINIATURE)) ?? []) {
            const r = violation.region;
            Logger.error(`[GROUP] Window ${violation.windowId} escapes the work area: region=(${r.x},${r.y} ${r.width}x${r.height}) workArea=(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height})`);
        }
    }

    _placeHorizontalAnimated(tile_info, meta_windows, ctx) {
        let y = tile_info.y;
        for (const level of tile_info.levels) {
            let x = level.x;
            for (const windowDesc of level.windows) {
                const targetX = windowDesc.targetX !== undefined ? windowDesc.targetX : x;
                const targetY = windowDesc.targetY !== undefined ? windowDesc.targetY : y;

                const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                if (window) this._placeAnimatedWindow(window, windowDesc, targetX, targetY, 'H', ctx);
                x += windowDesc.width + constants.WINDOW_SPACING;
            }
            y += level.height + constants.WINDOW_SPACING;
        }
    }

    _placeVerticalAnimated(tile_info, meta_windows, ctx) {
        let x = tile_info.x;
        for (const level of tile_info.levels) {
            let y = level.y;
            for (const windowDesc of level.windows) {
                const targetX = windowDesc.targetX !== undefined ? windowDesc.targetX : x;
                const targetY = windowDesc.targetY !== undefined ? windowDesc.targetY : y;

                const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                if (window) this._placeAnimatedWindow(window, windowDesc, targetX, targetY, 'V', ctx);
                y += windowDesc.height + constants.WINDOW_SPACING;
            }
            x += level.width + constants.WINDOW_SPACING;
        }
    }

    // Sort one window into how this pass treats it: miniature (actor transform), grabbed/resizing
    // (leave it to the cursor), pending-mini/grabbed (claim region, don't animate), or normal (animate).
    _placeAnimatedWindow(window, windowDesc, tx, ty, orient, ctx) {
        // The sibling path gets this clamp from Mutter itself, which never honours an out-of-area
        // move_resize_frame. Miniatures ride on an actor transform, which Mutter does not police,
        // so a packed column taller than the work area walks them off the bottom edge.
        ({ x: tx, y: ty } = clampToWorkArea(tx, ty, windowDesc.width, windowDesc.height, ctx.bounds));

        const region = { x: tx, y: ty, width: windowDesc.width, height: windowDesc.height };

        if (WindowState.get(window, IS_MINIATURE)) {
            this._animateMiniatureRegion(window, tx, ty, region, orient, ctx);
            return;
        }

        if (windowDesc.id === ctx.resizingWindowId) {
            // The user's own resize owns the size; only the position follows the layout.
            this._recordRegion(window, region, ctx);
            window.move_frame(false, tx, ty);
            return;
        }

        if (ctx.pendingMiniIds.has(window.get_id())) {
            // Pending miniature: capture the region, but skip animateReTiling. createMiniature handles
            // all visual animation; a concurrent move_resize_frame would shift the actor mid-animation.
            this._recordRegion(window, region, ctx);
            ctx.miniLayouts.push({ window, rect: region });
            Logger.log(`[LAYOUT] ${orient} pending-mini ${window.get_id()}: region=(${region.x},${region.y}) size=${region.width}x${region.height}`);
        } else if (window.get_id() === this._grabbedWindowId) {
            // Mutter's grab wins every frame, so a move_resize_frame here just yanks the window off
            // the cursor and snaps back. Claim the region; the drop lands in it.
            this._recordRegion(window, region, ctx);
            ctx.miniLayouts.push({ window, rect: region });
            Logger.log(`[LAYOUT] ${orient} grabbed ${window.get_id()}: region=(${region.x},${region.y}) size=${region.width}x${region.height}`);
        } else {
            this._recordRegion(window, region, ctx);
            Logger.log(`[LAYOUT] ${orient} window ${window.get_id()}: target=(${tx},${ty}) size=${windowDesc.width}x${windowDesc.height}`);
            ctx.windowLayouts.push({ window, rect: region });
        }
    }

    // Do NOT move_frame for miniatures (Mutter may reject); drive by actor transform and keep
    // MosaicModel in sync, since MosaicLayoutStrategy reads it for the overview region.
    _animateMiniatureRegion(window, tx, ty, region, orient, ctx) {
        const actor = window.get_compositor_private();
        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
        if (actor && !actor.is_destroyed()) {
            animateMiniatureToTarget(actor, window, sc, extL, extT, tx, ty, constants.ANIMATION_DURATION_MS);
            WindowState.get(window, MINIATURE_OVERLAY)?.animateToPosition(constants.ANIMATION_DURATION_MS);
        }
        this._recordRegion(window, region, ctx);
        Logger.log(`[MINIATURE] animateTile ${orient} ${window.get_id()}: target=(${tx},${ty}) scale=${sc.toFixed(4)} extLeft=${extL} extTop=${extT} size=${region.width}x${region.height}`);
    }

    // ctx carries the workspace/monitor this tile pass is running for, so the model can be
    // flushed later without guessing which workspace a deferred window belongs to.
    _recordRegion(window, region, ctx) {
        MosaicModel.setRegion(window, region, ctx.workspace, ctx.monitor);
        if (ctx.regionsOut) ctx.regionsOut.set(window.get_id(), region);
    }

    // Release the workspace lock after move_resize's signals have likely fired (delay matches
    // the animation). No registry means the extension is disabling, so unlock immediately.
    _scheduleWorkspaceUnlock(workspace) {
        if (!(this._extension && this._extension.windowHandler)) return;

        if (this._extension._timeoutRegistry) {
            this._extension._timeoutRegistry.add(constants.ANIMATION_DURATION_MS + 100, () => {
                this._extension.windowHandler.unlockWorkspace(workspace);
            }, 'unlockWorkspace');
        } else {
            this._extension.windowHandler.unlockWorkspace(workspace);
        }
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
        // Only on the active workspace, since activate() on a background one drags the shell over to it.
        if (workspace === global.workspace_manager.get_active_workspace())
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

        const resizeResult = this.tryFitWithResize(reference, others, workArea, workspace, reference);
        this._applyEnforcedFit(workspace, monitor, resizeResult);
    }

    _applyEnforcedFit(workspace, monitor, resizeResult) {
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

    // Decide what to do with an overflowing reference window. Returns { tile_info,
    // referenceOverflowSkipped }, or { stop: true } when a returning sacred window can't be fit.
    _handleReferenceOverflow(reference_meta_window, windows, tileArea, workspace, monitor, tile_info) {
        // Only overflow a window whose arrival is still being placed; this prevents expelling
        // existing windows during resize retiling.
        const isNewlyAdded = this._isArrivalPending(reference_meta_window);
        if (!isNewlyAdded && !WindowState.get(reference_meta_window, 'forceOverflow') && !WindowState.get(reference_meta_window, 'isRestoringSacred')) {
            Logger.log(`Skipping overflow for ${reference_meta_window.get_id()} - not a new window`);
            return { tile_info, referenceOverflowSkipped: true };
        }

        if (WindowState.get(reference_meta_window, 'isSmartResizing') || WindowState.get(reference_meta_window, 'isRestoringSacred')) {
            Logger.log(`Skipping overflow for ${reference_meta_window.get_id()} - smart resize/sacred restore in progress`);
            // A sacred return must be made to fit even if it squishes everyone; only try once
            // (guarded by isSmartResizing) to avoid loops.
            if (WindowState.get(reference_meta_window, 'isRestoringSacred') && !WindowState.get(reference_meta_window, 'isSmartResizing')) {
                return this._fitReturningSacred(reference_meta_window, workspace, monitor);
            }
            return { tile_info, referenceOverflowSkipped: false };
        }

        this._expelReferenceWindow(reference_meta_window, windows);
        return { tile_info: this._tile(windows, tileArea), referenceOverflowSkipped: false };
    }

    _fitReturningSacred(reference_meta_window, workspace, monitor) {
        Logger.log('Triggering Smart Resize for returning sacred window');
        const workArea = this.getUsableWorkArea(workspace, monitor);
        // windows above are descriptors; re-fetch MetaWindows for tryFitWithResize.
        const realExisting = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => w.get_id() !== reference_meta_window.get_id() && !this._windowingManager.isExcluded(w));

        const resizeResult = this.tryFitWithResize(reference_meta_window, realExisting, workArea, workspace);
        if (!resizeResult?.success) {
            Logger.log('Smart resize could not fit sacred window');
            this._positionSnapshot = null;
            this._restoreAnchor = null;
            this._unlockWorkspaceEarlyReturn(workspace);
            return { stop: true };
        }

        // Preserve any pending miniatures discovered during this resize pass.
        if (resizeResult.pendingWindows?.length > 0) {
            this._pendingMiniatureWindows = resizeResult.pendingWindows;
        }
        // Use the tile_info from tryFitWithResize (computed with miniature sizes).
        return { tile_info: resizeResult.tileInfo, referenceOverflowSkipped: false };
    }

    // Newest goes, matching the victim the smart-resize rebalance already picks. A drag is exempt
    // for the same reason the reference rung is: the drop decides, not the pass under the cursor.
    _ejectForSurvivingOverflow(overflow, meta_windows, workspace, monitor) {
        if (!overflow || this.isDragging) return false;

        const candidates = meta_windows.filter(w => !this._windowingManager.isExcluded(w));
        if (candidates.length <= 1) return false;

        const newest = candidates.reduce((n, w) => {
            const t1 = WindowState.get(w, 'addedTime') || 0;
            const t2 = WindowState.get(n, 'addedTime') || 0;
            return t1 > t2 ? w : n;
        }, candidates[0]);

        Logger.log(`Overflow survived miniaturization, ejecting newest window ${newest.get_id()}`);
        this._windowingManager.moveOversizedWindow(newest).then(() => {
            this.invalidateLayoutCache();
            this.tileWorkspaceWindows(workspace, null, monitor, true);
        }).catch(e => Logger.error(`Overflow eject failed: ${e}`));

        return true;
    }

    _expelReferenceWindow(reference_meta_window, windows) {
        // Match by descriptor id, since descriptor.index drifts after edge-tiled/sacred windows filtered.
        const id = reference_meta_window.get_id();
        for (let i = 0; i < windows.length; i++) {
            if (windows[i].id === id) {
                windows.splice(i, 1);
                break;
            }
        }
        this._windowingManager.moveOversizedWindow(reference_meta_window).catch(e =>
            Logger.error(`Overflow move failed for ref window: ${e}`));
    }

    // Snapshot positions (for stability scoring), find any restore anchor, and resolve the
    // pinned composition, all read by the _tile call that follows.
    _prepareTilePass(meta_windows, windows, workspace) {
        this._positionSnapshot = new Map();
        for (const w of meta_windows) {
            const f = w.get_frame_rect();
            this._positionSnapshot.set(w.get_id(), { cx: f.x + f.width / 2, cy: f.y + f.height / 2 });
        }

        // Pull a just-restored window back toward its old miniature region. The restore path tiles
        // with a null reference, so find the flagged window among these.
        this._restoreAnchor = null;
        for (const w of meta_windows) {
            const rc = WindowState.get(w, 'restoreAnchorCenter');
            if (rc) {
                this._restoreAnchor = { id: w.get_id(), cx: rc.cx, cy: rc.cy };
                break;
            }
        }

        // Zero-displacement bias makes stability scoring revert explicit drag order; suppress once.
        if (this._skipStabilityForNextTile) {
            this._skipStabilityForNextTile = false;
            this._positionSnapshot = null;
            this._restoreAnchor = null;
        }

        // Honor a pinned composition only while it still matches the current window count; a
        // count change (window opened/closed) invalidates it, handing control to the auto-layout.
        this._activePinnedShape = null;
        this._activePinnedWorkspace = workspace;
        const pin = this._pinnedComposition.get(workspace);
        if (pin) {
            if (pin.count === windows.length) this._activePinnedShape = pin.shape;
            else this._pinnedComposition.delete(workspace);
        }
    }

    // A single window never overflows; a maximized/fullscreen sibling always forces it.
    _determineOverflow(tile_info, workspace_windows) {
        if (workspace_windows.length <= 1) return false;
        if (workspace_windows.some(w => this._windowingManager.isMaximizedOrFullscreen(w))) return true;
        return tile_info.overflow;
    }

    // Fold existing edge tiles into the pass. Returns { stop: true } when the caller must bail
    // (both sides walled off, or nothing left to tile), else the updated { work_area, meta_windows }.
    _applyEdgeTiledConstraints(edgeTiledWindows, workspace, monitor, reference_meta_window, meta_windows, workspace_windows) {
        Logger.log(`Found ${edgeTiledWindows.length} edge-tiled window(s)`);
        const sides = new Set(edgeTiledWindows.map(w => ZONE_SIDE[w.zone]));

        if (sides.has('left') && sides.has('right')) {
            return this._handleBothSidesEdgeTiled(edgeTiledWindows, workspace, monitor, reference_meta_window);
        }

        const remainingSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
        if (this.dragRemainingSpace) {
            Logger.log(`Reusing drag remaining space: x=${this.dragRemainingSpace.x}, w=${this.dragRemainingSpace.width}`);
            return { work_area: this.dragRemainingSpace, meta_windows };
        }

        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        const nonEdgeTiledCount = workspace_windows.filter(w => !edgeTiledIds.includes(w.get_id())).length;
        Logger.log(`Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
        Logger.log(`Total workspace windows: ${workspace_windows.length}, Non-edge-tiled: ${nonEdgeTiledCount}`);

        let filtered = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
        Logger.log(`After filtering edge-tiled: ${filtered.length} windows to tile`);

        // Sacred windows (maximized/fullscreen) never get touched by the mosaic.
        const beforeMaxFilter = filtered.length;
        filtered = filtered.filter(w => !this._windowingManager.isMaximizedOrFullscreen(w));
        if (filtered.length < beforeMaxFilter) {
            Logger.log(`Filtered ${beforeMaxFilter - filtered.length} maximized/fullscreen (sacred) windows`);
        }

        if (filtered.length === 0) {
            Logger.log('No non-edge-tiled windows to tile');
            this._unlockWorkspaceEarlyReturn(workspace);
            return { stop: true };
        }

        return { work_area: remainingSpace, meta_windows: filtered };
    }

    // Both sides walled off, so the mosaic has no room. Expel the mosaic windows only when an
    // edge tile just completed the wall (or the newcomer is one of them); otherwise leave them.
    _handleBothSidesEdgeTiled(edgeTiledWindows, workspace, monitor, reference_meta_window) {
        // During a drag only the preview may move; touching frames would fight the grab.
        if (this.isDragging) {
            Logger.log('Both sides edge-tiled - deferring overflow until drag ends');
            this._unlockWorkspaceEarlyReturn(workspace);
            return { stop: true };
        }

        Logger.log('Both sides edge-tiled - workspace fully occupied');

        const edgeTiledIds = edgeTiledWindows.map(w => w.window.get_id());
        const isReferenceEdgeTiled = reference_meta_window && edgeTiledIds.includes(reference_meta_window.get_id());

        for (const window of this._edgeTilingManager.getNonEdgeTiledWindows(workspace, monitor)) {
            const isRef = reference_meta_window && window.get_id() === reference_meta_window.get_id();
            if ((isRef || isReferenceEdgeTiled) &&
                !this._windowingManager.isExcluded(window) &&
                !this._windowingManager.isMaximizedOrFullscreen(window)) {
                Logger.log(`Expelling non-edge-tiled window ${window.get_id()} (RefEdgeTiled=${isReferenceEdgeTiled}, IsRef=${isRef})`);
                this._windowingManager.moveOversizedWindow(window).catch(e =>
                    Logger.error(`Overflow expel failed for ${window.get_id()}: ${e}`));
            }
        }

        this._unlockWorkspaceEarlyReturn(workspace);
        return { stop: true };
    }

    // No monitor and no reference means "tile the whole workspace": recurse once per monitor,
    // each handling its own lock, then release this workspace's lock after they settle.
    _tileEachMonitor(workspace, keep_oversized_windows, excludeFromTiling, dryRun) {
        const nMonitors = global.display.get_n_monitors();
        if (nMonitors > 1) {
            Logger.log(`Auto-tiling workspace ${workspace.index()} across ${nMonitors} monitors`);
        }
        for (let m = 0; m < nMonitors; m++) {
            this.tileWorkspaceWindows(workspace, null, m, keep_oversized_windows, excludeFromTiling, dryRun, true);
        }

        if (!(this._extension && this._extension.windowHandler)) return;
        if (this._extension._timeoutRegistry) {
            this._extension._timeoutRegistry.add(constants.ANIMATION_DURATION_MS + 50, () => {
                this._extension.windowHandler.unlockWorkspace(workspace);
            }, 'unlockWorkspaceRecursive');
        } else {
            // No registry, so unlock immediately (extension is likely disabling)
            this._extension.windowHandler.unlockWorkspace(workspace);
        }
    }

    tileWorkspaceWindows(workspace, reference_meta_window, _monitor, keep_oversized_windows, excludeFromTiling = false, dryRun = false, isRecursive = false) {
        if (this._tileRequestBlocked(workspace, _monitor)) {
            return { overflow: false, layout: null };
        }

        Logger.log(`tileWorkspaceWindows: Starting for workspace ${workspace.index()} (isRecursive=${isRecursive})`);

        const opened = this._openTilePass(workspace, reference_meta_window, _monitor, keep_oversized_windows, excludeFromTiling, dryRun, isRecursive);
        if (opened.done) return opened.result;
        _monitor = opened.monitor;

        const ctx = this._buildTileContext(workspace, reference_meta_window, _monitor, excludeFromTiling);
        if (ctx.done) return ctx.result;
        const { meta_windows, windows, work_area, monitor, workspace_windows, edgeTiledWindows } = ctx;

        this._preapplyPendingMiniSizes(windows);

        // Computed regions from this pass, returned to the caller so it can find
        // miniature positions without depending on the ComputedLayouts side-channel.
        const computedRegions = new Map();

        const tileArea = this._effectiveTileArea(work_area);

        this._prepareTilePass(meta_windows, windows, workspace);

        let tile_info = this._tile(windows, tileArea, dryRun);
        this._activePinnedShape = null;
        let overflow = this._determineOverflow(tile_info, workspace_windows);

        if (dryRun) return this._dryRunResult(overflow, workspace);

        const refPhase = this._maybeEjectReference(
            overflow, keep_oversized_windows, reference_meta_window, edgeTiledWindows, windows, tileArea, workspace, monitor, tile_info);
        if (refPhase.stop) return { overflow: true, layout: null };
        tile_info = refPhase.tile_info;

        const resolved = this._resolveOverflowByMiniature(
            overflow, reference_meta_window, refPhase.referenceOverflowSkipped, meta_windows, windows, workspace, tileArea, tile_info);
        tile_info = resolved.tile_info;
        overflow = resolved.overflow;

        this._positionSnapshot = null;
        this._restoreAnchor = null;
        this._recordGroupStability(tile_info);
        Logger.log(`Drawing tiles - isDragging: ${this.isDragging}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`);

        // Ejecting and miniaturizing above can both come back still overflowing, and the packer
        // force-stacks into the work area rather than refusing, so drawing it piles windows up.
        if (this._ejectForSurvivingOverflow(overflow, meta_windows, workspace, monitor)) {
            // The miniaturization above still stands; finalize it here too, or the flagged
            // window never gets its miniature and stays frozen out of every later pass.
            this._finalizeTilePass(overflow, meta_windows, computedRegions, tileArea, workspace, isRecursive);
            return { overflow: true, layout: null };
        }

        this._positionTiledWindows(workspace, monitor, tile_info, tileArea, meta_windows, reference_meta_window, computedRegions, work_area);

        this._publishToOverviewIfAvailable(workspace, monitor);

        return this._finalizeTilePass(overflow, meta_windows, computedRegions, tileArea, workspace, isRecursive);
    }

    // destroyMasks + lock, then resolve the target monitor (dispatching per-monitor when none given).
    // Returns {done, result} to short-circuit, else {done:false, monitor}.
    _openTilePass(workspace, reference_meta_window, _monitor, keep_oversized_windows, excludeFromTiling, dryRun, isRecursive) {
        if (!isRecursive && !dryRun) {
            this.destroyMasks();
        }

        // LOCK: Prevent spurious overflow detection during tiling shifts
        if (this._extension && this._extension.windowHandler) {
            this._extension.windowHandler.lockWorkspace(workspace);
        }

        if (_monitor === null || _monitor === undefined) {
            if (!reference_meta_window) {
                this._tileEachMonitor(workspace, keep_oversized_windows, excludeFromTiling, dryRun);
                return { done: true, result: { overflow: false, layout: null } };
            }
            _monitor = reference_meta_window.get_monitor();
        }

        return { done: false, monitor: _monitor };
    }

    // Working geometry for the pass: descriptors, work area, resolved monitor, edge-tiled regions.
    // Returns {done, result} to short-circuit, else the context locals.
    _buildTileContext(workspace, reference_meta_window, _monitor, excludeFromTiling) {
        if (this._windowingManager) {
            this._windowingManager.invalidateWindowsCache();
        }

        const working_info = this._getWorkingInfo(workspace, reference_meta_window, _monitor, excludeFromTiling);
        if (!working_info) {
            this._unlockWorkspaceEarlyReturn(workspace);
            return { done: true, result: { overflow: false, layout: null } };
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
            const edgeResult = this._applyEdgeTiledConstraints(
                edgeTiledWindows, workspace, monitor, reference_meta_window, meta_windows, workspace_windows);
            if (edgeResult.stop) return { done: true, result: { overflow: false, layout: null } };
            meta_windows = edgeResult.meta_windows;
            work_area = edgeResult.work_area;
        }

        return { done: false, meta_windows, windows, work_area, monitor, workspace_windows, edgeTiledWindows };
    }

    // Nothing to eject (no reference, or its expulsion was skipped), so try
    // miniaturizing candidates to reclaim space instead of painting overflow.
    _resolveOverflowByMiniature(overflow, reference_meta_window, referenceOverflowSkipped, meta_windows, windows, workspace, tileArea, tile_info) {
        if (!(overflow && this._noRefMiniaturizeAllowed(reference_meta_window, referenceOverflowSkipped) && this._extension?.miniatureManager))
            return { tile_info, overflow };

        const resolved = this._miniaturizeForNoRefOverflow(meta_windows, windows, workspace, reference_meta_window, tileArea);
        return resolved ? resolved : { tile_info, overflow };
    }

    _finalizeTilePass(overflow, meta_windows, computedRegions, tileArea, workspace, isRecursive) {
        if (!isRecursive) {
            this._createPendingMiniatures(meta_windows, computedRegions, tileArea);
        }

        const result = { overflow, layout: this._cachedTileResult?.windows || null, computedRegions };
        this.emit('mosaic-changed', workspace);

        if (!isRecursive) {
            for (const { window: win } of this._pendingMiniatureWindows ?? [])
                WindowState.remove(win, PENDING_MINIATURE);
            this._pendingMiniatureWindows = [];
        }

        return result;
    }

    _publishToOverviewIfAvailable(workspace, monitor) {
        this._extension?.mosaicRenderer?.publishToOverview(workspace, monitor);
    }

    // Eject the reference window when it caused the overflow, unless edge-tiling or a drag
    // owns its placement. Returns {stop} to abort, else the possibly-updated tile_info.
    _maybeEjectReference(overflow, keep_oversized_windows, reference_meta_window, edgeTiledWindows, windows, tileArea, workspace, monitor, tile_info) {
        const canOverflow = this._canExpelReference(reference_meta_window, edgeTiledWindows);

        if (!(overflow && !keep_oversized_windows && reference_meta_window && canOverflow && !this.isDragging))
            return { stop: false, tile_info, referenceOverflowSkipped: false };

        const refResult = this._handleReferenceOverflow(reference_meta_window, windows, tileArea, workspace, monitor, tile_info);
        if (refResult.stop) return { stop: true };
        return { stop: false, tile_info: refResult.tile_info, referenceOverflowSkipped: refResult.referenceOverflowSkipped };
    }

    // Block expulsion if edge-tiled (except a non-edge reference); the edge region owns its geometry.
    _canExpelReference(reference_meta_window, edgeTiledWindows) {
        const hasEdgeTiledWindows = edgeTiledWindows && edgeTiledWindows.length > 0;
        const referenceIsEdgeTiled = reference_meta_window &&
            edgeTiledWindows?.some(s => s.window.get_id() === reference_meta_window.get_id());
        return !hasEdgeTiledWindows || !referenceIsEdgeTiled;
    }

    // An edge preview already knows where the reference is going (the tile), so it can never be
    // the one ejected; miniaturizing the rest is the entire point of the preview. Any other drag
    // has no such destination, so leave the mosaic alone until the drop.
    _noRefMiniaturizeAllowed(reference_meta_window, referenceOverflowSkipped) {
        return this.isDragging
            ? (!!this.dragRemainingSpace && this._dragMiniaturizationAllowed)
            : (!reference_meta_window || referenceOverflowSkipped);
    }

    _effectiveTileArea(work_area) {
        return this.isDragging && this.dragRemainingSpace ? this.dragRemainingSpace : work_area;
    }

    _dryRunResult(overflow, workspace) {
        this._positionSnapshot = null;
        this._restoreAnchor = null;
        this._unlockWorkspaceEarlyReturn(workspace);
        return { overflow, layout: this._cachedTileResult?.windows || null };
    }

    // Pre-apply mini sizes so the initial _tile sees the correct footprint.
    // Without this, pendingMiniature windows still have their full frame size,
    // which causes spurious overflow and fires the no-ref overflow block as a
    // second independent miniaturizer alongside tryFitWithResize.
    _preapplyPendingMiniSizes(windows) {
        // Only reset if not already populated (to survive recursive calls from tryFitWithResize)
        if (!this._pendingMiniatureWindows) {
            this._pendingMiniatureWindows = [];
        }
        for (const pm of this._pendingMiniatureWindows) {
            if (!pm.miniSize) continue;
            const desc = windows.find(d => d.id === pm.window.get_id());
            if (desc) {
                desc.width = pm.miniSize.width;
                desc.height = pm.miniSize.height;
            }
        }
    }

    _recordGroupStability(tile_info) {
        if (!(tile_info?.levels?.length > 0)) return;
        this._lastTiledOrder = tile_info.levels.flatMap(l => l.windows).map(w => w.id);
        const newGroupAssignment = {
            pairs: this._coMembershipPairs(tile_info.levels),
            ids: new Set(tile_info.levels.flatMap(l => l.windows.map(w => w.id))),
        };
        this._lastGroupAssignment = newGroupAssignment;
        // Partition rather than the pair set, which is quadratic and fires on every drag retile.
        const partition = tile_info.levels.map(l => `[${l.windows.map(w => w.id).join(',')}]`).join('');
        Logger.log(`[GROUP STABILITY] Recorded ${newGroupAssignment.pairs.size} pairs over ${partition}`);
    }

    _positionTiledWindows(workspace, monitor, tile_info, tileArea, meta_windows, reference_meta_window, computedRegions, work_area) {
        let animationsHandledPositioning = false;
        if (!this.isDragging && tile_info && tile_info.levels && tile_info.levels.length > 0) {
            // Allow animation for windows returning from excluded state
            if (reference_meta_window && WindowState.get(reference_meta_window, 'justReturnedFromExclusion')) {
                Logger.log(`Allowing animation for returning excluded window ${reference_meta_window.get_id()}`);
                WindowState.remove(reference_meta_window, 'justReturnedFromExclusion');
            }

            animationsHandledPositioning = this._animateTileLayout(workspace, monitor, tile_info, tileArea, meta_windows, reference_meta_window, computedRegions, work_area);
        }

        if (!animationsHandledPositioning) {
            Logger.log('Animations did not handle positioning, calling drawTile');
            this._drawTile(workspace, monitor, tile_info, meta_windows, false, computedRegions, work_area);
            // _animateTileLayout owns the deferred unlock; since it didn't run,
            // release the lock now that positioning is done synchronously.
            this._unlockWorkspaceEarlyReturn(workspace);
        } else {
            Logger.log('Animations handled positioning, skipping drawTile');
        }
    }

    // Top-level only, not inside recursive tryFitWithResize.
    _createPendingMiniatures(meta_windows, computedRegions, tileArea) {
        // Consume any restore anchor so it can't bleed into a later retile.
        for (const w of meta_windows) {
            if (WindowState.get(w, 'restoreAnchorCenter'))
                WindowState.remove(w, 'restoreAnchorCenter');
        }

        if (!(this._pendingMiniatureWindows?.length > 0) || !this._extension?.miniatureManager) return;
        for (const { window: win, preSize } of this._pendingMiniatureWindows) {
            // Skip if already miniaturized, since an earlier tile call may have created it first.
            if (WindowState.get(win, IS_MINIATURE)) continue;
            this._createOnePendingMiniature(win, preSize, computedRegions, tileArea);
        }
    }

    _createOnePendingMiniature(win, preSize, computedRegions, tileArea) {
        const region = computedRegions.get(win.get_id());
        Logger.log(`[MINIATURE] Creating ${win.get_id()} with stored preSize=${preSize?.width}x${preSize?.height}`);
        if (region) {
            Logger.log(`[MINIATURE] Creating miniature for window ${win.get_id()} at region (${region.x},${region.y}) size (${region.width}x${region.height})`);
            this._extension.miniatureManager.createMiniature(win, region, preSize);
        } else {
            Logger.warn(`[MINIATURE] No computed region for window ${win.get_id()}, using workArea`);
            this._extension.miniatureManager.createMiniature(win, { x: tileArea.x, y: tileArea.y, width: tileArea.width, height: tileArea.height }, preSize);
        }
    }

    // Guards that make a tile pass a no-op before any lock or work is taken.
    _tileRequestBlocked(workspace, _monitor) {
        if (!workspace || workspace.index() < 0) {
            Logger.log(`tileWorkspaceWindows: Invalid workspace (index=${workspace?.index?.() ?? 'null'}) - skipping`);
            return true;
        }

        if (this._extension && !this._extension.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log(`Mosaic disabled for workspace ${workspace.index()} - skipping tiling`);
            return true;
        }

        if (this._monitorGone(_monitor)) {
            Logger.log(`tileWorkspaceWindows: Monitor ${_monitor} no longer exists; skipping tiling`);
            return true;
        }

        return false;
    }

    // Callers that remember a monitor to retile later can land here after it was
    // unplugged, and mutter asserts on a stale index instead of answering empty.
    _monitorGone(_monitor) {
        return _monitor !== null && _monitor !== undefined &&
            (_monitor < 0 || _monitor >= global.display.get_n_monitors());
    }

    // No reference to eject, so reclaim space by miniaturizing MRU-coldest candidates
    // one at a time until the sim stops overflowing. Returns the resolved
    // {tile_info, overflow} when it fits, or null to leave the caller's values alone.
    _miniaturizeForNoRefOverflow(meta_windows, windows, workspace, reference_meta_window, tileArea) {
        const focusedId = global.display.focus_window?.get_id();
        const resizingId = this._animationsManager?.getResizingWindowId();
        const mru = this._windowingManager.getMRUOrder(workspace);
        const rank = w => mru.get(w.get_id()) ?? Number.MAX_SAFE_INTEGER;

        const overflowCandidates = meta_windows
            .filter(w =>
                !WindowState.get(w, IS_MINIATURE) &&
                w.get_id() !== focusedId &&
                w.get_id() !== resizingId &&
                w.get_id() !== (this._restoringWindowId ?? null) &&
                w.get_id() !== (reference_meta_window?.get_id() ?? null) &&
                !this._windowingManager.isMaximizedOrFullscreen(w)
            )
            .sort((a, b) => rank(b) - rank(a));

        // Accumulate mini sizes across iterations so multiple windows can stack to resolve overflow.
        const cumulativeSim = new Map(meta_windows.map(w => this._simFootprint(w)));
        const pendingMinis = [];

        for (const candidate of overflowCandidates) {
            const frame = candidate.get_frame_rect();
            // Scale from current frame so the visual fills the region.
            const scale = constants.MINIATURE_TARGET_SIZE_PX / Math.max(frame.width, frame.height);
            const miniW = Math.round(frame.width * scale);
            const miniH = Math.round(frame.height * scale);

            cumulativeSim.set(candidate.get_id(), { width: miniW, height: miniH });
            pendingMinis.push({ candidate, frame, miniW, miniH });

            const simSizes = [...cumulativeSim.entries()].map(([id, s]) => ({ id, width: s.width, height: s.height }));

            if (!this._tile(simSizes, tileArea, true).overflow) {
                Logger.log(`[OVERFLOW] No-ref overflow resolved by miniaturizing ${pendingMinis.length} window(s)`);
                return this._commitNoRefMinis(pendingMinis, windows, tileArea);
            }
        }

        Logger.log('[OVERFLOW] No-ref overflow: miniaturizing all candidates still overflows, applying clamped positions');
        return null;
    }

    // Current footprint of a window for the no-ref sim: mini size when miniaturized, frame otherwise.
    _simFootprint(w) {
        const f = w.get_frame_rect();
        if (WindowState.get(w, IS_MINIATURE)) {
            const ms = getMiniatureSize(w);
            return [w.get_id(), ms ? { width: ms.width, height: ms.height } : { width: f.width, height: f.height }];
        }
        return [w.get_id(), { width: f.width, height: f.height }];
    }

    _commitNoRefMinis(pendingMinis, windows, tileArea) {
        if (!this._pendingMiniatureWindows) this._pendingMiniatureWindows = [];
        for (const { candidate: c, frame: f, miniW: mW, miniH: mH } of pendingMinis) {
            Logger.log(`[OVERFLOW] Miniaturizing ${c.get_id()} (${mW}x${mH})`);
            this._pendingMiniatureWindows.push({ window: c, preSize: { x: f.x, y: f.y, width: f.width, height: f.height } });
            WindowState.set(c, PENDING_MINIATURE, true);
            const desc = windows.find(w => w.id === c.get_id());
            if (desc) { desc.width = mW; desc.height = mH; }
        }
        this.invalidateLayoutCache();
        const tile_info = this._tile(windows, tileArea);
        return { tile_info, overflow: tile_info.overflow };
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

        const verdict = this._sacredIsolationVerdict(window, workspace, monitor);
        if (verdict !== 'continue') return verdict === 'fits';

        const working_info = this._getWorkingInfo(workspace, window, monitor);
        if (!working_info) {
            Logger.log('canFitWindow: No working info - cannot fit');
            return false;
        }
        if (this._hasMaximizedWindow(working_info.meta_windows)) {
            Logger.log('canFitWindow: Workspace has maximized window - cannot fit');
            return false;
        }

        const fit = this._availableFitSpace(window, workspace, monitor, working_info.work_area);
        if (!fit) return false;

        const windows = working_info.windows.filter(w => !fit.edgeTiledIds.includes(w.id));
        // targetSmartResizeSize takes priority: preferredSize holds the pre-resize original, which would falsely report overflow.
        this._resolveExistingDescriptorSizes(windows, workspace.list_windows());

        this._placeCandidateDescriptor(window, windows, overrideSize);

        return !this._tile(windows, fit.space, relaxed).overflow;
    }

    _placeCandidateDescriptor(window, windows, overrideSize) {
        const newWindowId = window.get_id();
        if (windows.some(w => w.id === newWindowId)) {
            this._updateExistingWindowDescriptor(window, windows, overrideSize, newWindowId);
        } else {
            this._appendNewWindowDescriptor(window, windows, overrideSize);
        }
    }

    // Symmetric isolation: a sacred (maximized/fullscreen) incoming window only fits an empty
    // workspace; a normal one only fits a workspace with no sacred window. 'continue' otherwise.
    _sacredIsolationVerdict(window, workspace, monitor) {
        const otherWindows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !WindowState.get(w, 'pendingInQueue') && w.get_id() !== window.get_id());

        if (this._windowingManager.isMaximizedOrFullscreen(window)) {
            if (otherWindows.length > 0) {
                Logger.log(`canFitWindow: Incoming window is sacred but workspace ${workspace.index()} is occupied - blocked`);
                return 'blocked';
            }
            Logger.log('canFitWindow: Window is sacred and workspace is empty - fits');
            return 'fits';
        }

        if (otherWindows.some(w => this._windowingManager.isMaximizedOrFullscreen(w))) {
            Logger.log(`canFitWindow: Incoming normal window blocked - workspace ${workspace.index()} has a sacred window`);
            return 'blocked';
        }
        return 'continue';
    }

    _hasMaximizedWindow(metaWindows) {
        return metaWindows.some(w => this._windowingManager.isMaximizedOrFullscreen(w));
    }

    // Space left for the incoming window after existing edge tiles, plus the ids to exclude
    // from the layout. Returns null when both sides are snapped (nothing fits).
    _availableFitSpace(window, workspace, monitor, workArea) {
        const edgeTiledWindows = this._edgeTilingManager
            ? this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor) : [];
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());

        if (edgeTiledWindows.length === 0) return { space: workArea, edgeTiledIds };

        const sides = new Set(
            edgeTiledWindows
                .filter(w => w.window.get_id() !== window.get_id())
                .map(w => ZONE_SIDE[w.zone])
        );
        if (sides.has('left') && sides.has('right')) {
            Logger.log('canFitWindow: Workspace fully occupied by edge tiles - cannot fit');
            return null;
        }

        const space = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
        Logger.log(`canFitWindow: Using remaining space after snap: ${space.width}x${space.height}`);
        return { space, edgeTiledIds };
    }

    // Descriptors carry the pre-tiling size; correct them to what each window will actually
    // occupy (pending restore/smart-resize target, live frame when constrained, else preferred).
    _resolveExistingDescriptorSizes(windows, workspaceWindows) {
        for (const w of windows) {
            const realWindow = workspaceWindows.find(win => win.get_id() === w.id);
            if (!realWindow || WindowState.get(realWindow, IS_MINIATURE)) continue;
            const size = this._descriptorSizeForExisting(realWindow);
            w.width = size.width;
            w.height = size.height;
        }
    }

    _descriptorSizeForExisting(realWindow) {
        const restoredSize = WindowState.get(realWindow, 'targetRestoredSize');
        if (restoredSize) return restoredSize;

        // Resize still pending, target not reached yet.
        const smartResizeSize = WindowState.get(realWindow, 'targetSmartResizeSize');
        if (smartResizeSize) return smartResizeSize;

        // targetSmartResizeSize gets cleared once the frame settles, so use the actual frame
        // here instead of preferredSize.
        if (WindowState.get(realWindow, 'isConstrainedByMosaic')) return realWindow.get_frame_rect();

        return WindowState.get(realWindow, 'preferredSize')
            || WindowState.get(realWindow, 'openingSize')
            || realWindow.get_frame_rect();
    }

    _appendNewWindowDescriptor(window, windows, overrideSize) {
        const { width, height } = this._sizeForNewWindow(window, overrideSize);
        Logger.log(`canFitWindow: Window not in workspace - adding with size ${width}x${height} (preferred=${!!overrideSize || !!WindowState.get(window, 'preferredSize')})`);

        const descriptor = new WindowDescriptor(window, windows.length);
        descriptor.width = width;
        descriptor.height = height;
        windows.push(descriptor);
    }

    _sizeForNewWindow(window, overrideSize) {
        if (overrideSize) {
            Logger.log(`canFitWindow: Using overrideSize ${overrideSize.width}x${overrideSize.height}`);
            return { width: overrideSize.width, height: overrideSize.height };
        }

        const smartResizeSize = WindowState.get(window, 'targetSmartResizeSize');
        if (smartResizeSize) return { width: smartResizeSize.width, height: smartResizeSize.height };

        // Use the actual frame dimensions instead of a hardcoded fallback.
        const preferredSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
        const frame = window.get_frame_rect();
        return {
            width: preferredSize ? preferredSize.width : frame.width,
            height: preferredSize ? preferredSize.height : frame.height,
        };
    }

    _updateExistingWindowDescriptor(window, windows, overrideSize, newWindowId) {
        Logger.log('canFitWindow: Window already in workspace - checking current layout');
        const existingDescriptor = windows.find(w => w.id === newWindowId);
        if (!existingDescriptor) return;

        if (overrideSize) {
            existingDescriptor.width = overrideSize.width;
            existingDescriptor.height = overrideSize.height;
            return;
        }

        // Skip constrained windows since their frame was already set above; preferredSize is
        // pre-constraint and would wrongly report overflow.
        const preferred = WindowState.get(window, 'preferredSize');
        const isConstrained = WindowState.get(window, 'isConstrainedByMosaic');
        if (preferred && !window.is_fullscreen() && !window.is_maximized() && !isConstrained) {
            existingDescriptor.width = preferred.width;
            existingDescriptor.height = preferred.height;
        }
    }

    restorePreferredSize(window) {
        if (!window) return;

        const preferredSize = WindowState.get(window, 'preferredSize') ||
                              WindowState.get(window, 'openingSize');

        if (preferredSize) {
            Logger.log(`restorePreferredSize: Restoring window ${window.get_id()} to ${preferredSize.width}x${preferredSize.height}`);
            const frame = window.get_frame_rect();
            MosaicConstraints.commitRegion(window, { x: frame.x, y: frame.y, width: preferredSize.width, height: preferredSize.height });

            WindowState.set(window, 'isSmartResizing', false);
            WindowState.set(window, 'targetSmartResizeSize', null);
        } else {
            Logger.log(`restorePreferredSize: No preferred size found for ${window.get_id()}`);
        }
    }

    saveOriginalSize(window) {
        if (!WindowState.has(window, 'originalSize')) {
            const frame = window.get_frame_rect();
            WindowState.set(window, 'originalSize', { width: frame.width, height: frame.height });
            Logger.log(`saveOriginalSize: Saved ${window.get_id()} as ${frame.width}x${frame.height}`);
        }
    }

    // TARGET size the window wants to be
    savePreferredSize(window) {
        if (this._preferredSaveBlocked(window)) return;

        const frame = window.get_frame_rect();
        const size = { width: frame.width, height: frame.height };
        if (this._isMonitorSizedSave(window, size)) return;

        if (!(size.width > 10 && size.height > 10)) {
            Logger.log(`savePreferredSize: Could not determine valid preferred size for ${window.get_id()}`);
            return;
        }

        if (WindowState.get(window, 'isEnteringSacred')) {
            Logger.log(`savePreferredSize: Save blocked by sacred transition flag for ${window.get_id()}`);
            return;
        }

        this._commitPreferredSize(window, size);
    }

    // States that own preferredSize themselves (smart resize, mosaic constraint) or shouldn't
    // record a transient frame (sacred/born-maximized) block the save.
    _preferredSaveBlocked(window) {
        if (WindowState.get(window, 'isSmartResizing') || WindowState.get(window, 'isReverseSmartResizing')) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - during (reverse) smart resize`);
            return true;
        }
        if (WindowState.get(window, 'isConstrainedByMosaic')) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - already constrained by smart resize`);
            return true;
        }
        if (this._windowingManager.isMaximizedOrFullscreen(window)) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - sacred window (managed by maximizedUndoInfo)`);
            return true;
        }
        if (WindowState.get(window, 'openedMaximized')) {
            Logger.log(`savePreferredSize: Skipping for ${window.get_id()} - opened maximized, not yet settled`);
            return true;
        }
        return false;
    }

    // Defense-in-depth: reject monitor-sized dimensions during transitions.
    _isMonitorSizedSave(window, size) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (!(workspace && monitor !== null && monitor !== undefined)) return false;

        const workArea = this._clampedWorkArea(workspace, monitor);
        if (workArea && size.width >= workArea.width && size.height >= workArea.height) {
            Logger.log(`savePreferredSize: Rejected monitor-sized dimensions ${size.width}x${size.height} for ${window.get_id()}`);
            return true;
        }
        return false;
    }

    _commitPreferredSize(window, size) {
        const current = WindowState.get(window, 'preferredSize');
        if (!current) {
            WindowState.set(window, 'preferredSize', size);
            Logger.log(`savePreferredSize: [INITIAL] Window ${window.get_id()} set to ${size.width}x${size.height}`);
            return;
        }

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

    clearPreferredSize(window) {
        if (WindowState.has(window, 'preferredSize')) {
            WindowState.remove(window, 'preferredSize');
            Logger.log(`clearPreferredSize: Removed ${window.get_id()}`);
        }
    }

    getPreferredSize(window) {
        return WindowState.get(window, 'preferredSize') || null;
    }

    // Mirrors tryFitWithResize's binary search + miniature-threshold heuristic. A plain
    // "fits at minimum size" check isn't enough, since Smart Resize's real pass also
    // re-miniaturizes anything landing below half its min/max range even if it
    // geometrically fits. A looser gate here just restores it and watches Smart Resize
    // mini it right back (visible as a blink).
    canRestoreMiniature(candidateMini, remainingWindows, workArea) {
        // A shrink request can't win against the pointer, so simulate the grabbed window as fixed
        const resizingWindowId = this._animationsManager?.getResizingWindowId();
        const isResizable = w => w.get_id() !== resizingWindowId && w.allows_resize && w.allows_resize();
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

        // Mid-grab a shrink-assisted fit flaps: the next drag event overflows it
        // again and re-minis the window we just restored, so require a full-size fit
        if (resizingWindowId !== null && remainingWindows.some(w => w.get_id() === resizingWindowId)) {
            Logger.log(`canRestoreMiniature: resize grab active, keeping mini ${candidateMini.get_id()} until it fits at full size`);
            return false;
        }

        if (this._tile(buildSim(0.0), workArea, true).overflow) {
            Logger.log(`canRestoreMiniature: candidate=${candidateMini.get_id()} doesn't fit even at minimum sizes`);
            return false;
        }

        // It fits somewhere between min and preferred; restore only if the best-fit scale keeps
        // it visibly larger than a miniature, otherwise it would read as a slightly-bigger mini.
        return !this._wouldStayMiniAtBestFit(candidateMini, descriptors, buildSim, sizeAt, workArea);
    }

    _wouldStayMiniAtBestFit(candidateMini, descriptors, buildSim, sizeAt, workArea) {
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
        return wouldStayMini;
    }

    tryRestoreWindowSizes(windows, workArea, _freedWidth, _freedHeight, _workspace, _monitor) {
        const shrunkWindows = this._collectShrunkWindows(windows);

        if (shrunkWindows.length === 0) {
            Logger.log(`tryRestoreWindowSizes: No shrunk windows to restore (0/${windows.length} windows had deficits > 2px)`);
            return false;
        }

        Logger.log(`tryRestoreWindowSizes: Found ${shrunkWindows.length} shrunk windows`);

        const totalWidthDeficit = shrunkWindows.reduce((sum, w) => sum + w.widthDeficit, 0);
        const totalHeightDeficit = shrunkWindows.reduce((sum, w) => sum + w.heightDeficit, 0);

        Logger.log(`tryRestoreWindowSizes: Total deficits: W=${totalWidthDeficit}px, H=${totalHeightDeficit}px`);

        if (totalWidthDeficit <= 0 && totalHeightDeficit <= 0) {
            Logger.log('tryRestoreWindowSizes: No deficit to fill');
            return false;
        }

        const result = this.findBestRestorationGain(windows, shrunkWindows, workArea);
        if (!result) {
            Logger.log('tryRestoreWindowSizes: Restoration would cause overflow even at 10% - waiting');
            for (const w of windows) {
                WindowState.remove(w, 'isReverseSmartResizing');
            }
            return false;
        }

        Logger.log(`tryRestoreWindowSizes: Applying ${Math.round(result.gain * 100)}% restoration`);
        this._applyRestoration(windows, shrunkWindows, result.layout);
        return true;
    }

    // Windows the mosaic shrank below their preferred size (2px slop for rounding).
    _collectShrunkWindows(windows) {
        const shrunkWindows = [];
        for (const window of windows) {
            if (WindowState.get(window, IS_MINIATURE)) continue;
            const preferredSize = WindowState.get(window, 'preferredSize');
            if (!preferredSize) continue;

            const frame = window.get_frame_rect();
            const widthDiff = preferredSize.width - frame.width;
            const heightDiff = preferredSize.height - frame.height;

            Logger.log(`tryRestoreWindowSizes: Check ${window.get_id()}: frame=${frame.width}x${frame.height}, pref=${preferredSize.width}x${preferredSize.height}, diff=${widthDiff}x${heightDiff}`);

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
        return shrunkWindows;
    }

    _applyRestoration(windows, shrunkWindows, bestLayout) {
        for (const sim of bestLayout) {
            const w = windows.find(win => win.get_id() === sim.id);
            if (!w || WindowState.get(w, IS_MINIATURE)) continue;

            WindowState.set(w, 'isReverseSmartResizing', true);

            const frame = w.get_frame_rect();
            this._animateResize(w, frame, sim.width, sim.height);
            // Wayland hasn't acked the resize yet when the settle retile runs, so stash the target here.
            WindowState.set(w, 'targetRestoredSize', { width: sim.width, height: sim.height });

            const shrunk = shrunkWindows.find(sw => sw.id === w.get_id());
            if (!shrunk) continue;

            // If fully restored (allow for small pixel rounding errors), remove constraint
            if (sim.width >= shrunk.openingWidth - 2 && sim.height >= shrunk.openingHeight - 2) {
                Logger.log(`tryRestoreWindowSizes: Window ${sim.id} fully restored!`);
                WindowState.set(w, 'isConstrainedByMosaic', false);
                WindowState.set(w, 'targetSmartResizeSize', null);
            } else {
                // Still constrained, but update mask
                this._setSmartResizeTarget(w, sim);
            }
        }
    }
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

    tryFitWithResize(newWindow, windows, workArea, workspace, focusedWindowOverride = null) {
        if (this._isSmartResizingBlocked) {
            Logger.log('[SMART RESIZE] tryFitWithResize BLOCKED by _isSmartResizingBlocked');
            return { success: false };
        }
        this._isSmartResizingBlocked = true;

        this._extension?.resizeHandler?.resetConstraintRebalanceCount();

        // Also exclude the window under an active manual resize grab, since focusedWindowOverride can point elsewhere.
        const resizingWindowId = this._animationsManager?.getResizingWindowId();

        try {
            const { allWindows, allResizable, windowData } =
                this._collectResizeParticipants(windows, newWindow, resizingWindowId);

            if (allResizable.length === 0) return { success: false };

            this._logResizeParticipants(allWindows, allResizable, windowData, workArea, workspace);

            // Interpolate between min and current sizes at factor t (1=current, 0=min); a window
            // marked pendingMiniature uses its miniature size instead of the interpolated one.
            const buildSimulated = (t) => allWindows.map(w => {
                const d = windowData.get(w.get_id());
                if (!d.isResizable)
                    return { id: w.get_id(), width: d.current.width, height: d.current.height };

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

            if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Natural fit, no resize needed');
                return { success: true, tileInfo: null, pendingWindows: [] };
            }

            if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                Logger.log('[SMART RESIZE] Overflow inevitable, windows don\'t fit even at minimums');
                this._sacrificeUntilMinFits(allWindows, windowData, buildSimulated, workArea, workspace, focusedWindowOverride, resizingWindowId);

                if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                    Logger.log('[SMART RESIZE] Still overflow after miniaturization, applying overflow logic');
                    return { success: false, tileInfo: null, pendingWindows: [] };
                }
            }

            let lo = this._binarySearchFitScale(buildSimulated, workArea);
            Logger.log(`[SMART RESIZE] Optimal scale factor: ${lo.toFixed(4)}`);
            lo = this._miniaturizeBelowThreshold(allWindows, allResizable, windowData, buildSimulated, workArea, workspace, focusedWindowOverride, resizingWindowId, lo);

            const { pendingWindows, grownWindows } = this._applyFitResults(buildSimulated(lo), windowData);
            this._scheduleGrowSettle(grownWindows);

            const finalTileInfo = this._tile(windows, workArea);
            Logger.log(`[TRYFIT] Returning pendingWindows len=${pendingWindows.length}`);
            return { success: true, tileInfo: finalTileInfo, pendingWindows };
        } finally {
            this._isSmartResizingBlocked = false;
        }
    }

    _isUninitializedForResize(w, newWindow) {
        // Unreliable geometry corrupts the binary search.
        return w.get_id() !== newWindow.get_id()
            && !WindowState.get(w, 'preferredSize')
            && !WindowState.get(w, 'openingSize')
            && !WindowState.get(w, 'isConstrainedByMosaic');
    }

    // One participant's descriptor, or null to skip it. preferredSize is the ceiling for the
    // deterministic binary search.
    _classifyResizeParticipant(w, newWindow, resizingWindowId) {
        // get_frame_rect on a disposed MetaWindow segfaults libmutter.
        if (!isWindowAlive(w)) {
            Logger.log(`[SMART RESIZE] Skipping destroyed window ${w?.get_id?.() ?? '?'}`);
            return null;
        }

        // Already-miniaturized windows are fixed non-resizable participants so the simulation
        // accounts for their space. This must precede the uninitialized check, since minis never
        // get isConstrainedByMosaic and may lack preferredSize, so they'd be filtered out.
        if (WindowState.get(w, IS_MINIATURE)) {
            const ms = getMiniatureSize(w);
            if (!ms) return null;
            return { window: w, current: ms, min: ms, isResizable: false };
        }

        if (this._isUninitializedForResize(w, newWindow)) {
            Logger.log(`[SMART RESIZE] Skipping uninitialized window ${w.get_id()}`);
            return null;
        }

        const preferred = WindowState.get(w, 'preferredSize') || WindowState.get(w, 'openingSize');
        const current = preferred || this.getEffectiveWindowSize(w);
        const min = this.getWindowMinimumSize(w);
        return { window: w, current, preferred, min, isResizable: this._isResizableParticipant(w, resizingWindowId) };
    }

    // The window under an active manual resize grab is fixed (its size can't lose to the pointer).
    _isResizableParticipant(w, resizingWindowId) {
        return w.get_id() !== resizingWindowId && w.allows_resize && w.allows_resize();
    }

    _collectResizeParticipants(windows, newWindow, resizingWindowId) {
        const allResizable = [];
        const allWindows = [];
        const windowData = new Map();

        for (const w of [...windows, newWindow]) {
            if (allWindows.some(aw => aw.get_id() === w.get_id())) continue;
            const data = this._classifyResizeParticipant(w, newWindow, resizingWindowId);
            if (!data) continue;

            allWindows.push(w);
            windowData.set(w.get_id(), data);
            if (data.isResizable) allResizable.push(w);
        }

        return { allWindows, allResizable, windowData };
    }

    _logResizeParticipants(allWindows, allResizable, windowData, workArea, workspace) {
        Logger.log(`[SMART RESIZE] tryFitWithResize: ${allWindows.length} windows (${allResizable.length} resizable), workArea: ${workArea.width}×${workArea.height}`);
        const mruDiag = this._windowingManager.getMRUOrder(workspace);
        for (const [id, d] of windowData) {
            Logger.log(`[SMART RESIZE]   ${id}(${d.window.get_wm_class()}): current=${d.current.width}×${d.current.height}, min=${d.min.width}×${d.min.height}, resizable=${d.isResizable}, mruRank=${mruDiag.get(id) ?? '∞'}`);
        }
    }

    _binarySearchFitScale(buildSimulated, workArea) {
        let lo = 0.0, hi = 1.0;
        for (let i = 0; i < 15; i++) {
            const mid = (lo + hi) / 2;
            if (!this._tile(buildSimulated(mid), workArea, true).overflow)
                lo = mid;
            else
                hi = mid;
        }
        return lo;
    }

    // The user-active window (never sacrificed). focusedWindowOverride lets callers treat a
    // specific window as active when Mutter's focus hasn't shifted yet.
    _resizeFocusedId(focusedWindowOverride) {
        return (focusedWindowOverride ?? global.display.focus_window)?.get_id();
    }

    // Non-miniature, non-pending count; Guard 1 refuses to miniaturize the last one.
    _nonMiniatureCount(allWindows, windowData) {
        return allWindows.filter(w =>
            !WindowState.get(w, IS_MINIATURE) && !windowData.get(w.get_id())?.pendingMiniature
        ).length;
    }

    // A window eligible to be miniaturized to make room: not already pending/mini/maximized,
    // not the focused/resizing/arriving window, and resizable.
    _isMiniaturizationCandidate(w, d, focusedId, resizingWindowId) {
        if (!d || d.pendingMiniature) return false;
        if (w.get_id() === focusedId || w.get_id() === resizingWindowId || this._isArrivalPending(w)) return false;
        if (WindowState.get(w, IS_MINIATURE)) return false;
        if (this._windowingManager.isMaximizedOrFullscreen(w)) return false;
        return d.isResizable;
    }

    // Stamp pendingMiniature + miniSize + pre-size from the live frame (scaled so the visual
    // fills the mini region), and return the computed miniSize.
    _markPendingMiniature(d) {
        const frame = d.window.get_frame_rect();
        const scale = constants.MINIATURE_TARGET_SIZE_PX / Math.max(frame.width, frame.height);
        d.pendingMiniature = true;
        d.miniSize = { width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) };
        d.pendingPreSize = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
        return { miniSize: d.miniSize, scale };
    }

    // Windows don't fit even at minimum size: miniaturize least-recently-used ones (never the
    // last visible one) until the min-size layout fits.
    _sacrificeUntilMinFits(allWindows, windowData, buildSimulated, workArea, workspace, focusedWindowOverride, resizingWindowId) {
        if (!this._extension?.miniatureManager) return;

        const focusedId = this._resizeFocusedId(focusedWindowOverride);
        // Higher MRU index means less recently used, so descending sacrifices whichever window
        // the user has ignored longest.
        const mru = this._windowingManager.getMRUOrder(workspace);
        const rank = w => mru.get(w.get_id()) ?? Number.MAX_SAFE_INTEGER;
        const ordered = [...allWindows].sort((a, b) => rank(b) - rank(a));

        for (const w of ordered) {
            const d = windowData.get(w.get_id());
            if (!this._isMiniaturizationCandidate(w, d, focusedId, resizingWindowId)) continue;
            if (this._nonMiniatureCount(allWindows, windowData) <= 1) break;

            const { miniSize } = this._markPendingMiniature(d);
            Logger.log(`[SMART RESIZE] ${w.get_id()}: miniaturizing to make room (${miniSize.width}x${miniSize.height})`);

            if (!this._tile(buildSimulated(0.0), workArea, true).overflow) break;
        }
    }

    // After the fit scale is known, miniaturize windows the scale pushed below half their size
    // range, least-recently-used first, re-searching the scale after each so freed space is reclaimed.
    _miniaturizeBelowThreshold(allWindows, allResizable, windowData, buildSimulated, workArea, workspace, focusedWindowOverride, resizingWindowId, lo) {
        if (!this._extension?.miniatureManager) return lo;

        const focusedId = this._resizeFocusedId(focusedWindowOverride);
        const mru = this._windowingManager.getMRUOrder(workspace);
        const rank = id => mru.get(id) ?? Number.MAX_SAFE_INTEGER;

        for (let iter = 0; iter < allWindows.length; iter++) {
            const candidates = buildSimulated(lo).filter(sim => {
                const d = windowData.get(sim.id);
                if (!this._isMiniaturizationCandidate(d?.window, d, focusedId, resizingWindowId)) return false;
                // The threshold falls back to the work area, so a window still at its preferred size trips it.
                if (sim.width >= d.current.width && sim.height >= d.current.height) return false;
                const { thresholdW, thresholdH } = this._miniatureThreshold(d.window, workArea);
                return sim.width < thresholdW || sim.height < thresholdH;
            });
            if (candidates.length === 0) break;

            // Descending, so the window ignored longest is sacrificed first.
            candidates.sort((a, b) => rank(b.id) - rank(a.id));
            const candidateData = windowData.get(candidates[0].id);

            if (this._nonMiniatureCount(allWindows, windowData) <= 1) {
                Logger.log(`[MINIATURE] Guard 1: refusing to miniaturize last non-miniature window ${candidates[0].id}`);
                break;
            }

            candidateData.miniatureTargetSlot = null;
            const natural = candidateData.preferred || candidateData.current;
            const { miniSize, scale } = this._markPendingMiniature(candidateData);
            Logger.log(`[MINIATURE] Marking ${candidates[0].id}(${candidateData.window.get_wm_class()}) as PENDING miniature (will be created after layout)`);
            Logger.log(`[MINIATURE] ${candidates[0].id} PENDING at frame=${candidateData.pendingPreSize.width}x${candidateData.pendingPreSize.height} restore=${natural.width}x${natural.height} → miniSize: ${miniSize.width}x${miniSize.height} scale: ${scale}`);

            if (allResizable.length === 0) break;

            // Lock lo at 1.0 so the final pass applies preferred sizes; otherwise lo would stay
            // at the pre-mini scale and the freed space wouldn't be reclaimed by the siblings.
            if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                return 1.0;
            }
            lo = this._binarySearchFitScale(buildSimulated, workArea);
        }
        return lo;
    }

    _miniatureThreshold(w, workArea) {
        const min = this.getWindowMinimumSize(w);
        const maxSize = this.getWindowMaximumSize(w);
        const effectiveMaxW = maxSize?.width || workArea.width;
        const effectiveMaxH = maxSize?.height || workArea.height;
        return {
            thresholdW: (min.width + effectiveMaxW) / 2,
            thresholdH: (min.height + effectiveMaxH) / 2,
        };
    }

    _applyFitResults(finalSizes, windowData) {
        const pendingWindows = [];
        const grownWindows = [];

        for (const sim of finalSizes) {
            const d = windowData.get(sim.id);
            if (!d.isResizable) continue;

            const w = d.window;
            const frame = w.get_frame_rect();

            // sim ≥ current means this window can sit at (or above) its preferred size. If the
            // actual frame is smaller (left over from an earlier smart-resize we can now undo),
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
            this._setSmartResizeTarget(w, sim);

            if (d.pendingMiniature) {
                const storedPreSize = d.pendingPreSize || d.current;
                pendingWindows.push({ window: w, miniSize: d.miniSize, preSize: storedPreSize });
                Logger.log(`[MINIATURE] ${w.get_id()} stored in pendingWindows: preSize=${storedPreSize.width}x${storedPreSize.height}, SKIPPING move_resize_frame (will be miniaturized)`);
                continue;
            }
            this._animateResize(w, frame, sim.width, sim.height, true);
            Logger.log(`[SMART RESIZE] ${sim.id}: ${d.current.width}×${d.current.height} → ${sim.width}×${sim.height}`);
        }

        return { pendingWindows, grownWindows };
    }

    // Clear the targetRestoredSize bridge after the Wayland frame settles; until then
    // WindowDescriptor reads this value instead of the stale frame.
    _scheduleGrowSettle(grownWindows) {
        if (grownWindows.length === 0 || !this._extension?._timeoutRegistry) return;

        this._extension._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
            for (const gw of grownWindows) {
                WindowState.remove(gw, 'targetRestoredSize');
            }
            return false;
        }, 'tryFitWithResize_growSettle');
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
            const resizingWindowId = this._animationsManager?.getResizingWindowId();
            const allWindows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                .filter(w => !WindowState.get(w, 'pendingInQueue') &&
                             !this._edgeTilingManager?.isEdgeTiled(w) &&
                             !this._windowingManager.isMaximizedOrFullscreen(w));

            if (allWindows.length === 0) return;

            const { windowData, allResizable } = this._buildRebalanceData(allWindows, resizingWindowId);
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

            if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                this._restoreToPreferred(allWindows, windowData, workspace, monitor);
                return;
            }

            if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                this._ejectNewestOnRebalance(allWindows, workspace, monitor, resizingWindowId);
                return;
            }

            this._applyPartialRebalance(windowData, buildSimulated, workArea, workspace, monitor);
        } finally {
            this._isSmartResizingBlocked = false;
        }
    }

    _buildRebalanceData(allWindows, resizingWindowId) {
        const windowData = new Map();
        const allResizable = [];

        for (const w of allWindows) {
            const preferred = WindowState.get(w, 'preferredSize') || WindowState.get(w, 'originalSize');
            const current = preferred || this.getEffectiveWindowSize(w);
            const min = this.getWindowMinimumSize(w);
            // A shrink request can't win against the pointer, so the grabbed window is fixed
            const isResizable = w.get_id() !== resizingWindowId && w.allows_resize?.();

            windowData.set(w.get_id(), { window: w, current, min, isResizable });
            if (isResizable) allResizable.push(w);
        }

        return { windowData, allResizable };
    }

    // Everything fits at full size, so drop the constraints and ease each window back.
    _restoreToPreferred(allWindows, windowData, workspace, monitor) {
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
    }

    // Doesn't fit even at minimum sizes, so move the newest window out to a fresh workspace.
    _ejectNewestOnRebalance(allWindows, workspace, monitor, resizingWindowId) {
        Logger.log('[SMART RESIZE] Rebalance: overflow inevitable at corrected minimums');

        // Ghost mode already flags this during a live grab; the release path decides
        if (allWindows.some(w => w.get_id() === resizingWindowId)) {
            Logger.log('[SMART RESIZE] Rebalance: resize grab active, deferring overflow to release');
            return;
        }

        for (const w of allWindows) {
            WindowState.set(w, 'targetSmartResizeSize', null);
            WindowState.set(w, 'isConstrainedByMosaic', false);
        }

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
    }

    // Fits somewhere between min and preferred, so binary-search the largest scale that fits
    // and shrink each resizable window to it.
    _applyPartialRebalance(windowData, buildSimulated, workArea, workspace, monitor) {
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
            this._setSmartResizeTarget(w, sim);
            WindowState.set(w, 'isConstrainedByMosaic', true);

            this._animateResize(w, frame, sim.width, sim.height, true);
            Logger.log(`[SMART RESIZE] Rebal ${sim.id}: → ${sim.width}×${sim.height}`);
        }

        this.invalidateLayoutCache();
        // Save pending miniatures before recursive call (which resets the array)
        const savedPending = this._pendingMiniatureWindows;
        this.tileWorkspaceWindows(workspace, null, monitor, true);
        this._pendingMiniatureWindows = savedPending;
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
        this._pinnedComposition = null;
        this._activePinnedShape = null;
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
                this.width = frame.width > 0 ? frame.width : 1;
                this.height = frame.height > 0 ? frame.height : 1;
            }
        }

        this.id = meta_window.get_id();
    }

    draw(meta_windows, x, y, masks, isDragging, drawingManager, dryRun = false) {
        const window = meta_windows.find(w => w.get_id() === this.id);
        if (!window) {
            Logger.warn(`Could not find window with ID ${this.id} for drawing`);
            return;
        }

        // The layout cache was already updated in the caller.
        if (dryRun) return;

        // This descriptor already carries the mini's size, so moving the frame to it would
        // shrink the real window and createMiniature's scale would land on top of that.
        if (WindowState.get(window, PENDING_MINIATURE)) return;

        if (isDragging) {
            this._drawDragging(window, x, y, masks, drawingManager);
        } else {
            this._drawResting(window, x, y);
        }
    }

    _drawDragging(window, x, y, masks, drawingManager) {
        if (masks.has(this.id)) {
            if (drawingManager) drawingManager.rect(x, y, this.width, this.height);
            return;
        }
        // Miniatures use actor transforms, since move_resize_frame would shrink the frame and compound the scale.
        if (WindowState.get(window, IS_MINIATURE)) {
            this._animateMiniatureTo(window, x, y);
            return;
        }
        this._drawWindowDrag(window, x, y);
    }

    _animateMiniatureTo(window, x, y) {
        const windowActor = window.get_compositor_private();
        if (!windowActor || windowActor.is_destroyed()) return;

        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
        animateMiniatureToTarget(windowActor, window, sc, extL, extT, x, y, constants.ANIMATION_DURATION_MS);
        WindowState.get(window, MINIATURE_OVERLAY)?.animateToPosition(constants.ANIMATION_DURATION_MS);
    }

    _drawWindowDrag(window, x, y) {
        const currentRect = window.get_frame_rect();
        const windowActor = window.get_compositor_private();
        const currentScale = (windowActor && !windowActor.is_destroyed()) ? windowActor.scale_x : 1;
        const hasPreviewTransforms = Math.abs(currentScale - 1.0) > 0.01;

        Logger.log(`draw (drag): id=${this.id}, target=(${x},${y}), current=(${currentRect.x},${currentRect.y}), scale=${currentScale.toFixed(3)}`);

        if (hasPreviewTransforms && windowActor && !windowActor.is_destroyed()) {
            this._drawDragFromPreview(window, windowActor, currentRect, currentScale, x, y);
        } else {
            this._drawDragPlain(window, windowActor, currentRect, x, y);
        }
    }

    // Continue the drag preview's scale/translation into the settle ease, so a window still
    // shrunk from its preview eases smoothly to full size at the new region.
    _drawDragFromPreview(window, windowActor, currentRect, currentScale, x, y) {
        // actor.x changes after move_resize_frame; read all state first.
        const extLeft = currentRect.x - windowActor.x;
        const extTop = currentRect.y - windowActor.y;
        const [actorW, actorH] = windowActor.get_size();
        const [cpx, cpy] = windowActor.get_pivot_point();
        const visualX = windowActor.x + cpx * actorW * (1 - currentScale) + windowActor.translation_x + extLeft * currentScale;
        const visualY = windowActor.y + cpy * actorH * (1 - currentScale) + windowActor.translation_y + extTop * currentScale;
        WindowState.set(window, 'isConstrainedByMosaic', true);
        MosaicConstraints.commitRegion(window, { x, y, width: this.width, height: this.height });
        const actor_x_new = x - extLeft;
        const actor_y_new = y - extTop;
        const dw = actorW * (1 - currentScale);
        const dh = actorH * (1 - currentScale);
        const px = dw > 0 ? Math.max(0, Math.min(1, (visualX - actor_x_new - extLeft * currentScale) / dw)) : 0;
        const py = dh > 0 ? Math.max(0, Math.min(1, (visualY - actor_y_new - extTop * currentScale) / dh)) : 0;
        const startTx = visualX - actor_x_new - px * dw - extLeft * currentScale;
        const startTy = visualY - actor_y_new - py * dh - extTop * currentScale;
        windowActor.set_pivot_point(px, py);
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
    }

    _drawDragPlain(window, windowActor, currentRect, x, y) {
        const positionChanged = Math.abs(currentRect.x - x) > 5 || Math.abs(currentRect.y - y) > 5;
        const sizeChanged = Math.abs(currentRect.width - this.width) > 5 || Math.abs(currentRect.height - this.height) > 5;
        if (!positionChanged && !sizeChanged) return;

        WindowState.set(window, 'isConstrainedByMosaic', true);
        // Where the window really is, straight off the actor, since a half-finished ease
        // leaves the frame at the previous target.
        const alive = windowActor && !windowActor.is_destroyed();
        const visualX = alive ? windowActor.x + windowActor.translation_x : 0;
        const visualY = alive ? windowActor.y + windowActor.translation_y : 0;
        // A pure move lands on the actor synchronously (a resize doesn't), so after this the
        // actor carries the position the window really got, which is not x,y when the target
        // doesn't fit and mutter clamps it.
        window.move_frame(false, x, y);
        MosaicConstraints.commitRegion(window, { x, y, width: this.width, height: this.height });
        if (alive) {
            windowActor.set_translation(visualX - windowActor.x, visualY - windowActor.y, 0);
            windowActor.ease({
                translation_x: 0,
                translation_y: 0,
                opacity: 255,
                duration: Math.ceil(constants.ANIMATION_DURATION_MS * getSlowDownFactor()),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }
    }

    _drawResting(window, x, y) {
        if (WindowState.get(window, IS_MINIATURE)) {
            this._applyMiniatureResting(window, x, y);
            return;
        }
        WindowState.set(window, 'isConstrainedByMosaic', true);
        MosaicConstraints.commitRegion(window, { x, y, width: this.width, height: this.height });
        Logger.log(`[LAYOUT] draw ${window.get_id()}: target=(${x},${y}) size=${this.width}x${this.height}`);
    }

    // Do NOT move_frame for miniatures (Mutter may reject); drive them by actor transform.
    _applyMiniatureResting(window, x, y) {
        const windowActor = window.get_compositor_private();
        if (!windowActor || windowActor.is_destroyed()) return;

        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
        // Mid-flight the running ease owns the actor, so only stash the new target; a settled
        // miniature gets the transform applied now.
        if (!WindowState.get(window, ANIMATING_MINIATURE)) {
            applyMiniatureActorState(windowActor, sc, extL, extT, x, y);
        }
        WindowState.set(window, MINIATURE_TARGET_POS, { x, y });
        WindowState.get(window, MINIATURE_OVERLAY)?.updatePosition();
        Logger.log(`[MINIATURE] draw ${window.get_id()}: target=(${x},${y}) scale=${sc.toFixed(4)} extLeft=${extL} extTop=${extT} size=${this.width}x${this.height}`);
    }
}

// Slack inside a level belongs on the outer side, never between two neighbours,
// so the mosaic densifies toward the middle. Clamping keeps a level that straddles
// the origin from pushing its window past its own edge.
function outwardOffset(levelStart, levelExtent, windowExtent, origin) {
    const slack = levelExtent - windowExtent;
    if (slack <= 0) return 0;
    return Math.min(Math.max(origin - windowExtent / 2 - levelStart, 0), slack);
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

    // Clamp to the work area, record the computed region, and hand off to the window's own draw.
    _placeWindow(workspace, monitor, window, meta_windows, rawX, rawY, masks, isDragging, drawingManager, dryRun, regionsOut, bounds) {
        const { x: drawX, y: drawY } = clampToWorkArea(rawX, rawY, window.width, window.height, bounds);

        if (!dryRun)
            Logger.log(`Window ${window.id} target: ${drawX},${drawY} (${window.width}x${window.height})`);

        if (window.metaWindow) {
            const region = { x: drawX, y: drawY, width: window.width, height: window.height };
            MosaicModel.setRegion(window.metaWindow, region, workspace, monitor);
            if (regionsOut) regionsOut.set(window.metaWindow.get_id(), region);
        }

        window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
    }

    draw_horizontal(workspace, monitor, meta_windows, y, masks, isDragging, drawingManager, dryRun = false, regionsOut = null, bounds = null) {
        let x = this.x;
        for(const window of this.windows) {
            const rawX = window.targetX !== undefined ? window.targetX : x;
            const rawY = window.targetY !== undefined ? window.targetY : y;
            this._placeWindow(workspace, monitor, window, meta_windows, rawX, rawY, masks, isDragging, drawingManager, dryRun, regionsOut, bounds);
            x += window.width + constants.WINDOW_SPACING;
        }
    }

    draw_vertical(workspace, monitor, meta_windows, x, masks, isDragging, drawingManager, dryRun = false, regionsOut = null, bounds = null) {
        let y = this.y;
        for(const window of this.windows) {
            const rawX = window.targetX !== undefined ? window.targetX : x;
            const rawY = window.targetY !== undefined ? window.targetY : y;
            this._placeWindow(workspace, monitor, window, meta_windows, rawX, rawY, masks, isDragging, drawingManager, dryRun, regionsOut, bounds);
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
            // Don't clear boxes here; destroyMasks() already did it once at the start of tiling.
            drawingManager.rect(x, y, this.width, this.height);
        }
    }
}

