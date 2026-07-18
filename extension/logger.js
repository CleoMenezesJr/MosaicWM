// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

const DEBUG = true;

export function log(...args) {
    if (DEBUG) {
        console.log('[MOSAIC WM]', ...args);
    }
}

export function info(...args) {
    console.log('[MOSAIC INFO]', ...args);
}

export function error(...args) {
    console.error('[MOSAIC ERROR]', ...args);
}

export function warn(...args) {
    console.warn('[MOSAIC WARN]', ...args);
}
