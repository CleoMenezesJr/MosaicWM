// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Smooth window animations for mosaic tiling

import * as Logger from './logger.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as constants from './constants.js';
import * as WindowState from './windowState.js';
import { MINIATURE_ANIM_KIND } from './windowState.js';
import { getAnimationsEnabled, getSlowDownFactor } from './timing.js';
import { MosaicConstraints } from './mosaicConstraint.js';
import { followResize } from './resizeFollower.js';
import { createEasing } from './easing.js';

import GObject from 'gi://GObject';

const ANIMATION_DURATION = constants.ANIMATION_DURATION_MS;
const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const ANIMATION_MODE_SUBTLE = Clutter.AnimationMode.EASE_OUT_QUAD;
const USE_HOUSE_CURVE = constants.ANIMATION_EASING === 'house';
const HOUSE_EASE = createEasing(constants.HOUSE_CURVE);

export const AnimationsManager = GObject.registerClass({
    GTypeName: 'MosaicAnimationsManager',
    Signals: {
        'animations-completed': {},
    },
}, class AnimationsManager extends GObject.Object {
    _init() {
        super._init();
        this._isDragging = false;
        this._animatingWindows = new Map(); // Window ID -> actor, drives animations-completed signal
        this._animatingTargets = new Map(); // Window ID -> last targetRect, to detect redundant retile calls
        this._translationTimelines = new Map(); // Window ID -> Clutter.Timeline owning translation_x/y
        this._opacityTimelines = new Map(); // Window ID -> { timeline, actor } owning the entrance fade
        this._pendingEntranceEases = new Map(); // Window ID -> ease params, for entrances deferred until the actor is mapped
        this._heldReTiling = null; // pass waiting for an unmapped entrant, so push and entrance start together
        this._resizeFollowers = new Map(); // Window ID -> follower keeping a slow client's actor at its slot
        this._justEndedDrag = false;
        this._resizingWindowId = null;
        this._timeoutRegistry = null;
        this._isOverviewActive = false;
        // Toggled by setMembershipChangeBounce around a close-triggered retile pass.
        this._membershipChangeBounce = false;
    }

    // It runs without needing animations; it is the only sign that a removal gets refused, and
    // seeing the choice here would erase that refusal.
    shakeRefusal(actor) {
        if (!actor || actor.is_destroyed?.()) return;

        // The property named home must be idle. If another easing handles translation_x, checking
        // it would stall the actor on that frame before later steps advance him.
        if (actor.get_transition('translation-x')) return;
        const window = actor.get_meta_window?.();
        if (window && this._translationTimelines.has(window.get_id())) return;

        const step = Math.ceil(constants.REFUSAL_SHAKE_MS / 4);
        const home = actor.translation_x;

        const hop = (dx, next) => actor.ease({
            translation_x: home + dx,
            duration: step,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: next,
        });

        hop(-8, () => hop(8, () => hop(-4, () => hop(0, null))));
    }

    setMembershipChangeBounce(active) {
        this._membershipChangeBounce = active;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    // The pointer owns the size from here, so a follower still holding the old slot would fight it.
    setResizingWindow(windowId) {
        if (windowId !== null) this._cancelResizeFollower(windowId, { resetScale: true });
        this._resizingWindowId = windowId;
    }

    getResizingWindowId() {
        return this._resizingWindowId;
    }

    // Drops entries whose actor no longer has the translation transition we
    // started. Something else (a miniature ease, an edge-tile preview) can take
    // over the actor and call remove_all_transitions() without going through
    // removeAnimatingWindow, which would otherwise wedge animations-completed
    // for the rest of the session. Checking the real Clutter state here means
    // a future leak site like that self-heals instead of needing to be hunted down.
    _pruneStaleAnimations() {
        for (const [id, actor] of this._animatingWindows) {
            let stale;
            try {
                // The house path owns translation through a timeline, so the transition probe
                // the Clutter path relies on would read it as already finished.
                stale = !actor || actor.is_destroyed() ||
                    (USE_HOUSE_CURVE
                        ? !this._translationTimelines.get(id)?.is_playing()
                        : !actor.get_transition('translation_x'));
            } catch (_e) {
                // Actor's underlying GObject was fully disposed (e.g. window destroyed
                // mid-animation), not merely Clutter-destroyed, so any method call
                // on it throws instead of returning a clean false/null.
                stale = true;
            }
            if (stale) {
                this._stopTranslationTimeline(id);
                this._animatingWindows.delete(id);
                this._animatingTargets.delete(id);
            }
        }
    }

    hasActiveAnimations() {
        this._pruneStaleAnimations();
        return this._animatingWindows.size > 0;
    }

    _checkAllAnimationsComplete() {
        this._pruneStaleAnimations();
        if (this._animatingWindows.size === 0) {
            this.emit('animations-completed');
        }
    }

    setOverviewActive(active) {
        this._isOverviewActive = active;
    }

    setDragging(dragging) {
        if (this._isDragging && !dragging) {
            this._justEndedDrag = true;
            this._timeoutRegistry.add(constants.DEBOUNCE_DELAY_MS, () => {
                this._justEndedDrag = false;
                return GLib.SOURCE_REMOVE;
            }, 'animations_dragEndDebounce');
        }
        if (dragging) this._cancelAllResizeFollowers({ resetScale: true });
        this._isDragging = dragging;
    }

    shouldAnimateWindow(window, draggedWindow = null) {
        if (!getAnimationsEnabled()) return false;
        if (Main.overview.visible) return false;
        // During active resize, position all sibling windows instantly (real-time retile)
        if (this._resizingWindowId !== null) {
            // A leaked id here would quietly stop every window animating, so log it
            Logger.log(`[ANIM-DIAG] shouldAnimate ${window.get_id()}: no ease (resizingWindowId=${this._resizingWindowId})`);
            return false;
        }

        if (draggedWindow && window.get_id() === draggedWindow.get_id()) {
            return false;
        }

        return true;
    }

    _animOptions(options) {
        const {
            duration = ANIMATION_DURATION,
            mode = null,
            onComplete = null,
            draggedWindow = null,
            subtle = false,
            userOp = false,
            firstPlacement = false,
            slideInOffset = null,
            hold = null,
        } = options;
        return { duration, mode, onComplete, draggedWindow, subtle, userOp, firstPlacement, slideInOffset, hold };
    }

    animateWindow(window, targetRect, options = {}) {
        const { duration, mode, onComplete, draggedWindow, subtle, userOp, firstPlacement, slideInOffset, hold } =
            this._animOptions(options);

        // These paths move the frame without an ease to re-aim a follower, so one still holding an
        // earlier slot would draw the window at the wrong size.
        if (!this.shouldAnimateWindow(window, draggedWindow)) {
            this._cancelResizeFollower(window.get_id(), { resetScale: true });
            this._applyWithoutAnimation(window, targetRect, { userOp, firstPlacement, onComplete });
            return;
        }

        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            this._cancelResizeFollower(window.get_id());
            this._applyNoActor(window, targetRect, { firstPlacement, onComplete });
            return;
        }

        // A tiny restore effect animates scale on this actor and takes recovery when cut (see
        // continueScaleUp in miniature.js); adding our own scale easing on top clashes with it for
        // the same property.
        const skipScale = WindowState.get(window, MINIATURE_ANIM_KIND) !== undefined;

        if (this._isRedundantRetile(window, targetRect)) {
            Logger.log(`[ANIM-DIAG] redundant retile skipped for ${window.get_id()}: target=(${targetRect.x},${targetRect.y} ${targetRect.width}x${targetRect.height}), miniAnimKind=${WindowState.get(window, MINIATURE_ANIM_KIND)}, actorScale=${windowActor.scale_x?.toFixed(3)},${windowActor.scale_y?.toFixed(3)}`);
            if (onComplete) onComplete();
            return;
        }

        // Must read translation/scale BEFORE remove_all_transitions(), since they reset after.
        const currentFrame = window.get_frame_rect();
        const currentTx = windowActor.translation_x;
        const currentTy = windowActor.translation_y;
        const currentScaleX = windowActor.scale_x;
        const currentScaleY = windowActor.scale_y;

        // Triggering remove_all_transitions initiates the prior onStopped(isFinished=false); the
        // check inside the ease callback exits immediately, avoiding duplicate shutdown.
        this._stopTranslationTimeline(window.get_id());
        windowActor.remove_all_transitions();
        this._cancelResizeFollower(window.get_id());

        this._animatingWindows.set(window.get_id(), windowActor);
        // skipScale rides along so a later call to the same target, once skipScale
        // drops (the miniature ease that owned scale has since finished), isn't
        // mistaken for already-delivered: that earlier pass never actually applied
        // the scale/size half of this target, only position.
        this._animatingTargets.set(window.get_id(), { ...targetRect, skipScale });

        const effectiveDuration = Math.ceil(duration * getSlowDownFactor());
        const animationMode = this._pickAnimationMode({ mode, subtle, firstPlacement });

        this._primeAndEase(window, windowActor, targetRect, {
            currentFrame, currentTx, currentTy, currentScaleX, currentScaleY, slideInOffset,
            userOp, skipScale, effectiveDuration, animationMode, firstPlacement, onComplete, hold,
        });
    }

    // Sets the actor's starting transform (the "no jump" continuity math) and the real
    // frame move together, then hands off to whichever ease path applies.
    _primeAndEase(window, windowActor, targetRect, opts) {
        const { currentFrame, currentTx, currentTy, currentScaleX, currentScaleY, slideInOffset,
            userOp, skipScale, effectiveDuration, animationMode, firstPlacement, onComplete, hold } = opts;

        const { initialTx, initialTy, initialScaleX, initialScaleY } = this._computeInitialTransform(
            { currentFrame, currentTx, currentTy, currentScaleX, currentScaleY, targetRect, slideInOffset });

        WindowState.set(window, 'isMosaicResizing', true);
        // A pure move applies to the actor's allocation immediately, but a Wayland
        // client only commits a matching buffer for an actual size change some time
        // after the configure request, not synchronously here. Moving first, before
        // asking for the new size, means the position component is already correct
        // by the time set_translation reads it below, regardless of how long the
        // resize itself takes to land. The size mismatch in the meantime is already
        // covered by the scale animation below, which doesn't depend on this.
        MosaicConstraints.moveThenCommit(window, targetRect, userOp);

        windowActor.set_translation(initialTx, initialTy, 0);
        if (!skipScale) {
            windowActor.set_pivot_point(0, 0);
            windowActor.set_scale(initialScaleX, initialScaleY);
        }

        const easeParams = { initialTx, initialTy, effectiveDuration, animationMode, skipScale, firstPlacement, onComplete, targetRect };

        // A reflow with an unmapped entrant parks every actor here instead of starting piecemeal;
        // the pass that starts the slide must start the push on the same frame.
        if (hold) {
            hold.entries.push({ window, windowActor, easeParams });
            return;
        }

        // Clutter silently skips implicit transitions on actors that aren't mapped yet
        // (should_skip_implicit_transition in clutter-actor.c) and just snaps to the
        // final value. A first placement can easily run this early since this pipeline
        // outpaces the actor's own mapping, so defer until onWindowCreated (windowHandler.js)
        // confirms it's mapped, instead of calling ease() now and having it get skipped.
        if (firstPlacement && !windowActor.mapped) {
            this._pendingEntranceEases.set(window.get_id(), { windowActor, ...easeParams });
            return;
        }

        this._runEntranceEase(window, windowActor, easeParams);
    }

    _applyWithoutAnimation(window, targetRect, { userOp, firstPlacement, onComplete }) {
        this._stopTranslationTimeline(window.get_id());
        // move_resize_frame is a no-op while the overview is open (Mutter discards it). The
        // window still renders in the overview from the model, so it has to be visible there;
        // the entrance claim survives for the flush that plays once the overview hides.
        if (Main.overview.visible) {
            // The map-time opacity=0 still has to be cleared here: no ease is running to do it,
            // so the window would sit invisible until the 1s failsafe pops it in.
            if (firstPlacement) {
                const actor = window.get_compositor_private();
                if (actor && !actor.is_destroyed()) actor.opacity = 255;
            }
            if (onComplete) onComplete();
            return;
        }

        WindowState.set(window, 'isMosaicResizing', true);
        MosaicConstraints.commitRegion(window, targetRect, userOp);
        this._clearMosaicResizingSoon(window);
        if (firstPlacement) {
            WindowState.remove(window, 'pendingFirstPlacement');
            const actor = window.get_compositor_private();
            if (actor) actor.opacity = 255;
        }
        if (onComplete) onComplete();
    }

    _applyNoActor(window, targetRect, { firstPlacement, onComplete }) {
        Logger.log(`No actor for window ${window.get_id()}, skipping animation`);
        this._stopTranslationTimeline(window.get_id());
        WindowState.set(window, 'isMosaicResizing', true);
        MosaicConstraints.commitRegion(window, targetRect);
        this._clearMosaicResizingSoon(window);
        if (firstPlacement) WindowState.remove(window, 'pendingFirstPlacement');
        if (onComplete) onComplete();
    }

    // Redundant retile to the same destination already in flight (e.g. the
    // window-open queue re-evaluates the same window ~100ms later). Restarting
    // the ease would cut the original transition off before its EASE_OUT_BACK
    // overshoot plays, replacing a full bounce with an imperceptible one.
    _isRedundantRetile(window, targetRect) {
        const lastTarget = this._animatingTargets.get(window.get_id());
        // A skipScale delivery only ever applied position, so a later call for the
        // same rect still has real work to do (the size/scale half) and isn't redundant.
        return this._animatingWindows.has(window.get_id()) && lastTarget && !lastTarget.skipScale &&
            lastTarget.x === targetRect.x && lastTarget.y === targetRect.y &&
            lastTarget.width === targetRect.width && lastTarget.height === targetRect.height;
    }

    // Bounce is reserved for a window joining or leaving the workspace. Everything
    // else (miniaturize, swap, monitor change, exclusion, smart resize, edge snap)
    // keeps the same membership and stays subtle.
    _pickAnimationMode({ mode, subtle, firstPlacement }) {
        if (mode !== null) return mode;

        const isMembershipChange = firstPlacement || this._membershipChangeBounce;
        if (subtle || this._justEndedDrag || !isMembershipChange) return ANIMATION_MODE_SUBTLE;
        return ANIMATION_MODE;
    }

    _computeInitialTransform({ currentFrame, currentTx, currentTy, currentScaleX, currentScaleY, targetRect, slideInOffset }) {
        // idle  (currentTx=0): initialTx = frameX - targetX
        // moving (currentTx!=0): initialTx = (frameX + currentTx) - targetX  (no jump)
        // First placement has no prior visual position worth preserving, so start
        // from the slide-in offset instead of the "no jump" continuity math.
        const initialTx = slideInOffset ? slideInOffset.x : currentFrame.x + currentTx - targetRect.x;
        const initialTy = slideInOffset ? slideInOffset.y : currentFrame.y + currentTy - targetRect.y;

        // Same "no jump" logic, applied to visual size: preserves the actor's
        // current on-screen size if a previous resize ease is still in flight.
        const initialScaleX = targetRect.width > 0 ? (currentFrame.width * currentScaleX) / targetRect.width : 1;
        const initialScaleY = targetRect.height > 0 ? (currentFrame.height * currentScaleY) / targetRect.height : 1;

        return { initialTx, initialTy, initialScaleX, initialScaleY };
    }

    // Runs the actual translation/scale ease. Called either immediately from
    // animateWindow (actor already mapped) or later via runDeferredEntrance,
    // once windowHandler.js confirms the actor is mapped.
    _runEntranceEase(window, windowActor, { initialTx, initialTy, effectiveDuration, animationMode, skipScale, firstPlacement, onComplete, targetRect }) {
        // Position and scale run as separate animations. EASE_OUT_BACK overshoots past its
        // target and clamps there, so bundled into the same ease as translation it finishes
        // (and visually settles) well before the bouncy slide-in does. A resize that
        // overshoots reads as a glitch.
        if (!skipScale) {
            this._resizeFollowers.set(window.get_id(), followResize(window, windowActor, targetRect, {
                duration: effectiveDuration, mode: ANIMATION_MODE_SUBTLE, registry: this._timeoutRegistry,
            }));
        }

        // The map-time opacity=0 was only ever a placeholder until this real pass
        // knew where to slide in from. Needed even with no offset (e.g. the very
        // first window in an empty workspace), otherwise it never finishes fading in.
        if (firstPlacement) {
            if (USE_HOUSE_CURVE) {
                this._startEntranceOpacity(window, windowActor, effectiveDuration);
            } else {
                windowActor.ease({
                    opacity: 255,
                    duration: effectiveDuration,
                    mode: ANIMATION_MODE_SUBTLE,
                    onStopped: (isFinished) => {
                        if (!isFinished) return;
                        if (windowActor && !windowActor.is_destroyed())
                            windowActor.opacity = 255;
                    }
                });
            }
        }

        if (USE_HOUSE_CURVE) {
            this._easeTranslationWithHouseCurve(window, windowActor, {
                initialTx, initialTy, effectiveDuration, firstPlacement, onComplete,
            });
            return;
        }

        windowActor.ease({
            translation_x: 0,
            translation_y: 0,
            duration: effectiveDuration,
            mode: animationMode,
            onStopped: (isFinished) => {
                if (!isFinished) return; // redirect in progress; new animation owns cleanup
                this._finishTranslationEase(window, windowActor, { firstPlacement, onComplete });
            }
        });
    }

    // A Clutter ease only takes an enum curve, so the house bezier drives translation from a
    // timeline instead. Everything after the curve (cleanup, redirect, completion) is the same
    // contract the Clutter path signs.
    _easeTranslationWithHouseCurve(window, windowActor, { initialTx, initialTy, effectiveDuration, firstPlacement, onComplete }) {
        this.animateTranslation(window, windowActor, {
            fromTx: initialTx,
            fromTy: initialTy,
            toTx: 0,
            toTy: 0,
            duration: effectiveDuration,
            onComplete: () => this._finishTranslationEase(window, windowActor, { firstPlacement, onComplete }),
        });
    }

    // Shared with the miniature path, whose leg ends on the slot rect instead of zero. A takeover
    // stop stays silent; whoever interrupted owns translation from then on.
    animateTranslation(window, windowActor, { fromTx, fromTy, toTx, toTy, duration, onComplete }) {
        const id = window.get_id();
        this._stopTranslationTimeline(id);
        // A clockless timeline never ticks; binding it to the actor picks up the stage view's clock.
        const timeline = new Clutter.Timeline({
            duration: Math.max(1, duration),
            actor: windowActor,
        });
        this._translationTimelines.set(id, timeline);

        timeline.connect('new-frame', tl => {
            if (windowActor.is_destroyed()) {
                tl.stop();
                return;
            }
            const eased = HOUSE_EASE(tl.get_progress());
            windowActor.set_translation(
                fromTx + (toTx - fromTx) * eased,
                fromTy + (toTy - fromTy) * eased,
                0);
        });

        timeline.connect('stopped', (_tl, isFinished) => {
            if (!isFinished) return; // redirect in progress; new animation owns cleanup
            if (this._translationTimelines.get(id) === timeline) this._translationTimelines.delete(id);
            if (onComplete) onComplete();
        });

        timeline.start();
    }

    _finishTranslationEase(window, windowActor, { firstPlacement, onComplete }) {
        if (windowActor && !windowActor.is_destroyed())
            windowActor.set_translation(0, 0, 0);
        if (firstPlacement) WindowState.remove(window, 'pendingFirstPlacement');
        this._animatingWindows.delete(window.get_id());
        this._animatingTargets.delete(window.get_id());
        this._checkAllAnimationsComplete();
        WindowState.set(window, 'isMosaicResizing', false);
        if (onComplete) onComplete();
    }

    // Translation ownership moves to a takeover ease (miniature, drag preview); a running
    // timeline would keep writing it behind their back.
    stopTranslationEase(windowId) {
        this._stopTranslationTimeline(windowId);
    }

    _stopTranslationTimeline(windowId) {
        const timeline = this._translationTimelines.get(windowId);
        if (!timeline) return;
        this._translationTimelines.delete(windowId);
        timeline.stop();
    }

    // The house curve settles the slide long before 250ms, so a native fade would leave the
    // window sitting in place while still translucent. Same curve, same clock.
    _startEntranceOpacity(window, windowActor, duration) {
        const id = window.get_id();
        this._stopOpacityTimeline(id);
        const startOpacity = windowActor.opacity;
        const timeline = new Clutter.Timeline({ duration: Math.max(1, duration), actor: windowActor });
        this._opacityTimelines.set(id, { timeline, actor: windowActor });

        timeline.connect('new-frame', tl => {
            if (windowActor.is_destroyed()) {
                if (this._opacityTimelines.get(id)?.timeline === timeline)
                    this._opacityTimelines.delete(id);
                tl.stop();
                return;
            }
            const eased = HOUSE_EASE(tl.get_progress());
            windowActor.set_opacity(Math.round(startOpacity + (255 - startOpacity) * eased));
        });

        timeline.connect('stopped', (_tl, isFinished) => {
            if (!isFinished) return; // a newer fade continues from the current value
            if (this._opacityTimelines.get(id)?.timeline === timeline)
                this._opacityTimelines.delete(id);
            if (!windowActor.is_destroyed()) windowActor.set_opacity(255);
        });

        timeline.start();
    }

    _stopOpacityTimeline(windowId) {
        const entry = this._opacityTimelines.get(windowId);
        if (!entry) return;
        this._opacityTimelines.delete(windowId);
        entry.timeline.stop();
    }

    // Called from windowHandler.js's onWindowCreated once the actor is confirmed
    // mapped, safe to ease now that Clutter will no longer skip the transition outright.
    runDeferredEntrance(window) {
        if (this._heldReTiling?.entrantId === window.get_id())
            this._releaseHeldReTiling();

        const pending = this._pendingEntranceEases.get(window.get_id());
        if (!pending) return;
        this._pendingEntranceEases.delete(window.get_id());
        const { windowActor, ...easeParams } = pending;
        if (!windowActor || windowActor.is_destroyed()) return;
        this._runEntranceEase(window, windowActor, easeParams);
    }

    // onWindowAdded and onWindowCreated race independently (no guaranteed order), and
    // both can claim a window's entrance. If onWindowCreated already started or queued
    // the real ease, onWindowAdded must not reset opacity back to 0 behind its back.
    // That's a direct, non-eased property write, which stomps the fade mid-flight and
    // reads as a visible blink once the ease's own next frame overwrites it again.
    hasActiveOrPendingEntrance(window) {
        const id = window.get_id();
        return this._pendingEntranceEases.has(id) || this._animatingWindows.has(id);
    }

    animateReTiling(windowLayouts, draggedWindow = null, miniLayouts = []) {
        // A new window pushes siblings to make room; bounce those too, not just the entrant.
        const passHasEntrant = windowLayouts.some(({ window }) => WindowState.get(window, 'pendingFirstPlacement')) ||
            miniLayouts.some(({ window }) => WindowState.get(window, 'pendingFirstPlacement'));
        const previousMembershipChangeBounce = this._membershipChangeBounce;
        if (passHasEntrant) this._membershipChangeBounce = true;

        const forcedIds = this._cancelHeldReTiling();
        const pushDistance = passHasEntrant ? this._measurePushDistance(windowLayouts) : null;
        const entrant = passHasEntrant ? this._findUnmappedEntrant(windowLayouts, miniLayouts) : null;
        const hold = entrant ? { entrantId: entrant.get_id(), entries: [], timerId: null } : null;

        try {
            this._animateReTilingPass(windowLayouts, draggedWindow, miniLayouts, pushDistance, hold, forcedIds);
        } finally {
            this._membershipChangeBounce = previousMembershipChangeBounce;
        }

        if (hold && hold.entries.length > 0) {
            this._heldReTiling = hold;
            // A client that never maps must not freeze the reflow; release the push without it.
            hold.timerId = this._timeoutRegistry.add(constants.ENTRANT_HOLD_MS, () => {
                if (this._heldReTiling === hold) this._releaseHeldReTiling();
                return GLib.SOURCE_REMOVE;
            }, 'animations_entrant_hold');
        }
    }

    _animateReTilingPass(windowLayouts, draggedWindow, miniLayouts, pushDistance = null, hold = null, forcedIds = new Set()) {
        for (const { window, rect } of windowLayouts) {
            // Cleared by animateWindow once this placement actually finishes (not
            // here), since a single window-open burst can recurse through several
            // tileWorkspaceWindows passes, and each one needs to still see this
            // as a first placement, not just whichever pass happens to run first.
            const isFirstPlacement = WindowState.get(window, 'pendingFirstPlacement');

            const currentRect = window.get_frame_rect();

            const needsMove = this._rectMoved(currentRect, rect);

            // A held pass already committed its frames; re-prime those windows even when the
            // target matches, or their parked actors would never receive an ease.
            const forced = forcedIds.has(window.get_id());

            // A first placement still needs to run through animateWindow even when
            // the raw spawn position happens to already match the target, since it
            // owns clearing the opacity=0 onWindowAdded left it at and the slide-in offset.
            if (!needsMove && !isFirstPlacement && !forced) {
                MosaicConstraints.commitRegion(window, rect);
                continue;
            }

            // Include pending miniature siblings too: they're real neighbors for
            // direction purposes even though they're excluded from windowLayouts
            // (createMiniature owns their own animation, not this loop).
            const slideInOffset = isFirstPlacement
                ? this._computeSlideInOffset(window, rect, windowLayouts.concat(miniLayouts), pushDistance)
                : null;

            this.animateWindow(window, rect, { draggedWindow, firstPlacement: isFirstPlacement, slideInOffset, hold });
        }
    }

    _rectMoved(currentRect, rect) {
        return Math.abs(currentRect.x - rect.x) > constants.ANIMATION_DIFF_THRESHOLD ||
            Math.abs(currentRect.y - rect.y) > constants.ANIMATION_DIFF_THRESHOLD ||
            Math.abs(currentRect.width - rect.width) > constants.ANIMATION_DIFF_THRESHOLD ||
            Math.abs(currentRect.height - rect.height) > constants.ANIMATION_DIFF_THRESHOLD;
    }

    // The entrant must travel as far as the window it pushes, otherwise it starts inside the
    // pushed window's old area and slides across it instead of pushing it. The before-position
    // is the frame plus its parked translation (same pair _computeInitialTransform reads).
    _measurePushDistance(windowLayouts) {
        let x = 0;
        let y = 0;
        for (const { window, rect } of windowLayouts) {
            if (WindowState.get(window, 'pendingFirstPlacement')) continue;
            const old = window.get_frame_rect();
            const actor = window.get_compositor_private();
            const alive = actor && !actor.is_destroyed();
            const tx = alive ? actor.translation_x : 0;
            const ty = alive ? actor.translation_y : 0;
            x = Math.max(x, Math.abs(rect.x - (old.x + tx)));
            y = Math.max(y, Math.abs(rect.y - (old.y + ty)));
        }
        return { x, y };
    }

    _findUnmappedEntrant(windowLayouts, miniLayouts) {
        for (const { window } of [...windowLayouts, ...miniLayouts]) {
            if (!WindowState.get(window, 'pendingFirstPlacement')) continue;
            const actor = window.get_compositor_private();
            if (!actor || !actor.mapped) return window;
        }
        return null;
    }

    // A newer pass supersedes the parked one. Its windows keep their committed frames but are
    // re-primed from the parked visual position, so they still end where the newest pass says.
    _cancelHeldReTiling() {
        const hold = this._heldReTiling;
        if (!hold) return new Set();
        this._heldReTiling = null;
        if (hold.timerId !== null) this._timeoutRegistry.remove(hold.timerId);

        const ids = new Set();
        for (const { window } of hold.entries) {
            const id = window.get_id();
            ids.add(id);
            this._animatingWindows.delete(id);
            this._animatingTargets.delete(id);
        }
        return ids;
    }

    _releaseHeldReTiling() {
        const hold = this._heldReTiling;
        if (!hold) return;
        this._heldReTiling = null;
        if (hold.timerId !== null) this._timeoutRegistry.remove(hold.timerId);

        for (const { window, windowActor, easeParams } of hold.entries) {
            if (!windowActor || windowActor.is_destroyed()) continue;
            if (easeParams.firstPlacement && !windowActor.mapped) {
                this._pendingEntranceEases.set(window.get_id(), { windowActor, ...easeParams });
                continue;
            }
            this._runEntranceEase(window, windowActor, easeParams);
        }
    }

    // Derives the slide-in push direction from the real final layout instead of
    // guessing from wherever Mutter happened to drop the window before tiling.
    // That raw position is arbitrary and can coincidentally land dead-center on
    // the existing window(s), silently producing a zero offset (no animation at all).
    //
    // TODO: always picks some direction once there's at least one sibling, even
    // when the window ends up boxed in by neighbors on every side with no clear
    // side to slide from. By the time this runs, windowHandler.js's _hasSiblings
    // has already decided to suppress Mutter's native animation (skipNextEffect),
    // so there's no going back to it here even if we detected the enclosure.
    _computeSlideInOffset(window, targetRect, windowLayouts, pushDistance = null) {
        const siblings = windowLayouts.filter(l => l.window.get_id() !== window.get_id());

        if (siblings.length === 0) {
            // Nothing to push against, so fall back to a workspace-switch cue, if any.
            const OFFSET = constants.SLIDE_IN_OFFSET_PX;
            const ws = window.get_workspace();
            const prevWSIndex = WindowState.get(window, 'previousWorkspace');
            if (ws && prevWSIndex !== undefined && prevWSIndex !== ws.index())
                return { x: (prevWSIndex < ws.index() ? -1 : 1) * OFFSET * 3, y: 0 };
            return null;
        }

        let centerX = 0, centerY = 0;
        for (const { rect } of siblings) {
            centerX += rect.x + rect.width / 2;
            centerY += rect.y + rect.height / 2;
        }
        centerX /= siblings.length;
        centerY /= siblings.length;

        const winCenterX = targetRect.x + targetRect.width / 2;
        const winCenterY = targetRect.y + targetRect.height / 2;
        const deltaX = winCenterX - centerX;
        const deltaY = winCenterY - centerY;
        const OFFSET = this._pushSlideOffset(deltaX, deltaY, pushDistance);

        return this._slideDirection(deltaX, deltaY, OFFSET);
    }

    _pushSlideOffset(deltaX, deltaY, pushDistance) {
        const axisDistance = Math.abs(deltaX) >= Math.abs(deltaY) ? pushDistance?.x : pushDistance?.y;
        return Math.max(constants.SLIDE_IN_OFFSET_PX, Math.round(axisDistance ?? 0));
    }

    _slideDirection(deltaX, deltaY, offset) {
        return Math.abs(deltaX) >= Math.abs(deltaY)
            ? { x: deltaX < 0 ? -offset : offset, y: 0 }
            : { x: 0, y: deltaY < 0 ? -offset : offset };
    }

    // Replays an entrance whose claim survived the overview-visible tile pass. A settle
    // pass at 'hidden' can beat the flush to the claim and start a slide at full opacity
    // (the overview branch restored it for the grid), which reads as no animation; restart
    // from opacity 0 so the fade lands like a first placement.
    animateDeferredEntrance(window, targetRect, windowLayouts) {
        const actor = window.get_compositor_private();
        if (actor && !actor.is_destroyed()) {
            this._stopTranslationTimeline?.(window.get_id());
            actor.remove_all_transitions();
            this._animatingWindows.delete(window.get_id());
            this._animatingTargets.delete(window.get_id());
            actor.opacity = 0;
        }
        this.animateWindow(window, targetRect, {
            firstPlacement: true,
            slideInOffset: this._computeSlideInOffset(window, targetRect, windowLayouts),
        });
    }

    // Where an in-flight ease is driving the window, so size-changed can tell the
    // ease's own move_resize_frame apart from a client committing a different size.
    getAnimatingTarget(windowId) {
        return this._animatingTargets.get(windowId) || null;
    }

    _cancelResizeFollower(windowId, opts) {
        this._resizeFollowers.get(windowId)?.cancel(opts);
        this._resizeFollowers.delete(windowId);
    }

    _cancelAllResizeFollowers(opts) {
        for (const id of [...this._resizeFollowers.keys()])
            this._cancelResizeFollower(id, opts);
    }

    removeAnimatingWindow(windowId) {
        this._stopTranslationTimeline(windowId);
        this._cancelResizeFollower(windowId);
        this._animatingTargets.delete(windowId);
        if (this._animatingWindows.delete(windowId)) {
            this._checkAllAnimationsComplete();
        }
    }

    // Drops any entrance ease still pending map before the window was excluded
    // from tiling, so it can't fire later and clobber the snap-to-visible reset.
    cancelPendingEntrance(window) {
        const id = window.get_id();
        this._pendingEntranceEases.delete(id);
        this.removeAnimatingWindow(id);
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
        this._cancelHeldReTiling();
        for (const id of [...this._translationTimelines.keys()])
            this._stopTranslationTimeline(id);
        for (const { timeline, actor } of [...this._opacityTimelines.values()]) {
            timeline.stop();
            if (actor && !actor.is_destroyed()) actor.set_opacity(255);
        }
        this._opacityTimelines.clear();
        this._cancelAllResizeFollowers({ resetScale: true });
        this._animatingWindows.clear();
        this._animatingTargets.clear();
        this._checkAllAnimationsComplete();
        this._isDragging = false;
    }

    destroy() {
        this.cleanup();
    }
});
