// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Smooth window animations for mosaic tiling

import * as Logger from './logger.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as constants from './constants.js';

// Animation configuration
const ANIMATION_DURATION = constants.ANIMATION_DURATION_MS;
const ANIMATION_MODE = Clutter.AnimationMode.EASE_OUT_BACK;
const ANIMATION_MODE_MOMENTUM = Clutter.AnimationMode.EASE_OUT_BACK;
const ANIMATION_MODE_SUBTLE = Clutter.AnimationMode.EASE_OUT_QUAD;

export class AnimationsManager {
    constructor() {
        this._isDragging = false;
        this._animatingWindows = new Set();
        this._initialWindowPositions = new Map();
        this._justEndedDrag = false;
        this._resizingWindowId = null;
    }

    setResizingWindow(windowId) {
        this._resizingWindowId = windowId;
    }

    getResizingWindowId() {
        return this._resizingWindowId;
    }

    setDragging(dragging) {
        // If ending drag, set flag for smooth drop animation
        if (this._isDragging && !dragging) {
            this._justEndedDrag = true;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.DEBOUNCE_DELAY_MS, () => {
                this._justEndedDrag = false;
                return GLib.SOURCE_REMOVE;
            });
        }
        this._isDragging = dragging;
    }

    saveInitialPosition(window) {
        const windowId = window.get_id();
        const rect = window.get_frame_rect();
        this._initialWindowPositions.set(windowId, {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
        });
    }

    getAndClearInitialPosition(window) {
        const windowId = window.get_id();
        const pos = this._initialWindowPositions.get(windowId);
        if (pos) {
            this._initialWindowPositions.delete(windowId);
        }
        return pos;
    }

    shouldAnimateWindow(window, draggedWindow = null) {
        // Don't animate the window being dragged
        if (draggedWindow && window.get_id() === draggedWindow.get_id()) {
            return false;
        }
        
        if (this._animatingWindows.has(window.get_id())) {
            return false;
        }
        
        // Don't animate manually resized windows
        if (this._resizingWindowId === window.get_id()) {
            return false;
        }
        
        return true;
    }

    animateWindow(window, targetRect, options = {}) {
        const {
            duration = ANIMATION_DURATION,
            mode = null,
            onComplete = null,
            draggedWindow = null,
            subtle = false,
            userOp = false,
            startRect = null
        } = options;
        
        if (!this.shouldAnimateWindow(window, draggedWindow)) {
            // Apply position immediately without animation
            window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            if (onComplete) onComplete();
            return;
        }
        
        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            Logger.log(`[MOSAIC WM] No actor for window ${window.get_id()}, skipping animation`);
            window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            if (onComplete) onComplete();
            return;
        }
        
        const windowId = window.get_id();
        this._animatingWindows.add(windowId);
        
        const currentRect = startRect || window.get_frame_rect();
        
        // Choose animation mode based on context
        let animationMode;
        if (mode !== null) {
            animationMode = mode;
        } else if (subtle) {
            animationMode = ANIMATION_MODE_SUBTLE;
        } else if (this._justEndedDrag) {
            animationMode = ANIMATION_MODE_SUBTLE;
        } else {
            animationMode = ANIMATION_MODE;
        }
        
        // Calculate scale and translation for smooth animation
        const scaleX = currentRect.width / targetRect.width;
        const scaleY = currentRect.height / targetRect.height;
        const translateX = currentRect.x - targetRect.x;
        const translateY = currentRect.y - targetRect.y;
        
        const hasValidDimensions = currentRect.width > 0 && currentRect.height > 0 && 
                                    targetRect.width > 0 && targetRect.height > 0 &&
                                    !isNaN(scaleX) && !isNaN(scaleY);
        
        if (!hasValidDimensions) {
            window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            windowActor.set_translation(translateX, translateY, 0);
            windowActor.ease({
                translation_x: 0,
                translation_y: 0,
                duration: duration,
                mode: animationMode,
                onComplete: () => {
                    windowActor.set_translation(0, 0, 0);
                    this._animatingWindows.delete(windowId);
                    if (onComplete) onComplete();
                }
            });
            return;
        }
        
        // Apply new size/position immediately (logical change)
        window.move_resize_frame(userOp, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        
        // Setup visual actors to fake the transition
        windowActor.set_pivot_point(0, 0);
        windowActor.set_scale(scaleX, scaleY);
        windowActor.set_translation(translateX, translateY, 0);
        
        const safetyTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration + constants.SAFETY_TIMEOUT_BUFFER_MS, () => {
            if (this._animatingWindows.has(windowId)) {
                this._animatingWindows.delete(windowId);
                try {
                    windowActor.set_scale(1.0, 1.0);
                    windowActor.set_translation(0, 0, 0);
                } catch (e) {
                }
            }
            return GLib.SOURCE_REMOVE;
        });
        
        windowActor.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            translation_x: 0,
            translation_y: 0,
            duration: duration,
            mode: animationMode,
            onComplete: () => {
                GLib.source_remove(safetyTimeout);
                windowActor.set_scale(1.0, 1.0);
                windowActor.set_translation(0, 0, 0);
                this._animatingWindows.delete(windowId);
                if (onComplete) onComplete();
            }
        });
    }

    animateWindowOpen(window, targetRect) {
        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
            return;
        }
        
        const windowId = window.get_id();
        this._animatingWindows.add(windowId);
        
        window.move_resize_frame(false, targetRect.x, targetRect.y, targetRect.width, targetRect.height);
        
        windowActor.set_pivot_point(0.5, 0.5);
        windowActor.set_scale(0.9, 0.9);
        windowActor.set_opacity(0);
        
        windowActor.ease({
            scale_x: 1.0,
            scale_y: 1.0,
            opacity: 255,
            duration: ANIMATION_DURATION,
            mode: ANIMATION_MODE,
            onComplete: () => {
                windowActor.set_scale(1.0, 1.0);
                windowActor.set_opacity(255);
                this._animatingWindows.delete(windowId);
            }
        });
    }

    animateWindowClose(window, onComplete) {
        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            if (onComplete) onComplete();
            return;
        }
        
        const windowId = window.get_id();
        this._animatingWindows.add(windowId);
        
        windowActor.set_pivot_point(0.5, 0.5);
        
        windowActor.ease({
            scale_x: 0.9,
            scale_y: 0.9,
            opacity: 0,
            duration: ANIMATION_DURATION,
            mode: ANIMATION_MODE,
            onComplete: () => {
                this._animatingWindows.delete(windowId);
                if (onComplete) onComplete();
            }
        });
    }

    animateWindowMove(window, fromRect, toRect, options = {}) {
        const {
            duration = ANIMATION_DURATION,
            mode = ANIMATION_MODE_MOMENTUM,
            onComplete = null
        } = options;
        
        const windowActor = window.get_compositor_private();
        if (!windowActor) {
            if (onComplete) onComplete();
            return;
        }
        
        const windowId = window.get_id();
        this._animatingWindows.add(windowId);
        
        const translateX = fromRect.x - toRect.x;
        const translateY = fromRect.y - toRect.y;
        
        windowActor.set_pivot_point(0, 0);
        windowActor.set_translation(translateX, translateY, 0);
        
        windowActor.ease({
            translation_x: 0,
            translation_y: 0,
            duration: duration,
            mode: mode,
            onComplete: () => {
                windowActor.set_translation(0, 0, 0);
                this._animatingWindows.delete(windowId);
                if (onComplete) onComplete();
            }
        });
    }

    animateReTiling(windowLayouts, draggedWindow = null) {
        if (windowLayouts.length === 1) {
            const { window, rect } = windowLayouts[0];
            const currentRect = window.get_frame_rect();
            
            const needsMove = Math.abs(currentRect.x - rect.x) > constants.ANIMATION_DIFF_THRESHOLD || 
                             Math.abs(currentRect.y - rect.y) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.width - rect.width) > constants.ANIMATION_DIFF_THRESHOLD ||
                             Math.abs(currentRect.height - rect.height) > constants.ANIMATION_DIFF_THRESHOLD;
            
            Logger.log(`[MOSAIC WM] animateReTiling: single window, current=(${currentRect.x},${currentRect.y}), target=(${rect.x},${rect.y}), needsMove=${needsMove}`);
            
            if (!needsMove) {
                window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
                return;
            }
        }
        
        for (const {window, rect} of windowLayouts) {
            this.animateWindow(window, rect, { draggedWindow });
        }
    }

    cleanup() {
        this._animatingWindows.clear();
        this._isDragging = false;
    }

    destroy() {
        this.cleanup();
    }
}
