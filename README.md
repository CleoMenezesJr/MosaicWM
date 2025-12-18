# Mosaic WM

**Rethinking window management for GNOME Shell**

A GNOME Shell extension that provides automatic window tiling in a mosaic layout. Inspired by [GNOME's vision for rethinking window management](https://blogs.gnome.org/tbernard/2023/07/26/rethinking-window-management/), Mosaic WM intelligently arranges windows to maximize screen space while maintaining visual harmony.

> [!WARNING]
> **Experimental Extension**: This extension is under active development and may contain bugs or unexpected behavior. Use at your own risk. Please report any issues.

> [!NOTE]
> Developed for GNOME Shell 49. Tested only on this version.

## 💡 Philosophy

Traditional window management forces users to manually position and resize windows. Mosaic WM takes a different approach:

- **Automatic**: Windows organize themselves intelligently
- **Adaptive**: Layout responds to your workflow
- **Minimal**: No manual tiling or complex keyboard shortcuts needed
- **Visual**: See your workspace at a glance

This aligns with GNOME's philosophy of reducing cognitive load and letting users focus on their work, not window management.

## ✨ Features

### Core Tiling
- 🎯 **Automatic Mosaic Layout**: Windows are automatically arranged in an optimal layout using a radial packing algorithm
- 🔄 **Smart Resize**: Before moving windows to new workspaces, the extension tries to resize existing windows to make space
- 📐 **Edge Tiling (Snap Zones)**: Drag windows to screen edges for half/quarter tiling - remaining windows adapt to the available space
- 🔀 **Window Swapping**: Drag a window onto another to swap their positions

### Overflow & Workspaces  
- 🚀 **Intelligent Overflow**: Windows that don't fit are moved to existing workspaces when possible, or create new ones
- 🖥️ **Fullscreen Support**: Fullscreen and maximized windows automatically get dedicated workspaces
- 🔙 **Reverse Smart Resize**: When windows leave, remaining windows expand back to their original sizes

### Animations & Polish
- ✨ **Directional Momentum**: Windows slide in from the direction they came from, with a bouncy animation
- 🎬 **Smooth Transitions**: All layout changes are animated for a polished feel
- 👁️ **Visual Feedback**: Live preview during drag operations shows where windows will land

### Other
- ⌨️ **Keyboard Shortcuts**: Swap windows with keyboard (configurable)
- 🖥️ **Multi-Monitor**: Works across multiple displays (experimental)

## 📦 Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/CleoMenezesJr/MosaicWM.git
cd MosaicWM

# Install the extension
./scripts/build.sh -i

# Log out and log back in, then enable
gnome-extensions enable mosaicwm@cleomenezesjr.github.io
```

### Manual Installation

1. Download the latest release from GitHub
2. Extract to `~/.local/share/gnome-shell/extensions/mosaicwm@cleomenezesjr.github.io/`
3. **Disable debug logging**: Edit `extension/logger.js` and set `const DEBUG = false;`
4. Restart GNOME Shell (log out and log back in)
5. Enable via Extensions app or: `gnome-extensions enable mosaicwm@cleomenezesjr.github.io`

## 🎮 Usage

Once enabled, the extension works automatically:

- **Open windows**: They'll be automatically tiled
- **Drag windows**: Click and drag to reorder
- **Maximize/Fullscreen**: Window moves to its own workspace
- **Minimize**: Window is excluded from tiling
- **Too many windows**: Overflow windows move to new workspace

### Prerequisites

- GNOME Shell 49+
- Git

### Building & Testing

```bash
# Install the extension
./scripts/build.sh -i

# Test in a nested GNOME Shell session
./scripts/run-gnome-shell.sh
```

### Enable Debug Logging

Debug logging is enabled by default for development. To enable verbose debug logs, edit `extension/logger.js` and set:

```javascript
const DEBUG = true;
```

> [!TIP]
> For production/installation, set `DEBUG = false` to reduce CPU usage.

### Debugging

For debugging and development tips, see the [GJS Extension Development Guide](https://gjs.guide/extensions/development/debugging.html).

View logs in real-time:

```bash
# Monitor extension logs
journalctl -f -o cat /usr/bin/gnome-shell | grep -i mosaic

# Or use GNOME's Looking Glass (Alt+F2 → 'lg')
# Navigate to Extensions tab to see errors
```

### Code Style

- **Functions**: camelCase (`tileWorkspaceWindows`)
- **Classes**: PascalCase (`WindowDescriptor`)
- **Constants**: UPPER_CASE (`WINDOW_SPACING`)
- **Private properties**: Prefix with `_` (`this._wmEventIds`)
- **Comments**: Use `//` for inline comments, avoid JSDoc blocks

### Technical Notes

This extension is designed for Wayland sessions and leverages modern compositor integration for proper window positioning and multi-monitor support.

For more information on GNOME Shell extension development:
- [GJS Extension Development Guide](https://gjs.guide/extensions/development/debugging.html)
- [GNOME Shell Extensions Documentation](https://gjs.guide/extensions/)

## 🤝 Contributing

> [!NOTE]
> This project is in early development with rapidly changing code. Code contributions are not currently accepted due to the high velocity of changes.

**Best ways to contribute right now:**

- 🧪 **Testing**: Try the extension and explore edge cases
- 🐛 **Bug Reports**: Open issues with detailed reproduction steps
- 💡 **Feature Ideas**: Share suggestions in GitHub Issues

> [!IMPORTANT]
> **For development**: Ensure `DEBUG = true` in `extension/logger.js` to see verbose logs.

## 📝 License

This project is licensed under the GNU General Public License v2.0 or later - see the LICENSE file for details.

## 🙏 Acknowledgments

- Kudos to [heikkiket/window-mosaic-mode](https://gitlab.gnome.org/heikkiket/window-mosaic-mode) for the original concept and implementation
- Inspired by [Tobias Bernard's vision for GNOME window management](https://blogs.gnome.org/tbernard/2023/07/26/rethinking-window-management/)
- GNOME Shell team for the excellent extension API
- Contributors and testers

## 🐛 Known Issues

> [!CAUTION]
> The interaction between mosaic layout and edge tiling (snap zones) is experimental.

**Current limitations:**

- Multi-monitor requires **"Workspaces on all displays"** setting (Settings → Multitasking). "Workspaces on primary display only" is not yet supported. ([#30](https://github.com/CleoMenezesJr/MosaicWM/issues/30))
- Overview drag-drop may have issues in some scenarios
- Edge tiling overflow preview not yet animated

---

**Made with ❤️ for the GNOME community**
