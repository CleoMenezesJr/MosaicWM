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
        
        // Track original window sizes for smart resize before overflow
        this._originalSizes = new Map();  // windowId -> { width, height } - size before current resize session
        
        // Track window opening sizes for reverse smart resize (restore on window close)
        this._openingSizes = new Map();   // windowId -> { width, height } - size when window first opened
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
    
    setExcludedWindow(window) {
        this._excludedWindow = window;
    }
    
    clearExcludedWindow() {
        this._excludedWindow = null;
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
        let maxWidth = 0;
        for (const w of windows) {
            maxHeight = Math.max(maxHeight, w.height);
            maxWidth = Math.max(maxWidth, w.width);
        }
        
        // Use vertical shelves (stacking windows one above another) when:
        // 1. Any window is taller than 65% of workspace height, OR
        // 2. Workspace is narrow (width < height) - e.g., edge tiling half-screen, OR
        // 3. Widest window exceeds available width (force vertical stacking)
        const isNarrowWorkspace = work_area.width < work_area.height;
        const windowTooWide = maxWidth > work_area.width * 0.9;
        const windowTooTall = maxHeight > work_area.height * 0.65;
        const useVerticalShelves = windowTooTall || isNarrowWorkspace || windowTooWide;
        
        Logger.log(`[MOSAIC WM] _tile: ${windows.length} windows, workArea=${work_area.width}x${work_area.height}, maxWinH=${maxHeight}, maxWinW=${maxWidth}, narrow=${isNarrowWorkspace}, tooWide=${windowTooWide}, useVertical=${useVerticalShelves}`);
        
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
        
        // CRITICAL: Filter out excluded windows (always on top, sticky, etc.) early
        // This prevents them from being counted in layout calculations
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
            Logger.log(`[MOSAIC WM] Edge tile zones detected: [${zones.join(', ')}]`);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
            const hasRightQuarters = zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
            
            Logger.log(`[MOSAIC WM] Zone check: leftFull=${hasLeftFull}, rightFull=${hasRightFull}, leftQuarters=${hasLeftQuarters}, rightQuarters=${hasRightQuarters}`);
            
            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                // Don't move windows during drag - just show preview
                if (this.isDragging) {
                    Logger.log('[MOSAIC WM] Both sides edge-tiled - deferring overflow until drag ends');
                    return; // Let preview show but don't move windows
                }
                
                Logger.log('[MOSAIC WM] Both sides edge-tiled - workspace fully occupied, moving mosaic windows');
                
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
                
                // Also filter out maximized/fullscreen windows (SACRED - never touch them)
                const beforeMaxFilter = meta_windows.length;
                meta_windows = meta_windows.filter(w => !this._windowingManager.isMaximizedOrFullscreen(w));
                if (meta_windows.length < beforeMaxFilter) {
                    Logger.log(`[MOSAIC WM] Filtered ${beforeMaxFilter - meta_windows.length} maximized/fullscreen (sacred) windows`);
                }
                
                // Set work_area to remaining space for tiling calculations
                work_area = remainingSpace;
                
                // If no non-edge-tiled windows, nothing to tile
                if (meta_windows.length === 0) {
                    Logger.log('[MOSAIC WM] No non-edge-tiled windows to tile');
                    return;
                }
            }
        }
        
        // GLOBAL: Filter out maximized/fullscreen windows (SACRED - never touch them)
        const isSacredWindow = (w) => {
            // Check flags only (Maximized or Fullscreen)
            return this._windowingManager.isMaximizedOrFullscreen(w);
        };
        
        const sacredCount = meta_windows.filter(isSacredWindow).length;
        if (sacredCount > 0) {
            Logger.log(`[MOSAIC WM] Excluding ${sacredCount} SACRED windows from tiling`);
            meta_windows = meta_windows.filter(w => !isSacredWindow(w));
            windows = windows.filter((_, idx) => !isSacredWindow(working_info.meta_windows[idx]));
        }
        
        // If no windows left to tile, return early
        if (meta_windows.length === 0) {
            Logger.log('[MOSAIC WM] No windows left to tile after filtering sacred windows');
            return;
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

        // Don't expel windows when edge-tiled windows exist (reduced space is intentional)
        // EXCEPTION: if reference_meta_window itself is NOT edge-tiled, allow overflow for it
        // The "both sides" case is handled above with explicit workspace move
        // Also don't expel during drag - wait for confirmation
        const hasEdgeTiledWindows = edgeTiledWindows && edgeTiledWindows.length > 0;
        const referenceIsEdgeTiled = reference_meta_window && 
            edgeTiledWindows?.some(s => s.window.get_id() === reference_meta_window.get_id());
        const canOverflow = !hasEdgeTiledWindows || !referenceIsEdgeTiled;
        
        if(overflow && !keep_oversized_windows && reference_meta_window && canOverflow && !this.isDragging) {
            // SAFETY: Only overflow windows that are genuinely new (added within last 2 seconds)
            // This prevents incorrectly expelling existing windows during resize retiling
            const isNewlyAdded = reference_meta_window._windowAddedTime && 
                (Date.now() - reference_meta_window._windowAddedTime) < 2000;
            
            if (!isNewlyAdded && !reference_meta_window._forceOverflow) {
                Logger.log(`[MOSAIC WM] Skipping overflow for ${reference_meta_window.get_id()} - not a new window`);
            } else if (reference_meta_window._isSmartResizing) {
                Logger.log(`[MOSAIC WM] Skipping overflow for ${reference_meta_window.get_id()} - smart resize in progress`);
            } else {
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
        }
        
        Logger.log(`[MOSAIC WM] Drawing tiles - isDragging: ${this.isDragging}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`);
        
        // ANIMATIONS
        let animationsHandledPositioning = false;
        if (!this.isDragging && tile_info && tile_info.levels && tile_info.levels.length > 0) {
            // Pass null as draggedWindow to ensure all windows (including the triggering one) are animated
            animationsHandledPositioning = this._animateTileLayout(tile_info, tileArea, meta_windows, null);
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
        
        // CRITICAL: Update dimensions of existing windows from reality!
        // We might have just resized them in tryFitWithResize, but the working_info cache
        // hasn't updated yet because size-changed signals might be blocked or pending.
        const workspaceWindows = workspace.list_windows();
        
        for (const w of windows) {
            const realWindow = workspaceWindows.find(win => win.get_id() === w.id);
            if (realWindow) {
                const realFrame = realWindow.get_frame_rect();
                w.width = realFrame.width;
                w.height = realFrame.height;
            }
        }
        
        Logger.log(`[MOSAIC WM] canFitWindow: Current non-edge-tiled windows: ${windows.length}`);
        
        const newWindowId = window.get_id();
        const windowAlreadyInWorkspace = windows.some(w => w.id === newWindowId);
        
        if (!windowAlreadyInWorkspace) {
            // Use real window dimensions instead of estimate
            const frame = window.get_frame_rect();
            const realWidth = Math.max(frame.width, 200);   // Fallback to 200 if no geometry yet
            const realHeight = Math.max(frame.height, 200);
            
            Logger.log(`[MOSAIC WM] canFitWindow: Window not in workspace - adding with size ${realWidth}x${realHeight}`);
            
            const newWindowDescriptor = new WindowDescriptor(window, windows.length);
            newWindowDescriptor.width = realWidth;
            newWindowDescriptor.height = realHeight;
            
            windows.push(newWindowDescriptor);
        } else {
            Logger.log('[MOSAIC WM] canFitWindow: Window already in workspace - checking current layout');
        }
        
        // A single window should always fit - prevents infinite loop for large windows
        // Check AFTER potentially adding the new window to the list
        if (windows.length <= 1) {
            Logger.log('[MOSAIC WM] canFitWindow: Only 1 window total - always fits');
            return true;
        }

        const tile_result = this._tile(windows, availableSpace);
        
        Logger.log(`[MOSAIC WM] canFitWindow: Tile result overflow: ${tile_result.overflow}`);
        
        let fits = !tile_result.overflow;
        
        if (fits) {
            Logger.log('[MOSAIC WM] canFitWindow: Window fits!');
        } else {
            Logger.log('[MOSAIC WM] canFitWindow: Window does NOT fit (overflow)');
        }
        
        return fits;
    }

    /**
     * Save original size of a window before resizing
     * @param {Meta.Window} window
     */
    saveOriginalSize(window) {
        const winId = window.get_id();
        if (!this._originalSizes.has(winId)) {
            const frame = window.get_frame_rect();
            this._originalSizes.set(winId, { width: frame.width, height: frame.height });
            Logger.log(`[MOSAIC WM] saveOriginalSize: Saved ${winId} as ${frame.width}x${frame.height}`);
        }
    }

    /**
     * Save the opening size of a window (called once when window first appears)
     * This is the MAXIMUM size the window can be restored to
     * @param {Meta.Window} window
     */
    saveOpeningSize(window) {
        const winId = window.get_id();
        if (!this._openingSizes.has(winId)) {
            const frame = window.get_frame_rect();
            if (frame.width > 0 && frame.height > 0) {
                this._openingSizes.set(winId, { width: frame.width, height: frame.height });
                Logger.log(`[MOSAIC WM] saveOpeningSize: Window ${winId} opened at ${frame.width}x${frame.height}`);
            }
        }
    }
    
    /**
     * Clear opening size when window is destroyed
     * @param {number} windowId
     */
    clearOpeningSize(windowId) {
        if (this._openingSizes.has(windowId)) {
            this._openingSizes.delete(windowId);
            Logger.log(`[MOSAIC WM] clearOpeningSize: Removed ${windowId}`);
        }
    }

    /**
     * Get opening size for a window
     * @param {number} windowId
     * @returns {Object|null} { width, height } or null if not found
     */
    getOpeningSize(windowId) {
        return this._openingSizes.get(windowId) || null;
    }

    /**
     * Try to restore windows toward their original opening sizes when space is freed
     * @param {Meta.Window[]} windows - Remaining windows in workspace
     * @param {Object} workArea - Available work area
     * @param {number} freedWidth - Width freed by removed window
     * @param {number} freedHeight - Height freed by removed window
     * @param {Meta.Workspace} workspace - Current workspace for fit validation
     * @param {number} monitor - Monitor index for fit validation
     * @returns {boolean} True if any windows were resized
     */
    tryRestoreWindowSizes(windows, workArea, freedWidth, freedHeight, workspace, monitor) {
        Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: ${freedWidth}px width and ${freedHeight}px height freed`);
        
        // Find windows that were shrunk (current size < opening size)
        const shrunkWindows = [];
        for (const window of windows) {
            const winId = window.get_id();
            const openingSize = this._openingSizes.get(winId);
            if (!openingSize) continue;
            
            const frame = window.get_frame_rect();
            const widthDiff = openingSize.width - frame.width;
            const heightDiff = openingSize.height - frame.height;
            
            // Window was shrunk if it's smaller than opening size
            if (widthDiff > 10 || heightDiff > 10) {
                shrunkWindows.push({
                    window,
                    currentWidth: frame.width,
                    currentHeight: frame.height,
                    openingWidth: openingSize.width,
                    openingHeight: openingSize.height,
                    widthDeficit: Math.max(0, widthDiff),
                    heightDeficit: Math.max(0, heightDiff)
                });
            }
        }
        
        if (shrunkWindows.length === 0) {
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: No shrunk windows to restore`);
            return false;
        }
        
        Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Found ${shrunkWindows.length} shrunk windows`);
        
        // Determine orientation (use width for landscape, height for portrait)
        const isLandscape = workArea.width > workArea.height;
        
        // The freedSpace IS the available space (the removed window's space is now free)
        const freedSpace = isLandscape ? freedWidth : freedHeight;
        
        Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: freedSpace=${freedSpace}`);
        
        if (freedSpace <= 10) {
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Not enough space to distribute`);
            return false;
        }
        
        // Calculate total deficit (how much windows want to grow)
        const totalDeficit = shrunkWindows.reduce((sum, w) => 
            sum + (isLandscape ? w.widthDeficit : w.heightDeficit), 0);
        
        if (totalDeficit <= 0) {
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: No deficit to fill`);
            return false;
        }
        
        // Distribute freed space proportionally based on how much each window was shrunk
        const spaceToDistribute = Math.min(freedSpace, totalDeficit);
        let restored = false;
        
        for (const shrunkWindow of shrunkWindows) {
            const deficit = isLandscape ? shrunkWindow.widthDeficit : shrunkWindow.heightDeficit;
            const proportion = deficit / totalDeficit;
            const gain = Math.floor(spaceToDistribute * proportion);
            
            if (gain <= 0) continue;
            
            const frame = shrunkWindow.window.get_frame_rect();
            let newWidth = frame.width;
            let newHeight = frame.height;
            
            if (isLandscape) {
                newWidth = Math.min(frame.width + gain, shrunkWindow.openingWidth);
            } else {
                newHeight = Math.min(frame.height + gain, shrunkWindow.openingHeight);
            }
            
            // Only resize if there's a meaningful change
            if (newWidth !== frame.width || newHeight !== frame.height) {
                // Calculate max available space for this window
                // by determining effective space occupied by other windows.
                // We must handle stacked windows (same column/row) by grouping them,
                // otherwise we double-count their width/height.
                
                let occupiedSpace = 0;
                
                if (isLandscape) {
                    // Landscape: Check Width usage. Group by X coordinate (Columns)
                    const columns = [];
                    for (const w of windows) {
                        if (w.get_id() === shrunkWindow.window.get_id()) continue;
                        
                        const f = w.get_frame_rect();
                        // Find matching column (approximate X)
                        const col = columns.find(c => Math.abs(c.x - f.x) < constants.COLUMN_ALIGNMENT_TOLERANCE);
                        if (col) {
                            col.width = Math.max(col.width, f.width);
                        } else {
                            columns.push({ x: f.x, width: f.width });
                        }
                    }
                    occupiedSpace = columns.reduce((sum, c) => sum + c.width, 0);
                } else {
                    // Portrait: Check Height usage. Group by Y coordinate (Rows)
                    const rows = [];
                    for (const w of windows) {
                        if (w.get_id() === shrunkWindow.window.get_id()) continue;
                        
                        const f = w.get_frame_rect();
                        // Find matching row (approximate Y)
                        const row = rows.find(r => Math.abs(r.y - f.y) < constants.COLUMN_ALIGNMENT_TOLERANCE);
                        if (row) {
                            row.height = Math.max(row.height, f.height);
                        } else {
                            rows.push({ y: f.y, height: f.height });
                        }
                    }
                    occupiedSpace = rows.reduce((sum, r) => sum + r.height, 0);
                }
                
                // Add margins for each gap between columns/rows + outer margins if applicable?
                // The workArea includes outer margins usually.
                // We just need to subtract the gap between the window and "others".
                // Simple approximation: (number of groups) * 8px
                // If there are 0 other groups, margin is 0.
                const groupCount = isLandscape ? 
                    (occupiedSpace > 0 ? 1 : 0) : // Simplification: we assume 1 block of "others" usually
                    (occupiedSpace > 0 ? 1 : 0);
                
                // Better margin calc: (Total Windows - 1) * 8 is the total gap space in the layout.
                // But we don't know how many gaps are "active".
                // Safest is to use standard formula:
                const margin = (windows.length - 1) * 8;
                
                const maxAvailable = (isLandscape ? workArea.width : workArea.height) - margin - occupiedSpace;
                
                // Limit growth to what actually fits right now
                if (isLandscape && newWidth > maxAvailable) {
                    Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Limiting ${shrunkWindow.window.get_id()} from ${newWidth}px to maxAvailable ${maxAvailable}px (others effectively occupy ${occupiedSpace}px)`);
                    newWidth = maxAvailable;
                }
                if (!isLandscape && newHeight > maxAvailable) {
                    newHeight = maxAvailable;
                }
                
                // Skip if no meaningful growth after limiting
                if ((isLandscape && newWidth <= frame.width) || (!isLandscape && newHeight <= frame.height)) {
                    continue;
                }
                
                // Simple approach: grow by freedSpace proportionally, up to openingSize and maxAvailable
                // The flag prevents overflow detection, and tiling will redistribute other windows
                
                Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Restoring ${shrunkWindow.window.get_id()} from ${frame.width}x${frame.height} to ${newWidth}x${newHeight} (max: ${shrunkWindow.openingWidth}x${shrunkWindow.openingHeight})`);
                
                // Set flag to prevent overflow detection during reverse smart resize
                shrunkWindow.window._isReverseSmartResizing = true;
                
                shrunkWindow.window.move_resize_frame(
                    true,  // userOp
                    frame.x,
                    frame.y,
                    newWidth,
                    newHeight
                );
                
                // Clear flag after a delay to allow resize to complete
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.REVERSE_RESIZE_PROTECTION_MS, () => {
                    shrunkWindow.window._isReverseSmartResizing = false;
                    Logger.log(`[MOSAIC WM] Reverse smart resize complete for window ${shrunkWindow.window.get_id()}`);
                    return GLib.SOURCE_REMOVE;
                });
                
                restored = true;
            }
        }
        
        return restored;
    }

    /**
     * Legacy: Restore windows to their original sizes if possible
     * @param {Meta.Window[]} windows
     * @param {Object} workArea
     * @deprecated Use tryRestoreWindowSizes instead
     */
    restoreOriginalSizes(windows, workArea) {
        for (const window of windows) {
            const winId = window.get_id();
            const originalSize = this._originalSizes.get(winId);
            if (originalSize) {
                const frame = window.get_frame_rect();
                // Only restore if current size is smaller than original
                if (frame.width < originalSize.width || frame.height < originalSize.height) {
                    Logger.log(`[MOSAIC WM] restoreOriginalSizes: Restoring ${winId} to ${originalSize.width}x${originalSize.height}`);
                    window.move_resize_frame(false, frame.x, frame.y, originalSize.width, originalSize.height);
                }
                this._originalSizes.delete(winId);
            }
        }
    }

    /**
     * Calculate window area as ratio of workspace area
     * @param {Object} frame - Window frame rect
     * @param {Object} workArea - Workspace area
     * @returns {number} Ratio (0-1)
     */
    getWindowAreaRatio(frame, workArea) {
        const windowArea = frame.width * frame.height;
        const workspaceArea = workArea.width * workArea.height;
        return windowArea / workspaceArea;
    }

    /**
     * Helper to get usable work area considering edge tiles
     */
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

    /**
     * Try to fit a new window by resizing existing windows
     * @param {Meta.Window} newWindow - The window trying to fit
     * @param {Meta.Window[]} existingWindows - Windows already in workspace
     * @param {Object} workArea - Available workspace area
     * @returns {boolean} True if fit was successful
     */
    tryFitWithResize(newWindow, existingWindows, workArea) {
        Logger.log(`[MOSAIC WM] tryFitWithResize: Attempting to fit window by resizing ${existingWindows.length} existing windows`);
        
        // Filter out non-resizable windows
        // Note: Most windows are resizable, only special windows like dialogs may not be
        const resizableWindows = existingWindows.filter(w => {
            // Check if window has resize constraints that prevent resizing
            const isResizable = w.resizeable !== false;
            if (!isResizable) {
                Logger.log(`[MOSAIC WM] tryFitWithResize: Window ${w.get_id()} is not resizable`);
            }
            return isResizable;
        });
        
        Logger.log(`[MOSAIC WM] tryFitWithResize: ${resizableWindows.length} resizable windows found`);
        
        if (resizableWindows.length === 0) {
            Logger.log(`[MOSAIC WM] tryFitWithResize: No resizable windows`);
            return false;
        }
        
        // NOTE: We NO LONGER clear learned minimums between sessions.
        // The cached _cachedMinWidth/_cachedMinHeight values persist permanently,
        // allowing instant capacity calculations on subsequent resize attempts.
        
        const newFrame = newWindow.get_frame_rect();
        const newWindowRatio = this.getWindowAreaRatio(newFrame, workArea);
        
        // Classify windows by size
        const largeWindows = [];
        const smallWindows = [];
        
        for (const window of resizableWindows) {
            const frame = window.get_frame_rect();
            const ratio = this.getWindowAreaRatio(frame, workArea);
            
            if (ratio > constants.LARGE_WINDOW_THRESHOLD) {
                largeWindows.push({ window, frame, ratio });
            } else if (ratio < constants.SMALL_WINDOW_THRESHOLD) {
                smallWindows.push({ window, frame, ratio });
            } else {
                // Medium windows - treat as SMALL/FIXED for resize purposes
                // This prevents trying to shrink windows that are likely already near their min size
                smallWindows.push({ window, frame, ratio });
            }
        }
        
        Logger.log(`[MOSAIC WM] tryFitWithResize: Large=${largeWindows.length}, Small=${smallWindows.length}, NewRatio=${newWindowRatio.toFixed(2)}`);
        
        // Detect orientation - if width > height, we likely tile horizontally (windows side-by-side)
        // If height > width, we likely tile vertically (windows stacked)
        const isLandscape = workArea.width > workArea.height;
        const dim = isLandscape ? 'width' : 'height'; // Dimension to check
        
        Logger.log(`[MOSAIC WM] tryFitWithResize: Orientation is ${isLandscape ? 'LANDSCAPE (using width)' : 'PORTRAIT (using height)'}`);

        const workspaceMargin = 2; // Safety margin
        const usableSpace = workArea[dim] - (workspaceMargin * 2);
        
        let resizeRatio = 1.0;
        
        const totalWindows = resizableWindows.length + 1;
        const spacing = (totalWindows - 1) * constants.WINDOW_SPACING;
        
        let smallWindowsSpace = smallWindows.reduce((sum, item) => sum + item.frame[dim], 0);
        let largeWindowsSpace = largeWindows.reduce((sum, item) => sum + item.frame[dim], 0);
        
        // Assume new window is resizable by default
        let fixedSpace = smallWindowsSpace;
        let resizableSpace = largeWindowsSpace + newFrame[dim];
        
        // EXPERIMENTAL: If new window is NOT Large (> 60%), treat it as 'fixed' for calculation purposes.
        if (newWindowRatio < constants.LARGE_WINDOW_THRESHOLD) {
            Logger.log(`[MOSAIC WM] tryFitWithResize: New window is not Large (${newWindowRatio.toFixed(2)}), treating as fixed constraint`);
            fixedSpace += newFrame[dim];
            resizableSpace -= newFrame[dim];
        } else {
             // It's large, verify if we have ANY fixed constraints (e.g. edge tiles effectively reducing usable space)
             // If resizableSpace is huge but usableSpace is tiny, ratio will handle it.
        }

        const availableForResizable = usableSpace - spacing - fixedSpace;
        
        if (resizableSpace > 0) {
            resizeRatio = availableForResizable / resizableSpace;
        } else {
            // No resizable windows - check if we can still fit
            if (fixedSpace + spacing <= usableSpace) {
                Logger.log(`[MOSAIC WM] tryFitWithResize: No resizable windows but fixed windows fit - returning true`);
                return true;
            } else {
                Logger.log(`[MOSAIC WM] tryFitWithResize: No resizable windows and fixed windows don't fit - proceeding to fallback check`);
                resizeRatio = 1.0; // Will fail validity check and trigger fallback
            }
        }

        const totalSpaceNeeded = fixedSpace + resizableSpace + spacing;

        if (totalSpaceNeeded <= usableSpace) {
            Logger.log(`[MOSAIC WM] tryFitWithResize: No resize needed (dimensions fit) - returning true`);
            return true;
        }

        // If we need resize, resizeRatio is already calculated above.
        // Just verify min ratio.

        
        // Check if resize ratio is valid
        if (resizeRatio >= 1.0) {
            // If we have overflow (checked above) and ratio >= 1.0, it means standard resize failed.
            // If largeWindows are present, this is a legit failure.
            // If NO large windows, we want to fall through to FALLBACK logic below.
            if (largeWindows.length > 0) {
                Logger.log(`[MOSAIC WM] tryFitWithResize: Ratio >= 1.0 but space needed > usable (and large windows exist) - something wrong, returning false`);
                return false;
            } else {
                 Logger.log(`[MOSAIC WM] tryFitWithResize: Standard resize N/A (ratio >= 1.0), falling through to fallback strategy`);
            }
        }
        

        
        // Check minimum safety ratio (don't shrink to invisible)
        // Check minimum safety ratio (don't shrink to invisible)
        if (resizeRatio < constants.MIN_RESIZE_RATIO) {
            if (largeWindows.length > 0) {
                Logger.log(`[MOSAIC WM] tryFitWithResize: Ratio too small (${resizeRatio.toFixed(2)}), below min ${constants.MIN_RESIZE_RATIO}`);
                return false;
            } else {
                 Logger.log(`[MOSAIC WM] tryFitWithResize: Ratio too small (${resizeRatio.toFixed(2)}) but no Large windows - forcing fallback check`);
            }
        }
        
        Logger.log(`[MOSAIC WM] tryFitWithResize: Resize ratio needed: ${resizeRatio.toFixed(2)}`);
        
        // Special case: If no large EXISTING windows but new window is large, we need to resize the new window
        const newWindowIsLarge = newWindowRatio >= constants.LARGE_WINDOW_THRESHOLD;
        let newWindowFitSuccess = false;

        if (largeWindows.length === 0) {
            if (newWindowIsLarge) {
                Logger.log(`[MOSAIC WM] tryFitWithResize: No large existing windows - trying to fit NEW window (${newWindowRatio.toFixed(2)}) alone`);
                
                // Calculate how much space is available for the new window
                const existingSmallSpace = smallWindows.reduce((sum, item) => sum + item.frame[dim], 0);
                const availableForNew = usableSpace - existingSmallSpace - spacing;
                
                const newDimension = newFrame[dim];
                const shrinkRatio = availableForNew / newDimension;
                
                if (shrinkRatio >= constants.MIN_RESIZE_RATIO && shrinkRatio < 1.0) {
                    const targetWidth = Math.floor(newFrame.width * shrinkRatio);
                    const targetHeight = Math.floor(newFrame.height * shrinkRatio);
                    
                    // CHECK MIN SIZE
                    const hints = newWindow.get_size_hints ? newWindow.get_size_hints() : null;
                    const minSize = hints ? (dim === 'width' ? hints.min_width : hints.min_height) : 50;
                    const targetDim = dim === 'width' ? targetWidth : targetHeight;
                    
                    if (targetDim < minSize) {
                         Logger.log(`[MOSAIC WM] tryFitWithResize: Target ${targetDim} < Min ${minSize} for NEW window. Aborting single resize to try Fallback.`);
                         // Fallthrough to Fallback
                    } else {
                        Logger.log(`[MOSAIC WM] tryFitWithResize: Shrinking NEW window from ${newFrame.width}x${newFrame.height} to ${targetWidth}x${targetHeight} (ratio: ${shrinkRatio.toFixed(2)})`);
                        
                        // Protect new window
                        newWindow._isSmartResizing = true;
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_VERIFICATION_DELAY_MS, () => {
                             newWindow._isSmartResizing = false;
                             return GLib.SOURCE_REMOVE;
                        });
                        
                        GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                            newWindow.move_resize_frame(true, newFrame.x, newFrame.y, targetWidth, targetHeight);
                            Logger.log(`[MOSAIC WM] tryFitWithResize: Async resize applied to NEW window ${newWindow.get_id()}`);
                            return GLib.SOURCE_REMOVE;
                        });
                        
                        newWindowFitSuccess = true;
                        return true;
                    }
                } else {
                     Logger.log(`[MOSAIC WM] tryFitWithResize: New window shrink ratio ${shrinkRatio.toFixed(2)} too small/invalid. Falling through to Global Resize.`);
                }
            } 
            
            if (!newWindowFitSuccess) {
                // FALLBACK STRATEGY: SMART DISTRIBUTION (Democracy of the Capable)
                // We need to fit 'totalNeeded' into 'usableSpace'.
                // Instead of shrinking everyone proportionally (which fails if one window is at min size),
                // we calculate how much "shrinkable fat" each window has and distribute the reduction load
                // proportionally to that availability.
                
                Logger.log(`[MOSAIC WM] tryFitWithResize: No Large windows. Initiating SMART DISTRIBUTION fallback.`);
                
                // 1. Promote Small windows to be candidates
                largeWindows.push(...smallWindows);
                smallWindows.length = 0;
                
                // 2. Identify candidates and their limits
                // We need to reduce total width by this amount:
                // Note: newWindowWidth is usually fixed in this logic unless we add it to the pool?
                // Let's keep newWindow fixed for now to simplify, unless it's huge.
                // Assuming newWindow fits in usableSpace if alone.
                
                const totalCurrentWidth = largeWindows.reduce((sum, item) => sum + item.frame[dim], 0);
                const newWindowWidth = newFrame[dim];
                const spaceAvailableForExisting = usableSpace - newWindowWidth - spacing;
                
                // How much we need to shave off the existing windows Total
                const requiredReduction = totalCurrentWidth - spaceAvailableForExisting;
                
                Logger.log(`[MOSAIC WM] Smart Distribution: TotalCurrent=${totalCurrentWidth}, Available=${spaceAvailableForExisting}, Need to cut=${requiredReduction}`);
                
                if (requiredReduction <= 0) {
                    // Weird, it should fit without resize?
                    resizeRatio = 1.0; 
                } else {
                    // 3. Calculate shrinkable capability for each window
                    let totalShrinkCapacity = 0;
                    
                    largeWindows.forEach(item => {
                        // PRIORITY: Use cached actual minimum if available (persistent from previous attempts)
                        // Otherwise try get_size_hints, then fallback to 50px
                        let minSize;
                        
                        if (item.window._actualMinWidth && dim === 'width') {
                            minSize = item.window._actualMinWidth;
                            Logger.log(`[MOSAIC WM] Window ${item.window.get_id()}: Using CACHED min ${minSize}px`);
                        } else if (item.window._actualMinHeight && dim === 'height') {
                            minSize = item.window._actualMinHeight;
                            Logger.log(`[MOSAIC WM] Window ${item.window.get_id()}: Using CACHED min ${minSize}px`);
                        } else {
                            const hints = item.window.get_size_hints ? item.window.get_size_hints() : null;
                            minSize = hints ? (dim === 'width' ? hints.min_width : hints.min_height) : 50;
                            if (minSize < 50) minSize = 50; // Safety floor
                        }
                        
                        // How much can this window give?
                        item.minSize = minSize;
                        item.shrinkCapacity = Math.max(0, item.frame[dim] - minSize);
                        
                        totalShrinkCapacity += item.shrinkCapacity;
                        Logger.log(`[MOSAIC WM] Window ${item.window.get_id()} (${item.frame[dim]}px): Min=${minSize}, Capacity=${item.shrinkCapacity}`);
                    });
                    
                    if (totalShrinkCapacity < requiredReduction) {
                        Logger.log(`[MOSAIC WM] Smart Distribution: Existing windows at minimum. Need ${requiredReduction}, have ${totalShrinkCapacity}. Will try shrinking NEW window.`);
                        
                        // Calculate how much space is available for the new window
                        const existingTotalWidth = largeWindows.reduce((sum, item) => sum + item.minSize, 0);
                        const availableForNew = workArea.width - existingTotalWidth - (28 * largeWindows.length); // spacing
                        
                        if (availableForNew > 100) { // At least 100px for new window
                            const newFrame = newWindow.get_frame_rect();
                            const targetWidth = Math.max(100, Math.floor(availableForNew));
                            const targetHeight = newFrame.height; // Keep height unchanged
                            
                            Logger.log(`[MOSAIC WM] Resizing NEW window from ${newFrame.width} to ${targetWidth}px (existing windows stay at minimum)`);
                            
                            newWindow._isSmartResizing = true;
                            GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                                newWindow.move_resize_frame(true, newFrame.x, newFrame.y, targetWidth, targetHeight);
                                return GLib.SOURCE_REMOVE;
                            });
                            
                            return true; // Enable polling in extension.js
                        } else {
                            Logger.log(`[MOSAIC WM] Not enough space for new window (${availableForNew}px) - overflow unavoidable`);
                            return false;
                        }
                    }
                    
                    // 4. Distribute the load and Apply
                    // We calculate a custom target size for each window instead of using a global resizeRatio
                    
                    // We need to override the standard loop below because it uses 'resizeRatio'.
                    // Or we can pre-calculate targetWidth in the item and use it?
                    // The loop below uses: targetWidth = Math.floor(frame.width * resizeRatio);
                    
                    // Let's modify 'frame' in largeWindows? No, frame is current.
                    // We can set a custom property 'overrideTargetSize' on the item?
                    
                    largeWindows.forEach(item => {
                        if (totalShrinkCapacity > 0) {
                            // My share of the debt
                            const myShare = (item.shrinkCapacity / totalShrinkCapacity) * requiredReduction;
                            item.customTargetSize = Math.floor(item.frame[dim] - myShare);
                            Logger.log(`[MOSAIC WM] Window ${item.window.get_id()}: Taking load ${Math.floor(myShare)}px -> New Size ${item.customTargetSize}`);
                        } else {
                            item.customTargetSize = item.frame[dim];
                        }
                    });
                    
                    // Set resizeRatio to a dummy value that passes checks, but we will use customTargetSize in loop
                    resizeRatio = 0.99; // < 1.0 to trigger logic
                }
                
                // IMPORTANT: We must update the loop below to use 'customTargetSize' if present!
            }
        }
        
        // Save original sizes and apply resize to large windows only
        const resizedWindows = [];
        let allResizesSucceeded = true;
        
        for (const item of largeWindows) {
            const { window, frame } = item;
            try {
                this.saveOriginalSize(window);
                
                // Apply unified proportional ratio or Custom Target (Smart Distribution)
                let targetWidth, targetHeight;
                
                if (item.customTargetSize) {
                    // Use calculated custom size for the relevant dimension, keep other same(ish)
                    if (dim === 'width') {
                        targetWidth = item.customTargetSize;
                        targetHeight = frame.height; // Maintain height
                    } else {
                        targetHeight = item.customTargetSize;
                        targetWidth = frame.width;   // Maintain width
                    }
                } else {
                    // Only resize the relevant dimension - keep the other unchanged
                    // This avoids hitting min_height when we only need to shrink width
                    if (dim === 'width') {
                        targetWidth = Math.floor(frame.width * resizeRatio);
                        targetHeight = frame.height; // KEEP HEIGHT UNCHANGED
                    } else {
                        targetHeight = Math.floor(frame.height * resizeRatio);
                        targetWidth = frame.width;  // KEEP WIDTH UNCHANGED
                    }
                }
                
                // Check if window is maximized and unmaximize first
                if (window.maximized_horizontally || window.maximized_vertically) {
                    window.unmaximize(Meta.MaximizeFlags.BOTH);
                    Logger.log(`[MOSAIC WM] tryFitWithResize: Unmaximized window ${window.get_id()}`);
                }
                
                Logger.log(`[MOSAIC WM] tryFitWithResize: Resizing ${window.get_id()} from ${frame.width}x${frame.height} to ${targetWidth}x${targetHeight}`);
                
                // PROTECT EXISTING WINDOWS from false overflow detection during resize
                window._isSmartResizing = true;
                // Auto-clear protection after sufficient time (covers resize + polling duration)
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_VERIFICATION_DELAY_MS, () => {
                     if (window._isSmartResizing) {
                         window._isSmartResizing = false;
                         // Logger.log(`[MOSAIC WM] Protection cleared for ${window.get_id()} (timeout)`);
                     }
                     return GLib.SOURCE_REMOVE;
                });
                
                // Use animations for smooth transition
                const targetRect = { x: frame.x, y: frame.y, width: targetWidth, height: targetHeight };
                
                // Use idle_add for async resize
                const winId = window.get_id();
                GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    window.move_resize_frame(true, frame.x, frame.y, targetWidth, targetHeight);
                    Logger.log(`[MOSAIC WM] tryFitWithResize: Async resize applied to ${winId}`);
                    
                    // Verify after next frame
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        const checkFrame = window.get_frame_rect();
                        Logger.log(`[MOSAIC WM] tryFitWithResize: Delayed check: ${checkFrame.width}x${checkFrame.height}`);
                        return GLib.SOURCE_REMOVE;
                    });
                    
                    return GLib.SOURCE_REMOVE;
                });
                
                // Verify immediately (will likely still show old size)
                const afterFrame = window.get_frame_rect();
                Logger.log(`[MOSAIC WM] tryFitWithResize: Immediate result: ${afterFrame.width}x${afterFrame.height}`);
                
                resizedWindows.push({ window, targetWidth, targetHeight });
            } catch (e) {
                Logger.log(`[MOSAIC WM] tryFitWithResize: Error resizing window ${window.get_id()}: ${e.message}`);
            }
        }
        
        // Also resize the NEW window if resize needed
        if (resizeRatio < 1.0) {
            try {
                const newTargetWidth = Math.floor(newFrame.width * resizeRatio);
                const newTargetHeight = Math.floor(newFrame.height * resizeRatio);
                
                Logger.log(`[MOSAIC WM] tryFitWithResize: Also resizing NEW window ${newWindow.get_id()} to ${newTargetWidth}x${newTargetHeight}`);
                
                // Use animations for new window too (start large -> shrink)
                 const newTargetRect = { x: newFrame.x, y: newFrame.y, width: newTargetWidth, height: newTargetHeight };
                 
                 if (this._animationsManager) {
                    this._animationsManager.animateWindow(newWindow, newTargetRect, { duration: constants.ANIMATION_DURATION_MS, userOp: true });
                 } else {
                    // Apply resize to new window
                     GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        newWindow.move_resize_frame(false, newFrame.x, newFrame.y, newTargetWidth, newTargetHeight);
                        return GLib.SOURCE_REMOVE;
                    });
                 }
                
            } catch (e) {
                Logger.log(`[MOSAIC WM] tryFitWithResize: Error resizing new window: ${e.message}`);
            }
        }
        
        // Trust the animation - no verification needed
        // The animation manager handles the resize asynchronously
        Logger.log(`[MOSAIC WM] tryFitWithResize: Resize commands sent for ${resizedWindows.length} windows`);
        
        return true;
    }

    destroy() {
        this.destroyMasks();
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
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
        if (drawingManager) {
            drawingManager.removeBoxes();
            drawingManager.rect(x, y, this.width, this.height);
        }
    }
}
