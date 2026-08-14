// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Virtual canvas: the tiling surface is wider than the viewport, and a scroll
// offset slides the visible window slice over it. The offset is applied to the
// tile-area origin before the layout pass, never to individual window geometry.

import GObject from 'gi://GObject';

import { CANVAS_EXPANSION_RATIO } from './constants.js';

export const CanvasManager = GObject.registerClass({
}, class CanvasManager extends GObject.Object {
    _init() {
        super._init();
        this._scrollOffsets = new WeakMap();
        this._tilingManager = null;
        this._edgeTilingManager = null;
        this._scrolling = false;
    }

    setTilingManager(manager) {
        this._tilingManager = manager;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    // Edge tiles pin to the physical workarea, so a workspace hosting them has
    // no canvas. Everything below reads 0 / no-ops in that case.
    canvasEnabled(workspace, monitor) {
        if (!this._edgeTilingManager) return true;
        return this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor).length === 0;
    }

    getViewportWidth(workspace, monitor) {
        const area = workspace.get_work_area_for_monitor(monitor);
        return area ? area.width : 0;
    }

    getCanvasWidth(workspace, monitor) {
        return Math.round(this.getViewportWidth(workspace, monitor) * CANVAS_EXPANSION_RATIO);
    }

    // Total horizontal slide distance across the canvas.
    getMaxScroll(workspace, monitor) {
        const w = this.getViewportWidth(workspace, monitor);
        return Math.round(w * (CANVAS_EXPANSION_RATIO - 1));
    }

    _halfScroll(workspace, monitor) {
        return Math.round(this.getMaxScroll(workspace, monitor) / 2);
    }

    getScrollOffset(workspace, monitor) {
        if (!this.canvasEnabled(workspace, monitor)) return 0;
        const perMonitor = this._scrollOffsets.get(workspace);
        if (!perMonitor) return 0;
        return perMonitor.get(monitor) ?? 0;
    }

    setScrollOffset(workspace, monitor, value) {
        if (!this.canvasEnabled(workspace, monitor)) return 0;
        const half = this._halfScroll(workspace, monitor);
        const clamped = Math.max(-half, Math.min(half, value));
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

    // Shift the viewport so the frame's center lands on the viewport's center.
    // target = current + (frameCenter − viewportCenter), since every window
    // moves by exactly the offset delta.
    centerOnWindow(window) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        if (!workspace || !this.canvasEnabled(workspace, monitor)) return;
        const frame = window.get_frame_rect();
        const area = workspace.get_work_area_for_monitor(monitor);
        const w = this.getViewportWidth(workspace, monitor);
        const delta = (frame.x + frame.width / 2) - (area.x + w / 2);
        this.animateScroll(workspace, monitor,
            this.getScrollOffset(workspace, monitor) + delta);
    }

    stepScroll(workspace, monitor, delta) {
        this.animateScroll(workspace, monitor,
            this.getScrollOffset(workspace, monitor) + delta);
    }

    onWorkspaceRemoved(workspace) {
        this._scrollOffsets.delete(workspace);
    }

    destroy() {
        this._scrollOffsets = new WeakMap();
        this._tilingManager = null;
        this._edgeTilingManager = null;
    }
});
