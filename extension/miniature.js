// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import * as WindowState from './windowState.js';
import { getSlowDownFactor } from './timing.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    PRE_MINIATURE_SIZE,
    MINIATURE_TARGET_POS,
    MINIATURE_EXT_LEFT,
    MINIATURE_EXT_TOP,
    MINIATURE_SCREENSHOT_PAUSE,
    ANIMATING_MINIATURE,
    MINIATURE_OVERLAY,
    MINIATURE_ANIM_KIND,
} from './windowState.js';

/**
 * Apply miniature visual state to a window actor.
 *
 * On GNOME Wayland, move_frame is ASYNC and Mutter may REJECT the target
 * position if the frame rect (original, unscaled size) would extend beyond
 * the monitor. So we cannot rely on move_frame to place the actor.
 *
 * Instead, we compute the translation from the actor's CURRENT position
 * to place the frame visual at the desired target:
 *
 *   frame_visual_x = actorX + tx + extLeft * scale = targetX
 *   tx = targetX - actorX - extLeft * scale
 *
 * This works regardless of where Mutter actually placed the actor.
 */
export function applyMiniatureActorState(actor, scale, extLeft, extTop, targetX, targetY) {
    const [ax, ay] = actor.get_position();
    const [actorW, actorH] = actor.get_size();
    actor.set_pivot_point(0, 0);
    actor.remove_all_transitions();
    actor.set_scale(scale, scale);
    const tx = targetX - ax - extLeft * scale;
    const ty = targetY - ay - extTop * scale;
    actor.set_translation(tx, ty, 0);
    Logger.log(`[MINIATURE] applyMiniatureActorState: actor=( ${ax},${ay} ${actorW}x${actorH}) target=(${targetX},${targetY}) scale=${scale} tx=${tx} ty=${ty} FINAL_SIZE=${Math.round(actorW * scale)}x${Math.round(actorH * scale)}`);
}

/**
 * Animate a miniature window actor to a new target position.
 *
 * Handles three cases:
 * - create/restore animation in-flight: only update target, let onStopped settle
 * - move animation in-flight: cancel it and redirect from current visual state
 * - idle: start fresh animation from current position
 */
export function animateMiniatureToTarget(actor, window, scale, extLeft, extTop, targetX, targetY, duration) {
    const kind = WindowState.get(window, MINIATURE_ANIM_KIND);

    if (kind === 'create' || kind === 'restore') {
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
        return;
    }

    actor.remove_all_transitions();

    WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
    WindowState.set(window, ANIMATING_MINIATURE, true);
    WindowState.set(window, MINIATURE_ANIM_KIND, 'move');

    actor.set_pivot_point(0, 0);
    actor.set_scale(scale, scale);

    const [ax, ay] = actor.get_position();
    const targetTx = targetX - ax - extLeft * scale;
    const targetTy = targetY - ay - extTop * scale;

    actor.ease({
        translation_x: targetTx,
        translation_y: targetTy,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped: (isFinished) => {
            if (!isFinished) return;
            WindowState.remove(window, ANIMATING_MINIATURE);
            WindowState.remove(window, MINIATURE_ANIM_KIND);
            const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
            const sc = WindowState.get(window, MINIATURE_SCALE);
            if (tgt && sc) {
                const eL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                const eT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                applyMiniatureActorState(actor, sc, eL, eT, tgt.x, tgt.y);
            }
        },
    });
}

/**
 * Custom Clutter.Effect that enforces miniature transforms before every paint.
 *
 * Mutter may reset actor transforms internally (workspace switch animation,
 * sync_window_geometry, etc.) without emitting GObject signals. This effect
 * runs as part of the paint pipeline, guaranteeing correct transforms are
 * applied before the actor is rendered, every frame, with no race conditions.
 */
const MiniatureEnforceEffect = GObject.registerClass({
    GTypeName: 'MosaicMiniatureEnforceEffect',
}, class MiniatureEnforceEffect extends Clutter.Effect {
    _init(window) {
        super._init();
        this._window = window;
    }

    vfunc_paint(...args) {
        const actor = this.get_actor();
        if (!actor || !WindowState.get(this._window, IS_MINIATURE)) {
            // Not a miniature anymore, just paint normally
            super.vfunc_paint(...args);
            return;
        }

        if (WindowState.get(this._window, ANIMATING_MINIATURE)) {
            // Animation controls transforms; don't interfere
            super.vfunc_paint(...args);
            return;
        }

        if (WindowState.get(this._window, MINIATURE_SCREENSHOT_PAUSE)) {
            // paused for a screenshot capture, paint at full size
            super.vfunc_paint(...args);
            return;
        }

        const sc = WindowState.get(this._window, MINIATURE_SCALE);
        const extL = WindowState.get(this._window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(this._window, MINIATURE_EXT_TOP) ?? 0;
        const tgt = WindowState.get(this._window, MINIATURE_TARGET_POS);

        if (sc && tgt) {
            // Re-enforce scale and translation before this paint
            actor.set_pivot_point(0, 0);
            actor.set_scale(sc, sc);
            const [ax, ay] = actor.get_position();
            const tx = tgt.x - ax - extL * sc;
            const ty = tgt.y - ay - extT * sc;
            actor.set_translation(tx, ty, 0);
        }
        super.vfunc_paint(...args);
    }
});

/**
 * Transparent overlay that captures clicks on a miniature window.
 * Placed over the miniature's visual frame area. Clicking it restores
 * the miniature to full size.
 */
const MiniatureClickOverlay = GObject.registerClass({
    GTypeName: 'MosaicMiniatureClickOverlay',
}, class MiniatureClickOverlay extends Clutter.Actor {
    _init(window, miniatureManager) {
        const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
        const scale = WindowState.get(window, MINIATURE_SCALE);
        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;

        const width = preSize.width * scale;
        const height = preSize.height * scale;

        const tgt = WindowState.get(window, MINIATURE_TARGET_POS);

        super._init({
            reactive: true,
            opacity: 0,
            x: tgt.x - extL * scale,
            y: tgt.y - extT * scale,
            width,
            height,
        });

        this._window = window;
        this._miniatureManager = miniatureManager;
        this._destroyed = false;

        // Mirror the window actor's visibility. Mutter sets the window actor
        // invisible when the user is on a different workspace; without this
        // binding the overlay (reactive: true, opacity: 0) would keep being
        // pickable on every workspace at the same screen position where the
        // miniature lives on its own workspace, restoring it on stray clicks.
        const windowActor = window.get_compositor_private();
        if (windowActor) {
            windowActor.bind_property('visible',
                this, 'visible',
                GObject.BindingFlags.SYNC_CREATE);
        }

        this.connect('button-press-event', () => {
            Logger.log(`[MINIATURE] Click overlay clicked for ${window.get_id()}`);
            this._miniatureManager.restoreMiniature(window, null);
            return Clutter.EVENT_STOP;
        });
    }

    /**
     * Update overlay position/size when the miniature's target changes
     * (e.g., layout recomputation).
     */
    updatePosition() {
        if (this._destroyed) return;
        const tgt = WindowState.get(this._window, MINIATURE_TARGET_POS);
        const scale = WindowState.get(this._window, MINIATURE_SCALE);
        const extL = WindowState.get(this._window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(this._window, MINIATURE_EXT_TOP) ?? 0;
        const preSize = WindowState.get(this._window, PRE_MINIATURE_SIZE);

        if (tgt && scale && preSize) {
            this.set_position(tgt.x - extL * scale, tgt.y - extT * scale);
            this.set_size(preSize.width * scale, preSize.height * scale);
        }
    }

    animateToPosition(duration) {
        if (this._destroyed) return;
        const tgt = WindowState.get(this._window, MINIATURE_TARGET_POS);
        const scale = WindowState.get(this._window, MINIATURE_SCALE);
        const extL = WindowState.get(this._window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(this._window, MINIATURE_EXT_TOP) ?? 0;
        const preSize = WindowState.get(this._window, PRE_MINIATURE_SIZE);

        if (tgt && scale && preSize) {
            this.remove_all_transitions();
            this.ease({
                x: tgt.x - extL * scale,
                y: tgt.y - extT * scale,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this.set_size(preSize.width * scale, preSize.height * scale);
        }
    }

    destroy() {
        this._destroyed = true;
        super.destroy();
    }
});

export const MiniatureManager = GObject.registerClass({
    GTypeName: 'MosaicMiniatureManager',
    Signals: {
        'miniature-created': { param_types: [GObject.TYPE_OBJECT] },
        'miniature-restored': { param_types: [GObject.TYPE_OBJECT] },
    },
}, class MiniatureManager extends GObject.Object {
    _init() {
        super._init();
        this._miniatureWindows = new Set();
        this._timeoutRegistry = null;
        this._animationsManager = null;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    setAnimationsManager(animationsManager) {
        this._animationsManager = animationsManager;
    }

    createMiniature(window, computedSlot, forcedPreSize = null, { animate = true } = {}) {
        const windowActor = window.get_compositor_private();
        if (!windowActor) return false;

        // animateWindow's onStopped(false) leaves the window in AnimationsManager's tracking,
        // expecting a new animateWindow call to clean up. A miniature ease takes over
        // instead, so nothing else would, and 'animations-completed' would never fire again.
        this._animationsManager?.removeAnimatingWindow(window.get_id());

        const preSize = forcedPreSize || window.get_frame_rect();
        const scale = constants.MINIATURE_TARGET_SIZE_PX / Math.max(preSize.width, preSize.height);
        Logger.log(`[MINIATURE] createMiniature ${window.get_id()}: preSize=${preSize.width}x${preSize.height} scale=${scale} forced=${!!forcedPreSize}`);

        const targetX = computedSlot.x;
        const targetY = computedSlot.y;

        const [actorBefore_x, actorBefore_y] = windowActor.get_position();
        const currentFrame = window.get_frame_rect();

        // Buffer rect vs frame rect is a stable border offset; the actor's live position
        // isn't. After back-to-back move_resize_frame calls (e.g. a restore cascade
        // re-miniaturizing siblings) the compositor lags, baking that stale gap into extLeft/extTop.
        const bufferRect = window.get_buffer_rect();
        const extLeft = currentFrame.x - bufferRect.x;
        const extTop = currentFrame.y - bufferRect.y;
        Logger.log(`[MINIATURE] createMiniature ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): preFrame=(${preSize.x},${preSize.y} ${preSize.width}x${preSize.height}) slot=${Math.round(preSize.width * scale)}x${Math.round(preSize.height * scale)} currentFrame=(${currentFrame.x},${currentFrame.y} ${currentFrame.width}x${currentFrame.height}) actorBefore=(${actorBefore_x},${actorBefore_y}) target=(${targetX},${targetY}) scale=${scale.toFixed(4)} extLeft=${extLeft} extTop=${extTop}`);

        // Store state BEFORE animation. Enforce effect and workspace animation
        // patch need to read these during the animation
        WindowState.set(window, IS_MINIATURE, true);
        WindowState.set(window, MINIATURE_SCALE, scale);
        WindowState.set(window, PRE_MINIATURE_SIZE, { width: preSize.width, height: preSize.height });
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
        WindowState.set(window, MINIATURE_EXT_LEFT, extLeft);
        WindowState.set(window, MINIATURE_EXT_TOP, extTop);

        // Add the enforce effect (guard will skip during animation)
        const enforceEffect = new MiniatureEnforceEffect(window);
        windowActor.add_effect(enforceEffect);

        if (animate) {
            const prevKind = WindowState.get(window, MINIATURE_ANIM_KIND);

            WindowState.set(window, ANIMATING_MINIATURE, true);

            const [actorW, actorH] = windowActor.get_size();

            if (prevKind === 'restore') {
                // Interrupted restore, read current visual frame origin before canceling
                const [cpx, cpy] = windowActor.get_pivot_point();
                const cs = windowActor.scale_x;
                const curTx = windowActor.translation_x;
                const curTy = windowActor.translation_y;
                const visualX = actorBefore_x + cpx * actorW * (1 - cs) + curTx + extLeft * cs;
                const visualY = actorBefore_y + cpy * actorH * (1 - cs) + curTy + extTop * cs;
                const startTx = visualX - actorBefore_x - extLeft * cs;
                const startTy = visualY - actorBefore_y - extTop * cs;
                const endTx = targetX - actorBefore_x - extLeft * scale;
                const endTy = targetY - actorBefore_y - extTop * scale;
                const animDuration = Math.max(1, Math.round(constants.MINIATURE_ANIM_MS * getSlowDownFactor() * (cs - scale) / Math.max(0.001, 1.0 - scale)));

                // Set kind before remove_all_transitions, since restore's onStopped fires
                // synchronously and needs to see 'create' to skip its conditional removal.
                // IS_MINIATURE is already true (set above), so restore's actor reset is also skipped.
                WindowState.set(window, MINIATURE_ANIM_KIND, 'create');
                windowActor.remove_all_transitions();

                windowActor.set_pivot_point(0, 0);
                windowActor.set_scale(cs, cs);
                windowActor.set_translation(startTx, startTy, 0);

                windowActor.ease({
                    scale_x: scale,
                    scale_y: scale,
                    translation_x: endTx,
                    translation_y: endTy,
                    duration: animDuration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        WindowState.remove(window, ANIMATING_MINIATURE);
                        WindowState.remove(window, MINIATURE_ANIM_KIND);
                        windowActor.set_pivot_point(0, 0);
                        if (WindowState.get(window, IS_MINIATURE)) {
                            const finalTgt = WindowState.get(window, MINIATURE_TARGET_POS);
                            const finalSc = WindowState.get(window, MINIATURE_SCALE);
                            const finalExtL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                            const finalExtT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                            if (finalTgt && finalSc) {
                                applyMiniatureActorState(windowActor, finalSc, finalExtL, finalExtT, finalTgt.x, finalTgt.y);
                            }
                            const [finalAx, finalAy] = windowActor.get_position();
                            const [finalW, finalH] = windowActor.get_size();
                            Logger.log(`[MINIATURE] createMiniature animation complete ${window.get_id()}: FINAL actor=(${finalAx},${finalAy} ${finalW}x${finalH}) scale=${finalSc} FINAL_VISUAL=${Math.round(finalW * finalSc)}x${Math.round(finalH * finalSc)}`);
                        }
                    },
                });
            } else {
                WindowState.set(window, MINIATURE_ANIM_KIND, 'create');

                // Pivot at the exact frame anchor so scale tracks adjacent edges; tx/ty absorb residual when clamped past [0,1].
                const dw = actorW * (1 - scale);
                const dh = actorH * (1 - scale);
                const px = dw > 0 ? Math.max(0, Math.min(1, (targetX - actorBefore_x - extLeft * scale) / dw)) : 0;
                const py = dh > 0 ? Math.max(0, Math.min(1, (targetY - actorBefore_y - extTop * scale) / dh)) : 0;
                const tx = targetX - actorBefore_x - px * dw - extLeft * scale;
                const ty = targetY - actorBefore_y - py * dh - extTop * scale;

                windowActor.remove_all_transitions();
                windowActor.set_pivot_point(px, py);
                windowActor.set_translation(0, 0, 0);

                windowActor.ease({
                    scale_x: scale,
                    scale_y: scale,
                    translation_x: tx,
                    translation_y: ty,
                    duration: Math.ceil(constants.MINIATURE_ANIM_MS * getSlowDownFactor()),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        WindowState.remove(window, ANIMATING_MINIATURE);
                        WindowState.remove(window, MINIATURE_ANIM_KIND);
                        // Reset pivot for enforce effect (uses pivot 0,0)
                        windowActor.set_pivot_point(0, 0);
                        if (WindowState.get(window, IS_MINIATURE)) {
                            // Re-apply with the LATEST target (layout may have recomputed)
                            const finalTgt = WindowState.get(window, MINIATURE_TARGET_POS);
                            const finalSc = WindowState.get(window, MINIATURE_SCALE);
                            const finalExtL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
                            const finalExtT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
                            if (finalTgt && finalSc) {
                                applyMiniatureActorState(windowActor, finalSc, finalExtL, finalExtT, finalTgt.x, finalTgt.y);
                            }
                            const [finalAx, finalAy] = windowActor.get_position();
                            const [finalW, finalH] = windowActor.get_size();
                            Logger.log(`[MINIATURE] createMiniature animation complete ${window.get_id()}: FINAL actor=(${finalAx},${finalAy} ${finalW}x${finalH}) scale=${finalSc} FINAL_VISUAL=${Math.round(finalW * finalSc)}x${Math.round(finalH * finalSc)}`);
                        }
                    },
                });
            }
        } else {
            // Instant: apply transforms synchronously so the overview's frozen
            // slot (already set to mini) matches the actor state from the first frame.
            applyMiniatureActorState(windowActor, scale, extLeft, extTop, targetX, targetY);
        }

        Logger.log(`[MINIATURE] createMiniature ${window.get_id()}: miniSize=${Math.round(preSize.width * scale)}x${Math.round(preSize.height * scale)}`);

        // Only set the focus-restore guard when a registry can expire it, since a stuck flag blocks restore forever.
        if (this._timeoutRegistry) {
            WindowState.set(window, 'justMiniaturized', true);
            const timeoutId = this._timeoutRegistry.add(constants.MINIATURE_FOCUS_GUARD_MS, () => {
                WindowState.remove(window, 'justMiniaturized');
                WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
                return GLib.SOURCE_REMOVE;
            }, 'miniature_focusGuard');
            WindowState.set(window, 'miniatureJustMiniaturizedTimeoutId', timeoutId);
        }

        this._miniatureWindows.add(window.get_id());
        this.emit('miniature-created', window);

        // Add click-capture overlay above the miniature
        const overlay = new MiniatureClickOverlay(window, this);
        global.window_group.insert_child_above(overlay, windowActor);
        WindowState.set(window, MINIATURE_OVERLAY, overlay);

        Logger.log(`[MINIATURE] Created miniature for ${window.get_id()}, scale=${scale.toFixed(4)}`);
        return true;
    }

    restoreMiniature(window, _newSlot, { activate = true } = {}) {
        if (!WindowState.get(window, IS_MINIATURE)) return false;

        const windowActor = window.get_compositor_private();

        const frame = window.get_frame_rect();
        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
        const tgt = WindowState.get(window, MINIATURE_TARGET_POS);

        Logger.log(`[MINIATURE] restoreMiniature START ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): frame=(${frame.x},${frame.y} ${frame.width}x${frame.height}) scale=${sc.toFixed(4)}`);

        // Remove IS_MINIATURE first so enforce effect stops
        WindowState.remove(window, IS_MINIATURE);

        // Remove click overlay
        const overlay = WindowState.get(window, MINIATURE_OVERLAY);
        if (overlay) {
            overlay.destroy();
            WindowState.remove(window, MINIATURE_OVERLAY);
        }

        // Remove the enforce effect
        if (windowActor) {
            const effects = windowActor.get_effects();
            for (const effect of effects) {
                if (effect instanceof MiniatureEnforceEffect) {
                    windowActor.remove_effect(effect);
                    break;
                }
            }

            const kind = WindowState.get(window, MINIATURE_ANIM_KIND);
            const [ax, ay] = windowActor.get_position();
            const [actorW, actorH] = windowActor.get_size();

            let startPivotX, startPivotY, startScale, startTx, startTy, duration;

            if (kind === 'create') {
                // Interrupted miniaturize, read current visual frame origin before canceling
                const [cpx, cpy] = windowActor.get_pivot_point();
                const cs = windowActor.scale_x;
                const curTx = windowActor.translation_x;
                const curTy = windowActor.translation_y;
                const visualX = ax + cpx * actorW * (1 - cs) + curTx + extL * cs;
                const visualY = ay + cpy * actorH * (1 - cs) + curTy + extT * cs;
                startPivotX = 0;
                startPivotY = 0;
                startScale = cs;
                startTx = visualX - ax - extL * cs;
                startTy = visualY - ay - extT * cs;
                duration = Math.max(1, Math.round(constants.MINIATURE_ANIM_MS * getSlowDownFactor() * (1.0 - cs) / Math.max(0.001, 1.0 - sc)));
            } else {
                const miniTgt = tgt ?? { x: frame.x, y: frame.y };
                const dw = actorW * (1 - sc);
                const dh = actorH * (1 - sc);
                startPivotX = dw > 0 ? Math.max(0, Math.min(1, (miniTgt.x - ax - extL * sc) / dw)) : 0;
                startPivotY = dh > 0 ? Math.max(0, Math.min(1, (miniTgt.y - ay - extT * sc) / dh)) : 0;
                startScale = sc;
                startTx = dw > 0 ? miniTgt.x - ax - startPivotX * dw - extL * sc : 0;
                startTy = dh > 0 ? miniTgt.y - ay - startPivotY * dh - extT * sc : 0;
                duration = Math.ceil(constants.MINIATURE_ANIM_MS * getSlowDownFactor());
            }

            // Set kind after remove_all_transitions: create's onStopped fires synchronously during
            // that call and unconditionally removes MINIATURE_ANIM_KIND, so setting before would
            // be overwritten. Setting after is safe because onStopped has already run by this point.
            windowActor.remove_all_transitions();
            WindowState.set(window, MINIATURE_ANIM_KIND, 'restore');

            windowActor.set_pivot_point(startPivotX, startPivotY);
            windowActor.set_scale(startScale, startScale);
            windowActor.set_translation(startTx, startTy, 0);

            // Activate before ease so the window gains focus at animation start, not after.
            if (activate) window.activate(global.get_current_time());

            // A retile can interrupt this mid-flight (it shares the actor with
            // animateWindow's own position ease). Rather than snap to full size,
            // pick the scale-up back up from wherever it got cut off; position is
            // already handed off to whatever interrupted us by this point.
            const continueScaleUp = (isFinished) => {
                if (!windowActor || windowActor.is_destroyed()) return;

                if (!isFinished) {
                    if (WindowState.get(window, IS_MINIATURE)) return;
                    if (Math.abs(windowActor.scale_x - 1.0) < 0.001 && Math.abs(windowActor.scale_y - 1.0) < 0.001) {
                        if (WindowState.get(window, MINIATURE_ANIM_KIND) === 'restore')
                            WindowState.remove(window, MINIATURE_ANIM_KIND);
                        return;
                    }
                    windowActor.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: continueScaleUp,
                    });
                    return;
                }

                if (WindowState.get(window, MINIATURE_ANIM_KIND) === 'restore')
                    WindowState.remove(window, MINIATURE_ANIM_KIND);
                if (!WindowState.get(window, IS_MINIATURE)) {
                    windowActor.set_pivot_point(0, 0);
                    windowActor.set_scale(1.0, 1.0);
                    windowActor.set_translation(0, 0, 0);
                }
                const [finalAx, finalAy] = windowActor.get_position();
                const [finalW, finalH] = windowActor.get_size();
                Logger.log(`[MINIATURE] restoreMiniature animation complete ${window.get_id()}: FINAL actor=(${finalAx},${finalAy} ${finalW}x${finalH})`);
            };

            windowActor.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                translation_x: 0,
                translation_y: 0,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: continueScaleUp,
            });
        }

        // Clear remaining WindowState
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);
        // Stale mini-target persists when a window's min size prevents tryFitWithResize
        // from rewriting it; without clearing, the next layout uses the obsolete mini size.
        WindowState.remove(window, 'targetSmartResizeSize');

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) this._timeoutRegistry?.remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');

        this._miniatureWindows.delete(window.get_id());
        this.emit('miniature-restored', window);

        Logger.log(`[MINIATURE] Restored miniature ${window.get_id()}`);
        return true;
    }

    destroyMiniature(window) {
        const windowActor = window.get_compositor_private();

        // Remove IS_MINIATURE first so enforce effect stops
        WindowState.remove(window, IS_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);

        // Destroy the click overlay, since an orphaned reactive actor would capture clicks on a dead window.
        const overlay = WindowState.get(window, MINIATURE_OVERLAY);
        if (overlay) {
            overlay.destroy();
            WindowState.remove(window, MINIATURE_OVERLAY);
        }

        if (windowActor) {
            const effects = windowActor.get_effects();
            for (const effect of effects) {
                if (effect instanceof MiniatureEnforceEffect) {
                    windowActor.remove_effect(effect);
                    break;
                }
            }
        }

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) this._timeoutRegistry?.remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');

        this._miniatureWindows.delete(window.get_id());
        Logger.log(`[MINIATURE] Destroyed miniature ${window.get_id()} (window closed)`);
    }

    // Hard-restore every miniature back to full size. Used by disable() to
    // leave a clean slate, since the next enable() rebuilds via enforceWorkspaceFit.
    restoreAllMiniatures() {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(w => WindowState.get(w, IS_MINIATURE));
        for (const window of windows) {
            this.restoreMiniature(window, null, { activate: false });
        }
    }

    restoreWorkspaceMiniatures(workspace) {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .filter(w => WindowState.get(w, IS_MINIATURE));
        for (const window of windows) {
            this.restoreMiniature(window, null, { activate: false });
        }
    }

    // Screenshot UI grabs the actor straight off the stage, so a miniature would
    // get captured shrunk and in the wrong spot. Snap it back to full size here,
    // resumeFromScreenshot() puts it back once the capture is done.
    pauseForScreenshot() {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(w => WindowState.get(w, IS_MINIATURE));
        for (const window of windows) {
            const actor = window.get_compositor_private();
            if (!actor) continue;
            WindowState.set(window, MINIATURE_SCREENSHOT_PAUSE, true);
            actor.set_pivot_point(0, 0);
            actor.set_scale(1, 1);
            actor.set_translation(0, 0, 0);
        }
    }

    resumeFromScreenshot() {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(w => WindowState.get(w, MINIATURE_SCREENSHOT_PAUSE));
        for (const window of windows) {
            WindowState.remove(window, MINIATURE_SCREENSHOT_PAUSE);
            if (!WindowState.get(window, IS_MINIATURE)) continue;

            const actor = window.get_compositor_private();
            const scale = WindowState.get(window, MINIATURE_SCALE);
            const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
            const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
            const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
            if (actor && scale && tgt)
                applyMiniatureActorState(actor, scale, extL, extT, tgt.x, tgt.y);
        }
    }

    destroy() {
        if (this._miniatureWindows.size > 0) {
            const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
            for (const window of windows) {
                if (this._miniatureWindows.has(window.get_id()))
                    this.destroyMiniature(window);
            }
        }
        this._miniatureWindows.clear();
        this._timeoutRegistry = null;
    }

    getMiniatureSize(window) {
        return getMiniatureSize(window);
    }

    findMiniatureAtPoint(x, y) {
        if (this._miniatureWindows.size === 0) return null;
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, global.workspace_manager.get_active_workspace());
        for (const window of windows) {
            if (!this._miniatureWindows.has(window.get_id())) continue;
            const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
            const scale = WindowState.get(window, MINIATURE_SCALE);
            const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
            const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
            const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
            if (!tgt || !scale || !preSize) continue;
            const ox = tgt.x - extL * scale;
            const oy = tgt.y - extT * scale;
            const ow = preSize.width * scale;
            const oh = preSize.height * scale;
            if (x >= ox && x <= ox + ow && y >= oy && y <= oy + oh)
                return window;
        }
        return null;
    }
});

// Module-level helper so tiling.js can read miniature display size without a manager reference.
export function getMiniatureSize(window) {
    if (!WindowState.get(window, IS_MINIATURE)) return null;
    const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
    const scale = WindowState.get(window, MINIATURE_SCALE);
    if (!preSize || !scale) return null;
    return {
        width: Math.round(preSize.width * scale),
        height: Math.round(preSize.height * scale),
    };
}
