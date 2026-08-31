// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Window management utilities and workspace operations

import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import { afterWorkspaceSwitch } from './timing.js';

import { TileZone, ZONE_SIDE, SIDE_ZONES } from './constants.js';
import * as WindowState from './windowState.js';
import { isWindowAlive } from './liveness.js';

const BLACKLISTED_WM_CLASSES = [
    'org.gnome.Screenshot',
    'Gnome-screenshot',
];

import GObject from 'gi://GObject';

export const WindowingManager = GObject.registerClass({
    GTypeName: 'MosaicWindowingManager',
}, class WindowingManager extends GObject.Object {
    _init() {
        super._init();
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._tilingManager = null;
        this._timeoutRegistry = null;
        this._overflowStartCallback = null;
        this._overflowEndCallback = null;

        // Cache for getMonitorWorkspaceWindows; invalidated at start of each tiling operation
        // WeakMap<Workspace, Map<String, Window[]>>
        this._windowsCache = new WeakMap();
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    setTilingManager(manager) {
        this._tilingManager = manager;
    }

    setTimeoutRegistry(registry) {
        this._timeoutRegistry = registry;
    }

    setOverflowCallbacks(startCallback, endCallback) {
        this._overflowStartCallback = startCallback;
        this._overflowEndCallback = endCallback;
    }

    getTimestamp() {
        return global.get_current_time();
    }

    getWorkspace() {
        return global.workspace_manager.get_active_workspace();
    }

    getAllWorkspaceWindows(monitor, allow_unrelated) {
        return this.getMonitorWorkspaceWindows(this.getWorkspace(), monitor, allow_unrelated);
    }

    invalidateWindowsCache() {
        this._cacheVersion = (this._cacheVersion || 0) + 1;
    }

    getMonitorWorkspaceWindows(workspace, monitor, allow_unrelated) {
        if (!workspace) return [];

        let workspaceCache = this._windowsCache.get(workspace);
        if (!workspaceCache || workspaceCache._version !== this._cacheVersion) {
            workspaceCache = new Map();
            workspaceCache._version = this._cacheVersion;
            this._windowsCache.set(workspace, workspaceCache);
        }

        const cacheKey = `${monitor}-${allow_unrelated ? 1 : 0}`;
        if (workspaceCache.has(cacheKey)) {
            return workspaceCache.get(cacheKey);
        }

        const _windows = [];
        const windows = workspace.list_windows();
        for (const window of windows)
            if (window.get_monitor() === monitor && (this.isRelated(window) || allow_unrelated))
                _windows.push(window);

        workspaceCache.set(cacheKey, _windows);
        return _windows;
    }

    // Always pass a workspace: the null path drops Mutter's real MRU list and
    // falls back to sorting by the coarser user_time.
    getMRUOrder(workspace) {
        const order = new Map();
        global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .forEach((w, i) => order.set(w.get_id(), i));
        return order;
    }

    tryTileWithSnappedWindow(window, edgeTiledWindow, previousWorkspace) {
        if (!this._edgeTilingManager) {
            Logger.error('tryTileWithSnappedWindow: edgeTilingManager not set');
            return false;
        }

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        const tileState = this._edgeTilingManager.getWindowState(edgeTiledWindow);

        if (!tileState || tileState.zone === TileZone.NONE) {
            Logger.log('Existing window is not edge-tiled, cannot tile');
            return false;
        }

        const occupiedSide = ZONE_SIDE[tileState.zone];
        if (!occupiedSide) {
            Logger.log('Unsupported edge tile zone for dual-tiling');
            return false;
        }

        // We take whichever half the snapped window left free.
        const direction = occupiedSide === 'left' ? 'right' : 'left';

        const existingFrame = edgeTiledWindow.get_frame_rect();
        const existingWidth = existingFrame.width;
        const availableWidth = workArea.width - existingWidth;

        Logger.log(`Auto-tiling: existing window width=${existingWidth}px, available=${availableWidth}px`);

        const targetX = direction === 'left' ? workArea.x : workArea.x + existingWidth;
        const targetY = workArea.y;
        const targetWidth = availableWidth;
        const targetHeight = workArea.height;

        return this._applyDualTile(window, edgeTiledWindow, previousWorkspace, direction, {
            x: targetX, y: targetY, width: targetWidth, height: targetHeight
        });
    }

    _applyDualTile(window, edgeTiledWindow, previousWorkspace, direction, rect) {
        try {
            this._edgeTilingManager.saveWindowState(window);

            window.unmaximize();
            window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);

            const zone = SIDE_ZONES[direction].full;
            const state = this._edgeTilingManager.getWindowState(window);
            if (state) {
                state.zone = zone;
                Logger.log(`Dual-tiling: Updated window ${window.get_id()} state to zone ${zone}`);

                this._edgeTilingManager.setupResizeListener(window);
            }

            this._edgeTilingManager.registerAutoTileDependency(window, edgeTiledWindow);

            Logger.log(`Successfully dual-tiled window ${window.get_wm_class()} to ${direction} (${rect.width}x${rect.height})`);
            return true;
        } catch (error) {
            Logger.log(`Failed to tile window: ${error.message}`);
            // Undo the move that brought it here; leaving it stranded is worse than not tiling.
            if (previousWorkspace) {
                window.change_workspace(previousWorkspace);
            }
            return false;
        }
    }

    createOrReuseAdjacentWorkspace(originWorkspace) {
        const workspaceManager = global.workspace_manager;
        const currentIndex = originWorkspace.index();
        const nextIndex = currentIndex + 1;
        const totalWorkspaces = workspaceManager.get_n_workspaces();
        const nextWorkspace = nextIndex < totalWorkspaces ? workspaceManager.get_workspace_by_index(nextIndex) : null;

        let targetWorkspace;
        if (nextWorkspace && nextWorkspace.list_windows().length === 0) {
            Logger.log(`[WORKSPACE] Reusing existing empty workspace at WS-${nextIndex}`);
            targetWorkspace = nextWorkspace;
        } else {
            Logger.log(`[WORKSPACE] Creating new workspace and inserting at WS-${nextIndex}`);
            targetWorkspace = workspaceManager.append_new_workspace(false, this.getTimestamp());
            workspaceManager.reorder_workspace(targetWorkspace, nextIndex);
        }

        return targetWorkspace;
    }

    moveOversizedWindow(window, options = { switchFocus: true }) {
        return new Promise(resolve => {
            const workspaceManager = global.workspace_manager;
            const monitor = window.get_monitor();

            if (this._overflowStartCallback) {
                this._overflowStartCallback();
            }

            WindowState.set(window, 'movedByOverflow', true);

            // Use current workspace as origin to prevent overflow target loops.
            const currentIndex = window.get_workspace().index();

            Logger.log(`moveOversizedWindow: origin=${currentIndex}`);

            const isSacred = this.isMaximizedOrFullscreen(window);
            const nextIndex = currentIndex + 1;
            const totalWorkspaces = workspaceManager.get_n_workspaces();
            let target_workspace = null;

            // GNOME's dynamic workspaces might not have a workspace at nextIndex yet
            const nextWorkspace = nextIndex < totalWorkspaces ? workspaceManager.get_workspace_by_index(nextIndex) : null;

            if (isSacred) {
                Logger.log(`[PLACEMENT] Sacred window detected - targeting strictly WS-${nextIndex} for isolation`);
                target_workspace = this.createOrReuseAdjacentWorkspace(workspaceManager.get_workspace_by_index(currentIndex));
            } else {
                Logger.log(`[PLACEMENT] Overflow window detected - targeting strictly WS-${nextIndex}`);
                if (nextWorkspace && this._tilingManager && this._tilingManager.canFitWindow(window, nextWorkspace, monitor)) {
                    Logger.log(`[PLACEMENT] Window fits in existing adjacent WS-${nextIndex}`);
                    target_workspace = nextWorkspace;
                } else {
                    Logger.log(`[PLACEMENT] Adjacent WS-${nextIndex} is full or missing - creating new workspace`);
                    target_workspace = this.createOrReuseAdjacentWorkspace(workspaceManager.get_workspace_by_index(currentIndex));
                }
            }

            const previous_workspace = window.get_workspace();
            const switchFocusRequested = options.switchFocus !== false;

            window.change_workspace(target_workspace);

            // Defer activation to next idle (no artificial delay)
            this._timeoutRegistry.addIdle(() => {
                const workspaceIndex = target_workspace.index();
                if (workspaceIndex < 0 || workspaceIndex >= workspaceManager.get_n_workspaces()) {
                    Logger.warn(`Workspace no longer valid: ${workspaceIndex}`);
                    resolve(target_workspace);
                    return GLib.SOURCE_REMOVE;
                }

                // Decide focus after any ongoing workspace switch completes,
                // avoiding fights with user-initiated navigation.
                afterWorkspaceSwitch(() => {
                    const stillOnOrigin = global.workspace_manager.get_active_workspace() === previous_workspace;
                    if (stillOnOrigin && switchFocusRequested) {
                        target_workspace.activate(global.get_current_time());
                        this.showWorkspaceSwitcher(target_workspace, monitor);
                    }
                }, this._timeoutRegistry);

                // Re-tile after window has settled
                if (this._tilingManager) {
                    Logger.log('moveOversizedWindow: workspace switch done, retiling immediately and then waiting for animations');

                    // First, repair any aborted smart-resize corruption in the origin workspace before the window was ejected
                    if (previous_workspace.index() !== target_workspace.index()) {
                        this._tilingManager.tileWorkspaceWindows(previous_workspace, null, monitor);
                    }

                    // Tile target workspace IMMEDIATELY to prevent "leap to 0,0"
                    this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);

                    afterWorkspaceSwitch(() => {
                        try {
                            this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);

                            this._timeoutRegistry.addIdle(() => {
                                try {
                                    if (!isWindowAlive(window)) {
                                        return;
                                    }
                                    const finalFrame = window.get_frame_rect();
                                    const workArea = target_workspace.get_work_area_for_monitor(monitor);
                                    const expectedX = Math.floor((workArea.width - finalFrame.width) / 2) + workArea.x;
                                    const expectedY = Math.floor((workArea.height - finalFrame.height) / 2) + workArea.y;
                                    const positionError = Math.abs(finalFrame.x - expectedX) + Math.abs(finalFrame.y - expectedY);

                                    if (positionError > 10) {
                                        Logger.log(`moveOversizedWindow: window mispositioned by ${positionError}px, retiling`);
                                        this._tilingManager.tileWorkspaceWindows(target_workspace, null, monitor);
                                    }
                                } finally {
                                    WindowState.remove(window, 'movedByOverflow');
                                    WindowState.remove(window, 'overflowOriginWorkspace');

                                    if (this._overflowEndCallback) {
                                        this._overflowEndCallback();
                                    }
                                    resolve(target_workspace);
                                }
                                return GLib.SOURCE_REMOVE;
                            }, 'windowing_positionCheck', GLib.PRIORITY_DEFAULT_IDLE);
                        } catch (e) {
                            Logger.error(`Error during moveOversizedWindow retiling: ${e}`);

                            WindowState.remove(window, 'movedByOverflow');
                            WindowState.remove(window, 'overflowOriginWorkspace');

                            if (this._overflowEndCallback) {
                                this._overflowEndCallback();
                            }
                            resolve(target_workspace);
                        }
                    }, this._timeoutRegistry);
                } else {
                    WindowState.remove(window, 'movedByOverflow');
                    WindowState.remove(window, 'overflowOriginWorkspace');

                    if (this._overflowEndCallback) {
                        this._overflowEndCallback();
                    }
                    resolve(target_workspace);
                }

                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // The exclusion reasons that already hold before the window has any geometry.
    // Callers running that early (entrance setup) must ask this instead of
    // isExcluded, since an unmapped window reports 0x0 and reads as a 1×1 helper.
    isExcludedByPolicy(meta_window) {
        if (!this.isRelated(meta_window) || meta_window.minimized) {
            return true;
        }

        if (meta_window.is_above()) {
            return true;
        }

        const wmClass = meta_window.get_wm_class();
        if (wmClass && BLACKLISTED_WM_CLASSES.includes(wmClass)) {
            return true;
        }

        return false;
    }

    isExcluded(meta_window) {
        if (this.isExcludedByPolicy(meta_window)) {
            return true;
        }

        // 1×1 XWayland utility windows (clipboard helpers) must not enter the layout.
        // get_frame_rect on a disposed MetaWindow segfaults libmutter, so only
        // read it while the window is alive (dead windows keep prior semantics).
        if (isWindowAlive(meta_window)) {
            const frame = meta_window.get_frame_rect();
            if (frame.width <= 1 && frame.height <= 1) {
                return true;
            }
        }

        return false;
    }

    isRelated(meta_window) {
        if (meta_window.is_attached_dialog()) {
            return false;
        }

        if (meta_window.get_transient_for() !== null) {
            return false;
        }

        if (meta_window.window_type !== Meta.WindowType.NORMAL) {
            return false;
        }

        if (meta_window.is_skip_taskbar()) {
            return false;
        }

        if (this.isTrulySticky(meta_window)) {
            return false;
        }

        return true;
    }

    // With workspaces-only-on-primary, Mutter reports every window on a secondary monitor
    // as on-all-workspaces. That's the monitor policy talking, not the user pinning a
    // window, so it stays a normal mosaic member. The overview layout asks this too; both
    // have to agree on what sticky means or they end up laying out different mosaics.
    isTrulySticky(meta_window) {
        if (!meta_window.is_on_all_workspaces()) {
            return false;
        }

        const stickyByMonitorPolicy = Meta.prefs_get_workspaces_only_on_primary() &&
                                      !meta_window.is_on_primary_monitor();
        return !stickyByMonitorPolicy;
    }

    isMaximizedOrFullscreen(window) {
        return window.is_maximized() || window.is_fullscreen() || this._looksNativelyFullscreen(window);
    }

    // Some game engines (Unity's borderless "Fullscreen Window" mode) resize to the monitor's
    // resolution without setting the WM's real maximize/fullscreen state, so nothing marks
    // them sacred and mosaic shrinks then miniaturizes them like any oversized window. Catch
    // the shape instead: no preferred/opening size captured yet, and the frame already covers
    // the whole physical monitor, which normal placement (even maximized) never reaches.
    _looksNativelyFullscreen(window) {
        if (WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize'))
            return false;

        const monitor = window.get_monitor();
        if (monitor === null || monitor === undefined || monitor < 0) return false;

        const geom = global.display.get_monitor_geometry(monitor);
        if (!geom) return false;

        const frame = window.get_frame_rect();
        return frame.width >= geom.width && frame.height >= geom.height;
    }

    hasSacredWindow(workspace, monitor, excludeWindowId = null) {
        if (!workspace || monitor === null || monitor === undefined)
            return false;

        const windows = this.getMonitorWorkspaceWindows(workspace, monitor);
        return windows.some(w =>
            (!excludeWindowId || w.get_id() !== excludeWindowId) &&
            this.isMaximizedOrFullscreen(w)
        );
    }

    renavigate(workspace, condition, lastVisitedIndex = null, monitorIndex = -1) {
        if (!condition) return;

        // Queue in idle with low priority to let GNOME settle its dynamic workspace states
        this._timeoutRegistry.addIdle(() => {
            const currentIndex = this._indexOfWorkspace(workspace);
            if (currentIndex < 0) return GLib.SOURCE_REMOVE;

            const target = this._pickRenavigateTarget(workspace, currentIndex, lastVisitedIndex);

            if (target && target.index() >= 0 && target.index() !== currentIndex) {
                const currentWindows = workspace.list_windows();
                if (currentWindows.some(w => w.is_on_all_workspaces())) {
                    Logger.log(
                        '[RENAVIGATE] Current WS has is_on_all_workspaces() windows; skipping to avoid GNOME Shell WorkspaceSwitcherPopup freeze'
                    );
                } else {
                    target.activate(this.getTimestamp());
                    this.showWorkspaceSwitcher(target, monitorIndex);
                }
            } else {
                Logger.log(`[RENAVIGATE] No suitable target found to navigate away from WS-${currentIndex}`);
            }

            return GLib.SOURCE_REMOVE;
        }, 'windowing_renavigate', GLib.PRIORITY_LOW);
    }

    // This workspace might already be gone by the time the caller's idle runs, and
    // workspace.index() crashes on a removed one, so match by identity instead.
    _indexOfWorkspace(workspace) {
        const workspaceManager = global.workspace_manager;
        for (let i = 0; i < workspaceManager.get_n_workspaces(); i++) {
            if (workspaceManager.get_workspace_by_index(i) === workspace) return i;
        }
        return -1;
    }

    _pickRenavigateTarget(workspace, currentIndex, lastVisitedIndex) {
        const lastWorkspaceIndex = global.workspace_manager.get_n_workspaces() - 1;

        let target = this._preferredNeighbor(workspace, currentIndex, lastWorkspaceIndex, lastVisitedIndex);

        if (!target || target.index() === currentIndex) {
            target = workspace.get_neighbor(Meta.MotionDirection.LEFT);

            if (!target || target.index() === currentIndex || target.index() < 0) {
                target = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
            }

            // Final safety: never fallback to the placeholder workspace
            if (target && target.index() === lastWorkspaceIndex) {
                target = null;
            } else if (target) {
                Logger.log(`[RENAVIGATE] Falling back to available neighbor (WS-${target.index()})`);
            }
        }

        return this._guardLeftmostTarget(target, currentIndex);
    }

    // The leftmost workspace has nothing to return to; going right strands
    // the user in the overflow zone when the target is empty.
    _guardLeftmostTarget(target, currentIndex) {
        if (currentIndex === 0 && target && !this._workspaceHasWindows(target)) {
            Logger.log(`[RENAVIGATE] WS-0 is leftmost and WS-${target.index()} is empty; staying put`);
            return null;
        }
        return target;
    }

    _workspaceHasWindows(workspace) {
        return workspace.list_windows().some(w => !this.isExcluded(w));
    }

    // The last workspace is the placeholder, so from there the only way out is left.
    // Anywhere else, head back where we came from; null hands the choice to the fallback.
    _preferredNeighbor(workspace, currentIndex, lastWorkspaceIndex, lastVisitedIndex) {
        if (currentIndex === lastWorkspaceIndex) {
            const leftNeighbor = workspace.get_neighbor(Meta.MotionDirection.LEFT);
            if (leftNeighbor) {
                Logger.log(`[RENAVIGATE] On final workspace, moving to left neighbor (WS-${leftNeighbor.index()})`);
            }
            return leftNeighbor;
        }

        if (lastVisitedIndex === null || lastVisitedIndex === currentIndex) return null;

        const direction = lastVisitedIndex < currentIndex
            ? Meta.MotionDirection.LEFT
            : Meta.MotionDirection.RIGHT;

        const target = workspace.get_neighbor(direction);

        // Guard: Don't jump to the final empty workspace if we were going right
        if (target && target.index() === lastWorkspaceIndex) return null;
        if (target) {
            Logger.log(`[RENAVIGATE] Moving ${direction === Meta.MotionDirection.LEFT ? 'left' : 'right'} toward last visited WS-${lastVisitedIndex}`);
        }
        return target;
    }

    showWorkspaceSwitcher(workspace, monitorIndex = -1) {
        if (!workspace) return;

        const wsWindows = workspace.list_windows();
        if (wsWindows.some(w => w.is_on_all_workspaces())) {
            Logger.log(
                '[SWITCHER] Workspace has is_on_all_workspaces() windows; skipping to avoid GNOME Shell WorkspaceSwitcherPopup freeze'
            );
            return;
        }

        const index = workspace.index();
        Logger.log(`[SWITCHER] Activating OSD for WS-${index}`);

        if (monitorIndex === -1) {
            monitorIndex = Main.layoutManager.primaryIndex;
        }

        Logger.log(`showWorkspaceSwitcher: showing WorkspaceSwitcherPopup for workspace ${index} on monitor ${monitorIndex}`);

        try {
            if (!Main.wm._workspaceSwitcherPopup) {
                Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
            }

            if (!WindowState.get(Main.wm._workspaceSwitcherPopup, 'destroyConnected')) {
                Main.wm._workspaceSwitcherPopup.connect('destroy', () => {
                    Main.wm._workspaceSwitcherPopup = null;
                });
                WindowState.set(Main.wm._workspaceSwitcherPopup, 'destroyConnected', true);
            }

            Main.wm._workspaceSwitcherPopup.display(index);
        } catch (e) {
            Logger.warn(`WorkspaceSwitcherPopup failed: ${e.message}`);
        }
    }
    destroy() {
        this._edgeTilingManager = null;
        this._animationsManager = null;
        this._tilingManager = null;
        this._timeoutRegistry = null;
        this._overflowStartCallback = null;
        this._overflowEndCallback = null;
        this._windowsCache = new WeakMap();
    }
});
