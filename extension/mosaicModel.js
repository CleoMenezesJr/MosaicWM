// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Authoritative mosaic geometry: what the layout wants, independent of what Mutter applied

// Keyed by window ID, not the GObject, to survive GI reference churn (same reason
// windowState.js exists). Each entry carries its workspace/monitor so a flush can
// target one workspace without asking which is active.
const _entries = new Map();

function idOf(window) {
    return window?.get_id?.();
}

export const MosaicModel = {
    setSlot(window, slot, workspace, monitor) {
        const id = idOf(window);
        if (id === undefined) return;
        _entries.set(id, {
            window,
            slot: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
            workspaceIndex: workspace?.index?.() ?? null,
            monitor: monitor ?? null,
        });
    },

    slotFor(window) {
        const id = idOf(window);
        return id === undefined ? null : (_entries.get(id)?.slot ?? null);
    },

    // The layout's intent beats the live frame: mid-animation the frame is a transient
    // size, and with the overview open Mutter drops our moves entirely.
    geometryOf(window) {
        const slot = this.slotFor(window);
        if (slot) return slot;
        const frame = window?.get_frame_rect?.();
        return frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null;
    },

    entriesFor(workspace, monitor) {
        const wsIndex = workspace?.index?.();
        const out = [];
        for (const entry of _entries.values()) {
            if (entry.workspaceIndex === wsIndex && entry.monitor === monitor)
                out.push({ window: entry.window, slot: entry.slot });
        }
        return out;
    },

    // The client refused or changed the size on its own, so the model takes the real
    // frame as the new intent instead of fighting it back.
    learn(window, frame) {
        const id = idOf(window);
        const entry = id !== undefined ? _entries.get(id) : undefined;
        if (!entry) return;
        entry.slot = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
    },

    forget(window) {
        const id = idOf(window);
        if (id !== undefined) _entries.delete(id);
    },

    forgetById(id) { _entries.delete(id); },

    clear() { _entries.clear(); },
};

// Existing call sites speak this shape; kept so moving the store is not also an API churn.
export const ComputedLayouts = {
    get(mw) { return MosaicModel.slotFor(mw) ?? undefined; },
    set(mw, layout) { MosaicModel.setSlot(mw, layout, mw?.get_workspace?.(), mw?.get_monitor?.()); },
    delete(mw) { MosaicModel.forget(mw); },
    deleteById(id) { MosaicModel.forgetById(id); },
    clear() { MosaicModel.clear(); },
};
