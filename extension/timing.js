// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Async utilities for timeout management

import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Logger from './logger.js';
import * as constants from './constants.js';

const FALLBACK_ANIMATION_MS = 250;

// Milliseconds, matching the constants these get compared against. The wall clock
// can step backwards on an NTP correction, and a negative delta reads as "just
// happened" to every dedupe and settle check we have.
export function monotonicNow() {
    return GLib.get_monotonic_time() / 1000;
}

export function getAnimationsEnabled() {
    return St.Settings.get().enable_animations;
}

export function getSlowDownFactor() {
    return St.Settings.get().slow_down_factor ?? 1.0;
}

function getWorkspaceSwitchDuration() {
    if (!getAnimationsEnabled()) return 0;

    const baseDuration = FALLBACK_ANIMATION_MS;
    return Math.ceil(baseDuration * getSlowDownFactor());
}

export class TimeoutRegistry {
    constructor() {
        this._timeouts = new Map();
        this._nextId = 1;
    }

    add(delay, callback, name = 'unnamed') {
        const registryId = this._nextId++;
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            const again = callback() === GLib.SOURCE_CONTINUE;
            if (!again)
                this._timeouts.delete(registryId);
            return again;
        });
        this._timeouts.set(registryId, { sourceId, name });
        return registryId;
    }

    addIdle(callback, name = 'unnamed', priority = GLib.PRIORITY_DEFAULT) {
        const registryId = this._nextId++;
        const sourceId = GLib.idle_add(priority, () => {
            const again = callback() === GLib.SOURCE_CONTINUE;
            if (!again)
                this._timeouts.delete(registryId);
            return again;
        });
        this._timeouts.set(registryId, { sourceId, name });
        return registryId;
    }

    addSeconds(seconds, callback, name = 'unnamed') {
        const registryId = this._nextId++;
        const sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            const again = callback() === GLib.SOURCE_CONTINUE;
            if (!again)
                this._timeouts.delete(registryId);
            return again;
        });
        this._timeouts.set(registryId, { sourceId, name });
        return registryId;
    }

    remove(registryId) {
        const entry = this._timeouts.get(registryId);
        if (entry) {
            GLib.source_remove(entry.sourceId);
            this._timeouts.delete(registryId);
        }
    }

    clearAll() {
        for (const [_, entry] of this._timeouts) {
            try {
                GLib.source_remove(entry.sourceId);
            } catch (e) {
                Logger.warn(`Failed to remove timeout: ${e.message}`);
            }
        }
        this._timeouts.clear();
    }

    get count() {
        return this._timeouts.size;
    }

    destroy() {
        this.clearAll();
    }
}

export function createDebounced(func, delay, registry) {
    let timeoutId = null;

    const debounced = function(...args) {
        if (timeoutId !== null) registry.remove(timeoutId);
        timeoutId = registry.add(delay, () => {
            timeoutId = null;
            func.apply(this, args);
            return GLib.SOURCE_REMOVE;
        });
    };

    debounced.cancel = () => {
        if (timeoutId !== null) {
            registry.remove(timeoutId);
            timeoutId = null;
        }
    };

    return debounced;
}

export function afterWorkspaceSwitch(callback, registry) {
    const duration = getWorkspaceSwitchDuration();

    if (duration === 0) {
        callback();
        return;
    }

    registry.add(duration, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}

export function afterAnimations(animationsManager, callback, registry, maxWait = 5000) {
    if (!getAnimationsEnabled() || !animationsManager?.hasActiveAnimations?.()) {
        callback();
        return;
    }

    let processed = false;
    let timeoutId = null;
    let signalId = null;

    const cleanup = () => {
        processed = true;
        if (timeoutId) registry.remove(timeoutId);
        if (signalId) animationsManager.disconnect(signalId);
        timeoutId = null;
        signalId = null;
    };

    const trigger = () => {
        if (processed) return;
        cleanup();
        callback();
    };

    signalId = animationsManager.connect('animations-completed', trigger);

    const adjustedMaxWait = Math.ceil(maxWait * getSlowDownFactor());
    timeoutId = registry.add(adjustedMaxWait, () => {
        Logger.log('afterAnimations: Safety timeout triggered');
        trigger();
        return GLib.SOURCE_REMOVE;
    });
}

export function waitForGeometry(window, callback, registry, maxAttempts = constants.GEOMETRY_WAIT_MAX_ATTEMPTS) {
    const frame = window.get_frame_rect();
    if (frame.width > 10 && frame.height > 10) {
        callback(window);
        return;
    }

    let signalId = null;
    let timeoutId = null;
    let processed = false;

    const cleanup = () => {
        processed = true;
        if (signalId) window.disconnect(signalId);
        if (timeoutId) registry.remove(timeoutId);
    };

    const trigger = () => {
        if (processed) return;
        cleanup();
        callback(window);
    };

    signalId = window.connect('size-changed', () => {
        const f = window.get_frame_rect();
        if (f.width > 10 && f.height > 10) {
            trigger();
        }
    });

    const timeoutDuration = maxAttempts * 50;
    timeoutId = registry.add(timeoutDuration, () => {
        Logger.log('waitForGeometry: Safety timeout triggered');
        trigger();
        return GLib.SOURCE_REMOVE;
    });
}

export function afterWindowClose(callback, registry) {
    if (!getAnimationsEnabled()) {
        callback();
        return;
    }

    const duration = FALLBACK_ANIMATION_MS * getSlowDownFactor();
    registry.add(duration + 50, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}
