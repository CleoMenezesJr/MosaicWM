// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Debug logging utilities

const DEBUG = true;

export function log(...args) {
    if (DEBUG) {
        console.log(...args);
    }
}

export function info(...args) {
    console.log(...args);
}

export function error(...args) {
    console.error(...args);
}

export function warn(...args) {
    console.warn(...args);
}
