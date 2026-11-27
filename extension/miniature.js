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

// A miniature's region and MINIATURE_TARGET_POS define its frame like any tiled window,
// with the CSD shadow rendered beyond it; the overview draws the frame into that same region.
// Assumes pivot (0,0). get_position() gives the untransformed allocation, so this holds at any
// current scale; once scaled, the frame sits ext*scale within the buffer's origin.
// Rounded since nothing snaps a translation, and a frame edge on a half pixel draws a grey line.
function frameTranslation(actor, scale, targetX, targetY) {
    const window = actor.meta_window;
    const [ax, ay] = actor.get_position();
    return {
        tx: Math.round(targetX) - ax - (WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0) * scale,
        ty: Math.round(targetY) - ay - (WindowState.get(window, MINIATURE_EXT_TOP) ?? 0) * scale,
    };
}

function miniatureScaleToFit(window, region) {
    const frame = window.get_frame_rect();
    return Math.min(region.width / frame.width, region.height / frame.height);
}

// On GNOME Wayland, move_frame is ASYNC and Mutter may REJECT the target
// position if the frame rect (original, unscaled size) would extend beyond
// the monitor. So we cannot rely on move_frame to place the actor.
// Instead compute translation from the actor's position so the scaled frame lands on
// the target: tx = targetX - actorX - extLeft * scale.
export function applyMiniatureActorState(actor, scale, targetX, targetY) {
    const [ax, ay] = actor.get_position();
    const [actorW, actorH] = actor.get_size();
    actor.set_pivot_point(0, 0);
    actor.remove_all_transitions();
    actor.set_scale(scale, scale);
    const { tx, ty } = frameTranslation(actor, scale, targetX, targetY);
    actor.set_translation(tx, ty, 0);
    Logger.log(`[MINIATURE] applyMiniatureActorState: actor=( ${ax},${ay} ${actorW}x${actorH}) target=(${targetX},${targetY}) scale=${scale} tx=${tx} ty=${ty} FINAL_SIZE=${Math.round(actorW * scale)}x${Math.round(actorH * scale)}`);
}

export function animateMiniatureToTarget(actor, window, scale, targetX, targetY, duration, animationsManager = null) {
    const kind = WindowState.get(window, MINIATURE_ANIM_KIND);

    if (kind === 'create' || kind === 'restore') {
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
        return;
    }

    const curTx = actor.translation_x;
    const curTy = actor.translation_y;
    animationsManager?.stopTranslationEase(window.get_id());
    actor.remove_all_transitions();

    WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
    WindowState.set(window, ANIMATING_MINIATURE, true);
    WindowState.set(window, MINIATURE_ANIM_KIND, 'move');

    actor.set_pivot_point(0, 0);
    actor.set_scale(scale, scale);

    const { tx: targetTx, ty: targetTy } = frameTranslation(actor, scale, targetX, targetY);

    const onArrived = () => {
        WindowState.remove(window, ANIMATING_MINIATURE);
        WindowState.remove(window, MINIATURE_ANIM_KIND);
        const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
        const sc = WindowState.get(window, MINIATURE_SCALE);
        if (tgt && sc) applyMiniatureActorState(actor, sc, tgt.x, tgt.y);
    };

    if (constants.ANIMATION_EASING === 'house' && animationsManager) {
        animationsManager.animateTranslation(window, actor, {
            fromTx: curTx, fromTy: curTy, toTx: targetTx, toTy: targetTy, duration,
            onComplete: onArrived,
        });
        return;
    }

    actor.ease({
        translation_x: targetTx,
        translation_y: targetTy,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped: (isFinished) => {
            if (isFinished) onArrived();
        },
    });
}

// Mutter may clear actor transforms (workspace switch, sync_window_geometry) with no
// signals; this effect applies miniature transforms each frame at paint time, and
// locks the click overlay to the actor's live frame rect so icon and frame cannot drift.
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

        if (WindowState.get(this._window, MINIATURE_SCREENSHOT_PAUSE)) {
            super.vfunc_paint(...args);
            return;
        }

        if (!WindowState.get(this._window, ANIMATING_MINIATURE)) {
            const sc = WindowState.get(this._window, MINIATURE_SCALE);
            const tgt = WindowState.get(this._window, MINIATURE_TARGET_POS);

            if (sc && tgt) {
                actor.set_pivot_point(0, 0);
                actor.set_scale(sc, sc);
                const { tx, ty } = frameTranslation(actor, sc, tgt.x, tgt.y);
                actor.set_translation(tx, ty, 0);
            }
        }

        this._alignOverlayToFrame(actor);
        super.vfunc_paint(...args);
    }

    // Actor moves run on eased, instant and skipped timings, so a caller-side overlay write
    // does not stay glued; the live transform at paint is the one position that can't drift.
    _alignOverlayToFrame(actor) {
        // Reparented actors (overview, workspace switch) use parent-relative
        // coordinates; tracking is only meaningful in window_group space.
        if (actor.get_parent() !== global.window_group) return;

        const overlay = WindowState.get(this._window, MINIATURE_OVERLAY);
        const preSize = WindowState.get(this._window, PRE_MINIATURE_SIZE);
        if (!overlay || !preSize) return;

        const [ax, ay] = actor.get_position();
        const [actorW, actorH] = actor.get_size();
        const [px, py] = actor.get_pivot_point();
        const sx = actor.scale_x;
        const sy = actor.scale_y;
        const extL = (WindowState.get(this._window, MINIATURE_EXT_LEFT) ?? 0) * sx;
        const extT = (WindowState.get(this._window, MINIATURE_EXT_TOP) ?? 0) * sy;

        overlay.alignToFrame(
            ax + px * actorW * (1 - sx) + actor.translation_x + extL,
            ay + py * actorH * (1 - sy) + actor.translation_y + extT,
            preSize.width * sx,
            preSize.height * sy);
    }
});

const MiniatureClickOverlay = GObject.registerClass({
    GTypeName: 'MosaicMiniatureClickOverlay',
}, class MiniatureClickOverlay extends Clutter.Actor {
    _init(window, miniatureManager) {
        const { width, height } = getMiniatureSize(window);

        // MINIATURE_TARGET_POS names the frame's destination, and preSize is its size, so the box
        // wants no shadow-extent shift. An offset would place the centered icon away from the
        // Overview preview's own center, which follows the frame.
        const tgt = WindowState.get(window, MINIATURE_TARGET_POS);

        super._init({
            reactive: true,
            // The icon child would take on zero opacity, and this actor paints nothing regardless.
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

        // Some dialogs/XWayland clients lack an app; the overlay remains usable as a click target.
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

        // Reflect window actor visibility so the reactive overlay can't be picked from other
        // workspaces at the same screen position.
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
        // A tap never arrives at this window_group sibling as an emulated button press, and
        // Clutter.ClickAction is absent in GNOME 48+, so read the touch signal directly.
        this.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            restore();
            return Clutter.EVENT_STOP;
        });

        // Mutter maps the pointer to a window by climbing from the picked actor to a
        // MetaWindowActor. This overlay is a window_group sibling, so that climb ends here and
        // focus-follows-mouse never reaches the miniature. Perform the hover focus ourselves.
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

        // Each motion rearms the timer, so only a pointer that truly stops triggers it.
        this._cancelHoverRest();
        this._hoverRestId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.MINIATURE_HOVER_REST_MS, () => {
            this._hoverRestId = 0;
            this._restoreOnHover();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restoreOnHover() {
        if (this._destroyed || !WindowState.get(this._window, IS_MINIATURE)) return;
        // Reordering and edge tiling hold the miniature while a grab is active.
        if (global.display.is_grabbed()) return;
        // A window that has just shrunk beneath a stationary cursor would spring straight back out.
        if (WindowState.get(this._window, 'justMiniaturized')) return;

        Logger.log(`[MINIATURE] Hover focus restoring ${this._window.get_id()}`);
        this._miniatureManager.restoreMiniature(this._window, null);
    }

    _cancelHoverRest() {
        if (!this._hoverRestId) return;
        GLib.source_remove(this._hoverRestId);
        this._hoverRestId = 0;
    }

    // set_size takes hold on the next layout pass, so a size ease leaves BinLayout's centered icon
    // a frame behind; the translation closes that gap per paint.
    alignToFrame(x, y, width, height) {
        if (this._destroyed) return;
        this.set_position(x, y);
        this.set_size(width, height);
        if (!this._icon) return;
        const [allocW, allocH] = this.allocation.get_size();
        this._icon.set_translation((width - allocW) / 2, (height - allocH) / 2, 0);
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

    // The enforce effect moves the icon with the frame; only the delayed fade belongs to us.
    flyIconIn(duration) {
        if (this._destroyed || !this._icon) return;
        this._cancelIconDelay();
        this._icon.remove_all_transitions();

        if (duration <= 0) {
            this.showIcon(0);
            return;
        }

        this._icon.opacity = 0;
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
        this._icon.opacity = 0;
    }

    // Record the requester rather than a single flag (overview + screenshot can both want it gone).
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

    // Layout may recalculate the slot mid-ease; the final onStopped must re-apply the new target
    // instead of leaving the actor on a stale position.
    _finishMiniatureAnim(window, windowActor) {
        this._stopTranslationTakeover(window);
        WindowState.remove(window, ANIMATING_MINIATURE);
        WindowState.remove(window, MINIATURE_ANIM_KIND);
        windowActor.set_pivot_point(0, 0);
        if (!WindowState.get(window, IS_MINIATURE)) return;

        const finalTgt = WindowState.get(window, MINIATURE_TARGET_POS);
        const finalSc = WindowState.get(window, MINIATURE_SCALE);
        if (finalTgt && finalSc)
            applyMiniatureActorState(windowActor, finalSc, finalTgt.x, finalTgt.y);
        const [finalAx, finalAy] = windowActor.get_position();
        const [finalW, finalH] = windowActor.get_size();
        Logger.log(`[MINIATURE] createMiniature animation complete ${window.get_id()}: FINAL actor=(${finalAx},${finalAy} ${finalW}x${finalH}) scale=${finalSc} FINAL_VISUAL=${Math.round(finalW * finalSc)}x${Math.round(finalH * finalSc)}`);
    }

    // Shrinking directly from an interrupted restore: take the actor's live scale and translation
    // so the flight begins from the on-screen state, not a full-size frame.
    _animateMiniatureFromRestore(window, windowActor, ctx) {
        const { scale, targetX, targetY, extLeft, extTop, actorBefore_x, actorBefore_y } = ctx;
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

        // Set kind ahead of remove_all_transitions because restore's onStopped fires synchronously
        // and must observe 'create' to bypass its conditional removal; IS_MINIATURE is already true
        // (set above), so restore's actor reset is skipped as well.
        WindowState.set(window, MINIATURE_ANIM_KIND, 'create');
        windowActor.remove_all_transitions();

        windowActor.set_pivot_point(0, 0);
        windowActor.set_scale(cs, cs);
        windowActor.set_translation(startTx, startTy, 0);

        this._easeTransform(window, windowActor, {
            fromTx: startTx,
            fromTy: startTy,
            toTx: endTx,
            toTy: endTy,
            scale,
            duration: animDuration,
            onStopped: () => this._finishMiniatureAnim(window, windowActor),
        });

        return animDuration;
    }

    _animateMiniatureFresh(window, windowActor, ctx) {
        const { scale, targetX, targetY, extLeft, extTop, actorBefore_x, actorBefore_y } = ctx;
        const [actorW, actorH] = windowActor.get_size();

        WindowState.set(window, MINIATURE_ANIM_KIND, 'create');

        // Pivot on the exact frame point so scale follows adjacent edges; tx/ty absorb leftover
        // when clamped beyond [0,1].
        const dw = actorW * (1 - scale);
        const dh = actorH * (1 - scale);
        const px = dw > 0 ? Math.max(0, Math.min(1, (targetX - actorBefore_x - extLeft * scale) / dw)) : 0;
        const py = dh > 0 ? Math.max(0, Math.min(1, (targetY - actorBefore_y - extTop * scale) / dh)) : 0;
        const tx = targetX - actorBefore_x - px * dw - extLeft * scale;
        const ty = targetY - actorBefore_y - py * dh - extTop * scale;
        const animDuration = Math.ceil(constants.MINIATURE_ANIM_MS * getSlowDownFactor());

        windowActor.remove_all_transitions();
        windowActor.set_pivot_point(px, py);
        windowActor.set_translation(0, 0, 0);

        this._easeTransform(window, windowActor, {
            fromTx: 0,
            fromTy: 0,
            toTx: tx,
            toTy: ty,
            scale,
            duration: animDuration,
            onStopped: () => this._finishMiniatureAnim(window, windowActor),
        });

        return animDuration;
    }

    createMiniature(window, region, forcedPreSize = null, { animate = true } = {}) {
        const windowActor = window.get_compositor_private();
        if (!windowActor) return false;

        this._animationsManager?.removeAnimatingWindow(window.get_id());

        const { scale, targetX, targetY, actorBefore_x, actorBefore_y, currentFrame, extLeft, extTop } =
            this._computeMiniatureGeometry(window, windowActor, region, forcedPreSize);

        this._storeMiniatureState(window, windowActor, { scale, extLeft, extTop, targetX, targetY });

        let fadeDuration = 0;

        if (animate) {
            const ctx = { scale, targetX, targetY, extLeft, extTop, actorBefore_x, actorBefore_y };
            WindowState.set(window, ANIMATING_MINIATURE, true);

            if (WindowState.get(window, MINIATURE_ANIM_KIND) === 'restore') {
                fadeDuration = this._animateMiniatureFromRestore(window, windowActor, ctx);
            } else {
                fadeDuration = this._animateMiniatureFresh(window, windowActor, ctx);
            }
        } else {
            // Instant: write transforms synchronously so the overview's frozen slot (already set to
            // mini) matches actor state on frame one.
            applyMiniatureActorState(windowActor, scale, targetX, targetY);
        }

        Logger.log(`[MINIATURE] createMiniature ${window.get_id()}: miniSize=${Math.round(currentFrame.width * scale)}x${Math.round(currentFrame.height * scale)}`);

        this._armMiniatureFocusGuard(window);

        this._miniatureWindows.set(window.get_id(), window);
        this.emit('miniature-created', window);

        this._attachMiniatureOverlay(window, windowActor, fadeDuration, animate);

        Logger.log(`[MINIATURE] Created miniature for ${window.get_id()}, scale=${scale.toFixed(4)}`);
        return true;
    }

    _computeMiniatureGeometry(window, windowActor, region, forcedPreSize) {
        const preSize = forcedPreSize || window.get_frame_rect();

        const [actorWidth, actorHeight] = windowActor.get_size();
        const [actorBefore_x, actorBefore_y] = windowActor.get_position();
        const currentFrame = window.get_frame_rect();

        // buffer rect vs frame rect holds steady; actor position does not. After repeated
        // move_resize_frame the compositor lags, folding stale gap into extLeft/extTop.
        const bufferRect = window.get_buffer_rect();
        const extLeft = currentFrame.x - bufferRect.x;
        const extTop = currentFrame.y - bufferRect.y;

        const scale = miniatureScaleToFit(window, region);
        Logger.log(`[MINIATURE] createMiniature ${window.get_id()}: preSize=${preSize.width}x${preSize.height} actorSize=${actorWidth}x${actorHeight} region=(${region.width}x${region.height}) scale=${scale} forced=${!!forcedPreSize}`);

        const targetX = region.x;
        const targetY = region.y;

        Logger.log(`[MINIATURE] createMiniature ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): preFrame=(${preSize.x},${preSize.y} ${preSize.width}x${preSize.height}) slot=${Math.round(currentFrame.width * scale)}x${Math.round(currentFrame.height * scale)} currentFrame=(${currentFrame.x},${currentFrame.y} ${currentFrame.width}x${currentFrame.height}) actorBefore=(${actorBefore_x},${actorBefore_y}) target=(${targetX},${targetY}) scale=${scale.toFixed(4)} extLeft=${extLeft} extTop=${extTop}`);

        return { scale, targetX, targetY, actorBefore_x, actorBefore_y, currentFrame, extLeft, extTop };
    }

    _storeMiniatureState(window, windowActor, { scale, extLeft, extTop, targetX, targetY }) {
        // Persist before animating; enforce effect + workspace patch reads these during anim.
        WindowState.set(window, IS_MINIATURE, true);
        WindowState.set(window, MINIATURE_SCALE, scale);
        // The live frame scale was the fit basis; getMiniatureSize and every reshrink scale from
        // it.
        const frame = window.get_frame_rect();
        WindowState.set(window, PRE_MINIATURE_SIZE, { width: frame.width, height: frame.height });
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
        WindowState.set(window, MINIATURE_EXT_LEFT, extLeft);
        WindowState.set(window, MINIATURE_EXT_TOP, extTop);

        // Complete the entrance fade so mini does not draw half-transparent mid-fade.
        if (WindowState.get(window, 'pendingFirstPlacement')) {
            WindowState.remove(window, 'pendingFirstPlacement');
            WindowState.remove(window, 'entranceIntroduced');
            windowActor.remove_transition('opacity');
            windowActor.opacity = 255;
        }

        windowActor.add_effect(new MiniatureEnforceEffect(window));
    }

    // Guard blocks restore indefinitely when registry cannot expire it.
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

    _attachMiniatureOverlay(window, windowActor, fadeDuration, animate) {
        const overlay = new MiniatureClickOverlay(window, this);
        global.window_group.insert_child_above(overlay, windowActor);
        WindowState.set(window, MINIATURE_OVERLAY, overlay);

        overlay.flyIconIn(animate ? fadeDuration : 0);
        if (this._overviewActive) overlay.setIconSuppressed('overview', true);
    }

    // Further shrinks an already-miniaturized window in place: same actor, same overlay, only a
    // smaller scale. No-op if it isn't a miniature right now.
    reshrinkMiniature(window, region) {
        if (!WindowState.get(window, IS_MINIATURE)) return false;

        const windowActor = window.get_compositor_private();
        if (!windowActor) return false;

        this._animationsManager?.removeAnimatingWindow(window.get_id());

        const scale = miniatureScaleToFit(window, region);
        const targetX = region.x;
        const targetY = region.y;
        const { tx, ty } = frameTranslation(windowActor, scale, targetX, targetY);

        // Removing transitions makes the create ease's onStopped fire synchronously, snapping the
        // actor to its end state; capture the live transform first so the ease can continue from
        // it.
        const [actorW, actorH] = windowActor.get_size();
        const [px, py] = windowActor.get_pivot_point();
        const liveScale = windowActor.scale_x;
        const liveTx = windowActor.translation_x + px * actorW * (1 - liveScale);
        const liveTy = windowActor.translation_y + py * actorH * (1 - liveScale);

        windowActor.remove_all_transitions();
        windowActor.set_pivot_point(0, 0);
        windowActor.set_scale(liveScale, liveScale);
        windowActor.set_translation(liveTx, liveTy, 0);
        // Without the flag, the enforce effect writes the final transform at the next paint, and
        // that direct write loses this ease.
        WindowState.set(window, ANIMATING_MINIATURE, true);
        this._easeTransform(window, windowActor, {
            fromTx: liveTx,
            fromTy: liveTy,
            toTx: tx,
            toTy: ty,
            scale,
            duration: constants.MINIATURE_ANIM_MS,
            onStopped: (isFinished) => {
                if (!isFinished) return;
                this._stopTranslationTakeover(window);
                WindowState.remove(window, ANIMATING_MINIATURE);
                const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
                const sc = WindowState.get(window, MINIATURE_SCALE);
                if (tgt && sc) applyMiniatureActorState(windowActor, sc, tgt.x, tgt.y);
            },
        });

        WindowState.set(window, MINIATURE_SCALE, scale);
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });

        const size = getMiniatureSize(window);
        WindowState.get(window, MINIATURE_OVERLAY)?.set_size(size.width, size.height);

        Logger.log(`[MINIATURE] reshrinkMiniature ${window.get_id()}: scale=${scale.toFixed(4)} size=${size.width}x${size.height}`);
        return true;
    }

    // Every size reader scales from PRE_MINIATURE_SIZE, so following a late frame or the desktop
    // leaves layout and overview disagreeing. Returns whether anything moved.
    refitToFrame(window) {
        const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
        const frame = window.get_frame_rect();
        if (!preSize || (Math.abs(frame.width - preSize.width) <= 2 && Math.abs(frame.height - preSize.height) <= 2)) return false;

        const slot = getMiniatureSize(window);
        const scale = Math.min(slot.width / frame.width, slot.height / frame.height);
        WindowState.set(window, PRE_MINIATURE_SIZE, { width: frame.width, height: frame.height });
        WindowState.set(window, MINIATURE_SCALE, scale);
        Logger.log(`[MINIATURE] refitToFrame ${window.get_id()}: frame ${preSize.width}x${preSize.height} -> ${frame.width}x${frame.height}, scale=${scale.toFixed(4)}`);

        // Frozen paths (overview, screenshot pause) bypass paint tracking; keep their box up to
        // date.
        const freshSize = getMiniatureSize(window);
        WindowState.get(window, MINIATURE_OVERLAY)?.set_size(freshSize.width, freshSize.height);

        // A running ease reaches MINIATURE_SCALE at the end, so it picks this up on its own.
        const tgt = WindowState.get(window, MINIATURE_TARGET_POS);
        const actor = window.get_compositor_private();
        if (actor && tgt && !WindowState.get(window, ANIMATING_MINIATURE))
            applyMiniatureActorState(actor, scale, tgt.x, tgt.y);
        return true;
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

    _stopTranslationTakeover(window) {
        this._animationsManager?.stopTranslationEase(window.get_id());
    }

    // House curve owns translation, scale keeps the native curve so an interrupted scale-up keeps
    // its resume path; a takeover stops translation silently and owns it from then on.
    _easeTransform(window, windowActor, { fromTx, fromTy, toTx, toTy, scale, duration, onStopped }) {
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        if (constants.ANIMATION_EASING === 'house' && this._animationsManager) {
            this._animationsManager.animateTranslation(window, windowActor, {
                fromTx, fromTy, toTx, toTy, duration,
            });
            windowActor.ease({
                scale_x: scale,
                scale_y: scale,
                duration,
                mode,
                onStopped,
            });
            return;
        }
        windowActor.ease({
            scale_x: scale,
            scale_y: scale,
            translation_x: toTx,
            translation_y: toTy,
            duration,
            mode,
            onStopped,
        });
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
            // Miniaturize interrupted: capture the current visual frame origin before canceling
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

        // Set after remove_all_transitions: create's onStopped fires synchronously and clears
        // MINIATURE_ANIM_KIND, so earlier setting would be overwritten.
        this._stopTranslationTakeover(window);
        windowActor.remove_all_transitions();
        WindowState.set(window, MINIATURE_ANIM_KIND, 'restore');

        windowActor.set_pivot_point(startPivotX, startPivotY);
        windowActor.set_scale(startScale, startScale);
        windowActor.set_translation(startTx, startTy, 0);

        if (activate) window.activate(global.get_current_time());

        // A retile may interrupt this mid-flight (it shares the actor with animateWindow's own
        // position ease). Rather than snap to full size, resume the scale-up from where it stopped;
        // position has already been handed off to the interrupter by then.
        const continueScaleUp = (isFinished) => {
            if (!windowActor || windowActor.is_destroyed()) return;
            if (!isFinished) {
                this._resumeInterruptedRestore(window, windowActor, duration, continueScaleUp);
                return;
            }
            this._finishRestoreScaleUp(window, windowActor);
        };

        this._easeTransform(window, windowActor, {
            fromTx: startTx,
            fromTy: startTy,
            toTx: 0,
            toTy: 0,
            scale: 1.0,
            duration,
            onStopped: continueScaleUp,
        });

        // A concurrent smart resize (a sibling easing back in) can put a different real frame under
        // this same actor while the ease above is still running.
        // scale=1.0 always means "the actor's current native size"; if that native size changes
        // mid-ease, the on-screen box jumps as soon as the new buffer commits instead of continuing
        // to interpolate. Re-anchor at that moment.
        this._attachRestoreRaceGuard(window, windowActor, { actorW, actorH, extL, extT, duration, continueScaleUp });
    }

    // A retile can interrupt this mid-flight (it uses the same actor as animateWindow's own
    // position ease). Instead of snapping to full size, resume the scale-up from the cut-off point;
    // position is already handed off to whatever interrupted us.
    _resumeInterruptedRestore(window, windowActor, duration, continueScaleUp) {
        // The race guard's own remove_all_transitions() invokes this same callback with
        // isFinished=false before it has set the rebased scale/translation itself; starting a
        // second "pick back up" ease against that rebase is exactly the scale-property fight this
        // mechanism exists to avoid, so back off and let it finish.
        if (WindowState.get(window, 'restoreRaceGuardRebasing')) return;
        if (WindowState.get(window, IS_MINIATURE)) return;
        if (Math.abs(windowActor.scale_x - 1.0) < 0.001 && Math.abs(windowActor.scale_y - 1.0) < 0.001) {
            if (WindowState.get(window, MINIATURE_ANIM_KIND) === 'restore')
                WindowState.remove(window, MINIATURE_ANIM_KIND);
            this._detachRestoreRaceGuard(window, windowActor);
            return;
        }
        windowActor.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: continueScaleUp,
        });
    }

    _finishRestoreScaleUp(window, windowActor) {
        this._stopTranslationTakeover(window);
        if (WindowState.get(window, MINIATURE_ANIM_KIND) === 'restore')
            WindowState.remove(window, MINIATURE_ANIM_KIND);
        this._detachRestoreRaceGuard(window, windowActor);
        if (!WindowState.get(window, IS_MINIATURE)) {
            windowActor.set_pivot_point(0, 0);
            windowActor.set_scale(1.0, 1.0);
            windowActor.set_translation(0, 0, 0);
        }
        const [finalAx, finalAy] = windowActor.get_position();
        const [finalW, finalH] = windowActor.get_size();
        Logger.log(`[MINIATURE] restoreMiniature animation complete ${window.get_id()}: FINAL actor=(${finalAx},${finalAy} ${finalW}x${finalH})`);
    }

    // See the note above the call site for rationale. Meta.Window's own 'size-changed' fires on the
    // logical frame well before the actor's real pixel allocation catches up, so this tracks the
    // actor's reallocation instead, reusing the "preserve the visual box" math animations.js's
    // _computeInitialTransform uses for ordinary resizes.
    _attachRestoreRaceGuard(window, windowActor, { actorW, actorH, extL, extT, duration, continueScaleUp }) {
        this._detachRestoreRaceGuard(window, windowActor);
        let lastActorW = actorW;
        let lastActorH = actorH;

        const guardId = windowActor.connect('notify::allocation', () => {
            if (!windowActor || windowActor.is_destroyed()) return;
            if (WindowState.get(window, MINIATURE_ANIM_KIND) !== 'restore') return;

            const [newActorW, newActorH] = windowActor.get_size();
            if (Math.abs(newActorW - lastActorW) < 2 && Math.abs(newActorH - lastActorH) < 2) return;

            const [ax, ay] = windowActor.get_position();
            const [cpx, cpy] = windowActor.get_pivot_point();
            const curScaleX = windowActor.scale_x;
            const curScaleY = windowActor.scale_y;
            const curTx = windowActor.translation_x;
            const curTy = windowActor.translation_y;

            // Current absolute on-screen location of the logical (CSD-margin-excluded) content,
            // measured against the actor size this ease was last baselined on.
            const visualX = ax + cpx * lastActorW * (1 - curScaleX) + curTx + extL * curScaleX;
            const visualY = ay + cpy * lastActorH * (1 - curScaleY) + curTy + extT * curScaleY;
            const newScaleX = newActorW > 0 ? (lastActorW * curScaleX) / newActorW : curScaleX;
            const newScaleY = newActorH > 0 ? (lastActorH * curScaleY) / newActorH : curScaleY;

            // remove_all_transitions triggers continueScaleUp(isFinished=false) synchronously,
            // before this handler has set the rebased scale/translation; the flag tells it to hold
            // off instead of racing its own "pick back up" ease against this one.
            WindowState.set(window, 'restoreRaceGuardRebasing', true);
            this._stopTranslationTakeover(window);
            windowActor.remove_all_transitions();
            windowActor.set_pivot_point(0, 0);
            windowActor.set_scale(newScaleX, newScaleY);
            windowActor.set_translation(visualX - ax - extL * newScaleX, visualY - ay - extT * newScaleY, 0);

            Logger.log(`[MINIATURE] restore race guard rebased ${window.get_id()}: actor ${lastActorW}x${lastActorH} -> ${newActorW}x${newActorH}, scale ${curScaleX.toFixed(3)},${curScaleY.toFixed(3)} -> ${newScaleX.toFixed(3)},${newScaleY.toFixed(3)}`);

            lastActorW = newActorW;
            lastActorH = newActorH;

            this._easeTransform(window, windowActor, {
                fromTx: visualX - ax - extL * newScaleX,
                fromTy: visualY - ay - extT * newScaleY,
                toTx: 0,
                toTy: 0,
                scale: 1.0,
                duration,
                onStopped: continueScaleUp,
            });
            WindowState.remove(window, 'restoreRaceGuardRebasing');
        });

        WindowState.set(window, 'restoreRaceGuardId', guardId);
    }

    _detachRestoreRaceGuard(window, windowActor) {
        const guardId = WindowState.get(window, 'restoreRaceGuardId');
        if (guardId === undefined) return;
        WindowState.remove(window, 'restoreRaceGuardId');
        if (!windowActor) return;
        // By the time this runs, the actor may already be fully disposed rather than merely
        // Clutter-destroyed, so disconnect throws instead of returning cleanly.
        try {
            if (!windowActor.is_destroyed()) windowActor.disconnect(guardId);
        } catch (_e) {
            // Already absent; nothing to disconnect.
        }
    }

    // Snapshot prior to clearing; layout scorer uses it to pull window back near its slot.
    _snapshotRestoreAnchor(window, tgt, sc) {
        const anchorPre = WindowState.get(window, PRE_MINIATURE_SIZE);
        if (!tgt || !anchorPre) return;

        const cx = tgt.x + (anchorPre.width * sc) / 2;
        const cy = tgt.y + (anchorPre.height * sc) / 2;
        WindowState.set(window, 'restoreAnchorCenter', { cx, cy });
        Logger.log(`[RESTORE ANCHOR] ${window.get_id()}: slot center (${cx.toFixed(0)},${cy.toFixed(0)})`);
    }

    _clearMiniatureState(window) {
        WindowState.remove(window, ANIMATING_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);
        // A shrink target left over from before the window became a thumbnail is stale now; the
        // next layout would pack it instead of the restored size.
        WindowState.remove(window, 'targetSmartResizeSize');

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) this._timeoutRegistry?.remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');
    }

    destroyMiniature(window) {
        const windowActor = window.get_compositor_private();

        WindowState.remove(window, IS_MINIATURE);
        WindowState.remove(window, ANIMATING_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);

        // Reactive actor left orphaned would capture clicks on a dead window.
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

    // Mutter reorders window actors but not our overlays, so pin each back as the stack moves.
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

    // Screenshot grabs actor directly from stage; snap miniature back to full size first.
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
            if (actor && scale && tgt)
                applyMiniatureActorState(actor, scale, tgt.x, tgt.y);
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
            const size = getMiniatureSize(window);
            if (!tgt || !size) continue;
            if (x >= tgt.x && x <= tgt.x + size.width && y >= tgt.y && y <= tgt.y + size.height)
                return window;
        }
        return null;
    }
});

// Module-level helper letting tiling.js read miniature display size without a manager reference.
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
