// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Smooth window animations for mosaic tiling

import * as Logger from './logger.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as constants from './constants.js';
import * as WindowState from './windowState.js';
import { getAnimationsEnabled, getSlowDownFactor } from './timing.js';

import GObject from 'gi://GObject';

const ANIMATION_DURATION = constants.ANIMATION_DURATION_MS;
const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const ANIMATION_MODE_SUBTLE = Clutter.AnimationMode.EASE_OUT_QUAD;

export const AnimationsManager = GObject.registerClass({
    GTypeName: 'MosaicAnimationsManager',
    Signals: {
        'animations-completed': {},
    },
}, class AnimationsManager extends GObject.Object {
    _init() {
        super._init();
        this._isDragging = false;
        this._animatingWindows = new Set(); // Window IDs currently animating (drives animations-completed signal)
        this._animatingTargets = new Map(); // Window ID -> last targetRect, to detect redundant retile calls
        this._justEndedDrag = false;
        this._resizingWindowId = null;
        this._timeoutRegistry = null;
        this._isOverviewActive = false;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    setResizingWindow(windowId) {
        this._resizingWindowId = windowId;
    }

    getResizingWindowId() {
        return this._resizingWindowId;
    }

    // Used by async utilities to wait for animations to complete
    hasActiveAnimations() {
        return this._animatingWindows.size > 0;
    }

    _checkAllAnimationsComplete() {
        if (this._animatingWindows.size === 0) {
            this.emit('animations-completed');
        }
    }

    setOverviewActive(active) {
        this._isOverviewActive = active;
    }

    setDragging(dragging) {
        // If ending drag, set flag for smooth drop animation
        if (this._isDragging && !dragging) {
            this._justEndedDrag = true;
            this._timeoutRegistry.add(constants.DEBOUNCE_DELAY_MS, () => {
                this._justEndedDrag = false;
                return GLib.SOURCE_REMOVE;
            }, 'animations_dragEndDebounce');
        }
        this._isDragging = dragging;
    }

    shouldAnimateWindow(window, draggedWindow = null) {
        if (!getAnimationsEnabled()) return false;
        if (this._isOverviewActive) return false;
        // During active resize, position all sibling windows instantly (real-time retile)
        if (this._resizingWindowId !== null) {
            return false;
        }

        // Skip if slide-in animation is in progress (handled by first-frame)
        if (WindowState.get(window, 'slideInAnimating')) {
            return false;
        }

        // Skip for windows created during overview - already positioned correctly
        if (WindowState.get(window, 'createdDuringOverview')) {
            WindowState.remove(window, 'createdDuringOverview');
            return false;
        }

        if (draggedWindow && window.get_id() === draggedWindow.get_id()) {
            return false;
        }

        return true;
    }

    animateWindow(window, targetRect, options = {}) {
        const {
            duration = ANIMATION_DURATION,
            mode = null,
            onComplete = null,
            draggedWindow = null,
            subtle = false,
            userOp = false,
        } = options;

        if (!this.shouldAnimateWindow(window, draggedWindow)) {
            WindowState.set(window, 'isMosaicResizing', true);
            window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            this._clearMosaicResizingSoon(window);
            if (onComplete) onComplete();
            return;
        }

        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            Logger.log(`No actor for window ${window.get_id()}, skipping animation`);
            WindowState.set(window, 'isMosaicResizing', true);
            window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            this._clearMosaicResizingSoon(window);
            if (onComplete) onComplete();
            return;
        }

        // Redundant retile to the same destination already in flight (e.g. the
        // window-open queue re-evaluates the same window ~100ms later) — restarting
        // the ease here would cut the original transition off before its EASE_OUT_BACK
        // overshoot plays, replacing a full bounce with an imperceptible one. Let the
        // existing ease run to completion instead.
        const lastTarget = this._animatingTargets.get(window.get_id());
        if (this._animatingWindows.has(window.get_id()) && lastTarget &&
            lastTarget.x === targetRect.x && lastTarget.y === targetRect.y &&
            lastTarget.width === targetRect.width && lastTarget.height === targetRect.height) {
            if (onComplete) onComplete();
            return;
        }

        // Must read translation BEFORE remove_all_transitions() - it resets to 0 after.
        const currentFrame = window.get_frame_rect();
        const currentTx = windowActor.translation_x;
        const currentTy = windowActor.translation_y;

        // remove_all_transitions fires old onStopped(isFinished=false);
        // the guard at the ease callback returns early without double cleanup.
        windowActor.remove_all_transitions();

        this._animatingWindows.add(window.get_id());
        this._animatingTargets.set(window.get_id(), targetRect);

        const effectiveDuration = Math.ceil(duration * getSlowDownFactor());

        let animationMode;
        if (mode !== null) {
            animationMode = mode;
        } else if (subtle || this._justEndedDrag) {
            animationMode = ANIMATION_MODE_SUBTLE;
        } else {
            animationMode = ANIMATION_MODE;
        }

        // idle  (currentTx=0): initialTx = frameX - targetX
        // moving (currentTx!=0): initialTx = (frameX + currentTx) - targetX  (no jump)
        const initialTx = currentFrame.x + currentTx - targetRect.x;
        const initialTy = currentFrame.y + currentTy - targetRect.y;

        WindowState.set(window, 'isMosaicResizing', true);
        window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        windowActor.set_translation(initialTx, initialTy, 0);

        windowActor.ease({
            translation_x: 0,
            translation_y: 0,
            duration: effectiveDuration,
            mode: animationMode,
            onStopped: (isFinished) => {
                if (!isFinished) return; // redirect in progress; new animation owns cleanup
                if (windowActor && !windowActor.is_destroyed())
                    windowActor.set_translation(0, 0, 0);
                this._animatingWindows.delete(window.get_id());
                this._animatingTargets.delete(window.get_id());
                this._checkAllAnimationsComplete();
                WindowState.set(window, 'isMosaicResizing', false);
                if (onComplete) onComplete();
            }
        });
    }

    animateReTiling(windowLayouts, draggedWindow = null) {
        if (windowLayouts.length === 1) {
            const { window, rect } = windowLayouts[0];
            const currentRect = window.get_frame_rect();
            
            const needsMove = Math.abs(currentRect.x - rect.x) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.y - rect.y) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.width - rect.width) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.height - rect.height) > constants.ANIMATION_DIFF_THRESHOLD;

            if (!needsMove) {
                window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
                return;
            }
        }

        for (const {window, rect} of windowLayouts) {
            this.animateWindow(window, rect, { draggedWindow });
        }
    }

    removeAnimatingWindow(windowId) {
        this._animatingTargets.delete(windowId);
        if (this._animatingWindows.delete(windowId)) {
            this._checkAllAnimationsComplete();
        }
    }

    // No ease here means no onStopped to clear the flag, so give Mutter a
    // moment to actually fire size-changed before we drop it.
    _clearMosaicResizingSoon(window) {
        this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
            WindowState.set(window, 'isMosaicResizing', false);
            return GLib.SOURCE_REMOVE;
        }, 'animations_clearMosaicResizing');
    }

    cleanup() {
        this._animatingWindows.clear();
        this._animatingTargets.clear();
        this._checkAllAnimationsComplete();
        this._isDragging = false;
    }

    destroy() {
        this.cleanup();
    }
});
