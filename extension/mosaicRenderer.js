// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Renders the mosaic model onto its surfaces: real windows, or the overview's clones

import * as Logger from './logger.js';
import { MosaicModel } from './mosaicModel.js';
import { isWindowAlive } from './liveness.js';
import * as WindowState from './windowState.js';
import { IS_MINIATURE } from './windowState.js';

export class MosaicRenderer {
    constructor() {
        // The shell builds a fresh WorkspaceLayout per overview session, so these only
        // hold while it is open; clearOverviewLayouts drops them on hide.
        this._overviewLayouts = new Map();
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
        this._overviewLayouts.clear();
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
            member.window.move_resize_frame(false, r.x, r.y, r.width, r.height);
            applied++;
        }
        Logger.log(`[FLUSH] Applied ${applied} region(s) to WS-${workspace.index()} monitor ${monitor}`);
    }

    destroy() {
        this._overviewLayouts.clear();
    }
}
