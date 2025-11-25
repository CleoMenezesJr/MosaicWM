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

// Module-level state for tiling operations
var masks = []; // Visual feedback masks for windows being dragged
var working_windows = []; // Current set of window descriptors being tiled
var tmp_swap = []; // Temporary swap for preview during drag

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
     * 
     * @param {Meta.Window[]} meta_windows - Array of actual windows
     * @param {number} x - New X position
     * @param {number} y - New Y position
     */
    draw(meta_windows, x, y) {
        meta_windows[this.index].move_frame(false,
                                            x,
                                            y);
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
    
    // Quick overflow check based on area
    if (totalRequiredArea > availableArea * SPACE_USAGE_THRESHOLD) {
        overflow = true;
    }

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
    return {
        x: x,
        y: y,
        overflow: overflow,
        vertical: vertical,
        levels: levels
    }
}

function swapElements (array, index1, index2) {
    if(!array[index1] || !array[index2])
        return; // Prevent making swaps for elements that do not exist
    let tmp = array[index1];
    array[index1] = array[index2];
    array[index2] = tmp;
}

export function setTmpSwap(id1, id2) {
    let index1 = null
    let index2 = null;

    for(let i = 0; i < working_windows.length; i++) {
        let window = working_windows[i];
        if(window.id === id1 && index1 === null)
            index1 = i;
        if(window.id === id2 && index2 === null)
            index2 = i;
    }
    if(index1 !== null && index2 !== null) {
        if( index1 === index2 ||
            (tmp_swap[0] === index2 && tmp_swap[1] === index1))
            return;
        tmp_swap = [index1, index2];
    } else
        console.error("Could not find both indexes for windows");
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
    if(tmp_swap.length !== 0)
        swapElements(array, tmp_swap[0], tmp_swap[1]);
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

function getWorkingInfo(workspace, window, monitor) {
    if(!workspace) // Failsafe for undefined workspace
        return false;

    let current_monitor = null;
    if(window)
        current_monitor = window.get_monitor();
    else
        current_monitor = monitor;
    if(current_monitor === null || current_monitor === false)
        return false;

    let meta_windows = windowing.getMonitorWorkspaceWindows(workspace, current_monitor);

    // If any window is maximized or fullscreen, we cannot tile this workspace
    // These windows should be in their own workspace
    for (const window of meta_windows) {
        if (windowing.isMaximizedOrFullscreen(window))
            return false;
    }

    // Put needed window info into an enum so it can be transferred between arrays
    let _windows = windowsToDescriptors(meta_windows, current_monitor, window);
    // Apply window layout swaps
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

export function tileWorkspaceWindows(workspace, reference_meta_window, _monitor, keep_oversized_windows) {
    let working_info = getWorkingInfo(workspace, reference_meta_window, _monitor);
    if(!working_info) return;
    let meta_windows = working_info.meta_windows;
    let windows = working_info.windows;
    let work_area = working_info.work_area;
    let monitor = working_info.monitor;

    const workspace_windows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
    let tile_info = tile(windows, work_area);
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
        tile_info = tile(_windows, work_area);
    }
    drawTile(tile_info, work_area, meta_windows);
    return overflow;
}

/**
 * Checks if a new window fits in the workspace
 * 
 * This function is called BEFORE adding a window to the workspace
 * to decide if it should go to a new workspace.
 * 
 * Checks:
 * 1. If workspace has maximized/fullscreen window (= completely occupied)
 * 2. If adding the window would cause overflow in the layout
 * 
 * @param {Meta.Window} window - New window to check
 * @param {Meta.Workspace} workspace - Target workspace
 * @param {number} monitor - Monitor index
 * @returns {boolean} True if window fits, false if should go to new workspace
 */
export function canFitWindow(window, workspace, monitor) {
    // Get workspace information
    let working_info = getWorkingInfo(workspace, window, monitor);
    if(!working_info) return false;
    
    // If window is already in this workspace, it always fits
    if(workspace.index() === window.get_workspace().index()) return true;

    // RULE 1: Workspace with maximized window = completely occupied
    // Cannot receive new apps
    for(let existing_window of working_info.meta_windows) {
        if(windowing.isMaximizedOrFullscreen(existing_window)) {
            return false; // Workspace occupied by maximized window
        }
    }

    // RULE 2: Try adding window to layout and see if it fits
    let windows = working_info.windows;
    windows.push(new WindowDescriptor(window, windows.length));

    // Calculate layout with the new window
    const tile_result = tile(windows, working_info.work_area);
    
    // If it caused overflow, doesn't fit
    return !tile_result.overflow;
}

/**
 * DEPRECATED: Use canFitWindow() ao invés desta função
 * Mantida para compatibilidade com código existente
 */
export function windowFits(window, workspace, monitor) {
    return canFitWindow(window, workspace, monitor);
}