/**
 * Detects if a window is in a snap position (tiled to half or quarter of screen)
 * 
 * Snap positions detected:
 * - left: Left half of screen
 * - right: Right half of screen
 * - top-left: Top-left quarter
 * - top-right: Top-right quarter
 * - bottom-left: Bottom-left quarter
 * - bottom-right: Bottom-right quarter
 * 
 * @param {Meta.Window} window - Window to check
 * @param {Object} workArea - Work area {x, y, width, height}
 * @returns {{snapped: boolean, zone: string|null}} Snap state and zone
 */

import * as windowing from './windowing.js';

export function detectSnap(window, workArea) {
    const frame = window.get_frame_rect();
    const tolerance = 10; // Pixels of tolerance for snap detection
    
    // Helper to check if two values are approximately equal
    const approxEqual = (a, b) => Math.abs(a - b) < tolerance;
    
    // Check left half snap
    if (approxEqual(frame.x, workArea.x) &&
        approxEqual(frame.y, workArea.y) &&
        approxEqual(frame.width, workArea.width / 2) &&
        approxEqual(frame.height, workArea.height)) {
        return { snapped: true, zone: 'left' };
    }
    
    // Check right half snap
    if (approxEqual(frame.x, workArea.x + workArea.width / 2) &&
        approxEqual(frame.y, workArea.y) &&
        approxEqual(frame.width, workArea.width / 2) &&
        approxEqual(frame.height, workArea.height)) {
        return { snapped: true, zone: 'right' };
    }
    
    // Check quarter snaps
    const quarterWidth = workArea.width / 2;
    const quarterHeight = workArea.height / 2;
    
    // Top-left quarter
    if (approxEqual(frame.x, workArea.x) &&
        approxEqual(frame.y, workArea.y) &&
        approxEqual(frame.width, quarterWidth) &&
        approxEqual(frame.height, quarterHeight)) {
        return { snapped: true, zone: 'top-left' };
    }
    
    // Top-right quarter
    if (approxEqual(frame.x, workArea.x + quarterWidth) &&
        approxEqual(frame.y, workArea.y) &&
        approxEqual(frame.width, quarterWidth) &&
        approxEqual(frame.height, quarterHeight)) {
        return { snapped: true, zone: 'top-right' };
    }
    
    // Bottom-left quarter
    if (approxEqual(frame.x, workArea.x) &&
        approxEqual(frame.y, workArea.y + quarterHeight) &&
        approxEqual(frame.width, quarterWidth) &&
        approxEqual(frame.height, quarterHeight)) {
        return { snapped: true, zone: 'bottom-left' };
    }
    
    // Bottom-right quarter
    if (approxEqual(frame.x, workArea.x + quarterWidth) &&
        approxEqual(frame.y, workArea.y + quarterHeight) &&
        approxEqual(frame.width, quarterWidth) &&
        approxEqual(frame.height, quarterHeight)) {
        return { snapped: true, zone: 'bottom-right' };
    }
    
    return { snapped: false, zone: null };
}

/**
 * Gets all windows that are currently snapped in a workspace
 * 
 * @param {Meta.Workspace} workspace - Workspace to check
 * @param {number} monitor - Monitor index
 * @returns {Array<{window: Meta.Window, zone: string}>} Snapped windows with their zones
 */
export function getSnappedWindows(workspace, monitor) {
    const windows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
    const workArea = workspace.get_work_area_for_monitor(monitor);
    const snapped = [];
    
    for (const window of windows) {
        const snapState = detectSnap(window, workArea);
        if (snapState.snapped) {
            snapped.push({
                window: window,
                zone: snapState.zone
            });
        }
    }
    
    return snapped;
}

/**
 * Calculates the remaining space in a workspace after accounting for snapped windows
 * 
 * Rules:
 * - 1 window snapped left → remaining space is right half
 * - 1 window snapped right → remaining space is left half
 * - 2 windows snapped (left + right) → no remaining space
 * - Quarter snaps → calculate based on occupied quarters
 * 
 * @param {Meta.Workspace} workspace - Workspace
 * @param {number} monitor - Monitor index
 * @returns {Object|null} Remaining work area {x, y, width, height} or null if fully occupied
 */
export function calculateRemainingSpace(workspace, monitor) {
    const snappedWindows = getSnappedWindows(workspace, monitor);
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    if (snappedWindows.length === 0) {
        // No snapped windows, full space available
        return workArea;
    }
    
    // Check for two half-snaps (left + right = fully occupied)
    const zones = snappedWindows.map(w => w.zone);
    if (zones.includes('left') && zones.includes('right')) {
        return null; // Fully occupied
    }
    
    // Single half-snap
    if (snappedWindows.length === 1) {
        const zone = snappedWindows[0].zone;
        
        if (zone === 'left') {
            // Window snapped to LEFT → remaining space is RIGHT half
            return {
                x: workArea.x + workArea.width / 2,
                y: workArea.y,
                width: workArea.width / 2,
                height: workArea.height
            };
        }
        
        if (zone === 'right') {
            // Window snapped to RIGHT → remaining space is LEFT half
            return {
                x: workArea.x,
                y: workArea.y,
                width: workArea.width / 2,
                height: workArea.height
            };
        }
        
        // Quarter snap - for now, return full area
        // TODO: Calculate precise remaining space for quarter snaps
        return workArea;
    }
    
    // Multiple snaps - complex case, return full area for now
    // TODO: Calculate precise remaining space for multiple snaps
    return workArea;
}

/**
 * Gets windows that are NOT snapped in a workspace
 * 
 * @param {Meta.Workspace} workspace - Workspace
 * @param {number} monitor - Monitor index
 * @returns {Meta.Window[]} Non-snapped windows
 */
export function getNonSnappedWindows(workspace, monitor) {
    const windows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
    const workArea = workspace.get_work_area_for_monitor(monitor);
    
    return windows.filter(window => {
        const snapState = detectSnap(window, workArea);
        return !snapState.snapped;
    });
}
