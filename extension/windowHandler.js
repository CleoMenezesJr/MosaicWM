// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// WindowHandler - Manages window lifecycle signals and state transitions.

import GLib from 'gi://GLib';
import * as Logger from './logger.js';
import { ComputedLayouts } from './tiling.js';

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
        const windowId = window.get_id();
        
        // Workspace change signal
        const signalId = window.connect('workspace-changed', () => {
            this._ext._windowWorkspaceChangedHandler(window);
        });
        this._ext._windowWorkspaceSignals.set(windowId, signalId);
        
        // Always-on-top state change
        const aboveSignalId = window.connect('notify::above', () => {
            Logger.log(`[MOSAIC WM] notify::above triggered for window ${windowId}`);
            this.handleExclusionStateChange(window);
        });
        this._ext._windowAboveSignals = this._ext._windowAboveSignals || new Map();
        this._ext._windowAboveSignals.set(windowId, aboveSignalId);
        Logger.log(`[MOSAIC WM] Connected notify::above signal for window ${windowId}`);
        
        // Sticky (on-all-workspaces) state change
        const stickySignalId = window.connect('notify::on-all-workspaces', () => {
            this.handleExclusionStateChange(window);
        });
        this._ext._windowStickySignals = this._ext._windowStickySignals || new Map();
        this._ext._windowStickySignals.set(windowId, stickySignalId);
        
        // Initialize signal maps if needed
        this._ext._windowPositionSignals = this._ext._windowPositionSignals || new Map();
        this._ext._windowSizeSignals = this._ext._windowSizeSignals || new Map();

        // Invalidate ComputedLayouts cache on position/size change
        const posSignalId = window.connect('position-changed', () => {
            ComputedLayouts.delete(windowId);
        });
        this._ext._windowPositionSignals.set(windowId, posSignalId);

        const sizeSignalId = window.connect('size-changed', () => {
            ComputedLayouts.delete(windowId);
        });
        this._ext._windowSizeSignals.set(windowId, sizeSignalId);
        
        // Initialize exclusion state tracking
        this._ext._windowPreviousExclusionState = this._ext._windowPreviousExclusionState || new Map();
        this._ext._windowPreviousExclusionState.set(windowId, this.windowingManager.isExcluded(window));
        Logger.log(`[MOSAIC WM] Initialized exclusion state for window ${windowId}: ${this._ext._windowPreviousExclusionState.get(windowId)}`);
        
        // Track previous workspace for cross-workspace moves
        const currentWorkspace = window.get_workspace();
        if (currentWorkspace) {
            this._ext._windowPreviousWorkspace.set(windowId, currentWorkspace.index());
            Logger.log(`[MOSAIC WM] Initialized workspace tracker for window ${windowId} at workspace ${currentWorkspace.index()}`);
        }
    }

    // Disconnect all signals for a window
    disconnectWindowSignals(window) {
        const windowId = window.get_id();
        
        // Disconnect workspace signal
        const signalId = this._ext._windowWorkspaceSignals.get(windowId);
        if (signalId) {
            window.disconnect(signalId);
            this._ext._windowWorkspaceSignals.delete(windowId);
        }
    
        // Disconnect position signal
        if (this._ext._windowPositionSignals?.has(windowId)) {
            window.disconnect(this._ext._windowPositionSignals.get(windowId));
            this._ext._windowPositionSignals.delete(windowId);
        }

        // Disconnect size signal
        if (this._ext._windowSizeSignals?.has(windowId)) {
            window.disconnect(this._ext._windowSizeSignals.get(windowId));
            this._ext._windowSizeSignals.delete(windowId);
        }
        
        // Disconnect above signal (Always on Top)
        if (this._ext._windowAboveSignals?.has(windowId)) {
            window.disconnect(this._ext._windowAboveSignals.get(windowId));
            this._ext._windowAboveSignals.delete(windowId);
        }
        
        // Disconnect sticky signal (On All Workspaces)
        if (this._ext._windowStickySignals?.has(windowId)) {
            window.disconnect(this._ext._windowStickySignals.get(windowId));
            this._ext._windowStickySignals.delete(windowId);
        }
    }

    // Handle exclusion state transitions (Always on Top, Sticky, etc.)
    handleExclusionStateChange(window) {
        const windowId = window.get_id();
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        
        const isNowExcluded = this.windowingManager.isExcluded(window);
        
        // Track previous state to detect transitions
        this._ext._windowPreviousExclusionState = this._ext._windowPreviousExclusionState || new Map();
        const wasExcluded = this._ext._windowPreviousExclusionState.get(windowId) || false;
        this._ext._windowPreviousExclusionState.set(windowId, isNowExcluded);
        
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
                    window._justReturnedFromExclusion = true;
                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                    return GLib.SOURCE_REMOVE;
                }
                
                // Try smart resize
                const resizeSuccess = this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                
                if (resizeSuccess) {
                    Logger.log('[MOSAIC WM] Re-include: Smart resize applied - starting fit check polling');
                    window._isSmartResizing = true;
                    
                    const initialWorkspaceIndex = workspace.index();
                    const MAX_ATTEMPTS = 12;
                    const POLL_INTERVAL = 75;
                    let attempts = 0;
                    
                    const pollForFit = () => {
                        if (window.get_workspace()?.index() !== initialWorkspaceIndex) {
                            Logger.log(`[MOSAIC WM] Re-include: Window moved workspace - aborting poll`);
                            window._isSmartResizing = false;
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        attempts++;
                        const canFitNow = this.tilingManager.canFitWindow(window, workspace, monitor);
                        
                        if (canFitNow) {
                            Logger.log(`[MOSAIC WM] Re-include: Smart resize success after ${attempts} polls`);
                            window._isSmartResizing = false;
                            window._justReturnedFromExclusion = true;
                            this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                            return GLib.SOURCE_REMOVE;
                        }
                        
                        if (attempts >= MAX_ATTEMPTS) {
                            Logger.log('[MOSAIC WM] Re-include: Smart resize failed - moving to overflow');
                            window._isSmartResizing = false;
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
