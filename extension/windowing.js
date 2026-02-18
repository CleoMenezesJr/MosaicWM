// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Window management utilities and workspace operations

import * as Logger from './logger.js';
import * as constants from './constants.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import { afterWorkspaceSwitch } from './timing.js';

import { TileZone } from './constants.js';
import * as WindowState from './windowState.js';

const BLACKLISTED_WM_CLASSES = [
    'org.gnome.Screenshot',
    'Gnome-screenshot',
];

import GObject from 'gi://GObject';

export const WindowingManager = GObject.registerClass({
    GTypeName: 'MosaicWindowingManager',
}, class WindowingManager extends GObject.Object {
    _init() {
        super._init();
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._tilingManager = null;
        this._timeoutRegistry = null;
        this._overflowStartCallback = null;
        this._overflowEndCallback = null;
        
        // Cache for getMonitorWorkspaceWindows - invalidated at start of each tiling operation
        // WeakMap<Workspace, Map<String, Window[]>>
        this._windowsCache = new WeakMap();
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

    
    // Call this at start of tiling operations to invalidate cache
    invalidateWindowsCache() {
        this._windowsCache = new WeakMap();
    }

    getMonitorWorkspaceWindows(workspace, monitor, allow_unrelated) {
        if (!workspace) return [];
        
        let workspaceCache = this._windowsCache.get(workspace);
        if (!workspaceCache) {
            workspaceCache = new Map();
            this._windowsCache.set(workspace, workspaceCache);
        }

        const cacheKey = `${monitor}-${allow_unrelated ? 1 : 0}`;
        if (workspaceCache.has(cacheKey)) {
            return workspaceCache.get(cacheKey);
        }
        
        let _windows = [];
        let windows = workspace.list_windows();
        for (let window of windows)
            if (window.get_monitor() === monitor && (this.isRelated(window) || allow_unrelated))
                _windows.push(window);
        
        // Store in cache
        workspaceCache.set(cacheKey, _windows);
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
            this.showWorkspaceSwitcher(previous_workspace, window.get_monitor());
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
            Logger.log('Existing window is not edge-tiled, cannot tile');
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
            Logger.log('Unsupported edge tile zone for dual-tiling');
            return false;
        }
        
        const existingFrame = edgeTiledWindow.get_frame_rect();
        const existingWidth = existingFrame.width;
        const availableWidth = workArea.width - existingWidth;
        
        Logger.log(`Auto-tiling: existing window width=${existingWidth}px, available=${availableWidth}px`);
        
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
                Logger.log(`Dual-tiling: Updated window ${window.get_id()} state to zone ${zone}`);
                
                this._edgeTilingManager.setupResizeListener(window);
            }
            
            this._edgeTilingManager.registerAutoTileDependency(window.get_id(), edgeTiledWindow.get_id());
            
            Logger.log(`Successfully dual-tiled window ${window.get_wm_class()} to ${direction} (${targetWidth}x${targetHeight})`);
            return true;
        } catch (error) {
            Logger.log(`Failed to tile window: ${error.message}`);
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
        WindowState.set(window, 'movedByOverflow', true);
        
        // Track origin workspace across multiple calls
        const currentIndex = WindowState.get(window, 'overflowOriginWorkspace') ?? window.get_workspace().index();
        WindowState.set(window, 'overflowOriginWorkspace', currentIndex);
        
        const nextIndex = currentIndex + 1;
        
        Logger.log(`moveOversizedWindow: origin=${currentIndex}, next=${nextIndex}`);
        
        let target_workspace = null;
        
        if (nextIndex < workspaceManager.get_n_workspaces()) {
            const nextWorkspace = workspaceManager.get_workspace_by_index(nextIndex);
            
            Logger.log(`Checking if window ${window.get_id()} fits in workspace ${nextIndex}`);
            
            if (this._tilingManager && this._tilingManager.canFitWindow(window, nextWorkspace, monitor)) {
                target_workspace = nextWorkspace;
                Logger.log(`Window fits in existing workspace ${nextIndex}`);
            } else {
                Logger.log(`Window does NOT fit in workspace ${nextIndex} - creating new`);
            }
        } else {
            Logger.log(`No workspace at index ${nextIndex} - creating new`);
        }
        
        // Create new workspace if next doesn't exist or can't fit
        if (!target_workspace) {
            target_workspace = workspaceManager.append_new_workspace(false, this.getTimestamp());
            workspaceManager.reorder_workspace(target_workspace, nextIndex);
            Logger.log(`Created workspace at position ${nextIndex}`);
        }
        
        const previous_workspace = window.get_workspace();
        const switchFocusToMovedWindow = previous_workspace.active;
        
        window.change_workspace(target_workspace);
        
        // Clear flags after settling
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.REVERSE_RESIZE_PROTECTION_MS, () => {
            WindowState.set(window, 'movedByOverflow', false);
            WindowState.remove(window, 'overflowOriginWorkspace');
            return GLib.SOURCE_REMOVE;
        });
        
        // Defer activation to next idle (no artificial delay)
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const workspaceIndex = target_workspace.index();
            if (workspaceIndex < 0 || workspaceIndex >= workspaceManager.get_n_workspaces()) {
                Logger.warn(`Workspace no longer valid: ${workspaceIndex}`);
                return GLib.SOURCE_REMOVE;
            }
            
            if (switchFocusToMovedWindow) {
                target_workspace.activate(global.get_current_time());
                this.showWorkspaceSwitcher(target_workspace, monitor);
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
                        Logger.log(`moveOversizedWindow: window geometry ready (${frame.width}x${frame.height}), waiting for animation then retiling`);
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
                                Logger.log(`moveOversizedWindow: window mispositioned by ${positionError}px, retiling`);
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
                        Logger.log(`moveOversizedWindow: timeout waiting for geometry, forcing retile`);
                        afterWorkspaceSwitch(() => {
                            this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);
                        }, this._timeoutRegistry);
                        if (this._overflowEndCallback) {
                            this._overflowEndCallback();
                        }
                        return GLib.SOURCE_REMOVE;
                    }
                    
                    Logger.log(`moveOversizedWindow: waiting for geometry (${frame.width}x${frame.height})`);
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
        
        // Always on top (window is above other windows)
        if (meta_window.is_above()) {
            return true;
        }
        
        // Sticky / on all workspaces ("sempre na area de trabalho visivel")
        if (meta_window.is_on_all_workspaces()) {
            return true;
        }
        
        const wmClass = meta_window.get_wm_class();
        if (wmClass && BLACKLISTED_WM_CLASSES.includes(wmClass)) {
            return true;
        }
        
        return false;
    }

    isExcludedByID(id) {
        const window = global.display.list_all_windows().find(w => w.get_id() === id);
        return window ? this.isExcluded(window) : true;
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
            Logger.log(`Excluding transient/modal window: ${wmClass}`);
            return false;
        }
        
        return true;
    }

    isMaximizedOrFullscreen(window) {
        return (window.maximized_horizontally === true && 
                window.maximized_vertically === true) || 
               window.is_fullscreen();
    }

    // Checks if a workspace on a specific monitor contains any sacred windows.
    hasSacredWindow(workspace, monitor, excludeWindowId = null) {
        if (!workspace || monitor === null || monitor === undefined)
            return false;

        const windows = this.getMonitorWorkspaceWindows(workspace, monitor);
        return windows.some(w =>
            (!excludeWindowId || w.get_id() !== excludeWindowId) &&
            this.isMaximizedOrFullscreen(w)
        );
    }

    // Navigates to an appropriate workspace when current becomes empty.
    renavigate(workspace, condition, lastVisitedIndex = null, monitorIndex = -1) {
        if (!condition) return;

        // Queue in idle with low priority to let GNOME settle its dynamic workspace states
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const workspaceManager = global.workspace_manager;
            const currentIndex = workspace.index();

            if (currentIndex < 0) return GLib.SOURCE_REMOVE;

            const nWorkspaces = workspaceManager.get_n_workspaces();
            const lastWorkspaceIndex = nWorkspaces - 1;
            let target = null;

            // 1. If on the final (placeholder) workspace, the only valid move is left
            if (currentIndex === lastWorkspaceIndex) {
                target = workspace.get_neighbor(Meta.MotionDirection.LEFT);
                if (target) {
                    Logger.log(`[RENAVIGATE] On final workspace, moving to left neighbor (WS-${target.index()})`);
                }
            }
            // 2. Try to move in the direction of the last visited workspace
            else if (lastVisitedIndex !== null && lastVisitedIndex !== currentIndex) {
                const direction = lastVisitedIndex < currentIndex 
                    ? Meta.MotionDirection.LEFT 
                    : Meta.MotionDirection.RIGHT;
                
                target = workspace.get_neighbor(direction);
                
                // Guard: Don't jump to the final empty workspace if we were going right
                if (target && target.index() === lastWorkspaceIndex) {
                    target = null;
                } else if (target) {
                    Logger.log(`[RENAVIGATE] Moving ${direction === Meta.MotionDirection.LEFT ? 'left' : 'right'} toward last visited WS-${lastVisitedIndex}`);
                }
            }

            // 3. Fallback: Systematic neighbor search (Left, then Right)
            if (!target || target.index() === currentIndex) {
                target = workspace.get_neighbor(Meta.MotionDirection.LEFT);
                
                if (!target || target.index() === currentIndex || target.index() < 0) {
                    target = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
                }
                
                // Final safety: never fallback to the placeholder workspace
                if (target && target.index() === lastWorkspaceIndex) {
                    target = null;
                } else if (target) {
                    Logger.log(`[RENAVIGATE] Falling back to available neighbor (WS-${target.index()})`);
                }
            }

            // Execute navigation if a valid target was resolved
            if (target && target.index() >= 0 && target.index() !== currentIndex) {
                target.activate(this.getTimestamp());
                this.showWorkspaceSwitcher(target, monitorIndex);
            } else {
                Logger.log(`[RENAVIGATE] No suitable target found to navigate away from WS-${currentIndex}`);
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    showWorkspaceSwitcher(workspace, monitorIndex = -1) {
        if (!workspace) return;
        
        const index = workspace.index();
        Logger.log(`[SWITCHER] Activating OSD for WS-${index}`);
        
        // Default to primary monitor if none specified
        if (monitorIndex === -1) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }
        
        Logger.log(`showWorkspaceSwitcher: showing WorkspaceSwitcherPopup for workspace ${index} on monitor ${monitorIndex}`);
        
        // Use WorkspaceSwitcherPopup for native workspace switching indicator (dots/grid)
        try {
            if (!Main.wm._workspaceSwitcherPopup) {
                Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
            }
            
            // Ensure destruction cleanup
            if (!WindowState.get(Main.wm._workspaceSwitcherPopup, 'destroyConnected')) {
                 Main.wm._workspaceSwitcherPopup.connect('destroy', () => {
                     Main.wm._workspaceSwitcherPopup = null;
                 });
                 WindowState.set(Main.wm._workspaceSwitcherPopup, 'destroyConnected', true);
            }

            Main.wm._workspaceSwitcherPopup.display(index);
        } catch (e) {
            Logger.warn(`WorkspaceSwitcherPopup failed: ${e.message}`);
        }
    }
    destroy() {
        this._edgeTilingManager = null;
        this._animationsManager = null;
    }
});
