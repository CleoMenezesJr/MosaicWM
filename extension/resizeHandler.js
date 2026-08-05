// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Window resize operations and maximize undo

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Logger from './logger.js';
import { afterWorkspaceSwitch, afterAnimations, monotonicNow } from './timing.js';
import * as WindowState from './windowState.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import { isResizeGrabOp } from './grabOps.js';
import { isWorkspaceAlive, isWindowAlive } from './liveness.js';
import { MosaicModel } from './mosaicModel.js';

import GObject from 'gi://GObject';

export const ResizeHandler = GObject.registerClass({
    GTypeName: 'MosaicResizeHandler',
}, class ResizeHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;

        this._sizeChanged = false;
        this._resizeOverflowWindow = null;
        this._resizeInOverflow = false;
        this._resizeGracePeriod = null;
        this._resizeDebounceTimeout = null;
        this._lastResizeWindow = null;
        this._lastResizeTime = 0;
    }

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

    // Once the client had its chance, a frame still above target is a genuine minimum.
    _commitClampedSize(window, pendingSmartSize, rect) {
        Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamped: target=${pendingSmartSize.width}×${pendingSmartSize.height}, actual=${rect.width}×${rect.height}`);
        WindowState.set(window, 'targetSmartResizeSize', { width: rect.width, height: rect.height });
        // Only the axis that stayed above target really clamped; the other reached
        // target and shouldn't be pinned as a minimum.
        if (rect.width > pendingSmartSize.width + 2) WindowState.set(window, 'actualMinWidth', rect.width);
        if (rect.height > pendingSmartSize.height + 2) WindowState.set(window, 'actualMinHeight', rect.height);
        this._disarmClampVerification(window);

        // A window we just placed can clamp a few px against its own minimum.
        // Rebalancing right away races the tiling pass that's still settling
        // it and can kick it right back out, so give it a moment first.
        const now = monotonicNow();
        if (!this._resizeGracePeriod || (now - this._resizeGracePeriod) >= constants.REVERSE_RESIZE_PROTECTION_MS) {
            this._queueConstraintRebalance(window);
        } else {
            Logger.log(`[SMART RESIZE] Window ${window.get_id()} clamp rebalance skipped; within grace period`);
        }
    }

    // A frame above target shortly after window creation might just be the client
    // still negotiating its own size, not a real minimum, so hold the commit.
    _shouldDeferClampCommit(window) {
        // The frame settles relative to when the target was applied, not when the window was born;
        // an old window handed a fresh target is still mid-shrink, not clamping.
        const setAt = WindowState.get(window, 'targetSmartResizeSetAt');
        if (setAt !== undefined && (monotonicNow() - setAt) < constants.RESIZE_CLAMP_SETTLE_WINDOW_MS)
            return true;
        const addedTime = WindowState.get(window, 'addedTime');
        if (addedTime === undefined) return false;
        return (monotonicNow() - addedTime) < constants.RESIZE_CLAMP_SETTLE_WINDOW_MS;
    }

    // Only the tiler sends geometry; a silent client gets its frame committed
    // as truth once the over-target signals go quiet.
    _armClampVerification(window, pendingSmartSize) {
        this._disarmClampVerification(window);

        const verifyId = this._timeoutRegistry.add(constants.RESIZE_CLAMP_VERIFY_DELAY_MS, () => {
            WindowState.remove(window, 'clampVerifyId');
            if (!isWindowAlive(window)) return GLib.SOURCE_REMOVE;

            // Whatever resolved or replaced this target meanwhile owns the state now.
            const current = WindowState.get(window, 'targetSmartResizeSize');
            if (!current || current.width !== pendingSmartSize.width || current.height !== pendingSmartSize.height)
                return GLib.SOURCE_REMOVE;

            const rect = window.get_frame_rect();
            if (rect.width > pendingSmartSize.width + 2 || rect.height > pendingSmartSize.height + 2) {
                Logger.log(`[SMART RESIZE] Window ${window.get_id()} never applied ${pendingSmartSize.width}×${pendingSmartSize.height}; committing frame ${rect.width}×${rect.height}`);
                this._commitClampedSize(window, pendingSmartSize, rect);
            } else {
                WindowState.set(window, 'targetSmartResizeSize', null);
            }
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_clampVerify');
        WindowState.set(window, 'clampVerifyId', verifyId);
    }

    _disarmClampVerification(window) {
        const verifyId = WindowState.get(window, 'clampVerifyId');
        if (verifyId === undefined) return;
        this._timeoutRegistry.remove(verifyId);
        WindowState.remove(window, 'clampVerifyId');
    }

    onResizeBegin(window, grabpo) {
        this._resizeInOverflow = false;
        this._lastResizeTileTime = 0;
        this.animationsManager.setResizingWindow(window.get_id());

        // Always clear pending resize targets so manual resize takes precedence
        WindowState.set(window, 'targetSmartResizeSize', null);
        WindowState.remove(window, 'targetRestoredSize');
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

        if (isEdgeTiled) {
            this._fixEdgeTiledSizesOnResizeEnd(window, tileState.zone, grabpo);
        }

        if (this._resizeDebounceTimeout) {
            this._timeoutRegistry.remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }

        this._resizeGracePeriod = monotonicNow();

        if (this._resizeInOverflow || this._resizeOverflowWindow === window) {
            this._finishOverflowResize(window);
        } else if (!isEdgeTiled && !skipTiling) {
            this.tilingManager.savePreferredSize(window);
            this.tilingManager.invalidateLayoutCache();
            this.tilingManager.tileWorkspaceWindows(window.get_workspace(), null, window.get_monitor(), true);
        }

        // Clear resizing state AFTER final retile to prevent animation jiggle on drop
        this.animationsManager.setResizingWindow(null);
    }

    _fixEdgeTiledSizesOnResizeEnd(window, zone, grabpo) {
        if (zone === TileZone.LEFT_FULL || zone === TileZone.RIGHT_FULL) {
            Logger.log(`Resize ended (grabpo=${grabpo}) for FULL edge-tiled window - fixing final sizes`);
            const adjacentWindow = this.edgeTilingManager._getAdjacentWindow(window, window.get_workspace(), window.get_monitor(), zone);
            if (adjacentWindow) {
                this.edgeTilingManager.fixTiledPairSizes(window, zone);
            } else {
                this.edgeTilingManager.fixMosaicAfterEdgeResize(window, zone);
            }
        } else if (this.edgeTilingManager.isQuarterZone(zone)) {
            Logger.log(`Resize ended (grabpo=${grabpo}) for QUARTER edge-tiled window - fixing final sizes`);
            this.edgeTilingManager.fixQuarterPairSizes(window, zone);
        }
    }

    _finishOverflowResize(window) {
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

    // Isolates a maximized/fullscreen window to its own workspace, after a short
    // debounce so a quick toggle back never even starts the move. Some apps'
    // fullscreen doesn't reliably trigger window_manager's size-change signal, so
    // this is also called from windowHandler's notify::fullscreen as a backup -
    // the pending flag below makes calling it twice for the same transition safe.
    // size-change fires BEFORE window-created for new windows, so a window with no
    // preferredSize/openingSize hasn't been through onWindowCreated yet; if it's already
    // maximized it was born that way and skips isolation.
    _detectBornMaximized(window) {
        if (!WindowState.get(window, 'preferredSize') &&
            !WindowState.get(window, 'openingSize') &&
            this.windowingManager.isMaximizedOrFullscreen(window)) {
            WindowState.set(window, 'openedMaximized', true);
            Logger.log(`tryEnterSacred: Detected born-maximized window ${window.get_id()} - skipping isolation`);
            return true;
        }
        return false;
    }

    tryEnterSacred(window) {
        if (this._detectBornMaximized(window)) return;

        // Born-maximized guard (from onWindowCreated, for subsequent maximize events)
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

        Logger.log('[SACRED-ENTER] User entering sacred state - debouncing before moving to new workspace');
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

            Logger.log('[SACRED-ENTER] Still in sacred state after debounce - moving to new workspace');
            const originalWorkspaceIndex = currentWorkspace.index();

            this.windowingManager.moveOversizedWindow(window).then((newWorkspace) => {
                if (newWorkspace) {
                    WindowState.set(window, 'maximizedUndoInfo', {
                        originalWorkspace: originalWorkspaceIndex,
                        currentWorkspace: newWorkspace.index(),
                        monitor: currentMonitor,
                        preMaxSize: preMaxSize
                    });
                    // The companion only holds that half because this window was tiled beside it.
                    this.edgeTilingManager.releaseAutoTileDependents(window);
                    this.edgeTilingManager.expandQuarterPartner(window);
                    this.tilingManager.tileWorkspaceWindows(currentWorkspace, null, currentMonitor, false);
                }
            }).catch(e => Logger.error(`Sacred isolation failed: ${e}`));
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_sacredEnterDebounce');
    }

    // Mirrors tryEnterSacred: also called from windowHandler's notify::fullscreen
    // as a backup, in case the size-change signal didn't fire for this exit either.
    // maximizedUndoInfo gets removed right after use, so calling this twice for the
    // same exit is safe; the second call just finds nothing left to undo.
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
            // nothing to undo; just let the transition flags clear after it settles.
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
        // The latch is only false when no retile of ours is in flight; excluded windows never tile.
        if (this._sizeChanged || this.windowingManager.isExcluded(window)) return;

        const rect = window.get_frame_rect();
        if (this._ignoreSizeChange(window, rect)) return;

        if (this._handleClampAfterResize(window, rect)) return;
        if (this._handleSacredResizePhase(window)) return;
        if (this._handleMaxUnmaxResize(window)) return;

        this._liftStaleMinConstraint(window, rect);

        const ctx = this._computeResizeContext(window, rect);
        this._updatePreferredSizeFromResize(window, rect, ctx);
        WindowState.remove(window, 'isEnteringSacred');

        if (this._shouldSkipRetileAfterResize(window, ctx)) return;

        this._retileAfterSizeChange(window);
    };

    _ignoreSizeChange(window, rect) {
        if (!this.windowingManager.isRelated(window)) return true;
        // Windows pending in the evaluation queue haven't been processed yet, so ignore size changes
        if (WindowState.get(window, 'pendingInQueue')) return true;
        if (rect.width <= constants.ANIMATION_DIFF_THRESHOLD || rect.height <= constants.ANIMATION_DIFF_THRESHOLD) return true;

        if (WindowState.get(window, 'isSmartResizing') || WindowState.get(window, 'isReverseSmartResizing')) {
            Logger.log(`[GUARD-BLOCK] onSizeChanged short-circuited for ${window.get_id()} - isSmartResizing=${WindowState.get(window, 'isSmartResizing')} isReverseSmartResizing=${WindowState.get(window, 'isReverseSmartResizing')}`);
            this._sizeChanged = false;
            return true;
        }
        return false;
    }

    // Detect client-side clamping after smart resize. Returns true when the event is consumed
    // here; false lets it fall through (no pending target, or a sacred restore still waiting).
    _handleClampAfterResize(window, rect) {
        const pendingSmartSize = WindowState.get(window, 'targetSmartResizeSize');
        if (!pendingSmartSize) return false;

        // Actual size above target means the client enforced a larger minimum.
        if (rect.width > pendingSmartSize.width + 2 || rect.height > pendingSmartSize.height + 2) {
            if (this._shouldDeferClampCommit(window)) {
                // A young client often acks a beat late, so this frame is stale
                // rather than a real minimum; the verification settles it.
                Logger.log(`[SMART RESIZE] Window ${window.get_id()} above target while settling: target=${pendingSmartSize.width}×${pendingSmartSize.height}, actual=${rect.width}×${rect.height}; deferring to verification`);
                this._armClampVerification(window, pendingSmartSize);
                this._sizeChanged = false;
                return true;
            }

            this._commitClampedSize(window, pendingSmartSize, rect);
        } else {
            // A frame observed below a recorded minimum disproves it, so drop the pin.
            const minW = WindowState.get(window, 'actualMinWidth');
            const minH = WindowState.get(window, 'actualMinHeight');
            if ((minW && rect.width < minW - 2) || (minH && rect.height < minH - 2)) {
                WindowState.remove(window, 'actualMinWidth');
                WindowState.remove(window, 'actualMinHeight');
            }
            WindowState.set(window, 'targetSmartResizeSize', null);
            this._disarmClampVerification(window);
        }

        // A sacred restore waits on this same size-changed, and the resize that just
        // landed is the one it ordered itself. Returning here would strand it until
        // the safety timeout.
        if (WindowState.get(window, 'isRestoringSacred') === undefined) {
            this._sizeChanged = false;
            return true;
        }
        return false;
    }

    _handleSacredResizePhase(window) {
        const originWorkspaceIndex = WindowState.get(window, 'isRestoringSacred');
        if (originWorkspaceIndex === undefined) return false;

        // No longer sacred (unmaximized) means it finished resizing in place; otherwise it's
        // still maximized but moving. Either way we block further size handling here.
        if (!this.windowingManager.isMaximizedOrFullscreen(window)) {
            this.completeSacredReturn(window, originWorkspaceIndex);
        }
        this._sizeChanged = false;
        return true;
    }

    _handleMaxUnmaxResize(window) {
        if (this.windowingManager.isMaximizedOrFullscreen(window)) {
            WindowState.remove(window, 'isEnteringSacred');
            this._sizeChanged = false;
            return true;
        }

        if (WindowState.get(window, 'unmaximizing')) {
            this._sizeChanged = false;
            return true;
        }
        return false;
    }

    // A frame well above a recorded minimum disproves it (the window clearly can go bigger).
    _liftStaleMinConstraint(window, rect) {
        if (WindowState.get(window, 'actualMinWidth') && rect.width > WindowState.get(window, 'actualMinWidth') + 20) {
            WindowState.remove(window, 'actualMinWidth');
            WindowState.remove(window, 'actualMinHeight');
        }
    }

    _computeResizeContext(window, rect) {
        const isConstrained = WindowState.get(window, 'isConstrainedByMosaic');
        const userForcedResize = this._detectUserForcedResize(window, rect, isConstrained);
        const isMonitorSized = this._isMonitorSizedFrame(window, rect);
        const { isEaseEcho, clientOwnedSize } = this._classifyEase(window, rect);
        return { isConstrained, userForcedResize, isMonitorSized, isEaseEcho, clientOwnedSize };
    }

    // Manual grab, or a constrained window whose frame drifted far from its Smart Resize
    // target (an ambient/client-side resize), both count as the user forcing the size.
    _detectUserForcedResize(window, rect, isConstrained) {
        if (this._currentGrabOp && isResizeGrabOp(this._currentGrabOp)) return true;
        if (!isConstrained) return false;

        const target = WindowState.get(window, 'targetSmartResizeSize');
        if (!target) return false;

        const wDiff = Math.abs(rect.width - target.width);
        const hDiff = Math.abs(rect.height - target.height);
        if (wDiff > 10 || hDiff > 10) {
            Logger.log(`Detected ambient/client-side resize for constrained window ${window.get_id()} (delta: ${wDiff}x${hDiff})`);
            return true;
        }
        return false;
    }

    // A born-maximized window mid-unmaximize can report its still-fullscreen frame here before
    // tiling shrinks it; treating that as preferredSize makes it read as workspace-filling forever.
    _isMonitorSizedFrame(window, rect) {
        const sizeWorkspace = window.get_workspace();
        const sizeMonitor = window.get_monitor();
        const sizeWorkArea = sizeWorkspace && sizeMonitor !== null && sizeMonitor !== undefined
            ? sizeWorkspace.get_work_area_for_monitor(sizeMonitor) : null;
        return sizeWorkArea && rect.width >= sizeWorkArea.width && rect.height >= sizeWorkArea.height;
    }

    // An ease echoes back the size the layout picked, which says nothing about what the window
    // wants. Anything else arriving mid-ease is the client's own size. No target means no echo.
    _classifyEase(window, rect) {
        const easeTarget = WindowState.get(window, 'isMosaicResizing')
            ? this.animationsManager.getAnimatingTarget(window.get_id())
            : null;
        const isEaseEcho = !!easeTarget &&
            Math.abs(rect.width - easeTarget.width) <= constants.EASE_TARGET_TOLERANCE_PX &&
            Math.abs(rect.height - easeTarget.height) <= constants.EASE_TARGET_TOLERANCE_PX;
        return { isEaseEcho, clientOwnedSize: !!easeTarget && !isEaseEcho };
    }

    _updatePreferredSizeFromResize(window, rect, { isConstrained, userForcedResize, isMonitorSized, clientOwnedSize }) {
        const edgeState = this.edgeTilingManager.getWindowState(window);
        const isEdgeTiledNow = edgeState && edgeState.zone !== TileZone.NONE;

        if (isEdgeTiledNow) {
            // An edge tile's frame comes from its zone, so preferredSize stays the pre-tiling value.
            Logger.log(`onSizeChanged: preferredSize preserved for edge-tiled ${window.get_id()}`);
        } else if (isMonitorSized) {
            Logger.log(`onSizeChanged: Rejected monitor-sized dimensions ${rect.width}x${rect.height} for ${window.get_id()}`);
        } else if (userForcedResize) {
            WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
            // The user dragged the edge, so the model takes that as the new intent rather
            // than reapplying a target they just overrode.
            MosaicModel.learn(window, rect);
            if (isConstrained) {
                WindowState.set(window, 'isConstrainedByMosaic', false);
                Logger.log(`Manual resize for ${window.get_id()} - cleared constraint`);
            }
            Logger.log(`Preferred size updated (manual): ${window.get_id()} = ${rect.width}x${rect.height}`);
        } else if (!isConstrained) {
            this._maybeSaveAmbientPreferredSize(window, rect, clientOwnedSize);
        }
    }

    _maybeSaveAmbientPreferredSize(window, rect, clientOwnedSize) {
        // Not constrained and not manual: an initial placement or a legitimate external
        // resize, but still guarded against transition states that report a transient size.
        if (this._inResizeTransition(window, clientOwnedSize)) {
            Logger.log(`onSizeChanged: Save blocked by transition flag for ${window.get_id()}`);
            return;
        }

        // Past the transition guard, whatever lands below is a size the client actually
        // settled on, so the model needs to match it or it keeps steering toward a stale slot.
        const currentPreferredSize = WindowState.get(window, 'preferredSize');
        if (currentPreferredSize) {
            const widthDiff = Math.abs(rect.width - currentPreferredSize.width);
            const heightDiff = Math.abs(rect.height - currentPreferredSize.height);
            if (widthDiff > constants.ANIMATION_DIFF_THRESHOLD || heightDiff > constants.ANIMATION_DIFF_THRESHOLD) {
                WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
                MosaicModel.learn(window, rect);
                Logger.log(`Preferred size updated (ambient): ${window.get_id()} = ${rect.width}x${rect.height}`);
            }
        } else if (WindowState.get(window, 'geometryReady')) {
            WindowState.set(window, 'preferredSize', { width: rect.width, height: rect.height });
            MosaicModel.learn(window, rect);
            Logger.log(`Initial preferred size saved: ${window.get_id()} = ${rect.width}x${rect.height}`);
        }
    }

    _inResizeTransition(window, clientOwnedSize) {
        return WindowState.get(window, 'isEnteringSacred') ||
            WindowState.get(window, 'unmaximizing') ||
            WindowState.get(window, 'isRestoringSacred') ||
            WindowState.get(window, 'openedMaximized') ||
            (WindowState.get(window, 'isMosaicResizing') && !clientOwnedSize);
    }

    _shouldSkipRetileAfterResize(window, ctx) {
        if (this._skipNextTiling === window.get_id()) return true;

        // The ease owns the actor and its echo tells us nothing new; a client-picked size
        // must reach the layout, or it keeps placing the window at a size it doesn't have.
        if (ctx.isEaseEcho) {
            this._sizeChanged = false;
            return true;
        }

        // A new window commits its first size before the arrival pipeline places it, and this
        // global handler sees it ahead of the queue; the arrival evaluation runs the same pass.
        if (WindowState.get(window, 'arrivalPending')) {
            this._sizeChanged = false;
            return true;
        }

        const tileState = this.edgeTilingManager.getWindowState(window);
        return !!(tileState && tileState.zone !== TileZone.NONE);
    }

    // The latch (_sizeChanged) blocks re-entry while our own tileWorkspaceWindows below
    // fires more size-changes; every exit clears it.
    _retileAfterSizeChange(window) {
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
            const resizeNow = monotonicNow();
            const isActiveResize = isManualResize ||
                (this._lastResizeWindow === windowId && (resizeNow - this._lastResizeTime) < constants.RESIZE_SETTLE_DELAY_MS * 2);
            this._lastResizeWindow = windowId;
            this._lastResizeTime = resizeNow;

            if (isActiveResize) {
                this._retileDuringActiveResize(window, workspace, monitor, resizeNow);
                this._sizeChanged = false;
                return;
            }

            if (this._retileAfterSettledResize(window, workspace, monitor)) return;
        }

        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
        this._sizeChanged = false;
    }

    _retileDuringActiveResize(window, workspace, monitor, resizeNow) {
        // Throttle: execute immediately, skip if too soon since last retile
        if (this._lastResizeTileTime && (resizeNow - this._lastResizeTileTime) < 16) {
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
            this._enterResizeGhostMode(window, workspace, monitor);
            return;
        }

        this._recoverAndTileDuringResize(window, workspace, monitor, mosaicWindows, canFit);
    }

    _enterResizeGhostMode(window, workspace, monitor) {
        if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
            return;
        }

        // GHOST MODE: Reduce opacity to signal that the window no longer fits.
        this._resizeInOverflow = true;
        this._resizeOverflowWindow = window;
        const actor = window.get_compositor_private();
        if (actor) actor.opacity = 128;
        Logger.log(`Resize overflow detected for window ${window.get_id()} - enabling ghost mode`);
        this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true, false);
    }

    _recoverAndTileDuringResize(window, workspace, monitor, mosaicWindows, canFit) {
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

    // Returns true when it fully handled the event (caller must stop); false to fall through
    // to the final catch-all retile.
    _retileAfterSettledResize(window, workspace, monitor) {
        const canFit = this.tilingManager.canFitWindow(window, workspace, monitor);
        const now = monotonicNow();

        if (this._settledResizeShouldSkip(window, now)) {
            this._sizeChanged = false;
            return true;
        }

        if (this._resolveSettledOverflow(window, workspace, monitor, canFit)) {
            return true;
        }

        // Throttle to avoid excessive calculations during smooth resizing
        if (canFit && this._lastTileTime && (now - this._lastTileTime < 30)) {
            this._sizeChanged = false;
            return true;
        }
        if (canFit) this._lastTileTime = now;

        return false;
    }

    // Returns true when it ejected the window (caller stops). A window that no longer fits
    // and isn't the last one gets moved out; one that recovered clears its overflow claim.
    _resolveSettledOverflow(window, workspace, monitor, canFit) {
        const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
        const isSolo = mosaicWindows.length <= 1;

        if (!canFit && !isSolo) {
            if (this._resizeOverflowWindow !== window &&
                this._ejectOversizedOnResize(window, workspace, monitor)) {
                return true;
            }
        } else if (canFit && this._resizeOverflowWindow === window) {
            this._resizeOverflowWindow = null;
        }
        return false;
    }

    // Reasons a settled-resize retile is a no-op: still in the reverse-resize grace window,
    // a smart resize owns the geometry, the arrival queue or a drag is already tiling, or an
    // edge-tile exit is restoring full size into a tight mosaic (must miniaturize, not eject).
    _settledResizeShouldSkip(window, now) {
        if (this._resizeGracePeriod && (now - this._resizeGracePeriod) < constants.REVERSE_RESIZE_PROTECTION_MS) {
            return true;
        }
        if (WindowState.get(window, 'isSmartResizing') || this.tilingManager._isSmartResizingBlocked) {
            return true;
        }
        if (this._ext.windowHandler && this._ext.windowHandler.isEvaluatingQueue) {
            return true;
        }
        if (this.tilingManager.isDragging) {
            return true;
        }
        if (this._isEdgeTileRestoreSettling(now)) {
            return true;
        }
        return false;
    }

    // The drag flag and the edge-tiling stamp both mean the same thing here, just raised by
    // different callers (mouse drag vs. every removeTile caller including the keyboard path).
    _isEdgeTileRestoreSettling(now) {
        return this._ext.dragHandler?._restoringFromEdgeTile ||
            this.edgeTilingManager.isRestoringFromEdgeTile(now);
    }

    // Returns true when the window was ejected (or the attempt was aborted), so the caller stops.
    _ejectOversizedOnResize(window, workspace, monitor) {
        if (WindowState.get(window, 'waitingForGeometry') || !WindowState.get(window, 'geometryReady')) {
            this._sizeChanged = false;
            return true;
        }

        if (this._ext.windowHandler && this._ext.windowHandler.isWorkspaceLocked(workspace)) {
            this._sizeChanged = false;
            return true;
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
        return true;
    }

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

        Logger.log(`[SACRED-MOVE] Window ${window.get_id()} finished in-place resize. Moving to origin workspace ${originWorkspaceIndex}.`);

        const workspaceManager = global.workspace_manager;
        if (originWorkspaceIndex < 0 || originWorkspaceIndex >= workspaceManager.get_n_workspaces()) {
            WindowState.remove(window, 'isRestoringSacred');
            WindowState.remove(window, 'sacredFitConfirmed');
            WindowState.remove(window, 'pendingMiniaturesForReturn');
            return;
        }

        const originWS = workspaceManager.get_workspace_by_index(originWorkspaceIndex);
        const monitor = window.get_monitor();
        const oldWorkspace = window.get_workspace();
        // handleUnmaximizeUndo sets this once it already checked the window
        // fits, so the tile pass below doesn't second-guess it as overflow.
        const fitConfirmed = WindowState.get(window, 'sacredFitConfirmed') === true;
        const pendingMiniatures = WindowState.get(window, 'pendingMiniaturesForReturn') || [];

        window.change_workspace(originWS);
        originWS.activate(global.get_current_time());
        this.windowingManager.showWorkspaceSwitcher(originWS, monitor);

        // prevent double-move
        WindowState.remove(window, 'isRestoringSacred');
        WindowState.remove(window, 'sacredFitConfirmed');
        WindowState.remove(window, 'pendingMiniaturesForReturn');

        afterWorkspaceSwitch(() => {
            Logger.log(`Triggering tiling in destination workspace ${originWorkspaceIndex}`);
            this.tilingManager._isSmartResizingBlocked = true;
            try {
                this.tilingManager._pendingMiniatureWindows = pendingMiniatures;
                this.tilingManager.tileWorkspaceWindows(originWS, window, monitor, fitConfirmed);
            } finally {
                this.tilingManager._isSmartResizingBlocked = false;
            }
            if (isWorkspaceAlive(oldWorkspace, workspaceManager)) {
                this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, monitor, true);
            }

            // The exile dissolved whatever this window was paired with, so reclaiming
            // its half (or its quarter) has to put that pairing back together.
            this.edgeTilingManager.tryPairMosaicIntoOppositeHalf(window);
            this.edgeTilingManager.tryRestoreQuarterPartner(window);

            // Same clamp protection as above, so this window doesn't get
            // rebalanced right after it just landed.
            this._resizeGracePeriod = monotonicNow();

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
            this._undoOnSameWorkspace(window, currentWorkspace, monitor, preMaxSize);
            return;
        }

        if (preMaxSize) {
            WindowState.set(window, 'preferredSize', preMaxSize);
        }

        // Its zone is reserved, so the fit below would shrink the neighbours for room it never takes.
        if (this.edgeTilingManager.getWindowState(window)?.zone) {
            this._deferSacredReturn(window, origIndex, preMaxSize, false, []);
            return;
        }

        const { canFit, resizeNeeded, pendingMiniatures } =
            this._tryFitForUndo(window, targetWorkspace, monitor, preMaxSize);

        if (!canFit) {
            Logger.log(`[SACRED-STAY] handleUnmaximizeUndo: Window ${windowId} unable to fit even with Smart Resize - staying in current workspace`);
            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor);
            return;
        }

        this._deferSacredReturn(window, origIndex, preMaxSize, resizeNeeded, pendingMiniatures);
    }

    _undoOnSameWorkspace(window, currentWorkspace, monitor, preMaxSize) {
        Logger.log(`handleUnmaximizeUndo: Window ${window.get_id()} unmaximized on SAME workspace - tiling immediately`);
        WindowState.set(window, 'unmaximizing', true);
        if (preMaxSize) {
            WindowState.set(window, 'targetRestoredSize', preMaxSize);
        }

        this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor, true);

        this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS + 100, () => {
            WindowState.remove(window, 'unmaximizing');
            WindowState.remove(window, 'targetRestoredSize');
            return GLib.SOURCE_REMOVE;
        }, 'resizeHandler_settleUnmaximizeSame');
    }

    // Natural fit first, then Smart Resize as a fallback. On success the pending miniatures
    // are stashed early because intermediate tile passes need to treat them as pending too.
    _tryFitForUndo(window, targetWorkspace, monitor, preMaxSize) {
        if (this.tilingManager.canFitWindow(window, targetWorkspace, monitor, true, preMaxSize)) {
            return { canFit: true, resizeNeeded: false, pendingMiniatures: [] };
        }

        Logger.log(`handleUnmaximizeUndo: Window ${window.get_id()} doesn't fit normally - attempting Smart Resize fit`);
        const existingWindows = targetWorkspace.list_windows().filter(w => !this.windowingManager.isExcluded(w));
        // Pass window as focused override: preMaxSize is its ceiling, so it won't be miniaturized.
        const fitResult = this.tilingManager.tryFitWithResize(window, existingWindows, this.tilingManager.getUsableWorkArea(targetWorkspace, monitor), targetWorkspace, window);
        if (!(fitResult?.success ?? false)) {
            return { canFit: false, resizeNeeded: false, pendingMiniatures: [] };
        }

        // Pending minis MUST reach the tile pass, since skipping leaves siblings at miniature size with no real miniature.
        const pendingMiniatures = fitResult.pendingWindows ?? [];
        // Set early: intermediate tile calls treat these as pending-mini; afterWorkspaceSwitch re-sets before final pass.
        this.tilingManager._pendingMiniatureWindows = pendingMiniatures;
        return { canFit: true, resizeNeeded: true, pendingMiniatures };
    }

    _deferSacredReturn(window, origIndex, preMaxSize, resizeNeeded, pendingMiniatures) {
        if (resizeNeeded) {
            Logger.log(`handleUnmaximizeUndo: Smart Resize applied successfully for return of ${window.get_id()}`);
        }

        window.unmaximize();
        WindowState.set(window, 'unmaximizing', true);
        WindowState.set(window, 'isConstrainedByMosaic', true);

        if (preMaxSize) {
            WindowState.set(window, 'targetRestoredSize', preMaxSize);
            WindowState.set(window, 'openingSize', preMaxSize);
            WindowState.set(window, 'preferredSize', preMaxSize);
        }

        // Wait for the real size-changed confirmation instead of guessing with
        // a timer; a fixed delay could move the window before it's actually
        // done resizing, and it'd show up at the destination still huge.
        WindowState.set(window, 'isRestoringSacred', origIndex);
        WindowState.set(window, 'sacredFitConfirmed', true);
        if (pendingMiniatures.length > 0) {
            WindowState.set(window, 'pendingMiniaturesForReturn', pendingMiniatures);
        }
        this.scheduleSacredRestoreSafety(window, origIndex);
        Logger.log(`[SACRED-DEFER] Window ${window.get_id()} resizing in place before deferred move to WS ${origIndex}`);
    }
} );
