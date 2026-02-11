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

import { WindowingManager } from './windowing.js';
import * as constants from './constants.js';

import { SettingsOverrider } from './settingsOverrider.js';

// Import new Managers
import { EdgeTilingManager } from './edgeTiling.js';
import { TileZone } from './constants.js';
import { TilingManager } from './tiling.js';
import { ReorderingManager } from './reordering.js';
import { SwappingManager } from './swapping.js';
import { DrawingManager } from './drawing.js';
import { AnimationsManager } from './animations.js';
import { MosaicLayoutStrategy } from './overviewLayout.js';
import { TimeoutRegistry, afterAnimations } from './timing.js';
import { WindowHandler } from './windowHandler.js';
import { DragHandler } from './dragHandler.js';
import { ResizeHandler } from './resizeHandler.js';
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
        
        this._injectionManager = null;
        
        // Centralized timeout management for async operations
        this._timeoutRegistry = new TimeoutRegistry();
        
        // Per-workspace toggle for mosaic behavior.
        this._disabledWorkspaceStates = new WeakMap();
    }
    
    isMosaicEnabledForWorkspace(workspace) {
        if (!workspace) return true;
        // If explicitly set to true in WeakMap, it is disabled. Otherwise enabled.
        return !this._disabledWorkspaceStates.get(workspace);
    }
    
    _updateIndicatorIcon() {
        if (this._mosaicIndicator) {
            this._mosaicIndicator._updateIcon();
        }
    }

    _tileWindowWorkspace(meta_window) {
        if(!meta_window) return;
        let workspace = meta_window.get_workspace();
        if(!workspace) return;
        this.tilingManager.tileWorkspaceWindows(workspace, 
                                      meta_window, 
                                      null, 
                                      false);
    }

    _tileAllWorkspaces = () => {
        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let nMonitors = global.display.get_n_monitors();
            for(let j = 0; j < nMonitors; j++)
                this.tilingManager.tileWorkspaceWindows(workspace, false, j, true);
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
            Logger.log(`[MOSAIC WM] Workspace switched from ${this._currentWorkspaceIndex} to ${newIndex}, saved ${this._currentWorkspaceIndex} as last visited`);
        }
        
        this._currentWorkspaceIndex = newIndex;
        
        // Wait for workspace switch animation to complete before any tiling operations
        // This prevents race conditions where tiling starts while animation is still running
        afterAnimations(this.animationsManager, () => {
            Logger.log(`[MOSAIC WM] Workspace animation complete - ready for operations on workspace ${newIndex}`);
        }, this._timeoutRegistry);
    };

    _workspaceAddSignal = (_, workspaceIdx) => {
        const workspace = this._workspaceManager.get_workspace_by_index(workspaceIdx);
        let eventIds = [];
        eventIds.push(workspace.connect("window-added", (ws, win) => this.windowHandler.onWindowAdded(ws, win)));
        eventIds.push(workspace.connect("window-removed", (ws, win) => this.windowHandler.onWindowRemoved(ws, win)));
        this._workspaceEventIds.push([workspace, eventIds]);
    };
    

    enable() {
        Logger.info("[MOSAIC WM]: Starting Mosaic layout manager.");

        // Get workspace manager reference
        this._workspaceManager = global.workspace_manager;
        
        // Initialize mutter settings + failsafe: Ensure attach-modal-dialogs is enabled
        // (in case extension crashed during Overview with setting disabled)
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        try {
            if (!this._mutterSettings.get_boolean('attach-modal-dialogs')) {
                this._mutterSettings.set_boolean('attach-modal-dialogs', true);
                Logger.log('[MOSAIC WM] Failsafe: Restored attach-modal-dialogs setting');
            }
        } catch (e) {
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
        
        // Create handler classes (receive extension reference)
        this.windowHandler = new WindowHandler(this);
        this.dragHandler = new DragHandler(this);
        this.resizeHandler = new ResizeHandler(this);
        
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
                        
                        // Fallback to Native GNOME layout if there are "floating" windows
                        // according to the user's request (Above, Sticky, or Maximized)
                        if (mw.is_above() || mw.is_on_all_workspaces() || 
                            (mw.maximized_horizontally && mw.maximized_vertically)) {
                            useMosaic = false;
                            break;
                        }
                    }
                }

                // Literal Fallback: use native GNOME strategy if not strictly mosaic
                if (!useMosaic) {
                    if (isEnabled) {
                         Logger.log(`[MOSAIC WM] Overview: Fallback to NATIVE (floating window detected)`);
                    }
                    this._layoutStrategy = null;
                    return originalMethod.apply(this, args);
                }

                Logger.log(`[MOSAIC WM] Overview: Using MOSAIC Strategy for monitor ${this._monitorIndex}`);
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
        this._displayEventIds.push(global.display.connect("grab-op-begin", (display, window, grabpo) => this.dragHandler._grabOpBeginHandler(display, window, grabpo)));
        this._displayEventIds.push(global.display.connect("grab-op-end", (display, window, grabpo) => this.dragHandler._grabOpEndHandler(display, window, grabpo)));
        this._onOverviewHiddenId = Main.overview.connect('hidden', () => this.windowHandler.onOverviewHidden());
        
        this._workspaceManEventIds.push(global.workspace_manager.connect("active-workspace-changed", this._workspaceSwitchedHandler));
        this._workspaceManEventIds.push(global.workspace_manager.connect("workspace-added", this._workspaceAddSignal));

        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let eventIds = [];
            eventIds.push(workspace.connect("window-added", (ws, win) => this.windowHandler.onWindowAdded(ws, win)));
            eventIds.push(workspace.connect("window-removed", (ws, win) => this.windowHandler.onWindowRemoved(ws, win)));
            this._workspaceEventIds.push([workspace, eventIds]);
        }
        
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let windows = workspace.list_windows();
            for (let window of windows) {
                // Initialize preferredSize if not set (for veteran windows)
                if (this.windowingManager.isRelated(window)) {
                    this.tilingManager.savePreferredSize(window);
                }
                
                // Always connect exclusion signals, even if excluded
                this.windowHandler.connectWindowSignals(window);
            }
        }

        Logger.log('[MOSAIC WM] About to call _setupKeybindings()');
        this._setupKeybindings();
        Logger.log('[MOSAIC WM] _setupKeybindings() completed');

        // Use GLib.timeout_add for better GJS integration
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.STARTUP_TILE_DELAY_MS, () => {
            this._tileAllWorkspaces();
            return GLib.SOURCE_REMOVE;
        });
    }

    _setupKeybindings() {
        Logger.log('[MOSAIC WM] *** _setupKeybindings called ***');
        
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
        
        Logger.log('[MOSAIC WM] Registering swap-left keybinding');
        Main.wm.addKeybinding('swap-left', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('left'));
        
        Logger.log('[MOSAIC WM] Registering swap-right keybinding');
        Main.wm.addKeybinding('swap-right', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('right'));
        
        Logger.log('[MOSAIC WM] Registering swap-up keybinding');
        Main.wm.addKeybinding('swap-up', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('up'));
        
        Logger.log('[MOSAIC WM] Registering swap-down keybinding');
        Main.wm.addKeybinding('swap-down', settings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL,
            () => this._swapActiveWindow('down'));
        
        Logger.log('[MOSAIC WM] All swap keybindings registered successfully');
        Logger.log('[MOSAIC WM] Keyboard shortcuts registered');
    }
    
    _tileActiveWindow(zone) {
        const window = global.display.focus_window;
        if (!window) {
            Logger.log('[MOSAIC WM] No active window to tile');
            return;
        }
        
        if (this.windowingManager.isExcluded(window)) {
            Logger.log('[MOSAIC WM] Window is excluded from tiling');
            return;
        }
        
        const workspace = window.get_workspace();
        const monitor = window.get_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitor);
        
        Logger.log(`[MOSAIC WM] Keyboard shortcut: tiling window ${window.get_id()} to zone ${zone}`);
        this.edgeTilingManager.applyTile(window, zone, workArea);
    }
    
    _swapActiveWindow(direction) {
        Logger.log(`[MOSAIC WM] *** SWAP SHORTCUT TRIGGERED *** Direction: ${direction}`);
        const focusedWindow = global.display.get_focus_window();
        
        if (!focusedWindow) {
            Logger.log('[MOSAIC WM] SWAP FAILED: No focused window');
            return;
        }
        
        if (this.windowingManager.isExcluded(focusedWindow)) {
            Logger.log(`[MOSAIC WM] SWAP FAILED: Window ${focusedWindow.get_id()} is excluded`);
            return;
        }
        
        Logger.log(`[MOSAIC WM] SWAP: Calling swapping.swapWindow for window ${focusedWindow.get_id()} direction: ${direction}`);
        this.swappingManager.swapWindow(focusedWindow, direction);
        Logger.log(`[MOSAIC WM] SWAP: swapWindow call completed`);
    }

    disable() {
        Logger.log('[MOSAIC WM] Disabling extension');
        
        // Clear all managed timeouts first
        if (this._timeoutRegistry) {
            this._timeoutRegistry.clearAll();
        }
        
        if (this._resizeDebounceTimeout) {
            GLib.source_remove(this._resizeDebounceTimeout);
            this._resizeDebounceTimeout = null;
        }
        Logger.info("[MOSAIC WM]: Disabling Mosaic layout manager.");
        
        if (this._settingsOverrider) {
            this._settingsOverrider.destroy();
            this._settingsOverrider = null;
        }
        
        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }
        
        // Restore original map animation
        if (this._originalMapWindow) {
            Main.wm._mapWindow = this._originalMapWindow;
            this._originalMapWindow = null;
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
        Logger.log('[MOSAIC WM] Keyboard shortcuts removed');
        
        if (this.dragHandler) this.dragHandler.destroy();

        if (this.edgeTilingManager) this.edgeTilingManager.destroy();
        if (this.drawingManager) this.drawingManager.destroy();
        if (this.animationsManager) this.animationsManager.destroy();
        
        // Destroy Quick Settings indicator
        if (this._mosaicIndicator) {
            this._mosaicIndicator.destroy();
            this._mosaicIndicator = null;
        }
        
        if (this._tileTimeout) {
            GLib.source_remove(this._tileTimeout);
            this._tileTimeout = null;
        }
        for(let eventId of this._wmEventIds)
            global.window_manager.disconnect(eventId);
        for(let eventId of this._displayEventIds)
            global.display.disconnect(eventId);
        for(let eventId of this._workspaceManEventIds)
            global.workspace_manager.disconnect(eventId);
        for(let container of this._workspaceEventIds) {
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
        
        if (this._workspaceChangeTimeout) {
            GLib.source_remove(this._workspaceChangeTimeout);
            this._workspaceChangeTimeout = null;
        }

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
        
        // Clean up handler classes
        this.windowHandler = null;
        this.dragHandler = null;
        this.resizeHandler = null;
    }
}