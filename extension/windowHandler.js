// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// WindowHandler - Manages window lifecycle signals and state transitions.

import GLib from 'gi://GLib';
import * as Logger from './logger.js';
import { ComputedLayouts } from './tiling.js';
import * as WindowState from './windowState.js';

export class WindowHandler {
    constructor(extension) {
        this._ext = extension;
    }

    // Accessor shortcuts
    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }

    // Connect all signals for a window to track state changes
    connectWindowSignals(window) {
        // Workspace change signal
        if (!WindowState.has(window, 'workspaceSignalId')) {
            const signalId = window.connect('workspace-changed', () => {
                this._ext._windowWorkspaceChangedHandler(window);
            });
            WindowState.set(window, 'workspaceSignalId', signalId);
        }
        
        // Always-on-top state change
        if (!WindowState.has(window, 'aboveSignalId')) {
            const aboveSignalId = window.connect('notify::above', () => {
                Logger.log(`[MOSAIC WM] notify::above triggered for window ${window.get_id()}`);
                this.handleExclusionStateChange(window);
            });
            WindowState.set(window, 'aboveSignalId', aboveSignalId);
            Logger.log(`[MOSAIC WM] Connected notify::above signal for window ${window.get_id()}`);
        }
        
        // Sticky (on-all-workspaces) state change
        if (!WindowState.has(window, 'stickySignalId')) {
            const stickySignalId = window.connect('notify::on-all-workspaces', () => {
                this.handleExclusionStateChange(window);
            });
            WindowState.set(window, 'stickySignalId', stickySignalId);
        }
        
        // Invalidate ComputedLayouts cache on position/size change
        if (!WindowState.has(window, 'positionSignalId')) {
            const posSignalId = window.connect('position-changed', () => {
                ComputedLayouts.delete(window.get_id());
            });
            WindowState.set(window, 'positionSignalId', posSignalId);
        }

        if (!WindowState.has(window, 'sizeSignalId')) {
            const sizeSignalId = window.connect('size-changed', () => {
                ComputedLayouts.delete(window.get_id());
            });
            WindowState.set(window, 'sizeSignalId', sizeSignalId);
        }
        
        // Initialize exclusion state tracking
        const currentExclusion = this.windowingManager.isExcluded(window);
        WindowState.set(window, 'previousExclusionState', currentExclusion);
        Logger.log(`[MOSAIC WM] Initialized exclusion state for window ${window.get_id()}: ${currentExclusion}`);
        
        // Track previous workspace for cross-workspace moves
        const currentWorkspace = window.get_workspace();
        if (currentWorkspace) {
            WindowState.set(window, 'previousWorkspace', currentWorkspace.index());
            Logger.log(`[MOSAIC WM] Initialized workspace tracker for window ${window.get_id()} at workspace ${currentWorkspace.index()}`);
        }
    }

    // Disconnect all signals for a window
    disconnectWindowSignals(window) {
        // Disconnect workspace signal
        const signalId = WindowState.get(window, 'workspaceSignalId');
        if (signalId) {
            window.disconnect(signalId);
            WindowState.remove(window, 'workspaceSignalId');
        }
    
        // Disconnect position signal
        const posSignalId = WindowState.get(window, 'positionSignalId');
        if (posSignalId) {
            window.disconnect(posSignalId);
            WindowState.remove(window, 'positionSignalId');
        }

        // Disconnect size signal
        const sizeSignalId = WindowState.get(window, 'sizeSignalId');
        if (sizeSignalId) {
            window.disconnect(sizeSignalId);
            WindowState.remove(window, 'sizeSignalId');
        }
        
        // Disconnect above signal
        const aboveSignalId = WindowState.get(window, 'aboveSignalId');
        if (aboveSignalId) {
            window.disconnect(aboveSignalId);
            WindowState.remove(window, 'aboveSignalId');
        }
        
        // Disconnect sticky signal
        const stickySignalId = WindowState.get(window, 'stickySignalId');
        if (stickySignalId) {
            WindowState.remove(window, 'stickySignalId');
        }
        
        // Clear layout cache
        ComputedLayouts.delete(window.get_id());
        
        // Clean up other states
        WindowState.remove(window, 'previousExclusionState');
        WindowState.remove(window, 'previousWorkspace');
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
                
                // Try smart resize
                const resizeSuccess = this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                
                if (resizeSuccess) {
                    Logger.log('[MOSAIC WM] Re-include: Smart resize applied - starting fit check polling');
                    WindowState.set(window, 'isSmartResizing', true);
                    
                    const initialWorkspaceIndex = workspace.index();
                    const MAX_ATTEMPTS = 12;
                    const POLL_INTERVAL = 75;
                    let attempts = 0;
                    
                    const pollForFit = () => {
                        if (window.get_workspace()?.index() !== initialWorkspaceIndex) {
                            Logger.log(`[MOSAIC WM] Re-include: Window moved workspace - aborting poll`);
                            WindowState.set(window, 'isSmartResizing', false);
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        attempts++;
                        const canFitNow = this.tilingManager.canFitWindow(window, workspace, monitor);
                        
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
                        this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                        return GLib.SOURCE_CONTINUE;
                    };
                    
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL, pollForFit);
                } else {
                    Logger.log(`[MOSAIC WM] Re-include: Smart resize not applicable - moving to overflow`);
                    this.windowingManager.moveOversizedWindow(window);
                }
                
                return GLib.SOURCE_REMOVE;
            });
        }
    }
    
    // =========================================================================
    // FUTURE: The following methods could be extracted from extension.js:
    // - waitForGeometry(): Window geometry polling and readiness detection
    // - windowCreated(): Handle window-created signal
    // - windowDestroyed(): Handle window destruction and cleanup
    // =========================================================================
}
