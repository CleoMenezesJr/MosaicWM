// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Manages drag & drop operations and ghost window effects.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Logger from './logger.js';
import { TileZone } from './constants.js';
import { isResizeGrabOp, isMoveGrabOp } from './grabOps.js';
import * as constants from './constants.js';
import { afterAnimations } from './timing.js';
import * as WindowState from './windowState.js';

import GObject from 'gi://GObject';

export const DragHandler = GObject.registerClass({
    GTypeName: 'MosaicDragHandler',
}, class DragHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;

        this._draggedWindow = null;
        this._edgeTileGhostWindows = [];
        this._previewMiniaturizedWindows = [];
        this._miniatureCreatedId = 0;
        this._dragMonitorId = null;
        this._currentZone = TileZone.NONE;
        this._dragPositionChangedId = 0;
        this._isPositionProcessing = false;
        this._currentGrabOp = null;
        this._restoringFromEdgeTile = false;
        this._suppressRestoreRetile = false;
        this._skipNextTiling = null;
        this._lastReorderMonitor = null;
    }

    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get reorderingManager() { return this._ext.reorderingManager; }
    get drawingManager() { return this._ext.drawingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get swappingManager() { return this._ext.swappingManager; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }

    clearGhostWindows() {
        for (const win of this._edgeTileGhostWindows) {
            const actor = win.get_compositor_private();
            if (actor) actor.opacity = 255;
        }
        this._edgeTileGhostWindows = [];
    }

    _disconnectMiniatureCreated() {
        if (!this._miniatureCreatedId) return;
        this._ext.miniatureManager?.disconnect(this._miniatureCreatedId);
        this._miniatureCreatedId = 0;
    }

    // The preview miniaturizes for real, and nothing in the mosaic un-miniaturizes by itself,
    // so leaving the zone (or dropping outside it) is the only thing that can return these.
    _restorePreviewMiniatures() {
        const miniatureManager = this._ext.miniatureManager;
        // restoreMiniature fires 'miniature-restored' synchronously, and its handler retiles;
        // during this drop that retile would re-miniaturize the window (isDragging still true),
        // switching it back so the next entry restores it again in a loop. The drop's own
        // _endReorderAndRetile performs the single authoritative retile, so silence the per-restore
        // one.
        this._suppressRestoreRetile = true;
        try {
            for (const win of this._previewMiniaturizedWindows) {
                if (!miniatureManager || !WindowState.get(win, WindowState.IS_MINIATURE)) continue;
                Logger.log(`Edge preview cancelled - restoring miniature ${win.get_id()}`);
                miniatureManager.restoreMiniature(win, null, { activate: false });
            }
        } finally {
            this._suppressRestoreRetile = false;
        }
        this._previewMiniaturizedWindows = [];
    }

    _grabOpBeginHandler = (_display, window, grabpo) => {
        // Keyboard-driven grabs (Alt+F8 resize, Alt+Tab+move) skip the click overlay
        // entirely, so a miniature could otherwise be manipulated without ever restoring.
        if (WindowState.get(window, WindowState.IS_MINIATURE)) {
            this._ext.miniatureManager?.restoreMiniature(window, null);
        }

        this._currentGrabOp = grabpo;
        if (isResizeGrabOp(grabpo)) {
            this._ext.resizeHandler.onResizeBegin(window, grabpo);
        }

        // A window leaving an edge tile takes its own drag path; when that path owns the
        // grab it has already set everything up, so the reorder blocks below must not run.
        if (isMoveGrabOp(grabpo) && !this.windowingManager.isExcluded(window)) {
            if (this._beginEdgeTileDrag(window, grabpo)) return;
        }

        this._beginKeyboardMoveTracking(window, grabpo);
        this._maybeStartReorder(window, grabpo);
    };

    // Returns true when this took over the grab (mosaic off for the workspace, or the window
    // was edge-tiled and its removal drives the drag), so the caller should back out.
    _beginEdgeTileDrag(window, grabpo) {
        const workspace = window.get_workspace();
        if (workspace && this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace))
            return true;

        Logger.log('Edge tiling: grab begin');
        this._draggedWindow = window;
        this.tilingManager.setGrabbedWindow(window);

        // Only monitor crossings from this drag should retile a source on drop.
        WindowState.remove(window, 'leftMonitor');

        // The edge preview is the only thing that miniaturizes mid-drag, so whatever gets
        // created while the grab is live is ours to return if the drop never happens.
        if (!this._miniatureCreatedId && this._ext.miniatureManager) {
            // The preview re-miniaturizes the same window on every move into the zone, so dedupe;
            // otherwise the restore loop returns the same window dozens of times.
            this._miniatureCreatedId = this._ext.miniatureManager.connect('miniature-created',
                (_mgr, win) => {
                    if (!this._previewMiniaturizedWindows.includes(win))
                        this._previewMiniaturizedWindows.push(win);
                });
        }

        const windowState = this.edgeTilingManager.getWindowState(window);

        if (windowState && windowState.zone !== TileZone.NONE) {
            this._currentZone = windowState.zone;
            Logger.log(`Edge tiling: window was in zone ${windowState.zone}, initializing _currentZone`);

            this._skipNextTiling = window.get_id();
            this._restoringFromEdgeTile = true;

            this.edgeTilingManager.removeTile(window, () => this._onEdgeTileRemovedForDrag(window, grabpo), true);
            return true;
        }

        this._currentZone = TileZone.NONE;
        Logger.log('Connecting signal-based edge tiling listeners');
        this._dragPositionChangedId = this._draggedWindow.connect('position-changed', this._onDragPositionChanged.bind(this));
        return false;
    }

    _onEdgeTileRemovedForDrag(window, grabpo) {
        // Hold the flag until the overflow-detection debounce period passes
        this._timeoutRegistry.add(constants.EDGE_TILE_RESTORE_DELAY_MS, () => {
            this._restoringFromEdgeTile = false;
            return GLib.SOURCE_REMOVE;
        }, 'dragHandler_edgeTileRestoreDelay');

        Logger.log('Edge tiling: restoration complete, checking if drag still active');
        this._skipNextTiling = null;
        this._currentZone = TileZone.NONE; // Clear it so release does not tile the window again

        const [_x, _y, mods] = global.get_pointer();
        const isButtonPressed = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;

        if (!isButtonPressed) {
            Logger.log('Edge tiling: button released during restoration, skipping startDrag');
            this._draggedWindow = null;
            // The retile below cannot move the window while anything still claims the cursor holds
            // it.
            this.tilingManager.setGrabbedWindow(null);

            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            if (workspace && monitor !== null) {
                Logger.log('Edge tiling: triggering retile after quick release');
                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
            }
            return;
        }

        if (
            (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
            window && !this.windowingManager.isMaximizedOrFullscreen(window)
        ) {
            // Build the mosaic before drag mode starts; after isDragging is set, the
            // mosaic no longer miniaturizes and could not form around the held window.
            Logger.log('Edge tiling: building mosaic for the windows that left the tile');
            this.tilingManager.tileWorkspaceWindows(
                window.get_workspace(), window, window.get_monitor(), false);

            Logger.log(`_grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            this.reorderingManager.startDrag(window);
            this._lastReorderMonitor = global.display.get_current_monitor();

            // The grab is still live, so this drag needs the position listener a normal one
            // receives; without it, there is neither a live mosaic nor a zone to snap back to.
            if (!this._dragPositionChangedId) {
                Logger.log('Connecting signal-based edge tiling listeners (edge tile exit)');
                this._dragPositionChangedId = window.connect('position-changed', this._onDragPositionChanged.bind(this));
            }
        }
    }

    // KEYBOARD_MOVING also matches isMoveGrabOp, so protect against the edge-tile block
    // already being connected (a second connect would leak the first id).
    _beginKeyboardMoveTracking(window, grabpo) {
        if (grabpo === Meta.GrabOp.KEYBOARD_MOVING && !this._dragPositionChangedId &&
            !this.windowingManager.isExcluded(window)) {
            this._draggedWindow = window;
            this._dragPositionChangedId = this._draggedWindow.connect('position-changed', this._onDragPositionChanged.bind(this));
        }
    }

    _maybeStartReorder(window, grabpo) {
        if ( !this.windowingManager.isExcluded(window) &&
            (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
            !(this.windowingManager.isMaximizedOrFullscreen(window))) {
            Logger.log(`_grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            this.reorderingManager.startDrag(window);
            this._lastReorderMonitor = global.display.get_current_monitor();
        }
    }

    _grabOpEndHandler = (_display, window, grabpo) => {
        this._currentGrabOp = null;
        // Unconditional: a stray id would lock that window out of all later layouts.
        this.tilingManager.setGrabbedWindow(null);

        if ((isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) && window === this._draggedWindow) {
            this._disconnectDragListener(window);

            if (isMoveGrabOp(grabpo) && this._currentZone !== TileZone.NONE) {
                this._commitEdgeTileDrop(window);
            }

            this._finishMoveDragCleanup();
        }

        this._endReorderAndRetile(window, grabpo);

        this.clearGhostWindows();
        this.drawingManager.hideTilePreview();
    };

    _disconnectDragListener(window) {
        if (this._dragPositionChangedId && window) {
            try {
                window.disconnect(this._dragPositionChangedId);
            } catch (e) {
                Logger.log(`Failed to disconnect signal on drag end: ${e.message}`);
            }
            this._dragPositionChangedId = 0;
        }
    }

    _commitEdgeTileDrop(window) {
        const workspace = window.get_workspace();
        const monitor = global.display.get_current_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        // Check again that the mouse is really in the zone on release.
        // _currentZone updates through an idle, so it may trail the actual pointer
        // position: if the user leaves the zone and releases before the idle runs,
        // _currentZone is still non-NONE and applyTile would fire wrongly.
        const [curX, curY] = global.get_pointer();
        if (this.edgeTilingManager.detectZone(curX, curY, workArea, workspace) === TileZone.NONE) {
            Logger.log(`Edge tiling: grab released outside zone (pointer at ${curX},${curY}), cancelling`);
            this.clearGhostWindows();
            this._restorePreviewMiniatures();
            return;
        }

        Logger.log(`Edge tiling: applying zone ${this._currentZone}`);
        const occupiedWindow = this.edgeTilingManager.getWindowInZone(this._currentZone, workspace, monitor);

        if (occupiedWindow && occupiedWindow.get_id() !== window.get_id()) {
            this._dropBySwapping(window, occupiedWindow, workspace, monitor);
        } else {
            this._dropByTiling(window, workArea);
        }
    }

    _dropBySwapping(window, occupiedWindow, workspace, monitor) {
        Logger.log(`DnD: zone ${this._currentZone} occupied by ${occupiedWindow.get_id()}, swapping`);

        this._skipNextTiling = window.get_id();

        const success = this.swappingManager.swapWindows(window, occupiedWindow, this._currentZone, workspace, monitor);
        Logger.log(`DnD swap result = ${success}`);

        if (success) {
            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                this._skipNextTiling = null;
                return GLib.SOURCE_REMOVE;
            }, 'dragHandler_skipTilingSwap');
            this._previewMiniaturizedWindows = [];
        } else {
            this._restorePreviewMiniatures();
            this._skipNextTiling = null;
        }
    }

    _dropByTiling(window, workArea) {
        if (!this.edgeTilingManager.zoneFits(window, this._currentZone, workArea)) {
            Logger.log(`DnD: zone ${this._currentZone} refused, the window cannot live in it`);
            this._abandonDrop();
            return;
        }

        Logger.log(`DnD: zone ${this._currentZone} empty, applying tile`);

        this._skipNextTiling = window.get_id();

        const success = this.edgeTilingManager.applyTile(window, this._currentZone, workArea);
        Logger.log(`Edge tiling: apply result = ${success}`);

        if (success) {
            // The preview's miniatures are already genuine, so the tile just retains them.
            Logger.log(`Edge tile confirmed - keeping ${this._previewMiniaturizedWindows.length} miniatures`);
            this._previewMiniaturizedWindows = [];
            this.tilingManager.pinEdgePreview(window.get_workspace());

            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                this._skipNextTiling = null;
                return GLib.SOURCE_REMOVE;
            }, 'dragHandler_skipTilingApply');
        } else {
            this._abandonDrop();
        }
    }

    // The window retains whatever the mosaic held for it, namely where it originated.
    _abandonDrop() {
        this.clearGhostWindows();
        this._restorePreviewMiniatures();
        this._skipNextTiling = null;
    }

    _finishMoveDragCleanup() {
        this.drawingManager.hideTilePreview();
        this._draggedWindow = null;
        this._currentZone = TileZone.NONE;
        this._lastReorderMonitor = null;

        this.tilingManager.clearDragRemainingSpace();

        this.edgeTilingManager.setEdgeTilingActive(false, null);

        this.clearGhostWindows();
        // Entries still listed here belong to a preview that never reached a tile.
        this._restorePreviewMiniatures();
        this._disconnectMiniatureCreated();
    }

    _endReorderAndRetile(window, grabpo) {
        if (this.windowingManager.isExcluded(window)) {
            this.reorderingManager.stopDrag(window, true);
            return;
        }

        const skipTiling = this._skipNextTiling === window.get_id();
        const isResizeEnd = isResizeGrabOp(grabpo);

        // resizeHandler.onResizeEnd below takes care of resize-end retiling and holds
        // resizingWindowId set across the final retile
        // to avoid animation jiggle. Leave out stopDrag's own retile here to avoid two overlapping
        // tiling passes.
        // An edge drop already fixed what its preview showed; the reorder's own layout still counts
        // the window that just departed for the tile.
        this.reorderingManager.stopDrag(window, skipTiling && !isResizeEnd, skipTiling || isResizeEnd);

        if (isResizeEnd) {
            this._ext.resizeHandler.onResizeEnd(window, grabpo, skipTiling);
        }

        if ( (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
            !(this.windowingManager.isMaximizedOrFullscreen(window)) &&
            !skipTiling)
        {
            afterAnimations(this.animationsManager, () => {
                // Under workspaces-only-on-primary, a window on a secondary monitor owns no
                // workspace,
                // yet it appears in each workspace's list.
                const workspace = window.get_workspace() ?? global.workspace_manager.get_active_workspace();
                const monitor = window.get_monitor();
                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);

                // The drag crossed monitors; the siblings it abandoned still keep its slot open.
                // onWindowLeftMonitor keeps the source here
                // rather than retiling mid-grab, which would contend with the drag passes above.
                const sourceMonitor = WindowState.get(window, 'leftMonitor');
                if (sourceMonitor !== undefined && sourceMonitor !== monitor) {
                    WindowState.remove(window, 'leftMonitor');

                    this.tilingManager.retileWithAllocation(workspace, sourceMonitor);
                }
            }, this._timeoutRegistry);
        }
    }

    _onDragPositionChanged() {
        if (!this._draggedWindow) return;

        const [x, y] = global.get_pointer();
        const monitor = global.display.get_current_monitor();
        const workspace = this._draggedWindow.get_workspace();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        const zone = this.edgeTilingManager.detectZone(x, y, workArea, workspace);
        const isInZone = zone !== TileZone.NONE;

        // _currentZone refreshes one idle after zone detection; absent the guard, the synchronous
        // path
        // would paint a reordering rect atop the tile-preview overlay when entering a zone.
        if (this.reorderingManager) {
            this.reorderingManager.setPaused(isInZone);
            if (!isInZone && this._currentZone === TileZone.NONE) {
                this.reorderingManager._onPositionChanged();
            }
        }

        if (this._isPositionProcessing) return;
        this._isPositionProcessing = true;

        this._timeoutRegistry.addIdle(() => {
            // finally, not a trailing assignment: an exception below would leave the flag set
            // and each later position idle would stop at the guard, ending the drag for good.
            try {
                if (!this._draggedWindow) return GLib.SOURCE_REMOVE;

                if (zone !== TileZone.NONE && zone !== this._currentZone) {
                    this._enterEdgeZone(zone, workspace, monitor, workArea);
                } else if (zone === TileZone.NONE && this._currentZone !== TileZone.NONE) {
                    this._exitEdgeZone(workspace, monitor);
                } else if (zone === TileZone.NONE && monitor !== this._lastReorderMonitor) {
                    this._restartReorderOnMonitor(workspace, monitor);
                }

                return GLib.SOURCE_REMOVE;
            } finally {
                this._isPositionProcessing = false;
            }
        });
    }

    _enterEdgeZone(zone, workspace, monitor, workArea) {
        Logger.log(`Edge tiling: detected zone ${zone}`);
        this._currentZone = zone;

        if (this._lastReorderMonitor !== null && monitor !== this._lastReorderMonitor) {
            this.tilingManager.setDragRemainingSpace(null);
            this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, this._lastReorderMonitor, false, true);
        }
        this._lastReorderMonitor = monitor;
        this.edgeTilingManager.setEdgeTilingActive(true, this._draggedWindow);
        this._refreshZonePreview(zone, workArea);

        const remainingSpace = this.edgeTilingManager.calculateRemainingSpaceForZone(zone, workArea);
        this.tilingManager.setDragRemainingSpace(remainingSpace);

        this.clearGhostWindows();

        const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => w.get_id() !== this._draggedWindow.get_id() &&
                         !this.edgeTilingManager.isEdgeTiled(w));

        // A lone window able to fill the opposite half is auto-tiled there on drop, so it
        // gets its own tile preview. Miniaturizing it here would preview something that won't
        // occur.
        const pairsIntoOppositeHalf =
            mosaicWindows.length === 1 &&
            (zone === TileZone.LEFT_FULL || zone === TileZone.RIGHT_FULL) &&
            this.edgeTilingManager.isEdgeTileable(mosaicWindows[0], remainingSpace);

        // Determined before tiling, because the tile pass is now what miniaturizes.
        this.tilingManager.setDragMiniaturizationAllowed(!pairsIntoOppositeHalf);
        this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor, false);

        this.drawingManager.hideCompanionTilePreview();

        if (pairsIntoOppositeHalf) {
            Logger.log(`Edge tiling: previewing ${mosaicWindows[0].get_id()} as opposite half ${remainingSpace.width}x${remainingSpace.height}`);
            this.drawingManager.showCompanionTilePreview(remainingSpace);
        }

    }

    // The square merely marks the chosen half; whether the window truly fits there is another
    // matter, and a shake is the no signaled before the drop.
    _refreshZonePreview(zone, workArea) {
        this.drawingManager.showTilePreview(zone, workArea, this._draggedWindow);

        if (this.edgeTilingManager.zoneFits(this._draggedWindow, zone, workArea)) return;

        Logger.log(`Edge tiling: zone ${zone} cannot hold the dragged window`);
        this.animationsManager?.shakeRefusal(this.drawingManager.getTilePreviewActor());
    }

    _exitEdgeZone(workspace, monitor) {
        Logger.log('Edge tiling: exiting zone');
        this._currentZone = TileZone.NONE;
        this.edgeTilingManager.setEdgeTilingActive(false, null);
        this.drawingManager.hideTilePreview();
        this.tilingManager.setDragRemainingSpace(null);
        this.tilingManager.setDragMiniaturizationAllowed(true);

        this.clearGhostWindows();
        // Before the tile pass, so the layout finds them back at full size.
        this._restorePreviewMiniatures();

        // Switch straight to the layout beneath the cursor, the one the drop pins. Putting the pre-
        // zone layout back here instead means the reordering pass on the next pointer move right
        // away drags every window elsewhere.
        const layout = this.reorderingManager.layoutForZoneExit();
        this.tilingManager.setDragLayoutHint(layout);
        this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor);
        this.tilingManager.setDragLayoutHint(null);

        this._lastReorderMonitor = monitor;
    }

    _restartReorderOnMonitor(workspace, monitor) {
        Logger.log(`Drag monitor changed to ${monitor} (fast drag skipped edge zone), restarting reorder`);

        if (this._lastReorderMonitor !== null) {
            this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, this._lastReorderMonitor, false, true);
        }

        this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor);
        this.reorderingManager.startDrag(this._draggedWindow);
        this._lastReorderMonitor = monitor;
    }

    destroy() {
        if (this._dragPositionChangedId && this._draggedWindow) {
            try {
                this._draggedWindow.disconnect(this._dragPositionChangedId);
            } catch (e) {
                Logger.log(`DragHandler cleanup failed: ${e.message}`);
            }
            this._dragPositionChangedId = 0;
        }

        for (const win of this._previewMiniaturizedWindows) {
            const actor = win.get_compositor_private();
            if (actor && !actor.is_destroyed()) {
                actor.remove_all_transitions();
                actor.set_scale(1, 1);
                actor.set_translation(0, 0, 0);
            }
        }
        this.clearGhostWindows();
        this._skipNextTiling = null;
        this._draggedWindow = null;
        this._currentZone = null;
        this._restoringFromEdgeTile = false;
        this._isPositionProcessing = false;
        this._currentGrabOp = null;
    }
} );
