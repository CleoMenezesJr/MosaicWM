// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Centralized window state management using WeakMap

// WeakMap to store state associated with Meta.Window objects
// This avoids polluting native objects with custom properties
const windowStates = new WeakMap();

// Get a property from a window's state
// Returns undefined if window has no state or property doesn't exist
export function get(window, property) {
    const state = windowStates.get(window);
    return state ? state[property] : undefined;
}

// Set a property on a window's state
// Creates the state object if it doesn't exist
export function set(window, property, value) {
    let state = windowStates.get(window);
    if (!state) {
        state = {};
        windowStates.set(window, state);
    }
    state[property] = value;
}

// Check if a window has a specific property set
export function has(window, property) {
    const state = windowStates.get(window);
    return state ? property in state : false;
}

// Delete a property from a window's state
export function remove(window, property) {
    const state = windowStates.get(window);
    if (state) {
        delete state[property];
    }
}

// Get the entire state object for a window (for debugging)
export function getState(window) {
    return windowStates.get(window);
}

// Clear all state for a window
export function clear(window) {
    windowStates.delete(window);
}
