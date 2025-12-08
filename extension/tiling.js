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
        if(this.tmp_swap.length !== 0) {
            // Replace instead of accumulate to avoid conflicting swaps
            // Find and remove any existing swap involving these windows
            const [id1, id2] = this.tmp_swap;
            workspace.swaps = workspace.swaps.filter(s => 
                !(s[0] === id1 || s[1] === id1 || s[0] === id2 || s[1] === id2)
            );
            workspace.swaps.push(this.tmp_swap);
        }
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
     * Tile windows with dynamic shelf orientation.
     * If a window's height exceeds 50% of workspace, use vertical shelves (columns).
     * Otherwise, use horizontal shelves (rows).
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
        
        // Check if any window is taller than 50% of workspace height
        let maxHeight = 0;
        for (const w of windows) {
            maxHeight = Math.max(maxHeight, w.height);
        }
        
        const useVerticalShelves = maxHeight > work_area.height * 0.65;
        
        Logger.log(`[MOSAIC WM] _tile: ${windows.length} windows, workArea=${work_area.width}x${work_area.height}, maxWinH=${maxHeight}, threshold=${Math.round(work_area.height * 0.65)}, useVertical=${useVerticalShelves}`);
        
        if (useVerticalShelves) {
            return this._verticalShelves(windows, work_area, spacing);
        } else {
            return this._horizontalShelves(windows, work_area, spacing);
        }
    }
    
    /**
     * Vertical shelves layout - windows stack in columns side by side.
     */
    _verticalShelves(windows, work_area, spacing) {
        // For 1-2 windows, use simple centered column
        if (windows.length <= 2) {
            return this._simpleCenteredColumn(windows, work_area, spacing);
        }
        
        // BIN PACKING without height sorting - preserves array order for swaps
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
            // Left columns → align RIGHT (towards center)
            // Right columns → align LEFT (towards center)
            // Center column → centered
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
        
        Logger.log(`[MOSAIC WM] verticalShelves: ${windows.length} windows -> ${levels.length} cols, totalW=${totalWidth}, workH=${work_area.height}`);
        
        return {
            x: startX,
            y: work_area.y,
            overflow: overflow,
            vertical: true,
            levels: levels,
            windows: windows
        };
    }
    
    /**
     * Helper for 1-2 windows in vertical mode - simple centered column.
     */
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
    
    /**
     * Original horizontal shelves layout - windows arrange in rows.
     */
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
     * Helper for 1-2 windows, simple centered row.
     */
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

        return {
            x: work_area.x,
            y: y,
            overflow: totalWidth > work_area.width || maxHeight > work_area.height,
            vertical: false,
            levels: [level],
            windows: windows
        };
    }
    
    /**
     * Calculate optimal grid dimensions for balanced layout.
     * Uses actual window sizes to check for overflow (ROBUST).
     */
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
                
                if (currentRowWidth > work_area.width) overflow = true;
                maxRowWidth = Math.max(maxRowWidth, currentRowWidth);
                
                totalHeight += currentRowHeight + (r > 0 ? spacing : 0);
            }
            
            if (totalHeight > work_area.height) overflow = true;
            
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
                    
                    Logger.log(`[MOSAIC WM] draw (drag): id=${this.id}, target=(${x},${y}), current=(${currentRect.x},${currentRect.y}), posChanged=${positionChanged}`);
                    
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
        // Use targetX/targetY if set (for center-gravity alignment), otherwise use calculated position
        const drawX = window.targetX !== undefined ? window.targetX : x;
        const drawY = window.targetY !== undefined ? window.targetY : y;
        window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager);
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
