// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Shared constants for the extension

export const WINDOW_SPACING = 8; // Pixels

// Cap on distinct drag candidates kept after de-duplication so the live nearest search
// stays cheap. A safety net that keeps the current layout, so it never drops a reachable one.
export const MAX_DRAG_LAYOUTS = 48;
// Wall-clock ceiling for composition generation at drag start; a last-resort guard
// against pathological window counts.
export const DRAG_LAYOUT_TIME_BUDGET_MS = 8;
// A Super+Arrow only counts as an action if it moves the focused window's center at
// least this far in the pressed direction; below it the key is a no-op.
export const KEYBOARD_RECOMPOSE_MIN_DISPLACEMENT_PX = 20;

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

export const ANIMATION_DURATION_MS = 250;

export const MIN_WINDOW_WIDTH = 400;
export const MIN_WINDOW_HEIGHT = 100;
export const ABSOLUTE_MIN_HEIGHT = 100;

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
export const RESIZE_CLAMP_SETTLE_WINDOW_MS = 1500; // Window age below which a clamp is treated as the client still settling
export const RESIZE_CLAMP_VERIFY_DELAY_MS = 400; // Quiet time after a deferred clamp before the frame is committed as real
export const ISRESIZING_FLAG_RESET_MS = 2;
// Mutter can skip the size-changed confirmation on a fast maximize/unmaximize
// toggle, so force the move after this long instead of leaving the window stuck.
export const SACRED_RESTORE_SAFETY_TIMEOUT_MS = 1500;
// New windows fire both window-created and window-added, which would otherwise
// evaluate them twice. Skip a re-enqueue if we just evaluated this window.
export const DUPLICATE_EVALUATION_WINDOW_MS = 300;
// Wait this long after a maximize before isolating the window, so a quick
// maximize/unmaximize toggle never even starts the move.
export const SACRED_ENTER_DEBOUNCE_MS = 200;

export const ANIMATION_DIFF_THRESHOLD = 10;

// Fallback when get_min_size() has no hint
export const SMART_RESIZE_MIN_WINDOW_WIDTH = 100;
export const SMART_RESIZE_MIN_WINDOW_HEIGHT = 100;

// Slide-in animation for new windows
export const SLIDE_IN_OFFSET_PX = 100;
export const SLIDE_IN_DURATION_MS = 300;
export const SLIDE_IN_FAILSAFE_MS = 1000;     // Re-check interval if a window's entrance never gets claimed
export const QUEUE_PROCESS_DELAY_MS = 100;   // Delay between processing window opening queue items (Mutter settling)

// Miniature windows
export const MINIATURE_TARGET_SIZE_PX = 256;  // Longest side of a miniaturized window
export const MINIATURE_ANIM_MS = 250;
export const MINIATURE_FOCUS_GUARD_MS = 500;  // Block focus-triggered restore right after miniaturizing
export const NEW_WINDOW_MINIATURIZE_PROTECTION_MS = 2000;  // Shield a just-opened window from being chosen as the miniaturize target
export const DND_MINIATURE_RESTORE_DELAY_MS = 400;  // Dwell time over a miniature before a DnD hover triggers restore

// Restored window's distance to its old slot is the primary layout pick; layouts
// whose distances land within this many px tie, so shelves still break near-ties.
export const RESTORE_PROXIMITY_TOLERANCE_PX = 100;

// Compact the per-workspace swap history into a single canonical order op
// once it grows past this many entries (keeps replay cost bounded)
export const SWAP_OPS_COMPACT_THRESHOLD = 8;
