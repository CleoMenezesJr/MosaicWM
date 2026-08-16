// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

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

// On GNOME Wayland, move_frame is ASYNC and Mutter may REJECT the target
// position if the frame rect (original, unscaled size) would extend beyond
// the monitor. So we cannot rely on move_frame to place the actor.
// Instead compute translation from the actor's position to place the
// frame visual at the desired target: tx = targetX - actorX - extLeft * scale.
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

// Replacing the translation transition stops the old one synchronously, and that stop must
// not be read as the animation finishing: the settle would slam the actor onto the target
// and the redirect would never get to animate anywhere.
let redirectingWindow = null;

export function isRedirectingMiniature(window) {
    return redirectingWindow === window;
}

// Layout can move the slot while the entrance ease is still flying, and letting the ease land
// on the stale slot means correcting it afterwards, which reads as a jump. Retarget in place
// instead. Scale rides its own transition, so only translation is re-issued, and the pivot is
// whatever the running ease chose.
export function redirectMiniatureEase(actor, window, targetX, targetY) {
    const scale = WindowState.get(window, MINIATURE_SCALE);
    const running = actor.get_transition('translation-x');
    if (!scale || !running) {
        Logger.log(`[MINIATURE] redirect bail ${window.get_id()}: kind=${WindowState.get(window, MINIATURE_ANIM_KIND)} scale=${scale} running=${!!running} wanted=(${targetX},${targetY})`);
        return false;
    }

    const prev = WindowState.get(window, MINIATURE_TARGET_POS);
    // Recorded either way, so the settle still lands exact; what a pixel doesn't earn is
    // restarting the ease, which rubber-bands the miniature when passes come in bursts.
    WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
    if (prev && Math.abs(prev.x - targetX) < 2 && Math.abs(prev.y - targetY) < 2) return true;

    const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
    const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
    const [ax, ay] = actor.get_position();
    const [aw, ah] = actor.get_size();
    const [px, py] = actor.get_pivot_point();
    const tx = targetX - ax - px * aw * (1 - scale) - extL * scale;
    const ty = targetY - ay - py * ah * (1 - scale) - extT * scale;

    // Finishing with the transitions it started alongside keeps scale and translation in step.
    const remaining = Math.max(1, running.get_duration() - running.get_elapsed_time());

    redirectingWindow = window;
    try {
        actor.ease({
            translation_x: tx,
            translation_y: ty,
            duration: remaining,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: (isFinished) => {
                if (!isFinished || isRedirectingMiniature(window)) return;
                settleMiniature(actor, window);
            },
        });
    } finally {
        redirectingWindow = null;
    }
    Logger.log(`[MINIATURE] redirect ${window.get_id()} -> (${targetX},${targetY}) over ${remaining}ms`);
    return true;
}

function settleMiniature(actor, window) {
    WindowState.remove(window, ANIMATING_MINIATURE);
    WindowState.remove(window, MINIATURE_ANIM_KIND);
    const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
    const sc = WindowState.get(window, MINIATURE_SCALE);
    Logger.log(`[MINIATURE] settle ${window.get_id()}: target=${tgt ? `(${tgt.x},${tgt.y})` : 'none'} scale=${sc ?? 'none'}`);
    if (!tgt || !sc) return;
    const eL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
    const eT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
    applyMiniatureActorState(actor, sc, eL, eT, tgt.x, tgt.y);
}

export function animateMiniatureToTarget(actor, window, scale, extLeft, extTop, targetX, targetY, duration) {
    const kind = WindowState.get(window, MINIATURE_ANIM_KIND);

    if (kind === 'create' || kind === 'restore') {
        if (!redirectMiniatureEase(actor, window, targetX, targetY))
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
            if (!isFinished || isRedirectingMiniature(window)) return;
            settleMiniature(actor, window);
        },
    });
}

// Mutter may reset actor transforms (workspace switch, sync_window_geometry) without
// signals; this effect enforces miniature transforms every frame at paint time.
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
            super.vfunc_paint(...args);
            return;
        }

        if (WindowState.get(this._window, ANIMATING_MINIATURE)) {
            super.vfunc_paint(...args);
            return;
        }

        if (WindowState.get(this._window, MINIATURE_SCREENSHOT_PAUSE)) {
            super.vfunc_paint(...args);
            return;
        }

        const sc = WindowState.get(this._window, MINIATURE_SCALE);
        const extL = WindowState.get(this._window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(this._window, MINIATURE_EXT_TOP) ?? 0;
        const tgt = WindowState.get(this._window, MINIATURE_TARGET_POS);

        if (sc && tgt) {
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

const MiniatureClickOverlay = GObject.registerClass({
    GTypeName: 'MosaicMiniatureClickOverlay',
}, class MiniatureClickOverlay extends Clutter.Actor {
    _init(window, miniatureManager) {
        const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
        const scale = WindowState.get(window, MINIATURE_SCALE);

        const width = preSize.width * scale;
        const height = preSize.height * scale;

        // MINIATURE_TARGET_POS is where the frame lands, and preSize is the frame's
        // size, so the box needs no shadow-extent shift. Offsetting it would put the
        // centered icon off the Overview preview's own center, which tracks the frame.
        const tgt = WindowState.get(window, MINIATURE_TARGET_POS);

        super._init({
            reactive: true,
            // The icon child would inherit a zero opacity, and this actor paints nothing anyway.
            opacity: 255,
            layout_manager: new Clutter.BinLayout(),
            x: tgt.x,
            y: tgt.y,
            width,
            height,
        });

        this._window = window;
        this._miniatureManager = miniatureManager;
        this._destroyed = false;
        this._iconSuppressReasons = new Set();
        this._iconDelayId = 0;
        this._hoverRestId = 0;

        // Some dialogs/XWayland clients have no app; overlay still works as click target.
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        this._icon = null;
        if (app) {
            this._icon = app.create_icon_texture(constants.MINIATURE_ICON_SIZE_PX);
            this._icon.add_style_class_name('window-icon');
            this._icon.add_style_class_name('icon-dropshadow');
            this._icon.set({
                reactive: false,
                opacity: 0,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._icon);
        }

        // Mirror window actor visibility so the reactive overlay isn't pickable
        // from other workspaces at the same screen position.
        const windowActor = window.get_compositor_private();
        if (windowActor) {
            windowActor.bind_property('visible',
                this, 'visible',
                GObject.BindingFlags.SYNC_CREATE);
        }

        const restore = () => {
            Logger.log(`[MINIATURE] Click overlay clicked for ${window.get_id()}`);
            this._miniatureManager.restoreMiniature(window, null);
        };
        this.connect('button-press-event', () => {
            restore();
            return Clutter.EVENT_STOP;
        });
        // A tap never reaches this window_group sibling as an emulated button press,
        // and Clutter.ClickAction is gone in GNOME 48+, so read the touch signal raw.
        this.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            restore();
            return Clutter.EVENT_STOP;
        });

        // Mutter maps the pointer to a window by walking up from the picked actor to a
        // MetaWindowActor. This overlay is a window_group sibling, so the walk dies here
        // and focus-follows-mouse never sees the miniature. Do the hover focus ourselves.
        this.connect('motion-event', () => {
            this._onHover();
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('leave-event', () => {
            this._cancelHoverRest();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _onHover() {
        if (this._destroyed) return;
        if (!this._miniatureManager.isHoverFocusEnabled()) return;

        if (!this._miniatureManager.waitsForPointerRest()) {
            this._restoreOnHover();
            return;
        }

        // Every motion rearms the timer, so only a pointer that actually stops fires it.
        this._cancelHoverRest();
        this._hoverRestId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.MINIATURE_HOVER_REST_MS, () => {
            this._hoverRestId = 0;
            this._restoreOnHover();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restoreOnHover() {
        if (this._destroyed || !WindowState.get(this._window, IS_MINIATURE)) return;
        // Reordering and edge tiling own the miniature while a grab is up.
        if (global.display.is_grabbed()) return;
        // A window that just shrank under a resting cursor would bounce straight back out.
        if (WindowState.get(this._window, 'justMiniaturized')) return;

        Logger.log(`[MINIATURE] Hover focus restoring ${this._window.get_id()}`);
        this._miniatureManager.restoreMiniature(this._window, null);
    }

    _cancelHoverRest() {
        if (!this._hoverRestId) return;
        GLib.source_remove(this._hoverRestId);
        this._hoverRestId = 0;
    }

    updatePosition() {
        if (this._destroyed) return;
        const tgt = WindowState.get(this._window, MINIATURE_TARGET_POS);
        const scale = WindowState.get(this._window, MINIATURE_SCALE);
        const preSize = WindowState.get(this._window, PRE_MINIATURE_SIZE);

        if (tgt && scale && preSize) {
            this.set_position(tgt.x, tgt.y);
            this.set_size(preSize.width * scale, preSize.height * scale);
        }
    }

    animateToPosition(duration) {
        if (this._destroyed) return;
        const tgt = WindowState.get(this._window, MINIATURE_TARGET_POS);
        const scale = WindowState.get(this._window, MINIATURE_SCALE);
        const preSize = WindowState.get(this._window, PRE_MINIATURE_SIZE);

        if (tgt && scale && preSize) {
            this.remove_all_transitions();
            this.ease({
                x: tgt.x,
                y: tgt.y,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this.set_size(preSize.width * scale, preSize.height * scale);
        }
    }

    showIcon(duration) {
        if (this._destroyed || !this._icon) return;
        if (this._iconSuppressReasons.size > 0) return;
        this._icon.remove_transition('opacity');
        if (duration <= 0) {
            this._icon.opacity = 255;
            return;
        }
        this._icon.ease({
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    flyIconIn(dx, dy, duration) {
        if (this._destroyed || !this._icon) return;
        this._cancelIconDelay();
        this._icon.remove_all_transitions();

        if (duration <= 0) {
            this._icon.set_translation(0, 0, 0);
            this.showIcon(0);
            return;
        }

        this._icon.opacity = 0;
        this._icon.set_translation(dx, dy, 0);
        this._icon.ease({
            translation_x: 0,
            translation_y: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        const fadeDelay = Math.round(duration * constants.MINIATURE_ICON_FADE_START);
        this._iconDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, fadeDelay, () => {
            this._iconDelayId = 0;
            this.showIcon(duration - fadeDelay);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelIconDelay() {
        if (!this._iconDelayId) return;
        GLib.source_remove(this._iconDelayId);
        this._iconDelayId = 0;
    }

    hideIcon() {
        if (this._destroyed || !this._icon) return;
        this._cancelIconDelay();
        this._icon.remove_all_transitions();
        this._icon.set_translation(0, 0, 0);
        this._icon.opacity = 0;
    }

    // Track who asked instead of a single flag (overview + screenshot can both want it gone).
    setIconSuppressed(reason, suppressed) {
        if (suppressed) this._iconSuppressReasons.add(reason);
        else this._iconSuppressReasons.delete(reason);

        if (this._iconSuppressReasons.size > 0) this.hideIcon();
        else this.showIcon(0);
    }

    fadeOutAndDestroy(duration) {
        if (this._destroyed) return;
        this.reactive = false;
        this._cancelHoverRest();
        this._cancelIconDelay();
        if (!this._icon || this._icon.opacity === 0 || duration <= 0) {
            this.destroy();
            return;
        }
        this._icon.remove_all_transitions();
        this._icon.ease({
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    destroy() {
        this._destroyed = true;
        this._cancelHoverRest();
        this._cancelIconDelay();
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
        this._miniatureWindows = new Map();
        this._timeoutRegistry = null;
        this._animationsManager = null;
        this._overviewActive = false;
        this._wmPrefs = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' });
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    }

    isHoverFocusEnabled() {
        return this._wmPrefs?.get_string('focus-mode') !== 'click';
    }

    waitsForPointerRest() {
        return this._mutterSettings?.get_boolean('focus-change-on-pointer-rest') ?? true;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    setAnimationsManager(animationsManager) {
        this._animationsManager = animationsManager;
    }

    // Layout may have recomputed the slot while the ease ran; the final onStopped
    // has to re-apply the freshly written target instead of leaving the actor on a
    // stale position.
    _finishMiniatureAnim(window, windowActor) {
        if (isRedirectingMiniature(window)) return;
        WindowState.remove(window, ANIMATING_MINIATURE);
        WindowState.remove(window, MINIATURE_ANIM_KIND);
        windowActor.set_pivot_point(0, 0);
        if (!WindowState.get(window, IS_MINIATURE)) return;

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

    // Shrinking straight out of an interrupted restore: pick up the actor's live scale and
    // translation so the flight starts from what's on screen, not from a full-size frame.
    _animateMiniatureFromRestore(window, windowActor, ctx) {
        const { scale, targetX, targetY, extLeft, extTop, actorBefore_x, actorBefore_y, currentFrame, endCenterX, endCenterY } = ctx;
        const [actorW, actorH] = windowActor.get_size();

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

        // Frame is already shrunk to cs here, so its center rides that scale.
        const iconFly = {
            dx: visualX + currentFrame.width * cs / 2 - endCenterX,
            dy: visualY + currentFrame.height * cs / 2 - endCenterY,
            duration: animDuration,
        };

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
            onStopped: () => this._finishMiniatureAnim(window, windowActor),
        });

        return iconFly;
    }

    _animateMiniatureFresh(window, windowActor, ctx) {
        const { scale, targetX, targetY, extLeft, extTop, actorBefore_x, actorBefore_y, currentFrame, endCenterX, endCenterY } = ctx;
        const [actorW, actorH] = windowActor.get_size();

        WindowState.set(window, MINIATURE_ANIM_KIND, 'create');

        // Pivot at the exact frame anchor so scale tracks adjacent edges; tx/ty absorb residual when clamped past [0,1].
        const dw = actorW * (1 - scale);
        const dh = actorH * (1 - scale);
        const px = dw > 0 ? Math.max(0, Math.min(1, (targetX - actorBefore_x - extLeft * scale) / dw)) : 0;
        const py = dh > 0 ? Math.max(0, Math.min(1, (targetY - actorBefore_y - extTop * scale) / dh)) : 0;
        const tx = targetX - actorBefore_x - px * dw - extLeft * scale;
        const ty = targetY - actorBefore_y - py * dh - extTop * scale;

        const iconFly = {
            duration: Math.ceil(constants.MINIATURE_ANIM_MS * getSlowDownFactor()),
            dx: currentFrame.x + currentFrame.width / 2 - endCenterX,
            dy: currentFrame.y + currentFrame.height / 2 - endCenterY,
        };

        windowActor.remove_all_transitions();
        windowActor.set_pivot_point(px, py);
        windowActor.set_translation(0, 0, 0);

        windowActor.ease({
            scale_x: scale,
            scale_y: scale,
            translation_x: tx,
            translation_y: ty,
            duration: iconFly.duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._finishMiniatureAnim(window, windowActor),
        });

        return iconFly;
    }

    createMiniature(window, region, forcedPreSize = null, { animate = true } = {}) {
        const windowActor = window.get_compositor_private();
        if (!windowActor) return false;

        this._animationsManager?.removeAnimatingWindow(window.get_id());

        const { preSize, scale, targetX, targetY, actorBefore_x, actorBefore_y, currentFrame, extLeft, extTop } =
            this._computeMiniatureGeometry(window, windowActor, region, forcedPreSize);

        this._storeMiniatureState(window, windowActor, { scale, preSize, targetX, targetY, extLeft, extTop });

        // BinLayout gives icon center for free once flight translation reaches zero.
        const endCenterX = targetX + preSize.width * scale / 2;
        const endCenterY = targetY + preSize.height * scale / 2;
        let iconFly = { dx: 0, dy: 0, duration: 0 };

        if (animate) {
            const ctx = { scale, targetX, targetY, extLeft, extTop, actorBefore_x, actorBefore_y, currentFrame, endCenterX, endCenterY };
            WindowState.set(window, ANIMATING_MINIATURE, true);

            if (WindowState.get(window, MINIATURE_ANIM_KIND) === 'restore') {
                iconFly = this._animateMiniatureFromRestore(window, windowActor, ctx);
            } else {
                iconFly = this._animateMiniatureFresh(window, windowActor, ctx);
            }
        } else {
            // Instant: apply transforms synchronously so the overview's frozen
            // slot (already set to mini) matches the actor state from the first frame.
            applyMiniatureActorState(windowActor, scale, extLeft, extTop, targetX, targetY);
        }

        Logger.log(`[MINIATURE] createMiniature ${window.get_id()}: miniSize=${Math.round(preSize.width * scale)}x${Math.round(preSize.height * scale)}`);

        this._armMiniatureFocusGuard(window);

        this._miniatureWindows.set(window.get_id(), window);
        this.emit('miniature-created', window);

        this._attachMiniatureOverlay(window, windowActor, iconFly, animate);

        Logger.log(`[MINIATURE] Created miniature for ${window.get_id()}, scale=${scale.toFixed(4)}`);
        return true;
    }

    _computeMiniatureGeometry(window, windowActor, region, forcedPreSize) {
        const preSize = forcedPreSize || window.get_frame_rect();
        const scale = constants.MINIATURE_TARGET_SIZE_PX / Math.max(preSize.width, preSize.height);
        Logger.log(`[MINIATURE] createMiniature ${window.get_id()}: preSize=${preSize.width}x${preSize.height} scale=${scale} forced=${!!forcedPreSize}`);

        const targetX = region.x;
        const targetY = region.y;

        const [actorBefore_x, actorBefore_y] = windowActor.get_position();
        const currentFrame = window.get_frame_rect();

        // buffer rect vs frame rect is stable; actor position isn't. After back-to-back
        // move_resize_frame the compositor lags, baking stale gap into extLeft/extTop.
        const bufferRect = window.get_buffer_rect();
        const extLeft = currentFrame.x - bufferRect.x;
        const extTop = currentFrame.y - bufferRect.y;
        Logger.log(`[MINIATURE] createMiniature ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): preFrame=(${preSize.x},${preSize.y} ${preSize.width}x${preSize.height}) slot=${Math.round(preSize.width * scale)}x${Math.round(preSize.height * scale)} currentFrame=(${currentFrame.x},${currentFrame.y} ${currentFrame.width}x${currentFrame.height}) actorBefore=(${actorBefore_x},${actorBefore_y}) target=(${targetX},${targetY}) scale=${scale.toFixed(4)} extLeft=${extLeft} extTop=${extTop}`);

        return { preSize, scale, targetX, targetY, actorBefore_x, actorBefore_y, currentFrame, extLeft, extTop };
    }

    _storeMiniatureState(window, windowActor, { scale, preSize, targetX, targetY, extLeft, extTop }) {
        // Store before animation; enforce effect + workspace patch read these during anim.
        WindowState.set(window, IS_MINIATURE, true);
        WindowState.set(window, MINIATURE_SCALE, scale);
        WindowState.set(window, PRE_MINIATURE_SIZE, { width: preSize.width, height: preSize.height });
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
        WindowState.set(window, MINIATURE_EXT_LEFT, extLeft);
        WindowState.set(window, MINIATURE_EXT_TOP, extTop);

        // Finish entrance fade so mini doesn't render half-transparent mid-fade.
        if (WindowState.get(window, 'pendingFirstPlacement')) {
            WindowState.remove(window, 'pendingFirstPlacement');
            windowActor.remove_transition('opacity');
            windowActor.opacity = 255;
        }

        windowActor.add_effect(new MiniatureEnforceEffect(window));
    }

    // Guard blocks restore forever if registry can't expire it.
    _armMiniatureFocusGuard(window) {
        if (!this._timeoutRegistry) return;

        WindowState.set(window, 'justMiniaturized', true);
        const timeoutId = this._timeoutRegistry.add(constants.MINIATURE_FOCUS_GUARD_MS, () => {
            WindowState.remove(window, 'justMiniaturized');
            WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
            return GLib.SOURCE_REMOVE;
        }, 'miniature_focusGuard');
        WindowState.set(window, 'miniatureJustMiniaturizedTimeoutId', timeoutId);
    }

    _attachMiniatureOverlay(window, windowActor, iconFly, animate) {
        const overlay = new MiniatureClickOverlay(window, this);
        global.window_group.insert_child_above(overlay, windowActor);
        WindowState.set(window, MINIATURE_OVERLAY, overlay);

        // Ease is already running on the same frame clock; icon still lands with it.
        overlay.flyIconIn(iconFly.dx, iconFly.dy, animate ? iconFly.duration : 0);
        if (this._overviewActive) overlay.setIconSuppressed('overview', true);
    }

    restoreMiniature(window, _newSlot, { activate = true } = {}) {
        if (!WindowState.get(window, IS_MINIATURE)) return false;

        const windowActor = window.get_compositor_private();
        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
        const tgt = WindowState.get(window, MINIATURE_TARGET_POS);

        const frame = window.get_frame_rect();
        Logger.log(`[MINIATURE] restoreMiniature START ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): frame=(${frame.x},${frame.y} ${frame.width}x${frame.height}) scale=${sc.toFixed(4)}`);

        WindowState.remove(window, IS_MINIATURE);

        this._fadeMiniatureOverlay(window);

        if (windowActor) {
            this._animateRestore(window, windowActor, { sc, tgt, activate });
        }

        this._snapshotRestoreAnchor(window, tgt, sc);
        this._clearMiniatureState(window);

        this._miniatureWindows.delete(window.get_id());
        this.emit('miniature-restored', window);

        Logger.log(`[MINIATURE] Restored miniature ${window.get_id()}`);
        return true;
    }

    // Drop from state first so tiling stops finding it during icon fade-out.
    _fadeMiniatureOverlay(window) {
        const overlay = WindowState.get(window, MINIATURE_OVERLAY);
        if (!overlay) return;
        WindowState.remove(window, MINIATURE_OVERLAY);
        overlay.fadeOutAndDestroy(Math.ceil(constants.MINIATURE_ICON_FADE_OUT_MS * getSlowDownFactor()));
    }

    _removeEnforceEffect(windowActor) {
        for (const effect of windowActor.get_effects()) {
            if (effect instanceof MiniatureEnforceEffect) {
                windowActor.remove_effect(effect);
                break;
            }
        }
    }

    _animateRestore(window, windowActor, { sc, tgt, activate }) {
        this._removeEnforceEffect(windowActor);

        const extL = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
        const extT = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
        const frame = window.get_frame_rect();
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

        // Set after remove_all_transitions: create's onStopped fires synchronously and removes
        // MINIATURE_ANIM_KIND, so setting before would be overwritten.
        windowActor.remove_all_transitions();
        WindowState.set(window, MINIATURE_ANIM_KIND, 'restore');

        windowActor.set_pivot_point(startPivotX, startPivotY);
        windowActor.set_scale(startScale, startScale);
        windowActor.set_translation(startTx, startTy, 0);

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

    // Snapshot before clearing; layout scorer uses this to pull window back near its slot.
    _snapshotRestoreAnchor(window, tgt, sc) {
        const anchorPre = WindowState.get(window, PRE_MINIATURE_SIZE);
        if (!tgt || !anchorPre) return;

        const cx = tgt.x + (anchorPre.width * sc) / 2;
        const cy = tgt.y + (anchorPre.height * sc) / 2;
        WindowState.set(window, 'restoreAnchorCenter', { cx, cy });
        Logger.log(`[RESTORE ANCHOR] ${window.get_id()}: slot center (${cx.toFixed(0)},${cy.toFixed(0)})`);
    }

    _clearMiniatureState(window) {
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);
        // Stale mini-target persists when min size blocks tryFitWithResize; clear so next layout
        // doesn't use obsolete mini size.
        WindowState.remove(window, 'targetSmartResizeSize');

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) this._timeoutRegistry?.remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');
    }

    destroyMiniature(window) {
        const windowActor = window.get_compositor_private();

        WindowState.remove(window, IS_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);

        // Orphaned reactive actor would capture clicks on a dead window.
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

    // Mutter restacks window actors but not our overlays, so pin each back when stack moves.
    syncOverlayStacking() {
        for (const window of this._miniatureWindows.values()) {
            const overlay = WindowState.get(window, MINIATURE_OVERLAY);
            const actor = window.get_compositor_private();
            const parent = actor?.get_parent();
            if (overlay && parent && overlay.get_parent() === parent)
                parent.set_child_above_sibling(overlay, actor);
        }
    }

    setOverviewActive(active) {
        this._overviewActive = active;
        for (const window of this._miniatureWindows.values())
            WindowState.get(window, MINIATURE_OVERLAY)?.setIconSuppressed('overview', active);
    }

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

    // Screenshot grabs actor straight off stage; snap miniature back to full size first.
    pauseForScreenshot() {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(w => WindowState.get(w, IS_MINIATURE));
        for (const window of windows) {
            const actor = window.get_compositor_private();
            if (!actor) continue;
            WindowState.set(window, MINIATURE_SCREENSHOT_PAUSE, true);
            WindowState.get(window, MINIATURE_OVERLAY)?.setIconSuppressed('screenshot', true);
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
            WindowState.get(window, MINIATURE_OVERLAY)?.setIconSuppressed('screenshot', false);
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
        for (const window of this._miniatureWindows.values())
            this.destroyMiniature(window);
        this._miniatureWindows.clear();
        this._timeoutRegistry = null;
        this._wmPrefs = null;
        this._mutterSettings = null;
    }

    getMiniatureSize(window) {
        return getMiniatureSize(window);
    }

    findMiniatureAtPoint(x, y) {
        if (this._miniatureWindows.size === 0) return null;
        for (const window of this._miniatureWindows.values()) {
            const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
            const scale = WindowState.get(window, MINIATURE_SCALE);
            const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
            if (!tgt || !scale || !preSize) continue;
            const ox = tgt.x;
            const oy = tgt.y;
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
