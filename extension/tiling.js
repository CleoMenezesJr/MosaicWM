// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Core mosaic tiling algorithm and layout management

import Clutter from 'gi://Clutter'; // Used for Enums (AnimationMode, etc)
import GObject from 'gi://GObject';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import * as WindowState from './windowState.js';

export const ComputedLayouts = new WeakMap();

export const TilingManager = GObject.registerClass({
    GTypeName: 'MosaicTilingManager',
    Signals: {
        'mosaic-changed': { param_types: [GObject.TYPE_OBJECT] }, // Emitted when layout changes (param: workspace)
    },
}, class TilingManager extends GObject.Object {
    _init(extension) {
        super._init();
        this.masks = [];
        this.working_windows = [];
        this.tmp_swap = [];
        this.tmp_reorder = null;
        this.isDragging = false;
        this.dragRemainingSpace = null;
        
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
        this._extension = null;
        
        // Flag to block overflow decisions during smart resize
        this._isSmartResizingBlocked = false;
        
        // Layout cache to avoid redundant O(n!) permutation calculations
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
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

    setWindowingManager(manager) {
        this._windowingManager = manager;
    }

    // Effective size: pending async sizes → frame rect → saved sizes → fallback
    getEffectiveWindowSize(window) {
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

    // Native minimum size via Mutter 50+ get_min_size(), with fallback
    getWindowMinimumSize(window) {
        if (window.get_min_size) {
            const [hasHint, minW, minH] = window.get_min_size();
            if (hasHint) {
                return {
                    width: Math.max(minW, constants.SMART_RESIZE_MIN_WINDOW_WIDTH),
                    height: Math.max(minH, constants.SMART_RESIZE_MIN_WINDOW_HEIGHT),
                };
            }
        }
        return {
            width: constants.SMART_RESIZE_MIN_WINDOW_WIDTH,
            height: constants.SMART_RESIZE_MIN_WINDOW_HEIGHT,
        };
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
            this.masks[id] = true;
        }
    }

    destroyMasks() {
        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }
        // Clear logical masks only when not dragging; recycle boxes otherwise.
        if (!this.isDragging) {
            this.masks = [];
        }
    }

    getMask(window) {
        const id = window.id !== undefined ? window.id : (window.get_id ? window.get_id() : null);
        if(id !== null && this.masks[id])
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
                    let center_offset = (work_area.height / 2 + work_area.y) - (y + win.height / 2);
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

    // Apply a pre-computed layout during drag
    applyDragLayout(positions, workspace, monitor) {
        const meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }

        for (const pos of positions) {
            const isMask = this.masks[pos.id];

            if (isMask) {
                if (this._drawingManager) {
                    this._drawingManager.rect(pos.x, pos.y, pos.width, pos.height);
                }
            } else {
                const window = meta_windows.find(w => w.get_id() === pos.id);
                if (!window) continue;

                const currentRect = window.get_frame_rect();
                const posChanged = Math.abs(currentRect.x - pos.x) > 5 || Math.abs(currentRect.y - pos.y) > 5;
                const sizeChanged = Math.abs(currentRect.width - pos.width) > 5 || Math.abs(currentRect.height - pos.height) > 5;

                if (posChanged || sizeChanged) {
                    WindowState.set(window, 'isConstrainedByMosaic', true);
                    window.move_resize_frame(false, pos.x, pos.y, pos.width, pos.height);
                    const actor = window.get_compositor_private();
                    if (actor) {
                        actor.set_translation(currentRect.x - pos.x, currentRect.y - pos.y, 0);
                        actor.ease({
                            translation_x: 0,
                            translation_y: 0,
                            opacity: 255,
                            duration: constants.ANIMATION_DURATION_MS,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD
                        });
                    }
                }
            }
        }
    }

    // Queue a window opening operation to prevent race conditions
    // The callback will be called when it's this window's turn. Supports async callbacks.
    setTmpSwap(id1, id2) {
        if (id1 === id2 || (this.tmp_swap[0] === id2 && this.tmp_swap[1] === id1))
            return;
        this.tmp_swap = [id1, id2];
    }

    clearTmpSwap() {
        this.tmp_swap = [];
    }

    applyTmpSwap(workspace) {
        if(!workspace.swaps)
            workspace.swaps = [];
        
        if(this.tmp_swap.length !== 0)
            workspace.swaps.push(this.tmp_swap);
    }

    applySwaps(workspace, array) {
        if(workspace.swaps) {
            const getId = w => w.id !== undefined ? w.id : w.get_id();
            for(let op of workspace.swaps) {
                if (Array.isArray(op) && op[0] === 'move') {
                    this._moveElement(array, op[1], op[2]);
                } else if (Array.isArray(op) && op[0] === 'order') {
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
        }
    }

    applyTmp(array) {
        if (this.tmp_reorder) {
            this._moveElement(array, this.tmp_reorder.draggedId, this.tmp_reorder.targetId);
        } else if(this.tmp_swap.length !== 0) {
            this._swapElements(array, this.tmp_swap[0], this.tmp_swap[1]);
        }
    }

    setTmpReorder(draggedId, targetId) {
        if (draggedId === targetId) return;
        this.tmp_reorder = { draggedId, targetId };
    }

    clearTmpReorder() {
        this.tmp_reorder = null;
    }

    applyTmpReorder(workspace) {
        if (!workspace.swaps) workspace.swaps = [];
        if (this.tmp_reorder) {
            workspace.swaps.push(['move', this.tmp_reorder.draggedId, this.tmp_reorder.targetId]);
        }
    }

    _moveElement(array, draggedId, targetId) {
        const getId = w => w.id !== undefined ? w.id : w.get_id();
        const draggedIdx = array.findIndex(w => getId(w) === draggedId);
        const targetIdx = array.findIndex(w => getId(w) === targetId);
        if (draggedIdx === -1 || targetIdx === -1 || draggedIdx === targetIdx) return;

        const [dragged] = array.splice(draggedIdx, 1);
        const newTargetIdx = array.findIndex(w => getId(w) === targetId);
        if (draggedIdx < targetIdx) {
            array.splice(newTargetIdx + 1, 0, dragged);
        } else {
            array.splice(newTargetIdx, 0, dragged);
        }
    }

    _swapElements(array, id1, id2) {
        const index1 = array.findIndex(w => w.id === id1);
        const index2 = array.findIndex(w => w.id === id2);
        
        if (index1 === -1 || index2 === -1)
            return;
        
        let tmp = array[index1];
        array[index1] = array[index2];
        array[index2] = tmp;
    }

    checkValidity(monitor, workspace, window, strict) {
        if (monitor !== null &&
            window.wm_class !== null &&
            window.get_compositor_private() &&
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
        let descriptors = [];
        for(let i = 0; i < meta_windows.length; i++) {
            let descriptor = this._createDescriptor(meta_windows[i], monitor, i, reference_window);
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
            return [arr, byAreaDesc, byAreaAsc, byWidthDesc, byHeightDesc];
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
        return compactness * 50 + centralization * 30 + sizeEfficiency * 20;
    }

    // Find optimal ordering via permutations (with stability bonus for current order)
    _findOptimalOrder(windows, workArea, tilingFn) {
        if (windows.length <= 1) return windows;

        const startTime = Date.now();
        const permutations = this._generatePermutations(windows);
        const currentIds = windows.map(w => w.id);

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

    // Generate a hash of window configuration for cache invalidation.
    // If windows haven't changed IDs/sizes, we can reuse the previous layout.
    _getLayoutHash(windows, work_area) {
        const sorted = [...windows].sort((a, b) => a.id - b.id);
        // Snap to 8px grid to reduce cache invalidation during resize
        const snap = v => Math.round(v / 8) * 8;
        const parts = sorted.map(w => `${w.id}:${snap(w.width)}x${snap(w.height)}`);
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

        // Try current order first; only permute on overflow
        const currentResult = tilingFn.call(this, windows, work_area, spacing);
        let result;

        if (!currentResult.overflow) {
            result = currentResult;
            Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, stable order`);
        } else if (this.isDragging && !isSimulation) {
            result = currentResult;
            Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, overflow (drag, no permute)`);
        } else {
            const optimalWindows = this._findOptimalOrder(windows, work_area, tilingFn);
            result = tilingFn.call(this, optimalWindows, work_area, spacing);
            Logger.log(`_tile: ${windows.length} windows, vertical=${useVerticalShelves}, reordered (overflow fallback)`);
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
            
            // Try to fit in existing column
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
        
        // Calculate horizontal centering
        const startX = (work_area.width - totalWidth) / 2 + work_area.x;
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
            
            let yPos = (work_area.height - totalColHeight) / 2 + work_area.y;
            
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
            const startX = (work_area.width - totalWidth) / 2 + work_area.x;
            
            const levels = [];
            let xPos = startX;
            
            for (const w of windows) {
                const level = new Level(work_area);
                level.windows.push(w);
                level.width = w.width;
                level.height = w.height;
                level.x = xPos;
                level.y = (work_area.height - w.height) / 2 + work_area.y;
                
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
        level.x = (work_area.width - maxWidth) / 2 + work_area.x;
        level.y = (work_area.height - totalHeight) / 2 + work_area.y;

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
    
    // Original horizontal shelves layout.
    _horizontalShelves(windows, work_area, spacing) {
        // For 1-2 windows, use simple centered row
        if (windows.length <= 2) {
            return this._simpleCenteredRow(windows, work_area, spacing);
        }
        
        // Calculate average dimensions
        let avgWidth = 0, avgHeight = 0;
        for (const w of windows) {
            avgWidth += w.width;
            avgHeight += w.height;
        }
        avgWidth /= windows.length;
        avgHeight /= windows.length;
        
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
            
            level.x = (work_area.width - level.width) / 2 + work_area.x;
            if (totalHeight + level.height + spacing > work_area.height && r > 0) {
                overflow = true;
            }
            
            if (r > 0) totalHeight += spacing;
            totalHeight += level.height;
            
            levels.push(level);
        }
        
        const y = (work_area.height - totalHeight) / 2 + work_area.y;
        
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
        level.x = (work_area.width - totalWidth) / 2 + work_area.x;
        
        const y = (work_area.height - maxHeight) / 2 + work_area.y;
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
        
        // Exclude the reference window only if explicitly requested (for overflow scenarios)
        if (window && excludeFromTiling && !this.isDragging) {
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

        let _windows = this.windowsToDescriptors(windowsForSwaps, current_monitor, window);
        
        this.applySwaps(workspace, _windows);
        this.working_windows = [];
        _windows.map(w => this.working_windows.push(w));
        this.applyTmp(_windows);
        
        let windows = [];
        for(let w of _windows)
            windows.push(this.getMask(w));

        let work_area = workspace.get_work_area_for_monitor(current_monitor);
        if(!work_area) return false;

        return {
            monitor: current_monitor,
            meta_windows: meta_windows,
            windows: windows,
            work_area: work_area
        }
    }

    _drawTile(tile_info, work_area, meta_windows, dryRun = false) {
        let levels = tile_info.levels;
        let _x = tile_info.x;
        let _y = tile_info.y;
        if(!tile_info.vertical) {
            let y = _y;
            for(let level of levels) {
                Logger.log(`Drawing horizontal level at y=${y}, width=${level.width}, height=${level.height}`);
                // Pass masks, isDragging AND drawingManager AND dryRun
                level.draw_horizontal(meta_windows, work_area, y, this.masks, this.isDragging, this._drawingManager, dryRun);
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = _x;
            for(let level of levels) {
                Logger.log(`Drawing vertical level at x=${x}, width=${level.width}, height=${level.height}`);
                level.draw_vertical(meta_windows, x, this.masks, this.isDragging, this._drawingManager, dryRun);
                x += level.width + constants.WINDOW_SPACING;
            }
        }
    }

    _animateTileLayout(workspace, tile_info, work_area, meta_windows, draggedWindow = null) {
        if (this._animationsManager) {
            const resizingWindowId = this._animationsManager.getResizingWindowId();
            
            const levels = tile_info.levels;
            const _y = tile_info.y;
            
            const windowLayouts = [];
            
            if (!tile_info.vertical) {
                let y = _y;
                for (let level of levels) {
                    let x = level.x;
                    for (let windowDesc of level.windows) {
                        let center_offset = (work_area.height / 2 + work_area.y) - (y + windowDesc.height / 2);
                        let y_offset = 0;
                        if (center_offset > 0)
                            y_offset = Math.min(center_offset, level.height - windowDesc.height);
                        
                        const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                        if (window) {
                            if (windowDesc.id === resizingWindowId) {
                                window.move_frame(false, x, y + y_offset);
                            } else {
                                windowLayouts.push({
                                    window: window,
                                    rect: {
                                        x: x,
                                        y: y + y_offset,
                                        width: windowDesc.width,
                                        height: windowDesc.height
                                    }
                                });
                            }
                        }
                        x += windowDesc.width + constants.WINDOW_SPACING;
                    }
                    y += level.height + constants.WINDOW_SPACING;
                }
            } else {
                // Vertical layout: each level is a column
                let x = tile_info.x;
                for (let level of levels) {
                    let y = level.y;
                    for (let windowDesc of level.windows) {
                        // Use targetX/targetY if set, otherwise calculate
                        const targetX = windowDesc.targetX !== undefined ? windowDesc.targetX : x;
                        const targetY = windowDesc.targetY !== undefined ? windowDesc.targetY : y;
                        
                        const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                        if (window) {
                            if (windowDesc.id === resizingWindowId) {
                                window.move_frame(false, targetX, targetY);
                            } else {
                                windowLayouts.push({
                                    window: window,
                                    rect: {
                                        x: targetX,
                                        y: targetY,
                                        width: windowDesc.width,
                                        height: windowDesc.height
                                    }
                                });
                            }
                        }
                        y += windowDesc.height + constants.WINDOW_SPACING;
                    }
                    x += level.width + constants.WINDOW_SPACING;
                }
            }
            
            this._animationsManager.animateReTiling(windowLayouts, draggedWindow);
        }

        // Release workspace lock after signals from move_resize have likely fired.
        // We use a safe delay matching the animation duration.
        if (this._extension && this._extension.windowHandler) {
            if (this._extension._timeoutRegistry) {
                this._extension._timeoutRegistry.add(constants.ANIMATION_DURATION_MS + 100, () => {
                    this._extension.windowHandler.unlockWorkspace(workspace);
                }, 'unlockWorkspace');
            } else {
                // No registry — unlock immediately (extension likely disabling)
                this._extension.windowHandler.unlockWorkspace(workspace);
            }
        }

        return true;
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
                        // No registry — unlock immediately (extension likely disabling)
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
        
        let working_info = this._getWorkingInfo(workspace, reference_meta_window, _monitor, excludeFromTiling);
        if(!working_info) {
            return { overflow: false, layout: null };
        }
        let meta_windows = working_info.meta_windows;
        let windows = working_info.windows;
        let work_area = working_info.work_area;
        let monitor = working_info.monitor;

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
                    return { overflow: false, layout: null };
                }
            }
        }
        
        // GLOBAL: Filter out maximized/fullscreen windows (SACRED - never touch them)
        const isSacredWindow = (w) => {
            // Check flags only (Maximized or Fullscreen)
            return this._windowingManager.isMaximizedOrFullscreen(w);
        };
        
        const sacredWindows = meta_windows.filter(isSacredWindow);
        if (sacredWindows.length > 0) {
            Logger.log(`Excluding ${sacredWindows.length} SACRED windows: ${sacredWindows.map(w => w.get_id()).join(', ')}`);
            meta_windows = meta_windows.filter(w => !isSacredWindow(w));
            windows = windows.filter((_, idx) => !isSacredWindow(working_info.meta_windows[idx]));
        }
        
        // If no windows left to tile, return early
        if (meta_windows.length === 0) {
            Logger.log(`No windows left to tile after filtering sacred windows. Original count: ${working_info.meta_windows.length}`);
            return { overflow: false, layout: null };
        }
        
        const tileArea = this.isDragging && this.dragRemainingSpace ? this.dragRemainingSpace : work_area;
        
        let tile_info = this._tile(windows, tileArea, dryRun);
        let overflow = tile_info.overflow;
        
        if (workspace_windows.length <= 1) {
            overflow = false;
        } else {
            for(let window of workspace_windows)
                if(this._windowingManager.isMaximizedOrFullscreen(window))
                    overflow = true;
        }
        
        // DRY RUN: If dryRun flag is set, return overflow without moving anything
        if (dryRun) {
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
            const isNewlyAdded = addedTime && (Date.now() - addedTime) < 2000;
            
            if (!isNewlyAdded && !WindowState.get(reference_meta_window, 'forceOverflow') && !WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                Logger.log(`Skipping overflow for ${reference_meta_window.get_id()} - not a new window`);
            } else if (WindowState.get(reference_meta_window, 'isSmartResizing') || WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                Logger.log(`Skipping overflow for ${reference_meta_window.get_id()} - smart resize/sacred restore in progress`);
                
                // FORCE RESIZE ATTEMPT IF NEEDED
                // If it's a sacred return, we MUST try to fit it, even if it means squishing everyone.
                if (WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                     const workArea = this.getUsableWorkArea(workspace, monitor);
                     const existingWindows = windows.filter(w => w.id !== reference_meta_window.get_id()).map(w => w.window); // Need MetaWindows
                     // We need actual MetaWindows for tryFit, but 'windows' here are descriptors.
                     // Re-fetch real windows.
                     const realExisting = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                                          .filter(w => w.get_id() !== reference_meta_window.get_id() && !this._windowingManager.isExcluded(w));
                                          
                     // Only try resize if we haven't already (to avoid loops)
                     if (!WindowState.get(reference_meta_window, 'isSmartResizing')) {
                         Logger.log(`Triggering Smart Resize for returning sacred window`);
                         const resizeOk = this.tryFitWithResize(reference_meta_window, realExisting, workArea);
                         if (!resizeOk)
                             Logger.log(`Smart resize could not fit sacred window`);
                         return { overflow: !resizeOk, layout: null };
                     }
                }
            } else {
                let id = reference_meta_window.get_id();
                let _windows = windows;
                for(let i = 0; i < _windows.length; i++) {
                    if(meta_windows[_windows[i].index].get_id() === id) {
                        _windows.splice(i, 1);
                        break;
                    }
                }
                this._windowingManager.moveOversizedWindow(reference_meta_window).catch(e =>
                    Logger.error(`Overflow move failed for ref window: ${e}`));
                tile_info = this._tile(_windows, tileArea);
            }
        }
        
        Logger.log(`Drawing tiles - isDragging: ${this.isDragging}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`);
        
        // ANIMATIONS
        let animationsHandledPositioning = false;
        if (!this.isDragging && tile_info && tile_info.levels && tile_info.levels.length > 0) {
            let draggedWindow = reference_meta_window;
            
            // Allow animation for windows returning from excluded state
            if (reference_meta_window && WindowState.get(reference_meta_window, 'justReturnedFromExclusion')) {
                Logger.log(`Allowing animation for returning excluded window ${reference_meta_window.get_id()}`);
                WindowState.remove(reference_meta_window, 'justReturnedFromExclusion');
            }
            
            animationsHandledPositioning = this._animateTileLayout(workspace, tile_info, tileArea, meta_windows, draggedWindow);
        }
        
        if (!animationsHandledPositioning) {
            // Only call drawTile if animations didn't handle positioning
            Logger.log(`Animations did not handle positioning, calling drawTile`);
            this._drawTile(tile_info, tileArea, meta_windows);
        } else {
            Logger.log(`Animations handled positioning, skipping drawTile`);
        }
        
        const result = { overflow, layout: this._cachedTileResult?.windows || null };
        this.emit('mosaic-changed', workspace);
        
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
        const currentWindows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
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
        
        let windows = working_info.windows.filter(w => 
            !edgeTiledIds.includes(w.id)
        );
        
        // Use pending async sizes over stale frame rects
        const workspaceWindows = workspace.list_windows();

        for (const w of windows) {
            const realWindow = workspaceWindows.find(win => win.get_id() === w.id);
            if (realWindow) {
                const restoredSize = WindowState.get(realWindow, 'targetRestoredSize');
                const smartSize = WindowState.get(realWindow, 'targetSmartResizeSize');

                if (restoredSize) {
                    w.width = restoredSize.width;
                    w.height = restoredSize.height;
                } else if (smartSize) {
                    w.width = smartSize.width;
                    w.height = smartSize.height;
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
                    // Use actual frame dimensions — no hardcoded fallback
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
            Logger.log(`canFitWindow: Window already in workspace - checking current layout`);
            // Update descriptor size to match reality or override
            const existingDescriptor = windows.find(w => w.id === newWindowId);
            if (existingDescriptor) {
                 if (overrideSize) {
                     existingDescriptor.width = overrideSize.width;
                     existingDescriptor.height = overrideSize.height;
                 } else {
                     // Ensure we use the best available size info
                     const preferred = WindowState.get(window, 'preferredSize');
                     const isMaximized = window.is_maximized();
                     if (preferred && !window.is_fullscreen() && !isMaximized) {
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

        let size = null;

        // Get frame size (window is not sacred here)
        const frame = window.get_frame_rect();
        size = { width: frame.width, height: frame.height };

        // Defense-in-depth: reject monitor-sized dimensions during transitions
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (workspace && monitor !== null && monitor !== undefined) {
            const workArea = workspace.get_work_area_for_monitor(monitor);
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

    tryRestoreWindowSizes(windows, workArea, freedWidth, freedHeight, workspace, monitor) {
        
        // Find windows that were shrunk (current size < preferred size)
        const shrunkWindows = [];
        for (const window of windows) {
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
            Logger.log(`tryRestoreWindowSizes: No shrunk windows to restore (0/3 windows had deficits > 2px)`);
            return false;
        }
        
        Logger.log(`tryRestoreWindowSizes: Found ${shrunkWindows.length} shrunk windows`);
        
        // Determine orientation (use width for landscape, height for portrait)
        const isLandscape = workArea.width > workArea.height;
        
        // Check if we have valid freed dimensions, otherwise calculate them
        if (freedWidth === null || freedWidth === undefined || isNaN(freedWidth)) {
            Logger.log(`tryRestoreWindowSizes: Calculating available space from work area...`);
            
            // Calculate currently used space by remaining windows (at their current sizes)
            let usedWidth = 0;
            let usedHeight = 0;
            
            if (windows.length > 0) {
                 for (const w of windows) {
                     const f = w.get_frame_rect();
                     // In Mosaic, typically windows are side-by-side or stacked.
                     // A simple bbox approach is a good proxy for "available incremental space"
                     usedWidth += f.width;
                     usedHeight += f.height;
                 }
            }
            
            // Use simulation to determine fit
            freedWidth = workArea.width; 
            freedHeight = workArea.height;
        }

        // Calculate total deficits
        const totalWidthDeficit = shrunkWindows.reduce((sum, w) => sum + w.widthDeficit, 0);
        const totalHeightDeficit = shrunkWindows.reduce((sum, w) => sum + w.heightDeficit, 0);
        
        Logger.log(`tryRestoreWindowSizes: Total deficits: W=${totalWidthDeficit}px, H=${totalHeightDeficit}px`);

        if (totalWidthDeficit <= 0 && totalHeightDeficit <= 0) {
            Logger.log(`tryRestoreWindowSizes: No deficit to fill`);
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
                    WindowState.set(w, 'isReverseSmartResizing', true);
                    
                    // Direct resize without animation for now to ensure stability
                    w.move_resize_frame(false, w.get_frame_rect().x, w.get_frame_rect().y, sim.width, sim.height);
                    
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
             Logger.log(`tryRestoreWindowSizes: Restoration would cause overflow even at 10% - waiting`);
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
        return workspace.get_work_area_for_monitor(monitor);
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
        let working_info = this._getWorkingInfo(workspace, null, monitorIndex, false);
        if(!working_info) return;

        let meta_windows = working_info.meta_windows;
        let windows = working_info.windows;
        let work_area = working_info.work_area;

        // Populate ComputedLayouts cache without moving windows (dryRun=true)
        // Must perform the tiling calculation first
        let tile_info = this._tile(windows, work_area);
        
        // Then run the draw phase in dryRun mode to just populate the cache
        this._drawTile(tile_info, work_area, meta_windows, true);
    }

    // Binary search for optimal scale factor that makes all windows fit
    tryFitWithResize(newWindow, windows, workArea) {
        if (this._isSmartResizingBlocked) {
            Logger.log(`[SMART RESIZE] tryFitWithResize BLOCKED by _isSmartResizingBlocked`);
            return false;
        }
        this._isSmartResizingBlocked = true;

        try {
            const allResizable = [];
            const allWindows = [];
            const windowData = new Map();

            // Collect data for all windows (deduplicated)
            for (const w of [...windows, newWindow]) {
                if (allWindows.some(aw => aw.get_id() === w.get_id())) continue;

                // Skip uninitialized windows — unreliable geometry corrupts binary search
                if (w.get_id() !== newWindow.get_id()
                    && !WindowState.get(w, 'preferredSize')
                    && !WindowState.get(w, 'openingSize')
                    && !WindowState.get(w, 'isConstrainedByMosaic')) {
                    Logger.log(`[SMART RESIZE] Skipping uninitialized window ${w.get_id()}`);
                    continue;
                }

                allWindows.push(w);

                const current = this.getEffectiveWindowSize(w);
                const min = this.getWindowMinimumSize(w);
                const isResizable = w.allows_resize && w.allows_resize();

                windowData.set(w.get_id(), { window: w, current, min, isResizable });
                if (isResizable) allResizable.push(w);
            }

            if (allResizable.length === 0) return false;

            Logger.log(`[SMART RESIZE] tryFitWithResize: ${allWindows.length} windows (${allResizable.length} resizable), workArea: ${workArea.width}×${workArea.height}`);
            for (const [id, d] of windowData) {
                Logger.log(`[SMART RESIZE]   ${id}: current=${d.current.width}×${d.current.height}, min=${d.min.width}×${d.min.height}, resizable=${d.isResizable}`);
            }

            // Interpolate between min and current sizes at factor t (1=current, 0=min)
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

            // Step 1: Natural fit check (current sizes)
            if (!this._tile(buildSimulated(1.0), workArea, true).overflow) {
                Logger.log(`[SMART RESIZE] Natural fit — no resize needed`);
                return true;
            }

            // Step 2: Minimum fit check — if doesn't fit at minimums, overflow is inevitable
            if (this._tile(buildSimulated(0.0), workArea, true).overflow) {
                Logger.log(`[SMART RESIZE] Overflow inevitable — even at minimums, windows don't fit`);
                return false;
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

            // Step 4: Apply final sizes (factor lo = largest that fits)
            const finalSizes = buildSimulated(lo);
            for (const sim of finalSizes) {
                const d = windowData.get(sim.id);
                if (!d.isResizable) continue;
                if (sim.width >= d.current.width && sim.height >= d.current.height) continue;

                const w = d.window;
                const frame = w.get_frame_rect();

                if (!WindowState.has(w, 'preferredSize'))
                    WindowState.set(w, 'preferredSize', { width: d.current.width, height: d.current.height });
                WindowState.set(w, 'originalSize', { width: d.current.width, height: d.current.height });
                WindowState.set(w, 'isConstrainedByMosaic', true);
                WindowState.set(w, 'targetSmartResizeSize', { width: sim.width, height: sim.height });

                w.move_resize_frame(false, frame.x, frame.y, sim.width, sim.height);
                Logger.log(`[SMART RESIZE] ${sim.id}: ${d.current.width}×${d.current.height} → ${sim.width}×${sim.height}`);
            }

            return true;
        } finally {
            this._isSmartResizingBlocked = false;
        }
    }

    destroy() {
        this.destroyMasks();
        this._isSmartResizingBlocked = false;
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
    }
});

class WindowDescriptor {
    constructor(meta_window, index) {
        let frame = meta_window.get_frame_rect();

        this.index = index;
        this.x = frame.x;
        this.y = frame.y;
        this.metaWindow = meta_window;
        
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
            // Use actual frame dimensions — no hardcoded fallback
            this.width = frame.width > 0 ? frame.width : 1;
            this.height = frame.height > 0 ? frame.height : 1;
        }
        
        this.id = meta_window.get_id();
    }
    
    draw(meta_windows, x, y, masks, isDragging, drawingManager, dryRun = false) {
    const window = meta_windows.find(w => w.get_id() === this.id);
    if (window) {
        // If dry run, just return - the layout cache was already updated in the caller
        if (dryRun) return;

        const isMask = masks[this.id];
        
        if (isDragging) {
            if (isMask) {
                // This is the dragged window - draw preview at its target position
                if (drawingManager) {
                    drawingManager.rect(x, y, this.width, this.height);
                }
            } else {
                // This is NOT the dragged window - reposition it
                const currentRect = window.get_frame_rect();
                const positionChanged = Math.abs(currentRect.x - x) > 5 || Math.abs(currentRect.y - y) > 5;
                const sizeChanged = Math.abs(currentRect.width - this.width) > 5 || Math.abs(currentRect.height - this.height) > 5;
                
                Logger.log(`draw (drag): id=${this.id}, target=(${x},${y}), current=(${currentRect.x},${currentRect.y}), posChanged=${positionChanged}`);
                
                if (positionChanged || sizeChanged) {
                    WindowState.set(window, 'isConstrainedByMosaic', true);
                    window.move_resize_frame(false, x, y, this.width, this.height);
                    const windowActor = window.get_compositor_private();
                    if (windowActor) {
                        const translateX = currentRect.x - x;
                        const translateY = currentRect.y - y;
                        windowActor.set_translation(translateX, translateY, 0);
                        windowActor.ease({
                            translation_x: 0,
                            translation_y: 0,
                            opacity: 255,
                            duration: constants.ANIMATION_DURATION_MS,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD
                        });
                    }
                }
            }
        } else {
            WindowState.set(window, 'isConstrainedByMosaic', true);
            window.move_resize_frame(false, x, y, this.width, this.height);
        }
    } else {
        Logger.warn(`Could not find window with ID ${this.id} for drawing`);
    }
}
}

function Level(work_area) {
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.windows = [];
    this.work_area = work_area;
}

Level.prototype.draw_horizontal = function(meta_windows, work_area, y, masks, isDragging, drawingManager, dryRun = false) {
    let x = this.x;
    for(let window of this.windows) {
        let center_offset = (work_area.height / 2 + work_area.y) - (y + window.height / 2);
        let y_offset = 0;
        if(center_offset > 0)
            y_offset = Math.min(center_offset, this.height - window.height);
            
        // Use targetX/targetY if set (for center-gravity alignment), otherwise use calculated position
        const drawX = window.targetX !== undefined ? window.targetX : x;
        const drawY = window.targetY !== undefined ? window.targetY : y + y_offset;
        
        if (!dryRun)
            Logger.log(`Window ${window.id} target: ${drawX},${drawY} (${window.width}x${window.height})`);
        
        if (window.metaWindow) {
            ComputedLayouts.set(window.metaWindow, { x: drawX, y: drawY, width: window.width, height: window.height });
        }

        window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
        x += window.width + constants.WINDOW_SPACING;
    }
}

Level.prototype.draw_vertical = function(meta_windows, x, masks, isDragging, drawingManager, dryRun = false) {
    let y = this.y;
    for(let window of this.windows) {
        // Use targetX/targetY if set (for center-gravity alignment), otherwise use calculated position
        const drawX = window.targetX !== undefined ? window.targetX : x;
        const drawY = window.targetY !== undefined ? window.targetY : y;
        
        if (!dryRun)
            Logger.log(`Window ${window.id} target: ${drawX},${drawY} (${window.width}x${window.height})`);
        
        if (window.metaWindow) {
            ComputedLayouts.set(window.metaWindow, { x: drawX, y: drawY, width: window.width, height: window.height });
        }
        
        window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
        y += window.height + constants.WINDOW_SPACING;
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
