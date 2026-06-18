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
import { IS_MINIATURE } from './windowState.js';
import { ComputedLayouts } from './tiling.js';
import { isWindowAlive } from './liveness.js';
import { afterWorkspaceSwitch, afterAnimations, afterWindowClose } from './timing.js';

export const WindowHandler = GObject.registerClass({
    GTypeName: 'MosaicWindowHandler',
}, class WindowHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;
        this._workspaceLocks = new WeakMap();

        this._evaluationQueue = [];
        this._isEvaluatingQueue = false;

        this._overflowInProgress = false;
        this._windowSignals = new WeakMap(); // WeakMap so signal IDs are released when the window is GC'd
        this._origShouldAnimateActor = null; 
    }

    patchMapWindow() {
        if (this._origShouldAnimateActor) return; // Already patched

        Logger.log('Patching Main.wm._shouldAnimateActor for slide-in animations');
        this._origShouldAnimateActor = Main.wm._shouldAnimateActor;
        
        const self = this;
        Main.wm._shouldAnimateActor = function(actor, types) {
            const win = actor.meta_window;
            const stack = (new Error()).stack;
            const isMapCall = win && stack.includes('_mapWindow@');

            if (isMapCall) {
                const isRelated = self._ext && self._ext.windowingManager.isRelated(win);
                const skipSlideIn = WindowState.get(win, 'movedByOverflow') || (self._ext && self._ext._overflowInProgress);

                if (isRelated && !skipSlideIn) {
                    // Reimplements the original's gates minus actor.get_texture(): Mutter
                    // can emit 'map' before the window's first frame is committed to the
                    // compositor, which fails that check and silently skips the open
                    // animation - natively-installed apps race this far more often than
                    // Flatpak ones, whose sandbox/portal startup latency gives the
                    // compositor time to receive the first frame first. Skipping the check
                    // is safe: Clutter can ease opacity/scale/translation before a texture
                    // exists, it simply appears mid-transition once ready.
                    if (this._skippedActors.delete(actor)) return false;
                    if (!this._shouldAnimate()) return false;
                    if (!types.includes(this._getAnimationWindowType(actor))) return false;

                    const { offsetX, offsetY, animationMode } = self._evaluateSlideIn(win);

                    if (offsetX !== 0 || offsetY !== 0) {
                        Logger.log(`MAPPED SLIDE-IN (ease intercepted): Applying offset (${offsetX}, ${offsetY}) to window ${win.get_id()} Mode: ${animationMode}`);
                        self._applySlideInAnimation(actor, offsetX, offsetY, animationMode);
                    }

                    return true;
                }
            }

            return self._origShouldAnimateActor.call(this, actor, types);
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
        for (const entry of this._evaluationQueue)
            WindowState.remove(entry.window, 'pendingInQueue');
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
                } catch (_e) {}
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
        let restored = false;

        const restoreEase = () => {
            if (restored) return;
            restored = true;
            actor.ease = origEase;
        };

        actor.ease = function(props) {
            const callStack = (new Error()).stack;
            if (callStack.includes('_mapWindow@')) {
                // Restore ease immediately
                restoreEase();

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
                    duration: constants.SLIDE_IN_DURATION_MS,
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

        // Failsafe: if _mapWindow never animates this actor (animation cancelled,
        // different code path), don't leave actor.ease patched forever.
        this._timeoutRegistry.add(constants.SLIDE_IN_FAILSAFE_MS, () => {
            restoreEase();
            WindowState.remove(win, 'slideInAnimating');
            return GLib.SOURCE_REMOVE;
        }, 'windowHandler_easeRestoreFailsafe');
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

    // Check if the evaluation queue is currently processing windows.
    get isEvaluatingQueue() {
        return this._isEvaluatingQueue;
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
        const ids = [];

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
                    if (!isWindowAlive(win)) return GLib.SOURCE_REMOVE;

                    // Entering/exiting sacred state is owned by resizeHandler, normally
                    // driven by the WM size-change signal. This property notify is a
                    // backup for apps where that signal doesn't fire reliably - calling
                    // these twice for the same transition is safe (see resizeHandler.js).
                    if (this.windowingManager.isMaximizedOrFullscreen(win)) {
                        if (!WindowState.get(win, 'openedMaximized')) {
                            this._ext.resizeHandler.tryEnterSacred(win);
                        }
                    } else if (WindowState.get(win, 'openedMaximized')) {
                        Logger.log(`Window ${win.get_id()} born maximized - skipping sacred exit, treating as normal unmaximize`);
                        WindowState.remove(win, 'openedMaximized');
                        WindowState.remove(win, 'unmaximizing');
                        WindowState.remove(win, 'isEnteringSacred');
                        const ws = win.get_workspace();
                        const mon = win.get_monitor();
                        // Only capture if nothing's recorded yet, so a later manual resize or
                        // Smart Resize decision is never clobbered.
                        if (!WindowState.get(win, 'preferredSize')) {
                            const settled = win.get_frame_rect();
                            const wa = ws && mon !== null ? ws.get_work_area_for_monitor(mon) : null;
                            const isMonitorSized = wa && settled.width >= wa.width && settled.height >= wa.height;
                            // No saved_rect means Mutter's unmaximize leaves the frame at the literal
                            // monitor size, indistinguishable from maximized. Use 95% of the work
                            // area instead so it reads as "nearly full" rather than maximized.
                            const size = isMonitorSized
                                ? { width: Math.floor(wa.width * 0.95), height: Math.floor(wa.height * 0.95) }
                                : { width: settled.width, height: settled.height };
                            WindowState.set(win, 'preferredSize', size);
                            Logger.log(`Captured preferredSize on unmaximize for ${win.get_id()}: ${size.width}x${size.height}${isMonitorSized ? ' (95% fallback, no real shrink)' : ''}`);
                        }
                        if (ws) this.tilingManager.tileWorkspaceWindows(ws, win, mon);
                    } else {
                        this._ext.resizeHandler.tryExitSacred(win);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }));
        });

        // Detect Fullscreen changes - same backup pattern as maximize above.
        ids.push(window.connect('notify::fullscreen', (win) => {
            if (this.windowingManager.isMaximizedOrFullscreen(win)) {
                if (!WindowState.get(win, 'openedMaximized')) {
                    this._ext.resizeHandler.tryEnterSacred(win);
                }
            } else if (WindowState.get(win, 'openedMaximized')) {
                Logger.log(`Window ${win.get_id()} born fullscreen - skipping sacred exit, treating as normal`);
                WindowState.remove(win, 'openedMaximized');
                WindowState.remove(win, 'unmaximizing');
                WindowState.remove(win, 'isEnteringSacred');
                const ws = win.get_workspace();
                const mon = win.get_monitor();
                if (!WindowState.get(win, 'preferredSize')) {
                    const settled = win.get_frame_rect();
                    const wa = ws && mon !== null ? ws.get_work_area_for_monitor(mon) : null;
                    const isMonitorSized = wa && settled.width >= wa.width && settled.height >= wa.height;
                    const size = isMonitorSized
                        ? { width: Math.floor(wa.width * 0.95), height: Math.floor(wa.height * 0.95) }
                        : { width: settled.width, height: settled.height };
                    WindowState.set(win, 'preferredSize', size);
                    Logger.log(`Captured preferredSize on unfullscreen for ${win.get_id()}: ${size.width}x${size.height}${isMonitorSized ? ' (95% fallback, no real shrink)' : ''}`);
                }
                if (ws) this.tilingManager.tileWorkspaceWindows(ws, win, mon);
            } else {
                this._ext.resizeHandler.tryExitSacred(win);
            }
        }));

        // Smart resize completion: clear bridge state and retile
        ids.push(window.connect('size-changed', (win) => {
            ComputedLayouts.delete(win);
            if (WindowState.get(win, 'isSmartResizing') || WindowState.get(win, 'isReverseSmartResizing')) {
                // During queue evaluation, skip all processing so target sizes stay
                // consistent for subsequent canFitWindow/tryFitWithResize calls
                if (this._isEvaluatingQueue) return;
                const target = WindowState.get(win, 'targetSmartResizeSize');
                if (target)
                    WindowState.set(win, 'targetSmartResizeSize', null);
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
        const ids = this._windowSignals.get(window);
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

    // Handle window unmaximize event.
    onWindowUnmaximized(window) {
        const workspace = window.get_workspace();
        if (!workspace) return;

        // Clear the opened-maximized flag now that the window has been unmaximized
        WindowState.remove(window, 'openedMaximized');

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

            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== windowId && !this.windowingManager.isExcluded(w));

                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                let restored = false;
                if (workArea) {
                    restored = this.tilingManager.tryRestoreWindowSizes(remainingWindows, workArea, freedWidth, freedHeight, workspace, monitor);
                } else {
                    Logger.log('WindowHandler: Skipped restore - invalid workArea');
                }

                this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);

                if (restored) {
                    this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                        for (const w of remainingWindows) {
                            WindowState.remove(w, 'isReverseSmartResizing');
                        }
                        return GLib.SOURCE_REMOVE;
                    }, 'windowHandler_excludeRestoreSettle');
                }
                return GLib.SOURCE_REMOVE;
            }, 'windowHandler_excludeRetile');
        } else {
            // Window became included - treat like new window arrival with smart resize
            Logger.log(`Window ${windowId} became included - treating as new window arrival`);

            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                if (!workArea) {
                    Logger.log('WindowHandler: Skipped include - invalid workArea');
                    return GLib.SOURCE_REMOVE;
                }
                const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== window.get_id() && !this.windowingManager.isExcluded(w));

                // Check if window fits without resize
                if (this.tilingManager.canFitWindow(window, workspace, monitor)) {
                    Logger.log('Re-included window fits without resize');
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                    return GLib.SOURCE_REMOVE;
                }

                // Try smart resize (now synchronous). Treat the re-included window
                // as focused, since Mutter's focus_window may still point at the
                // previously focused sibling, which would otherwise be excluded
                // from miniaturization candidates alongside newWindow.
                const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, window);

                if (resizeResult?.success) {
                    Logger.log('Re-include: Smart resize applied - tiling workspace');
                    WindowState.set(window, 'justReturnedFromExclusion', true);
                    this.tilingManager._isSmartResizingBlocked = true;
                    try {
                        this.tilingManager._pendingMiniatureWindows = resizeResult.pendingWindows ?? [];
                        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                    } finally {
                        this.tilingManager._isSmartResizingBlocked = false;
                    }
                } else {
                    Logger.log('Re-include: Smart resize not applicable - moving to overflow');
                    this.windowingManager.moveOversizedWindow(window).catch(e =>
                        Logger.error(`Re-include overflow failed: ${e}`));
                }

                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Tries to bring back the oldest miniature when space frees up. Shared by
    // the close, move and live-resize paths so they don't duplicate the fit check.
    _tryAutoRestoreMiniature(remainingWindows, workspace, monitor) {
        if (!this._ext.miniatureManager) return false;

        const miniatureWindows = remainingWindows
            .filter(w => WindowState.get(w, IS_MINIATURE))
            .sort((a, b) => a.get_id() - b.get_id());

        if (miniatureWindows.length === 0) return false;

        const candidate = miniatureWindows[0];
        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        if (!this._ext.tilingManager.canRestoreMiniature(candidate, remainingWindows, workArea)) {
            Logger.log(`_tryAutoRestoreMiniature: keeping mini ${candidate.get_id()} - would overflow if restored`);
            return false;
        }

        this._ext._miniatureCascadeIds?.delete(candidate.get_id());
        this._ext.miniatureManager.restoreMiniature(candidate, null, { activate: false });
        // 'miniature-restored' signal fires synchronously, _onMiniatureRestored already
        // ran by the time restoreMiniature returns - calling it again here used to double
        // the whole Smart Resize + retile pass for one restore.
        return true;
    }

    // Deduped via closeRetileHandledAt since both signals fire for the same close/move -
    // whichever gets here first does the work, the other (often arriving much later
    // behind afterAnimations) skips. No time expiry: a close never repeats, and a move
    // clears the flag in enqueueWindowForEvaluation so a later close/move reads as fresh.
    // Options below capture real behavioral differences between the two callers, not duplication.
    _retileAfterWindowGone(removedWindow, remainingWindows, workspace, monitor, freedWidth, freedHeight, options = {}) {
        const {
            wasMovedByOverflow = false,
            requireConstrainedCheck = false,
            passFreedDimsToRestore = true,
            includeMinisInRestoreCall = false,
            cleanSmartResizingFlags = false,
            requireBothFreedDims = false,
            reverseLogLabel = '[REVERSE]',
            settleLogLabel = null,
            settleTimeoutName = 'windowHandler_closeRetileSettle',
        } = options;

        if (WindowState.get(removedWindow, 'closeRetileHandledAt')) {
            Logger.log(`_retileAfterWindowGone: already handled for ${removedWindow.get_id()} - skipping duplicate`);
            return;
        }
        WindowState.set(removedWindow, 'closeRetileHandledAt', true);

        if (cleanSmartResizingFlags) {
            Logger.log('[SMART RESIZE] Cleaning up transient flags for remaining windows');
            for (const w of remainingWindows) {
                WindowState.set(w, 'isSmartResizing', false);
            }
        }

        if (!wasMovedByOverflow && this._tryAutoRestoreMiniature(remainingWindows, workspace, monitor)) {
            return;
        }

        const restorableWindows = remainingWindows.filter(w => !WindowState.get(w, IS_MINIATURE));

        // When the caller doesn't trust its own freedWidth/freedHeight enough to pass
        // them through (passFreedDimsToRestore: false), gating the attempt on those same
        // values is pointless - e.g. 'unmanaged' fires early enough that the closed
        // window's frame already reads 0x0, which used to block the attempt outright
        // even though tryRestoreWindowSizes would have computed available space itself.
        const hasFreedSpace = !passFreedDimsToRestore || (requireBothFreedDims
            ? (freedWidth > 0 && freedHeight > 0)
            : (freedWidth > 0 || freedHeight > 0));
        let shouldTryRestore = hasFreedSpace && restorableWindows.length > 0;
        if (shouldTryRestore && requireConstrainedCheck) {
            shouldTryRestore = restorableWindows.some(w => {
                const hasTarget = WindowState.get(w, 'targetSmartResizeSize') !== null;
                const isConstrained = WindowState.get(w, 'isConstrainedByMosaic') === true;
                return hasTarget || isConstrained;
            });
        }

        let restored = false;
        if (shouldTryRestore) {
            Logger.log(`${reverseLogLabel} - attempting reverse smart resize with freed ${freedWidth}x${freedHeight}`);
            const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
            const target = includeMinisInRestoreCall ? remainingWindows : restorableWindows;
            restored = this._ext.tilingManager.tryRestoreWindowSizes(
                target, workArea,
                passFreedDimsToRestore ? freedWidth : null,
                passFreedDimsToRestore ? freedHeight : null,
                workspace, monitor);
        }

        if (restored) {
            // move_resize_frame above hasn't settled yet - retiling now would read
            // get_frame_rect() before the client acks the new size, hit the layout
            // cache with the stale dimensions, and redraw right back over the restore.
            this._ext._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                if (settleLogLabel) Logger.log(settleLogLabel);
                for (const w of restorableWindows) {
                    WindowState.remove(w, 'isReverseSmartResizing');
                }
                this._ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                return GLib.SOURCE_REMOVE;
            }, settleTimeoutName);
        } else {
            this._ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
        }
    }

    // Executes when a window is physically destroyed
    onWindowDestroyed(window) {
        const monitor = window.get_monitor();
        const windowId = window.get_id();
        const windowWorkspace = window.get_workspace();

        Logger.log(`onWindowDestroyed: ${windowId}`);

        this.disconnectWindowSignals(window);

        if (this._ext.miniatureManager && WindowState.get(window, IS_MINIATURE)) {
            this._ext.miniatureManager.destroyMiniature(window);
        }

        this.edgeTilingManager.clearWindowState(window);

        WindowState.remove(window, 'maximizedUndoInfo');

        if (this.windowingManager.isExcluded(window)) {
            Logger.log('Excluded window closed - no workspace navigation');
            return;
        }

        if (windowWorkspace) {
            const workspace = windowWorkspace;

            // Capture destroyed window size for reverse smart resize. The actor
            // may already be disposed during signal delivery, and get_frame_rect
            // on a dead MetaWindow segfaults libmutter.
            const destroyedFrame = isWindowAlive(window) ? window.get_frame_rect() : null;
            const freedWidth = destroyedFrame ? destroyedFrame.width : 0;
            const freedHeight = destroyedFrame ? destroyedFrame.height : 0;

            this.edgeTilingManager.checkQuarterExpansion(workspace, monitor);

            afterWindowClose(() => {
                afterAnimations(this._ext.animationsManager, () => {
                    const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));

                    this._retileAfterWindowGone(window, remainingWindows, workspace, monitor, freedWidth, freedHeight, {
                        requireConstrainedCheck: true,
                        reverseLogLabel: '[REVERSE-DESTROYED] Window closed',
                        settleTimeoutName: 'windowHandler_destroyedRestoreSettle',
                    });
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
        const windowId = window.get_id();
        // Deduplicate
        if (this._evaluationQueue.some(entry => entry.window.get_id() === windowId)) {
            Logger.log(`Skipping duplicate enqueue for window ${windowId}`);
            return;
        }
        // window-created and window-added both land here for a new window, so
        // skip if we just evaluated it.
        const lastEvaluatedAt = WindowState.get(window, 'lastEvaluatedAt');
        if (lastEvaluatedAt && (Date.now() - lastEvaluatedAt) < constants.DUPLICATE_EVALUATION_WINDOW_MS) {
            Logger.log(`Skipping re-enqueue for window ${windowId} - evaluated ${Date.now() - lastEvaluatedAt}ms ago`);
            return;
        }
        Logger.log(`Enqueueing window ${windowId} for evaluation`);
        // A window being (re)considered for the mosaic is a fresh lifecycle position -
        // any earlier close-retile dedup claim (from a previous move) no longer applies.
        WindowState.remove(window, 'closeRetileHandledAt');
        WindowState.set(window, 'pendingInQueue', true);
        this._evaluationQueue.push({ window, workspace, monitor });
        if (!this._isEvaluatingQueue) {
            this._processEvaluationQueue().catch(e => {
                Logger.error(`Evaluation queue failed: ${e}\n${e.stack}`);
                for (const entry of this._evaluationQueue)
                    WindowState.remove(entry.window, 'pendingInQueue');
                this._evaluationQueue = [];
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
            WindowState.remove(window, 'pendingInQueue');
            WindowState.set(window, 'lastEvaluatedAt', Date.now());

            if (!isWindowAlive(window)) {
                Logger.log('Evaluation queue: window destroyed before evaluation, skipping');
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
                lastOverflowWorkspace = null; // Reset overflow cascade, user intent takes priority
                overflowedWorkspaces.clear();
                window.change_workspace(workspace);
            } else if (lastOverflowWorkspace && lastOverflowWorkspace !== workspace) {
                // Check if the overflow destination already failed, stop cascading to prevent loops
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
                    .filter(w => !this.windowingManager.isExcluded(w) && !WindowState.get(w, 'pendingInQueue'));

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

        if (WindowState.get(window, 'restoringFromMiniature')) {
            Logger.log(`ensureWindowFits: Skipping - restoring from miniature for ${window.get_id()}`);
            return workspace;
        }

        // Already constrained, so sibling frames may not have settled yet; tile directly to avoid false overflow.
        if (WindowState.get(window, 'isConstrainedByMosaic')) {
            Logger.log(`ensureWindowFits: Window ${window.get_id()} already constrained by mosaic - tiling directly`);
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            return workspace;
        }

        // Path 1: Sacred Isolation - Symmetric isolation enforcement.
        const isIncomingSacred = this.windowingManager.isMaximizedOrFullscreen(window);
        const hasExistingSacred = this.windowingManager.hasSacredWindow(workspace, monitor, window.get_id());
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !WindowState.get(w, 'pendingInQueue'));
        const otherWindows = workspaceWindows.filter(w => w.get_id() !== window.get_id());

        if (hasExistingSacred || (isIncomingSacred && otherWindows.length > 0)) {
            Logger.log(`Sacred Isolation triggered (IncomingSacred: ${isIncomingSacred}, HasExistingSacred: ${hasExistingSacred}) - isolating`);
            return await this.windowingManager.moveOversizedWindow(window);
        }

        // Save preferred size after sacred checks, to avoid capturing monitor-sized dimensions
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
                    const restored = this.tilingManager.tryRestoreWindowSizes(monitorWindows, wa, availableExtra, wa.height, workspace, monitor);
                    if (restored) {
                        this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                            for (const w of monitorWindows) {
                                WindowState.remove(w, 'isReverseSmartResizing');
                            }
                            return GLib.SOURCE_REMOVE;
                        }, 'windowHandler_dndRestoreSettle');
                    }
                }
            }
        }

        // Path 3: Fitting & Smart Resize
        // Use TARGET size for restoration flows to avoid transient overflow ejection.
        const targetSize = WindowState.get(window, 'targetRestoredSize');
        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor, false, targetSize);

        if (canFit) {
            Logger.log('Window fits - tiling workspace directly');
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
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
            .filter(w => w.get_id() !== window.get_id() && !this.edgeTilingManager.isEdgeTiled(w)
                && !WindowState.get(w, 'pendingInQueue'));

        // Include IS_MINIATURE windows so tryFitWithResize can account for the space they occupy.
        // They are treated as non-resizable fixed participants inside tryFitWithResize.
        const existingWindows = allExistingWindows.filter(w =>
            !this.windowingManager.isMaximizedOrFullscreen(w)
        );

        if (existingWindows.length > 0) {
            // Pass the new window as focused override, since Mutter's focus_window
            // may still be the previously focused sibling at this point, which
            // would exclude it from miniaturization alongside newWindow.
            const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, window);
            if (resizeResult?.success) {
                Logger.log('Smart resize applied, tiling directly');
                // Block overflow during tiling, since a null reference would otherwise let it expel something
                this.tilingManager._isSmartResizingBlocked = true;
                try {
                    this.tilingManager._pendingMiniatureWindows = resizeResult.pendingWindows ?? [];
                    this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                } finally {
                    this.tilingManager._isSmartResizingBlocked = false;
                }
                return workspace;
            }
        }

        // Path 5: Overflow (Final fallback)
        Logger.log(`Smart resize failed or skipped - applying Overflow logic (existingWindows=${existingWindows.length}, blocked=${this.tilingManager._isSmartResizingBlocked})`);
        return await this.windowingManager.moveOversizedWindow(window);
    }
    onWindowCreated(window) {
        this.windowingManager.invalidateWindowsCache();

        // Shift held at launch: make always-on-top before any tiling runs
        const [, , creationMods] = global.get_pointer();
        if (creationMods & Clutter.ModifierType.SHIFT_MASK) {
            window.make_above();
            Logger.log(`Window ${window.get_id()} opened with Shift, set always-on-top`);
        }

        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            WindowState.set(window, 'openedMaximized', true);
            // Defense: clean up flags that onSizeChange may have set before window-created fired
            WindowState.remove(window, 'maximizedUndoInfo');
            WindowState.remove(window, 'isEnteringSacred');
            Logger.log(`Window ${window.get_id()} opened maximized - marked for auto-tile check`);
        }

        const processWindowCallback = () => {
            const monitor = window.get_monitor();
            const workspace = window.get_workspace();

            if( monitor !== null &&
                window.wm_class !== null &&
                isWindowAlive(window) &&
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
                    Logger.log('New window: Attempting to tile with edge-tiled window');
                    const tileSuccess = this.windowingManager.tryTileWithSnappedWindow(window, edgeTiledWindows[0], null);

                    if (tileSuccess) {
                        Logger.log('New window: Successfully tiled with edge-tiled window');
                        this.connectWindowSignals(window);
                        return GLib.SOURCE_REMOVE;
                    }
                    Logger.log('New window: Tiling failed, continuing with normal flow');
                }

                // Mutter discards resizes while overview is open, so defer until onOverviewHidden.
                if (Main.overview.visible) {
                    Logger.log(`Window ${window.get_id()} created while overview visible - deferring evaluation until overview hidden`);
                    WindowState.set(window, 'deferTilingUntilOverviewHidden', true);
                    return GLib.SOURCE_REMOVE;
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
                    // Bounded safety polling if initial callback failed (rare)
                    let attempts = 0;
                    this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
                        if (++attempts > constants.GEOMETRY_WAIT_MAX_ATTEMPTS || !isWindowAlive(window))
                            return GLib.SOURCE_REMOVE;
                        return processWindowCallback();
                    }, 'windowHandler_safetyPoll');
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
                if (!isWindowAlive(window)) {
                    Logger.log('window map timeout - window already disposed, aborting process');
                    return GLib.SOURCE_REMOVE;
                }

                Logger.log('window map timeout - falling back to immediate processing');
                processOnce();
                return GLib.SOURCE_REMOVE;
            }, 'windowHandler_mapSafety');
        } else {
            // Fallback for non-actor windows (rare in Shell): bounded polling
            let fallbackAttempts = 0;
            this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
                // Abort if window is gone (destroyed or unmanaged) or poll exhausted
                if (++fallbackAttempts > constants.GEOMETRY_WAIT_MAX_ATTEMPTS ||
                    !isWindowAlive(window) || !window.get_workspace()) {
                    Logger.log('onWindowCreated fallback: window gone or poll exhausted - aborting');
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

    onWindowAdded(_workspace, window) {
        this.windowingManager.invalidateWindowsCache();
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }

        // Capture natural size immediately upon arrival to a workspace
        this._ext.tilingManager.savePreferredSize(window);

        // Mark window as newly added for overflow protection logic
        WindowState.set(window, 'addedTime', Date.now());

        let validityAttempts = 0;
        this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            // Abort if window is gone (destroyed or unmanaged) or poll exhausted
            if (++validityAttempts > constants.GEOMETRY_WAIT_MAX_ATTEMPTS ||
                !isWindowAlive(window) || !window.get_workspace()) {
                Logger.log(`window-added: window ${window.get_id()} gone or poll exhausted - aborting`);
                return GLib.SOURCE_REMOVE;
            }

            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = WINDOW.get_monitor();

            if (this._ext.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {

                const frame = WINDOW.get_frame_rect();
                const hasValidDimensions = frame.width > 0 && frame.height > 0;

                if (hasValidDimensions) {
                    // Detect a DnD across workspaces: window was just removed from a different
                    // workspace within SAFETY_TIMEOUT_BUFFER_MS, so this add is the drop side.
                    const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
                    const removedTimestamp = WindowState.get(WINDOW, 'removedTimestamp');
                    const timeSinceRemoved = removedTimestamp ? Date.now() - removedTimestamp : Infinity;

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

                    // Repoll while waitForGeometry returns SOURCE_CONTINUE, bounded
                    // so a window that never reports geometry can't poll forever.
                    let geometryAttempts = 0;
                    this._timeoutRegistry.add(constants.GEOMETRY_CHECK_DELAY_MS, () => {
                        if (++geometryAttempts > constants.GEOMETRY_WAIT_MAX_ATTEMPTS || !isWindowAlive(WINDOW))
                            return GLib.SOURCE_REMOVE;
                        return this.waitForGeometry(WINDOW, WORKSPACE, MONITOR);
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

        // On destroy, both the 'unmanaged' handler and the workspace
        // 'window-removed' signal land here, so dedupe to keep the retile/restore
        // pipeline (and miniature auto-restore) from running twice.
        const now = Date.now();
        const lastHandled = WindowState.get(window, 'removalHandledAt');
        if (lastHandled && now - lastHandled < constants.SAFETY_TIMEOUT_BUFFER_MS) {
            Logger.log(`onWindowRemoved: duplicate removal event for ${window.get_id()} - skipping`);
            return;
        }
        WindowState.set(window, 'removalHandledAt', now);

        WindowState.set(window, 'previousWorkspace', workspace.index());
        WindowState.set(window, 'removedTimestamp', now);

        // SKIP if window was moved by overflow
        const wasMovedByOverflow = WindowState.get(window, 'movedByOverflow');

        // Capture removed window's size before any operations. Guarded since the
        // window may already be disposed when removal comes from a destroy.
        const removedFrame = isWindowAlive(window) ? window.get_frame_rect() : null;
        const freedWidth = removedFrame ? removedFrame.width : 0;
        const freedHeight = removedFrame ? removedFrame.height : 0;

        // Capture monitor at event time (window may move monitors during DnD)
        const removedMonitor = window.get_monitor();

        const actor = window.get_compositor_private();
        if (!actor || actor.is_destroyed()) {
            this._ext.tilingManager.clearPreferredSize(window);
        } else {
            Logger.log('_windowRemoved: Window still exists (DnD move) - keeping preferred size');
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

            // Try to restore window sizes with freed space (Reverse Smart Resize)
            // Miniatures are excluded since their slot is fixed and shouldn't be grown to preferred.
            if (remainingWindows.length > 0) {
                this._retileAfterWindowGone(window, remainingWindows, WORKSPACE, MONITOR, freedWidth, freedHeight, {
                    wasMovedByOverflow,
                    cleanSmartResizingFlags: true,
                    includeMinisInRestoreCall: true,
                    passFreedDimsToRestore: false,
                    requireBothFreedDims: true,
                    reverseLogLabel: '[REVERSE-REMOVED] Window removed',
                    settleLogLabel: 'Retiling after restore delay',
                    settleTimeoutName: 'windowHandler_restoreSettle',
                });
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

    waitForGeometry(WINDOW, WORKSPACE, MONITOR) {
        const rect = WINDOW.get_frame_rect();

        if (rect.width > 0 && rect.height > 0) {
            // Geometry ready
            WindowState.set(WINDOW, 'waitingForGeometry', false);
            WindowState.set(WINDOW, 'geometryReady', true);

            if (this._ext.windowingManager.isExcluded(WINDOW)) {
                Logger.log('waitForGeometry: Window is excluded - connecting signals but skipping tiling');
                this.connectWindowSignals(WINDOW);
                return GLib.SOURCE_REMOVE;
            }

            const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
            Logger.log(`Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`);

            if (WindowState.get(WINDOW, 'movedByOverflow')) {
                Logger.log('Skipping early tile in waitForGeometry - window was moved by overflow (Flags cleared to prevent leakage)');
                WindowState.remove(WINDOW, 'movedByOverflow');
                return GLib.SOURCE_REMOVE;
            }

            if (Main.overview.visible) {
                Logger.log('Window created while overview visible - deferring evaluation until overview hidden');
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
                    } catch (_e) {}
                    return GLib.SOURCE_REMOVE;
                }, 'windowHandler_overviewRelayout', GLib.PRIORITY_DEFAULT_IDLE);
                return GLib.SOURCE_REMOVE;
            }

            const performTiling = async () => {
                if (WindowState.get(WINDOW, 'movedByOverflow')) {
                    Logger.log('Skipping duplicate evaluation queueing - window was already evaluated and moved by overflow');
                    return;
                }
                this.enqueueWindowForEvaluation(WINDOW, WORKSPACE, MONITOR);
            };

            const isDnDArrival = WindowState.get(WINDOW, 'arrivedFromDnD');
            const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');

            if (isDnDArrival || WindowState.get(WINDOW, 'movedByOverflow') || (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== WORKSPACE.index())) {
                Logger.log('Cross-workspace move: Waiting for workspace animation');
                afterWorkspaceSwitch(performTiling, this._ext._timeoutRegistry);
            } else {
                performTiling();
            }

            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

});
