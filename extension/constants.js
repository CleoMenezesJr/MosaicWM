// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
/// Mosaic WM Constants
// Shared constants for the extension

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

export const WINDOW_SPACING = 8; // Pixels

export const TILE_INTERVAL_MS = 60000 * 5; // 5 minutes

export const WINDOW_VALIDITY_CHECK_INTERVAL_MS = 10;

export const TileZone = {
    NONE: 0,
    LEFT_FULL: 1,
    RIGHT_FULL: 2,
    TOP_LEFT: 3,
    TOP_RIGHT: 4,
    BOTTOM_LEFT: 5,
    BOTTOM_RIGHT: 6,
    FULLSCREEN: 7
};

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
export const ABSOLUTE_MIN_HEIGHT = 200;

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
export const GEOMETRY_WAIT_MAX_ATTEMPTS = 40;   // Max attempts to wait for window geometry (40 * 50ms = 2s)
export const REVERSE_RESIZE_PROTECTION_MS = 500; // Protection window for reverse smart resize/unmaximize
export const RESIZE_VERIFICATION_DELAY_MS = 1500; // Delay for resize verification checks
export const RESIZE_SETTLE_DELAY_MS = 150;       // Delay to let Mutter apply resize before retiling
export const ISRESIZING_FLAG_RESET_MS = 2;       // Delay to reset isResizing flag
export const MIN_AVAILABLE_SPACE_PX = 50;        // Minimum available space threshold for smart resize
export const OVERFLOW_MOVE_DEBOUNCE_MS = 2000;   // Debounce to prevent infinite loops after overflow move

// Threshold for identifying significant changes in window geometry for animations
export const ANIMATION_DIFF_THRESHOLD = 10;

// Smart resize
export const SMART_RESIZE_ANIMATION_MS = 400; // Dedicated animation duration for auto-resize (smoother)

// Smart Resize Iterative - Democratic Proportional Resizing
export const SMART_RESIZE_STEP_PERCENTAGE = 20;      // Reduce 20% per cycle (multiply by 0.8) - aggressive to fit quickly
export const SMART_RESIZE_DETECTION_DELTA_PX = 2;    // Tolerance (in pixels) to detect if window actually shrank
export const SMART_RESIZE_MAX_ITERATIONS = 10;       // Maximum cycles before declaring overflow
export const SMART_RESIZE_ITERATION_DEBOUNCE_MS = 100;  // Delay between cycles (let Mutter apply resize - increased from 50ms)
export const SMART_RESIZE_LEARNING_DEBOUNCE_MS = 200;  // Delay before checking if window actually moved (increased from 100ms to accommodate slow systems)
export const SMART_RESIZE_MIN_WINDOW_WIDTH = 250;    // Minimum window size during smart resize
export const SMART_RESIZE_MIN_WINDOW_HEIGHT = 250;   // Minimum window size during smart resize

// Slide-in animation for new windows
export const SLIDE_IN_OFFSET_PX = 100;        // Offset in pixels for new window slide-in animation
export const QUEUE_PROCESS_DELAY_MS = 100;    // Delay between processing window opening queue items

// Alternative resize operations:
const GRAB_OP_SUPER_SECONDARY_CLICK = 37889; // No Enum found yet
const GRAB_OP_SUPER_RESIZE_S = 25601; // No Enum found yet
const GRAB_OP_SUPER_RESIZE_SE = 24833; // No Enum found yet

export const RESIZE_GRAB_OPS = [
    Meta.GrabOp.RESIZING_NW, Meta.GrabOp.RESIZING_N, Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_E, Meta.GrabOp.RESIZING_SE, Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_SW, Meta.GrabOp.RESIZING_W,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
    GRAB_OP_SUPER_SECONDARY_CLICK,
    GRAB_OP_SUPER_RESIZE_S, GRAB_OP_SUPER_RESIZE_SE,
    Meta.GrabOp.COMPOSITOR_RESIZE || 769
];
