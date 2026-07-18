// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// WindowHandler manages window lifecycle signals and state transitions.

import GLib from 'gi://GLib';
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
import { afterWorkspaceSwitch, afterAnimations, afterWindowClose, monotonicNow } from './timing.js';

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
        this._pendingRestoreRetiles = [];
        this._readinessWaiters = new Set();
    }

    destroy() {
        for (const entry of this._evaluationQueue)
            WindowState.remove(entry.window, 'pendingInQueue');
        this._evaluationQueue = [];
        this._isEvaluatingQueue = false;
        this._pendingRestoreRetiles = [];
        for (const waiter of this._readinessWaiters) {
            for (const id of waiter.ids) waiter.window.disconnect(id);
        }
        this._readinessWaiters.clear();
    }

    // Some windows aren't identifiable at map time (wm_class can arrive seconds
    // late), so retry the gate whenever the relevant state changes.
    _awaitWindowReadiness(window, tryProceed) {
        const waiter = { window, ids: [] };
        const finish = () => {
            for (const id of waiter.ids) window.disconnect(id);
            waiter.ids = [];
            this._readinessWaiters.delete(waiter);
        };
        const retry = () => {
            if (!isWindowAlive(window)) {
                finish();
                return;
            }
            if (tryProceed()) finish();
        };
        for (const signal of ['notify::wm-class', 'size-changed', 'notify::minimized'])
            waiter.ids.push(window.connect(signal, retry));
        waiter.ids.push(window.connect('unmanaged', finish));
        this._readinessWaiters.add(waiter);
    }

    // Claiming the entrance hides the actor and cancels Mutter's open animation,
    // betting the tile pass eases it in. Whoever the tile pass won't touch (disabled
    // workspace, sacred, opening alone) can't take that bet: the failsafe a full
    // second later would be their only way back to visible.
    shouldSkipSlideIn(window) {
        return WindowState.get(window, 'movedByOverflow') || this._ext._overflowInProgress
            || !this._ext.isMosaicEnabledForWorkspace(window.get_workspace())
            || this.windowingManager.isMaximizedOrFullscreen(window)
            || this.windowingManager.isExcludedByPolicy(window)
            || !this._hasSiblings(window);
    }

    // Floating windows never enter the tile pass that would clear opacity=0;
    // reveal so the slide-in failsafe isn't their only path to visibility.
    revealPendingEntrance(window) {
        if (!WindowState.get(window, 'pendingFirstPlacement')) return;
        WindowState.remove(window, 'pendingFirstPlacement');
        this.animationsManager.cancelPendingEntrance(window);
        const actor = isWindowAlive(window) ? window.get_compositor_private() : null;
        if (actor && !actor.is_destroyed()) {
            actor.remove_transition('opacity');
            actor.opacity = 255;
        }
    }

    // Lock a workspace to prevent recursive or conflicting tiling triggers.
    // Reference-counted: overlapping tileWorkspaceWindows calls (e.g. drag-end
    // and resize-end firing close together) each hold their own depth, so the
    // workspace stays locked until every holder has unlocked.
    lockWorkspace(workspace) {
        if (!workspace) return;
        const depth = (this._workspaceLocks.get(workspace) ?? 0) + 1;
        this._workspaceLocks.set(workspace, depth);
        Logger.log(`Workspace ${workspace.index()} LOCKED for tiling (depth=${depth})`);
    }

    unlockWorkspace(workspace) {
        if (!workspace) return;
        const depth = (this._workspaceLocks.get(workspace) ?? 0) - 1;
        if (depth <= 0) {
            this._workspaceLocks.delete(workspace);
            Logger.log(`Workspace ${workspace.index()} UNLOCKED`);
        } else {
            this._workspaceLocks.set(workspace, depth);
            Logger.log(`Workspace ${workspace.index()} unlock (depth=${depth}, still locked)`);
        }
    }

    isWorkspaceLocked(workspace) {
        if (!workspace) return false;
        return (this._workspaceLocks.get(workspace) ?? 0) > 0;
    }

    get isEvaluatingQueue() {
        return this._isEvaluatingQueue;
    }

    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }

    connectWindowSignals(window) {
        if (!window || this._windowSignals.has(window)) return;

        Logger.log(`Connecting signals for window ${window.get_id()}`);
        const ids = [];

        ids.push(window.connect('unmanaged', (win) => {
            Logger.log(`Window ${win.get_id()} (unmanaged) - cleaning up`);
            this.animationsManager.removeAnimatingWindow(win.get_id());
            const ws = win.get_workspace();
            if (ws) this.onWindowRemoved(ws, win);
            this.disconnectWindowSignals(win);
        }));

        // Have two signals that fires when (un)maximize, so we coalesce it via idle.
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
                    // backup for apps where that signal doesn't fire reliably; calling
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
                        this._settleBornSacredExit(win, 'unmaximize');
                    } else {
                        this._ext.resizeHandler.tryExitSacred(win);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }));
        });

        // Detect Fullscreen changes, same backup pattern as maximize above.
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
                this._settleBornSacredExit(win, 'unfullscreen');
            } else {
                this._ext.resizeHandler.tryExitSacred(win);
            }
        }));

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

        ids.push(window.connect('notify::above', (win) => this.handleExclusionStateChange(win)));
        ids.push(window.connect('notify::on-all-workspaces', (win) => this.handleExclusionStateChange(win)));
        ids.push(window.connect('notify::minimized', (win) => this.handleExclusionStateChange(win)));

        this._windowSignals.set(window, ids);

        const currentExclusion = this.windowingManager.isExcluded(window);
        WindowState.set(window, 'previousExclusionState', currentExclusion);

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

        ComputedLayouts.delete(window);

        WindowState.remove(window, 'previousExclusionState');
        WindowState.remove(window, 'previousWorkspace');
    }

    _isFrameMonitorSized(win) {
        const ws = win.get_workspace();
        const mon = win.get_monitor();
        const wa = ws && mon !== null ? ws.get_work_area_for_monitor(mon) : null;
        const frame = win.get_frame_rect();
        return !!wa && frame.width >= wa.width && frame.height >= wa.height;
    }

    // The state flips before the client commits the size that goes with it, so the frame
    // here can still be the maximized one. Tiling on it sends a configure the client's own
    // late commit then overrides, so wait for that commit.
    _settleBornSacredExit(win, label) {
        if (!this._isFrameMonitorSized(win)) {
            this._captureAndTile(win, label);
            return;
        }

        let sizeId = null;
        let unmanagedId = null;
        const disconnect = () => {
            if (sizeId) win.disconnect(sizeId);
            if (unmanagedId) win.disconnect(unmanagedId);
            sizeId = unmanagedId = null;
        };

        sizeId = win.connect('size-changed', () => {
            disconnect();
            this._captureAndTile(win, label);
        });
        unmanagedId = win.connect('unmanaged', disconnect);
    }

    _captureAndTile(win, label) {
        if (!isWindowAlive(win)) return;

        const ws = win.get_workspace();
        const mon = win.get_monitor();
        // Only capture if nothing's recorded yet, so a later manual resize or
        // Smart Resize decision is never clobbered.
        if (!WindowState.get(win, 'preferredSize')) {
            const settled = win.get_frame_rect();
            const wa = ws && mon !== null ? ws.get_work_area_for_monitor(mon) : null;
            // A client that stays monitor-sized through the exit leaves a frame
            // indistinguishable from maximized. Use 95% of the work area instead so it
            // reads as "nearly full" rather than maximized.
            const isMonitorSized = wa && settled.width >= wa.width && settled.height >= wa.height;
            const size = isMonitorSized
                ? { width: Math.floor(wa.width * 0.95), height: Math.floor(wa.height * 0.95) }
                : { width: settled.width, height: settled.height };
            WindowState.set(win, 'preferredSize', size);
            Logger.log(`Captured preferredSize on ${label} for ${win.get_id()}: ${size.width}x${size.height}${isMonitorSized ? ' (95% fallback, no real shrink)' : ''}`);
        }

        if (ws) this.tilingManager.tileWorkspaceWindows(ws, win, mon);
    }

    onWindowUnmaximized(window) {
        const workspace = window.get_workspace();
        if (!workspace) return;

        WindowState.remove(window, 'openedMaximized');

        const monitor = window.get_monitor();
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        if (workspaceWindows.length > 1) {
            // Restore preferred size if it was edge-constrained or smart-resized
            if (WindowState.get(window, 'isConstrainedByMosaic')) {
                this.tilingManager.restorePreferredSize(window);
            }

            this.tilingManager.tileWorkspaceWindows(workspace, window, monitor);
        }
    }

    handleExclusionStateChange(window) {
        const windowId = window.get_id();
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();

        const isNowExcluded = this.windowingManager.isExcluded(window);

        const wasExcluded = WindowState.get(window, 'previousExclusionState') || false;
        WindowState.set(window, 'previousExclusionState', isNowExcluded);

        if (wasExcluded === isNowExcluded) {
            return;
        }

        if (isNowExcluded) {
            Logger.log(`Window ${windowId} became excluded; retiling without it`);

            // Exclusion arriving after opacity=0 was set (e.g. always-on-top
            // toggled mid-entrance) strands the actor invisible; reveal now.
            this.revealPendingEntrance(window);

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
            Logger.log(`Window ${windowId} became included; treating as new window arrival`);

            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                const workArea = this.edgeTilingManager.calculateRemainingSpace(workspace, monitor);
                if (!workArea) {
                    Logger.log('WindowHandler: Skipped include - invalid workArea');
                    return GLib.SOURCE_REMOVE;
                }
                const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== window.get_id() && !this.windowingManager.isExcluded(w));

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
                const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, workspace, window);

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

    onWindowLeftMonitor(monitor, window) {
        if (!this._windowSignals.has(window)) return;

        // Mutter flips on_all_workspaces (workspaces-only-on-primary) before emitting this,
        // so the window may already report no workspace of its own.
        const workspace = window.get_workspace() ?? global.workspace_manager.get_active_workspace();
        if (!workspace) return;

        Logger.log(`Window ${window.get_id()} left monitor ${monitor}`);

        // onWindowRemoved runs before this signal and can only see the destination
        // monitor, so leave the source behind for its deferred count to pick up.
        WindowState.set(window, 'leftMonitor', monitor);
        WindowState.set(window, 'leftMonitorAt', monotonicNow());

        this.windowingManager.invalidateWindowsCache();

        // Under a grab the drag passes own the layout; retiling here on top of them feeds
        // reverse smart resize back into tiling forever. stopDrag retiles the source.
        if (this._ext.dragHandler._draggedWindow) return;

        // Mutter discards resizes while the overview is open, so an overview drag would
        // leave the source mosaic half-positioned. Hand it to onOverviewHidden instead.
        if (Main.overview.visible) {
            this._pendingRestoreRetiles.push({ workspace, monitor, windows: [] });
            return;
        }

        this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
            this.windowingManager.invalidateWindowsCache();
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            return GLib.SOURCE_REMOVE;
        }, 'windowHandler_leftMonitorRetile');
    }

    onWindowEnteredMonitor(monitor, window) {
        if (!this._windowSignals.has(window)) return;

        // A grab drag ends in stopDrag, which tiles the destination itself. Overview
        // drags, keyboard moves and monitor hotplug have no grab, so this is the only
        // place that gets the arriving window into the mosaic.
        if (this._ext.dragHandler._draggedWindow) return;

        // An on-all-workspaces window reports no workspace of its own, but it does show
        // up in every workspace's list, so the active one is the right context to tile in.
        const workspace = window.get_workspace() ?? global.workspace_manager.get_active_workspace();
        if (!workspace || this.windowingManager.isExcluded(window)) return;

        Logger.log(`Window ${window.get_id()} entered monitor ${monitor}; evaluating for mosaic`);

        this.windowingManager.invalidateWindowsCache();

        if (Main.overview.visible) {
            WindowState.set(window, 'deferTilingUntilOverviewHidden', true);
            return;
        }

        this.enqueueWindowForEvaluation(window, workspace, monitor);
    }

    // Brings back the most recently used miniature when space frees up. Shared by
    // the close, move and live-resize paths so they don't duplicate the fit check.
    _tryAutoRestoreMiniature(remainingWindows, workspace, monitor) {
        if (!this._ext.miniatureManager) return false;

        const mru  = this.windowingManager.getMRUOrder(workspace);
        const rank = w => mru.get(w.get_id()) ?? Number.MAX_SAFE_INTEGER;

        // Ascending here, unlike the sacrifice sites: index 0 is the most recent,
        // and that's the miniature to bring back first.
        const miniatureWindows = remainingWindows
            .filter(w => WindowState.get(w, IS_MINIATURE))
            .sort((a, b) => rank(a) - rank(b));

        if (miniatureWindows.length === 0) return false;

        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);

        // canRestoreMiniature only simulates, so falling through to the next candidate
        // costs nothing; the most recent may not fit while an older one still does.
        for (const candidate of miniatureWindows) {
            if (!this._ext.tilingManager.canRestoreMiniature(candidate, remainingWindows, workArea)) {
                Logger.log(`_tryAutoRestoreMiniature: keeping mini ${candidate.get_id()}, would overflow if restored`);
                continue;
            }

            this._ext._miniatureCascadeIds?.delete(candidate.get_id());
            this._ext.miniatureManager.restoreMiniature(candidate, null, { activate: false });
            // 'miniature-restored' signal fires synchronously, _onMiniatureRestored already
            // ran by the time restoreMiniature returns; calling it again here used to double
            // the whole Smart Resize + retile pass for one restore.
            return true;
        }

        return false;
    }

    // Deduped via closeRetileHandledAt since both close signals land here; whichever
    // gets here first does the work, the other (often arriving much later behind
    // afterAnimations) skips. No time expiry: a close never repeats, a DnD move clears
    // the flag on re-enqueue, and an overflow move never claims at all since it never
    // re-enqueues (a stale claim would block the retile at the window's real close).
    // Options below capture real behavioral differences between the two callers, not duplication.
    _retileAfterWindowGone(removedWindow, remainingWindows, workspace, monitor, freedWidth, freedHeight, options = {}) {
        const opts = this._retileOptions(options);

        if (WindowState.get(removedWindow, 'closeRetileHandledAt')) {
            Logger.log(`_retileAfterWindowGone: already handled for ${removedWindow.get_id()} - skipping duplicate`);
            return;
        }
        if (!opts.wasMovedByOverflow)
            WindowState.set(removedWindow, 'closeRetileHandledAt', true);

        if (opts.cleanSmartResizingFlags) {
            Logger.log('[SMART RESIZE] Cleaning up transient flags for remaining windows');
            for (const w of remainingWindows) {
                WindowState.set(w, 'isSmartResizing', false);
            }
        }

        if (!opts.wasMovedByOverflow && this._tryAutoRestoreMiniature(remainingWindows, workspace, monitor)) {
            return;
        }

        const restorableWindows = remainingWindows.filter(w => !WindowState.get(w, IS_MINIATURE));

        const restored = this._maybeReverseRestore(
            remainingWindows, restorableWindows, workspace, monitor, freedWidth, freedHeight, opts);

        // Resettling because a window just left, so bounce it like an entrance.
        if (restored) {
            this._scheduleRestoreSettle(restorableWindows, workspace, monitor, opts);
        } else {
            this._retileWithoutRestore(workspace, monitor);
        }
    }

    _retileOptions(options) {
        return {
            wasMovedByOverflow: false,
            requireConstrainedCheck: false,
            passFreedDimsToRestore: true,
            includeMinisInRestoreCall: false,
            cleanSmartResizingFlags: false,
            requireBothFreedDims: false,
            reverseLogLabel: '[REVERSE]',
            settleLogLabel: null,
            settleTimeoutName: 'windowHandler_closeRetileSettle',
            ...options,
        };
    }

    // Whether reclaiming the freed space is worth attempting: there must be freed space
    // (or a caller that measures it itself) and at least one restorable window, and under
    // requireConstrainedCheck at least one that mosaic actually shrank.
    _shouldReverseRestore(restorableWindows, freedWidth, freedHeight, opts) {
        // When the caller doesn't trust its own freedWidth/freedHeight enough to pass
        // them through (passFreedDimsToRestore: false), gating the attempt on those same
        // values is pointless; e.g. 'unmanaged' fires early enough that the closed
        // window's frame already reads 0x0, which used to block the attempt outright
        // even though tryRestoreWindowSizes would have computed available space itself.
        const hasFreedSpace = !opts.passFreedDimsToRestore || (opts.requireBothFreedDims
            ? (freedWidth > 0 && freedHeight > 0)
            : (freedWidth > 0 || freedHeight > 0));
        if (!(hasFreedSpace && restorableWindows.length > 0)) return false;
        if (!opts.requireConstrainedCheck) return true;

        return restorableWindows.some(w => {
            const hasTarget = WindowState.get(w, 'targetSmartResizeSize') !== null;
            const isConstrained = WindowState.get(w, 'isConstrainedByMosaic') === true;
            return hasTarget || isConstrained;
        });
    }

    _maybeReverseRestore(remainingWindows, restorableWindows, workspace, monitor, freedWidth, freedHeight, opts) {
        if (!this._shouldReverseRestore(restorableWindows, freedWidth, freedHeight, opts)) return false;

        // Printing the freed dims where they're ignored sends readers chasing the
        // 0x0 that 'window-removed' always reports; say where the space came from.
        const freedDesc = opts.passFreedDimsToRestore
            ? `freed ${freedWidth}x${freedHeight}`
            : 'free space measured from the work area';
        Logger.log(`${opts.reverseLogLabel}: attempting reverse smart resize with ${freedDesc}`);
        const workArea = this._ext.tilingManager.getUsableWorkArea(workspace, monitor);
        const target = opts.includeMinisInRestoreCall ? remainingWindows : restorableWindows;
        return this._ext.tilingManager.tryRestoreWindowSizes(
            target, workArea,
            opts.passFreedDimsToRestore ? freedWidth : null,
            opts.passFreedDimsToRestore ? freedHeight : null,
            workspace, monitor);
    }

    _scheduleRestoreSettle(restorableWindows, workspace, monitor, opts) {
        // move_resize_frame above hasn't settled yet; retiling now would read
        // get_frame_rect() before the client acks the new size, hit the layout
        // cache with the stale dimensions, and redraw right back over the restore.
        this._ext._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
            if (opts.settleLogLabel) Logger.log(opts.settleLogLabel);
            for (const w of restorableWindows) {
                WindowState.remove(w, 'isReverseSmartResizing');
            }
            if (Main.overview.visible) {
                // animateWindow does nothing while the overview is open, so defer the tile and cleanup to onOverviewHidden.
                this._pendingRestoreRetiles.push({ workspace, monitor, windows: restorableWindows });
                return GLib.SOURCE_REMOVE;
            }
            this.animationsManager.setMembershipChangeBounce(true);
            this._ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
            this.animationsManager.setMembershipChangeBounce(false);
            for (const w of restorableWindows) {
                WindowState.remove(w, 'targetRestoredSize');
            }
            return GLib.SOURCE_REMOVE;
        }, opts.settleTimeoutName);
    }

    _retileWithoutRestore(workspace, monitor) {
        if (Main.overview.visible) {
            this._pendingRestoreRetiles.push({ workspace, monitor, windows: [] });
        } else {
            this.animationsManager.setMembershipChangeBounce(true);
            this._ext.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
            this.animationsManager.setMembershipChangeBounce(false);
        }
    }

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
                    // Both waits run inline when animations are off, so this can still
                    // execute inside the destroy signal, with the dying window listed.
                    const remainingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(w => w.get_id() !== windowId &&
                                     !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));

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
                // Skip if overflow is in progress; window is being moved and will arrive soon
                if (this._overflowInProgress) {
                    Logger.log('Workspace is empty but overflow in progress; skipping navigation');
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

        if (this._pendingRestoreRetiles.length > 0) {
            for (const { workspace: ws, monitor: mon, windows } of this._pendingRestoreRetiles) {
                Logger.log('Retiling after restore delay (deferred: overview was open)');
                this.animationsManager.setMembershipChangeBounce(true);
                this._ext.tilingManager.tileWorkspaceWindows(ws, null, mon, true);
                this.animationsManager.setMembershipChangeBounce(false);
                for (const w of windows) {
                    WindowState.remove(w, 'targetRestoredSize');
                }
            }
            this._pendingRestoreRetiles = [];
        }
    }

    enqueueWindowForEvaluation(window, workspace, monitor) {
        const windowId = window.get_id();
        // A (re)considered window voids any earlier close-retile dedup claim; cleared
        // before the dedupe returns below so a skipped re-enqueue still resets it.
        WindowState.remove(window, 'closeRetileHandledAt');
        if (this._evaluationQueue.some(entry => entry.window.get_id() === windowId)) {
            Logger.log(`Skipping duplicate enqueue for window ${windowId}`);
            return;
        }
        // window-created and window-added both land here for a new window, so
        // skip if we just evaluated it.
        const lastEvaluatedAt = WindowState.get(window, 'lastEvaluatedAt');
        if (lastEvaluatedAt && (monotonicNow() - lastEvaluatedAt) < constants.DUPLICATE_EVALUATION_WINDOW_MS) {
            Logger.log(`Skipping re-enqueue for window ${windowId} - evaluated ${Math.round(monotonicNow() - lastEvaluatedAt)}ms ago`);
            return;
        }
        Logger.log(`Enqueueing window ${windowId} for evaluation`);
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
        // expectedWorkspace detects manual user switches; lastOverflowWorkspace cascades a
        // batch's overflow; overflowedWorkspaces caps that cascade so it can't loop forever.
        const state = { lastOverflowWorkspace: null, expectedWorkspace: null };
        const overflowedWorkspaces = new Set();

        while (this._evaluationQueue.length > 0) {
            let { window, workspace, monitor } = this._evaluationQueue.shift();
            WindowState.remove(window, 'pendingInQueue');
            WindowState.set(window, 'lastEvaluatedAt', monotonicNow());

            if (!isWindowAlive(window)) {
                Logger.log('Evaluation queue: window destroyed before evaluation, skipping');
                continue;
            }

            const resolved = this._resolveQueueItemWorkspace(window, workspace);
            if (resolved.skip) continue;
            workspace = this._applyQueueCascade(window, resolved.workspace, state, overflowedWorkspaces);
            state.expectedWorkspace = workspace;

            Logger.log(`Evaluating queued window ${window.get_id()} on WS-${workspace.index()} (remaining: ${this._evaluationQueue.length})`);
            await this._evaluateQueuedWindowFit(window, workspace, monitor, state, overflowedWorkspaces);

            WindowState.remove(window, 'arrivalPending');
            await this._queueSettleDelay();
        }

        this._isEvaluatingQueue = false;
    }

    // Recover from a workspace removed mid-flight (async smart resize can leave index -1),
    // falling back to the window's current one; {skip:true} when there's nowhere valid.
    _resolveQueueItemWorkspace(window, workspace) {
        if (workspace.index() >= 0) return { skip: false, workspace };

        const currentWorkspace = window.get_workspace();
        if (currentWorkspace && currentWorkspace.index() >= 0) {
            Logger.log(`Evaluation queue: stale workspace (index -1), using window's current WS-${currentWorkspace.index()}`);
            return { skip: false, workspace: currentWorkspace };
        }
        Logger.log(`Evaluation queue: window ${window.get_id()} has invalid workspace, skipping`);
        WindowState.remove(window, 'arrivalPending');
        return { skip: true };
    }

    // Pick the workspace to evaluate on: follow a manual user switch (which wins over any
    // in-flight cascade), else keep cascading this batch's overflow. Returns that workspace.
    _applyQueueCascade(window, workspace, state, overflowedWorkspaces) {
        const activeWorkspace = this.windowingManager.getWorkspace();
        const targetWorkspace = state.lastOverflowWorkspace || state.expectedWorkspace || workspace;

        if (activeWorkspace && targetWorkspace && activeWorkspace.index() !== targetWorkspace.index()) {
            Logger.log(`Evaluation queue: User switched to WS-${activeWorkspace.index()} during processing (expected WS-${targetWorkspace.index()}) - following user`);
            state.lastOverflowWorkspace = null;
            overflowedWorkspaces.clear();
            window.change_workspace(activeWorkspace);
            return activeWorkspace;
        }

        if (state.lastOverflowWorkspace && state.lastOverflowWorkspace !== workspace) {
            return this._cascadeToOverflow(window, workspace, state, overflowedWorkspaces);
        }
        return workspace;
    }

    _cascadeToOverflow(window, workspace, state, overflowedWorkspaces) {
        // Stop cascading once the overflow destination itself failed, or it loops.
        if (overflowedWorkspaces.has(state.lastOverflowWorkspace.index())) {
            Logger.log(`Evaluation queue: overflow destination WS-${state.lastOverflowWorkspace.index()} already failed - stopping cascade, window ${window.get_id()} stays on WS-${workspace.index()}`);
            state.lastOverflowWorkspace = null;
            return workspace;
        }

        const dest = state.lastOverflowWorkspace;
        Logger.log(`Evaluation queue: cascading window ${window.get_id()} to overflow destination WS-${dest.index()}`);
        if (window.get_workspace() !== dest) {
            WindowState.set(window, 'movedByOverflow', true);
            window.change_workspace(dest);
        }
        return dest;
    }

    async _evaluateQueuedWindowFit(window, workspace, monitor, state, overflowedWorkspaces) {
        try {
            const resultWorkspace = await this._ensureWindowFits(window, workspace, monitor);
            if (resultWorkspace && resultWorkspace.index() !== workspace.index()) {
                overflowedWorkspaces.add(workspace.index());
                state.lastOverflowWorkspace = resultWorkspace;
                state.expectedWorkspace = resultWorkspace;
            }

            const managedWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                .filter(w => !this.windowingManager.isExcluded(w) && !WindowState.get(w, 'pendingInQueue'));

            if (managedWindows.length === 0) {
                this._renavigateIfTrulyEmpty(window, workspace, monitor, state);
            }
        } catch (e) {
            Logger.error(`Error in evaluation queue for window ${window.get_id()}: ${e}`);
        }
    }

    _renavigateIfTrulyEmpty(window, workspace, monitor, state) {
        // Don't renavigate a workspace that's empty only because overflow is mid-transition.
        const isEjectedByOverflow = state.lastOverflowWorkspace && state.lastOverflowWorkspace.index() !== workspace.index();
        if (!isEjectedByOverflow) {
            Logger.log(`Queue: Window ${window.get_id()} moved and left WS-${workspace.index()} empty - renavigating`);
            this.windowingManager.renavigate(workspace, true, this._ext._lastVisitedWorkspace, monitor);
        } else {
            Logger.log(`Queue: WS-${workspace.index()} empty due to overflow - skipping renavigate to stay on WS-${state.lastOverflowWorkspace.index()}`);
        }
    }

    // Small delay to let animations/mutter settle before evaluating the next window.
    _queueSettleDelay() {
        return new Promise(resolve => {
            if (this._timeoutRegistry) {
                this._timeoutRegistry.add(constants.QUEUE_PROCESS_DELAY_MS || 50, resolve, '_processEvaluationQueue');
            } else {
                resolve();
            }
        });
    }

    async _ensureWindowFits(window, workspace, monitor) {
        if (this._ensureFitsBlocked(window, workspace)) return workspace;

        // Runs before constrained fast path: tiling refuses sacred workspaces and would
        // strand a constrained arrival floating there.
        const sacred = await this._ensureFitsSacred(window, workspace, monitor);
        if (sacred.handled) return sacred.result;

        // Already constrained, so sibling frames may not have settled yet; tile directly to avoid false overflow.
        if (WindowState.get(window, 'isConstrainedByMosaic')) {
            Logger.log(`ensureWindowFits: Window ${window.get_id()} already constrained by mosaic - tiling directly`);
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            return workspace;
        }

        // Save preferred size after sacred checks, to avoid capturing monitor-sized dimensions
        this.tilingManager.savePreferredSize(window);

        if (WindowState.get(window, 'arrivedFromDnD')) {
            this._handleDnDArrival(window, workspace, monitor);
        }

        // Use TARGET size for restoration flows to avoid transient overflow ejection.
        const targetSize = WindowState.get(window, 'targetRestoredSize');
        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor, false, targetSize);

        if (canFit) {
            Logger.log('Window fits - tiling workspace directly');
            this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            return workspace;
        }

        return await this._fitByResizeOrOverflow(window, workspace, monitor);
    }

    _ensureFitsBlocked(window, workspace) {
        if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log('ensureWindowFits: Skipping - mosaic disabled for workspace');
            return true;
        }
        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log('ensureWindowFits: Skipping - smart resize in progress');
            return true;
        }
        if (WindowState.get(window, 'restoringFromMiniature')) {
            Logger.log(`ensureWindowFits: Skipping - restoring from miniature for ${window.get_id()}`);
            return true;
        }
        return false;
    }

    // A sacred (maximized/fullscreen) arrival, or a normal one landing where a sacred window
    // already lives, gets its own workspace. {handled:true, result} when isolated.
    async _ensureFitsSacred(window, workspace, monitor) {
        const isIncomingSacred = this.windowingManager.isMaximizedOrFullscreen(window);
        const hasExistingSacred = this.windowingManager.hasSacredWindow(workspace, monitor, window.get_id());
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !WindowState.get(w, 'pendingInQueue'));
        const otherWindows = workspaceWindows.filter(w => w.get_id() !== window.get_id());

        if (hasExistingSacred || (isIncomingSacred && otherWindows.length > 0)) {
            Logger.log(`Sacred Isolation triggered (IncomingSacred: ${isIncomingSacred}, HasExistingSacred: ${hasExistingSacred}) - isolating`);
            return { handled: true, result: await this.windowingManager.moveOversizedWindow(window) };
        }
        return { handled: false };
    }

    _handleDnDArrival(window, workspace, monitor) {
        WindowState.set(window, 'arrivedFromDnD', false);
        const monitorWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
        const preferredSize = this.tilingManager.getPreferredSize(window);

        if (preferredSize && monitorWindows.length === 1) {
            this._dndRestoreSolo(monitorWindows[0], workspace, monitor, preferredSize);
        } else {
            this._dndRestoreExpansion(monitorWindows, workspace, monitor);
        }
    }

    _dndRestoreSolo(win, workspace, monitor, preferredSize) {
        const wa = workspace.get_work_area_for_monitor(monitor);
        const currentRect = win.get_frame_rect();
        const targetW = Math.min(preferredSize.width, wa.width - constants.WINDOW_SPACING * 2);
        const targetH = Math.min(preferredSize.height, wa.height - constants.WINDOW_SPACING * 2);
        Logger.log(`DnD Solo: Fully restoring window to ${targetW}x${targetH}`);
        win.move_resize_frame(true, currentRect.x, currentRect.y, targetW, targetH);
    }

    _dndRestoreExpansion(monitorWindows, workspace, monitor) {
        const usedWidth = monitorWindows.reduce((sum, w) => sum + w.get_frame_rect().width, 0);
        const wa = workspace.get_work_area_for_monitor(monitor);
        const availableExtra = wa.width - usedWidth - (monitorWindows.length + 1) * constants.WINDOW_SPACING;
        if (availableExtra <= constants.ANIMATION_DIFF_THRESHOLD) return;

        Logger.log(`DnD arrival: Extra space ${availableExtra}px - trying expansion`);
        const restored = this.tilingManager.tryRestoreWindowSizes(monitorWindows, wa, availableExtra, wa.height, workspace, monitor);
        if (!restored) return;

        this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
            for (const w of monitorWindows) {
                WindowState.remove(w, 'isReverseSmartResizing');
            }
            return GLib.SOURCE_REMOVE;
        }, 'windowHandler_dndRestoreSettle');
    }

    async _fitByResizeOrOverflow(window, workspace, monitor) {
        const workArea = this.tilingManager.getUsableWorkArea(workspace, monitor);

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
            const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, workspace, window);
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

        Logger.log(`Smart resize failed or skipped - applying Overflow logic (existingWindows=${existingWindows.length}, blocked=${this.tilingManager._isSmartResizingBlocked})`);
        return await this.windowingManager.moveOversizedWindow(window);
    }

    // A window opening alone should keep Mutter's native animation instead of
    // getting hidden and swapped for our fade-only entrance, since there's nothing
    // to slide in against. onWindowCreated and onWindowAdded both call this and need
    // to agree, so the result is cached instead of each side recomputing on its own
    // (workspace/monitor can resolve differently by the time the second one runs,
    // and disagreeing would leave the actor hidden with no entrance ever claimed).
    // Defaults to true when workspace/monitor aren't ready yet, since losing a real
    // slide-in is more noticeable than an unnecessary one.
    //
    // TODO: only checks whether any sibling exists, not whether the window ends up
    // boxed in by siblings on every side, which also has no real direction to slide
    // from and should get the native animation too. Telling that apart needs the
    // final tiled layout, which isn't computed yet at this point (skipNextEffect
    // has to be called here, before the layout exists). Options: run an early
    // dry-run tiling pass with the new window included (geometry isn't always
    // settled yet here, so the prediction could be wrong), or a cheaper heuristic
    // from the current siblings alone (e.g. a fully packed grid with no free edge),
    // which would only catch that one shape of enclosure, not every possible one.
    _hasSiblings(window) {
        const cached = WindowState.get(window, 'hasEntranceSiblings');
        if (cached !== undefined) return cached;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (!workspace || monitor === null || monitor < 0) return true;

        const result = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .some(w => w.get_id() !== window.get_id());
        WindowState.set(window, 'hasEntranceSiblings', result);
        return result;
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

        const processWindowCallback = () => this._processCreatedWindow(window);

        const actor = window.get_compositor_private();
        if (actor) {
            const isRelated = this.windowingManager.isRelated(window);
            if (isRelated && !this.shouldSkipSlideIn(window)) {
                // Ask Mutter to skip its own open animation outright (the same public
                // API altTab.js uses to skip the unminimize effect) instead of fighting
                // it after the fact. Our own pipeline drives the entrance once it knows
                // the real tiled target and siblings, on its own timeline.
                Main.wm.skipNextEffect(actor);

                // onWindowAdded tries to hide the actor too, but it usually runs before
                // the actor even exists yet (get_compositor_private() is still null there
                // most of the time). This is the first point we're guaranteed to have it,
                // so the fade-in actually has something to fade from instead of starting
                // (and silently staying) at the default opacity of 255.
                actor.opacity = 0;

                // animateWindow may run (and defer, per Clutter skipping transitions on
                // unmapped actors) before the actor is actually mapped. Once it is, give
                // it the one nudge it needs to actually ease instead of sitting hidden.
                // One-shot: mapped flips on and off repeatedly later on (e.g. every time
                // the Overview opens/closes), and runDeferredEntrance only has anything
                // to do the first time anyway.
                if (actor.mapped) {
                    this._ext.animationsManager.runDeferredEntrance(window);
                } else {
                    const mappedSignalId = actor.connect('notify::mapped', () => {
                        if (!actor.mapped) return;
                        actor.disconnect(mappedSignalId);
                        this._ext.animationsManager.runDeferredEntrance(window);
                    });
                }
            }

            let signalId = null;
            let timeoutId = null;
            let processed = false;

            const processOnce = () => {
                if (processed) return;
                processed = true;

                if (signalId) actor.disconnect(signalId);
                if (timeoutId) this._timeoutRegistry.remove(timeoutId);

                if (processWindowCallback() === GLib.SOURCE_CONTINUE) {
                    // Gate closed (e.g. wm_class still unset); retry on state changes
                    this._awaitWindowReadiness(window, () => processWindowCallback() === GLib.SOURCE_REMOVE);
                }

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
            // Fallback for non-actor windows (rare in Shell): same signal-driven gate
            if (processWindowCallback() === GLib.SOURCE_CONTINUE)
                this._awaitWindowReadiness(window, () => processWindowCallback() === GLib.SOURCE_REMOVE);
            this.connectWindowSignals(window);
        }
    }

    // Runs once the window is ready enough to place. SOURCE_CONTINUE re-arms the readiness
    // gate; SOURCE_REMOVE means placement is resolved (tiled, isolated, queued, or deferred).
    _processCreatedWindow(window) {
        const monitor = window.get_monitor();
        const workspace = window.get_workspace();

        if (!(monitor !== null &&
              window.wm_class !== null &&
              isWindowAlive(window) &&
              workspace.list_windows().length !== 0 &&
              !window.is_hidden()))
            return GLib.SOURCE_CONTINUE;

        if (this.windowingManager.isExcluded(window)) {
            Logger.log('Window excluded from tiling');
            WindowState.remove(window, 'arrivalPending');
            this.revealPendingEntrance(window);
            return GLib.SOURCE_REMOVE;
        }

        this._captureOpeningSize(window, workspace, monitor);

        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            return this._handleSacredCreated(window, workspace, monitor);
        }

        const edgeResult = this._tryTileNewWithEdge(window, workspace, monitor);
        if (edgeResult !== null) return edgeResult;

        // Mutter discards resizes while overview is open, so defer until onOverviewHidden.
        if (Main.overview.visible) {
            Logger.log(`Window ${window.get_id()} created while overview visible - deferring evaluation until overview hidden`);
            WindowState.set(window, 'deferTilingUntilOverviewHidden', true);
            return GLib.SOURCE_REMOVE;
        }

        this.enqueueWindowForEvaluation(window, workspace, monitor);
        return GLib.SOURCE_REMOVE;
    }

    // Use saved_rect for natural size (get_frame_rect matches monitor if Maximized).
    _captureOpeningSize(window, workspace, monitor) {
        if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
            // ONLY save preferred size if the window is NOT maximized/fullscreen upon creation.
            // This prevents capturing "almost-maximized" frames during the opening animation.
            this.tilingManager.savePreferredSize(window);
            return;
        }

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
    }

    _handleSacredCreated(window, workspace, monitor) {
        if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log('Sacred window in disabled mosaic workspace - skipping isolation');
            return GLib.SOURCE_REMOVE;
        }

        this.windowingManager.invalidateWindowsCache();
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        const otherWindows = workspaceWindows.filter(w => w.get_id() !== window.get_id());

        if (otherWindows.length > 0) {
            // Isolating straight from here would race the queue's own sacred
            // check and isolate twice, each pass creating its own workspace.
            Logger.log('Opened sacred (Max/Full) in occupied workspace; queueing for isolation (SACRED)');
            this.enqueueWindowForEvaluation(window, workspace, monitor);
            return GLib.SOURCE_REMOVE;
        }
        Logger.log('Sacred window in empty workspace - keeping here');
        WindowState.remove(window, 'arrivalPending');
        this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
        return GLib.SOURCE_REMOVE;
    }

    // Pairs a brand-new window with a lone edge-tiled sibling. Returns a GLib source
    // verdict when it took over placement, or null to fall through to the normal flow.
    _tryTileNewWithEdge(window, workspace, monitor) {
        const workspaceWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        const edgeTiledWindows = workspaceWindows.filter(w => {
            const tileState = this.edgeTilingManager.getWindowState(w);
            return tileState && tileState.zone !== TileZone.NONE && w.get_id() !== window.get_id();
        });

        if (!(edgeTiledWindows.length === 1 && workspaceWindows.length === 2)) return null;

        Logger.log('New window: Attempting to tile with edge-tiled window');
        const tileSuccess = this.windowingManager.tryTileWithSnappedWindow(window, edgeTiledWindows[0], null);
        if (tileSuccess) {
            Logger.log('New window: Successfully tiled with edge-tiled window');
            WindowState.remove(window, 'arrivalPending');
            this.connectWindowSignals(window);
            return GLib.SOURCE_REMOVE;
        }
        Logger.log('New window: Tiling failed, continuing with normal flow');
        return null;
    }

    onWindowAdded(_workspace, window) {
        this.windowingManager.invalidateWindowsCache();
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }

        // Going on-all-workspaces (sticky, or landing on a secondary monitor under
        // workspaces-only-on-primary) re-adds the window to every workspace at once.
        // It isn't arriving anywhere; the monitor signals own its placement, and
        // running the arrival pipeline here overflows it to another workspace.
        if (window.is_on_all_workspaces()) {
            return;
        }

        this._ext.tilingManager.savePreferredSize(window);

        // addedTime feeds the resize settle check and the rebalance's newest-window pick;
        // arrivalPending shields the window until its arrival evaluation resolves placement.
        WindowState.set(window, 'addedTime', monotonicNow());
        WindowState.set(window, 'arrivalPending', true);

        // Flag the first-ever tiling pass for this window so it slides in instead
        // of using the "no jump" continuity math meant for windows that already
        // have a real visual position. onWindowCreated separately asks Mutter to
        // skip its own open animation (skipNextEffect) and nudges animateWindow's
        // deferred entrance once the actor is actually mapped.
        if (!this.shouldSkipSlideIn(window)) {
            WindowState.set(window, 'pendingFirstPlacement', true);
            const actor = window.get_compositor_private();
            // onWindowCreated races independently and may have already started (or
            // queued) the real entrance ease by the time this runs. Resetting opacity
            // here would stomp that mid-flight (a direct property write the ease's own
            // next frame then overwrites again), which is exactly what shows up as a blink.
            if (actor && !this._ext.animationsManager.hasActiveOrPendingEntrance(window))
                actor.opacity = 0;

            // Failsafe: if animateWindow never claims this window (e.g. excluded
            // right after creation), don't leave it invisible or the flag stuck.
            // pendingFirstPlacement stays true for the entire span of a genuinely
            // running ease (cleared only by its own onStopped), and a slowed-down
            // slow_down_factor easily outlasts this fixed timeout, so re-arm instead
            // of yanking opacity to its final value out from under an ease that's
            // still legitimately mid-flight.
            const scheduleFirstPlacementFailsafe = () => {
                this._timeoutRegistry.add(constants.SLIDE_IN_FAILSAFE_MS, () => {
                    if (!WindowState.get(window, 'pendingFirstPlacement')) return GLib.SOURCE_REMOVE;
                    if (this._ext.animationsManager.hasActiveOrPendingEntrance(window)) {
                        scheduleFirstPlacementFailsafe();
                        return GLib.SOURCE_REMOVE;
                    }
                    WindowState.remove(window, 'pendingFirstPlacement');
                    const a = isWindowAlive(window) ? window.get_compositor_private() : null;
                    if (a && !a.is_destroyed()) a.opacity = 255;
                    return GLib.SOURCE_REMOVE;
                }, 'windowHandler_firstPlacementFailsafe');
            };
            scheduleFirstPlacementFailsafe();
        }

        const proceedWhenValid = () => {
            const WORKSPACE = window.get_workspace();
            if (!WORKSPACE) return false;

            const WINDOW = window;
            const MONITOR = WINDOW.get_monitor();

            if (!this._ext.tilingManager.checkValidity(MONITOR, WORKSPACE, WINDOW, false))
                return false;

            const frame = WINDOW.get_frame_rect();
            if (frame.width <= 0 || frame.height <= 0)
                return false;

            this._handleCrossWorkspaceDnD(WINDOW, WORKSPACE, MONITOR);

            // Mark window as waiting for geometry; prevents premature overflow
            WindowState.set(WINDOW, 'waitingForGeometry', true);

            // Repoll while waitForGeometry returns SOURCE_CONTINUE, bounded
            // so a window that never reports geometry can't poll forever.
            let geometryAttempts = 0;
            this._timeoutRegistry.add(constants.GEOMETRY_CHECK_DELAY_MS, () => {
                if (++geometryAttempts > constants.GEOMETRY_WAIT_MAX_ATTEMPTS || !isWindowAlive(WINDOW)) {
                    // Giving up here used to strand arrivalPending, and everything that
                    // reads it as "placement unresolved" would shield the window forever.
                    WindowState.remove(WINDOW, 'arrivalPending');
                    return GLib.SOURCE_REMOVE;
                }
                return this.waitForGeometry(WINDOW, WORKSPACE, MONITOR);
            }, 'windowHandler_geometryCheck');

            return true;
        };

        // First attempt runs on idle, keeping it out of the window-added emission
        this._timeoutRegistry.addIdle(() => {
            if (isWindowAlive(window) && !proceedWhenValid())
                this._awaitWindowReadiness(window, proceedWhenValid);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Detect a DnD across workspaces: window was just removed from a different
    // workspace within SAFETY_TIMEOUT_BUFFER_MS, so this add is the drop side.
    _handleCrossWorkspaceDnD(WINDOW, WORKSPACE, MONITOR) {
        const previousWorkspaceIndex = WindowState.get(WINDOW, 'previousWorkspace');
        const removedTimestamp = WindowState.get(WINDOW, 'removedTimestamp');
        const timeSinceRemoved = removedTimestamp ? monotonicNow() - removedTimestamp : Infinity;

        const isCrossWorkspaceDrop = previousWorkspaceIndex !== undefined
            && previousWorkspaceIndex !== WORKSPACE.index()
            && timeSinceRemoved < constants.SAFETY_TIMEOUT_BUFFER_MS;
        // Skip if this is an overflow move, not a real drag-drop
        if (!isCrossWorkspaceDrop || WindowState.get(WINDOW, 'movedByOverflow')) return;

        WORKSPACE.activate(global.get_current_time());
        this._ext.windowingManager.showWorkspaceSwitcher(WORKSPACE, MONITOR);

        // Mark as DnD arrival; triggers expansion after tiling
        WindowState.set(WINDOW, 'arrivedFromDnD', true);

        // Wait for overview to fully close before tiling
        if (Main.overview.visible) {
            WindowState.set(WINDOW, 'deferTilingUntilOverviewHidden', true);
            Main.overview.hide();
        }

        WindowState.remove(WINDOW, 'previousWorkspace');
        WindowState.remove(WINDOW, 'removedTimestamp');
        WindowState.remove(WINDOW, 'manualWorkspaceMove');
    }

    onWindowRemoved(workspace, window) {
        this.windowingManager.invalidateWindowsCache();
        if (!this._ext.windowingManager.isRelated(window)) {
            return;
        }

        // On destroy, both the 'unmanaged' handler and the workspace
        // 'window-removed' signal land here, so dedupe to keep the retile/restore
        // pipeline (and miniature auto-restore) from running twice.
        const now = monotonicNow();
        const lastHandled = WindowState.get(window, 'removalHandledAt');
        if (lastHandled && now - lastHandled < constants.SAFETY_TIMEOUT_BUFFER_MS) {
            Logger.log(`onWindowRemoved: duplicate removal event for ${window.get_id()} - skipping`);
            return;
        }
        WindowState.set(window, 'removalHandledAt', now);

        WindowState.set(window, 'previousWorkspace', workspace.index());
        WindowState.set(window, 'removedTimestamp', now);

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
            Logger.log('_windowRemoved: Window still exists (DnD move); keeping preferred size');
        }

        this._timeoutRegistry.add(constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS, () => {
            const WORKSPACE = workspace;

            // A window leaving for another monitor already reports the destination here,
            // which counts the siblings it left behind as zero and reads as an empty
            // workspace. onWindowLeftMonitor fires right after us with the real source.
            const leftMonitorAt = WindowState.get(window, 'leftMonitorAt');
            const cameFromMonitorMove = leftMonitorAt &&
                monotonicNow() - leftMonitorAt < constants.SAFETY_TIMEOUT_BUFFER_MS;
            const MONITOR = cameFromMonitorMove
                ? WindowState.get(window, 'leftMonitor')
                : removedMonitor;

            if (!WORKSPACE || WORKSPACE.index() < 0) {
                return GLib.SOURCE_REMOVE;
            }

            const removedId = window.get_id();
            const remainingWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                .filter(w => w.get_id() !== removedId &&
                             !this._ext.edgeTilingManager.isEdgeTiled(w) &&
                             !this._ext.windowingManager.isExcluded(w));

            Logger.log(`_windowRemoved: ${remainingWindows.length} remaining windows, wasOverflowMove=${wasMovedByOverflow}`);

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
                const allRelatedWindows = this._ext.windowingManager.getMonitorWorkspaceWindows(WORKSPACE, MONITOR)
                    .filter(w => w.get_id() !== removedId);
                if (allRelatedWindows.length === 0) {
                    if (WORKSPACE.index() < 0) {
                        Logger.log('_windowRemoved: Workspace already destroyed, skipping navigation');
                        return GLib.SOURCE_REMOVE;
                    }
                    if (wasMovedByOverflow) {
                        Logger.log('_windowRemoved: Workspace empty but window was moved by overflow; skipping navigation');
                    } else {
                        Logger.log('_windowRemoved: Workspace truly empty, navigating away');
                        this._ext.windowingManager.renavigate(WORKSPACE, global.workspace_manager.get_active_workspace() === WORKSPACE, this._ext._lastVisitedWorkspace, MONITOR);
                    }

                    WindowState.remove(window, 'isRestoringSacred');
                }
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    waitForGeometry(WINDOW, WORKSPACE, MONITOR) {
        const rect = WINDOW.get_frame_rect();

        if (rect.width > 0 && rect.height > 0) {
            WindowState.set(WINDOW, 'waitingForGeometry', false);
            WindowState.set(WINDOW, 'geometryReady', true);

            if (this._ext.windowingManager.isExcluded(WINDOW)) {
                Logger.log('waitForGeometry: Window is excluded - connecting signals but skipping tiling');
                WindowState.remove(WINDOW, 'arrivalPending');
                this.connectWindowSignals(WINDOW);
                this.revealPendingEntrance(WINDOW);
                return GLib.SOURCE_REMOVE;
            }

            const wa = WORKSPACE.get_work_area_for_monitor(MONITOR);
            Logger.log(`Window ${WINDOW.get_id()} ready: size=${rect.width}x${rect.height}, workArea=${wa.width}x${wa.height}`);

            if (WindowState.get(WINDOW, 'movedByOverflow')) {
                Logger.log('Skipping early tile in waitForGeometry - window was moved by overflow (Flags cleared to prevent leakage)');
                WindowState.remove(WINDOW, 'movedByOverflow');
                WindowState.remove(WINDOW, 'arrivalPending');
                return GLib.SOURCE_REMOVE;
            }

            if (Main.overview.visible) {
                Logger.log('Window created while overview visible - deferring evaluation until overview hidden');
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
                    WindowState.remove(WINDOW, 'arrivalPending');
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
