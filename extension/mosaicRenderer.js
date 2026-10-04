// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Renders the mosaic model onto its surfaces: real windows, or the overview's clones

import { lerp } from 'resource:///org/gnome/shell/misc/util.js';

import * as Logger from './logger.js';
import { MosaicModel } from './mosaicModel.js';
import { MosaicConstraints } from './mosaicConstraint.js';
import { isWindowAlive } from './liveness.js';
import * as WindowState from './windowState.js';
import { IS_MINIATURE } from './windowState.js';

export class MosaicRenderer {
    constructor() {
        // The shell builds a fresh WorkspaceLayout per overview session, so these only
        // hold while it is open; clearOverviewLayouts drops them on hide.
        this._overviewLayouts = new Map();
        this._slotBlends = [];
    }

    // Same key shape as MosaicModel: workspace index plus monitor, not the GObject
    // itself, since GJS can hand back a different wrapper for the same workspace.
    _key(workspace, monitor) {
        return `${workspace.index()}:${monitor}`;
    }

    registerOverviewLayout(workspace, monitor, layout) {
        const key = this._key(workspace, monitor);
        let layouts = this._overviewLayouts.get(key);
        if (!layouts) {
            layouts = new Set();
            this._overviewLayouts.set(key, layouts);
        }
        layouts.add(layout);
    }

    clearOverviewLayouts() {
        this._stopSlotBlends();
        this._overviewLayouts.clear();
    }

    // Leaving the overview freezes its slots before 'hiding', and the shell never lets a window
    // drop below its slot on the way out, so a window miniaturized in 'hiding' rides out at full
    // size and snaps small on 'hidden'. Sliding each slot to the published one as the state
    // runs 1 -> 0 starts from the frozen geometry and lands where the desktop is.
    blendFrozenOverviewSlots() {
        for (const layouts of this._overviewLayouts.values()) {
            for (const layout of layouts) {
                if (!layout._needsLayout || !layout._windowSlots || !layout._windowSlotsBox) continue;

                const from = layout._windowSlots.map(slot => [...slot]);
                layout._layout = layout._createBestLayout(layout._workarea);
                const to = new Map(layout._getWindowSlots(layout._windowSlotsBox).map(slot => [slot[4], slot]));

                const adjustment = layout._stateAdjustment;
                const blend = () => {
                    const t = adjustment.value;
                    layout._windowSlots = from.map(([x, y, w, h, child]) => {
                        const target = to.get(child);
                        if (!target) return [x, y, w, h, child];
                        return [
                            lerp(target[0], x, t), lerp(target[1], y, t),
                            lerp(target[2], w, t), lerp(target[3], h, t), child,
                        ];
                    });
                };
                adjustment.connectObject('notify::value', blend, layout);
                this._slotBlends.push([adjustment, layout]);
                blend();
                Logger.log(`[RENDER] Blending ${from.length} frozen overview slot(s) toward the published layout`);
            }
        }
    }

    _stopSlotBlends() {
        for (const [adjustment, layout] of this._slotBlends)
            adjustment.disconnectObject(layout);
        this._slotBlends = [];
    }

    // _needsLayout is the flag vfunc_allocate actually gates on before rebuilding slots;
    // it is what the shell's own addWindow/removeWindow set. layout_changed only schedules
    // the allocation, so without the flag the pass reuses the slots it already had.
    publishToOverview(workspace, monitor) {
        const layouts = this._overviewLayouts.get(this._key(workspace, monitor));
        if (!layouts || layouts.size === 0) return;

        Logger.log(`[RENDER] Publishing ${layouts.size} overview layout(s) for WS-${workspace.index()} monitor ${monitor}`);
        for (const layout of layouts) {
            layout._needsLayout = true;
            layout.layout_changed();
        }
    }

    // Applies what the layout already decided instead of recomputing it, so the desktop
    // lands on exactly the geometry the overview was showing.
    flushToWindows(workspace, monitor) {
        const group = MosaicModel.store.groupFor(workspace.index(), monitor);
        if (!group || group.size === 0) return;

        let applied = 0;
        for (const member of group.members()) {
            if (!isWindowAlive(member.window)) continue;
            // createMiniature drives the miniature through the actor's scale, so moving the
            // frame here would compound on top of it.
            if (WindowState.get(member.window, IS_MINIATURE)) continue;
            const r = member.region;
            MosaicConstraints.commitRegion(member.window, r);
            applied++;
        }
        Logger.log(`[FLUSH] Applied ${applied} region(s) to WS-${workspace.index()} monitor ${monitor}`);
    }

    destroy() {
        this._stopSlotBlends();
        this._overviewLayouts.clear();
    }
}
