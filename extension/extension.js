// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later

import * as Logger from './logger.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';

import { WindowingManager } from './windowing.js';
import * as constants from './constants.js';

import { SettingsOverrider } from './settingsOverrider.js';

// Import new Managers
import { EdgeTilingManager, TileZone } from './edgeTiling.js';
import { TilingManager, ComputedLayouts } from './tiling.js';
import { ReorderingManager } from './reordering.js';
import { SwappingManager } from './swapping.js';
import { DrawingManager } from './drawing.js';
import { AnimationsManager } from './animations.js';
import { MosaicLayoutStrategy } from './overviewLayout.js';
import { TimeoutRegistry, afterWorkspaceSwitch, afterAnimations, afterWindowClose, afterOverviewHidden } from './timing.js';
import { WindowHandler } from './windowHandler.js';
import { DragHandler } from './dragHandler.js';
import { ResizeHandler } from './resizeHandler.js';
import * as WindowState from './windowState.js';
import { MosaicIndicator } from './quickSettings.js';

// Module-level accessor for TilingManager (used by overviewLayout.js for on-demand cache)
let _tilingManagerInstance = null;

// Track windows processed for smart resize per workspace to avoid double-processing in a single burst
const _smartResizeProcessedWindows = new WeakMap();
export function getTilingManager() {
    return _tilingManagerInstance;
}

export default class WindowMosaicExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        
        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];
        this._sizeChanged = false;
        
        this._resizeDebounceTimeout = null;
        this._resizeGracePeriod = 0;
        this._tileTimeout = null;

        this._currentWorkspaceIndex = null;
        this._lastVisitedWorkspace = null;
        this._overflowInProgress = false;  // Flag to prevent empty workspace navigation during overflow
        this._restoringFromEdgeTile = false;  // Flag to prevent overflow during edge tile restoration
        
        this._settingsOverrider = null;
        this._draggedWindow = null;
        this._edgeTileGhostWindows = [];  // Windows that would overflow during edge tile preview
        this._dragMonitorId = null;
        this._currentZone = TileZone.NONE;
        this._grabOpBeginId = null;
        this._grabOpEndId = null;
        this._dragPositionChangedId = 0;
        this._dragEventFilterId = 0;
        this._isPositionProcessing = false;
        this._currentGrabOp = null; // Track current grab operation

        this.edgeTilingManager = null;
        this.tilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.windowingManager = null;
        
        // Handler classes
        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;
        
        this._injectionManager = null;
        
        // Centralized timeout management for async operations
        this._timeoutRegistry = new TimeoutRegistry();
        
        // Track disabled state per workspace object (persistence across reordering)
        // Key: Meta.Workspace, Value: true (if disabled)
        // Default (missing key): Enabled
        this._disabledWorkspaceStates = new WeakMap();

        this._resizeOverflowWindow = null;
        this._resizeInOverflow = false;
    }
    
    // Check if mosaic is enabled for a given workspace
    isMosaicEnabledForWorkspace(workspace) {
        if (!workspace) return true;
        // If explicitly set to true in WeakMap, it is disabled. Otherwise enabled.
        return !this._disabledWorkspaceStates.get(workspace);
    }
    
    // Update the indicator icon based on current workspace state
    _updateIndicatorIcon() {
        if (this._mosaicIndicator) {
            this._mosaicIndicator._updateIcon();
        }
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
    };

    // =========================================================================
    // SIGNAL HANDLERS - Window Creation & Destruction
    // =========================================================================

    _windowCreatedHandler = (_, window) => {

        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            WindowState.set(window, 'openedMaximized', true);
            Logger.log(`[MOSAIC WM] Window ${window.get_id()} opened maximized - marked for auto-tile check`);
        }
        
        // Defined as callback to be used by either first-frame signal or polling
        const processWindowCallback = () => {
            // Using a closure variable to track if we're inside the timeout loop already or called directly
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
                        const openedMaximized = WindowState.get(window, 'openedMaximized');
                        
                        if (openedMaximized) {
                            Logger.log('[MOSAIC WM] Opened maximized with tiled window - auto-tiling');
                            
                            const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                            const tiledWindows = workspaceWindows.filter(w => {
                                if (w === window) return false;
                                const state = this.edgeTilingManager.getWindowState(w);
                                return state && state.zone !== TileZone.NONE;
                            });
                            
                            if (tiledWindows.length > 0) {
                                window.unmaximize(Meta.MaximizeFlags.BOTH);
                                WindowState.remove(window, 'openedMaximized');
                            } else {
                                Logger.log('[MOSAIC WM] Opened maximized without tiled window - moving to new workspace');
                                Logger.log('[TRACE] OVERFLOW from: Opened maximized without tiled window');
                                this.windowingManager.moveOversizedWindow(window);
                                WindowState.remove(window, 'openedMaximized');
                            }
                        } else {
                            Logger.log('[MOSAIC WM] User maximized window - moving to new workspace');
                            Logger.log('[TRACE] OVERFLOW from: User maximized window');
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
                        this.windowHandler.connectWindowSignals(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    Logger.log('[MOSAIC WM] New window: Tiling failed, continuing with normal flow');
                }
                
                const canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                Logger.log(`[TRACE] NEW WINDOW: canFit=${canFit}, movedByOverflow=${WindowState.get(window, 'movedByOverflow')}`);
                
                if(!canFit && !WindowState.get(window, 'movedByOverflow')) {
                    // Enqueue to prevent race conditions when multiple windows open
                    this.tilingManager.enqueueWindowOpen(window.get_id(), () => {
                        Logger.log('[MOSAIC WM] Window doesn\'t fit - trying smart resize first');
                        
                        // Try smart resize before overflow - use edge-tiling-aware work area
                        let workArea = workspace.get_work_area_for_monitor(monitor);
                        if (this.edgeTilingManager) {
                            const edgeTiledWindows = this.edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
                            if (edgeTiledWindows.length > 0) {
                                workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                            }
                        }
                        
                        // Check for SACRED windows (Maximized/Fullscreen/Full WorkArea)
                        const allExistingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                            .filter(w => w.get_id() !== window.get_id() && 
                                    !this.edgeTilingManager.isEdgeTiled(w));
                        
                        const hasSacredWindow = allExistingWindows.some(w => {
                            return w.maximized_horizontally || w.maximized_vertically || w.is_fullscreen();
                        });
                        
                        if (hasSacredWindow) {
                            Logger.log('[MOSAIC WM] Sacred window detected - forcing overflow');
                            Logger.log('[TRACE] OVERFLOW from: Sacred window detected');
                            this.windowingManager.moveOversizedWindow(window);
                            return;
                        }
                        
                        const existingWindows = allExistingWindows.filter(w => {
                            return !(w.maximized_horizontally || w.maximized_vertically || w.is_fullscreen());
                        });
                        
                        if (existingWindows.length > 0) {
                            const resizeSuccess = this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                            if (resizeSuccess) {
                                // Smart Resize now includes 2D tile simulation internally
                                // Use a small timeout to give Mutter time to process resize
                                // before tileWorkspaceWindows reads the new frame_rect sizes
                                Logger.log('[MOSAIC WM] Smart resize applied - waiting for resize to propagate');
                                GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.POLL_INTERVAL_MS, () => {
                                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                                    return GLib.SOURCE_REMOVE;
                                });
                                return;
                            }
                        }

                        
                        Logger.log('[MOSAIC WM] No smart resize possible - moving to new workspace');
                        Logger.log('[TRACE] OVERFLOW from: No smart resize possible');
                        this.windowingManager.moveOversizedWindow(window);
                    });
                } else if (WindowState.get(window, 'movedByOverflow')) {
                    // Skip tiling here - let the delayed retile in moveOversizedWindow handle it
                    Logger.log('[MOSAIC WM] Skipping initial tile - window was just moved by overflow');
                } else {
                    // Enqueue normal tiling too to prevent race conditions
                    this.tilingManager.enqueueWindowOpen(window.get_id(), () => {
                        Logger.log('[MOSAIC WM] Window fits - adding to tiling via queue');
                        this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                    });
                }
                
                this.windowHandler.connectWindowSignals(window);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };

        const actor = window.get_compositor_private();
        if (actor) {
            let signalId = null;
            let timeoutId = null;
            let processed = false;
            
            const processOnce = () => {
                if (processed) return;
                processed = true;
                
                if (signalId) actor.disconnect(signalId);
                if (timeoutId) GLib.source_remove(timeoutId);
                
                if (processWindowCallback() === GLib.SOURCE_CONTINUE) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, processWindowCallback);
                }
            };
            
            signalId = actor.connect('first-frame', processOnce);
            
            // Safety timeout: if first-frame doesn't fire within 500ms (safety fallback), start polling anyway
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                Logger.log('[MOSAIC WM] first-frame timeout - falling back to polling');
                processOnce();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, processWindowCallback);
        }
    };

    _destroyedHandler = (_, win) => {
        let window = win.meta_window;
        let monitor = window.get_monitor();
        const windowId = window.get_id();
        
        this.windowHandler.disconnectWindowSignals(window);
        this.edgeTilingManager.clearWindowState(window);
        
        const configureSignalId = WindowState.get(window, 'configureSignalId');
        if (configureSignalId) {
             window.disconnect(configureSignalId);
             WindowState.remove(window, 'configureSignalId');
        }
        
        const debounceId = WindowState.get(window, 'workspaceChangeDebounceId');
        if (debounceId) {
             GLib.source_remove(debounceId);
             WindowState.remove(window, 'workspaceChangeDebounceId');
        }
        
        WindowState.remove(window, 'maximizedUndoInfo');
        
        if(this.windowingManager.isExcluded(window)) {
            Logger.log('[MOSAIC WM] Excluded window closed - no workspace navigation');
            return;
        }
        
        if(monitor === global.display.get_primary_monitor()) {
            const workspace = this.windowingManager.getWorkspace();
            
            this.edgeTilingManager.checkQuarterExpansion(workspace, monitor);
            
            afterWindowClose(() => {
                afterAnimations(this.animationsManager, () => {
                    this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                }, this._timeoutRegistry);
            }, this._timeoutRegistry);
            
            const windows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
            const managedWindows = windows.filter(w => !this.windowingManager.isExcluded(w));
            
            if (managedWindows.length === 0) {
                // Skip if overflow is in progress - window is being moved and will arrive soon
                if (this._overflowInProgress) {
                    Logger.log('[MOSAIC WM] Workspace is empty but overflow in progress - skipping navigation');
                    return;
                }
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
    };

    // =========================================================================
    // SIGNAL HANDLERS - Workspace Changes
    // =========================================================================

    _switchWorkspaceHandler = (_, win) => {
        this._tileWindowWorkspace(win.meta_window);
    };
    
    _workspaceSwitchedHandler = () => {
        const newWorkspace = this._workspaceManager.get_active_workspace();
        const newIndex = newWorkspace.index();
        
        if (this._currentWorkspaceIndex !== null && this._currentWorkspaceIndex !== newIndex) {
            this._lastVisitedWorkspace = this._currentWorkspaceIndex;
            Logger.log(`[MOSAIC WM] Workspace switched from ${this._currentWorkspaceIndex} to ${newIndex}, saved ${this._currentWorkspaceIndex} as last visited`);
        }
        
        this._currentWorkspaceIndex = newIndex;
        
        // Wait for workspace switch animation to complete before any tiling operations
        // This prevents race conditions where tiling starts while animation is still running
        afterAnimations(this.animationsManager, () => {
            Logger.log(`[MOSAIC WM] Workspace animation complete - ready for operations on workspace ${newIndex}`);
        }, this._timeoutRegistry);
    };

    _windowWorkspaceChangedHandler = (window) => {
        Logger.log(`[MOSAIC WM] workspace-changed fired for window ${window.get_id()}`);
        const windowId = window.get_id();
        
        const existingDebounceId = WindowState.get(window, 'workspaceChangeDebounceId');
        if (existingDebounceId) {
            Logger.log('[MOSAIC WM] Clearing previous debounce timeout');
            GLib.source_remove(existingDebounceId);
            WindowState.remove(window, 'workspaceChangeDebounceId');
        }
        
        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            Logger.log('[MOSAIC WM] Skipping overflow check for maximized window');
            return;
        }
        
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.DEBOUNCE_DELAY_MS, () => {
            WindowState.remove(window, 'workspaceChangeDebounceId');
            
            // Guard: Skip if window was recently moved due to overflow (prevents infinite loop)
            const lastOverflowMove = WindowState.get(window, 'overflowMoveTimestamp');
            if (lastOverflowMove && (Date.now() - lastOverflowMove) < constants.OVERFLOW_MOVE_DEBOUNCE_MS) {
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
            
            const previousWorkspaceIndex = WindowState.get(window, 'previousWorkspace');
            
            if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== currentWorkspaceIndex) {
                const sourceWorkspace = global.workspace_manager.get_workspace_by_index(previousWorkspaceIndex);
                if (sourceWorkspace) {
                    Logger.log(`[MOSAIC WM] Re-tiling source workspace ${previousWorkspaceIndex} after window ${windowId} moved to ${currentWorkspaceIndex}`);
                    
                    afterWorkspaceSwitch(() => {
                        afterAnimations(this.animationsManager, () => {
                                if (!WindowState.get(window, 'movedByOverflow')) {
                                    Logger.log('[MOSAIC WM] Source Workspace Departure: Attempting Reverse Smart Resize on source workspace');
                                    const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(sourceWorkspace, monitor);
                                    const workArea = this.edgeTilingManager.calculateRemainingSpace(sourceWorkspace, monitor);
                                    if (workArea) {
                                        // Pass undefined for freed dimensions to trigger the new auto-calculation in tiling.js
                                        this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, undefined, undefined, sourceWorkspace, monitor);
                                    } else {
                                        Logger.log('[MOSAIC WM] extension.js: Skipped restore - invalid workArea');
                                    }
                                }
                            this.tilingManager.tileWorkspaceWindows(sourceWorkspace, false, monitor, false);
                        }, this._timeoutRegistry);
                    }, this._timeoutRegistry);
                }
            }
            
            WindowState.set(window, 'previousWorkspace', currentWorkspaceIndex);
            
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
                // SMART RESIZE FOR DnD: Try shrinking existing windows before overflow
                Logger.log(`[MOSAIC WM] Manual move: window doesn't fit - trying Smart Resize first`);
                
                const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(currentWorkspace, monitor)
                    .filter(w => 
                        w.get_id() !== windowId &&
                        !this.edgeTilingManager.isEdgeTiled(w) &&
                        !(w.maximized_horizontally || w.maximized_vertically) &&
                        !w.is_fullscreen()
                    );
                
                // Use edge-tiling-aware work area
                let workArea = currentWorkspace.get_work_area_for_monitor(monitor);
                if (this.edgeTilingManager) {
                    const edgeTiledWindows = this.edgeTilingManager.getEdgeTiledWindows(currentWorkspace, monitor);
                    if (edgeTiledWindows.length > 0) {
                        workArea = this.edgeTilingManager.calculateRemainingSpace(currentWorkspace, monitor);
                    }
                }
                const resizeSuccess = this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                
                if (resizeSuccess) {
                    Logger.log('[MOSAIC WM] DnD arrival: Smart Resize succeeded - tiling workspace');
                    afterWorkspaceSwitch(() => {
                        afterAnimations(this.animationsManager, () => {
                            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, false);
                        }, this._timeoutRegistry);
                    }, this._timeoutRegistry);
                } else {
                    Logger.log('[MOSAIC WM] DnD arrival: Smart Resize failed - moving to new workspace');
                    Logger.log('[TRACE] OVERFLOW from: DnD Smart Resize failed');
                    WindowState.set(window, 'overflowMoveTimestamp', Date.now());
                    this.windowingManager.moveOversizedWindow(window);
                }
            } else {
                Logger.log('[MOSAIC WM] Manual move: window fits - tiling workspace');
                afterWorkspaceSwitch(() => {
                    afterAnimations(this.animationsManager, () => {
                        this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, false);
                    }, this._timeoutRegistry);
                }, this._timeoutRegistry);
            }
            
            return GLib.SOURCE_REMOVE;
        });
        
        WindowState.set(window, 'workspaceChangeDebounceId', timeoutId);
    };

    
    // =========================================================================
    // SIGNAL HANDLERS - Window Size Changes
    // =========================================================================

    _sizeChangeHandler = (_, win, mode) => {
        let window = win.meta_window;
        if(!this.windowingManager.isExcluded(window)) {
            let id = window.get_id();
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();

            if(mode === 2 || mode === 0) { // If the window was maximized
                if(this.windowingManager.isMaximizedOrFullscreen(window) && this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor).length > 1) {
                    Logger.log('[MOSAIC WM] User maximized window - moving to new workspace');
                    const originalWorkspaceIndex = workspace.index(); // Save BEFORE move (for undo)
                    
                    // Use preferredSize as pre-maximize size (frame is already maximized here)
                    const preMaxSize = WindowState.get(window, 'preferredSize');
                    if (preMaxSize) {
                        Logger.log(`[MOSAIC WM] Saved pre-max size: ${preMaxSize.width}x${preMaxSize.height}`);
                    }
                    
                    let newWorkspace = this.windowingManager.moveOversizedWindow(window);
                    if(newWorkspace) {
                        WindowState.set(window, 'maximizedUndoInfo', {
                            originalWorkspace: originalWorkspaceIndex,  // Origin (for undo)
                            currentWorkspace: newWorkspace.index(),     // Destination
                            monitor: monitor,
                            preMaxSize: preMaxSize                      // Size before maximize (may be null)
                        });
                        this.tilingManager.tileWorkspaceWindows(workspace, false, monitor, false);
                    }
                }
            }
        }
    };

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
            
            // UNMAXIMIZE UNDO: Check if this is an unmaximize of a tracked window
            const maxInfo = WindowState.get(window, 'maximizedUndoInfo');
            
            if (maxInfo && !this.windowingManager.isMaximizedOrFullscreen(window)) {
                Logger.log(`[MOSAIC WM] Window ${windowId} was unmaximized - attempting undo to workspace ${maxInfo.originalWorkspace}`);
                this.resizeHandler.handleUnmaximizeUndo(window, maxInfo);
                WindowState.remove(window, 'maximizedUndoInfo');
                this._sizeChanged = false;
                return; // Skip normal size-changed handling
            }
            
            // CRITICAL: Skip if window is being programmatically resized by Smart Resize or Reverse Smart Resize
            if (WindowState.get(window, 'isSmartResizing') || WindowState.get(window, 'isReverseSmartResizing')) {
                Logger.log(`[MOSAIC WM] Skipping resize detection for window ${window.get_id()} - ${WindowState.get(window, 'isSmartResizing') ? 'smart' : 'reverse smart'} resize in progress`);
                this._sizeChanged = false;
                return;
            }
            
            // CACHE INVALIDATION: If user increased window size beyond cached minimum,
            // clear the cache to allow future Smart Resize to try shrinking this window
            if (WindowState.get(window, 'actualMinWidth') && rect.width > WindowState.get(window, 'actualMinWidth') + 20) {
                Logger.log(`[MOSAIC WM] Window ${window.get_id()} grew from cached min ${WindowState.get(window, 'actualMinWidth')}px to ${rect.width}px - invalidating cache`);
                WindowState.remove(window, 'actualMinWidth');
                WindowState.remove(window, 'actualMinHeight');
            }
            
            // UPDATE PREFERRED SIZE: If user manually resizes, update the stored size
            // This prevents reverse smart resize from undoing manual resizes
            // CRITICAL: Only update if the user explicitly resized it (GrabOp) OR if the window is NOT constrained by Mosaic
            
            const isConstrained = WindowState.get(window, 'isConstrainedByMosaic');
            const isManualResizeAction = this._currentGrabOp && constants.RESIZE_GRAB_OPS.includes(this._currentGrabOp);
            
            if (!isConstrained || isManualResizeAction) {
                const currentPreferredSize = WindowState.get(window, 'preferredSize');
                if (currentPreferredSize) {
                    // Only update if there's a meaningful size difference (avoid noise)
                    const widthDiff = Math.abs(rect.width - currentPreferredSize.width);
                    const heightDiff = Math.abs(rect.height - currentPreferredSize.height);
                    if (widthDiff > 10 || heightDiff > 10) {
                        WindowState.set(window, 'preferredSize', { 
                            width: rect.width, 
                            height: rect.height 
                        });
                        
                        // If user explicitly resized, we should clear the constraint flag
                        if (isConstrained && isManualResizeAction) {
                            WindowState.set(window, 'isConstrainedByMosaic', false);
                            Logger.log(`[MOSAIC WM] Manual resize action detected - cleared constraint flag for ${window.get_id()}`);
                        }
                        
                        Logger.log(`[MOSAIC WM] Updated preferred size for ${window.get_id()} to ${rect.width}x${rect.height}`);
                    }
                }
            } else {
                 Logger.log(`[MOSAIC WM] Ignored size change for ${window.get_id()} - Window is constrained by Mosaic logic`);
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
            

            
            // Skip resize handling for windows just moved by overflow
            if (WindowState.get(window, 'movedByOverflow')) {
                Logger.log(`[MOSAIC WM] Skipping resize detection for window ${window.get_id()} - recently moved by overflow`);
                this._sizeChanged = false;
                return;
            }
            
            if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
                const isManualResize = this._currentGrabOp && constants.RESIZE_GRAB_OPS.includes(this._currentGrabOp);
                
                // Also detect resize without grabOp (context menu/keyboard resize)
                // by checking for continuous size-changed events
                const windowId = window.get_id();
                const resizeNow = Date.now();
                const isActiveResize = isManualResize || 
                    (this._lastResizeWindow === windowId && (resizeNow - this._lastResizeTime) < 300); // 300ms threshold for continuous resize events
                this._lastResizeWindow = windowId;
                this._lastResizeTime = resizeNow;
                
                if (isActiveResize) {
                    if (this._resizeDebounceTimeout) {
                        GLib.source_remove(this._resizeDebounceTimeout);
                        this._resizeDebounceTimeout = null;
                    }
                    
                    this._resizeDebounceTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
                        this._resizeDebounceTimeout = null;
                        
                        let canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                        
                        if (!canFit && !this._resizeInOverflow) {
                            // Skip new windows - let waitForGeometry handle them with smart resize
                            if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
                                Logger.log('[MOSAIC WM] Manual resize: skipping new window - waiting for geometry');
                                return GLib.SOURCE_REMOVE;
                            }
                            
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
                if (this._resizeGracePeriod && (now - this._resizeGracePeriod) < 200) { // 200ms grace period
                    Logger.log('[MOSAIC WM] Skipping automatic overflow check - in grace period');
                    this._sizeChanged = false;
                    return;
                }
                
                // Skip overflow detection during edge tile restoration
                if (this._restoringFromEdgeTile) {
                    Logger.log('[MOSAIC WM] Skipping overflow check - restoring from edge tile');
                    this._sizeChanged = false;
                    return;
                }
                
                // Skip overflow detection if smart resize is in progress
                if (workspace._smartResizingInProgress || WindowState.get(window, 'isSmartResizing')) {
                    Logger.log('[MOSAIC WM] Skipping overflow check - smart resize in progress');
                    this._sizeChanged = false;
                    return;
                }
                
                if (!canFit) {
                    if (this._resizeOverflowWindow !== window) {
                        // Skip new windows - let waitForGeometry handle them with smart resize
                        if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
                            Logger.log('[MOSAIC WM] Resize overflow detected but window is new - letting waitForGeometry handle');
                            this._sizeChanged = false;
                            return;
                        }
                        
                        Logger.log('[MOSAIC WM] Resize overflow detected (automatic) - moving window');
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
    };

    // =========================================================================
    // SIGNAL HANDLERS - Drag & Drop / Grab Operations
    // =========================================================================

    _onDragGlobalButtonRelease(event) {
        if (event.type() !== Clutter.EventType.BUTTON_RELEASE) {
            return Clutter.EVENT_PROPAGATE;
        }

        // Cleanup filter immediately to avoid duplicate events
        if (this._dragEventFilterId) {
            Clutter.Event.remove_filter(this._dragEventFilterId);
            this._dragEventFilterId = 0;
        }

        if (!this._draggedWindow) {
            return Clutter.EVENT_PROPAGATE;
        }

        Logger.log(`[MOSAIC WM] Global button release detected - cleaning up drag`);
        
        if (this._currentZone !== TileZone.NONE) {
            const workspace = this._draggedWindow.get_workspace();
            const monitor = this._draggedWindow.get_monitor();
            const workArea = workspace.get_work_area_for_monitor(monitor);
            
            Logger.log(`[MOSAIC WM] Applying zone ${this._currentZone} on button release`);
            this.edgeTilingManager.applyTile(this._draggedWindow, this._currentZone, workArea);
        }
        
        this.drawingManager.hideTilePreview();
        this.tilingManager.clearDragRemainingSpace();
        this.edgeTilingManager.setEdgeTilingActive(false, null);
        
        // Clear ghost windows that were created during edge tile preview
        this.dragHandler.clearGhostWindows();
        
        // Restore opacity if window was marked as overflow
        if (this._dragOverflowWindow) {
            const overflowActor = this._dragOverflowWindow.get_compositor_private();
            if (overflowActor) overflowActor.opacity = 255;
            this.tilingManager.clearExcludedWindow();
            this._dragOverflowWindow = null;
        }
        
        const draggedWindow = this._draggedWindow;
        this._draggedWindow = null;
        this._currentZone = TileZone.NONE;
        
        this.reorderingManager.stopDrag(draggedWindow, false, true);

        // Disconnect position signal if still active
        if (this._dragPositionChangedId && draggedWindow) {
            try {
                draggedWindow.disconnect(this._dragPositionChangedId);
            } catch (e) {
                Logger.log(`[MOSAIC WM] Failed to disconnect drag signal: ${e.message}`);
            }
            this._dragPositionChangedId = 0;
        }
        
        return Clutter.EVENT_PROPAGATE;
    }

    _onDragPositionChanged() {
        if (!this._draggedWindow) return;
        
        // 1. SYNCHRONOUS STATE UPDATE
        // We must detect zone and pause reordering IMMEDIATELY to prevent conflicts
        const monitor = this._draggedWindow.get_monitor();
        const workspace = this._draggedWindow.get_workspace();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const [x, y] = global.get_pointer();
        
        const zone = this.edgeTilingManager.detectZone(x, y, workArea, workspace);
        const isInZone = zone !== TileZone.NONE;
        
        // Pause reordering if we are in an edge zone
        if (this.reorderingManager) {
            this.reorderingManager.setPaused(isInZone);
        }

        // 2. THROTTLED VISUAL UPDATE
        if (this._isPositionProcessing) return;
        this._isPositionProcessing = true;
        
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
             if (!this._draggedWindow) {
                 this._isPositionProcessing = false;
                 return GLib.SOURCE_REMOVE;
             }
             
             // Trust the synchronous check for logical state, but re-calculate for UI specifics if needed
             // or just use the current zone calculation from inside idle (safer for rendering sync)
             if (zone !== TileZone.NONE && zone !== this._currentZone) {
                 Logger.log(`[MOSAIC WM] Edge tiling: detected zone ${zone}`);
                 this._currentZone = zone;
                 this.edgeTilingManager.setEdgeTilingActive(true, this._draggedWindow);
                 this.drawingManager.showTilePreview(zone, workArea, this._draggedWindow);
                 
                 const remainingSpace = this.edgeTilingManager.calculateRemainingSpaceForZone(zone, workArea);
                 this.tilingManager.setDragRemainingSpace(remainingSpace);
                 
                 this.dragHandler.clearGhostWindows();
                 
                 const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                     .filter(w => w.get_id() !== this._draggedWindow.get_id() && 
                                 !this.edgeTilingManager.isEdgeTiled(w));
                 
                 const result = this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor, false);
                 
                 if (result?.overflow) {
                     for (const win of mosaicWindows) {
                         const actor = win.get_compositor_private();
                         if (actor) {
                             actor.opacity = 128;
                             this._edgeTileGhostWindows.push(win);
                         }
                     }
                 }
             } else if (zone === TileZone.NONE && this._currentZone !== TileZone.NONE) {
                 Logger.log(`[MOSAIC WM] Edge tiling: exiting zone`);
                 this._currentZone = TileZone.NONE;
                 this.edgeTilingManager.setEdgeTilingActive(false, null);
                 this.drawingManager.hideTilePreview();
                 this.tilingManager.setDragRemainingSpace(null);
                 
                 // Clear ghost windows - they were only needed for edge tile preview
                 this.dragHandler.clearGhostWindows();
                 
                 // Force re-tile to restore full workarea immediately
                 Logger.log(`[MOSAIC WM] Edge tile exit: forcing re-tile to restore workarea`);
                 this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor);
                 
                 // Resume normal drag - overflow will be checked when drag actually ends
                 Logger.log(`[MOSAIC WM] Edge tile exit: resuming normal drag`);
                 this.reorderingManager.startDrag(this._draggedWindow);
             }
             
             this._isPositionProcessing = false;
             return GLib.SOURCE_REMOVE;
        });
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
            
            const windowState = this.edgeTilingManager.getWindowState(window);
            
            // Initialize _currentZone with window's zone if it's already edge-tiled
            if (windowState && windowState.zone !== TileZone.NONE) {
                this._currentZone = windowState.zone;
                Logger.log(`[MOSAIC WM] Edge tiling: window was in zone ${windowState.zone}, initializing _currentZone`);
                
                this._skipNextTiling = window.get_id();
                this._restoringFromEdgeTile = true;
                
                this.edgeTilingManager.removeTile(window, () => {
                    // Delay clearing the flag to cover the debounce period for overflow detection
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.EDGE_TILE_RESTORE_DELAY_MS, () => {
                        this._restoringFromEdgeTile = false;
                        return GLib.SOURCE_REMOVE;
                    });
                    
                    Logger.log(`[MOSAIC WM] Edge tiling: restoration complete, checking if drag still active`);
                    this._skipNextTiling = null;
                    this._currentZone = TileZone.NONE; // Reset so window doesn't get re-tiled on release
                    
                    // Check if button was already released during restoration
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

                    // Window logic continues...
                    if ( 
                        (grabpo === constants.GRAB_OP_MOVING || grabpo === constants.GRAB_OP_KEYBOARD_MOVING) && 
                        window && !this.windowingManager.isMaximizedOrFullscreen(window)
                    ) {
                         const workspace = window.get_workspace();
                         const monitor = window.get_monitor();
                         const fits = this.tilingManager.canFitWindow(window, workspace, monitor);
                         
                         if (!fits) {
                             Logger.log(`[MOSAIC WM] Edge tile exit: window doesn't fit - applying overflow opacity`);
                             const actor = window.get_compositor_private();
                             if (actor) {
                                 actor.opacity = 128;
                             }
                             this._dragOverflowWindow = window;
                             this.tilingManager.setExcludedWindow(window);
                             this.drawingManager.hideTilePreview();
                             this.drawingManager.removeBoxes();
                         } else {
                             Logger.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
                             this.reorderingManager.startDrag(window);
                         }
                    }
                });
                return;
            } else {
                this._currentZone = TileZone.NONE;
            }
            
            // Connect signal-based listeners for edge tiling (replaces polling)
            Logger.log(`[MOSAIC WM] Connecting signal-based edge tiling listeners`);
            this._dragPositionChangedId = this._draggedWindow.connect('position-changed', this._onDragPositionChanged.bind(this));
        }
        
        if( !this.windowingManager.isExcluded(window) &&
            (grabpo === constants.GRAB_OP_MOVING || grabpo === constants.GRAB_OP_KEYBOARD_MOVING) && 
            !(this.windowingManager.isMaximizedOrFullscreen(window))) {
            Logger.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            this.reorderingManager.startDrag(window);
        }
    }
    
    _grabOpEndHandler = (_, window, grabpo) => {
        this._currentGrabOp = null;
        
        // Handle drag overflow - window that was marked as not fitting
        if (this._dragOverflowWindow && this._dragOverflowWindow === window) {
            Logger.log(`[MOSAIC WM] Drag ended with overflow window - moving to new workspace`);
            const actor = this._dragOverflowWindow.get_compositor_private();
            if (actor) actor.opacity = 255; // Restore opacity
            
            this.tilingManager.clearExcludedWindow();
            this.drawingManager.hideTilePreview();
            this.drawingManager.removeBoxes();
            
            const oldWorkspace = window.get_workspace();
            this.windowingManager.moveOversizedWindow(window);
            afterAnimations(this.animationsManager, () => {
                this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, window.get_monitor(), false);
            }, this._timeoutRegistry);
            
            this._dragOverflowWindow = null;
            this._draggedWindow = null;
            this._currentZone = TileZone.NONE;
            
            if (this._dragPositionChangedId && window) {
                try {
                    window.disconnect(this._dragPositionChangedId);
                } catch (e) {
                    Logger.log(`[MOSAIC WM] Failed to disconnect signal on drag end (overflow): ${e.message}`);
                }
                this._dragPositionChangedId = 0;
            }
            if (this._dragEventFilterId) {
                Clutter.Event.remove_filter(this._dragEventFilterId);
                this._dragEventFilterId = 0;
            }
            return;
        }
        
        if (grabpo === constants.GRAB_OP_MOVING && window === this._draggedWindow) {
            if (this._dragPositionChangedId && window) {
                try {
                    window.disconnect(this._dragPositionChangedId);
                } catch (e) {
                    Logger.log(`[MOSAIC WM] Failed to disconnect signal on drag end: ${e.message}`);
                }
                this._dragPositionChangedId = 0;
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
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RETILE_DELAY_MS, () => {
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
                        // Move ghost windows to overflow after edge tile is applied
                        if (this._edgeTileGhostWindows.length > 0) {
                            Logger.log(`[MOSAIC WM] Edge tile confirmed - moving ${this._edgeTileGhostWindows.length} ghost windows to overflow`);
                            this.dragHandler.moveGhostWindowsToOverflow();
                        }
                        
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RETILE_DELAY_MS, () => {
                            this._skipNextTiling = null;
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        // Edge tile failed - clear ghosts
                        this.dragHandler.clearGhostWindows();
                        this._skipNextTiling = null;
                    }
                }
            } 
            
            this.drawingManager.hideTilePreview();
            this._draggedWindow = null;
            this._currentZone = TileZone.NONE;
            
            this.tilingManager.clearDragRemainingSpace();
            
            this.edgeTilingManager.setEdgeTilingActive(false, null);
            
            // Failsafe: Always clear ghost windows on drag end (may have been missed if zone exit timing was off)
            this.dragHandler.clearGhostWindows();
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
                    // Check if there's an adjacent edge tile or mosaic windows
                    const adjacentWindow = this.edgeTilingManager._getAdjacentWindow(window, window.get_workspace(), window.get_monitor(), tileState.zone);
                    if (adjacentWindow) {
                        this.edgeTilingManager.fixTiledPairSizes(window, tileState.zone);
                    } else {
                        // Edge tile with mosaic - constrain and retile
                        this.edgeTilingManager.fixMosaicAfterEdgeResize(window, tileState.zone);
                    }
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
                        afterAnimations(this.animationsManager, () => {
                            this.tilingManager.tileWorkspaceWindows(oldWorkspace, false, window.get_monitor(), false);
                        }, this._timeoutRegistry);
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
                afterAnimations(this.animationsManager, () => {
                    this.tilingManager.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), false);
                }, this._timeoutRegistry);
            }
        } else
            this.reorderingManager.stopDrag(window, true);
        
        // UNCONDITIONAL CLEANUP: Ensure ghost windows and preview are always cleaned up
        // This catches edge cases where zone exit during drag didn't properly clean up state
        this.dragHandler.clearGhostWindows();
        this.drawingManager.hideTilePreview();
    }

    _windowAdded = (workspace, window) => {
        if (!this.windowingManager.isRelated(window)) {
            return;
        }
        
        // Mark windows created during overview to skip slide-in animation
        if (Main.overview.visible) {
            WindowState.set(window, 'createdDuringOverview', true);
        }
        
        // Connect to configure signal for slide-in animation setup
        try {
            const configureId = window.connect('configure', (win, config) => {
                // Only handle initial configuration (first time window is placed)
                if (config.get_is_initial()) {
                    const ws = win.get_workspace();
                    const mon = win.get_monitor();
                    if (ws && mon >= 0) {
                        // Get existing windows to check if this is the first window
                        const existingWindows = ws.list_windows().filter(w =>
                            w.get_monitor() === mon &&
                            w.get_id() !== win.get_id() &&
                            !w.is_hidden() &&
                            w.get_window_type() === Meta.WindowType.NORMAL &&
                            !this.windowingManager.isExcluded(w) &&
                            w.showing_on_its_workspace()
                        );
                        
                        // Determine directional offset logic - using HISTORY from window-removed
                        let offsetDirection = 0;
                        const currentWSIndex = ws.index();
                        
                        // Use accurate previous workspace from _windowRemoved handler
                        // This handles both DnD and Move-to-workspace actions reliably
                        const prevWSIndex = WindowState.get(win, 'previousWorkspace');
                        
                        // Check if we have a valid previous workspace index and it's different from current
                        if (prevWSIndex !== undefined && prevWSIndex !== currentWSIndex) {
                            if (prevWSIndex < currentWSIndex) {
                                offsetDirection = -1; // From Left (slide in from left)
                            } else {
                                offsetDirection = 1; // From Right (slide in from right)
                            }
                        }
                        
                        // Animate if there are other windows OR if it's a directional move
                        // BUT skip if window was created during overview (already positioned correctly)
                        if ((existingWindows.length > 0 || offsetDirection !== 0) && !WindowState.get(win, 'createdDuringOverview')) {
                            WindowState.set(win, 'needsSlideIn', true);
                            WindowState.set(win, 'slideInExistingWindows', existingWindows);
                            WindowState.set(win, 'slideInDirection', offsetDirection);
                            
                            Logger.log(`[MOSAIC WM] SLIDE-IN: Window ${win.get_id()} (Existing: ${existingWindows.length}, Dir: ${offsetDirection}, PrevWS: ${prevWSIndex})`);
                            
                            // Connect to first-frame for visual animation
                            const actor = win.get_compositor_private();
                            if (actor) {
                                const firstFrameId = actor.connect('first-frame', () => {
                                    actor.disconnect(firstFrameId);
                                    
                                    // Apply offset translation NOW that actor is rendered
                                    if (WindowState.get(win, 'needsSlideIn')) {
                                        const neighbors = WindowState.get(win, 'slideInExistingWindows') || [];
                                        const direction = WindowState.get(win, 'slideInDirection') || 0;
                                        const OFFSET = constants.SLIDE_IN_OFFSET_PX;
                                        
                                        let offsetX = 0, offsetY = 0;
                                        let animationMode = Clutter.AnimationMode.EASE_OUT_QUAD; // Default subtle

                                        // 1. Center of Mass Logic (if neighbors exist) - Prioritize fitting in
                                        if (neighbors.length > 0) {
                                            let centerX = 0, centerY = 0, count = 0;
                                            for (const n of neighbors) {
                                                try {
                                                    const r = n.get_frame_rect();
                                                    if (r && r.width > 0) {
                                                        centerX += r.x + r.width / 2;
                                                        centerY += r.y + r.height / 2;
                                                        count++;
                                                    }
                                                } catch (e) {
                                                    Logger.log(`[MOSAIC WM] Failed to get neighbor rect: ${e.message}`);
                                                }
                                            }
                                            
                                            if (count > 0) {
                                                centerX /= count;
                                                centerY /= count;
                                                const winRect = win.get_frame_rect();
                                                const winCenterX = winRect.x + winRect.width / 2;
                                                const winCenterY = winRect.y + winRect.height / 2;
                                                
                                                const deltaX = winCenterX - centerX;
                                                const deltaY = winCenterY - centerY;
                                                
                                                if (Math.abs(deltaX) >= Math.abs(deltaY)) {
                                                    offsetX = deltaX > constants.ANIMATION_DIFF_THRESHOLD ? OFFSET : (deltaX < -constants.ANIMATION_DIFF_THRESHOLD ? -OFFSET : 0);
                                                } else {
                                                    offsetY = deltaY > constants.ANIMATION_DIFF_THRESHOLD ? OFFSET : (deltaY < -constants.ANIMATION_DIFF_THRESHOLD ? -OFFSET : 0);
                                                }
                                            }
                                        } 
                                        // 2. Directional Logic (Single window or strict override)
                                        else if (direction !== 0) {
                                            // Apply direction-based offset
                                            // Coming from LEFT (dir -1): Start at Left (-Offset) -> Move to 0
                                            // Coming from RIGHT (dir 1): Start at Right (+Offset) -> Move to 0
                                            offsetX = direction * OFFSET * 3; // Increase offset for "coming from outside" feel
                                            animationMode = Clutter.AnimationMode.EASE_OUT_BACK; // Momentum for directional
                                        }
                                        
                                        if (offsetX !== 0 || offsetY !== 0) {
                                            Logger.log(`[MOSAIC WM] FIRST-FRAME SLIDE-IN: Applying offset (${offsetX}, ${offsetY}) to window ${win.get_id()} Mode: ${animationMode}`);
                                            
                                            // Mark as animating to prevent other animations from overwriting
                                            WindowState.set(win, 'slideInAnimating', true);
                                            
                                            // FORCE KILL GNOME ANIMATION & PREPARE OURS
                                            actor.remove_all_transitions();
                                            actor.set_scale(1.0, 1.0);
                                            actor.set_opacity(0); // Start invisible
                                            actor.set_pivot_point(0.5, 0.5);
                                            actor.set_translation(offsetX, offsetY, 0);
                                            
                                            // Wait one tick for the initial state to be applied, then animate
                                            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                                                if (!actor.get_parent()) return GLib.SOURCE_REMOVE; 
                                                
                                                actor.ease({
                                                    translation_x: 0,
                                                    translation_y: 0,
                                                    opacity: 255, // Fade in
                                                    duration: 250,
                                                    mode: animationMode,
                                                    onComplete: () => {
                                                        WindowState.remove(win, 'slideInAnimating');
                                                    }
                                                });
                                                return GLib.SOURCE_REMOVE;
                                            });
                                        }
                                        
                                        // Clear flags
                                        WindowState.remove(win, 'needsSlideIn');
                                        WindowState.remove(win, 'slideInExistingWindows');
                                        WindowState.remove(win, 'slideInDirection');
                                    }
                                });
                            }
                        } else {
                            Logger.log(`[MOSAIC WM] SLIDE-IN: First window ${win.get_id()} - no animation needed`);
                        }
                    }
                }
            });
            
            // Track signal for cleanup
            WindowState.set(window, 'configureSignalId', configureId);
        } catch (e) {
            Logger.log(`[MOSAIC WM] SLIDE-IN: Failed to connect configure signal: ${e.message}`);
        }
        
        // Mark window as newly added for overflow protection logic
        WindowState.set(window, 'addedTime', Date.now());
        
        // Save initial position for animation later
        
        // Use timeout_add instead of setInterval
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (this.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                
                const frame = WINDOW.get_frame_rect();
                const hasValidDimensions = frame.width > 0 && frame.height > 0;
                
                if (hasValidDimensions) {
                    Logger.log(`[TRACE] WINDOW OPENED: "${WINDOW.get_wm_class()}" size=${frame.width}x${frame.height}`);
                }

                
                
                const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
                const removedTimestamp = WindowState.get(WINDOW, 'removedTimestamp');
                const timeSinceRemoved = removedTimestamp ? Date.now() - removedTimestamp : Infinity;
                const isManualMove = WindowState.get(WINDOW, 'manualWorkspaceMove');
                
                const workArea = WORKSPACE.get_work_area_for_monitor(MONITOR);
                Logger.log(`[MOSAIC WM] window-added: window=${WINDOW.get_id()}, size=${frame.width}x${frame.height}, workArea=${workArea.width}x${workArea.height}, timeSince=${timeSinceRemoved}ms, prevWS=${previousWorkspaceIndex}, currentWS=${WORKSPACE.index()}, isManual=${isManualMove}`);
                
                if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index() && timeSinceRemoved < constants.SAFETY_TIMEOUT_BUFFER_MS) {
                    // Skip if this is an overflow move, not a real drag-drop
                    if (WindowState.get(WINDOW, 'movedByOverflow')) {
                        Logger.log(`[MOSAIC WM] window-added: Skipping drag-drop handling - window was moved by overflow`);
                    } else {
                        Logger.log(`[MOSAIC WM] window-added: Overview drag-drop - window ${WINDOW.get_id()} from workspace ${previousWorkspaceIndex} to ${WORKSPACE.index()}`);
                        
                        // ACTIVATE destination workspace and EXIT Overview
                        Logger.log(`[MOSAIC WM] DnD: Activating workspace ${WORKSPACE.index()} and exiting Overview`);
                        WORKSPACE.activate(global.get_current_time());
                        
                        // Mark as DnD arrival - will trigger expansion after tiling
                        WindowState.set(WINDOW, 'arrivedFromDnD', true);
                        
                        // Wait for overview to fully close before tiling
                        // This ensures move_resize_frame works correctly
                        if (Main.overview.visible) {
                            WindowState.set(WINDOW, 'deferTilingUntilOverviewHidden', true);
                            Main.overview.hide();
                        }
                        
                        // Clear DnD tracking - normal flow will handle window
                        WindowState.remove(WINDOW, 'previousWorkspace');
                        WindowState.remove(WINDOW, 'removedTimestamp');
                        WindowState.remove(WINDOW, 'manualWorkspaceMove');
                        
                        // Let waitForGeometry flow handle the window
                    }
                }
                // Mark window as waiting for geometry - prevents premature overflow
                WindowState.set(WINDOW, 'waitingForGeometry', true);
                
                const waitForGeometry = () => {
            const rect = WINDOW.get_frame_rect();
            
            if (rect.width > 0 && rect.height > 0) {
                // Geometry ready - clear flag
                WindowState.set(WINDOW, 'waitingForGeometry', false);
                        WindowState.set(WINDOW, 'geometryReady', true);
                        
                        // CRITICAL: Skip ALL tiling logic for excluded windows (modals, transients, etc.)
                        // BUT still connect signals to track status changes (e.g. Always on Top)
                        if (this.windowingManager.isExcluded(WINDOW)) {
                            Logger.log(`[MOSAIC WM] waitForGeometry: Window is excluded (modal/transient) - connecting signals but skipping tiling`);
                            this.windowHandler.connectWindowSignals(WINDOW);
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
                        Logger.log(`[MOSAIC WM] Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`);
                        
                        // Skip early tiling for overflow moved windows
                        if (WindowState.get(WINDOW, 'movedByOverflow')) {
                            Logger.log(`[MOSAIC WM] Skipping early tile in waitForGeometry - window was moved by overflow`);
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        // If overview is visible when window is created/dropped,
                        // tile immediately (may reflect in overview) then also after overview closes
                        if (Main.overview.visible) {
                            Logger.log(`[MOSAIC WM] Window created while overview visible - tiling now + after hide`);
                            
                            // Mark this window to skip slide-in animation after overview closes
                            WindowState.set(WINDOW, 'createdDuringOverview', true);
                            
                            // Save preferred size first
                            this.tilingManager.savePreferredSize(WINDOW);
                            this.windowHandler.connectWindowSignals(WINDOW);
                            
                            // Tile immediately (positions may reflect in overview via MosaicLayoutStrategy)
                            // Use calculateLayoutsOnly to update cache without moving windows (safer for Overview)
                            this.tilingManager.calculateLayoutsOnly();
                            
                            // Force overview to re-layout window clones (deferred to avoid allocation cycle)
                            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                                try {
                                    if (Main.overview.visible) {
                                        const overview = Main.overview._overview;
                                        // Trigger layout update on all workspace displays
                                        if (overview && overview.controls) {
                                            const wsDisplay = overview.controls._workspacesDisplay;
                                            if (wsDisplay) {
                                                Logger.log('[MOSAIC WM] Triggering workspace display relayout');
                                                wsDisplay.queue_relayout();
                                                // Also try to force layout change on active workspace view if accessible
                                                // This is the "Nuclear Option" for forcing a redraw
                                                if (wsDisplay._workspacesViews) {
                                                    Logger.log(`[MOSAIC WM] Found ${wsDisplay._workspacesViews.length} workspace views - forcing layout_changed`);
                                                    for (let view of wsDisplay._workspacesViews) {
                                                        if (view._layoutManager) {
                                                            view._layoutManager.layout_changed();
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } catch (e) {
                                    Logger.log(`[MOSAIC WM] Could not force overview relayout: ${e.message}`);
                                }
                                return GLib.SOURCE_REMOVE;
                            });
                            
                            // Also tile after overview closes to guarantee positions are applied
                            afterOverviewHidden(() => {
                                Logger.log(`[MOSAIC WM] Post-overview retile for robustness`);
                                this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                            }, this._timeoutRegistry);
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        // CRITICAL: Save preferred size NOW when geometry is ready but BEFORE Smart Resize
                        // This captures the window's actual size for Reverse Smart Resize
                        this.tilingManager.savePreferredSize(WINDOW);
                        
                        // FALLBACK: If configure signal didn't fire in time, set slide-in flag now
                        // Skip for windows created during overview (already positioned)
                        if (!WindowState.get(WINDOW, 'needsSlideIn') && !WindowState.get(WINDOW, 'slideInChecked') && !WindowState.get(WINDOW, 'createdDuringOverview')) {
                            WindowState.set(WINDOW, 'slideInChecked', true);
                            const existingWindows = WORKSPACE.list_windows().filter(w =>
                                w.get_monitor() === MONITOR &&
                                w.get_id() !== WINDOW.get_id() &&
                                !w.is_hidden() &&
                                w.get_window_type() === Meta.WindowType.NORMAL &&
                                !this.windowingManager.isExcluded(w)
                            );
                            if (existingWindows.length > 0) {
                                WindowState.set(WINDOW, 'needsSlideIn', true);
                                WindowState.set(WINDOW, 'slideInExistingWindows', existingWindows);
                                Logger.log(`[MOSAIC WM] SLIDE-IN FALLBACK: Marked window ${WINDOW.get_id()} (${existingWindows.length} existing)`);
                            }
                        }
                        
                        // Protect against premature overflow during initial tiling/smart resize
                        WindowState.set(WINDOW, 'isSmartResizing', true);
                        
                        // Attempt smart resize first!
                        // Calculate REAL usable area (subtracting edge tiles)
                        const workArea = this.tilingManager.getUsableWorkArea(WORKSPACE, MONITOR);
                        
                        // If workArea is depleted (e.g. 2 edge tiles), we can't fit anything
                        if (workArea.width <= 0 || workArea.height <= 0) {
                             Logger.log('[MOSAIC WM] waitForGeometry: No usable work area (fully edge tiled?)');
                             // Let standard overflow handling take over
                        } else {
                            // Check for "Sacred" Maximized Windows before doing anything
                            // IMPORTANT: Filter out excluded windows (modals, transients, etc.)
                            const allWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                                .filter(w => !this.windowingManager.isExcluded(w));
                            
                            // Use Work Area (excluding docks/panels) for comparison
                            const workAreaRect = WORKSPACE.get_work_area_for_monitor(MONITOR);
                            
                            Logger.log(`[MOSAIC WM] Sacred Check: Analyzing ${allWindows.length} windows in workspace (WorkArea: ${workAreaRect.width}x${workAreaRect.height})`);

                            const hasMaximized = allWindows.some(w => {
                                if (w.get_id() === WINDOW.get_id()) return false;
                                
                                const id = w.get_id();
                                const isMaximized = w.maximized_horizontally || w.maximized_vertically;
                                const frame = w.get_frame_rect();
                                const isEdge = this.edgeTilingManager.isEdgeTiled(w);
                                
                                // Debug log for each window
                                Logger.log(`[MOSAIC WM] Window ${id}: Maximized=${isMaximized}, Rect=${frame.width}x${frame.height}, Edge=${isEdge}`);
                                
                                // 1. Check official flags only (Maximized or Fullscreen)
                                if (isMaximized) {
                                    Logger.log(`[MOSAIC WM] Window ${id} IS SACRED (Maximized)`);
                                    return true;
                                }
                                
                                if (w.is_fullscreen()) {
                                    Logger.log(`[MOSAIC WM] Window ${id} IS SACRED (Fullscreen)`);
                                    return true;
                                }
                                
                                return false;
                            });
                            
                            if (hasMaximized) {
                                Logger.log('[MOSAIC WM] waitForGeometry: Sacred Maximized window detected - forcing overflow');
                                this.windowingManager.moveOversizedWindow(WINDOW);
                                return GLib.SOURCE_REMOVE;
                            }

                            const existingWindows = allWindows
                                .filter(w => w.get_id() !== WINDOW.get_id() && 
                                        !this.edgeTilingManager.isEdgeTiled(w) && 
                                        !(w.maximized_horizontally || w.maximized_vertically) &&
                                        !w.is_fullscreen());
                            
                            Logger.log(`[MOSAIC WM] waitForGeometry: existingWindows=${existingWindows.length} (mosaic)`);
                            
                            // NOTE: Do NOT call tryFitWithResize here - let _windowAdded handle it with proper polling
                            // Just track window ID for tile skip decision
                            let processed = _smartResizeProcessedWindows.get(WORKSPACE);
                            if (!processed) {
                                processed = new Set();
                                _smartResizeProcessedWindows.set(WORKSPACE, processed);
                            }
                        }
                        
                        // Only call tileWorkspaceWindows if smart resize was NOT processed
                        // If it was, the delayed callback in _windowAdded will handle tiling
                        let processed = _smartResizeProcessedWindows.get(WORKSPACE);
                        if (!processed || !processed.has(WINDOW.get_id())) {
                            // PRE-FIT CHECK: Verify window will fit BEFORE tiling to avoid mosaic disruption
                            const preFitCheck = this.tilingManager.canFitWindow(WINDOW, WORKSPACE, MONITOR);
                            const mosaicWindowsPreCheck = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                                .filter(w => !this.edgeTilingManager.isEdgeTiled(w));
                            const isSoloPreCheck = mosaicWindowsPreCheck.length <= 1;
                            
                            if (!preFitCheck && !isSoloPreCheck) {
                                Logger.log('[MOSAIC WM] PRE-FIT CHECK: Window will NOT fit - attempting Smart Resize first');
                                
                                // Try Smart Resize before giving up
                                const existingForResize = mosaicWindowsPreCheck.filter(w => 
                                    w.get_id() !== WINDOW.get_id() &&
                                    !(w.maximized_horizontally || w.maximized_vertically) &&
                                    !w.is_fullscreen()
                                );
                                
                                const smartResizeSuccess = this.tilingManager.tryFitWithResize(WINDOW, existingForResize, workArea);
                                
                                if (smartResizeSuccess) {
                                    Logger.log('[MOSAIC WM] PRE-FIT CHECK: Smart Resize initiated - will tile after polling');
                                    // Mark for smart resize polling
                                    let p = _smartResizeProcessedWindows.get(WORKSPACE);
                                    if (!p) {
                                        p = new Set();
                                        _smartResizeProcessedWindows.set(WORKSPACE, p);
                                    }
                                    p.add(WINDOW.get_id());
                                    
                                    // GHOST STATE: Make window semi-transparent while calculating fit
                                    const actor = WINDOW.get_compositor_private();
                                    if (actor) {
                                        actor.opacity = 153; // 60% opacity
                                        Logger.log('[MOSAIC WM] Ghost state: Window opacity set to 60%');
                                    }
                                    
                                    // Start polling for fit
                                    const windowId = WINDOW.get_id();
                                    const initialWorkspaceIndex = WORKSPACE.index();
                                    let attempts = 0;
                                    let consecutiveNoChange = 0;
                                    
                                    const pollForFit = () => {
                                        // Abort if window was moved to another workspace
                                        if (WINDOW.get_workspace().index() !== initialWorkspaceIndex) {
                                            let p = _smartResizeProcessedWindows.get(WORKSPACE);
                                            if (p) p.delete(windowId);
                                            WindowState.set(WINDOW, 'isSmartResizing', false);
                                            return GLib.SOURCE_REMOVE;
                                        }
                                        
                                        attempts++;
                                        const canFitNow = this.tilingManager.canFitWindow(WINDOW, WORKSPACE, MONITOR);
                                        
                                        if (canFitNow) {
                                            Logger.log(`[MOSAIC WM] PRE-FIT: Smart resize successful after ${attempts} polls`);
                                            // Restore opacity from ghost state
                                            const successActor = WINDOW.get_compositor_private();
                                            if (successActor) successActor.opacity = 255;
                                            
                                            let p = _smartResizeProcessedWindows.get(WORKSPACE);
                                            if (p) p.delete(windowId);
                                            
                                            WindowState.set(WINDOW, 'isSmartResizing', false);
                                            this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                                            
                                            // After tiling, try to expand windows towards their opening sizes
                                            // Only if there's available space
                                            const allWins = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                                                .filter(w => !this.edgeTilingManager.isEdgeTiled(w) &&
                                                             !this.windowingManager.isExcluded(w));
                                            
                                            // Calculate current used space and check if there's extra
                                            const usedWidth = allWins.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
                                            const totalSpacing = (allWins.length + 1) * constants.WINDOW_SPACING;
                                            const availableExtra = workArea.width - usedWidth - totalSpacing;
                                            
                                            // Logger.log(`[MOSAIC WM] PRE-FIT expansion check: usedWidth=${usedWidth}, workArea.width=${workArea.width}, availableExtra=${availableExtra}`);
                                            if (availableExtra > 20) { // Only expand if meaningful space available
                                                Logger.log(`[MOSAIC WM] DnD: Extra space ${availableExtra}px available - trying expansion`);
                                                this.tilingManager.tryRestoreWindowSizes(allWins, workArea, availableExtra, workArea.height, WORKSPACE, MONITOR);
                                            }
                                            
                                            return GLib.SOURCE_REMOVE;
                                        }
                                        
                                        // SMART DETECTION: Calculate available space to determine if overflow is unavoidable
                                        const mosaicWins = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                                            .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && w.get_id() !== windowId);
                                        
                                        const existingTotalWidth = mosaicWins.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
                                        const spacing = (mosaicWins.length + 1) * constants.WINDOW_SPACING;
                                        const availableForNew = workArea.width - existingTotalWidth - spacing;
                                        const newFrame = WINDOW.get_frame_rect();
                                        
                                        if (availableForNew <= constants.MIN_AVAILABLE_SPACE_PX) {
                                            Logger.log(`[MOSAIC WM] PRE-FIT: Available space ${availableForNew}px <= 50px - overflow unavoidable`);
                                            // Restore opacity before overflow
                                            const actor50 = WINDOW.get_compositor_private();
                                            if (actor50) actor50.opacity = 255;
                                            
                                            let p = _smartResizeProcessedWindows.get(WORKSPACE);
                                            if (p) p.delete(windowId);
                                            
                                            WindowState.set(WINDOW, 'isSmartResizing', false);
                                            this.windowingManager.moveOversizedWindow(WINDOW);
                                            return GLib.SOURCE_REMOVE;
                                        }
                                        
                                        // Note: We removed the shrink ratio check here
                                        // It was causing premature rejection when windows COULD fit
                                        // Just let the polling continue until it succeeds or times out
                                        
                                        if (attempts >= constants.PRE_FIT_MAX_ATTEMPTS) { // Pre-Fit uses max 10 attempts (500ms) for DnD resize
                                            Logger.log('[MOSAIC WM] PRE-FIT: Smart resize failed after 10 polls - triggering overflow');
                                            // Restore opacity before overflow
                                            const actor10 = WINDOW.get_compositor_private();
                                            if (actor10) actor10.opacity = 255;
                                            
                                            let p = _smartResizeProcessedWindows.get(WORKSPACE);
                                            if (p) p.delete(windowId);
                                            
                                            WindowState.set(WINDOW, 'isSmartResizing', false);
                                            this.windowingManager.moveOversizedWindow(WINDOW);
                                            return GLib.SOURCE_REMOVE;
                                        }
                                        
                                        return GLib.SOURCE_CONTINUE;
                                    };
                                    
                                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.POLL_INTERVAL_MS, pollForFit);
                                    return GLib.SOURCE_REMOVE;
                                } else {
                                    // Smart Resize failed immediately - overflow without tiling
                                    Logger.log('[MOSAIC WM] PRE-FIT CHECK: Smart Resize failed - overflow immediately');
                                    // Restore opacity before overflow
                                    const actorImm = WINDOW.get_compositor_private();
                                    if (actorImm) actorImm.opacity = 255;
                                    this.windowingManager.moveOversizedWindow(WINDOW);
                                    return GLib.SOURCE_REMOVE;
                                }
                            }
                            
                            // Window fits or is solo - tile normally
                            const isDnDArrival = WindowState.get(WINDOW, 'arrivedFromDnD');
                            
                            const performTiling = () => {
                                // If arriving from DnD, pass null to enable animation (since default suppresses)
                                // If new window, pass WINDOW to suppress animation (default behavior for new windows)
                                const refWindow = isDnDArrival ? null : WINDOW;
                                this.tilingManager.tileWorkspaceWindows(WORKSPACE, refWindow, MONITOR, true);
                                
                                // If window arrived from DnD, try to expand it towards opening size
                                if (isDnDArrival) {
                                    WindowState.set(WINDOW, 'arrivedFromDnD', false);
                                    
                                    const monitorWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                                        .filter(w => !this.edgeTilingManager.isEdgeTiled(w) &&
                                                     !this.windowingManager.isExcluded(w));
                                    const preferredSize = this.tilingManager.getPreferredSize(WINDOW);
                                    
                                    if (preferredSize && monitorWindows.length === 1) {
                                        // Solo window - fully restore to preferred size
                                        const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
                                        const win = monitorWindows[0];
                                        const currentRect = win.get_frame_rect();
                                        const x = currentRect.x;
                                        const y = currentRect.y;
                                        
                                        const targetW = Math.min(preferredSize.width, wa.width - constants.WINDOW_SPACING * 2);
                                        const targetH = Math.min(preferredSize.height, wa.height - constants.WINDOW_SPACING * 2);
                                        
                                        Logger.log(`[MOSAIC WM] DnD Solo: Fully restoring window to ${targetW}x${targetH}`);
                                        win.move_resize_frame(true, x, y, targetW, targetH);
                                    } else {
                                        // Fallback for multiple windows (Width expansion mostly)
                                        const usedWidth = monitorWindows.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
                                        const totalSpacing = (monitorWindows.length + 1) * constants.WINDOW_SPACING;
                                        const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
                                        const availableExtra = wa.width - usedWidth - totalSpacing;
                                        
                                        if (availableExtra > constants.ANIMATION_DIFF_THRESHOLD) { // Only expand if meaningful space available
                                            Logger.log(`[MOSAIC WM] DnD arrival: Extra space ${availableExtra}px - trying expansion`);
                                            this.tilingManager.tryRestoreWindowSizes(monitorWindows, wa, availableExtra, wa.height, WORKSPACE, MONITOR);
                                        }
                                    }
                                }
                            };
                            
                            // All cross-workspace moves: Wait for FULL workspace animation
                            // This includes DnD, Overflow, and keyboard moves
                            if (isDnDArrival || WindowState.get(WINDOW, 'movedByOverflow') || (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index())) {
                                Logger.log(`[MOSAIC WM] Cross-workspace move: Waiting for workspace animation`);
                                afterWorkspaceSwitch(performTiling, this._timeoutRegistry);
                            } else {
                                // Same workspace - tile immediately
                                performTiling();
                            }
                        } else {
                            Logger.log('[MOSAIC WM] waitForGeometry: Skipping immediate tile - smart resize in progress');
                        }
                        
                        // Clear protection after delay to allow resizes to settle
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RETILE_DELAY_MS, () => {
                            // Only clear if NOT managed by _windowAdded polling loop 
                            // (checked via _smartResizeProcessedWindows existing for this window)
                            let p = _smartResizeProcessedWindows.get(WORKSPACE);
                            if (!p || !p.has(WINDOW.get_id())) {
                                WindowState.set(WINDOW, 'isSmartResizing', false);
                                Logger.log('[MOSAIC WM] Smart resize protection cleared (timeout)');
                            }
                            
                            // One final check if things fit now
                            // SKIP if window was already moved by overflow to prevent double movement
                            if (WindowState.get(WINDOW, 'movedByOverflow')) {
                                Logger.log('[MOSAIC WM] Skipping final overflow check - window already moved');
                                return GLib.SOURCE_REMOVE;
                            }
                            
                            // SKIP if smart resize is still running - let pollForFit handle overflow
                            if (WindowState.get(WINDOW, 'isSmartResizing')) {
                                Logger.log('[MOSAIC WM] Skipping final overflow check - smart resize in progress');
                                return GLib.SOURCE_REMOVE;
                            }
                            
                            const canFitFinal = this.tilingManager.canFitWindow(WINDOW, WORKSPACE, MONITOR);
                            // FAILSAFE: Ensure we never move a solo window
                            const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                                      .filter(w => !this.edgeTilingManager.isEdgeTiled(w));
                            const isSolo = mosaicWindows.length <= 1;

                            if (!canFitFinal) {
                                if (isSolo) {
                                    Logger.log('[MOSAIC WM] Overflow detected but window is solo - suppressing move (failsafe)');
                                } else {
                                    // If still doesn't fit after protection expires, trigger overflow manually
                                    Logger.log('[MOSAIC WM] Still overflow after protection - triggering manual move');
                                    this.windowingManager.moveOversizedWindow(WINDOW);
                                }
                            }
                            return GLib.SOURCE_REMOVE;
                        });
                        
                        return GLib.SOURCE_REMOVE;
                    }
                    return GLib.SOURCE_CONTINUE;
                };
                
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.GEOMETRY_CHECK_DELAY_MS, waitForGeometry);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _windowRemoved = (workspace, window) => {
        if (!this.windowingManager.isRelated(window)) {
            return;
        }
        
        WindowState.set(window, 'previousWorkspace', workspace.index());
        WindowState.set(window, 'removedTimestamp', Date.now());
        
        // SKIP if window was moved by overflow - don't trigger restore for overflow moves
        // This prevents cascade: window overflows → restore grows another → that one overflows too
        const wasMovedByOverflow = WindowState.get(window, 'movedByOverflow');
        
        // Capture removed window's size BEFORE any operations (for Reverse Smart Resize)
        const removedFrame = window.get_frame_rect();
        const freedWidth = removedFrame.width;
        const freedHeight = removedFrame.height;
        
        // Only clear opening size if window is actually being destroyed (not moved)
        // Check if window still has an actor (destroyed windows don't)
        const actor = window.get_compositor_private();
        if (!actor) {
            this.tilingManager.clearPreferredSize(window);
        } else {
            Logger.log(`[MOSAIC WM] _windowRemoved: Window still exists (DnD move) - keeping preferred size`);
        }
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = workspace;
            const MONITOR = global.display.get_primary_monitor();

            // Check if workspace still exists and has windows
            if (!WORKSPACE || WORKSPACE.index() < 0) {
                return GLib.SOURCE_REMOVE;
            }
            
            // Get remaining windows in workspace (exclude edge tiles and the removed window)
            const removedId = window.get_id();
            const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                .filter(w => w.get_id() !== removedId &&
                             !this.edgeTilingManager.isEdgeTiled(w) && 
                             !this.windowingManager.isExcluded(w));
            
            Logger.log(`[MOSAIC WM] _windowRemoved: ${remainingWindows.length} remaining windows, freed ${freedWidth}x${freedHeight}, wasOverflowMove=${wasMovedByOverflow}`);
            
            // Try to restore window sizes with freed space (Reverse Smart Resize)
            // Note: We deliberately allow this even for overflow moves to recover from failed Smart Resize attempts
            if (remainingWindows.length > 0) {
                const workArea = this.tilingManager.getUsableWorkArea(WORKSPACE, MONITOR);
                const restored = this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, WORKSPACE, MONITOR);
                
                if (restored) {
                    // Delay retile to let the resize command be applied by Mutter
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_SETTLE_DELAY_MS, () => {
                        Logger.log('[MOSAIC WM] Retiling after restore delay');
                        this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    // No restoration, retile immediately
                    this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                }
            } else {
                // Workspace is now empty of mosaic windows
                // Check if there are ANY related windows (including edge-tiled) before navigating
                // Note: window-removed fires BEFORE actual removal, so filter out the removed window
                const allRelatedWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                    .filter(w => w.get_id() !== removedId);
                if (allRelatedWindows.length === 0) {
                    // Guard: verify workspace still valid (GNOME may auto-remove empty workspaces)
                    if (WORKSPACE.index() < 0) {
                        Logger.log('[MOSAIC WM] _windowRemoved: Workspace already destroyed, skipping navigation');
                        return GLib.SOURCE_REMOVE;
                    }
                    Logger.log('[MOSAIC WM] _windowRemoved: Workspace truly empty, navigating away');
                    this.windowingManager.renavigate(WORKSPACE, WORKSPACE.active, this._lastVisitedWorkspace);
                }
            }
            
            return GLib.SOURCE_REMOVE;
        });
    };

    _workspaceAddSignal = (_, workspaceIdx) => {
        const workspace = this._workspaceManager.get_workspace_by_index(workspaceIdx);
        let eventIds = [];
        eventIds.push(workspace.connect("window-added", this._windowAdded));
        eventIds.push(workspace.connect("window-removed", this._windowRemoved));
        this._workspaceEventIds.push([workspace, eventIds]);
    };
    

    enable() {
        Logger.info("[MOSAIC WM]: Starting Mosaic layout manager.");

        // Get workspace manager reference
        this._workspaceManager = global.workspace_manager;
        
        // Initialize mutter settings + failsafe: Ensure attach-modal-dialogs is enabled
        // (in case extension crashed during Overview with setting disabled)
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        try {
            if (!this._mutterSettings.get_boolean('attach-modal-dialogs')) {
                this._mutterSettings.set_boolean('attach-modal-dialogs', true);
                Logger.log('[MOSAIC WM] Failsafe: Restored attach-modal-dialogs setting');
            }
        } catch (e) {
            // Ignore - setting may not exist
        }
        
        // Create managers
        this.edgeTilingManager = new EdgeTilingManager();
        this.tilingManager = new TilingManager();
        this.tilingManager.setExtension(this);
        _tilingManagerInstance = this.tilingManager; // Expose for overviewLayout.js
        this.reorderingManager = new ReorderingManager();
        this.swappingManager = new SwappingManager();
        this.drawingManager = new DrawingManager();
        this.animationsManager = new AnimationsManager();
        this.windowingManager = new WindowingManager();

        // Wire up dependencies
        this.windowingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.windowingManager.setAnimationsManager(this.animationsManager);
        this.windowingManager.setTilingManager(this.tilingManager);
        this.windowingManager.setTimeoutRegistry(this._timeoutRegistry);
        this.windowingManager.setOverflowCallbacks(
            () => { this._overflowInProgress = true; },
            () => { this._overflowInProgress = false; }
        );
        
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
        
        // Create handler classes (receive extension reference)
        this.windowHandler = new WindowHandler(this);
        this.dragHandler = new DragHandler(this);
        this.resizeHandler = new ResizeHandler(this);
        
        // Initialize Quick Settings indicator
        this._mosaicIndicator = new MosaicIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._mosaicIndicator);
        
        
        this._windowsOpenedMaximized = new Set();
        
        this._settingsOverrider = new SettingsOverrider();
        
        this._settingsOverrider.add(
            new Gio.Settings({ schema_id: 'org.gnome.mutter' }),
            'edge-tiling',
            new GLib.Variant('b', false)
        );
        
        // Disable attach-modal-dialogs to prevent squashed Overview previews
        // When enabled, attached dialogs expand the window bounding box causing layout issues
        this._settingsOverrider.add(
            this._mutterSettings,
            'attach-modal-dialogs',
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
        
        // Override Overview layout to preserve mosaic positions
        this._injectionManager = new InjectionManager();
        const layoutProto = Workspace.WorkspaceLayout.prototype;
        this._injectionManager.overrideMethod(layoutProto, '_createBestLayout', () => {
            return function () {
                this._layoutStrategy = new MosaicLayoutStrategy({
                    monitor: Main.layoutManager.monitors[this._monitorIndex],
                });
                return this._layoutStrategy.computeLayout(this._sortedWindows);
            };
        });
        
        this._wmEventIds.push(global.window_manager.connect('size-change', this._sizeChangeHandler));
        this._wmEventIds.push(global.window_manager.connect('size-changed', this._sizeChangedHandler));
        this._displayEventIds.push(global.display.connect('window-created', this._windowCreatedHandler));
        this._wmEventIds.push(global.window_manager.connect('destroy', this._destroyedHandler));
        this._displayEventIds.push(global.display.connect("grab-op-begin", this._grabOpBeginHandler));
        this._displayEventIds.push(global.display.connect("grab-op-end", this._grabOpEndHandler));
        
        this._onOverviewHiddenId = Main.overview.connect('hidden', () => {
            const workspace = this.windowingManager.getWorkspace();
            const monitor = global.display.get_primary_monitor();
            const windows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
            
            for (const win of windows) {
                if (WindowState.get(win, 'deferTilingUntilOverviewHidden')) {
                    Logger.log(`[MOSAIC WM] Overview hidden: Tiling deferred window ${win.get_id()}`);
                    WindowState.remove(win, 'deferTilingUntilOverviewHidden');
                    this.tilingManager.tileWorkspaceWindows(workspace, win, monitor, false);
                }
            }
        });
        
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
                // Always connect exclusion signals, even if excluded
                this.windowHandler.connectWindowSignals(window);
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
        
        // DISABLED: Periodic retile every 5 minutes was a safety net for missed signals.
        // Now that we have proper signal handlers for all state changes (window-added,
        // window-removed, notify::above, notify::on-all-workspaces, grab-op-*, etc.),
        // this polling is unnecessary and wastes CPU cycles. Re-enable if layout bugs
        // are found that signals don't catch.
        // this._tileTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.TILE_INTERVAL_MS, () => {
        //     this._tileAllWorkspaces();
        //     return GLib.SOURCE_CONTINUE;
        // });
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
        
        // Clear all managed timeouts first
        if (this._timeoutRegistry) {
            this._timeoutRegistry.clearAll();
        }
        
        if (this._resizeDebounceTimeout) {
            GLib.source_remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }
        Logger.info("[MOSAIC WM]: Disabling Mosaic layout manager.");
        
        if (this._settingsOverrider) {
            this._settingsOverrider.destroy();
            this._settingsOverrider = null;
        }
        
        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }
        
        // Restore original map animation
        if (this._originalMapWindow) {
            Main.wm._mapWindow = this._originalMapWindow;
            this._originalMapWindow = null;
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
        
        if (this._dragPositionChangedId && this._draggedWindow) {
            try {
                this._draggedWindow.disconnect(this._dragPositionChangedId);
            } catch (e) {
                Logger.log(`[MOSAIC WM] Failed to disconnect window signal: ${e.message}`);
            }
            this._dragPositionChangedId = 0;
        }
        if (this._dragEventFilterId) {
            Clutter.Event.remove_filter(this._dragEventFilterId);
            this._dragEventFilterId = 0;
        }

        if (this.edgeTilingManager) this.edgeTilingManager.destroy();
        if (this.drawingManager) this.drawingManager.destroy();
        if (this.animationsManager) this.animationsManager.destroy();
        
        // Destroy Quick Settings indicator
        if (this._mosaicIndicator) {
            this._mosaicIndicator.destroy();
            this._mosaicIndicator = null;
        }
        
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
        
        if (this._onOverviewHiddenId) {
            Main.overview.disconnect(this._onOverviewHiddenId);
            this._onOverviewHiddenId = 0;
        }

        // Cleanup handled by WindowHandler and WindowState
        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        allWindows.forEach(w => {
            if (this.windowHandler) this.windowHandler.disconnectWindowSignals(w);
        });
        
        if (this._workspaceChangeTimeout) {
            GLib.source_remove(this._workspaceChangeTimeout);
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
        
        // Clean up handler classes
        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;
    }
}