/**
 * Windowing Module
 * 
 * This module handles window management operations including:
 * - Moving windows between workspaces
 * - Checking window states and properties
 * - Workspace navigation
 * - Window filtering and exclusion logic
 */

import Meta from 'gi://Meta';
import * as tiling from './tiling.js';
import * as edgeTiling from './edgeTiling.js';

/**
 * Gets the current timestamp from GNOME Shell.
 * Used for workspace activation and window focus operations.
 * 
 * @returns {number} Current timestamp in milliseconds
 */
function getTimestamp() {
    return global.get_current_time();
}

/**
 * Gets the index of the primary monitor.
 * 
 * @returns {number} Primary monitor index
 */
function getPrimaryMonitor() {
    return global.display.getPrimaryMonitor();
}

/**
 * Gets the currently active workspace.
 * 
 * @returns {Meta.Workspace} The active workspace
 */
export function getWorkspace() {
    return global.workspace_manager.get_active_workspace();
}

/**
 * Gets all windows across all workspaces.
 * 
 * @returns {Meta.Window[]} Array of all windows
 */
function getAllWindows() {
    return global.display.list_all_windows();
}

/**
 * Finds and returns the currently focused window.
 * 
 * @returns {Meta.Window|undefined} The focused window, or undefined if none
 */
function getFocusedWindow() {
    let windows = getAllWindows();
    for(let window of windows) {
        if(window.has_focus())
            return window;
    }
}

/**
 * Gets all windows in the active workspace for a specific monitor.
 * 
 * @param {number} monitor - Monitor index
 * @param {boolean} allow_unrelated - Whether to include unrelated windows (dialogs, etc.)
 * @returns {Meta.Window[]} Array of windows
 */
function getAllWorkspaceWindows(monitor, allow_unrelated) {
    return getMonitorWorkspaceWindows(getWorkspace(), monitor, allow_unrelated);
}

/**
 * Gets all windows in a specific workspace and monitor.
 * Filters windows by monitor and optionally by whether they're "related" (normal windows).
 * 
 * @param {Meta.Workspace} workspace - The workspace to get windows from
 * @param {number} monitor - Monitor index to filter by
 * @param {boolean} allow_unrelated - If true, include dialogs and other unrelated windows
 * @returns {Meta.Window[]} Array of filtered windows
 */
export function getMonitorWorkspaceWindows(workspace, monitor, allow_unrelated) {
    let _windows = [];
    let windows = workspace.list_windows();
    for(let window of windows)
        if(window.get_monitor() === monitor && (isRelated(window) || allow_unrelated))
            _windows.push(window);
    return _windows;
}

/**
 * Gets the index of a window in its workspace's window list.
 * 
 * @param {Meta.Window} window - The window to find
 * @returns {number|null} Index of the window, or null if not found
 */
function getIndex(window) {
    let id = window.get_id();
    let meta_windows = windowing.getMonitorWorkspaceWindows(window.get_workspace(), window.get_monitor());
    for(let i = 0; i < meta_windows.length; i++)
        if(meta_windows[i].id === id)
            return i;
    return null;
}

/**
 * Moves a window back to the previous workspace.
 * Only moves if there's space in the previous workspace.
 * 
 * @param {Meta.Window} window - The window to move back
 * @returns {Meta.Workspace} The workspace the window was moved to, or current workspace if move failed
 */
export function moveBackWindow(window) {
    let workspace = window.get_workspace();
    let active = workspace.active;
    let previous_workspace = workspace.get_neighbor(-3);
    if(!previous_workspace) {
        console.error("There is no workspace to the left.");
        return;
    }
    if(!tiling.windowFits(window, previous_workspace)) // Make sure there is space for the window in the previous workspace
        return workspace;
    window.change_workspace(previous_workspace); // Move window to previous workspace
    if(active)
        previous_workspace.activate(getTimestamp()); // Switch to it
    return previous_workspace;
}

/**
 * Moves a window that doesn't fit in the current workspace to a new workspace.
 * This is called when a window is too large (maximized/fullscreen) or when there's no space.
 * 
 * @param {Meta.Window} window - The window to move
 * @returns {Meta.Workspace} The new workspace where the window was moved
 */
/**
 * Attempts to tile a window with an existing edge-tiled window in the workspace.
 * If the window cannot be tiled (e.g., fixed size), returns it to the previous workspace.
 * 
 * @param {Meta.Window} window - The window to tile
 * @param {Meta.Window} edgeTiledWindow - The existing edge-tiled window
 * @param {Meta.Workspace} previousWorkspace - The workspace to return to if tiling fails
 * @returns {boolean} True if tiling succeeded, false if window was returned
 */
export function tryTileWithSnappedWindow(window, edgeTiledWindow, previousWorkspace) {
    // Get the edge tiling state of the existing window
    const workspace = window.get_workspace();
    const monitor = window.get_monitor();
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    const tileState = edgeTiling.getWindowState(edgeTiledWindow);
    
    if (!tileState || tileState.zone === edgeTiling.TileZone.NONE) {
        console.log('[MOSAIC WM] Existing window is not edge-tiled, cannot tile');
        return false;
    }
    
    // Determine opposite side for tiling based on edge tiling zone
    let direction;
    if (tileState.zone === edgeTiling.TileZone.LEFT_FULL ||
        tileState.zone === edgeTiling.TileZone.TOP_LEFT ||
        tileState.zone === edgeTiling.TileZone.BOTTOM_LEFT) {
        direction = 'right';
    } else if (tileState.zone === edgeTiling.TileZone.RIGHT_FULL ||
               tileState.zone === edgeTiling.TileZone.TOP_RIGHT ||
               tileState.zone === edgeTiling.TileZone.BOTTOM_RIGHT) {
        direction = 'left';
    } else {
        console.log('[MOSAIC WM] Unsupported edge tile zone for dual-tiling');
        return false;
    }
    
    // Calculate available tile space (half screen)
    const halfWidth = Math.floor(workArea.width / 2);
    let targetX, targetY, targetWidth, targetHeight;
    
    if (direction === 'left') {
        targetX = workArea.x;
        targetY = workArea.y;
        targetWidth = halfWidth;
        targetHeight = workArea.height;
    } else { // right
        targetX = workArea.x + halfWidth;
        targetY = workArea.y;
        targetWidth = workArea.width - halfWidth;
        targetHeight = workArea.height;
    }
    
    
    // Tile the window by positioning it
    try {
        // IMPORTANT: Save window state BEFORE tiling
        // This allows the auto-tiled window to exit tiling like a drag-and-drop tiled window
        edgeTiling.saveWindowState(window);
        
        window.unmaximize();
        window.move_resize_frame(false, targetX, targetY, targetWidth, targetHeight);
        
        // Update window state to mark it as edge-tiled
        // This makes it behave exactly like a drag-and-drop tiled window
        const zone = direction === 'left' ? edgeTiling.TileZone.LEFT_FULL : edgeTiling.TileZone.RIGHT_FULL;
        const state = edgeTiling.getWindowState(window);
        if (state) {
            state.zone = zone;
            console.log(`[MOSAIC WM] Dual-tiling: Updated window ${window.get_id()} state to zone ${zone}`);
        }
        
        console.log(`[MOSAIC WM] Successfully dual-tiled window ${window.get_wm_class()} to ${direction} (${targetWidth}x${targetHeight})`);
        return true;
    } catch (error) {
        console.log(`[MOSAIC WM] Failed to tile window: ${error.message}`);
        if (previousWorkspace) {
            window.change_workspace(previousWorkspace);
        }
        return false;
    }
}

export function moveOversizedWindow(window) {
    let previous_workspace = window.get_workspace();
    let new_workspace = global.workspace_manager.append_new_workspace(false, getTimestamp());
    let monitor = window.get_monitor();

    window.change_workspace(new_workspace);
    global.workspace_manager.reorder_workspace(new_workspace, previous_workspace.index() + 1);

    let switchFocusToMovedWindow = previous_workspace.active;
    if (switchFocusToMovedWindow) {
        new_workspace.activate(getTimestamp());
    }

    return new_workspace;
}

/**
 * Checks if a window is on the primary monitor.
 * 
 * @param {Meta.Window} window - The window to check
 * @returns {boolean} True if on primary monitor, false otherwise
 */
export function isPrimary(window) {
    if(window.get_monitor() === getPrimaryMonitor())
        return true;
    return false;
}

/**
 * List of WM_CLASS names that should be excluded from tiling.
 * Currently only includes GNOME's builtin screenshot/screencast app
 * which causes performance issues during screen recording.
 */
const BLACKLISTED_WM_CLASSES = [
    'org.gnome.Screenshot',       // GNOME Screenshot/Screencast (builtin)
];

/**
 * Checks if a window should be excluded from tiling.
 * Windows are excluded if they are not related (dialogs, etc.), 
 * if they are minimized, or if they are in the blacklist.
 * 
 * @param {Meta.Window} meta_window - The window to check
 * @returns {boolean} True if the window should be excluded from tiling, false otherwise
 */
export function isExcluded(meta_window) {
    // Check if window is not related or minimized
    if (!isRelated(meta_window) || meta_window.minimized) {
        return true;
    }
    
    // Check if window is in blacklist
    const wmClass = meta_window.get_wm_class();
    if (wmClass && BLACKLISTED_WM_CLASSES.includes(wmClass)) {
        console.log(`[MOSAIC WM] Window excluded (blacklisted): ${wmClass}`);
        return true;
    }
    
    return false;
}

/**
 * Checks if a window is a "related" window that should be tiled.
 * Related windows are normal windows (not dialogs, not on all workspaces).
 * 
 * @param {Meta.Window} meta_window - The window to check
 * @returns {boolean} True if the window should be tiled, false otherwise
 */
export function isRelated(meta_window) {
    // Exclude attached dialogs
    if (meta_window.is_attached_dialog()) {
        return false;
    }
    
    // Exclude non-normal window types (0 = META_WINDOW_NORMAL)
    if (meta_window.window_type !== 0) {
        return false;
    }
    
    // Exclude windows on all workspaces
    if (meta_window.is_on_all_workspaces()) {
        return false;
    }
    
    // Exclude transient windows (modals with parent window)
    // This catches modal dialogs that have window_type === 0
    if (meta_window.get_transient_for() !== null) {
        const wmClass = meta_window.get_wm_class();
        console.log(`[MOSAIC WM] Excluding transient/modal window: ${wmClass}`);
        return false;
    }
    
    return true;
}

/**
 * Checks if a window is maximized or in fullscreen mode.
 * This is used to determine if a window should be moved to a separate workspace.
 * 
 * @param {Meta.Window} window - The window to check
 * @returns {boolean} True if the window is maximized or fullscreen, false otherwise
 */
export function isMaximizedOrFullscreen(window) {
    if((window.maximized_horizontally === true && window.maximized_vertically === true) || window.is_fullscreen()) {
        return true;
    } else {
        return false;
    }
}

/**
 * Navigates to a previous workspace when the current one becomes empty.
 * Tries to navigate left first, then right if left is not available.
 * 
 * @param {Meta.Workspace} workspace - The current workspace
 * @param {boolean} condition - Whether to actually perform the navigation
 */
export function renavigate(workspace, condition) {
    let previous_workspace = workspace.get_neighbor(-3);

    if(previous_workspace === 1 || previous_workspace.index() === workspace.index() || !previous_workspace) {
        previous_workspace = workspace.get_neighbor(-4); // The new workspace will be the one on the right instead.
        // Recheck to see if it is still a problematic workspace
        if( previous_workspace === 1 ||
            previous_workspace.index() === workspace.index() ||
            previous_workspace.index() === global.workspace_manager.get_n_workspaces() - 1)
            return;
    }
    
    if( condition &&
        workspace.index() !== global.workspace_manager.get_n_workspaces() - 1)
    {
        previous_workspace.activate(getTimestamp());
    }
}
