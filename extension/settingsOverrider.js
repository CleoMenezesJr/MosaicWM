// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// GNOME settings override for window management

import * as Logger from './logger.js';
import Gio from 'gi://Gio';

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


        if (!schemaOverrides.has(key)) {
            const currentValue = settings.get_value(key);
            if (currentValue.equal(value)) {
                const defaultValue = settings.get_default_value(key);
                schemaOverrides.set(key, defaultValue);
                Logger.log(`${schemaId}.${key} already overridden, saved schema default`);
            } else {
                schemaOverrides.set(key, currentValue);
            }
        }

        settings.set_value(key, value);
        Logger.log(`Overriding ${schemaId}.${key}`);
    }

    clear() {
        if (!this.#overrides) return;


        for (const [schemaId, overrides] of this.#overrides) {
            try {
                const settings = new Gio.Settings({ schema_id: schemaId });

                for (const [key, originalValue] of overrides) {
                    try {
                        settings.set_value(key, originalValue);
                        Logger.log(`Restored ${schemaId}.${key} to original value`);
                    } catch (e) {
                        Logger.warn(`Failed to restore ${schemaId}.${key}: ${e.message}`);
                    }
                }
            } catch (e) {
                Logger.warn(`Failed to create settings for ${schemaId}: ${e.message}`);
            }
        }

        // Flush dconf before process exit (e.g. uninstall).
        Gio.Settings.sync();

        this.#overrides.clear();
    }

    destroy() {
        this.clear();
        this.#overrides = null;
    }
}
