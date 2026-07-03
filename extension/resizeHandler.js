// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// ResizeHandler - Manages window resize operations and maximize undo.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Logger from './logger.js';
import { afterWorkspaceSwitch, afterAnimations } from './timing.js';
import * as WindowState from './windowState.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import { isResizeGrabOp } from './grabOps.js';
import { isWorkspaceAlive, isWindowAlive } from './liveness.js';

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

    _queueConstraintRebalance(window) {
        if (this._constraintRebalanceQueued) return;

        // Suppress rebalance during queue evaluation, since the queue handles its own overflow
        if (this._ext.windowHandler && this._ext.windowHandler.isEvaluatingQueue) return;

        this._constraintRebalanceCount = (this._constraintRebalanceCount || 0) + 1;
        if (this._constraintRebalanceCount > 3) {
            Logger.log('[SMART RESIZE] Max rebalance attempts reached, skipping');
            return;
        }

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();

        this._constraintRebalanceQueued = true;
        this._timeoutRegistry.addIdle(() => {
            this._constraintRebalanceQueued = false;
            if (workspace && workspace.index() >= 0) {
                this.tilingManager.rebalanceSmartResize(workspace, monitor);
            }
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_constraintRebalance');
    }

    resetConstraintRebalanceCount() {
        this._constraintRebalanceCount = 0;
    }

    // A clamp seen shortly after window creation might just be the client still
    // negotiating its own size, not a real minimum, so allow one retry per target.
    _shouldRetryClamp(window, pendingSmartSize) {
        const addedTime = WindowState.get(window, 'addedTime');
        if (addedTime === undefined) return false;
        if (Date.now() - addedTime >= constants.RESIZE_CLAMP_SETTLE_WINDOW_MS) return false;

        const retriedTarget = WindowState.get(window, 'clampRetryTarget');
        const alreadyRetriedThisTarget = retriedTarget
            && retriedTarget.width === pendingSmartSize.width
            && retriedTarget.height === pendingSmartSize.height;

        return !alreadyRetriedThisTarget;
    }

    onResizeBegin(window, grabpo) {
        this._resizeInOverflow = false;
        this._lastResizeTileTime = 0;
        this.animationsManager.setResizingWindow(window.get_id());

        // Always clear smart-resize target so manual resize takes precedence
        WindowState.set(window, 'targetSmartResizeSize', null);
        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log(`Manual resize started for ${window.get_id()} - clearing smart-resize state`);
            WindowState.set(window, 'isSmartResizing', false);
        }

        Logger.log(`Tracking resize for window ${window.get_id()}, grabpo=${grabpo}`);
    }

    onResizeEnd(window, grabpo, skipTiling) {
        // Keep resizingWindowId set during final retile to prevent animation jiggle
        Logger.log(`Resize ended for window ${window.get_id()}`);

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
            this._timeoutRegistry.remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }

        this._resizeGracePeriod = GLib.get_monotonic_time() / 1000;

        if (this._resizeInOverflow || this._resizeOverflowWindow === window) {
            Logger.log('Resize ended with overflow - moving window to new workspace');
            this._resizeInOverflow = false;
            const actor = window.get_compositor_private();
            if (actor) actor.opacity = 255;

            const oldWorkspace = window.get_workspace();
            this.windowingManager.moveOversizedWindow(window).then(newWorkspace => {
                if (newWorkspace) {
                    afterAnimations(this.animationsManager, () => {
                        const monitor = window.get_monitor();
                        if (monitor !== null) {
                            this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, monitor, false);
                        }
                    }, this._timeoutRegistry);
                }
            });
            this._resizeOverflowWindow = null;
        } else if (!isEdgeTiled && !skipTiling) {
            this.tilingManager.savePreferredSize(window);
            this.tilingManager.invalidateLayoutCache();
            this.tilingManager.tileWorkspaceWindows(window.get_workspace(), null, window.get_monitor(), true);
        }

        // Clear resizing state AFTER final retile to prevent animation jiggle on drop
        this.animationsManager.setResizingWindow(null);
    }

    onSizeChange = (_, win, mode) => {
        const window = win.meta_window;
        if (!this.windowingManager.isExcluded(window)) {
            if (mode === Meta.SizeChange.FULLSCREEN || mode === Meta.SizeChange.MAXIMIZE) {
                this.tryEnterSacred(window);
            } else if (mode === Meta.SizeChange.UNMAXIMIZE || mode === Meta.SizeChange.UNFULLSCREEN) {
                this.tryExitSacred(window);
            }
        }
    };

    // Debounced so a quick toggle back never even starts the displace. Also called
    // from windowHandler's notify::fullscreen as a backup (some apps' fullscreen
    // doesn't reliably fire size-change); sacredEnterPending makes duplicate calls safe.
    tryEnterSacred(window) {
        // Detect born-maximized: size-change fires BEFORE window-created for new windows.
        // A window with no preferredSize/openingSize hasn't been through onWindowCreated yet.
        if (!WindowState.get(window, 'preferredSize') &&
            !WindowState.get(window, 'openingSize') &&
            this.windowingManager.isMaximizedOrFullscreen(window)) {
            WindowState.set(window, 'openedMaximized', true);
            Logger.log(`tryEnterSacred: Detected born-maximized window ${window.get_id()} - skipping isolation`);
            return;
        }
        // Born-maximized guard (from onWindowCreated - for subsequent maximize events)
        if (WindowState.get(window, 'openedMaximized')) {
            return;
        }
        if (WindowState.get(window, 'sacredEnterPending')) {
            return;
        }

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();

        // LOCK: Set flag to block onSizeChanged from saving giant dimensions
        WindowState.set(window, 'isEnteringSacred', true);

        if (this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log('User entering sacred state, but mosaic is disabled - skipping isolation');
            return;
        }
        if (!this.windowingManager.isMaximizedOrFullscreen(window) ||
            this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor).length <= 1) {
            return;
        }

        Logger.log('[SACRED-ENTER] User entering sacred state - debouncing before displacing other windows');
        WindowState.set(window, 'sacredEnterPending', true);
        const preMaxSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');

        this._timeoutRegistry.add(constants.SACRED_ENTER_DEBOUNCE_MS, () => {
            WindowState.remove(window, 'sacredEnterPending');

            if (!isWindowAlive(window) || !this.windowingManager.isMaximizedOrFullscreen(window)) {
                Logger.log(`[SACRED-ENTER] Window ${window.get_id()} already left sacred state - skipping isolation`);
                return GLib.SOURCE_REMOVE;
            }

            const currentWorkspace = window.get_workspace();
            const currentMonitor = window.get_monitor();
            if (!currentWorkspace || this.windowingManager.getMonitorWorkspaceWindows(currentWorkspace, currentMonitor).length <= 1) {
                Logger.log(`[SACRED-ENTER] Window ${window.get_id()} workspace no longer occupied - skipping isolation`);
                return GLib.SOURCE_REMOVE;
            }

            Logger.log('[SACRED-ENTER] Still in sacred state after debounce - displacing other windows');

            const preInsertionIndex = currentWorkspace.index();
            const targetWorkspace = this.windowingManager.createOrReuseLeftWorkspace(currentWorkspace);

            // Capture original workspace index AFTER workspace insertion, since
            // createOrReuseLeftWorkspace may reorder and shift the current workspace.
            const originalWorkspaceIndex = currentWorkspace.index();

            // Keep the maximized window in place so expand doesn't fight a lateral slide.
            const otherWindows = this.windowingManager.getMonitorWorkspaceWindows(currentWorkspace, currentMonitor)
                .filter(w => w !== window && !this.windowingManager.isExcluded(w));

            if (otherWindows.length === 0) {
                Logger.log(`[SACRED-ENTER] Window ${window.get_id()} has no other windows to displace`);
                return GLib.SOURCE_REMOVE;
            }

            for (const w of otherWindows) {
                WindowState.set(w, 'movedByOverflow', true);
                w.change_workspace(targetWorkspace);
            }

            WindowState.set(window, 'maximizedUndoInfo', {
                originalWorkspace: originalWorkspaceIndex,
                displacedWorkspace: targetWorkspace.index(),
                monitor: currentMonitor,
                preMaxSize: preMaxSize,
                osdWorkspace: preInsertionIndex
            });

            this.tilingManager.tileWorkspaceWindows(targetWorkspace, null, currentMonitor);

            // OSD on the current workspace
            this.windowingManager.showWorkspaceSwitcher(currentWorkspace, currentMonitor);

            // Clear overflow flags after a settling delay
            this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                for (const w of otherWindows) {
                    WindowState.remove(w, 'movedByOverflow');
                }
                return GLib.SOURCE_REMOVE;
            }, 'resizeHandler_sacredDisplaceSettle');

            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_sacredEnterDebounce');
    }

    // Mirrors tryEnterSacred: also called from windowHandler's notify::fullscreen
    // as a backup, in case the size-change signal didn't fire for this exit either.
    // maximizedUndoInfo gets removed right after use, so calling this twice for the
    // same exit is safe - the second call just finds nothing left to undo.
    tryExitSacred(window) {
        // Born-maximized windows: don't set unmaximizing flag or try undo
        if (WindowState.get(window, 'openedMaximized')) {
            return;
        }
        WindowState.set(window, 'unmaximizing', true);
        const maxInfo = WindowState.get(window, 'maximizedUndoInfo');
        if (maxInfo) {
            Logger.log(`[SACRED-EXIT] Window ${window.get_id()} was unmaximized - attempting undo`);
            this.handleUnmaximizeUndo(window, maxInfo);
            WindowState.remove(window, 'maximizedUndoInfo');
        } else {
            // Window was never isolated (it was alone in its workspace), so there's
            // nothing to undo - just let the transition flags clear after it settles.
            const preferredSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
            if (preferredSize) {
                WindowState.set(window, 'targetRestoredSize', preferredSize);
            }
            this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                WindowState.remove(window, 'unmaximizing');
                WindowState.remove(window, 'targetRestoredSize');
                return GLib.SOURCE_REMOVE;
            }, 'resizeHandler_settleSoloUnmaximize');
        }
    }

    onSizeChanged = (_, win) => {
        const window = win.meta_window;
        if (!this._sizeChanged && !this.windowingManager.isExcluded(window)) {
            if (!this.windowingManager.isRelated(window)) return;

            // Windows pending in the evaluation queue haven't been processed yet, so ignore size changes
            if (WindowState.get(window, 'pendingInQueue')) return;

            const rect = window.get_frame_rect();
            if (rect.width <= constants.ANIMATION_DIFF_THRESHOLD || rect.height <= constants.ANIMATION_DIFF_THRESHOLD) return;

            if (WindowState.get(window, 'isSmartResizing') || WindowState.get(window, 'isReverseSmartResizing')) {
                Logger.log(`[GUARD-BLOCK] onSizeChanged short-circuited for ${window.get_id()} - isSmartResizing=${WindowState.get(window, 'isSmartResizing')} isReverseSmartResizing=${WindowState.get(window, 'isReverseSmartResizing')}`);
                this._sizeChanged = false;
                return;
            }

            // Detect client-side clamping after smart resize.
            // If actual size > target, the client enforced a larger minimum.
            const pendingSmartSize = WindowState.get(window, 'targetSmartResizeSize');
            if (pendingSmartSize) {
                if (rect.width > pendingSmartSize.width + 2 || rect.height > pendingSmartSize.height + 2) {
                    if (this._shouldRetryClamp(window, pendingSmartSize)) {
                        Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamped while still settling: target=${pendingSmartSize.width}×${pendingSmartSize.height}, actual=${rect.width}×${rect.height}; retrying once`);
                        WindowState.set(window, 'clampRetryTarget', { width: pendingSmartSize.width, height: pendingSmartSize.height });
                        const retryRect = window.get_frame_rect();
                        this._timeoutRegistry.add(constants.RESIZE_CLAMP_RETRY_DELAY_MS, () => {
                            if (isWindowAlive(window)) {
                                Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamp retry firing: requesting ${pendingSmartSize.width}×${pendingSmartSize.height}`);
                                window.move_resize_frame(false, retryRect.x, retryRect.y, pendingSmartSize.width, pendingSmartSize.height);
                            } else {
                                Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamp retry skipped; window gone`);
                            }
                            return GLib.SOURCE_REMOVE;
                        }, 'resizeHandler_clampRetry');
                        this._sizeChanged = false;
                        return;
                    }

                    // The retry (or the settle window for older ones) already gave the async
                    // resize its chance, so a frame still above target now is a genuine client
                    // minimum, not lag. Trust it instead of guessing from how far it shrank.
                    Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamped: target=${pendingSmartSize.width}×${pendingSmartSize.height}, actual=${rect.width}×${rect.height}`);
                    WindowState.set(window, 'targetSmartResizeSize', { width: rect.width, height: rect.height });
                    // Only the axis that stayed above target really clamped; the other reached
                    // target and shouldn't be pinned as a minimum.
                    if (rect.width > pendingSmartSize.width + 2) WindowState.set(window, 'actualMinWidth', rect.width);
                    if (rect.height > pendingSmartSize.height + 2) WindowState.set(window, 'actualMinHeight', rect.height);
                    WindowState.remove(window, 'clampRetryTarget');

                    // A window we just placed can clamp a few px against its own minimum.
                    // Rebalancing right away races the tiling pass that's still settling
                    // it and can kick it right back out, so give it a moment first.
                    const now = GLib.get_monotonic_time() / 1000;
                    if (!this._resizeGracePeriod || (now - this._resizeGracePeriod) >= constants.REVERSE_RESIZE_PROTECTION_MS) {
                        this._queueConstraintRebalance(window);
                    } else {
                        Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamp rebalance skipped; within grace period`);
                    }
                } else {
                    WindowState.set(window, 'targetSmartResizeSize', null);
                    WindowState.remove(window, 'clampRetryTarget');
                }
                this._sizeChanged = false;
                return;
            }

            // STATE MACHINE STAGE 2: Deferred Move Completion
            const originWorkspaceIndex = WindowState.get(window, 'isRestoringSacred');
            if (originWorkspaceIndex !== undefined) {
                // If the window is no longer sacred (maximized or fullscreen), it has finished resizing in place.
                if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
                    this.completeSacredReturn(window, originWorkspaceIndex);
                    this._sizeChanged = false;
                    return;
                }

                // If it's still maximized/fullscreen but moving, block size updates
                this._sizeChanged = false;
                return;
            }

            if (this.windowingManager.isMaximizedOrFullscreen(window)) {
                WindowState.remove(window, 'isEnteringSacred');
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
            const isManualResizeAction = this._currentGrabOp && isResizeGrabOp(this._currentGrabOp);

            // If constrained but dimensions differ significantly from Smart Resize target,
            // assume an external or ambient resize and lift the constraint.
            let userForcedResize = isManualResizeAction;
            if (!userForcedResize && isConstrained) {
                const target = WindowState.get(window, 'targetSmartResizeSize');
                if (target) {
                    const wDiff = Math.abs(rect.width - target.width);
                    const hDiff = Math.abs(rect.height - target.height);
                    if (wDiff > 10 || hDiff > 10) {
                        userForcedResize = true;
                        Logger.log(`Detected ambient/client-side resize for constrained window ${window.get_id()} (delta: ${wDiff}x${hDiff})`);
                    }
                }
            }

            // Mirrors savePreferredSize's guard: a born-maximized window mid-unmaximize can
            // report its still-fullscreen frame here before tiling shrinks it, baking it in
            // as preferredSize and making the window read as workspace-filling forever.
            const sizeWorkspace = window.get_workspace();
            const sizeMonitor = window.get_monitor();
            const sizeWorkArea = sizeWorkspace && sizeMonitor !== null && sizeMonitor !== undefined
                ? sizeWorkspace.get_work_area_for_monitor(sizeMonitor) : null;
            const isMonitorSized = sizeWorkArea && rect.width >= sizeWorkArea.width && rect.height >= sizeWorkArea.height;

            if (isMonitorSized) {
                Logger.log(`onSizeChanged: Rejected monitor-sized dimensions ${rect.width}x${rect.height} for ${window.get_id()}`);
            } else if (userForcedResize) {
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
                    WindowState.get(window, 'isRestoringSacred') ||
                    WindowState.get(window, 'openedMaximized') ||
                    WindowState.get(window, 'isMosaicResizing')) {
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

            const tileState = this.edgeTilingManager.getWindowState(window);
            const isEdgeTiled = tileState && tileState.zone !== TileZone.NONE;
            if (isEdgeTiled) return;

            this._sizeChanged = true;
            const workspace = window.get_workspace();
            const monitor = window.get_monitor();

            if (WindowState.get(window, 'movedByOverflow')) {
                this._sizeChanged = false;
                return;
            }

            if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
                const isManualResize = this._currentGrabOp && isResizeGrabOp(this._currentGrabOp);
                const windowId = window.get_id();
                const resizeNow = GLib.get_monotonic_time() / 1000;
                const isActiveResize = isManualResize ||
                    (this._lastResizeWindow === windowId && (resizeNow - this._lastResizeTime) < constants.RESIZE_SETTLE_DELAY_MS * 2);
                this._lastResizeWindow = windowId;
                this._lastResizeTime = resizeNow;

                if (isActiveResize) {
                    // Throttle: execute immediately, skip if too soon since last retile
                    if (this._lastResizeTileTime && (resizeNow - this._lastResizeTileTime) < 16) {
                        this._sizeChanged = false;
                        return;
                    }
                    this._lastResizeTileTime = resizeNow;

                    if (this._resizeDebounceTimeout) {
                        this._timeoutRegistry.remove(this._resizeDebounceTimeout);
                        this._resizeDebounceTimeout = null;
                    }

                    const canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                    const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                        .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
                    const isSolo = mosaicWindows.length <= 1;

                    // Block moves during smart resize to prevent expelling windows on revert.
                    const isSmartResizing = this.tilingManager._isSmartResizingBlocked;
                    // Skip ghost detection right after smart resize to prevent false positives from unsettled rects.
                    const hasUnsettledSmartResize = WindowState.get(window, 'targetSmartResizeSize') !== null;

                    if (!canFit && !this._resizeInOverflow && !isSolo && !isSmartResizing && !hasUnsettledSmartResize) {
                        if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
                            this._sizeChanged = false;
                            return;
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

                        // Shrinking the dragged window can free up room for a sibling
                        // miniature mid-drag. The overflow path only checks the inverse.
                        if (!this._resizeInOverflow && this._ext.windowHandler) {
                            this._ext.windowHandler._tryAutoRestoreMiniature(mosaicWindows, workspace, monitor);
                        }
                    }

                    this._sizeChanged = false;
                    return;
                }

                const canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
                const now = GLib.get_monotonic_time() / 1000;
                if (this._resizeGracePeriod && (now - this._resizeGracePeriod) < constants.REVERSE_RESIZE_PROTECTION_MS) {
                    this._sizeChanged = false;
                    return;
                }

                if (WindowState.get(window, 'isSmartResizing') || this.tilingManager._isSmartResizingBlocked) {
                    this._sizeChanged = false;
                    return;
                }

                // Skip tiling while the evaluation queue is processing, since it handles its own tiling
                if (this._ext.windowHandler && this._ext.windowHandler.isEvaluatingQueue) {
                    this._sizeChanged = false;
                    return;
                }

                // draw() repositions windows via move_resize_frame during a drag; those geometry
                // changes must not trigger overflow ejection. The drag handler owns all overflow decisions.
                if (this.tilingManager.isDragging) {
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
                        const oldWorkspace = workspace;
                        this.windowingManager.moveOversizedWindow(window).then(newWorkspace => {
                            if (newWorkspace) {
                                this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, monitor, false);
                            }
                        });
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

    destroy() {
        if (this._resizeDebounceTimeout) {
            this._timeoutRegistry.remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }
        this._resizeInOverflow = false;
        this._resizeOverflowWindow = null;
        this._sizeChanged = false;
        this._resizeGracePeriod = null;
        this._lastResizeWindow = null;
        this._lastResizeTime = 0;
        this._lastResizeTileTime = 0;
        this._constraintRebalanceQueued = false;
        this._constraintRebalanceCount = 0;
        this._ext = null;
    }

    // Mutter can skip firing size-changed on a fast toggle, leaving the window
    // stuck on the isolated workspace if nothing else nudges it.
    scheduleSacredRestoreSafety(window, originWorkspaceIndex) {
        this._timeoutRegistry.add(constants.SACRED_RESTORE_SAFETY_TIMEOUT_MS, () => {
            if (WindowState.get(window, 'isRestoringSacred') === originWorkspaceIndex) {
                Logger.log(`[SACRED-TIMEOUT] Window ${window.get_id()} never confirmed unmaximize - forcing deferred move`);
                this.completeSacredReturn(window, originWorkspaceIndex);
            }
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_sacredRestoreSafety');
    }

    // Clearing the flag below makes this safe to call twice, since the real
    // signal and the timeout above can both end up calling it.
    completeSacredReturn(window, originWorkspaceIndex) {
        if (WindowState.get(window, 'isRestoringSacred') !== originWorkspaceIndex) return;

        Logger.log(`[SACRED-RETURN] Window ${window.get_id()} finished unmaximize. Tiling on WS ${originWorkspaceIndex}.`);

        const workspaceManager = global.workspace_manager;
        if (originWorkspaceIndex < 0 || originWorkspaceIndex >= workspaceManager.get_n_workspaces()) {
            WindowState.remove(window, 'isRestoringSacred');
            WindowState.remove(window, 'sacredDisplacedWorkspace');
            return;
        }

        const originWS = workspaceManager.get_workspace_by_index(originWorkspaceIndex);
        const monitor = window.get_monitor();
        const displacedIndex = WindowState.get(window, 'sacredDisplacedWorkspace');

        // CLEAR FLAGS IMMEDIATELY to prevent double-move
        WindowState.remove(window, 'isRestoringSacred');
        WindowState.remove(window, 'sacredDisplacedWorkspace');

        afterWorkspaceSwitch(() => {
            Logger.log(`Triggering tiling in workspace ${originWorkspaceIndex}`);

            this.tilingManager._isSmartResizingBlocked = true;
            try {
                this.tilingManager.tileWorkspaceWindows(originWS, window, monitor, true);
            } finally {
                this.tilingManager._isSmartResizingBlocked = false;
            }

            // Tile displaced workspace if it still has windows
            if (displacedIndex !== undefined && displacedIndex >= 0 && displacedIndex < workspaceManager.get_n_workspaces()) {
                const displacedWS = workspaceManager.get_workspace_by_index(displacedIndex);
                if (displacedWS && isWorkspaceAlive(displacedWS, workspaceManager)) {
                    this.tilingManager.tileWorkspaceWindows(displacedWS, null, monitor, true);
                }
            }

            this._resizeGracePeriod = GLib.get_monotonic_time() / 1000;

            // Clear unmaximizing flags after a settle period
            this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                WindowState.remove(window, 'unmaximizing');
                WindowState.remove(window, 'isConstrainedByMosaic');
                WindowState.remove(window, 'targetRestoredSize');
                WindowState.remove(window, 'openedMaximized');
                return GLib.SOURCE_REMOVE;
            }, 'resizeHandler_settleRestoreSacred');
        }, this._timeoutRegistry);
    }

    async handleUnmaximizeUndo(window, maxInfo) {
        const { originalWorkspace: origIndex, preMaxSize, displacedWorkspace, osdWorkspace } = maxInfo;
        const workspaceManager = global.workspace_manager;
        const windowId = window.get_id();

        if (preMaxSize) {
            WindowState.set(window, 'openingSize', preMaxSize);
            WindowState.set(window, 'preferredSize', preMaxSize);
            WindowState.set(window, 'targetRestoredSize', preMaxSize);
        }

        // completeSacredReturn reads this to tile the displaced workspace
        if (displacedWorkspace !== undefined) {
            WindowState.set(window, 'sacredDisplacedWorkspace', displacedWorkspace);
        }

        // Move displaced windows back BEFORE unmaximizing so they're visible
        // during the shrink animation instead of popping in afterward.
        if (displacedWorkspace !== undefined && displacedWorkspace >= 0 && displacedWorkspace < workspaceManager.get_n_workspaces()) {
            const displacedWS = workspaceManager.get_workspace_by_index(displacedWorkspace);
            if (displacedWS && isWorkspaceAlive(displacedWS, workspaceManager)) {
                const displacedWindows = displacedWS.list_windows()
                    .filter(w => !this.windowingManager.isExcluded(w));
                const targetWS = (origIndex >= 0 && origIndex < workspaceManager.get_n_workspaces())
                    ? workspaceManager.get_workspace_by_index(origIndex)
                    : null;
                if (!targetWS) {
                    Logger.log(`[SACRED] Origin workspace ${origIndex} no longer exists, moving displaced windows to current`);
                }
                for (const w of displacedWindows) {
                    WindowState.set(w, 'movedByOverflow', true);
                    w.change_workspace(targetWS || window.get_workspace());
                }
                // Clear overflow flags after a settling delay
                this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                    for (const w of displacedWindows) {
                        WindowState.remove(w, 'movedByOverflow');
                    }
                    return GLib.SOURCE_REMOVE;
                }, 'resizeHandler_sacredReturnSettle');
            }
        }


        window.unmaximize();
        WindowState.set(window, 'unmaximizing', true);
        WindowState.set(window, 'isConstrainedByMosaic', true);

        // Show workspace OSD at the same visual position as when maximized
        const osdWS = osdWorkspace !== undefined
            ? global.workspace_manager.get_workspace_by_index(osdWorkspace)
            : window.get_workspace();
        if (osdWS) {
            this.windowingManager.showWorkspaceSwitcher(osdWS, window.get_monitor());
        }

        // Stage 2 (completeSacredReturn) handles final tiling of all windows.
        WindowState.set(window, 'isRestoringSacred', origIndex);
        this.scheduleSacredRestoreSafety(window, origIndex);
        Logger.log(`[SACRED-DEFER] Window ${windowId} unmaximizing in place; displaced windows already returned`);
    }
} );
