// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Enforces mosaic regions from inside Mutter's own constraint pass

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import { isWindowAlive } from './liveness.js';

const MosaicRegionConstraint = GObject.registerClass({
    GTypeName: 'MosaicRegionConstraint',
    Implements: [Meta.ExternalConstraint],
}, class MosaicRegionConstraint extends GObject.Object {
    _init() {
        super._init();
        this.armed = null;
    }

    // The solver runs this on every pass for the window: user grabs and client resizes
    // included, with nothing saying who initiated. Armed only around our own commits,
    // so everyone else's geometry goes through untouched.
    vfunc_constrain(_window, info) {
        if (!this.armed) return false;
        info.set_rect(new Mtk.Rectangle({
            x: this.armed.x,
            y: this.armed.y,
            width: this.armed.width,
            height: this.armed.height,
        }));
        return true;
    }
});

export class MosaicConstraintManager {
    constructor() {
        // Keyed by window ID, not the GObject, to survive GI reference churn (same
        // reason windowState.js exists).
        this._entries = new Map();
        this._moving = new Map();
        this._requested = new Map();
    }

    // A move_resize_frame the solver cannot amend, since the armed constraint outranks
    // the work-area clamp.
    commitRegion(window, region, userOp = false) {
        this._recordRequest(window, region);
        const { constraint } = this._ensure(window);
        constraint.armed = region;
        try {
            window.move_resize_frame(userOp, region.x, region.y, region.width, region.height);
        } finally {
            constraint.armed = null;
        }
    }

    // Unarmed, Mutter clamps the move against the size the window still has, so near an edge the
    // frame lands short of the region before the resize ever reaches the client.
    moveThenCommit(window, region, userOp = false) {
        const id = window.get_id();
        const { constraint } = this._ensure(window);
        const frame = window.get_frame_rect();
        constraint.armed = { x: region.x, y: region.y, width: frame.width, height: frame.height };
        this._moving.set(id, region);
        try {
            window.move_frame(userOp, region.x, region.y);
        } finally {
            constraint.armed = null;
            this._moving.delete(id);
        }
        this.commitRegion(window, region, userOp);
    }

    // What the window is being moved to while the move's own position-changed is firing. The
    // frame then still has the old size, so learning it would overwrite the size we're committing.
    regionInFlight(window) {
        return this._moving.get(window.get_id()) ?? null;
    }

    // Every size we ask for goes through commitRegion, so a frame matching none of the recent
    // ones is a size the client picked itself, whatever state the ease bookkeeping is in.
    isOwnRequest(window, rect) {
        const tol = constants.EASE_TARGET_TOLERANCE_PX;
        return (this._requested.get(window.get_id()) ?? []).some(size =>
            Math.abs(rect.width - size.width) <= tol && Math.abs(rect.height - size.height) <= tol);
    }

    _recordRequest(window, region) {
        const id = window.get_id();
        const sizes = this._requested.get(id) ?? [];
        sizes.push({ width: region.width, height: region.height });
        if (sizes.length > constants.REQUESTED_SIZE_HISTORY) sizes.shift();
        this._requested.set(id, sizes);
    }

    _ensure(window) {
        const id = window.get_id();
        let entry = this._entries.get(id);
        if (!entry) {
            entry = { window, constraint: new MosaicRegionConstraint() };
            window.add_external_constraint(entry.constraint);
            this._entries.set(id, entry);
            Logger.log(`External constraint attached to window ${id}`);
        }
        return entry;
    }

    detach(window) {
        const id = window?.get_id?.();
        if (id === undefined) return;
        this._requested.delete(id);
        const entry = this._entries.get(id);
        if (!entry) return;
        // A dead window segfaults libmutter, so only live ones get the removal call.
        if (isWindowAlive(entry.window))
            entry.window.remove_external_constraint(entry.constraint);
        this._entries.delete(id);
    }

    // A constraint left behind after unload keeps a dead JS object pinned in the solver.
    destroy() {
        for (const entry of this._entries.values()) {
            if (isWindowAlive(entry.window))
                entry.window.remove_external_constraint(entry.constraint);
        }
        this._entries.clear();
        this._requested.clear();
    }
}

// The geometry writers are plain classes (Level, WindowDescriptor) with no path back to the
// extension object, so the manager is reached the same way MosaicModel is. Constructing it
// touches nothing in the Shell; the first GObject only appears when a window is committed.
export const MosaicConstraints = new MosaicConstraintManager();
