// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// DragHandler - Manages drag & drop operations and ghost window effects.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Logger from './logger.js';
import { TileZone } from './constants.js';
import * as constants from './constants.js';
import * as WindowState from './windowState.js';
import { afterAnimations } from './timing.js';

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
        this._dragMonitorId = null;
        this._currentZone = TileZone.NONE;
        this._dragPositionChangedId = 0;
        this._dragEventFilterId = 0;
        this._isPositionProcessing = false;
        this._dragOverflowWindow = null;
        this._currentGrabOp = null;
        this._restoringFromEdgeTile = false;
        this._skipNextTiling = null;
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

    // Restore opacity of ghost windows when exiting edge zone or drag ends
    clearGhostWindows() {
        if (!this._edgeTileGhostWindows) return;
        for (const win of this._edgeTileGhostWindows) {
            const actor = win.get_compositor_private();
            if (actor) {
                actor.opacity = 255;
            }
        }
        this._edgeTileGhostWindows = [];
    }

    // Move ghost windows to overflow workspace when edge tile is confirmed
    moveGhostWindowsToOverflow() {
        if (!this._edgeTileGhostWindows || this._edgeTileGhostWindows.length === 0) return;
        
        Logger.log(`[MOSAIC WM] Moving ${this._edgeTileGhostWindows.length} ghost windows to overflow`);
        
        for (const win of this._edgeTileGhostWindows) {
            const actor = win.get_compositor_private();
            if (actor) actor.opacity = 255;
            
            this.windowingManager.moveOversizedWindow(win);
        }
        
        this._edgeTileGhostWindows = [];
    }

    _grabOpBeginHandler = (display, window, grabpo) => {
        this._currentGrabOp = grabpo;
        const isResizeOp = constants.RESIZE_GRAB_OPS.includes(grabpo);
        if (isResizeOp) {
            // Resize logic delegation (will be handled by ResizeHandler)
            this._ext.resizeHandler.onResizeBegin(window, grabpo);
        }
        
        if (grabpo === 1 && !this.windowingManager.isExcluded(window)) {
            Logger.log(`[MOSAIC WM] Edge tiling: grab begin`);
            this._draggedWindow = window;
            
            const windowState = this.edgeTilingManager.getWindowState(window);
            
            // Initialize _currentZone with window's zone if it's already edge-tiled
            if (windowState && windowState.zone !== TileZone.NONE) {
                this._currentZone = windowState.zone;
                Logger.log(`[MOSAIC WM] Edge tiling: window was in zone ${windowState.zone}, initializing _currentZone`);
                
                this._skipNextTiling = window.get_id();
                this._restoringFromEdgeTile = true;
                
                this.edgeTilingManager.removeTile(window, () => {
                    // Delay clearing the flag to cover the debounce period for overflow detection
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.EDGE_TILE_RESTORE_DELAY_MS, () => {
                        this._restoringFromEdgeTile = false;
                        return GLib.SOURCE_REMOVE;
                    });
                    
                    Logger.log(`[MOSAIC WM] Edge tiling: restoration complete, checking if drag still active`);
                    this._skipNextTiling = null;
                    this._currentZone = TileZone.NONE; // Reset so window doesn't get re-tiled on release
                    
                    // Check if button was already released during restoration
                    const [x, y, mods] = global.get_pointer();
                    const isButtonPressed = (mods & Clutter.ModifierType.BUTTON1_MASK) !== 0;
                    
                    if (!isButtonPressed) {
                        Logger.log(`[MOSAIC WM] Edge tiling: button released during restoration, skipping startDrag`);
                        this._draggedWindow = null;
                        
                        // Retile the workspace so the window returns to mosaic position
                        const workspace = window.get_workspace();
                        const monitor = window.get_monitor();
                        if (workspace && monitor !== null) {
                            Logger.log(`[MOSAIC WM] Edge tiling: triggering retile after quick release`);
                            this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
                        }
                        return;
                    }

                    // Window logic continues...
                    if ( 
                        (grabpo === Meta.GrabOp.MOVING || grabpo === Meta.GrabOp.KEYBOARD_MOVING) && 
                        window && !this.windowingManager.isMaximizedOrFullscreen(window)
                    ) {
                         const workspace = window.get_workspace();
                         const monitor = window.get_monitor();
                         const fits = this.tilingManager.canFitWindow(window, workspace, monitor, true);
                         
                         if (!fits) {
                             Logger.log(`[MOSAIC WM] Edge tile exit: window doesn't fit - applying overflow opacity`);
                             const actor = window.get_compositor_private();
                             if (actor) {
                                 actor.opacity = 128;
                             }
                             this._dragOverflowWindow = window;
                             this.tilingManager.setExcludedWindow(window);
                             this.drawingManager.hideTilePreview();
                             this.drawingManager.removeBoxes();
                         } else {
                             Logger.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
                             this.reorderingManager.startDrag(window);
                         }
                    }
                });
                return;
            } else {
                this._currentZone = TileZone.NONE;
            }
            
            // Connect signal-based listeners for edge tiling (replaces polling)
            Logger.log(`[MOSAIC WM] Connecting signal-based edge tiling listeners`);
            this._dragPositionChangedId = this._draggedWindow.connect('position-changed', this._onDragPositionChanged.bind(this));
        }
        
        if ( !this.windowingManager.isExcluded(window) &&
            (grabpo === Meta.GrabOp.MOVING || grabpo === Meta.GrabOp.KEYBOARD_MOVING) && 
            !(this.windowingManager.isMaximizedOrFullscreen(window))) {
            Logger.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            this.reorderingManager.startDrag(window);
        }
    };
    
    _grabOpEndHandler = (display, window, grabpo) => {
        this._currentGrabOp = null;
        
        // Handle drag overflow - window that was marked as not fitting
        if (this._dragOverflowWindow && this._dragOverflowWindow === window) {
            Logger.log(`[MOSAIC WM] Drag ended with overflow window - moving to new workspace`);
            const actor = this._dragOverflowWindow.get_compositor_private();
            if (actor) actor.opacity = 255; // Restore opacity
            
            this.tilingManager.clearExcludedWindow();
            this.drawingManager.hideTilePreview();
            this.drawingManager.removeBoxes();
            
            const oldWorkspace = window.get_workspace();
            this.windowingManager.moveOversizedWindow(window);
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
                    Logger.log(`[MOSAIC WM] Failed to disconnect signal on drag end (overflow): ${e.message}`);
                }
                this._dragPositionChangedId = 0;
            }
            if (this._dragEventFilterId) {
                Clutter.Event.remove_filter(this._dragEventFilterId);
                this._dragEventFilterId = 0;
            }
            return;
        }
        
        if (grabpo === Meta.GrabOp.MOVING && window === this._draggedWindow) {
            if (this._dragPositionChangedId && window) {
                try {
                    window.disconnect(this._dragPositionChangedId);
                } catch (e) {
                    Logger.log(`[MOSAIC WM] Failed to disconnect signal on drag end: ${e.message}`);
                }
                this._dragPositionChangedId = 0;
            }
            
            if (this._currentZone !== TileZone.NONE) {
                Logger.log(`[MOSAIC WM] Edge tiling: applying zone ${this._currentZone}`);
                const workspace = window.get_workspace();
                const monitor = window.get_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                
                const occupiedWindow = this.edgeTilingManager.getWindowInZone(this._currentZone, workspace, monitor);
                
                if (occupiedWindow && occupiedWindow.get_id() !== window.get_id()) {
                    Logger.log(`[MOSAIC WM] DnD: zone ${this._currentZone} occupied by ${occupiedWindow.get_id()}, swapping`);
                    
                    this._skipNextTiling = window.get_id();
                    
                    const success = this.swappingManager.swapWindows(window, occupiedWindow, this._currentZone, workspace, monitor);
                    Logger.log(`[MOSAIC WM] DnD swap result = ${success}`);
                    
                    if (success) {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RETILE_DELAY_MS, () => {
                            this._skipNextTiling = null;
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        this._skipNextTiling = null;
                    }
                } else {
                    Logger.log(`[MOSAIC WM] DnD: zone ${this._currentZone} empty, applying tile`);
                    
                    this._skipNextTiling = window.get_id();
                    
                    const success = this.edgeTilingManager.applyTile(window, this._currentZone, workArea);
                    Logger.log(`[MOSAIC WM] Edge tiling: apply result = ${success}`);
                    
                    if (success) {
                        // Move ghost windows to overflow after edge tile is applied
                        if (this._edgeTileGhostWindows.length > 0) {
                            Logger.log(`[MOSAIC WM] Edge tile confirmed - moving ${this._edgeTileGhostWindows.length} ghost windows to overflow`);
                            this.moveGhostWindowsToOverflow();
                        }
                        
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RETILE_DELAY_MS, () => {
                            this._skipNextTiling = null;
                            return GLib.SOURCE_REMOVE;
                        });
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
            
            this.tilingManager.clearDragRemainingSpace();
            
            this.edgeTilingManager.setEdgeTilingActive(false, null);
            
            // Failsafe: Always clear ghost windows on drag end
            this.clearGhostWindows();
        }
        
        if (!this.windowingManager.isExcluded(window)) {
            const skipTiling = this._skipNextTiling === window.get_id();
            
            this.reorderingManager.stopDrag(window, false, skipTiling);
            
            const isResizeEnd = constants.RESIZE_GRAB_OPS.includes(grabpo);
            if (isResizeEnd) {
                this._ext.resizeHandler.onResizeEnd(window, grabpo, skipTiling);
            }
            
            if ( (grabpo === Meta.GrabOp.MOVING || grabpo === Meta.GrabOp.KEYBOARD_MOVING) && 
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

    _onDragGlobalButtonRelease(event) {
        if (event.type() !== Clutter.EventType.BUTTON_RELEASE) {
            return Clutter.EVENT_PROPAGATE;
        }

        // Cleanup filter immediately to avoid duplicate events
        if (this._dragEventFilterId) {
            Clutter.Event.remove_filter(this._dragEventFilterId);
            this._dragEventFilterId = 0;
        }

        if (!this._draggedWindow) {
            return Clutter.EVENT_PROPAGATE;
        }

        Logger.log(`[MOSAIC WM] Global button release detected - cleaning up drag`);
        
        if (this._currentZone !== TileZone.NONE) {
            const workspace = this._draggedWindow.get_workspace();
            const monitor = this._draggedWindow.get_monitor();
            const workArea = workspace.get_work_area_for_monitor(monitor);
            
            Logger.log(`[MOSAIC WM] Applying zone ${this._currentZone} on button release`);
            this.edgeTilingManager.applyTile(this._draggedWindow, this._currentZone, workArea);
        }
        
        this.drawingManager.hideTilePreview();
        this.tilingManager.clearDragRemainingSpace();
        this.edgeTilingManager.setEdgeTilingActive(false, null);
        
        // Clear ghost windows
        this.clearGhostWindows();
        
        // Restore opacity if window was marked as overflow
        if (this._dragOverflowWindow) {
            const overflowActor = this._dragOverflowWindow.get_compositor_private();
            if (overflowActor) overflowActor.opacity = 255;
            this.tilingManager.clearExcludedWindow();
            this._dragOverflowWindow = null;
        }
        
        const draggedWindow = this._draggedWindow;
        this._draggedWindow = null;
        this._currentZone = TileZone.NONE;
        
        this.reorderingManager.stopDrag(draggedWindow, false, true);

        // Disconnect position signal if still active
        if (this._dragPositionChangedId && draggedWindow) {
            try {
                draggedWindow.disconnect(this._dragPositionChangedId);
            } catch (e) {
                Logger.log(`[MOSAIC WM] Failed to disconnect drag signal: ${e.message}`);
            }
            this._dragPositionChangedId = 0;
        }
        
        return Clutter.EVENT_PROPAGATE;
    }

    _onDragPositionChanged() {
        if (!this._draggedWindow) return;
        
        const monitor = this._draggedWindow.get_monitor();
        const workspace = this._draggedWindow.get_workspace();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const [x, y] = global.get_pointer();
        
        const zone = this.edgeTilingManager.detectZone(x, y, workArea, workspace);
        const isInZone = zone !== TileZone.NONE;
        
        // Delegate reordering if we are NOT in an edge zone
        if (this.reorderingManager) {
            this.reorderingManager.setPaused(isInZone);
            if (!isInZone) {
                this.reorderingManager._onPositionChanged();
            }
        }

        // THROTTLED VISUAL UPDATE
        if (this._isPositionProcessing) return;
        this._isPositionProcessing = true;
        
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
             if (!this._draggedWindow) {
                 this._isPositionProcessing = false;
                 return GLib.SOURCE_REMOVE;
             }
             
             if (zone !== TileZone.NONE && zone !== this._currentZone) {
                 Logger.log(`[MOSAIC WM] Edge tiling: detected zone ${zone}`);
                 this._currentZone = zone;
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
                     for (const win of mosaicWindows) {
                         const actor = win.get_compositor_private();
                         if (actor) {
                             actor.opacity = 128;
                             this._edgeTileGhostWindows.push(win);
                         }
                     }
                 }
             } else if (zone === TileZone.NONE && this._currentZone !== TileZone.NONE) {
                 Logger.log(`[MOSAIC WM] Edge tiling: exiting zone`);
                 this._currentZone = TileZone.NONE;
                 this.edgeTilingManager.setEdgeTilingActive(false, null);
                 this.drawingManager.hideTilePreview();
                 this.tilingManager.setDragRemainingSpace(null);
                 
                 this.clearGhostWindows();
                 
                 this.tilingManager.tileWorkspaceWindows(workspace, this._draggedWindow, monitor);
                 
                 this.reorderingManager.startDrag(this._draggedWindow);
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
                Logger.log(`[MOSAIC WM] DragHandler cleanup failed: ${e.message}`);
            }
            this._dragPositionChangedId = 0;
        }
        
        if (this._dragEventFilterId) {
            Clutter.Event.remove_filter(this._dragEventFilterId);
            this._dragEventFilterId = 0;
        }
        
        this.clearGhostWindows();
    }
} );
