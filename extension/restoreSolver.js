import * as constants from './constants.js';

// Packer arithmetic only, never _tile(): a full layout search per probe is too slow to run for
// every restore candidate. No GObject, no WindowState; plain numbers in, plain numbers out.

function openRow(col, w, spacing) {
    col.height += (col.rows.length > 0 ? spacing : 0) + w.height;
    col.width = Math.max(col.width, w.width);
    col.rows.push({ windows: [w], used: w.width, height: w.height });
}

function joinRow(col, w, spacing, maxHeight) {
    for (const row of col.rows) {
        if (row.used + spacing + w.width > col.width) continue;

        const grown = Math.max(row.height, w.height);
        if (col.height - row.height + grown > maxHeight) continue;

        col.height += grown - row.height;
        row.height = grown;
        row.used += spacing + w.width;
        row.windows.push(w);
        return true;
    }
    return false;
}

function forceIntoShortestColumn(columns, w, spacing, allowRows) {
    let bestCol = columns[0];
    for (const col of columns) {
        if (col.height < bestCol.height) bestCol = col;
    }
    if (!allowRows || !joinRow(bestCol, w, spacing, Infinity))
        openRow(bestCol, w, spacing);
}

// Port of the engine's greedy column packer: same join/open/force decisions, so a fit here
// is a fit the engine's own placement can produce.
function packColumns(windows, workArea, spacing, allowRows) {
    const columns = [];

    for (const w of windows) {
        const tallest = columns.reduce((h, c) => Math.max(h, c.height), 0);
        let placed = false;

        for (const col of columns) {
            if (allowRows && joinRow(col, w, spacing, tallest)) {
                placed = true;
                break;
            }
            if (col.height + spacing + w.height <= workArea.height) {
                openRow(col, w, spacing);
                placed = true;
                break;
            }
        }
        if (placed) continue;

        const totalWidth = columns.reduce((s, c) => s + c.width, 0) +
            (columns.length > 0 ? columns.length * spacing : 0) + w.width;

        if (totalWidth <= workArea.width || columns.length === 0) {
            columns.push({ rows: [], height: 0, width: 0 });
            openRow(columns[columns.length - 1], w, spacing);
        } else {
            forceIntoShortestColumn(columns, w, spacing, allowRows);
        }
    }

    return columns;
}

function columnsOverflow(columns, workArea, spacing) {
    let totalWidth = 0;
    let overflow = false;

    for (const [c, col] of columns.entries()) {
        if (col.height > workArea.height) overflow = true;
        if (totalWidth + col.width + spacing > workArea.width && c > 0) overflow = true;
        if (c > 0) totalWidth += spacing;
        totalWidth += col.width;
    }

    return { overflow, totalWidth };
}

// Both row policies packed, tighter box wins: the same tie the engine breaks in
// _tighterPacking, so the solver never claims a fit the engine would refuse.
export function fitsVertical(windows, workArea, spacing = constants.WINDOW_SPACING) {
    let best = null;

    for (const allowRows of [false, true]) {
        const columns = packColumns(windows, workArea, spacing, allowRows);
        const { overflow, totalWidth } = columnsOverflow(columns, workArea, spacing);
        const height = columns.reduce((h, c) => Math.max(h, c.height), 0);
        const candidate = { overflow, area: totalWidth * height };
        if (!best || (!candidate.overflow && best.overflow) ||
            (candidate.overflow === best.overflow && candidate.area < best.area))
            best = candidate;
    }

    return !best.overflow;
}

// Sizes at interpolation factor t: min→current, exactly the range the engine's binary
// search walks. Non-resizable participants keep their current size at every t.
export function sizesAt(participants, t) {
    return participants.map(p => {
        if (!p.resizable) return { id: p.id, ...p.current };
        const w = Math.min(p.min.width, p.current.width);
        const h = Math.min(p.min.height, p.current.height);
        return {
            id: p.id,
            width: Math.round(w + (p.current.width - w) * t),
            height: Math.round(h + (p.current.height - h) * t),
        };
    });
}

// Largest t whose packing fits, or null when even t=0 overflows. Tolerance matches the
// engine's FIT_SCALE_SEARCH_TOLERANCE_PX so both agree on where "fits" stops mattering.
export function solveScale(participants, workArea, spacing = constants.WINDOW_SPACING) {
    const span = Math.max(1, ...participants.map(p =>
        Math.max(p.current.width - Math.min(p.min.width, p.current.width),
            p.current.height - Math.min(p.min.height, p.current.height))));

    if (fitsVertical(sizesAt(participants, 1.0), workArea, spacing))
        return 1.0;
    if (!fitsVertical(sizesAt(participants, 0.0), workArea, spacing))
        return null;

    let lo = 0.0;
    let hi = 1.0;
    while ((hi - lo) * span > constants.FIT_SCALE_SEARCH_TOLERANCE_PX) {
        const mid = (lo + hi) / 2;
        if (fitsVertical(sizesAt(participants, mid), workArea, spacing))
            lo = mid;
        else
            hi = mid;
    }
    return lo;
}

// The caller computes miniRange with the same helper the apply pass marks minis with, so the
// plan and the real miniature can't disagree on how big a sacrificed window ends up.
function toMiniatureRange(p) {
    return { ...p, resizable: true, isMiniature: true, min: p.miniRange.min, current: p.miniRange.current };
}

// Windows the solved scale would squeeze below their worth-showing threshold leave the
// tiling as miniatures, coldest first, one at a time; the same selection order and
// guards as the engine's _miniaturizeBelowThreshold, minus the engine probes.
function miniaturizeBelowThreshold(pool, scale, plan, solve, isSacrificeCandidate, mruRank) {
    for (let i = 0; i < pool.length; i++) {
        const shrunk = sizesAt(pool, scale);
        const candidates = pool.filter(p => {
            if (p.isMiniature || !p.resizable || plan.miniaturize.includes(p.id)) return false;
            if (!isSacrificeCandidate(p.id)) return false;
            const s = shrunk.find(e => e.id === p.id);
            // A window still sitting at its preferred size never trips the threshold:
            // the threshold falls back to the work area, so preferred sizes would always trip.
            if (s.width >= p.current.width && s.height >= p.current.height) return false;
            return s.width < p.threshold.width || s.height < p.threshold.height;
        });
        if (candidates.length === 0) break;

        // The last tiled window never leaves: a mosaic of only miniatures has nothing to show.
        if (pool.filter(p => !p.isMiniature).length <= 1) break;

        const victim = candidates.sort((a, b) => mruRank(b.id) - mruRank(a.id))[0];
        plan.miniaturize.push(victim.id);
        pool = pool.map(q => (q.id === victim.id ? toMiniatureRange(q) : q));

        const rescale = solve(pool);
        if (rescale === null) return { pool, scale: null };
        // Marking one freed enough room for everyone to grow back to preferred.
        if (rescale === 1.0) return { pool, scale: 1.0 };
        scale = rescale;
    }
    return { pool, scale };
}

// The full restore decision in one pass: try natural fit, shrink by scale, miniaturize
// what the layout still can't hold (coldest first), then re-solve once so the survivors
// can grow back into the space the sacrifices freed. Result is the plan the caller applies
// (sizes for everyone, plus the ids to hand to the miniature manager).
export function planRestore({ participants, workArea, spacing = constants.WINDOW_SPACING, isSacrificeCandidate = () => true, mruRank = () => 0 }) {
    const plan = { fits: false, scale: 0.0, sizes: new Map(), miniaturize: [] };
    let pool = participants.map(p => ({ ...p }));

    const solve = p => solveScale(p, workArea, spacing);
    let scale = solve(pool);

    // Natural fit: everything stays at its preferred size, the way a plain retile
    // would place it. No shrink, no miniatures; the engine returns early here too.
    if (scale === 1.0) {
        plan.fits = true;
        plan.scale = 1.0;
        for (const s of sizesAt(pool, 1.0))
            plan.sizes.set(s.id, { width: s.width, height: s.height });
        return plan;
    }

    // Even at minimums it overflows: miniaturize the coldest eligible windows one at a
    // time until the floor layout fits. The restoring window is never on this list.
    while (scale === null) {
        const victims = pool
            .filter(p => p.resizable && !p.isMiniature && isSacrificeCandidate(p.id))
            .sort((a, b) => mruRank(b.id) - mruRank(a.id));
        if (victims.length === 0) {
            plan.reason = 'min-overflow';
            return plan;
        }
        const victim = victims[0];
        plan.miniaturize.push(victim.id);
        pool = pool.map(p => (p.id === victim.id ? toMiniatureRange(p) : p));
        scale = solve(pool);
    }

    const settled = miniaturizeBelowThreshold(pool, scale, plan, solve, isSacrificeCandidate, mruRank);
    if (settled.scale === null) {
        plan.reason = 'min-overflow';
        return plan;
    }
    pool = settled.pool;
    scale = settled.scale;

    plan.fits = true;
    plan.scale = scale;
    for (const s of sizesAt(pool, scale))
        plan.sizes.set(s.id, { width: s.width, height: s.height });
    return plan;
}
