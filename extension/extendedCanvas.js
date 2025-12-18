// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Extended Canvas Manager - 200% virtual canvas with horizontal scrolling

import * as Logger from './logger.js';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as constants from './constants.js';

/**
 * Layout phases for the extended canvas system.
 * 
 * Phase 1: Windows fit within 100% workarea - no smart resize, no scroll needed
 * Phase 2: Windows exceed 100% but fit within 200% - no smart resize, scroll available
 * Phase 3: Windows exceed 200% canvas - smart resize is applied
 */
export const CanvasPhase = {
    PHASE_1: 1,  // 0-100% of workarea
    PHASE_2: 2,  // 100-200% of canvas
    PHASE_3: 3,  // >200% - overflow, smart resize kicks in
};

/**
 * Extended Canvas Manager
 * 
 * Manages a 200% virtual canvas where windows can be scrolled horizontally.
 * The canvas extends 50% to the left and 50% to the right of the visible workarea.
 * 
 * Canvas structure:
 * ┌─────────────────────────────────────────┐
 * │  -50%  │     0-100%     │  +50%        │
 * │ (LEFT) │   (WORKAREA)   │  (RIGHT)     │
 * └─────────────────────────────────────────┘
 * 
 * Adapted from PaperWM's Space class and scroll system.
 */
export class ExtendedCanvasManager {
    constructor(extension) {
        this._extension = extension;
        
        // Canvas dimensions (will be set per-monitor)
        this._canvasStates = new Map(); // Map<monitorIndex, CanvasState>
        
        // Animation tracking
        this._scrollAnimationId = null;
        
        // Scroll offset for debug/navigation (in pixels)
        this._scrollOffset = 0;
        this._scrollStep = 20; // 20px per scroll
        
        // Clip tracking - tracks which windows have clips applied
        this._clippedWindows = new Set(); // Set<windowId>
        
        this._clippedWindows = new Set(); // Set<windowId>
        
        this._tilingManager = null;
        
        Logger.log('[MOSAIC WM] ExtendedCanvasManager initialized (clip-based)');
    }

    get scrollOffset() {
        return this._scrollOffset;
    }

    setTilingManager(manager) {
        this._tilingManager = manager;
    }

    
    /**
     * Get or create canvas state for a monitor.
     * @param {number} monitorIndex 
     * @param {Meta.Workspace} workspace 
     * @returns {CanvasState}
     */
    getCanvasState(monitorIndex, workspace) {
        const key = `${workspace.index()}-${monitorIndex}`;
        
        if (!this._canvasStates.has(key)) {
            const workArea = workspace.get_work_area_for_monitor(monitorIndex);
            this._canvasStates.set(key, new CanvasState(workArea, monitorIndex, workspace));
        }
        
        return this._canvasStates.get(key);
    }
    
    /**
     * Calculate which phase we're currently in based on total window widths.
     * 
     * @param {Array} windows - Array of window descriptors with width property
     * @param {Object} workArea - Work area rectangle
     * @returns {number} Phase number (1, 2, or 3)
     */
    calculatePhase(windows, workArea) {
        if (!windows || windows.length === 0) {
            return CanvasPhase.PHASE_1;
        }
        
        const totalWidth = windows.reduce((sum, w) => {
            let width = 0;
            if (typeof w.width === 'number') {
                width = w.width;
            } else if (typeof w.get_frame_rect === 'function') {
                const rect = w.get_frame_rect();
                if (rect) width = rect.width;
            }
            return sum + width;
        }, 0);
        const spacing = (windows.length + 1) * constants.WINDOW_SPACING;
        const totalNeeded = totalWidth + spacing;
        
        const workAreaWidth = workArea.width;
        const canvasWidth = workAreaWidth * constants.CANVAS_EXPANSION_RATIO;
        
        Logger.log(`[MOSAIC WM] ExtendedCanvas: totalNeeded=${totalNeeded}, workArea=${workAreaWidth}, canvas=${canvasWidth}`);
        
        if (totalNeeded <= workAreaWidth) {
            Logger.log('[MOSAIC WM] ExtendedCanvas: Phase 1 - fits in workarea');
            return CanvasPhase.PHASE_1;
        }
        
        if (totalNeeded <= canvasWidth) {
            Logger.log('[MOSAIC WM] ExtendedCanvas: Phase 2 - fits in canvas');
            return CanvasPhase.PHASE_2;
        }
        
        Logger.log('[MOSAIC WM] ExtendedCanvas: Phase 3 - overflow, smart resize needed');
        return CanvasPhase.PHASE_3;
    }
    
    /**
     * Get the effective work area for tiling based on current phase.
     * In Phase 1 & 2, we use the expanded canvas. In Phase 3, we use normal workarea.
     * 
     * IMPORTANT: We keep the original X position so windows remain centered 
     * in the visible viewport. We only expand width to prevent premature 
     * overflow detection. The tiling algorithm will center windows within
     * the expanded space, placing them in the visible area when they fit.
     * 
     * @param {Object} workArea - Original work area
     * @param {number} phase - Current phase
     * @returns {Object} Effective work area for tiling
     */
    getEffectiveWorkArea(workArea, phase) {
        if (phase === CanvasPhase.PHASE_3) {
            // Phase 3: Smart resize will handle overflow, use normal workarea
            return workArea;
        }
        
        if (phase === CanvasPhase.PHASE_1) {
            // Phase 1: Everything fits in normal workarea, no expansion needed
            return workArea;
        }
        
        // Phase 2: SYMMETRIC expansion - grow 50% on each side
        // Original: x=0, width=1280, center=640
        // Expanded: x=-640, width=2560, center=640 (same center!)
        // This allows radial growth from the center
        const extraWidth = workArea.width * (constants.CANVAS_EXPANSION_RATIO - 1);
        const halfExtra = extraWidth / 2;
        
        return {
            x: workArea.x - halfExtra,
            y: workArea.y,
            width: workArea.width + extraWidth,
            height: workArea.height,
        };
    }
    
    /**
     * Check if smart resize should be applied.
     * Only applies in Phase 3.
     * 
     * @param {number} phase 
     * @returns {boolean}
     */
    shouldApplySmartResize(phase) {
        return phase === CanvasPhase.PHASE_3;
    }
    
    /**
     * Scroll the extended canvas left (move viewport right).
     * Pressing Ctrl+Alt+Left scrolls left (shows content to the right).
     */
    scrollLeft() {
        this._scrollOffset -= this._scrollStep;
        Logger.log(`[MOSAIC WM] Scroll LEFT: offset=${this._scrollOffset}`);
        // Trigger retile to apply new scroll offset
        this._requestRetile();
    }
    
    /**
     * Scroll the extended canvas right (move viewport left).
     * Pressing Ctrl+Alt+Right scrolls right (shows content to the left).
     */
    scrollRight() {
        this._scrollOffset += this._scrollStep;
        Logger.log(`[MOSAIC WM] Scroll RIGHT: offset=${this._scrollOffset}`);
        // Trigger retile to apply new scroll offset
        this._requestRetile();
    }
    
    /**
     * Request a retile to update window positions and clips.
     */
    _requestRetile() {
        // The extension will handle this via its tileWorkspaceWindows method
        if (this._extension && this._extension._tileManager) {
            const workspace = global.workspace_manager.get_active_workspace();
            const windows = workspace.list_windows().filter(w => 
                !w.is_skip_taskbar() && 
                w.get_window_type() === Meta.WindowType.NORMAL
            );
            if (windows.length > 0) {
                this._extension._tileManager.tileWorkspaceWindows(windows[0], 'scroll');
            }
        }
    }
    
    /**
     * Apply viewport clipping to a window actor.
     * This creates the visual effect of windows being cut off at viewport edges.
     * Uses both clip AND translation to properly shift visible content.
     * 
     * @param {Meta.Window} metaWindow - Window to clip
     * @param {Object} targetPos - Target position {x, y, width, height}
     * @param {Object} viewport - Viewport bounds {x, width}
     * @returns {Object} - Adjusted position {x, y} for the actor
     */
    applyViewportClip(metaWindow, targetPos, viewport) {
        const actor = metaWindow.get_compositor_private();
        if (!actor) return { x: targetPos.x, y: targetPos.y };
        
        // FORCE OPACITY: Ensure window is fully opaque, overriding any "Ghost" states
        // from legacy resizing logic or stuck animations.
        // Clipping handles visibility, so opacity should always be 255.
        if (actor.opacity !== 255) {
             actor.opacity = 255;
        }

        const windowId = metaWindow.get_id();
        const bufferRect = metaWindow.get_buffer_rect();
        const frameRect = metaWindow.get_frame_rect();
        
        // Calculate offsets between Actor (Buffer) and Logical Frame
        const offsetX = frameRect.x - bufferRect.x;
        const offsetY = frameRect.y - bufferRect.y;
        
        // SYNC: Force actor to match logical frame position
        // This clears any lingering translations from animations
        const expectedActorX = bufferRect.x;
        const expectedActorY = bufferRect.y;
        const currentActorX = Math.round(actor.get_x());
        const currentActorY = Math.round(actor.get_y());
        const currentTransX = actor.translation_x || 0;
        const currentTransY = actor.translation_y || 0;
        
        // Visual position = base position + translation
        const visualX = currentActorX + Math.round(currentTransX);
        const visualY = currentActorY + Math.round(currentTransY);
        
        // Force sync if visual doesn't match expected
        if (Math.abs(visualX - expectedActorX) > 1 || Math.abs(visualY - expectedActorY) > 1) {
            // Clear translations and fix position
            actor.remove_all_transitions();
            actor.set_translation(0, 0, 0);
            actor.set_position(expectedActorX, expectedActorY);
        }
        
        // Round target and viewport for precision
        const targetFrameLeft = Math.floor(targetPos.x + this._scrollOffset);
        const targetFrameRight = targetFrameLeft + Math.floor(targetPos.width);
        const viewportLeft = Math.floor(viewport.x);
        const viewportRight = Math.floor(viewport.x + viewport.width);

        // --- CLAMPING STRATEGY ---
        // Mutter might constrain logic windows to the workspace area.
        // We explicitly clamp the Logical Frame Position to the Viewport.
        // Then we use Translation to visually shift it to the intended Target.
        
        let clampedFrameX = targetFrameLeft;
        
        // Clamp Left
        if (targetFrameLeft < viewportLeft) {
            clampedFrameX = viewportLeft;
        }
        // Clamp Right (optional, but good for consistency if we want window securely in view)
        // Actually, for right overflow, the window start is usually inside viewport, 
        // usually we just clamp if the start is 'too far right' - but here we only care about left constraints
        // creating gaps. Windows extending right usually don't get constrained 'pushes' unless they are huge?
        // Let's stick to Clamping Left for now as that's the primary issue (gap at x=0).
        
        // Calculate Translation Delta (Visual Shift)
        // If Target is -200 and Clamped is 0, Delta is -200.
        const translationX = targetFrameLeft - clampedFrameX;

        // Check if fully visible (simplification)
        if (translationX === 0 && targetFrameRight <= viewportRight) {
             // CRITICAL FIX: Force actor position to match frame
             // The actor might be offset from frame due to shell animations
             actor.remove_all_transitions();
             actor.remove_clip();
             actor.set_translation(0, 0, 0);
             // Force actor to correct position (bufferRect = where actor should render)
             const correctActorX = frameRect.x - offsetX;
             const correctActorY = frameRect.y - offsetY;
             if (Math.abs(actor.get_x() - correctActorX) > 1 || Math.abs(actor.get_y() - correctActorY) > 1) {
                 Logger.log(`[MOSAIC FIX] Window ${windowId}: Forcing actor from (${Math.round(actor.get_x())},${Math.round(actor.get_y())}) to (${correctActorX},${correctActorY})`);
                 actor.set_position(correctActorX, correctActorY);
             }
             this._clippedWindows.delete(windowId);
             return { x: targetFrameLeft, y: targetPos.y };
        }

        // --- ACTOR SPACE CLIP CALCULATION ---
        
        // 1. Where is the Actor (Buffer) Logically?
        //    It's at clampedFrameX - offsetX.
        const logicalActorX = clampedFrameX - offsetX;
        
        // 2. Where is the Actor VISUALLY (with translation)?
        //    visualActorX = logicalActorX + translationX
        //    (This matches targetFrameLeft - offsetX)
        const visualActorX = logicalActorX + translationX;
        
        const actorWidth = bufferRect.width;
        const actorHeight = bufferRect.height; 

        // 3. Calculate Intersection of VISUAL Actor with Viewport
        const visibleLeft = Math.max(visualActorX, viewportLeft);
        const visibleRight = Math.min(visualActorX + actorWidth, viewportRight);

        // 4. Convert to Local Coordinates (relative to Actor Origin)
        //    Local 0 corresponds to visualActorX
        let clipX = visibleLeft - visualActorX; 
        let clipWidth = visibleRight - visibleLeft;

        // 5. Apply Rounded Clip
        clipX = Math.floor(Math.max(0, clipX));
        clipWidth = Math.floor(Math.min(clipWidth, actorWidth - clipX));

        if (clipWidth <= 0) {
             actor.set_clip(0, 0, 0, 0); // Hide
             // Logger.log(`[MOSAIC CLIP] Window ${windowId}: Hidden`);
        } else if (clipWidth >= actorWidth && clipX === 0) {
             actor.remove_clip(); 
             // Logger.log(`[MOSAIC CLIP] Window ${windowId}: Full`);
        } else {
             actor.set_clip(clipX, 0, clipWidth, actorHeight); 
             this._clippedWindows.add(windowId);
             Logger.log(`[MOSAIC CLIP] Window ${windowId}: Target=${targetFrameLeft}, Clamped=${clampedFrameX}, Trans=${translationX}, Clip=(${clipX}, ${clipWidth})`);
        }

        // CRITICAL FIX: Force actor to correct BASE position before applying translation
        // The actor might be at wrong position due to shell map animations
        // Actor should be at bufferRect when translation is 0
        const expectedBaseX = bufferRect.x;
        const expectedBaseY = bufferRect.y;
        const currentBaseX = actor.get_x();
        const currentBaseY = actor.get_y();
        
        if (Math.abs(currentBaseX - expectedBaseX) > 1 || Math.abs(currentBaseY - expectedBaseY) > 1) {
            actor.remove_all_transitions();
            actor.set_position(expectedBaseX, expectedBaseY);
        }

        // POSITION CORRECTION: Add stored correction delta to translation
        // This compensates for when move_resize_frame was ignored
        const positionCorrectionX = metaWindow._mosaicPositionCorrectionX || 0;
        const positionCorrectionY = metaWindow._mosaicPositionCorrectionY || 0;
        const finalTranslationX = translationX + positionCorrectionX;
        const finalTranslationY = positionCorrectionY;
        
        if (positionCorrectionX !== 0 || positionCorrectionY !== 0) {
            Logger.log(`[MOSAIC APPLY CORRECTION] Window ${windowId}: trans=${translationX}, correction=${positionCorrectionX}, finalTrans=${finalTranslationX}`);
        }

        // Apply Translation (including position correction)
        actor.set_translation(finalTranslationX, finalTranslationY, 0);
        
        // Force Clutter to apply position changes immediately
        actor.queue_relayout();
        
        // Return the CLAMPED logical position for move_resize_frame
        return { x: clampedFrameX, y: targetPos.y };
    }

    
    /**
     * Remove all clips from windows and restore normal visibility.
     */
    removeAllClips() {
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace.list_windows();
        
        for (const metaWindow of windows) {
            const actor = metaWindow.get_compositor_private();
            if (actor) {
                try {
                    actor.remove_clip();
                    actor.set_translation(0, 0, 0); // Reset translation
                } catch (e) {
                    // Ignore errors for disposed actors
                }
            }
        }
        this._clippedWindows.clear();
        this._scrollOffset = 0;
        Logger.log('[MOSAIC WM] All clips and translations removed');
    }


    
    /**
     * Ensure a window is fully visible in the viewport by scrolling if necessary.
     * Adapted from PaperWM's ensureViewport function.
     * 
     * @param {Meta.Window} metaWindow - Window to ensure visibility for
     * @param {boolean} animate - Whether to animate the scroll
     */
    ensureViewport(metaWindow, animate = true) {
        if (!metaWindow) return;
        
        const workspace = metaWindow.get_workspace();
        const monitorIndex = metaWindow.get_monitor();
        const state = this.getCanvasState(monitorIndex, workspace);
        
        const windowFrame = metaWindow.get_frame_rect();
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);
        
        // Calculate window position relative to current viewport
        const windowLeft = windowFrame.x;
        const windowRight = windowFrame.x + windowFrame.width;
        const viewportLeft = workArea.x + state.viewportX;
        const viewportRight = viewportLeft + workArea.width;
        
        let targetX = state.viewportX;
        
        // Check if window is fully visible
        if (windowLeft < viewportLeft) {
            // Window is to the left of viewport - scroll left
            targetX = windowLeft - workArea.x;
        } else if (windowRight > viewportRight) {
            // Window is to the right of viewport - scroll right
            targetX = windowRight - workArea.x - workArea.width;
        }
        
        // Clamp to canvas bounds
        targetX = this._clampViewportX(targetX, workArea);
        
        if (targetX !== state.viewportX) {
            this.scrollTo(targetX, state, animate);
        }
    }
    
    /**
     * Scroll the viewport to a specific X position.
     * 
     * @param {number} targetX - Target viewport X position
     * @param {CanvasState} state - Canvas state to scroll
     * @param {boolean} animate - Whether to animate
     */
    scrollTo(targetX, state, animate = true) {
        // Cancel any existing animation
        if (this._scrollAnimationId) {
            GLib.source_remove(this._scrollAnimationId);
            this._scrollAnimationId = null;
        }
        
        targetX = this._clampViewportX(targetX, state.workArea);
        
        if (!animate) {
            state.viewportX = targetX;
            this._applyViewport(state);
            return;
        }
        
        // Animate the scroll
        const startX = state.viewportX;
        const deltaX = targetX - startX;
        const duration = constants.VIEWPORT_SCROLL_DURATION_MS;
        const startTime = GLib.get_monotonic_time() / 1000;
        
        const animateStep = () => {
            const currentTime = GLib.get_monotonic_time() / 1000;
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Ease out quad for smooth deceleration
            const eased = 1 - (1 - progress) * (1 - progress);
            
            state.viewportX = startX + deltaX * eased;
            this._applyViewport(state);
            
            if (progress < 1) {
                this._scrollAnimationId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT_IDLE,
                    16, // ~60fps
                    animateStep
                );
                return GLib.SOURCE_REMOVE;
            }
            
            state.viewportX = targetX;
            this._applyViewport(state);
            this._scrollAnimationId = null;
            return GLib.SOURCE_REMOVE;
        };
        
        animateStep();
    }
    
    /**
     * Clamp viewport X position to valid canvas bounds.
     * 
     * @param {number} x - Desired viewport X
     * @param {Object} workArea - Work area for bounds calculation
     * @returns {number} Clamped X position
     */
    _clampViewportX(x, workArea) {
        const maxPanLeft = -(workArea.width * constants.CANVAS_PAN_LEFT);
        const maxPanRight = workArea.width * constants.CANVAS_PAN_RIGHT;
        
        return Math.max(maxPanLeft, Math.min(x, maxPanRight));
    }
    
    /**
     * Apply current viewport position to windows.
     * In a full implementation, this would move window clones or actual windows.
     * 
     * @param {CanvasState} state 
     */
    _applyViewport(state) {
        // Update the scroll offset for updateWindowPositions logic
        this._scrollOffset = state.viewportX;
        
        Logger.log(`[MOSAIC WM] ExtendedCanvas: Scrolling to X=${state.viewportX.toFixed(0)}`);
        
        // Trigger re-tile to update window positions and clips
        if (this._tilingManager) {
            // Use state information to target the correct workspace
            // Note: tileWorkspaceWindows expects monitor as index or object? Usually works with index.
            this._tilingManager.tileWorkspaceWindows(state.workspace, null, state.monitorIndex);
        } else {
            Logger.warn('[MOSAIC WM] ExtendedCanvas: No TilingManager set - cannot update positions');
        }
    }
    
    /**
     * Check if a window is fully visible in the current viewport.
     * 
     * @param {Meta.Window} metaWindow 
     * @returns {boolean}
     */
    isWindowFullyVisible(metaWindow) {
        if (!metaWindow) return false;
        
        const workspace = metaWindow.get_workspace();
        const monitorIndex = metaWindow.get_monitor();
        const state = this.getCanvasState(monitorIndex, workspace);
        
        const windowFrame = metaWindow.get_frame_rect();
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);
        
        const windowLeft = windowFrame.x;
        const windowRight = windowFrame.x + windowFrame.width;
        const viewportLeft = workArea.x + state.viewportX;
        const viewportRight = viewportLeft + workArea.width;
        
        return windowLeft >= viewportLeft && windowRight <= viewportRight;
    }
    
    /**
     * Check if a window is partially visible in the current viewport.
     * 
     * @param {Meta.Window} metaWindow 
     * @returns {boolean}
     */
    isWindowPartiallyVisible(metaWindow) {
        if (!metaWindow) return false;
        
        const workspace = metaWindow.get_workspace();
        const monitorIndex = metaWindow.get_monitor();
        const state = this.getCanvasState(monitorIndex, workspace);
        
        const windowFrame = metaWindow.get_frame_rect();
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);
        
        const windowLeft = windowFrame.x;
        const windowRight = windowFrame.x + windowFrame.width;
        const viewportLeft = workArea.x + state.viewportX;
        const viewportRight = viewportLeft + workArea.width;
        
        // Window overlaps with viewport but not fully inside
        const overlaps = windowLeft < viewportRight && windowRight > viewportLeft;
        const fullyInside = windowLeft >= viewportLeft && windowRight <= viewportRight;
        
        return overlaps && !fullyInside;
    }
    
    /**
     * Get current viewport bounds.
     * 
     * @param {number} monitorIndex 
     * @param {Meta.Workspace} workspace 
     * @returns {Object} Viewport bounds {left, right, top, bottom}
     */
    getViewportBounds(monitorIndex, workspace) {
        const state = this.getCanvasState(monitorIndex, workspace);
        const workArea = workspace.get_work_area_for_monitor(monitorIndex);
        
        return {
            left: workArea.x + state.viewportX,
            right: workArea.x + state.viewportX + workArea.width,
            top: workArea.y,
            bottom: workArea.y + workArea.height,
        };
    }
    
    /**
     * Reset viewport to center (initial position).
     * 
     * @param {number} monitorIndex 
     * @param {Meta.Workspace} workspace 
     */
    resetViewport(monitorIndex, workspace) {
        const state = this.getCanvasState(monitorIndex, workspace);
        state.viewportX = 0;
        this._applyViewport(state);
    }
    
    /**
     * Clean up resources.
     */
    destroy() {
        if (this._scrollAnimationId) {
            GLib.source_remove(this._scrollAnimationId);
            this._scrollAnimationId = null;
        }
        
        // Clean up all clones
        this._destroyAllClones();
        
        // Remove clone container from window_group
        if (this._cloneContainer) {
            if (this._cloneContainer.get_parent()) {
                this._cloneContainer.get_parent().remove_child(this._cloneContainer);
            }
            this._cloneContainer.destroy();
            this._cloneContainer = null;
        }
        
        this._canvasStates.clear();
        
        Logger.log('[MOSAIC WM] ExtendedCanvasManager destroyed');
    }
    
    /**
     * Destroy all clones.
     */
    _destroyAllClones() {
        for (const [windowId, clone] of this._clones) {
            clone.destroy();
        }
        this._clones.clear();
    }
    
    /**
     * Hide all clones and show all window actors.
     * Used when exiting extended canvas mode (e.g., during drag).
     * 
     * @param {Array<Meta.Window>} windows - Windows to restore
     */
    hideAllClones(windows = []) {
        // Hide all clones - with error handling for disposed clones
        const toRemove = [];
        for (const [windowId, clone] of this._clones) {
            try {
                clone.hide();
            } catch (e) {
                // Clone was destroyed, mark for removal
                toRemove.push(windowId);
            }
        }
        
        // Remove disposed clones from map
        for (const windowId of toRemove) {
            this._clones.delete(windowId);
        }
        
        // Restore all window actors (using opacity for reliability)
        for (const metaWindow of windows) {
            const actor = metaWindow.get_compositor_private();
            if (actor) {
                actor.opacity = 255;
            }
        }
        
        Logger.log(`[MOSAIC WM] ExtendedCanvas: Hidden all clones, restored ${windows.length} actors`);
    }
    
    /**
     * Create or update a clone for a window.
     * 
     * @param {Meta.Window} metaWindow - Window to clone
     * @param {Object|null} targetPos - Target position {x, y, width, height} from tileInfo
     * @returns {Clutter.Clone|null} The clone actor
     */
    createOrUpdateClone(metaWindow, targetPos = null) {
        if (!metaWindow) return null;
        
        const windowId = metaWindow.get_id();
        const actor = metaWindow.get_compositor_private();
        
        if (!actor) {
            Logger.log(`[MOSAIC WM] ExtendedCanvas: No actor for window ${windowId}`);
            return null;
        }
        
        let clone = this._clones.get(windowId);
        
        // Check if clone was destroyed externally - wrap in try-catch
        let needsRecreation = false;
        if (clone) {
            try {
                // Try to access the clone - will throw if destroyed
                // Use get_parent() which is more reliable
                clone.get_parent();
            } catch (e) {
                // Clone was destroyed, need to recreate
                Logger.log(`[MOSAIC WM] Clone ${windowId}: Was destroyed externally, recreating`);
                needsRecreation = true;
            }
        }
        
        if (needsRecreation) {
            this._clones.delete(windowId);
            clone = null;
        }
        
        if (!clone) {
            try {
                // Create new clone
                clone = new Clutter.Clone({
                    source: actor,
                    reactive: false,
                    opacity: 255, // Fully opaque - clones should look like real windows
                });
                
                this._cloneContainer.add_child(clone);
                this._clones.set(windowId, clone);
                Logger.log(`[MOSAIC WM] ExtendedCanvas: Created clone for window ${windowId}`);
            } catch (e) {
                Logger.log(`[MOSAIC WM] Clone ${windowId}: Failed to create - ${e.message}`);
                return null;
            }
        }
        
        // Position clone at TARGET position (where window SHOULD be)
        // PaperWM approach: use target position directly, no offset needed
        // The clone renders the window's content at the logical target position
        try {
            if (targetPos) {
                clone.set_position(targetPos.x, targetPos.y);
                Logger.log(`[MOSAIC WM] Clone ${windowId}: positioned at TARGET (${targetPos.x.toFixed(0)}, ${targetPos.y.toFixed(0)})`);
            } else {
                // Fallback: use current frame position
                const frame = metaWindow.get_frame_rect();
                clone.set_position(frame.x, frame.y);
            }
        } catch (e) {
            Logger.log(`[MOSAIC WM] Clone ${windowId}: Error positioning - ${e.message}`);
        }
        
        // Only hide the real window actor if it's outside the viewport
        // Windows fully inside viewport should show their real actor
        // This is passed from updateClones which knows the viewport bounds
        // For now, always show actor - we'll control visibility in updateClones
        
        return clone;

    }
    
    /**
     * Destroy clone for a window and show the real window again.
     * 
     * @param {number} windowId
     * @param {Meta.Window} metaWindow - Optional, to restore actor visibility
     */
    destroyClone(windowId, metaWindow = null) {
        const clone = this._clones.get(windowId);
        if (clone) {
            clone.destroy();
            this._clones.delete(windowId);
            
            // Restore the real window actor visibility
            if (metaWindow) {
                const actor = metaWindow.get_compositor_private();
                if (actor) {
                    actor.show();
                }
            }
            
            Logger.log(`[MOSAIC WM] ExtendedCanvas: Destroyed clone for window ${windowId}`);
        }
    }
    
    /**
     * Update clones for all windows in the extended canvas.
     * PaperWM-style: clones are positioned at TARGET coordinates from tileInfo.
     * The real windows stay wherever Mutter puts them; clones show where they SHOULD be.
     * 
     * @param {Array<Meta.Window>} windows - All windows to check
     * @param {Meta.Workspace} workspace 
     * @param {number} monitorIndex 
     * @param {Object} tileInfo - Tile info with target positions from _tile()
     */
    updateClones(windows, workspace, monitorIndex, tileInfo) {
        // Delegate to the full method with controlPositioning=false for backward compat
        this.updateWindowPositions(windows, workspace, monitorIndex, tileInfo, null, false);
    }
    
    /**
     * Update clones AND control window positioning for Phase 2.
     * This is the core method for spatial anchoring - it ensures windows are
     * positioned exactly where the mosaic calculated, using clones for windows
     * outside the viewport.
     * 
     * @param {Array<Meta.Window>} windows - All windows
     * @param {Meta.Workspace} workspace 
     * @param {number} monitorIndex 
     * @param {Object} tileInfo - Tile info with target positions from _tile()
     * @param {Object} workArea - Work area for positioning (null to use workspace default)
     * @param {boolean} controlPositioning - If true, apply clips and position at edges
     */
    updateWindowPositions(windows, workspace, monitorIndex, tileInfo, workArea = null, controlPositioning = true) {
        if (!windows || windows.length === 0) return;
        
        // Build a map of window id -> target position from tile_info
        const targetPositions = new Map();
        if (tileInfo && tileInfo.levels) {
            for (const level of tileInfo.levels) {
                for (const windowDesc of level.windows || []) {
                    targetPositions.set(windowDesc.id, {
                        x: windowDesc.targetX,
                        y: windowDesc.targetY,
                        width: windowDesc.width,
                        height: windowDesc.height
                    });
                }
            }
        }
        
        Logger.log(`[MOSAIC WM] ExtendedCanvas: updateWindowPositions - ${windows.length} windows, controlPositioning=${controlPositioning}`);
        
        // Get viewport bounds (visible area = 100% workArea)
        const actualWorkArea = workArea || workspace.get_work_area_for_monitor(monitorIndex);
        const viewport = { x: actualWorkArea.x, width: actualWorkArea.width };
        
        for (const metaWindow of windows) {
            const windowId = metaWindow.get_id();
            
            // Get the target position for this window
            const targetPos = targetPositions.get(windowId);
            if (!targetPos) {
                Logger.log(`[MOSAIC WM] Window ${windowId}: No target position found`);
                continue;
            }
            
                if (controlPositioning) {
                // TIMING FIX: Move window FIRST, then apply clipping AFTER
                // This ensures clip is calculated when window is at target position
                
                // Calculate target position (with scroll offset applied)
                const targetFrameLeft = Math.floor(targetPos.x + this._scrollOffset);
                const viewportLeft = Math.floor(viewport.x);
                
                // Clamp position to viewport
                let adjustedX = targetFrameLeft;
                if (targetFrameLeft < viewportLeft) {
                    adjustedX = viewportLeft;
                }
                
                // DEBUG: Check for overlap
                const rightEdge = targetPos.x + targetPos.width;
                
                const currentFrame = metaWindow.get_frame_rect();
                const actor = metaWindow.get_compositor_private();
                
                // Kill any native GNOME animations before moving
                if (actor) {
                    actor.remove_all_transitions();
                }

                // Move window to adjusted position
                metaWindow.move_resize_frame(
                    false,
                    adjustedX,
                    targetPos.y,
                    targetPos.width,
                    targetPos.height
                );
                
                // Check if move was successful
                const frameAfter = metaWindow.get_frame_rect();
                
                // POSITION CORRECTION: If move_resize_frame was ignored, store the correction delta
                // This delta will be applied in applyViewportClip to visually shift the window
                const positionDeltaX = adjustedX - frameAfter.x;
                const positionDeltaY = Math.floor(targetPos.y) - frameAfter.y;
                
                if (Math.abs(positionDeltaX) > 2 || Math.abs(positionDeltaY) > 2) {
                    Logger.log(`[MOSAIC CORRECTION] Window ${windowId}: Storing position correction dx=${positionDeltaX}, dy=${positionDeltaY}`);
                    metaWindow._mosaicPositionCorrectionX = positionDeltaX;
                    metaWindow._mosaicPositionCorrectionY = positionDeltaY;
                } else {
                    // Clear any stored correction if frame is at correct position
                    metaWindow._mosaicPositionCorrectionX = 0;
                    metaWindow._mosaicPositionCorrectionY = 0;
                }
                
                // STEP 2: Apply clip AFTER window has moved
                // Use position-changed signal with timeout fallback (signal might not fire if no actual move)
                const clipWindow = metaWindow;
                const clipTarget = targetPos;
                const clipViewport = viewport;
                const extCanvas = this;
                
                // Cleanup any previous signal/timeout
                if (clipWindow._mosaicClipSignalId) {
                    try { clipWindow.disconnect(clipWindow._mosaicClipSignalId); } catch (e) { }
                    clipWindow._mosaicClipSignalId = null;
                }
                if (clipWindow._mosaicClipTimeoutId) {
                    GLib.source_remove(clipWindow._mosaicClipTimeoutId);
                    clipWindow._mosaicClipTimeoutId = null;
                }
                
                const applyClipOnce = () => {
                    // Cleanup both signal and timeout
                    if (clipWindow._mosaicClipSignalId) {
                        try { clipWindow.disconnect(clipWindow._mosaicClipSignalId); } catch (e) { }
                        clipWindow._mosaicClipSignalId = null;
                    }
                    if (clipWindow._mosaicClipTimeoutId) {
                        GLib.source_remove(clipWindow._mosaicClipTimeoutId);
                        clipWindow._mosaicClipTimeoutId = null;
                    }
                    
                    // Apply clip
                    if (clipWindow.get_compositor_private()) {
                        extCanvas.applyViewportClip(clipWindow, clipTarget, clipViewport);
                    }
                };
                
                // Connect position-changed (fires when window moves)
                clipWindow._mosaicClipSignalId = clipWindow.connect('position-changed', () => {
                    Logger.log(`[MOSAIC WM] Position-changed fired for ${clipWindow.get_id()} - applying clip`);
                    applyClipOnce();
                });
                
                // Timeout fallback (fires if position-changed doesn't within 50ms)
                clipWindow._mosaicClipTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    Logger.log(`[MOSAIC WM] Timeout fallback for ${clipWindow.get_id()} - applying clip`);
                    applyClipOnce();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                // Not controlling positioning - just remove any clips
                const actor = metaWindow.get_compositor_private();
                if (actor) {
                    try {
                        actor.remove_clip();
                    } catch (e) {
                        // Ignore errors for disposed actors
                    }
                }
                this._clippedWindows.delete(windowId);
            }
        }
    }

    
    /**
     * Calculate how much of a window is outside the viewport (0-1).
     */
    _calculateOutsideRatio(frame, vLeft, vRight, vTop, vBottom) {
        const windowArea = frame.width * frame.height;
        if (windowArea <= 0) return 0;
        
        // Calculate visible portion
        const visibleLeft = Math.max(frame.x, vLeft);
        const visibleRight = Math.min(frame.x + frame.width, vRight);
        const visibleTop = Math.max(frame.y, vTop);
        const visibleBottom = Math.min(frame.y + frame.height, vBottom);
        
        const visibleWidth = Math.max(0, visibleRight - visibleLeft);
        const visibleHeight = Math.max(0, visibleBottom - visibleTop);
        const visibleArea = visibleWidth * visibleHeight;
        
        return 1 - (visibleArea / windowArea);
    }
}

/**
 * Canvas state for a specific workspace/monitor combination.
 */
class CanvasState {
    constructor(workArea, monitorIndex, workspace) {
        this.workArea = workArea;
        this.monitorIndex = monitorIndex;
        this.workspace = workspace;
        
        // Viewport position (0 = centered on workarea)
        // Negative = panned left, Positive = panned right
        this.viewportX = 0;
        
        // Current phase
        this.currentPhase = CanvasPhase.PHASE_1;
    }
}
