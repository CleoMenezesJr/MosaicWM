/**
 * Animations Module
 * 
 * Provides smooth animations for window movements and resizing.
 * Uses Clutter Actor ease() API for hardware-accelerated animations.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as constants from './constants.js';

// Animation configuration
const ANIMATION_DURATION = constants.ANIMATION_DURATION_MS; // Use constant from constants.js
const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_BACK; // Momentum for re-tiling
const ANIMATION_MODE_MOMENTUM = Clutter.AnimationMode.EASE_OUT_BACK; // Momentum for open/close
const ANIMATION_MODE_SUBTLE = Clutter.AnimationMode.EASE_OUT_QUAD; // Subtle for edge tiling

// Module state
let _isDragging = false; // Track if user is dragging a window
let _animatingWindows = new Set(); // Track windows currently being animated
let _initialWindowPositions = new Map(); // Track initial positions for new windows
let _justEndedDrag = false; // Track if we just ended a drag (for smooth drop animation)
let _resizingWindowId = null; // Track window being resized

/**
 * Set which window is currently being resized
 * @param {number|null} windowId
 */
export function setResizingWindow(windowId) {
    _resizingWindowId = windowId;
}

/**
 * Get the ID of window currently being resized
 * @returns {number|null}
 */
export function getResizingWindowId() {
    return _resizingWindowId;
}

/**
 * Set dragging state
 * Animations are disabled for the dragged window itself during drag
 * @param {boolean} dragging
 */
export function setDragging(dragging) {
    // If ending drag, set flag for smooth drop animation
    if (_isDragging && !dragging) {
        _justEndedDrag = true;
        // Clear flag after a short delay (enough for one animation)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            _justEndedDrag = false;
            return GLib.SOURCE_REMOVE;
        });
    }
    _isDragging = dragging;
}

/**
 * Save initial position of a newly added window
 * @param {Meta.Window} window
 */
export function saveInitialPosition(window) {
    const windowId = window.get_id();
    const rect = window.get_frame_rect();
    _initialWindowPositions.set(windowId, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
    });
}

/**
 * Get and clear initial position for a window
 * @param {Meta.Window} window
 * @returns {Object|null} Initial rect or null
 */
export function getAndClearInitialPosition(window) {
    const windowId = window.get_id();
    const pos = _initialWindowPositions.get(windowId);
    if (pos) {
        _initialWindowPositions.delete(windowId);
    }
    return pos;
}

/**
 * Check if animations are allowed
 * @returns {boolean}
 */
export function isAnimationAllowed() {
    // Always allow animations for other windows, just not the dragged one
    return true;
}

/**
 * Check if a specific window should be animated
 * @param {Meta.Window} window
 * @param {Meta.Window|null} draggedWindow - Currently dragged window (if any)
 * @returns {boolean}
 */
function shouldAnimateWindow(window, draggedWindow = null) {
    // Don't animate the window being dragged
    if (draggedWindow && window.get_id() === draggedWindow.get_id()) {
        return false;
    }
    
    // Don't animate if window is already being animated (prevent conflicts)
    if (_animatingWindows.has(window.get_id())) {
        return false;
    }
    
    return true;
}

/**
 * Animate a window to a target position and size
 * @param {Meta.Window} window - Window to animate
 * @param {Object} targetRect - Target rectangle {x, y, width, height}
 * @param {Object} options - Animation options
 * @param {number} options.duration - Animation duration in ms (default: 250)
 * @param {Clutter.AnimationMode} options.mode - Easing mode (default: auto-select based on movement)
 * @param {Function} options.onComplete - Callback when animation completes
 * @param {Meta.Window|null} options.draggedWindow - Currently dragged window to exclude
 * @param {boolean} options.subtle - Use subtle animation (for edge tiling)
 */
export function animateWindow(window, targetRect, options = {}) {
    const {
        duration = ANIMATION_DURATION,
        mode = null,
        onComplete = null,
        draggedWindow = null,
        subtle = false
    } = options;
    
    // Check if we should animate this window
    if (!shouldAnimateWindow(window, draggedWindow)) {
        // Apply position immediately without animation
        window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        if (onComplete) onComplete();
        return;
    }
    
    const windowActor = window.get_compositor_private();
    if (!windowActor) {
        console.log(`[MOSAIC WM] No actor for window ${window.get_id()}, skipping animation`);
        window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        if (onComplete) onComplete();
        return;
    }
    
    // Mark window as animating
    const windowId = window.get_id();
    _animatingWindows.add(windowId);
    
    // Get current frame rect for animation
    const currentRect = window.get_frame_rect();
    
    // Choose animation mode based on context
    // Momentum (overshoot) only for open/close, smooth for everything else
    let animationMode;
    if (mode !== null) {
        animationMode = mode;
    } else if (subtle) {
        // Subtle animation for edge tiling
        animationMode = ANIMATION_MODE_SUBTLE;
    } else if (_justEndedDrag) {
        // Smooth animation when dropping dragged window (no overshoot)
        animationMode = ANIMATION_MODE_SUBTLE;
    } else {
        // Default: momentum animation for re-tiling
        animationMode = ANIMATION_MODE;
    }
    
    // Calculate scale and translation for smooth animation
    const scaleX = currentRect.width / targetRect.width;
    const scaleY = currentRect.height / targetRect.height;
    const translateX = currentRect.x - targetRect.x;
    const translateY = currentRect.y - targetRect.y;
    
    // Check if we can use scale+translation animation or just translation
    const hasValidDimensions = currentRect.width > 0 && currentRect.height > 0 && 
                                targetRect.width > 0 && targetRect.height > 0 &&
                                !isNaN(scaleX) && !isNaN(scaleY);
    
    if (!hasValidDimensions) {
        
        // For windows with 0x0 size (newly opened), animate only position
        // Move to target position first
        window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        
        // Animate from old position to new position using translation only
        windowActor.set_translation(translateX, translateY, 0);
        windowActor.ease({
            translation_x: 0,
            translation_y: 0,
            duration: duration,
            mode: animationMode,
            onComplete: () => {
                windowActor.set_translation(0, 0, 0);
                _animatingWindows.delete(windowId);
                if (onComplete) onComplete();
            }
        });
        return;
    }
    
    // Apply target position immediately (Clutter will animate the visual)
    window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
    
    // Set initial transform state
    windowActor.set_pivot_point(0, 0);
    windowActor.set_scale(scaleX, scaleY);
    windowActor.set_translation(translateX, translateY, 0);
    
    // Safety timeout: remove from set if animation doesn't complete
    const safetyTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration + 100, () => {
        if (_animatingWindows.has(windowId)) {
            console.log(`[MOSAIC WM] Safety timeout: removing stuck window ${windowId}`);
            _animatingWindows.delete(windowId);
            try {
                windowActor.set_scale(1.0, 1.0);
                windowActor.set_translation(0, 0, 0);
            } catch (e) {
                console.log(`[MOSAIC WM] Safety cleanup error (window may be destroyed): ${e}`);
            }
        }
        return GLib.SOURCE_REMOVE;
    });
    
    // Animate back to normal (scale 1.0, translation 0)
    windowActor.ease({
        scale_x: 1.0,
        scale_y: 1.0,
        translation_x: 0,
        translation_y: 0,
        duration: duration,
        mode: animationMode,
        onComplete: () => {
            // Cancel safety timeout
            GLib.source_remove(safetyTimeout);
            
            // Reset transform
            windowActor.set_scale(1.0, 1.0);
            windowActor.set_translation(0, 0, 0);
            
            // Remove from animating set
            _animatingWindows.delete(windowId);
            
            if (onComplete) onComplete();
        }
    });
}

/**
 * Animate window opening (fade in + scale up)
 * @param {Meta.Window} window - Window being opened
 * @param {Object} targetRect - Target rectangle
 */
export function animateWindowOpen(window, targetRect) {
    const windowActor = window.get_compositor_private();
    if (!windowActor) {
        window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        return;
    }
    
    const windowId = window.get_id();
    _animatingWindows.add(windowId);
    
    // Apply target position
    window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
    
    // Set initial state: slightly smaller and transparent
    windowActor.set_pivot_point(0.5, 0.5);
    windowActor.set_scale(0.9, 0.9);
    windowActor.set_opacity(0);
    
    // Animate to normal
    windowActor.ease({
        scale_x: 1.0,
        scale_y: 1.0,
        opacity: 255,
        duration: ANIMATION_DURATION,
        mode: ANIMATION_MODE,
        onComplete: () => {
            windowActor.set_scale(1.0, 1.0);
            windowActor.set_opacity(255);
            _animatingWindows.delete(windowId);
        }
    });
}

/**
 * Animate window closing (fade out + scale down)
 * @param {Meta.Window} window - Window being closed
 * @param {Function} onComplete - Callback when animation completes
 */
export function animateWindowClose(window, onComplete) {
    const windowActor = window.get_compositor_private();
    if (!windowActor) {
        if (onComplete) onComplete();
        return;
    }
    
    const windowId = window.get_id();
    _animatingWindows.add(windowId);
    
    windowActor.set_pivot_point(0.5, 0.5);
    
    // Animate to smaller and transparent
    windowActor.ease({
        scale_x: 0.9,
        scale_y: 0.9,
        opacity: 0,
        duration: ANIMATION_DURATION,
        mode: ANIMATION_MODE,
        onComplete: () => {
            _animatingWindows.delete(windowId);
            if (onComplete) onComplete();
        }
    });
}

/**
 * Animate a window moving from point A to point B
 * Used for automatic window movements (overflow, workspace changes)
 * @param {Meta.Window} window - Window to animate
 * @param {Object} fromRect - Starting rectangle {x, y, width, height}
 * @param {Object} toRect - Target rectangle {x, y, width, height}
 * @param {Object} options - Animation options
 */
export function animateWindowMove(window, fromRect, toRect, options = {}) {
    const {
        duration = ANIMATION_DURATION,
        mode = ANIMATION_MODE_MOMENTUM, // Use momentum for dramatic effect
        onComplete = null
    } = options;
    
    const windowActor = window.get_compositor_private();
    if (!windowActor) {
        console.log(`[MOSAIC WM] No actor for window ${window.get_id()}, skipping A→B animation`);
        if (onComplete) onComplete();
        return;
    }
    
    // Mark window as animating
    const windowId = window.get_id();
    _animatingWindows.add(windowId);
    
    console.log(`[MOSAIC WM] Animating window ${windowId} from (${fromRect.x}, ${fromRect.y}) to (${toRect.x}, ${toRect.y})`);
    
    // Calculate translation needed
    const translateX = fromRect.x - toRect.x;
    const translateY = fromRect.y - toRect.y;
    
    // Set initial transform state (at old position)
    windowActor.set_pivot_point(0, 0);
    windowActor.set_translation(translateX, translateY, 0);
    
    // Animate to new position (translation 0)
    windowActor.ease({
        translation_x: 0,
        translation_y: 0,
        duration: duration,
        mode: mode,
        onComplete: () => {
            // Reset transform
            windowActor.set_translation(0, 0, 0);
            
            // Remove from animating set
            _animatingWindows.delete(windowId);
            
            console.log(`[MOSAIC WM] A→B animation completed for window ${windowId}`);
            
            if (onComplete) onComplete();
        }
    });
}

/**
 * Animate multiple windows to new layout
 * @param {Array<{window: Meta.Window, rect: Object}>} windowLayouts - Array of {window, rect}
 * @param {Meta.Window|null} draggedWindow - Currently dragged window to exclude
 */
export function animateReTiling(windowLayouts, draggedWindow = null) {
    for (const {window, rect} of windowLayouts) {
        animateWindow(window, rect, { draggedWindow });
    }
}

/**
 * Cleanup function
 */
export function cleanup() {
    _animatingWindows.clear();
    _isDragging = false;
}
