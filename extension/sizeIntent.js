// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Decides how one window enters the allocator, apart from its GObject.

// A window is trusted to shrink on its own when this extension placed it or when it is the
// pass's own subject; a fresh client may still be mid-placement, so its frame is held.
export function hasReliableSize({ isReference, preferred, opening, constrained }) {
    return isReference || preferred || opening || constrained;
}

export function isFixedParticipant({ id, resizingWindowId, allowsResize, pinned, reliable }) {
    return id === resizingWindowId || (!allowsResize && !pinned) || !reliable;
}

// The pass's own subject (arrival, re-include, sacred return, restore) stays a window; the
// user just asked for it.
export function isCappedParticipant({ id, referenceId, arrivalPending, restoringFromMiniature }) {
    return id === referenceId || arrivalPending || restoringFromMiniature;
}

export function sizeAtLongestSide(refSize, targetPx) {
    const scale = targetPx / Math.max(refSize.width, refSize.height);
    return { width: Math.round(refSize.width * scale), height: Math.round(refSize.height * scale) };
}
