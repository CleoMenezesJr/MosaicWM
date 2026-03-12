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

        this._evaluationQueue = [];
        this._isEvaluatingQueue = false;

        this._overflowInProgress = false; // Moved from extension.js
        this._windowSignals = new WeakMap(); // Store signal IDs for cleanup using WeakMap for memory safety
        this._origShouldAnimateActor = null; 
    }

    patchMapWindow() {
        if (this._origShouldAnimateActor) return; // Already patched

        Logger.log('Patching Main.wm._shouldAnimateActor for slide-in animations');
        this._origShouldAnimateActor = Main.wm._shouldAnimateActor;
        
        const self = this;
        Main.wm._shouldAnimateActor = function(actor, types) {
            // First, call the original to see if GNOME thinks we should animate
            const shouldAnimate = self._origShouldAnimateActor.call(this, actor, types);
            
            if (!shouldAnimate) return false;
            
            const win = actor.meta_window;
            if (!win) return true;

            const frame = win.get_frame_rect();
            Logger.log(`[PATCH SIZE CHECK] _shouldAnimateActor intercepted window ${win.get_id()} with size ${frame.width}x${frame.height}`);

            const stack = (new Error()).stack;
            if (!stack.includes('_mapWindow@') && !stack.includes('mapWindow') && !stack.includes('size_change')) return true;

            const isRelated = self._ext && self._ext.windowingManager.isRelated(win);
            if (!isRelated) return true;

            // Skip slide-in for windows moved by overflow or during active switch (protects clones).
            if (WindowState.get(win, 'movedByOverflow') || (self._ext && self._ext._overflowInProgress)) {
                Logger.log(`[PATCH SIZE CHECK] Skipping slide-in for window ${win.get_id()} - overflow active or window moved`);
                return true;
            }

            // Evaluate if we should slide in, natively calculating JIT neighbors
            const { offsetX, offsetY, animationMode } = self._evaluateSlideIn(win);

            if (offsetX !== 0 || offsetY !== 0) {
                Logger.log(`MAPPED SLIDE-IN (ease intercepted): Applying offset (${offsetX}, ${offsetY}) to window ${win.get_id()} Mode: ${animationMode}`);
                self._applySlideInAnimation(actor, offsetX, offsetY, animationMode);
            }

            return true;
        };
    }

    unpatchMapWindow() {
        if (this._origShouldAnimateActor) {
            Logger.log('Unpatching Main.wm._shouldAnimateActor');
            Main.wm._shouldAnimateActor = this._origShouldAnimateActor;
            this._origShouldAnimateActor = null;
        }
    }

    destroy() {
        this.unpatchMapWindow();
        this._evaluationQueue = [];
        this._isEvaluatingQueue = false;
    }

    _evaluateSlideIn(window) {
        let offsetX = 0, offsetY = 0;
        let animationMode = Clutter.AnimationMode.EASE_OUT_QUART;

        const ws = window.get_workspace();
        const mon = window.get_monitor();
        const frame = window.get_frame_rect();

        if (!ws || mon < 0 || frame.width <= 0) {
            return { offsetX, offsetY, animationMode };
        }

        const existingWindows = ws.list_windows().filter(w =>
            w.get_monitor() === mon &&
            w.get_id() !== window.get_id() &&
            !w.minimized &&
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !this.windowingManager.isExcluded(w) &&
            w.showing_on_its_workspace()
        );

        let offsetDirection = 0;
        const currentWSIndex = ws.index();
        const prevWSIndex = WindowState.get(window, 'previousWorkspace');

        if (prevWSIndex !== undefined && prevWSIndex !== currentWSIndex) {
            offsetDirection = prevWSIndex < currentWSIndex ? -1 : 1;
        }

        const OFFSET = constants.SLIDE_IN_OFFSET_PX;

        if (existingWindows.length > 0) {
            let centerX = 0, centerY = 0, count = 0;
            for (const n of existingWindows) {
                try {
                    const r = n.get_frame_rect();
                    if (r && r.width > 0) {
                        centerX += r.x + r.width / 2;
                        centerY += r.y + r.height / 2;
                        count++;
                    }
                } catch (e) {}
            }
            if (count > 0) {
                centerX /= count;
                centerY /= count;
                const winCenterX = frame.x + frame.width / 2;
                const winCenterY = frame.y + frame.height / 2;
                const deltaX = winCenterX - centerX;
                const deltaY = winCenterY - centerY;
                
                if (Math.abs(deltaX) >= Math.abs(deltaY)) {
                    offsetX = deltaX > constants.ANIMATION_DIFF_THRESHOLD ? OFFSET : (deltaX < -constants.ANIMATION_DIFF_THRESHOLD ? -OFFSET : 0);
                } else {
                    offsetY = deltaY > constants.ANIMATION_DIFF_THRESHOLD ? OFFSET : (deltaY < -constants.ANIMATION_DIFF_THRESHOLD ? -OFFSET : 0);
                }
            }
        } else if (offsetDirection !== 0) {
            offsetX = offsetDirection * OFFSET * 3;
            animationMode = Clutter.AnimationMode.EASE_OUT_BACK;
        }

        return { offsetX, offsetY, animationMode };
    }

    _applySlideInAnimation(actor, offsetX, offsetY, animationMode) {
        const win = actor.meta_window;
        const origEase = actor.ease;
        
        actor.ease = function(props) {
            const callStack = (new Error()).stack;
            if (callStack.includes('_mapWindow@')) {
                // Restore ease immediately
                actor.ease = origEase;

                // Revert GNOME's initial scaling setup (from _mapWindow)
                actor.set_scale(1.0, 1.0);
                actor.set_pivot_point(0.5, 0.5);

                // Apply our slide offset
                actor.set_translation(offsetX, offsetY, 0);
                
                // Force opacity to 0
                actor.opacity = 0;

                // Let GNOME handle the wait
                WindowState.set(win, 'slideInAnimating', true);

                origEase.call(this, {
                    translation_x: 0,
                    translation_y: 0,
                    opacity: 255,
                    duration: 300,
                    mode: animationMode,
                    onStopped: () => {
                        actor.opacity = 255;
                        WindowState.remove(win, 'slideInAnimating');
                        if (props.onStopped) props.onStopped();
                    }
                });
            } else {
                origEase.apply(this, arguments);
            }
        };
    }

    // Lock a workspace to prevent recursive or conflicting tiling triggers.
    lockWorkspace(workspace) {
        if (!workspace) return;
        this._workspaceLocks.set(workspace, true);
        Logger.log(`Workspace ${workspace.index()} LOCKED for tiling`);
    }

    // Unlock a workspace after tiling is complete.
    unlockWorkspace(workspace) {
        if (!workspace) return;
        this._workspaceLocks.delete(workspace);
        Logger.log(`Workspace ${workspace.index()} UNLOCKED`);
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

        Logger.log(`Connecting signals for window ${window.get_id()}`);
        let ids = [];

        // Final cleanup signal
        ids.push(window.connect('unmanaged', (win) => {
            Logger.log(`Window ${win.get_id()} (unmanaged) - cleaning up`);
            this.animationsManager.removeAnimatingWindow(win.get_id());
            const ws = win.get_workspace();
            if (ws) this.onWindowRemoved(ws, win);
            this.disconnectWindowSignals(win);
        }));

        // Detect Maximized changes. Have two signals that fires when (un)maximize, so we coalesce it via idle.
        let pendingMaximizeCheck = false;
        ['notify::maximized-horizontally', 'notify::maximized-vertically'].forEach(signal => {
            ids.push(window.connect(signal, (win) => {
                if (pendingMaximizeCheck) return;
                pendingMaximizeCheck = true;
                this._timeoutRegistry.addIdle(() => {
                    pendingMaximizeCheck = false;
                    if (!win.get_compositor_private()) return GLib.SOURCE_REMOVE;

                    if (this.windowingManager.isMaximizedOrFullscreen(win)) {
                        Logger.log(`Window ${win.get_id()} entered a sacred state (Maximized) - checking for isolation`);
                        const workspace = win.get_workspace();

                        if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
                            Logger.log(`Workspace has mosaic disabled - skipping isolation for maximized window ${win.get_id()}`);
                        } else {
                            const monitor = win.get_monitor();
                            const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

                            if (workspaceWindows.length > 1) {
                                Logger.log(`Window ${win.get_id()} maximized in occupied workspace - isolating (SACRED)`);
                                WindowState.set(win, 'sacredOriginWorkspace', workspace.index());
                                this.windowingManager.moveOversizedWindow(win).catch(e =>
                                    Logger.error(`Sacred maximize isolation failed: ${e}`));
                            }
                        }
                    } else {
                        Logger.log(`Window ${win.get_id()} exited a sacred state (Unmaximized) - starting state machine`);
                        this.handleSacredExit(win);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }));
        });

        // Detect Fullscreen changes
        ids.push(window.connect('notify::fullscreen', (win) => {
            if (this.windowingManager.isMaximizedOrFullscreen(win)) {
                 // Entered Fullscreen: Move to new workspace if current is occupied.
                 const workspace = win.get_workspace();
                 if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
                     Logger.log(`Workspace has mosaic disabled - skipping isolation for fullscreen window ${win.get_id()}`);
                 } else {
                     const monitor = win.get_monitor();
                     const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

                     if (workspaceWindows.length > 1) {
                         Logger.log(`Window ${win.get_id()} entered FULLSCREEN in occupied workspace - isolating (SACRED)`);
                         // Save origin for restoration later
                         WindowState.set(win, 'sacredOriginWorkspace', workspace.index());
                         this.windowingManager.moveOversizedWindow(win).catch(e =>
                             Logger.error(`Sacred fullscreen isolation failed: ${e}`));
                     }
                 }
            } else {
                Logger.log(`Window ${win.get_id()} exited fullscreen - starting state machine`);
                this.handleSacredExit(win);
            }
        }));

        // Confirmation of smart resize completion + minimum size learning
        ids.push(window.connect('size-changed', (win) => {
            ComputedLayouts.delete(win);
            if (WindowState.get(win, 'isSmartResizing') || WindowState.get(win, 'isReverseSmartResizing')) {
                // Compare target vs actual frame
                const target = WindowState.get(win, 'targetSmartResizeSize');
                if (target) {
                    const actual = win.get_frame_rect();
                    const hitMinimum = actual.width > target.width || actual.height > target.height;

                    if (hitMinimum) {
                        WindowState.set(win, 'learnedMinSize', {
                            width: actual.width,
                            height: actual.height
                        });
                        Logger.log(`Learned min size for ${win.get_id()}: ${actual.width}x${actual.height} (requested ${target.width}x${target.height})`);

                        // Overflow triggers automatically if resize fails
                        
                        // Clear flags to allow normal tiling
                        WindowState.set(win, 'targetSmartResizeSize', null);
                        WindowState.set(win, 'isSmartResizing', false);
                    } else {
                        // Resize worked — clear target
                        WindowState.set(win, 'targetSmartResizeSize', null);
                    }
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
        ids.push(window.connect('notify::minimized', (win) => this.handleExclusionStateChange(win)));

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
            Logger.log(`Disconnected signals for window ${window.get_id()}`);
        }

        // Clear layout cache
        ComputedLayouts.delete(window);

        // Clean up other states
        WindowState.remove(window, 'previousExclusionState');
        WindowState.remove(window, 'previousWorkspace');
    }

    // State Machine: Defer move until window has finished resizing in place.
    handleSacredExit(window) {
        // Idempotency: skip if already processing this sacred exit
        if (WindowState.get(window, 'isRestoringSacred') !== undefined) {
            Logger.log(`handleSacredExit: Already restoring ${window.get_id()} - skipping duplicate`);
            return;
        }

        this.windowingManager.invalidateWindowsCache();
        const originIndex = WindowState.get(window, 'sacredOriginWorkspace');

        // Always set these flags to prevent giant dimensions during the in-place resize
        const preferredSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
        if (preferredSize) {
            WindowState.set(window, 'targetRestoredSize', { width: preferredSize.width, height: preferredSize.height });
            WindowState.set(window, 'unmaximizing', true);
        }

        if (originIndex !== undefined) {
            Logger.log(`Sacred exit detected for ${window.get_id()}. Flagging for deferred move to WS ${originIndex}.`);
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
            Logger.log(`Window ${windowId} became excluded - retiling without it`);

            const frame = window.get_frame_rect();
            const freedWidth = frame.width;
            const freedHeight = frame.height;

            this._timeoutRegistry.add(100, () => {
                const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== windowId && !this.windowingManager.isExcluded(w));

                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                if (workArea) {
                    this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, workspace, monitor);
                } else {
                    Logger.log('WindowHandler: Skipped restore - invalid workArea');
                }

                this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                return GLib.SOURCE_REMOVE;
            }, 'windowHandler_excludeRetile');
        } else {
            // Window became included - treat like new window arrival with smart resize
            Logger.log(`Window ${windowId} became included - treating as new window arrival`);

            this._timeoutRegistry.add(100, () => {
                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                if (!workArea) {
                    Logger.log('WindowHandler: Skipped include - invalid workArea');
                    return GLib.SOURCE_REMOVE;
                }
                const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== window.get_id() && !this.windowingManager.isExcluded(w));

                // Check if window fits without resize
                if (this.tilingManager.canFitWindow(window, workspace, monitor)) {
                    Logger.log(`Re-included window fits without resize`);
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                    return GLib.SOURCE_REMOVE;
                }

                // Try smart resize (async IIFE)
                (async () => {
                    const resizeSuccess = await this.tilingManager.tryFitWithResize(window, existingWindows, workArea);

                    if (resizeSuccess) {
                        Logger.log('Re-include: Smart resize applied - starting fit check polling');
                        WindowState.set(window, 'isSmartResizing', true);

                        const initialWorkspaceIndex = workspace.index();
                        const MAX_ATTEMPTS = 12;
                        const POLL_INTERVAL = 75;
                        let attempts = 0;

                        const pollForFit = async () => {
                            if (window.get_workspace()?.index() !== initialWorkspaceIndex) {
                                Logger.log(`Re-include: Window moved workspace - aborting poll`);
                                WindowState.set(window, 'isSmartResizing', false);
                                return GLib.SOURCE_REMOVE;
                            }

                            attempts++;
                            const canFitNow = this.tilingManager.canFitWindow(window, workspace, monitor, true);

                            if (canFitNow) {
                                Logger.log(`Re-include: Smart resize success after ${attempts} polls`);
                                WindowState.set(window, 'isSmartResizing', false);
                                WindowState.set(window, 'justReturnedFromExclusion', true);
                                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                                return GLib.SOURCE_REMOVE;
                            }

                            if (attempts >= MAX_ATTEMPTS) {
                                Logger.log('Re-include: Smart resize failed - moving to overflow');
                                WindowState.set(window, 'isSmartResizing', false);
                                this.windowingManager.moveOversizedWindow(window).catch(e =>
                                    Logger.error(`Re-include overflow failed: ${e}`));
                                return GLib.SOURCE_REMOVE;
                            }

                            // Retry resize attempt
                            await this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
                            return GLib.SOURCE_CONTINUE;
                        };

                        this._timeoutRegistry.add(POLL_INTERVAL, () => pollForFit(), 'windowHandler_pollForFit');
                    } else {
                        Logger.log(`Re-include: Smart resize not applicable - moving to overflow`);
                        this.windowingManager.moveOversizedWindow(window).catch(e =>
                            Logger.error(`Re-include overflow failed: ${e}`));
                    }
                })().catch(e => Logger.error(`Re-include async resize failed: ${e}`));

                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Executes when a window is physically destroyed
    onWindowDestroyed(window) {
        const monitor = window.get_monitor();
        const windowId = window.get_id();
        const windowWorkspace = window.get_workspace();

        Logger.log(`onWindowDestroyed: ${windowId}`);

        this.disconnectWindowSignals(window);
        this.edgeTilingManager.clearWindowState(window);

        const debounceId = WindowState.get(window, 'workspaceChangeDebounceId');
        if (debounceId) {
             this._timeoutRegistry.remove(debounceId);
             WindowState.remove(window, 'workspaceChangeDebounceId');
        }

        WindowState.remove(window, 'maximizedUndoInfo');

        if (this.windowingManager.isExcluded(window)) {
            Logger.log('Excluded window closed - no workspace navigation');
            return;
        }

        if (windowWorkspace) {
            const workspace = windowWorkspace;

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
                    Logger.log('Workspace is empty but overflow in progress - skipping navigation');
                    return;
                }

                this.windowingManager.renavigate(workspace, true, this._ext._lastVisitedWorkspace, monitor);
            }
        }
    }

    onOverviewHidden() {
        const workspace = this.windowingManager.getWorkspace();

        for (const win of workspace.list_windows()) {
            if (WindowState.get(win, 'deferTilingUntilOverviewHidden')) {
                Logger.log(`Overview hidden: Tiling deferred window ${win.get_id()}`);
                WindowState.remove(win, 'deferTilingUntilOverviewHidden');
                this.enqueueWindowForEvaluation(win, workspace, win.get_monitor());
            }
        }
    }

    // Ensures a new window fits via smart resize, queued to handle rapid spawns.
    enqueueWindowForEvaluation(window, workspace, monitor) {
        Logger.log(`Enqueueing window ${window.get_id()} for evaluation`);
        this._evaluationQueue.push({ window, workspace, monitor });
        if (!this._isEvaluatingQueue) {
            this._processEvaluationQueue().catch(e => {
                Logger.error(`Evaluation queue failed: ${e}\n${e.stack}`);
                this._isEvaluatingQueue = false;
            });
        }
    }

    async _processEvaluationQueue() {
        if (this._isEvaluatingQueue || this._evaluationQueue.length === 0) {
            return;
        }

        this._isEvaluatingQueue = true;
        let lastOverflowWorkspace = null;
        // Track the expected workspace so we can detect manual user switches
        let expectedWorkspace = null;
        // Track workspaces that already overflowed to prevent infinite cascade loops.
        const overflowedWorkspaces = new Set();

        while (this._evaluationQueue.length > 0) {
            let { window, workspace, monitor } = this._evaluationQueue.shift();

            if (!window || !window.get_compositor_private()) {
                Logger.log('Evaluation queue: window destroyed before evaluation, skipping');
                continue;
            }

            // Skip windows that were already successfully placed by smart resize
            if (WindowState.get(window, 'smartResizeApplied')) {
                Logger.log(`Evaluation queue: window ${window.get_id()} already placed by smart resize, skipping`);
                WindowState.set(window, 'smartResizeApplied', false);
                continue;
            }

            // Guard against invalid workspace (can occur if workspace was removed during async smart resize)
            if (workspace.index() < 0) {
                const currentWorkspace = window.get_workspace();
                if (currentWorkspace && currentWorkspace.index() >= 0) {
                    Logger.log(`Evaluation queue: stale workspace (index -1), using window's current WS-${currentWorkspace.index()}`);
                    workspace = currentWorkspace;
                } else {
                    Logger.log(`Evaluation queue: window ${window.get_id()} has invalid workspace, skipping`);
                    continue;
                }
            }

            // Use the active workspace as the source of truth to detect manual user switches.
            const activeWorkspace = this.windowingManager.getWorkspace();
            const targetWorkspace = lastOverflowWorkspace || expectedWorkspace || workspace;

            if (activeWorkspace && targetWorkspace && activeWorkspace.index() !== targetWorkspace.index()) {
                Logger.log(`Evaluation queue: User switched to WS-${activeWorkspace.index()} during processing (expected WS-${targetWorkspace.index()}) - following user`);
                workspace = activeWorkspace;
                lastOverflowWorkspace = null; // Reset overflow cascade — user intent takes priority
                overflowedWorkspaces.clear();
                window.change_workspace(workspace);
            } else if (lastOverflowWorkspace && lastOverflowWorkspace !== workspace) {
                // Check if the overflow destination already failed — stop cascading to prevent loops
                if (overflowedWorkspaces.has(lastOverflowWorkspace.index())) {
                    Logger.log(`Evaluation queue: overflow destination WS-${lastOverflowWorkspace.index()} already failed - stopping cascade, window ${window.get_id()} stays on WS-${workspace.index()}`);
                    lastOverflowWorkspace = null;
                } else {
                    // Cascade target workspace if a previous window in this batch caused an overflow
                    Logger.log(`Evaluation queue: cascading window ${window.get_id()} to overflow destination WS-${lastOverflowWorkspace.index()}`);
                    workspace = lastOverflowWorkspace;
                    
                    if (window.get_workspace() !== workspace) {
                        WindowState.set(window, 'movedByOverflow', true);
                        window.change_workspace(workspace);
                    }
                }
            }

            // Track the expected workspace for the next iteration
            expectedWorkspace = workspace;

            Logger.log(`Evaluating queued window ${window.get_id()} on WS-${workspace.index()} (remaining: ${this._evaluationQueue.length})`);
            try {
                const resultWorkspace = await this._ensureWindowFits(window, workspace, monitor);
                if (resultWorkspace && resultWorkspace.index() !== workspace.index()) {
                    overflowedWorkspaces.add(workspace.index());
                    lastOverflowWorkspace = resultWorkspace;
                    expectedWorkspace = resultWorkspace;
                }

                const managedWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => !this.windowingManager.isExcluded(w));

                if (managedWindows.length === 0) {
                    // Only renavigate if the workspace is truly empty and not just being transitioned during overflow
                    const isEjectedByOverflow = lastOverflowWorkspace && lastOverflowWorkspace.index() !== workspace.index();
                    
                    if (!isEjectedByOverflow) {
                        Logger.log(`Queue: Window ${window.get_id()} moved and left WS-${workspace.index()} empty - renavigating`);
                        this.windowingManager.renavigate(workspace, true, this._ext._lastVisitedWorkspace, monitor);
                    } else {
                        Logger.log(`Queue: WS-${workspace.index()} empty due to overflow - skipping renavigate to stay on WS-${lastOverflowWorkspace.index()}`);
                    }
                }
            } catch (e) {
                Logger.error(`Error in evaluation queue for window ${window.get_id()}: ${e}`);
            }

            // Small delay to let animations/mutter settle before evaluating the next window
            await new Promise(resolve => {
                if (this._timeoutRegistry) {
                    this._timeoutRegistry.add(constants.QUEUE_PROCESS_DELAY_MS || 50, resolve, '_processEvaluationQueue');
                } else {
                    resolve();
                }
            });
        }

        this._isEvaluatingQueue = false;
    }

    // Returns the final workspace the window landed in, useful for tracking overflow destinations
    async _ensureWindowFits(window, workspace, monitor) {
        if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log('ensureWindowFits: Skipping - mosaic disabled for workspace');
            return workspace;
        }

        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log('ensureWindowFits: Skipping - smart resize in progress');
            return workspace;
        }

        // Path 1: Sacred Isolation - Symmetric isolation enforcement.
        const isIncomingSacred = this.windowingManager.isMaximizedOrFullscreen(window);
        const hasExistingSacred = this.windowingManager.hasSacredWindow(workspace, monitor, window.get_id());
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        const otherWindows = workspaceWindows.filter(w => w.get_id() !== window.get_id());

        if (hasExistingSacred || (isIncomingSacred && otherWindows.length > 0)) {
            Logger.log(`Sacred Isolation triggered (IncomingSacred: ${isIncomingSacred}, HasExistingSacred: ${hasExistingSacred}) - isolating`);
            return await this.windowingManager.moveOversizedWindow(window);
        }

        // Save preferred size AFTER sacred checks — prevents capturing monitor-sized dimensions
        this.tilingManager.savePreferredSize(window);

        // Path 2: DnD Arrival Handling (Expansion)
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
                Logger.log(`DnD Solo: Fully restoring window to ${targetW}x${targetH}`);
                win.move_resize_frame(true, currentRect.x, currentRect.y, targetW, targetH);
            } else {
                const usedWidth = monitorWindows.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
                const wa = workspace.get_work_area_for_monitor(monitor);
                const availableExtra = wa.width - usedWidth - (monitorWindows.length + 1) * constants.WINDOW_SPACING;
                if (availableExtra > constants.ANIMATION_DIFF_THRESHOLD) {
                    Logger.log(`DnD arrival: Extra space ${availableExtra}px - trying expansion`);
                    this.tilingManager.tryRestoreWindowSizes(monitorWindows, wa, availableExtra, wa.height, workspace, monitor);
                }
            }
        }

        // Path 3: Fitting & Smart Resize
        // Use TARGET size for restoration flows to avoid transient overflow ejection.
        const targetSize = WindowState.get(window, 'targetRestoredSize');
        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor, targetSize);

        if (canFit) {
            this.tilingManager.enqueueWindowOpen(window.get_id(), () => {
                Logger.log('Window fits - adding to tiling via queue');
                this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            });
            return workspace;
        }

        // Path 4: Smart Resize attempt
        let workArea = workspace.get_work_area_for_monitor(monitor);
        if (this.edgeTilingManager) {
            const edgeTiledWindows = this.edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            if (edgeTiledWindows.length > 0) {
                workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            }
        }

        const allExistingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => w.get_id() !== window.get_id() && !this.edgeTilingManager.isEdgeTiled(w));

        const existingWindows = allExistingWindows.filter(w => !this.windowingManager.isMaximizedOrFullscreen(w));

        if (existingWindows.length > 0) {
            const resizeSuccess = await this.tilingManager.tryFitWithResize(window, existingWindows, workArea);
            if (resizeSuccess) {
                Logger.log('Smart resize applied - tiling with reference');
                WindowState.set(window, 'smartResizeApplied', true);
                this.tilingManager.enqueueWindowOpen(window.get_id(), () => {
                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                });
                return workspace;
            }
        }

        // Path 5: Overflow (Final fallback)
        Logger.log('Smart resize failed or skipped - applying Overflow logic');
        return await this.windowingManager.moveOversizedWindow(window);
    }
    onWindowCreated(window) {
        this.windowingManager.invalidateWindowsCache();
        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            WindowState.set(window, 'openedMaximized', true);
            Logger.log(`Window ${window.get_id()} opened maximized - marked for auto-tile check`);
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
                    Logger.log('Window excluded from tiling');
                    return GLib.SOURCE_REMOVE;
                }

                // Use saved_rect for natural size (get_frame_rect matches monitor if Maximized).
                if (this.windowingManager.isMaximizedOrFullscreen(window)) {
                    try {
                         const saved = window.saved_rect || (window.get_saved_rect ? window.get_saved_rect() : null);
                         if (saved && saved.width > 0 && saved.height > 0) {
                             WindowState.set(window, 'openingSize', { width: saved.width, height: saved.height });
                             Logger.log(`onWindowCreated: Captured openingSize fallback from saved_rect: ${saved.width}x${saved.height}`);
                         } else {
                             // Fallback for natively fullscreen apps with no saved_rect:
                             // Use 80% of work area as a reasonable default window size
                             const workArea = workspace.get_work_area_for_monitor(monitor);
                             if (workArea) {
                                 const fallbackWidth = Math.floor(workArea.width * 0.8);
                                 const fallbackHeight = Math.floor(workArea.height * 0.8);
                                 WindowState.set(window, 'openingSize', { width: fallbackWidth, height: fallbackHeight });
                                 Logger.log(`onWindowCreated: No saved_rect for fullscreen window - using 80% fallback: ${fallbackWidth}x${fallbackHeight}`);
                             }
                         }
                    } catch (e) {
                         Logger.warn(`onWindowCreated: Failed to capture saved_rect: ${e.message}`);
                    }
                } else {
                    // ONLY save preferred size if the window is NOT maximized/fullscreen upon creation.
                    // This prevents capturing "almost-maximized" frames during the opening animation.
                    this.tilingManager.savePreferredSize(window);
                }

                if(this.windowingManager.isMaximizedOrFullscreen(window)) {
                    if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
                        Logger.log('Sacred window in disabled mosaic workspace - skipping isolation');
                        return GLib.SOURCE_REMOVE;
                    }

                    this.windowingManager.invalidateWindowsCache();
                    const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
                    const otherWindows = workspaceWindows.filter(w => w.get_id() !== window.get_id());

                    if(otherWindows.length > 0) {
                        Logger.log('Opened sacred (Max/Full) in occupied workspace - isolating (SACRED)');
                        // Save origin for restoration later
                        WindowState.set(window, 'sacredOriginWorkspace', workspace.index());
                        this.windowingManager.moveOversizedWindow(window).catch(e =>
                            Logger.error(`Sacred open isolation failed: ${e}`));
                        return GLib.SOURCE_REMOVE;
                    } else {
                        Logger.log('Sacred window in empty workspace - keeping here');
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
                    Logger.log(`New window: Attempting to tile with edge-tiled window`);
                    const tileSuccess = this.windowingManager.tryTileWithSnappedWindow(window, edgeTiledWindows[0], null);

                    if (tileSuccess) {
                        Logger.log('New window: Successfully tiled with edge-tiled window');
                        this.connectWindowSignals(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    Logger.log('New window: Tiling failed, continuing with normal flow');
                }

                // Enqueue window for async sequential fit evaluation
                this.enqueueWindowForEvaluation(window, workspace, monitor);

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
                if (timeoutId) this._timeoutRegistry.remove(timeoutId);

                if (processWindowCallback() === GLib.SOURCE_CONTINUE) {
                    // One small safety polling if initial callback failed (rare)
                    this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, processWindowCallback, 'windowHandler_safetyPoll');
                }

                // Now that window is processed, connect standard signals
                this.connectWindowSignals(window);
            };

            // USE MAPPED SIGNAL: Triggers when the window is added to the scene but before paint.
            // This allows us to position it "before" it appears, effectively skipping the spawn animation.
            if (actor.mapped) {
                processOnce();
            } else {
                signalId = actor.connect('notify::mapped', () => {
                    if (actor.mapped) processOnce();
                });
            }

            // Safety timeout
            timeoutId = this._timeoutRegistry.add(400, () => {
                // Pre-flight check: If the actor was disposed while waiting, abort safely.
                if (!window.get_compositor_private()) {
                    Logger.log('window map timeout - window already disposed, aborting process');
                    return GLib.SOURCE_REMOVE;
                }

                Logger.log('window map timeout - falling back to immediate processing');
                processOnce();
                return GLib.SOURCE_REMOVE;
            }, 'windowHandler_mapSafety');
        } else {
            // Fallback for non-actor windows (rare in Shell)
            this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
                 // Abort if window is gone (destroyed or unmanaged)
                 if (!window.get_compositor_private() || !window.get_workspace()) {
                     Logger.log(`onWindowCreated fallback: window gone - aborting`);
                     return GLib.SOURCE_REMOVE;
                 }
                 if (processWindowCallback() === GLib.SOURCE_REMOVE) {
                     this.connectWindowSignals(window);
                     return GLib.SOURCE_REMOVE;
                 }
                 return GLib.SOURCE_CONTINUE;
            }, 'windowHandler_fallbackCreated');
        }
    }

    onWindowAdded(workspace, window) {
        this.windowingManager.invalidateWindowsCache();
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }

        // Capture natural size immediately upon arrival to a workspace
        this._ext.tilingManager.savePreferredSize(window);

        // Only abort smart resize for cross-workspace arrivals; same-workspace waits to be queued sequentially.
        if (this._ext.tilingManager._activeSmartResize) {
            const resizeWorkspace = this._ext.tilingManager._activeSmartResizeWorkspace;
            if (!resizeWorkspace || resizeWorkspace.index() !== workspace.index()) {
                Logger.log(`onWindowAdded: Aborting smart resize - new window on different workspace`);
                this._ext.tilingManager.abortActiveSmartResize();
            } else {
                Logger.log(`onWindowAdded: Smart resize active on same workspace - will queue after completion`);
            }
        }

        // Mark window as newly added for overflow protection logic
        WindowState.set(window, 'addedTime', Date.now());

        this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            // Abort if window is gone (destroyed or unmanaged)
            if (!window.get_compositor_private() || !window.get_workspace()) {
                Logger.log(`window-added: window ${window.get_id()} gone - aborting`);
                return GLib.SOURCE_REMOVE;
            }

            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = WINDOW.get_monitor();

            if (this._ext.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {

                const frame = WINDOW.get_frame_rect();
                const hasValidDimensions = frame.width > 0 && frame.height > 0;

                if (hasValidDimensions) {
                    // we use this lock for prevent the window to get stuck in the middle
                    const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
                    const removedTimestamp = WindowState.get(WINDOW, 'removedTimestamp');
                    const timeSinceRemoved = removedTimestamp ? Date.now() - removedTimestamp : Infinity;

                    const workArea = WORKSPACE.get_work_area_for_monitor(MONITOR);

                    if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index() && timeSinceRemoved < constants.SAFETY_TIMEOUT_BUFFER_MS) {
                        // Skip if this is an overflow move, not a real drag-drop
                        if (!WindowState.get(WINDOW, 'movedByOverflow')) {
                            // ACTIVATE destination workspace and EXIT Overview
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

                    this._timeoutRegistry.add(constants.GEOMETRY_CHECK_DELAY_MS, () => {
                        this.waitForGeometry(WINDOW, WORKSPACE, MONITOR);
                        return GLib.SOURCE_REMOVE;
                    }, 'windowHandler_geometryCheck');

                    return GLib.SOURCE_REMOVE;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    onWindowRemoved(workspace, window) {
        this.windowingManager.invalidateWindowsCache();
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }

        // Abort any ongoing smart resize immediately to prevent 'zombie' logic
        this._ext.tilingManager.abortActiveSmartResize();

        WindowState.set(window, 'previousWorkspace', workspace.index());
        WindowState.set(window, 'removedTimestamp', Date.now());

        // SKIP if window was moved by overflow
        const wasMovedByOverflow = WindowState.get(window, 'movedByOverflow');

        // Capture removed window's size BEFORE any operations
        const removedFrame = window.get_frame_rect();
        const freedWidth = removedFrame.width;
        const freedHeight = removedFrame.height;

        // Capture monitor at event time (window may move monitors during DnD)
        const removedMonitor = window.get_monitor();

        const actor = window.get_compositor_private();
        if (!actor) {
            this._ext.tilingManager.clearPreferredSize(window);
        } else {
            Logger.log(`_windowRemoved: Window still exists (DnD move) - keeping preferred size`);
        }

        this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = workspace;
            const MONITOR = removedMonitor;

            // Check if workspace still exists and has windows
            if (!WORKSPACE || WORKSPACE.index() < 0) {
                return GLib.SOURCE_REMOVE;
            }

            const removedId = window.get_id();
            const remainingWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                .filter(w => w.get_id() !== removedId &&
                             !this._ext.edgeTilingManager.isEdgeTiled(w) &&
                             !this._ext.windowingManager.isExcluded(w));

            Logger.log(`_windowRemoved: ${remainingWindows.length} remaining windows, freed ${freedWidth}x${freedHeight}, wasOverflowMove=${wasMovedByOverflow}`);

            // FASE 5: Cleanup transient Smart Resize flags
            Logger.log(`[SMART RESIZE] Cleaning up transient flags for remaining windows`);
            for (const w of remainingWindows) {
                // Ensure all windows are released from smart-resize state before we try to restore them
                WindowState.set(w, 'isSmartResizing', false);
                WindowState.set(w, 'hitMinimumSize', false);
                // Preserve preferredSize for restoration
            }

            // Try to restore window sizes with freed space (Reverse Smart Resize)
            if (remainingWindows.length > 0) {
                if (freedWidth > 0 && freedHeight > 0) {
                    const workArea = this._ext.tilingManager.getUsableWorkArea(WORKSPACE, MONITOR);
                    // PASS null to force recalculation of real incremental available space
                    const restored = this._ext.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, null, null, WORKSPACE, MONITOR);

                    if (restored) {
                        this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                            Logger.log('Retiling after restore delay');
                            // Ensure flags are cleared after settlement
                            for (const w of remainingWindows) {
                                 WindowState.remove(w, 'isReverseSmartResizing');
                            }
                            this._ext.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                            return GLib.SOURCE_REMOVE;
                        }, 'windowHandler_restoreSettle');
                    } else {
                        this._ext.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                    }
                } else {
                    // Skip restore, just retile
                    this._ext.tilingManager.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
                }
            } else {
                // Workspace is now empty of mosaic windows
                const allRelatedWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                    .filter(w => w.get_id() !== removedId);
                if (allRelatedWindows.length === 0) {
                    if (WORKSPACE.index() < 0) {
                        Logger.log('_windowRemoved: Workspace already destroyed, skipping navigation');
                        return GLib.SOURCE_REMOVE;
                    }
                    if (wasMovedByOverflow) {
                        Logger.log('_windowRemoved: Workspace empty but window was moved by overflow - skipping navigation');
                    } else {
                        Logger.log('_windowRemoved: Workspace truly empty, navigating away');
                        this._ext.windowingManager.renavigate(WORKSPACE, global.workspace_manager.get_active_workspace() === WORKSPACE, this._ext._lastVisitedWorkspace, MONITOR);
                    }

                    // Cleanup flag (if any)
                    WindowState.remove(window, 'isRestoringSacred');
                }
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    onWindowWorkspaceChanged(window) {
        Logger.log(`workspace-changed fired for window ${window.get_id()}`);
        const windowId = window.get_id();

        const existingDebounceId = WindowState.get(window, 'workspaceChangeDebounceId');
        if (existingDebounceId) {
            Logger.log('Clearing previous debounce timeout');
            this._timeoutRegistry.remove(existingDebounceId);
            WindowState.remove(window, 'workspaceChangeDebounceId');
        }

        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            Logger.log('Skipping overflow check for maximized window');
            return;
        }

        if (WindowState.get(window, 'unmaximizing')) {
            Logger.log(`Skipping overflow check for window ${windowId} - currently unmaximizing (undo)`);
            return;
        }

        const timeoutId = this._timeoutRegistry.add(constants.DEBOUNCE_DELAY_MS, () => {
            WindowState.remove(window, 'workspaceChangeDebounceId');

            // Guard: Skip if window was recently moved due to overflow (prevents infinite loop)
            const lastOverflowMove = WindowState.get(window, 'overflowMoveTimestamp');
            if (lastOverflowMove && (Date.now() - lastOverflowMove) < constants.OVERFLOW_MOVE_DEBOUNCE_MS) {
                Logger.log(`Skipping overflow check - window ${windowId} was recently moved for overflow`);
                return GLib.SOURCE_REMOVE;
            }

            const currentWorkspace = window.get_workspace();
            if (!currentWorkspace) {
                Logger.log(`Debounce: window ${windowId} has no workspace, skipping`);
                return GLib.SOURCE_REMOVE;
            }
            const currentWorkspaceIndex = currentWorkspace.index();

            Logger.log(`Debounce complete - checking overflow for window ${windowId} in workspace ${currentWorkspaceIndex}`);

            const monitor = window.get_monitor();

            const previousWorkspaceIndex = WindowState.get(window, 'previousWorkspace');

            if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== currentWorkspaceIndex) {
                const sourceWorkspace = global.workspace_manager.get_workspace_by_index(previousWorkspaceIndex);
                if (sourceWorkspace) {
                    Logger.log(`Re-tiling source workspace ${previousWorkspaceIndex} after window ${windowId} moved to ${currentWorkspaceIndex}`);

                    afterWorkspaceSwitch(() => {
                        afterAnimations(this.animationsManager, () => {
                                if (!WindowState.get(window, 'movedByOverflow')) {
                                    Logger.log('Source Workspace Departure: Attempting Reverse Smart Resize on source workspace');
                                    const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(sourceWorkspace, monitor);
                                    const workArea = this.edgeTilingManager.calculateRemainingSpace(sourceWorkspace, monitor);
                                    if (workArea) {
                                        // Pass undefined for freed dimensions to trigger the new auto-calculation in tiling.js
                                        this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, undefined, undefined, sourceWorkspace, monitor);
                                    } else {
                                        Logger.log('WindowHandler: Skipped restore - invalid workArea');
                                    }
                                }
                            this.tilingManager.tileWorkspaceWindows(sourceWorkspace, false, monitor, false);
                        }, this._timeoutRegistry);
                    }, this._timeoutRegistry);
                }
            }

            WindowState.set(window, 'previousWorkspace', currentWorkspaceIndex);

            if (this._ext && !this._ext.isMosaicEnabledForWorkspace(currentWorkspace)) {
                Logger.log(`Manual move to disabled mosaic workspace - skipping fit/overflow checks`);
                this.tilingManager.tileWorkspaceWindows(currentWorkspace, null, monitor, true);
                return GLib.SOURCE_REMOVE;
            }

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
                    Logger.log('Manual move: Attempting to tile with edge-tiled window');
                    const success = this.windowingManager.tryTileWithSnappedWindow(window, edgeTiledWindow, null);
                    if (success) {
                        Logger.log('Manual move: Successfully tiled with edge-tiled window');
                        return GLib.SOURCE_REMOVE;
                    }
                }
            }

            const canFit = this.tilingManager.canFitWindow(window, currentWorkspace, monitor);

            // Sacred Protection: Expel if destination has sacred windows.
            const hasSacredInDest = this.windowingManager.hasSacredWindow(currentWorkspace, monitor, windowId);
            if (hasSacredInDest) {
                Logger.log(`Manual move BLOCKED: Destination workspace has sacred window - moving to overflow`);
                WindowState.set(window, 'overflowMoveTimestamp', Date.now());
                this.windowingManager.moveOversizedWindow(window).catch(e =>
                    Logger.error(`Sacred protection overflow failed: ${e}`));
                return GLib.SOURCE_REMOVE;
            }

            if (!canFit) {
                // SMART RESIZE FOR DnD: Try shrinking existing windows before overflow
                Logger.log(`Manual move: window doesn't fit - trying Smart Resize first`);

                const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(currentWorkspace, monitor)
                    .filter(w =>
                        w.get_id() !== windowId &&
                        !this.edgeTilingManager.isEdgeTiled(w) &&
                        !this.windowingManager.isMaximizedOrFullscreen(w)
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
                        Logger.log('DnD arrival: Smart Resize succeeded - starting fit check polling');
                        afterWorkspaceSwitch(() => {
                            afterAnimations(this.animationsManager, () => {
                                WindowState.set(window, 'isSmartResizing', true);
                                this._waitForFit(window, currentWorkspace, monitor, existingWindows, workArea);
                            }, this._timeoutRegistry);
                        }, this._timeoutRegistry);
                    } else {
                        Logger.log('DnD arrival: Smart Resize failed - checking if we should expel');

                        let hasEdgeTiles = false;
                        if (this.edgeTilingManager) {
                             const et = this.edgeTilingManager.getEdgeTiledWindows(currentWorkspace, monitor);
                             hasEdgeTiles = et && et.length > 0;
                        }

                        if (hasEdgeTiles) {
                            Logger.log('DnD arrival: Edge tiling detected - moving to new workspace (TRACE: OVERFLOW)');
                            WindowState.set(window, 'overflowMoveTimestamp', Date.now());
                            this.windowingManager.moveOversizedWindow(window).catch(e =>
                                Logger.error(`DnD edge-tile overflow failed: ${e}`));
                        } else {
                            Logger.log('DnD arrival: Pure Mosaic mode - forcing tile');
                            afterWorkspaceSwitch(() => {
                                afterAnimations(this.animationsManager, () => {
                                    this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, false);
                                }, this._timeoutRegistry);
                            }, this._timeoutRegistry);
                        }
                    }
                })().catch(e => Logger.error(`DnD async resize failed: ${e}`));
            } else {
                Logger.log('Manual move: window fits - tiling workspace');
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
                Logger.log(`waitForGeometry: Window is excluded - connecting signals but skipping tiling`);
                this.connectWindowSignals(WINDOW);
                return GLib.SOURCE_REMOVE;
            }

            const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
            Logger.log(`Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`);

            if (WindowState.get(WINDOW, 'movedByOverflow')) {
                Logger.log(`Skipping early tile in waitForGeometry - window was moved by overflow (Flags cleared to prevent leakage)`);
                WindowState.remove(WINDOW, 'movedByOverflow');
                return GLib.SOURCE_REMOVE;
            }

            if (Main.overview.visible) {
                Logger.log(`Window created while overview visible - deferring evaluation until overview hidden`);
                WindowState.set(WINDOW, 'createdDuringOverview', true);
                WindowState.set(WINDOW, 'deferTilingUntilOverviewHidden', true);
                this._ext.tilingManager.savePreferredSize(WINDOW);
                this.connectWindowSignals(WINDOW);
                this._ext.tilingManager.calculateLayoutsOnly();

                this._timeoutRegistry.addIdle(() => {
                    try {
                        if (Main.overview.visible) {
                            const overview = Main.overview._overview;
                            if (overview && overview._controls && overview._controls._thumbnailsBox) {
                                overview._controls._thumbnailsBox.queue_relayout();
                            }
                        }
                    } catch (e) {}
                    return GLib.SOURCE_REMOVE;
                }, 'windowHandler_overviewRelayout', GLib.PRIORITY_DEFAULT_IDLE);
                return GLib.SOURCE_REMOVE;
            }

            const performTiling = async () => {
                if (WindowState.get(WINDOW, 'movedByOverflow')) {
                     Logger.log(`Skipping duplicate evaluation queueing - window was already evaluated and moved by overflow`);
                     return;
                }
                this.enqueueWindowForEvaluation(WINDOW, WORKSPACE, MONITOR);
            };

            const isDnDArrival = WindowState.get(WINDOW, 'arrivedFromDnD');
            const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');

            if (isDnDArrival || WindowState.get(WINDOW, 'movedByOverflow') || (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index())) {
                Logger.log(`Cross-workspace move: Waiting for workspace animation`);
                afterWorkspaceSwitch(performTiling, this._ext._timeoutRegistry);
            } else {
                performTiling();
            }

            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                if (WindowState.get(WINDOW, 'movedByOverflow')) {
                    Logger.log('Skipping final overflow check - window already moved');
                    return GLib.SOURCE_REMOVE;
                }

                if (WindowState.get(WINDOW, 'isSmartResizing') || WindowState.get(WINDOW, 'isReverseSmartResizing')) {
                    Logger.log('Skipping final overflow check - smart resize in progress');
                    return GLib.SOURCE_REMOVE;
                }

                if (WindowState.get(WINDOW, 'smartResizeApplied')) {
                    Logger.log('Skipping final overflow check - window successfully smart resized');
                    // We can clear the transient flag now
                    WindowState.remove(WINDOW, 'smartResizeApplied');
                    return GLib.SOURCE_REMOVE;
                }

                if (WindowState.get(WINDOW, 'unmaximizing')) {
                    Logger.log('Skipping final overflow check - window is unmaximizing (undo)');
                    return GLib.SOURCE_REMOVE;
                }

                // Don't trigger overflow decisions while smart resize is in progress
                if (this._ext.tilingManager._isSmartResizingBlocked) {
                    Logger.log('Skipping overflow check - smart resize in progress');
                    return GLib.SOURCE_CONTINUE;
                }

                const canFitFinal = this._ext.tilingManager.canFitWindow(WINDOW, WORKSPACE, MONITOR, true);
                const mosaicWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                          .filter(w => !this._ext.edgeTilingManager.isEdgeTiled(w));
                const isSolo = mosaicWindows.length <= 1;

                if (!canFitFinal) {
                    if (isSolo) {
                        Logger.log('Overflow detected but window is solo - suppressing move (failsafe)');
                    } else {
                        Logger.log('Still overflow after protection - triggering manual move');
                        this._ext.windowingManager.moveOversizedWindow(WINDOW).catch(e =>
                            Logger.error(`Post-protection overflow failed: ${e}`));
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
                this._timeoutRegistry.remove(timeoutId);
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
                Logger.log(`waitForFit: Window ${windowId} moved or destroyed - aborting`);
                WindowState.set(window, 'isSmartResizing', false);
                WindowState.set(window, 'targetSmartResizeSize', null);
                cleanup();
                return;
            }

            // Check fit with relaxed path
            const canFitNow = this.tilingManager.canFitWindow(window, workspace, monitor, true);

            if (canFitNow) {
                Logger.log(`waitForFit: Window ${windowId} fits via geometry signal - triggering tile`);

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
            Logger.log(`waitForFit: No resized windows found - triggering immediate check`);
            checkFit();
            if (!processed) {
                // Last ditch effort: try tiling anyway
                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                cleanup();
            }
            return;
        }

        Logger.log(`waitForFit: Connecting to ${resizableWindows.length} resized windows for geometry signals`);

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
        timeoutId = this._timeoutRegistry.add(800, () => {
            if (!processed) {
                Logger.log(`waitForFit: Signal timeout - forcing final check`);
                checkFit();
                if (!processed) {
                    // Force overflow if it really doesn't fit
                    Logger.log(`waitForFit: Still doesn't fit - moving to overflow`);
                    this.windowingManager.moveOversizedWindow(window).catch(e =>
                        Logger.error(`waitForFit overflow failed: ${e}`));
                    cleanup();
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }
});
