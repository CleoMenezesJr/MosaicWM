// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Window position swapping with keyboard shortcuts

import * as Logger from './logger.js';
import { TileZone } from './edgeTiling.js';

export class SwappingManager {
    constructor() {
        this._tilingManager = null;
        this._edgeTilingManager = null;
    }

    setTilingManager(manager) {
        this._tilingManager = manager;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    findNeighbor(window, direction, workspace, monitor) {
        if (!this._edgeTilingManager) return null;
        
        const windowState = this._edgeTilingManager.getWindowState(window);
        const isWindowTiled = windowState && windowState.zone !== TileZone.NONE;
        
        Logger.log(`[MOSAIC WM] Finding neighbor for window ${window.get_id()} in direction: ${direction}`);
        
        if (isWindowTiled) {
            return this._findNeighborFromTiling(window, windowState.zone, direction, workspace, monitor);
        } else {
            return this._findNeighborFromMosaic(window, direction, workspace, monitor);
        }
    }

    _findNeighborFromTiling(window, zone, direction, workspace, monitor) {
        const isQuarter = this._edgeTilingManager.isQuarterZone(zone);
        
        if (direction === 'up' || direction === 'down') {
            if (!isQuarter) {
                Logger.log('[MOSAIC WM] Vertical swap only works for quarter tiles');
                return null;
            }
            return this._findVerticalQuarterNeighbor(zone, direction, workspace, monitor);
        }
        return this._findHorizontalNeighborFromTiling(window, zone, direction, workspace, monitor);
    }

    _findVerticalQuarterNeighbor(zone, direction, workspace, monitor) {
        const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        
        const verticalPairs = {
            [TileZone.TOP_LEFT]: TileZone.BOTTOM_LEFT,
            [TileZone.BOTTOM_LEFT]: TileZone.TOP_LEFT,
            [TileZone.TOP_RIGHT]: TileZone.BOTTOM_RIGHT,
            [TileZone.BOTTOM_RIGHT]: TileZone.TOP_RIGHT,
        };
        
        const targetZone = verticalPairs[zone];
        if (!targetZone) return null;
        
        const targetWindow = edgeTiledWindows.find(w => {
            const state = this._edgeTilingManager.getWindowState(w.window);
            return state && state.zone === targetZone;
        });
        
        if (targetWindow) {
            return { window: targetWindow.window, zone: targetZone, type: 'tiling' };
        }
        
        return { window: null, zone: targetZone, type: 'empty_tiling' };
    }

    _findHorizontalNeighborFromTiling(window, zone, direction, workspace, monitor) {
        const isLeft = zone === TileZone.LEFT_FULL || zone === TileZone.TOP_LEFT || zone === TileZone.BOTTOM_LEFT;
        const isRight = zone === TileZone.RIGHT_FULL || zone === TileZone.TOP_RIGHT || zone === TileZone.BOTTOM_RIGHT;
        
        let targetSide;
        if (direction === 'left') targetSide = 'left';
        else if (direction === 'right') targetSide = 'right';
        else return null;
        
        const movingToOppositeSide = (isLeft && targetSide === 'right') || (isRight && targetSide === 'left');
        
        if (movingToOppositeSide) {
            return this._findOppositeSideNeighbor(window, zone, targetSide, workspace, monitor);
        } else {
            return this._findSameSideMosaicNeighbor(window, zone, direction, workspace, monitor);
        }
    }

    _findOppositeSideNeighbor(window, sourceZone, targetSide, workspace, monitor) {
        const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        const isQuarter = this._edgeTilingManager.isQuarterZone(sourceZone);
        
        const isTop = sourceZone === TileZone.TOP_LEFT || sourceZone === TileZone.TOP_RIGHT;
        const isBottom = sourceZone === TileZone.BOTTOM_LEFT || sourceZone === TileZone.BOTTOM_RIGHT;
        
        const targetSideWindows = edgeTiledWindows.filter(w => {
            const state = this._edgeTilingManager.getWindowState(w.window);
            if (!state) return false;
            const z = state.zone;
            if (targetSide === 'left') {
                return z === TileZone.LEFT_FULL || z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT;
            } else {
                return z === TileZone.RIGHT_FULL || z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT;
            }
        });
        
        if (targetSideWindows.length === 0) {
            const mosaicNeighbor = this._findMosaicOnSide(targetSide, workspace, monitor);
            if (mosaicNeighbor) return mosaicNeighbor;
            
            if (isQuarter) {
                const targetZone = targetSide === 'left' ? TileZone.LEFT_FULL : TileZone.RIGHT_FULL;
                return { window: null, zone: targetZone, type: 'empty_tiling_expand' };
            } else {
                return null;
            }
        }
        
        if (isQuarter) {
            const matchingLevel = targetSideWindows.find(w => {
                const state = this._edgeTilingManager.getWindowState(w.window);
                if (isTop) {
                    return state.zone === (targetSide === 'left' ? TileZone.TOP_LEFT : TileZone.TOP_RIGHT);
                } else if (isBottom) {
                    return state.zone === (targetSide === 'left' ? TileZone.BOTTOM_LEFT : TileZone.BOTTOM_RIGHT);
                }
                return false;
            });
            
            if (matchingLevel) {
                const state = this._edgeTilingManager.getWindowState(matchingLevel.window);
                return { window: matchingLevel.window, zone: state.zone, type: 'tiling' };
            }
            
            const targetWindow = targetSideWindows[0];
            const state = this._edgeTilingManager.getWindowState(targetWindow.window);
            return { window: targetWindow.window, zone: state.zone, type: 'tiling' };
        } else {
            const targetWindow = targetSideWindows[0];
            const state = this._edgeTilingManager.getWindowState(targetWindow.window);
            return { window: targetWindow.window, zone: state.zone, type: 'tiling' };
        }
    }

    _findMosaicOnSide(side, workspace, monitor) {
        if (!this._edgeTilingManager) return null;
        
        const mosaicWindows = this._edgeTilingManager.getNonEdgeTiledWindows(workspace, monitor);
        if (mosaicWindows.length === 0) return null;
        
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const centerX = workArea.x + workArea.width / 2;
        
        const sideWindows = mosaicWindows.filter(w => {
            const frame = w.get_frame_rect();
            const windowCenterX = frame.x + frame.width / 2;
            if (side === 'left') return windowCenterX < centerX;
            else return windowCenterX >= centerX;
        });
        
        if (sideWindows.length > 0) {
            return { window: sideWindows[0], zone: null, type: 'mosaic' };
        }
        return null;
    }

    _findSameSideMosaicNeighbor(window, zone, direction, workspace, monitor) {
        return null;
    }

    _findNeighborFromMosaic(window, direction, workspace, monitor) {
        if (!this._edgeTilingManager) return null;
        
        const mosaicWindows = this._edgeTilingManager.getNonEdgeTiledWindows(workspace, monitor);
        const windowFrame = window.get_frame_rect();
        
        const mosaicNeighbor = this._findClosestMosaicInDirection(window, mosaicWindows, direction);
        if (mosaicNeighbor) return mosaicNeighbor;
        
        if (direction === 'left' || direction === 'right') {
            const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            const workArea = workspace.get_work_area_for_monitor(monitor);
            const centerX = workArea.x + workArea.width / 2;
            const windowCenterX = windowFrame.x + windowFrame.width / 2;
            
            if (direction === 'left' && windowCenterX > centerX) {
                const leftTiles = edgeTiledWindows.filter(w => {
                    const state = this._edgeTilingManager.getWindowState(w.window);
                    return state && (state.zone === TileZone.LEFT_FULL || state.zone === TileZone.TOP_LEFT || state.zone === TileZone.BOTTOM_LEFT);
                });
                if (leftTiles.length > 0) {
                    const state = this._edgeTilingManager.getWindowState(leftTiles[0].window);
                    return { window: leftTiles[0].window, zone: state.zone, type: 'tiling' };
                }
            } else if (direction === 'right' && windowCenterX < centerX) {
                const rightTiles = edgeTiledWindows.filter(w => {
                    const state = this._edgeTilingManager.getWindowState(w.window);
                    return state && (state.zone === TileZone.RIGHT_FULL || state.zone === TileZone.TOP_RIGHT || state.zone === TileZone.BOTTOM_RIGHT);
                });
                if (rightTiles.length > 0) {
                    const state = this._edgeTilingManager.getWindowState(rightTiles[0].window);
                    return { window: rightTiles[0].window, zone: state.zone, type: 'tiling' };
                }
            }
        }
        return null;
    }

    _findClosestMosaicInDirection(window, mosaicWindows, direction) {
        const windowFrame = window.get_frame_rect();
        const windowCenterX = windowFrame.x + windowFrame.width / 2;
        const windowCenterY = windowFrame.y + windowFrame.height / 2;
        
        let candidates = mosaicWindows.filter(w => {
            if (w.get_id() === window.get_id()) return false;
            
            const frame = w.get_frame_rect();
            const centerX = frame.x + frame.width / 2;
            const centerY = frame.y + frame.height / 2;
            
            if (direction === 'left' || direction === 'right') {
                const verticalOverlap = !(windowFrame.y + windowFrame.height <= frame.y || frame.y + frame.height <= windowFrame.y);
                if (!verticalOverlap) return false;
            }
            if (direction === 'up' || direction === 'down') {
                const horizontalOverlap = !(windowFrame.x + windowFrame.width <= frame.x || frame.x + frame.width <= windowFrame.x);
                if (!horizontalOverlap) return false;
            }
            
            switch (direction) {
                case 'left': return centerX < windowCenterX;
                case 'right': return centerX > windowCenterX;
                case 'up': return centerY < windowCenterY;
                case 'down': return centerY > windowCenterY;
                default: return false;
            }
        });
        
        if (candidates.length === 0) return null;
        
        let closest = candidates[0];
        let minDistance = Infinity;
        
        for (const candidate of candidates) {
            const frame = candidate.get_frame_rect();
            const centerX = frame.x + frame.width / 2;
            const centerY = frame.y + frame.height / 2;
            let distance = Infinity;
            
            switch (direction) {
                case 'left': distance = windowCenterX - centerX; break;
                case 'right': distance = centerX - windowCenterX; break;
                case 'up': distance = windowCenterY - centerY; break;
                case 'down': distance = centerY - windowCenterY; break;
            }
            
            if (distance < minDistance) {
                minDistance = distance;
                closest = candidate;
            }
        }
        
        return { window: closest, zone: null, type: 'mosaic' };
    }

    swapWindow(window, direction) {
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        
        Logger.log(`[MOSAIC WM] Swapping window ${window.get_id()} in direction: ${direction}`);
        
        const neighbor = this.findNeighbor(window, direction, workspace, monitor);
        if (!neighbor) {
            Logger.log('[MOSAIC WM] No neighbor found in direction:', direction);
            return false;
        }
        
        const windowState = this._edgeTilingManager.getWindowState(window);
        const isWindowTiled = windowState && windowState.zone !== TileZone.NONE;
        
        switch (neighbor.type) {
            case 'mosaic':
                if (isWindowTiled) {
                    return this._swapTiledWithMosaic(window, windowState.zone, neighbor.window, workspace, monitor);
                } else {
                    return this._swapMosaicWindows(window, neighbor.window, workspace, monitor);
                }
            case 'tiling':
                if (isWindowTiled) {
                    return this._swapTiledWindows(window, windowState.zone, neighbor.window, neighbor.zone, workspace, monitor);
                } else {
                    return this._swapMosaicWithTiled(window, neighbor.window, neighbor.zone, workspace, monitor);
                }
            case 'empty_tiling':
                if (isWindowTiled) {
                    return false;
                } else {
                    return this._tileToEmptyZone(window, neighbor.zone, workspace, monitor);
                }
            case 'empty_tiling_expand':
                if (isWindowTiled && this._edgeTilingManager.isQuarterZone(windowState.zone)) {
                    return this._expandQuarterToFull(window, windowState.zone, neighbor.zone, workspace, monitor);
                }
                return false;
            default:
                return false;
        }
    }

    swapWindows(draggedWindow, targetWindow, targetZone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;
        
        Logger.log(`[MOSAIC WM] DnD Swap: ${draggedWindow.get_id()} → zone ${targetZone}`);
        
        if (draggedWindow.get_id() === targetWindow.get_id()) return false;
        
        const draggedState = this._edgeTilingManager.getWindowState(draggedWindow);
        const isDraggedTiled = draggedState && draggedState.zone !== TileZone.NONE;
        
        if (isDraggedTiled) {
            return this._swapTiledWindows(draggedWindow, draggedState.zone, targetWindow, targetZone, workspace, monitor);
        } else {
            return this._swapMosaicWithTiled(draggedWindow, targetWindow, targetZone, workspace, monitor);
        }
    }

    _swapMosaicWindows(window1, window2, workspace, monitor) {
        if (!this._tilingManager) return false;
        
        Logger.log(`[MOSAIC WM] Swapping mosaic windows: ${window1.get_id()} ↔ ${window2.get_id()}`);
        
        const id1 = window1.get_id();
        const id2 = window2.get_id();
        
        this._tilingManager.setTmpSwap(id1, id2);
        this._tilingManager.applyTmpSwap(workspace);
        this._tilingManager.clearTmpSwap();
        
        this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
        return true;
    }

    _swapMosaicWithTiled(mosaicWindow, tiledWindow, tiledZone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;
        
        Logger.log(`[MOSAIC WM] Swapping mosaic ${mosaicWindow.get_id()} with tiled ${tiledWindow.get_id()}`);
        
        this._edgeTilingManager.removeTile(tiledWindow);
        
        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(mosaicWindow, tiledZone, workArea, true);
        
        return true;
    }

    _swapTiledWithMosaic(tiledWindow, tiledZone, mosaicWindow, workspace, monitor) {
        return this._swapMosaicWithTiled(mosaicWindow, tiledWindow, tiledZone, workspace, monitor);
    }

    _swapTiledWindows(window1, zone1, window2, zone2, workspace, monitor) {
        if (!this._edgeTilingManager) return false;
        
        Logger.log(`[MOSAIC WM] Swapping tiled windows: ${window1.get_id()} ↔ ${window2.get_id()}`);
        
        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(window1, zone2, workArea);
        this._edgeTilingManager.applyTile(window2, zone1, workArea);
        
        return true;
    }

    _tileToEmptyZone(window, zone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;
        
        Logger.log(`[MOSAIC WM] Tiling window ${window.get_id()} to empty zone ${zone}`);
        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(window, zone, workArea);
        return true;
    }

    _expandQuarterToFull(window, currentZone, targetZone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;
        
        Logger.log(`[MOSAIC WM] Expanding quarter tile ${window.get_id()} to ${targetZone}`);
        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(window, targetZone, workArea);
        return true;
    }

    destroy() {
        this._tilingManager = null;
        this._edgeTilingManager = null;
    }
}
