// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later

import * as Logger from './logger.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import * as WindowPreviewModule from 'resource:///org/gnome/shell/ui/windowPreview.js';

import { WindowingManager } from './windowing.js';
import * as constants from './constants.js';

import { SettingsOverrider } from './settingsOverrider.js';

import { EdgeTilingManager } from './edgeTiling.js';
import { TileZone } from './constants.js';
import { TilingManager } from './tiling.js';
import { isWindowAlive } from './liveness.js';
import { ReorderingManager } from './reordering.js';
import { SwappingManager } from './swapping.js';
import { DrawingManager } from './drawing.js';
import { AnimationsManager } from './animations.js';
import { MosaicLayoutStrategy } from './overviewLayout.js';
import { TimeoutRegistry, afterAnimations } from './timing.js';
import { WindowHandler } from './windowHandler.js';
import { DragHandler } from './dragHandler.js';
import { ResizeHandler } from './resizeHandler.js';
import { MiniatureManager } from './miniature.js';
import * as WindowState from './windowState.js';
import { IS_MINIATURE, MINIATURE_SCALE, MINIATURE_EXT_LEFT, MINIATURE_EXT_TOP, MINIATURE_TARGET_POS } from './windowState.js';
import { MosaicIndicator } from './quickSettings.js';

// Module-level accessor for TilingManager (used by overviewLayout.js for on-demand cache)
let _tilingManagerInstance = null;

export function getTilingManager() {
    return _tilingManagerInstance;
}

export default class WindowMosaicExtension extends Extension {
    constructor(metadata) {
        super(metadata);

        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];

        this._tileTimeout = null;

        this._currentWorkspaceIndex = null;
        this._lastVisitedWorkspace = null;
        this._overflowInProgress = false;  // Flag to prevent empty workspace navigation during overflow

        this._settingsOverrider = null;

        this.edgeTilingManager = null;
        this.tilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.windowingManager = null;

        // Handler classes
        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;

        this.miniatureManager    = null;
        this._miniatureCascadeIds  = null;
        this._lastFocusedWindowId  = null;
        this._focusWindowChangedId = 0;
        this._miniatureRestoredId  = 0;

        this._injectionManager = null;

        // Centralized timeout management for async operations
        this._timeoutRegistry = null; // created in enable()

        // Per-workspace toggle for mosaic behavior.
        this._disabledWorkspaceStates = new WeakMap();
    }

    isMosaicEnabledForWorkspace(workspace) {
        if (!workspace) return true;
        // If explicitly set to true in WeakMap, it is disabled. Otherwise enabled.
        return !this._disabledWorkspaceStates.get(workspace);
    }

    disableWorkspaceMosaic(workspace) {
        if (!workspace) return;

        if (this.miniatureManager)
            this.miniatureManager.restoreWorkspaceMiniatures(workspace);

        if (this.drawingManager) {
            this.drawingManager.removeBoxes();
            this.drawingManager.hideTilePreview();
        }

        if (this.edgeTilingManager)
            this.edgeTilingManager.clearAllStates();

        // 300 ms margin lets the 250 ms miniature-restore animations finish first.
        this._timeoutRegistry?.add(300, () => {
            if (!this.isMosaicEnabledForWorkspace(workspace))
                this.tilingManager?.cascadeWorkspaceWindows(workspace);
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateIndicatorIcon() {
        if (this._mosaicIndicator) {
            this._mosaicIndicator._updateIcon();
        }
    }

    _tileWindowWorkspace(meta_window) {
        if(!meta_window) return;
        const workspace = meta_window.get_workspace();
        if(!workspace) return;
        this.tilingManager.tileWorkspaceWindows(workspace,
            meta_window,
            null,
            false);
    }

    _tileAllWorkspaces = () => {
        const nWorkspaces = this._workspaceManager.get_n_workspaces();

        for(let i = 0; i < nWorkspaces; i++) {
            const workspace = this._workspaceManager.get_workspace_by_index(i);
            const nMonitors = global.display.get_n_monitors();
            for(let j = 0; j < nMonitors; j++)
                this.tilingManager.enforceWorkspaceFit(workspace, j);
        }
    };

    // =========================================================================
    // SIGNAL HANDLERS - Workspace Changes
    // =========================================================================

    _switchWorkspaceHandler = (_, win) => {
        this._tileWindowWorkspace(win.meta_window);
    };

    _workspaceSwitchedHandler = () => {
        const newWorkspace = this._workspaceManager.get_active_workspace();
        const newIndex = newWorkspace.index();

        if (this._currentWorkspaceIndex !== null && this._currentWorkspaceIndex !== newIndex) {
            this._lastVisitedWorkspace = this._currentWorkspaceIndex;
            Logger.log(`[WORKSPACE SWITCH] WS-${this._currentWorkspaceIndex} -> WS-${newIndex} (Stored ${this._currentWorkspaceIndex} as last visited)`);
        }

        this._currentWorkspaceIndex = newIndex;

        // Wait for workspace switch animation to complete before any tiling operations
        // This prevents race conditions where tiling starts while animation is still running
        afterAnimations(this.animationsManager, () => {
            Logger.log(`Workspace animation complete - ready for operations on workspace ${newIndex}`);
        }, this._timeoutRegistry);
    };

    // Syncs _currentWorkspaceIndex after reorder_workspace (no active-workspace-changed fired).
    _workspacesReorderedHandler = () => {
        const activeWorkspace = this._workspaceManager.get_active_workspace();
        const newIndex = activeWorkspace.index();
        if (this._currentWorkspaceIndex !== newIndex) {
            Logger.log(`[WORKSPACE REORDER] Index updated: ${this._currentWorkspaceIndex} -> ${newIndex}`);
            this._currentWorkspaceIndex = newIndex;
        }
    };

    _workspaceAddSignal = (_, workspaceIdx) => {
        const workspace = this._workspaceManager.get_workspace_by_index(workspaceIdx);
        const eventIds = [];
        eventIds.push(workspace.connect('window-added', (ws, win) => this.windowHandler.onWindowAdded(ws, win)));
        eventIds.push(workspace.connect('window-removed', (ws, win) => this.windowHandler.onWindowRemoved(ws, win)));
        this._workspaceEventIds.push([workspace, eventIds]);
    };

    enable() {
        Logger.info('Starting Mosaic layout manager.');

        this._timeoutRegistry = new TimeoutRegistry();
        this._workspaceManager = global.workspace_manager;

        // Initialize mutter settings + failsafe: Ensure attach-modal-dialogs is enabled
        // (in case extension crashed during Overview with setting disabled)
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        try {
            if (!this._mutterSettings.get_boolean('attach-modal-dialogs')) {
                this._mutterSettings.set_boolean('attach-modal-dialogs', true);
                Logger.log('Failsafe: Restored attach-modal-dialogs setting');
            }
        } catch (_e) {
            // Ignore - setting may not exist
        }

        // Create managers
        this.edgeTilingManager = new EdgeTilingManager();
        this.tilingManager = new TilingManager();
        this.tilingManager.setExtension(this);
        _tilingManagerInstance = this.tilingManager; // Expose for overviewLayout.js
        this.reorderingManager = new ReorderingManager();
        this.swappingManager = new SwappingManager();
        this.drawingManager = new DrawingManager();
        this.animationsManager = new AnimationsManager();
        this.windowingManager = new WindowingManager();

        // Wire up dependencies
        this.windowingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.windowingManager.setAnimationsManager(this.animationsManager);
        this.windowingManager.setTilingManager(this.tilingManager);
        this.windowingManager.setTimeoutRegistry(this._timeoutRegistry);
        this.windowingManager.setOverflowCallbacks(
            () => { this._overflowInProgress = true; },
            () => { this._overflowInProgress = false; }
        );

        this.tilingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.tilingManager.setDrawingManager(this.drawingManager);
        this.tilingManager.setAnimationsManager(this.animationsManager);
        this.tilingManager.setWindowingManager(this.windowingManager);

        this.reorderingManager.setTilingManager(this.tilingManager);
        this.reorderingManager.setEdgeTilingManager(this.edgeTilingManager);
        this.reorderingManager.setAnimationsManager(this.animationsManager);
        this.reorderingManager.setWindowingManager(this.windowingManager);

        this.swappingManager.setTilingManager(this.tilingManager);
        this.swappingManager.setEdgeTilingManager(this.edgeTilingManager);

        this.drawingManager.setEdgeTilingManager(this.edgeTilingManager);

        this.edgeTilingManager.setAnimationsManager(this.animationsManager);
        this.edgeTilingManager.setTimeoutRegistry(this._timeoutRegistry);
        this.animationsManager.setTimeoutRegistry(this._timeoutRegistry);

        // Create handler classes (receive extension reference)
        this.windowHandler = new WindowHandler(this);
        this.dragHandler = new DragHandler(this);
        this.resizeHandler = new ResizeHandler(this);

        this.miniatureManager = new MiniatureManager();
        this._miniatureCascadeIds = new Set();
        this._lastFocusedWindowId = null;

        // Expose on global for module-level helpers in tiling.js
        global.MosaicExtension = this;

        this._miniatureRestoredId = this.miniatureManager.connect('miniature-restored',
            (_, window) => this._onMiniatureRestored(window));
        this._focusWindowChangedId = global.display.connect('notify::focus-window',
            () => this._onFocusWindowChanged());

        // Apply slide-in animation patch
        this.windowHandler.patchMapWindow();

        // Initialize Quick Settings indicator
        this._mosaicIndicator = new MosaicIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._mosaicIndicator);

        this._settingsOverrider = new SettingsOverrider();

        this._settingsOverrider.add(
            new Gio.Settings({ schema_id: 'org.gnome.mutter' }),
            'edge-tiling',
            new GLib.Variant('b', false)
        );

        // Disable attach-modal-dialogs to prevent squashed Overview previews
        // When enabled, attached dialogs expand the window bounding box causing layout issues
        this._settingsOverrider.add(
            this._mutterSettings,
            'attach-modal-dialogs',
            new GLib.Variant('b', false)
        );

        const mutterKeybindings = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });
        const emptyArray = new GLib.Variant('as', []);

        if (mutterKeybindings.get_strv('toggle-tiled-left').includes('<Super>Left')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-left', emptyArray);
        }
        if (mutterKeybindings.get_strv('toggle-tiled-right').includes('<Super>Right')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-right', emptyArray);
        }

        // Override Overview layout to preserve mosaic positions
        this._injectionManager = new InjectionManager();

        // Patch MonitorGroup._init to fix miniature clone positions and scale.
        //
        // GNOME Shell creates Clutter.Clone at (windowActor.x - monitor.x,
        // windowActor.y - monitor.y) with scale=1. For miniature windows, the
        // actor has set_scale + set_translation applied to visually shrink and
        // reposition the frame content at MINIATURE_TARGET_POS. However,
        // Clutter.Clone disables the source actor’s model-view transform during
        // clone paint — so set_scale/set_translation on the source are ignored.
        // The clone paints the source at full size with scale=1.
        //
        // We must apply the miniature scale directly on the clone (set_scale)
        // and position it at the visual frame location (MINIATURE_TARGET_POS),
        // accounting for CSD shadow extents that shift the frame within the actor.
        //
        // InjectionManager.overrideMethod does NOT work for GObject.registerClass
        // methods (resolved via vtable, not JS prototype). Direct prototype
        // replacement of _init DOES work — confirmed by the static-workspace-background
        // extension pattern.
        //
        // TODO: Contribute upstream to gnome-shell/js/ui/workspaceAnimation.js —
        // _createClone should propagate the source actor’s scale and position the
        // clone at the visual frame location, not the raw actor position. This
        // would allow extensions that use actor transforms (tiling WMs, magnifiers,
        // etc.) to work correctly with the native workspace switch animation.
        this._origMonitorGroupInit = WorkspaceAnimation.MonitorGroup.prototype._init;
        const origInit = this._origMonitorGroupInit;
        WorkspaceAnimation.MonitorGroup.prototype._init = function (monitor, workspaceIndices, movingWindow) {
            origInit.call(this, monitor, workspaceIndices, movingWindow);

            // After original _init, all WorkspaceGroups and their clones are created.
            // Fix positions and scale of miniature clones.
            //
            // Clutter.Clone disables the source actor's model-view transform during
            // clone paint, so set_scale/set_translation on the source are ignored.
            // We must apply the miniature scale directly on the clone, and position
            // it at the visual frame location (MINIATURE_TARGET_POS).
            for (const wsGroup of this._workspaceGroups) {
                if (!wsGroup._windowRecords) continue;
                for (const record of wsGroup._windowRecords) {
                    const metaWindow = record.windowActor.meta_window;
                    if (WindowState.get(metaWindow, IS_MINIATURE)) {
                        const tgt = WindowState.get(metaWindow, MINIATURE_TARGET_POS);
                        const sc = WindowState.get(metaWindow, MINIATURE_SCALE);
                        const extL = WindowState.get(metaWindow, MINIATURE_EXT_LEFT) ?? 0;
                        const extT = WindowState.get(metaWindow, MINIATURE_EXT_TOP) ?? 0;
                        if (tgt && sc) {
                            record.clone.set_pivot_point(0, 0);
                            record.clone.set_scale(sc, sc);
                            record.clone.x = tgt.x - monitor.x - extL * sc;
                            record.clone.y = tgt.y - monitor.y - extT * sc;
                        }
                    }
                }
            }
        };

        // Patch WindowPreview.boundingBox so the Overview enter/leave animation
        // uses the miniature's VISUAL bounds (set_scale + MINIATURE_TARGET_POS)
        // for the state=0 (session) side of Workspace._allocate's lerp.
        //
        // Without this patch, WindowPreview.boundingBox returns the meta
        // window's full frame_rect (computed by Shell.WindowPreviewLayout in C
        // from meta_window_get_frame_rect, which does NOT know about actor
        // set_scale). The animation then interpolates from "full size at frame
        // position" to "miniature-size slot from MosaicLayoutStrategy", making
        // the miniature visually pop back to full size during the transition.
        //
        // TODO: Contribute upstream — Shell.WindowPreviewLayout should propagate
        // the source actor's scale (and account for actor translation) when
        // computing its bounding box. Extensions using actor transforms (tiling
        // WMs, magnifiers, etc.) would then work with the native overview
        // transition without this patch.
        this._origWindowPreviewBoundingBoxDesc = Object.getOwnPropertyDescriptor(
            WindowPreviewModule.WindowPreview.prototype, 'boundingBox');
        const origBoundingBoxGetter = this._origWindowPreviewBoundingBoxDesc.get;
        Object.defineProperty(WindowPreviewModule.WindowPreview.prototype, 'boundingBox', {
            configurable: true,
            get() {
                const mw = this.metaWindow;
                if (mw && WindowState.get(mw, IS_MINIATURE)) {
                    const tgt = WindowState.get(mw, MINIATURE_TARGET_POS);
                    const sc = WindowState.get(mw, MINIATURE_SCALE);
                    if (tgt && sc) {
                        const f = mw.get_frame_rect();
                        return {
                            x: tgt.x,
                            y: tgt.y,
                            width: f.width * sc,
                            height: f.height * sc,
                        };
                    }
                }
                return origBoundingBoxGetter.call(this);
            },
        });

        const layoutProto = Workspace.WorkspaceLayout.prototype;
        this._injectionManager.overrideMethod(layoutProto, '_createBestLayout', originalMethod => {
            const extension = this;
            return function (...args) {
                // Determine workspace from the windows in this layout
                let workspace = null;
                for (const win of this._sortedWindows) {
                    const mw = win.metaWindow || win.source?.metaWindow;
                    if (mw) {
                        workspace = mw.get_workspace();
                        if (workspace) break;
                    }
                }

                const isEnabled = workspace ? !extension._disabledWorkspaceStates.get(workspace) : true;

                // Determine if we should use Mosaic or Fallback to Native
                let useMosaic = isEnabled;
                if (isEnabled) {
                    for (const win of this._sortedWindows) {
                        const mw = win.metaWindow || win.source?.metaWindow;
                        if (!mw) continue;

                        // Fallback to Native GNOME layout if there are non-mosaic windows
                        // (Above, Sticky, Maximized, Fullscreen, Modals, Transients, or Minimized)
                        if (mw.minimized ||
                            mw.is_above() || mw.is_on_all_workspaces() ||
                            mw.is_fullscreen() ||
                            mw.get_window_type() === Meta.WindowType.MODAL_DIALOG ||
                            mw.is_attached_dialog() ||
                            mw.get_transient_for() !== null) {
                            useMosaic = false;
                            break;
                        }
                    }
                }

                // Literal Fallback: use native GNOME strategy if not strictly mosaic
                if (!useMosaic) {
                    if (isEnabled) {
                        Logger.log('Overview: Fallback to NATIVE (floating window detected)');
                    }
                    this._layoutStrategy = null;
                    return originalMethod.apply(this, args);
                }

                Logger.log(`Overview: Using MOSAIC Strategy for monitor ${this._monitorIndex}`);
                this._layoutStrategy = new MosaicLayoutStrategy({
                    monitor: Main.layoutManager.monitors[this._monitorIndex],
                });
                return this._layoutStrategy.computeLayout(this._sortedWindows, ...args);
            };
        });

        this._wmEventIds.push(global.window_manager.connect('size-change', (wm, win, mode) => this.resizeHandler.onSizeChange(wm, win, mode)));
        this._wmEventIds.push(global.window_manager.connect('size-changed', (wm, win) => this.resizeHandler.onSizeChanged(wm, win)));
        this._displayEventIds.push(global.display.connect('window-created', (_, window) => this.windowHandler.onWindowCreated(window)));
        this._wmEventIds.push(global.window_manager.connect('destroy', (wm, win) => this.windowHandler.onWindowDestroyed(win.meta_window)));
        this._displayEventIds.push(global.display.connect('grab-op-begin', (display, window, grabpo) => this.dragHandler._grabOpBeginHandler(display, window, grabpo)));
        this._displayEventIds.push(global.display.connect('grab-op-end', (display, window, grabpo) => this.dragHandler._grabOpEndHandler(display, window, grabpo)));
        this._onOverviewHiddenId = Main.overview.connect('hidden', () => this.windowHandler.onOverviewHidden());

        this._workspaceManEventIds.push(global.workspace_manager.connect('active-workspace-changed', this._workspaceSwitchedHandler));
        this._workspaceManEventIds.push(global.workspace_manager.connect('workspaces-reordered', this._workspacesReorderedHandler));
        this._workspaceManEventIds.push(global.workspace_manager.connect('workspace-added', this._workspaceAddSignal));

        const nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            const workspace = this._workspaceManager.get_workspace_by_index(i);
            const eventIds = [];
            eventIds.push(workspace.connect('window-added', (ws, win) => this.windowHandler.onWindowAdded(ws, win)));
            eventIds.push(workspace.connect('window-removed', (ws, win) => this.windowHandler.onWindowRemoved(ws, win)));
            this._workspaceEventIds.push([workspace, eventIds]);
        }

        for(let i = 0; i < nWorkspaces; i++) {
            const workspace = this._workspaceManager.get_workspace_by_index(i);
            const windows = workspace.list_windows();
            for (const window of windows) {
                // Initialize preferredSize if not set (for veteran windows)
                if (this.windowingManager.isRelated(window)) {
                    this.tilingManager.savePreferredSize(window);
                }

                // Always connect exclusion signals, even if excluded
                this.windowHandler.connectWindowSignals(window);
            }
        }

        this._setupKeybindings();

        this._tileTimeout = this._timeoutRegistry.add(constants.STARTUP_TILE_DELAY_MS, () => {
            this._tileAllWorkspaces();
            this._tileTimeout = null;
            return GLib.SOURCE_REMOVE;
        }, 'startupTile');
    }

    _onFocusWindowChanged() {
        const window = global.display.focus_window;
        if (!window) return;

        const prevFocusedId = this._lastFocusedWindowId;
        this._lastFocusedWindowId = window.get_id();

        if (!this.windowingManager.isRelated(window)) return;
        if (this.windowingManager.isExcluded(window)) return;
        if (this.windowingManager.isMaximizedOrFullscreen(window)) return;
        if (!WindowState.get(window, IS_MINIATURE)) return;
        if (WindowState.get(window, 'justMiniaturized')) {
            Logger.log(`[FOCUS] Skip restore ${window.get_id()}: justMiniaturized`);
            return;
        }
        if (this.tilingManager._isSmartResizingBlocked) {
            Logger.log(`[FOCUS] Skip restore ${window.get_id()}: smartResizingBlocked`);
            return;
        }

        const windowId = window.get_id();
        Logger.log(`[FOCUS] Miniature focused ${windowId} (prev=${prevFocusedId}) cascade=${this._miniatureCascadeIds?.has(windowId)}`);

        if (this._miniatureCascadeIds?.has(windowId)) {
            if (prevFocusedId !== windowId) {
                // User deliberately focused it after focusing something else → allow restore
                Logger.log(`[FOCUS] Allow restore ${windowId} (deliberate, prev=${prevFocusedId})`);
                this._miniatureCascadeIds.delete(windowId);
            } else {
                // Auto-focused during cascade → block; activate a non-miniature window instead
                const ws  = window.get_workspace();
                const mon = window.get_monitor();
                const nonMiniature = this.windowingManager.getMonitorWorkspaceWindows(ws, mon)
                    .find(w => !WindowState.get(w, IS_MINIATURE) && !this.windowingManager.isExcluded(w));
                Logger.log(`[FOCUS] Block cascade restore ${windowId} → activating ${nonMiniature?.get_id() ?? 'none'}`);
                if (nonMiniature) nonMiniature.activate(global.get_current_time());
                return;
            }
        }

        Logger.log(`[FOCUS] Triggering restore ${windowId}`);
        this._miniatureCascadeIds.clear();
        this.tilingManager._isSmartResizingBlocked = true;
        WindowState.set(window, 'restoringFromMiniature', true);

        this.miniatureManager.restoreMiniature(window, null);
        // 'miniature-restored' signal fires synchronously → _onMiniatureRestored runs next
    }

    _onMiniatureRestored(window) {
        Logger.log(`[FOCUS] _onMiniatureRestored ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): running smart resize`);
        WindowState.remove(window, 'restoringFromMiniature');
        this.tilingManager._isSmartResizingBlocked = false;

        const workspace = window.get_workspace();
        if (!workspace) return;
        if (!this.isMosaicEnabledForWorkspace(workspace)) return;
        const monitor = window.get_monitor();
        const workArea = this.tilingManager.getUsableWorkArea(workspace, monitor);

        const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w =>
                isWindowAlive(w) &&
                w.get_id() !== window.get_id() &&
                !this.edgeTilingManager.isEdgeTiled(w) &&
                !WindowState.get(w, 'pendingInQueue') &&
                !this.windowingManager.isMaximizedOrFullscreen(w)
            );

        // Treat the restored window as the user-focused one — Mutter's focus
        // hasn't shifted yet (window.activate runs after the 250ms animation),
        // so the previously-focused sibling would otherwise be excluded from
        // miniaturization candidates and nothing would shrink.
        const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, window);

        if (resizeResult?.success) {
            this.tilingManager._isSmartResizingBlocked = true;
            this.tilingManager._restoringWindowId = window.get_id();
            try {
                // Pass pending miniatures to tileWorkspaceWindows via instance state;
                // it'll skip animateReTiling for them and create miniatures itself.
                this.tilingManager._pendingMiniatureWindows = resizeResult.pendingWindows ?? [];
                this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
            } finally {
                this.tilingManager._isSmartResizingBlocked = false;
                this.tilingManager._restoringWindowId = null;
            }
        } else {
            this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
        }
    }

    _setupKeybindings() {
        const settings = this.getSettings('org.gnome.shell.extensions.mosaic-wm');

        Main.wm.addKeybinding('tile-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.LEFT_FULL));

        Main.wm.addKeybinding('tile-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.RIGHT_FULL));

        Main.wm.addKeybinding('tile-top-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.TOP_LEFT));

        Main.wm.addKeybinding('tile-top-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.TOP_RIGHT));

        Main.wm.addKeybinding('tile-bottom-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.BOTTOM_LEFT));

        Main.wm.addKeybinding('tile-bottom-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._tileActiveWindow(TileZone.BOTTOM_RIGHT));

        Logger.log('Registering swap-left keybinding');
        Main.wm.addKeybinding('swap-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('left'));

        Logger.log('Registering swap-right keybinding');
        Main.wm.addKeybinding('swap-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('right'));

        Logger.log('Registering swap-up keybinding');
        Main.wm.addKeybinding('swap-up', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('up'));

        Logger.log('Registering swap-down keybinding');
        Main.wm.addKeybinding('swap-down', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('down'));

        Logger.log('All swap keybindings registered successfully');
        Logger.log('Keyboard shortcuts registered');
    }

    _tileActiveWindow(zone) {
        const window = global.display.focus_window;
        if (!window) {
            Logger.log('No active window to tile');
            return;
        }

        if (this.windowingManager.isExcluded(window)) {
            Logger.log('Window is excluded from tiling');
            return;
        }

        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);

        Logger.log(`Keyboard shortcut: tiling window ${window.get_id()} to zone ${zone}`);
        this.edgeTilingManager.applyTile(window, zone, workArea);
    }

    _swapActiveWindow(direction) {
        Logger.log(`*** SWAP SHORTCUT TRIGGERED *** Direction: ${direction}`);
        const focusedWindow = global.display.get_focus_window();

        if (!focusedWindow) {
            Logger.log('SWAP FAILED: No focused window');
            return;
        }

        if (this.windowingManager.isExcluded(focusedWindow)) {
            Logger.log(`SWAP FAILED: Window ${focusedWindow.get_id()} is excluded`);
            return;
        }

        Logger.log(`SWAP: Calling swapping.swapWindow for window ${focusedWindow.get_id()} direction: ${direction}`);
        this.swappingManager.swapWindow(focusedWindow, direction);
        Logger.log('SWAP: swapWindow call completed');
    }

    disable() {
        Logger.log('Disabling extension');

        // Clear all managed timeouts first
        if (this._timeoutRegistry) {
            this._timeoutRegistry.clearAll();
        }

        Logger.info('Disabling Mosaic layout manager.');

        if (this._settingsOverrider) {
            this._settingsOverrider.destroy();
            this._settingsOverrider = null;
        }

        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        // Restore MonitorGroup._init prototype patch
        if (this._origMonitorGroupInit) {
            WorkspaceAnimation.MonitorGroup.prototype._init = this._origMonitorGroupInit;
            this._origMonitorGroupInit = null;
        }

        // Restore WindowPreview.boundingBox prototype patch
        if (this._origWindowPreviewBoundingBoxDesc) {
            Object.defineProperty(
                WindowPreviewModule.WindowPreview.prototype,
                'boundingBox',
                this._origWindowPreviewBoundingBoxDesc);
            this._origWindowPreviewBoundingBoxDesc = null;
        }

        Main.wm.removeKeybinding('tile-left');
        Main.wm.removeKeybinding('tile-right');
        Main.wm.removeKeybinding('tile-top-left');
        Main.wm.removeKeybinding('tile-top-right');
        Main.wm.removeKeybinding('tile-bottom-left');
        Main.wm.removeKeybinding('tile-bottom-right');
        Main.wm.removeKeybinding('swap-left');
        Main.wm.removeKeybinding('swap-right');
        Main.wm.removeKeybinding('swap-up');
        Main.wm.removeKeybinding('swap-down');
        Logger.log('Keyboard shortcuts removed');

        if (this.edgeTilingManager) this.edgeTilingManager.destroy();
        if (this.drawingManager) this.drawingManager.destroy();
        if (this.animationsManager) this.animationsManager.destroy();

        // Destroy Quick Settings indicator
        if (this._mosaicIndicator) {
            this._mosaicIndicator.destroy();
            this._mosaicIndicator = null;
        }

        if (this._focusWindowChangedId) {
            global.display.disconnect(this._focusWindowChangedId);
            this._focusWindowChangedId = 0;
        }

        if (this.miniatureManager) {
            // Disconnect listener first — otherwise restoreMiniature re-enters
            // _onMiniatureRestored, scheduling timeouts that fire after windowHandler is nulled.
            if (this._miniatureRestoredId)
                this.miniatureManager.disconnect(this._miniatureRestoredId);
            this._miniatureRestoredId = 0;
            // Restore miniatures to full size — otherwise users see scaled, click-dead windows post-disable.
            this.miniatureManager.restoreAllMiniatures();
            this.miniatureManager.destroy();
            this.miniatureManager = null;
        }

        this._miniatureCascadeIds = null;
        this._lastFocusedWindowId = null;

        delete global.MosaicExtension;

        if (this._tileTimeout && this._timeoutRegistry) {
            this._timeoutRegistry.remove(this._tileTimeout);
            this._tileTimeout = null;
        }
        for(const eventId of this._wmEventIds)
            global.window_manager.disconnect(eventId);
        for(const eventId of this._displayEventIds)
            global.display.disconnect(eventId);
        for(const eventId of this._workspaceManEventIds)
            global.workspace_manager.disconnect(eventId);
        for(const container of this._workspaceEventIds) {
            const workspace = container[0];
            const eventIds = container[1];
            eventIds.forEach((eventId) => workspace.disconnect(eventId));
        }

        if (this._onOverviewHiddenId) {
            Main.overview.disconnect(this._onOverviewHiddenId);
            this._onOverviewHiddenId = 0;
        }

        // Cleanup handled by WindowHandler and WindowState
        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        allWindows.forEach(w => {
            if (this.windowHandler) this.windowHandler.disconnectWindowSignals(w);
        });

        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];

        // Clean up managers (if they had cleanup methods)
        if (this.tilingManager) this.tilingManager.destroy();
        if (this.reorderingManager) this.reorderingManager.destroy();
        if (this.swappingManager) this.swappingManager.destroy();
        if (this.windowingManager) this.windowingManager.destroy();

        this.tilingManager = null;
        this.edgeTilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.windowingManager = null;
        this._timeoutRegistry = null;
        this._mutterSettings = null;
        this._settingsOverrider = null;
        this._injectionManager = null;
        this._workspaceManager = null;

        // Clean up handler classes
        if (this.resizeHandler) this.resizeHandler.destroy();
        if (this.dragHandler) this.dragHandler.destroy();
        if (this.windowHandler?.destroy) this.windowHandler.destroy();
        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;
    }
}
