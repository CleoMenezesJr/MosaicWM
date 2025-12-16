// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// DragHandler - Manages drag & drop operations and ghost window effects.

import * as Logger from './logger.js';

export class DragHandler {
    constructor(extension) {
        this._ext = extension;
    }

    // Accessor shortcuts
    get windowingManager() { return this._ext.windowingManager; }
    get tilingManager() { return this._ext.tilingManager; }
    get edgeTilingManager() { return this._ext.edgeTilingManager; }
    get reorderingManager() { return this._ext.reorderingManager; }
    get drawingManager() { return this._ext.drawingManager; }
    get animationsManager() { return this._ext.animationsManager; }

    // Restore opacity of ghost windows when exiting edge zone or drag ends
    clearGhostWindows() {
        for (const win of this._ext._edgeTileGhostWindows) {
            const actor = win.get_compositor_private();
            if (actor) {
                actor.opacity = 255;
            }
        }
        this._ext._edgeTileGhostWindows = [];
    }

    // Move ghost windows to overflow workspace when edge tile is confirmed
    moveGhostWindowsToOverflow() {
        if (this._ext._edgeTileGhostWindows.length === 0) return;
        
        Logger.log(`[MOSAIC WM] Moving ${this._ext._edgeTileGhostWindows.length} ghost windows to overflow`);
        
        for (const win of this._ext._edgeTileGhostWindows) {
            const actor = win.get_compositor_private();
            if (actor) actor.opacity = 255;
            
            this.windowingManager.moveOversizedWindow(win);
        }
        
        this._ext._edgeTileGhostWindows = [];
    }
}
