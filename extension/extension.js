/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* exported init */
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import Meta from 'gi://Meta';
import * as windowing from './windowing.js';
import * as tiling from './tiling.js';
import * as drawing from './drawing.js';
import * as reordering from './reordering.js';
import * as constants from './constants.js';

function tileWindowWorkspace(meta_window) {
    if(!meta_window) return;
    let workspace = meta_window.get_workspace();
    if(!workspace) return;
    tiling.tileWorkspaceWindows(workspace, 
                                  meta_window, 
                                  null, 
                                  false);
}

export default class WindowMosaicExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = []; // Tracks workspace-level event connections
        this._maximizedWindows = [];
        this._workspaceManager = global.workspace_manager;
        this._sizeChanged = false;
        this._tileTimeout = null;
        this._windowWorkspaceSignals = new Map(); // window_id -> signal_id for workspace-changed
        this._workspaceChangeTimeout = null; // Debounce timeout for manual workspace changes
    }

    _tileAllWorkspaces = () => {
        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            // Recurse all monitors
            let nMonitors = global.display.get_n_monitors();
            for(let j = 0; j < nMonitors; j++)
                tiling.tileWorkspaceWindows(workspace, false, j, true);
        }
    }

    /**
     * Handler called when a new window is created in the display.
     * 
     * OVERFLOW FLOW (Main requirement):
     * 1. Every new window goes through space optimization calculation
     * 2. If it fits in current workspace → add to tiling
     * 3. If it DOESN'T fit → move to new workspace
     * 
     * SPECIAL RULES:
     * - Workspace with maximized window = completely occupied
     * - Maximized window with other apps → move maximized to new workspace
     * 
     * @param {Meta.Display} _ - The display (unused)
     * @param {Meta.Window} window - The newly created window
     */
    _windowCreatedHandler = (_, window) => {
        let timeout = setInterval(() => {
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();
            
            // Ensure window is valid before any action
            if( monitor !== null &&
                window.wm_class !== null &&
                window.get_compositor_private() &&
                workspace.list_windows().length !== 0 &&
                !window.is_hidden())
            {
                clearTimeout(timeout);
                
                // Check if window should be managed (includes blacklist check)
                if(windowing.isExcluded(window)) {
                    console.log('[MOSAIC WM] Window excluded from tiling');
                    return; // Window should not be managed (dialog, blacklisted, etc.)
                }
                
                // CASE 1: Window is maximized/fullscreen AND there are other apps in workspace
                // → Move maximized window to new workspace
                // IMPORTANT: Only move if workspace is NOT empty (has other windows)
                if(windowing.isMaximizedOrFullscreen(window)) {
                    const workspaceWindows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
                    
                    // Only move to new workspace if there are OTHER windows (length > 1)
                    // If workspace is empty or only has this window, keep it here
                    if(workspaceWindows.length > 1) {
                        console.log('[MOSAIC WM] Maximized window with other apps - moving to new workspace');
                        windowing.moveOversizedWindow(window);
                        return;
                    } else {
                        console.log('[MOSAIC WM] Maximized window in empty workspace - keeping here');
                        // Don't move, just tile normally (will be alone in workspace)
                        tiling.tileWorkspaceWindows(workspace, window, monitor, false);
                        return;
                    }
                }
                
                // CASE 2: Check if window FITS in current workspace
                // Uses canFitWindow() which checks:
                // - If workspace has maximized window (= occupied)
                // - If adding would cause overflow
                const canFit = tiling.canFitWindow(window, workspace, monitor);
                
                if(!canFit) {
                    // DOESN'T FIT → Create new workspace and move window
                    console.log('[MOSAIC WM] Window doesn\'t fit - moving to new workspace');
                    windowing.moveOversizedWindow(window);
                } else {
                    // FITS → Add to tiling in current workspace
                    console.log('[MOSAIC WM] Window fits - adding to tiling');
                    tiling.tileWorkspaceWindows(workspace, window, monitor, false);
                }
                
                // Connect workspace-changed signal to detect manual window movement
                this._connectWindowWorkspaceSignal(window);
            }
        }, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS);
    }

    _destroyedHandler = (_, win) => {
        let window = win.meta_window;
        let monitor = window.get_monitor();
        
        // Disconnect workspace-changed signal
        this._disconnectWindowWorkspaceSignal(window);
        
        // Only process if window was managed (not excluded/blacklisted)
        if(windowing.isExcluded(window)) {
            console.log('[MOSAIC WM] Excluded window closed - no workspace navigation');
            return;
        }
        
        if(monitor === global.display.get_primary_monitor()) {
            const workspace = windowing.getWorkspace();
            
            // Re-tile workspace after window is closed
            // Use null as reference to tile all remaining windows
            tiling.tileWorkspaceWindows(workspace, 
                null,  // No reference window - tile all windows
                monitor,
                true);
            
            // Check if workspace is now empty and navigate to previous if so
            const windows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
            const managedWindows = windows.filter(w => !windowing.isExcluded(w));
            
            if (managedWindows.length === 0) {
                console.log('[MOSAIC WM] Workspace is empty - navigating to previous workspace');
                
                const previousWorkspace = workspace.get_neighbor(Meta.MotionDirection.LEFT);
                
                if (previousWorkspace && previousWorkspace.index() !== workspace.index()) {
                    previousWorkspace.activate(global.get_current_time());
                    console.log(`[MOSAIC WM] Navigated to workspace ${previousWorkspace.index()}`);
                } else {
                    const nextWorkspace = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
                    
                    if (nextWorkspace && nextWorkspace.index() !== workspace.index()) {
                        nextWorkspace.activate(global.get_current_time());
                        console.log(`[MOSAIC WM] Navigated to workspace ${nextWorkspace.index()}`);
                    }
                }
            }
        }
    }
    
    _switchWorkspaceHandler = (_, win) => {
        tileWindowWorkspace(win.meta_window); // Tile when switching to a workspace. Helps to create a more cohesive experience.
    }

    /**
     * Handler for manual window movement between workspaces.
     * Uses debounce to avoid interrupting rapid navigation.
     * 
     * @param {Meta.Window} window - The window that changed workspace
     */
    _windowWorkspaceChangedHandler = (window) => {
        // Clear any existing debounce timeout
        if (this._workspaceChangeTimeout) {
            clearTimeout(this._workspaceChangeTimeout);
        }
        
        // Debounce: wait 500ms before checking overflow
        // This allows user to navigate through multiple workspaces without interruption
        this._workspaceChangeTimeout = setTimeout(() => {
            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            
            // Skip if window is excluded
            if (windowing.isExcluded(window)) {
                return;
            }
            
            // Check if window fits in new workspace
            const canFit = tiling.canFitWindow(window, workspace, monitor);
            
            if (!canFit) {
                console.log('[MOSAIC WM] Manual move: window doesn\'t fit - moving to new workspace');
                windowing.moveOversizedWindow(window);
            } else {
                console.log('[MOSAIC WM] Manual move: window fits - tiling');
                tiling.tileWorkspaceWindows(workspace, window, monitor, false);
            }
        }, 500); // 500ms debounce
    }

    /**
     * Connect workspace-changed signal for a window.
     * 
     * @param {Meta.Window} window - The window to track
     */
    _connectWindowWorkspaceSignal(window) {
        const signalId = window.connect('workspace-changed', () => {
            this._windowWorkspaceChangedHandler(window);
        });
        this._windowWorkspaceSignals.set(window.get_id(), signalId);
    }

    /**
     * Disconnect workspace-changed signal for a window.
     * 
     * @param {Meta.Window} window - The window to stop tracking
     */
    _disconnectWindowWorkspaceSignal(window) {
        const windowId = window.get_id();
        const signalId = this._windowWorkspaceSignals.get(windowId);
        if (signalId) {
            window.disconnect(signalId);
            this._windowWorkspaceSignals.delete(windowId);
        }
    }

    /**
     * Handler called when a window's size changes (maximize/unmaximize/fullscreen).
     * Moves maximized/fullscreen windows to a new workspace if they're not alone.
     * 
     * @param {Meta.WindowManager} _ - The window manager (unused)
     * @param {Meta.WindowActor} win - The window actor
     * @param {number} mode - The size change mode (0=maximize, 1=unmaximize, 2=maximize, 3=unmaximize)
     */
    _sizeChangeHandler = (_, win, mode) => {
        let window = win.meta_window;
        if(!windowing.isExcluded(window)) {
            let id = window.get_id();
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();

            if(mode === 2 || mode === 0) { // If the window was maximized
                if(windowing.isMaximizedOrFullscreen(window) && windowing.getMonitorWorkspaceWindows(workspace, monitor).length > 1) {
                    // If maximized/fullscreen (and not alone), move to new workspace and activate it if it is on the active workspace
                    let newWorkspace = windowing.moveOversizedWindow(window);
                    /* We mark the window as activated by using its id to index an array
                        We put the value as the active workspace index so that if the workspace anatomy
                        of the current workspace changes, it does not move the maximized window to an unrelated
                        window.
                    */
                    if(newWorkspace) {
                        this._maximizedWindows[id] = {
                            workspace: newWorkspace.index(),
                            monitor: monitor
                        }; // Mark window as maximized
                        tiling.tileWorkspaceWindows(workspace, false, monitor, false); // Sort the workspace where the window came from
                    }
                }
            } else if(false && (mode === 3 || mode === 1)) { // If the window was unmaximized
                if( !windowing.isMaximizedOrFullscreen(window) && // If window is not maximized
                    this._maximizedWindows[id] &&
                    windowing.getMonitorWorkspaceWindows(workspace, monitor).length === 1// If the workspace anatomy has not changed
                ) {
                    if( this._maximizedWindows[id].workspace === workspace.index() &&
                        this._maximizedWindows[id].monitor === monitor
                    ) {
                        this._maximizedWindows[id] = false;
                        windowing.moveBackWindow(window); // Move the window back to its workspace
                        tileWindowWorkspace(window);
                    }
                }
            }
        }
    }

    _sizeChangedHandler = (_, win) => {
        let window = win.meta_window;
        if(!this._sizeChanged && !windowing.isExcluded(window)) {
            // Live resizing
            this._sizeChanged = true;
            tiling.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), true);
            this._sizeChanged = false;
        }
    }

    /**
     * Handler called when a grab operation begins (window is being moved or resized).
     * Starts the drag-and-drop reordering process if the window is being moved.
     * 
     * @param {Meta.Display} _ - The display (unused)
     * @param {Meta.Window} window - The window being grabbed
     * @param {number} grabpo - The grab operation type
     */
    _grabOpBeginHandler = (_, window, grabpo) => {
        if( !windowing.isExcluded(window) &&
            (grabpo === 1 || grabpo === 1025) && // When a window has moved
            !(windowing.isMaximizedOrFullscreen(window)))
            reordering.startDrag(window);
        // tileWindowWorkspace(window);
    }
    
    /**
     * Handler called when a grab operation ends (window released after move/resize).
     * Stops the drag operation and re-tiles the workspace if needed.
     * 
     * @param {Meta.Display} _ - The display (unused)
     * @param {Meta.Window} window - The window that was grabbed
     * @param {number} grabpo - The grab operation type
     */
    _grabOpEndHandler = (_, window, grabpo) => {
        if(!windowing.isExcluded(window)) {
            reordering.stopDrag(window);
            if( (grabpo === 1 || grabpo === 1025) && // When a window has moved
                !(windowing.isMaximizedOrFullscreen(window)))
            {
                tiling.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), false);
            }
            if(grabpo === 25601) // When released from resizing
                tileWindowWorkspace(window);
        } else
            reordering.stopDrag(window, true);
    }

    /**
     * Handler called when a window is added to a workspace.
     * This is triggered by workspace.connect('window-added').
     * Tiles the workspace after a short delay to ensure the window is fully added.
     * 
     * @param {Meta.Workspace} workspace - The workspace that received the window
     * @param {Meta.Window} window - The window that was added
     */
    _windowAdded = (workspace, window) => {
        let timeout = setInterval(() => {
            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (tiling.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                clearTimeout(timeout);
                tiling.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
            }
        }, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS);
    }

    /**
     * Handler called when a window is removed from a workspace.
     * This is triggered by workspace.connect('window-removed').
     * Re-tiles the workspace and handles workspace navigation if empty.
     * 
     * @param {Meta.Workspace} workspace - The workspace that lost the window
     * @param {Meta.Window} window - The window that was removed
     */
    _windowRemoved = (workspace, window) => {
        let timeout = setInterval(() => {
            const WORKSPACE = window.get_workspace();
            const WINDOW = window;
            const MONITOR = global.display.get_primary_monitor();

            if (tiling.checkValidity(MONITOR, WORKSPACE, WINDOW, false)) {
                clearTimeout(timeout);
                tiling.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
            } else {
                clearTimeout(timeout);
                return;
            }
        }, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS);
    }

    /**
     * Handler called when a new workspace is added to the workspace manager.
     * Connects window-added and window-removed listeners to the new workspace.
     * 
     * @param {Meta.WorkspaceManager} _ - The workspace manager (unused)
     * @param {number} workspaceIdx - The index of the newly added workspace
     */
    _workspaceAddSignal = (_, workspaceIdx) => {
        const workspace = this._workspaceManager.get_workspace_by_index(workspaceIdx);
        let eventIds = [];
        eventIds.push(workspace.connect("window-added", this._windowAdded));
        eventIds.push(workspace.connect("window-removed", this._windowRemoved));
        this._workspaceEventIds.push([workspace, eventIds]);
    }

    enable() {
        console.log("[MOSAIC WM]: Starting Mosaic layout manager.");
        
        this._wmEventIds.push(global.window_manager.connect('size-change', this._sizeChangeHandler));
        this._wmEventIds.push(global.window_manager.connect('size-changed', this._sizeChangedHandler));
        this._displayEventIds.push(global.display.connect('window-created', this._windowCreatedHandler));
        this._wmEventIds.push(global.window_manager.connect('destroy', this._destroyedHandler));
        this._displayEventIds.push(global.display.connect("grab-op-begin", this._grabOpBeginHandler));
        this._displayEventIds.push(global.display.connect("grab-op-end", this._grabOpEndHandler));
        
        // Connect workspace-added listener to attach listeners to new workspaces
        this._workspaceManEventIds.push(global.workspace_manager.connect("workspace-added", this._workspaceAddSignal));

        // Connect window-added and window-removed listeners to all existing workspaces
        let nWorkspaces = this._workspaceManager.get_n_workspaces();
        for(let i = 0; i < nWorkspaces; i++) {
            let workspace = this._workspaceManager.get_workspace_by_index(i);
            let eventIds = [];
            eventIds.push(workspace.connect("window-added", this._windowAdded));
            eventIds.push(workspace.connect("window-removed", this._windowRemoved));
            this._workspaceEventIds.push([workspace, eventIds]);
        }

        // Sort all workspaces at startup
        setTimeout(this._tileAllWorkspaces, constants.STARTUP_TILE_DELAY_MS);
        this._tileTimeout = setInterval(this._tileAllWorkspaces, constants.TILE_INTERVAL_MS); // Tile all windows periodically
    }

    disable() {
        console.log("[MOSAIC WM]: Disabling Mosaic layout manager.");
        // Disconnect all events
        clearTimeout(this._tileTimeout);
        for(let eventId of this._wmEventIds)
            global.window_manager.disconnect(eventId);
        for(let eventId of this._displayEventIds)
            global.display.disconnect(eventId);
        for(let eventId of this._workspaceManEventIds)
            global.workspace_manager.disconnect(eventId);
        // Disconnect workspace-level event listeners
        for(let container of this._workspaceEventIds) {
            const workspace = container[0];
            const eventIds = container[1];
            eventIds.forEach((eventId) => workspace.disconnect(eventId));
        }

        drawing.clearActors();

        // Cleanup workspace-changed signals
        this._windowWorkspaceSignals.forEach((signalId, windowId) => {
            const window = global.display.get_window_by_id(windowId);
            if (window) {
                window.disconnect(signalId);
            }
        });
        this._windowWorkspaceSignals.clear();
        
        // Clear debounce timeout
        if (this._workspaceChangeTimeout) {
            clearTimeout(this._workspaceChangeTimeout);
            this._workspaceChangeTimeout = null;
        }

        // Reset all event ID arrays to prevent memory leaks
        this._wmEventIds = [];
        this._displayEventIds = [];
        this._workspaceManEventIds = [];
        this._workspaceEventIds = [];
    }
}