// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Window swapping logic

import * as Logger from './logger.js';
import { TileZone, ZONE_SIDE, ZONE_HALF, ZONE_VERTICAL_PAIR } from './constants.js';
import * as WindowState from './windowState.js';
import { monotonicNow } from './timing.js';

import GObject from 'gi://GObject';

// Which axis each direction travels on, and which way "closer" runs on it.
const DIRECTION_RULES = Object.freeze({
    left: { axis: 'x', sign: -1 },
    right: { axis: 'x', sign: 1 },
    up: { axis: 'y', sign: -1 },
    down: { axis: 'y', sign: 1 }
});

function centerOf(frame) {
    return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

// A horizontal move only counts windows sharing rows, a vertical one columns.
function overlapsOnCrossAxis(a, b, axis) {
    if (axis === 'x') return !(a.y + a.height <= b.y || b.y + b.height <= a.y);
    return !(a.x + a.width <= b.x || b.x + b.width <= a.x);
}

// Positive means the candidate really sits that way from the origin.
function signedDistance(origin, center, rule) {
    return (center[rule.axis] - origin[rule.axis]) * rule.sign;
}

export const SwappingManager = GObject.registerClass({
    GTypeName: 'MosaicSwappingManager',
}, class SwappingManager extends GObject.Object {
    _init() {
        super._init();
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

        Logger.log(`Finding neighbor for window ${window.get_id()} in direction: ${direction}`);

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
                Logger.log('Vertical swap only works for quarter tiles');
                return null;
            }
            return this._findVerticalQuarterNeighbor(zone, direction, workspace, monitor);
        }
        return this._findHorizontalNeighborFromTiling(window, zone, direction, workspace, monitor);
    }

    _findVerticalQuarterNeighbor(zone, _direction, workspace, monitor) {
        const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);

        const targetZone = ZONE_VERTICAL_PAIR[zone];
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
        if (direction !== 'left' && direction !== 'right') return null;

        const side = ZONE_SIDE[zone];
        const movingToOppositeSide = side && side !== direction;

        if (movingToOppositeSide) {
            return this._findOppositeSideNeighbor(window, zone, direction, workspace, monitor);
        } else {
            return this._findSameSideMosaicNeighbor(window, null, null, null, null);
        }
    }

    _findOppositeSideNeighbor(_window, sourceZone, targetSide, workspace, monitor) {
        const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        const isQuarter = this._edgeTilingManager.isQuarterZone(sourceZone);
        const sourceHalf = ZONE_HALF[sourceZone];

        const targetSideWindows = edgeTiledWindows.filter(w => {
            const state = this._edgeTilingManager.getWindowState(w.window);
            return state && ZONE_SIDE[state.zone] === targetSide;
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
                return sourceHalf && ZONE_HALF[state.zone] === sourceHalf;
            });

            if (matchingLevel) {
                const state = this._edgeTilingManager.getWindowState(matchingLevel.window);
                return { window: matchingLevel.window, zone: state.zone, type: 'tiling' };
            }
        }

        const targetWindow = targetSideWindows[0];
        const state = this._edgeTilingManager.getWindowState(targetWindow.window);
        return { window: targetWindow.window, zone: state.zone, type: 'tiling' };
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

    _findSameSideMosaicNeighbor(_window, _zone, _direction, _workspace, _monitor) {
        return null;
    }

    _findNeighborFromMosaic(window, direction, workspace, monitor) {
        if (!this._edgeTilingManager) return null;

        const mosaicWindows = this._edgeTilingManager.getNonEdgeTiledWindows(workspace, monitor);
        const mosaicNeighbor = this._findClosestMosaicInDirection(window, mosaicWindows, direction);
        if (mosaicNeighbor) return mosaicNeighbor;

        if (direction !== 'left' && direction !== 'right') return null;
        return this._findEdgeTileAcrossCenter(window, direction, workspace, monitor);
    }

    _findEdgeTileAcrossCenter(window, direction, workspace, monitor) {
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const centerX = workArea.x + workArea.width / 2;
        const windowCenterX = centerOf(window.get_frame_rect()).x;

        // Only reach for a tile once the move actually crosses the center; one sitting
        // on the same half as us isn't the neighbor in that direction.
        const crossesCenter = direction === 'left' ? windowCenterX > centerX : windowCenterX < centerX;
        if (!crossesCenter) return null;

        const tiles = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor).filter(w => {
            const state = this._edgeTilingManager.getWindowState(w.window);
            return state && ZONE_SIDE[state.zone] === direction;
        });
        if (tiles.length === 0) return null;

        const state = this._edgeTilingManager.getWindowState(tiles[0].window);
        return { window: tiles[0].window, zone: state.zone, type: 'tiling' };
    }

    _findClosestMosaicInDirection(window, mosaicWindows, direction) {
        const rule = DIRECTION_RULES[direction];
        if (!rule) return null;

        const windowFrame = window.get_frame_rect();
        const origin = centerOf(windowFrame);

        const candidates = mosaicWindows.filter(w => {
            if (w.get_id() === window.get_id()) return false;

            const frame = w.get_frame_rect();
            if (!overlapsOnCrossAxis(windowFrame, frame, rule.axis)) return false;

            return signedDistance(origin, centerOf(frame), rule) > 0;
        });

        if (candidates.length === 0) return null;

        let closest = candidates[0];
        let minDistance = Infinity;

        for (const candidate of candidates) {
            const distance = signedDistance(origin, centerOf(candidate.get_frame_rect()), rule);
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

        Logger.log(`Swapping window ${window.get_id()} in direction: ${direction}`);

        const windowState = this._edgeTilingManager.getWindowState(window);
        const isWindowTiled = windowState && windowState.zone !== TileZone.NONE;

        const neighbor = this.findNeighbor(window, direction, workspace, monitor);

        // A snapped (edge-tiled) neighbor in this direction wins, so only recompose the
        // mosaic when there isn't one. Recomposition is deterministic per press and moves
        // retarget mid-flight, so it skips the anti-oscillation throttle below.
        const snappedInDirection = neighbor && neighbor.type === 'tiling';
        if (!isWindowTiled && this._tilingManager && !snappedInDirection) {
            return this._recompose(window, direction, workspace, monitor);
        }

        // Hysteresis: prevent rapid oscillation of the neighbor swap below.
        const lastSwap = WindowState.get(window, 'lastSwapTime');
        if (lastSwap && (monotonicNow() - lastSwap) < 500) {
            Logger.log(`Swap throttled for window ${window.get_id()}`);
            return false;
        }

        if (!neighbor) {
            Logger.log('No neighbor found in direction:', direction);
            return false;
        }

        if (isWindowTiled) {
            return this._applySwapFromTiled(window, windowState.zone, neighbor, workspace, monitor);
        }
        return this._applySwapFromMosaic(window, neighbor, workspace, monitor);
    }

    _recompose(window, direction, workspace, monitor) {
        const best = this._tilingManager.bestRecomposition(workspace, monitor, window, direction);
        if (best) {
            this._tilingManager.pinComposition(workspace, best.shape, best.order);
            this._tilingManager.invalidateLayoutCache();
            this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            Logger.log(`Recomposed to [${best.shape.join(',')}] moving ${window.get_id()} ${direction}`);
            return true;
        }
        // Recompose is the whole mosaic keyboard action; if nothing moves that way, do
        // nothing rather than an order-swap that would leave the pinned shape stale.
        Logger.log(`No recomposition for ${window.get_id()} ${direction}`);
        return false;
    }

    _applySwapFromTiled(window, zone, neighbor, workspace, monitor) {
        switch (neighbor.type) {
            case 'mosaic':
                return this._swapTiledWithMosaic(window, zone, neighbor.window, workspace, monitor);
            case 'tiling':
                return this._swapTiledWindows(window, zone, neighbor.window, neighbor.zone, workspace, monitor);
            case 'empty_tiling_expand':
                if (!this._edgeTilingManager.isQuarterZone(zone)) return false;
                return this._markSwapped(window, this._expandQuarterToFull(window, zone, neighbor.zone, workspace, monitor));
            default:
                return false;
        }
    }

    _applySwapFromMosaic(window, neighbor, workspace, monitor) {
        switch (neighbor.type) {
            case 'mosaic':
                return this._swapMosaicWindows(window, neighbor.window, workspace, monitor);
            case 'tiling':
                return this._swapMosaicWithTiled(window, neighbor.window, neighbor.zone, workspace, monitor);
            case 'empty_tiling':
                return this._markSwapped(window, this._tileToEmptyZone(window, neighbor.zone, workspace, monitor));
            default:
                return false;
        }
    }

    // Only the paths that place the window into a zone stamp the throttle clock; a plain
    // swap leaves it alone, same as before.
    _markSwapped(window, success) {
        if (success) WindowState.set(window, 'lastSwapTime', monotonicNow());
        return success;
    }

    swapWindows(draggedWindow, targetWindow, targetZone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;

        Logger.log(`DnD Swap: ${draggedWindow.get_id()} → zone ${targetZone}`);

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

        Logger.log(`Swapping mosaic windows: ${window1.get_id()} ↔ ${window2.get_id()}`);

        const id1 = window1.get_id();
        const id2 = window2.get_id();

        this._tilingManager.setTmpSwap(id1, id2);
        this._tilingManager.applyTmpSwap(workspace);
        this._tilingManager.clearTmpSwap();
        this._tilingManager.invalidateLayoutCache();
        this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
        WindowState.set(window1, 'lastSwapTime', monotonicNow());
        WindowState.set(window2, 'lastSwapTime', monotonicNow());
        return true;
    }

    _swapMosaicWithTiled(mosaicWindow, tiledWindow, tiledZone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;

        Logger.log(`Swapping mosaic ${mosaicWindow.get_id()} with tiled ${tiledWindow.get_id()}`);

        this._edgeTilingManager.removeTile(tiledWindow);

        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(mosaicWindow, tiledZone, workArea, true);

        WindowState.set(mosaicWindow, 'lastSwapTime', monotonicNow());
        WindowState.set(tiledWindow, 'lastSwapTime', monotonicNow());
        return true;
    }

    _swapTiledWithMosaic(tiledWindow, tiledZone, mosaicWindow, workspace, monitor) {
        return this._swapMosaicWithTiled(mosaicWindow, tiledWindow, tiledZone, workspace, monitor);
    }

    _swapTiledWindows(window1, zone1, window2, zone2, workspace, monitor) {
        if (!this._edgeTilingManager) return false;

        Logger.log(`Swapping tiled windows: ${window1.get_id()} ↔ ${window2.get_id()}`);

        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(window1, zone2, workArea);
        this._edgeTilingManager.applyTile(window2, zone1, workArea);

        WindowState.set(window1, 'lastSwapTime', monotonicNow());
        WindowState.set(window2, 'lastSwapTime', monotonicNow());

        return true;
    }

    _tileToEmptyZone(window, zone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;

        Logger.log(`Tiling window ${window.get_id()} to empty zone ${zone}`);
        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(window, zone, workArea);
        WindowState.set(window, 'lastSwapTime', monotonicNow());
        return true;
    }

    _expandQuarterToFull(window, _currentZone, targetZone, workspace, monitor) {
        if (!this._edgeTilingManager) return false;

        Logger.log(`Expanding quarter tile ${window.get_id()} to ${targetZone}`);
        const workArea = workspace.get_work_area_for_monitor(monitor);
        this._edgeTilingManager.applyTile(window, targetZone, workArea);
        WindowState.set(window, 'lastSwapTime', monotonicNow());
        return true;
    }

    destroy() {
        this._tilingManager = null;
        this._edgeTilingManager = null;
    }
});
