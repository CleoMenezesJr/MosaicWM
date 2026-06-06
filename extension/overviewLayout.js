// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Custom layout strategy to preserve mosaic geometry in Overview

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import { ComputedLayouts } from './tiling.js';

// Scales down the layout instead of reorganizing windows (preserves spatial memory)
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

        // Filter out attached dialogs (visually merged with parent window)
        const filteredClones = clones.filter(clone => {
            const metaWindow = clone.metaWindow || clone.source?.metaWindow;
            if (!metaWindow) return true;
            if (metaWindow.is_attached_dialog()) return false;
            return true;
        });
        
        if (filteredClones.length === 0)
            return [];

        // Determine workspace
        let workspace = null;
        for (const clone of filteredClones) {
            const mw = clone.metaWindow || clone.source?.metaWindow;
            if (mw) {
                workspace = mw.get_workspace();
                if (workspace) break;
            }
        }
        
        if (!workspace) return [];

        // --- VIEWPORT MIRROR ---
        const monitor = this.monitor || this._monitor;
        const monitorIndex = monitor ? monitor.index : global.display.get_primary_monitor();
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);

        if (!workArea || workArea.width <= 0 || workArea.height <= 0) {
            return [];
        }

        // Calculate uniform scale to fit workArea into area (letterboxing)
        const scale = Math.min(area.width / workArea.width, area.height / workArea.height, 1.0);

        // Center the "mirrored" desktop
        const offsetX = (area.width - (workArea.width * scale)) / 2;
        const offsetY = (area.height - (workArea.height * scale)) / 2;

        const slots = [];
        for (const clone of filteredClones) {
            const mw = clone.metaWindow || clone.source?.metaWindow;
            if (!mw) continue;

            // Map absolute screen coordinates to the Overview slot
            // Primary: Mosaic Cache (stable positions)
            // Secondary Fallback: Real Window Frame (ensures visibility if cache is missing)
            const rect = ComputedLayouts.get(mw) || mw.get_frame_rect();
            if (!rect) continue;
            
            // Formula: (DesktopPos - DesktopOrigin) * Scale + OverviewSlotOrigin + CenteringOffset
            const x = (rect.x - workArea.x) * scale + area.x + offsetX;
            const y = (rect.y - workArea.y) * scale + area.y + offsetY;
            const w = rect.width * scale;
            const h = rect.height * scale;
            
            slots.push([x, y, w, h, clone]);
        }

        return slots;
    }
}
