// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Window management utilities and workspace operations

import * as Logger from './logger.js';
import * as constants from './constants.js';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import { afterWorkspaceSwitch } from './timing.js';

import { TileZone } from './edgeTiling.js';

const BLACKLISTED_WM_CLASSES = [
    'org.gnome.Screenshot',
    'Gnome-screenshot',
];

export class WindowingManager {
    constructor() {
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._tilingManager = null;
        this._timeoutRegistry = null;
        this._overflowStartCallback = null;
        this._overflowEndCallback = null;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }
    
    setTilingManager(manager) {
        this._tilingManager = manager;
    }
    
    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }
    
    setOverflowCallbacks(startCallback, endCallback) {
        this._overflowStartCallback = startCallback;
        this._overflowEndCallback = endCallback;
    }

    getTimestamp() {
        return global.get_current_time();
    }

    getPrimaryMonitor() {
        return global.display.get_primary_monitor();
    }

    getWorkspace() {
        return global.workspace_manager.get_active_workspace();
    }

    getAllWorkspaceWindows(monitor, allow_unrelated) {
        return this.getMonitorWorkspaceWindows(this.getWorkspace(), monitor, allow_unrelated);
    }

    getMonitorWorkspaceWindows(workspace, monitor, allow_unrelated) {
        let _windows = [];
        if (!workspace) return _windows;
        
        let windows = workspace.list_windows();
        for (let window of windows)
            if (window.get_monitor() === monitor && (this.isRelated(window) || allow_unrelated))
                _windows.push(window);
        return _windows;
    }

    moveBackWindow(window) {
        let workspace = window.get_workspace();
        let active = workspace.active;
        let previous_workspace = workspace.get_neighbor(Meta.MotionDirection.LEFT);
        
        if (!previous_workspace) {
            Logger.error("There is no workspace to the left.");
            return;
        }
        
        window.change_workspace(previous_workspace);
        if (active)
            previous_workspace.activate(this.getTimestamp());
        return previous_workspace;
    }

    // Attempts to tile a window with an existing edge-tiled window
    tryTileWithSnappedWindow(window, edgeTiledWindow, previousWorkspace) {
        if (!this._edgeTilingManager) {
            Logger.error('tryTileWithSnappedWindow: edgeTilingManager not set');
            return false;
        }
        
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        const tileState = this._edgeTilingManager.getWindowState(edgeTiledWindow);
        
        if (!tileState || tileState.zone === TileZone.NONE) {
            Logger.log('[MOSAIC WM] Existing window is not edge-tiled, cannot tile');
            return false;
        }
        
        let direction;
        if (tileState.zone === TileZone.LEFT_FULL ||
            tileState.zone === TileZone.TOP_LEFT ||
            tileState.zone === TileZone.BOTTOM_LEFT) {
            direction = 'right';
        } else if (tileState.zone === TileZone.RIGHT_FULL ||
                   tileState.zone === TileZone.TOP_RIGHT ||
                   tileState.zone === TileZone.BOTTOM_RIGHT) {
            direction = 'left';
        } else {
            Logger.log('[MOSAIC WM] Unsupported edge tile zone for dual-tiling');
            return false;
        }
        
        const existingFrame = edgeTiledWindow.get_frame_rect();
        const existingWidth = existingFrame.width;
        const availableWidth = workArea.width - existingWidth;
        
        Logger.log(`[MOSAIC WM] Auto-tiling: existing window width=${existingWidth}px, available=${availableWidth}px`);
        
        let targetX, targetY, targetWidth, targetHeight;
        
        if (direction === 'left') {
            targetX = workArea.x;
            targetY = workArea.y;
            targetWidth = availableWidth;
            targetHeight = workArea.height;
        } else { // right
            targetX = workArea.x + existingWidth;
            targetY = workArea.y;
            targetWidth = availableWidth;
            targetHeight = workArea.height;
        }
        
        try {
            this._edgeTilingManager.saveWindowState(window);
            
            window.unmaximize(Meta.MaximizeFlags.BOTH);
            window.move_resize_frame(false, targetX, targetY, targetWidth, targetHeight);
            
            const zone = direction === 'left' ? TileZone.LEFT_FULL : TileZone.RIGHT_FULL;
            const state = this._edgeTilingManager.getWindowState(window);
            if (state) {
                state.zone = zone;
                Logger.log(`[MOSAIC WM] Dual-tiling: Updated window ${window.get_id()} state to zone ${zone}`);
                
                this._edgeTilingManager.setupResizeListener(window);
            }
            
            this._edgeTilingManager.registerAutoTileDependency(window.get_id(), edgeTiledWindow.get_id());
            
            Logger.log(`[MOSAIC WM] Successfully dual-tiled window ${window.get_wm_class()} to ${direction} (${targetWidth}x${targetHeight})`);
            return true;
        } catch (error) {
            Logger.log(`[MOSAIC WM] Failed to tile window: ${error.message}`);
            if (previousWorkspace) {
                window.change_workspace(previousWorkspace);
            }
            return false;
        }
    }

    // Moves a window that doesn't fit into another workspace.
    moveOversizedWindow(window) {
        const workspaceManager = global.workspace_manager;
        const monitor = this.getPrimaryMonitor();
        
        // Notify that overflow is starting
        if (this._overflowStartCallback) {
            this._overflowStartCallback();
        }
        
        // Flag window as overflow-moved to prevent tiling errors
        window._movedByOverflow = true;
        
        // Track origin workspace across multiple calls
        const currentIndex = window._overflowOriginWorkspace ?? window.get_workspace().index();
        window._overflowOriginWorkspace = currentIndex;
        
        const nextIndex = currentIndex + 1;
        
        Logger.log(`[MOSAIC WM] moveOversizedWindow: origin=${currentIndex}, next=${nextIndex}`);
        
        let target_workspace = null;
        
        // Check if next workspace exists and can fit this window
        if (nextIndex < workspaceManager.get_n_workspaces()) {
            const nextWorkspace = workspaceManager.get_workspace_by_index(nextIndex);
            
            Logger.log(`[MOSAIC WM] Checking if window ${window.get_id()} fits in workspace ${nextIndex}`);
            
            if (this._tilingManager && this._tilingManager.canFitWindow(window, nextWorkspace, monitor)) {
                target_workspace = nextWorkspace;
                Logger.log(`[MOSAIC WM] Window fits in existing workspace ${nextIndex}`);
            } else {
                Logger.log(`[MOSAIC WM] Window does NOT fit in workspace ${nextIndex} - creating new`);
            }
        } else {
            Logger.log(`[MOSAIC WM] No workspace at index ${nextIndex} - creating new`);
        }
        
        // Create new workspace if next doesn't exist or can't fit
        if (!target_workspace) {
            target_workspace = workspaceManager.append_new_workspace(false, this.getTimestamp());
            workspaceManager.reorder_workspace(target_workspace, nextIndex);
            Logger.log(`[MOSAIC WM] Created workspace at position ${nextIndex}`);
        }
        
        const previous_workspace = window.get_workspace();
        const switchFocusToMovedWindow = previous_workspace.active;
        
        window.change_workspace(target_workspace);
        
        // Clear flags after settling
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.REVERSE_RESIZE_PROTECTION_MS, () => {
            window._movedByOverflow = false;
            delete window._overflowOriginWorkspace;
            return GLib.SOURCE_REMOVE;
        });
        
        // Defer activation to next idle (no artificial delay)
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const workspaceIndex = target_workspace.index();
            if (workspaceIndex < 0 || workspaceIndex >= workspaceManager.get_n_workspaces()) {
                Logger.warn(`[MOSAIC WM] Workspace no longer valid: ${workspaceIndex}`);
                return GLib.SOURCE_REMOVE;
            }
            
            if (switchFocusToMovedWindow) {
                target_workspace.activate(global.get_current_time());
            }
            
            // Re-tile after window has settled
            if (this._tilingManager) {
                let attempts = 0;
                const maxAttempts = constants.GEOMETRY_WAIT_MAX_ATTEMPTS;
                
                const waitForWindowGeometry = () => {
                    attempts++;
                    const frame = window.get_frame_rect();
                    
                    // Check if window has real dimensions (not 0x0) AND is in the workspace list
                    const workspaceWindows = target_workspace.list_windows();
                    const windowInWorkspace = workspaceWindows.some(w => w.get_id() === window.get_id());
                    
                    if (frame.width > 0 && frame.height > 0 && windowInWorkspace) {
                        Logger.log(`[MOSAIC WM] moveOversizedWindow: window geometry ready (${frame.width}x${frame.height}), waiting for animation then retiling`);
                        // Wait for workspace switch animation to complete before tiling
                        afterWorkspaceSwitch(() => {
                            this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);
                        }, this._timeoutRegistry);
                        
                        // Check position immediately after retile (no delay)
                        const checkPosition = () => {
                            const finalFrame = window.get_frame_rect();
                            const workArea = target_workspace.get_work_area_for_monitor(monitor);
                            
                            // Calculate expected center position
                            const expectedX = Math.floor((workArea.width - finalFrame.width) / 2) + workArea.x;
                            const expectedY = Math.floor((workArea.height - finalFrame.height) / 2) + workArea.y;
                            
                            // Check if window is far from expected position (threshold of 10px)
                            const positionError = Math.abs(finalFrame.x - expectedX) + Math.abs(finalFrame.y - expectedY);
                            
                            if (positionError > 10) {
                                Logger.log(`[MOSAIC WM] moveOversizedWindow: window mispositioned by ${positionError}px, retiling`);
                                this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);
                            }
                            
                            // Notify that overflow is complete
                            if (this._overflowEndCallback) {
                                this._overflowEndCallback();
                            }
                        };
                        
                        // Use idle callback for immediate check (no artificial delay)
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            checkPosition();
                            return GLib.SOURCE_REMOVE;
                        });
                        
                        return GLib.SOURCE_REMOVE;
                    }
                    
                    // Prevent infinite loop - give up after max attempts
                    if (attempts >= maxAttempts) {
                        Logger.log(`[MOSAIC WM] moveOversizedWindow: timeout waiting for geometry, forcing retile`);
                        afterWorkspaceSwitch(() => {
                            this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);
                        }, this._timeoutRegistry);
                        if (this._overflowEndCallback) {
                            this._overflowEndCallback();
                        }
                        return GLib.SOURCE_REMOVE;
                    }
                    
                    Logger.log(`[MOSAIC WM] moveOversizedWindow: waiting for geometry (${frame.width}x${frame.height})`);
                    return GLib.SOURCE_CONTINUE;
                };
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, waitForWindowGeometry);
            }
            
            return GLib.SOURCE_REMOVE;
        });

        return target_workspace;
    }

    isPrimary(window) {
        return window.get_monitor() === this.getPrimaryMonitor();
    }

    isExcluded(meta_window) {
        if (!this.isRelated(meta_window) || meta_window.minimized) {
            return true;
        }
        
        // Always on top ("sempre na frente de outras janelas")
        if (meta_window.is_above()) {
            Logger.log(`[MOSAIC WM] Window excluded (always on top): ${meta_window.get_wm_class()}`);
            return true;
        }
        
        // Sticky / on all workspaces ("sempre na area de trabalho visivel")
        if (meta_window.is_on_all_workspaces()) {
            Logger.log(`[MOSAIC WM] Window excluded (on all workspaces): ${meta_window.get_wm_class()}`);
            return true;
        }
        
        const wmClass = meta_window.get_wm_class();
        if (wmClass && BLACKLISTED_WM_CLASSES.includes(wmClass)) {
            Logger.log(`[MOSAIC WM] Window excluded (blacklisted): ${wmClass}`);
            return true;
        }
        
        return false;
    }

    isRelated(meta_window) {
        if (meta_window.is_attached_dialog()) {
            return false;
        }
        
        if (meta_window.window_type !== Meta.WindowType.NORMAL) {
            return false;
        }
        
        if (meta_window.is_on_all_workspaces()) {
            return false;
        }
        
        if (meta_window.get_transient_for() !== null) {
            const wmClass = meta_window.get_wm_class();
            Logger.log(`[MOSAIC WM] Excluding transient/modal window: ${wmClass}`);
            return false;
        }
        
        return true;
    }

    isMaximizedOrFullscreen(window) {
        return (window.maximized_horizontally === true && 
                window.maximized_vertically === true) || 
               window.is_fullscreen();
    }

    // Navigates to an appropriate workspace when current becomes empty.
    // Priority: last visited workspace, unless it's the final (always-empty) workspace
    renavigate(workspace, condition, lastVisitedIndex = null) {
        const workspaceManager = global.workspace_manager;
        const nWorkspaces = workspaceManager.get_n_workspaces();
        const currentIndex = workspace.index();
        const lastWorkspaceIndex = nWorkspaces - 1; // Final workspace is always empty (GNOME dynamic)
        
        // Skip if workspace is already the final one (nothing to navigate from)
        if (currentIndex === lastWorkspaceIndex) {
            Logger.log('[MOSAIC WM] renavigate: Already on final workspace, going left');
            const leftNeighbor = workspace.get_neighbor(Meta.MotionDirection.LEFT);
            if (leftNeighbor && leftNeighbor.index() !== currentIndex) {
                leftNeighbor.activate(this.getTimestamp());
            }
            return;
        }
        
        // Try last visited workspace first (if provided and valid)
        if (lastVisitedIndex !== null && lastVisitedIndex !== currentIndex && lastVisitedIndex !== lastWorkspaceIndex) {
            const lastVisited = workspaceManager.get_workspace_by_index(lastVisitedIndex);
            if (lastVisited && lastVisited.index() >= 0 && lastVisited.index() < nWorkspaces) {
                Logger.log(`[MOSAIC WM] renavigate: Going to last visited workspace ${lastVisitedIndex}`);
                lastVisited.activate(this.getTimestamp());
                return;
            }
        }
        
        // Fallback: left neighbor, then right neighbor
        let targetWorkspace = workspace.get_neighbor(Meta.MotionDirection.LEFT);
        
        if (!targetWorkspace || targetWorkspace.index() === currentIndex || targetWorkspace.index() === lastWorkspaceIndex) {
            targetWorkspace = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
            // Avoid final empty workspace
            if (targetWorkspace && targetWorkspace.index() === lastWorkspaceIndex) {
                targetWorkspace = null;
            }
        }
        
        if (targetWorkspace && targetWorkspace.index() !== currentIndex && condition) {
            Logger.log(`[MOSAIC WM] renavigate: Falling back to neighbor workspace ${targetWorkspace.index()}`);
            targetWorkspace.activate(this.getTimestamp());
        }
    }

    destroy() {
        this._edgeTilingManager = null;
        this._animationsManager = null;
    }
}
