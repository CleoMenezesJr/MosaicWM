// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Global constants and configuration values

import * as Logger from './logger.js';
import Clutter from 'gi://Clutter';

export const WINDOW_SPACING = 8; // Pixels

export const TILE_INTERVAL_MS = 60000 * 5; // 5 minutes

export const WINDOW_VALIDITY_CHECK_INTERVAL_MS = 10;

export const DRAG_UPDATE_INTERVAL_MS = 50;

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
export const REVERSE_RESIZE_PROTECTION_MS = 200; // Protection window for reverse smart resize
export const RESIZE_VERIFICATION_DELAY_MS = 1500; // Delay for resize verification checks
export const DRAG_SAFETY_TIMEOUT_MS = 10000;     // Safety timeout for drag operations
export const ISRESIZING_FLAG_RESET_MS = 2;       // Delay to reset isResizing flag
export const EXCLUSION_POLL_INTERVAL_MS = 1000;  // Interval for polling exclusion state changes
export const MIN_AVAILABLE_SPACE_PX = 50;        // Minimum available space threshold for smart resize

// Threshold for identifying significant changes in window geometry for animations
export const ANIMATION_DIFF_THRESHOLD = 10;

// Smart resize thresholds
export const SMALL_WINDOW_THRESHOLD = 0.25;  // Window < 25% of workspace = small
export const LARGE_WINDOW_THRESHOLD = 0.35;  // Window > 35% of workspace = large (lowered to catch Medium windows)
export const MIN_RESIZE_RATIO = 0.30;        // Minimum 30% of original size when resizing
export const SMART_RESIZE_ANIMATION_MS = 400; // Dedicated animation duration for auto-resize (smoother)
export const SMART_RESIZE_MAX_ATTEMPTS = 20;  // Max polling attempts before giving up on smart resize

// Slide-in animation for new windows
export const SLIDE_IN_OFFSET_PX = 100;        // Offset in pixels for new window slide-in animation

// Grab Operation IDs (Meta.GrabOp values). Undocumented but empirically discovered.
// Matches common resize operations (edge/corner drag).
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
