/**
 * Tiling Module
 * 
 * This module implements the core tiling algorithm for arranging windows in a mosaic layout.
 * It handles:
 * - Converting windows to descriptors for layout calculations
 * - Calculating optimal window positions in horizontal levels
 * - Handling window overflow when workspace is full
 * - Managing window swaps for manual reordering
 * - Creating visual masks for drag-and-drop feedback
 */

import * as constants from './constants.js';
import * as windowing from './windowing.js';
import * as reordering from './reordering.js';
import * as drawing from './drawing.js';
import * as edgeTiling from './edgeTiling.js';

// Module-level state for tiling operations
var masks = []; // Visual feedback masks for windows being dragged
var working_windows = []; // Current set of window descriptors being tiled
var tmp_swap = []; // Temporary swap for preview during drag
var isDragging = false; // Flag to track drag state
var dragRemainingSpace = null; // Remaining space to use during drag (when edge tiling is active)

/**
 * WindowDescriptor class
 * 
 * Represents a window's position and size for tiling calculations.
 * This is a lightweight representation that can be manipulated without
 * affecting the actual Meta.Window until draw() is called.
 */
class WindowDescriptor{
    /**
     * Creates a new window descriptor from a Meta.Window.
     * 
     * @param {Meta.Window} meta_window - The window to create a descriptor for
     * @param {number} index - Index of this window in the meta_windows array
     */
    constructor(meta_window, index) {
        let frame = meta_window.get_frame_rect();

        this.index = index; // Index in the original meta_windows array
        this.x = frame.x;
        this.y = frame.y;
        this.width = frame.width;
        this.height = frame.height;
        this.id = meta_window.get_id();
    }
    
    /**
     * Applies this descriptor's position to the actual window.
     * Finds the window by ID instead of index to support filtered window lists.
     * 
     * @param {Meta.Window[]} meta_windows - Array of actual windows
     * @param {number} x - New X position
     * @param {number} y - New Y position
     */
    draw(meta_windows, x, y) {
        // Find window by ID instead of index (supports filtered lists)
        const window = meta_windows.find(w => w.get_id() === this.id);
        if (window) {
            window.move_frame(false, x, y);
        } else {
            console.warn(`[MOSAIC WM] Could not find window with ID ${this.id} for drawing`);
        }
    }
}

/**
 * Creates a window descriptor for a meta window if it should be included in tiling.
 * Excludes windows that are on different monitors, excluded by policy, or maximized/fullscreen.
 * 
 * @param {Meta.Window} meta_window - The window to create a descriptor for
 * @param {number} monitor - The monitor index to filter by
 * @param {number} index - The index of this window in the window list
 * @param {Meta.Window} reference_window - Optional reference window to always include
 * @returns {WindowDescriptor|boolean} Window descriptor if valid, false otherwise
 */
function createDescriptor(meta_window, monitor, index, reference_window) {
    // If the input window is the same as the reference, make a descriptor for it anyways
    if(reference_window)
        if(meta_window.get_id() === reference_window.get_id())
            return new WindowDescriptor(meta_window, index);
    
    if( windowing.isExcluded(meta_window) ||
        meta_window.get_monitor() !== monitor ||
        windowing.isMaximizedOrFullscreen(meta_window))
        return false;
    return new WindowDescriptor(meta_window, index);
}

/**
 * Converts an array of Meta.Windows to window descriptors for tiling.
 * Filters out windows that should not be tiled (wrong monitor, excluded, maximized).
 * 
 * @param {Meta.Window[]} meta_windows - Array of windows to convert
 * @param {number} monitor - Monitor index to filter by
 * @param {Meta.Window} reference_window - Optional window to always include
 * @returns {WindowDescriptor[]} Array of window descriptors
 */
export function windowsToDescriptors(meta_windows, monitor, reference_window) {
    let descriptors = [];
    for(let i = 0; i < meta_windows.length; i++) {
        let descriptor = createDescriptor(meta_windows[i], monitor, i, reference_window);
        if(descriptor)
            descriptors.push(descriptor);
    }
    return descriptors;
}

/**
 * Level class
 * 
 * Represents a horizontal row of windows in the tiling layout.
 * Windows are arranged in levels to fit within the workspace height.
 * 
 * @param {Object} work_area - The available workspace area {x, y, width, height}
 */
function Level(work_area) {
    this.x = 0; // X position of this level (centered)
    this.y = 0; // Y position of this level
    this.width = 0; // Total width of all windows in this level
    this.height = 0; // Height of the tallest window in this level
    this.windows = []; // Array of WindowDescriptor objects
    this.work_area = work_area;
}

/**
 * Draws all windows in this level horizontally.
 * Windows are vertically centered within the level's height.
 * 
 * @param {Meta.Window[]} meta_windows - Array of actual windows
 * @param {Object} work_area - The workspace area
 * @param {number} y - Y position to start drawing from
 */
Level.prototype.draw_horizontal = function(meta_windows, work_area, y) {
    let x = this.x;
    for(let window of this.windows) {
        // Calculate vertical offset to center window in the level
        let center_offset = (work_area.height / 2 + work_area.y) - (y + window.height / 2);
        let y_offset = 0;
        if(center_offset > 0)
            y_offset = Math.min(center_offset, this.height - window.height);

        window.draw(meta_windows, x, y + y_offset);
        x += window.width + constants.WINDOW_SPACING;
    }
}

/**
 * Core tiling algorithm.
 * 
 * Arranges windows in horizontal levels to fit within the work area.
 * Algorithm:
 * 1. Calculate total width needed for all windows
 * 2. Determine number of levels needed based on work area width
 * 3. Distribute windows across levels, creating new levels when width is exceeded
 * 4. Center each level horizontally and all levels vertically
 * 5. Mark overflow if windows don't fit in available height
 * 
 * @param {WindowDescriptor[]} windows - Array of window descriptors to tile
 * @param {Object} work_area - Available workspace area {x, y, width, height}
 * @returns {Object} Tiling info {x, y, overflow, vertical, levels}
 */
function tile(windows, work_area) {
    let vertical = false; // Currently only horizontal tiling is fully implemented
    
    // IMPROVEMENT: Calculate total required area first
    // This allows us to detect overflow earlier
    let totalRequiredArea = 0;
    for(let window of windows) {
        // Use real area of each window
        totalRequiredArea += (window.width * window.height);
    }
    
    // Available area in workspace
    const availableArea = work_area.width * work_area.height;
    
    // If required area > 90% of available area, probably won't fit
    // (we leave 10% margin for spacing)
    const SPACE_USAGE_THRESHOLD = 0.9;
    
    let levels = [new Level(work_area)];
    let total_width = 0;
    let total_height = 0;
    let x, y;

    let overflow = false; // Set to true if windows don't fit
    
    // NOTE: Disabled area-based overflow check - it's too conservative
    // The actual level-based tiling logic below correctly determines overflow
    // if (totalRequiredArea > availableArea * SPACE_USAGE_THRESHOLD) {
    //     overflow = true;
    // }

    if(!vertical) { // Horizontal tiling mode
        // Calculate total width of all windows including spacing
        let window_widths = 0;
        windows.map(w => window_widths += w.width + constants.WINDOW_SPACING)
        window_widths -= constants.WINDOW_SPACING;

        // Determine how many levels we need
        let n_levels = Math.round(window_widths / work_area.width) + 1;
        let avg_level_width = window_widths / n_levels;
        let level = levels[0];
        let level_index = 0;
        
        // Distribute windows across levels
        for(let window of windows) {
            // Create a new level if current level would exceed work area width
            if(level.width + constants.WINDOW_SPACING + window.width > work_area.width) {
                total_width = Math.max(level.width, total_width);
                total_height += level.height + constants.WINDOW_SPACING;
                level.x = (work_area.width - level.width) / 2 + work_area.x; // Center level
                levels.push(new Level(work_area));
                level_index++;
                level = levels[level_index];
            }
            // Check if adding this window would cause overflow
            if( Math.max(window.height, level.height) + total_height > work_area.height || 
                window.width + level.width > work_area.width){
                overflow = true;
                continue; // Skip this window
            }
            level.windows.push(window);
            if(level.width !== 0)
                level.width += constants.WINDOW_SPACING;
            level.width += window.width;
            level.height = Math.max(window.height, level.height);
        }
        total_width = Math.max(level.width, total_width);
        total_height += level.height;
        level.x = (work_area.width - level.width) / 2 + work_area.x; // Center last level

        y = (work_area.height - total_height) / 2 + work_area.y; // Center all levels vertically
    } else {
        // Vertical tiling mode (not fully implemented)
        let window_heights = 0;
        windows.map(w => window_heights += w.height + constants.WINDOW_SPACING)
        window_heights -= constants.WINDOW_SPACING;

        let n_levels = Math.floor(window_heights / work_area.height) + 1;
        let avg_level_height = window_heights / n_levels;
        let level = levels[0];
        let level_index = 0;
        
        for(let window of windows) {
            if(level.width > avg_level_height) {
                total_width = Math.max(level.width, total_width);
                total_height += level.height + constants.WINDOW_SPACING;
                level.x = (work_area.width - level.width) / 2 + work_area.x;
                levels.push(new Level(work_area));
                level_index++;
                level = levels[level_index];
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
    }
    
    // Collect all windows from all levels for return
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
        windows: all_windows  // Return windows for post-tile validation
    }
}

/**
 * Swaps two elements in an array by their window IDs.
 * Finds windows by ID and swaps their positions.
 * 
 * @param {WindowDescriptor[]} array - Array of window descriptors
 * @param {number} id1 - ID of first window
 * @param {number} id2 - ID of second window
 */
function swapElements(array, id1, id2) {
    // Find indices of windows with these IDs
    const index1 = array.findIndex(w => w.id === id1);
    const index2 = array.findIndex(w => w.id === id2);
    
    if (index1 === -1 || index2 === -1)
        return; // One or both windows not found
    
    // Swap the elements
    let tmp = array[index1];
    array[index1] = array[index2];
    array[index2] = tmp;
}

/**
 * Sets a temporary swap between two windows by their IDs.
 * The swap will be applied when applyTmpSwap() is called.
 * Now uses window IDs directly instead of converting to indices.
 * 
 * @param {number} id1 - ID of first window
 * @param {number} id2 - ID of second window
 */
export function setTmpSwap(id1, id2) {
    // Store IDs directly instead of converting to indices
    // This works correctly even with filtered window lists
    if (id1 === id2 || (tmp_swap[0] === id2 && tmp_swap[1] === id1))
        return;
    tmp_swap = [id1, id2];
}

export function clearTmpSwap() {
    tmp_swap = [];
}

export function applyTmpSwap(workspace) {
    if(!workspace.swaps)
        workspace.swaps = [];
    if(tmp_swap.length !== 0)
        workspace.swaps.push(tmp_swap);
}

export function applySwaps(workspace, array) {
    if(workspace.swaps)
        for(let swap of workspace.swaps)
            swapElements(array, swap[0], swap[1]);
}

export function applyTmp(array) {
    if(tmp_swap.length !== 0) {
        console.log(`[MOSAIC WM] Applying tmp swap: ${tmp_swap[0]} <-> ${tmp_swap[1]}`);
        swapElements(array, tmp_swap[0], tmp_swap[1]);
    }
}

/**
 * Checks if a window is in a valid state for tiling operations.
 * This validates that the window has all necessary properties and is not in a state
 * that would prevent tiling (e.g., minimized, no compositor, etc.).
 * 
 * @param {number} monitor - The monitor index
 * @param {Meta.Workspace} workspace - The workspace containing the window
 * @param {Meta.Window} window - The window to validate
 * @param {boolean} strict - If true, use is_hidden() check; if false, use minimized check
 * @returns {boolean} True if the window is valid for tiling, false otherwise
 */
export function checkValidity(monitor, workspace, window, strict) {
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

function getWorkingInfo(workspace, window, _monitor) {
    let current_monitor = _monitor;
    if(current_monitor === undefined)
        current_monitor = window.get_monitor();

    // Get all windows in this workspace and monitor
    let meta_windows = windowing.getMonitorWorkspaceWindows(workspace, current_monitor);
    
    // EDGE TILING AWARENESS: Filter out edge-tiled windows before applying swaps
    // Edge-tiled windows stay in their assigned positions
    const edgeTiledWindows = edgeTiling.getEdgeTiledWindows(workspace, current_monitor);
    const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
    const nonEdgeTiledMetaWindows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));

    // If we have edge-tiled windows, use only non-edge-tiled for swap application
    const windowsForSwaps = edgeTiledWindows.length > 0 ? nonEdgeTiledMetaWindows : meta_windows;

    // Check if any window is maximized or fullscreen
    // If any window is maximized or fullscreen, we cannot tile this workspace
    // These windows should be in their own workspace
    for (const window of meta_windows) {
        if (windowing.isMaximizedOrFullscreen(window))
            return false;
    }

    // Put needed window info into an enum so it can be transferred between arrays
    let _windows = windowsToDescriptors(windowsForSwaps, current_monitor, window);
    // Apply window layout swaps (only to non-edge-tiled windows if edge tiling is active)
    applySwaps(workspace, _windows);
    working_windows = [];
    _windows.map(window => working_windows.push(window)); // Set working windows before tmp application
    applyTmp(_windows);
    // Apply masks
    let windows = [];
    for(let window of _windows)
        windows.push(getMask(window));

    let work_area = workspace.get_work_area_for_monitor(current_monitor); // Get working area for current space
    if(!work_area) return false;

    return {
        monitor: current_monitor,
        meta_windows: meta_windows,
        windows: windows,
        work_area: work_area
    }
}

function drawTile(tile_info, work_area, meta_windows) {
    console.log(`[MOSAIC WM] drawTile called with work_area: x=${work_area.x}, y=${work_area.y}, w=${work_area.width}, h=${work_area.height}`);
    
    let levels = tile_info.levels;
    let _x = tile_info.x;
    let _y = tile_info.y;
    if(!tile_info.vertical) { // Horizontal tiling
        let y = _y;
        for(let level of levels) {
            level.draw_horizontal(meta_windows, work_area, y);
            y += level.height + constants.WINDOW_SPACING;
        }
    } else { // Vertical
        let x = _x;
        for(let level of levels) {
            level.draw_vertical(meta_windows, x);
            x += level.width + constants.WINDOW_SPACING;
        }
    }
}

class Mask{
    constructor(window) {
        this.x = window.x;
        this.y = window.y;
        this.width = window.width;
        this.height = window.height;
    }
    draw(_, x, y) {
        drawing.removeBoxes();
        drawing.rect(x, y, this.width, this.height);
    }
}

export function createMask(meta_window) {
    masks[meta_window.get_id()] = true;
}

export function destroyMasks() {
    drawing.removeBoxes();
    masks = [];
}

export function getMask(window) {
    if(masks[window.id])
        return new Mask(window);
    return window;
}

/**
 * Enable drag mode - disables snap logic during drag operations
 * @param {Object|null} remainingSpace - The remaining space to use for tiling during drag (null for full workspace)
 */
export function enableDragMode(remainingSpace = null) {
    isDragging = true;
    dragRemainingSpace = remainingSpace;
}

/**
 * Disable drag mode - re-enables snap logic after drag completes
 */
export function disableDragMode() {
    isDragging = false;
    dragRemainingSpace = null;
}

export function tileWorkspaceWindows(workspace, reference_meta_window, _monitor, keep_oversized_windows) {
    let working_info = getWorkingInfo(workspace, reference_meta_window, _monitor);
    if(!working_info) return;
    let meta_windows = working_info.meta_windows;
    let windows = working_info.windows;
    let work_area = working_info.work_area;
    let monitor = working_info.monitor;

    const workspace_windows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
    
    // EDGE TILING DETECTION: Check for edge-tiled windows
    // IMPORTANT: Edge-tiled windows stay in their assigned positions
    // EDGE TILING DETECTION: Check if there are edge-tiled windows
    const edgeTiledWindows = edgeTiling.getEdgeTiledWindows(workspace, monitor);
    console.log(`[MOSAIC WM] tileWorkspaceWindows: Found ${edgeTiledWindows.length} edge-tiled windows`);
    
    if (edgeTiledWindows.length > 0) {
        console.log(`[MOSAIC WM] Found ${edgeTiledWindows.length} edge-tiled window(s)`);
        
        // Check if we have 2 half-tiles (left + right = fully occupied)
        const zones = edgeTiledWindows.map(w => w.zone);
        const hasLeftFull = zones.includes(edgeTiling.TileZone.LEFT_FULL);
        const hasRightFull = zones.includes(edgeTiling.TileZone.RIGHT_FULL);
        const hasLeftQuarters = zones.some(z => z === edgeTiling.TileZone.TOP_LEFT || z === edgeTiling.TileZone.BOTTOM_LEFT);
        const hasRightQuarters = zones.some(z => z === edgeTiling.TileZone.TOP_RIGHT || z === edgeTiling.TileZone.BOTTOM_RIGHT);
        
        if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
            console.log('[MOSAIC WM] Both sides edge-tiled - workspace fully occupied');
            
            // Get non-edge-tiled windows
            const nonEdgeTiledMeta = edgeTiling.getNonEdgeTiledWindows(workspace, monitor);
            
            // Move all non-edge-tiled windows to new workspace
            for (const window of nonEdgeTiledMeta) {
                if (!windowing.isExcluded(window)) {
                    console.log('[MOSAIC WM] Moving non-edge-tiled window to new workspace');
                    windowing.moveOversizedWindow(window);
                }
            }
            
            return; // Don't tile, edge-tiled windows stay in place
        }
        
        // Single tile or quarter tiles - calculate remaining space
        // Calculate remaining space after edge tiling
        const remainingSpace = edgeTiling.calculateRemainingSpace(workspace, monitor);
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        const nonEdgeTiledCount = workspace_windows.filter(w => !edgeTiledIds.includes(w.get_id())).length;
        console.log(`[MOSAIC WM] Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
        console.log(`[MOSAIC WM] Total workspace windows: ${workspace_windows.length}, Non-edge-tiled: ${nonEdgeTiledCount}`);
        console.log(`[MOSAIC WM] isDragging: ${isDragging}, has dragRemainingSpace: ${!!dragRemainingSpace}`);
        
        // Filter out edge-tiled windows from tiling
        meta_windows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
        console.log(`[MOSAIC WM] After filtering edge-tiled: ${meta_windows.length} windows to tile`);
        
        // Set work_area to remaining space for tiling calculations
        work_area = remainingSpace;
        
        // If no non-edge-tiled windows, nothing to tile
        if (meta_windows.length === 0) {
            console.log('[MOSAIC WM] No non-edge-tiled windows to tile');
            return;
        }
    }
    
    // DRAG MODE: Use stored remaining space for calculations if in drag mode
    const tileArea = isDragging && dragRemainingSpace ? dragRemainingSpace : work_area;
    
    // No snaps or no special handling needed - normal tiling
    let tile_info = tile(windows, tileArea);
    let overflow = tile_info.overflow;
    
    if (workspace_windows.length <= 1) {
        overflow = false;
    } else {
        for(let window of workspace_windows)
            if(windowing.isMaximizedOrFullscreen(window))
                overflow = true;
    }

    if(overflow && !keep_oversized_windows && reference_meta_window) { // Overflow clause
        let id = reference_meta_window.get_id();
        let _windows = windows;
        for(let i = 0; i < _windows.length; i++) {
            if(meta_windows[_windows[i].index].get_id() === id) {
                _windows.splice(i, 1);
                break;
            }
        }
        windowing.moveOversizedWindow(reference_meta_window);
        tile_info = tile(_windows, tileArea);
    }
    
    // Use the same area for drawing that was used for tiling
    console.log(`[MOSAIC WM] Drawing tiles - isDragging: ${isDragging}, has dragRemainingSpace: ${!!dragRemainingSpace}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`);
    drawTile(tile_info, tileArea, meta_windows);
    return overflow;
}

/**
 * Calculates minimum acceptable window size for overflow detection
 * 
 * Uses dynamic calculation based on:
 * - Available workspace area
 * - Number of windows that will be tiled
 * - Minimum acceptable dimensions per window
 * 
 * @param {Object} availableSpace - Available area {x, y, width, height}
 * @param {number} windowCount - Total number of windows (including new one)
 * @returns {Object} Minimum size {width, height}
 */
function calculateMinimumWindowSize(availableSpace, windowCount) {
    // Calculate area per window with breathing room (divide by windowCount * 3)
    // The *3 factor ensures windows don't get too cramped
    const areaPerWindow = (availableSpace.width * availableSpace.height) / (windowCount * 3);
    
    // Calculate balanced dimensions (square root gives balanced width/height)
    const size = Math.sqrt(areaPerWindow);
    
    // Apply minimum thresholds to prevent tiny windows
    // Width: minimum 350px, Height: minimum 250px (slightly narrower aspect ratio)
    return {
        width: Math.max(Math.floor(size), 350),
        height: Math.max(Math.floor(size * 0.75), 250)
    };
}

/**
 * Checks if a new window fits in the workspace
 * 
 * This function is called BEFORE adding a window to the workspace
 * to decide if it should go to a new workspace.
 * 
 * Checks:
 * 1. If workspace has maximized/fullscreen window (= completely occupied)
 * 2. If there are snapped windows, uses remaining space for calculation
 * 3. If adding the window would cause overflow in the available layout space
 * 
 * @param {Meta.Window} window - New window to check
 * @param {Meta.Workspace} workspace - Target workspace
 * @param {number} monitor - Monitor index
 * @returns {boolean} True if window fits, false if should go to new workspace
 */
export function canFitWindow(window, workspace, monitor) {
    console.log(`[MOSAIC WM] canFitWindow: Checking if window can fit in workspace ${workspace.index()}`);
    
    // CRITICAL: Fullscreen windows always "fit" - they don't participate in tiling
    // This prevents infinite workspace creation loop for fullscreen games/apps
    if (window.is_fullscreen()) {
        console.log('[MOSAIC WM] canFitWindow: Window is fullscreen - always fits (no overflow)');
        return true;
    }
    
    // Get workspace information
    const working_info = getWorkingInfo(workspace, window, monitor);
    if (!working_info) {
        console.log('[MOSAIC WM] canFitWindow: No working info - cannot fit');
        return false;
    }

    // RULE 1: Workspace with maximized window = completely occupied
    // Cannot receive new apps
    for (const existing_window of working_info.meta_windows) {
        if(windowing.isMaximizedOrFullscreen(existing_window)) {
            console.log('[MOSAIC WM] canFitWindow: Workspace has maximized window - cannot fit');
            return false; // Workspace occupied by maximized window
        }
    }


    // RULE 2: Check for edge-tiled windows and use remaining space
    const edgeTiledWindows = edgeTiling.getEdgeTiledWindows(workspace, monitor);
    let availableSpace = working_info.work_area;
    
    console.log(`[MOSAIC WM] canFitWindow: Found ${edgeTiledWindows.length} edge-tiled windows`);
    
    if (edgeTiledWindows.length > 0) {
        // Check if workspace is fully occupied by edge tiles (e.g., left + right)
        const zones = edgeTiledWindows.map(w => w.zone);
        const hasLeftFull = zones.includes(edgeTiling.TileZone.LEFT_FULL);
        const hasRightFull = zones.includes(edgeTiling.TileZone.RIGHT_FULL);
        const hasLeftQuarters = zones.some(z => z === edgeTiling.TileZone.TOP_LEFT || z === edgeTiling.TileZone.BOTTOM_LEFT);
        const hasRightQuarters = zones.some(z => z === edgeTiling.TileZone.TOP_RIGHT || z === edgeTiling.TileZone.BOTTOM_RIGHT);
        
        if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
            console.log('[MOSAIC WM] canFitWindow: Workspace fully occupied by edge tiles - cannot fit');
            return false; // No space left
        }
        
        // Calculate remaining space after edge tiling
        availableSpace = edgeTiling.calculateRemainingSpace(workspace, monitor);
        console.log(`[MOSAIC WM] canFitWindow: Using remaining space after snap: ${availableSpace.width}x${availableSpace.height}`);
    }

    // RULE 3: Try adding window to layout and see if it fits in available space
    // Only consider non-edge-tiled windows for the layout
    const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
    
    // Get all non-edge-tiled windows (including the new window if it's already in the workspace)
    // This handles both cases:
    // - window-created: new window not yet in workspace
    // - window-added: new window already in workspace (overview drag-drop)
    let windows = working_info.windows.filter(w => 
        !edgeTiledIds.includes(w.id)
    );
    
    console.log(`[MOSAIC WM] canFitWindow: Current non-edge-tiled windows: ${windows.length}`);
    
    // Check if the window being tested is already in the list
    // (happens with window-added signal from overview drag-drop)
    const newWindowId = window.get_id();
    const windowAlreadyInWorkspace = windows.some(w => w.id === newWindowId);
    
    if (!windowAlreadyInWorkspace) {
        // Window not yet in workspace (window-created case)
        // Add a test window with conservative size
        console.log('[MOSAIC WM] canFitWindow: Window not in workspace yet - adding test window');
        
        // Use a very small conservative size for the test window
        // The actual tile() function will resize windows to fit properly
        // This prevents false overflow while still catching genuinely full workspaces
        const estimatedWidth = 200;
        const estimatedHeight = 200;
        
        console.log(`[MOSAIC WM] canFitWindow: Using conservative test size: ${estimatedWidth}x${estimatedHeight}`);
        
        const newWindowDescriptor = new WindowDescriptor(window, windows.length);
        newWindowDescriptor.width = estimatedWidth;
        newWindowDescriptor.height = estimatedHeight;
        
        windows.push(newWindowDescriptor);
    } else {
        console.log('[MOSAIC WM] canFitWindow: Window already in workspace - checking current layout');
    }

    // Calculate layout with all windows in available space
    const tile_result = tile(windows, availableSpace);
    
    console.log(`[MOSAIC WM] canFitWindow: Tile result overflow: ${tile_result.overflow}`);
    
    // If it caused overflow, doesn't fit
    if (tile_result.overflow) {
        console.log('[MOSAIC WM] canFitWindow: Would overflow - cannot fit');
        return false;
    }
    
    console.log('[MOSAIC WM] canFitWindow: Window fits!');
    return true;
}

/**
 * DEPRECATED: Use canFitWindow() ao invés desta função
 * Mantida para compatibilidade com código existente
 */
export function windowFits(window, workspace, monitor) {
    return canFitWindow(window, workspace, monitor);
}