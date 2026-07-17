// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Custom layout strategy to preserve mosaic geometry in Overview

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import { ComputedLayouts } from './tiling.js';
import { WINDOW_SPACING } from './constants.js';

// Scales down the layout instead of reorganizing windows (preserves spatial memory)
// Overview clones expose the window directly or behind .source depending on where the
// shell built them, so never reach for .metaWindow on its own.
function metaWindowOf(clone) {
    return clone.metaWindow || clone.source?.metaWindow;
}

export class MosaicLayoutStrategy extends Workspace.LayoutStrategy {
    constructor(props) {
        super(props);
        this._calculating = false;
    }

    computeLayout(windows, _params) {
        return { windows };
    }

    computeWindowSlots(layout, area) {
        const clones = layout.windows;

        if (!area || clones.length === 0) {
            return [];
        }

        // Attached dialogs and transients ride along with their parent, so no slot of their own.
        const filteredClones = clones.filter(clone => {
            const metaWindow = metaWindowOf(clone);
            if (!metaWindow) return true;
            return !metaWindow.is_attached_dialog() && metaWindow.get_transient_for() === null;
        });

        if (filteredClones.length === 0)
            return [];

        const workspace = this._firstWorkspace(filteredClones);
        if (!workspace) return [];

        const monitor = this.monitor || this._monitor;
        const monitorIndex = monitor ? monitor.index : global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);

        if (!workArea || workArea.width <= 0 || workArea.height <= 0) {
            return [];
        }

        const scale = Math.min(area.width / workArea.width, area.height / workArea.height, 1.0);

        const offsetX = (area.width - (workArea.width * scale)) / 2;
        const offsetY = (area.height - (workArea.height * scale)) / 2;

        return this._buildSlots(filteredClones, { workArea, area, scale, offsetX, offsetY });
    }

    _firstWorkspace(clones) {
        for (const clone of clones) {
            const mw = metaWindowOf(clone);
            const workspace = mw?.get_workspace();
            if (workspace) return workspace;
        }
        return null;
    }

    _buildSlots(clones, { workArea, area, scale, offsetX, offsetY }) {
        const gap = WINDOW_SPACING / 2;
        const slots = [];

        for (const clone of clones) {
            const mw = metaWindowOf(clone);
            if (!mw) continue;

            // The mosaic's computed layout beats the live frame; mid-animation the frame is
            // a transient size and the overview would mirror the blur.
            const rect = ComputedLayouts.get(mw) || mw.get_frame_rect();
            if (!rect) continue;

            const x = (rect.x - workArea.x) * scale + area.x + offsetX + gap;
            const y = (rect.y - workArea.y) * scale + area.y + offsetY + gap;
            const w = rect.width * scale - gap * 2;
            const h = rect.height * scale - gap * 2;

            slots.push([x, y, w, h, clone]);
        }

        return slots;
    }
}
