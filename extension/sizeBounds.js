// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Bounds the allocator reads for one participant: what the client enforces, what the
// window wants, and the point where it becomes a thumbnail.

import { MINIATURE_CROSSING_FRACTION } from './constants.js';

// Neither preferred nor threshold may sit under what the client enforces, and a saved
// preferred can. Nor past the packing area, where an arrival held at it can't fit even alone.
export function windowSizeBounds({ min, saved, area }) {
    const natural = {
        width: Math.max(saved.width, min.width),
        height: Math.max(saved.height, min.height),
    };
    const preferred = {
        width: Math.max(Math.min(natural.width, area.width), min.width),
        height: Math.max(Math.min(natural.height, area.height), min.height),
    };

    // A parking point past the screen would never bind, so the preferred clamp collapses it
    // and windows bigger than the area keep parking early.
    const threshold = {
        width: Math.round(Math.min(Math.max(min.width, MINIATURE_CROSSING_FRACTION * natural.width), preferred.width)),
        height: Math.round(Math.min(Math.max(min.height, MINIATURE_CROSSING_FRACTION * natural.height), preferred.height)),
    };

    return { natural, preferred, min: { width: min.width, height: min.height }, threshold };
}
