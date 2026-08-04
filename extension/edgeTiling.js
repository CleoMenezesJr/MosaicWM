// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Edge tiling (snap to screen edges) functionality

import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as constants from './constants.js';
import { TileZone, ZONE_SIDE, ZONE_HALF, ZONE_VERTICAL_PAIR, SIDE_ZONES } from './constants.js';
import * as WindowState from './windowState.js';
import { IS_MINIATURE, ANIMATING_MINIATURE, MINIATURE_ANIM_KIND } from './windowState.js';
import { getMiniatureSize } from './miniature.js';
import { monotonicNow } from './timing.js';

import GObject from 'gi://GObject';

export const EdgeTilingManager = GObject.registerClass({
    GTypeName: 'MosaicEdgeTilingManager',
    Signals: {
        'edge-tiling-changed': { param_types: [GObject.TYPE_OBJECT, GObject.TYPE_INT] }, // (window, zone)
    },
}, class EdgeTilingManager extends GObject.Object {
    _init() {
        super._init();
        this._isEdgeTilingActive = false;
        this._activeEdgeTilingWindow = null;
        this._isResizing = false;
        this._animationsManager = null;
        this._tilingManager = null;
        this._windowingManager = null;
        this._miniatureManager = null;
        this._timeoutRegistry = null;
        this._lastRemoveTileAt = null;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    isEdgeTilingActive() {
        return this._isEdgeTilingActive;
    }

    getActiveEdgeTilingWindow() {
        return this._activeEdgeTilingWindow;
    }

    setEdgeTilingActive(active, window = null) {
        Logger.log(`Edge tiling state: ${this._isEdgeTilingActive} -> ${active}, window: ${window ? window.get_id() : 'null'}`);
        this._isEdgeTilingActive = active;
        this._activeEdgeTilingWindow = window;
    }

    clearAllStates() {
        // Disconnect resize listeners from all known windows
        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        for (const window of allWindows) {
            const signalId = WindowState.get(window, 'edgeResizeSignalId');
            if (signalId) {
                try {
                    window.disconnect(signalId);
                } catch (_e) {
                    // Ignore if window destroyed
                }
                WindowState.remove(window, 'edgeResizeSignalId');
            }
            // Clear other states
            WindowState.remove(window, 'edgeTilingState');
            WindowState.remove(window, 'edgePreviousSize');
        }

        this._isResizing = false;
        this._isEdgeTilingActive = false;
        this._activeEdgeTilingWindow = null;
    }

    destroy() {
        this.clearAllStates();
        this._animationsManager = null;
        this._tilingManager = null;
        this._windowingManager = null;
        this._miniatureManager = null;
        this._timeoutRegistry = null;
    }

    // Windows that can hold a zone here; hidden and non-normal ones never tile.
    _tileableWindows(workspace, monitor, exclude = null) {
        return workspace.list_windows().filter(w =>
            w.get_monitor() === monitor &&
            !w.is_hidden() &&
            w.get_window_type() === Meta.WindowType.NORMAL &&
            w.get_id() !== exclude?.get_id()
        );
    }

    // cachedEdgeTiledIds is ignored in WeakMap implementation
    _hasEdgeTiledWindowsOnSide(workspace, side, _cachedEdgeTiledIds = null) {
        if (!workspace) return false;

        // Iterating WeakMap is not possible in GJS, so query workspace windows instead
        // This is robust but slightly more expensive than a Map lookup
        return workspace.list_windows().some(win => {
            const state = WindowState.get(win, 'edgeTilingState');
            return state && ZONE_SIDE[state.zone] === side;
        });
    }

    // _cachedEdgeTiledIds: optional array of window IDs to avoid list_windows() call
    detectZone(cursorX, cursorY, workArea, workspace, cachedEdgeTiledIds = null) {
        const threshold = constants.EDGE_TILING_THRESHOLD;

        // Check TOP edge first (maximize)
        if (cursorY < workArea.y + threshold) {
            return TileZone.FULLSCREEN;
        }

        if (cursorX < workArea.x + threshold) {
            return this._sideZone('left', cursorY, workArea, workspace, cachedEdgeTiledIds);
        }
        if (cursorX > workArea.x + workArea.width - threshold) {
            return this._sideZone('right', cursorY, workArea, workspace, cachedEdgeTiledIds);
        }
        return TileZone.NONE;
    }

    // A side only offers quarters once something is tiled there; on an empty side the
    // whole edge reads as the full half, wherever vertically the cursor sits.
    _sideZone(side, cursorY, workArea, workspace, cachedEdgeTiledIds) {
        const zones = SIDE_ZONES[side];
        if (!this._hasEdgeTiledWindowsOnSide(workspace, side, cachedEdgeTiledIds)) return zones.full;

        const thirdY = workArea.height / 3;
        const relY = cursorY - workArea.y;
        if (relY < thirdY) return zones.top;
        if (relY > workArea.height - thirdY) return zones.bottom;
        return zones.full;
    }

    // Same question _sideZone answers for the pointer, minus the cursor: with no Y to read,
    // the side's own occupancy picks the zone. Excluding the window matters because one
    // maximized off a tile still carries that tile's zone in its state.
    keyboardZoneForSide(side, workspace, monitor, excludeWindow) {
        const occupied = this._tileableWindows(workspace, monitor, excludeWindow)
            .map(w => this.getWindowState(w)?.zone)
            .filter(zone => zone && ZONE_SIDE[zone] === side);

        if (occupied.length === 0) return SIDE_ZONES[side].full;
        if (occupied.length > 1) return null;

        // A lone quarter leaves its pair free; a full tile gets split, and the newcomer
        // taking the bottom is what pushes the sitting one into the top.
        return ZONE_VERTICAL_PAIR[occupied[0]] ?? SIDE_ZONES[side].bottom;
    }

    _getExistingSideWidth(workspace, monitor, side) {
        if (!workspace || monitor === undefined) return null;

        const existing = this._tileableWindows(workspace, monitor).find(w => {
            const state = this.getWindowState(w);
            return state && ZONE_SIDE[state.zone] === side;
        });

        return existing ? existing.get_frame_rect().width : null;
    }

    _getExistingQuarterHeight(workspace, monitor, zone) {
        if (!workspace || monitor === undefined) return null;

        const existing = this._tileableWindows(workspace, monitor).find(w => {
            const state = this.getWindowState(w);
            return state && state.zone === zone;
        });

        return existing ? existing.get_frame_rect().height : null;
    }

    getZoneRect(zone, workArea, windowToTile = null) {
        if (!workArea) return null;

        if (zone === TileZone.FULLSCREEN) {
            return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
        }
        if (ZONE_HALF[zone]) {
            return this._quarterRect(zone, workArea, windowToTile);
        }
        if (zone === TileZone.LEFT_FULL || zone === TileZone.RIGHT_FULL) {
            return this._fullSideRect(zone, workArea, windowToTile);
        }
        return null;
    }

    // Width the partner across the split already occupies, so we claim only the rest.
    _oppositeFullWidth(zone, windowToTile) {
        if (!windowToTile) return null;

        const oppositeZone = zone === TileZone.LEFT_FULL ? TileZone.RIGHT_FULL : TileZone.LEFT_FULL;
        const candidates = this._tileableWindows(windowToTile.get_workspace(), windowToTile.get_monitor(), windowToTile);

        const existingWindow = candidates.find(w => {
            const state = this.getWindowState(w);
            return state && state.zone === oppositeZone;
        });
        if (!existingWindow) return null;

        // Mid-animation the frame is a transient size; the ease target is the width it will
        // settle at, so a freshly auto-tiled partner splits 50/50 instead of chasing the blur.
        const animTarget = this._animationsManager?.getAnimatingTarget(existingWindow.get_id());
        const width = animTarget?.width ?? existingWindow.get_frame_rect().width;
        Logger.log(`getZoneRect: Found existing tiled window with width ${width}px`);
        return width;
    }

    _fullSideRect(zone, workArea, windowToTile) {
        const halfWidth = Math.floor(workArea.width / 2);
        const existingWidth = this._oppositeFullWidth(zone, windowToTile);
        const width = existingWidth ? (workArea.width - existingWidth) : halfWidth;

        if (zone === TileZone.LEFT_FULL) {
            return { x: workArea.x, y: workArea.y, width, height: workArea.height };
        }
        return {
            x: existingWidth ? (workArea.x + existingWidth) : (workArea.x + halfWidth),
            y: workArea.y,
            width: existingWidth ? (workArea.width - existingWidth) : (workArea.width - halfWidth),
            height: workArea.height
        };
    }

    _quarterRect(zone, workArea, windowToTile) {
        const workspace = windowToTile?.get_workspace();
        const monitor = windowToTile?.get_monitor();
        const halfWidth = Math.floor(workArea.width / 2);
        const halfHeight = Math.floor(workArea.height / 2);

        const side = ZONE_SIDE[zone];
        const width = this._getExistingSideWidth(workspace, monitor, side) || halfWidth;
        const x = side === 'left' ? workArea.x : workArea.x + workArea.width - width;

        // The quarter stacked against us already picked its height; we take what's left.
        const stackedHeight = this._getExistingQuarterHeight(workspace, monitor, ZONE_VERTICAL_PAIR[zone]);

        if (ZONE_HALF[zone] === 'top') {
            return {
                x,
                y: workArea.y,
                width,
                height: stackedHeight ? (workArea.height - stackedHeight) : halfHeight
            };
        }
        return {
            x,
            y: stackedHeight ? (workArea.y + stackedHeight) : (workArea.y + halfHeight),
            width,
            height: stackedHeight ? (workArea.height - stackedHeight) : (workArea.height - halfHeight)
        };
    }

    saveWindowState(window) {
        const winId = window.get_id();
        const existingState = WindowState.get(window, 'edgeTilingState');

        if (existingState) {
            Logger.log(`Window ${winId} already has saved state (${existingState.width}x${existingState.height}), preserving it`);
            return;
        }

        const frame = window.get_frame_rect();
        WindowState.set(window, 'edgeTilingState', {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            zone: TileZone.NONE
        });
        Logger.log(`Saved window ${winId} PRE-TILING state: ${frame.width}x${frame.height}`);
    }

    getWindowState(window) {
        return WindowState.get(window, 'edgeTilingState');
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
        if (!workspace || monitor === undefined || monitor === null || monitor < 0) {
            Logger.log(`calculateRemainingSpace: Invalid inputs (ws=${workspace}, mon=${monitor})`);
            return null;
        }

        // Validation for monitor index
        const nMonitors = global.display.get_n_monitors();
        if (monitor >= nMonitors) {
            Logger.log(`calculateRemainingSpace: Monitor index ${monitor} out of bounds (${nMonitors})`);
            return null;
        }

        const workArea = workspace.get_work_area_for_monitor(monitor);
        const edgeTiledWindows = this.getEdgeTiledWindows(workspace, monitor);

        if (edgeTiledWindows.length === 0) return workArea;

        // Tiles on the left push the free space rightwards, tiles on the right cap it.
        // Left keeps priority when both sides are occupied.
        const leftTiles = edgeTiledWindows.filter(w => ZONE_SIDE[w.zone] === 'left');
        if (leftTiles.length > 0) {
            const maxRight = leftTiles.reduce((acc, w) => {
                const rect = w.window.get_frame_rect();
                return Math.max(acc, rect.x + rect.width);
            }, workArea.x);

            return {
                x: maxRight,
                y: workArea.y,
                width: (workArea.x + workArea.width) - maxRight,
                height: workArea.height
            };
        }

        const rightTiles = edgeTiledWindows.filter(w => ZONE_SIDE[w.zone] === 'right');
        if (rightTiles.length > 0) {
            const minLeft = rightTiles.reduce(
                (acc, w) => Math.min(acc, w.window.get_frame_rect().x),
                workArea.x + workArea.width
            );

            return {
                x: workArea.x,
                y: workArea.y,
                width: minLeft - workArea.x,
                height: workArea.height
            };
        }

        return workArea;
    }

    // Snapping a quarter onto a side that already holds a full tile splits that side, so the
    // sitting tile gets pushed into the quarter stacked against the incoming one.
    _planFullToQuarterConversion(window, zone, workspace, monitor) {
        const side = ZONE_SIDE[zone];
        if (!side || !ZONE_HALF[zone]) return null;

        const fullZone = SIDE_ZONES[side].full;
        const fullWindow = this._tileableWindows(workspace, monitor, window).find(w => {
            const state = this.getWindowState(w);
            return state && state.zone === fullZone;
        });

        if (!fullWindow) {
            Logger.log(`No ${side} full window found for conversion`);
            return null;
        }

        Logger.log(`Found ${side} full window ${fullWindow.get_id()} for conversion`);
        return { window: fullWindow, newZone: ZONE_VERTICAL_PAIR[zone] };
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
        const state = WindowState.get(window, 'edgeTilingState');

        // If this was a quarter tile, expand the adjacent quarter to FULL
        if (state && state.zone && this._isQuarterZone(state.zone)) {
            Logger.log(`Quarter tile ${winId} being removed from zone ${state.zone}`);

            const adjacentZone = this._getAdjacentQuarterZone(state.zone);
            if (adjacentZone) {
                const adjacentWindow = this._findWindowInZone(adjacentZone, window.get_workspace());

                if (adjacentWindow) {
                    Logger.log(`Found adjacent quarter ${adjacentWindow.get_id()} in zone ${adjacentZone}, expanding to FULL`);

                    const fullZone = this._getFullZoneFromQuarter(state.zone);
                    const workspace = window.get_workspace();
                    const monitor = window.get_monitor();
                    const workArea = workspace.get_work_area_for_monitor(monitor);
                    const fullRect = this.getZoneRect(fullZone, workArea, adjacentWindow);

                    if (fullRect) {
                        adjacentWindow.move_resize_frame(false, fullRect.x, fullRect.y, fullRect.width, fullRect.height);

                        const adjacentState = WindowState.get(adjacentWindow, 'edgeTilingState');
                        if (adjacentState) adjacentState.zone = fullZone;

                        Logger.log(`Expanded quarter to ${fullZone}: ${fullRect.width}x${fullRect.height}`);
                    }
                }
            }
        }

        // autoTileMaster/autoTileDependents are cleaned up in removeTile;
        // this path only needs to drop the tiling state itself.
        WindowState.remove(window, 'edgeTilingState');
    }

    registerAutoTileDependency(dependentWindow, masterWindow) {
        WindowState.set(dependentWindow, 'autoTileMaster', masterWindow);

        let dependents = WindowState.get(masterWindow, 'autoTileDependents');
        if (!dependents) {
            dependents = new Set();
            WindowState.set(masterWindow, 'autoTileDependents', dependents);
        }
        dependents.add(dependentWindow);

        Logger.log(`Registered auto-tile dependency: ${dependentWindow.get_id()} depends on ${masterWindow.get_id()}`);
    }

    isEdgeTiled(window) {
        if (!window) return false;
        const state = WindowState.get(window, 'edgeTilingState');
        return state && state.zone !== TileZone.NONE;
    }

    // The whole keyboard contract, top to bottom. Maximized is answered before the zone is
    // even read, since a window maximized off a tile keeps that tile's zone in its state.
    resolveArrowIntent(window, direction) {
        const zone = this.getWindowState(window)?.zone ?? TileZone.NONE;

        if (window.is_maximized()) {
            if (direction === 'up') return { kind: 'none' };
            if (direction === 'down') return { kind: 'restore' };
            return this._keyboardTileIntent(window, direction);
        }

        return direction === 'up' || direction === 'down'
            ? this._verticalArrowIntent(window, zone, direction)
            : this._horizontalArrowIntent(window, zone, direction);
    }

    _horizontalArrowIntent(window, zone, direction) {
        if (ZONE_SIDE[zone] === direction) return { kind: 'none' };
        if (zone !== TileZone.NONE) return { kind: 'restore' };
        return this._keyboardTileIntent(window, direction);
    }

    // With no pair to trade with, up maximizes instead of climbing to the top half.
    _verticalArrowIntent(window, zone, direction) {
        const half = ZONE_HALF[zone];
        if (this._hasVerticalPair(window, zone) &&
            ((half === 'top' && direction === 'down') || (half === 'bottom' && direction === 'up')))
            return { kind: 'swap', direction };

        if (direction === 'up') return { kind: 'maximize' };
        return zone === TileZone.NONE ? { kind: 'none' } : { kind: 'restore' };
    }

    _keyboardTileIntent(window, side) {
        const zone = this.keyboardZoneForSide(
            side, window.get_workspace(), window.get_monitor(), window);
        return zone ? { kind: 'tile', zone } : { kind: 'none' };
    }

    _hasVerticalPair(window, zone) {
        const pair = ZONE_VERTICAL_PAIR[zone];
        return pair ? !!this._findWindowInZone(pair, window.get_workspace()) : false;
    }

    // Can this window be resized to fill a zone? A max-size cap below the zone means it can't,
    // so such a window stays in the mosaic (miniaturized) instead of being paired as a half-tile.
    isEdgeTileable(window, zoneRect) {
        if (!this._canResize(window)) return false;
        if (zoneRect && window.get_max_size) {
            const [hasMax, maxW, maxH] = window.get_max_size();
            if (hasMax && maxW > 0 && maxH > 0 && (maxW < zoneRect.width || maxH < zoneRect.height))
                return false;
        }
        return true;
    }

    // Edge tiling and miniaturization are exclusive. Leave the actor's transform alone though, since
    // animateWindow eases from it, and the stale anim keys would make it skip the scale ease.
    _dropMiniature(window) {
        if (!this._miniatureManager || !WindowState.get(window, IS_MINIATURE)) return;
        this._miniatureManager.destroyMiniature(window);
        WindowState.remove(window, ANIMATING_MINIATURE);
        WindowState.remove(window, MINIATURE_ANIM_KIND);
    }

    checkQuarterExpansion(workspace, monitor) {
        const edgeTiledWindows = this.getEdgeTiledWindows(workspace, monitor);
        if (edgeTiledWindows.length === 0) return;

        const workArea = workspace.get_work_area_for_monitor(monitor);

        const leftQuarters = edgeTiledWindows.filter(w =>
            w.zone === TileZone.TOP_LEFT || w.zone === TileZone.BOTTOM_LEFT
        );

        if (leftQuarters.length === 1) {
            const window = leftQuarters[0].window;
            Logger.log('Single quarter on left - expanding to LEFT_FULL');

            const state = WindowState.get(window, 'edgeTilingState');
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

        const rightQuarters = edgeTiledWindows.filter(w =>
            w.zone === TileZone.TOP_RIGHT || w.zone === TileZone.BOTTOM_RIGHT
        );

        if (rightQuarters.length === 1) {
            const window = rightQuarters[0].window;
            Logger.log('Single quarter on right - expanding to RIGHT_FULL');

            const state = WindowState.get(window, 'edgeTilingState');
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

    _isQuarterZone(zone) {
        return zone === TileZone.TOP_LEFT || zone === TileZone.BOTTOM_LEFT ||
               zone === TileZone.TOP_RIGHT || zone === TileZone.BOTTOM_RIGHT;
    }

    isQuarterZone(zone) {
        return this._isQuarterZone(zone);
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
            const state = WindowState.get(win, 'edgeTilingState');
            if (state && state.zone === zone) return win;
        }
        return null;
    }

    setTilingManager(tilingManager) {
        this._tilingManager = tilingManager;
    }

    setWindowingManager(windowingManager) {
        this._windowingManager = windowingManager;
    }

    setMiniatureManager(miniatureManager) {
        this._miniatureManager = miniatureManager;
    }

    _canResize(window, _targetWidth, _targetHeight, aboutToUnmaximize = false) {
        if (window.window_type !== 0) { // Meta.WindowType.NORMAL
            Logger.log(`Window type ${window.window_type} is not suitable for edge tiling`);
            return false;
        }

        // allows_resize() folds in the current maximized state, so it vetoes a window
        // applyTile is about to unmaximize. resizeable is the same hint minus that state.
        if (aboutToUnmaximize && window.is_maximized()) {
            if (!window.resizeable) {
                Logger.log('Window does not allow resize');
                return false;
            }
            return true;
        }

        if (window.allows_resize && !window.allows_resize()) {
            Logger.log('Window does not allow resize');
            return false;
        }
        return true;
    }

    applyTile(window, zone, workArea, skipOverflowCheck = false) {
        this.saveWindowState(window);

        const winId = window.get_id();

        const oldMaster = WindowState.get(window, 'autoTileMaster');
        if (oldMaster) {
            Logger.log(`Manual retile breaks auto-tile dependency for ${winId}`);
            const deps = WindowState.get(oldMaster, 'autoTileDependents');
            if (deps) deps.delete(window);
            WindowState.remove(window, 'autoTileMaster');
        }

        if (zone === TileZone.FULLSCREEN) {
            window.maximize();
            const state = WindowState.get(window, 'edgeTilingState');
            if (state) state.zone = zone;
            Logger.log(`Maximized window ${window.get_id()}`);
            this.emit('edge-tiling-changed', window, zone);
            return true;
        }

        const rect = this.getZoneRect(zone, workArea, window);
        if (!rect) {
            Logger.log(`Invalid zone ${zone}`);
            return false;
        }

        if (!this._canResize(window, rect.width, rect.height, true)) return false;

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const fullToQuarterConversion = this._planFullToQuarterConversion(window, zone, workspace, monitor);

        let savedFullTileWidth = null;
        if (fullToQuarterConversion) {
            const fullFrame = fullToQuarterConversion.window.get_frame_rect();
            savedFullTileWidth = fullFrame.width;
            Logger.log(`Converting FULL tile ${fullToQuarterConversion.window.get_id()} to quarter zone ${fullToQuarterConversion.newZone}, preserving width=${savedFullTileWidth}px`);
        }

        window.unmaximize();

        this._timeoutRegistry.addIdle(() => {
            this._dropMiniature(window);
            // The zone dictates this window's frame now, so a leftover smart-resize target would
            // only make the clamp detector learn a false minimum against it.
            WindowState.remove(window, 'targetSmartResizeSize');

            this._placeTiledWindow(window, rect);
            this.setupResizeListener(window);

            const state = WindowState.get(window, 'edgeTilingState');
            if (state) state.zone = zone;

            Logger.log(`Applied edge tile zone ${zone} to window ${winId}`);

            if (fullToQuarterConversion && savedFullTileWidth) {
                this._splitSideIntoQuarters(window, zone, rect, workArea, workspace, monitor,
                    fullToQuarterConversion, savedFullTileWidth);
            }

            // Handle mosaic windows that can't fit in remaining space
            if (!skipOverflowCheck) {
                const remSpace = this.calculateRemainingSpace(
                    window.get_workspace(), window.get_monitor());
                this._handleMosaicOverflow(window, zone, remSpace);
            }
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    _placeTiledWindow(window, rect) {
        if (this._animationsManager) {
            this._animationsManager.animateWindow(window, rect, { subtle: true });
            return;
        }

        // Nobody eases the leftover miniature transform away here, so clear it by hand.
        const actor = window.get_compositor_private();
        if (actor) {
            actor.remove_all_transitions();
            actor.set_scale(1, 1);
            actor.set_translation(0, 0, 0);
        }
        window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
    }

    // The sitting full tile keeps its width so the split lands where the user had already
    // dragged the divider, instead of snapping both quarters back to 50/50.
    _splitSideIntoQuarters(window, zone, rect, workArea, workspace, monitor, conversion, savedFullTileWidth) {
        const convertedRect = this.getZoneRect(conversion.newZone, workArea, conversion.window);

        convertedRect.width = savedFullTileWidth;
        rect.width = savedFullTileWidth;

        const x = ZONE_SIDE[conversion.newZone] === 'left'
            ? workArea.x
            : workArea.x + workArea.width - savedFullTileWidth;
        convertedRect.x = x;
        rect.x = x;

        const halfHeight = Math.floor(workArea.height / 2);

        if (this._animationsManager) {
            this._animationsManager.animateWindow(conversion.window, {
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
            conversion.window.move_resize_frame(false, convertedRect.x, convertedRect.y, convertedRect.width, halfHeight);
            window.move_resize_frame(false, rect.x, rect.y, rect.width, halfHeight);
        }

        Logger.log(`Applied quarter tiles with halfHeight=${halfHeight}px, width=${savedFullTileWidth}px`);

        const convertedState = WindowState.get(conversion.window, 'edgeTilingState');
        if (convertedState) {
            Logger.log(`Converted window original state: ${convertedState.width}x${convertedState.height} (preserving for restore)`);
            convertedState.zone = conversion.newZone;
        }

        this.emit('edge-tiling-changed', window, zone);
        this.emit('edge-tiling-changed', conversion.window, conversion.newZone);

        this._settleQuarterHeights(window, zone, rect, convertedRect, workArea, workspace, monitor, conversion, halfHeight);
    }

    // An app can refuse the halved height. Whoever won that argument dictates where the
    // other one starts, so the pair still covers the side with no gap between them.
    _settleQuarterHeights(window, zone, rect, convertedRect, workArea, workspace, monitor, conversion, halfHeight) {
        this._timeoutRegistry.add(constants.POLL_INTERVAL_MS, () => {
            if (!window.get_compositor_private() ||
                !conversion.window.get_compositor_private()) {
                return GLib.SOURCE_REMOVE;
            }

            const actualConvertedFrame = conversion.window.get_frame_rect();
            const actualNewFrame = window.get_frame_rect();

            if (actualConvertedFrame.height !== halfHeight || actualNewFrame.height !== halfHeight) {
                this._realignQuarterPair(window, zone, rect, convertedRect, workArea, conversion,
                    actualNewFrame, actualConvertedFrame, halfHeight);
            }

            if (this._tilingManager) {
                this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _realignQuarterPair(window, zone, rect, convertedRect, workArea, conversion, actualNewFrame, actualConvertedFrame, halfHeight) {
        if (ZONE_HALF[zone] === 'bottom') {
            if (actualNewFrame.height > halfHeight) {
                const topHeight = workArea.height - actualNewFrame.height;
                const bottomY = workArea.y + topHeight;
                conversion.window.move_resize_frame(false, convertedRect.x, workArea.y, convertedRect.width, topHeight);
                window.move_resize_frame(false, rect.x, bottomY, rect.width, actualNewFrame.height);
            } else {
                const bottomY = actualConvertedFrame.y + actualConvertedFrame.height;
                const bottomHeight = (workArea.y + workArea.height) - bottomY;
                window.move_resize_frame(false, rect.x, bottomY, rect.width, bottomHeight);
            }
            return;
        }

        if (actualNewFrame.height > halfHeight) {
            const bottomHeight = workArea.height - actualNewFrame.height;
            const bottomY = workArea.y + actualNewFrame.height;
            conversion.window.move_resize_frame(false, convertedRect.x, bottomY, convertedRect.width, bottomHeight);
        } else {
            const bottomY = actualNewFrame.y + actualNewFrame.height;
            const bottomHeight = (workArea.y + workArea.height) - bottomY;
            conversion.window.move_resize_frame(false, convertedRect.x, bottomY, convertedRect.width, bottomHeight);
        }
    }

    removeTile(window, callback = null, placeAtCursor = false) {
        const winId = window.get_id();
        const savedState = WindowState.get(window, 'edgeTilingState');

        if (!savedState || savedState.zone === TileZone.NONE) {
            Logger.log(`removeTile: Window ${winId} is not edge-tiled`);
            if (callback) callback();
            return;
        }

        Logger.log(`removeTile: Removing tile from window ${winId}, zone=${savedState.zone}`);
        Logger.log(`removeTile: Saved state to restore: ${savedState.width}x${savedState.height} at (${savedState.x}, ${savedState.y})`);

        // Stamped here, not in a per-caller flag, so mouse drag, keyboard shortcut and
        // auto-tile dependent cleanup all suppress the same settled-resize ejection window.
        this._lastRemoveTileAt = monotonicNow();

        this._removeResizeListener(window);

        const savedWidth = savedState.width;
        const savedHeight = savedState.height;
        const savedZone = savedState.zone;

        // Drop the whole state, not just the zone: a leftover width/height would make the
        // next saveWindowState preserve it and freeze the restore size for the window's life.
        WindowState.remove(window, 'edgeTilingState');

        // Back to a normal window: restore the pre-tiling preferred size and drop any mosaic-learned minimum.
        WindowState.set(window, 'preferredSize', { width: savedWidth, height: savedHeight });
        // The layout reads this before the frame, so the size survives a retile landing before the frame settles.
        WindowState.set(window, 'targetRestoredSize', { width: savedWidth, height: savedHeight });
        WindowState.remove(window, 'actualMinWidth');
        WindowState.remove(window, 'actualMinHeight');
        WindowState.remove(window, 'targetSmartResizeSize');
        WindowState.set(window, 'isConstrainedByMosaic', false);

        this._releaseAutoTileLinks(window);

        if (this._isQuarterZone(savedZone)) {
            this._expandAdjacentQuarterToFull(window, savedZone);
        }

        if (window.is_maximized()) {
            window.unmaximize();
        }

        this._restoreFrameAfterUntile(window, savedWidth, savedHeight, placeAtCursor);

        if (callback) {
            this._timeoutRegistry.add(constants.RETILE_DELAY_MS, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }, 'edgeTiling_removeTileCallback');
        }

        this._timeoutRegistry.add(constants.RETILE_DELAY_MS + constants.RESIZE_SETTLE_DELAY_MS, () => {
            WindowState.remove(window, 'targetRestoredSize');
            return GLib.SOURCE_REMOVE;
        }, 'edgeTiling_removeTileSizeSettle');
    }

    // Mirrors the targetRestoredSize bridge above: while it's live, a settling resize is
    // that restore's tail, not a window that's genuinely too big for the workspace.
    isRestoringFromEdgeTile(now) {
        return this._lastRemoveTileAt !== null &&
            (now - this._lastRemoveTileAt) < constants.EDGE_TILE_EXIT_SUPPRESSION_MS;
    }

    // An untiled window drags its auto-tiled dependents out with it, and stops counting
    // against whatever master pulled it in.
    _releaseAutoTileLinks(window) {
        Logger.log(`removeTile: Checking dependencies for master=${window.get_id()}`);

        const dependents = WindowState.get(window, 'autoTileDependents');
        if (dependents && dependents.size > 0) {
            Logger.log(`removeTile: Found ${dependents.size} dependents`);
            // Copy set to avoid modification during iteration
            for (const dependent of Array.from(dependents)) {
                Logger.log(`removeTile: Calling removeTile on dependent ${dependent.get_id()}`);
                this.removeTile(dependent);

                // Cleanup refs
                WindowState.remove(dependent, 'autoTileMaster');
            }
            dependents.clear();
            WindowState.remove(window, 'autoTileDependents');
        }

        // If this window is a dependent, remove itself from master
        const master = WindowState.get(window, 'autoTileMaster');
        if (master) {
            const masterDeps = WindowState.get(master, 'autoTileDependents');
            if (masterDeps) masterDeps.delete(window);
            WindowState.remove(window, 'autoTileMaster');
        }
    }

    // The quarter stacked against the one leaving has the whole side to itself now.
    _expandAdjacentQuarterToFull(window, savedZone) {
        Logger.log(`Quarter tile ${window.get_id()} being removed from zone ${savedZone}`);

        const adjacentZone = this._getAdjacentQuarterZone(savedZone);
        if (!adjacentZone) return;

        const adjacentWindow = this._findWindowInZone(adjacentZone, window.get_workspace());
        if (!adjacentWindow) return;

        // Our own state is already gone by now, so the side has to come from the
        // saved copy; reading it back would resolve to RIGHT_FULL for a left quarter.
        const fullZone = this._getFullZoneFromQuarter(savedZone);
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const fullRect = this.getZoneRect(fullZone, workArea, adjacentWindow);
        if (!fullRect) return;

        adjacentWindow.move_resize_frame(false, fullRect.x, fullRect.y, fullRect.width, fullRect.height);
        const adjacentState = WindowState.get(adjacentWindow, 'edgeTilingState');
        if (adjacentState) adjacentState.zone = fullZone;
    }

    _restoreFrameAfterUntile(window, savedWidth, savedHeight, placeAtCursor) {
        // Restore the pre-tiling size as it was. Whether it still fits is the mosaic's call, and it
        // shrinks or miniaturizes accordingly; pre-shrinking here would just lose the size for good.
        let restoredX;
        let restoredY;
        if (placeAtCursor) {
            const [cursorX, cursorY] = global.get_pointer();
            restoredX = cursorX - (savedWidth / 2);
            restoredY = cursorY - 20;
        } else {
            // Only the window the pointer is holding belongs at the cursor. A dependent or a
            // swapped-out tile isn't, so it grows in place and lets the mosaic ease it to its slot.
            const frame = window.get_frame_rect();
            restoredX = frame.x;
            restoredY = frame.y;
        }

        Logger.log(`removeTile: Restoring window ${window.get_id()} to size ${savedWidth}x${savedHeight} at (${restoredX}, ${restoredY})`);
        window.move_resize_frame(false, restoredX, restoredY, savedWidth, savedHeight);
    }

    _evacuateMosaicToNewWorkspace(mosaicWindows, workspace, monitor) {
        Logger.log(`Both sides edge-tiled - moving ${mosaicWindows.length} mosaic windows to new workspace`);
        const newWorkspace = this._windowingManager.createOrReuseAdjacentWorkspace(workspace);

        for (const mosaicWindow of mosaicWindows) {
            mosaicWindow.change_workspace(newWorkspace);
        }

        this._timeoutRegistry.add(constants.REVERSE_RESIZE_PROTECTION_MS, () => {
            if (this._tilingManager) {
                this._tilingManager.tileWorkspaceWindows(workspace, null, monitor);
            }
            return GLib.SOURCE_REMOVE;
        }, 'edgeTiling_bothSidesRetile');

        newWorkspace.activate(global.get_current_time());
        this._windowingManager.showWorkspaceSwitcher(newWorkspace, monitor);
    }

    _tryPairIntoOppositeHalf(mosaicWindow, tiledWindow, zone, workArea) {
        if (zone !== TileZone.LEFT_FULL && zone !== TileZone.RIGHT_FULL) return false;

        const oppositeZone = (zone === TileZone.LEFT_FULL) ? TileZone.RIGHT_FULL : TileZone.LEFT_FULL;
        const oppositeRect = this.getZoneRect(oppositeZone, workArea, mosaicWindow);

        // A window that can't fill the half (max-size capped) falls through to the miniature path.
        if (!oppositeRect || !this.isEdgeTileable(mosaicWindow, oppositeRect)) return false;

        Logger.log(`_handleMosaicOverflow: auto-tiling single window ${mosaicWindow.get_id()} to opposite zone ${oppositeZone}`);

        // Reserve the zone and drop any miniature synchronously so the trigger's size-changed
        // retile treats this window as tiled before applyTile positions it, with no race.
        this.saveWindowState(mosaicWindow);
        const oppState = this.getWindowState(mosaicWindow);
        if (oppState) oppState.zone = oppositeZone;
        this._dropMiniature(mosaicWindow);

        this.applyTile(mosaicWindow, oppositeZone, workArea);
        this.registerAutoTileDependency(mosaicWindow, tiledWindow);
        return true;
    }

    _handleMosaicOverflow(tiledWindow, zone, remainingSpace) {
        Logger.log(`_handleMosaicOverflow: called for zone=${zone}`);

        const workspace = tiledWindow.get_workspace();
        const monitor = tiledWindow.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        // Check if BOTH sides are now edge-tiled (including the window just tiled)
        const occupiedSides = new Set(
            this.getEdgeTiledWindows(workspace, monitor).map(w => ZONE_SIDE[w.zone])
        );

        const mosaicWindows = this.getNonEdgeTiledWindows(workspace, monitor);

        if (mosaicWindows.length === 0) return;

        // If both sides are occupied, move ALL mosaic windows to new workspace
        if (occupiedSides.has('left') && occupiedSides.has('right')) {
            this._evacuateMosaicToNewWorkspace(mosaicWindows, workspace, monitor);
            return;
        }

        // Single edge tile: pair the last window into the opposite half instead of miniaturizing it.
        if (mosaicWindows.length === 1 &&
            this._tryPairIntoOppositeHalf(mosaicWindows[0], tiledWindow, zone, workArea)) {
            return;
        }

        if (!this._tilingManager) return;

        // Miniaturized windows report their original full size from get_frame_rect, so pass the miniature display size instead.
        const testTileInfo = this._tilingManager._tile(
            mosaicWindows.map((w, i) => {
                if (WindowState.get(w, IS_MINIATURE)) {
                    const ms = getMiniatureSize(w);
                    if (ms) return { index: i, width: ms.width, height: ms.height };
                }
                const f = w.get_frame_rect();
                return { index: i, width: f.width, height: f.height };
            }),
            remainingSpace
        );

        Logger.log(`_handleMosaicOverflow: Checking ${mosaicWindows.length} windows in ${remainingSpace.width}x${remainingSpace.height}. Overflow: ${testTileInfo.overflow}`);

        if (testTileInfo.overflow) {
            Logger.log(`Mosaic overflow - scheduling miniaturization for ${mosaicWindows.length} windows`);
            this._timeoutRegistry.add(constants.REVERSE_RESIZE_PROTECTION_MS, () => {
                if (this._tilingManager) {
                    this._tilingManager.tileWorkspaceWindows(workspace, null, monitor);
                }
                return GLib.SOURCE_REMOVE;
            }, 'edgeTiling_overflowRetile');
        }
    }

    setupResizeListener(window) {
        if (WindowState.has(window, 'edgeResizeSignalId')) return;

        const signalId = window.connect('size-changed', () => {
            this._handleWindowResize(window);
        });

        WindowState.set(window, 'edgeResizeSignalId', signalId);
        Logger.log(`Setup resize listener for window ${window.get_id()}`);
    }

    _removeResizeListener(window) {
        const signalId = WindowState.get(window, 'edgeResizeSignalId');

        if (signalId) {
            window.disconnect(signalId);
            WindowState.remove(window, 'edgeResizeSignalId');
            Logger.log(`Removed resize listener from window ${window.get_id()}`);
        }
    }

    _handleWindowResize(window) {
        const state = this.getWindowState(window);
        if (!state || state.zone === TileZone.NONE) return;

        if (this._isResizing) return;

        Logger.log(`Resize detected on edge-tiled window ${window.get_id()}, zone=${state.zone}`);

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
            // No adjacent edge tile, so retile the mosaic to adapt to the new edge tile size
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

        const resizedFrame = window.get_frame_rect();

        const previousState = WindowState.get(window, 'edgePreviousSize');

        if (!previousState) {
            const adjacentFrame = adjacentWindow.get_frame_rect();
            WindowState.set(window, 'edgePreviousSize', { width: resizedFrame.width, height: resizedFrame.height, y: resizedFrame.y });
            WindowState.set(adjacentWindow, 'edgePreviousSize', { width: adjacentFrame.width, height: adjacentFrame.height, y: adjacentFrame.y });
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

                WindowState.set(window, 'edgePreviousSize', { width: resizedFrame.width, height: resizedFrame.height, y: workArea.y });
                WindowState.set(adjacentWindow, 'edgePreviousSize', { width: resizedFrame.width, height: newAdjacentHeight, y: adjacentY });
            } else {
                adjacentWindow.move_frame(false, resizedFrame.x, workArea.y);
                adjacentWindow.move_resize_frame(false, resizedFrame.x, workArea.y, resizedFrame.width, newAdjacentHeight);

                const resizedY = workArea.y + newAdjacentHeight;
                window.move_frame(false, resizedFrame.x, resizedY);
                window.move_resize_frame(false, resizedFrame.x, resizedY, resizedFrame.width, resizedFrame.height);

                WindowState.set(adjacentWindow, 'edgePreviousSize', { width: resizedFrame.width, height: newAdjacentHeight, y: workArea.y });
                WindowState.set(window, 'edgePreviousSize', { width: resizedFrame.width, height: resizedFrame.height, y: resizedY });
            }
        } finally {
            this._timeoutRegistry.add(constants.ISRESIZING_FLAG_RESET_MS, () => {
                this._isResizing = false;
                return GLib.SOURCE_REMOVE;
            }, 'edgeTiling_isResizingReset');
        }
    }

    _resizeTiledPair(resizedWindow, adjacentWindow, workArea, zone) {
        const resizedFrame = resizedWindow.get_frame_rect();

        const previousState = WindowState.get(resizedWindow, 'edgePreviousSize');

        if (!previousState) {
            const adjacentFrame = adjacentWindow.get_frame_rect();
            WindowState.set(resizedWindow, 'edgePreviousSize', { width: resizedFrame.width, height: resizedFrame.height, x: resizedFrame.x });
            WindowState.set(adjacentWindow, 'edgePreviousSize', { width: adjacentFrame.width, height: resizedFrame.height, x: adjacentFrame.x });
            return;
        }

        const minWidth = constants.MIN_WINDOW_WIDTH;
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

                WindowState.set(resizedWindow, 'edgePreviousSize', { width: resizedFrame.width, height: workArea.height, x: workArea.x });
                WindowState.set(adjacentWindow, 'edgePreviousSize', { width: newAdjacentWidth, height: workArea.height, x: workArea.x + resizedFrame.width });
            } else {
                adjacentWindow.move_frame(false, workArea.x, workArea.y);
                adjacentWindow.move_resize_frame(false, workArea.x, workArea.y, newAdjacentWidth, workArea.height);

                resizedWindow.move_frame(false, workArea.x + newAdjacentWidth, workArea.y);
                resizedWindow.move_resize_frame(false, workArea.x + newAdjacentWidth, workArea.y, resizedFrame.width, workArea.height);

                WindowState.set(adjacentWindow, 'edgePreviousSize', { width: newAdjacentWidth, height: workArea.height, x: workArea.x });
                WindowState.set(resizedWindow, 'edgePreviousSize', { width: resizedFrame.width, height: workArea.height, x: workArea.x + newAdjacentWidth });
            }
        } finally {
            this._timeoutRegistry.add(constants.ISRESIZING_FLAG_RESET_MS, () => {
                this._isResizing = false;
                return GLib.SOURCE_REMOVE;
            }, 'edgeTiling_isResizingReset');
        }
    }

    _handleResizeWithMosaic(_window, workspace, monitor) {
        // Retile mosaic to adapt to the edge tile's new size
        if (this._tilingManager) {
            Logger.log('Edge-tiled window resizing - retiling mosaic to adapt');
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

    fixTiledPairSizes(resizedWindow, zone) {
        const workspace = resizedWindow.get_workspace();
        const monitor = resizedWindow.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const adjacentWindow = this._getAdjacentWindow(resizedWindow, workspace, monitor, zone);

        if (!adjacentWindow) return;

        const resizedFrame = resizedWindow.get_frame_rect();
        const minWidth = constants.MIN_WINDOW_WIDTH;
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
                this._timeoutRegistry.add(100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                }, 'edgeTiling_isResizingReset');
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
                this._timeoutRegistry.add(100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                }, 'edgeTiling_isResizingReset');
            }
        }
    }

    fixMosaicAfterEdgeResize(edgeTiledWindow, zone) {
        const workspace = edgeTiledWindow.get_workspace();
        const monitor = edgeTiledWindow.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        const edgeFrame = edgeTiledWindow.get_frame_rect();

        const mosaicWindows = this.getNonEdgeTiledWindows(workspace, monitor);
        if (mosaicWindows.length === 0) {
            // No mosaic windows, so leave room for at least one minimum-width window
            const minFreeSpace = constants.MIN_WINDOW_WIDTH;
            const maxWidth = workArea.width - minFreeSpace;

            if (edgeFrame.width > maxWidth) {
                this._isResizing = true;
                try {
                    const isLeft = (zone === TileZone.LEFT_FULL);
                    const x = isLeft ? workArea.x : (workArea.x + workArea.width - maxWidth);
                    edgeTiledWindow.move_resize_frame(false, x, workArea.y, maxWidth, workArea.height);
                } finally {
                    this._timeoutRegistry.add(50, () => {
                        this._isResizing = false;
                        return GLib.SOURCE_REMOVE;
                    }, 'edgeTiling_isResizingReset');
                }
            }
            return;
        }
        // The maximum width for an edge tile is the work area minus the space required by the mosaic.

        let mosaicMinX = Infinity;
        let mosaicMaxX = 0;
        for (const w of mosaicWindows) {
            const f = w.get_frame_rect();
            mosaicMinX = Math.min(mosaicMinX, f.x);
            mosaicMaxX = Math.max(mosaicMaxX, f.x + f.width);
        }

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

        // Fallback if mosaic width is somehow 0
        if (maxEdgeWidth <= 0) {
            maxEdgeWidth = workArea.width - constants.MIN_WINDOW_WIDTH;
        }

        if (edgeFrame.width > maxEdgeWidth) {
            Logger.log(`Edge tile exceeds max (${edgeFrame.width} > ${maxEdgeWidth}) - constraining to mosaic boundary`);
            this._isResizing = true;
            try {
                if (isLeft) {
                    edgeTiledWindow.move_resize_frame(false, workArea.x, workArea.y, maxEdgeWidth, workArea.height);
                } else {
                    const newX = workArea.x + workArea.width - maxEdgeWidth;
                    edgeTiledWindow.move_resize_frame(false, newX, workArea.y, maxEdgeWidth, workArea.height);
                }
            } finally {
                this._timeoutRegistry.add(50, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                }, 'edgeTiling_isResizingReset');
            }
        }

        // Always retile mosaic to adapt to new available space
        if (this._tilingManager) {
            Logger.log('Retiling mosaic after edge tile resize');
            this._timeoutRegistry.add(100, () => {
                this._tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                return GLib.SOURCE_REMOVE;
            }, 'edgeTiling_retileMosaic');
        }
    }

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
                this._timeoutRegistry.add(100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                }, 'edgeTiling_isResizingReset');
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
                this._timeoutRegistry.add(100, () => {
                    this._isResizing = false;
                    return GLib.SOURCE_REMOVE;
                }, 'edgeTiling_isResizingReset');
            }
        }
    }

    _findWindowById(windowId) {
        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        return allWindows.find(w => w.get_id() === windowId) || null;
    }
});

export function isQuarterZone(zone) {
    return zone === TileZone.TOP_LEFT || zone === TileZone.BOTTOM_LEFT ||
           zone === TileZone.TOP_RIGHT || zone === TileZone.BOTTOM_RIGHT;
}
