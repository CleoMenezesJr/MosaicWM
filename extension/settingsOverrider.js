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
            try {
                const settings = new Gio.Settings({ schema_id: schemaId });
                
                for (const [key, originalValue] of overrides) {
                    try {
                        settings.set_value(key, originalValue);
                        Logger.log(`[MOSAIC WM] Restored ${schemaId}.${key} to ${originalValue.print(true)}`);
                    } catch (e) {
                        Logger.warn(`[MOSAIC WM] Failed to restore ${schemaId}.${key}: ${e.message}`);
                    }
                }
                
                // Sync settings to ensure they're written
                Gio.Settings.sync();
            } catch (e) {
                Logger.warn(`[MOSAIC WM] Failed to create settings for ${schemaId}: ${e.message}`);
            }
        }
        
        this.#overrides.clear();
    }
    
    destroy() {
        this.clear();
        this.#overrides = null;
    }
}
