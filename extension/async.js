// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Async utilities for timeout management

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Logger from './logger.js';
import * as constants from './constants.js';

const FALLBACK_ANIMATION_MS = 250;

let _animationsEnabled = null;

function getAnimationsEnabled() {
    if (_animationsEnabled === null) {
        try {
            const settings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
            _animationsEnabled = settings.get_boolean('enable-animations');
        } catch (e) {
            _animationsEnabled = true;
        }
    }
    return _animationsEnabled;
}

function getSlowDownFactor() {
    try {
        return St.Settings.get().slow_down_factor;
    } catch (e) {
        return 1.0;
    }
}

function getWorkspaceSwitchDuration() {
    if (!getAnimationsEnabled()) return 0;
    
    // Main.wm uses GNOME Shell's internal animation duration
    // The factor from St.Settings scales all animations
    const baseDuration = FALLBACK_ANIMATION_MS;
    return Math.ceil(baseDuration * getSlowDownFactor());
}

export function refreshAnimationsSetting() {
    _animationsEnabled = null;
}

export class TimeoutRegistry {
    constructor() {
        this._timeouts = new Map();
        this._nextId = 1;
    }

    add(delay, callback, name = 'unnamed') {
        const registryId = this._nextId++;
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(registryId);
            return callback();
        });
        this._timeouts.set(registryId, { sourceId, name });
        return registryId;
    }

    addSeconds(seconds, callback, name = 'unnamed') {
        const registryId = this._nextId++;
        const sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeouts.delete(registryId);
            return callback();
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
                Logger.warn(`[MOSAIC WM] Failed to remove timeout: ${e.message}`);
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
    
    // Add buffer to ensure animation is fully complete
    registry.add(duration + 50, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}

export function afterAnimations(animationsManager, callback, registry, maxWait = 1000) {
    if (!getAnimationsEnabled()) {
        callback();
        return;
    }
    
    const startTime = Date.now();
    const adjustedMaxWait = Math.ceil(maxWait * getSlowDownFactor());
    
    const check = () => {
        if (animationsManager?.hasActiveAnimations?.() && (Date.now() - startTime) < adjustedMaxWait) {
            registry.add(50, check);
            return GLib.SOURCE_REMOVE;
        }
        callback();
        return GLib.SOURCE_REMOVE;
    };
    
    registry.add(50, check);
}

export function waitForGeometry(window, callback, registry, maxAttempts = constants.GEOMETRY_WAIT_MAX_ATTEMPTS) {
    let attempts = 0;
    
    const check = () => {
        attempts++;
        const frame = window.get_frame_rect();
        
        if (frame.width > 10 && frame.height > 10 || attempts >= maxAttempts) {
            callback(window);
            return GLib.SOURCE_REMOVE;
        }
        
        registry.add(constants.GEOMETRY_CHECK_DELAY_MS, check);
        return GLib.SOURCE_REMOVE;
    };
    
    check();
}

export function queueIdle(callback) {
    return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}

export function queueHighPriority(callback) {
    return GLib.idle_add(GLib.PRIORITY_HIGH, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}
