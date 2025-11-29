import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

/**
 * Edge Tiling Zones
 * 
 * 6-zone system:
 * - Left/Right Full: 50% width, 100% height
 * - Corners: 50% width, 50% height (TL, TR, BL, BR)
 */
export const TileZone = {
    NONE: 0,
    LEFT_FULL: 1,
    RIGHT_FULL: 2,
    TOP_LEFT: 3,
    TOP_RIGHT: 4,
    BOTTOM_LEFT: 5,
    BOTTOM_RIGHT: 6,
    FULLSCREEN: 7
};

// Store window states (pre-tile position/size)
const _windowStates = new Map();

// Track if we're currently in an edge tiling operation
let _isEdgeTilingActive = false;
let _activeEdgeTilingWindow = null;

/**
 * Check if edge tiling is currently active (during drag)
 * @returns {boolean}
 */
export function isEdgeTilingActive() {
    return _isEdgeTilingActive;
}

/**
 * Get the window currently being edge-tiled
 * @returns {Meta.Window|null}
 */
export function getActiveEdgeTilingWindow() {
    return _activeEdgeTilingWindow;
}

/**
 * Set edge tiling active state
 * @param {boolean} active
 * @param {Meta.Window|null} window
 */
export function setEdgeTilingActive(active, window = null) {
    console.log(`[MOSAIC WM] Edge tiling state: ${_isEdgeTilingActive} -> ${active}, window: ${window ? window.get_id() : 'null'}`);
    _isEdgeTilingActive = active;
    _activeEdgeTilingWindow = window;
}

/**
 * Check if there are edge-tiled windows on a specific side
 * @param {Meta.Workspace} workspace
 * @param {string} side - 'left' or 'right'
 * @returns {boolean}
 */
function hasEdgeTiledWindows(workspace, side) {
    if (!workspace) return false;
    
    const windows = workspace.list_windows();
    for (const win of windows) {
        const state = _windowStates.get(win.get_id());
        // Only count windows that are CURRENTLY edge-tiled (zone !== NONE)
        if (!state || state.zone === TileZone.NONE || state.zone === TileZone.FULLSCREEN) continue;
        
        // Check if window is on the specified side
        if (side === 'left') {
            if (state.zone === TileZone.LEFT_FULL || 
                state.zone === TileZone.TOP_LEFT || 
                state.zone === TileZone.BOTTOM_LEFT) {
                return true;
            }
        } else if (side === 'right') {
            if (state.zone === TileZone.RIGHT_FULL || 
                state.zone === TileZone.TOP_RIGHT || 
                state.zone === TileZone.BOTTOM_RIGHT) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * Detect which edge tiling zone the cursor is in
 * @param {number} cursorX - Cursor X coordinate
 * @param {number} cursorY - Cursor Y coordinate
 * @param {Object} workArea - Work area rectangle
 * @param {Meta.Workspace} workspace - Current workspace to check for existing windows
 * @returns {number} TileZone enum value
 */
export function detectZone(cursorX, cursorY, workArea, workspace) {
    const threshold = 10; // pixels from edge to trigger
    const thirdY = workArea.height / 3;
    
    // Top edge = fullscreen (like GNOME native behavior)
    if (cursorY < workArea.y + threshold) {
        return TileZone.FULLSCREEN;
    }
    
    // Left edge
    if (cursorX < workArea.x + threshold) {
        // Check if there are already windows on the left side
        const hasLeftWindows = hasEdgeTiledWindows(workspace, 'left');
        
        if (!hasLeftWindows) {
            // No windows on left = always return LEFT_FULL
            return TileZone.LEFT_FULL;
        }
        
        // Has windows = allow quarters
        const relY = cursorY - workArea.y;
        if (relY < thirdY) return TileZone.TOP_LEFT;
        if (relY > workArea.height - thirdY) return TileZone.BOTTOM_LEFT;
        return TileZone.LEFT_FULL;
    }
    
    // Right edge
    if (cursorX > workArea.x + workArea.width - threshold) {
        // Check if there are already windows on the right side
        const hasRightWindows = hasEdgeTiledWindows(workspace, 'right');
        
        if (!hasRightWindows) {
            // No windows on right = always return RIGHT_FULL
            return TileZone.RIGHT_FULL;
        }
        
        // Has windows = allow quarters
        const relY = cursorY - workArea.y;
        if (relY < thirdY) return TileZone.TOP_RIGHT;
        if (relY > workArea.height - thirdY) return TileZone.BOTTOM_RIGHT;
        return TileZone.RIGHT_FULL;
    }
    
    return TileZone.NONE;
}

/**
 * Get rectangle for a specific tile zone
 * @param {number} zone - TileZone enum value
 * @param {Object} workArea - Work area rectangle
 * @returns {Object|null} Rectangle {x, y, width, height} or null
 */
export function getZoneRect(zone, workArea) {
    const halfW = Math.floor(workArea.width / 2);
    const halfH = Math.floor(workArea.height / 2);
    
    switch (zone) {
        case TileZone.LEFT_FULL:
            return { 
                x: workArea.x, 
                y: workArea.y, 
                width: halfW, 
                height: workArea.height 
            };
        case TileZone.RIGHT_FULL:
            return { 
                x: workArea.x + halfW, 
                y: workArea.y, 
                width: workArea.width - halfW, 
                height: workArea.height 
            };
        case TileZone.TOP_LEFT:
            return { 
                x: workArea.x, 
                y: workArea.y, 
                width: halfW, 
                height: halfH 
            };
        case TileZone.TOP_RIGHT:
            return { 
                x: workArea.x + halfW, 
                y: workArea.y, 
                width: workArea.width - halfW, 
                height: halfH 
            };
        case TileZone.BOTTOM_LEFT:
            return { 
                x: workArea.x, 
                y: workArea.y + halfH, 
                width: halfW, 
                height: workArea.height - halfH 
            };
        case TileZone.BOTTOM_RIGHT:
            return { 
                x: workArea.x + halfW, 
                y: workArea.y + halfH, 
                width: workArea.width - halfW, 
                height: workArea.height - halfH 
            };
        case TileZone.FULLSCREEN:
            return { 
                x: workArea.x, 
                y: workArea.y, 
                width: workArea.width, 
                height: workArea.height 
            };
        default:
            return null;
    }
}

/**
 * Save window's current state before tiling
 * @param {Meta.Window} window
 */
export function saveWindowState(window) {
    const winId = window.get_id();
    const existingState = _windowStates.get(winId);
    
    // Only save if window is NOT already edge-tiled
    // This preserves the original pre-tiling dimensions
    if (existingState && existingState.zone !== TileZone.NONE) {
        console.log(`[MOSAIC WM] Window ${winId} already has edge tile state, not overwriting`);
        return;
    }
    
    const frame = window.get_frame_rect();
    _windowStates.set(winId, {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        zone: TileZone.NONE
    });
    console.log(`[MOSAIC WM] Saved window ${winId} PRE-TILING state: ${frame.width}x${frame.height}`);
}

/**
 * Get saved window state
 * @param {Meta.Window} window
 * @returns {Object|undefined} Saved state or undefined
 */
export function getWindowState(window) {
    return _windowStates.get(window.get_id());
}

/**
 * Get all edge-tiled windows in a workspace
 * Replaces snap.getSnappedWindows()
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @returns {Array<{window: Meta.Window, zone: number}>}
 */
export function getEdgeTiledWindows(workspace, monitor) {
    const windows = workspace.list_windows().filter(w => 
        w.get_monitor() === monitor && 
        !w.is_skip_taskbar() &&
        w.window_type === Meta.WindowType.NORMAL
    );
    
    return windows
        .map(w => ({window: w, state: getWindowState(w)}))
        .filter(({state}) => state && state.zone !== TileZone.NONE)
        .map(({window, state}) => ({window, zone: state.zone}));
}

/**
 * Get all non-edge-tiled windows in a workspace
 * Replaces snap.getNonSnappedWindows()
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @returns {Array<Meta.Window>}
 */
export function getNonEdgeTiledWindows(workspace, monitor) {
    const windows = workspace.list_windows().filter(w => 
        w.get_monitor() === monitor && 
        !w.is_skip_taskbar() &&
        w.window_type === Meta.WindowType.NORMAL
    );
    
    return windows.filter(w => {
        const state = getWindowState(w);
        return !state || state.zone === TileZone.NONE;
    });
}

/**
 * Calculate remaining workspace space after edge-tiled windows
 * Replaces snap.calculateRemainingSpace()
 * @param {Meta.Workspace} workspace
 * @param {number} monitor
 * @returns {Object} Remaining space rectangle {x, y, width, height}
 */
export function calculateRemainingSpace(workspace, monitor) {
    const workArea = workspace.get_work_area_for_monitor(monitor);
    const edgeTiledWindows = getEdgeTiledWindows(workspace, monitor);
    
    if (edgeTiledWindows.length === 0) {
        return workArea;
    }
    
    // Check for left/right full tiles
    const hasLeftFull = edgeTiledWindows.some(w => w.zone === TileZone.LEFT_FULL);
    const hasRightFull = edgeTiledWindows.some(w => w.zone === TileZone.RIGHT_FULL);
    
    // Check for quarter tiles
    const hasLeftQuarters = edgeTiledWindows.some(w => 
        w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT
    );
    const hasRightQuarters = edgeTiledWindows.some(w => 
        w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT
    );
    
    const halfWidth = Math.floor(workArea.width / 2);
    
    // If left side is occupied (full or quarters), remaining space is on the right
    if (hasLeftFull || hasLeftQuarters) {
        return {
            x: workArea.x + halfWidth,
            y: workArea.y,
            width: workArea.width - halfWidth,
            height: workArea.height
        };
    }
    
    // If right side is occupied (full or quarters), remaining space is on the left
    if (hasRightFull || hasRightQuarters) {
        return {
            x: workArea.x,
            y: workArea.y,
            width: halfWidth,
            height: workArea.height
        };
    }
    
    // No full/quarter tiles, return full work area
    return workArea;
}

/**
 * Clear saved window state
 * @param {Meta.Window} window
 */
export function clearWindowState(window) {
    _windowStates.delete(window.get_id());
}

/**
 * Check if window is currently edge-tiled
 * @param {Meta.Window} window
 * @returns {boolean}
 */
export function isEdgeTiled(window) {
    const state = _windowStates.get(window.get_id());
    return state && state.zone !== TileZone.NONE;
}

/**
 * Check if window can be resized to target dimensions
 * @param {Meta.Window} window
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {boolean}
 */
function canResize(window, targetWidth, targetHeight) {
    // Check window type - only normal windows can be tiled
    if (window.window_type !== 0) { // Meta.WindowType.NORMAL
        console.log(`[MOSAIC WM] Window type ${window.window_type} cannot be edge-tiled`);
        return false;
    }
    
    // Check if window allows resize
    if (window.allows_resize && !window.allows_resize()) {
        console.log(`[MOSAIC WM] Window does not allow resize`);
        return false;
    }
    
    return true;
}

/**
 * Apply edge tiling to a window
 * @param {Meta.Window} window
 * @param {number} zone - TileZone enum value
 * @param {Object} workArea - Work area rectangle
 * @returns {boolean} Success
 */
export function applyTile(window, zone, workArea) {
    // Save current window state before tiling
    saveWindowState(window);
    
    // Special case: fullscreen
    if (zone === TileZone.FULLSCREEN) {
        window.maximize(); // No arguments needed
        
        // Update state
        const state = _windowStates.get(window.get_id());
        if (state) {
            state.zone = zone;
        }
        
        console.log(`[MOSAIC WM] Maximized window ${window.get_id()}`);
        return true;
    }
    
    const rect = getZoneRect(zone, workArea);
    if (!rect) {
        console.log(`[MOSAIC WM] Invalid zone ${zone}`);
        return false;
    }
    
    // Check if window can be resized
    if (!canResize(window, rect.width, rect.height)) {
        return false;
    }
    
    // Capture winId before callback
    const winId = window.get_id();
    
    // Unmaximize first (no arguments needed)
    window.unmaximize();
    
    // Apply tile using idle callback for reliability
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        
        // Note: Square corners feature deferred - requires GLSL shaders
        // See interactive_resize_task.md for future implementation

        // Update state
        const state = _windowStates.get(winId);
        if (state) {
            state.zone = zone;
        }
        
        console.log(`[MOSAIC WM] Applied edge tile zone ${zone} to window ${winId}`);
        return GLib.SOURCE_REMOVE;
    });
    
    return true;
}

/**
 * Remove edge tiling and restore window to previous state
 * @param {Meta.Window} window
 * @param {Function} callback - Optional callback to call after restoration completes
 */
export function removeTile(window, callback = null) {
    const winId = window.get_id();
    const savedState = _windowStates.get(winId);

    if (!savedState || savedState.zone === TileZone.NONE) {
        console.log(`[MOSAIC WM] removeTile: Window ${winId} is not edge-tiled`);
        if (callback) callback();
        return;
    }
    
    console.log(`[MOSAIC WM] removeTile: Removing tile from window ${winId}, zone=${savedState.zone}`);
    
    // Note: Square corners restoration deferred

    // Clear zone BEFORE restoring to prevent hasEdgeTiledWindows from detecting this window
    // Make a copy of the state to preserve dimensions
    const savedWidth = savedState.width;
    const savedHeight = savedState.height;
    const savedX = savedState.x;
    const savedY = savedState.y;
    
    console.log(`[MOSAIC WM] removeTile: Saved dimensions: ${savedWidth}x${savedHeight} at (${savedX}, ${savedY})`);
    
    savedState.zone = TileZone.NONE;
    
    // Get current window position before restoration
    const currentFrame = window.get_frame_rect();
    console.log(`[MOSAIC WM] removeTile: Current window position BEFORE restore: (${currentFrame.x}, ${currentFrame.y}), size: ${currentFrame.width}x${currentFrame.height}`);
    
    // Unmaximize first
    if (window.maximized_horizontally || window.maximized_vertically) {
        window.unmaximize(Meta.MaximizeFlags.BOTH);
    }
    
    // Restore to cursor position instead of saved position to avoid flicker
    // The saved position is often off-screen (where the window was when dragged to edge)
    // Restoring to cursor position provides smooth UX with no visible jump
    const [cursorX, cursorY] = global.get_pointer();
    const restoredX = cursorX - (savedWidth / 2);  // Center window on cursor
    const restoredY = cursorY - 20;  // Slightly below cursor (titlebar offset)
    
    console.log(`[MOSAIC WM] removeTile: Restoring to cursor position (${restoredX}, ${restoredY}) instead of saved (${savedX}, ${savedY})`);
    window.move_resize_frame(false, restoredX, restoredY, savedWidth, savedHeight);
    
    // Wait for the window manager to process the resize before calling callback
    // Using a timeout to ensure the window has actually been resized
    if (callback) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            // Check position after restoration
            const afterFrame = window.get_frame_rect();
            console.log(`[MOSAIC WM] removeTile: Window position AFTER restore: (${afterFrame.x}, ${afterFrame.y}), size: ${afterFrame.width}x${afterFrame.height}`);
            
            console.log(`[MOSAIC WM] removeTile: Calling callback after restoration`);
            callback();
            
            return GLib.SOURCE_REMOVE;
        });
    }
    
    console.log(`[MOSAIC WM] Removed edge tile from window ${window.get_id()}, restored to ${savedWidth}x${savedHeight}`);
}

/**
 * Clear all window states (cleanup)
 */
export function clearAllStates() {
    _windowStates.clear();
}
