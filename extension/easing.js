// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Cubic-bezier easing for window transitions

function sample(a1, a2, t) {
    const mt = 1 - t;
    return 3 * mt * mt * t * a1 + 3 * mt * t * t * a2 + t * t * t;
}

function slope(a1, a2, t) {
    const mt = 1 - t;
    return 3 * mt * mt * a1 + 6 * mt * t * (a2 - a1) + 3 * t * t * (1 - a2);
}

// Newton converges in a few steps for the house curve; bisection is the fallback when
// the derivative vanishes.
export function createEasing({ x1, y1, x2, y2 }) {
    return progress => {
        if (progress <= 0) return 0;
        if (progress >= 1) return 1;

        let t = progress;
        for (let i = 0; i < 6; i++) {
            const err = sample(x1, x2, t) - progress;
            if (Math.abs(err) < 1e-4) return sample(y1, y2, t);
            const d = slope(x1, x2, t);
            if (Math.abs(d) < 1e-6) break;
            t -= err / d;
        }

        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 30; i++) {
            t = (lo + hi) / 2;
            if (sample(x1, x2, t) < progress) lo = t;
            else hi = t;
        }
        return sample(y1, y2, t);
    };
}
