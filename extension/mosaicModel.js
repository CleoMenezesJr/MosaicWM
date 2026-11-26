// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Authoritative mosaic geometry: what the layout wants, independent of what Mutter applied

import { MosaicTileGroupStore } from './mosaicTileGroup.js';

// Groups hold the regions; this is the extension's existing window-keyed view over them. It keys by
// window ID, not the GObject, to survive GI reference churn (same reason windowState.js exists).
const _store = new MosaicTileGroupStore();

function idOf(window) {
    return window?.get_id?.();
}

export const MosaicModel = {
    store: _store,

    setRegion(window, region, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;
        _store.setMember(workspace?.index?.() ?? null, monitor ?? null, null, id, { window, region });
    },

    regionFor(window) {
        const id = idOf(window);
        if (id === undefined) return null;
        return _store.groupOfWindow(id)?.regionOf(id) ?? null;
    },

    // Layout intent outranks the live frame: during animation the size is transient, and while the
    // overview is open Mutter discards our moves entirely.
    geometryOf(window) {
        const region = this.regionFor(window);
        if (region) return region;
        const frame = window?.get_frame_rect?.();
        return frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null;
    },

    // The client refused or independently changed the size, so the model treats the actual frame as
    // the new intent instead of opposing it.
    learn(window, frame) {
        const id = idOf(window);
        const group = id !== undefined ? _store.groupOfWindow(id) : null;
        const member = group?.memberOf(id);
        if (!member) return;
        // Store's setMember also keeps the reverse index, but this call never shifts the window to
        // another group, and no workspace/monitor exists to supply here anyway.
        group.setMember(id, { ...member, region: frame });
    },

    forget(window) {
        const id = idOf(window);
        if (id !== undefined) _store.removeWindow(id);
    },

    forgetById(id) { _store.removeWindow(id); },

    clear() { _store.clear(); },
};

// Current call sites use this shape; kept so relocating the store does not also require API churn.
export const ComputedLayouts = {
    get(mw) { return MosaicModel.regionFor(mw) ?? undefined; },
    set(mw, layout) { MosaicModel.setRegion(mw, layout, mw?.get_workspace?.(), mw?.get_monitor?.()); },
    delete(mw) { MosaicModel.forget(mw); },
    deleteById(id) { MosaicModel.forgetById(id); },
    clear() { MosaicModel.clear(); },
};
