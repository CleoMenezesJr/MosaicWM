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

    /**
     * Tile windows with balanced radial distribution.
     * Creates homogeneous layout that grows from center outward.
     */
    _tile(windows, work_area) {
        if (windows.length === 0) {
            return {
                x: work_area.x,
                y: work_area.y,
                overflow: false,
                vertical: false,
                levels: [],
                windows: []
            };
        }
        
        const spacing = constants.WINDOW_SPACING;
        
        let avgWidth = 0, avgHeight = 0;
        for (const w of windows) {
            avgWidth += w.width;
            avgHeight += w.height;
        }
        avgWidth /= windows.length;
        avgHeight /= windows.length;
        
        // Calculate optimal grid dimensions
        const { rows: numRows, windowsPerRow } = this._calculateOptimalGrid(
            windows.length,
            avgWidth,
            avgHeight,
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
        
        return {
            x: work_area.x,
            y: y,
            overflow: overflow,
            vertical: false,
            levels: levels,
            windows: windows
        };
    }
    
    /**
     * Calculate optimal grid dimensions for balanced layout
     * Aims for a square-ish layout (aspect ratio close to 1:1)
     */
    _calculateOptimalGrid(windowCount, avgWidth, avgHeight, work_area) {
        if (windowCount <= 0) return { rows: 0, windowsPerRow: [] };
        if (windowCount === 1) return { rows: 1, windowsPerRow: [1] };
        if (windowCount === 2) return { rows: 1, windowsPerRow: [2] };
        
        const spacing = constants.WINDOW_SPACING;
        
        const maxPerRow = Math.floor((work_area.width + spacing) / (avgWidth + spacing));
        const workspaceAspect = work_area.width / work_area.height;
        
        let bestRows = 1;
        let bestScore = Infinity;
        
        for (let rows = 1; rows <= windowCount; rows++) {
            const cols = Math.ceil(windowCount / rows);
            
            if (cols > maxPerRow) continue;

            const layoutWidth = cols * avgWidth + (cols - 1) * spacing;
            const layoutHeight = rows * avgHeight + (rows - 1) * spacing;
            if (layoutWidth > work_area.width || layoutHeight > work_area.height) continue;
            
            const layoutAspect = layoutWidth / layoutHeight;
            const aspectDiff = Math.abs(layoutAspect - workspaceAspect);
            const emptySpaces = rows * cols - windowCount;
            const score = aspectDiff + emptySpaces * 0.3;
            
            if (score < bestScore) {
                bestScore = score;
                bestRows = rows;
            }
        }
        
        // Distribute windows symmetrically (extras go to center rows)
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
        
        // Exclude the reference window only if explicitly requested (for overflow scenarios)
        if (window && excludeFromTiling && !this.isDragging) {
            const windowId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== windowId);
        }
        
        if (this.isDragging && this.dragRemainingSpace && window) {
            const draggedId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== draggedId);
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

    _drawTile(tile_info, work_area, meta_windows) {
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
        
        // A single window should always fit - prevents infinite loop for large windows
        if (windows.length <= 1) {
            Logger.log('[MOSAIC WM] canFitWindow: Only 1 window - always fits');
            return true;
        }
        
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
