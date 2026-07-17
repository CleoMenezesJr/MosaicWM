// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Window reordering via drag and drop

import * as Logger from './logger.js';
import { TileZone } from './constants.js';

import GObject from 'gi://GObject';

export const ReorderingManager = GObject.registerClass({
    GTypeName: 'MosaicReorderingManager',
}, class ReorderingManager extends GObject.Object {
    _init() {
        super._init();
        this.dragStart = false;
        this._dragLayouts = null;
        this._chosenLayout = null;
        this._lastTileState = null;

        this._tilingManager = null;
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;

        this._dragContext = null;
    }

    setTilingManager(manager) {
        this._tilingManager = manager;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    setWindowingManager(manager) {
        this._windowingManager = manager;
    }

    _cursorDistance(cursor, rect) {
        const x = cursor.x - (rect.x + rect.width / 2);
        const y = cursor.y - (rect.y + rect.height / 2);
        return Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
    }

    setPaused(paused) {
        this._paused = paused;
    }

    _onPositionChanged() {
        if (!this.dragStart || !this._tilingManager || !this._dragContext) return;

        if (this._paused) {
            return;
        }

        const { meta_window } = this._dragContext;

        const workspace = meta_window.get_workspace();
        const monitor = global.display.get_current_monitor();

        const _cursor = global.get_pointer();
        const cursor = {
            x: _cursor[0],
            y: _cursor[1]
        };

        if (this._isOverEdgeZone(cursor, workspace, monitor)) {
            this._lastTileState = 'edge-zone';
            return;
        }

        const closest = this._closestLayout(cursor);
        if (!closest) return;

        const { layout: closestLayout, distance: minDist } = closest;

        if (!this._shouldSwitchLayout(cursor, closestLayout, minDist)) return;

        const newState = this._tileStateFor(closestLayout);
        if (this._lastTileState !== newState) {
            this._tilingManager.applyDragLayout(closestLayout.positions, workspace, monitor);
            this._lastTileState = newState;
            this._chosenLayout = closestLayout;
        }
    }

    _isOverEdgeZone(cursor, workspace, monitor) {
        if (!this._edgeTilingManager) return false;

        const workArea = workspace.get_work_area_for_monitor(monitor);
        return this._edgeTilingManager.detectZone(cursor.x, cursor.y, workArea, workspace) !== TileZone.NONE;
    }

    // Sticking to the layout we're already previewing until the new one is clearly closer;
    // near-ties would otherwise flip the preview back and forth under a still cursor.
    _shouldSwitchLayout(cursor, closestLayout, minDist) {
        if (!this._chosenLayout || closestLayout === this._chosenLayout) return true;

        const currentDist = this._cursorDistance(cursor, this._chosenLayout.draggedRect);
        return minDist <= currentDist * 0.5;
    }

    _closestLayout(cursor) {
        if (!this._dragLayouts || this._dragLayouts.length === 0) return null;

        let closestLayout = null;
        let minDist = Infinity;
        for (const layout of this._dragLayouts) {
            const dist = this._cursorDistance(cursor, layout.draggedRect);
            if (dist < minDist) {
                minDist = dist;
                closestLayout = layout;
            }
        }

        return closestLayout ? { layout: closestLayout, distance: minDist } : null;
    }

    _tileStateFor(layout) {
        return `layout-${Math.round(layout.draggedRect.x)}-${Math.round(layout.draggedRect.y)}`;
    }

    // The edge-zone exit tiles the mosaic itself and needs to reproduce this layout;
    // adopting it here keeps the next motion from moving everything again.
    layoutForZoneExit() {
        if (!this.dragStart || !this._dragContext) return null;

        const [x, y] = global.get_pointer();
        const closest = this._closestLayout({ x, y });
        if (!closest) return null;

        this._chosenLayout = closest.layout;
        this._lastTileState = this._tileStateFor(closest.layout);
        return closest.layout;
    }

    startDrag(meta_window) {
        if (!this._tilingManager) return;

        Logger.log(`startDrag called for window ${meta_window.get_id()}`);
        const workspace = meta_window.get_workspace();
        const monitor = global.display.get_current_monitor();
        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        // If the dragged window is on a different monitor (cursor crossed before window did),
        // include it so layout computation can place it in the cursor monitor's mosaic.
        if (!meta_windows.find(w => w.get_id() === meta_window.get_id())) {
            meta_windows = [meta_window, ...meta_windows];
        }

        if (this._animationsManager) {
            this._animationsManager.setDragging(true);
        }

        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());

        const nonEdgeTiledMetaWindows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
        Logger.log(`startDrag: Total: ${meta_windows.length}, Edge-tiled: ${edgeTiledWindows.length}, Mosaic: ${nonEdgeTiledMetaWindows.length}`);

        this._tilingManager.applySwaps(workspace, nonEdgeTiledMetaWindows);

        const descriptors = this._tilingManager.windowsToDescriptors(nonEdgeTiledMetaWindows, monitor, meta_window);

        let remainingSpace = null;
        if (edgeTiledWindows.length > 0 && this._edgeTilingManager) {
            remainingSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            Logger.log(`startDrag: Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
        }

        this._tilingManager.createMask(meta_window);
        this._tilingManager.clearTmpSwap();

        this._tilingManager.enableDragMode(remainingSpace);

        this.dragStart = true;
        // Plain-data copy: the layout search only needs geometry and ids, and
        // descriptors carry a metaWindow GObject that must not be serialized.
        const descriptorsCopy = descriptors.map(d => ({
            id: d.id,
            index: d.index,
            x: d.x,
            y: d.y,
            width: d.width,
            height: d.height,
        }));

        this._dragContext = {
            meta_window,
            id: meta_window.get_id(),
            windows: descriptorsCopy
        };

        // Pre-compute all valid mosaic layouts for this drag session
        const draggedId = meta_window.get_id();
        const workArea = remainingSpace || workspace.get_work_area_for_monitor(monitor);
        this._dragLayouts = this._tilingManager.computeDragLayouts(descriptorsCopy, workArea, draggedId);
        this._chosenLayout = null;

        Logger.log(`Pre-computed ${this._dragLayouts.length} valid drag positions`);

        this._paused = false;
        this._onPositionChanged();
    }

    stopDrag(meta_window, skip_apply, skip_tiling) {
        if (!this._tilingManager) return;

        Logger.log(`stopDrag called for window ${meta_window.get_id()}, dragStart was: ${this.dragStart}`);
        const workspace = meta_window.get_workspace();
        this.dragStart = false;

        // Use the shape from the layout, not re-derived from positions: unequal-height windows
        // have differing top edges and would be misread as separate rows.
        if (!skip_apply && this._chosenLayout && this._tilingManager) {
            this._tilingManager.pinComposition(workspace, this._chosenLayout.shape, this._chosenLayout.permOrder);
        }

        this._dragLayouts = null;
        this._chosenLayout = null;
        this._lastTileState = null;
        this._dragContext = null;

        if (this._animationsManager) {
            this._animationsManager.setDragging(false);
        }

        this._tilingManager.disableDragMode();
        this._tilingManager.destroyMasks();

        if (!skip_tiling) {
            this._tilingManager.tileWorkspaceWindows(workspace, null, meta_window.get_monitor());
        } else {
            Logger.log('stopDrag: Skipping workspace tiling (requested)');
        }
    }

    destroy() {
        this.dragStart = false;
        this._dragLayouts = null;
        this._chosenLayout = null;
        this._dragContext = null;
        this._tilingManager = null;
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
    }
});
