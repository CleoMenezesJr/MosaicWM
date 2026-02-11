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
            Logger.log(`[MOSAIC WM] Failed to read animation settings: ${e.message}, defaulting to true`);
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
    
    // Adjust for slow down factor if present
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
    
    // Wait for workspace animation duration
    registry.add(duration, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}

export function afterAnimations(animationsManager, callback, registry, maxWait = 1000) {
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

    // 1. Connect to our new deterministic signal
    signalId = animationsManager.connect('animations-completed', trigger);

    // 2. Safety fallback
    const adjustedMaxWait = Math.ceil(maxWait * getSlowDownFactor());
    timeoutId = registry.add(adjustedMaxWait, () => {
        Logger.log('[MOSAIC WM] afterAnimations: Safety timeout triggered');
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

    // Use size-changed as deterministic signal
    signalId = window.connect('size-changed', () => {
        const f = window.get_frame_rect();
        if (f.width > 10 && f.height > 10) {
            trigger();
        }
    });

    // Safety timeout
    timeoutId = registry.add(1000, () => {
        Logger.log('[MOSAIC WM] waitForGeometry: Safety timeout triggered');
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

// Executes callback after overview is hidden (waits for exit animation)
// If overview is not visible, executes immediately
export function afterOverviewHidden(callback, registry) {
    if (!Main.overview.visible) {
        callback();
        return;
    }
    
    Logger.log('[MOSAIC WM] Waiting for overview to hide...');
    
    const hiddenId = Main.overview.connect('hidden', () => {
        Main.overview.disconnect(hiddenId);
        Logger.log('[MOSAIC WM] Overview hidden - executing callback');
        callback();
    });
    
    // Failsafe: if overview doesn't hide within 1s, execute anyway
    registry.add(1000, () => {
        if (Main.overview.visible) {
            Logger.log('[MOSAIC WM] Overview hide timeout - forcing callback');
            try { Main.overview.disconnect(hiddenId); } catch(e) {}
            callback();
        }
        return GLib.SOURCE_REMOVE;
    });
}
