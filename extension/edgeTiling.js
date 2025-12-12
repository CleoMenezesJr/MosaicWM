// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Edge tiling (snap to screen edges) functionality

import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as animations from './animations.js';
import * as constants from './constants.js';

export const TileZone = {
    NONE: 0,
    LEFT_FULL: 1,
    RIGHT_FULL: 2,
    TOP_LEFT: 3,
    TOP_RIGHT: 4,
    BOTTOM_LEFT: 5,
    BOTTOM_RIGHT: 6,
    FULLSCREEN: 7
};

export class EdgeTilingManager {
    constructor() {
        // Module state for window states (pre-tile position/size)
        this._windowStates = new Map(); // windowId -> { x, y, width, height, zone }

        // Module state for edge tiling activity
        this._isEdgeTilingActive = false;
        this._activeEdgeTilingWindow = null;

        // Module state for interactive resize
        this._resizeListeners = new Map(); // windowId -> signalId
        this._isResizing = false; // Flag to prevent recursive resize
        this._previousSizes = new Map(); // windowId -> { width, height } for delta tracking

        // Module state for auto-tiling dependencies
        // Maps: dependentWindowId -> masterWindowId
        this._autoTiledDependencies = new Map();
        
        this._animationsManager = null;
    }
    
    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    isEdgeTilingActive() {
        return this._isEdgeTilingActive;
    }

    getActiveEdgeTilingWindow() {
        return this._activeEdgeTilingWindow;
    }

    setEdgeTilingActive(active, window = null) {
        Logger.log(`[MOSAIC WM] Edge tiling state: ${this._isEdgeTilingActive} -> ${active}, window: ${window ? window.get_id() : 'null'}`);
        this._isEdgeTilingActive = active;
        this._activeEdgeTilingWindow = window;
    }

    clearAllStates() {
        this._resizeListeners.forEach((signalId, winId) => {
            const window = this._findWindowById(winId);
            if (window) {
                try {
                    window.disconnect(signalId);
                } catch (e) {
                    // Ignore if window destroyed
                }
            }
        });
        this._resizeListeners.clear();
        this._windowStates.clear();
        this._autoTiledDependencies.clear();
        this._previousSizes.clear();
        this._isResizing = false;
        this._isEdgeTilingActive = false;
        this._activeEdgeTilingWindow = null;
    }

    /**
     * Cleanup and destroy manager
     */
    destroy() {
        this.clearAllStates();
        this._animationsManager = null;
    }

    /**
     * Check if there are edge-tiled windows on a specific side
     * @private
     * @param {Meta.Workspace} workspace
     * @param {string} side - 'left' or 'right'
     * @returns {boolean}
     */
    _hasEdgeTiledWindows(workspace, side) {
        if (!workspace) return false;
        
        const windows = workspace.list_windows();
        for (const win of windows) {
            const state = this._windowStates.get(win.get_id());
            if (!state || state.zone === TileZone.NONE || state.zone === TileZone.FULLSCREEN) continue;
            
            if (side === 'left') {
                if (state.zone === TileZone.LEFT_FULL || 
                    state.zone === TileZone.TOP_LEFT || 
                    state.zone === TileZone.BOTTOM_LEFT) {
                    return true;
                }
            } else if (side === 'right') {
                if (state.zone === TileZone.RIGHT_FULL || 
                    state.zone === TileZone.TOP_RIGHT || 
                    state.zone === TileZone.BOTTOM_RIGHT) {
                    return true;
                }
            }
        }
        return false;
    }

    detectZone(cursorX, cursorY, workArea, workspace) {
        const threshold = constants.EDGE_TILING_THRESHOLD;
        const thirdY = workArea.height / 3;
        
        if (cursorX < workArea.x + threshold) {
            const hasLeftWindows = this._hasEdgeTiledWindows(workspace, 'left');
            
            if (!hasLeftWindows) return TileZone.LEFT_FULL;
            
            const relY = cursorY - workArea.y;
            if (relY < thirdY) return TileZone.TOP_LEFT;
            if (relY > workArea.height - thirdY) return TileZone.BOTTOM_LEFT;
            return TileZone.LEFT_FULL;
        }
        
        if (cursorX > workArea.x + workArea.width - threshold) {
            const hasRightWindows = this._hasEdgeTiledWindows(workspace, 'right');
            
            if (!hasRightWindows) return TileZone.RIGHT_FULL;
            
            const relY = cursorY - workArea.y;
            if (relY < thirdY) return TileZone.TOP_RIGHT;
            if (relY > workArea.height - thirdY) return TileZone.BOTTOM_RIGHT;
            return TileZone.RIGHT_FULL;
        }
        return TileZone.NONE;
    }

    /**
     * Get width of existing tile on the same side
     * @private
     */
    _getExistingSideWidth(workspace, monitor, side) {
        if (!workspace || monitor === undefined) return null;
        
        const workspaceWindows = workspace.list_windows().filter(w => 
            w.get_monitor() === monitor &&
            !w.is_hidden() &&
            w.get_window_type() === Meta.WindowType.NORMAL
        );
        
        let existing = null;
        for (const w of workspaceWindows) {
            const state = this.getWindowState(w);
            if (!state || !state.zone) continue;
            
            if (side === 'LEFT' && (
                state.zone === TileZone.LEFT_FULL ||
                state.zone === TileZone.TOP_LEFT ||
                state.zone === TileZone.BOTTOM_LEFT
            )) {
                existing = w;
                break;
            } else if (side === 'RIGHT' && (
                state.zone === TileZone.RIGHT_FULL ||
                state.zone === TileZone.TOP_RIGHT ||
                state.zone === TileZone.BOTTOM_RIGHT
            )) {
                existing = w;
                break;
            }
        }
        
        if (existing) {
            const frame = existing.get_frame_rect();
            return frame.width;
        }
        return null;
    }

    /**
     * Get height of existing quarter tile window
     * @private
     */
    _getExistingQuarterHeight(workspace, monitor, zone) {
        if (!workspace || monitor === undefined) return null;
        
        const workspaceWindows = workspace.list_windows().filter(w => 
            w.get_monitor() === monitor &&
            !w.is_hidden() &&
            w.get_window_type() === Meta.WindowType.NORMAL
        );
        
        const existing = workspaceWindows.find(w => {
            const state = this.getWindowState(w);
            return state && state.zone === zone;
        });
        
        if (existing) {
            const frame = existing.get_frame_rect();
            return frame.height;
        }
        return null;
    }

    getZoneRect(zone, workArea, windowToTile = null) {
        if (!workArea) return null;
        
        let existingWidth = null;
        
        if (windowToTile) {
            const workspace = windowToTile.get_workspace();
            const monitor = windowToTile.get_monitor();
            const workspaceWindows = workspace.list_windows().filter(w => 
                w.get_monitor() === monitor && 
                w.get_id() !== windowToTile.get_id() &&
                !w.is_hidden() &&
                w.get_window_type() === Meta.WindowType.NORMAL
            );
            
            let oppositeZone = null;
            if (zone === TileZone.LEFT_FULL) oppositeZone = TileZone.RIGHT_FULL;
            else if (zone === TileZone.RIGHT_FULL) oppositeZone = TileZone.LEFT_FULL;
            
            if (oppositeZone) {
                const existingWindow = workspaceWindows.find(w => {
                    const state = this.getWindowState(w);
                    return state && state.zone === oppositeZone;
                });
                
                if (existingWindow) {
                    const frame = existingWindow.get_frame_rect();
                    existingWidth = frame.width;
                    Logger.log(`[MOSAIC WM] getZoneRect: Found existing tiled window with width ${existingWidth}px`);
                }
            }
        }
        
        const halfWidth = Math.floor(workArea.width / 2);
        const halfHeight = Math.floor(workArea.height / 2);
        
        const workspace = windowToTile?.get_workspace();
        const monitor = windowToTile?.get_monitor();

        switch(zone) {
            case TileZone.LEFT_FULL:
                return {
                    x: workArea.x,
                    y: workArea.y,
                    width: existingWidth ? (workArea.width - existingWidth) : halfWidth,
                    height: workArea.height
                };
                
            case TileZone.RIGHT_FULL:
                return {
                    x: existingWidth ? (workArea.x + existingWidth) : (workArea.x + halfWidth),
                    y: workArea.y,
                    width: existingWidth ? (workArea.width - existingWidth) : (workArea.width - halfWidth),
                    height: workArea.height
                };
                
            case TileZone.TOP_LEFT: {
                const leftWidth = this._getExistingSideWidth(workspace, monitor, 'LEFT') || halfWidth;
                const bottomHeight = this._getExistingQuarterHeight(workspace, monitor, TileZone.BOTTOM_LEFT);
                return { 
                    x: workArea.x, 
                    y: workArea.y, 
                    width: leftWidth, 
                    height: bottomHeight ? (workArea.height - bottomHeight) : halfHeight 
                };
            }
                
            case TileZone.TOP_RIGHT: {
                const rightWidth = this._getExistingSideWidth(workspace, monitor, 'RIGHT') || halfWidth;
                const bottomHeight = this._getExistingQuarterHeight(workspace, monitor, TileZone.BOTTOM_RIGHT);
                return { 
                    x: workArea.x + workArea.width - rightWidth, 
                    y: workArea.y, 
                    width: rightWidth, 
                    height: bottomHeight ? (workArea.height - bottomHeight) : halfHeight 
                };
            }
                
            case TileZone.BOTTOM_LEFT: {
                const leftWidth = this._getExistingSideWidth(workspace, monitor, 'LEFT') || halfWidth;
                const topHeight = this._getExistingQuarterHeight(workspace, monitor, TileZone.TOP_LEFT);
                return { 
                    x: workArea.x, 
                    y: topHeight ? (workArea.y + topHeight) : (workArea.y + halfHeight), 
                    width: leftWidth, 
                    height: topHeight ? (workArea.height - topHeight) : (workArea.height - halfHeight) 
                };
            }
                
            case TileZone.BOTTOM_RIGHT: {
                const rightWidth = this._getExistingSideWidth(workspace, monitor, 'RIGHT') || halfWidth;
                const topHeight = this._getExistingQuarterHeight(workspace, monitor, TileZone.TOP_RIGHT);
                return { 
                    x: workArea.x + workArea.width - rightWidth, 
                    y: topHeight ? (workArea.y + topHeight) : (workArea.y + halfHeight), 
                    width: rightWidth, 
                    height: topHeight ? (workArea.height - topHeight) : (workArea.height - halfHeight) 
                };
            }
                
            case TileZone.FULLSCREEN:
                return { 
                    x: workArea.x, 
                    y: workArea.y, 
                    width: workArea.width, 
                    height: workArea.height 
                };
            default:
                return null;
        }
    }

    saveWindowState(window) {
        const winId = window.get_id();
        const existingState = this._windowStates.get(winId);
        
        if (existingState) {
            Logger.log(`[MOSAIC WM] Window ${winId} already has saved state (${existingState.width}x${existingState.height}), preserving it`);
            return;
        }
        
        const frame = window.get_frame_rect();
        this._windowStates.set(winId, {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            zone: TileZone.NONE
        });
        Logger.log(`[MOSAIC WM] Saved window ${winId} PRE-TILING state: ${frame.width}x${frame.height}`);
    }

    getWindowState(window) {
        return this._windowStates.get(window.get_id());
    }

    getEdgeTiledWindows(workspace, monitor) {
        const windows = workspace.list_windows().filter(w => 
            w.get_monitor() === monitor && 
            !w.is_skip_taskbar() &&
            w.window_type === Meta.WindowType.NORMAL
        );
        
        return windows
            .map(w => ({window: w, state: this.getWindowState(w)}))
            .filter(({state}) => state && state.zone !== TileZone.NONE)
            .map(({window, state}) => ({window, zone: state.zone}));
    }

    getNonEdgeTiledWindows(workspace, monitor) {
        const windows = workspace.list_windows().filter(w => 
            w.get_monitor() === monitor && 
            !w.is_skip_taskbar() &&
            w.window_type === Meta.WindowType.NORMAL
        );
        
        return windows.filter(w => {
            const state = this.getWindowState(w);
            return !state || state.zone === TileZone.NONE;
        });
    }

    getWindowInZone(zone, workspace, monitor) {
        const edgeTiledWindows = this.getEdgeTiledWindows(workspace, monitor);
        
        for (const {window, zone: windowZone} of edgeTiledWindows) {
            if (windowZone === zone) {
                return window;
            }
        }
        return null;
    }

    calculateRemainingSpace(workspace, monitor) {
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const edgeTiledWindows = this.getEdgeTiledWindows(workspace, monitor);
        
        if (edgeTiledWindows.length === 0) return workArea;
        
        const hasLeftFull = edgeTiledWindows.some(w => w.zone === TileZone.LEFT_FULL);
        const hasLeftQuarters = edgeTiledWindows.some(w => 
            w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT
        );
        
        const hasRightFull = edgeTiledWindows.some(w => w.zone === TileZone.RIGHT_FULL);
        const hasRightQuarters = edgeTiledWindows.some(w => 
            w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT
        );
        
        const halfWidth = Math.floor(workArea.width / 2);
        
        if (hasLeftFull || hasLeftQuarters) {
            // Find the rightmost edge of all left-tiled windows
            let maxRight = workArea.x;
            edgeTiledWindows.forEach(w => {
                 if (w.zone === TileZone.LEFT_FULL || w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT) {
                     const rect = w.window.get_frame_rect();
                     maxRight = Math.max(maxRight, rect.x + rect.width);
                 }
            });
            
            return {
                x: maxRight,
                y: workArea.y,
                width: (workArea.x + workArea.width) - maxRight,
                height: workArea.height
            };
        }
        
        if (hasRightFull || hasRightQuarters) {
            // Find the leftmost edge of all right-tiled windows
            let minLeft = workArea.x + workArea.width;
            edgeTiledWindows.forEach(w => {
                 if (w.zone === TileZone.RIGHT_FULL || w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT) {
                     const rect = w.window.get_frame_rect();
                     minLeft = Math.min(minLeft, rect.x);
                 }
            });

            return {
                x: workArea.x,
                y: workArea.y,
                width: minLeft - workArea.x,
                height: workArea.height
            };
        }
        
        return workArea;
    }

    calculateRemainingSpaceForZone(zone, workArea) {
        const halfWidth = Math.floor(workArea.width / 2);
        
        switch (zone) {
            case TileZone.LEFT_FULL:
            case TileZone.TOP_LEFT:
            case TileZone.BOTTOM_LEFT:
                return {
                    x: workArea.x + halfWidth,
                    y: workArea.y,
                    width: workArea.width - halfWidth,
                    height: workArea.height
                };
                
            case TileZone.RIGHT_FULL:
            case TileZone.TOP_RIGHT:
            case TileZone.BOTTOM_RIGHT:
                return {
                    x: workArea.x,
                    y: workArea.y,
                    width: halfWidth,
                    height: workArea.height
                };
                
            default:
                return workArea;
        }
    }

    clearWindowState(window) {
        const winId = window.get_id();
        const state = this._windowStates.get(winId);
        
        // If this was a quarter tile, expand the adjacent quarter to FULL
        if (state && state.zone && this._isQuarterZone(state.zone)) {
            Logger.log(`[MOSAIC WM] Quarter tile ${winId} being removed from zone ${state.zone}`);
            
            const adjacentZone = this._getAdjacentQuarterZone(state.zone);
            if (adjacentZone) {
                const adjacentWindow = this._findWindowInZone(adjacentZone, window.get_workspace());
                
                if (adjacentWindow) {
                    Logger.log(`[MOSAIC WM] Found adjacent quarter ${adjacentWindow.get_id()} in zone ${adjacentZone}, expanding to FULL`);
                    
                    const fullZone = this._getFullZoneFromQuarter(state.zone);
                    const workspace = window.get_workspace();
                    const monitor = window.get_monitor();
                    const workArea = workspace.get_work_area_for_monitor(monitor);
                    const fullRect = this.getZoneRect(fullZone, workArea, adjacentWindow);
                    
                    if (fullRect) {
                        adjacentWindow.move_resize_frame(false, fullRect.x, fullRect.y, fullRect.width, fullRect.height);
                        
                        const adjacentState = this._windowStates.get(adjacentWindow.get_id());
                        if (adjacentState) adjacentState.zone = fullZone;
                        
                        Logger.log(`[MOSAIC WM] Expanded quarter to ${fullZone}: ${fullRect.width}x${fullRect.height}`);
                    }
                }
            }
        }
        
        // Clean up dependencies
        this._autoTiledDependencies.forEach((masterId, dependentId) => {
            if (masterId === winId || dependentId === winId) {
                this._autoTiledDependencies.delete(dependentId);
            }
        });
        
        this._windowStates.delete(winId);
    }

    registerAutoTileDependency(dependentId, masterId) {
        this._autoTiledDependencies.set(dependentId, masterId);
        Logger.log(`[MOSAIC WM] Registered auto-tile dependency: ${dependentId} depends on ${masterId}`);
    }

    isEdgeTiled(window) {
        const state = this._windowStates.get(window.get_id());
        return state && state.zone !== TileZone.NONE;
    }

    checkQuarterExpansion(workspace, monitor) {
        const edgeTiledWindows = this.getEdgeTiledWindows(workspace, monitor);
        if (edgeTiledWindows.length === 0) return;
        
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        // Check left side
        const leftQuarters = edgeTiledWindows.filter(w => 
            w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT
        );
        
        if (leftQuarters.length === 1) {
            const window = leftQuarters[0].window;
            Logger.log(`[MOSAIC WM] Single quarter on left - expanding to LEFT_FULL`);
            
            const state = this._windowStates.get(window.get_id());
            if (state) state.zone = TileZone.LEFT_FULL;
            
            const rect = this.getZoneRect(TileZone.LEFT_FULL, workArea, window);
            if (rect) {
                if (this._animationsManager) {
                    this._animationsManager.animateWindow(window, rect, { subtle: true });
                } else {
                    window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
                }
            }
        }
        
        // Check right side
        const rightQuarters = edgeTiledWindows.filter(w => 
            w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT
        );
        
        if (rightQuarters.length === 1) {
            const window = rightQuarters[0].window;
            Logger.log(`[MOSAIC WM] Single quarter on right - expanding to RIGHT_FULL`);
            
            const state = this._windowStates.get(window.get_id());
            if (state) state.zone = TileZone.RIGHT_FULL;
            
            const rect = this.getZoneRect(TileZone.RIGHT_FULL, workArea, window);
            if (rect) {
                if (this._animationsManager) {
                    this._animationsManager.animateWindow(window, rect, { subtle: true });
                } else {
                    window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
                }
            }
        }
    }

    // Helpers for clearWindowState
    _isQuarterZone(zone) {
        return zone === TileZone.TOP_LEFT || zone === TileZone.BOTTOM_LEFT ||
               zone === TileZone.TOP_RIGHT || zone === TileZone.BOTTOM_RIGHT;
    }

    _getAdjacentQuarterZone(zone) {
        switch (zone) {
            case TileZone.TOP_LEFT: return TileZone.BOTTOM_LEFT;
            case TileZone.BOTTOM_LEFT: return TileZone.TOP_LEFT;
            case TileZone.TOP_RIGHT: return TileZone.BOTTOM_RIGHT;
            case TileZone.BOTTOM_RIGHT: return TileZone.TOP_RIGHT;
            default: return null;
        }
    }

    _getFullZoneFromQuarter(zone) {
        if (zone === TileZone.TOP_LEFT || zone === TileZone.BOTTOM_LEFT) {
            return TileZone.LEFT_FULL;
        } else {
            return TileZone.RIGHT_FULL;
        }
    }

    _findWindowInZone(zone, workspace) {
        const windows = workspace.list_windows();
        for (const win of windows) {
            const state = this._windowStates.get(win.get_id());
            if (state && state.zone === zone) return win;
        }
        return null;
    }

    setTilingManager(tilingManager) {
        this._tilingManager = tilingManager;
    }

    /**
     * Check if window can be resized to target dimensions
     * @private
     * @param {Meta.Window} window
     * @param {number} targetWidth
     * @param {number} targetHeight
     * @returns {boolean}
     */
    _canResize(window, targetWidth, targetHeight) {
        if (window.window_type !== 0) { // Meta.WindowType.NORMAL
            Logger.log(`[MOSAIC WM] Window type ${window.window_type} cannot be edge-tiled`);
            return false;
        }
        
        if (window.allows_resize && !window.allows_resize()) {
            Logger.log(`[MOSAIC WM] Window does not allow resize`);
            return false;
        }
        return true;
    }

    applyTile(window, zone, workArea, skipOverflowCheck = false) {
        this.saveWindowState(window);
        
        const winId = window.get_id();
        
        if (this._autoTiledDependencies.has(winId)) {
            Logger.log(`[MOSAIC WM] Manual retile breaks auto-tile dependency for ${winId}`);
            this._autoTiledDependencies.delete(winId);
        }
        
        if (zone === TileZone.FULLSCREEN) {
            window.maximize(Meta.MaximizeFlags.BOTH);
            const state = this._windowStates.get(window.get_id());
            if (state) state.zone = zone;
            Logger.log(`[MOSAIC WM] Maximized window ${window.get_id()}`);
            return true;
        }
        
        const rect = this.getZoneRect(zone, workArea, window);
        if (!rect) {
            Logger.log(`[MOSAIC WM] Invalid zone ${zone}`);
            return false;
        }
        
        if (!this._canResize(window, rect.width, rect.height)) return false;
        
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        let fullToQuarterConversion = null;
        
        if (zone === TileZone.BOTTOM_LEFT || zone === TileZone.TOP_LEFT) {
            Logger.log(`[MOSAIC WM] Checking for LEFT_FULL conversion, zone=${zone}`);
            const workspaceWindows = workspace.list_windows().filter(w => 
                w.get_monitor() === monitor &&
                w.get_id() !== window.get_id() &&
                !w.is_hidden() &&
                w.get_window_type() === Meta.WindowType.NORMAL
            );
            
            Logger.log(`[MOSAIC WM] Found ${workspaceWindows.length} potential windows`);
            
            const leftFullWindow = workspaceWindows.find(w => {
                const state = this.getWindowState(w);
                Logger.log(`[MOSAIC WM] Window ${w.get_id()} state: ${state ? `zone=${state.zone}` : 'no state'}`);
                return state && state.zone === TileZone.LEFT_FULL;
            });
            
            if (leftFullWindow) {
                Logger.log(`[MOSAIC WM] Found LEFT_FULL window ${leftFullWindow.get_id()} for conversion`);
                const newZone = (zone === TileZone.BOTTOM_LEFT) ? TileZone.TOP_LEFT : TileZone.BOTTOM_LEFT;
                fullToQuarterConversion = { window: leftFullWindow, newZone };
            } else {
                Logger.log(`[MOSAIC WM] No LEFT_FULL window found for conversion`);
            }
        } else if (zone === TileZone.BOTTOM_RIGHT || zone === TileZone.TOP_RIGHT) {
            const workspaceWindows = workspace.list_windows().filter(w => 
                w.get_monitor() === monitor &&
                w.get_id() !== window.get_id() &&
                !w.is_hidden() &&
                w.get_window_type() === Meta.WindowType.NORMAL
            );
            
            const rightFullWindow = workspaceWindows.find(w => {
                const state = this.getWindowState(w);
                return state && state.zone === TileZone.RIGHT_FULL;
            });
            
            if (rightFullWindow) {
                const newZone = (zone === TileZone.BOTTOM_RIGHT) ? TileZone.TOP_RIGHT : TileZone.BOTTOM_RIGHT;
                fullToQuarterConversion = { window: rightFullWindow, newZone };
            }
        }
        
        let savedFullTileWidth = null;
        if (fullToQuarterConversion) {
            const fullFrame = fullToQuarterConversion.window.get_frame_rect();
            savedFullTileWidth = fullFrame.width;
            Logger.log(`[MOSAIC WM] Converting FULL tile ${fullToQuarterConversion.window.get_id()} to quarter zone ${fullToQuarterConversion.newZone}, preserving width=${savedFullTileWidth}px`);
        }
        
        window.unmaximize();
        
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._animationsManager) {
                this._animationsManager.animateWindow(window, rect, { subtle: true });
            } else {
                window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
            }
            
            this.setupResizeListener(window);
            
            const state = this._windowStates.get(winId);
            if (state) state.zone = zone;
            
            Logger.log(`[MOSAIC WM] Applied edge tile zone ${zone} to window ${winId}`);
            
            if (fullToQuarterConversion && savedFullTileWidth) {
                const convertedRect = this.getZoneRect(fullToQuarterConversion.newZone, workArea, fullToQuarterConversion.window);
                
                convertedRect.width = savedFullTileWidth;
                rect.width = savedFullTileWidth;
                
                if (fullToQuarterConversion.newZone === TileZone.TOP_LEFT || fullToQuarterConversion.newZone === TileZone.BOTTOM_LEFT) {
                    convertedRect.x = workArea.x;
                    rect.x = workArea.x;
                } else {
                    convertedRect.x = workArea.x + workArea.width - savedFullTileWidth;
                    rect.x = workArea.x + workArea.width - savedFullTileWidth;
                }
                
                const halfHeight = Math.floor(workArea.height / 2);
                
                if (this._animationsManager) {
                    this._animationsManager.animateWindow(fullToQuarterConversion.window, {
                        x: convertedRect.x,
                        y: convertedRect.y,
                        width: convertedRect.width,
                        height: halfHeight
                    }, { subtle: true });
                    
                    this._animationsManager.animateWindow(window, {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: halfHeight
                    });
                } else {
                    fullToQuarterConversion.window.move_resize_frame(false, convertedRect.x, convertedRect.y, convertedRect.width, halfHeight);
                    window.move_resize_frame(false, rect.x, rect.y, rect.width, halfHeight);
                }
                
                Logger.log(`[MOSAIC WM] Applied quarter tiles with halfHeight=${halfHeight}px, width=${savedFullTileWidth}px`);
                
                const convertedState = this._windowStates.get(fullToQuarterConversion.window.get_id());
                if (convertedState) {
                    Logger.log(`[MOSAIC WM] Converted window original state: ${convertedState.width}x${convertedState.height} (preserving for restore)`);
                    convertedState.zone = fullToQuarterConversion.newZone;
                }
                
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.POLL_INTERVAL_MS, () => {
                    const actualConvertedFrame = fullToQuarterConversion.window.get_frame_rect();
                    const actualNewFrame = window.get_frame_rect();
                    
                    if (actualConvertedFrame.height !== halfHeight || actualNewFrame.height !== halfHeight) {
                        if (zone === TileZone.BOTTOM_LEFT || zone === TileZone.BOTTOM_RIGHT) {
                            if (actualNewFrame.height > halfHeight) {
                                const topHeight = workArea.height - actualNewFrame.height;
                                const bottomY = workArea.y + topHeight;
                                fullToQuarterConversion.window.move_resize_frame(false, convertedRect.x, workArea.y, convertedRect.width, topHeight);
                                window.move_resize_frame(false, rect.x, bottomY, rect.width, actualNewFrame.height);
                            } else {
                                const bottomY = actualConvertedFrame.y + actualConvertedFrame.height;
                                const bottomHeight = (workArea.y + workArea.height) - bottomY;
                                window.move_resize_frame(false, rect.x, bottomY, rect.width, bottomHeight);
                            }
                        } else {
                            if (actualNewFrame.height > halfHeight) {
                                const bottomHeight = workArea.height - actualNewFrame.height;
                                const bottomY = workArea.y + actualNewFrame.height;
                                fullToQuarterConversion.window.move_resize_frame(false, convertedRect.x, bottomY, convertedRect.width, bottomHeight);
                            } else {
                                const bottomY = actualNewFrame.y + actualNewFrame.height;
                                const bottomHeight = (workArea.y + workArea.height) - bottomY;
                                fullToQuarterConversion.window.move_resize_frame(false, convertedRect.x, bottomY, convertedRect.width, bottomHeight);
                            }
                        }
                    }
                    
                    if (this._tilingManager) {
                        this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            
            // Handle mosaic windows that can't fit in remaining space
            if (!skipOverflowCheck) {
                this._handleMosaicOverflow(window, zone);
            }
            
            return GLib.SOURCE_REMOVE;
        });
        
        return true;
    }

    /**
     * Remove edge tiling and restore window to previous state
     * @param {Meta.Window} window
     * @param {Function} callback
     */
    removeTile(window, callback = null) {
        const winId = window.get_id();
        const savedState = this._windowStates.get(winId);

        if (!savedState || savedState.zone === TileZone.NONE) {
            Logger.log(`[MOSAIC WM] removeTile: Window ${winId} is not edge-tiled`);
            if (callback) callback();
            return;
        }
        
        Logger.log(`[MOSAIC WM] removeTile: Removing tile from window ${winId}, zone=${savedState.zone}`);
        Logger.log(`[MOSAIC WM] removeTile: Saved state to restore: ${savedState.width}x${savedState.height} at (${savedState.x}, ${savedState.y})`);
        
        this._removeResizeListener(window);
        
        const savedWidth = savedState.width;
        const savedHeight = savedState.height;
        const savedX = savedState.x;
        const savedY = savedState.y;
        
        Logger.log(`[MOSAIC WM] removeTile: Checking dependencies for master=${winId}, total dependencies=${this._autoTiledDependencies.size}`);
        this._autoTiledDependencies.forEach((masterId, dependentId) => {
            Logger.log(`[MOSAIC WM] removeTile: Dependency: dependent=${dependentId} -> master=${masterId}`);
            if (masterId === winId) {
                Logger.log(`[MOSAIC WM] removeTile: Found dependent ${dependentId} of master ${winId}, removing...`);
                const dependent = this._findWindowById(dependentId);
                if (dependent) {
                    Logger.log(`[MOSAIC WM] removeTile: Calling removeTile on dependent ${dependentId}`);
                    this.removeTile(dependent);
                } else {
                    Logger.log(`[MOSAIC WM] removeTile: Could not find window for dependent ${dependentId}`);
                }
                this._autoTiledDependencies.delete(dependentId);
            }
        });
        
        if (this._isQuarterZone(savedState.zone)) {
            Logger.log(`[MOSAIC WM] Quarter tile ${winId} being removed from zone ${savedState.zone}`);
            
            const adjacentZone = this._getAdjacentQuarterZone(savedState.zone);
            if (adjacentZone) {
                const adjacentWindow = this._findWindowInZone(adjacentZone, window.get_workspace());
                
                if (adjacentWindow) {
                    const fullZone = this._getFullZoneFromQuarter(savedState.zone);
                    const workspace = window.get_workspace();
                    const monitor = window.get_monitor();
                    const workArea = workspace.get_work_area_for_monitor(monitor);
                    const fullRect = this.getZoneRect(fullZone, workArea, adjacentWindow);
                    
                    if (fullRect) {
                        adjacentWindow.move_resize_frame(false, fullRect.x, fullRect.y, fullRect.width, fullRect.height);
                        const adjacentState = this._windowStates.get(adjacentWindow.get_id());
                        if (adjacentState) adjacentState.zone = fullZone;
                    }
                }
            }
        }
        
        savedState.zone = TileZone.NONE;
        
        if (window.maximized_horizontally || window.maximized_vertically) {
            window.unmaximize();
        }
        
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        
        // Calculate remaining mosaic space after edge tiles
        const remainingSpace = this.calculateRemainingSpace(workspace, monitor);
        
        // Check if saved size fits in remaining space, resize if needed
        let finalWidth = savedWidth;
        let finalHeight = savedHeight;
        
        if (remainingSpace.width > 0 && remainingSpace.height > 0) {
            // Leave some margin (80% of available space max)
            const maxWidth = Math.floor(remainingSpace.width * 0.85);
            const maxHeight = Math.floor(remainingSpace.height * 0.85);
            
            if (savedWidth > maxWidth || savedHeight > maxHeight) {
                // Scale down proportionally while maintaining aspect ratio
                const widthRatio = maxWidth / savedWidth;
                const heightRatio = maxHeight / savedHeight;
                const scale = Math.min(widthRatio, heightRatio, 1);
                
                finalWidth = Math.floor(savedWidth * scale);
                finalHeight = Math.floor(savedHeight * scale);
                Logger.log(`[MOSAIC WM] removeTile: Window ${winId} resized to fit: ${savedWidth}x${savedHeight} -> ${finalWidth}x${finalHeight}`);
            }
        }
        
        const [cursorX, cursorY] = global.get_pointer();
        const restoredX = cursorX - (finalWidth / 2);
        const restoredY = cursorY - 20;
        
        Logger.log(`[MOSAIC WM] removeTile: Restoring window ${winId} to size ${finalWidth}x${finalHeight} at cursor (${restoredX}, ${restoredY})`);
        window.move_resize_frame(false, restoredX, restoredY, finalWidth, finalHeight);
        
        if (callback) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.RETILE_DELAY_MS, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Handle mosaic overflow after edge tiling is applied
     * @private
     * @param {Meta.Window} tiledWindow
     * @param {number} zone
     */
    _handleMosaicOverflow(tiledWindow, zone) {
        Logger.log(`[MOSAIC WM] _handleMosaicOverflow: called for zone=${zone}`);
        
        const workspace = tiledWindow.get_workspace();
        const monitor = tiledWindow.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        // Check if BOTH sides are now edge-tiled (including the window just tiled)
        const edgeTiledWindows = this.getEdgeTiledWindows(workspace, monitor);
        const zones = edgeTiledWindows.map(w => w.zone);
        
        const hasLeft = zones.includes(TileZone.LEFT_FULL) || 
                        zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
        const hasRight = zones.includes(TileZone.RIGHT_FULL) || 
                         zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
        
        const mosaicWindows = this.getNonEdgeTiledWindows(workspace, monitor);
        
        if (mosaicWindows.length === 0) return;
        
        // If both sides are occupied, move ALL mosaic windows to new workspace
        if (hasLeft && hasRight) {
            Logger.log(`[MOSAIC WM] Both sides edge-tiled - moving ${mosaicWindows.length} mosaic windows to new workspace`);
            const workspaceManager = global.workspace_manager;
            const newWorkspace = workspaceManager.append_new_workspace(false, global.get_current_time());
            
            for (const mosaicWindow of mosaicWindows) {
                mosaicWindow.change_workspace(newWorkspace);
            }
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.REVERSE_RESIZE_PROTECTION_MS, () => {
                if (this._tilingManager) {
                    this._tilingManager.tileWorkspaceWindows(workspace, null, monitor);
                }
                return GLib.SOURCE_REMOVE;
            });
            
            newWorkspace.activate(global.get_current_time());
            return;
        }
        
        // Single edge tile - check if we should auto-tile the single mosaic window
        if (mosaicWindows.length === 1) {
            const mosaicWindow = mosaicWindows[0];
            
            // Only auto-tile to opposite side for FULL zones
            // When only one mosaic window remains, always auto-tile it to the opposite side
            if (zone === TileZone.LEFT_FULL || zone === TileZone.RIGHT_FULL) {
                const oppositeZone = (zone === TileZone.LEFT_FULL) ? TileZone.RIGHT_FULL : TileZone.LEFT_FULL;
                
                Logger.log(`[MOSAIC WM] _handleMosaicOverflow: auto-tiling single window ${mosaicWindow.get_id()} to opposite zone ${oppositeZone}`);
                
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this.applyTile(mosaicWindow, oppositeZone, workArea);
                    
                    const dependentId = mosaicWindow.get_id();
                    const masterId = tiledWindow.get_id();
                    this._autoTiledDependencies.set(dependentId, masterId);
                    
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
        }
        
        // Use tiling manager to check if mosaic windows fit in remaining space
        if (!this._tilingManager) return;
        
        // Try to tile and check for overflow
        const testTileInfo = this._tilingManager._tile(
            mosaicWindows.map((w, i) => ({
                index: i,
                width: w.get_frame_rect().width,
                height: w.get_frame_rect().height
            })),
            remainingSpace
        );
        
        if (testTileInfo.overflow) {
            Logger.log(`[MOSAIC WM] Mosaic overflow detected - moving ${mosaicWindows.length} windows to new workspace`);
            const workspaceManager = global.workspace_manager;
            const newWorkspace = workspaceManager.append_new_workspace(false, global.get_current_time());
            
            for (const mosaicWindow of mosaicWindows) {
                mosaicWindow.change_workspace(newWorkspace);
            }
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.REVERSE_RESIZE_PROTECTION_MS, () => {
                if (this._tilingManager) {
                    this._tilingManager.tileWorkspaceWindows(workspace, null, monitor);
                }
                return GLib.SOURCE_REMOVE;
            });
            
            newWorkspace.activate(global.get_current_time());
        }
    }

    /**
     * Setup resize listener for edge-tiled window
     * @param {Meta.Window} window
     */
    setupResizeListener(window) {
        const winId = window.get_id();
        
        if (this._resizeListeners.has(winId)) return;
        
        const signalId = window.connect('size-changed', () => {
            this._handleWindowResize(window);
        });
        
        this._resizeListeners.set(winId, signalId);
        Logger.log(`[MOSAIC WM] Setup resize listener for window ${winId}`);
    }

    /**
     * Remove resize listener from window
     * @private
     * @param {Meta.Window} window
     */
    _removeResizeListener(window) {
        const winId = window.get_id();
        const signalId = this._resizeListeners.get(winId);
        
        if (signalId) {
            window.disconnect(signalId);
            this._resizeListeners.delete(winId);
            Logger.log(`[MOSAIC WM] Removed resize listener from window ${winId}`);
        }
    }

    /**
     * Handle window resize event
     * @private
     * @param {Meta.Window} window
     */
    _handleWindowResize(window) {
        const state = this.getWindowState(window);
        if (!state || state.zone === TileZone.NONE) return;
        
        if (this._isResizing) return;
        
        Logger.log(`[MOSAIC WM] Resize detected on edge-tiled window ${window.get_id()}, zone=${state.zone}`);
        
        if (state.zone === TileZone.LEFT_FULL || state.zone === TileZone.RIGHT_FULL) {
            this._handleHorizontalResize(window, state.zone);
        } else if (this._isQuarterZone(state.zone)) {
            this._handleVerticalResize(window, state.zone);
        }
    }

    _handleHorizontalResize(window, zone) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        const adjacentWindow = this._getAdjacentWindow(window, workspace, monitor, zone);
        
        if (!adjacentWindow) {
            // No adjacent edge tile - retile mosaic to adapt to new edge tile size
            this._handleResizeWithMosaic(window, workspace, monitor);
            return;
        }
        
        this._resizeTiledPair(window, adjacentWindow, workArea, zone);
    }

    _handleVerticalResize(window, zone) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        const adjacentZone = this._getAdjacentQuarterZone(zone);
        if (!adjacentZone) return;
        
        const adjacentWindow = this._findWindowInZone(adjacentZone, workspace);
        if (!adjacentWindow) return;
        
        const resizedId = window.get_id();
        const adjacentId = adjacentWindow.get_id();
        const resizedFrame = window.get_frame_rect();
        
        const previousState = this._previousSizes.get(resizedId);
        
        if (!previousState) {
            const adjacentFrame = adjacentWindow.get_frame_rect();
            this._previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, y: resizedFrame.y });
            this._previousSizes.set(adjacentId, { width: adjacentFrame.width, height: adjacentFrame.height, y: adjacentFrame.y });
            return;
        }
        
        const newAdjacentHeight = workArea.height - resizedFrame.height;
        const minHeight = constants.MIN_WINDOW_HEIGHT;
        const maxResizedHeight = workArea.height - minHeight;
        
        if (resizedFrame.height > maxResizedHeight) return;
        if (newAdjacentHeight < minHeight) return;
        
        const isResizedTop = (zone === TileZone.TOP_LEFT || zone === TileZone.TOP_RIGHT);
        this._isResizing = true;
        
        try {
            if (isResizedTop) {
                window.move_frame(false, resizedFrame.x, workArea.y);
                window.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, resizedFrame.height);
                
                const adjacentY = workArea.y + resizedFrame.height;
                adjacentWindow.move_frame(false, resizedFrame.x, adjacentY);
                adjacentWindow.move_resize_frame(false, resizedFrame.x, adjacentY, resizedFrame.width, newAdjacentHeight);
                
                this._previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, y: workArea.y });
                this._previousSizes.set(adjacentId, { width: resizedFrame.width, height: newAdjacentHeight, y: adjacentY });
            } else {
                adjacentWindow.move_frame(false, resizedFrame.x, workArea.y);
                adjacentWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newAdjacentHeight);
                
                const resizedY = workArea.y + newAdjacentHeight;
                window.move_frame(false, resizedFrame.x, resizedY);
                window.move_resize_frame(false, resizedFrame.x, resizedY, resizedFrame.width, resizedFrame.height);
                
                this._previousSizes.set(adjacentId, { width: resizedFrame.width, height: newAdjacentHeight, y: workArea.y });
                this._previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, y: resizedY });
            }
        } finally {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.ISRESIZING_FLAG_RESET_MS, () => {
                this._isResizing = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _resizeTiledPair(resizedWindow, adjacentWindow, workArea, zone) {
        const resizedId = resizedWindow.get_id();
        const adjacentId = adjacentWindow.get_id();
        const resizedFrame = resizedWindow.get_frame_rect();
        
        const previousState = this._previousSizes.get(resizedId);
        
        if (!previousState) {
            const adjacentFrame = adjacentWindow.get_frame_rect();
            this._previousSizes.set(resizedId, { width: resizedFrame.width, height: resizedFrame.height, x: resizedFrame.x });
            this._previousSizes.set(adjacentId, { width: adjacentFrame.width, height: resizedFrame.height, x: adjacentFrame.x });
            return;
        }
        
        const minWidth = 400;
        const maxResizedWidth = workArea.width - minWidth;
        
        if (resizedFrame.width > maxResizedWidth) return;
        
        const newAdjacentWidth = workArea.width - resizedFrame.width;
        
        this._isResizing = true;
        
        try {
            const isResizedLeft = (zone === TileZone.LEFT_FULL);
            
            if (isResizedLeft) {
                resizedWindow.move_frame(false, workArea.x, workArea.y);
                resizedWindow.move_resize_frame(false, workArea.x, workArea.y, resizedFrame.width, workArea.height);
                
                adjacentWindow.move_frame(false, workArea.x + resizedFrame.width, workArea.y);
                adjacentWindow.move_resize_frame(false, workArea.x + resizedFrame.width, workArea.y, newAdjacentWidth, workArea.height);
                
                this._previousSizes.set(resizedId, { width: resizedFrame.width, height: workArea.height, x: workArea.x });
                this._previousSizes.set(adjacentId, { width: newAdjacentWidth, height: workArea.height, x: workArea.x + resizedFrame.width });
            } else {
                adjacentWindow.move_frame(false, workArea.x, workArea.y);
                adjacentWindow.move_resize_frame(false, workArea.x, workArea.y, newAdjacentWidth, workArea.height);
                
                resizedWindow.move_frame(false, workArea.x + newAdjacentWidth, workArea.y);
                resizedWindow.move_resize_frame(false, workArea.x + newAdjacentWidth, workArea.y, resizedFrame.width, workArea.height);
                
                this._previousSizes.set(adjacentId, { width: newAdjacentWidth, height: workArea.height, x: workArea.x });
                this._previousSizes.set(resizedId, { width: resizedFrame.width, height: workArea.height, x: workArea.x + newAdjacentWidth });
            }
        } finally {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.ISRESIZING_FLAG_RESET_MS, () => {
                this._isResizing = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _handleResizeWithMosaic(window, workspace, monitor) {
        // During resize: just retile mosaic to use remaining space
        // The edge tile and mosaic "fight" for space dynamically
        // Constraint (min 400px for mosaic) is enforced in fixMosaicAfterEdgeResize on grab-op-end
        if (this._tilingManager) {
            Logger.log(`[MOSAIC WM] Edge-tiled window resizing - retiling mosaic to adapt`);
            this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
        }
    }

    _getAdjacentWindow(window, workspace, monitor, zone) {
        const edgeTiledWindows = this.getEdgeTiledWindows(workspace, monitor);
        const windowId = window.get_id();
        const targetZone = (zone === TileZone.LEFT_FULL) ? TileZone.RIGHT_FULL : TileZone.LEFT_FULL;
        const adjacent = edgeTiledWindows.find(w => w.window.get_id() !== windowId && w.zone === targetZone);
        return adjacent ? adjacent.window : null;
    }

    /**
     * Fix tiled pair sizes after resize ends
     * @param {Meta.Window} resizedWindow
     * @param {number} zone
     */
    fixTiledPairSizes(resizedWindow, zone) {
        const workspace = resizedWindow.get_workspace();
        const monitor = resizedWindow.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const adjacentWindow = this._getAdjacentWindow(resizedWindow, workspace, monitor, zone);
        
        if (!adjacentWindow) return;
        
        const resizedFrame = resizedWindow.get_frame_rect();
        const minWidth = 400;
        const impliedAdjacentWidth = workArea.width - resizedFrame.width;
        
        if (impliedAdjacentWidth < minWidth) {
            const newAdjacentWidth = minWidth;
            const newResizedWidth = workArea.width - newAdjacentWidth;
            
            this._isResizing = true;
            try {
                const isResizedLeft = (zone === TileZone.LEFT_FULL);
                if (isResizedLeft) {
                    resizedWindow.move_frame(false, workArea.x, workArea.y);
                    resizedWindow.move_resize_frame(false, workArea.x, workArea.y, newResizedWidth, workArea.height);
                    
                    adjacentWindow.move_frame(false, workArea.x + newResizedWidth, workArea.y);
                    adjacentWindow.move_resize_frame(false, workArea.x + newResizedWidth, workArea.y, newAdjacentWidth, workArea.height);
                } else {
                    adjacentWindow.move_frame(false, workArea.x, workArea.y);
                    adjacentWindow.move_resize_frame(false, workArea.x, workArea.y, newAdjacentWidth, workArea.height);
                    
                    resizedWindow.move_frame(false, workArea.x + newAdjacentWidth, workArea.y);
                    resizedWindow.move_resize_frame(false, workArea.x + newAdjacentWidth, workArea.y, newResizedWidth, workArea.height);
                }
            } finally {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        
        const adjacentFrame = adjacentWindow.get_frame_rect();
        const totalWidth = resizedFrame.width + adjacentFrame.width;
        
        if (totalWidth < workArea.width) {
            const gap = workArea.width - totalWidth;
            const newResizedWidth = resizedFrame.width + gap;
            
            this._isResizing = true;
            try {
                const isResizedLeft = (zone === TileZone.LEFT_FULL);
                if (isResizedLeft) {
                    resizedWindow.move_frame(false, workArea.x, workArea.y);
                    resizedWindow.move_resize_frame(false, workArea.x, workArea.y, newResizedWidth, workArea.height);
                    
                    adjacentWindow.move_frame(false, workArea.x + newResizedWidth, workArea.y);
                    adjacentWindow.move_resize_frame(false, workArea.x + newResizedWidth, workArea.y, adjacentFrame.width, workArea.height);
                } else {
                    adjacentWindow.move_frame(false, workArea.x, workArea.y);
                    adjacentWindow.move_resize_frame(false, workArea.x, workArea.y, adjacentFrame.width, workArea.height);
                    
                    resizedWindow.move_frame(false, workArea.x + adjacentFrame.width, workArea.y);
                    resizedWindow.move_resize_frame(false, workArea.x + adjacentFrame.width, workArea.y, newResizedWidth, workArea.height);
                }
            } finally {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    /**
     * Fix edge tile size and retile mosaic after resize ends (when no adjacent edge tile)
     * @param {Meta.Window} edgeTiledWindow
     * @param {number} zone
     */
    fixMosaicAfterEdgeResize(edgeTiledWindow, zone) {
        const workspace = edgeTiledWindow.get_workspace();
        const monitor = edgeTiledWindow.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const edgeFrame = edgeTiledWindow.get_frame_rect();
        
        // Get mosaic windows that need space
        const mosaicWindows = this.getNonEdgeTiledWindows(workspace, monitor);
        if (mosaicWindows.length === 0) {
            // No mosaic windows - MUST leave 400px free (User Request 1)
            const minFreeSpace = 400;
            const maxWidth = workArea.width - minFreeSpace;
            
            if (edgeFrame.width > maxWidth) {
                 this._isResizing = true;
                try {
                    const isLeft = (zone === TileZone.LEFT_FULL);
                    const x = isLeft ? workArea.x : (workArea.x + workArea.width - maxWidth);
                    edgeTiledWindow.move_resize_frame(false, x, workArea.y, maxWidth, workArea.height);
                } finally {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        this._isResizing = false;
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
            return;
        }
        
        // With mosaic windows: edge tile's max is workArea - actualMosaicWidth
        // "O tamanho maximo de um tiling pode chegar é o tamanho do mosaico"
        
        // Calculate actual mosaic bounds
        let mosaicMinX = Infinity;
        let mosaicMaxX = 0;
        for (const w of mosaicWindows) {
            const f = w.get_frame_rect();
            mosaicMinX = Math.min(mosaicMinX, f.x);
            mosaicMaxX = Math.max(mosaicMaxX, f.x + f.width);
        }
        const actualMosaicWidth = mosaicMaxX - mosaicMinX;
        
        // Edge tile max = workArea - actualMosaicWidth
        // This means edge tile cannot exceed the space NOT occupied by mosaic
        const isLeft = (zone === TileZone.LEFT_FULL);
        let maxEdgeWidth;
        
        if (isLeft) {
            // Left edge tile: max = mosaicMinX - workArea.x (space before mosaic)
            maxEdgeWidth = mosaicMinX - workArea.x;
        } else {
            // Right edge tile: max = (workArea.x + workArea.width) - mosaicMaxX (space after mosaic)
            maxEdgeWidth = (workArea.x + workArea.width) - mosaicMaxX;
        }
        
        // Use 400px as fallback if mosaic width is somehow 0
        if (maxEdgeWidth <= 0) {
            maxEdgeWidth = workArea.width - 400;
        }
        
        if (edgeFrame.width > maxEdgeWidth) {
            Logger.log(`[MOSAIC WM] Edge tile exceeds max (${edgeFrame.width} > ${maxEdgeWidth}) - constraining to mosaic boundary`);
            this._isResizing = true;
            try {
                if (isLeft) {
                    edgeTiledWindow.move_resize_frame(false, workArea.x, workArea.y, maxEdgeWidth, workArea.height);
                } else {
                    const newX = workArea.x + workArea.width - maxEdgeWidth;
                    edgeTiledWindow.move_resize_frame(false, newX, workArea.y, maxEdgeWidth, workArea.height);
                }
            } finally {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
        
        // Always retile mosaic to adapt to new available space
        if (this._tilingManager) {
            Logger.log(`[MOSAIC WM] Retiling mosaic after edge tile resize`);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }
    
    /**
     * Fix quarter tile pair sizes after vertical resize ends
     * @param {Meta.Window} resizedWindow
     * @param {number} zone
     */
    fixQuarterPairSizes(resizedWindow, zone) {
        const workspace = resizedWindow.get_workspace();
        const monitor = resizedWindow.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const adjacentZone = this._getAdjacentQuarterZone(zone);
        if (!adjacentZone) return;
        
        const adjacentWindow = this._findWindowInZone(adjacentZone, workspace);
        if (!adjacentWindow) return;
        
        const resizedFrame = resizedWindow.get_frame_rect();
        const adjacentFrame = adjacentWindow.get_frame_rect();
        const absoluteMinHeight = constants.ABSOLUTE_MIN_HEIGHT;
        const minHeight = Math.max(adjacentFrame.height, absoluteMinHeight);
        const impliedAdjacentHeight = workArea.height - resizedFrame.height;
        
        if (impliedAdjacentHeight < minHeight) {
            const newAdjacentHeight = minHeight;
            const newResizedHeight = workArea.height - newAdjacentHeight;
            
            this._isResizing = true;
            try {
                const isResizedTop = (zone === TileZone.TOP_LEFT || zone === TileZone.TOP_RIGHT);
                if (isResizedTop) {
                    resizedWindow.move_frame(false, resizedFrame.x, workArea.y);
                    resizedWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newResizedHeight);
                    
                    const adjacentY = workArea.y + newResizedHeight;
                    adjacentWindow.move_frame(false, resizedFrame.x, adjacentY);
                    adjacentWindow.move_resize_frame(false, resizedFrame.x, adjacentY, resizedFrame.width, newAdjacentHeight);
                } else {
                    adjacentWindow.move_frame(false, resizedFrame.x, workArea.y);
                    adjacentWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newAdjacentHeight);
                    
                    const resizedY = workArea.y + newAdjacentHeight;
                    resizedWindow.move_frame(false, resizedFrame.x, resizedY);
                    resizedWindow.move_resize_frame(false, resizedFrame.x, resizedY, resizedFrame.width, newResizedHeight);
                }
            } finally {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        
        const totalHeight = resizedFrame.height + adjacentFrame.height;
        
        if (totalHeight < workArea.height) {
            const gap = workArea.height - totalHeight;
            const newResizedHeight = resizedFrame.height + gap;
            
            this._isResizing = true;
            try {
                const isResizedTop = (zone === TileZone.TOP_LEFT || zone === TileZone.TOP_RIGHT);
                if (isResizedTop) {
                    resizedWindow.move_frame(false, resizedFrame.x, workArea.y);
                    resizedWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newResizedHeight);
                    
                    const adjacentY = workArea.y + newResizedHeight;
                    adjacentWindow.move_frame(false, resizedFrame.x, adjacentY);
                    adjacentWindow.move_resize_frame(false, resizedFrame.x, adjacentY, resizedFrame.width, adjacentFrame.height);
                } else {
                    adjacentWindow.move_frame(false, resizedFrame.x, workArea.y);
                    adjacentWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, adjacentFrame.height);
                    
                    const resizedY = workArea.y + adjacentFrame.height;
                    resizedWindow.move_frame(false, resizedFrame.x, resizedY);
                    resizedWindow.move_resize_frame(false, resizedFrame.x, resizedY, resizedFrame.width, newResizedHeight);
                }
            } finally {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }


    /**
     * Find window by ID across all workspaces
     * @private
     * @param {number} windowId - Window ID to find
     * @returns {Meta.Window|null}
     */
    _findWindowById(windowId) {
        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        return allWindows.find(w => w.get_id() === windowId) || null;
    }
}

/**
 * Check if a zone is a quarter zone
 * @param {number} zone - TileZone value
 * @returns {boolean}
 */
export function isQuarterZone(zone) {
    return zone === TileZone.TOP_LEFT || zone === TileZone.BOTTOM_LEFT ||
           zone === TileZone.TOP_RIGHT || zone === TileZone.BOTTOM_RIGHT;
}

