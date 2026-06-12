// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared constants for the extension

export const WINDOW_SPACING = 8; // Pixels

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

// Minimum dimensions for tiling
export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 100;
export const ABSOLUTE_MIN_HEIGHT = 100;

// Edge detection threshold
export const EDGE_TILING_THRESHOLD = 10;

// Timing constants
export const POLL_INTERVAL_MS = 50;
export const DEBOUNCE_DELAY_MS = 500;
export const RETILE_DELAY_MS = 100;
export const GEOMETRY_CHECK_DELAY_MS = 10;
export const SAFETY_TIMEOUT_BUFFER_MS = 100;
export const EDGE_TILE_RESTORE_DELAY_MS = 300;  // Delay to prevent false overflow during edge tile restoration
// Allows up to 5 seconds for geometry check during mass spawning
export const GEOMETRY_WAIT_MAX_ATTEMPTS = 100;   // Max attempts to wait for window geometry (100 * 50ms = 5s)
export const REVERSE_RESIZE_PROTECTION_MS = 1000; // Protection window for reverse smart resize/unmaximize/overflow
export const RESIZE_SETTLE_DELAY_MS = 150;       // Delay to let Mutter apply resize before retiling
export const ISRESIZING_FLAG_RESET_MS = 2;       // Delay to reset isResizing flag

// Threshold for identifying significant changes in window geometry for animations
export const ANIMATION_DIFF_THRESHOLD = 10;

// Fallback when get_min_size() has no hint
export const SMART_RESIZE_MIN_WINDOW_WIDTH = 100;
export const SMART_RESIZE_MIN_WINDOW_HEIGHT = 100;

// Slide-in animation for new windows
export const SLIDE_IN_OFFSET_PX = 100;        // Offset in pixels for new window slide-in animation
export const SLIDE_IN_DURATION_MS = 300;      // Duration of the slide-in ease
export const SLIDE_IN_FAILSAFE_MS = 1000;     // Restore patched actor.ease if _mapWindow never animates
export const QUEUE_PROCESS_DELAY_MS = 100;   // Delay between processing window opening queue items (Mutter settling)

// Miniature windows
export const MINIATURE_TARGET_SIZE_PX = 256;  // Longest side of a miniaturized window
export const MINIATURE_ANIM_MS = 250;         // Miniaturize/restore animation duration
export const MINIATURE_FOCUS_GUARD_MS = 500;  // Block focus-triggered restore right after miniaturizing

// Compact the per-workspace swap history into a single canonical order op
// once it grows past this many entries (keeps replay cost bounded)
export const SWAP_OPS_COMPACT_THRESHOLD = 8;
