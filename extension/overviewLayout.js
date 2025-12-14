// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Custom layout strategy to preserve mosaic geometry in Overview

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';

// Scales down the layout instead of reorganizing windows (preserves spatial memory)
export class MosaicLayoutStrategy extends Workspace.LayoutStrategy {
    computeLayout(windows, _params) {
        return { windows };
    }

    computeWindowSlots(layout, area) {
        const clones = layout.windows;
        if (clones.length === 0)
            return [];

        // Calculate bounding box
        let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
        for (const clone of clones) {
            const rect = clone.boundingBox;
            minX = Math.min(minX, rect.x);
            minY = Math.min(minY, rect.y);
            maxX = Math.max(maxX, rect.x + rect.width);
            maxY = Math.max(maxY, rect.y + rect.height);
        }

        const mosaicWidth = maxX - minX;
        const mosaicHeight = maxY - minY;

        // Calculate uniform scale
        const scale = Math.min(
            area.width / mosaicWidth,
            area.height / mosaicHeight,
            1.0
        );

        // Center layout
        const scaledWidth = mosaicWidth * scale;
        const scaledHeight = mosaicHeight * scale;
        const offsetX = (area.width - scaledWidth) / 2;
        const offsetY = (area.height - scaledHeight) / 2;

        // Return layout slots
        const slots = [];
        for (const clone of clones) {
            const rect = clone.boundingBox;
            const x = (rect.x - minX) * scale + area.x + offsetX;
            const y = (rect.y - minY) * scale + area.y + offsetY;
            const w = rect.width * scale;
            const h = rect.height * scale;
            slots.push([x, y, w, h, clone]);
        }

        return slots;
    }
}
