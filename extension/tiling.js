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
import * as WindowState from './windowState.js';

export const ComputedLayouts = new Map();

export class TilingManager {
    constructor(extension) {
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
        this._extension = null;
        
        // Track original window sizes for smart resize before overflow
        // windowId -> { width, height } - size before current resize session
        // Now stored in WindowState.get(window, 'originalSize')
        
        // Track window opening sizes for reverse smart resize (restore on window close)
        // windowId -> { width, height } - size when window first opened
        // Now stored in WindowState.get(window, 'openingSize')
        
        // Queue for serializing window opening operations to prevent race conditions
        this._openingQueue = [];
        this._processingQueue = false;
        
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
    
    // Invalidate the layout cache when windows change
    invalidateLayoutCache() {
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
    }
    
    // Get the cached layout result (array of {id, x, y, width, height})
    getCachedLayout() {
        return this._cachedTileResult?.windows || null;
    }
    
    // Queue a window opening operation to prevent race conditions
    // The callback will be called when it's this window's turn
    enqueueWindowOpen(windowId, callback) {
        Logger.log(`[MOSAIC WM] Enqueuing window ${windowId} for opening (queue size: ${this._openingQueue.length})`);
        this._openingQueue.push({ windowId, callback });
        this._processOpeningQueue();
    }
    
    // Process the opening queue one window at a time
    _processOpeningQueue() {
        if (this._processingQueue || this._openingQueue.length === 0) {
            return;
        }
        
        this._processingQueue = true;
        const { windowId, callback } = this._openingQueue.shift();
        
        Logger.log(`[MOSAIC WM] Processing queue: window ${windowId} (remaining: ${this._openingQueue.length})`);
        
        // Monitor this processing step
        const watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
             Logger.log(`[MOSAIC WM] Queue watchdog: Window ${windowId} callback took too long or stalled - forcing next`);
             this._processingQueue = false;
             this._processOpeningQueue();
             return GLib.SOURCE_REMOVE;
        });

        // Execute the callback
        try {
            callback();
        } catch (e) {
            Logger.log(`[MOSAIC WM] Error processing window ${windowId}: ${e}`);
        } finally {
            if (watchdogId) GLib.source_remove(watchdogId);
        }
        
        // Small delay before processing next window to let animations settle
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.QUEUE_PROCESS_DELAY_MS, () => {
             this._processingQueue = false;
             this._processOpeningQueue();
             return GLib.SOURCE_REMOVE;
        });
    }
    
    // Clear queue (e.g., on disable)
    clearOpeningQueue() {
        this._openingQueue = [];
        this._processingQueue = false;
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

    // Generate permutations of an array (limited for performance)
    // For 6+ items, returns heuristic orderings instead of all permutations
    _generatePermutations(arr, maxPermutations = 120) {
        if (arr.length <= 1) return [arr];
        if (arr.length === 2) return [arr, [arr[1], arr[0]]];
        
        // For 6+ windows, use heuristic orderings (by area, descending and ascending)
        // This avoids O(n!) complexity: 6! = 720, 7! = 5040 permutations
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

    // Find the optimal window ordering by trying permutations
    _findOptimalOrder(windows, workArea, tilingFn) {
        if (windows.length <= 1) return windows;
        
        const startTime = Date.now();
        const permutations = this._generatePermutations(windows);
        
        let bestOrder = windows;
        let bestScore = -Infinity;
        
        for (const perm of permutations) {
            const result = tilingFn.call(this, perm, workArea, constants.WINDOW_SPACING);
            const score = this._scoreLayout(result, workArea);
            
            if (score > bestScore) {
                bestScore = score;
                bestOrder = perm;
            }
        }
        
        const elapsed = Date.now() - startTime;
        Logger.log(`[MOSAIC WM] _findOptimalOrder: ${windows.length} windows, ${permutations.length} permutations, ${elapsed}ms`);
        
        return bestOrder;
    }

    // Generate a hash of window configuration for cache invalidation.
    // If windows haven't changed IDs/sizes, we can reuse the previous layout.
    _getLayoutHash(windows, work_area) {
        const sorted = [...windows].sort((a, b) => a.id - b.id);
        const parts = sorted.map(w => `${w.id}:${w.width}x${w.height}`);
        return `${work_area.width}x${work_area.height}|${parts.join(',')}`;
    }

    // Tile windows with dynamic shelf orientation.
    // Selects vertical columns if any window is tall (>65%) or workspace is narrow.
    // Uses optimal permutation search for predictable, best-quality layouts.
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
        
        // Check cache: skip permutation search if windows unchanged
        const hash = this._getLayoutHash(windows, work_area);
        if (hash === this._lastLayoutHash && this._cachedTileResult) {
            Logger.log(`[MOSAIC WM] _tile: Cache hit, reusing layout for ${windows.length} windows`);
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
        
        // Find optimal window ordering (tries permutations, scores each layout)
        const optimalWindows = this._findOptimalOrder(windows, work_area, tilingFn);
        
        Logger.log(`[MOSAIC WM] _tile: ${windows.length} windows, vertical=${useVerticalShelves}, optimized order`);
        
        // Execute with optimal order and cache result
        const result = tilingFn.call(this, optimalWindows, work_area, spacing);
        this._lastLayoutHash = hash;
        this._cachedTileResult = result;
        
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
        
        // Set targetX/targetY for each window
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
                // Pass masks, isDragging AND drawingManager AND dryRun
                level.draw_horizontal(meta_windows, work_area, y, this.masks, this.isDragging, this._drawingManager, dryRun);
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = _x;
            for(let level of levels) {
                level.draw_vertical(meta_windows, x, this.masks, this.isDragging, this._drawingManager, dryRun);
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
        // Check if mosaic is enabled for this workspace
        if (this._extension && !this._extension.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log(`[MOSAIC WM] Mosaic disabled for workspace ${workspace.index()} - skipping tiling`);
            return { overflow: false, layout: null };
        }

        Logger.log(`[MOSAIC WM] tileWorkspaceWindows: Starting for workspace ${workspace.index()}`);


        
        // Auto-detect monitors: if no monitor specified and no reference window,
        // iterate over all monitors to ensure complete tiling coverage
        if (_monitor === null || _monitor === undefined) {
            if (!reference_meta_window) {
                const nMonitors = global.display.get_n_monitors();
                if (nMonitors > 1) {
                    Logger.log(`[MOSAIC WM] Auto-tiling workspace ${workspace.index()} across ${nMonitors} monitors`);
                }
                for (let m = 0; m < nMonitors; m++) {
                    this.tileWorkspaceWindows(workspace, null, m, keep_oversized_windows, excludeFromTiling);
                }
                return { overflow: false, layout: null };
            } else {
                // Get monitor from reference window
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
                    return { overflow: false, layout: null }; // Let preview show but don't move windows
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
                
                return { overflow: false, layout: null }; // Don't tile, edge-tiled windows stay in place
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
                    return { overflow: false, layout: null };
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
            return { overflow: false, layout: null };
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
        
        // DRY RUN: If dryRun flag is set, return overflow without moving anything
        if (arguments[5] === true) {
            return { overflow, layout: this._cachedTileResult?.windows || null };
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
            const addedTime = WindowState.get(reference_meta_window, 'addedTime');
            const isNewlyAdded = addedTime && (Date.now() - addedTime) < 2000;
            
            if (!isNewlyAdded && !WindowState.get(reference_meta_window, 'forceOverflow')) {
                Logger.log(`[MOSAIC WM] Skipping overflow for ${reference_meta_window.get_id()} - not a new window`);
            } else if (WindowState.get(reference_meta_window, 'isSmartResizing')) {
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
            let draggedWindow = reference_meta_window;
            
            // Allow animation for windows returning from excluded state
            // Allow animation for windows returning from excluded state
            if (reference_meta_window && WindowState.get(reference_meta_window, 'justReturnedFromExclusion')) {
                Logger.log(`[MOSAIC WM] Allowing animation for returning excluded window ${reference_meta_window.get_id()}`);
                WindowState.remove(reference_meta_window, 'justReturnedFromExclusion');
            }
            
            animationsHandledPositioning = this._animateTileLayout(tile_info, tileArea, meta_windows, draggedWindow);
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
        
        return { overflow, layout: this._cachedTileResult?.windows || null };
    }

    canFitWindow(window, workspace, monitor) {
        Logger.log(`[MOSAIC WM] canFitWindow: Checking if window can fit in workspace ${workspace.index()}`);
        
        // Excluded windows (Always on Top, Sticky) always "fit" - they don't participate in tiling
        // This allows them to coexist with fullscreen/maximized windows
        if (this._windowingManager.isExcluded(window)) {
            Logger.log('[MOSAIC WM] canFitWindow: Window is excluded - always fits (not tiled)');
            return true;
        }
        
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

    //
     // Save original size of a window before resizing
     
    saveOriginalSize(window) {
        if (!WindowState.has(window, 'originalSize')) {
            const frame = window.get_frame_rect();
            WindowState.set(window, 'originalSize', { width: frame.width, height: frame.height });
            Logger.log(`[MOSAIC WM] saveOriginalSize: Saved ${window.get_id()} as ${frame.width}x${frame.height}`);
        }
    }

    //
     // Save the opening size of a window (called once when window first appears)
     // This is the MAXIMUM size the window can be restored to
     
    saveOpeningSize(window) {
        if (!WindowState.has(window, 'openingSize')) {
            const frame = window.get_frame_rect();
            if (frame.width > 0 && frame.height > 0) {
                WindowState.set(window, 'openingSize', { width: frame.width, height: frame.height });
                Logger.log(`[MOSAIC WM] saveOpeningSize: Window ${window.get_id()} opened at ${frame.width}x${frame.height}`);
            }
        }
    }
    
    //
     // Clear opening size when window is destroyed
     
    //
     // Clear opening size when window is destroyed
     
    clearOpeningSize(window) {
        if (WindowState.has(window, 'openingSize')) {
            WindowState.remove(window, 'openingSize');
            Logger.log(`[MOSAIC WM] clearOpeningSize: Removed ${window.get_id()}`);
        }
    }

    //
     // Get opening size for a window
     
    getOpeningSize(window) {
        return WindowState.get(window, 'openingSize') || null;
    }

    //
     // Try to restore windows toward their original opening sizes when space is freed
     
    tryRestoreWindowSizes(windows, workArea, freedWidth, freedHeight, workspace, monitor) {
        Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: ${freedWidth}px width and ${freedHeight}px height freed`);
        
        // Find windows that were shrunk (current size < opening size)
        const shrunkWindows = [];
        for (const window of windows) {
            const openingSize = WindowState.get(window, 'openingSize');
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
                // Also restore height proportionally if it was shrunk
                if (shrunkWindow.heightDeficit > 0 && shrunkWindow.widthDeficit > 0) {
                    const heightRatio = shrunkWindow.heightDeficit / shrunkWindow.widthDeficit;
                    const heightGain = Math.floor(gain * heightRatio);
                    newHeight = Math.min(frame.height + heightGain, shrunkWindow.openingHeight);
                }
            } else {
                newHeight = Math.min(frame.height + gain, shrunkWindow.openingHeight);
                // Also restore width proportionally if it was shrunk
                if (shrunkWindow.widthDeficit > 0 && shrunkWindow.heightDeficit > 0) {
                    const widthRatio = shrunkWindow.widthDeficit / shrunkWindow.heightDeficit;
                    const widthGain = Math.floor(gain * widthRatio);
                    newWidth = Math.min(frame.width + widthGain, shrunkWindow.openingWidth);
                }
            }
            
            // Only resize if there's a meaningful change
            if (newWidth !== frame.width || newHeight !== frame.height) {
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
                WindowState.set(shrunkWindow.window, 'isReverseSmartResizing', true);
                
                shrunkWindow.window.move_resize_frame(
                    true,  // userOp
                    frame.x,
                    frame.y,
                    newWidth,
                    newHeight
                );
                
                // Clear flag after a delay to allow resize to complete
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.REVERSE_RESIZE_PROTECTION_MS, () => {
                    WindowState.set(shrunkWindow.window, 'isReverseSmartResizing', false);
                    Logger.log(`[MOSAIC WM] Reverse smart resize complete for window ${shrunkWindow.window.get_id()}`);
                    return GLib.SOURCE_REMOVE;
                });
                
                restored = true;
            }
        }
        
        return restored;
    }



    //
     // Calculate window area as ratio of workspace area
     
    getWindowAreaRatio(frame, workArea) {
        const windowArea = frame.width * frame.height;
        const workspaceArea = workArea.width * workArea.height;
        return windowArea / workspaceArea;
    }

    //
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
    calculateLayoutsOnly() {
        const workspace = global.workspace_manager.get_active_workspace();
        const monitor = global.display.get_focus_window()?.get_monitor() || 0;
        
        // Pass excludeFromTiling=false to ensure we consider the new window
        let working_info = this._getWorkingInfo(workspace, null, monitor, false);
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

    //
     // Try to fit a new window by resizing existing windows
     
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
        
        // All resizable windows are candidates for shrinking
        // (Previously only "Large" windows were resized, but medium-sized resizable windows should also shrink)
        const resizableCandidates = resizableWindows.map(w => {
            const frame = w.get_frame_rect();
            return { window: w, frame, ratio: this.getWindowAreaRatio(frame, workArea) };
        });
        
        Logger.log(`[MOSAIC WM] tryFitWithResize: Resizable=${resizableCandidates.length}, NewRatio=${newWindowRatio.toFixed(2)}`);
        
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
        
        // All resizable windows can potentially be shrunk
        let resizableSpace = resizableCandidates.reduce((sum, item) => sum + item.frame[dim], 0);
        
        // Assume new window is resizable by default
        let fixedSpace = 0; // No more "small = fixed" assumption
        resizableSpace += newFrame[dim];
        

        
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
            // No resizable windows - will check totalSpaceNeeded below
            Logger.log(`[MOSAIC WM] tryFitWithResize: No resizable windows - checking if fixed windows fit`);
            resizeRatio = 1.0; // No resize possible, check if it fits as-is
        }


        const totalSpaceNeeded = fixedSpace + resizableSpace + spacing;

        // IMPORTANT: 1D check is not enough - verify with actual 2D tile simulation
        // Create window descriptors to simulate the layout - use ALL existing windows, not just resizable ones
        const simulatedWindows = [];
        for (const w of existingWindows) {
            const frame = w.get_frame_rect();
            simulatedWindows.push({
                id: w.get_id(),
                width: frame.width,
                height: frame.height
            });
        }
        // Add new window
        simulatedWindows.push({
            id: newWindow.get_id(),
            width: newFrame.width,
            height: newFrame.height
        });

        
        // Run tile simulation
        const tileResult = this._tile(simulatedWindows, workArea);
        
        if (!tileResult.overflow) {
            Logger.log(`[MOSAIC WM] tryFitWithResize: 2D tile simulation confirms fit - returning true`);
            return true;
        }
        
        Logger.log(`[MOSAIC WM] tryFitWithResize: 2D tile simulation shows overflow with current sizes - attempting resize`);
        
        // Calculate how much we need to shrink resizable windows
        // The overflow happens because windows are too tall when stacked vertically
        // We need to shrink resizable windows so that vertical stacks fit within workArea.height
        
        if (resizableCandidates.length === 0) {
            Logger.log(`[MOSAIC WM] tryFitWithResize: No resizable windows - cannot fix overflow`);
            return false;
        }
        
        // Calculate target sizes for resizable windows
        // Strategy: shrink all resizable windows proportionally until 2D layout fits
        let shrinkRatio = 0.95; // Start at 95%
        let fitsAfterResize = false;
        let attempts = 0;
        const maxAttempts = 10;
        
        while (!fitsAfterResize && shrinkRatio >= constants.MIN_RESIZE_RATIO && attempts < maxAttempts) {
            // Create simulated windows with shrunk sizes for resizable windows
            const shrunkSimulation = [];
            
            for (const w of existingWindows) {
                const frame = w.get_frame_rect();
                const isResizable = resizableCandidates.some(c => c.window.get_id() === w.get_id());
                
                if (isResizable) {
                    shrunkSimulation.push({
                        id: w.get_id(),
                        width: Math.floor(frame.width * shrinkRatio),
                        height: Math.floor(frame.height * shrinkRatio)
                    });
                } else {
                    shrunkSimulation.push({
                        id: w.get_id(),
                        width: frame.width,
                        height: frame.height
                    });
                }
            }
            
            // Add new window (unchanged)
            shrunkSimulation.push({
                id: newWindow.get_id(),
                width: newFrame.width,
                height: newFrame.height
            });
            
            // Test this configuration
            const shrunkResult = this._tile(shrunkSimulation, workArea);
            
            if (!shrunkResult.overflow) {
                fitsAfterResize = true;
                Logger.log(`[MOSAIC WM] tryFitWithResize: Found working shrink ratio ${shrinkRatio.toFixed(2)}`);
            } else {
                shrinkRatio -= 0.05; // Try 5% smaller
                attempts++;
            }
        }
        
        if (!fitsAfterResize) {
            Logger.log(`[MOSAIC WM] tryFitWithResize: Cannot fit even after max shrink - returning false`);
            return false;
        }
        
        // Apply the resize to resizable windows
        Logger.log(`[MOSAIC WM] tryFitWithResize: Applying resize with ratio ${shrinkRatio.toFixed(2)} to ${resizableCandidates.length} windows`);
        
        for (const candidate of resizableCandidates) {
            const { window, frame } = candidate;
            const targetWidth = Math.floor(frame.width * shrinkRatio);
            const targetHeight = Math.floor(frame.height * shrinkRatio);
            
            this.saveOriginalSize(window);
            WindowState.set(window, 'isSmartResizing', true);
            
            // Apply resize SYNCHRONOUSLY so tileWorkspaceWindows sees correct sizes
            window.move_resize_frame(true, frame.x, frame.y, targetWidth, targetHeight);
            Logger.log(`[MOSAIC WM] tryFitWithResize: Resized window ${window.get_id()} from ${frame.width}x${frame.height} to ${targetWidth}x${targetHeight}`);
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_VERIFICATION_DELAY_MS, () => {
                WindowState.set(window, 'isSmartResizing', false);
                return GLib.SOURCE_REMOVE;
            });
        }
        
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
        // Fallback for new windows that report 0 dimensions
        this.width = Math.max(frame.width, 200);
        this.height = Math.max(frame.height, 200);
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
            window.move_resize_frame(false, x, y, this.width, this.height);
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
        
        ComputedLayouts.set(window.id, { x: drawX, y: drawY, width: window.width, height: window.height });

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
        
        ComputedLayouts.set(window.id, { x: drawX, y: drawY, width: window.width, height: window.height });

        window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
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
