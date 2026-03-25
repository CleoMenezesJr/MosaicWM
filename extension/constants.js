// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared constants for the extension

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

export const WINDOW_SPACING = 8; // Pixels

export const TILE_INTERVAL_MS = 60000 * 5; // 5 minutes

export const WINDOW_VALIDITY_CHECK_INTERVAL_MS = 10;

export const TileZone = Object.freeze({
    NONE: 0,
    LEFT_FULL: 1,
    RIGHT_FULL: 2,
    TOP_LEFT: 3,
    TOP_RIGHT: 4,
    BOTTOM_LEFT: 5,
    BOTTOM_RIGHT: 6,
    FULLSCREEN: 7
});

export const STARTUP_TILE_DELAY_MS = 300;

export const ANIMATION_DURATION_MS = 350;

export const ANIMATION_OPEN_CLOSE_DURATION_MS = 350;

// Animation Modes
export const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_EXPO;
export const ANIMATION_MODE_SUBTLE = Clutter.AnimationMode.EASE_OUT_QUAD;
export const ANIMATION_MODE_MOMENTUM = Clutter.AnimationMode.EASE_OUT_BACK; // Bouncy

// Minimum dimensions for tiling
export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 100;
export const ABSOLUTE_MIN_HEIGHT = 100;

// Edge detection threshold
export const EDGE_TILING_THRESHOLD = 10;
// Tolerance for grouping windows into virtual columns (Virtual Columns Algorithm)
export const COLUMN_ALIGNMENT_TOLERANCE = 50;

// Timing constants
export const POLL_INTERVAL_MS = 50;
export const DEBOUNCE_DELAY_MS = 500;
export const RETILE_DELAY_MS = 100;
export const GEOMETRY_CHECK_DELAY_MS = 10;
export const SAFETY_TIMEOUT_BUFFER_MS = 100;
export const EDGE_TILE_RESTORE_DELAY_MS = 300;  // Delay to prevent false overflow during edge tile restoration
// Increased from 40 to 100 to allow up to 5 seconds for geometry check during mass spawning
export const GEOMETRY_WAIT_MAX_ATTEMPTS = 100;   // Max attempts to wait for window geometry (100 * 50ms = 5s)
export const REVERSE_RESIZE_PROTECTION_MS = 1000; // Protection window for reverse smart resize/unmaximize/overflow
export const RESIZE_VERIFICATION_DELAY_MS = 1500; // Delay for resize verification checks
export const RESIZE_SETTLE_DELAY_MS = 150;       // Delay to let Mutter apply resize before retiling
export const ISRESIZING_FLAG_RESET_MS = 2;       // Delay to reset isResizing flag
export const MIN_AVAILABLE_SPACE_PX = 50;        // Minimum available space threshold for smart resize
export const OVERFLOW_MOVE_DEBOUNCE_MS = 2000;   // Debounce to prevent infinite loops after overflow move

// Threshold for identifying significant changes in window geometry for animations
export const ANIMATION_DIFF_THRESHOLD = 10;

// Smart resize
export const SMART_RESIZE_ANIMATION_MS = 400; // Dedicated animation duration for auto-resize (smoother)

// Fallback when get_min_size() has no hint
export const SMART_RESIZE_MIN_WINDOW_WIDTH = 100;
export const SMART_RESIZE_MIN_WINDOW_HEIGHT = 100;

// Slide-in animation for new windows
export const SLIDE_IN_OFFSET_PX = 100;        // Offset in pixels for new window slide-in animation
export const QUEUE_PROCESS_DELAY_MS = 100;   // Delay between processing window opening queue items (Mutter settling)

export const RESIZE_GRAB_OPS = [
    Meta.GrabOp.RESIZING_NW, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_E, Meta.GrabOp.RESIZING_SE, Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_SW, Meta.GrabOp.RESIZING_W,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
    Meta.GrabOp.KEYBOARD_RESIZING_SE,
];

// Robust resize detection (handles Super+click composite grab ops via bitmask)
export function isResizeGrabOp(grabOp) {
    if (RESIZE_GRAB_OPS.includes(grabOp)) return true;
    // Composite resize bitmask: WINDOW_BASE (bit 0) + any directional bit
    return (grabOp & 0x1) !== 0 && (grabOp & 0x3000) !== 0;
}

// Robust move detection (handles Super+click composite grab ops via bitmask)
// A window grab op with no directional bits set is a move (Mutter convention)
export function isMoveGrabOp(grabOp) {
    return (grabOp & 0x1) !== 0 && (grabOp & 0xF000) === 0;
}
