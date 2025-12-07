// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Core mosaic tiling algorithm and layout management

import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import * as constants from './constants.js';
import { TileZone } from './edgeTiling.js';

export class TilingManager {
    constructor() {
        // Module-level state converted to class properties
        this.masks = [];
        this.working_windows = [];
        this.tmp_swap = [];
        this.isDragging = false;
        this.dragRemainingSpace = null;
        
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
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

    createMask(meta_window) {
        this.masks[meta_window.get_id()] = true;
    }

    destroyMasks() {
        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }
        this.masks = [];
    }

    getMask(window) {
        if(this.masks[window.id])
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
    }

    setDragRemainingSpace(space) {
        this.dragRemainingSpace = space;
    }

    clearDragRemainingSpace() {
        this.dragRemainingSpace = null;
    }

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
        if(workspace.swaps)
            for(let swap of workspace.swaps)
                this._swapElements(array, swap[0], swap[1]);
    }

    applyTmp(array) {
        if(this.tmp_swap.length !== 0) {
            this._swapElements(array, this.tmp_swap[0], this.tmp_swap[1]);
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

    _tile(windows, work_area) {
        let vertical = false;
        
        let totalRequiredArea = 0;
        for(let window of windows) {
            totalRequiredArea += (window.width * window.height);
        }
        
        const availableArea = work_area.width * work_area.height;
        
        let levels = [new Level(work_area)];
        let total_width = 0;
        let total_height = 0;
        let x, y;

        let overflow = false;

        if(!vertical) {
            let window_widths = 0;
            windows.map(w => window_widths += w.width + constants.WINDOW_SPACING)
            window_widths -= constants.WINDOW_SPACING;

            let n_levels = Math.round(window_widths / work_area.width) + 1;
            let level = levels[0];
            let level_index = 0;
            
            for(let window of windows) {
                if(level.width + constants.WINDOW_SPACING + window.width > work_area.width) {
                    total_width = Math.max(level.width, total_width);
                    total_height += level.height + constants.WINDOW_SPACING;
                    level.x = (work_area.width - level.width) / 2 + work_area.x;
                    levels.push(new Level(work_area));
                    level_index++;
                    level = levels[level_index];
                }
                
                if( Math.max(window.height, level.height) + total_height > work_area.height || 
                    window.width + level.width > work_area.width){
                    overflow = true;
                    continue;
                }
                level.windows.push(window);
                if(level.width !== 0)
                    level.width += constants.WINDOW_SPACING;
                level.width += window.width;
                level.height = Math.max(window.height, level.height);
            }
            total_width = Math.max(level.width, total_width);
            total_height += level.height;
            level.x = (work_area.width - level.width) / 2 + work_area.x;

            y = (work_area.height - total_height) / 2 + work_area.y;
        } else {
            // Vertical - skipping implementation details for brevity, assume similar structure
            // In original code it was partially implemented.
            // Copied from original for completeness:
            let window_heights = 0;
            windows.map(w => window_heights += w.height + constants.WINDOW_SPACING);
            window_heights -= constants.WINDOW_SPACING;
            
            let level = levels[0];
            let level_index = 0;
            let avg_level_height = window_heights / (Math.floor(window_heights / work_area.height) + 1);
            
            for(let window of windows) {
                if(level.width > avg_level_height) { // Original logic
                     total_width = Math.max(level.width, total_width);
                     total_height += level.height + constants.WINDOW_SPACING;
                     level.x = (work_area.width - level.width) / 2 + work_area.x;
                     levels.push(new Level(work_area));
                     level_index++;
                     level = levels[level_index];
                }
                level.windows.push(window);
                if(level.width !== 0) level.width += constants.WINDOW_SPACING;
                level.width += window.width;
                level.height = Math.max(window.height, level.height);
            }
            total_width = Math.max(level.width, total_width);
            total_height += level.height;
            level.x = (work_area.width - level.width) / 2 + work_area.x;
            y = (work_area.height - total_height) / 2 + work_area.y;
        }
        
        let all_windows = [];
        for (let level of levels) {
            all_windows = all_windows.concat(level.windows);
        }
        
        return {
            x: x,
            y: y,
            overflow: overflow,
            vertical: vertical,
            levels: levels,
            windows: all_windows
        };
    }

    _getWorkingInfo(workspace, window, _monitor, excludeFromTiling = false) {
        let current_monitor = _monitor;
        if(current_monitor === undefined)
            current_monitor = window.get_monitor();

        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, current_monitor);
        
        // Exclude the reference window only if explicitly requested (for overflow scenarios)
        if (window && excludeFromTiling && !this.isDragging) {
            const windowId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== windowId);
            Logger.log(`[MOSAIC WM] Excluding overflow window ${windowId} from mosaic calculation`);
        }
        
        if (this.isDragging && this.dragRemainingSpace && window) {
            const draggedId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== draggedId);
            Logger.log(`[MOSAIC WM] Excluding dragged window ${draggedId} from mosaic calculation`);
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

        Logger.log(`[MOSAIC WM] Creating descriptors for ${windowsForSwaps.length} windows`);
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

    _drawTile(tile_info, work_area, meta_windows) {
        Logger.log(`[MOSAIC WM] drawTile called `);
        
        let levels = tile_info.levels;
        let _x = tile_info.x;
        let _y = tile_info.y;
        if(!tile_info.vertical) {
            let y = _y;
            for(let level of levels) {
                // Pass masks, isDragging AND drawingManager
                level.draw_horizontal(meta_windows, work_area, y, this.masks, this.isDragging, this._drawingManager);
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = _x;
            for(let level of levels) {
                level.draw_vertical(meta_windows, x, this.masks, this.isDragging, this._drawingManager);
                x += level.width + constants.WINDOW_SPACING;
            }
        }
    }

    _animateTileLayout(tile_info, work_area, meta_windows, draggedWindow = null) {
        Logger.log(`[MOSAIC WM] animateTileLayout called: ${meta_windows.length} windows`);
        
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
                                // If this is the window being resized, move it immediately without animation
                                // The animation manager will handle its animation separately.
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
            }
            
            this._animationsManager.animateReTiling(windowLayouts, draggedWindow);
        }
        return true;
    }

    tileWorkspaceWindows(workspace, reference_meta_window, _monitor, keep_oversized_windows, excludeFromTiling = false) {
        let working_info = this._getWorkingInfo(workspace, reference_meta_window, _monitor, excludeFromTiling);
        if(!working_info) return;
        let meta_windows = working_info.meta_windows;
        let windows = working_info.windows;
        let work_area = working_info.work_area;
        let monitor = working_info.monitor;

        const workspace_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            Logger.log(`[MOSAIC WM] tileWorkspaceWindows: Found ${edgeTiledWindows.length} edge-tiled windows`);
        }
        
        if (edgeTiledWindows.length > 0) {
            Logger.log(`[MOSAIC WM] Found ${edgeTiledWindows.length} edge-tiled window(s)`);
            
            // Check if we have 2 half-tiles (left + right = fully occupied)
            const zones = edgeTiledWindows.map(w => w.zone);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
            const hasRightQuarters = zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
            
            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                Logger.log('[MOSAIC WM] Both sides edge-tiled - workspace fully occupied');
                
                const nonEdgeTiledMeta = this._edgeTilingManager.getNonEdgeTiledWindows(workspace, monitor);
                
                // Move all non-edge-tiled windows to new workspace
                for (const window of nonEdgeTiledMeta) {
                    if (!this._windowingManager.isExcluded(window)) {
                        Logger.log('[MOSAIC WM] Moving non-edge-tiled window to new workspace');
                        this._windowingManager.moveOversizedWindow(window);
                    }
                }
                
                return; // Don't tile, edge-tiled windows stay in place
            }
            
            // Single tile or quarter tiles - calculate remaining space
            const remainingSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
            const nonEdgeTiledCount = workspace_windows.filter(w => !edgeTiledIds.includes(w.get_id())).length;
            if (this.dragRemainingSpace) {
             Logger.log(`[MOSAIC WM] Reusing drag remaining space: x=${this.dragRemainingSpace.x}, w=${this.dragRemainingSpace.width}`);
             // If we have a cached remaining space from drag, use it
             work_area = this.dragRemainingSpace;
            } else {
                Logger.log(`[MOSAIC WM] Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
                Logger.log(`[MOSAIC WM] Total workspace windows: ${workspace_windows.length}, Non-edge-tiled: ${nonEdgeTiledCount}`);
                
                // Filter out edge-tiled windows from tiling
                meta_windows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
                Logger.log(`[MOSAIC WM] After filtering edge-tiled: ${meta_windows.length} windows to tile`);
                
                // Set work_area to remaining space for tiling calculations
                work_area = remainingSpace;
                
                // If no non-edge-tiled windows, nothing to tile
                if (meta_windows.length === 0) {
                    Logger.log('[MOSAIC WM] No non-edge-tiled windows to tile');
                    return;
                }
            }
        }
        
        const tileArea = this.isDragging && this.dragRemainingSpace ? this.dragRemainingSpace : work_area;
        
        let tile_info = this._tile(windows, tileArea);
        let overflow = tile_info.overflow;
        
        if (workspace_windows.length <= 1) {
            overflow = false;
        } else {
            for(let window of workspace_windows)
                if(this._windowingManager.isMaximizedOrFullscreen(window))
                    overflow = true;
        }

        if(overflow && !keep_oversized_windows && reference_meta_window) {
            let id = reference_meta_window.get_id();
            let _windows = windows;
            for(let i = 0; i < _windows.length; i++) {
                if(meta_windows[_windows[i].index].get_id() === id) {
                    _windows.splice(i, 1);
                    break;
                }
            }
            this._windowingManager.moveOversizedWindow(reference_meta_window);
            tile_info = this._tile(_windows, tileArea);
        }
        
        Logger.log(`[MOSAIC WM] Drawing tiles - isDragging: ${this.isDragging}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`);
        
        // ANIMATIONS
        let animationsHandledPositioning = false;
        if (!this.isDragging && tile_info && tile_info.levels && tile_info.levels.length > 0) {
            animationsHandledPositioning = this._animateTileLayout(tile_info, tileArea, meta_windows, reference_meta_window);
        }
        
        if (this.isDragging && windows.length === 0 && reference_meta_window) {
            const mask = this.getMask(reference_meta_window);
            if (mask) {
                Logger.log(`[MOSAIC WM] Drawing mask preview for dragged window (no other windows)`);
                const x = tileArea.x + tileArea.width / 2 - mask.width / 2;
                const y = tileArea.y + tileArea.height / 2 - mask.height / 2;
                // Visualize tiles if drawing manager is available
                if (this._drawingManager) {
                    this._drawingManager.removeBoxes();
                    this.working_windows.forEach(w => {
                        this._drawingManager.rect(w.x, w.y, w.width, w.height);
                    });
                }
            }
        } else if (!animationsHandledPositioning) {
            // Only call drawTile if animations didn't handle positioning
            Logger.log(`[MOSAIC WM] Animations did not handle positioning, calling drawTile`);
            this._drawTile(tile_info, tileArea, meta_windows);
        } else {
            Logger.log(`[MOSAIC WM] Animations handled positioning, skipping drawTile`);
        }
        
        return overflow;
    }

    canFitWindow(window, workspace, monitor) {
        Logger.log(`[MOSAIC WM] canFitWindow: Checking if window can fit in workspace ${workspace.index()}`);
        
        if (window.is_fullscreen()) {
            Logger.log('[MOSAIC WM] canFitWindow: Window is fullscreen - always fits (no overflow)');
            return true;
        }
        
        const working_info = this._getWorkingInfo(workspace, window, monitor);
        if (!working_info) {
            Logger.log('[MOSAIC WM] canFitWindow: No working info - cannot fit');
            return false;
        }

        for (const existing_window of working_info.meta_windows) {
            if(this._windowingManager.isMaximizedOrFullscreen(existing_window)) {
                Logger.log('[MOSAIC WM] canFitWindow: Workspace has maximized window - cannot fit');
                return false;
            }
        }

        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }
        
        let availableSpace = working_info.work_area;
        
        Logger.log(`[MOSAIC WM] canFitWindow: Found ${edgeTiledWindows.length} edge-tiled windows`);
        
        if (edgeTiledWindows.length > 0) {
            const otherEdgeTiles = edgeTiledWindows.filter(w => w.window.get_id() !== window.get_id());
            const zones = otherEdgeTiles.map(w => w.zone);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
            const hasRightQuarters = zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
            
            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                Logger.log('[MOSAIC WM] canFitWindow: Workspace fully occupied by edge tiles - cannot fit');
                return false;
            }
            
            availableSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            Logger.log(`[MOSAIC WM] canFitWindow: Using remaining space after snap: ${availableSpace.width}x${availableSpace.height}`);
        }

        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        
        let windows = working_info.windows.filter(w => 
            !edgeTiledIds.includes(w.id)
        );
        
        Logger.log(`[MOSAIC WM] canFitWindow: Current non-edge-tiled windows: ${windows.length}`);
        
        const newWindowId = window.get_id();
        const windowAlreadyInWorkspace = windows.some(w => w.id === newWindowId);
        
        if (!windowAlreadyInWorkspace) {
            Logger.log('[MOSAIC WM] canFitWindow: Window not in workspace yet - adding test window');
            
            const estimatedWidth = 200;
            const estimatedHeight = 200;
            
            const newWindowDescriptor = new WindowDescriptor(window, windows.length);
            newWindowDescriptor.width = estimatedWidth;
            newWindowDescriptor.height = estimatedHeight;
            
            windows.push(newWindowDescriptor);
        } else {
            Logger.log('[MOSAIC WM] canFitWindow: Window already in workspace - checking current layout');
        }

        const tile_result = this._tile(windows, availableSpace);
        
        Logger.log(`[MOSAIC WM] canFitWindow: Tile result overflow: ${tile_result.overflow}`);
        
        const fits = !tile_result.overflow;
        
        if (fits) {
            Logger.log('[MOSAIC WM] canFitWindow: Window fits!');
        } else {
            Logger.log('[MOSAIC WM] canFitWindow: Window does NOT fit (overflow)');
        }
        
        return fits;
    }

}

class WindowDescriptor {
    constructor(meta_window, index) {
        let frame = meta_window.get_frame_rect();

        this.index = index;
        this.x = frame.x;
        this.y = frame.y;
        this.width = frame.width;
        this.height = frame.height;
        this.id = meta_window.get_id();
    }
    
    draw(meta_windows, x, y, masks, isDragging, drawingManager) {
        const window = meta_windows.find(w => w.get_id() === this.id);
        if (window) {
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
                    
                    if (positionChanged || sizeChanged) {
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
                window.move_frame(false, x, y);
            }
        } else {
            Logger.warn(`[MOSAIC WM] Could not find window with ID ${this.id} for drawing`);
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

Level.prototype.draw_horizontal = function(meta_windows, work_area, y, masks, isDragging, drawingManager) {
    let x = this.x;
    for(let window of this.windows) {
        let center_offset = (work_area.height / 2 + work_area.y) - (y + window.height / 2);
        let y_offset = 0;
        if(center_offset > 0)
            y_offset = Math.min(center_offset, this.height - window.height);

        window.draw(meta_windows, x, y + y_offset, masks, isDragging, drawingManager);
        x += window.width + constants.WINDOW_SPACING;
    }
}

Level.prototype.draw_vertical = function(meta_windows, x, masks, isDragging, drawingManager) {
    let y = this.y;
    for(let window of this.windows) {
        window.draw(meta_windows, x, y, masks, isDragging, drawingManager);
        y += window.height + constants.WINDOW_SPACING;
    }
}

class Mask {
    constructor(window) {
        this.x = window.x;
        this.y = window.y;
        this.width = window.width;
        this.height = window.height;
    }
    draw(_, x, y, _masks, _isDragging, drawingManager) {
        Logger.log(`[MOSAIC WM] Mask.draw called: x=${x}, y=${y}, w=${this.width}, h=${this.height}`);
        if (drawingManager) {
            drawingManager.removeBoxes();
            drawingManager.rect(x, y, this.width, this.height);
        }
    }
}
