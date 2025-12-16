// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Custom layout strategy to preserve mosaic geometry in Overview

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import { ComputedLayouts } from './tiling.js';
import { getTilingManager } from './extension.js';

// Scales down the layout instead of reorganizing windows (preserves spatial memory)
export class MosaicLayoutStrategy extends Workspace.LayoutStrategy {
    computeLayout(windows, _params) {
        return { windows };
    }

    computeWindowSlots(layout, area) {
        const clones = layout.windows;
        if (clones.length === 0)
            return [];

        // Check cache completeness
        let allCached = this._isCacheComplete(clones);
        
        // If cache incomplete, try to populate it
        if (!allCached) {
            const tilingManager = getTilingManager();
            if (tilingManager) {
                tilingManager.calculateLayoutsOnly();
            }
            
            // Re-check after population attempt
            allCached = this._isCacheComplete(clones);
        }
        
        // GRACEFUL DEGRADATION: If cache is still incomplete, use GNOME's default layout
        // This ensures windows appear correctly positioned (even if not in mosaic) until tiling is ready
        if (!allCached) {
            return this._computeDefaultSlots(clones, area);
        }

        // All windows have cached positions - use mosaic layout
        let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
        const usedRects = new Map();

        for (const clone of clones) {
            let winId = null;
            if (clone.metaWindow) {
                winId = clone.metaWindow.get_id();
            } else if (clone.source && clone.source.metaWindow) {
                winId = clone.source.metaWindow.get_id();
            }

            const cached = ComputedLayouts.get(winId);
            const rect = cached; // We know it's valid from the check above
            
            usedRects.set(clone, rect);
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
            const rect = usedRects.get(clone);
            const x = (rect.x - minX) * scale + area.x + offsetX;
            const y = (rect.y - minY) * scale + area.y + offsetY;
            const w = rect.width * scale;
            const h = rect.height * scale;
            slots.push([x, y, w, h, clone]);
        }

        return slots;
    }
    
    // Check if valid cached layouts exist for all given clones
    _isCacheComplete(clones) {
        for (const clone of clones) {
            let winId = null;
            if (clone.metaWindow) {
                winId = clone.metaWindow.get_id();
            } else if (clone.source && clone.source.metaWindow) {
                winId = clone.source.metaWindow.get_id();
            }
            
            if (winId !== null) {
                const cached = ComputedLayouts.get(winId);
                if (!cached || cached.width <= 0 || cached.height <= 0) {
                    return false;
                }
            }
        }
        return true;
    }
    
    // Fallback: Simple centered layout (similar to GNOME's default)
    _computeDefaultSlots(clones, area) {
        const slots = [];
        const padding = 20;
        const maxScale = 0.7;
        
        // Simple grid-like arrangement
        const count = clones.length;
        const cols = Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);
        
        const cellWidth = (area.width - padding * (cols + 1)) / cols;
        const cellHeight = (area.height - padding * (rows + 1)) / rows;
        
        for (let i = 0; i < clones.length; i++) {
            const clone = clones[i];
            const col = i % cols;
            const row = Math.floor(i / cols);
            
            const bbox = clone.boundingBox;
            const winWidth = bbox.width > 0 ? bbox.width : 300;
            const winHeight = bbox.height > 0 ? bbox.height : 200;
            
            const scale = Math.min(cellWidth / winWidth, cellHeight / winHeight, maxScale);
            const w = winWidth * scale;
            const h = winHeight * scale;
            
            const cellX = area.x + padding + col * (cellWidth + padding);
            const cellY = area.y + padding + row * (cellHeight + padding);
            
            const x = cellX + (cellWidth - w) / 2;
            const y = cellY + (cellHeight - h) / 2;
            
            slots.push([x, y, w, h, clone]);
        }
        
        return slots;
    }
}
