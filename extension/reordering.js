/**
 * Reordering Module
 * 
 * This module handles manual window reordering via drag-and-drop.
 * It provides visual feedback during dragging and manages temporary
 * window swaps that can be applied or cancelled.
 */

import * as tiling from './tiling.js';
import * as windowing from './windowing.js';
import * as constants from './constants.js';
import * as snap from './snap.js';

// Module state for drag operations
var dragStart = false; // Whether a drag operation is in progress
var dragTimeout; // Timeout ID for drag update loop

/**
 * Calculates the distance from the cursor to the center of a window frame.
 * Used to determine which window is closest to the cursor during drag operations.
 * 
 * @param {Object} cursor - Cursor position {x, y}
 * @param {Object} frame - Window frame {x, y, width, height}
 * @returns {number} Euclidean distance from cursor to window center
 */
export function cursorDistance(cursor, frame) {
    let x = cursor.x - (frame.x + frame.width / 2);
    let y = cursor.y - (frame.y + frame.height / 2);
    return Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
}

/**
 * Main drag loop function.
 * Continuously updates window positions during a drag operation.
 * Finds the window closest to the cursor and swaps positions with the dragged window.
 * 
 * @param {Meta.Window} meta_window - The window being dragged
 * @param {Object} child_frame - Original frame of the dragged window
 * @param {number} id - ID of the dragged window
 * @param {WindowDescriptor[]} windows - Array of window descriptors
 */
export function drag(meta_window, child_frame, id, windows) {
    let workspace = meta_window.get_workspace();
    let monitor = meta_window.get_monitor();
    let workArea = workspace.get_work_area_for_monitor(monitor);

    // Get current cursor position
    let _cursor = global.get_pointer();
    let cursor = {
        x: _cursor[0],
        y: _cursor[1]
    }
    
    // SNAP AWARENESS: Filter out snapped windows from reordering
    // Snapped windows stay in place, only non-snapped can be reordered
    const snappedWindows = snap.getSnappedWindows(workspace, monitor);
    const snappedIds = snappedWindows.map(s => s.window.get_id());
    
    // Filter windows to only non-snapped ones for reordering
    const reorderableWindows = windows.filter(w => !snappedIds.includes(w.id));
    
    // If dragged window is snapped, don't allow it to be reordered
    // But don't block the entire drag operation
    if (snappedIds.includes(id)) {
        // Snapped window can't be reordered, just return without doing anything
        if(dragStart)
            dragTimeout = setTimeout(() => { drag(meta_window, child_frame, id, windows); }, constants.DRAG_UPDATE_INTERVAL_MS);
        return;
    }

    // Find the window closest to the cursor (only among non-snapped windows)
    let minimum_distance = Infinity;
    let target_id = null;
    for(let window of reorderableWindows) {
        let distance = cursorDistance(cursor, window);
        if(distance < minimum_distance)
        {
            minimum_distance = distance;
            target_id = window.id;
        }
    }

    // Set up temporary swap if cursor is over a different window
    if(target_id === id || target_id === null) {
        tiling.clearTmpSwap();
        console.log('[MOSAIC WM] Drag: No swap (cursor not over another window)');
    } else {
        tiling.setTmpSwap(id, target_id);
        console.log(`[MOSAIC WM] Drag: Setting swap ${id} <-> ${target_id}`);
    }

    // Re-tile with the temporary swap to show preview
    // NOTE: This should maintain drag mode to use dragRemainingSpace
    if(tiling.tileWorkspaceWindows(workspace, null, monitor)) {
        tiling.clearTmpSwap();
        tiling.tileWorkspaceWindows(workspace, null, monitor)
    }

    // Continue drag loop if still dragging
    if(dragStart)
        dragTimeout = setTimeout(() => { drag(meta_window, child_frame, id, windows); }, constants.DRAG_UPDATE_INTERVAL_MS);
}

/**
 * Starts a drag operation for a window.
 * Creates a visual mask for the dragged window and begins the drag loop.
 * 
 * @param {Meta.Window} meta_window - The window being dragged
 */
export function startDrag(meta_window) {
    let workspace = meta_window.get_workspace()
    let monitor = meta_window.get_monitor();
    let meta_windows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
    
    // SNAP AWARENESS: Detect snapped windows and calculate remaining space
    const snappedWindows = snap.getSnappedWindows(workspace, monitor);
    const snappedIds = snappedWindows.map(s => s.window.get_id());
    
    // Filter to only non-snapped windows for reordering
    const nonSnappedMetaWindows = meta_windows.filter(w => !snappedIds.includes(w.get_id()));
    console.log(`[MOSAIC WM] startDrag: Total windows: ${meta_windows.length}, Snapped: ${snappedWindows.length}, Non-snapped: ${nonSnappedMetaWindows.length}`);
    
    
    // Apply swaps only to non-snapped windows
    tiling.applySwaps(workspace, nonSnappedMetaWindows);
    
    // Create descriptors only for non-snapped windows
    let descriptors = tiling.windowsToDescriptors(nonSnappedMetaWindows, monitor);
    
    // Calculate remaining space if there are snaps
    let remainingSpace = null;
    if (snappedWindows.length > 0) {
        remainingSpace = snap.calculateRemainingSpace(workspace, monitor);
        console.log(`[MOSAIC WM] startDrag: Remaining space for drag: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
    }

    // Create visual mask for the dragged window
    tiling.createMask(meta_window);
    tiling.clearTmpSwap();
    
    // Enable drag mode with remaining space
    tiling.enableDragMode(remainingSpace);

    dragStart = true;
    drag(meta_window, meta_window.get_frame_rect(), meta_window.get_id(), JSON.parse(JSON.stringify(descriptors)));
}

/**
 * Stops a drag operation.
 * Cleans up visual masks and optionally applies the swap to make it permanent.
 * 
 * @param {Meta.Window} meta_window - The window that was being dragged
 * @param {boolean} skip_apply - If true, don't apply the swap (cancel the drag)
 */
export function stopDrag(meta_window, skip_apply) {
    let workspace = meta_window.get_workspace();
    dragStart = false;
    clearTimeout(dragTimeout);
    
    // Disable drag mode to re-enable snap logic
    tiling.disableDragMode();
 
    tiling.destroyMasks();
    if(!skip_apply)
        tiling.applyTmpSwap(workspace); // Make the swap permanent
    tiling.clearTmpSwap();
    tiling.tileWorkspaceWindows(workspace, null, meta_window.get_monitor());
}