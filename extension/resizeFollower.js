// Copyright 2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Keeps a resizing window drawn at its slot until the client's buffer catches up

import * as constants from './constants.js';

const settled = (frame, target) =>
    Math.abs(frame.width - target.width) <= constants.EASE_TARGET_TOLERANCE_PX &&
    Math.abs(frame.height - target.height) <= constants.EASE_TARGET_TOLERANCE_PX;

// A Wayland client commits the new size whenever it gets to it, sometimes well over a second
// later, so easing the scale to 1 shows the old buffer at its old size the moment the ease
// ends. Scaling to slot/frame instead keeps the slot filled, and each reallocation re-aims.
export function followResize(window, actor, target, { duration, mode, registry }) {
    let allocId = 0;
    let timeoutId = null;
    let last = window.get_frame_rect();

    const aim = d => {
        const frame = window.get_frame_rect();
        if (frame.width <= 0 || frame.height <= 0) return;
        const done = settled(frame, target);
        const sx = done ? 1 : target.width / frame.width;
        const sy = done ? 1 : target.height / frame.height;
        actor.ease({
            scale_x: sx,
            scale_y: sy,
            duration: d,
            mode,
            onStopped: isFinished => {
                if (!isFinished || actor.is_destroyed()) return;
                actor.set_scale(sx, sy);
            },
        });
        if (done) detach();
    };

    const detach = () => {
        if (allocId && !actor.is_destroyed()) actor.disconnect(allocId);
        allocId = 0;
        if (timeoutId !== null) registry?.remove(timeoutId);
        timeoutId = null;
    };

    // The actor resizes with the buffer in one frame, so the scale is rebased to keep what's on
    // screen still before easing on toward the slot.
    allocId = actor.connect('notify::allocation', () => {
        if (actor.is_destroyed()) return;
        const frame = window.get_frame_rect();
        if (frame.width <= 0 || frame.height <= 0) return;
        if (frame.width === last.width && frame.height === last.height) return;
        actor.remove_transition('scale-x');
        actor.remove_transition('scale-y');
        actor.set_scale(last.width * actor.scale_x / frame.width, last.height * actor.scale_y / frame.height);
        last = frame;
        aim(duration);
    });
    timeoutId = registry?.add(constants.RESIZE_CLAMP_MAX_WAIT_MS, () => {
        timeoutId = null;
        detach();
        if (!actor.is_destroyed()) actor.set_scale(1, 1);
        return false;
    }, 'resizeFollower_release') ?? null;

    aim(duration);
    // Leaving the scale where the follower had it would draw the window at a stale slot for good,
    // since nothing rebases it once the follower lets go.
    const cancel = ({ resetScale = false } = {}) => {
        detach();
        if (!resetScale || actor.is_destroyed()) return;
        actor.remove_transition('scale-x');
        actor.remove_transition('scale-y');
        actor.set_scale(1, 1);
    };
    return { cancel };
}
