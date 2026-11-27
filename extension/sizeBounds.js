// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Bounds the allocator reads for one participant: what the client enforces, what the
// window wants, and the point where it becomes a thumbnail.

// Neither preferred nor threshold may sit under what the client enforces, and a saved
// preferred can. Nor past the packing area, where an arrival held at it can't fit even alone.
export function windowSizeBounds({ min, max, saved, workArea, area }) {
    const natural = {
        width: Math.max(saved.width, min.width),
        height: Math.max(saved.height, min.height),
    };
    const preferred = {
        width: Math.max(Math.min(natural.width, area.width), min.width),
        height: Math.max(Math.min(natural.height, area.height), min.height),
    };

    // Some clients publish a max past the monitor, which pins the threshold to preferred.
    const effectiveMaxW = Math.min(max?.width || workArea.width, workArea.width);
    const effectiveMaxH = Math.min(max?.height || workArea.height, workArea.height);
    const threshold = {
        width: Math.round(Math.min(Math.max((min.width + effectiveMaxW) / 2, min.width), preferred.width)),
        height: Math.round(Math.min(Math.max((min.height + effectiveMaxH) / 2, min.height), preferred.height)),
    };

    return { natural, preferred, min: { width: min.width, height: min.height }, threshold };
}
