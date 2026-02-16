// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Centralized window state management using WeakMap


// WeakMap to store state associated with Meta.Window objects
// This avoids polluting native objects with custom properties

const windowStates = new WeakMap();

export function get(window, property) {
    const state = windowStates.get(window);
    return state ? state[property] : undefined;
}

export function set(window, property, value) {
    let state = windowStates.get(window);
    if (!state) {
        state = {};
        windowStates.set(window, state);
    }
    state[property] = value;
}

export function has(window, property) {
    const state = windowStates.get(window);
    return state ? property in state : false;
}

export function remove(window, property) {
    const state = windowStates.get(window);
    if (state) {
        delete state[property];
    }
}

export function getState(window) {
    return windowStates.get(window);
}

export function clear(window) {
    windowStates.delete(window);
}
