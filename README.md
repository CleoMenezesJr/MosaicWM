# Mosaic WM

**Rethinking window management for GNOME Shell**

A GNOME Shell extension that provides automatic window tiling in a mosaic layout. Inspired by [GNOME's vision for rethinking window management](https://blogs.gnome.org/tbernard/2023/07/26/rethinking-window-management/), Mosaic WM intelligently arranges windows to maximize screen space while maintaining visual harmony.

> [!WARNING]
> **Experimental Extension**: This extension is under active development and may contain bugs or unexpected behavior. Use at your own risk. Please report any issues.

## 💡 Philosophy

Traditional window management forces users to manually position and resize windows. Mosaic WM takes a different approach:

- **Automatic**: Windows organize themselves intelligently
- **Adaptive**: Layout responds to your workflow
- **Minimal**: No manual tiling or complex keyboard shortcuts needed
- **Visual**: See your workspace at a glance

This aligns with GNOME's philosophy of reducing cognitive load and letting users focus on their work, not window management.

## ✨ Features

- 🎯 **Automatic Tiling**: Windows are automatically arranged in an optimal mosaic layout
- 🔄 **Smart Overflow**: Oversized windows automatically move to new workspaces
- 🎨 **Drag & Drop**: Reorder windows by dragging them
- 🖥️ **Fullscreen Support**: Fullscreen and maximized windows get dedicated workspaces
- 👁️ **Visual Feedback**: See window positions during drag operations
- 🚀 **Performance**: Lightweight and efficient
- 🎛️ **Multi-Monitor**: Works seamlessly with multiple displays

## 📦 Installation

### From Source

```bash
# Clone the repository
git clone git@github.com:CleoMenezesJr/MosaicWM.git
cd MosaicWM

# Install the extension
./install.sh

# Enable the extension
gnome-extensions enable mosaicwm@cleomenezesjr.github.io

# Log out and log back in
```

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
./install.sh

# Test in a nested GNOME Shell session
./run-gnome-shell.sh
```

### Enable Debug Logging

To enable verbose debug logs, edit `extension/logger.js` and set:

```javascript
const DEBUG_ENABLED = true;
```

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
- **Documentation**: JSDoc for all exported functions

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

## 📝 License

This project is licensed under the GNU General Public License v2.0 or later - see the LICENSE file for details.

## 🙏 Acknowledgments

- Kudos to [heikkiket/window-mosaic-mode](https://gitlab.gnome.org/heikkiket/window-mosaic-mode) for the original concept and implementation
- Inspired by [Tobias Bernard's vision for GNOME window management](https://blogs.gnome.org/tbernard/2023/07/26/rethinking-window-management/)
- GNOME Shell team for the excellent extension API
- Contributors and testers

## 🐛 Known Issues

> [!CAUTION]
> The interaction between mosaic layout and quarter tiling (edge tiling) is highly experimental and may not work as expected.

**Open issues:**

- Overview drag-drop may crash in some scenarios
- Edge tiling overflow preview not yet animated

---

**Made with ❤️ for the GNOME community**
