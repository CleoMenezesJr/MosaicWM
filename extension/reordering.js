// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Window reordering via drag and drop

import * as Logger from './logger.js';
import { TileZone } from './edgeTiling.js';

export class ReorderingManager {
    constructor() {
        this.dragStart = false;
        this._positionChangedId = 0;
        this._rejectedSwap = null;  // Track rejected swap to avoid repeated overflow checks
        this._lastTileState = null;  // Track last tile state to avoid repeated tiling
        
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

    _cursorDistance(cursor, frame) {
        let x = cursor.x - (frame.x + frame.width / 2);
        let y = cursor.y - (frame.y + frame.height / 2);
        return Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
    }

    setPaused(paused) {
        this._paused = paused;
        if (paused && this._tilingManager) {
            this._tilingManager.clearTmpSwap();
        }
    }

    _onPositionChanged() {
        if (!this.dragStart || !this._tilingManager || !this._dragContext) return;
        
        if (this._paused) {
            return;
        }
        
        const { meta_window, id, windows } = this._dragContext;
        
        let workspace = meta_window.get_workspace();
        let monitor = meta_window.get_monitor();
        let workArea = workspace.get_work_area_for_monitor(monitor);

        let _cursor = global.get_pointer();
        let cursor = {
            x: _cursor[0],
            y: _cursor[1]
        }
        
        // EDGE TILING AWARENESS
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        
        const reorderableWindows = windows.filter(w => !edgeTiledIds.includes(w.id));
        
        // If dragged window became edge-tiled, skip swap logic
        if (edgeTiledIds.includes(id)) {
            return;
        }

        let minimum_distance = Infinity;
        let target_id = null;
        for(let window of reorderableWindows) {
            let distance = this._cursorDistance(cursor, window);
            if(distance < minimum_distance)
            {
                minimum_distance = distance;
                target_id = window.id;
            }
        }

        let isOverEdgeZone = false;
        if (this._edgeTilingManager) {
            const zone = this._edgeTilingManager.detectZone(cursor.x, cursor.y, workArea, workspace);
            isOverEdgeZone = zone !== TileZone.NONE;
        }
        
        // When over edge zone, skip all swap and tiling logic - edge tiling handler manages the layout
        if (isOverEdgeZone) {
            this._tilingManager.clearTmpSwap();
            // Don't call tileWorkspaceWindows - edge tiling poll handles it
        } else if (target_id === id || target_id === null) {
            
            // If we have a rejected swap active, don't reset to 'no-swap' immediately.
            // This prevents bouncing when the "revert" animation temporarily makes the target detection fail.
            // We just wait until we either find a VALID new target or hit the edge zone.
            if (this._rejectedSwap) {
                 // Ignoring no-swap because we have rejected swap
            } else if (this._lastTileState !== 'no-swap') {
                this._tilingManager.clearTmpSwap();
                this._rejectedSwap = null;
                this._tilingManager.tileWorkspaceWindows(workspace, meta_window, monitor);
                this._lastTileState = 'no-swap';
            }
        } else if (this._rejectedSwap === target_id) {
            // This swap was already rejected due to overflow - do nothing, keep current layout
            // Don't call tileWorkspaceWindows to avoid re-animation
        } else {
            // Try swap - only if we're changing to a new swap target
            const newState = `swap-${target_id}`;
            if (this._lastTileState !== newState) {
                // DRY-RUN: Check if swap would cause overflow WITHOUT moving windows
                this._tilingManager.setTmpSwap(id, target_id);
                const wouldOverflow = this._tilingManager.tileWorkspaceWindows(
                    workspace, meta_window, monitor, false, false, true  // dryRun = true
                );
                
                if (wouldOverflow) {
                    // Swap would cause overflow - reject without ever moving windows
                    this._rejectedSwap = target_id;
                    this._tilingManager.clearTmpSwap();
                    this._lastTileState = newState;
                } else {
                    // Swap is valid - now actually tile the windows
                    this._tilingManager.tileWorkspaceWindows(workspace, meta_window, monitor);
                    this._rejectedSwap = null;
                    this._lastTileState = newState;
                }
            }
        }
    }

    startDrag(meta_window) {
        if (!this._tilingManager) return;
        
        Logger.log(`[MOSAIC WM] startDrag called for window ${meta_window.get_id()}`);
        let workspace = meta_window.get_workspace()
        let monitor = meta_window.get_monitor();
        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        
        if (this._animationsManager) {
            this._animationsManager.setDragging(true);
        }
        
        // EDGE TILING AWARENESS
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        
        const nonEdgeTiledMetaWindows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
        Logger.log(`[MOSAIC WM] startDrag: Total windows: ${meta_windows.length}, Edge-tiled: ${edgeTiledWindows.length}, Non-edge-tiled: ${nonEdgeTiledMetaWindows.length}`);
        
        this._tilingManager.applySwaps(workspace, nonEdgeTiledMetaWindows);
        
        let descriptors = this._tilingManager.windowsToDescriptors(nonEdgeTiledMetaWindows, monitor);
        
        let remainingSpace = null;
        if (edgeTiledWindows.length > 0 && this._edgeTilingManager) {
            remainingSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            Logger.log(`[MOSAIC WM] startDrag: Remaining space for drag: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
        }

        this._tilingManager.createMask(meta_window);
        this._tilingManager.clearTmpSwap();
        
        this._tilingManager.enableDragMode(remainingSpace);

        this.dragStart = true;
        const descriptorsCopy = JSON.parse(JSON.stringify(descriptors));
        
        this._dragContext = {
            meta_window,
            id: meta_window.get_id(),
            windows: descriptorsCopy
        };
        
        this._boundPositionHandler = this._onPositionChanged.bind(this);
        this._positionChangedId = meta_window.connect('position-changed', this._boundPositionHandler);
        
        this._paused = false; // Ensure paused state is reset on start
        this._onPositionChanged();
    }

    stopDrag(meta_window, skip_apply, skip_tiling) {
        if (!this._tilingManager) return;
        
        Logger.log(`[MOSAIC WM] stopDrag called for window ${meta_window.get_id()}, dragStart was: ${this.dragStart}`);
        let workspace = meta_window.get_workspace();
        this.dragStart = false;
        this._rejectedSwap = null;
        this._lastTileState = null;
        
        if (this._positionChangedId && this._dragContext?.meta_window) {
            try {
                this._dragContext.meta_window.disconnect(this._positionChangedId);
            } catch (e) {
                // Window may have been destroyed
            }
            this._positionChangedId = 0;
        }
        this._boundPositionHandler = null;
        this._dragContext = null;
        
        if (this._animationsManager) {
            this._animationsManager.setDragging(false);
        }
        
        this._tilingManager.disableDragMode();
        this._tilingManager.destroyMasks();
        
        if(!skip_apply)
            this._tilingManager.applyTmpSwap(workspace);
            
        this._tilingManager.clearTmpSwap();
        
        if (!skip_tiling) {
            this._tilingManager.tileWorkspaceWindows(workspace, null, meta_window.get_monitor());
        } else {
            Logger.log(`[MOSAIC WM] stopDrag: Skipping workspace tiling (requested)`);
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
        this._boundPositionHandler = null;
        this._dragContext = null;
        this._tilingManager = null;
        this._edgeTilingManager = null;
        this._animationsManager = null;
    }
}