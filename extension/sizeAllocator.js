// Copyright 2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// One MRU-weighted scale sizes every window and miniature in a mosaic

import * as constants from './constants.js';

const longest = s => Math.max(s.width, s.height);

function legsOf(p) {
    const legA = Math.max(p.preferred.width - p.min.width, p.preferred.height - p.min.height, 0);
    const legB = Math.max(0, longest(fitInto(p.aspectRef, p.min)) - longest(p.floor));
    return { legA, total: legA + legB };
}

function fitInto(ref, box) {
    const k = Math.min(1, box.width / ref.width, box.height / ref.height);
    return { width: Math.round(ref.width * k), height: Math.round(ref.height * k) };
}

const lerp = (a, b, t) => ({
    width: Math.round(a.width + (b.width - a.width) * t),
    height: Math.round(a.height + (b.height - a.height) * t),
});

// The first axis to reach its threshold decides; a thumbnail can't be half a window.
export function axisOf(p) {
    const { legA, total } = legsOf(p);
    if (total === 0 || legA === 0) return { total, pLim: 0 };
    const crossAt = axis => {
        const span = p.preferred[axis] - p.min[axis];
        return span > 0 ? (p.preferred[axis] - p.threshold[axis]) / span : 1;
    };
    const t = Math.max(0, Math.min(1, crossAt('width'), crossAt('height')));
    return { total, pLim: t * legA / total };
}

// The mode never changes the size the walk asked for; a thumbnail only has to keep its frame's
// proportions, since the actor can only scale uniformly.
export function sizeFor(p, mode, pos) {
    const { legA, total } = legsOf(p);
    const pA = total > 0 ? legA / total : 1;
    if (pos <= pA || pA >= 1) {
        const fit = lerp(p.preferred, p.min, pA > 0 ? Math.min(1, pos / pA) : 0);
        return mode === 'window' ? fit : fitInto(p.aspectRef, fit);
    }
    const start = longest(fitInto(p.aspectRef, p.min));
    const g = (pos - pA) / (1 - pA);
    const k = (start + (longest(p.floor) - start) * g) / longest(p.aspectRef);
    return { width: Math.round(p.aspectRef.width * k), height: Math.round(p.aspectRef.height * k) };
}

// A thumbnail only comes back once it's clear of the threshold by the margin; coming back right
// at it would let rounding flip the window every pass.
export function resolveMode(p, pos, { restoreMarginPx, allowRestore }) {
    if (p.capAtThreshold) return 'window';
    const { total, pLim } = axisOf(p);
    if (p.mode !== 'thumbnail') return pos > pLim ? 'thumbnail' : 'window';
    if (!allowRestore) return 'thumbnail';
    const restoreAt = Math.max(0, pLim - (total > 0 ? restoreMarginPx / total : 0));
    return pos <= restoreAt ? 'window' : 'thumbnail';
}

const byRecency = (a, b) => (a.mruRank - b.mruRank) || (a.id - b.id);

// Age is normalized over the eligible windows, so the slope means the same thing whatever the
// window count.
export function ratesOf(participants, slope) {
    const eligible = participants.filter(p => !p.fixed).sort(byRecency);
    const rates = new Map(participants.map(p => [p.id, 0]));
    const n = eligible.length;
    eligible.forEach((p, i) => rates.set(p.id, 1 + slope * (n > 1 ? i / (n - 1) : 0)));
    // Age only has to pick which window crosses into a thumbnail first. Among thumbnails it just
    // sent the oldest to the floor while the others kept their size.
    const thumbs = eligible.filter(p => p.mode === 'thumbnail' && !p.capAtThreshold);
    if (thumbs.length === 0) return rates;
    const shared = thumbs.reduce((sum, p) => sum + rates.get(p.id), 0) / thumbs.length;
    for (const p of thumbs) rates.set(p.id, shared);
    return rates;
}

function entriesAt(participants, rates, s, opts) {
    const entries = participants.map(p => {
        if (p.fixed) return { id: p.id, mode: p.mode, size: { ...p.current }, pos: null };
        let pos = Math.min(1, s * rates.get(p.id));
        if (p.capAtThreshold) pos = Math.min(pos, axisOf(p).pLim);
        const mode = resolveMode(p, pos, opts);
        return { id: p.id, mode, size: sizeFor(p, mode, pos), pos };
    });
    holdRestoresToRecency(participants, entries);
    return entries;
}

// Thumbnails share one rate, so which clears its threshold first comes down to geometry; the
// newest still has to come back first. A thumbnail is never bigger than the window at the same
// pos, so holding one back can't break the fit.
function holdRestoresToRecency(participants, entries) {
    const byId = new Map(entries.map(e => [e.id, e]));
    let blocked = false;
    for (const p of participants.filter(q => q.mode === 'thumbnail' && !q.fixed && !q.capAtThreshold).sort(byRecency)) {
        const e = byId.get(p.id);
        if (blocked && e.mode === 'window') {
            e.mode = 'thumbnail';
            e.size = sizeFor(p, 'thumbnail', e.pos);
        }
        if (e.mode === 'thumbnail') blocked = true;
    }
}

// Assumes fit only gets easier as s grows. A previous s brackets the answer in two probes when
// little changed.
export function searchSmallestFit(probe, eps, previousS) {
    const b = { lo: null, hi: null };
    const test = s => {
        if (probe(s)) b.hi = b.hi === null ? s : Math.min(b.hi, s);
        else b.lo = b.lo === null ? s : Math.max(b.lo, s);
    };

    warmStart(test, b, previousS, eps);
    if (b.lo === null) {
        test(0);
        if (b.hi === 0) return 0;
    }
    if (b.hi === null) {
        test(1);
        if (b.hi === null) return null;
    }
    while (b.hi - b.lo > eps) test((b.lo + b.hi) / 2);
    return b.hi;
}

function warmStart(test, b, previousS, eps) {
    if (previousS === null || previousS <= 0 || previousS >= 1) return;
    test(previousS);
    test(b.hi !== null ? Math.max(0, previousS - eps / 2) : Math.min(1, previousS + eps / 2));
}

export function allocate({
    participants,
    fits,
    previousS = null,
    allowRestore = true,
    restoreMarginPx = constants.MINIATURE_RESTORE_HYSTERESIS_PX,
    slope = constants.ALLOCATOR_MRU_RATE_SLOPE,
    tolerancePx = constants.FIT_SCALE_SEARCH_TOLERANCE_PX,
}) {
    const once = pool => allocateOnce(pool, fits, previousS, { restoreMarginPx, allowRestore }, slope, tolerancePx);
    const run = pool => settleCrossings(pool, once);
    const free = run(participants);
    if (!free.fits) return free;
    return holdHeadAtPreferred(participants, run, free) ?? holdOneAsWindow(participants, run, free);
}

// A window crossing into a thumbnail still walked at its window rate, so the next pass, seeing it
// as a thumbnail, resized every thumbnail again. Resizing it as one here is what that pass finds.
function settleCrossings(pool, once) {
    const first = once(pool);
    if (!first.fits) return first;
    const crossed = new Set(pool.filter(p => !p.fixed && p.mode === 'window' &&
        first.entries.get(p.id).mode === 'thumbnail').map(p => p.id));
    if (crossed.size === 0) return first;
    const second = once(pool.map(p => (crossed.has(p.id) ? { ...p, mode: 'thumbnail' } : p)));
    const settled = second.fits && [...crossed].every(id => second.entries.get(id).mode === 'thumbnail');
    return settled ? second : first;
}

// Under a shared s the newest always pays a little, even while an older thumbnail sits well above
// its floor. It's only held when no window of the free fit has to become a thumbnail for it.
function holdHeadAtPreferred(participants, run, free) {
    const head = [...participants].sort(byRecency)[0];
    if (!head || head.fixed || free.entries.get(head.id).mode !== 'window') return null;
    const r = run(participants.map(p => (p === head ? { ...p, mode: 'window', fixed: true, current: p.preferred } : p)));
    if (!r.fits) return null;
    const costsAWindow = participants.some(p =>
        free.entries.get(p.id).mode === 'window' && r.entries.get(p.id).mode === 'thumbnail');
    return costsAWindow ? null : r;
}

// A mosaic of nothing but thumbnails has nothing to show. Most recent first; one that can't fit
// as a window even with everyone else at the floor hands the spot to the next, and when none can,
// the all-thumbnail fit still beats overflowing.
function holdOneAsWindow(participants, run, free) {
    if ([...free.entries.values()].some(e => e.mode === 'window')) return free;
    if (participants.some(p => p.capAtThreshold || (p.fixed && p.mode === 'window'))) return free;
    for (const held of participants.filter(p => !p.fixed).sort(byRecency)) {
        const r = run(participants.map(p => (p === held ? { ...p, capAtThreshold: true } : p)));
        if (r.fits) return r;
    }
    return free;
}

function allocateOnce(pool, fits, previousS, opts, slope, tolerancePx) {
    const rates = ratesOf(pool, slope);
    const at = s => entriesAt(pool, rates, s, opts);
    const probe = s => fits(at(s).map(e => ({ id: e.id, width: e.size.width, height: e.size.height })));

    const span = Math.max(1, ...pool.filter(p => !p.fixed).map(p => rates.get(p.id) * axisOf(p).total));
    const s = searchSmallestFit(probe, tolerancePx / span, previousS);
    const entries = new Map(at(s ?? 1).map(e => [e.id, e]));
    return { fits: s !== null, s: s ?? 1, entries };
}
