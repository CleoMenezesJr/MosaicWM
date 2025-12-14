// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Visual feedback and preview rendering
import * as Logger from './logger.js';
import st from 'gi://St';
import * as main from 'resource:///org/gnome/shell/ui/main.js';

export class DrawingManager {
    constructor() {
        // Active feedback boxes
        this._boxes = [];
        // Pool of reusable boxes (avoids create/destroy churn)
        this._boxPool = [];
        
        // Tile preview overlay for edge tiling
        this._tilePreview = null;
        
        this._edgeTilingManager = null;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    rect(x, y, w, h) {
        // Managed by Extension.js
        
        let box;
        if (this._boxPool.length > 0) {
            box = this._boxPool.pop();
            box.show();
        } else {
            box = new st.Widget({ 
                style_class: "mosaic-preview",
                opacity: 200 // Ensure it's visible
            });
            main.uiGroup.add_child(box);
        }
        
        box.set_position(x, y);
        box.set_size(w, h);
        
        this._boxes.push(box);
    }

    removeBoxes() {
        // Recycle boxes instead of destroying
        while(this._boxes.length > 0) {
            let box = this._boxes.pop();
            box.hide();
            this._boxPool.push(box);
        }
    }

    showTilePreview(zone, workArea, window = null) {
        // Hide mosaic preview when showing edge tiling preview
        this.removeBoxes();
        
        if (!this._edgeTilingManager) {
            Logger.warn('[MOSAIC WM] showTilePreview: EdgeTilingManager not set');
            return;
        }
        
        const rect = this._edgeTilingManager.getZoneRect(zone, workArea, window);
        if (!rect) return;
        
        if (!this._tilePreview) {
            this._tilePreview = new st.Widget({
                style_class: 'tile-preview',
                opacity: 128
            });
            main.uiGroup.add_child(this._tilePreview);
        }
        
        this._tilePreview.set_position(rect.x, rect.y);
        this._tilePreview.set_size(rect.width, rect.height);
        this._tilePreview.show();
    }

    hideTilePreview() {
        if (this._tilePreview) {
            this._tilePreview.hide();
        }
    }

    clearActors() {
        this.removeBoxes();
        
        // Clean up pool
        while(this._boxPool.length > 0) {
            let box = this._boxPool.pop();
            main.uiGroup.remove_child(box);
            box.destroy();
        }
        
        if (this._tilePreview) {
            main.uiGroup.remove_child(this._tilePreview);
            this._tilePreview.destroy();
            this._tilePreview = null;
        }
        this._edgeTilingManager = null;
    }

    destroy() {
        this.clearActors();
    }
}