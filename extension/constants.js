// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Global constants and configuration values

import * as Logger from './logger.js';

export const WINDOW_SPACING = 8; // Pixels

export const TILE_INTERVAL_MS = 60000 * 5; // 5 minutes

export const WINDOW_VALIDITY_CHECK_INTERVAL_MS = 10;

export const DRAG_UPDATE_INTERVAL_MS = 50;

export const STARTUP_TILE_DELAY_MS = 300;

export const ANIMATION_DURATION_MS = 350;

export const ANIMATION_OPEN_CLOSE_DURATION_MS = 350;

// Minimum window dimensions for tiling consideration
export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 100;
export const ABSOLUTE_MIN_HEIGHT = 200;

// Thresholds for edge tiling detection (pixels from screen edge)
export const EDGE_TILING_THRESHOLD = 10;

// Timing constants for polling and delays
export const POLL_INTERVAL_MS = 50;
export const DEBOUNCE_DELAY_MS = 500;
export const RETILE_DELAY_MS = 100;
export const GEOMETRY_CHECK_DELAY_MS = 10;
export const SAFETY_TIMEOUT_BUFFER_MS = 100;

// Threshold for identifying significant changes in window geometry for animations
export const ANIMATION_DIFF_THRESHOLD = 10;

// Grab Operation IDs (Legacy replacements/Helpers if Meta doesn't expose them cleanly)
// These match common Meta.GrabOp values for resizing.
// Resize grab operations (empirically discovered, not officially documented)
// Pattern: base value + direction flags
// Mouse resize operations (edge/corner drag):
export const GRAB_OP_RESIZING_NW = 36865;
export const GRAB_OP_RESIZING_N  = 4097;
export const GRAB_OP_RESIZING_NE = 8193;
export const GRAB_OP_RESIZING_E  = 16385;
export const GRAB_OP_RESIZING_SE = 20481;
export const GRAB_OP_RESIZING_S  = 24577;
export const GRAB_OP_RESIZING_SW = 40961;
export const GRAB_OP_RESIZING_W  = 32769;

// Alternative resize operations (Super+click, menu, keyboard):
export const GRAB_OP_KEYBOARD_RESIZING = 41217;
export const GRAB_OP_SUPER_SECONDARY_CLICK = 37889;
export const GRAB_OP_SUPER_RESIZE_S = 25601;
export const GRAB_OP_SUPER_RESIZE_SE = 24833;
export const GRAB_OP_COMPOSITOR_RESIZE = 769;

export const RESIZE_GRAB_OPS = [
    GRAB_OP_RESIZING_NW, GRAB_OP_RESIZING_N, GRAB_OP_RESIZING_NE,
    GRAB_OP_RESIZING_E, GRAB_OP_RESIZING_SE, GRAB_OP_RESIZING_S,
    GRAB_OP_RESIZING_SW, GRAB_OP_RESIZING_W,
    GRAB_OP_KEYBOARD_RESIZING, GRAB_OP_SUPER_SECONDARY_CLICK,
    GRAB_OP_SUPER_RESIZE_S, GRAB_OP_SUPER_RESIZE_SE, GRAB_OP_COMPOSITOR_RESIZE
];

// Move grab operations:
export const GRAB_OP_MOVING = 1;
export const GRAB_OP_KEYBOARD_MOVING = 1025;
