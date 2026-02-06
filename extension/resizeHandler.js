// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// ResizeHandler - Manages window resize operations and maximize undo.

import * as Logger from './logger.js';
import { afterWorkspaceSwitch } from './timing.js';
import * as WindowState from './windowState.js';

export class ResizeHandler {
    constructor(extension) {
        this._ext = extension;
    }

    // Accessor shortcuts
    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get animationsManager() { return this._ext.animationsManager; }
    get _timeoutRegistry() { return this._ext._timeoutRegistry; }

    // Handle undo of maximize - returns window to original workspace if it fits
    handleUnmaximizeUndo(window, maxInfo) {
        const { originalWorkspace: origIndex, monitor, preMaxSize } = maxInfo;
        const currentWorkspace = window.get_workspace();
        const workspaceManager = global.workspace_manager;
        const windowId = window.get_id();
        
        // Restore pre-maximize size so tiling uses correct dimensions
        if (preMaxSize) {
            Logger.log(`[MOSAIC WM] Undo: Restoring pre-max size ${preMaxSize.width}x${preMaxSize.height} for window ${windowId}`);
            WindowState.set(window, 'openingSize', preMaxSize);
        }
        
        // Check if original workspace still exists
        if (origIndex >= workspaceManager.get_n_workspaces()) {
            Logger.log(`[MOSAIC WM] Undo: Original workspace ${origIndex} no longer exists - staying`);
            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor);
            return;
        }
        
        const targetWorkspace = workspaceManager.get_workspace_by_index(origIndex);
        
        // If already in original workspace, just tile
        if (currentWorkspace.index() === origIndex) {
            Logger.log(`[MOSAIC WM] Undo: Already in original workspace - tiling`);
            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor);
            return;
        }
        
        // Check if window will fit in original workspace
        const canFit = this.tilingManager.canFitWindow(window, targetWorkspace, monitor);
        
        if (!canFit) {
            Logger.log(`[MOSAIC WM] Undo: Window doesn't fit in original workspace ${origIndex} - staying`);
            this.tilingManager.tileWorkspaceWindows(currentWorkspace, window, monitor);
            return;
        }
        
        // Move back to original workspace
        Logger.log(`[MOSAIC WM] Undo: Moving window back to workspace ${origIndex}`);
        const oldWorkspace = currentWorkspace;
        window.change_workspace(targetWorkspace);
        targetWorkspace.activate(global.get_current_time());
        
        // Tile both workspaces after switch
        afterWorkspaceSwitch(() => {
            this.tilingManager.tileWorkspaceWindows(targetWorkspace, window, monitor, true);
            if (oldWorkspace.index() >= 0 && oldWorkspace.index() < workspaceManager.get_n_workspaces()) {
                this.tilingManager.tileWorkspaceWindows(oldWorkspace, null, monitor, false);
            }
        }, this._timeoutRegistry);
    }
}
