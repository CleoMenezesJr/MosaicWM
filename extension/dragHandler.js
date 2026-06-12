// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// DragHandler - Manages drag & drop operations and ghost window effects.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Logger from './logger.js';
import { TileZone } from './constants.js';
import { isResizeGrabOp, isMoveGrabOp } from './grabOps.js';
import * as constants from './constants.js';
import { afterAnimations } from './timing.js';
import * as WindowState from './windowState.js';
import { MINIATURE_ANIM_KIND } from './windowState.js';

import GObject from 'gi://GObject';

export const DragHandler = GObject.registerClass({
    GTypeName: 'MosaicDragHandler',
}, class DragHandler extends GObject.Object {
    _init(extension) {
        super._init();
        this._ext = extension;
        
        // Drag state
        this._draggedWindow = null;
        this._edgeTileGhostWindows = [];
        this._previewMiniaturizedWindows = [];
        this._dragMonitorId = null;
        this._currentZone = TileZone.NONE;
        this._dragPositionChangedId = 0;
        this._isPositionProcessing = false;
        this._dragOverflowWindow = null;
        this._currentGrabOp = null;
        this._restoringFromEdgeTile = false;
        this._skipNextTiling = null;
        this._lastReorderMonitor = null;
    }

    // Accessor shortcuts
    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get reorderingManager() { return this._ext.reorderingManager; }
    get drawingManager() { return this._ext.drawingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get swappingManager() { return this._ext.swappingManager; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }

    clearGhostWindows() {
        this._previewMiniaturizedWindows = [];
        for (const win of this._edgeTileGhostWindows) {
            const actor = win.get_compositor_private();
            if (actor) actor.opacity = 255;
        }
        this._edgeTileGhostWindows = [];
    }

    // 'restore' causes createMiniature to animate from current actor state, skipping the snap-to-natural step.
    _commitPreviewMini() {
        for (const win of this._previewMiniaturizedWindows) {
            WindowState.set(win, MINIATURE_ANIM_KIND, 'restore');
        }
        this._previewMiniaturizedWindows = [];
    }

    _grabOpBeginHandler = (_display, window, grabpo) => {
        this._currentGrabOp = grabpo;
        const isResizeOp = isResizeGrabOp(grabpo);
        if (isResizeOp) {
            this._ext.resizeHandler.onResizeBegin(window, grabpo);
        }
        
        if (isMoveGrabOp(grabpo) && !this.windowingManager.isExcluded(window)) {
            const workspace = window.get_workspace();
            if (workspace && this._ext && !this._ext.isMosaicEnabledForWorkspace(workspace))
                return;
            Logger.log('Edge tiling: grab begin');
            this._draggedWindow = window;
            
            const windowState = this.edgeTilingManager.getWindowState(window);
            
            // Initialize _currentZone with window's zone if it's already edge-tiled
            if (windowState && windowState.zone !== TileZone.NONE) {
                this._currentZone = windowState.zone;
                Logger.log(`Edge tiling: window was in zone ${windowState.zone}, initializing _currentZone`);
                
                this._skipNextTiling = window.get_id();
                this._restoringFromEdgeTile = true;
                
                this.edgeTilingManager.removeTile(window, () => {
                    // Delay clearing the flag to cover the debounce period for overflow detection
                    this._timeoutRegistry.add(constants.EDGE_TILE_RESTORE_DELAY_MS, () => {
                        this._restoringFromEdgeTile = false;
                        return GLib.SOURCE_REMOVE;
                    }, 'dragHandler_edgeTileRestoreDelay');
                    
                    Logger.log('Edge tiling: restoration complete, checking if drag still active');
                    this._skipNextTiling = null;
                    this._currentZone = TileZone.NONE; // Reset so window doesn't get re-tiled on release
                    
                    // Check if button was already released during restoration
                    const [_x, _y, mods] = global.get_pointer();
                    const isButtonPressed = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
                    
                    if (!isButtonPressed) {
                        Logger.log('Edge tiling: button released during restoration, skipping startDrag');
                        this._draggedWindow = null;
                        
                        // Retile the workspace so the window returns to mosaic position
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
                        const workspace = window.get_workspace();
                        const monitor = window.get_monitor();
                        const fits = this.tilingManager.canFitWindow(window, workspace, monitor, true);
                         
                        if (!fits) {
                            Logger.log('Edge tile exit: window doesn\'t fit - applying overflow opacity');
                            const actor = window.get_compositor_private();
                            if (actor) {
                                actor.opacity = 128;
                            }
                            this._dragOverflowWindow = window;
                            this.tilingManager.setExcludedWindow(window);
                            this.drawingManager.hideTilePreview();
                            this.drawingManager.removeBoxes();
                        } else {
                            Logger.log(`_grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
                            this.reorderingManager.startDrag(window);
                        }
                    }
                });
                return;
            } else {
                this._currentZone = TileZone.NONE;
            }
            
            // Drive edge-tiling detection from Mutter's position-changed signal
            Logger.log('Connecting signal-based edge tiling listeners');
            this._dragPositionChangedId = this._draggedWindow.connect('position-changed', this._onDragPositionChanged.bind(this));
        }

        // For keyboard/menu move: set up position tracking for reordering (no edge tiling).
        // KEYBOARD_MOVING also matches isMoveGrabOp, so guard against the block
        // above having already connected (a second connect would leak the first id).
        if (grabpo === Meta.GrabOp.KEYBOARD_MOVING && !this._dragPositionChangedId &&
            !this.windowingManager.isExcluded(window)) {
            this._draggedWindow = window;
            this._dragPositionChangedId = this._draggedWindow.connect('position-changed', this._onDragPositionChanged.bind(this));
        }

        if ( !this.windowingManager.isExcluded(window) &&
            (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
            !(this.windowingManager.isMaximizedOrFullscreen(window))) {
            Logger.log(`_grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            this.reorderingManager.startDrag(window);
            this._lastReorderMonitor = global.display.get_current_monitor();
        }
    };
    
    _grabOpEndHandler = (_display, window, grabpo) => {
        this._currentGrabOp = null;
        
        // Handle drag overflow - window that was marked as not fitting
        if (this._dragOverflowWindow && this._dragOverflowWindow === window) {
            Logger.log('Drag ended with overflow window - moving to new workspace');
            const actor = this._dragOverflowWindow.get_compositor_private();
            if (actor) actor.opacity = 255; // Restore opacity
            
            this.tilingManager.clearExcludedWindow();
            this.drawingManager.hideTilePreview();
            this.drawingManager.removeBoxes();
            
            const oldWorkspace = window.get_workspace();
            this.windowingManager.moveOversizedWindow(window).catch(e =>
                Logger.error(`Drag overflow failed: ${e}`));
            afterAnimations(this.animationsManager, () => {
                const monitor = window.get_monitor();
                if (monitor !== null) {
                    this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, monitor, false);
                }
            }, this._timeoutRegistry);
            
            this._dragOverflowWindow = null;
            this._draggedWindow = null;
            this._currentZone = TileZone.NONE;
            
            if (this._dragPositionChangedId && window) {
                try {
                    window.disconnect(this._dragPositionChangedId);
                } catch (e) {
                    Logger.log(`Failed to disconnect signal on drag end (overflow): ${e.message}`);
                }
                this._dragPositionChangedId = 0;
            }
            return;
        }
        
        if ((isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) && window === this._draggedWindow) {
            if (this._dragPositionChangedId && window) {
                try {
                    window.disconnect(this._dragPositionChangedId);
                } catch (e) {
                    Logger.log(`Failed to disconnect signal on drag end: ${e.message}`);
                }
                this._dragPositionChangedId = 0;
            }

            if (isMoveGrabOp(grabpo) && this._currentZone !== TileZone.NONE) {
                Logger.log(`Edge tiling: applying zone ${this._currentZone}`);
                const workspace = window.get_workspace();
                const monitor = global.display.get_current_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                
                const occupiedWindow = this.edgeTilingManager.getWindowInZone(this._currentZone, workspace, monitor);
                
                if (occupiedWindow && occupiedWindow.get_id() !== window.get_id()) {
                    Logger.log(`DnD: zone ${this._currentZone} occupied by ${occupiedWindow.get_id()}, swapping`);
                    
                    this._skipNextTiling = window.get_id();
                    
                    const success = this.swappingManager.swapWindows(window, occupiedWindow, this._currentZone, workspace, monitor);
                    Logger.log(`DnD swap result = ${success}`);
                    
                    if (success) {
                        this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                            this._skipNextTiling = null;
                            return GLib.SOURCE_REMOVE;
                        }, 'dragHandler_skipTilingSwap');
                    } else {
                        this._skipNextTiling = null;
                    }
                } else {
                    Logger.log(`DnD: zone ${this._currentZone} empty, applying tile`);

                    this._skipNextTiling = window.get_id();

                    const success = this.edgeTilingManager.applyTile(window, this._currentZone, workArea);
                    Logger.log(`Edge tiling: apply result = ${success}`);

                    if (success) {
                        if (this._previewMiniaturizedWindows.length > 0) {
                            Logger.log(`Edge tile confirmed - committing ${this._previewMiniaturizedWindows.length} preview miniatures`);
                            this._commitPreviewMini();
                        }

                        this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                            this._skipNextTiling = null;
                            return GLib.SOURCE_REMOVE;
                        }, 'dragHandler_skipTilingApply');
                    } else {
                        // Edge tile failed - clear ghosts
                        this.clearGhostWindows();
                        this._skipNextTiling = null;
                    }
                }
            } 
            
            this.drawingManager.hideTilePreview();
            this._draggedWindow = null;
            this._currentZone = TileZone.NONE;
            this._lastReorderMonitor = null;

            this.tilingManager.clearDragRemainingSpace();
            
            this.edgeTilingManager.setEdgeTilingActive(false, null);
            
            // Failsafe: Always clear ghost windows on drag end
            this.clearGhostWindows();
        }
        
        if (!this.windowingManager.isExcluded(window)) {
            const skipTiling = this._skipNextTiling === window.get_id();
            
            this.reorderingManager.stopDrag(window, false, skipTiling);
            
            const isResizeEnd = isResizeGrabOp(grabpo);
            if (isResizeEnd) {
                this._ext.resizeHandler.onResizeEnd(window, grabpo, skipTiling);
            }
            
            if ( (isMoveGrabOp(grabpo) || grabpo === Meta.GrabOp.KEYBOARD_MOVING) &&
                !(this.windowingManager.isMaximizedOrFullscreen(window)) &&
                !skipTiling) 
            {
                afterAnimations(this.animationsManager, () => {
                    this.tilingManager.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), false);
                }, this._timeoutRegistry);
            }
        } else {
            this.reorderingManager.stopDrag(window, true);
        }
        
        // UNCONDITIONAL CLEANUP
        this.clearGhostWindows();
        this.drawingManager.hideTilePreview();
    };

    _onDragPositionChanged() {
        if (!this._draggedWindow) return;

        const [x, y] = global.get_pointer();
        const monitor = global.display.get_current_monitor();
        const workspace = this._draggedWindow.get_workspace();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        const zone = this.edgeTilingManager.detectZone(x, y, workArea, workspace);
        const isInZone = zone !== TileZone.NONE;
        
        // _currentZone is updated one idle after zone detection; without the guard the synchronous
        // path would draw a reordering rect over the tile-preview overlay on zone entry.
        if (this.reorderingManager) {
            this.reorderingManager.setPaused(isInZone);
            if (!isInZone && this._currentZone === TileZone.NONE) {
                this.reorderingManager._onPositionChanged();
            }
        }

        // THROTTLED VISUAL UPDATE
        if (this._isPositionProcessing) return;
        this._isPositionProcessing = true;
        
        this._timeoutRegistry.addIdle(() => {
            if (!this._draggedWindow) {
                this._isPositionProcessing = false;
                return GLib.SOURCE_REMOVE;
            }
             
            if (zone !== TileZone.NONE && zone !== this._currentZone) {
                Logger.log(`Edge tiling: detected zone ${zone}`);
                this._currentZone = zone;

                if (this._lastReorderMonitor !== null && monitor !== this._lastReorderMonitor) {
                    this.tilingManager.setDragRemainingSpace(null);
                    this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, this._lastReorderMonitor, false, true);
                }
                this._lastReorderMonitor = monitor;
                this.edgeTilingManager.setEdgeTilingActive(true, this._draggedWindow);
                this.drawingManager.showTilePreview(zone, workArea, this._draggedWindow);
                 
                const remainingSpace = this.edgeTilingManager.calculateRemainingSpaceForZone(zone, workArea);
                this.tilingManager.setDragRemainingSpace(remainingSpace);
                 
                this.clearGhostWindows();
                 
                const mosaicWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                    .filter(w => w.get_id() !== this._draggedWindow.get_id() && 
                                 !this.edgeTilingManager.isEdgeTiled(w));
                 
                const result = this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor, false);

                if (result?.overflow) {
                    const miniSlots = this.tilingManager.computePreviewMiniSlots(mosaicWindows, remainingSpace);
                    for (const { win, slot, scale } of miniSlots) {
                        const actor = win.get_compositor_private();
                        if (!actor || actor.is_destroyed()) continue;
                        const frame = win.get_frame_rect();
                        const actorX = actor.x;
                        const actorY = actor.y;
                        const extLeft = frame.x - actorX;
                        const extTop = frame.y - actorY;
                        const actorW = actor.width;
                        const actorH = actor.height;
                        const dw = actorW * (1 - scale);
                        const dh = actorH * (1 - scale);
                        const px = dw > 0 ? Math.max(0, Math.min(1, (slot.x - actorX - extLeft * scale) / dw)) : 0;
                        const py = dh > 0 ? Math.max(0, Math.min(1, (slot.y - actorY - extTop * scale) / dh)) : 0;
                        const endTx = slot.x - actorX - px * dw - extLeft * scale;
                        const endTy = slot.y - actorY - py * dh - extTop * scale;
                        actor.set_pivot_point(px, py);
                        actor.remove_all_transitions();
                        // No set_translation reset: preserves draw()'s compensation offset to avoid a visual jump.
                        actor.ease({
                            scale_x: scale,
                            scale_y: scale,
                            translation_x: endTx,
                            translation_y: endTy,
                            duration: constants.ANIMATION_DURATION_MS,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                        this._previewMiniaturizedWindows.push(win);
                    }
                }
            } else if (zone === TileZone.NONE && this._currentZone !== TileZone.NONE) {
                Logger.log('Edge tiling: exiting zone');
                this._currentZone = TileZone.NONE;
                this.edgeTilingManager.setEdgeTilingActive(false, null);
                this.drawingManager.hideTilePreview();
                this.tilingManager.setDragRemainingSpace(null);

                this.clearGhostWindows();

                this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor);

                this.reorderingManager.resetDragTileState();
                this._lastReorderMonitor = monitor;
            } else if (zone === TileZone.NONE && monitor !== this._lastReorderMonitor) {
                Logger.log(`Drag monitor changed to ${monitor} (fast drag skipped edge zone), restarting reorder`);

                if (this._lastReorderMonitor !== null) {
                    this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, this._lastReorderMonitor, false, true);
                }

                this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor);
                this.reorderingManager.startDrag(this._draggedWindow);
                this._lastReorderMonitor = monitor;
            }
             
            this._isPositionProcessing = false;
            return GLib.SOURCE_REMOVE;
        });
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
        this._dragOverflowWindow = null;
        this._currentGrabOp = null;
    }
} );
