// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// A mosaic partition: the windows of one workspace/monitor and the region each one owns

// Mirrors what a MetaTileGroup would carry, so migrating this upstream is a move rather
// than a rewrite. No gi:// import here on purpose; the partition is pure geometry.

export class MosaicTileGroup {
    constructor(workspaceIndex, monitor, workArea) {
        this.workspaceIndex = workspaceIndex;
        this.monitor = monitor;
        this.workArea = { ...workArea };
        this._members = new Map();
    }

    get size() {
        return this._members.size;
    }

    setMember(windowId, { window, region }) {
        this._members.set(windowId, {
            windowId,
            window,
            region: { x: region.x, y: region.y, width: region.width, height: region.height },
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
            group.workArea = { ...workArea };
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
