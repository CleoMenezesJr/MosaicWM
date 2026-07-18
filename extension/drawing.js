// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Visual feedback and preview rendering
import * as Logger from './logger.js';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import GObject from 'gi://GObject';

export const DrawingManager = GObject.registerClass({
    GTypeName: 'MosaicDrawingManager',
}, class DrawingManager extends GObject.Object {
    _init() {
        super._init();
        this._boxes = [];
        this._boxPool = [];

        this._tilePreview = null;
        this._companionPreview = null;

        this._edgeTilingManager = null;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }

    rect(x, y, w, h) {
        let box;
        if (this._boxPool.length > 0) {
            box = this._boxPool.pop();
            box.show();
        } else {
            box = new St.Widget({
                style_class: 'mosaic-preview',
                opacity: 200 // Ensure it's visible
            });
            Main.uiGroup.add_child(box);
        }

        box.set_position(x, y);
        box.set_size(w, h);

        this._boxes.push(box);
    }

    removeBoxes() {
        while(this._boxes.length > 0) {
            const box = this._boxes.pop();
            box.hide();
            this._boxPool.push(box);
        }
    }

    showTilePreview(zone, workArea, window = null) {
        this.removeBoxes();

        if (!this._edgeTilingManager) {
            Logger.warn('showTilePreview: EdgeTilingManager not set');
            return;
        }

        const rect = this._edgeTilingManager.getZoneRect(zone, workArea, window);
        if (!rect) return;

        if (!this._tilePreview) {
            this._tilePreview = new St.Widget({
                style_class: 'tile-preview',
                opacity: 128
            });
            Main.uiGroup.add_child(this._tilePreview);
        }

        this._tilePreview.set_position(rect.x, rect.y);
        this._tilePreview.set_size(rect.width, rect.height);
        this._tilePreview.show();
    }

    // The lone mosaic window becomes the opposite half, so it gets its own preview instead of
    // being drawn as a miniature. Callers pass the already-computed opposite zone rect.
    showCompanionTilePreview(rect) {
        if (!rect) return;

        if (!this._companionPreview) {
            this._companionPreview = new St.Widget({
                style_class: 'tile-preview',
                opacity: 128
            });
            Main.uiGroup.add_child(this._companionPreview);
        }

        this._companionPreview.set_position(rect.x, rect.y);
        this._companionPreview.set_size(rect.width, rect.height);
        this._companionPreview.show();
    }

    hideCompanionTilePreview() {
        if (this._companionPreview) {
            this._companionPreview.hide();
        }
    }

    hideTilePreview() {
        if (this._tilePreview) {
            this._tilePreview.hide();
        }
        this.hideCompanionTilePreview();
    }

    clearActors() {
        this.removeBoxes();

        while(this._boxPool.length > 0) {
            const box = this._boxPool.pop();
            if (box.get_parent())
                Main.uiGroup.remove_child(box);
            box.destroy();
        }

        if (this._tilePreview) {
            if (this._tilePreview.get_parent())
                Main.uiGroup.remove_child(this._tilePreview);
            this._tilePreview.destroy();
            this._tilePreview = null;
        }

        if (this._companionPreview) {
            if (this._companionPreview.get_parent())
                Main.uiGroup.remove_child(this._companionPreview);
            this._companionPreview.destroy();
            this._companionPreview = null;
        }
        this._edgeTilingManager = null;
    }

    destroy() {
        this.clearActors();
    }
});