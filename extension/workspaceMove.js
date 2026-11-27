// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-2.0-or-later
// Marks extension-initiated workspace moves so arrivals are not read as user drops.

import * as WindowState from './windowState.js';
import * as constants from './constants.js';
import { monotonicNow } from './timing.js';

// The arrival side only sees a window leave one workspace and land on another,
// which is also what a user drop looks like. Marking the move here keeps the two
// apart without relying on how long the trip took.
export function moveWindowToWorkspace(window, workspace, reason) {
    WindowState.set(window, 'expectedWorkspaceMove', {
        targetIndex: workspace.index(),
        reason,
        at: monotonicNow(),
    });
    window.change_workspace(workspace);
}

// Consumed once, so a mark that outlives its arrival cannot reclassify a later drag.
export function consumeExpectedMove(window, workspace) {
    const move = WindowState.get(window, 'expectedWorkspaceMove');
    if (!move) return null;

    WindowState.remove(window, 'expectedWorkspaceMove');
    const landed = move.targetIndex === workspace.index();
    const fresh = monotonicNow() - move.at < constants.WORKSPACE_MOVE_MARK_TTL_MS;
    return landed && fresh ? move : null;
}
