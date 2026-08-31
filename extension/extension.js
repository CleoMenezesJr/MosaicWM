// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Logger from './logger.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import * as WindowPreviewModule from 'resource:///org/gnome/shell/ui/windowPreview.js';

import { WindowingManager } from './windowing.js';
import * as constants from './constants.js';

import { SettingsOverrider } from './settingsOverrider.js';

import { EdgeTilingManager } from './edgeTiling.js';
import { TilingManager } from './tiling.js';
import { isWindowAlive, isWorkspaceAlive } from './liveness.js';
import { ReorderingManager } from './reordering.js';
import { SwappingManager } from './swapping.js';
import { DrawingManager } from './drawing.js';
import { AnimationsManager } from './animations.js';
import { MosaicLayoutStrategy } from './overviewLayout.js';
import { MosaicRenderer } from './mosaicRenderer.js';
import { TimeoutRegistry, createDebounced, afterAnimations } from './timing.js';
import { WindowHandler } from './windowHandler.js';
import { DragHandler } from './dragHandler.js';
import { ResizeHandler } from './resizeHandler.js';
import { MiniatureManager } from './miniature.js';
import * as WindowState from './windowState.js';
import { IS_MINIATURE, MINIATURE_SCALE, MINIATURE_EXT_LEFT, MINIATURE_EXT_TOP, MINIATURE_TARGET_POS, MINIATURE_OVERLAY } from './windowState.js';
import { MosaicIndicator } from './quickSettings.js';

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
        this._overflowInProgress = false;

        this._settingsOverrider = null;

        this.edgeTilingManager = null;
        this.tilingManager = null;
        this.reorderingManager = null;
        this.swappingManager = null;
        this.drawingManager = null;
        this.animationsManager = null;
        this.mosaicRenderer = null;
        this.windowingManager = null;

        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;

        this.miniatureManager    = null;
        this._miniatureCascadeIds  = null;
        this._lastFocusedWindowId  = null;
        this._focusWindowChangedId = 0;
        this._miniatureRestoredId  = 0;

        this._dnd = null;
        this._dndEnterId = 0;
        this._dndPositionId = 0;
        this._dndLeaveId = 0;
        this._dndActive = false;
        this._dndScheduleRestore = null;
        this._dndPendingWindowId = null;

        this._injectionManager = null;

        this._timeoutRegistry = null;

        this._disabledWorkspaceStates = new WeakMap();
        this._mosaicDisabledByDefault = false;
    }

    // Workspaces are created on demand, so the global toggle can't just stamp the
    // ones that exist when it's flipped: whatever is born later has to inherit its
    // decision. The map only holds per-workspace exceptions on top of that default.
    isMosaicEnabledForWorkspace(workspace) {
        if (!workspace) return true;
        const exception = this._disabledWorkspaceStates.get(workspace);
        if (exception !== undefined) return !exception;
        return !this._mosaicDisabledByDefault;
    }

    isMosaicEnabledAnywhere() {
        const workspaceManager = global.workspace_manager;
        const nWorkspaces = workspaceManager.get_n_workspaces();

        for (let i = 0; i < nWorkspaces; i++) {
            const workspace = workspaceManager.get_workspace_by_index(i);
            if (workspace && this.isMosaicEnabledForWorkspace(workspace))
                return true;
        }

        return false;
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

        // A window still mid-entrance was hidden expecting a tile pass that now
        // won't come, so hand it back its visibility here.
        if (this.windowHandler) {
            for (const window of workspace.list_windows())
                this.windowHandler.revealPendingEntrance(window);
        }

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

    // Flushes every workspace/monitor combo; flushToWindows no-ops on ones with no
    // recorded slots, so this is cheap even though most combos are empty.
    _flushMosaicToWindows() {
        const nWorkspaces = this._workspaceManager.get_n_workspaces();
        const nMonitors = global.display.get_n_monitors();
        for (let i = 0; i < nWorkspaces; i++) {
            const workspace = this._workspaceManager.get_workspace_by_index(i);
            for (let j = 0; j < nMonitors; j++)
                this.mosaicRenderer?.flushToWindows(workspace, j);
        }
    }

    _workspaceSwitchedHandler = () => {
        const newWorkspace = this._workspaceManager.get_active_workspace();
        const newIndex = newWorkspace.index();

        if (this._currentWorkspaceIndex !== null && this._currentWorkspaceIndex !== newIndex) {
            this._lastVisitedWorkspace = this._currentWorkspaceIndex;
            Logger.log(`[WORKSPACE SWITCH] WS-${this._currentWorkspaceIndex} -> WS-${newIndex} (Stored ${this._currentWorkspaceIndex} as last visited)`);
        }

        this._currentWorkspaceIndex = newIndex;

        // Tiling while the switch animation runs races it; wait until it finishes.
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

    // Drop bookkeeping for destroyed workspaces, since their signals die with
    // the object, and disconnecting them on disable() would target a dead GObject.
    _workspaceRemovedSignal = () => {
        this._workspaceEventIds = this._workspaceEventIds.filter(([workspace]) => isWorkspaceAlive(workspace, this._workspaceManager));
    };

    enable() {
        Logger.info('Starting Mosaic layout manager.');

        this._disabledWorkspaceStates = new WeakMap();
        this._mosaicDisabledByDefault = false;
        this._timeoutRegistry = new TimeoutRegistry();
        this._workspaceManager = global.workspace_manager;

        // SettingsOverrider already handles a stale override from a previous
        // crash (it restores the schema default when the current value equals
        // the override). Forcing the value here would clobber a user who
        // legitimately disabled attach-modal-dialogs.
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });

        this.edgeTilingManager = new EdgeTilingManager();
        this.tilingManager = new TilingManager();
        this.tilingManager.setExtension(this);
        this.reorderingManager = new ReorderingManager();
        this.swappingManager = new SwappingManager();
        this.drawingManager = new DrawingManager();
        this.animationsManager = new AnimationsManager();
        this.mosaicRenderer = new MosaicRenderer();
        this.windowingManager = new WindowingManager();

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
        this.edgeTilingManager.setTilingManager(this.tilingManager);
        this.edgeTilingManager.setWindowingManager(this.windowingManager);
        this.animationsManager.setTimeoutRegistry(this._timeoutRegistry);

        this.windowHandler = new WindowHandler(this);
        this.dragHandler = new DragHandler(this);
        this.resizeHandler = new ResizeHandler(this);

        this.miniatureManager = new MiniatureManager();
        this.miniatureManager.setTimeoutRegistry(this._timeoutRegistry);
        this.miniatureManager.setAnimationsManager(this.animationsManager);
        this.edgeTilingManager.setMiniatureManager(this.miniatureManager);
        this._miniatureCascadeIds = new Set();
        this._lastFocusedWindowId = null;

        this._miniatureRestoredId = this.miniatureManager.connect('miniature-restored',
            (_, window) => this._onMiniatureRestored(window));
        this._focusWindowChangedId = global.display.connect('notify::focus-window',
            () => this._onFocusWindowChanged());

        this._setupDndMiniatureRestore();

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

        this._overrideConflictingKeybindings();

        this._injectionManager = new InjectionManager();

        // Patch MonitorGroup._init to fix miniature clone positions and scale.
        //
        // GNOME Shell creates Clutter.Clone at (windowActor.x - monitor.x,
        // windowActor.y - monitor.y) with scale=1. For miniature windows, the
        // actor has set_scale + set_translation applied to visually shrink and
        // reposition the frame content at MINIATURE_TARGET_POS. However,
        // Clutter.Clone disables the source actor’s model-view transform during
        // clone paint, so set_scale/set_translation on the source are ignored.
        // The clone paints the source at full size with scale=1.
        //
        // We must apply the miniature scale directly on the clone (set_scale)
        // and position it at the visual frame location (MINIATURE_TARGET_POS),
        // accounting for CSD shadow extents that shift the frame within the actor.
        //
        // InjectionManager.overrideMethod does NOT work for GObject.registerClass
        // methods (resolved via vtable, not JS prototype). Direct prototype
        // replacement of _init DOES work, confirmed by the static-workspace-background
        // extension pattern.
        //
        // TODO: Contribute upstream to gnome-shell/js/ui/workspaceAnimation.js:
        // _createClone should propagate the source actor’s scale and position the
        // clone at the visual frame location, not the raw actor position. This
        // would allow extensions that use actor transforms (tiling WMs, magnifiers,
        // etc.) to work correctly with the native workspace switch animation.
        this._origMonitorGroupInit = WorkspaceAnimation.MonitorGroup.prototype._init;
        const origInit = this._origMonitorGroupInit;
        const extension = this;
        WorkspaceAnimation.MonitorGroup.prototype._init = function (monitor, workspaceIndices, movingWindow) {
            origInit.call(this, monitor, workspaceIndices, movingWindow);

            // After original _init, all WorkspaceGroups and their clones are created;
            // patch the miniature clones the shell just built.
            for (const wsGroup of this._workspaceGroups) {
                if (!wsGroup._windowRecords) continue;
                for (const record of wsGroup._windowRecords) {
                    extension._fixSwitchMiniatureClone(wsGroup, record, monitor);
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
        // TODO: Contribute upstream: Shell.WindowPreviewLayout should propagate
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

        // Mirror ICON_SIZE and ICON_OVERLAP from gnome-shell's windowPreview.js: the
        // icon rests with 30% of itself hanging below the preview's bottom edge.
        const PREVIEW_ICON_SIZE = 64;
        const PREVIEW_ICON_OVERLAP = 0.7;
        const previewProto = WindowPreviewModule.WindowPreview.prototype;

        // The shell already writes translation_y here to follow the preview's hover
        // growth, so our lift has to add to it rather than replace it. A window
        // restored from inside a static overview never re-runs _updateIconScale,
        // so re-check the flag instead of trusting the stored lift.
        this._injectionManager.overrideMethod(previewProto, '_adjustOverlayOffsets', originalMethod => {
            return function (...args) {
                originalMethod.apply(this, args);
                if (this._mosaicIconLift && WindowState.get(this.metaWindow, IS_MINIATURE))
                    this._icon.translation_y += this._mosaicIconLift;
            };
        });

        // For a miniature the icon starts centered on the preview (right where the
        // session icon was) and slides down to the native footer anchor. Driven by
        // the adjustment, not an ease, so a half-open swipe leaves it halfway.
        this._injectionManager.overrideMethod(previewProto, '_updateIconScale', originalMethod => {
            const extension = this;
            return function (...args) {
                const mw = this.metaWindow;
                const { currentState, initialState, finalState } =
                    this._overviewAdjustment.getStateTransitionParams();

                const throughPicker = extension._overviewGoesThroughPicker(initialState, finalState);

                if (!mw || !WindowState.get(mw, IS_MINIATURE) || !throughPicker || currentState > 1) {
                    this._mosaicIconLift = 0;
                    return originalMethod.apply(this, args);
                }

                const t = Math.max(0, Math.min(1, currentState));
                const container = this.window_container;

                // _init runs this before the actor is allocated or styled, so the live box
                // is empty and the icon has no preferred height yet. boundingBox is the
                // size state 0 starts from, and the icon is always ICON_SIZE tall.
                const allocH = container.allocation.get_height() * container.scale_y;
                const visualH = allocH > 0 ? allocH : this.boundingBox.height;
                const [, preferredIconH] = allocH > 0 ? this._icon.get_preferred_height(-1) : [0, 0];
                const iconH = preferredIconH || PREVIEW_ICON_SIZE;

                this._mosaicIconLift = (1 - t) * (iconH * (PREVIEW_ICON_OVERLAP - 0.5) - visualH / 2);
                this._icon.set({ scale_x: 1, scale_y: 1 });

                // Offsetting an empty box lands NaN in the overlay's translation. The lift still
                // has to land now, since the icon is already at scale 1 and the shell's next pass
                // is a frame too late; the term that pass adds is zero at scale 1 anyway.
                if (allocH > 0)
                    this._adjustOverlayOffsets();
                else
                    this._icon.translation_y = this._mosaicIconLift;
                return undefined;
            };
        });

        const layoutProto = Workspace.WorkspaceLayout.prototype;
        this._injectionManager.overrideMethod(layoutProto, '_createBestLayout', originalMethod => {
            const extension = this;
            return function (...args) {
                // Screenshot UI's window picker reuses WorkspaceLayout too, but its
                // window objects don't have metaWindow/source.metaWindow, so the
                // workspace lookup below would just fail and we'd hand back nothing.
                if (!Main.overview.visible)
                    return originalMethod.apply(this, args);

                // Opened from inside the overview, the screenshot picker slips past the
                // check above, and its windows carry no metaWindow to locate a workspace
                // with. Without this the mosaic strategy hands back an empty slot list.
                const workspace = extension._firstOverviewWorkspace(this._sortedWindows);
                if (!workspace)
                    return originalMethod.apply(this, args);

                const isEnabled = extension.isMosaicEnabledForWorkspace(workspace);
                const useMosaic = isEnabled && !extension._hasFloatingOverviewWindow(this._sortedWindows);

                if (!useMosaic) {
                    if (isEnabled) {
                        Logger.log('Overview: Fallback to NATIVE (floating window detected)');
                    }
                    this._layoutStrategy = null;
                    return originalMethod.apply(this, args);
                }

                Logger.log(`Overview: Using MOSAIC Strategy for monitor ${this._monitorIndex}`);
                extension.mosaicRenderer?.registerOverviewLayout(workspace, this._monitorIndex, this);
                this._layoutStrategy = new MosaicLayoutStrategy({
                    monitor: Main.layoutManager.monitors[this._monitorIndex],
                });
                return this._layoutStrategy.computeLayout(this._sortedWindows, ...args);
            };
        });

        // The picker's window captures at the top of open() need miniatures at
        // full size, but the frozen stage shot right after must see them scaled
        // again; resuming inside screenshot_stage_to_content splits the two.
        const screenshotProto = Screenshot.ScreenshotUI.prototype;
        this._injectionManager.overrideMethod(screenshotProto, 'open', originalMethod => {
            const extension = this;
            return function (...args) {
                extension.miniatureManager?.pauseForScreenshot();
                const result = originalMethod.apply(this, args);
                // no-op normally; clears the pause when open() returned early
                extension.miniatureManager?.resumeFromScreenshot();
                return result;
            };
        });
        this._injectionManager.overrideMethod(Shell.Screenshot.prototype, 'screenshot_stage_to_content', originalMethod => {
            const extension = this;
            return function (...args) {
                extension.miniatureManager?.resumeFromScreenshot();
                return originalMethod.apply(this, args);
            };
        });

        this._wmEventIds.push(global.window_manager.connect('size-change', (wm, win, mode) => this.resizeHandler.onSizeChange(wm, win, mode)));
        this._wmEventIds.push(global.window_manager.connect('size-changed', (wm, win) => this.resizeHandler.onSizeChanged(wm, win)));
        this._displayEventIds.push(global.display.connect('window-created', (_, window) => this.windowHandler.onWindowCreated(window)));
        this._wmEventIds.push(global.window_manager.connect('destroy', (_, win) => this.windowHandler.onWindowDestroyed(win.meta_window)));
        this._displayEventIds.push(global.display.connect('grab-op-begin', (display, window, grabpo) => this.dragHandler._grabOpBeginHandler(display, window, grabpo)));
        this._displayEventIds.push(global.display.connect('grab-op-end', (display, window, grabpo) => this.dragHandler._grabOpEndHandler(display, window, grabpo)));
        this._displayEventIds.push(global.display.connect('window-left-monitor', (_, monitor, window) => this.windowHandler.onWindowLeftMonitor(monitor, window)));
        this._displayEventIds.push(global.display.connect('window-entered-monitor', (_, monitor, window) => this.windowHandler.onWindowEnteredMonitor(monitor, window)));
        this._displayEventIds.push(global.display.connect('restacked', () => this.miniatureManager?.syncOverlayStacking()));
        this._onOverviewShowingId = Main.overview.connect('showing', () => {
            this.animationsManager.setOverviewActive(true);
            this.miniatureManager?.setOverviewActive(true);
        });
        // Mutter already accepts move_resize_frame here, so real windows are in place
        // before the closing animation finishes and nothing flashes untiled.
        this._onOverviewHidingId = Main.overview.connect('hiding', () => {
            Logger.log('[FLUSH] triggered by hiding');
            this._flushMosaicToWindows();
        });
        this._onOverviewHiddenId = Main.overview.connect('hidden', () => {
            this.animationsManager.setOverviewActive(false);
            this.miniatureManager?.setOverviewActive(false);
            // A slot can get recomputed between 'hiding' and 'hidden'; this catches that window's final value.
            Logger.log('[FLUSH] triggered by hidden');
            this._flushMosaicToWindows();
            this.mosaicRenderer?.clearOverviewLayouts();
        });

        this._workspaceManEventIds.push(global.workspace_manager.connect('active-workspace-changed', this._workspaceSwitchedHandler));
        this._workspaceManEventIds.push(global.workspace_manager.connect('workspaces-reordered', this._workspacesReorderedHandler));
        this._workspaceManEventIds.push(global.workspace_manager.connect('workspace-added', this._workspaceAddSignal));
        this._workspaceManEventIds.push(global.workspace_manager.connect('workspace-removed', this._workspaceRemovedSignal));

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

    _setupDndMiniatureRestore() {
        this._dnd = global.backend?.get_dnd() ?? null;
        if (!this._dnd) return;

        this._dndScheduleRestore = createDebounced(
            (window) => {
                this._dndPendingWindowId = null;
                if (isWindowAlive(window) && WindowState.get(window, WindowState.IS_MINIATURE))
                    this.miniatureManager?.restoreMiniature(window, null);
            },
            constants.DND_MINIATURE_RESTORE_DELAY_MS,
            this._timeoutRegistry
        );
        this._dndEnterId = this._dnd.connect('dnd-enter', this._onDndEnter.bind(this));
        this._dndPositionId = this._dnd.connect('dnd-position-change', this._onDndPositionChange.bind(this));
        this._dndLeaveId = this._dnd.connect('dnd-leave', this._onDndLeave.bind(this));
    }

    // Take only our combo off GNOME's list. Clearing the key would take its other bindings
    // with it, and unmaximize also carries Alt+F5.
    _releaseBinding(settings, key, combo) {
        const bindings = settings.get_strv(key);
        const remaining = bindings.filter(binding => binding !== combo);
        // Registered even when the combo is already gone, since that means a run took it and died
        // before disable(); bailing out here is what leaves the key without it for good.
        this._settingsOverrider.add(settings, key, new GLib.Variant('as', remaining));
    }

    // Clear the stock GNOME shortcuts that collide with ours, but only when they still hold
    // their default combo, so a user who rebound them keeps their choice.
    _overrideConflictingKeybindings() {
        const mutterKeybindings = new Gio.Settings({ schema_id: 'org.gnome.mutter.keybindings' });
        const emptyArray = new GLib.Variant('as', []);

        if (mutterKeybindings.get_strv('toggle-tiled-left').includes('<Super>Left')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-left', emptyArray);
        }
        if (mutterKeybindings.get_strv('toggle-tiled-right').includes('<Super>Right')) {
            this._settingsOverrider.add(mutterKeybindings, 'toggle-tiled-right', emptyArray);
        }

        const shellKeybindings = new Gio.Settings({ schema_id: 'org.gnome.shell.keybindings' });
        // Super+Alt+Up/Down is our swap-up/down default but also GNOME's stock
        // shift-overview-up/down, so clear GNOME's to keep the combo for recomposition.
        if (shellKeybindings.get_strv('shift-overview-up').includes('<Super><Alt>Up')) {
            this._settingsOverrider.add(shellKeybindings, 'shift-overview-up', emptyArray);
        }
        if (shellKeybindings.get_strv('shift-overview-down').includes('<Super><Alt>Down')) {
            this._settingsOverrider.add(shellKeybindings, 'shift-overview-down', emptyArray);
        }

        const wmKeybindings = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.keybindings' });
        this._releaseBinding(wmKeybindings, 'maximize', '<Super>Up');
        this._releaseBinding(wmKeybindings, 'unmaximize', '<Super>Down');
    }

    // A straight run to the app grid is one transition from 0 to 2, so currentState alone
    // would sweep through the picker and flash an icon the shell keeps hidden. At rest the
    // two endpoints collapse onto the current state, and _init lands there, so it gets placed.
    _overviewGoesThroughPicker(initialState, finalState) {
        const { ControlsState } = OverviewControls;
        return initialState === finalState ||
            initialState === ControlsState.WINDOW_PICKER ||
            finalState === ControlsState.WINDOW_PICKER;
    }

    // Clutter.Clone disables the source actor's model-view transform during clone paint,
    // so set_scale/set_translation on the source are ignored. Apply the miniature scale
    // directly on the clone and place it at the visual frame location (MINIATURE_TARGET_POS).
    _fixSwitchMiniatureClone(wsGroup, record, monitor) {
        const metaWindow = record.windowActor.meta_window;
        if (!WindowState.get(metaWindow, IS_MINIATURE)) return;

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

        // _createClone only ever sees the window actor, and the icon overlay is its
        // sibling, so the icon would vanish for the whole slide. The overlay already
        // sits at frame scale, hence no set_scale.
        const overlay = WindowState.get(metaWindow, MINIATURE_OVERLAY);
        if (overlay && tgt) {
            const iconClone = new Clutter.Clone({
                source: overlay,
                x: tgt.x - monitor.x,
                y: tgt.y - monitor.y,
            });
            overlay.connectObject('destroy', () => iconClone.destroy(), iconClone);
            wsGroup.add_child(iconClone);
        }
    }

    // The screenshot picker reuses WorkspaceLayout with window objects that carry no
    // metaWindow, so a miss here (null) is the signal to leave the native layout alone.
    _firstOverviewWorkspace(sortedWindows) {
        for (const win of sortedWindows) {
            const mw = win.metaWindow || win.source?.metaWindow;
            const workspace = mw?.get_workspace();
            if (workspace) return workspace;
        }
        return null;
    }

    _hasFloatingOverviewWindow(sortedWindows) {
        return sortedWindows.some(win => {
            const mw = win.metaWindow || win.source?.metaWindow;
            return mw && this._isFloatingWindow(mw);
        });
    }

    // Non-mosaic windows the overview must lay out natively: anything raised out of the
    // tiling flow (Above, Sticky, Fullscreen, Modals, Transients, or Minimized).
    _isFloatingWindow(mw) {
        return mw.minimized ||
            mw.is_above() || this.windowingManager.isTrulySticky(mw) ||
            mw.is_fullscreen() ||
            mw.get_window_type() === Meta.WindowType.MODAL_DIALOG ||
            mw.is_attached_dialog() ||
            mw.get_transient_for() !== null;
    }

    _onFocusWindowChanged() {
        const window = global.display.focus_window;
        if (!window) return;

        const prevFocusedId = this._lastFocusedWindowId;
        this._lastFocusedWindowId = window.get_id();

        if (!this._focusEligibleForRestore(window)) return;

        const windowId = window.get_id();
        Logger.log(`[FOCUS] Miniature focused ${windowId} (prev=${prevFocusedId}) cascade=${this._miniatureCascadeIds?.has(windowId)}`);

        // A cascade auto-focus doesn't get to restore; only a deliberate re-focus does.
        if (this._miniatureCascadeIds?.has(windowId) &&
            !this._resolveCascadeFocus(window, windowId, prevFocusedId)) {
            return;
        }

        Logger.log(`[FOCUS] Triggering restore ${windowId}`);
        this._miniatureCascadeIds.clear();
        this.tilingManager._isSmartResizingBlocked = true;
        WindowState.set(window, 'restoringFromMiniature', true);

        this.miniatureManager.restoreMiniature(window, null);
        // 'miniature-restored' signal fires synchronously → _onMiniatureRestored runs next
    }

    // Only a miniature that the user could sensibly want back qualifies; a maximized,
    // excluded, or just-miniaturized window, or one mid smart-resize, is left alone.
    _focusEligibleForRestore(window) {
        if (!this.windowingManager.isRelated(window)) return false;
        if (this.windowingManager.isExcluded(window)) return false;
        if (this.windowingManager.isMaximizedOrFullscreen(window)) return false;
        if (!WindowState.get(window, IS_MINIATURE)) return false;
        if (WindowState.get(window, 'justMiniaturized')) {
            Logger.log(`[FOCUS] Skip restore ${window.get_id()}: justMiniaturized`);
            return false;
        }
        if (this.tilingManager._isSmartResizingBlocked) {
            Logger.log(`[FOCUS] Skip restore ${window.get_id()}: smartResizingBlocked`);
            return false;
        }
        return true;
    }

    // Returns true to let the restore proceed (deliberate re-focus), false when it was an
    // auto-focus during a cascade, which instead hands focus to a non-miniature window.
    _resolveCascadeFocus(window, windowId, prevFocusedId) {
        if (prevFocusedId !== windowId) {
            Logger.log(`[FOCUS] Allow restore ${windowId} (deliberate, prev=${prevFocusedId})`);
            this._miniatureCascadeIds.delete(windowId);
            return true;
        }

        const ws  = window.get_workspace();
        const mon = window.get_monitor();
        const nonMiniature = this.windowingManager.getMonitorWorkspaceWindows(ws, mon)
            .find(w => !WindowState.get(w, IS_MINIATURE) && !this.windowingManager.isExcluded(w));
        Logger.log(`[FOCUS] Block cascade restore ${windowId} → activating ${nonMiniature?.get_id() ?? 'none'}`);
        if (nonMiniature) nonMiniature.activate(global.get_current_time());
        return false;
    }

    _onMiniatureRestored(window) {
        if (this._dndPendingWindowId === window.get_id()) {
            this._dndScheduleRestore?.cancel();
            this._dndPendingWindowId = null;
        }
        Logger.log(`[FOCUS] _onMiniatureRestored ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): running smart resize`);
        WindowState.remove(window, 'restoringFromMiniature');
        this.tilingManager._isSmartResizingBlocked = false;

        const workspace = window.get_workspace();
        if (!workspace) return;
        if (!this.isMosaicEnabledForWorkspace(workspace)) return;

        // A drop's preview cleanup restores several miniatures in a row; retiling per restore
        // re-miniaturizes them mid-drag and ping-pongs into a storm. The drag's own drop retile
        // handles layout, so skip this heavy pass while that cleanup is running.
        if (this.dragHandler?._suppressRestoreRetile) return;

        const monitor = window.get_monitor();
        const workArea = this.tilingManager.getUsableWorkArea(workspace, monitor);

        const existingWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w =>
                isWindowAlive(w) &&
                w.get_id() !== window.get_id() &&
                !this.edgeTilingManager.isEdgeTiled(w) &&
                !WindowState.get(w, 'pendingInQueue') &&
                !this.windowingManager.isExcluded(w) &&
                !this.windowingManager.isMaximizedOrFullscreen(w)
            );

        // Treat the restored window as the user-focused one, since Mutter's focus
        // hasn't shifted yet (window.activate runs after the 250ms animation),
        // so the previously-focused sibling would otherwise be excluded from
        // miniaturization candidates and nothing would shrink.
        const resizeResult = this.tilingManager.tryFitWithResize(window, existingWindows, workArea, workspace, window);

        const doTile = () => {
            if (resizeResult?.success) {
                this.tilingManager._isSmartResizingBlocked = true;
                this.tilingManager._restoringWindowId = window.get_id();
                try {
                    this.tilingManager._pendingMiniatureWindows = resizeResult.pendingWindows ?? [];
                    this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, false);
                } finally {
                    this.tilingManager._isSmartResizingBlocked = false;
                    this.tilingManager._restoringWindowId = null;
                }
            } else {
                this.tilingManager.tileWorkspaceWindows(workspace, window, monitor, false);
            }

            // restoreMiniature only undoes the scale, not the frame. If this was last
            // shrunk via Smart Resize's skip-resize miniaturize path, the real frame
            // is still pre-restore size, so give reverse smart resize a chance to grow it back.
            const allWindows = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
            const grew = this.tilingManager.tryRestoreWindowSizes(allWindows, workArea, null, null, workspace, monitor);
            if (grew) {
                this._timeoutRegistry.add(constants.RESIZE_SETTLE_DELAY_MS, () => {
                    for (const w of allWindows) {
                        WindowState.remove(w, 'isReverseSmartResizing');
                    }
                    this.tilingManager.tileWorkspaceWindows(workspace, null, monitor, true);
                    this._tryCascadeMiniatureRestore(workspace, monitor);
                    return GLib.SOURCE_REMOVE;
                }, 'miniatureRestoreGrowSettle');
            } else {
                this._tryCascadeMiniatureRestore(workspace, monitor);
            }
        };

        doTile();
    }

    // One restore can leave enough room for the next MRU miniature too; restoreMiniature
    // fires this same handler synchronously, so this just keeps the chain going until
    // nothing else fits, the same way a single window leaving already restores one.
    _tryCascadeMiniatureRestore(workspace, monitor) {
        if (this.dragHandler?._suppressRestoreRetile) return;

        const remaining = this.windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
            .filter(w => !this.edgeTilingManager.isEdgeTiled(w) && !this.windowingManager.isExcluded(w));
        this.windowHandler?._tryAutoRestoreMiniature(remaining, workspace, monitor);
    }

    _onDndEnter() {
        this._dndActive = true;
    }

    _onDndPositionChange(_dnd, x, y) {
        if (!this._dndActive || !this.miniatureManager) return;
        const window = this.miniatureManager.findMiniatureAtPoint(x, y);
        if (window) {
            if (this._dndPendingWindowId === window.get_id()) return;
            this._dndPendingWindowId = window.get_id();
            this._dndScheduleRestore(window);
        } else {
            this._dndScheduleRestore.cancel();
            this._dndPendingWindowId = null;
        }
    }

    _onDndLeave() {
        this._dndActive = false;
        this._dndScheduleRestore?.cancel();
        this._dndPendingWindowId = null;
    }

    _setupKeybindings() {
        const settings = this.getSettings('org.gnome.shell.extensions.mosaic-wm');

        Main.wm.addKeybinding('tile-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._onArrowShortcut('left'));

        Main.wm.addKeybinding('tile-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._onArrowShortcut('right'));

        Main.wm.addKeybinding('maximize-window', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._onArrowShortcut('up'));

        Main.wm.addKeybinding('restore-window', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._onArrowShortcut('down'));

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

    _onArrowShortcut(direction) {
        const window = global.display.focus_window;
        if (!window) return;

        const workspace = window.get_workspace();

        // Super+Up/Down are GNOME's for every window we don't manage, so swallowing the key
        // here would strip maximize from dialogs and from mosaic-disabled workspaces.
        if (!workspace || this.windowingManager.isExcluded(window) ||
            !this.isMosaicEnabledForWorkspace(workspace)) {
            this._applyStockVertical(window, direction);
            return;
        }

        const intent = this.edgeTilingManager.resolveArrowIntent(window, direction);
        Logger.log(`Arrow ${direction} on window ${window.get_id()}: intent=${intent.kind}${intent.zone ? ` zone=${intent.zone}` : ''}`);
        this._applyArrowIntent(window, workspace, intent);
    }

    _applyArrowIntent(window, workspace, intent) {
        switch (intent.kind) {
            case 'tile': {
                const workArea = workspace.get_work_area_for_monitor(window.get_monitor());
                this.edgeTilingManager.applyTile(window, intent.zone, workArea);
                break;
            }
            case 'restore':
                this._restoreWindow(window);
                break;
            case 'unmaximize':
                window.unmaximize();
                break;
            case 'swap':
                this.swappingManager.swapWindow(window, intent.direction);
                break;
            case 'maximize':
                if (window.can_maximize()) window.maximize();
                break;
        }
    }

    // Mirrors the stock handlers we replaced, which never force a window that says it can't.
    // The side arrows come through here too, so both branches have to name their direction.
    _applyStockVertical(window, direction) {
        if (direction === 'up' && window.can_maximize()) window.maximize();
        else if (direction === 'down' && window.is_maximized()) window.unmaximize();
    }

    _restoreWindow(window) {
        if (this.edgeTilingManager.isEdgeTiled(window)) {
            this.edgeTilingManager.removeTile(window, () => {
                if (!isWindowAlive(window)) return;
                this.tilingManager.tileWorkspaceWindows(
                    window.get_workspace(), null, window.get_monitor());
            });
        }
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

    // Phases run in the same order the old flat method did; teardown order is load-bearing
    // (e.g. the miniature listener comes off before restore, handlers destroy before refs null).
    disable() {
        Logger.log('Disabling extension');

        if (this._timeoutRegistry) {
            this._timeoutRegistry.clearAll();
        }

        Logger.info('Disabling Mosaic layout manager.');

        this._teardownOverrides();
        this._removeKeybindings();
        this._teardownEarlyManagers();
        this._teardownDnd();
        this._teardownMiniatures();
        this._disconnectSignals();
        this._destroyManagersAndClearRefs();
    }

    _teardownOverrides() {
        if (this._settingsOverrider) {
            this._settingsOverrider.destroy();
            this._settingsOverrider = null;
        }

        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        if (this._origMonitorGroupInit) {
            WorkspaceAnimation.MonitorGroup.prototype._init = this._origMonitorGroupInit;
            this._origMonitorGroupInit = null;
        }

        if (this._origWindowPreviewBoundingBoxDesc) {
            Object.defineProperty(
                WindowPreviewModule.WindowPreview.prototype,
                'boundingBox',
                this._origWindowPreviewBoundingBoxDesc);
            this._origWindowPreviewBoundingBoxDesc = null;
        }
    }

    _removeKeybindings() {
        Main.wm.removeKeybinding('tile-left');
        Main.wm.removeKeybinding('tile-right');
        Main.wm.removeKeybinding('maximize-window');
        Main.wm.removeKeybinding('restore-window');
        Main.wm.removeKeybinding('swap-left');
        Main.wm.removeKeybinding('swap-right');
        Main.wm.removeKeybinding('swap-up');
        Main.wm.removeKeybinding('swap-down');
        Logger.log('Keyboard shortcuts removed');
    }

    _teardownEarlyManagers() {
        if (this.edgeTilingManager) this.edgeTilingManager.destroy();
        if (this.drawingManager) this.drawingManager.destroy();
        if (this.animationsManager) this.animationsManager.destroy();

        if (this._mosaicIndicator) {
            this._mosaicIndicator.destroy();
            this._mosaicIndicator = null;
        }

        if (this._focusWindowChangedId) {
            global.display.disconnect(this._focusWindowChangedId);
            this._focusWindowChangedId = 0;
        }
    }

    _teardownDnd() {
        if (this._dnd) {
            if (this._dndEnterId) this._dnd.disconnect(this._dndEnterId);
            if (this._dndPositionId) this._dnd.disconnect(this._dndPositionId);
            if (this._dndLeaveId) this._dnd.disconnect(this._dndLeaveId);
            this._dndEnterId = 0;
            this._dndPositionId = 0;
            this._dndLeaveId = 0;
            this._dnd = null;
        }
        this._dndScheduleRestore?.cancel();
        this._dndScheduleRestore = null;
        this._dndActive = false;
        this._dndPendingWindowId = null;
    }

    _teardownMiniatures() {
        if (this.miniatureManager) {
            // Disconnect listener first, otherwise restoreMiniature re-enters
            // _onMiniatureRestored, scheduling timeouts that fire after windowHandler is nulled.
            if (this._miniatureRestoredId)
                this.miniatureManager.disconnect(this._miniatureRestoredId);
            this._miniatureRestoredId = 0;
            // Restore miniatures to full size, otherwise users see scaled, click-dead windows post-disable.
            this.miniatureManager.restoreAllMiniatures();
            this.miniatureManager.destroy();
            this.miniatureManager = null;
        }

        this._miniatureCascadeIds = null;
        this._lastFocusedWindowId = null;
    }

    _disconnectSignals() {
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

        if (this._onOverviewShowingId) {
            Main.overview.disconnect(this._onOverviewShowingId);
            this._onOverviewShowingId = 0;
        }
        if (this._onOverviewHidingId) {
            Main.overview.disconnect(this._onOverviewHidingId);
            this._onOverviewHidingId = 0;
        }
        if (this._onOverviewHiddenId) {
            Main.overview.disconnect(this._onOverviewHiddenId);
            this._onOverviewHiddenId = 0;
        }

        const allWindows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        allWindows.forEach(w => {
            if (this.windowHandler) this.windowHandler.disconnectWindowSignals(w);
        });

        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];
    }

    _destroyManagersAndClearRefs() {
        // Clean up handler classes before nulling shared refs, since their destroy()
        // reaches the timeout registry through the extension reference.
        if (this.resizeHandler) this.resizeHandler.destroy();
        if (this.dragHandler) this.dragHandler.destroy();
        if (this.windowHandler?.destroy) this.windowHandler.destroy();
        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;

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
        this.mosaicRenderer?.destroy();
        this.mosaicRenderer = null;
        this.windowingManager = null;
        this._timeoutRegistry = null;
        this._mutterSettings = null;
        this._settingsOverrider = null;
        this._injectionManager = null;
        this._workspaceManager = null;
    }
}
