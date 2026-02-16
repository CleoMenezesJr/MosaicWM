// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// WindowHandler - Manages window lifecycle signals and state transitions.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import * as WindowState from './windowState.js';
import { ComputedLayouts } from './tiling.js';
import { afterWorkspaceSwitch, afterAnimations, afterWindowClose } from './timing.js';

export const WindowHandler = GObject.registerClass({
    GTypeName: 'MosaicWindowHandler',
}, class WindowHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;
        this._workspaceLocks = new WeakMap();
        this._smartResizeProcessedWindows = new WeakMap();
        
        this._overflowInProgress = false; // Moved from extension.js
        this._windowSignals = new WeakMap(); // Store signal IDs for cleanup using WeakMap for memory safety
    }

    // Lock a workspace to prevent recursive or conflicting tiling triggers.
    lockWorkspace(workspace) {
        if (!workspace) return;
        this._workspaceLocks.set(workspace, true);
        Logger.log(`[MOSAIC WM] Workspace ${workspace.index()} LOCKED for tiling`);
    }

    // Unlock a workspace after tiling is complete.
    unlockWorkspace(workspace) {
        if (!workspace) return;
        this._workspaceLocks.delete(workspace);
        Logger.log(`[MOSAIC WM] Workspace ${workspace.index()} UNLOCKED`);
    }

    // Check if a workspace is currently locked for tiling.
    isWorkspaceLocked(workspace) {
        if (!workspace) return false;
        return this._workspaceLocks.get(workspace) === true;
    }

    // Accessor shortcuts
    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }

    // Connect deterministic signals for window lifecycle
    connectWindowSignals(window) {
        if (!window || this._windowSignals.has(window)) return;
        
        Logger.log(`[MOSAIC WM] Connecting signals for window ${window.get_id()}`);
        let ids = [];
        
        // Final cleanup signal
        ids.push(window.connect('unmanaged', (win) => {
            Logger.log(`[MOSAIC WM] Window ${win.get_id()} (unmanaged) - cleaning up`);
            this.onWindowRemoved(win.get_workspace(), win);
            this.disconnectWindowSignals(win);
        }));
        
        // Immediate unmaximize detection
        ids.push(window.connect('notify::maximized-horizontally', (win) => {
            // Check strictly for unmaximized state (not fullscreen)
            if (!this.windowingManager.isMaximizedOrFullscreen(win)) {
                Logger.log(`[MOSAIC WM] Window ${win.get_id()} unmaximized - starting state machine`);
                this.handleSacredExit(win);
            }
        }));

        // Detect Fullscreen changes
        ids.push(window.connect('notify::fullscreen', (win) => {
            if (!win.is_fullscreen()) {
                Logger.log(`[MOSAIC WM] Window ${win.get_id()} exited fullscreen - starting state machine`);
                this.handleSacredExit(win);
            } else {
                 // Entered Fullscreen: Move to new workspace if current is occupied.
                 const workspace = win.get_workspace();
                 const monitor = win.get_monitor();
                 const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                 
                 if (workspaceWindows.length > 1) {
                     Logger.log(`[MOSAIC WM] Window ${win.get_id()} entered FULLSCREEN in occupied workspace - isolating (SACRED)`);
                     // Save origin for restoration later
                     WindowState.set(win, 'sacredOriginWorkspace', workspace.index());
                     this.windowingManager.moveOversizedWindow(win);
                 }
            }
        }));
        
        // Confirmation of smart resize completion + minimum size learning
        ids.push(window.connect('size-changed', (win) => {
            ComputedLayouts.delete(win);
            if (WindowState.get(win, 'isSmartResizing')) {
                // LEARN MINIMUM SIZE: compare requested target vs actual frame
                const target = WindowState.get(win, 'targetSmartResizeSize');
                if (target) {
                    const actual = win.get_frame_rect();
                    const hitMinimum = actual.width > target.width || actual.height > target.height;
                    
                    if (hitMinimum) {
                        WindowState.set(win, 'learnedMinSize', {
                            width: actual.width,
                            height: actual.height
                        });
                        Logger.log(`[MOSAIC WM] Learned min size for ${win.get_id()}: ${actual.width}x${actual.height} (requested ${target.width}x${target.height})`);
                        
                        // Smart Resize failed: clear overrides and retile with overflow enabled.
                        const ws = win.get_workspace();
                        const mon = win.get_monitor();
                        if (ws) {
                            const wsWindows = this.windowingManager.getMonitorWorkspaceWindows(ws, mon);
                            let newestWindow = null;
                            let newestTime = 0;
                            
                            for (const w of wsWindows) {
                                WindowState.set(w, 'targetSmartResizeSize', null);
                                WindowState.set(w, 'isSmartResizing', false);
                                
                                const addedTime = WindowState.get(w, 'addedTime') || 0;
                                if (addedTime > newestTime) {
                                    newestTime = addedTime;
                                    newestWindow = w;
                                }
                            }
                            
                            // Retile with actual dimensions; triggers overflow if needed.
                            if (newestWindow) {
                                Logger.log(`[MOSAIC WM] Smart resize minimum hit — retiling with overflow for ${newestWindow.get_id()}`);
                                WindowState.set(newestWindow, 'forceOverflow', true);
                                this.tilingManager.tileWorkspaceWindows(ws, newestWindow, mon, false);
                            }
                        }
                        return;
                    }
                    
                    // Resize worked — clear target, frame is up to date
                    WindowState.set(win, 'targetSmartResizeSize', null);
                }
                this.tilingManager.tileWorkspaceWindows(win.get_workspace(), null, win.get_monitor());
            }
        }));

        ids.push(window.connect('position-changed', (win) => {
            ComputedLayouts.delete(win);
        }));
        
        // Track for lifecycle exclusion updates
        ids.push(window.connect('notify::above', (win) => this.handleExclusionStateChange(win)));
        ids.push(window.connect('notify::on-all-workspaces', (win) => this.handleExclusionStateChange(win)));

        this._windowSignals.set(window, ids);
        
        // Initialize exclusion state tracking
        const currentExclusion = this.windowingManager.isExcluded(window);
        WindowState.set(window, 'previousExclusionState', currentExclusion);
        
        // Track previous workspace for cross-workspace moves
        const currentWorkspace = window.get_workspace();
        if (currentWorkspace) {
            WindowState.set(window, 'previousWorkspace', currentWorkspace.index());
        }
    }

    disconnectWindowSignals(window) {
        let ids = this._windowSignals.get(window);
        if (ids) {
            ids.forEach(id => window.disconnect(id));
            this._windowSignals.delete(window);
            Logger.log(`[MOSAIC WM] Disconnected signals for window ${window.get_id()}`);
        }
        
        // Clear layout cache
        ComputedLayouts.delete(window);
        
        // Clean up other states
        WindowState.remove(window, 'previousExclusionState');
        WindowState.remove(window, 'previousWorkspace');
    }

    // State Machine: Defer move until window has finished resizing in place.
    handleSacredExit(window) {
        const originIndex = WindowState.get(window, 'sacredOriginWorkspace');
        
        // Always set these flags to prevent giant dimensions during the in-place resize
        const preferredSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
        if (preferredSize) {
            WindowState.set(window, 'targetRestoredSize', { width: preferredSize.width, height: preferredSize.height });
            WindowState.set(window, 'unmaximizing', true);
        }

        if (originIndex !== undefined) {
            Logger.log(`[MOSAIC WM] Sacred exit detected for ${window.get_id()}. Flagging for deferred move to WS ${originIndex}.`);
            WindowState.set(window, 'isRestoringSacred', originIndex);
            
            // Re-tile the current workspace immediately (it's leaving this spot)
            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor);
        }
    }


    // Handle window unmaximize event.
    onWindowUnmaximized(window) {
        const workspace = window.get_workspace();
        if (!workspace) return;
        
        const monitor = window.get_monitor();
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        
        // Check if we should retile or if it's a standalone window
        if (workspaceWindows.length > 1) {
            // Restore preferred size if it was edge-constrained or smart-resized
            if (WindowState.get(window, 'isConstrainedByMosaic')) {
                this.tilingManager.restorePreferredSize(window);
            }
            
            this.tilingManager.tileWorkspaceWindows(workspace, window, monitor);
        }
    }

    // Handle exclusion state transitions (Always on Top, Sticky, etc.)
    handleExclusionStateChange(window) {
        const windowId = window.get_id();
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        
        const isNowExcluded = this.windowingManager.isExcluded(window);
        
        // Track previous state to detect transitions
        const wasExcluded = WindowState.get(window, 'previousExclusionState') || false;
        WindowState.set(window, 'previousExclusionState', isNowExcluded);
        
        // Only act on actual state transitions
        if (wasExcluded === isNowExcluded) {
            return;
        }
        
        if (isNowExcluded) {
            // Window became excluded - retile remaining windows
            Logger.log(`[MOSAIC WM] Window ${windowId} became excluded - retiling without it`);
            
            const frame = window.get_frame_rect();
            const freedWidth = frame.width;
            const freedHeight = frame.height;
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== windowId && !this.windowingManager.isExcluded(w));
                
                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                if (workArea) {
                    this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, workspace, monitor);
                } else {
                    Logger.log('[MOSAIC WM] WindowHandler: Skipped restore - invalid workArea');
                }
                
                this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            // Window became included - treat like new window arrival with smart resize
            Logger.log(`[MOSAIC WM] Window ${windowId} became included - treating as new window arrival`);
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                if (!workArea) {
                    Logger.log('[MOSAIC WM] WindowHandler: Skipped include - invalid workArea');
                    return GLib.SOURCE_REMOVE;
                }
                const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== window.get_id() && !this.windowingManager.isExcluded(w));
                
                // Check if window fits without resize
                if (this.tilingManager.canFitWindow(window, workspace, monitor)) {
                    Logger.log(`[MOSAIC WM] Re-included window fits without resize`);
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                    return GLib.SOURCE_REMOVE;
                }
                
                // Try smart resize (async IIFE)
                (async () => {
                    const resizeSuccess = await this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                    
                    if (resizeSuccess) {
                        Logger.log('[MOSAIC WM] Re-include: Smart resize applied - starting fit check polling');
                        WindowState.set(window, 'isSmartResizing', true);
                        
                        const initialWorkspaceIndex = workspace.index();
                        const MAX_ATTEMPTS = 12;
                        const POLL_INTERVAL = 75;
                        let attempts = 0;
                        
                        const pollForFit = async () => {
                            if (window.get_workspace()?.index() !== initialWorkspaceIndex) {
                                Logger.log(`[MOSAIC WM] Re-include: Window moved workspace - aborting poll`);
                                WindowState.set(window, 'isSmartResizing', false);
                                return GLib.SOURCE_REMOVE;
                            }
                            
                            attempts++;
                            const canFitNow = this.tilingManager.canFitWindow(window, workspace, monitor, true);
                            
                            if (canFitNow) {
                                Logger.log(`[MOSAIC WM] Re-include: Smart resize success after ${attempts} polls`);
                                WindowState.set(window, 'isSmartResizing', false);
                                WindowState.set(window, 'justReturnedFromExclusion', true);
                                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                                return GLib.SOURCE_REMOVE;
                            }
                            
                            if (attempts >= MAX_ATTEMPTS) {
                                Logger.log('[MOSAIC WM] Re-include: Smart resize failed - moving to overflow');
                                WindowState.set(window, 'isSmartResizing', false);
                                this.windowingManager.moveOversizedWindow(window);
                                return GLib.SOURCE_REMOVE;
                            }
                            
                            // Retry resize attempt
                            await this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                            return GLib.SOURCE_CONTINUE;
                        };
                        
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, () => pollForFit());
                    } else {
                        Logger.log(`[MOSAIC WM] Re-include: Smart resize not applicable - moving to overflow`);
                        this.windowingManager.moveOversizedWindow(window);
                    }
                })();
                
                return GLib.SOURCE_REMOVE;
            });
        }
    }
    
    // Executes when a window is physically destroyed
    onWindowDestroyed(window) {
        const monitor = window.get_monitor();
        const windowId = window.get_id();
        
        Logger.log(`[MOSAIC WM] onWindowDestroyed: ${windowId}`);
        
        this.disconnectWindowSignals(window);
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
        
        if (this.windowingManager.isExcluded(window)) {
            Logger.log('[MOSAIC WM] Excluded window closed - no workspace navigation');
            return;
        }
        
        if (monitor === global.display.get_primary_monitor()) {
            const workspace = this.windowingManager.getWorkspace();
            
            // Capture destroyed window size for reverse smart resize
            const destroyedFrame = window.get_frame_rect();
            const freedWidth = destroyedFrame.width;
            const freedHeight = destroyedFrame.height;
            
            this.edgeTilingManager.checkQuarterExpansion(workspace, monitor);
            
            afterWindowClose(() => {
                afterAnimations(this._ext.animationsManager, () => {
                    // Try to restore/reverse smart resize constrained windows with freed space
                    const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
                    
                    // Check if ANY remaining window was smart-resized (constrained)
                    const hasConstrainedWindows = remainingWindows.some(w => {
                        const hasTarget = WindowState.get(w, 'targetSmartResizeSize') !== null;
                        const isConstrained = WindowState.get(w, 'isConstrainedByMosaic') === true;
                        return hasTarget || isConstrained;
                    });
                    
                    if (hasConstrainedWindows && (freedWidth > 0 || freedHeight > 0)) {
                        Logger.log(`[SMART RESIZE] Window closed - attempting reverse smart resize with freed ${freedWidth}x${freedHeight}`);
                        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
                        this._ext.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, workspace, monitor);
                    }
                    
                    this._ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                }, this._ext._timeoutRegistry);
            }, this._ext._timeoutRegistry);
            
            const windows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
            const managedWindows = windows.filter(w => !this.windowingManager.isExcluded(w));
            
            if (managedWindows.length === 0) {
                // Skip if overflow is in progress - window is being moved and will arrive soon
                if (this._overflowInProgress) {
                    Logger.log('[MOSAIC WM] Workspace is empty but overflow in progress - skipping navigation');
                    return;
                }
                
                Logger.log('[MOSAIC WM] Workspace is empty - renavigating');
                this.windowingManager.renavigate(workspace, true, this._ext._lastVisitedWorkspace, monitor);
            }
        }
    }
    
    onOverviewHidden() {
        const workspace = this.windowingManager.getWorkspace();
        const monitor = global.display.get_primary_monitor();
        const windows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        
        for (const win of windows) {
            if (WindowState.get(win, 'deferTilingUntilOverviewHidden')) {
                Logger.log(`[MOSAIC WM] Overview hidden: Tiling deferred window ${win.get_id()}`);
                WindowState.remove(win, 'deferTilingUntilOverviewHidden');
                // Use async IIFE to avoid blocking
                (async () => {
                    await this._ensureWindowFits(win, workspace, monitor);
                })();
            }
        }
    }

    // Unified logic to ensure a new window fits, using smart resize if needed.
    async _ensureWindowFits(window, workspace, monitor) {
        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log('[MOSAIC WM] ensureWindowFits: Skipping - smart resize in progress');
            return;
        }

        if (WindowState.get(window, 'movedByOverflow')) {
            Logger.log('[MOSAIC WM] ensureWindowFits: Skipping - window was moved by overflow');
            return;
        }

        this.tilingManager.savePreferredSize(window);

        // Path 1: DnD Arrival Handling (Expansion)
        if (WindowState.get(window, 'arrivedFromDnD')) {
            WindowState.set(window, 'arrivedFromDnD', false);
            const monitorWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
            const preferredSize = this.tilingManager.getPreferredSize(window);
            
            if (preferredSize && monitorWindows.length === 1) {
                const wa = workspace.get_work_area_for_monitor(monitor);
                const win = monitorWindows[0];
                const currentRect = win.get_frame_rect();
                const targetW = Math.min(preferredSize.width, wa.width - constants.WINDOW_SPACING * 2);
                const targetH = Math.min(preferredSize.height, wa.height - constants.WINDOW_SPACING * 2);
                Logger.log(`[MOSAIC WM] DnD Solo: Fully restoring window to ${targetW}x${targetH}`);
                win.move_resize_frame(true, currentRect.x, currentRect.y, targetW, targetH);
            } else {
                const usedWidth = monitorWindows.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
                const wa = workspace.get_work_area_for_monitor(monitor);
                const availableExtra = wa.width - usedWidth - (monitorWindows.length + 1) * constants.WINDOW_SPACING;
                if (availableExtra > constants.ANIMATION_DIFF_THRESHOLD) {
                    Logger.log(`[MOSAIC WM] DnD arrival: Extra space ${availableExtra}px - trying expansion`);
                    this.tilingManager.tryRestoreWindowSizes(monitorWindows, wa, availableExtra, wa.height, workspace, monitor);
                }
            }
        }

        // Path 2: Fitting Check & Smart Resize
        // CRITICAL: Check fit using the TARGET size if we are in a restoration flow.
        // This prevents immediate overflow ejection when the frame is still transiently giant.
        const targetSize = WindowState.get(window, 'targetRestoredSize');
        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor, targetSize);
        Logger.log(`[TRACE] ensureWindowFits: canFit=${canFit}, id=${window.get_id()} (usingTargetSize: ${!!targetSize})`);

        if (canFit) {
            this.tilingManager.enqueueWindowOpen(window.get_id(), () => {
                Logger.log('[MOSAIC WM] Window fits - adding to tiling via queue');
                this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            });
            return;
        }

        // Path 3: Smart Resize attempt
        let workArea = workspace.get_work_area_for_monitor(monitor);
        if (this.edgeTilingManager) {
            const edgeTiledWindows = this.edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            if (edgeTiledWindows.length > 0) {
                workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            }
        }

        const allExistingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => w.get_id() !== window.get_id() && !this.edgeTilingManager.isEdgeTiled(w));

        const hasSacredWindow = allExistingWindows.some(w => w.maximized_horizontally || w.maximized_vertically || w.is_fullscreen());
        
        if (hasSacredWindow) {
            Logger.log('[MOSAIC WM] Sacred window detected - immediate overflow');
            this.windowingManager.moveOversizedWindow(window);
            return;
        }

        const existingWindows = allExistingWindows.filter(w => !(w.maximized_horizontally || w.maximized_vertically || w.is_fullscreen()));
        
        if (existingWindows.length > 0) {
            const resizeSuccess = await this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
            if (resizeSuccess) {
                Logger.log('[MOSAIC WM] Smart resize applied - tiling with reference');
                this.tilingManager.enqueueWindowOpen(window.get_id(), () => {
                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                });
                return;
            }
        }

        // Path 4: Overflow (Final fallback)
        Logger.log('[TRACE] OVERFLOW: No fit, no smart resize possible');
        
        // Only move if smart resize is not blocking overflow decisions
        if (!this.tilingManager._isSmartResizingBlocked) {
            this.windowingManager.moveOversizedWindow(window);
        } else {
            Logger.log('[MOSAIC WM] Deferring overflow - smart resize still in progress');
        }
    }
    onWindowCreated(window) {
        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            WindowState.set(window, 'openedMaximized', true);
            Logger.log(`[MOSAIC WM] Window ${window.get_id()} opened maximized - marked for auto-tile check`);
        }
        
        const processWindowCallback = () => {
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
                
                // CRITICAL: Use saved_rect for natural size (get_frame_rect matches monitor if Maximized).
                if (this.windowingManager.isMaximizedOrFullscreen(window)) {
                    try {
                         const saved = window.get_saved_rect();
                         if (saved && saved.width > 0 && saved.height > 0) {
                             WindowState.set(window, 'openingSize', { width: saved.width, height: saved.height });
                             Logger.log(`[MOSAIC WM] onWindowCreated: Captured openingSize fallback from saved_rect: ${saved.width}x${saved.height}`);
                         }
                    } catch (e) {
                         Logger.warn(`[MOSAIC WM] onWindowCreated: Failed to capture saved_rect: ${e.message}`);
                    }
                } else {
                    // ONLY save preferred size if the window is NOT maximized/fullscreen upon creation.
                    // This prevents capturing "almost-maximized" frames during the opening animation.
                    this.tilingManager.savePreferredSize(window);
                }
                
                // Unified Sacred Logic: Auto-tile in occupied workspaces; stay sacred in empty ones.
                if(this.windowingManager.isMaximizedOrFullscreen(window)) {
                    const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                    
                    if(workspaceWindows.length > 1) {
                        const openedMaximized = WindowState.get(window, 'openedMaximized');
                        
                        if (openedMaximized) {
                            Logger.log('[MOSAIC WM] Opened sacred (Max/Full) with tiled window - auto-tiling');
                            
                            const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                            const tiledWindows = workspaceWindows.filter(w => {
                                if (w === window) return false;
                                const state = this.edgeTilingManager.getWindowState(w);
                                return state && state.zone !== TileZone.NONE;
                            });
                            
                            if (tiledWindows.length > 0) {
                                if (window.is_fullscreen()) {
                                    window.unmake_fullscreen();
                                } else {
                                    window.unmaximize(Meta.MaximizeFlags.BOTH);
                                }
                                WindowState.remove(window, 'openedMaximized');
                            } else {
                                Logger.log('[MOSAIC WM] Opened sacred without tiled window - moving to new workspace');
                                // Save origin for restoration later
                                WindowState.set(window, 'sacredOriginWorkspace', workspace.index());
                                this.windowingManager.moveOversizedWindow(window);
                                WindowState.remove(window, 'openedMaximized');
                            }
                        } else {
                            Logger.log('[MOSAIC WM] User sacred window - moving to new workspace');
                            // Save origin for restoration later
                            WindowState.set(window, 'sacredOriginWorkspace', workspace.index());
                            this.windowingManager.moveOversizedWindow(window);
                        }
                        return GLib.SOURCE_REMOVE;
                    } else {
                        Logger.log('[MOSAIC WM] Sacred window in empty workspace - keeping here');
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
                        this.connectWindowSignals(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    Logger.log('[MOSAIC WM] New window: Tiling failed, continuing with normal flow');
                }
                
                // Use async IIFE to avoid blocking callback
                (async () => {
                    await this._ensureWindowFits(window, workspace, monitor);
                })();
                
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
                    // One small safety polling if initial callback failed (rare)
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, processWindowCallback);
                }
                
                // Now that window is processed, connect standard signals
                this.connectWindowSignals(window);
            };
            
            // USE MAPPED SIGNAL: Triggers when the window is added to the scene but before paint.
            // This allows us to position it "before" it appears, as the user requested.
            if (actor.mapped) {
                processOnce();
            } else {
                signalId = actor.connect('notify::mapped', () => {
                    if (actor.mapped) processOnce();
                });
            }
            
            // Safety timeout (reduced from 800ms to 400ms)
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                Logger.log('[MOSAIC WM] window map timeout - falling back to immediate processing');
                processOnce();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            // Fallback for non-actor windows (rare in Shell)
            const fallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
                 if (processWindowCallback() === GLib.SOURCE_REMOVE) {
                     this.connectWindowSignals(window);
                     return GLib.SOURCE_REMOVE;
                 }
                 return GLib.SOURCE_CONTINUE;
            });
        }
    }

    onWindowAdded(workspace, window) {
        if (!this._ext.windowingManager.isRelated(window)) {
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
                            !this._ext.windowingManager.isExcluded(w) &&
                            w.showing_on_its_workspace()
                        );
                        
                        // Determine directional offset logic - using HISTORY from window-removed
                        let offsetDirection = 0;
                        const currentWSIndex = ws.index();
                        
                        // Use accurate previous workspace from _windowRemoved handler
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
                        if ((existingWindows.length > 0 || offsetDirection !== 0) && !WindowState.get(win, 'createdDuringOverview')) {
                            WindowState.set(win, 'needsSlideIn', true);
                            WindowState.set(win, 'slideInExistingWindows', existingWindows);
                            WindowState.set(win, 'slideInDirection', offsetDirection);
                            
                            Logger.log(`[MOSAIC WM] SLIDE-IN: Window ${win.get_id()} (Existing: ${existingWindows.length}, Dir: ${offsetDirection}, PrevWS: ${prevWSIndex})`);
                            
                            // Connect to first-frame for visual animation
                            const actor = win.get_compositor_private();
                            if (actor) {
                                const applySlideIn = () => {
                                    if (!actor.mapped) return;
                                    
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
                                            offsetX = direction * OFFSET * 3; // Increase offset for "coming from outside" feel
                                            animationMode = Clutter.AnimationMode.EASE_OUT_BACK; // Momentum for directional
                                        }
                                        
                                        if (offsetX !== 0 || offsetY !== 0) {
                                            Logger.log(`[MOSAIC WM] MAPPED SLIDE-IN: Applying offset (${offsetX}, ${offsetY}) to window ${win.get_id()} Mode: ${animationMode}`);
                                            
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
                                };

                                if (actor.mapped) {
                                    applySlideIn();
                                } else {
                                    const mappedId = actor.connect('notify::mapped', () => {
                                        if (actor.mapped) {
                                            actor.disconnect(mappedId);
                                            applySlideIn();
                                        }
                                    });
                                }
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
        
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (this._ext.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                
                const frame = WINDOW.get_frame_rect();
                const hasValidDimensions = frame.width > 0 && frame.height > 0;
                
                if (hasValidDimensions) {
                    Logger.log(`[TRACE] WINDOW OPENED: "${WINDOW.get_wm_class()}" size=${frame.width}x${frame.height}`);
                }

                const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
                const removedTimestamp = WindowState.get(WINDOW, 'removedTimestamp');
                const timeSinceRemoved = removedTimestamp ? Date.now() - removedTimestamp : Infinity;
                
                const workArea = WORKSPACE.get_work_area_for_monitor(MONITOR);
                Logger.log(`[MOSAIC WM] window-added: window=${WINDOW.get_id()}, size=${frame.width}x${frame.height}, workArea=${workArea.width}x${workArea.height}, timeSince=${timeSinceRemoved}ms, prevWS=${previousWorkspaceIndex}, currentWS=${WORKSPACE.index()}`);
                
                if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index() && timeSinceRemoved < constants.SAFETY_TIMEOUT_BUFFER_MS) {
                    // Skip if this is an overflow move, not a real drag-drop
                    if (WindowState.get(WINDOW, 'movedByOverflow')) {
                        Logger.log(`[MOSAIC WM] window-added: Skipping drag-drop handling - window was moved by overflow`);
                    } else {
                        Logger.log(`[MOSAIC WM] window-added: Overview drag-drop - window ${WINDOW.get_id()} from workspace ${previousWorkspaceIndex} to ${WORKSPACE.index()}`);
                        
                        // ACTIVATE destination workspace and EXIT Overview
                        Logger.log(`[MOSAIC WM] DnD: Activating workspace ${WORKSPACE.index()} and exiting Overview`);
                        WORKSPACE.activate(global.get_current_time());
                        this._ext.windowingManager.showWorkspaceSwitcher(WORKSPACE, MONITOR);
                        
                        // Mark as DnD arrival - will trigger expansion after tiling
                        WindowState.set(WINDOW, 'arrivedFromDnD', true);
                        
                        // Wait for overview to fully close before tiling
                        if (Main.overview.visible) {
                            WindowState.set(WINDOW, 'deferTilingUntilOverviewHidden', true);
                            Main.overview.hide();
                        }
                        
                        // Clear DnD tracking - normal flow will handle window
                        WindowState.remove(WINDOW, 'previousWorkspace');
                        WindowState.remove(WINDOW, 'removedTimestamp');
                        WindowState.remove(WINDOW, 'manualWorkspaceMove');
                    }
                }
                
                // Mark window as waiting for geometry - prevents premature overflow
                WindowState.set(WINDOW, 'waitingForGeometry', true);
                
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.GEOMETRY_CHECK_DELAY_MS, () => {
                    this.waitForGeometry(WINDOW, WORKSPACE, MONITOR);
                    return GLib.SOURCE_REMOVE;
                });
                
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    onWindowRemoved(workspace, window) {
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }
        
        WindowState.set(window, 'previousWorkspace', workspace.index());
        WindowState.set(window, 'removedTimestamp', Date.now());
        
        // SKIP if window was moved by overflow
        const wasMovedByOverflow = WindowState.get(window, 'movedByOverflow');
        
        // Capture removed window's size BEFORE any operations
        const removedFrame = window.get_frame_rect();
        const freedWidth = removedFrame.width;
        const freedHeight = removedFrame.height;
        
        const actor = window.get_compositor_private();
        if (!actor) {
            this._ext.tilingManager.clearPreferredSize(window);
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
            
            const removedId = window.get_id();
            const remainingWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                .filter(w => w.get_id() !== removedId &&
                             !this._ext.edgeTilingManager.isEdgeTiled(w) && 
                             !this._ext.windowingManager.isExcluded(w));
            
            Logger.log(`[MOSAIC WM] _windowRemoved: ${remainingWindows.length} remaining windows, freed ${freedWidth}x${freedHeight}, wasOverflowMove=${wasMovedByOverflow}`);
            
            // FASE 5: Cleanup Smart Resize flags
            Logger.log(`[SMART RESIZE] Cleaning up smart resize flags for remaining windows`);
            for (const w of remainingWindows) {
                const id = w.get_id();
                const wasSmartResized = WindowState.get(w, 'smartResizing');
                const hitMinimum = WindowState.get(w, 'hitMinimumSize');
                const isConstrained = WindowState.get(w, 'isConstrainedByMosaic');
                
                if (wasSmartResized || hitMinimum || isConstrained) {
                    Logger.log(`[SMART RESIZE] Cleaning flags for ${id}: smartResizing=${wasSmartResized}, hitMinimum=${hitMinimum}, constrained=${isConstrained}`);
                }
                
                WindowState.set(w, 'smartResizing', false);
                WindowState.set(w, 'hitMinimumSize', false);
                WindowState.set(w, 'learnedMinSize', null);
                WindowState.set(w, 'targetSmartResizeSize', null);
                WindowState.set(w, 'isConstrainedByMosaic', false); // Release constraint since space was freed
            }
            
            // Try to restore window sizes with freed space (Reverse Smart Resize)
            if (remainingWindows.length > 0) {
                const workArea = this._ext.tilingManager.getUsableWorkArea(WORKSPACE, MONITOR);
                const restored = this._ext.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, WORKSPACE, MONITOR);
                
                if (restored) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_SETTLE_DELAY_MS, () => {
                        Logger.log('[MOSAIC WM] Retiling after restore delay');
                        this._ext.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._ext.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                }
            } else {
                // Workspace is now empty of mosaic windows
                const allRelatedWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                    .filter(w => w.get_id() !== removedId);
                if (allRelatedWindows.length === 0) {
                    if (WORKSPACE.index() < 0) {
                        Logger.log('[MOSAIC WM] _windowRemoved: Workspace already destroyed, skipping navigation');
                        return GLib.SOURCE_REMOVE;
                    }
                    Logger.log('[MOSAIC WM] _windowRemoved: Workspace truly empty, navigating away');
                    this._ext.windowingManager.renavigate(WORKSPACE, WORKSPACE.active, this._ext._lastVisitedWorkspace, MONITOR);
                    
                    // Cleanup flag (if any)
                    WindowState.remove(window, 'isRestoringSacred');
                }
            }
            
            return GLib.SOURCE_REMOVE;
        });
    }

    onWindowWorkspaceChanged(window) {
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

        if (WindowState.get(window, 'unmaximizing')) {
            Logger.log(`[MOSAIC WM] Skipping overflow check for window ${windowId} - currently unmaximizing (undo)`);
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
                                        Logger.log('[MOSAIC WM] WindowHandler: Skipped restore - invalid workArea');
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
                
                // Use async IIFE to handle async tryFitWithResize
                (async () => {
                    const resizeSuccess = await this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                    
                    if (resizeSuccess) {
                        Logger.log('[MOSAIC WM] DnD arrival: Smart Resize succeeded - starting fit check polling');
                        afterWorkspaceSwitch(() => {
                            afterAnimations(this.animationsManager, () => {
                                WindowState.set(window, 'isSmartResizing', true);
                                this._waitForFit(window, currentWorkspace, monitor, existingWindows, workArea);
                            }, this._timeoutRegistry);
                        }, this._timeoutRegistry);
                    } else {
                        Logger.log('[MOSAIC WM] DnD arrival: Smart Resize failed - checking if we should expel');
                        
                        let hasEdgeTiles = false;
                        if (this.edgeTilingManager) {
                             const et = this.edgeTilingManager.getEdgeTiledWindows(currentWorkspace, monitor);
                             hasEdgeTiles = et && et.length > 0;
                        }
                        
                        if (hasEdgeTiles) {
                            Logger.log('[MOSAIC WM] DnD arrival: Edge tiling detected - moving to new workspace (TRACE: OVERFLOW)');
                            WindowState.set(window, 'overflowMoveTimestamp', Date.now());
                            this.windowingManager.moveOversizedWindow(window);
                        } else {
                            Logger.log('[MOSAIC WM] DnD arrival: Pure Mosaic mode - forcing tile');
                            afterWorkspaceSwitch(() => {
                                afterAnimations(this.animationsManager, () => {
                                    this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, false);
                                }, this._timeoutRegistry);
                            }, this._timeoutRegistry);
                        }
                    }
                })();
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
    }

    waitForGeometry(WINDOW, WORKSPACE, MONITOR) {
        const rect = WINDOW.get_frame_rect();
        
        if (rect.width > 0 && rect.height > 0) {
            // Geometry ready
            WindowState.set(WINDOW, 'waitingForGeometry', false);
            WindowState.set(WINDOW, 'geometryReady', true);
            
            if (this._ext.windowingManager.isExcluded(WINDOW)) {
                Logger.log(`[MOSAIC WM] waitForGeometry: Window is excluded - connecting signals but skipping tiling`);
                this.connectWindowSignals(WINDOW);
                return GLib.SOURCE_REMOVE;
            }
            
            const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
            Logger.log(`[MOSAIC WM] Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`);
            
            if (WindowState.get(WINDOW, 'movedByOverflow')) {
                Logger.log(`[MOSAIC WM] Skipping early tile in waitForGeometry - window was moved by overflow`);
                return GLib.SOURCE_REMOVE;
            }
            
            if (Main.overview.visible) {
                Logger.log(`[MOSAIC WM] Window created while overview visible - tiling now + after hide`);
                WindowState.set(WINDOW, 'createdDuringOverview', true);
                this._ext.tilingManager.savePreferredSize(WINDOW);
                this.connectWindowSignals(WINDOW);
                this._ext.tilingManager.calculateLayoutsOnly();
                
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    try {
                        if (Main.overview.visible) {
                            const overview = Main.overview._overview;
                            if (overview && overview._controls && overview._controls._thumbnailsBox) {
                                overview._controls._thumbnailsBox.queue_relayout();
                            }
                        }
                    } catch (e) {}
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }

            const performTiling = async () => {
                await this._ensureWindowFits(WINDOW, WORKSPACE, MONITOR);
            };
            
            const isDnDArrival = WindowState.get(WINDOW, 'arrivedFromDnD');
            const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
            
            if (isDnDArrival || WindowState.get(WINDOW, 'movedByOverflow') || (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index())) {
                Logger.log(`[MOSAIC WM] Cross-workspace move: Waiting for workspace animation`);
                afterWorkspaceSwitch(performTiling, this._ext._timeoutRegistry);
            } else {
                performTiling();
            }

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RETILE_DELAY_MS, () => {
                if (WindowState.get(WINDOW, 'movedByOverflow')) {
                    Logger.log('[MOSAIC WM] Skipping final overflow check - window already moved');
                    return GLib.SOURCE_REMOVE;
                }

                if (WindowState.get(WINDOW, 'isSmartResizing') || WindowState.get(WINDOW, 'isReverseSmartResizing')) {
                    Logger.log('[MOSAIC WM] Skipping final overflow check - smart resize in progress');
                    return GLib.SOURCE_REMOVE;
                }

                if (WindowState.get(WINDOW, 'unmaximizing')) {
                    Logger.log('[MOSAIC WM] Skipping final overflow check - window is unmaximizing (undo)');
                    return GLib.SOURCE_REMOVE;
                }
                
                // Don't trigger overflow decisions while smart resize is in progress
                if (this._ext.tilingManager._isSmartResizingBlocked) {
                    Logger.log('[MOSAIC WM] Skipping overflow check - smart resize in progress');
                    return GLib.SOURCE_CONTINUE;
                }
                
                const canFitFinal = this._ext.tilingManager.canFitWindow(WINDOW, WORKSPACE, MONITOR, true);
                const mosaicWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                          .filter(w => !this._ext.edgeTilingManager.isEdgeTiled(w));
                const isSolo = mosaicWindows.length <= 1;

                if (!canFitFinal) {
                    if (isSolo) {
                        Logger.log('[MOSAIC WM] Overflow detected but window is solo - suppressing move (failsafe)');
                    } else {
                        Logger.log('[MOSAIC WM] Still overflow after protection - triggering manual move');
                        this._ext.windowingManager.moveOversizedWindow(WINDOW);
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
            
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    // Wait for fit after a smart resize operation using deterministic signals.
    _waitForFit(window, workspace, monitor, existingWindows, workArea) {
        const initialWorkspaceIndex = workspace.index();
        const windowId = window.get_id();
        
        let signalIds = [];
        let timeoutId = null;
        let processed = false;

        const cleanup = () => {
            processed = true;
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = null;
            }
            signalIds.forEach(item => {
                if (item.win && item.id) {
                    item.win.disconnect(item.id);
                }
            });
            signalIds = [];
        };

        const checkFit = () => {
            if (processed) return;
            
            // Guard: Stop if window moved workspace or was destroyed
            if (!window.get_workspace() || window.get_workspace().index() !== initialWorkspaceIndex) {
                Logger.log(`[MOSAIC WM] waitForFit: Window ${windowId} moved or destroyed - aborting`);
                WindowState.set(window, 'isSmartResizing', false);
                WindowState.set(window, 'targetSmartResizeSize', null);
                cleanup();
                return;
            }

            // Check fit with relaxed path
            const canFitNow = this.tilingManager.canFitWindow(window, workspace, monitor, true);

            if (canFitNow) {
                Logger.log(`[MOSAIC WM] waitForFit: Window ${windowId} fits via geometry signal - triggering tile`);
                
                // Success: Clear flags for ALL windows in workspace
                const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                for (const win of workspaceWindows) {
                    WindowState.set(win, 'isSmartResizing', false);
                    WindowState.set(win, 'isReverseSmartResizing', false);
                    WindowState.set(win, 'targetSmartResizeSize', null);
                }
                
                let p = this._smartResizeProcessedWindows.get(workspace);
                if (p) p.delete(windowId);

                cleanup();
                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
            }
        };

        // 1. Identify and connect to resizable windows that were triggered
        const resizableWindows = existingWindows.filter(win => WindowState.get(win, 'isSmartResizing'));
        
        if (resizableWindows.length === 0) {
            // Fallback if no windows are marked (shouldn't happen on success)
            Logger.log(`[MOSAIC WM] waitForFit: No resized windows found - triggering immediate check`);
            checkFit();
            if (!processed) {
                // Last ditch effort: try tiling anyway
                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                cleanup();
            }
            return;
        }

        Logger.log(`[MOSAIC WM] waitForFit: Connecting to ${resizableWindows.length} resized windows for geometry signals`);
        
        resizableWindows.forEach(win => {
            // We use size-changed as the primary signal
            const id = win.connect('size-changed', () => checkFit());
            signalIds.push({ win, id });
            
            // Also notify::allocation for Clutter-level stability
            const actor = win.get_compositor_private();
            if (actor) {
                const allocId = actor.connect('notify::allocation', () => checkFit());
                signalIds.push({ win: actor, id: allocId });
            }
        });

        // 2. Safety timeout - if signals never fire or geometry gets stuck
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            if (!processed) {
                Logger.log(`[MOSAIC WM] waitForFit: Signal timeout - forcing final check`);
                checkFit();
                if (!processed) {
                    // Force overflow if it really doesn't fit
                    Logger.log(`[MOSAIC WM] waitForFit: Still doesn't fit - moving to overflow`);
                    this.windowingManager.moveOversizedWindow(window);
                    cleanup();
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }
});
