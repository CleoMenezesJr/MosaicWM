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

                const frozen = new Map(from.map(slot => [slot[4], slot]));
                const to = new Map(layout._getWindowSlots(layout._windowSlotsBox).map(slot => [slot[4], slot]));
                const adjustment = layout._stateAdjustment;
                const blend = () => {
                    const t = adjustment.value;
                    // A preview added mid-exit only exists in the shell's rebuilds; clamping to
                    // the freeze-time list would leave it unallocated and painting full-size. The
                    // exit never re-aims a sibling at a layout published after the freeze, since
                    // a late target would cross the whole push in its last frames.
                    layout._windowSlots = layout._windowSlots.map(([x, y, w, h, child]) => {
                        const start = frozen.get(child);
                        const target = to.get(child);
                        if (!start || !target) return [x, y, w, h, child];
                        return [
                            lerp(target[0], start[0], t), lerp(target[1], start[1], t),
                            lerp(target[2], start[2], t), lerp(target[3], start[3], t), child,
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

        const members = group.members().filter(member => isWindowAlive(member.window));
        const hasEntrance = members.some(member => WindowState.get(member.window, 'pendingFirstPlacement'));

        let applied = 0;
        let deferred = 0;
        for (const member of members) {
            // createMiniature drives the miniature through the actor's scale, so moving the frame
            // here would compound atop it.
            if (WindowState.get(member.window, IS_MINIATURE)) continue;
            const r = member.region;
            // An entrance claimed while the overview was up converges here: the closing flush
            // lands the frame; the one after the cut settles it or leaves it to the queued pass.
            if (WindowState.get(member.window, 'pendingFirstPlacement')) {
                this._animations.finishOverviewArrival(member.window, r);
            } else if (hasEntrance && !Main.overview.visible && !this._frameMatches(member.window, r)) {
                // The pass queued behind this flush owns the push; committing the sibling here
                // would land it first and leave the entrance with nothing to animate.
                deferred++;
                continue;
            } else {
                MosaicConstraints.commitRegion(member.window, r);
            }
            applied++;
        }
        Logger.log(`[FLUSH] Applied ${applied} region(s), ${deferred} deferred to reflow, to WS-${workspace.index()} monitor ${monitor}`);
    }

    _frameMatches(window, rect) {
        const frame = window.get_frame_rect();
        return frame.x === rect.x && frame.y === rect.y &&
            frame.width === rect.width && frame.height === rect.height;
    }

    destroy() {
        this._stopSlotBlends();
        this._overviewLayouts.clear();
    }
}
