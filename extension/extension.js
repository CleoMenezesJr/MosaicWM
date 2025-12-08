// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later

import * as Logger from './logger.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { WindowingManager } from './windowing.js';
import * as constants from './constants.js';

import { SettingsOverrider } from './settingsOverrider.js';

// Import new Managers
import { EdgeTilingManager, TileZone } from './edgeTiling.js';
import { TilingManager } from './tiling.js';
import { ReorderingManager } from './reordering.js';
import { SwappingManager } from './swapping.js';
import { DrawingManager } from './drawing.js';
import { AnimationsManager } from './animations.js';

export default class WindowMosaicExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        
        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];
        this._maximizedWindows = [];
        this._sizeChanged = false;
        
        this._resizeOverflowWindow = null;
        this._resizeInOverflow = false;
        this._resizeDebounceTimeout = null;
        this._resizeGracePeriod = 0;
        this._tileTimeout = null;
        this._windowPreviousWorkspace = new Map();
        this._windowRemovedTimestamp = new Map();
        this._manualWorkspaceMove = new Map();
        this._overflowMoveTimestamps = new Map();  // Track windows recently moved due to overflow
        this._currentWorkspaceIndex = null;
        this._lastVisitedWorkspace = null;
        
        this._settingsOverrider = null;
        this._draggedWindow = null;
        this._dragMonitorId = null;
        this._currentZone = TileZone.NONE;
        this._grabOpBeginId = null;
        this._grabOpEndId = null;
        this._currentGrabOp = null; // Track current grab operation

        this.edgeTilingManager = null;
        this.tilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.windowingManager = null;
    }

    _tileWindowWorkspace(meta_window) {
        if(!meta_window) return;
        let workspace = meta_window.get_workspace();
        if(!workspace) return;
        this.tilingManager.tileWorkspaceWindows(workspace, 
                                      meta_window, 
                                      null, 
                                      false);
    }

    _tileAllWorkspaces = () => {
        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let nMonitors = global.display.get_n_monitors();
            for(let j = 0; j < nMonitors; j++)
                this.tilingManager.tileWorkspaceWindows(workspace, false, j, true);
        }
    }

    _windowCreatedHandler = (_, window) => {
        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            if (!this._windowsOpenedMaximized) {
                this._windowsOpenedMaximized = new Set();
            }
            this._windowsOpenedMaximized.add(window.get_id());
            Logger.log(`[MOSAIC WM] Window ${window.get_id()} opened maximized - marked for auto-tile check`);
        }
        
        // Use GLib.timeout_add for better GJS integration than setInterval
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            let monitor = window.get_monitor();
            let workspace = window.get_workspace();
                
            if( monitor !== null &&
                window.wm_class !== null &&
                window.get_compositor_private() &&
                workspace.list_windows().length !== 0 &&
                !window.is_hidden())
            {
                if(this.windowingManager.isExcluded(window)) {
                    Logger.log('[MOSAIC WM] Window excluded from tiling');
                    return GLib.SOURCE_REMOVE; 
                }
                
                if(this.windowingManager.isMaximizedOrFullscreen(window)) {
                    const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                    
                    if(workspaceWindows.length > 1) {
                        const windowId = window.get_id();
                        const openedMaximized = this._windowsOpenedMaximized && this._windowsOpenedMaximized.has(windowId);
                        
                        if (openedMaximized) {
                            Logger.log('[MOSAIC WM] Opened maximized with tiled window - auto-tiling');
                            
                            const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                            const tiledWindows = workspaceWindows.filter(w => {
                                if (w === window) return false;
                                const state = this.edgeTilingManager.getWindowState(w);
                                return state && state.zone !== TileZone.NONE;
                            });
                            
                            if (tiledWindows.length > 0) {
                                Logger.log('[MOSAIC WM] Opened maximized with tiled window - auto-tiling');
                                window.unmaximize(Meta.MaximizeFlags.BOTH);
                                this._windowsOpenedMaximized.delete(windowId);
                            } else {
                                Logger.log('[MOSAIC WM] Opened maximized without tiled window - moving to new workspace');
                                this.windowingManager.moveOversizedWindow(window);
                                this._windowsOpenedMaximized.delete(windowId);
                            }
                        } else {
                            Logger.log('[MOSAIC WM] User maximized window - moving to new workspace');
                            this.windowingManager.moveOversizedWindow(window);
                        }
                        return GLib.SOURCE_REMOVE;
                    } else {
                        Logger.log('[MOSAIC WM] Maximized window in empty workspace - keeping here');
                        this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                        return GLib.SOURCE_REMOVE;
                    }
                }
                
                const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                const edgeTiledWindows = workspaceWindows.filter(w => {
                    const tileState = this.edgeTilingManager.getWindowState(w);
                    return tileState && tileState.zone !== TileZone.NONE && w.get_id() !== window.get_id();
                });
                
                if (edgeTiledWindows.length === 1 && workspaceWindows.length === 2) {
                    Logger.log(`[MOSAIC WM] New window: Attempting to tile with edge-tiled window`);
                    const tileSuccess = this.windowingManager.tryTileWithSnappedWindow(window, edgeTiledWindows[0], null);
                    
                    if (tileSuccess) {
                        Logger.log('[MOSAIC WM] New window: Successfully tiled with edge-tiled window');
                        this._connectWindowWorkspaceSignal(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    Logger.log('[MOSAIC WM] New window: Tiling failed, continuing with normal flow');
                }
                
                const canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                
                if(!canFit) {
                    Logger.log('[MOSAIC WM] Window doesn\'t fit - moving to new workspace');
                    this.windowingManager.moveOversizedWindow(window);
                } else {
                    Logger.log('[MOSAIC WM] Window fits - adding to tiling');
                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                }
                
                this._connectWindowWorkspaceSignal(window);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _destroyedHandler = (_, win) => {
        let window = win.meta_window;
        let monitor = window.get_monitor();
        const windowId = window.get_id();
        
        this._disconnectWindowWorkspaceSignal(window);
        this.edgeTilingManager.clearWindowState(window);
        
        this._windowPreviousWorkspace.delete(windowId);
        this._windowRemovedTimestamp.delete(windowId);
        this._manualWorkspaceMove.delete(windowId);
        
        if(this.windowingManager.isExcluded(window)) {
            Logger.log('[MOSAIC WM] Excluded window closed - no workspace navigation');
            return;
        }
        
        if(monitor === global.display.get_primary_monitor()) {
            const workspace = this.windowingManager.getWorkspace();
            
            this.edgeTilingManager.checkQuarterExpansion(workspace, monitor);
            
            this.tilingManager.tileWorkspaceWindows(workspace, 
                null, 
                monitor,
                true);
            
            const windows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
            const managedWindows = windows.filter(w => !this.windowingManager.isExcluded(w));
            
            if (managedWindows.length === 0) {
                Logger.log('[MOSAIC WM] Workspace is empty - checking if should navigate');
                
                const workspaceManager = global.workspace_manager;
                const currentIndex = workspace.index();
                
                if (currentIndex === 0) {
                    Logger.log('[MOSAIC WM] Workspace 0 is now empty - staying in workspace 0');
                    return;
                }
                
                let shouldNavigate = false;
                let targetWorkspace = null;
                
                if (this._lastVisitedWorkspace !== null && 
                    this._lastVisitedWorkspace !== currentIndex) {
                    const lastWorkspace = workspaceManager.get_workspace_by_index(this._lastVisitedWorkspace);
                    if (lastWorkspace) {
                        const lastWindows = this.windowingManager.getMonitorWorkspaceWindows(lastWorkspace, monitor);
                        const lastManagedWindows = lastWindows.filter(w => !this.windowingManager.isExcluded(w));
                        
                        if (lastManagedWindows.length > 0) {
                            shouldNavigate = true;
                            targetWorkspace = lastWorkspace;
                            Logger.log(`[MOSAIC WM] Navigating to last visited workspace ${this._lastVisitedWorkspace}`);
                        }
                    }
                }
                
                if (!shouldNavigate) {
                    const previousWorkspace = workspace.get_neighbor(Meta.MotionDirection.LEFT);
                    if (previousWorkspace && previousWorkspace.index() !== currentIndex) {
                        const prevWindows = this.windowingManager.getMonitorWorkspaceWindows(previousWorkspace, monitor);
                        const prevManagedWindows = prevWindows.filter(w => !this.windowingManager.isExcluded(w));
                        
                        if (prevManagedWindows.length > 0) {
                            shouldNavigate = true;
                            targetWorkspace = previousWorkspace;
                            Logger.log(`[MOSAIC WM] Found non-empty previous workspace ${previousWorkspace.index()}`);
                        }
                    }
                }
                
                if (!shouldNavigate) {
                    const nextWorkspace = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
                    if (nextWorkspace && nextWorkspace.index() !== currentIndex) {
                        const nextWindows = this.windowingManager.getMonitorWorkspaceWindows(nextWorkspace, monitor);
                        const nextManagedWindows = nextWindows.filter(w => !this.windowingManager.isExcluded(w));
                        
                        if (nextManagedWindows.length > 0) {
                            shouldNavigate = true;
                            targetWorkspace = nextWorkspace;
                            Logger.log(`[MOSAIC WM] Found non-empty next workspace ${nextWorkspace.index()}`);
                        }
                    }
                }
                
                if (shouldNavigate && targetWorkspace) {
                    targetWorkspace.activate(global.get_current_time());
                    Logger.log(`[MOSAIC WM] Navigated to workspace ${targetWorkspace.index()}`);
                } else {
                    Logger.log('[MOSAIC WM] No non-empty workspace available to navigate to');
                }
            }
        }
    }
    
    _switchWorkspaceHandler = (_, win) => {
        this._tileWindowWorkspace(win.meta_window);
    }
    
    _workspaceSwitchedHandler = () => {
        const newWorkspace = this._workspaceManager.get_active_workspace();
        const newIndex = newWorkspace.index();
        
        if (this._currentWorkspaceIndex !== null && this._currentWorkspaceIndex !== newIndex) {
            this._lastVisitedWorkspace = this._currentWorkspaceIndex;
            Logger.log(`[MOSAIC WM] Workspace switched from ${this._currentWorkspaceIndex} to ${newIndex}, saved ${this._currentWorkspaceIndex} as last visited`);
        }
        
        this._currentWorkspaceIndex = newIndex;
    }

    _windowWorkspaceChangedHandler = (window) => {
        Logger.log(`[MOSAIC WM] workspace-changed fired for window ${window.get_id()}`);
        const windowId = window.get_id();
        
        if (this._workspaceChangeDebounce.has(windowId)) {
            Logger.log('[MOSAIC WM] Clearing previous debounce timeout');
            GLib.source_remove(this._workspaceChangeDebounce.get(windowId));
        }
        
        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            Logger.log('[MOSAIC WM] Skipping overflow check for maximized window');
            return;
        }
        
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.DEBOUNCE_DELAY_MS, () => {
            this._workspaceChangeDebounce.delete(windowId);
            
            // Guard: Skip if window was recently moved due to overflow (prevents infinite loop)
            const lastOverflowMove = this._overflowMoveTimestamps.get(windowId);
            if (lastOverflowMove && (Date.now() - lastOverflowMove) < 2000) {
                Logger.log(`[MOSAIC WM] Skipping overflow check - window ${windowId} was recently moved for overflow`);
                return GLib.SOURCE_REMOVE;
            }
            
            const currentWorkspace = window.get_workspace();
            if (!currentWorkspace) {
                Logger.log(`[MOSAIC WM] Debounce: window ${windowId} has no workspace, skipping`);
                return GLib.SOURCE_REMOVE;
            }
            const currentWorkspaceIndex = currentWorkspace.index();
            
            Logger.log(`[MOSAIC WM] Debounce complete - checking overflow for window ${windowId} in workspace ${currentWorkspaceIndex}`);
            
            const monitor = window.get_monitor();
            
            const previousWorkspaceIndex = this._windowPreviousWorkspace.get(windowId);
            
            if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== currentWorkspaceIndex) {
                const sourceWorkspace = global.workspace_manager.get_workspace_by_index(previousWorkspaceIndex);
                if (sourceWorkspace) {
                    Logger.log(`[MOSAIC WM] Re-tiling source workspace ${previousWorkspaceIndex} after window ${windowId} moved to ${currentWorkspaceIndex}`);
                    this.tilingManager.tileWorkspaceWindows(sourceWorkspace, false, monitor, false);
                }
            }
            
            this._windowPreviousWorkspace.set(windowId, currentWorkspaceIndex);
            
            const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(currentWorkspace, monitor);
            
            const edgeTiledCount = workspaceWindows.filter(w => {
                const state = this.edgeTilingManager.getWindowState(w);
                return state && state.zone !== TileZone.NONE;
            }).length;
            
            if (edgeTiledCount === 1 && workspaceWindows.length === 2) {
                const edgeTiledWindow = workspaceWindows.find(w => {
                    if (w === window) return false;
                    const state = this.edgeTilingManager.getWindowState(w);
                    return state && state.zone !== TileZone.NONE;
                });
                
                if (edgeTiledWindow) {
                    Logger.log('[MOSAIC WM] Manual move: Attempting to tile with edge-tiled window');
                    const success = this.windowingManager.tryTileWithSnappedWindow(window, edgeTiledWindow, null);
                    if (success) {
                        Logger.log('[MOSAIC WM] Manual move: Successfully tiled with edge-tiled window');
                        return GLib.SOURCE_REMOVE;
                    }
                }
            }
            
            const canFit = this.tilingManager.canFitWindow(window, currentWorkspace, monitor);
            
            if (!canFit) {
                Logger.log('[MOSAIC WM] Manual move: window doesn\'t fit - moving to new workspace');
                this._overflowMoveTimestamps.set(windowId, Date.now());  // Track to prevent re-processing
                this.windowingManager.moveOversizedWindow(window);
            } else {
                Logger.log('[MOSAIC WM] Manual move: window fits - tiling workspace');
                this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, false);
            }
            
            return GLib.SOURCE_REMOVE;
        });
        
        this._workspaceChangeDebounce.set(windowId, timeoutId);
    }

    _connectWindowWorkspaceSignal(window) {
        const windowId = window.get_id();
        const signalId = window.connect('workspace-changed', () => {
            this._windowWorkspaceChangedHandler(window);
        });
        this._windowWorkspaceSignals.set(windowId, signalId);
        
        const currentWorkspace = window.get_workspace();
        if (currentWorkspace) {
            this._windowPreviousWorkspace.set(windowId, currentWorkspace.index());
            Logger.log(`[MOSAIC WM] Initialized workspace tracker for window ${windowId} at workspace ${currentWorkspace.index()}`);
        }
    }

    _disconnectWindowWorkspaceSignal(window) {
        const windowId = window.get_id();
        const signalId = this._windowWorkspaceSignals.get(windowId);
        if (signalId) {
            window.disconnect(signalId);
            this._windowWorkspaceSignals.delete(windowId);
        }
    }

    _sizeChangeHandler = (_, win, mode) => {
        let window = win.meta_window;
        if(!this.windowingManager.isExcluded(window)) {
            let id = window.get_id();
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();

            if(mode === 2 || mode === 0) { // If the window was maximized
                if(this.windowingManager.isMaximizedOrFullscreen(window) && this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor).length > 1) {
                    Logger.log('[MOSAIC WM] User maximized window - moving to new workspace');
                    let newWorkspace = this.windowingManager.moveOversizedWindow(window);
                    if(newWorkspace) {
                        this._maximizedWindows[id] = {
                            workspace: newWorkspace.index(),
                            monitor: monitor
                        };
                        this.tilingManager.tileWorkspaceWindows(workspace, false, monitor, false);
                    }
                }
            }
        }
    }

    _sizeChangedHandler = (_, win) => {
        let window = win.meta_window;
        if(!this._sizeChanged && !this.windowingManager.isExcluded(window)) {
            if (!this.windowingManager.isRelated(window)) {
                return;
            }
            
            const rect = window.get_frame_rect();
            if (rect.width <= 10 || rect.height <= 10) {
                return;
            }
            
            if (this._skipNextTiling === window.get_id()) {
                Logger.log(`[MOSAIC WM] Skipping size change tiling for window ${window.get_id()} (restoring from edge tiling)`);
                return;
            }

            let tileState = this.edgeTilingManager.getWindowState(window);
            let isEdgeTiled = tileState && tileState.zone !== TileZone.NONE;
            
            if (isEdgeTiled) {
                return;
            }

            this._sizeChanged = true;
            
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();
            
            if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
                const isManualResize = this._currentGrabOp && constants.RESIZE_GRAB_OPS.includes(this._currentGrabOp);
                
                if (isManualResize) {
                    if (this._resizeDebounceTimeout) {
                        GLib.source_remove(this._resizeDebounceTimeout);
                        this._resizeDebounceTimeout = null;
                    }
                    
                    // Need some tests how much debounce is needed
                    this._resizeDebounceTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
                        this._resizeDebounceTimeout = null;
                        
                        let canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                        
                        if (!canFit && !this._resizeInOverflow) {
                            Logger.log('[MOSAIC WM] Manual resize: entering overflow');
                            this._resizeInOverflow = true;
                            this._resizeOverflowWindow = window;
                            // Visual indicator - make window semi-transparent
                            const actor = window.get_compositor_private();
                            if (actor) {
                                actor.opacity = 160;
                            }
                            this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, true, true);
                        } else if (canFit && this._resizeInOverflow) {
                            Logger.log('[MOSAIC WM] Manual resize: exiting overflow');
                            this._resizeInOverflow = false;
                            // Restore opacity
                            const actor = window.get_compositor_private();
                            if (actor) {
                                actor.opacity = 255;
                            }
                            this._resizeOverflowWindow = null;
                            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true, false);
                        } else {
                            const excludeWindow = this._resizeInOverflow ? window : null;
                            const excludeFromTiling = this._resizeInOverflow;
                            this.tilingManager.tileWorkspaceWindows(workspace, excludeWindow, monitor, true, excludeFromTiling);
                        }
                        
                        return GLib.SOURCE_REMOVE;
                    });
                    
                    this._sizeChanged = false;
                    return;
                }
                
                let canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                
                // Skip automatic overflow detection during grace period after grab-op-end
                const now = Date.now();
                if (this._resizeGracePeriod && (now - this._resizeGracePeriod) < 200) {
                    Logger.log('[MOSAIC WM] Skipping automatic overflow check - in grace period');
                    this._sizeChanged = false;
                    return;
                }
                
                if (!canFit) {
                    if (this._resizeOverflowWindow !== window) {
                        Logger.log('[MOSAIC WM] Resize overflow detected (automatic) - moving window immediately');
                        this._resizeOverflowWindow = window;
                        
                        let oldWorkspace = workspace;
                        let newWorkspace = this.windowingManager.moveOversizedWindow(window);
                        if (newWorkspace) {
                            this.tilingManager.tileWorkspaceWindows(oldWorkspace, false, monitor, false);
                            workspace = newWorkspace;
                        }
                        this._resizeOverflowWindow = null;
                        this._sizeChanged = false;
                        return;
                    }
                } else if (this._resizeOverflowWindow === window) {
                    this._resizeOverflowWindow = null;
                    Logger.log('[MOSAIC WM] Resize overflow cleared - window fits again');
                }
                
                // If window fits and no overflow change, skip unnecessary re-tiling
                if (canFit) {
                    this._sizeChanged = false;
                    return;
                }
            }
            
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
            this._sizeChanged = false;
        }
    }

    _grabOpBeginHandler = (_, window, grabpo) => {
        this._currentGrabOp = grabpo;
        
        const isResizeOp = constants.RESIZE_GRAB_OPS.includes(grabpo);
        if (isResizeOp) {
            this._resizeInOverflow = false;
            this.animationsManager.setResizingWindow(window.get_id());
            Logger.log(`[MOSAIC WM] Tracking resize for window ${window.get_id()}, grabpo=${grabpo}`);
        }
        
        if (grabpo === 1 && !this.windowingManager.isExcluded(window)) {
            Logger.log(`[MOSAIC WM] Edge tiling: grab begin`);
            this._draggedWindow = window;
            this._currentZone = TileZone.NONE;
            
            const windowState = this.edgeTilingManager.getWindowState(window);
            
            if (windowState && windowState.zone !== TileZone.NONE) {
                Logger.log(`[MOSAIC WM] Edge tiling: window was in zone ${windowState.zone}, restoring immediately`);
                
                this._skipNextTiling = window.get_id();
                
                this.edgeTilingManager.removeTile(window, () => {
                    Logger.log(`[MOSAIC WM] Edge tiling: restoration complete, checking if drag still active`);
                    this._skipNextTiling = null;
                    
                    const [x, y, mods] = global.get_pointer();
                    const isButtonPressed = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
                    
                    if (!isButtonPressed) {
                        Logger.log(`[MOSAIC WM] Edge tiling: button released during restoration, skipping startDrag`);
                        this._draggedWindow = null;
                        
                        // Retile the workspace so the window returns to mosaic position
                        const workspace = window.get_workspace();
                        const monitor = window.get_monitor();
                        if (workspace && monitor !== null) {
                            Logger.log(`[MOSAIC WM] Edge tiling: triggering retile after quick release`);
                            this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                        }
                        return;
                    }
                    
                    if ( 
                        (grabpo === constants.GRAB_OP_MOVING || grabpo === constants.GRAB_OP_KEYBOARD_MOVING) && 
                        window && !this.windowingManager.isMaximizedOrFullscreen(window)
                    ) {
                        Logger.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
                        this.reorderingManager.startDrag(window);
                        Logger.log(`[MOSAIC WM] _grabOpBeginHandler: startDrag completed`);
                    }
                });
                return;
            }
            
            if (this._edgeTilingPollId) {
                Logger.log(`[MOSAIC WM] Stopping previous polling loop before starting new one`);
                GLib.source_remove(this._edgeTilingPollId);
                this._edgeTilingPollId = null;
            }
            
            this._edgeTilingPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!this._draggedWindow) {
                    return GLib.SOURCE_REMOVE;
                }
                
                const [x, y, mods] = global.get_pointer();
                const isButtonPressed = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
                
                if (!isButtonPressed) {
                    Logger.warn(`[MOSAIC WM] Drag ended without grab-op-end event - forcing cleanup`);
                    
                    if (this._currentZone !== TileZone.NONE) {
                        const workspace = this._draggedWindow.get_workspace();
                        const monitor = this._draggedWindow.get_monitor();
                        const workArea = workspace.get_work_area_for_monitor(monitor);
                        
                        Logger.log(`[MOSAIC WM] Applying zone ${this._currentZone} on forced cleanup`);
                        this.edgeTilingManager.applyTile(this._draggedWindow, this._currentZone, workArea);
                    }
                    
                    this.drawingManager.hideTilePreview();
                    this.tilingManager.clearDragRemainingSpace();
                    this.edgeTilingManager.setEdgeTilingActive(false, null);
                    
                    const draggedWindow = this._draggedWindow;
                    this._draggedWindow = null;
                    this._currentZone = TileZone.NONE;
                    
                    this.reorderingManager.stopDrag(draggedWindow, false, true);
                    
                    // Clear the poll ID since we're returning SOURCE_REMOVE
                    this._edgeTilingPollId = null;
                    return GLib.SOURCE_REMOVE;
                }
                
                const monitor = this._draggedWindow.get_monitor();
                const workspace = this._draggedWindow.get_workspace();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                
                const zone = this.edgeTilingManager.detectZone(x, y, workArea, workspace);
                const windowState = this.edgeTilingManager.getWindowState(this._draggedWindow);
                const wasInEdgeTiling = windowState && windowState.zone !== TileZone.NONE;
                
                if (zone !== TileZone.NONE && zone !== this._currentZone) {
                    Logger.log(`[MOSAIC WM] Edge tiling: detected zone ${zone}`);
                    this._currentZone = zone;
                    this.edgeTilingManager.setEdgeTilingActive(true, this._draggedWindow);
                    this.drawingManager.showTilePreview(zone, workArea, this._draggedWindow);
                    
                    const remainingSpace = this.edgeTilingManager.calculateRemainingSpaceForZone(zone, workArea);
                    Logger.log(`[MOSAIC WM] Preview: tiling mosaic to remaining space x=${remainingSpace.x}, w=${remainingSpace.width}`);
                    this.tilingManager.setDragRemainingSpace(remainingSpace);
                    this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor, false);
                } else if (zone === TileZone.NONE && this._currentZone !== TileZone.NONE) {
                    Logger.log(`[MOSAIC WM] Edge tiling: exiting zone, wasInEdgeTiling=${wasInEdgeTiling}`);
                    this._currentZone = TileZone.NONE;
                    this.edgeTilingManager.setEdgeTilingActive(false, null);
                    this.drawingManager.hideTilePreview();
                    
                    Logger.log(`[MOSAIC WM] Preview cancelled: returning mosaic to full workspace`);
                    this.tilingManager.clearDragRemainingSpace();
                    this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor, false);
                    
                    if (wasInEdgeTiling) {
                        Logger.log(`[MOSAIC WM] Edge tiling: restoring window from tiled state`);
                        this.edgeTilingManager.removeTile(this._draggedWindow);
                    }
                }
                
                return GLib.SOURCE_CONTINUE;
            });
        }
        
        if( !this.windowingManager.isExcluded(window) &&
            (grabpo === constants.GRAB_OP_MOVING || grabpo === constants.GRAB_OP_KEYBOARD_MOVING) && 
            !(this.windowingManager.isMaximizedOrFullscreen(window))) {
            Logger.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            this.reorderingManager.startDrag(window);
            Logger.log(`[MOSAIC WM] _grabOpBeginHandler: startDrag completed`);
        }
    }
    
    _grabOpEndHandler = (_, window, grabpo) => {
        this._currentGrabOp = null;
        
        if (grabpo === constants.GRAB_OP_MOVING && window === this._draggedWindow) {
            if (this._edgeTilingPollId) {
                GLib.source_remove(this._edgeTilingPollId);
                this._edgeTilingPollId = null;
            }
            
            if (this._currentZone !== TileZone.NONE) {
                Logger.log(`[MOSAIC WM] Edge tiling: applying zone ${this._currentZone}`);
                const workspace = window.get_workspace();
                const monitor = window.get_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                
                const occupiedWindow = this.edgeTilingManager.getWindowInZone(this._currentZone, workspace, monitor);
                
                if (occupiedWindow && occupiedWindow.get_id() !== window.get_id()) {
                    Logger.log(`[MOSAIC WM] DnD: zone ${this._currentZone} occupied by ${occupiedWindow.get_id()}, swapping`);
                    
                    this._skipNextTiling = window.get_id();
                    
                    const success = this.swappingManager.swapWindows(window, occupiedWindow, this._currentZone, workspace, monitor);
                    Logger.log(`[MOSAIC WM] DnD swap result = ${success}`);
                    
                    if (success) {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                            this._skipNextTiling = null;
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        this._skipNextTiling = null;
                    }
                } else {
                    Logger.log(`[MOSAIC WM] DnD: zone ${this._currentZone} empty, applying tile`);
                    
                    this._skipNextTiling = window.get_id();
                    
                    const success = this.edgeTilingManager.applyTile(window, this._currentZone, workArea);
                    Logger.log(`[MOSAIC WM] Edge tiling: apply result = ${success}`);
                    
                    if (success) {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                            this._skipNextTiling = null;
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        this._skipNextTiling = null;
                    }
                }
            } 
            
            this.drawingManager.hideTilePreview();
            this._draggedWindow = null;
            this._currentZone = TileZone.NONE;
            
            this.tilingManager.clearDragRemainingSpace();
            
            this.edgeTilingManager.setEdgeTilingActive(false, null);
        }
        
        if(!this.windowingManager.isExcluded(window)) {
            const skipTiling = this._skipNextTiling === window.get_id();
            Logger.log(`[MOSAIC WM] _grabOpEndHandler: calling stopDrag for window ${window.get_id()}, grabpo=${grabpo}, skipTiling=${skipTiling}`);
            this.reorderingManager.stopDrag(window, false, skipTiling);
            Logger.log(`[MOSAIC WM] _grabOpEndHandler: stopDrag completed`);
            
            Logger.log(`[MOSAIC WM] Grab operation ended: ${grabpo}`);
            
            const isResizeEnd = constants.RESIZE_GRAB_OPS.includes(grabpo);
            if (isResizeEnd) {
                this.animationsManager.setResizingWindow(null);
                Logger.log(`[MOSAIC WM] Cleared resize tracking for window ${window.get_id()}`);
            }
            
            
            if(isResizeEnd) {
                const tileState = this.edgeTilingManager.getWindowState(window);
                const isEdgeTiled = tileState && tileState.zone !== TileZone.NONE;
                
                if (isEdgeTiled && (tileState.zone === TileZone.LEFT_FULL || tileState.zone === TileZone.RIGHT_FULL)) {
                    Logger.log(`[MOSAIC WM] Resize ended (grabpo=${grabpo}) for FULL edge-tiled window - fixing final sizes`);
                    this.edgeTilingManager.fixTiledPairSizes(window, tileState.zone);
                } else if (isEdgeTiled && this.edgeTilingManager.isQuarterZone(tileState.zone)) {
                    Logger.log(`[MOSAIC WM] Resize ended (grabpo=${grabpo}) for QUARTER edge-tiled window - fixing final sizes`);
                    this.edgeTilingManager.fixQuarterPairSizes(window, tileState.zone);
                }
                
                if (this._resizeDebounceTimeout) {
                    GLib.source_remove(this._resizeDebounceTimeout);
                    this._resizeDebounceTimeout = null;
                }
                
                // Set grace period to ignore residual size-changed events
                this._resizeGracePeriod = Date.now();
                
                if (this._resizeInOverflow || this._resizeOverflowWindow === window) {
                    Logger.log('[MOSAIC WM] Resize ended with overflow - moving window to new workspace');
                    this._resizeInOverflow = false;
                    // Restore opacity before moving
                    const actor = window.get_compositor_private();
                    if (actor) {
                        actor.opacity = 255;
                    }
                    let oldWorkspace = window.get_workspace();
                    let newWorkspace = this.windowingManager.moveOversizedWindow(window);
                    if (newWorkspace) {
                        this.tilingManager.tileWorkspaceWindows(oldWorkspace, false, window.get_monitor(), false);
                    }
                    this._resizeOverflowWindow = null;
                } else if (!isEdgeTiled) {
                    this._tileWindowWorkspace(window);
                }
            }
            
            if( (grabpo === constants.GRAB_OP_MOVING || grabpo === constants.GRAB_OP_KEYBOARD_MOVING) && 
                !(this.windowingManager.isMaximizedOrFullscreen(window)) &&
                !skipTiling) 
            {
                this.tilingManager.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), false);
            }
        } else
            this.reorderingManager.stopDrag(window, true);
    }

    _windowAdded = (workspace, window) => {
        if (!this.windowingManager.isRelated(window)) {
            return;
        }
        
        // Save initial position IMMEDIATELY for animation later
        // This must happen before any tiling to capture the true starting position
        this.animationsManager.saveInitialPosition(window);
        
        // Use timeout_add instead of setInterval
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (this.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                
                const frame = WINDOW.get_frame_rect();
                const hasValidDimensions = frame.width > 0 && frame.height > 0;
                
                const previousWorkspaceIndex = this._windowPreviousWorkspace.get(WINDOW.get_id());
                const removedTimestamp = this._windowRemovedTimestamp.get(WINDOW.get_id());
                const timeSinceRemoved = removedTimestamp ? Date.now() - removedTimestamp : Infinity;
                const isManualMove = this._manualWorkspaceMove.get(WINDOW.get_id());
                
                Logger.log(`[MOSAIC WM] window-added debug: window=${WINDOW.get_id()}, timeSince=${timeSinceRemoved}ms, prevWS=${previousWorkspaceIndex}, currentWS=${WORKSPACE.index()}, isManual=${isManualMove}`);
                
                if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index() && timeSinceRemoved < 100) {
                    Logger.log(`[MOSAIC WM] window-added: Overview drag-drop - window ${WINDOW.get_id()} from workspace ${previousWorkspaceIndex} to ${WORKSPACE.index()}`);
                    
                    const sourceWorkspace = this._workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                    if (sourceWorkspace) {
                        Logger.log(`[MOSAIC WM] Re-tiling source workspace ${previousWorkspaceIndex} after DnD`);
                        this.tilingManager.tileWorkspaceWindows(sourceWorkspace, null, MONITOR, false);
                    }
                    
                    const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR);
                    const edgeTiledWindows = workspaceWindows.filter(w => {
                        const tileState = this.edgeTilingManager.getWindowState(w);
                        return tileState && tileState.zone !== TileZone.NONE && w.get_id() !== WINDOW.get_id();
                    });
                    
                    if (edgeTiledWindows.length === 1 && workspaceWindows.length === 2) {
                        Logger.log(`[MOSAIC WM] Attempting to tile with edge-tiled window`);
                        const previousWorkspace = this._workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                        const tileSuccess = this.windowingManager.tryTileWithSnappedWindow(WINDOW, edgeTiledWindows[0], previousWorkspace);
                        
                        if (tileSuccess) {
                            this._windowPreviousWorkspace.delete(WINDOW.get_id());
                            this._windowRemovedTimestamp.delete(WINDOW.get_id());
                            this._manualWorkspaceMove.delete(WINDOW.get_id());
                            return GLib.SOURCE_REMOVE; 
                        }
                        return GLib.SOURCE_REMOVE;
                    }
                    
                    const canFit = this.tilingManager.canFitWindow(WINDOW, WORKSPACE, MONITOR);
                    
                    if (!canFit) {
                        if (this.windowingManager.isMaximizedOrFullscreen(WINDOW)) {
                            Logger.log('[MOSAIC WM] window-added: Maximized window doesn\'t fit but keeping in new workspace');
                            this._windowPreviousWorkspace.delete(WINDOW.get_id());
                            this._windowRemovedTimestamp.delete(WINDOW.get_id());
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        Logger.log(`[MOSAIC WM] window-added: Doesn't fit - returning to workspace ${previousWorkspaceIndex}`);
                        const previousWorkspace = this._workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                        if (previousWorkspace) {
                            WINDOW.change_workspace(previousWorkspace);
                            this._windowPreviousWorkspace.delete(WINDOW.get_id());
                            this._windowRemovedTimestamp.delete(WINDOW.get_id());
                            return GLib.SOURCE_REMOVE; 
                        }
                    } else {
                        this._windowPreviousWorkspace.delete(WINDOW.get_id());
                        this._windowRemovedTimestamp.delete(WINDOW.get_id());
                        this._manualWorkspaceMove.delete(WINDOW.get_id());
                    }
                }
                
                const waitForGeometry = () => {
                    const rect = WINDOW.get_frame_rect();
                    if (rect.width > 0 && rect.height > 0) {
                        Logger.log(`[MOSAIC WM] Window ${WINDOW.get_id()} has geometry ${rect.width}x${rect.height}, tiling with animation`);
                        this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                };
                
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, waitForGeometry);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _windowRemoved = (workspace, window) => {
        if (!this.windowingManager.isRelated(window)) {
            return;
        }
        
        this._windowPreviousWorkspace.set(window.get_id(), workspace.index());
        this._windowRemovedTimestamp.set(window.get_id(), Date.now());
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = workspace;
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (this.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                return GLib.SOURCE_REMOVE;
            } else {
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    _workspaceAddSignal = (_, workspaceIdx) => {
        const workspace = this._workspaceManager.get_workspace_by_index(workspaceIdx);
        let eventIds = [];
        eventIds.push(workspace.connect("window-added", this._windowAdded));
        eventIds.push(workspace.connect("window-removed", this._windowRemoved));
        this._workspaceEventIds.push([workspace, eventIds]);
    }

    enable() {
        Logger.info("[MOSAIC WM]: Starting Mosaic layout manager.");

        // Get workspace manager reference
        this._workspaceManager = global.workspace_manager;
        
        // Create managers
        this.edgeTilingManager = new EdgeTilingManager();
        this.tilingManager = new TilingManager();
        this.reorderingManager = new ReorderingManager();
        this.swappingManager = new SwappingManager();
        this.drawingManager = new DrawingManager();
        this.animationsManager = new AnimationsManager();
        this.windowingManager = new WindowingManager();

        // Wire up dependencies
        this.windowingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.windowingManager.setAnimationsManager(this.animationsManager);
        
        this.tilingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.tilingManager.setDrawingManager(this.drawingManager);
        this.tilingManager.setAnimationsManager(this.animationsManager);
        this.tilingManager.setWindowingManager(this.windowingManager);
        
        this.reorderingManager.setTilingManager(this.tilingManager);
        this.reorderingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.reorderingManager.setAnimationsManager(this.animationsManager);
        this.reorderingManager.setWindowingManager(this.windowingManager);
        
        this.swappingManager.setTilingManager(this.tilingManager);
        this.swappingManager.setEdgeTilingManager(this.edgeTilingManager);
        
        this.drawingManager.setEdgeTilingManager(this.edgeTilingManager);
        
        this.edgeTilingManager.setAnimationsManager(this.animationsManager);
        
        this._windowWorkspaceSignals = new Map();
        this._workspaceChangeDebounce = new Map();
        this._windowsOpenedMaximized = new Set();
        
        this._settingsOverrider = new SettingsOverrider();
        
        this._settingsOverrider.add(
            new Gio.Settings({ schema_id: 'org.gnome.mutter' }),
            'edge-tiling',
            new GLib.Variant('b', false)
        );
        
        const mutterKeybindings = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });
        const emptyArray = new GLib.Variant('as', []);
        
        if (mutterKeybindings.get_strv('toggle-tiled-left').includes('<Super>Left')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-left', emptyArray);
        }
        if (mutterKeybindings.get_strv('toggle-tiled-right').includes('<Super>Right')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-right', emptyArray);
        }
        
        this._wmEventIds.push(global.window_manager.connect('size-change', this._sizeChangeHandler));
        this._wmEventIds.push(global.window_manager.connect('size-changed', this._sizeChangedHandler));
        this._displayEventIds.push(global.display.connect('window-created', this._windowCreatedHandler));
        this._wmEventIds.push(global.window_manager.connect('destroy', this._destroyedHandler));
        this._displayEventIds.push(global.display.connect("grab-op-begin", this._grabOpBeginHandler));
        this._displayEventIds.push(global.display.connect("grab-op-end", this._grabOpEndHandler));
        
        this._workspaceManEventIds.push(global.workspace_manager.connect("active-workspace-changed", this._workspaceSwitchedHandler));
        this._workspaceManEventIds.push(global.workspace_manager.connect("workspace-added", this._workspaceAddSignal));

        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let eventIds = [];
            eventIds.push(workspace.connect("window-added", this._windowAdded));
            eventIds.push(workspace.connect("window-removed", this._windowRemoved));
            this._workspaceEventIds.push([workspace, eventIds]);
        }
        
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let windows = workspace.list_windows();
            for (let window of windows) {
                if (!this.windowingManager.isExcluded(window)) {
                    this._connectWindowWorkspaceSignal(window);
                }
            }
        }

        Logger.log('[MOSAIC WM] About to call _setupKeybindings()');
        this._setupKeybindings();
        Logger.log('[MOSAIC WM] _setupKeybindings() completed');

        // Use GLib.timeout_add for better GJS integration
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.STARTUP_TILE_DELAY_MS, () => {
            this._tileAllWorkspaces();
            return GLib.SOURCE_REMOVE;
        });
        
        this._tileTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.TILE_INTERVAL_MS, () => {
            this._tileAllWorkspaces();
            return GLib.SOURCE_CONTINUE;
        });
    }
    
    _setupKeybindings() {
        Logger.log('[MOSAIC WM] *** _setupKeybindings called ***');
        
        const settings = this.getSettings('org.gnome.shell.extensions.mosaic-wm');
        
        Main.wm.addKeybinding('tile-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.LEFT_FULL));
        
        Main.wm.addKeybinding('tile-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.RIGHT_FULL));
        
        Main.wm.addKeybinding('tile-top-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.TOP_LEFT));
        
        Main.wm.addKeybinding('tile-top-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.TOP_RIGHT));
        
        Main.wm.addKeybinding('tile-bottom-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.BOTTOM_LEFT));
        
        Main.wm.addKeybinding('tile-bottom-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.BOTTOM_RIGHT));
        
        Logger.log('[MOSAIC WM] Registering swap-left keybinding');
        Main.wm.addKeybinding('swap-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('left'));
        
        Logger.log('[MOSAIC WM] Registering swap-right keybinding');
        Main.wm.addKeybinding('swap-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('right'));
        
        Logger.log('[MOSAIC WM] Registering swap-up keybinding');
        Main.wm.addKeybinding('swap-up', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('up'));
        
        Logger.log('[MOSAIC WM] Registering swap-down keybinding');
        Main.wm.addKeybinding('swap-down', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('down'));
        
        Logger.log('[MOSAIC WM] All swap keybindings registered successfully');
        Logger.log('[MOSAIC WM] Keyboard shortcuts registered');
    }
    
    _tileActiveWindow(zone) {
        const window = global.display.focus_window;
        if (!window) {
            Logger.log('[MOSAIC WM] No active window to tile');
            return;
        }
        
        if (this.windowingManager.isExcluded(window)) {
            Logger.log('[MOSAIC WM] Window is excluded from tiling');
            return;
        }
        
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        Logger.log(`[MOSAIC WM] Keyboard shortcut: tiling window ${window.get_id()} to zone ${zone}`);
        this.edgeTilingManager.applyTile(window, zone, workArea);
    }
    
    _swapActiveWindow(direction) {
        Logger.log(`[MOSAIC WM] *** SWAP SHORTCUT TRIGGERED *** Direction: ${direction}`);
        const focusedWindow = global.display.get_focus_window();
        
        if (!focusedWindow) {
            Logger.log('[MOSAIC WM] SWAP FAILED: No focused window');
            return;
        }
        
        if (this.windowingManager.isExcluded(focusedWindow)) {
            Logger.log(`[MOSAIC WM] SWAP FAILED: Window ${focusedWindow.get_id()} is excluded`);
            return;
        }
        
        Logger.log(`[MOSAIC WM] SWAP: Calling swapping.swapWindow for window ${focusedWindow.get_id()} direction: ${direction}`);
        this.swappingManager.swapWindow(focusedWindow, direction);
        Logger.log(`[MOSAIC WM] SWAP: swapWindow call completed`);
    }

    disable() {
        Logger.log('[MOSAIC WM] Disabling extension');
        
        if (this._resizeDebounceTimeout) {
            GLib.source_remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }
        Logger.info("[MOSAIC WM]: Disabling Mosaic layout manager.");
        
        if (this._settingsOverrider) {
            this._settingsOverrider.destroy();
            this._settingsOverrider = null;
        }
        
        Main.wm.removeKeybinding('tile-left');
        Main.wm.removeKeybinding('tile-right');
        Main.wm.removeKeybinding('tile-top-left');
        Main.wm.removeKeybinding('tile-top-right');
        Main.wm.removeKeybinding('tile-bottom-left');
        Main.wm.removeKeybinding('tile-bottom-right');
        Main.wm.removeKeybinding('swap-left');
        Main.wm.removeKeybinding('swap-right');
        Main.wm.removeKeybinding('swap-up');
        Main.wm.removeKeybinding('swap-down');
        Logger.log('[MOSAIC WM] Keyboard shortcuts removed');
        
        if (this._edgeTilingPollId) {
            GLib.source_remove(this._edgeTilingPollId);
            this._edgeTilingPollId = null;
        }
        
        if (this.edgeTilingManager) this.edgeTilingManager.destroy();
        if (this.drawingManager) this.drawingManager.destroy();
        if (this.animationsManager) this.animationsManager.destroy();
        
        if (this._tileTimeout) {
            GLib.source_remove(this._tileTimeout);
            this._tileTimeout = null;
        }
        for(let eventId of this._wmEventIds)
            global.window_manager.disconnect(eventId);
        for(let eventId of this._displayEventIds)
            global.display.disconnect(eventId);
        for(let eventId of this._workspaceManEventIds)
            global.workspace_manager.disconnect(eventId);
        for(let container of this._workspaceEventIds) {
            const workspace = container[0];
            const eventIds = container[1];
            eventIds.forEach((eventId) => workspace.disconnect(eventId));
        }

        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        this._windowWorkspaceSignals.forEach((signalId, windowId) => {
            const window = allWindows.find(w => w.get_id() === windowId);
            if (window) {
                try {
                    window.disconnect(signalId);
                } catch (e) {
                }
            }
        });
        this._windowWorkspaceSignals.clear();
        
        if (this._workspaceChangeTimeout) {
            clearTimeout(this._workspaceChangeTimeout);
            this._workspaceChangeTimeout = null;
        }

        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];
        
        // Clean up managers (if they had cleanup methods)
        if (this.tilingManager) this.tilingManager.destroy();
        if (this.reorderingManager) this.reorderingManager.destroy();
        if (this.swappingManager) this.swappingManager.destroy();
        if (this.windowingManager) this.windowingManager.destroy();

        this.tilingManager = null;
        this.edgeTilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.windowingManager = null;
    }
}