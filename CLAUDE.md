# Mosaic WM - Claude Code Guidelines

## Project Overview

GNOME Shell extension that provides automatic mosaic window tiling. Written in GJS (GNOME JavaScript) using ESM modules. Supports GNOME Shell 45–50.

## Project Structure

```
extension/          # All extension source code (JS, CSS, icons, schemas)
  extension.js      # Main controller — signal handling, state management
  windowHandler.js  # Window lifecycle (creation, removal, geometry)
  dragHandler.js    # Drag/grab operations (mouse + keyboard move)
  reordering.js     # Drag reordering within mosaic
  tiling.js         # Layout calculation, window positioning, overflow
  windowing.js      # Window queries (exclusion, monitor, workspace)
  edgeTiling.js     # Edge zone detection and snap-to-edge
  resizeHandler.js  # Resize operations (manual + smart resize)
  animations.js     # Smooth transitions
  drawing.js        # Visual overlays (preview boxes)
  swapping.js       # Window swap logic
  overviewLayout.js # Overview mosaic layout strategy
  constants.js      # Shared constants and enums
  windowState.js    # Per-window state (WeakMap-based flags)
  logger.js         # Debug logging (DEBUG flag)
  timing.js         # Timing utilities
  quickSettings.js  # Quick settings toggle
  settingsOverrider.js # GSettings overrides
  metadata.json     # Extension metadata
scripts/            # Build and test scripts
.local/             # Internal docs (BEHAVIOR.md, ARCHITECTURE.md) — NOT committed
.agent/             # Agent workflows — NOT committed
```

## Build & Test

```bash
# Build and install
flatpak-spawn --host bash -c './scripts/build.sh -i'

# Build only (no install)
flatpak-spawn --host bash -c './scripts/build.sh -b'

# Run nested GNOME Shell for testing
flatpak-spawn --host bash -c './scripts/run-gnome-shell.sh'
```

**WARNING**: Never use `kill`, `pkill`, or `killall gnome-shell` — it will terminate the host session.

## Code Conventions

- **ESM imports only**: `import Foo from 'gi://Foo';` — never `imports.gi.Foo`
- **GObject pattern**: All managers use `GObject.registerClass` with `_init()`/`destroy()` lifecycle
- **Signal-driven**: Use GObject signals and Meta.Window signals — no polling loops
- **Logging**: Use `Logger.log()` / `Logger.error()` — never raw `console.log`
- **Constants**: All magic numbers go in `constants.js`
- **Window state**: Per-window flags via `WindowState.set()`/`WindowState.get()` (WeakMap)

## Commit Rules

- **No AI Co-Author tags**: Never include `Co-Authored-By` referencing Claude, Copilot, or any AI
- **No AI-like comments**: Comments explain the WHY technically, never reference user requests or AI interaction
- **Only commit `extension/`, `scripts/`, `schemas/`** — never `.agent/`, `.local/`, or log files
- **Never use `git add .` or `git add -A`**
- **Keep `DEBUG = true`** in logger.js unless explicitly doing a release

## Pre-Commit Checklist

**MANDATORY before every commit** — run `.agent/workflows/pre-commit.md`. Key checks:
1. No unused imports, dead code, or commented-out blocks
2. No deprecated modules (Lang, Mainloop, ByteArray)
3. No GTK imports in extension.js
4. No excessive blank lines or trailing whitespace
5. Build passes without errors
6. Behavior patterns from `.local/BEHAVIOR.md` remain intact
7. Architecture changes documented in `.local/ARCHITECTURE.md`
8. Read every modified file manually and verify comment quality (grep alone is not enough)

## Comment Rules

- **WHY only**: comments explain a non-obvious reason, constraint, or workaround — never what the code does
- **Casual tone**: quick note from a teammate, not API docs
- **No dash-as-connector**: no ` - ` or `—` joining two clauses in comments or log strings; use a period, semicolon, "since", "because", or parentheses
- **No over-explaining**: if removing a sentence wouldn't confuse a future reader, remove it; match length to the nearest sibling comment
- **No AI/task references**: never mention the user's request, issue numbers, or the AI interaction
- **Grep before committing**: `grep -n " - " extension/*.js | grep "//"` must return empty
- **Don't make a "fix comments" commit**: fold comment cleanup silently into the commit that touches that code

## Key Architectural Patterns

- **Coordinated Pause**: During drag, `Extension.js` controls `ReorderingManager.setPaused()` to prevent conflicts between edge tiling and reordering
- **Sacred Window State Machine**: Two-stage resize-first strategy for unmaximize — window shrinks in isolation, then moves to destination
- **Smart Resize Iterator**: Democratic proportional shrinking before overflow — iterative with abort support
- **Producer-Consumer Queue**: Sequential window evaluation via `_evaluationQueue` to prevent race conditions
- **Throttled Visual Updates**: High-frequency signals throttled via `GLib.idle_add` pattern

## GNOME Shell Extension Rules (ego review)

- Nothing before `enable()` — no object creation, signal connections, or Shell modifications
- `disable()` must clean up everything done in `enable()`
- All `GLib.timeout_add`/`GLib.idle_add` must be removed in `disable()`
- Never import Gdk/Gtk/Adw in extension.js (only in prefs.js)
- Never import Clutter/Meta/St/Shell in prefs.js
