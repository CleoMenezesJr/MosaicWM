// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Enforces mosaic regions from inside Mutter's own constraint pass

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Logger from './logger.js';
import { isWindowAlive } from './liveness.js';

// The interface predates the rect being writable; without set_rect (Mutter 51) the vfunc
// can only read, so the whole path stays off. Feature-detected since a backport would
// make a version check lie.
let _supported = null;
export function constraintSupported() {
    if (_supported === null) {
        _supported = typeof Meta.ExternalConstraintInfo?.prototype?.set_rect === 'function' &&
            typeof Meta.Window?.prototype?.add_external_constraint === 'function';
        Logger.log(`External constraint support: ${_supported}`);
    }
    return _supported;
}

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
    }

    // A move_resize_frame the solver cannot amend, since the armed constraint outranks
    // the work-area clamp.
    commitRegion(window, region, userOp = false) {
        if (!constraintSupported()) {
            window.move_resize_frame(userOp, region.x, region.y, region.width, region.height);
            return;
        }

        const { constraint } = this._ensure(window);
        constraint.armed = region;
        try {
            window.move_resize_frame(userOp, region.x, region.y, region.width, region.height);
        } finally {
            constraint.armed = null;
        }
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
    }
}

// The geometry writers are plain classes (Level, WindowDescriptor) with no path back to the
// extension object, so the manager is reached the same way MosaicModel is. Constructing it
// touches nothing in the Shell; the first GObject only appears when a window is committed.
export const MosaicConstraints = new MosaicConstraintManager();
