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
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as windowing from './windowing.js';
import * as tiling from './tiling.js';
import * as drawing from './drawing.js';
import * as reordering from './reordering.js';
import * as edgeTiling from './edgeTiling.js';
import * as constants from './constants.js';
import { SettingsOverrider } from './settingsOverrider.js';

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
        this._resizeOverflowWindow = null;
        this._tileTimeout = null;
        this._windowWorkspaceSignals = new Map(); // window_id -> signal_id for workspace-changed
        this._workspaceChangeTimeout = null; // Debounce timeout for manual workspace changes
        this._windowPreviousWorkspace = new Map(); // window_id -> previous_workspace_index for overview drag-drop
        this._windowRemovedTimestamp = new Map(); // window_id -> timestamp when removed
        this._manualWorkspaceMove = new Map(); // window_id -> true if manual move (workspace-changed fired)
        
        // Edge tiling state
        this._settingsOverrider = null;
        this._draggedWindow = null;
        this._dragMonitorId = null;
        this._currentZone = edgeTiling.TileZone.NONE;
        this._grabOpBeginId = null;
        this._grabOpEndId = null;
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
                
                // CASE 2: Check if workspace has exactly one edge-tiled window
                // If so, try to tile the new window with it BEFORE checking overflow
                const workspaceWindows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
                const edgeTiledWindows = workspaceWindows.filter(w => {
                    const tileState = edgeTiling.getWindowState(w);
                    return tileState && tileState.zone !== edgeTiling.TileZone.NONE && w.get_id() !== window.get_id();
                });
                
                if (edgeTiledWindows.length === 1 && workspaceWindows.length === 2) {
                    // Try to tile with the edge-tiled window
                    console.log(`[MOSAIC WM] New window: Attempting to tile with edge-tiled window`);
                    const tileSuccess = windowing.tryTileWithSnappedWindow(window, edgeTiledWindows[0], null);
                    
                    if (tileSuccess) {
                        console.log('[MOSAIC WM] New window: Successfully tiled with edge-tiled window');
                        this._connectWindowWorkspaceSignal(window);
                        return; // Done - don't do overflow check
                    }
                    console.log('[MOSAIC WM] New window: Tiling failed, continuing with normal flow');
                }
                
                // CASE 3: Check if window FITS in current workspace
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
        const windowId = window.get_id();
        
        // Disconnect workspace-changed signal
        this._disconnectWindowWorkspaceSignal(window);
        
        // Clean up tracking Maps to prevent memory leaks
        this._windowPreviousWorkspace.delete(windowId);
        this._windowRemovedTimestamp.delete(windowId);
        this._manualWorkspaceMove.delete(windowId);
        
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
                console.log('[MOSAIC WM] Workspace is empty - checking if should navigate');
                
                const workspaceManager = global.workspace_manager;
                const currentIndex = workspace.index();
                
                // Only navigate away if:
                // 1. We're not in workspace 0 (first workspace), OR
                // 2. There's a non-empty workspace to navigate to
                
                // Check if there's a previous non-empty workspace
                let shouldNavigate = false;
                let targetWorkspace = null;
                
                if (currentIndex > 0) {
                    // Try to navigate to previous workspace
                    const previousWorkspace = workspace.get_neighbor(Meta.MotionDirection.LEFT);
                    if (previousWorkspace && previousWorkspace.index() !== currentIndex) {
                        const prevWindows = windowing.getMonitorWorkspaceWindows(previousWorkspace, monitor);
                        const prevManagedWindows = prevWindows.filter(w => !windowing.isExcluded(w));
                        
                        if (prevManagedWindows.length > 0) {
                            shouldNavigate = true;
                            targetWorkspace = previousWorkspace;
                            console.log(`[MOSAIC WM] Found non-empty previous workspace ${previousWorkspace.index()}`);
                        }
                    }
                }
                
                // If no previous non-empty workspace, check next (but only if we're not in workspace 0)
                if (!shouldNavigate && currentIndex > 0) {
                    const nextWorkspace = workspace.get_neighbor(Meta.MotionDirection.RIGHT);
                    if (nextWorkspace && nextWorkspace.index() !== currentIndex) {
                        const nextWindows = windowing.getMonitorWorkspaceWindows(nextWorkspace, monitor);
                        const nextManagedWindows = nextWindows.filter(w => !windowing.isExcluded(w));
                        
                        if (nextManagedWindows.length > 0) {
                            shouldNavigate = true;
                            targetWorkspace = nextWorkspace;
                            console.log(`[MOSAIC WM] Found non-empty next workspace ${nextWorkspace.index()}`);
                        }
                    }
                }
                
                if (shouldNavigate && targetWorkspace) {
                    targetWorkspace.activate(global.get_current_time());
                    console.log(`[MOSAIC WM] Navigated to workspace ${targetWorkspace.index()}`);
                } else {
                    console.log('[MOSAIC WM] Staying in current workspace (workspace 0 or no non-empty workspaces available)');
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
        console.log(`[MOSAIC WM] workspace-changed fired for window ${window.get_id()}`);
        
        // Mark this as a manual workspace move (not overview drag-drop)
        this._manualWorkspaceMove.set(window.get_id(), true);
        
        // Store the previous workspace index so we can re-tile it after the move
        const previousWorkspaceIndex = this._windowPreviousWorkspace.get(window.get_id());
        
        // Clear any existing debounce timeout
        if (this._workspaceChangeTimeout) {
            console.log('[MOSAIC WM] Clearing previous debounce timeout');
            clearTimeout(this._workspaceChangeTimeout);
        }
        
        // Debounce: wait 500ms before checking overflow
        // This allows user to navigate through multiple workspaces without interruption
        this._workspaceChangeTimeout = setTimeout(() => {
            const workspace = window.get_workspace();
            const monitor = window.get_monitor();
            
            console.log(`[MOSAIC WM] Debounce complete - checking overflow for window ${window.get_id()} in workspace ${workspace.index()}`);
            
            // Skip if window is excluded
            if (windowing.isExcluded(window)) {
                console.log('[MOSAIC WM] Window is excluded - skipping overflow check');
                return;
            }
            
            // Re-tile the source workspace to fill the gap left by the moved window
            if (previousWorkspaceIndex !== undefined && previousWorkspaceIndex !== workspace.index()) {
                const workspaceManager = global.workspace_manager;
                const previousWorkspace = workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                if (previousWorkspace) {
                    console.log(`[MOSAIC WM] Re-tiling source workspace ${previousWorkspaceIndex} after window move`);
                    tiling.tileWorkspaceWindows(previousWorkspace, null, monitor, false);
                }
            }
            
            // Check if target workspace has exactly one snapped window
            const workspaceWindows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
            console.log(`[MOSAIC WM] Manual move: workspace has ${workspaceWindows.length} windows`);
            
            const edgeTiledWindows = workspaceWindows.filter(w => {
                const tileState = edgeTiling.getWindowState(w);
                const isEdgeTiled = tileState && tileState.zone !== edgeTiling.TileZone.NONE && w.get_id() !== window.get_id();
                console.log(`[MOSAIC WM] Manual move: window ${w.get_id()} edgeTiled=${isEdgeTiled}, isTarget=${w.get_id() === window.get_id()}, willInclude=${isEdgeTiled}`);
                return isEdgeTiled;
            });
            
            console.log(`[MOSAIC WM] Manual move: found ${edgeTiledWindows.length} edge-tiled windows, total ${workspaceWindows.length} windows`);
            
            if (edgeTiledWindows.length === 1 && workspaceWindows.length === 2) {
                // Try to tile with the edge-tiled window
                console.log(`[MOSAIC WM] Manual move: Attempting to tile with edge-tiled window`);
                const previousWorkspace = previousWorkspaceIndex !== undefined ? 
                    global.workspace_manager.get_workspace_by_index(previousWorkspaceIndex) : null;
                const tileSuccess = windowing.tryTileWithSnappedWindow(window, edgeTiledWindows[0], previousWorkspace);
                
                if (tileSuccess) {
                    console.log('[MOSAIC WM] Manual move: Successfully tiled with edge-tiled window');
                    return; // Don't do overflow check
                }
                // If tiling failed, window was already returned to previous workspace
                if (previousWorkspace && window.get_workspace() === previousWorkspace) {
                    console.log('[MOSAIC WM] Manual move: Tiling failed, window returned to previous workspace');
                    return;
                }
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
            // Skip tiling if this window is being restored from edge tiling
            if (this._skipNextTiling === window.get_id()) {
                console.log(`[MOSAIC WM] Skipping size change tiling for window ${window.get_id()} (restoring from edge tiling)`);
                return;
            }

            // Live resizing
            this._sizeChanged = true;
            
            // Check if resize causes overflow
            let workspace = window.get_workspace();
            let monitor = window.get_monitor();
            
            // Only check overflow if window is being actively resized (not maximized/edge-tiled)
            let workArea = workspace.get_work_area_for_monitor(monitor);
            let tileState = edgeTiling.getWindowState(window);
            let isEdgeTiled = tileState && tileState.zone !== edgeTiling.TileZone.NONE;
            if (!windowing.isMaximizedOrFullscreen(window) && !isEdgeTiled) {
                let canFit = tiling.canFitWindow(window, workspace, monitor);
                
                if (!canFit) {
                    // Track overflow state
                    if (this._resizeOverflowWindow !== window) {
                        this._resizeOverflowWindow = window;
                        console.log('[MOSAIC WM] Resize overflow detected - window too large');
                    }
                } else {
                    // Clear overflow state if window fits again
                    if (this._resizeOverflowWindow === window) {
                        this._resizeOverflowWindow = null;
                        console.log('[MOSAIC WM] Resize overflow cleared - window fits again');
                    }
                }
            }
            
            tiling.tileWorkspaceWindows(workspace, window, monitor, true);
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
        // Edge tiling: start polling cursor position
        if (grabpo === 1 && !windowing.isExcluded(window)) {
            console.log(`[MOSAIC WM] Edge tiling: grab begin`);
            this._draggedWindow = window;
            this._currentZone = edgeTiling.TileZone.NONE;
            
            // Check if window is currently edge-tiled and restore it immediately
            const windowState = edgeTiling.getWindowState(window);
            console.log(`[MOSAIC WM] _grabOpBeginHandler: windowState=${JSON.stringify(windowState)}`);
            if (windowState && windowState.zone !== edgeTiling.TileZone.NONE) {
                console.log(`[MOSAIC WM] Edge tiling: window was in zone ${windowState.zone}, restoring immediately`);
                
                // Prevent mosaic tiling during restoration
                this._skipNextTiling = window.get_id();
                
                // Restore the window and call startDrag only after restoration completes
                edgeTiling.removeTile(window, () => {
                    console.log(`[MOSAIC WM] Edge tiling: restoration complete, now calling startDrag`);
                    
                    // Clear skip flag after restoration
                    this._skipNextTiling = null;
                    
                    // Start mosaic drag for non-excluded, non-maximized windows
                    if( !windowing.isExcluded(window) &&
                        (grabpo === 1 || grabpo === 1025) && // When a window has moved
                        !(windowing.isMaximizedOrFullscreen(window))) {
                        console.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
                        reordering.startDrag(window);
                        console.log(`[MOSAIC WM] _grabOpBeginHandler: startDrag completed`);
                    }
                });
                
                // Return early - startDrag will be called by the callback
                return;
            }
            
            // Poll cursor position to detect edge tiling zones
            this._edgeTilingPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                if (!this._draggedWindow) {
                    return GLib.SOURCE_REMOVE;
                }
                
                const [x, y] = global.get_pointer();
                const monitor = this._draggedWindow.get_monitor();
                const workspace = this._draggedWindow.get_workspace();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                
                const zone = edgeTiling.detectZone(x, y, workArea, workspace);
                const windowState = edgeTiling.getWindowState(this._draggedWindow);
                const wasInEdgeTiling = windowState && windowState.zone !== edgeTiling.TileZone.NONE;
                
                console.log(`[MOSAIC WM] Edge tiling poll: zone=${zone}, windowState=${JSON.stringify(windowState)}, wasInEdgeTiling=${wasInEdgeTiling}`);
                
                if (zone !== edgeTiling.TileZone.NONE && zone !== this._currentZone) {
                    // Entering a new edge tiling zone
                    console.log(`[MOSAIC WM] Edge tiling: detected zone ${zone}`);
                    this._currentZone = zone;
                    edgeTiling.setEdgeTilingActive(true, this._draggedWindow);
                    drawing.showTilePreview(zone, workArea);
                } else if (zone === edgeTiling.TileZone.NONE && this._currentZone !== edgeTiling.TileZone.NONE) {
                    // Exiting edge tiling zone
                    console.log(`[MOSAIC WM] Edge tiling: exiting zone, wasInEdgeTiling=${wasInEdgeTiling}`);
                    this._currentZone = edgeTiling.TileZone.NONE;
                    edgeTiling.setEdgeTilingActive(false, null);
                    drawing.hideTilePreview();
                    
                    // If window was previously in edge tiling, restore it now
                    if (wasInEdgeTiling) {
                        console.log(`[MOSAIC WM] Edge tiling: restoring window from tiled state`);
                        edgeTiling.removeTile(this._draggedWindow);
                    }
                }
                
                return GLib.SOURCE_CONTINUE;
            });
        }
        
        // Start mosaic drag for non-excluded, non-maximized windows
        if( !windowing.isExcluded(window) &&
            (grabpo === 1 || grabpo === 1025) && // When a window has moved
            !(windowing.isMaximizedOrFullscreen(window))) {
            console.log(`[MOSAIC WM] _grabOpBeginHandler: calling startDrag for window ${window.get_id()}`);
            reordering.startDrag(window);
            console.log(`[MOSAIC WM] _grabOpBeginHandler: startDrag completed`);
        }
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
        // Edge tiling: stop polling and apply tile if in zone
        if (grabpo === 1 && window === this._draggedWindow) {
            // Stop polling
            if (this._edgeTilingPollId) {
                GLib.source_remove(this._edgeTilingPollId);
                this._edgeTilingPollId = null;
            }
            
            if (this._currentZone !== edgeTiling.TileZone.NONE) {
                console.log(`[MOSAIC WM] Edge tiling: applying zone ${this._currentZone}`);
                const workspace = window.get_workspace();
                const monitor = window.get_monitor();
                const workArea = workspace.get_work_area_for_monitor(monitor);
                
                // Set skip flag BEFORE applying tile to prevent signal handlers (like size-change)
                // from triggering a mosaic retile during the operation
                this._skipNextTiling = window.get_id();
                
                const success = edgeTiling.applyTile(window, this._currentZone, workArea);
                console.log(`[MOSAIC WM] Edge tiling: apply result = ${success}`);
                
                // Prevent mosaic from re-tiling this window immediately after edge tiling
                if (success) {
                    // Short timeout to prevent immediate re-tiling
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                        this._skipNextTiling = null;
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    // Failed, clear flag immediately
                    this._skipNextTiling = null;
                }
            } 
            // Note: Window restoration from edge tiling now happens during drag
            // in the polling loop, not here on release
            
            
            drawing.hideTilePreview();
            this._draggedWindow = null;
            this._currentZone = edgeTiling.TileZone.NONE;
            
            // Clear edge tiling active state
            edgeTiling.setEdgeTilingActive(false, null);
        }
        
        if(!windowing.isExcluded(window)) {
            // Pass skip_tiling=true if we just applied edge tiling
            const skipTiling = this._skipNextTiling === window.get_id();
            reordering.stopDrag(window, false, skipTiling);
            
            // Log grab operation for debugging
            console.log(`[MOSAIC WM] Grab operation ended: ${grabpo}`);
            
            if( (grabpo === 1 || grabpo === 1025) && // When a window has moved
                !(windowing.isMaximizedOrFullscreen(window)) &&
                !skipTiling) // Skip if edge tiling was just applied
            {
                tiling.tileWorkspaceWindows(window.get_workspace(), window, window.get_monitor(), false);
            }
            if(grabpo === 20481) { // When released from resizing
                // Check if resize ended with overflow - move to new workspace
                if (this._resizeOverflowWindow === window) {
                    console.log('[MOSAIC WM] Resize ended with overflow - moving window to new workspace');
                    let oldWorkspace = window.get_workspace();
                    let newWorkspace = windowing.moveOversizedWindow(window);
                    if (newWorkspace) {
                        tiling.tileWorkspaceWindows(oldWorkspace, false, window.get_monitor(), false);
                    }
                    this._resizeOverflowWindow = null;
                } else {
                    tileWindowWorkspace(window);
                }
            }
        } else
            reordering.stopDrag(window, true);
    }

    _sizeChangeHandler = (_, window, mode) => {
        let workspace = window.get_workspace();
        let monitor = window.get_monitor();

        if (!windowing.isExcluded(window)) {
            if (mode === 0 || mode === 2) { // Maximize
                const workspaceWindows = windowing.getMonitorWorkspaceWindows(workspace, monitor);
                if (workspaceWindows.length > 1) {
                    console.log('[MOSAIC WM] Window maximized - moving to new workspace');
                    let newWorkspace = windowing.moveOversizedWindow(window);
                    if (newWorkspace) {
                        tiling.tileWorkspaceWindows(workspace, false, monitor, false);
                    }
                }
            } else if (mode === 1 || mode === 3) { // Unmaximize
                // Skip tiling if this window is being restored from edge tiling
                if (this._skipNextTiling === window.get_id()) {
                    console.log(`[MOSAIC WM] Skipping tiling for unmaximized window ${window.get_id()} (restoring from edge tiling)`);
                    return;
                }
                
                console.log('[MOSAIC WM] Window unmaximized - tiling workspace');
                tiling.tileWorkspaceWindows(workspace, window, monitor, false);
            }
        }
    }

    /**
     * Handler called when a window is added to a workspace.
     * This is triggered by workspace.connect('window-added').
     * Handles both new window creation and overview drag-drop.
     * 
     * For overview drag-drop: checks overflow and returns window to previous workspace if needed.
     * For new windows: just tiles normally (no overflow check to avoid infinite loops).
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
                
                // Get window frame to check if it's a new window or existing one
                const frame = WINDOW.get_frame_rect();
                const hasValidDimensions = frame.width > 0 && frame.height > 0;
                
                // Check if this is an overview drag-drop (has different previous workspace AND happened recently)
                const previousWorkspaceIndex = this._windowPreviousWorkspace.get(WINDOW.get_id());
                const removedTimestamp = this._windowRemovedTimestamp.get(WINDOW.get_id());
                const timeSinceRemoved = removedTimestamp ? Date.now() - removedTimestamp : Infinity;
                const isManualMove = this._manualWorkspaceMove.get(WINDOW.get_id());
                
                console.log(`[MOSAIC WM] window-added debug: window=${WINDOW.get_id()}, timeSince=${timeSinceRemoved}ms, prevWS=${previousWorkspaceIndex}, currentWS=${WORKSPACE.index()}, isManual=${isManualMove}`);
                
                // Overview drag-drop: fast (<3s), different workspace, NOT a manual move
                // Manual moves are handled by workspace-changed signal (500ms debounce)
                const isOverviewDragDrop = previousWorkspaceIndex !== undefined && 
                                          previousWorkspaceIndex !== WORKSPACE.index() &&
                                          timeSinceRemoved < 3000 &&
                                          !isManualMove;
                
                // Only check overflow for overview drag-drop operations
                // Skip new windows (no previous workspace) to avoid infinite loops
                if (hasValidDimensions && !windowing.isExcluded(WINDOW) && isOverviewDragDrop) {
                    console.log(`[MOSAIC WM] window-added: Overview drag-drop - window ${WINDOW.get_id()} from workspace ${previousWorkspaceIndex} to ${WORKSPACE.index()}`);
                    
                    // Check if target workspace has exactly one edge-tiled window
                    const workspaceWindows = windowing.getMonitorWorkspaceWindows(WORKSPACE, MONITOR);
                    const edgeTiledWindows = workspaceWindows.filter(w => {
                        const tileState = edgeTiling.getWindowState(w);
                        return tileState && tileState.zone !== edgeTiling.TileZone.NONE && w.get_id() !== WINDOW.get_id();
                    });
                    
                    if (edgeTiledWindows.length === 1 && workspaceWindows.length === 2) {
                        // Try to tile with the edge-tiled window
                        console.log(`[MOSAIC WM] Attempting to tile with edge-tiled window`);
                        const previousWorkspace = this._workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                        const tileSuccess = windowing.tryTileWithSnappedWindow(WINDOW, edgeTiledWindows[0], previousWorkspace);
                        
                        if (tileSuccess) {
                            // Clean up tracking
                            this._windowPreviousWorkspace.delete(WINDOW.get_id());
                            this._windowRemovedTimestamp.delete(WINDOW.get_id());
                            this._manualWorkspaceMove.delete(WINDOW.get_id());
                            return; // Don't do normal overflow check
                        }
                        // If tiling failed, window was already returned to previous workspace
                        return;
                    }
                    
                    const canFit = tiling.canFitWindow(WINDOW, WORKSPACE, MONITOR);
                    
                    if (!canFit) {
                        // Return to previous workspace
                        console.log(`[MOSAIC WM] window-added: Doesn't fit - returning to workspace ${previousWorkspaceIndex}`);
                        const previousWorkspace = this._workspaceManager.get_workspace_by_index(previousWorkspaceIndex);
                        if (previousWorkspace) {
                            WINDOW.change_workspace(previousWorkspace);
                            this._windowPreviousWorkspace.delete(WINDOW.get_id());
                            this._windowRemovedTimestamp.delete(WINDOW.get_id());
                            return; // Don't tile, window is being moved back
                        }
                    } else {
                        // Clean up tracking if window fits
                        this._windowPreviousWorkspace.delete(WINDOW.get_id());
                        this._windowRemovedTimestamp.delete(WINDOW.get_id());
                        this._manualWorkspaceMove.delete(WINDOW.get_id());
                    }
                }
                
                // Tile the workspace
                tiling.tileWorkspaceWindows(WORKSPACE, null, MONITOR, true);
            }
        }, constants.WINDOW_VALIDITY_CHECK_INTERVAL_MS);
    }

    /**
     * Handler called when a window is removed from a workspace.
     * This is triggered by workspace.connect('window-removed').
     * Re-tiles the workspace and handles workspace navigation if empty.
     * Also tracks the previous workspace for overview drag-drop.
     * 
     * @param {Meta.Workspace} workspace - The workspace that lost the window
     * @param {Meta.Window} window - The window that was removed
     */
    _windowRemoved = (workspace, window) => {
        // Track previous workspace and timestamp for overview drag-drop detection
        this._windowPreviousWorkspace.set(window.get_id(), workspace.index());
        this._windowRemovedTimestamp.set(window.get_id(), Date.now());
        
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
        
        // Disable native edge tiling and conflicting keybindings
        this._settingsOverrider = new SettingsOverrider();
        
        this._settingsOverrider.add(
            new Gio.Settings({ schema_id: 'org.gnome.mutter' }),
            'edge-tiling',
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
        
        this._wmEventIds.push(global.window_manager.connect('size-change', this._sizeChangeHandler));
        this._wmEventIds.push(global.window_manager.connect('size-changed', this._sizeChangedHandler));
        this._displayEventIds.push(global.display.connect('window-created', this._windowCreatedHandler));
        this._wmEventIds.push(global.window_manager.connect('destroy', this._destroyedHandler));
        this._displayEventIds.push(global.display.connect("grab-op-begin", this._grabOpBeginHandler));
        this._displayEventIds.push(global.display.connect("grab-op-end", this._grabOpEndHandler));
        
        // Edge tiling is now integrated into _grabOpBeginHandler and _grabOpEndHandler
        
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
        
        // Restore native settings
        if (this._settingsOverrider) {
            this._settingsOverrider.destroy();
            this._settingsOverrider = null;
        }
        
        // Cleanup edge tiling polling timer if active
        if (this._edgeTilingPollId) {
            GLib.source_remove(this._edgeTilingPollId);
            this._edgeTilingPollId = null;
        }
        
        // Clear edge tiling states
        edgeTiling.clearAllStates();
        drawing.hideTilePreview();
        
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