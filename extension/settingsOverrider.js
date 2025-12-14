// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME settings override for window management

import * as Logger from './logger.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class SettingsOverrider {
    #overrides;

    constructor() {
        this.#overrides = new Map();
    }
    
    add(settings, key, value) {
        const schemaId = settings.schema_id;
        
        if (!this.#overrides.has(schemaId)) {
            this.#overrides.set(schemaId, new Map());
        }
        
        const schemaOverrides = this.#overrides.get(schemaId);
        
        // Save original value
        if (!schemaOverrides.has(key)) {
            const originalValue = settings.get_value(key);
            schemaOverrides.set(key, originalValue);
        }
        
        // Apply override
        settings.set_value(key, value);
        Logger.log(`[MOSAIC WM] Overriding ${schemaId}.${key}`);
    }
    
    clear() {
        if (!this.#overrides) return;

        // Restore original values
        for (const [schemaId, overrides] of this.#overrides) {
            const settings = new Gio.Settings({ schema_id: schemaId });
            
            for (const [key, originalValue] of overrides) {
                settings.set_value(key, originalValue);
                Logger.log(`[MOSAIC WM] Restored ${schemaId}.${key}`);
            }
        }
        
        this.#overrides.clear();
    }
    
    destroy() {
        this.clear();
        this.#overrides = null;
    }
}
