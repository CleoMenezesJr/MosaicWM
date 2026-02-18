// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// ResizeHandler - Manages window resize operations and maximize undo.

import GLib from 'gi://GLib';
import * as Logger from './logger.js';
import { afterWorkspaceSwitch, afterAnimations } from './timing.js';
import * as WindowState from './windowState.js';
import * as constants from './constants.js';

import GObject from 'gi://GObject';

export const ResizeHandler = GObject.registerClass({
    GTypeName: 'MosaicResizeHandler',
}, class ResizeHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;
        
        // Resize state
        this._sizeChanged = false;
        this._resizeOverflowWindow = null;
        this._resizeInOverflow = false;
        this._resizeGracePeriod = null;
        this._resizeDebounceTimeout = null;
        this._lastResizeWindow = null;
        this._lastResizeTime = 0;
    }

    // Accessor shortcuts
    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get dragHandler() { return this._ext.dragHandler; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }
    get _currentGrabOp() { return this.dragHandler._currentGrabOp; }
    get _skipNextTiling() { return this.dragHandler._skipNextTiling; }
    set _skipNextTiling(val) { this.dragHandler._skipNextTiling = val; }

    onResizeBegin(window, grabpo) {
        this._resizeInOverflow = false;
        this.animationsManager.setResizingWindow(window.get_id());
        
        // Clear smart-resize mode so manual resize can trigger overflow check
        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log(`Manual resize started for ${window.get_id()} - clearing smart-resize state`);
            WindowState.set(window, 'isSmartResizing', false);
            WindowState.set(window, 'targetSmartResizeSize', null);
        }
        
        Logger.log(`Tracking resize for window ${window.get_id()}, grabpo=${grabpo}`);
    }

    onResizeEnd(window, grabpo, skipTiling) {
        this.animationsManager.setResizingWindow(null);
        Logger.log(`Cleared resize tracking for window ${window.get_id()}`);
        
        const tileState = this.edgeTilingManager.getWindowState(window);
        const isEdgeTiled = tileState && tileState.zone !== TileZone.NONE;
        
        if (isEdgeTiled && (tileState.zone === TileZone.LEFT_FULL || tileState.zone === TileZone.RIGHT_FULL)) {
            Logger.log(`Resize ended (grabpo=${grabpo}) for FULL edge-tiled window - fixing final sizes`);
            const adjacentWindow = this.edgeTilingManager._getAdjacentWindow(window, window.get_workspace(), window.get_monitor(), tileState.zone);
            if (adjacentWindow) {
                this.edgeTilingManager.fixTiledPairSizes(window, tileState.zone);
            } else {
                this.edgeTilingManager.fixMosaicAfterEdgeResize(window, tileState.zone);
            }
        } else if (isEdgeTiled && this.edgeTilingManager.isQuarterZone(tileState.zone)) {
            Logger.log(`Resize ended (grabpo=${grabpo}) for QUARTER edge-tiled window - fixing final sizes`);
            this.edgeTilingManager.fixQuarterPairSizes(window, tileState.zone);
        }
        
        if (this._resizeDebounceTimeout) {
            GLib.source_remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }
        
        this._resizeGracePeriod = Date.now();
        
        if (this._resizeInOverflow || this._resizeOverflowWindow === window) {
            Logger.log('Resize ended with overflow - moving window to new workspace');
            this._resizeInOverflow = false;
            const actor = window.get_compositor_private();
            if (actor) actor.opacity = 255;
            
            let oldWorkspace = window.get_workspace();
            let newWorkspace = this.windowingManager.moveOversizedWindow(window);
            if (newWorkspace) {
                afterAnimations(this.animationsManager, () => {
                    const monitor = window.get_monitor();
                    if (monitor !== null) {
                        this.tilingManager.tileWorkspaceWindows(oldWorkspace, false, monitor, false);
                    }
                }, this._timeoutRegistry);
            }
            this._resizeOverflowWindow = null;
        } else if (!isEdgeTiled && !skipTiling) {
            this.tilingManager.savePreferredSize(window);
            this.tilingManager.tileWorkspaceWindows(window.get_workspace(), null, window.get_monitor(), true);
        }
    }

    onSizeChange = (_, win, mode) => {
        let window = win.meta_window;
        if (!this.windowingManager.isExcluded(window)) {
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();

            // Modes: 0=MAXIMIZE, 1=UNMAXIMIZE, 2=FULLSCREEN (Mutter/Wayland uses this mode value)
            if (mode === 2 || mode === 0) {
                // LOCK: Set flag to block onSizeChanged from saving giant dimensions
                WindowState.set(window, 'isEnteringSacred', true);
                
                if (this.windowingManager.isMaximizedOrFullscreen(window) && 
                    this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor).length > 1) {
                    
                    Logger.log('User entering sacred state - moving to new workspace');
                    const originalWorkspaceIndex = workspace.index();
                    const preMaxSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
                    
                    let newWorkspace = this.windowingManager.moveOversizedWindow(window);
                    if (newWorkspace) {
                        WindowState.set(window, 'maximizedUndoInfo', {
                            originalWorkspace: originalWorkspaceIndex,
                            currentWorkspace: newWorkspace.index(),
                            monitor: monitor,
                            preMaxSize: preMaxSize
                        });
                        this.tilingManager.tileWorkspaceWindows(workspace, false, monitor, false);
                    }
                }
            } else if (mode === 1) { // Unmaximized
                WindowState.set(window, 'unmaximizing', true);
                const maxInfo = WindowState.get(window, 'maximizedUndoInfo');
                if (maxInfo) {
                    Logger.log(`Window ${window.get_id()} was unmaximized - attempting undo`);
                    this.handleUnmaximizeUndo(window, maxInfo);
                    WindowState.remove(window, 'maximizedUndoInfo');
                }
            }
        }
    };

    onSizeChanged = (_, win) => {
        let window = win.meta_window;
        if (!this._sizeChanged && !this.windowingManager.isExcluded(window)) {
            if (!this.windowingManager.isRelated(window)) return;
            
            const rect = window.get_frame_rect();
            if (rect.width <= constants.ANIMATION_DIFF_THRESHOLD || rect.height <= constants.ANIMATION_DIFF_THRESHOLD) return;
            
            if (WindowState.get(window, 'isSmartResizing') || WindowState.get(window, 'isReverseSmartResizing')) {
                this._sizeChanged = false;
                return;
            }

            // STATE MACHINE STAGE 2: Deferred Move Completion
            const originWorkspaceIndex = WindowState.get(window, 'isRestoringSacred');
            if (originWorkspaceIndex !== undefined) {
                // If the window is no longer sacred (maximized or fullscreen), it has finished resizing in place.
                if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
                    Logger.log(`Window ${window.get_id()} finished in-place resize. Moving to origin workspace ${originWorkspaceIndex}.`);
                    
                    const workspaceManager = global.workspace_manager;
                    if (originWorkspaceIndex >= 0 && originWorkspaceIndex < workspaceManager.get_n_workspaces()) {
                        const originWS = workspaceManager.get_workspace_by_index(originWorkspaceIndex);
                        const monitor = window.get_monitor();
                        
                        // MOVE ATOMICALLY
                        window.change_workspace(originWS);
                        originWS.activate(global.get_current_time());
                        this.windowingManager.showWorkspaceSwitcher(originWS, monitor);
                        
                        // CLEAR FLAGS IMMEDIATELY to prevent double-move
                        WindowState.remove(window, 'isRestoringSacred');
                        
                        // TILE IN DESTINATION
                        afterWorkspaceSwitch(() => {
                            Logger.log(`Triggering tiling in destination workspace ${originWorkspaceIndex}`);
                            this.tilingManager.tileWorkspaceWindows(originWS, window, monitor);
                            
                            // Clear unmaximizing flags after a settle period
                            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_SETTLE_DELAY_MS, () => {
                                WindowState.remove(window, 'unmaximizing');
                                WindowState.remove(window, 'targetRestoredSize');
                                return GLib.SOURCE_REMOVE;
                            });
                        }, this._timeoutRegistry);
                        
                        this._sizeChanged = false;
                        return;
                    }
                }
                
                // If it's still maximized/fullscreen but moving, block size updates
                this._sizeChanged = false;
                return;
            }

            if (this.windowingManager.isMaximizedOrFullscreen(window)) {
                this._sizeChanged = false;
                return;
            }

            if (WindowState.get(window, 'unmaximizing')) {
                this._sizeChanged = false;
                return;
            }
            
            if (WindowState.get(window, 'actualMinWidth') && rect.width > WindowState.get(window, 'actualMinWidth') + 20) {
                WindowState.remove(window, 'actualMinWidth');
                WindowState.remove(window, 'actualMinHeight');
            }
            
            const isConstrained = WindowState.get(window, 'isConstrainedByMosaic');
            const isManualResizeAction = this._currentGrabOp && constants.RESIZE_GRAB_OPS.includes(this._currentGrabOp);
            
            if (isManualResizeAction) {
                // Manual resize always updates preferredSize and clears constraints
                WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
                if (isConstrained) {
                    WindowState.set(window, 'isConstrainedByMosaic', false);
                    Logger.log(`Manual resize for ${window.get_id()} - cleared constraint`);
                }
                Logger.log(`Preferred size updated (manual): ${window.get_id()} = ${rect.width}x${rect.height}`);
            } else if (!isConstrained) {
                // If NOT constrained and NOT manual, it might be an initial placement or legitimate external resize
                // But we still guard against transition states
                if (WindowState.get(window, 'isEnteringSacred') || 
                    WindowState.get(window, 'unmaximizing') ||
                    WindowState.get(window, 'isRestoringSacred')) {
                    Logger.log(`onSizeChanged: Save blocked by transition flag for ${window.get_id()}`);
                } else {
                    const currentPreferredSize = WindowState.get(window, 'preferredSize');
                    if (currentPreferredSize) {
                        const widthDiff = Math.abs(rect.width - currentPreferredSize.width);
                        const heightDiff = Math.abs(rect.height - currentPreferredSize.height);
                        if (widthDiff > constants.ANIMATION_DIFF_THRESHOLD || heightDiff > constants.ANIMATION_DIFF_THRESHOLD) {
                            WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
                            Logger.log(`Preferred size updated (ambient): ${window.get_id()} = ${rect.width}x${rect.height}`);
                        }
                    } else if (WindowState.get(window, 'geometryReady')) {
                         // First time seeing a size for this window
                         WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
                         Logger.log(`Initial preferred size saved: ${window.get_id()} = ${rect.width}x${rect.height}`);
                    }
                }
            }
            
            // Mode-Based Lock Cleanup
            WindowState.remove(window, 'isEnteringSacred');
            
            if (this._skipNextTiling === window.get_id()) return;

            let tileState = this.edgeTilingManager.getWindowState(window);
            let isEdgeTiled = tileState && tileState.zone !== TileZone.NONE;
            if (isEdgeTiled) return;

            this._sizeChanged = true;
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();
            
            if (WindowState.get(window, 'movedByOverflow')) {
                this._sizeChanged = false;
                return;
            }
            
            if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
                const isManualResize = this._currentGrabOp && constants.RESIZE_GRAB_OPS.includes(this._currentGrabOp);
                const windowId = window.get_id();
                const resizeNow = Date.now();
                const isActiveResize = isManualResize || 
                    (this._lastResizeWindow === windowId && (resizeNow - this._lastResizeTime) < constants.RESIZE_SETTLE_DELAY_MS * 2);
                this._lastResizeWindow = windowId;
                this._lastResizeTime = resizeNow;
                
                if (isActiveResize) {
                    if (this._resizeDebounceTimeout) {
                        GLib.source_remove(this._resizeDebounceTimeout);
                        this._resizeDebounceTimeout = null;
                    }
                    
                    // Batch events with 50ms delay to allow overflow detection and
                    // ghost mode feedback during continuous resizing.
                    this._resizeDebounceTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        this._resizeDebounceTimeout = null;
                        
                        let canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                        const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                            .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
                        const isSolo = mosaicWindows.length <= 1;
                        
                        // Block moves during smart resize to prevent expelling windows on revert.
                        const isSmartResizing = this.tilingManager._isSmartResizingBlocked;

                        if (!canFit && !this._resizeInOverflow && !isSolo && !isSmartResizing) {
                            if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
                                return GLib.SOURCE_REMOVE;
                            }
                            
                            // GHOST MODE: Reduce opacity to signal that the window no longer fits.
                            this._resizeInOverflow = true;
                            this._resizeOverflowWindow = window;
                            const actor = window.get_compositor_private();
                            if (actor) actor.opacity = 128;
                            Logger.log(`Resize overflow detected for window ${window.get_id()} - enabling ghost mode`);
                            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true, false);
                        } else {
                            // Recovery logic: if it fits again, clear overflow state and restore full opacity
                            if (canFit && this._resizeInOverflow) {
                                this._resizeInOverflow = false;
                                this._resizeOverflowWindow = null;
                                const actor = window.get_compositor_private();
                                if (actor) actor.opacity = 255;
                                Logger.log(`Window ${window.get_id()} recovered from resize overflow`);
                            }
                            
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
                const now = Date.now();
                if (this._resizeGracePeriod && (now - this._resizeGracePeriod) < constants.REVERSE_RESIZE_PROTECTION_MS) {
                    this._sizeChanged = false;
                    return;
                }
                
                if (workspace._smartResizingInProgress || WindowState.get(window, 'isSmartResizing') || this.tilingManager._isSmartResizingBlocked) {
                    this._sizeChanged = false;
                    return;
                }
                
                const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
                const isSolo = mosaicWindows.length <= 1;

                if (!canFit && !isSolo) {
                    if (this._resizeOverflowWindow !== window) {
                        if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
                            this._sizeChanged = false;
                            return;
                        }
                        
                        if (this._ext.windowHandler && this._ext.windowHandler.isWorkspaceLocked(workspace)) {
                            this._sizeChanged = false;
                            return;
                        }

                        this._resizeOverflowWindow = window;
                        let oldWorkspace = workspace;
                        let newWorkspace = this.windowingManager.moveOversizedWindow(window);
                        if (newWorkspace) {
                            this.tilingManager.tileWorkspaceWindows(oldWorkspace, false, monitor, false);
                        }
                        this._resizeOverflowWindow = null;
                        this._sizeChanged = false;
                        return;
                    }
                } else if (canFit && this._resizeOverflowWindow === window) {
                    this._resizeOverflowWindow = null;
                }
                
                // If it fits, perform tiling to ensure other windows move out of the way (live tiling)
                // However, we throttle it slightly to avoid excessive calculations during smooth resizing
                if (canFit) {
                    if (this._lastTileTime && (now - this._lastTileTime < 30)) {
                         this._sizeChanged = false;
                         return; 
                    }
                    this._lastTileTime = now;
                }
            }
            
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
            this._sizeChanged = false;
        }
    };

    handleUnmaximizeUndo(window, maxInfo) {
        const { originalWorkspace: origIndex, monitor, preMaxSize } = maxInfo;
        const currentWorkspace = window.get_workspace();
        const workspaceManager = global.workspace_manager;
        const windowId = window.get_id();
        
        if (preMaxSize) {
            WindowState.set(window, 'openingSize', preMaxSize);
        }
        
        if (origIndex >= workspaceManager.get_n_workspaces()) {
            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor);
            return;
        }
        
        const targetWorkspace = workspaceManager.get_workspace_by_index(origIndex);
        if (currentWorkspace.index() === origIndex) {
            Logger.log(`handleUnmaximizeUndo: Window ${windowId} unmaximized on SAME workspace - tiling immediately`);
            WindowState.set(window, 'unmaximizing', true);
            if (preMaxSize) {
                WindowState.set(window, 'targetRestoredSize', preMaxSize);
            }
            
            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, true);
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_SETTLE_DELAY_MS + 100, () => {
                WindowState.remove(window, 'unmaximizing');
                WindowState.remove(window, 'targetRestoredSize');
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        
        if (preMaxSize) {
            WindowState.set(window, 'preferredSize', preMaxSize);
        }
        
        // SMART FIT: Try to fit without resize first, then attempt to fit WITH resize
        const existingWindows = targetWorkspace.list_windows().filter(w => !this.windowingManager.isExcluded(w));
        let canFit = this.tilingManager.canFitWindow(window, targetWorkspace, monitor, true, preMaxSize);
        let resizeNeeded = false;
        
        if (!canFit) {
            Logger.log(`handleUnmaximizeUndo: Window ${windowId} doesn't fit normally - attempting Smart Resize fit`);
            // Pass preMaxSize as overrideSize to tryFitWithResize
            canFit = this.tilingManager.tryFitWithResize(window, existingWindows, targetWorkspace.get_work_area_for_monitor(monitor), preMaxSize);
            resizeNeeded = canFit;
        }
        
        if (!canFit) {
            Logger.log(`handleUnmaximizeUndo: Window ${windowId} unable to fit even with Smart Resize - staying in current workspace`);
            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor);
            return;
        }
        
        if (resizeNeeded) {
            Logger.log(`handleUnmaximizeUndo: Smart Resize applied successfully for return of ${windowId}`);
        }
        
        window.unmaximize();
        WindowState.set(window, 'unmaximizing', true);
        WindowState.set(window, 'isConstrainedByMosaic', true); 
        
        if (preMaxSize) {
            WindowState.set(window, 'targetRestoredSize', preMaxSize);
            WindowState.set(window, 'openingSize', preMaxSize);
            WindowState.set(window, 'preferredSize', preMaxSize);
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (!window.get_compositor_private()) return GLib.SOURCE_REMOVE;

            const oldWorkspace = currentWorkspace;
            window.change_workspace(targetWorkspace);
            targetWorkspace.activate(global.get_current_time());
            this.windowingManager.showWorkspaceSwitcher(targetWorkspace, monitor);
            
            afterWorkspaceSwitch(() => {
                this.tilingManager.tileWorkspaceWindows(targetWorkspace, window, monitor, true);
                if (oldWorkspace.index() >= 0 && oldWorkspace.index() < workspaceManager.get_n_workspaces()) {
                    this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, monitor, true);
                }

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RESIZE_SETTLE_DELAY_MS, () => {
                    WindowState.remove(window, 'unmaximizing');
                    WindowState.remove(window, 'isConstrainedByMosaic');
                    WindowState.remove(window, 'targetRestoredSize');
                    return GLib.SOURCE_REMOVE;
                });
            }, this._timeoutRegistry);
            
            return GLib.SOURCE_REMOVE;
        });
    }
} );
