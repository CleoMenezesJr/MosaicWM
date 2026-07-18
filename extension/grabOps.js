// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Grab operation detection helpers

import Meta from 'gi://Meta';

export const RESIZE_GRAB_OPS = [
    Meta.GrabOp.RESIZING_NW, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_E, Meta.GrabOp.RESIZING_SE, Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_SW, Meta.GrabOp.RESIZING_W,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
    Meta.GrabOp.KEYBOARD_RESIZING_SE,
];


export function isResizeGrabOp(grabOp) {
    if (RESIZE_GRAB_OPS.includes(grabOp)) return true;
    // Composite resize bitmask: WINDOW_BASE (bit 0) + any directional bit
    return (grabOp & 0x1) !== 0 && (grabOp & 0x3000) !== 0;
}

// A window grab op with no directional bits set is a move (Mutter convention).
export function isMoveGrabOp(grabOp) {
    return (grabOp & 0x1) !== 0 && (grabOp & 0xF000) === 0;
}
