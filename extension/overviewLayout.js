// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Custom layout strategy to preserve mosaic geometry in Overview

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import { ComputedLayouts } from './tiling.js';
import * as Logger from './logger.js';
import { getTilingManager } from './extension.js';

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
        
        if (clones.length === 0)
            return [];

        // Filter out attached dialogs (visually merged with parent window)
        // These expand the parent's bounding box in Overview causing layout issues
        const filteredClones = clones.filter(clone => {
            const metaWindow = clone.metaWindow || clone.source?.metaWindow;
            if (!metaWindow) return true; // Keep clones without metaWindow (fallback)
            
            // Only exclude attached dialogs (visually merged with parent)
            if (metaWindow.is_attached_dialog()) return false;
            
            // Also exclude transient modal dialogs (which appear when we detach them)
            // This ensures we hide the detached modal while keeping the parent clean
            if (metaWindow.get_transient_for() !== null) return false;
            
            return true;
        });
        
        // Safety check: If we filtered everything, but input wasn't empty, 
        // it might be better to show *something* rather than nothing?
        // For now, let's respect the filter (attached dialogs really shouldn't be shown separately)
        if (filteredClones.length === 0)
            return [];

        // Check cache completeness
        let allCached = this._isCacheComplete(filteredClones);

        // If cache incomplete, try to populate it during layout computation
        // Use a flag to prevent infinite recursion if calculateLayoutsOnly triggers a relayout
        if (!allCached && !this._calculating) {
            this._calculating = true;
            try {
                const tilingManager = getTilingManager();
                if (tilingManager) {
                    // Determine workspace from the first clone that has a metaWindow
                    let workspace = null;
                    for (const clone of filteredClones) {
                        const mw = clone.metaWindow || clone.source?.metaWindow;
                        if (mw) {
                            workspace = mw.get_workspace();
                            break;
                        }
                    }
                    
                    if (workspace) {
                        tilingManager.calculateLayoutsOnly(workspace, this._monitor.index);
                    } else {
                         // Fallback if no workspace found (shouldn't happen if there are clones)
                         tilingManager.calculateLayoutsOnly(null, this._monitor.index);
                    }
                }
            } catch (e) {
                Logger.error(`[MOSAIC WM] Overview: Error calculating layouts: ${e.message}`, e);
            } finally {
                this._calculating = false;
            }
            
            // Re-check after population attempt
            allCached = this._isCacheComplete(filteredClones);
        }
        
        // GRACEFUL DEGRADATION: If cache is still incomplete, use GNOME's default layout
        // This ensures windows appear correctly positioned (even if not in mosaic) until tiling is ready
        if (!allCached) {
            return this._computeDefaultSlots(filteredClones, area);
        }

        // Determine workspace from the first clone that has a metaWindow
        let workspace = null;
        for (const clone of filteredClones) {
            const mw = clone.metaWindow || clone.source?.metaWindow;
            if (mw) {
                workspace = mw.get_workspace();
                break;
            }
        }
        
        if (!workspace) {
            return this._computeDefaultSlots(filteredClones, area);
        }

        // --- STABLE SCALING (Viewport Mirror) ---
        // Instead of scaling based on the bounding box of windows (which is unstable),
        // we scale based on the real Monitor Work Area. This ensures 1:1 spatial memory.
        const monitorIndex = this._monitor.index;
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);

        if (!workArea || workArea.width <= 0 || workArea.height <= 0) {
            return this._computeDefaultSlots(filteredClones, area);
        }

        // Calculate uniform scale based on Work Area
        const scale = Math.min(
            area.width / workArea.width,
            area.height / workArea.height,
            1.0
        );

        // Center the "mirror" within the overview slot
        const scaledWidth = workArea.width * scale;
        const scaledHeight = workArea.height * scale;
        const offsetX = (area.width - scaledWidth) / 2;
        const offsetY = (area.height - scaledHeight) / 2;

        // Return layout slots
        const slots = [];
        for (const clone of filteredClones) {
            let winId = null;
            if (clone.metaWindow) {
                winId = clone.metaWindow.get_id();
            } else if (clone.source && clone.source.metaWindow) {
                winId = clone.source.metaWindow.get_id();
            }

            const rect = ComputedLayouts.get(winId);
            if (!rect) continue;
            
            // Map absolute screen coordinates to the Overview slot
            // Formula: (DesktopPos - DesktopOrigin) * Scale + OverviewSlotOrigin + CenteringOffset
            const x = (rect.x - workArea.x) * scale + area.x + offsetX;
            const y = (rect.y - workArea.y) * scale + area.y + offsetY;
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
                // Strict check: Must exists AND have finite positive dimensions
                // Note: (NaN <= 0) is false, so we must use isFinite/isNaN checks
                if (!cached || 
                    !Number.isFinite(cached.x) || 
                    !Number.isFinite(cached.y) || 
                    !Number.isFinite(cached.width) || 
                    !Number.isFinite(cached.height) || 
                    cached.width <= 0 || 
                    cached.height <= 0) {
                    return false;
                }
            } else {
                // If we have a clone without a metaWindow, we can't use the mosaic layout
                // (because we can't look up its position in ComputedLayouts)
                // So we must report incomplete cache to force fallback to default layout
                return false;
            }
        }
        return true;
    }
    
    // Fallback: Simple centered layout (similar to GNOME's default)
    _computeDefaultSlots(clones, area) {
        try {
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
                
                // Use metaWindow frame_rect if available (excludes attached dialogs)
                // Otherwise fall back to clone's boundingBox
                const metaWindow = clone.metaWindow || clone.source?.metaWindow;
                let winWidth = 300, winHeight = 200;
                
                if (metaWindow) {
                    try {
                        const frameRect = metaWindow.get_frame_rect();
                        winWidth = frameRect.width > 0 ? frameRect.width : 300;
                        winHeight = frameRect.height > 0 ? frameRect.height : 200;
                    } catch (e) {
                         // ignore
                    }
                } else if (clone.boundingBox) {
                    const bbox = clone.boundingBox;
                    winWidth = bbox.width > 0 ? bbox.width : 300;
                    winHeight = bbox.height > 0 ? bbox.height : 200;
                } else if (clone.width > 0 && clone.height > 0) {
                     winWidth = clone.width;
                     winHeight = clone.height;
                }
                
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
        } catch (e) {
            Logger.error(`[MOSAIC WM] Overview: _computeDefaultSlots failed: ${e.message}`);
            return [];
        }
    }
}
