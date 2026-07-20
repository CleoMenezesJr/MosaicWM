// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// A mosaic partition: the windows of one workspace/monitor and the region each one owns

// Mirrors what a MetaTileGroup would carry, so migrating this upstream is a move rather
// than a rewrite. No gi:// import here on purpose; the partition is pure geometry.

// Two regions splitting the work area along one axis. Callers used to write the "who goes
// first" if/else by hand; here the order is just the order of the arguments.
//
// Read field by field, never spread: a work area straight from Mutter is an Mtk.Rectangle whose
// geometry lives on the prototype, so {...workArea} is {} and every field turns undefined.
export function splitAlongAxis(workArea, axis, firstSize, secondSize) {
    const base = { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
    const sizeKey = axis === 'x' ? 'width' : 'height';
    return [
        { ...base, [sizeKey]: firstSize },
        { ...base, [axis]: base[axis] + firstSize, [sizeKey]: secondSize },
    ];
}

// Same reason splitAlongAxis reads field by field: an Mtk.Rectangle spreads to {}, and a work
// area of undefined makes every partition check quietly pass.
export function rectOf(rect) {
    if (!rect) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export class MosaicTileGroup {
    constructor(workspaceIndex, monitor, workArea) {
        this.workspaceIndex = workspaceIndex;
        this.monitor = monitor;
        this.workArea = rectOf(workArea);
        this._members = new Map();
    }

    get size() {
        return this._members.size;
    }

    // The floor is what the client taught us, not part of this placement, so it outlives every
    // retile that rewrites the region.
    setMember(windowId, { window, region }) {
        const floor = this._members.get(windowId)?.floor;
        this._members.set(windowId, {
            windowId,
            window,
            region: { x: region.x, y: region.y, width: region.width, height: region.height },
            ...(floor ? { floor } : {}),
        });
    }

    memberOf(windowId) {
        return this._members.get(windowId) ?? null;
    }

    regionOf(windowId) {
        return this._members.get(windowId)?.region ?? null;
    }

    members() {
        return [...this._members.values()];
    }

    // The smallest size a window has actually held. Clients declare a minimum that reads higher
    // than what they really accept (measured: an editor declaring 666 sitting at 616), and a
    // floor that overestimates refuses layouts that would have worked.
    noteObservedSize(windowId, size) {
        const member = this._members.get(windowId);
        if (!member) return;
        const floor = member.floor;
        member.floor = floor
            ? { width: Math.min(floor.width, size.width), height: Math.min(floor.height, size.height) }
            : { width: size.width, height: size.height };
    }

    floorOf(windowId) {
        return this._members.get(windowId)?.floor ?? null;
    }

    // An unknown window answers yes: denying on ignorance would reject every first encounter,
    // and a wrong denial is worse than the overlap it replaces.
    splitFits(available, axis, windowIds) {
        const sizeKey = axis === 'x' ? 'width' : 'height';
        let needed = 0;
        for (const id of windowIds) {
            const floor = this._members.get(id)?.floor;
            if (!floor) return true;
            needed += floor[sizeKey];
        }
        return needed <= available;
    }

    removeMember(windowId) {
        return this._members.delete(windowId);
    }

    // Exemption is policy, not geometry, so the caller decides who's exempt. Reported instead
    // of thrown since a violation means the layout is wrong, and dropping the window would hide that.
    partitionViolations(isExempt = () => false) {
        const wa = this.workArea;
        const violations = [];
        for (const member of this._members.values()) {
            if (isExempt(member.window)) continue;
            const r = member.region;
            if (r.x < wa.x || r.y < wa.y ||
                r.x + r.width > wa.x + wa.width ||
                r.y + r.height > wa.y + wa.height)
                violations.push(member);
        }
        return violations;
    }
}

export class MosaicTileGroupStore {
    constructor() {
        this._groups = new Map();
        this._windowIndex = new Map();
    }

    _key(workspaceIndex, monitor) {
        return `${workspaceIndex}:${monitor}`;
    }

    groupFor(workspaceIndex, monitor) {
        return this._groups.get(this._key(workspaceIndex, monitor)) ?? null;
    }

    ensureGroup(workspaceIndex, monitor, workArea) {
        const key = this._key(workspaceIndex, monitor);
        let group = this._groups.get(key);
        if (!group) {
            group = new MosaicTileGroup(workspaceIndex, monitor, workArea);
            this._groups.set(key, group);
        } else if (workArea) {
            group.workArea = rectOf(workArea);
        }
        return group;
    }

    // The reverse index is what keeps a window from lingering in its old group when it
    // changes workspace or monitor, which is the way a partition silently gains a ghost.
    noteMembership(windowId, group) {
        const previous = this._windowIndex.get(windowId);
        if (previous && previous !== group) previous.removeMember(windowId);
        this._windowIndex.set(windowId, group);
    }

    groupOfWindow(windowId) {
        return this._windowIndex.get(windowId) ?? null;
    }

    removeWindow(windowId) {
        this._windowIndex.get(windowId)?.removeMember(windowId);
        this._windowIndex.delete(windowId);
    }

    // Kept on the store rather than on the group so the group stays a plain partition with
    // no back-reference to whoever is holding it.
    setMember(workspaceIndex, monitor, workArea, windowId, member) {
        const group = this.ensureGroup(workspaceIndex, monitor, workArea);
        group.setMember(windowId, member);
        this.noteMembership(windowId, group);
        return group;
    }

    clear() {
        this._groups.clear();
        this._windowIndex.clear();
    }
}
