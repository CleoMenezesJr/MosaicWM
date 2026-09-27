// Copyright 2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

import Mtk from 'gi://Mtk';

// Mutter keeps size hints in client space, which for a CSD window includes its shadow, while
// everything here compares against frame rects. Left raw, every min reads a shadow too big.
function hintToFrame(window, width, height) {
    const frame = window.client_rect_to_frame_rect(new Mtk.Rectangle({ x: 0, y: 0, width, height }));
    return { width: Math.max(0, frame.width), height: Math.max(0, frame.height) };
}

export function frameMinSize(window) {
    const [known, width, height] = window.get_min_size?.() ?? [false, 0, 0];
    return known ? hintToFrame(window, width, height) : null;
}

export function frameMaxSize(window) {
    const [known, width, height] = window.get_max_size?.() ?? [false, 0, 0];
    return known && width > 0 && height > 0 ? hintToFrame(window, width, height) : null;
}
