// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Settings integration for Mosaic WM

import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Logger from './logger.js';

// Helper to get GIcon for custom icons
let _iconPath = null;
function _getIcon(extension, iconName) {
    if (!_iconPath) {
        _iconPath = extension.path + '/icons';
    }
    const iconFile = Gio.File.new_for_path(`${_iconPath}/${iconName}.svg`);
    return new Gio.FileIcon({ file: iconFile });
}

// MosaicMenuToggle - Quick Settings toggle with per-workspace menu
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
        
        // Set initial state
        this.checked = true;
        
        // Connect toggle to global enable/disable
        this.connect('clicked', () => {
            this._onGlobalToggle();
        });
        
        // Build the menu header
        this.menu.setHeader(_getIcon(extension, 'mosaic-on-symbolic'), 'Mosaic WM');
        
        // Workspaces section
        this._workspacesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._workspacesSection);
        
        // Connect to workspace signals
        this._workspaceManager = global.workspace_manager;
        this._wsAddedId = this._workspaceManager.connect('workspace-added', () => this._rebuildWorkspaceList());
        this._wsRemovedId = this._workspaceManager.connect('workspace-removed', () => this._rebuildWorkspaceList());
        this._wsSwitchedId = this._workspaceManager.connect('active-workspace-changed', () => this._updateCurrentWorkspaceHighlight());
        
        // Build initial workspace list (after _workspaceManager is set)
        this._rebuildWorkspaceList();
    }
    
    _onGlobalToggle() {
        const enabled = this.checked;
        Logger.log(`[MOSAIC WM] Quick Settings: Global toggle ${enabled ? 'ON' : 'OFF'}`);
        
        // Update icon
        this.gicon = _getIcon(this._extension, enabled ? 'mosaic-on-symbolic' : 'mosaic-off-symbolic');
        
        if (enabled) {
            // Enable mosaic on all workspaces
            this._extension._disabledWorkspaces.clear();
            
            // Re-tile all workspaces (monitor detection is automatic)
            const nWorkspaces = this._workspaceManager.get_n_workspaces();
            for (let i = 0; i < nWorkspaces; i++) {
                const workspace = this._workspaceManager.get_workspace_by_index(i);
                if (workspace) {
                    Logger.log(`[MOSAIC WM] Quick Settings: Re-tiling workspace ${i + 1} (global toggle)`);
                    this._extension.tilingManager.tileWorkspaceWindows(workspace, null, null, false);
                }
            }
        } else {
            // Disable mosaic on all workspaces
            const nWorkspaces = this._workspaceManager.get_n_workspaces();
            for (let i = 0; i < nWorkspaces; i++) {
                this._extension._disabledWorkspaces.add(i);
            }
        }
        
        this._rebuildWorkspaceList();
        this._extension._updateIndicatorIcon();
    }
    
    _rebuildWorkspaceList() {
        // Clear existing items
        this._workspacesSection.removeAll();
        this._workspaceItems = [];
        
        const nWorkspaces = this._workspaceManager.get_n_workspaces();
        const activeIndex = this._workspaceManager.get_active_workspace_index();
        
        for (let i = 0; i < nWorkspaces; i++) {
            const isEnabled = !this._extension._disabledWorkspaces.has(i);
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
            
            // Insert after label (label is usually index 1 after ornament)
            item.insert_child_at_index(icon, 2);
            item._locationIcon = icon;
            
            item._workspaceIndex = i;
            item.connect('toggled', (menuItem, state) => {
                this._onWorkspaceToggle(menuItem._workspaceIndex, state);
            });
            
            this._workspacesSection.addMenuItem(item);
            this._workspaceItems.push(item);
        }
        
        // Update global toggle state based on workspace states
        this._updateGlobalToggleState();
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
        
        // Update indicator icon for current workspace
        this._extension._updateIndicatorIcon();
    }
    
    _onWorkspaceToggle(workspaceIndex, enabled) {
        Logger.log(`[MOSAIC WM] Quick Settings: Workspace ${workspaceIndex + 1} mosaic ${enabled ? 'ON' : 'OFF'}`);
        
        if (enabled) {
            this._extension._disabledWorkspaces.delete(workspaceIndex);
        } else {
            this._extension._disabledWorkspaces.add(workspaceIndex);
        }
        
        this._updateGlobalToggleState();
        this._extension._updateIndicatorIcon();
        
        // Re-tile the affected workspace if enabling
        if (enabled) {
            const workspace = this._workspaceManager.get_workspace_by_index(workspaceIndex);
            if (workspace) {
                Logger.log(`[MOSAIC WM] Quick Settings: Re-tiling workspace ${workspaceIndex + 1}`);
                // Monitor detection is automatic in tileWorkspaceWindows
                this._extension.tilingManager.tileWorkspaceWindows(workspace, null, null, false);
            }
        }
    }
    
    _updateGlobalToggleState() {
        // Global toggle is ON if any workspace has mosaic enabled
        const anyEnabled = this._extension._disabledWorkspaces.size < this._workspaceManager.get_n_workspaces();
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

// MosaicIndicator - System indicator with icon in top bar
export const MosaicIndicator = GObject.registerClass(
class MosaicIndicator extends QuickSettings.SystemIndicator {
    constructor(extension) {
        super();
        
        this._extension = extension;
        
        // Create the indicator icon
        this._indicator = this._addIndicator();
        this._indicator.gicon = _getIcon(extension, 'mosaic-on-symbolic');
        this._indicator.visible = true;
        
        // Create the toggle menu
        this._toggle = new MosaicMenuToggle(extension);
        this.quickSettingsItems.push(this._toggle);
        
        // Connect to workspace switch to update icon
        this._workspaceManager = global.workspace_manager;
        this._wsSwitchedId = this._workspaceManager.connect('active-workspace-changed', () => {
            this._updateIcon();
        });
    }
    
    _updateIcon() {
        const activeIndex = this._workspaceManager.get_active_workspace_index();
        const isEnabled = !this._extension._disabledWorkspaces.has(activeIndex);
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
