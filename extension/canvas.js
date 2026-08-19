// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Virtual canvas: the tiling surface is wider than the viewport, and a scroll
// offset slides the visible window slice over it. The offset is applied to the
// tile-area origin before the layout pass, never to individual window geometry.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { CANVAS_EXPANSION_RATIO, CANVAS_SIDE_MARGIN_RATIO, CANVAS_REVEAL_PADDING } from './constants.js';
import { constraintSupported } from './mosaicConstraint.js';
import { MosaicModel } from './mosaicModel.js';

export const CanvasManager = GObject.registerClass({
}, class CanvasManager extends GObject.Object {
    _init() {
        super._init();
        this._scrollOffsets = new WeakMap();
        this._contentBounds = new WeakMap();
        this._tilingManager = null;
        this._edgeTilingManager = null;
        this._scrolling = false;
        this._settleId = 0;
        this._settlePending = [];
        this._onSettled = null;
    }

    // Revealing a window has to wait for the layout that placed it, and the guards for when
    // that's unwelcome (drag, a pan the user just made) live with the caller.
    setSettledCallback(callback) {
        this._onSettled = callback;
    }

    setTilingManager(manager) {
        this._tilingManager = manager;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    // Every consumer (tiling, overview, click-to-reveal) crosses this, so it's the only
    // place the canvas can be switched off without two of them disagreeing on the width.
    // Without the external constraint, commitRegion falls back to move_resize_frame, which
    // Mutter clamps to the workarea: the off-screen half of the canvas would pile up at the
    // edge instead of extending past it. Edge tiles pin to the physical workarea too.
    canvasEnabled(workspace, monitor) {
        if (!constraintSupported()) return false;
        if (!this._edgeTilingManager) return true;
        return this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor).length === 0;
    }

    getViewportWidth(workspace, monitor) {
        const area = workspace.get_work_area_for_monitor(monitor);
        return area ? area.width : 0;
    }

    // Total horizontal slide distance across the canvas.
    getMaxScroll(workspace, monitor) {
        const w = this.getViewportWidth(workspace, monitor);
        return Math.round(w * (CANVAS_EXPANSION_RATIO - 1));
    }

    _halfScroll(workspace, monitor) {
        return Math.round(this.getMaxScroll(workspace, monitor) / 2);
    }

    // Where the mosaic actually came out, canvas-relative, reported by the pass that laid it
    // out. Both edges, not a width: a block that gets clamped to the left bound sits off
    // center, and a width would put the scroll limits on the wrong side of it.
    noteContentBounds(workspace, monitor, bounds) {
        let perMonitor = this._contentBounds.get(workspace);
        if (!perMonitor) {
            perMonitor = new Map();
            this._contentBounds.set(workspace, perMonitor);
        }
        perMonitor.set(monitor, bounds);
        this._scheduleSettle(workspace, monitor);
    }

    getContentBounds(workspace, monitor) {
        return this._contentBounds.get(workspace)?.get(monitor) ?? null;
    }

    // Scrolling exists to reach content, so the range is the content's, not the canvas's.
    // A mosaic that fits the viewport has nothing to reach and pins the offset to 0, which is
    // the plain screen center; an anchored block still shows off-center, since that's the
    // layout's own doing and not a scroll.
    _scrollRange(workspace, monitor) {
        const half = this._halfScroll(workspace, monitor);
        const bounds = this.getContentBounds(workspace, monitor);
        if (!bounds) return { lo: -half, hi: half };
        const view = this.getViewportWidth(workspace, monitor);
        if (bounds.right - bounds.left <= view) return { lo: 0, hi: 0 };
        // Scrolled far enough that an edge of the content meets the matching edge of the
        // viewport; past that there is only empty canvas to look at.
        const margin = Math.round(view * CANVAS_SIDE_MARGIN_RATIO);
        const lo = Math.max(-half, bounds.left - margin);
        const hi = Math.min(half, bounds.right - margin - view);
        return lo > hi ? { lo: 0, hi: 0 } : { lo, hi };
    }

    // The overview draws the whole canvas, but scaling against its full width would shrink
    // a mosaic that never needed the extra room. Only the span the content occupies counts.
    overviewSpan(workspace, monitor, area) {
        const canvasWidth = Math.round(area.width * CANVAS_EXPANSION_RATIO);
        const margin = Math.round(area.width * CANVAS_SIDE_MARGIN_RATIO);
        const originX = area.x - margin - this.getScrollOffset(workspace, monitor);
        const bounds = this.getContentBounds(workspace, monitor);
        if (!bounds) return { x: originX, y: area.y, width: canvasWidth, height: area.height };
        // Framing the content where it sits, not a centered span of the same width, or an
        // anchored block would be drawn back in the middle of the overview.
        const width = Math.max(area.width, Math.min(canvasWidth, bounds.right - bounds.left));
        const slack = width - (bounds.right - bounds.left);
        const left = Math.min(Math.max(0, bounds.left - Math.round(slack / 2)), canvasWidth - width);
        return { x: originX + left, y: area.y, width, height: area.height };
    }

    // Closing a window can shrink the content out from under a scroll that was legal when
    // it was made. Both this and the reveal have to run after the pass, since an offset
    // that moves mid-pass leaves the group bounds describing a layout that no longer exists.
    _scheduleSettle(workspace, monitor) {
        if (!this._settlePending.some(p => p.workspace === workspace && p.monitor === monitor))
            this._settlePending.push({ workspace, monitor });
        if (this._settleId) return;
        this._settleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settleId = 0;
            const pending = this._settlePending;
            this._settlePending = [];
            let retiled = false;
            for (const { workspace: ws, monitor: mon } of pending) {
                const stored = this._scrollOffsets.get(ws)?.get(mon) ?? 0;
                const { lo, hi } = this._scrollRange(ws, mon);
                const clamped = Math.round(Math.max(lo, Math.min(hi, stored)));
                if (clamped === stored) continue;
                this.animateScroll(ws, mon, clamped);
                retiled = true;
            }
            // A retile publishes again and schedules the next settle, so the reveal waits
            // for the run where nothing moved any more.
            if (!retiled) this._onSettled?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Stays a plain read on purpose. A pass asks for the origin twice, once to place the
    // windows and once to record the bounds, and an offset that shifts in between makes
    // the two disagree; re-clamping belongs in the settle, after the pass.
    getScrollOffset(workspace, monitor) {
        if (!this.canvasEnabled(workspace, monitor)) return 0;
        const perMonitor = this._scrollOffsets.get(workspace);
        if (!perMonitor) return 0;
        return perMonitor.get(monitor) ?? 0;
    }

    setScrollOffset(workspace, monitor, value) {
        if (!this.canvasEnabled(workspace, monitor)) return 0;
        const { lo, hi } = this._scrollRange(workspace, monitor);
        const clamped = Math.round(Math.max(lo, Math.min(hi, value)));
        let perMonitor = this._scrollOffsets.get(workspace);
        if (!perMonitor) {
            perMonitor = new Map();
            this._scrollOffsets.set(workspace, perMonitor);
        }
        perMonitor.set(monitor, clamped);
        return clamped;
    }

    // Re-tiling applies the new offset at the tile-area origin; the existing
    // tile animation eases every window to its shifted slot. A target that
    // clamps back to the current offset is a no-op, not a retile.
    animateScroll(workspace, monitor, target) {
        if (this._scrolling) return;
        const before = this.getScrollOffset(workspace, monitor);
        const clamped = this.setScrollOffset(workspace, monitor, target);
        if (clamped === before) return;
        this._scrolling = true;
        try {
            this._tilingManager?.tileWorkspaceWindows(workspace, null, monitor, false);
        } finally {
            this._scrolling = false;
        }
    }

    // Scroll only as far as it takes to bring the window fully on screen. Centering it
    // instead would drag everything else along on every focus change, and the window the
    // user just left would leave the viewport for no reason.
    revealWindow(window) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (!workspace || !this.canvasEnabled(workspace, monitor)) return;
        // Mid-animation the frame is a transient size, so ask the model what the layout wants.
        const rect = MosaicModel.geometryOf(window);
        const area = workspace.get_work_area_for_monitor(monitor);
        if (!rect || !area) return;
        const w = this.getViewportWidth(workspace, monitor);
        const pastLeft = area.x - (rect.x - CANVAS_REVEAL_PADDING);
        const pastRight = (rect.x + rect.width + CANVAS_REVEAL_PADDING) - (area.x + w);
        // A window wider than the viewport sticks out either way; showing its left edge
        // beats showing its right one.
        let delta = 0;
        if (pastLeft > 0) delta = -pastLeft;
        else if (pastRight > 0) delta = pastRight;
        if (delta === 0) return;
        this.animateScroll(workspace, monitor,
            this.getScrollOffset(workspace, monitor) + delta);
    }

    stepScroll(workspace, monitor, delta) {
        this.animateScroll(workspace, monitor,
            this.getScrollOffset(workspace, monitor) + delta);
    }

    onWorkspaceRemoved(workspace) {
        this._scrollOffsets.delete(workspace);
        this._contentBounds.delete(workspace);
    }

    destroy() {
        if (this._settleId) {
            GLib.Source.remove(this._settleId);
            this._settleId = 0;
        }
        this._settlePending = [];
        this._onSettled = null;
        this._scrollOffsets = new WeakMap();
        this._contentBounds = new WeakMap();
        this._tilingManager = null;
        this._edgeTilingManager = null;
    }
});
