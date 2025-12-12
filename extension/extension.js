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
        this._overflowInProgress = false;  // Flag to prevent empty workspace navigation during overflow
        this._restoringFromEdgeTile = false;  // Flag to prevent overflow during edge tile restoration
        
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
                
                if(!canFit && !window._movedByOverflow) {
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
                        // Check flags only (Maximized or Fullscreen)
                        return w.maximized_horizontally || w.maximized_vertically || w.is_fullscreen();
                    });
                    
                    if (hasSacredWindow) {
                        Logger.log('[MOSAIC WM] Sacred window detected - skipping smart resize, forcing overflow');
                        this.windowingManager.moveOversizedWindow(window);
                        this._connectWindowWorkspaceSignal(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    
                    // Filter to resizable windows only (non-sacred)
                    const existingWindows = allExistingWindows.filter(w => {
                        return !(w.maximized_horizontally || w.maximized_vertically || w.is_fullscreen());
                    });
                    
                    if (existingWindows.length > 0) {
                        // Prevent duplicate calls for the SAME NEW WINDOW using workspace-level tracking
                        if (!workspace._smartResizeProcessedWindows) {
                            workspace._smartResizeProcessedWindows = new Set();
                        }
                        
                        const windowId = window.get_id();
                        if (workspace._smartResizeProcessedWindows.has(windowId)) {
                            Logger.log('[MOSAIC WM] Smart resize already processed for this window - skipping');
                            this._connectWindowWorkspaceSignal(window);
                            return GLib.SOURCE_REMOVE;
                        }
                        workspace._smartResizeProcessedWindows.add(windowId);
                        
                        const resizeSuccess = this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                        
                        if (resizeSuccess) {
                            Logger.log('[MOSAIC WM] Smart resize applied - starting fit check polling');
                            
                            // SET PROTECTION FLAG (Window-level for robustness)
                            window._isSmartResizing = true;
                            
                            // GHOST STATE: Make window semi-transparent while calculating fit
                            const ghostActor = window.get_compositor_private();
                            if (ghostActor) {
                                ghostActor.opacity = 153; // 60% opacity
                                Logger.log('[MOSAIC WM] Ghost state: Window opacity set to 60%');
                            }
                            
                            // Capture initial sizes for stuck detection
                            const initialSizes = new Map();
                            existingWindows.forEach(w => {
                                const frame = w.get_frame_rect();
                                initialSizes.set(w.get_id(), { width: frame.width, height: frame.height });
                            });
                            
                            // Track windows that are truly stuck at minimum
                            const stuckWindows = new Set();
                            let retryAttempts = 0;
                            const MAX_RETRIES = 2; // Max times to retry with learned minimums
                            
                            // Polling: Check if window fits, retry until success or max attempts
                            const MAX_ATTEMPTS = 12;
                            const POLL_INTERVAL = 75; // 75ms * 12 = 900ms max
                            
                            // Capture initial workspace to detect moves
                            const initialWorkspaceIndex = workspace.index();
                            
                            let attempts = 0;
                            const pollForFit = () => {
                                // CRITICAL CHECK: Abort if window was moved to another workspace (e.g. by overflow protection)
                                if (window.get_workspace().index() !== initialWorkspaceIndex) {
                                    Logger.log(`[MOSAIC WM] Window moved to workspace ${window.get_workspace().index()} (expected ${initialWorkspaceIndex}) - aborting smart resize poll`);
                                    workspace._smartResizeProcessedWindows?.delete(windowId);
                                    window._isSmartResizing = false;
                                    return GLib.SOURCE_REMOVE;
                                }
                                attempts++;
                                const canFitNow = this.tilingManager.canFitWindow(window, workspace, monitor);
                                
                                if (canFitNow) {
                                    Logger.log(`[MOSAIC WM] Smart resize successful after ${attempts} polls - window fits now`);
                                    // Restore opacity from ghost state
                                    const successActor = window.get_compositor_private();
                                    if (successActor) successActor.opacity = 255;
                                    
                                    workspace._smartResizeProcessedWindows?.delete(windowId);
                                    window._isSmartResizing = false;
                                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                                    return GLib.SOURCE_REMOVE;
                                }
                                
                                // After 4 polls (~300ms), check which windows are stuck
                                if (attempts === 4 && retryAttempts < MAX_RETRIES) {
                                    let foundStuck = false;
                                    
                                    existingWindows.forEach(w => {
                                        if (stuckWindows.has(w.get_id())) return; // Already known stuck
                                        
                                        const wId = w.get_id();
                                        const initialSize = initialSizes.get(wId);
                                        const currentFrame = w.get_frame_rect();
                                        
                                        // If window didn't shrink at all, mark as stuck
                                        if (initialSize && 
                                            currentFrame.width >= initialSize.width && 
                                            currentFrame.height >= initialSize.height) {
                                            stuckWindows.add(wId);
                                            // Store ACTUAL minimum as current size
                                            w._actualMinWidth = currentFrame.width;
                                            w._actualMinHeight = currentFrame.height;
                                            Logger.log(`[MOSAIC WM] Window ${wId} is STUCK at ${currentFrame.width}x${currentFrame.height} - marking as fixed`);
                                            foundStuck = true;
                                        }
                                    });
                                    
                                    // If we found stuck windows, retry resize with updated info
                                    if (foundStuck && stuckWindows.size < existingWindows.length) {
                                        retryAttempts++;
                                        Logger.log(`[MOSAIC WM] Retry ${retryAttempts}: Found ${stuckWindows.size} stuck windows. Redistributing load to ${existingWindows.length - stuckWindows.size} remaining windows.`);
                                        
                                        // Filter to only shrinkable windows
                                        const shrinkableWindows = existingWindows.filter(w => !stuckWindows.has(w.get_id()));
                                        
                                        if (shrinkableWindows.length > 0) {
                                            // Call tryFitWithResize again with only shrinkable windows
                                            const retrySuccess = this.tilingManager.tryFitWithResize(window, shrinkableWindows, workArea);
                                            
                                            if (retrySuccess) {
                                                // Update initial sizes for next stuck check
                                                shrinkableWindows.forEach(w => {
                                                    const frame = w.get_frame_rect();
                                                    initialSizes.set(w.get_id(), { width: frame.width, height: frame.height });
                                                });
                                                
                                                // Reset attempt counter for new polling cycle
                                                attempts = 0;
                                            }
                                        }
                                    } else if (foundStuck && stuckWindows.size === existingWindows.length) {
                                        // ALL existing windows are stuck! Try resizing the NEW window instead
                                        Logger.log(`[MOSAIC WM] ALL ${existingWindows.length} existing windows are stuck. Trying to resize NEW window to fit.`);
                                        
                                        // Calculate available space after stuck windows
                                        const stuckTotalWidth = existingWindows.reduce((sum, w) => {
                                            const frame = w.get_frame_rect();
                                            return sum + frame.width;
                                        }, 0);
                                        
                                        const spacing = (existingWindows.length + 1) * constants.WINDOW_SPACING;
                                        const availableForNew = workArea.width - stuckTotalWidth - spacing;
                                        const newFrame = window.get_frame_rect();
                                        
                                        // Check if new window already failed to resize (in a previous retry)
                                        if (window._resizeAttempted && newFrame.width >= (window._originalWidth || newFrame.width) * 0.95) {
                                            Logger.log(`[MOSAIC WM] NEW window also stuck at ${newFrame.width}px (min=${window._originalWidth}). All windows at minimum - overflow truly unavoidable.`);
                                            // Force max attempts to trigger overflow immediately
                                            attempts = MAX_ATTEMPTS; 
                                        } else if (availableForNew > 50) { // At least 50px for new window
                                            const shrinkRatio = availableForNew / newFrame.width;
                                            
                                            if (shrinkRatio >= 0.20) { // Allow aggressive shrink (20% of original)
                                                const targetWidth = Math.floor(availableForNew); // Use exact available space
                                                // KEEP HEIGHT UNCHANGED - window might already be at min height
                                                const targetHeight = newFrame.height;
                                                
                                                Logger.log(`[MOSAIC WM] Shrinking NEW window WIDTH ONLY from ${newFrame.width} to ${targetWidth}px (height stays ${targetHeight}px)`);
                                                
                                                // Save original width for stuck detection
                                                if (!window._originalWidth) {
                                                    window._originalWidth = newFrame.width;
                                                }
                                                window._resizeAttempted = true;
                                                
                                                window._isSmartResizing = true;
                                                GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                                                    window.move_resize_frame(true, newFrame.x, newFrame.y, targetWidth, targetHeight);
                                                    return GLib.SOURCE_REMOVE;
                                                });
                                                
                                                // Reset attempt counter to give time for resize
                                                attempts = 0;
                                                retryAttempts++;
                                            } else {
                                                Logger.log(`[MOSAIC WM] NEW window shrink ratio ${shrinkRatio.toFixed(2)} too small - overflow unavoidable`);
                                                attempts = MAX_ATTEMPTS; // Force immediate overflow
                                            }
                                        } else {
                                            Logger.log(`[MOSAIC WM] Available space ${availableForNew}px too small for NEW window - overflow unavoidable`);
                                            attempts = MAX_ATTEMPTS; // Force immediate overflow
                                        }
                                    }
                                }
                                
                                if (attempts >= MAX_ATTEMPTS) {
                                    // CHECK if window was already moved by another process (e.g. manual resize protection)
                                    if (window._movedByOverflow) {
                                        Logger.log(`[MOSAIC WM] Smart resize timed out but window already moved - stopping poll`);
                                    } else {
                                        Logger.log(`[MOSAIC WM] Smart resize failed after ${attempts} polls - proceeding with overflow`);
                                        // Restore opacity before overflow (will be visible during move animation)
                                        const overflowActor = window.get_compositor_private();
                                        if (overflowActor) overflowActor.opacity = 255;
                                        this.windowingManager.moveOversizedWindow(window);
                                    }
                                    
                                    workspace._smartResizeProcessedWindows?.delete(windowId);
                                    window._isSmartResizing = false;
                                    return GLib.SOURCE_REMOVE;
                                }
                                
                                // Continue polling
                                GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, pollForFit);
                                return GLib.SOURCE_REMOVE;
                            };
                            
                            // Start polling after initial delay (let resize start)
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, pollForFit);
                            this._connectWindowWorkspaceSignal(window);
                            return GLib.SOURCE_REMOVE;
                        }
                    }
                    
                    Logger.log('[MOSAIC WM] No smart resize possible - moving to new workspace');
                    this.windowingManager.moveOversizedWindow(window);
                } else if (window._movedByOverflow) {
                    // Skip tiling here - let the delayed retile in moveOversizedWindow handle it
                    Logger.log('[MOSAIC WM] Skipping initial tile - window was just moved by overflow');
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
                    
                    // REVERSE SMART RESIZE: Restore window sizes in origin workspace
                    // Skip if window was moved by overflow (already handled elsewhere)
                    if (!window._movedByOverflow) {
                        Logger.log('[MOSAIC WM] DnD departure: Attempting Reverse Smart Resize on source workspace');
                        this.tilingManager.tryRestoreWindowSizes(sourceWorkspace, monitor);
                    }
                    
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
                    this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, false);
                } else {
                    Logger.log('[MOSAIC WM] DnD arrival: Smart Resize failed - moving to new workspace');
                    this._overflowMoveTimestamps.set(windowId, Date.now());  // Track to prevent re-processing
                    this.windowingManager.moveOversizedWindow(window);
                }
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
            
            // CRITICAL: Skip if window is being programmatically resized by Smart Resize or Reverse Smart Resize
            if (window._isSmartResizing || window._isReverseSmartResizing) {
                Logger.log(`[MOSAIC WM] Skipping resize detection for window ${window.get_id()} - ${window._isSmartResizing ? 'smart' : 'reverse smart'} resize in progress`);
                this._sizeChanged = false;
                return;
            }
            
            // CACHE INVALIDATION: If user increased window size beyond cached minimum,
            // clear the cache to allow future Smart Resize to try shrinking this window
            if (window._actualMinWidth && rect.width > window._actualMinWidth + 20) {
                Logger.log(`[MOSAIC WM] Window ${window.get_id()} grew from cached min ${window._actualMinWidth}px to ${rect.width}px - invalidating cache`);
                delete window._actualMinWidth;
                delete window._actualMinHeight;
            }
            
            // UPDATE OPENING SIZE: If user manually resizes larger, update the max restore size
            // This way the new max becomes whatever size the user chose
            const currentOpeningSize = this.tilingManager._openingSizes.get(window.get_id());
            if (currentOpeningSize) {
                if (rect.width > currentOpeningSize.width || rect.height > currentOpeningSize.height) {
                    this.tilingManager._openingSizes.set(window.get_id(), { 
                        width: Math.max(rect.width, currentOpeningSize.width), 
                        height: Math.max(rect.height, currentOpeningSize.height) 
                    });
                    Logger.log(`[MOSAIC WM] Manual resize: Updated opening size for ${window.get_id()} to ${rect.width}x${rect.height}`);
                }
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
            if (window._movedByOverflow) {
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
                    (this._lastResizeWindow === windowId && (resizeNow - this._lastResizeTime) < 300);
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
                            if (window._waitingForGeometry || !window._geometryReady) {
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
                if (this._resizeGracePeriod && (now - this._resizeGracePeriod) < 200) {
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
                if (workspace._smartResizingInProgress || window._isSmartResizing) {
                    Logger.log('[MOSAIC WM] Skipping overflow check - smart resize in progress');
                    this._sizeChanged = false;
                    return;
                }
                
                if (!canFit) {
                    if (this._resizeOverflowWindow !== window) {
                        // Skip new windows - let waitForGeometry handle them with smart resize
                        if (window._waitingForGeometry || !window._geometryReady) {
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
            // This allows proper detection when the window exits the zone
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
                        // Check if window fits in mosaic after exiting edge tile
                        const workspace = window.get_workspace();
                        const monitor = window.get_monitor();
                        const fits = this.tilingManager.canFitWindow(window, workspace, monitor);
                        
                        if (!fits) {
                            // Window doesn't fit - apply opacity and mark for overflow
                            Logger.log(`[MOSAIC WM] Edge tile exit: window doesn't fit - applying overflow opacity`);
                            const actor = window.get_compositor_private();
                            if (actor) {
                                actor.opacity = 128; // Semi-transparent
                            }
                            this._dragOverflowWindow = window;
                            this.tilingManager.setExcludedWindow(window);
                            this.drawingManager.hideTilePreview();
                            this.drawingManager.removeBoxes();
                            // Don't start drag mode - window floats freely
                            Logger.log(`[MOSAIC WM] Edge tile exit: overflow window, skipping startDrag`);
                        } else {
                            Logger.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}, fits=${fits}`);
                            this.reorderingManager.startDrag(window);
                            Logger.log(`[MOSAIC WM] _grabOpBeginHandler: startDrag completed`);
                        }
                    }
                });
                return;
            } else {
                // Window is not edge-tiled, start with NONE
                this._currentZone = TileZone.NONE;
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
                    
                    // CRITICAL: Restore opacity if window was marked as overflow
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
                    
                    // Check if window fits in mosaic
                    const fits = this.tilingManager.canFitWindow(this._draggedWindow, workspace, monitor);
                    
                    if (!fits) {
                        // Window doesn't fit - apply opacity and exclude from tiling
                        Logger.log(`[MOSAIC WM] Window doesn't fit in mosaic - applying overflow opacity`);
                        const actor = this._draggedWindow.get_compositor_private();
                        if (actor) {
                            actor.opacity = 128; // Semi-transparent
                        }
                        this._dragOverflowWindow = this._draggedWindow;
                        // Don't include this window in tiling
                        this.tilingManager.clearDragRemainingSpace();
                        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                    } else {
                        Logger.log(`[MOSAIC WM] Preview cancelled: returning mosaic to full workspace`);
                        // Clear any previous overflow state
                        if (this._dragOverflowWindow) {
                            const actor = this._dragOverflowWindow.get_compositor_private();
                            if (actor) actor.opacity = 255;
                            this._dragOverflowWindow = null;
                        }
                        this.tilingManager.clearDragRemainingSpace();
                        this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor, false);
                    }
                    
                    if (wasInEdgeTiling) {
                        Logger.log(`[MOSAIC WM] Edge tiling: restoring window ${this._draggedWindow.get_id()} from tiled state, zone was ${windowState.zone}`);
                        this._restoringFromEdgeTile = true;
                        this.edgeTilingManager.removeTile(this._draggedWindow);
                        // Delay clearing the flag to cover the debounce period for overflow detection
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.EDGE_TILE_RESTORE_DELAY_MS, () => {
                            this._restoringFromEdgeTile = false;
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        Logger.log(`[MOSAIC WM] Edge tiling: window was NOT in edge tile (preview only)`);
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
            this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, window.get_monitor(), false);
            
            this._dragOverflowWindow = null;
            this._draggedWindow = null;
            this._currentZone = TileZone.NONE;
            
            if (this._edgeTilingPollId) {
                GLib.source_remove(this._edgeTilingPollId);
                this._edgeTilingPollId = null;
            }
            return;
        }
        
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
        
        // Mark window as newly added for overflow protection logic
        window._windowAddedTime = Date.now();
        
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
                
                const workArea = WORKSPACE.get_work_area_for_monitor(MONITOR);
                Logger.log(`[MOSAIC WM] window-added: window=${WINDOW.get_id()}, size=${frame.width}x${frame.height}, workArea=${workArea.width}x${workArea.height}, timeSince=${timeSinceRemoved}ms, prevWS=${previousWorkspaceIndex}, currentWS=${WORKSPACE.index()}, isManual=${isManualMove}`);
                
                if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index() && timeSinceRemoved < 100) {
                    // Skip if this is an overflow move, not a real drag-drop
                    if (WINDOW._movedByOverflow) {
                        Logger.log(`[MOSAIC WM] window-added: Skipping drag-drop handling - window was moved by overflow`);
                    } else {
                        Logger.log(`[MOSAIC WM] window-added: Overview drag-drop - window ${WINDOW.get_id()} from workspace ${previousWorkspaceIndex} to ${WORKSPACE.index()}`);
                        
                        // ACTIVATE destination workspace and EXIT Overview first
                        // This allows proper window geometry handling
                        Logger.log(`[MOSAIC WM] DnD: Activating workspace ${WORKSPACE.index()} and exiting Overview`);
                        WORKSPACE.activate(global.get_current_time());
                        
                        if (Main.overview.visible) {
                            Main.overview.hide();
                        }
                        
                        // Mark as DnD arrival - will trigger expansion after tiling
                        WINDOW._arrivedFromDnD = true;
                        
                        // Clear DnD tracking - normal flow will handle window
                        this._windowPreviousWorkspace.delete(WINDOW.get_id());
                        this._windowRemovedTimestamp.delete(WINDOW.get_id());
                        this._manualWorkspaceMove.delete(WINDOW.get_id());
                        
                        // Let normal waitForGeometry flow handle the window
                        // It will do Smart Resize, overflow, etc. as needed
                    }
                }
                // Mark window as waiting for geometry - prevents premature overflow
                WINDOW._waitingForGeometry = true;
                
                const waitForGeometry = () => {
                    const rect = WINDOW.get_frame_rect();
                    if (rect.width > 0 && rect.height > 0) {
                        // Geometry ready - clear flag
                        WINDOW._waitingForGeometry = false;
                        WINDOW._geometryReady = true;
                        
                        // CRITICAL: Skip ALL tiling logic for excluded windows (modals, transients, etc.)
                        if (this.windowingManager.isExcluded(WINDOW)) {
                            Logger.log(`[MOSAIC WM] waitForGeometry: Skipping - window is excluded (modal/transient)`);
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
                        Logger.log(`[MOSAIC WM] Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`);
                        
                        // Skip early tiling for overflow moved windows
                        if (WINDOW._movedByOverflow) {
                            Logger.log(`[MOSAIC WM] Skipping early tile in waitForGeometry - window was moved by overflow`);
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        // CRITICAL: Save opening size NOW when geometry is ready but BEFORE Smart Resize
                        // This captures the window's actual size for Reverse Smart Resize
                        this.tilingManager.saveOpeningSize(WINDOW);
                        
                        // Protect against premature overflow during initial tiling/smart resize
                        WINDOW._isSmartResizing = true;
                        
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
                            if (!WORKSPACE._smartResizeProcessedWindows) {
                                WORKSPACE._smartResizeProcessedWindows = new Set();
                            }
                        }
                        
                        // Only call tileWorkspaceWindows if smart resize was NOT processed
                        // If it was, the delayed callback in _windowAdded will handle tiling
                        if (!WORKSPACE._smartResizeProcessedWindows?.has(WINDOW.get_id())) {
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
                                    WORKSPACE._smartResizeProcessedWindows.add(WINDOW.get_id());
                                    
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
                                            WORKSPACE._smartResizeProcessedWindows?.delete(windowId);
                                            WINDOW._isSmartResizing = false;
                                            return GLib.SOURCE_REMOVE;
                                        }
                                        
                                        attempts++;
                                        const canFitNow = this.tilingManager.canFitWindow(WINDOW, WORKSPACE, MONITOR);
                                        
                                        if (canFitNow) {
                                            Logger.log(`[MOSAIC WM] PRE-FIT: Smart resize successful after ${attempts} polls`);
                                            // Restore opacity from ghost state
                                            const successActor = WINDOW.get_compositor_private();
                                            if (successActor) successActor.opacity = 255;
                                            
                                            WORKSPACE._smartResizeProcessedWindows?.delete(windowId);
                                            WINDOW._isSmartResizing = false;
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
                                        
                                        if (availableForNew <= 50) {
                                            Logger.log(`[MOSAIC WM] PRE-FIT: Available space ${availableForNew}px <= 50px - overflow unavoidable`);
                                            // Restore opacity before overflow
                                            const actor50 = WINDOW.get_compositor_private();
                                            if (actor50) actor50.opacity = 255;
                                            WORKSPACE._smartResizeProcessedWindows?.delete(windowId);
                                            WINDOW._isSmartResizing = false;
                                            this.windowingManager.moveOversizedWindow(WINDOW);
                                            return GLib.SOURCE_REMOVE;
                                        }
                                        
                                        // Note: We removed the shrink ratio check here
                                        // It was causing premature rejection when windows COULD fit
                                        // Just let the polling continue until it succeeds or times out
                                        
                                        if (attempts >= 10) { // Pre-Fit uses max 10 attempts (500ms) for DnD resize
                                            Logger.log('[MOSAIC WM] PRE-FIT: Smart resize failed after 10 polls - triggering overflow');
                                            // Restore opacity before overflow
                                            const actor10 = WINDOW.get_compositor_private();
                                            if (actor10) actor10.opacity = 255;
                                            WORKSPACE._smartResizeProcessedWindows?.delete(windowId);
                                            WINDOW._isSmartResizing = false;
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
                            this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                            
                            // If window arrived from DnD, try to expand it towards opening size
                            if (WINDOW._arrivedFromDnD) {
                                WINDOW._arrivedFromDnD = false;
                                const monitorWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                                    .filter(w => !this.edgeTilingManager.isEdgeTiled(w) &&
                                                 !this.windowingManager.isExcluded(w));
                                
                                // Special handling for solo window (Empty Workspace)
                                // We want to restore BOTH width and height logic
                                if (monitorWindows.length === 1) {
                                    const win = monitorWindows[0];
                                    const openingSize = this.tilingManager.getOpeningSize(win.get_id());
                                    
                                    if (openingSize) {
                                        const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
                                        // Calculate safe dimensions (respecting spacing)
                                        const targetW = Math.min(openingSize.width, wa.width - constants.WINDOW_SPACING * 2);
                                        const targetH = Math.min(openingSize.height, wa.height - constants.WINDOW_SPACING * 2);
                                        
                                        // Center the window
                                        const x = wa.x + Math.floor((wa.width - targetW) / 2);
                                        const y = wa.y + Math.floor((wa.height - targetH) / 2);
                                        
                                        Logger.log(`[MOSAIC WM] DnD Solo: Fully restoring window to ${targetW}x${targetH}`);
                                        win.move_resize_frame(true, x, y, targetW, targetH);
                                    }
                                } else {
                                    // Fallback for multiple windows (Width expansion mostly)
                                    const usedWidth = monitorWindows.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
                                    const totalSpacing = (monitorWindows.length + 1) * constants.WINDOW_SPACING;
                                    const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
                                    const availableExtra = wa.width - usedWidth - totalSpacing;
                                    
                                    if (availableExtra > 20) {
                                        Logger.log(`[MOSAIC WM] DnD arrival: Extra space ${availableExtra}px - trying expansion`);
                                        this.tilingManager.tryRestoreWindowSizes(monitorWindows, wa, availableExtra, wa.height, WORKSPACE, MONITOR);
                                    }
                                }
                            }
                        } else {
                            Logger.log('[MOSAIC WM] waitForGeometry: Skipping immediate tile - smart resize in progress');
                        }
                        
                        // Clear protection after delay to allow resizes to settle
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                            // Only clear if NOT managed by _windowAdded polling loop 
                            // (checked via _smartResizeProcessedWindows existing for this window)
                            if (!WORKSPACE._smartResizeProcessedWindows?.has(WINDOW.get_id())) {
                                WINDOW._isSmartResizing = false;
                                Logger.log('[MOSAIC WM] Smart resize protection cleared (timeout)');
                            }
                            
                            // One final check if things fit now
                            // SKIP if window was already moved by overflow to prevent double movement
                            if (WINDOW._movedByOverflow) {
                                Logger.log('[MOSAIC WM] Skipping final overflow check - window already moved');
                                return GLib.SOURCE_REMOVE;
                            }
                            
                            // SKIP if smart resize is still running - let pollForFit handle overflow
                            if (WINDOW._isSmartResizing) {
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
        
        // SKIP if window was moved by overflow - don't trigger restore for overflow moves
        // This prevents cascade: window overflows → restore grows another → that one overflows too
        const wasMovedByOverflow = window._movedByOverflow;
        
        // Capture removed window's size BEFORE any operations (for Reverse Smart Resize)
        const removedFrame = window.get_frame_rect();
        const freedWidth = removedFrame.width;
        const freedHeight = removedFrame.height;
        
        // Only clear opening size if window is actually being destroyed (not moved)
        // Check if window still has an actor (destroyed windows don't)
        const actor = window.get_compositor_private();
        if (!actor) {
            this.tilingManager.clearOpeningSize(window.get_id());
        } else {
            Logger.log(`[MOSAIC WM] _windowRemoved: Window still exists (DnD move) - keeping opening size`);
        }
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = workspace;
            const MONITOR = global.display.get_primary_monitor();

            // Check if workspace still exists and has windows
            if (!WORKSPACE || WORKSPACE.index() < 0) {
                return GLib.SOURCE_REMOVE;
            }
            
            // Get remaining windows in workspace (exclude edge tiles)
            const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && 
                             !this.windowingManager.isExcluded(w));
            
            Logger.log(`[MOSAIC WM] _windowRemoved: ${remainingWindows.length} remaining windows, freed ${freedWidth}x${freedHeight}, wasOverflowMove=${wasMovedByOverflow}`);
            
            // Try to restore window sizes with freed space (Reverse Smart Resize)
            // SKIP if window was moved by overflow to prevent cascade overflow
            if (remainingWindows.length > 0 && !wasMovedByOverflow) {
                const workArea = this.tilingManager.getUsableWorkArea(WORKSPACE, MONITOR);
                const restored = this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, WORKSPACE, MONITOR);
                
                if (restored) {
                    // Delay retile to let the resize command be applied by Mutter
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                        Logger.log('[MOSAIC WM] Retiling after restore delay');
                        this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    // No restoration, retile immediately
                    this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                }
            } else if (remainingWindows.length > 0) {
                // Just retile without restore for overflow moves
                this.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
            }
            
            return GLib.SOURCE_REMOVE;
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
        this.windowingManager.setTilingManager(this.tilingManager);
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