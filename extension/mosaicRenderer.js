// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Renders the mosaic model onto its surfaces: real windows, or the overview's clones

import { lerp } from 'resource:///org/gnome/shell/misc/util.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Logger from './logger.js';
import { MosaicModel } from './mosaicModel.js';
import { MosaicConstraints } from './mosaicConstraint.js';
import { isWindowAlive } from './liveness.js';
import * as WindowState from './windowState.js';
import { IS_MINIATURE } from './windowState.js';

export class MosaicRenderer {
    constructor(animations) {
        this._animations = animations;
        // The shell creates a new WorkspaceLayout for each overview session, so these last only
        // while it is open; clearOverviewLayouts drops them on hide.
        this._overviewLayouts = new Map();
        this._slotBlends = [];
    }

    // Key shape matches MosaicModel: workspace index plus monitor, not the GObject itself, because
    // GJS may return another wrapper for the same workspace.
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

    // Exiting the overview freezes its slots ahead of 'hiding', and the shell never lets a window
    // fall below its slot while leaving, so a window miniaturized in 'hiding' rides out full-size
    // and snaps small on 'hidden'. Sliding each slot to the published one as the state runs 1 -> 0
    // starts from the frozen geometry and lands on the desktop.
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

    // _needsLayout is the flag vfunc_allocate actually checks before slots are rebuilt; the shell's
    // own addWindow/removeWindow set it. layout_changed merely schedules allocation, so without the
    // flag the pass keeps using the slots already present.
    publishToOverview(workspace, monitor) {
        const layouts = this._overviewLayouts.get(this._key(workspace, monitor));
        if (!layouts || layouts.size === 0) return;

        Logger.log(`[RENDER] Publishing ${layouts.size} overview layout(s) for WS-${workspace.index()} monitor ${monitor}`);
        for (const layout of layouts) {
            layout._needsLayout = true;
            layout.layout_changed();
        }
    }

    // Applies the layout's existing decision rather than recomputing it, so the desktop lands on
    // exactly the geometry the overview showed.
    flushToWindows(workspace, monitor) {
        const group = MosaicModel.store.groupFor(workspace.index(), monitor);
        if (!group || group.size === 0) return;

        // Windows that claimed an entrance while the overview was open could not play it:
        // Mutter drops frame moves until it closes. The 'hidden' flush is the first moment
        // the move is accepted, so replay the slide there instead of committing it silently.
        const layouts = [...group.members()]
            .filter(m => isWindowAlive(m.window) && !WindowState.get(m.window, IS_MINIATURE))
            .map(m => ({ window: m.window, rect: m.region }));

        let applied = 0;
        for (const member of group.members()) {
            if (!isWindowAlive(member.window)) continue;
            // createMiniature drives the miniature through the actor's scale, so moving the frame
            // here would compound atop it.
            if (WindowState.get(member.window, IS_MINIATURE)) continue;
            const r = member.region;
            const claim = WindowState.get(member.window, 'pendingFirstPlacement');
            // A settle pass can start the entrance first and sit on the claim; replaying
            // over it re-zeros the opacity so the fade is actually visible.
            if (claim && !Main.overview.visible) {
                this._animations.animateDeferredEntrance(member.window, r, layouts);
            } else {
                MosaicConstraints.commitRegion(member.window, r);
            }
            applied++;
        }
        Logger.log(`[FLUSH] Applied ${applied} region(s) to WS-${workspace.index()} monitor ${monitor}`);
    }

    destroy() {
        this._stopSlotBlends();
        this._overviewLayouts.clear();
    }
}
