// Copyright 2025 Cleo Menezes Jr.
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
        this._positionChangedId = 0;
        this._dragLayouts = null;
        this._chosenLayout = null;
        this._lastTileState = null;

        this._tilingManager = null;
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;

        this._boundPositionHandler = null;
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
        let x = cursor.x - (rect.x + rect.width / 2);
        let y = cursor.y - (rect.y + rect.height / 2);
        return Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
    }

    setPaused(paused) {
        this._paused = paused;
        if (paused && this._tilingManager) {
            this._tilingManager.clearTmpReorder();
        }
    }

    _onPositionChanged() {
        if (!this.dragStart || !this._tilingManager || !this._dragContext) return;

        if (this._paused) {
            return;
        }

        const { meta_window } = this._dragContext;

        let workspace = meta_window.get_workspace();
        let monitor = global.display.get_current_monitor();
        let workArea = workspace.get_work_area_for_monitor(monitor);

        let _cursor = global.get_pointer();
        let cursor = {
            x: _cursor[0],
            y: _cursor[1]
        }

        // Edge zone — defer to edge tiling handler
        let isOverEdgeZone = false;
        if (this._edgeTilingManager) {
            const zone = this._edgeTilingManager.detectZone(cursor.x, cursor.y, workArea, workspace);
            isOverEdgeZone = zone !== TileZone.NONE;
        }

        if (isOverEdgeZone) {
            this._tilingManager.clearTmpReorder();
            this._lastTileState = 'edge-zone';
            return;
        }

        if (!this._dragLayouts || this._dragLayouts.length === 0) return;

        // Find closest trigger zone
        let closestLayout = null;
        let minDist = Infinity;
        for (const layout of this._dragLayouts) {
            const dist = this._cursorDistance(cursor, layout.draggedRect);
            if (dist < minDist) {
                minDist = dist;
                closestLayout = layout;
            }
        }

        if (!closestLayout) return;

        // Hysteresis: require 50% closer to switch layout
        if (this._chosenLayout && closestLayout !== this._chosenLayout) {
            const currentDist = this._cursorDistance(cursor, this._chosenLayout.draggedRect);
            if (minDist > currentDist * 0.5) return;
        }

        const newState = `layout-${Math.round(closestLayout.draggedRect.x)}-${Math.round(closestLayout.draggedRect.y)}`;
        if (this._lastTileState !== newState) {
            this._tilingManager.applyDragLayout(closestLayout.positions, workspace, monitor);
            this._lastTileState = newState;
            this._chosenLayout = closestLayout;
        }
    }

    startDrag(meta_window) {
        if (!this._tilingManager) return;

        Logger.log(`startDrag called for window ${meta_window.get_id()}`);
        let workspace = meta_window.get_workspace()
        let monitor = global.display.get_current_monitor();
        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);

        // If the dragged window is on a different monitor (cursor crossed before window did),
        // include it so layout computation can place it in the cursor monitor's mosaic.
        if (!meta_windows.find(w => w.get_id() === meta_window.get_id())) {
            meta_windows = [meta_window, ...meta_windows];
        }

        if (this._animationsManager) {
            this._animationsManager.setDragging(true);
        }

        // Filter out edge-tiled windows
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());

        const nonEdgeTiledMetaWindows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
        Logger.log(`startDrag: Total: ${meta_windows.length}, Edge-tiled: ${edgeTiledWindows.length}, Mosaic: ${nonEdgeTiledMetaWindows.length}`);

        this._tilingManager.applySwaps(workspace, nonEdgeTiledMetaWindows);

        let descriptors = this._tilingManager.windowsToDescriptors(nonEdgeTiledMetaWindows, monitor, meta_window);

        let remainingSpace = null;
        if (edgeTiledWindows.length > 0 && this._edgeTilingManager) {
            remainingSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            Logger.log(`startDrag: Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
        }

        this._tilingManager.createMask(meta_window);
        this._tilingManager.clearTmpSwap();
        this._tilingManager.clearTmpReorder();

        this._tilingManager.enableDragMode(remainingSpace);

        this.dragStart = true;
        const descriptorsCopy = JSON.parse(JSON.stringify(descriptors));

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
        let workspace = meta_window.get_workspace();
        this.dragStart = false;

        // Persist chosen layout order
        if (!skip_apply && this._chosenLayout) {
            if (!workspace.swaps) workspace.swaps = [];
            workspace.swaps = workspace.swaps.filter(op => !(Array.isArray(op) && op[0] === 'order'));
            workspace.swaps.push(['order', this._chosenLayout.permOrder]);
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
        this._tilingManager.clearTmpReorder();

        if (!skip_tiling) {
            this._tilingManager.tileWorkspaceWindows(workspace, null, meta_window.get_monitor());
        } else {
            Logger.log(`stopDrag: Skipping workspace tiling (requested)`);
        }
    }

    destroy() {
        if (this._positionChangedId && this._dragContext?.meta_window) {
            const actor = this._dragContext.meta_window.get_compositor_private();
            if (actor) {
                this._dragContext.meta_window.disconnect(this._positionChangedId);
            }
            this._positionChangedId = 0;
        }
        this.dragStart = false;
        this._dragLayouts = null;
        this._chosenLayout = null;
        this._boundPositionHandler = null;
        this._dragContext = null;
        this._tilingManager = null;
        this._edgeTilingManager = null;
        this._animationsManager = null;
    }
});
