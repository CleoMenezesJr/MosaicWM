// Copyright 2025-2026 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Settings integration for Mosaic WM

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Logger from './logger.js';

let _iconPath = null;
function _getIcon(extension, iconName) {
    if (!_iconPath) {
        _iconPath = extension.path + '/icons';
    }
    const iconFile = Gio.File.new_for_path(`${_iconPath}/${iconName}.svg`);
    return new Gio.FileIcon({ file: iconFile });
}

const MosaicMenuToggle = GObject.registerClass(
    class MosaicMenuToggle extends QuickSettings.QuickMenuToggle {
        constructor(extension) {
            super({
                title: 'Mosaic',
                gicon: _getIcon(extension, 'mosaic-on-symbolic'),
                toggleMode: true,
            });

            this._extension = extension;
            this._workspaceItems = [];

            this.checked = true;

            this.connect('clicked', () => {
                this._onGlobalToggle();
            });

            this.menu.setHeader(_getIcon(extension, 'mosaic-on-symbolic'), 'Mosaic WM');

            this._workspacesSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._workspacesSection);

            this._workspaceManager = global.workspace_manager;
            this._wsAddedId = this._workspaceManager.connect('workspace-added', () => this._rebuildWorkspaceList());
            this._wsRemovedId = this._workspaceManager.connect('workspace-removed', () => this._rebuildWorkspaceList());
            this._wsSwitchedId = this._workspaceManager.connect('active-workspace-changed', () => this._updateCurrentWorkspaceHighlight());

            this._rebuildWorkspaceList();
        }

        // get_workspace_by_index goes null mid-teardown, so callers never see the hole.
        _eachWorkspace(fn) {
            const nWorkspaces = this._workspaceManager.get_n_workspaces();
            for (let i = 0; i < nWorkspaces; i++) {
                const workspace = this._workspaceManager.get_workspace_by_index(i);
                if (workspace) fn(workspace, i);
            }
        }

        _onGlobalToggle() {
            const enabled = this.checked;
            Logger.log(`Quick Settings: Global toggle ${enabled ? 'ON' : 'OFF'}`);

            this.gicon = _getIcon(this._extension, enabled ? 'mosaic-on-symbolic' : 'mosaic-off-symbolic');

            // Carries over to workspaces that don't exist yet. Per-workspace exceptions
            // are dropped since a global click overrides whatever was picked one by one.
            this._extension._mosaicDisabledByDefault = !enabled;
            this._eachWorkspace(workspace => this._extension._disabledWorkspaceStates.delete(workspace));

            if (enabled) {
                this._eachWorkspace((workspace, i) => {
                    Logger.log(`Quick Settings: Re-tiling workspace ${i + 1} (global toggle)`);
                    const nMonitors = global.display.get_n_monitors();
                    for (let j = 0; j < nMonitors; j++)
                        this._extension.tilingManager.enforceWorkspaceFit(workspace, j);
                });
            } else {
                this._eachWorkspace(workspace => this._extension.disableWorkspaceMosaic(workspace));
            }

            this._rebuildWorkspaceList();
            this._extension._updateIndicatorIcon();
        }

        _rebuildWorkspaceList() {
            this._workspacesSection.removeAll();
            this._workspaceItems = [];

            const nWorkspaces = this._workspaceManager.get_n_workspaces();
            const activeIndex = this._workspaceManager.get_active_workspace_index();

            for (let i = 0; i < nWorkspaces; i++) {
                const workspace = this._workspaceManager.get_workspace_by_index(i);
                const isEnabled = this._extension.isMosaicEnabledForWorkspace(workspace);
                const isActive = i === activeIndex;

                const item = new PopupMenu.PopupSwitchMenuItem(
                    `Workspace ${i + 1}`,
                    isEnabled
                );

                const icon = new St.Icon({
                    gicon: _getIcon(this._extension, 'dot-symbolic'),
                    style_class: 'popup-menu-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                icon.visible = isActive;

                item.insert_child_at_index(icon, 2);
                item._locationIcon = icon;

                item._workspaceIndex = i;
                item.connect('toggled', (menuItem, state) => {
                    this._onWorkspaceToggle(menuItem._workspaceIndex, state);
                });

                this._workspacesSection.addMenuItem(item);
                this._workspaceItems.push(item);
            }

            this._updateGlobalToggleState();

            // Dropping the last enabled workspace has to take the top bar icon with it.
            this._extension._updateIndicatorIcon();
        }

        _updateCurrentWorkspaceHighlight() {
            const activeIndex = this._workspaceManager.get_active_workspace_index();
            const nWorkspaces = this._workspaceManager.get_n_workspaces();

            for (let i = 0; i < this._workspaceItems.length && i < nWorkspaces; i++) {
                const item = this._workspaceItems[i];
                const isActive = i === activeIndex;

                if (item._locationIcon) {
                    item._locationIcon.visible = isActive;
                }
            }

            this._extension._updateIndicatorIcon();
        }

        _onWorkspaceToggle(workspaceIndex, enabled) {
            Logger.log(`Quick Settings: Workspace ${workspaceIndex + 1} mosaic ${enabled ? 'ON' : 'OFF'}`);

            const workspace = this._workspaceManager.get_workspace_by_index(workspaceIndex);
            if (workspace) {
                // Explicit either way: deleting would drop the workspace back to the
                // global default, which is the opposite of what the user just picked.
                this._extension._disabledWorkspaceStates.set(workspace, !enabled);
            }

            this._updateGlobalToggleState();
            this._extension._updateIndicatorIcon();

            if (workspace) {
                if (enabled) {
                    Logger.log(`Quick Settings: Re-tiling workspace ${workspaceIndex + 1}`);
                    const nMonitors = global.display.get_n_monitors();
                    for (let j = 0; j < nMonitors; j++)
                        this._extension.tilingManager.enforceWorkspaceFit(workspace, j);
                } else {
                    this._extension.disableWorkspaceMosaic(workspace);
                }
            }
        }

        _updateGlobalToggleState() {
            const anyEnabled = this._extension.isMosaicEnabledAnywhere();

            this.checked = anyEnabled;
            this.gicon = _getIcon(this._extension, anyEnabled ? 'mosaic-on-symbolic' : 'mosaic-off-symbolic');
        }

        destroy() {
            if (this._wsAddedId) {
                this._workspaceManager.disconnect(this._wsAddedId);
                this._wsAddedId = null;
            }
            if (this._wsRemovedId) {
                this._workspaceManager.disconnect(this._wsRemovedId);
                this._wsRemovedId = null;
            }
            if (this._wsSwitchedId) {
                this._workspaceManager.disconnect(this._wsSwitchedId);
                this._wsSwitchedId = null;
            }

            super.destroy();
        }
    });

export const MosaicIndicator = GObject.registerClass(
    class MosaicIndicator extends QuickSettings.SystemIndicator {
        constructor(extension) {
            super();

            this._extension = extension;

            this._indicator = this._addIndicator();
            this._indicator.gicon = _getIcon(extension, 'mosaic-on-symbolic');

            this._toggle = new MosaicMenuToggle(extension);
            this.quickSettingsItems.push(this._toggle);

            this._workspaceManager = global.workspace_manager;
            this._wsSwitchedId = this._workspaceManager.connect('active-workspace-changed', () => {
                this._updateIcon();
            });

            this._updateIcon();
        }

        _updateIcon() {
            // The off variant means "not on this workspace", so it only makes sense while
            // mosaic still lives somewhere; off everywhere, the icon leaves the bar.
            this._indicator.visible = this._extension.isMosaicEnabledAnywhere();
            if (!this._indicator.visible)
                return;

            const activeIndex = this._workspaceManager.get_active_workspace_index();
            const workspace = this._workspaceManager.get_workspace_by_index(activeIndex);
            const isEnabled = this._extension.isMosaicEnabledForWorkspace(workspace);
            this._indicator.gicon = _getIcon(this._extension, isEnabled ? 'mosaic-on-symbolic' : 'mosaic-off-symbolic');
        }

        destroy() {
            if (this._wsSwitchedId) {
                this._workspaceManager.disconnect(this._wsSwitchedId);
                this._wsSwitchedId = null;
            }

            this.quickSettingsItems.forEach(item => item.destroy());
            super.destroy();
        }
    });
