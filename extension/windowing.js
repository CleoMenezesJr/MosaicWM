// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Window management utilities and workspace operations

import * as Logger from './logger.js';
import * as constants from './constants.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import { afterWorkspaceSwitch, waitForGeometry } from './timing.js';

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

    getWorkspace() {
        return global.workspace_manager.get_active_workspace();
    }

    getAllWorkspaceWindows(monitor, allow_unrelated) {
        return this.getMonitorWorkspaceWindows(this.getWorkspace(), monitor, allow_unrelated);
    }

    // Call this at start of tiling operations to invalidate cache
    invalidateWindowsCache() {
        this._cacheVersion = (this._cacheVersion || 0) + 1;
    }

    getMonitorWorkspaceWindows(workspace, monitor, allow_unrelated) {
        if (!workspace) return [];
        
        let workspaceCache = this._windowsCache.get(workspace);
        if (!workspaceCache || workspaceCache._version !== this._cacheVersion) {
            workspaceCache = new Map();
            workspaceCache._version = this._cacheVersion;
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
        const active = global.workspace_manager.get_active_workspace() === workspace;
        let previous_workspace = workspace.get_neighbor(Meta.MotionDirection.LEFT);

        if (!previous_workspace) {
            Logger.error("There is no workspace to the left.");
            return;
        }
        
        window.change_workspace(previous_workspace);
        if (active) {
            previous_workspace.activate(this.getTimestamp());
            this.showWorkspaceSwitcher(previous_workspace, window.get_monitor());
        }
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
            
            window.unmaximize();
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

    // Helper to create or reuse an adjacent workspace cleanly
    createOrReuseAdjacentWorkspace(originWorkspace) {
        const workspaceManager = global.workspace_manager;
        const currentIndex = originWorkspace.index();
        const nextIndex = currentIndex + 1;
        const totalWorkspaces = workspaceManager.get_n_workspaces();
        const nextWorkspace = nextIndex < totalWorkspaces ? workspaceManager.get_workspace_by_index(nextIndex) : null;
        
        let targetWorkspace = null;
        if (nextWorkspace && nextWorkspace.list_windows().length === 0) {
            Logger.log(`[WORKSPACE] Reusing existing empty workspace at WS-${nextIndex}`);
            targetWorkspace = nextWorkspace;
        } else {
            Logger.log(`[WORKSPACE] Creating new workspace and inserting at WS-${nextIndex}`);
            targetWorkspace = workspaceManager.append_new_workspace(false, this.getTimestamp());
            workspaceManager.reorder_workspace(targetWorkspace, nextIndex);
        }
        
        return targetWorkspace;
    }

    // Moves a window that doesn't fit into another workspace.
    // Returns a Promise that resolves with the target_workspace when the move and retiling are complete.
    moveOversizedWindow(window, options = { switchFocus: true }) {
        return new Promise(resolve => {
            const workspaceManager = global.workspace_manager;
            const monitor = window.get_monitor();
            
            // Notify that overflow is starting
            if (this._overflowStartCallback) {
                this._overflowStartCallback();
            }
            
            // Flag window as overflow-moved to prevent tiling errors
            WindowState.set(window, 'movedByOverflow', true);
        
        // Use current workspace as origin to prevent overflow target loops.
        const currentIndex = window.get_workspace().index();
        
        Logger.log(`moveOversizedWindow: origin=${currentIndex}`);
        
        const isSacred = this.isMaximizedOrFullscreen(window);
        const nextIndex = currentIndex + 1;
        const totalWorkspaces = workspaceManager.get_n_workspaces();
        let target_workspace = null;
        
        // GNOME's dynamic workspaces might not have a workspace at nextIndex yet
        const nextWorkspace = nextIndex < totalWorkspaces ? workspaceManager.get_workspace_by_index(nextIndex) : null;
        
        if (isSacred) {
            Logger.log(`[PLACEMENT] Sacred window detected - targeting strictly WS-${nextIndex} for isolation`);
            target_workspace = this.createOrReuseAdjacentWorkspace(workspaceManager.get_workspace_by_index(currentIndex));
        } else {
            Logger.log(`[PLACEMENT] Overflow window detected - targeting strictly WS-${nextIndex}`);
            if (nextWorkspace && this._tilingManager && this._tilingManager.canFitWindow(window, nextWorkspace, monitor)) {
                Logger.log(`[PLACEMENT] Window fits in existing adjacent WS-${nextIndex}`);
                target_workspace = nextWorkspace;
            } else {
                Logger.log(`[PLACEMENT] Adjacent WS-${nextIndex} is full or missing - creating new workspace`);
                target_workspace = this.createOrReuseAdjacentWorkspace(workspaceManager.get_workspace_by_index(currentIndex));
            }
        }
        
        const previous_workspace = window.get_workspace();
        const switchFocusRequested = options.switchFocus !== false;

        window.change_workspace(target_workspace);

        // Defer activation to next idle (no artificial delay)
            this._timeoutRegistry.addIdle(() => {
                const workspaceIndex = target_workspace.index();
                if (workspaceIndex < 0 || workspaceIndex >= workspaceManager.get_n_workspaces()) {
                    Logger.warn(`Workspace no longer valid: ${workspaceIndex}`);
                    resolve(target_workspace);
                    return GLib.SOURCE_REMOVE;
                }

                // Decide focus after any ongoing workspace switch completes,
                // avoiding fights with user-initiated navigation.
                afterWorkspaceSwitch(() => {
                    const stillOnOrigin = global.workspace_manager.get_active_workspace() === previous_workspace;
                    if (stillOnOrigin && switchFocusRequested) {
                        target_workspace.activate(global.get_current_time());
                        this.showWorkspaceSwitcher(target_workspace, monitor);
                    }
                }, this._timeoutRegistry);
                
                // Re-tile after window has settled
                if (this._tilingManager) {
                    Logger.log(`moveOversizedWindow: workspace switch done, retiling immediately and then waiting for animations`);
                    
                    // First, repair any aborted smart-resize corruption in the origin workspace before the window was ejected
                    if (previous_workspace.index() !== target_workspace.index()) {
                        this._tilingManager.tileWorkspaceWindows(previous_workspace, null, monitor);
                    }
                    
                    // Tile target workspace IMMEDIATELY to prevent "leap to 0,0"
                    this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);

                    afterWorkspaceSwitch(() => {
                        try {
                            // Perfectly tile the target workspace again after GNOME animations finish
                            this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);
                            
                            // Check position after tiling
                            this._timeoutRegistry.addIdle(() => {
                                try {
                                    if (!window || !window.get_compositor_private()) {
                                        return;
                                    }
                                    const finalFrame = window.get_frame_rect();
                                    const workArea = target_workspace.get_work_area_for_monitor(monitor);
                                    const expectedX = Math.floor((workArea.width - finalFrame.width) / 2) + workArea.x;
                                    const expectedY = Math.floor((workArea.height - finalFrame.height) / 2) + workArea.y;
                                    const positionError = Math.abs(finalFrame.x - expectedX) + Math.abs(finalFrame.y - expectedY);
                                    
                                    if (positionError > 10) {
                                        Logger.log(`moveOversizedWindow: window mispositioned by ${positionError}px, retiling`);
                                        this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);
                                    }
                                } finally {
                                    WindowState.remove(window, 'movedByOverflow');
                                    WindowState.remove(window, 'overflowOriginWorkspace');

                                    if (this._overflowEndCallback) {
                                        this._overflowEndCallback();
                                    }
                                    resolve(target_workspace);
                                }
                                return GLib.SOURCE_REMOVE;
                            }, 'windowing_positionCheck', GLib.PRIORITY_DEFAULT_IDLE);
                        } catch (e) {
                            Logger.error(`Error during moveOversizedWindow retiling: ${e}`);
                            
                            WindowState.remove(window, 'movedByOverflow');
                            WindowState.remove(window, 'overflowOriginWorkspace');

                            if (this._overflowEndCallback) {
                                this._overflowEndCallback();
                            }
                            resolve(target_workspace);
                        }
                    }, this._timeoutRegistry);
                } else {
                    WindowState.remove(window, 'movedByOverflow');
                    WindowState.remove(window, 'overflowOriginWorkspace');

                    if (this._overflowEndCallback) {
                        this._overflowEndCallback();
                    }
                    resolve(target_workspace);
                }
                
                return GLib.SOURCE_REMOVE;
            });
        });
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

        if (meta_window.get_transient_for() !== null) {
            return false;
        }
        
        if (meta_window.window_type !== Meta.WindowType.NORMAL) {
            return false;
        }
        
        if (meta_window.is_on_all_workspaces()) {
            return false;
        }
        
        return true;
    }

    isMaximizedOrFullscreen(window) {
        return window.is_maximized() || window.is_fullscreen();
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
        this._timeoutRegistry.addIdle(() => {
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
        }, 'windowing_renavigate', GLib.PRIORITY_LOW);
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
