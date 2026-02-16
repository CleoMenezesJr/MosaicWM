// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later
// Core mosaic tiling algorithm and layout management

import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter'; // CRITICAL: Used for Enums (AnimationMode, etc)
import GObject from 'gi://GObject';

import * as Logger from './logger.js';
import * as constants from './constants.js';
import { TileZone } from './constants.js';
import * as WindowState from './windowState.js';

export const ComputedLayouts = new WeakMap();

/**
 * SmartResizeIterator - Manages democratic and iterative window resizing
 * 
 * Responsible for:
 * - Apply proportional reduction (10% per cycle) to all windows
 * - Detect when a window reaches its minimum size (no change > DELTA)
 * - Maintain state across multiple iterations
 * - Revert everything to original on overflow
 */
class SmartResizeIterator {
    constructor(windows, newWindow, workArea, tilingManager) {
        // Filter to only resizable windows - non-resizable windows can't be shrunk
        const existingResizable = windows.filter(w => w.allows_resize && w.allows_resize());
        const existingNonResizable = windows.filter(w => !w.allows_resize || !w.allows_resize());
        
        // CRITICAL: Include newWindow in resize pool if it's resizable
        // This ensures BOTH existing and new windows are democratically resized together
        const newWindowResizable = newWindow.allows_resize && newWindow.allows_resize();
        const allResizable = newWindowResizable ? [...existingResizable, newWindow] : existingResizable;
        
        this.resizableWindows = allResizable;
        this.nonResizableWindows = existingNonResizable;
        
        // Early exit if no resizable windows found
        if (this.resizableWindows.length === 0) {
            Logger.log(`[SMART RESIZE] No resizable windows found - cannot shrink anything`);
        }
        
        // Use only resizable windows for the resize process
        this.windows = this.resizableWindows;
        this.newWindow = newWindow;
        this.workArea = workArea;
        this.tilingManager = tilingManager;
        this.iteration = 0;
        
        // Pre-populate windowsAtMinimum: windows already at their learned minimum size
        // This avoids wasting iterations on windows that can't shrink further
        this.windowsAtMinimum = new Set();
        const minWidth = constants.SMART_RESIZE_MIN_WINDOW_WIDTH || 250;
        const minHeight = constants.SMART_RESIZE_MIN_WINDOW_HEIGHT || 250;
        const MINIMUM_TOLERANCE = 10; // Allow small margin for borders/decoration
        
        for (const window of this.windows) {
            const currentRect = window.get_frame_rect();
            const currentSize = { w: currentRect.width, h: currentRect.height };
            const learnedMin = WindowState.get(window, 'learnedMinSize');
            const hitMinimumBefore = WindowState.get(window, 'hitMinimumSize');
            
            // Check 1: If window has a learned minimum and current size matches it, mark as at minimum
            if (learnedMin && currentSize.w === learnedMin.w && currentSize.h === learnedMin.h) {
                this.windowsAtMinimum.add(window.get_id());
                Logger.log(`[SMART RESIZE] Window ${window.get_id()} already at learned minimum (${learnedMin.w}x${learnedMin.h})`);
            }
            // Check 2: If window already hit minimum in a previous smart resize, don't resize it again
            // (even if current size is larger due to layout changes)
            else if (hitMinimumBefore && learnedMin) {
                this.windowsAtMinimum.add(window.get_id());
                Logger.log(`[SMART RESIZE] Window ${window.get_id()} previously hit minimum at ${learnedMin.w}x${learnedMin.h}, not resizing again (current: ${currentSize.w}x${currentSize.h})`);
            }
            // Check 3: If window is already at/near absolute minimum size, mark as at minimum (avoids wasted iteration)
            // Include MINIMUM_TOLERANCE for window decorations/borders
            else if (currentSize.w <= minWidth + MINIMUM_TOLERANCE && currentSize.h <= minHeight + MINIMUM_TOLERANCE) {
                this.windowsAtMinimum.add(window.get_id());
                Logger.log(`[SMART RESIZE] Window ${window.get_id()} already near/at absolute minimum (${currentSize.w}x${currentSize.h} ~<= ${minWidth}x${minHeight})`);
            }
        }
        this.originalSizes = new Map();      // {windowId -> {w, h}} before smart resize
        this.currentSizes = new Map();       // {windowId -> {w, h}} current size during reduction
        this.resizeAttempts = new Map();     // {windowId -> count} how many times attempted to shrink
        this.noMovementCount = new Map();    // {windowId -> count} iterations without movement
        this.lastIterationWindowShrank = new Map(); // {windowId -> iteration} last iteration window shrank
        this.maxIterations = constants.SMART_RESIZE_MAX_ITERATIONS;
        this.MIN_MOVEMENT_ITERATIONS = 2;   // Require 2 iterations without movement to confirm minimum (avoid false positives)
        this.consecutiveTimeouts = 0;       // Counter of consecutive timeouts in event-driven wait
        
        const actuallyResizable = this.resizableWindows.length - this.windowsAtMinimum.size;
        Logger.log(`[SMART RESIZE] SmartResizeIterator created for ${this.resizableWindows.length} resizable windows (${this.nonResizableWindows.length} non-resizable, ${this.windowsAtMinimum.size} already at minimum) - ${actuallyResizable} available for resize`);
    }

    /**
     * Executes a democratic resizing cycle
     * @returns {Promise<Object>} {success: boolean, allAtMinimum: boolean, shouldRetry: boolean}
     */
    async executeIteration() {
        this.iteration++;
        Logger.log(`[SMART RESIZE] ===== Iteration ${this.iteration} start =====`);
        Logger.log(`[SMART RESIZE] Windows: ${this.windows.length} candidates, ${this.windowsAtMinimum.size} at minimum`);
        
        if (this.iteration > this.maxIterations) {
            Logger.log(`[SMART RESIZE] Max iterations (${this.maxIterations}) reached - overflow`);
            return { success: false, allAtMinimum: true, shouldRetry: false };
        }

        // Phase 1: Filter windows that are NOT at minimum
        const toShrink = this.windows.filter(w => !this.windowsAtMinimum.has(w.get_id()));
        
        if (toShrink.length === 0) {
            Logger.log(`[SMART RESIZE] All windows at minimum - cannot shrink further`);
            return { success: false, allAtMinimum: true, shouldRetry: false };
        }

        // Phase 2: Calculate proportional reduction (10% per iteration)
        const reductionPercentage = 1 - (constants.SMART_RESIZE_STEP_PERCENTAGE / 100); // 0.90 if 10%
        Logger.log(`[SMART RESIZE] Reduction ratio: ${reductionPercentage.toFixed(3)} (${constants.SMART_RESIZE_STEP_PERCENTAGE}% shrink)`);
        
        // Phase 3: Apply resize to ALL candidate windows
        for (const window of toShrink) {
            const id = window.get_id();
            this.resizeAttempts.set(id, (this.resizeAttempts.get(id) || 0) + 1);
            
            // CRITICAL: Mark window as smart resizing BEFORE calling move_resize_frame
            // This prevents onSizeChanged from interfering with the resizing
            WindowState.set(window, 'isSmartResizing', true);
            
            // Salvar tamanho ORIGINAL se primeira vez
            if (!this.originalSizes.has(id)) {
                const frame = window.get_frame_rect();
                this.originalSizes.set(id, { width: frame.width, height: frame.height });
                this.currentSizes.set(id, { width: frame.width, height: frame.height });
                Logger.log(`[SMART RESIZE] Iter ${this.iteration}: Learning original size for ${id}: ${frame.width}x${frame.height}`);
            }
            
            // Apply proportional reduction to CURRENT size
            const current = this.currentSizes.get(id);
            let newWidth = Math.floor(current.width * reductionPercentage);
            let newHeight = Math.floor(current.height * reductionPercentage);
            
            // Respect absolute minimum size of 250x250 for smart resize
            const minWidth = constants.SMART_RESIZE_MIN_WINDOW_WIDTH || 250;
            const minHeight = constants.SMART_RESIZE_MIN_WINDOW_HEIGHT || 250;
            
            if (newWidth < minWidth) {
                newWidth = minWidth;
            }
            if (newHeight < minHeight) {
                newHeight = minHeight;
            }
            
            Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} shrinking ${current.width}x${current.height} -> ${newWidth}x${newHeight}`);
            
            // Do NOT set targetSmartResizeSize here - will be set in commitResizes() after validation
            const frame = window.get_frame_rect();
            window.move_resize_frame(false, frame.x, frame.y, newWidth, newHeight);
        }

        // Phase 4: EVENT-DRIVEN - Wait for resizes to be applied by Mutter
        // NOTE: instead of await this._waitMs(200), we use event-driven with Promise.race
        // This reduces typical time from 200ms to ~50-100ms (when Mutter actually responds)
        Logger.log(`[SMART RESIZE] Iter ${this.iteration}: [EVENT-DRIVEN] Waiting for size-changed signals...`);
        const hadTimeout = await this._waitForSizeChanges(toShrink, 500);
        if (hadTimeout) {
            this.consecutiveTimeouts++;
        } else {
            this.consecutiveTimeouts = 0;
        }

        // Phase 5: Detect which windows actually shrank (dynamic minimum discovery)
        const minWidth = constants.SMART_RESIZE_MIN_WINDOW_WIDTH || 250;
        const minHeight = constants.SMART_RESIZE_MIN_WINDOW_HEIGHT || 250;
        
        for (const window of toShrink) {
            // CRITICAL: Keep isSmartResizing flag active during detection
            // Prevents onSizeChanged from triggering tiling during iteration
            WindowState.set(window, 'isSmartResizing', true);
            const id = window.get_id();
            const frame = window.get_frame_rect();
            const current = this.currentSizes.get(id);
            
            // Consider BOTH width and height for detection
            const widthDelta = Math.abs(frame.width - current.width);
            const heightDelta = Math.abs(frame.height - current.height);
            const maxDelta = Math.max(widthDelta, heightDelta);
            
            Logger.log(`[SMART RESIZE] Iter ${this.iteration}: Verify ${id}: delta_w=${widthDelta.toFixed(1)}px, delta_h=${heightDelta.toFixed(1)}px, max=${maxDelta.toFixed(1)}px`);
            
            const DETECTION_DELTA = constants.SMART_RESIZE_DETECTION_DELTA_PX || 2;
            const bothDimensionsStuck = widthDelta < DETECTION_DELTA && heightDelta < DETECTION_DELTA;
            const eitherDimensionMoving = widthDelta >= DETECTION_DELTA || heightDelta >= DETECTION_DELTA;
            
            // Check if window already reached absolute minimum size
            if (frame.width <= minWidth && frame.height <= minHeight) {
                Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} REACHED ABSOLUTE MINIMUM (${frame.width}x${frame.height} <= ${minWidth}x${minHeight})`);
                const noMovCount = (this.noMovementCount.get(id) || 0) + 1;
                this.noMovementCount.set(id, noMovCount);
                
                if (noMovCount >= this.MIN_MOVEMENT_ITERATIONS) {
                    Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} HIT MINIMUM (absolute limit reached, delta=${maxDelta.toFixed(1)}px)`);
                    this.windowsAtMinimum.add(id);
                    WindowState.set(window, 'hitMinimumSize', true);
                    WindowState.set(window, 'learnedMinSize', { width: frame.width, height: frame.height });
                } else {
                    Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} no movement detected (${noMovCount}/${this.MIN_MOVEMENT_ITERATIONS}), will retry next iteration`);
                }
                
                // Atualizar currentSizes com o tamanho REAL
                this.currentSizes.set(id, { width: frame.width, height: frame.height });
            }
            // CRITICAL: Detect REAL minimum - both dimensions must be stuck
            else if (bothDimensionsStuck) {
                const noMovCount = (this.noMovementCount.get(id) || 0) + 1;
                this.noMovementCount.set(id, noMovCount);
                
                if (noMovCount >= this.MIN_MOVEMENT_ITERATIONS) {
                    Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} HIT MINIMUM (${noMovCount} iterations without movement in BOTH dimensions, delta_w=${widthDelta.toFixed(1)}, delta_h=${heightDelta.toFixed(1)})`);
                    this.windowsAtMinimum.add(id);
                    WindowState.set(window, 'hitMinimumSize', true);
                    WindowState.set(window, 'learnedMinSize', { width: frame.width, height: frame.height });
                } else {
                    Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} both dimensions stuck (${noMovCount}/${this.MIN_MOVEMENT_ITERATIONS}), will retry next iteration`);
                }
                
                // IMPORTANT: Update currentSizes with the REAL size
                this.currentSizes.set(id, { width: frame.width, height: frame.height });
            } else if (eitherDimensionMoving) {
                // Excellent! At least one dimension shrank - continue trying
                this.noMovementCount.set(id, 0);
                this.lastIterationWindowShrank.set(id, this.iteration); // Record that this window made progress
                this.currentSizes.set(id, { width: frame.width, height: frame.height });
                Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} shrunk successfully (new size: ${frame.width}x${frame.height})`);
            } else {
                // No dimension moved significantly (edge case)
                this.noMovementCount.set(id, 0);
                this.currentSizes.set(id, { width: frame.width, height: frame.height });
                Logger.log(`[SMART RESIZE] Iter ${this.iteration}: ${id} no significant movement but continuing (delta_w=${widthDelta.toFixed(1)}, delta_h=${heightDelta.toFixed(1)})`);
            }
        }

        // Phase 6: Simulate layout with CURRENT sizes (after this.iteration)
        // CRITICAL: Build simulation with ALL windows - newWindow may or may not be in this.windows
        const simulatedWindows = this.windows.map(w => {
            const isNewWindow = w.get_id() === this.newWindow.get_id();
            const current = this.currentSizes.get(w.get_id());
            
            // For windows in currentSizes (already resized), use tracked size
            // For newWindow if not in currentSizes, use current frame
            const size = current || (isNewWindow ? this.newWindow.get_frame_rect() : null);
            
            if (!size) {
                Logger.log(`[SMART RESIZE] WARNING: No size found for window ${w.get_id()}`);
                return { id: w.get_id(), width: 250, height: 250 };
            }
            
            return { id: w.get_id(), width: size.width, height: size.height };
        });
        
        // If newWindow is not resizable, add it separately to the simulation
        if (!this.windows.some(w => w.get_id() === this.newWindow.get_id())) {
            simulatedWindows.push({
                id: this.newWindow.get_id(),
                width: this.newWindow.get_frame_rect().width,
                height: this.newWindow.get_frame_rect().height
            });
        }

        const layoutResult = this.tilingManager._tile(simulatedWindows, this.workArea, true);
        
        Logger.log(`[SMART RESIZE] Iter ${this.iteration}: Layout simulation: overflow=${layoutResult.overflow}`);
        
        if (!layoutResult.overflow) {
            Logger.log(`[SMART RESIZE] Iteration ${this.iteration}: ✓ SUCCESS - all windows fit!`);
            return { success: true, shouldRetry: false };
        }

        // Phase 7: Check if can continue or overflow is inevitable
        const allAtMinimum = this.windows.every(w => this.windowsAtMinimum.has(w.get_id()));
        const stillResizableCandidates = this.windows.length - this.windowsAtMinimum.size;
        
        Logger.log(`[SMART RESIZE] Iter ${this.iteration}: Still overflowing. Resizable remaining: ${stillResizableCandidates}`);
        
        // CRITICAL OPTIMIZATION (Iter 1 Early Exit): If NO window made progress in this iteration
        // Means preferred sizes are at the app's real limit - overflow is permanent and future iterations are futile
        const anyWindowMadeProgressThisIteration = this.windows.some(w => {
            const lastShrank = this.lastIterationWindowShrank.get(w.get_id());
            return lastShrank === this.iteration; // Did this window shrink in THIS iteration?
        });
        
        if (!anyWindowMadeProgressThisIteration && layoutResult.overflow && this.iteration === 1) {
            Logger.log(`[SMART RESIZE] Iteration 1 EARLY EXIT: No window could even start shrinking - preferred sizes too tight. IMPOSSIBLE to fit. Aborting.`);
            return { success: false, allAtMinimum: false, shouldRetry: false, earlyEscape: true };
        }
        
        if (!anyWindowMadeProgressThisIteration && layoutResult.overflow && this.iteration >= 3) {
            Logger.log(`[SMART RESIZE] Iteration ${this.iteration}: Permanent cycle detected - no window made progress and overflow=true. IMPOSSIBLE to fit. Aborting.`);
            return { success: false, allAtMinimum: false, shouldRetry: false, earlyEscape: true };
        }
        
        // Only reliable condition: 100% of windows are at minimum but overflow still exists
        if (allAtMinimum) {
            Logger.log(`[SMART RESIZE] All windows at minimum but overflow persists - ✗ CANNOT FIT (overflow inevitable)`);
            return { success: false, allAtMinimum: true, shouldRetry: false };
        }

        // USER OPTIMIZATION: If most remaining windows are small (< 25% of primary axis)
        // And overflow persists, impossible to fit by expanding - goes directly to overflow
        // Detects orientation automatically: landscape uses width, portrait uses height
        const isLandscape = this.workArea.width > this.workArea.height;
        const primaryDimension = isLandscape ? this.workArea.width : this.workArea.height;
        const SMALL_WINDOW_RATIO = 0.25; // 25% of primary axis
        const SMALL_WINDOW_THRESHOLD = Math.round(primaryDimension * SMALL_WINDOW_RATIO);
        
        const nonMinimumWindows = this.windows.filter(w => !this.windowsAtMinimum.has(w.get_id()));
        const smallWindowsCount = nonMinimumWindows.filter(w => {
            const size = this.currentSizes.get(w.get_id());
            const windowPrimaryDimension = isLandscape ? size.width : size.height;
            return size && windowPrimaryDimension < SMALL_WINDOW_THRESHOLD;
        }).length;
        
        const mostlySmallWindows = nonMinimumWindows.length > 0 && 
                                   (smallWindowsCount / nonMinimumWindows.length) >= 0.5;
        
        if (mostlySmallWindows && layoutResult.overflow) {
            const dimensionName = isLandscape ? "width" : "height";
            Logger.log(`[SMART RESIZE] Iter ${this.iteration}: SMALL WINDOW OPTIMIZATION (${dimensionName}=${primaryDimension}px) - Most remaining windows are < ${SMALL_WINDOW_THRESHOLD}px (25% of ${dimensionName}) and overflow persists. Impossible to fit. ABORTING.`);
            return { success: false, allAtMinimum: false, shouldRetry: false, earlyEscape: true };
        }

        Logger.log(`[SMART RESIZE] Iter ${this.iteration}: Will continue on next iteration (${stillResizableCandidates} can still shrink)`);
        return { success: false, allAtMinimum: false, shouldRetry: true };
    }

    /**
     * Calculate free space percentage in workspace
     * Based on the bounding box of levels returned by layout
     * @param {Object} layoutResult - Result of tiling simulation
     * @returns {number} Free space percentage (0-100)
     */
    _calculateFreeSpacePercent(layoutResult) {
        if (!layoutResult || !layoutResult.levels || layoutResult.levels.length === 0) {
            return 100; // If no data, assume available space
        }
        
        const totalArea = this.workArea.width * this.workArea.height;
        
        // Calculate bounding box for all levels
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        
        for (const level of layoutResult.levels) {
            minX = Math.min(minX, level.x);
            maxX = Math.max(maxX, level.x + level.width);
            minY = Math.min(minY, level.y);
            maxY = Math.max(maxY, level.y + level.height);
        }
        
        // If no valid level, return 100%
        if (minX === Infinity || maxX === -Infinity) {
            return 100;
        }
        
        const usedWidth = maxX - minX;
        const usedHeight = maxY - minY;
        const usedArea = usedWidth * usedHeight;
        const freeArea = totalArea - usedArea;
        const freePercent = (freeArea / totalArea) * 100;
        
        return Math.max(0, freePercent); // Nunca retornar negativo
    }

    /**
     * Helper: Aguardar por N milissegundos
     */
    _waitMs(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /**
     * EVENT-DRIVEN: Wait for resizing of multiple windows
     * 
     * Instead of polling with fixed wait, connect to 'size-changed' signal of each window
     * and execute when the FIRST signal arrives (Promise.race).
     * 
     * PROFESSIONAL:
     * - Reduces time from fixed 200ms to ~50-100ms real (depends on Mutter)
     * - Event-driven win Promise.race (faster than busyloop)
     * - Safety timeout as fallback
     * - Auto-cleanup of listeners
     * 
     * @param {MetaWindow[]} windows - Windows to monitor
     * @param {number} timeoutMs - Maximum time before giving up (default 500ms)
     * @returns {Promise<void>}
     */
    async _waitForSizeChanges(windows, timeoutMs = 1500) {
        if (windows.length === 0) {
            Logger.log(`[SMART RESIZE EVENT-DRIVEN] No windows to monitor, returning immediately`);
            return false;
        }

        const startTime = Date.now();
        const promises = [];
        const signalHandlers = [];
        let timeoutOccurred = false;

        // Para cada janela, criar uma Promise que resolve no primeiro 'size-changed'
        for (const window of windows) {
            const promise = new Promise((resolve) => {
                const handler = window.connect('size-changed', () => {
                    const elapsed = Date.now() - startTime;
                    Logger.log(`[SMART RESIZE EVENT-DRIVEN] Window ${window.get_id()} fired size-changed (${elapsed}ms after batch resize)`);
                    resolve();
                });
                signalHandlers.push({ window, handler });
            });
            promises.push(promise);
        }

        // Promise.race: resolve when ANY window moves
        // Timeout: safety net em caso de Mutter lento
        const timeoutPromise = new Promise((resolve) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                timeoutOccurred = true;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
        
        try {
            await Promise.race([
                Promise.race(promises),
                timeoutPromise
            ]);
            const totalElapsed = Date.now() - startTime;
            if (timeoutOccurred) {
                Logger.log(`[SMART RESIZE EVENT-DRIVEN] ⏱ Timeout after ${totalElapsed}ms (window manager slow to respond)`);
            } else {
                Logger.log(`[SMART RESIZE EVENT-DRIVEN] ✓ Size change detected in ${totalElapsed}ms`);
            }
        } catch (e) {
            Logger.log(`[SMART RESIZE EVENT-DRIVEN] Promise.race error (should not happen): ${e}`);
        } finally {
            // CRITICAL: Cleanup - disconnect all handlers
            for (const { window, handler } of signalHandlers) {
                try {
                    window.disconnect(handler);
                } catch (e) {
                    Logger.log(`[SMART RESIZE EVENT-DRIVEN] Warning: Failed to disconnect signal from ${window.get_id()}`);
                }
            }
        }
        
        return timeoutOccurred;
    }

    /**
     * Aplicar os tamanhos reduzidos finais e marcar flags apropriados
     */
    commitResizes() {
        Logger.log(`[SMART RESIZE] Committing ${this.originalSizes.size} resized windows`);
        
        for (const [id, size] of this.originalSizes) {
            const window = this.windows.find(w => w.get_id() === id);
            if (!window) continue;

            WindowState.set(window, 'originalSize', size);
            // CRITICAL: Save original size in preferredSize for later restoration
            // When window closes, tryRestoreWindowSizes() will use this to expand remaining windows
            WindowState.set(window, 'preferredSize', { width: size.width, height: size.height });
            WindowState.set(window, 'isConstrainedByMosaic', true);
            // CRITICAL: Disable isSmartResizing flag AFTER successful commit
            // Releases onSizeChanged to work normally again
            WindowState.set(window, 'isSmartResizing', false);
            
            const current = this.currentSizes.get(id);
            const frame = window.get_frame_rect();
            
            Logger.log(`[SMART RESIZE] Committed: ${id}, original=${size.width}x${size.height}, current=${current.width}x${current.height}`);
            
            // IMPORTANT: Validate that the CURRENT window size matches what was applied
            // If there's mismatch, clear targetSmartResizeSize to avoid outdated masks
            const sizeMismatch = Math.max(
                Math.abs(frame.width - current.width),
                Math.abs(frame.height - current.height)
            );
            
            if (sizeMismatch > constants.SMART_RESIZE_DETECTION_DELTA_PX) {
                Logger.log(`[SMART RESIZE] WARNING: Size mismatch for ${id}: frame=${frame.width}x${frame.height}, expected=${current.width}x${current.height}, delta=${sizeMismatch}px`);
                Logger.log(`[SMART RESIZE] Clearing targetSmartResizeSize due to mismatch`);
                WindowState.set(window, 'targetSmartResizeSize', null);
            } else {
                // Size matches! Preserve targetSmartResizeSize for next tiling use
                WindowState.set(window, 'targetSmartResizeSize', current);
            }
        }
    }

    /**
     * Reverter tudo ao original (reverse smart resize em caso de overflow final)
     */
    async revertAll() {
        Logger.log(`[SMART RESIZE] Reverting ${this.windows.length} windows to original sizes`);
        
        for (const window of this.windows) {
            const id = window.get_id();
            const originalSize = this.originalSizes.get(id);
            if (!originalSize) continue;

            Logger.log(`[SMART RESIZE] Reverting ${id}: ${originalSize.width}x${originalSize.height}`);
            
            const frame = window.get_frame_rect();
            window.move_resize_frame(false, frame.x, frame.y, originalSize.width, originalSize.height);
            
            WindowState.set(window, 'targetSmartResizeSize', originalSize);
            WindowState.set(window, 'isConstrainedByMosaic', false);
            WindowState.set(window, 'hitMinimumSize', false);
            WindowState.set(window, 'smartResizing', false);
            // Limpar preferredSize quando revert - janela volta ao tamanho original
            WindowState.remove(window, 'preferredSize');
        }
        
        // Aguardar Mutter aplicar os reverts
        await this._waitMs(constants.SMART_RESIZE_ITERATION_DEBOUNCE_MS);
    }
}

export const TilingManager = GObject.registerClass({
    GTypeName: 'MosaicTilingManager',
    Signals: {
        'mosaic-changed': { param_types: [GObject.TYPE_OBJECT] }, // Emitted when layout changes (param: workspace)
    },
}, class TilingManager extends GObject.Object {
    _init(extension) {
        super._init();
        this.masks = [];
        this.working_windows = [];
        this.tmp_swap = [];
        this.isDragging = false;
        this.dragRemainingSpace = null;
        
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
        this._extension = null;
        
        // Queue for serializing window opening operations to prevent race conditions
        this._openingQueue = [];
        this._processingQueue = false;
        
        // Promise chain to serialize smart resize operations
        this._smartResizeQueue = Promise.resolve();
        // Flag to block overflow decisions during smart resize
        this._isSmartResizingBlocked = false;
        
        // Layout cache to avoid redundant O(n!) permutation calculations
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
    }

    setEdgeTilingManager(manager) {
        this._edgeTilingManager = manager;
    }
    
    setExtension(extension) {
        this._extension = extension;
    }

    setDrawingManager(manager) {
        this._drawingManager = manager;
    }

    setAnimationsManager(manager) {
        this._animationsManager = manager;
    }

    setWindowingManager(manager) {
        this._windowingManager = manager;
    }

    createMask(window) {
        const id = window.id !== undefined ? window.id : (window.get_id ? window.get_id() : null);
        if (id !== null) {
            this.masks[id] = true;
        }
    }

    destroyMasks() {
        if (this._drawingManager) {
            this._drawingManager.removeBoxes();
        }
        // Clear logical masks only when not dragging; recycle boxes otherwise.
        if (!this.isDragging) {
            this.masks = [];
        }
    }

    getMask(window) {
        const id = window.id !== undefined ? window.id : (window.get_id ? window.get_id() : null);
        if(id !== null && this.masks[id])
            return new Mask(window);
        return window;
    }

    enableDragMode(remainingSpace = null) {
        this.isDragging = true;
        this.dragRemainingSpace = remainingSpace;
    }

    disableDragMode() {
        this.isDragging = false;
        this.dragRemainingSpace = null;
    }

    setDragRemainingSpace(space) {
        this.dragRemainingSpace = space;
    }

    clearDragRemainingSpace() {
        this.dragRemainingSpace = null;
    }
    
    setExcludedWindow(window) {
        this._excludedWindow = window;
    }
    
    clearExcludedWindow() {
        this._excludedWindow = null;
    }
    
    // Invalidate the layout cache when windows change
    invalidateLayoutCache() {
        this._lastLayoutHash = null;
        this._cachedTileResult = null;
    }
    
    // Get the cached layout result (array of {id, x, y, width, height})
    getCachedLayout() {
        return this._cachedTileResult?.windows || null;
    }
    
    // Queue a window opening operation to prevent race conditions
    // The callback will be called when it's this window's turn
    enqueueWindowOpen(windowId, callback) {
        Logger.log(`[MOSAIC WM] Enqueuing window ${windowId} for opening (queue size: ${this._openingQueue.length})`);
        this._openingQueue.push({ windowId, callback });
        this._processOpeningQueue();
    }
    
    // Process the opening queue one window at a time
    _processOpeningQueue() {
        if (this._processingQueue || this._openingQueue.length === 0) {
            return;
        }
        
        this._processingQueue = true;
        const { windowId, callback } = this._openingQueue.shift();
        
        Logger.log(`[MOSAIC WM] Processing queue: window ${windowId} (remaining: ${this._openingQueue.length})`);
        
        // Monitor this processing step
        const watchdogId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
             Logger.log(`[MOSAIC WM] Queue watchdog: Window ${windowId} callback took too long or stalled - forcing next`);
             this._processingQueue = false;
             this._processOpeningQueue();
             return GLib.SOURCE_REMOVE;
        });

        // Execute the callback
        try {
            callback();
        } catch (e) {
            Logger.log(`[MOSAIC WM] Error processing window ${windowId}: ${e}`);
        } finally {
            if (watchdogId) GLib.source_remove(watchdogId);
        }
        
        // Small delay before processing next window to let animations settle
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.QUEUE_PROCESS_DELAY_MS, () => {
             this._processingQueue = false;
             this._processOpeningQueue();
             return GLib.SOURCE_REMOVE;
        });
    }
    
    // Clear queue (e.g., on disable)
    clearOpeningQueue() {
        this._openingQueue = [];
        this._processingQueue = false;
    }

    setTmpSwap(id1, id2) {
        if (id1 === id2 || (this.tmp_swap[0] === id2 && this.tmp_swap[1] === id1))
            return;
        this.tmp_swap = [id1, id2];
    }

    clearTmpSwap() {
        this.tmp_swap = [];
    }

    applyTmpSwap(workspace) {
        if(!workspace.swaps)
            workspace.swaps = [];
        
        if(this.tmp_swap.length !== 0)
            workspace.swaps.push(this.tmp_swap);
    }

    applySwaps(workspace, array) {
        if(workspace.swaps)
            for(let swap of workspace.swaps)
                this._swapElements(array, swap[0], swap[1]);
    }

    applyTmp(array) {
        if(this.tmp_swap.length !== 0) {
            this._swapElements(array, this.tmp_swap[0], this.tmp_swap[1]);
        }
    }

    _swapElements(array, id1, id2) {
        const index1 = array.findIndex(w => w.id === id1);
        const index2 = array.findIndex(w => w.id === id2);
        
        if (index1 === -1 || index2 === -1)
            return;
        
        let tmp = array[index1];
        array[index1] = array[index2];
        array[index2] = tmp;
    }

    checkValidity(monitor, workspace, window, strict) {
        if (monitor !== null &&
            window.wm_class !== null &&
            window.get_compositor_private() &&
            workspace.list_windows().length !== 0 &&
            (strict ? !window.is_hidden() : !window.minimized)
        ) {
            return true;
        } else {
            return false;
        }
    }

    _createDescriptor(meta_window, monitor, index, reference_window) {
        if(reference_window)
            if(meta_window.get_id() === reference_window.get_id())
                return new WindowDescriptor(meta_window, index);
        
        if( this._windowingManager.isExcluded(meta_window) ||
            meta_window.get_monitor() !== monitor ||
            this._windowingManager.isMaximizedOrFullscreen(meta_window))
            return false;
        return new WindowDescriptor(meta_window, index);
    }

    windowsToDescriptors(meta_windows, monitor, reference_window) {
        let descriptors = [];
        for(let i = 0; i < meta_windows.length; i++) {
            let descriptor = this._createDescriptor(meta_windows[i], monitor, i, reference_window);
            if(descriptor)
                descriptors.push(descriptor);
        }
        return descriptors;
    }

    // Generate permutations of an array (limited for performance)
    // For 6+ items, returns heuristic orderings instead of all permutations
    _generatePermutations(arr, maxPermutations = 120) {
        if (arr.length <= 1) return [arr];
        if (arr.length === 2) return [arr, [arr[1], arr[0]]];
        
        // For 6+ windows, use heuristic orderings (by area, descending and ascending)
        // This avoids O(n!) complexity: 6! = 720, 7! = 5040 permutations
        if (arr.length >= 6) {
            const byAreaDesc = [...arr].sort((a, b) => (b.width * b.height) - (a.width * a.height));
            const byAreaAsc = [...arr].sort((a, b) => (a.width * a.height) - (b.width * b.height));
            const byWidthDesc = [...arr].sort((a, b) => b.width - a.width);
            const byHeightDesc = [...arr].sort((a, b) => b.height - a.height);
            return [arr, byAreaDesc, byAreaAsc, byWidthDesc, byHeightDesc];
        }
        
        // Generate all permutations using Heap's algorithm
        const result = [];
        const heap = (n, arr) => {
            if (n === 1) {
                result.push([...arr]);
                return;
            }
            for (let i = 0; i < n; i++) {
                heap(n - 1, arr);
                if (result.length >= maxPermutations) return;
                if (n % 2 === 0) {
                    [arr[i], arr[n - 1]] = [arr[n - 1], arr[i]];
                } else {
                    [arr[0], arr[n - 1]] = [arr[n - 1], arr[0]];
                }
            }
        };
        heap(arr.length, [...arr]);
        return result;
    }

    // Score a layout result - higher is better
    // Prioritizes: no overflow, compactness, centralization
    _scoreLayout(tileResult, workArea) {
        if (!tileResult || tileResult.overflow) return -Infinity;
        
        // Calculate bounding box of all windows
        let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
        let totalArea = 0;
        
        for (const level of tileResult.levels) {
            for (const w of level.windows) {
                const x = w.targetX || level.x;
                const y = w.targetY || level.y;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + w.width);
                maxY = Math.max(maxY, y + w.height);
                totalArea += w.width * w.height;
            }
        }
        
        if (minX === Infinity) return -Infinity;
        
        const bboxWidth = maxX - minX;
        const bboxHeight = maxY - minY;
        const bboxArea = bboxWidth * bboxHeight;
        
        // Score components
        // 1. Compactness: ratio of window area to bounding box area (0-1)
        const compactness = totalArea / Math.max(bboxArea, 1);
        
        // 2. Centralization: how close is the bbox center to workArea center
        const bboxCenterX = minX + bboxWidth / 2;
        const bboxCenterY = minY + bboxHeight / 2;
        const workCenterX = workArea.x + workArea.width / 2;
        const workCenterY = workArea.y + workArea.height / 2;
        const centerDist = Math.sqrt(
            Math.pow(bboxCenterX - workCenterX, 2) + 
            Math.pow(bboxCenterY - workCenterY, 2)
        );
        const maxDist = Math.sqrt(Math.pow(workArea.width, 2) + Math.pow(workArea.height, 2)) / 2;
        const centralization = 1 - (centerDist / maxDist);
        
        // 3. Size efficiency: smaller bounding box is better
        const sizeEfficiency = 1 - (bboxArea / (workArea.width * workArea.height));
        
        // Weighted score (compactness is most important)
        return compactness * 50 + centralization * 30 + sizeEfficiency * 20;
    }

    // Find the optimal window ordering by trying permutations
    _findOptimalOrder(windows, workArea, tilingFn) {
        if (windows.length <= 1) return windows;
        
        const startTime = Date.now();
        const permutations = this._generatePermutations(windows);
        
        let bestOrder = windows;
        let bestScore = -Infinity;
        
        for (const perm of permutations) {
            const result = tilingFn.call(this, perm, workArea, constants.WINDOW_SPACING);
            const score = this._scoreLayout(result, workArea);
            
            if (score > bestScore) {
                bestScore = score;
                bestOrder = perm;
            }
        }
        
        const elapsed = Date.now() - startTime;
        Logger.log(`[MOSAIC WM] _findOptimalOrder: ${windows.length} windows, ${permutations.length} permutations, ${elapsed}ms`);
        
        return bestOrder;
    }

    // Generate a hash of window configuration for cache invalidation.
    // If windows haven't changed IDs/sizes, we can reuse the previous layout.
    _getLayoutHash(windows, work_area) {
        const sorted = [...windows].sort((a, b) => a.id - b.id);
        const parts = sorted.map(w => `${w.id}:${w.width}x${w.height}`);
        return `${work_area.width}x${work_area.height}|${parts.join(',')}`;
    }

    // Tile windows with dynamic shelf orientation.
    // Selects vertical columns if any window is tall (>65%) or workspace is narrow.
    // Uses optimal permutation search for predictable, best-quality layouts.
    _tile(windows, work_area, isSimulation = false) {
        if (!windows || windows.length === 0) return { levels: [], vertical: false, overflow: false };

        const hash = this._getLayoutHash(windows, work_area);
        if (this._cachedTileResult && this._lastLayoutHash === hash && !isSimulation) {
            Logger.log('[MOSAIC WM] _tile: Cache hit, reusing layout');
            return this._cachedTileResult;
        }
        
        const spacing = constants.WINDOW_SPACING;
        
        // Check if any window is taller than 50% of workspace height
        let maxHeight = 0;
        let maxWidth = 0;
        for (const w of windows) {
            maxHeight = Math.max(maxHeight, w.height);
            maxWidth = Math.max(maxWidth, w.width);
        }
        
        const isNarrowWorkspace = work_area.width < work_area.height;
        const windowTooWide = maxWidth > work_area.width * 0.9;
        const windowTooTall = maxHeight > work_area.height * 0.65;
        const useVerticalShelves = windowTooTall || isNarrowWorkspace || windowTooWide;
        
        // Select tiling function based on orientation
        const tilingFn = useVerticalShelves ? this._verticalShelves : this._horizontalShelves;
        
        // Find optimal window ordering (tries permutations, scores each layout)
        const optimalWindows = this._findOptimalOrder(windows, work_area, tilingFn);
        
        Logger.log(`[MOSAIC WM] _tile: ${windows.length} windows, vertical=${useVerticalShelves}, optimized order`);
        
        // Execute with optimal order and cache result (unless simulation)
        const result = tilingFn.call(this, optimalWindows, work_area, spacing);
        
        if (!isSimulation) {
            this._lastLayoutHash = hash;
            this._cachedTileResult = result;
        }
        
        return result;
    }
    
    // Vertical shelves layout - windows stack in columns side by side.
    _verticalShelves(windows, work_area, spacing) {
        // For 1-2 windows, use simple centered column
        if (windows.length <= 2) {
            return this._simpleCenteredColumn(windows, work_area, spacing);
        }
        
        // Bin packing without height sorting to preserve swap order
        const columns = []; // Each column: { windows: [], height: 0, width: 0 }
        
        for (const w of windows) {
            let placed = false;
            
            // Try to fit in existing column
            for (const col of columns) {
                const newHeight = col.height + (col.height > 0 ? spacing : 0) + w.height;
                if (newHeight <= work_area.height) {
                    col.windows.push(w);
                    col.height = newHeight;
                    col.width = Math.max(col.width, w.width);
                    placed = true;
                    break;
                }
            }
            
            // If doesn't fit anywhere, create new column
            if (!placed) {
                const totalWidth = columns.reduce((s, c) => s + c.width, 0) + 
                                   (columns.length > 0 ? columns.length * spacing : 0) + w.width;
                
                if (totalWidth <= work_area.width || columns.length === 0) {
                    columns.push({ windows: [w], height: w.height, width: w.width });
                } else {
                    // Force into column with most space (overflow case)
                    let bestCol = columns[0];
                    let minHeight = columns[0].height;
                    for (const col of columns) {
                        if (col.height < minHeight) {
                            minHeight = col.height;
                            bestCol = col;
                        }
                    }
                    bestCol.windows.push(w);
                    bestCol.height += spacing + w.height;
                    bestCol.width = Math.max(bestCol.width, w.width);
                }
            }
        }
        
        // Convert columns to levels for rendering
        const levels = [];
        let totalWidth = 0;
        let overflow = false;
        
        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const level = new Level(work_area);
            
            // Recalculate height for this column's windows
            let colHeight = 0;
            for (const w of col.windows) {
                level.windows.push(w);
                if (colHeight > 0) colHeight += spacing;
                colHeight += w.height;
                level.width = Math.max(level.width, w.width);
            }
            level.height = colHeight;
            
            // Check if column overflows height
            if (level.height > work_area.height) {
                overflow = true;
            }
            
            // Center column vertically
            level.y = (work_area.height - level.height) / 2 + work_area.y;
            
            // Check width overflow
            if (totalWidth + level.width + spacing > work_area.width && c > 0) {
                overflow = true;
            }
            
            if (c > 0) totalWidth += spacing;
            totalWidth += level.width;
            
            levels.push(level);
        }
        
        // Calculate horizontal centering
        const startX = (work_area.width - totalWidth) / 2 + work_area.x;
        const levelCount = levels.length;
        const centerColIndex = (levelCount - 1) / 2; // e.g., 0.5 for 2 cols, 1 for 3 cols
        
        // Set X positions for each column with CENTER-POINTING alignment
        let xPos = startX;
        for (let colIdx = 0; colIdx < levelCount; colIdx++) {
            const level = levels[colIdx];
            level.x = xPos;
            
            // Determine horizontal alignment based on column position
            let alignMode = 'center';
            if (levelCount > 1) {
                if (colIdx < centerColIndex) {
                    alignMode = 'right'; // Left column → push windows right
                } else if (colIdx > centerColIndex) {
                    alignMode = 'left';  // Right column → push windows left
                }
            }
            
            // Stack windows vertically (packed, centered vertically)
            let totalColHeight = 0;
            for (const win of level.windows) {
                totalColHeight += win.height;
            }
            totalColHeight += (level.windows.length - 1) * spacing;
            
            let yPos = (work_area.height - totalColHeight) / 2 + work_area.y;
            
            for (const win of level.windows) {
                // Apply horizontal alignment within column
                if (alignMode === 'left') {
                    win.targetX = xPos; // Align to left edge of column
                } else if (alignMode === 'right') {
                    win.targetX = xPos + level.width - win.width; // Align to right edge
                } else {
                    win.targetX = xPos + (level.width - win.width) / 2; // Centered
                }
                win.targetY = yPos;
                yPos += win.height + spacing;
            }
            
            xPos += level.width + spacing;
        }

        return {
            x: startX,
            y: work_area.y,
            overflow: overflow,
            vertical: true,
            levels: levels,
            windows: windows
        };
    }
    
    // Helper for 1-2 windows in vertical mode.
    _simpleCenteredColumn(windows, work_area, spacing) {
        // Calculate total height if stacked
        let totalHeight = 0;
        let maxWidth = 0;
        for (const w of windows) {
            if (totalHeight > 0) totalHeight += spacing;
            totalHeight += w.height;
            maxWidth = Math.max(maxWidth, w.width);
        }
        
        // If windows DON'T fit when stacked, put them side by side in separate columns
        if (totalHeight > work_area.height && windows.length === 2) {
            // Create 2 columns side by side
            const totalWidth = windows[0].width + spacing + windows[1].width;
            const startX = (work_area.width - totalWidth) / 2 + work_area.x;
            
            const levels = [];
            let xPos = startX;
            
            for (const w of windows) {
                const level = new Level(work_area);
                level.windows.push(w);
                level.width = w.width;
                level.height = w.height;
                level.x = xPos;
                level.y = (work_area.height - w.height) / 2 + work_area.y;
                
                w.targetX = level.x;
                w.targetY = level.y;
                
                levels.push(level);
                xPos += w.width + spacing;
            }
            
            const overflow = totalWidth > work_area.width;
            
            return {
                x: startX,
                y: work_area.y,
                overflow: overflow,
                vertical: true,
                levels: levels,
                windows: windows
            };
        }
        
        // Windows FIT when stacked - use single column
        const level = new Level(work_area);
        for (const w of windows) {
            level.windows.push(w);
        }

        level.width = maxWidth;
        level.height = totalHeight;
        level.x = (work_area.width - maxWidth) / 2 + work_area.x;
        level.y = (work_area.height - totalHeight) / 2 + work_area.y;

        // Set target positions for each window
        let yPos = level.y;
        for (const w of level.windows) {
            w.targetX = level.x + (maxWidth - w.width) / 2;
            w.targetY = yPos;
            yPos += w.height + spacing;
        }

        const overflow = totalHeight > work_area.height || maxWidth > work_area.width;

        return {
            x: level.x,
            y: level.y,
            overflow: overflow,
            vertical: true,
            levels: [level],
            windows: windows
        };
    }
    
    // Original horizontal shelves layout.
    _horizontalShelves(windows, work_area, spacing) {
        // For 1-2 windows, use simple centered row
        if (windows.length <= 2) {
            return this._simpleCenteredRow(windows, work_area, spacing);
        }
        
        // Calculate average dimensions
        let avgWidth = 0, avgHeight = 0;
        for (const w of windows) {
            avgWidth += w.width;
            avgHeight += w.height;
        }
        avgWidth /= windows.length;
        avgHeight /= windows.length;
        
        // Calculate optimal grid dimensions
        const { rows: numRows, windowsPerRow } = this._calculateOptimalGrid(
            windows,
            work_area
        );
        
        // Distribute windows across rows
        const levels = [];
        let windowIndex = 0;
        let totalHeight = 0;
        let overflow = false;
        
        for (let r = 0; r < numRows; r++) {
            const level = new Level(work_area);
            const windowsInThisRow = windowsPerRow[r];
            
            for (let i = 0; i < windowsInThisRow && windowIndex < windows.length; i++) {
                const w = windows[windowIndex++];
                if (level.width + w.width + (level.width > 0 ? spacing : 0) > work_area.width) {
                    overflow = true;
                }
                
                level.windows.push(w);
                if (level.width > 0) level.width += spacing;
                level.width += w.width;
                level.height = Math.max(level.height, w.height);
            }
            
            level.x = (work_area.width - level.width) / 2 + work_area.x;
            if (totalHeight + level.height + spacing > work_area.height && r > 0) {
                overflow = true;
            }
            
            if (r > 0) totalHeight += spacing;
            totalHeight += level.height;
            
            levels.push(level);
        }
        
        const y = (work_area.height - totalHeight) / 2 + work_area.y;
        
        // Set targetX/targetY for each window in each level
        let levelY = y;
        for (const level of levels) {
            level.y = levelY;
            let xPos = level.x;
            for (const w of level.windows) {
                w.targetX = xPos;
                w.targetY = levelY + (level.height - w.height) / 2; // Center vertically within row
                xPos += w.width + spacing;
            }
            levelY += level.height + spacing;
        }
        
        return {
            x: work_area.x,
            y: y,
            overflow: overflow,
            vertical: false,
            levels: levels,
            windows: windows
        };
    }

    // Helper for 1-2 windows, simple centered row.
    _simpleCenteredRow(windows, work_area, spacing) {
        const level = new Level(work_area);
        let totalWidth = 0;
        let maxHeight = 0;

        for (const w of windows) {
            if (totalWidth > 0) totalWidth += spacing;
            totalWidth += w.width;
            maxHeight = Math.max(maxHeight, w.height);
            level.windows.push(w);
        }

        level.width = totalWidth;
        level.height = maxHeight;
        level.x = (work_area.width - totalWidth) / 2 + work_area.x;
        
        const y = (work_area.height - maxHeight) / 2 + work_area.y;
        level.y = y;

        let xPos = level.x;
        for (const w of level.windows) {
            w.targetX = xPos;
            w.targetY = y + (maxHeight - w.height) / 2; // Center vertically within row
            xPos += w.width + spacing;
        }

        return {
            x: work_area.x,
            y: y,
            overflow: totalWidth > work_area.width || maxHeight > work_area.height,
            vertical: false,
            levels: [level],
            windows: windows
        };
    }
    
    // Calculate optimal grid dimensions using actual window sizes
    _calculateOptimalGrid(windows, work_area) {
        const windowCount = windows.length;
        if (windowCount <= 0) return { rows: 0, windowsPerRow: [] };
        if (windowCount === 1) return { rows: 1, windowsPerRow: [1] };
        if (windowCount === 2) return { rows: 1, windowsPerRow: [2] };
        
        const spacing = constants.WINDOW_SPACING;
        const workspaceAspect = work_area.width / work_area.height;
        
        let bestRows = 1;
        let bestScore = Infinity;
        let bestOverflow = true; // Start assuming everything overflows
        
        // Try different row counts
        for (let rows = 1; rows <= windowCount; rows++) {
            const cols = Math.ceil(windowCount / rows);
            
            // Distribute windows logic (symmetric)
            const windowsPerRow = new Array(rows).fill(0);
            const basePerRow = Math.floor(windowCount / rows);
            let remainder = windowCount % rows;

            for (let r = 0; r < rows; r++) windowsPerRow[r] = basePerRow;

            if (remainder > 0) {
                const centerIndex = Math.floor(rows / 2);
                let left = centerIndex;
                let right = centerIndex;
                
                while (remainder > 0) {
                    if (left >= 0 && left < rows) { windowsPerRow[left]++; remainder--; }
                    if (remainder > 0 && right !== left && right >= 0 && right < rows) { windowsPerRow[right]++; remainder--; }
                    left--;
                    right++;
                }
            }
            
            // SIMULATE ACTUAL PLACEMENT to check fit
            let totalHeight = 0;
            let maxRowWidth = 0;
            let windowIndex = 0;
            let currentRowHeight = 0;
            let currentRowWidth = 0;
            let overflow = false;
            
            for (let r = 0; r < rows; r++) {
                currentRowHeight = 0;
                currentRowWidth = 0;
                const count = windowsPerRow[r];
                
                for (let i = 0; i < count; i++) {
                    if (windowIndex < windows.length) {
                        const w = windows[windowIndex++];
                        currentRowWidth += w.width + (currentRowWidth > 0 ? spacing : 0);
                        currentRowHeight = Math.max(currentRowHeight, w.height);
                    }
                }
                
                if (currentRowWidth > work_area.width + 5) overflow = true;
                maxRowWidth = Math.max(maxRowWidth, currentRowWidth);
                
                totalHeight += currentRowHeight + (r > 0 ? spacing : 0);
            }
            
            if (totalHeight > work_area.height + 5) overflow = true;
            
            // Calculate score (Aspect ratio + Empty spaces)
            const layoutWidth = maxRowWidth;
            const layoutHeight = totalHeight;
            const layoutAspect = layoutWidth / layoutHeight;
            const aspectDiff = Math.abs(layoutAspect - workspaceAspect);
            const emptySpaces = rows * cols - windowCount;
            // Heavily penalize overflow
            const score = aspectDiff + emptySpaces * 0.3 + (overflow ? 1000 : 0);
            
            // Prefer valid layouts over invalid ones
            if (!overflow && bestOverflow) {
                // Found first valid layout!
                bestScore = score;
                bestRows = rows;
                bestOverflow = false;
            } else if (overflow === bestOverflow) {
                // Determine best among same validity status
                if (score < bestScore) {
                    bestScore = score;
                    bestRows = rows;
                }
            }
        }
        
        // Re-generate windowsPerRow for the best result
        const windowsPerRow = new Array(bestRows).fill(0);
        const basePerRow = Math.floor(windowCount / bestRows);
        let remainder = windowCount % bestRows;

        for (let r = 0; r < bestRows; r++) windowsPerRow[r] = basePerRow;

        if (remainder > 0) {
            const centerIndex = Math.floor(bestRows / 2);
            let left = centerIndex;
            let right = centerIndex;
            
            while (remainder > 0) {
                if (left >= 0 && left < bestRows) { windowsPerRow[left]++; remainder--; }
                if (remainder > 0 && right !== left && right >= 0 && right < bestRows) { windowsPerRow[right]++; remainder--; }
                left--;
                right++;
            }
        }
        
        return { rows: bestRows, windowsPerRow };
    }

    _getWorkingInfo(workspace, window, _monitor, excludeFromTiling = false) {
        let current_monitor = _monitor;
        if(current_monitor === undefined)
            current_monitor = window.get_monitor();

        let meta_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, current_monitor);
        
        // Filter out excluded windows (always on top, sticky, etc.)
        meta_windows = meta_windows.filter(w => !this._windowingManager.isExcluded(w));
        
        // Exclude the reference window only if explicitly requested (for overflow scenarios)
        if (window && excludeFromTiling && !this.isDragging) {
            const windowId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== windowId);
        }
        
        if (this.isDragging && this.dragRemainingSpace && window) {
            const draggedId = window.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== draggedId);
        }
        
        // Exclude window marked as overflow (won't fit in mosaic)
        if (this._excludedWindow) {
            const excludedId = this._excludedWindow.get_id();
            meta_windows = meta_windows.filter(w => w.get_id() !== excludedId);
        }
        
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, current_monitor);
        }
        
        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        const nonEdgeTiledMetaWindows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));

        const windowsForSwaps = edgeTiledWindows.length > 0 ? nonEdgeTiledMetaWindows : meta_windows;

        for (const win of meta_windows) {
            if (this._windowingManager.isMaximizedOrFullscreen(win))
                return false;
        }

        let _windows = this.windowsToDescriptors(windowsForSwaps, current_monitor, window);
        
        this.applySwaps(workspace, _windows);
        this.working_windows = [];
        _windows.map(w => this.working_windows.push(w));
        this.applyTmp(_windows);
        
        let windows = [];
        for(let w of _windows)
            windows.push(this.getMask(w));

        let work_area = workspace.get_work_area_for_monitor(current_monitor);
        if(!work_area) return false;

        return {
            monitor: current_monitor,
            meta_windows: meta_windows,
            windows: windows,
            work_area: work_area
        }
    }

    _drawTile(tile_info, work_area, meta_windows, dryRun = false) {
        let levels = tile_info.levels;
        let _x = tile_info.x;
        let _y = tile_info.y;
        if(!tile_info.vertical) {
            let y = _y;
            for(let level of levels) {
                Logger.log(`[MOSAIC WM] Drawing horizontal level at y=${y}, width=${level.width}, height=${level.height}`);
                // Pass masks, isDragging AND drawingManager AND dryRun
                level.draw_horizontal(meta_windows, work_area, y, this.masks, this.isDragging, this._drawingManager, dryRun);
                y += level.height + constants.WINDOW_SPACING;
            }
        } else {
            let x = _x;
            for(let level of levels) {
                Logger.log(`[MOSAIC WM] Drawing vertical level at x=${x}, width=${level.width}, height=${level.height}`);
                level.draw_vertical(meta_windows, x, this.masks, this.isDragging, this._drawingManager, dryRun);
                x += level.width + constants.WINDOW_SPACING;
            }
        }
    }

    _animateTileLayout(workspace, tile_info, work_area, meta_windows, draggedWindow = null) {
        if (this._animationsManager) {
            const resizingWindowId = this._animationsManager.getResizingWindowId();
            
            const levels = tile_info.levels;
            const _y = tile_info.y;
            
            const windowLayouts = [];
            
            if (!tile_info.vertical) {
                let y = _y;
                for (let level of levels) {
                    let x = level.x;
                    for (let windowDesc of level.windows) {
                        let center_offset = (work_area.height / 2 + work_area.y) - (y + windowDesc.height / 2);
                        let y_offset = 0;
                        if (center_offset > 0)
                            y_offset = Math.min(center_offset, level.height - windowDesc.height);
                        
                        const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                        if (window) {
                            if (windowDesc.id === resizingWindowId) {
                                window.move_frame(false, x, y + y_offset);
                            } else {
                                windowLayouts.push({
                                    window: window,
                                    rect: {
                                        x: x,
                                        y: y + y_offset,
                                        width: windowDesc.width,
                                        height: windowDesc.height
                                    }
                                });
                            }
                        }
                        x += windowDesc.width + constants.WINDOW_SPACING;
                    }
                    y += level.height + constants.WINDOW_SPACING;
                }
            } else {
                // Vertical layout: each level is a column
                let x = tile_info.x;
                for (let level of levels) {
                    let y = level.y;
                    for (let windowDesc of level.windows) {
                        // Use targetX/targetY if set, otherwise calculate
                        const targetX = windowDesc.targetX !== undefined ? windowDesc.targetX : x;
                        const targetY = windowDesc.targetY !== undefined ? windowDesc.targetY : y;
                        
                        const window = meta_windows.find(w => w.get_id() === windowDesc.id);
                        if (window) {
                            if (windowDesc.id === resizingWindowId) {
                                window.move_frame(false, targetX, targetY);
                            } else {
                                windowLayouts.push({
                                    window: window,
                                    rect: {
                                        x: targetX,
                                        y: targetY,
                                        width: windowDesc.width,
                                        height: windowDesc.height
                                    }
                                });
                            }
                        }
                        y += windowDesc.height + constants.WINDOW_SPACING;
                    }
                    x += level.width + constants.WINDOW_SPACING;
                }
            }
            
            this._animationsManager.animateReTiling(windowLayouts, draggedWindow);
        }

        // UNLOCK: Release workspace lock after signals from move_resize have likely fired.
        // We use a safe delay matching the animation duration.
        if (this._extension && this._extension.windowHandler) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.ANIMATION_DURATION_MS + 100, () => {
                this._extension.windowHandler.unlockWorkspace(workspace);
                return GLib.SOURCE_REMOVE;
            });
        }

        return true;
    }

    tileWorkspaceWindows(workspace, reference_meta_window, _monitor, keep_oversized_windows, excludeFromTiling = false, dryRun = false, isRecursive = false) {
        if (this._extension && !this._extension.isMosaicEnabledForWorkspace(workspace)) {
            Logger.log(`[MOSAIC WM] Mosaic disabled for workspace ${workspace.index()} - skipping tiling`);
            return { overflow: false, layout: null };
        }

        Logger.log(`[MOSAIC WM] tileWorkspaceWindows: Starting for workspace ${workspace.index()} (isRecursive=${isRecursive})`);

        // Clear previous masks before drawing; recycle boxes if dragging.
        if (!isRecursive && !dryRun) {
            this.destroyMasks();
        }

        // LOCK: Prevent spurious overflow detection during tiling shifts
        if (this._extension && this._extension.windowHandler) {
            this._extension.windowHandler.lockWorkspace(workspace);
        }

        // Auto-detect monitors: if no monitor specified and no reference window,
        // iterate over all monitors to ensure complete tiling coverage
        if (_monitor === null || _monitor === undefined) {
            if (!reference_meta_window) {
                const nMonitors = global.display.get_n_monitors();
                if (nMonitors > 1) {
                    Logger.log(`[MOSAIC WM] Auto-tiling workspace ${workspace.index()} across ${nMonitors} monitors`);
                }
                for (let m = 0; m < nMonitors; m++) {
                    this.tileWorkspaceWindows(workspace, null, m, keep_oversized_windows, excludeFromTiling, dryRun, true);
                }
                
                // UNLOCK: The recursive calls will handle their own monitor-specific locks,
                // but we need to ensure the final state is unlocked after a safe delay.
                if (this._extension && this._extension.windowHandler) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, constants.ANIMATION_DURATION_MS + 50, () => {
                        this._extension.windowHandler.unlockWorkspace(workspace);
                        return GLib.SOURCE_REMOVE;
                    });
                }
                return { overflow: false, layout: null };
            } else {
                _monitor = reference_meta_window.get_monitor();
            }
        }
        
        // Invalidate window list cache for this operation
        if (this._windowingManager) {
            this._windowingManager.invalidateWindowsCache();
        }
        
        let working_info = this._getWorkingInfo(workspace, reference_meta_window, _monitor, excludeFromTiling);
        if(!working_info) {
            return { overflow: false, layout: null };
        }
        let meta_windows = working_info.meta_windows;
        let windows = working_info.windows;
        let work_area = working_info.work_area;
        let monitor = working_info.monitor;

        const workspace_windows = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor);
        
        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            Logger.log(`[MOSAIC WM] tileWorkspaceWindows: Found ${edgeTiledWindows.length} edge-tiled windows`);
        }
        
        if (edgeTiledWindows.length > 0) {
            Logger.log(`[MOSAIC WM] Found ${edgeTiledWindows.length} edge-tiled window(s)`);
            
            // Check if we have 2 half-tiles (left + right = fully occupied)
            const zones = edgeTiledWindows.map(w => w.zone);
            Logger.log(`[MOSAIC WM] Edge tile zones detected: [${zones.join(', ')}]`);
            const hasLeftFull = zones.includes(TileZone.LEFT_FULL);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
            const hasRightQuarters = zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
            
            Logger.log(`[MOSAIC WM] Zone check: leftFull=${hasLeftFull}, rightFull=${hasRightFull}, leftQuarters=${hasLeftQuarters}, rightQuarters=${hasRightQuarters}`);
            
            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                // Don't move windows during drag - just show preview
                if (this.isDragging) {
                    Logger.log('[MOSAIC WM] Both sides edge-tiled - deferring overflow until drag ends');
                    return { overflow: false, layout: null }; // Let preview show but don't move windows
                }
                
                Logger.log('[MOSAIC WM] Both sides edge-tiled - workspace fully occupied');
                
                // GUARD: Only trigger mass expulsion if the change was caused by an edge-tiled window (completing the wall)
                // If a normal window is added to a full workspace, ONLY expel that window.
                const edgeTiledIds = edgeTiledWindows.map(w => w.window.get_id());
                const isReferenceEdgeTiled = reference_meta_window && edgeTiledIds.includes(reference_meta_window.get_id());
                
                const nonEdgeTiledMeta = this._edgeTilingManager.getNonEdgeTiledWindows(workspace, monitor);
                
                // Move non-edge-tiled windows to new workspace
                for (const window of nonEdgeTiledMeta) {
                    const isRef = reference_meta_window && window.get_id() === reference_meta_window.get_id();
                    
                    // Expel if:
                    // 1. It's the reference window (the newcomer trying to squeeze in)
                    // 2. OR the reference window IS an edge tile (meaning we just closed the wall on existing windows)
                    if (isRef || isReferenceEdgeTiled) {
                        if (!this._windowingManager.isExcluded(window) && !this._windowingManager.isMaximizedOrFullscreen(window)) {
                            Logger.log(`[MOSAIC WM] Expelling non-edge-tiled window ${window.get_id()} (RefEdgeTiled=${isReferenceEdgeTiled}, IsRef=${isRef})`);
                            this._windowingManager.moveOversizedWindow(window);
                        }
                    }
                }
                
                return { overflow: false, layout: null }; // Don't tile, edge-tiled windows stay in place
            }
            
            // Single tile or quarter tiles - calculate remaining space
            const remainingSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
            const nonEdgeTiledCount = workspace_windows.filter(w => !edgeTiledIds.includes(w.get_id())).length;
            if (this.dragRemainingSpace) {
             Logger.log(`[MOSAIC WM] Reusing drag remaining space: x=${this.dragRemainingSpace.x}, w=${this.dragRemainingSpace.width}`);
             // If we have a cached remaining space from drag, use it
             work_area = this.dragRemainingSpace;
            } else {
                Logger.log(`[MOSAIC WM] Remaining space: x=${remainingSpace.x}, y=${remainingSpace.y}, w=${remainingSpace.width}, h=${remainingSpace.height}`);
                Logger.log(`[MOSAIC WM] Total workspace windows: ${workspace_windows.length}, Non-edge-tiled: ${nonEdgeTiledCount}`);
                
                // Filter out edge-tiled windows from tiling
                meta_windows = meta_windows.filter(w => !edgeTiledIds.includes(w.get_id()));
                Logger.log(`[MOSAIC WM] After filtering edge-tiled: ${meta_windows.length} windows to tile`);
                
                // Also filter out maximized/fullscreen windows (SACRED - never touch them)
                const beforeMaxFilter = meta_windows.length;
                meta_windows = meta_windows.filter(w => !this._windowingManager.isMaximizedOrFullscreen(w));
                if (meta_windows.length < beforeMaxFilter) {
                    Logger.log(`[MOSAIC WM] Filtered ${beforeMaxFilter - meta_windows.length} maximized/fullscreen (sacred) windows`);
                }
                
                // Set work_area to remaining space for tiling calculations
                work_area = remainingSpace;
                
                // If no non-edge-tiled windows, nothing to tile
                if (meta_windows.length === 0) {
                    Logger.log('[MOSAIC WM] No non-edge-tiled windows to tile');
                    return { overflow: false, layout: null };
                }
            }
        }
        
        // GLOBAL: Filter out maximized/fullscreen windows (SACRED - never touch them)
        const isSacredWindow = (w) => {
            // Check flags only (Maximized or Fullscreen)
            return this._windowingManager.isMaximizedOrFullscreen(w);
        };
        
        const sacredWindows = meta_windows.filter(isSacredWindow);
        if (sacredWindows.length > 0) {
            Logger.log(`[MOSAIC WM] Excluding ${sacredWindows.length} SACRED windows: ${sacredWindows.map(w => w.get_id()).join(', ')}`);
            meta_windows = meta_windows.filter(w => !isSacredWindow(w));
            windows = windows.filter((_, idx) => !isSacredWindow(working_info.meta_windows[idx]));
        }
        
        // If no windows left to tile, return early
        if (meta_windows.length === 0) {
            Logger.log(`[MOSAIC WM] No windows left to tile after filtering sacred windows. Original count: ${working_info.meta_windows.length}`);
            return { overflow: false, layout: null };
        }
        
        const tileArea = this.isDragging && this.dragRemainingSpace ? this.dragRemainingSpace : work_area;
        
        let tile_info = this._tile(windows, tileArea);
        let overflow = tile_info.overflow;
        
        if (workspace_windows.length <= 1) {
            overflow = false;
        } else {
            for(let window of workspace_windows)
                if(this._windowingManager.isMaximizedOrFullscreen(window))
                    overflow = true;
        }
        
        // DRY RUN: If dryRun flag is set, return overflow without moving anything
        if (arguments[5] === true) {
            return { overflow, layout: this._cachedTileResult?.windows || null };
        }

        // Block expulsion if edge-tiled (except non-edge ref); defer if dragging.
        const hasEdgeTiledWindows = edgeTiledWindows && edgeTiledWindows.length > 0;
        const referenceIsEdgeTiled = reference_meta_window && 
            edgeTiledWindows?.some(s => s.window.get_id() === reference_meta_window.get_id());
        const canOverflow = !hasEdgeTiledWindows || !referenceIsEdgeTiled;
        
        if(overflow && !keep_oversized_windows && reference_meta_window && canOverflow && !this.isDragging) {
            // SAFETY: Only overflow windows that are genuinely new (added within last 2 seconds)
            // This prevents incorrectly expelling existing windows during resize retiling
            const addedTime = WindowState.get(reference_meta_window, 'addedTime');
            const isNewlyAdded = addedTime && (Date.now() - addedTime) < 2000;
            
            if (!isNewlyAdded && !WindowState.get(reference_meta_window, 'forceOverflow') && !WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                Logger.log(`[MOSAIC WM] Skipping overflow for ${reference_meta_window.get_id()} - not a new window`);
            } else if (WindowState.get(reference_meta_window, 'isSmartResizing') || WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                Logger.log(`[MOSAIC WM] Skipping overflow for ${reference_meta_window.get_id()} - smart resize/sacred restore in progress`);
                
                // FORCE RESIZE ATTEMPT IF NEEDED
                // If it's a sacred return, we MUST try to fit it, even if it means squishing everyone.
                if (WindowState.get(reference_meta_window, 'isRestoringSacred')) {
                     const workArea = this._getWorkArea(workspace, monitor);
                     const existingWindows = windows.filter(w => w.id !== reference_meta_window.get_id()).map(w => w.window); // Need MetaWindows
                     // We need actual MetaWindows for tryFit, but 'windows' here are descriptors.
                     // Re-fetch real windows.
                     const realExisting = this._windowingManager.getMonitorWorkspaceWindows(workspace, monitor)
                                          .filter(w => w.get_id() !== reference_meta_window.get_id() && !this._windowingManager.isExcluded(w));
                                          
                     // Only try resize if we haven't already (to avoid loops)
                     if (!WindowState.get(reference_meta_window, 'isSmartResizing')) {
                         Logger.log(`[MOSAIC WM] Triggering Smart Resize for returning sacred window`);
                         if (this.tryFitWithResize(reference_meta_window, realExisting, workArea)) {
                             Logger.log(`[MOSAIC WM] Sacred window fitted with resize!`);
                             return { overflow: false, layout: null }; // Return early to let resize happen
                         }
                     }
                }
            } else {
                let id = reference_meta_window.get_id();
                let _windows = windows;
                for(let i = 0; i < _windows.length; i++) {
                    if(meta_windows[_windows[i].index].get_id() === id) {
                        _windows.splice(i, 1);
                        break;
                    }
                }
                this._windowingManager.moveOversizedWindow(reference_meta_window);
                tile_info = this._tile(_windows, tileArea);
            }
        }
        
        Logger.log(`[MOSAIC WM] Drawing tiles - isDragging: ${this.isDragging}, using tileArea: x=${tileArea.x}, y=${tileArea.y}`);
        
        // ANIMATIONS
        let animationsHandledPositioning = false;
        if (!this.isDragging && tile_info && tile_info.levels && tile_info.levels.length > 0) {
            let draggedWindow = reference_meta_window;
            
            // Allow animation for windows returning from excluded state
            // Allow animation for windows returning from excluded state
            if (reference_meta_window && WindowState.get(reference_meta_window, 'justReturnedFromExclusion')) {
                Logger.log(`[MOSAIC WM] Allowing animation for returning excluded window ${reference_meta_window.get_id()}`);
                WindowState.remove(reference_meta_window, 'justReturnedFromExclusion');
            }
            
            animationsHandledPositioning = this._animateTileLayout(workspace, tile_info, tileArea, meta_windows, draggedWindow);
        }
        
        if (!animationsHandledPositioning) {
            // Only call drawTile if animations didn't handle positioning
            Logger.log(`[MOSAIC WM] Animations did not handle positioning, calling drawTile`);
            this._drawTile(tile_info, tileArea, meta_windows);
        } else {
            Logger.log(`[MOSAIC WM] Animations handled positioning, skipping drawTile`);
        }
        
        const result = { overflow, layout: this._cachedTileResult?.windows || null };
        this.emit('mosaic-changed', workspace);
        
        // PHASE 4: Save preferred size only after success (final-only)
        // Apenas se NOT em overflow e tiling foi bem-sucedido
        if (!overflow && !this.isDragging && meta_windows &&  meta_windows.length > 0) {
            Logger.log(`[SMART RESIZE] Saving preferred size for ${meta_windows.length} windows after successful tiling`);
            
            // Windows that were constrained by mosaic (smart resize applied)
            const windowsShrunk = meta_windows.filter(w => WindowState.get(w, 'isConstrainedByMosaic'));
            
            if (windowsShrunk.length > 0) {
                Logger.log(`[SMART RESIZE] Found ${windowsShrunk.length} constrained windows - saving preferred size`);
                
                for (const window of windowsShrunk) {
                    // CRITICAL: Do NOT override preferredSize if already set by smart resize
                    // commitResizes() already set it with ORIGINAL size, don't override here
                    const hasOriginalPreferred = WindowState.get(window, 'originalSize');
                    if (hasOriginalPreferred) {
                        Logger.log(`[SMART RESIZE] Skipping preferred size save for ${window.get_id()} - already set by smart resize`);
                        continue;
                    }
                    
                    const currentFrame = window.get_frame_rect();
                    WindowState.set(window, 'preferredSize', { 
                        width: currentFrame.width, 
                        height: currentFrame.height 
                    });
                    Logger.log(`[SMART RESIZE] Preferred size saved: ${window.get_id()} = ${currentFrame.width}x${currentFrame.height}`);
                }
            }
            
            // Reference window (new window that was added)
            if (reference_meta_window) {
                const refId = reference_meta_window.get_id();
                
                // If smart resize was applied to it, preferred size is already at final reduced size
                if (WindowState.get(reference_meta_window, 'isSmartResizing')) {
                    const finalFrame = reference_meta_window.get_frame_rect();
                    WindowState.set(reference_meta_window, 'preferredSize', { 
                        width: finalFrame.width, 
                        height: finalFrame.height 
                    });
                    Logger.log(`[SMART RESIZE] New window preferred (after smart resize): ${refId} = ${finalFrame.width}x${finalFrame.height}`);
                } else if (!WindowState.get(reference_meta_window, 'preferredSize')) {
                    // Smart resize was not applied - save opening size as preferred
                    const openingSize = WindowState.get(reference_meta_window, 'openingSize') || reference_meta_window.get_frame_rect();
                    WindowState.set(reference_meta_window, 'preferredSize', openingSize);
                    Logger.log(`[SMART RESIZE] New window preferred (opening size): ${refId} = ${openingSize.width}x${openingSize.height}`);
                }
            }
        }
        
        return result;
    }

    canFitWindow(window, workspace, monitor, relaxed = false, overrideSize = null) {
        Logger.log(`[MOSAIC WM] canFitWindow: Checking if window can fit in workspace ${workspace.index()} (relaxed=${relaxed})`);
        
        // Excluded windows (Always on Top, Sticky) always "fit" - they don't participate in tiling
        // This allows them to coexist with fullscreen/maximized windows
        if (this._windowingManager.isExcluded(window)) {
            Logger.log('[MOSAIC WM] canFitWindow: Window is excluded - always fits (not tiled)');
            return true;
        }
        
        if (window.is_fullscreen()) {
            Logger.log('[MOSAIC WM] canFitWindow: Window is fullscreen - always fits (no overflow)');
            return true;
        }

        
        const working_info = this._getWorkingInfo(workspace, window, monitor);
        if (!working_info) {
            Logger.log('[MOSAIC WM] canFitWindow: No working info - cannot fit');
            return false;
        }

        for (const existing_window of working_info.meta_windows) {
            if(this._windowingManager.isMaximizedOrFullscreen(existing_window)) {
                Logger.log('[MOSAIC WM] canFitWindow: Workspace has maximized window - cannot fit');
                return false;
            }
        }

        let edgeTiledWindows = [];
        if (this._edgeTilingManager) {
            edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
        }
        
        let availableSpace = working_info.work_area;
        const newWindowId = window.get_id();

        
        if (edgeTiledWindows.length > 0) {
            const otherEdgeTiles = edgeTiledWindows.filter(w => w.window.get_id() !== window.get_id());
            const zones = otherEdgeTiles.map(w => w.zone);
            const hasRightFull = zones.includes(TileZone.RIGHT_FULL);
            const hasLeftQuarters = zones.some(z => z === TileZone.TOP_LEFT || z === TileZone.BOTTOM_LEFT);
            const hasRightQuarters = zones.some(z => z === TileZone.TOP_RIGHT || z === TileZone.BOTTOM_RIGHT);
            
            if ((hasLeftFull || hasLeftQuarters) && (hasRightFull || hasRightQuarters)) {
                Logger.log('[MOSAIC WM] canFitWindow: Workspace fully occupied by edge tiles - cannot fit');
                return false;
            }
            
            availableSpace = this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            Logger.log(`[MOSAIC WM] canFitWindow: Using remaining space after snap: ${availableSpace.width}x${availableSpace.height}`);
        }

        const edgeTiledIds = edgeTiledWindows.map(s => s.window.get_id());
        
        let windows = working_info.windows.filter(w => 
            !edgeTiledIds.includes(w.id)
        );
        
        // CRITICAL: Use same dimension priority as WindowDescriptor for consistency
        // with tileWorkspaceWindows. Priority: targetRestoredSize → targetSmartResizeSize → frame_rect
        const workspaceWindows = workspace.list_windows();
        
        for (const w of windows) {
            const realWindow = workspaceWindows.find(win => win.get_id() === w.id);
            if (realWindow) {
                const restoredSize = WindowState.get(realWindow, 'targetRestoredSize');
                const smartResizeSize = WindowState.get(realWindow, 'targetSmartResizeSize');
                
                if (restoredSize) {
                    w.width = restoredSize.width;
                    w.height = restoredSize.height;
                } else if (smartResizeSize) {
                    w.width = smartResizeSize.width;
                    w.height = smartResizeSize.height;
                } else {
                    const realFrame = realWindow.get_frame_rect();
                    w.width = realFrame.width;
                    w.height = realFrame.height;
                }
            }
        }
        
        const windowAlreadyInWorkspace = windows.some(w => w.id === newWindowId);
        
        if (!windowAlreadyInWorkspace) {
            let realWidth, realHeight;
            
            if (overrideSize) {
                realWidth = overrideSize.width;
                realHeight = overrideSize.height;
                Logger.log(`[MOSAIC WM] canFitWindow: Using overrideSize ${realWidth}x${realHeight}`);
            } else {
                const preferredSize = WindowState.get(window, 'preferredSize') || WindowState.get(window, 'openingSize');
                const frame = window.get_frame_rect();
                
                // Use actual frame dimensions — no hardcoded fallback
                realWidth = preferredSize ? preferredSize.width : frame.width;
                realHeight = preferredSize ? preferredSize.height : frame.height;
            }
            
            Logger.log(`[MOSAIC WM] canFitWindow: Window not in workspace - adding with size ${realWidth}x${realHeight} (preferred=${!!overrideSize || !!WindowState.get(window, 'preferredSize')})`);
            
            const newWindowDescriptor = new WindowDescriptor(window, windows.length);
            newWindowDescriptor.width = realWidth;
            newWindowDescriptor.height = realHeight;
            
            windows.push(newWindowDescriptor);
        }
        
        if (windowAlreadyInWorkspace) {
            Logger.log(`[MOSAIC WM] canFitWindow: Window already in workspace - checking current layout`);
            // Update descriptor size to match reality or override
            const existingDescriptor = windows.find(w => w.id === newWindowId);
            if (existingDescriptor) {
                 if (overrideSize) {
                     existingDescriptor.width = overrideSize.width;
                     existingDescriptor.height = overrideSize.height;
                 } else {
                     // Ensure we use the best available size info
                     const preferred = WindowState.get(window, 'preferredSize');
                     const isMaximized = window.maximized_horizontally && window.maximized_vertically;
                     if (preferred && !window.is_fullscreen() && !isMaximized) {
                         existingDescriptor.width = preferred.width;
                         existingDescriptor.height = preferred.height;
                     }
                 }
            }
        }
        
        // Temporarily add new descriptor if it wasn't there (for simulation)
        // ... (existing logic handles this via windows array)
        
        // Try to tile with these windows
        const layout = this._tile(windows, availableSpace, relaxed);
        return !layout.overflow;
    }

    // Restore a window's size to its preferred/original dimensions
    restorePreferredSize(window) {
        if (!window) return;
        
        const preferredSize = WindowState.get(window, 'preferredSize') || 
                              WindowState.get(window, 'openingSize') ||
                              WindowState.get(window, 'learnedMinSize');
                              
        if (preferredSize) {
            Logger.log(`[MOSAIC WM] restorePreferredSize: Restoring window ${window.get_id()} to ${preferredSize.width}x${preferredSize.height}`);
            const frame = window.get_frame_rect();
            window.move_resize_frame(false, frame.x, frame.y, preferredSize.width, preferredSize.height);
            
            // Clear constraint flags
            WindowState.set(window, 'isConstrainedByMosaic', false);
            WindowState.set(window, 'isSmartResizing', false);
            WindowState.set(window, 'targetSmartResizeSize', null);
        } else {
            Logger.log(`[MOSAIC WM] restorePreferredSize: No preferred size found for ${window.get_id()}`);
        }
    }

     // Save original size of a window before resizing
    saveOriginalSize(window) {
        if (!WindowState.has(window, 'originalSize')) {
            const frame = window.get_frame_rect();
            WindowState.set(window, 'originalSize', { width: frame.width, height: frame.height });
            Logger.log(`[MOSAIC WM] saveOriginalSize: Saved ${window.get_id()} as ${frame.width}x${frame.height}`);
        }
    }

    // Save the preferred size of a window (called once when window first appears or user manually resizes)
    // This is the TARGET size the window wants to be
     
    savePreferredSize(window) {
        // CRITICAL: If window is in smart resize, do NOT override preferredSize
        // Smart resize will set preferredSize correctly in commitResizes()
        if (WindowState.get(window, 'isSmartResizing')) {
            Logger.log(`[MOSAIC WM] savePreferredSize: Skipping for ${window.get_id()} - during smart resize`);
            return;
        }

        // CRITICAL: If window was resized by smart resize, do NOT override preferredSize
        // O preferredSize foi setado em commitResizes() com o tamanho ORIGINAL
        // Overriding here would destroy the restoration capability later
        if (WindowState.get(window, 'isConstrainedByMosaic')) {
            Logger.log(`[MOSAIC WM] savePreferredSize: Skipping for ${window.get_id()} - already constrained by smart resize`);
            return;
        }

        let size = null;
        
        // Use frame rect if window is NOT maximized/fullscreen
        if (!this._windowingManager.isMaximizedOrFullscreen(window)) {
            const frame = window.get_frame_rect();
            size = { width: frame.width, height: frame.height };
        } else {
            // If currently maximized/fullscreen, we attempt to get the underlying "saved" size
            // provided by Mutter. This is the size the window will return to.
            try {
                const saved = window.get_saved_rect();
                if (saved && saved.width > 0 && saved.height > 0) {
                    size = { width: saved.width, height: saved.height };
                    Logger.log(`[MOSAIC WM] savePreferredSize: Captured saved_rect ${size.width}x${size.height} for sacred window ${window.get_id()}`);
                }
            } catch (e) {
                Logger.warn(`[MOSAIC WM] savePreferredSize: Failed to get_saved_rect: ${e.message}`);
            }
        }
                               
        if (size && size.width > 0 && size.height > 0) {
            // Signal-Based Lock: If onSizeChange just flagged this window as entering a sacred state,
            // we do NOT save the size, as it's almost certainly the giant transition frame.
            if (WindowState.get(window, 'isEnteringSacred')) {
                Logger.log(`[MOSAIC WM] savePreferredSize: Save blocked by sacred transition flag for ${window.get_id()}`);
                return;
            }

            WindowState.set(window, 'preferredSize', size);
            Logger.log(`[MOSAIC WM] savePreferredSize: Window ${window.get_id()} target size updated to ${size.width}x${size.height}`);
        } else {
            Logger.log(`[MOSAIC WM] savePreferredSize: Could not determine valid preferred size for ${window.get_id()}`);
        }
    }
    
    // Clear preferred size when window is destroyed
     
    clearPreferredSize(window) {
        if (WindowState.has(window, 'preferredSize')) {
            WindowState.remove(window, 'preferredSize');
            Logger.log(`[MOSAIC WM] clearPreferredSize: Removed ${window.get_id()}`);
        }
    }

    getPreferredSize(window) {
        return WindowState.get(window, 'preferredSize') || null;
    }

    tryRestoreWindowSizes(windows, workArea, freedWidth, freedHeight, workspace, monitor) {
        
        // Find windows that were shrunk (current size < preferred size)
        const shrunkWindows = [];
        for (const window of windows) {
            const preferredSize = WindowState.get(window, 'preferredSize');
            if (!preferredSize) continue;
            
            const frame = window.get_frame_rect();
            const widthDiff = preferredSize.width - frame.width;
            const heightDiff = preferredSize.height - frame.height;
            
            // Window was shrunk if it's smaller than opening size
            if (widthDiff > 10 || heightDiff > 10) {
                shrunkWindows.push({
                    window,
                    currentWidth: frame.width,
                    currentHeight: frame.height,
                    openingWidth: preferredSize.width,
                    openingHeight: preferredSize.height,
                    widthDeficit: Math.max(0, widthDiff),
                    heightDeficit: Math.max(0, heightDiff)
                });
            }
        }
        
        if (shrunkWindows.length === 0) {
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: No shrunk windows to restore`);
            return false;
        }
        
        Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Found ${shrunkWindows.length} shrunk windows`);
        
        // Determine orientation (use width for landscape, height for portrait)
        const isLandscape = workArea.width > workArea.height;
        
        // Check if we have valid freed dimensions, otherwise calculate them
        if (freedWidth === undefined || freedHeight === undefined || isNaN(freedWidth) || isNaN(freedHeight)) {
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Freed dimensions undefined/NaN - calculating from work area`);
            
            // Calculate currently used space by remaining windows
            let usedWidth = 0;
            let usedHeight = 0;
            
            if (windows.length > 0) {
                 // Calculate bbox of used space
                 let minX = Infinity;
                 let maxX = -Infinity;
                 let minY = Infinity;
                 let maxY = -Infinity;
                 for (const w of windows) {
                     const f = w.get_frame_rect();
                     minX = Math.min(minX, f.x);
                     maxX = Math.max(maxX, f.x + f.width);
                     minY = Math.min(minY, f.y);
                     maxY = Math.max(maxY, f.y + f.height);
                 }
                 usedWidth = (maxX - minX) > 0 ? (maxX - minX) : 0;
                 usedHeight = (maxY - minY) > 0 ? (maxY - minY) : 0;
            }
            
            // Add spacing for gaps between windows
            const spacing = (Math.max(0, windows.length - 1)) * constants.WINDOW_SPACING;
            
            // Available space in each dimension
            freedWidth = Math.max(0, workArea.width - usedWidth - spacing);
            freedHeight = Math.max(0, workArea.height - usedHeight - spacing);
            
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Calculated incremental available space: ${freedWidth}x${freedHeight}`);
        } else {
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: ${freedWidth}px width and ${freedHeight}px height freed`);
        }

        // Calculate total deficits for both dimensions
        const totalWidthDeficit = shrunkWindows.reduce((sum, w) => sum + w.widthDeficit, 0);
        const totalHeightDeficit = shrunkWindows.reduce((sum, w) => sum + w.heightDeficit, 0);
        
        if (totalWidthDeficit <= 0 && totalHeightDeficit <= 0) {
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: No deficit to fill`);
            return false;
        }
        
        // --- SIMULATION-BASED RECOVERY (2D) ---
        // We try to restore both dimensions proportional to available freed space
        
        const gainFactorW = totalWidthDeficit > 0 ? Math.min(1.0, freedWidth / totalWidthDeficit) : 1.0;
        const gainFactorH = totalHeightDeficit > 0 ? Math.min(1.0, freedHeight / totalHeightDeficit) : 1.0;
        
        Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Factors: W=${gainFactorW.toFixed(2)}, H=${gainFactorH.toFixed(2)}`);

        // Simulating the new state if we applied the gain
        const simulatedWindows = windows.map(w => {
            const shrunk = shrunkWindows.find(sw => sw.window.get_id() === w.get_id());
            if (!shrunk) {
                const f = w.get_frame_rect();
                return { id: w.get_id(), width: f.width, height: f.height };
            }
            
            const f = w.get_frame_rect();
            const nw = Math.floor(f.width + (shrunk.widthDeficit * gainFactorW));
            const nh = Math.floor(f.height + (shrunk.heightDeficit * gainFactorH));
            
            return {
                id: w.get_id(),
                width: Math.min(nw, shrunk.openingWidth),
                height: Math.min(nh, shrunk.openingHeight)
            };
        });

        // Re-verify fit with direct simulation — no artificial padding
        const tile_result = this._tile(simulatedWindows, workArea, true);
        
        if (!tile_result.overflow) {
            // It fits! Apply the restoration.
            Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Restoration possible`);
            
            for (const sim of simulatedWindows) {
                const w = windows.find(win => win.get_id() === sim.id);
                if (w) {
                    // Set flag so extension skip re-tiling while we are pushing sizes
                    WindowState.set(w, 'isReverseSmartResizing', true);
                    
                    // Direct resize without animation for now to ensure stability
                    w.move_resize_frame(false, w.get_frame_rect().x, w.get_frame_rect().y, sim.width, sim.height);
                    
                    // Update our internal state
                    const shrunkIndex = shrunkWindows.findIndex(sw => sw.window.get_id() === w.get_id());
                    if (shrunkIndex !== -1) {
                         const shrunk = shrunkWindows[shrunkIndex];
                         // If fully restored (allow for small pixel rounding errors), remove constraint
                         if (sim.width >= shrunk.openingWidth - 2 && sim.height >= shrunk.openingHeight - 2) {
                             WindowState.set(w, 'isConstrainedByMosaic', false);
                             WindowState.set(w, 'targetSmartResizeSize', null);
                         }
                    }
                }
            }
            return true;
        } else {
             Logger.log(`[MOSAIC WM] tryRestoreWindowSizes: Restoration would cause overflow - waiting for more space`);
             
             // Ensure flags are cleared if we failed
             for (const w of windows) {
                 WindowState.remove(w, 'isReverseSmartResizing');
             }
             return false;
        }
    }
     // Calculate window area as ratio of workspace area
     
    getWindowAreaRatio(frame, workArea) {
        const windowArea = frame.width * frame.height;
        const workspaceArea = workArea.width * workArea.height;
        return windowArea / workspaceArea;
    }

     // Helper to get usable work area considering edge tiles
     
    getUsableWorkArea(workspace, monitor) {
        if (this._edgeTilingManager) {
            const edgeTiledWindows = this._edgeTilingManager.getEdgeTiledWindows(workspace, monitor);
            if (edgeTiledWindows.length > 0) {
                // If the workspace is fully occupied (left + right), return zero/empty rect
                const zones = edgeTiledWindows.map(w => w.zone);
                const hasLeft = zones.some(z => [TileZone.LEFT_FULL, TileZone.TOP_LEFT, TileZone.BOTTOM_LEFT].includes(z));
                const hasRight = zones.some(z => [TileZone.RIGHT_FULL, TileZone.TOP_RIGHT, TileZone.BOTTOM_RIGHT].includes(z));
                
                if (hasLeft && hasRight) {
                    return { x: 0, y: 0, width: 0, height: 0 };
                }
                
                return this._edgeTilingManager.calculateRemainingSpace(workspace, monitor);
            }
        }
        return workspace.get_work_area_for_monitor(monitor);
    }

    // Calculate layouts without moving windows (for Overview)
    calculateLayoutsOnly(targetWorkspace = null, targetMonitor = null) {
        const workspace = targetWorkspace || global.workspace_manager.get_active_workspace();
        
        // Handle monitor index or object
        let monitorIndex = 0;
        if (targetMonitor !== null && targetMonitor !== undefined) {
             monitorIndex = typeof targetMonitor === 'number' ? targetMonitor : targetMonitor.index;
        } else {
             monitorIndex = global.display.get_focus_window()?.get_monitor() || 0;
        }
        
        // Pass excludeFromTiling=false to ensure we consider the new window
        let working_info = this._getWorkingInfo(workspace, null, monitorIndex, false);
        if(!working_info) return;

        let meta_windows = working_info.meta_windows;
        let windows = working_info.windows;
        let work_area = working_info.work_area;

        // Populate ComputedLayouts cache without moving windows (dryRun=true)
        // Must perform the tiling calculation first
        let tile_info = this._tile(windows, work_area);
        
        // Then run the draw phase in dryRun mode to just populate the cache
        this._drawTile(tile_info, work_area, meta_windows, true);
    }

     // Try to fit a new window by democratically resizing ALL resizable windows
     
    async tryFitWithResize(newWindow, existingWindows, workArea, overrideSize = null) {
        const newFrame = overrideSize || newWindow.get_frame_rect();
        const allWindows = [...existingWindows, newWindow];
        
        // Serialize smart resize operations via Promise queue
        return this._smartResizeQueue = this._smartResizeQueue.then(async () => {
            // Block overflow decisions while smart resize runs
            this._isSmartResizingBlocked = true;
            
            try {
                Logger.log(`[SMART RESIZE] tryFitWithResize START: ${allWindows.length} total windows (${existingWindows.length} existing + 1 new)`);
            
            // 0. Quick check: does it fit naturally?
            const naturalSims = allWindows.map(w => {
                const isNew = w.get_id() === newWindow.get_id();
                const frame = isNew ? newFrame : w.get_frame_rect();
                return { id: w.get_id(), width: frame.width, height: frame.height };
            });
            
            const naturalResult = this._tile(naturalSims, workArea, true);
            if (!naturalResult.overflow) {
                Logger.log(`[SMART RESIZE] Natural fit without resize - success`);
                return true;
            }
            
            Logger.log(`[SMART RESIZE] Natural fit failed - starting iterative smart resize`);
            
            // 1. Criar iterator
            const iterator = new SmartResizeIterator(existingWindows, newWindow, workArea, this);
            
            // 2. Early exit: if there are no resizable windows, no point trying
            if (iterator.resizableWindows.length === 0) {
                Logger.log(`[SMART RESIZE] No resizable windows - smart resize not possible`);
                return false;
            }
            
            // 3. Iterative loop until convergence
            while (true) {
                const result = await iterator.executeIteration();
                
                if (result.success) {
                    // ✅ SUCCESS: Todas as janelas couberam!
                    Logger.log(`[SMART RESIZE] ✓ SUCCESS at iteration ${iterator.iteration}`);
                    iterator.commitResizes();
                    
                    // Limpar flag de smart resizing ANTES de retornar
                    for (const window of existingWindows) {
                        WindowState.set(window, 'smartResizing', false);
                    }
                    return true;
                }
                
                if (!result.shouldRetry) {
                    // ❌ OVERFLOW final: Cannot fit even with all windows at minimum
                    Logger.log(`[SMART RESIZE] ✗ OVERFLOW: Cannot fit even at minimum - applying reverse resize`);
                    await iterator.revertAll();
                    
                    // Wait for Mutter to apply reverts (event-driven with timeout)
                    // Skip wait on early escape (window manager is slow anyway)
                    if (!result.earlyEscape) {
                        Logger.log(`[SMART RESIZE] Waiting for revert to apply...`);
                        await iterator._waitForSizeChanges(existingWindows, 500);
                    } else {
                        Logger.log(`[SMART RESIZE] Early escape: skipping revert wait, proceeding with overflow`);
                    }
                    
                    return false;
                }
                
                // Continue to next iteration (fast fixed wait - not event-driven)
                // Skip debounce on early escape to speed up overflow transition
                if (result.earlyEscape) {
                    Logger.log(`[SMART RESIZE] Early escape: skipping debounce, proceeding immediately to overflow`);
                } else {
                    Logger.log(`[SMART RESIZE] Waiting ${constants.SMART_RESIZE_ITERATION_DEBOUNCE_MS}ms before next iteration`);
                    await iterator._waitMs(constants.SMART_RESIZE_ITERATION_DEBOUNCE_MS);
                }
            }
            } finally {
                this._isSmartResizingBlocked = false;
                Logger.log(`[SMART RESIZE] tryFitWithResize finished - unblocked overflow`);
            }
        });
    }

    destroy() {
        this.destroyMasks();
        this._edgeTilingManager = null;
        this._drawingManager = null;
        this._animationsManager = null;
        this._windowingManager = null;
    }
});

class WindowDescriptor {
    constructor(meta_window, index) {
        let frame = meta_window.get_frame_rect();

        this.index = index;
        this.x = frame.x;
        this.y = frame.y;
        this.metaWindow = meta_window;
        
        // Use target dimensions if unmaximizing, as physical frame might still be maximized.
        const targetSize = WindowState.get(meta_window, 'targetRestoredSize');
        // Use smart resize target dims if move_resize_frame hasn't completed yet.
        const smartResizeSize = WindowState.get(meta_window, 'targetSmartResizeSize');
        
        if (targetSize) {
            this.width = targetSize.width;
            this.height = targetSize.height;
            Logger.log(`[MOSAIC WM] WindowDescriptor: Using targetRestoredSize ${this.width}x${this.height} for ${meta_window.get_id()}`);
        } else if (smartResizeSize) {
            this.width = smartResizeSize.width;
            this.height = smartResizeSize.height;
            Logger.log(`[MOSAIC WM] WindowDescriptor: Using targetSmartResizeSize ${this.width}x${this.height} for ${meta_window.get_id()}`);
        } else {
            // Use actual frame dimensions — no hardcoded fallback
            this.width = frame.width > 0 ? frame.width : 1;
            this.height = frame.height > 0 ? frame.height : 1;
        }
        
        this.id = meta_window.get_id();
    }
    
    draw(meta_windows, x, y, masks, isDragging, drawingManager, dryRun = false) {
    const window = meta_windows.find(w => w.get_id() === this.id);
    if (window) {
        // If dry run, just return - the layout cache was already updated in the caller
        if (dryRun) return;

        const isMask = masks[this.id];
        
        if (isDragging) {
            if (isMask) {
                // This is the dragged window - draw preview at its target position
                if (drawingManager) {
                    drawingManager.rect(x, y, this.width, this.height);
                }
            } else {
                // This is NOT the dragged window - reposition it
                const currentRect = window.get_frame_rect();
                const positionChanged = Math.abs(currentRect.x - x) > 5 || Math.abs(currentRect.y - y) > 5;
                const sizeChanged = Math.abs(currentRect.width - this.width) > 5 || Math.abs(currentRect.height - this.height) > 5;
                
                Logger.log(`[MOSAIC WM] draw (drag): id=${this.id}, target=(${x},${y}), current=(${currentRect.x},${currentRect.y}), posChanged=${positionChanged}`);
                
                if (positionChanged || sizeChanged) {
                    WindowState.set(window, 'isConstrainedByMosaic', true);
                    window.move_resize_frame(false, x, y, this.width, this.height);
                    const windowActor = window.get_compositor_private();
                    if (windowActor) {
                        const translateX = currentRect.x - x;
                        const translateY = currentRect.y - y;
                        windowActor.set_translation(translateX, translateY, 0);
                        windowActor.ease({
                            translation_x: 0,
                            translation_y: 0,
                            opacity: 255,
                            duration: constants.ANIMATION_DURATION_MS,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD
                        });
                    }
                }
            }
        } else {
            WindowState.set(window, 'isConstrainedByMosaic', true);
            window.move_resize_frame(false, x, y, this.width, this.height);
        }
    } else {
        Logger.warn(`[MOSAIC WM] Could not find window with ID ${this.id} for drawing`);
    }
}
}

function Level(work_area) {
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.windows = [];
    this.work_area = work_area;
}

Level.prototype.draw_horizontal = function(meta_windows, work_area, y, masks, isDragging, drawingManager, dryRun = false) {
    let x = this.x;
    for(let window of this.windows) {
        let center_offset = (work_area.height / 2 + work_area.y) - (y + window.height / 2);
        let y_offset = 0;
        if(center_offset > 0)
            y_offset = Math.min(center_offset, this.height - window.height);
            
        // Use targetX/targetY if set (for center-gravity alignment), otherwise use calculated position
        const drawX = window.targetX !== undefined ? window.targetX : x;
        const drawY = window.targetY !== undefined ? window.targetY : y + y_offset;
        
        if (!dryRun)
            Logger.log(`[MOSAIC WM] Window ${window.id} target: ${drawX},${drawY} (${window.width}x${window.height})`);
        
        if (window.metaWindow) {
            ComputedLayouts.set(window.metaWindow, { x: drawX, y: drawY, width: window.width, height: window.height });
        }

        window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
        x += window.width + constants.WINDOW_SPACING;
    }
}

Level.prototype.draw_vertical = function(meta_windows, x, masks, isDragging, drawingManager, dryRun = false) {
    let y = this.y;
    for(let window of this.windows) {
        // Use targetX/targetY if set (for center-gravity alignment), otherwise use calculated position
        const drawX = window.targetX !== undefined ? window.targetX : x;
        const drawY = window.targetY !== undefined ? window.targetY : y;
        
        if (!dryRun)
            Logger.log(`[MOSAIC WM] Window ${window.id} target: ${drawX},${drawY} (${window.width}x${window.height})`);
        
        if (window.metaWindow) {
            ComputedLayouts.set(window.metaWindow, { x: drawX, y: drawY, width: window.width, height: window.height });
        }
        
        window.draw(meta_windows, drawX, drawY, masks, isDragging, drawingManager, dryRun);
        y += window.height + constants.WINDOW_SPACING;
    }
}

class Mask {
    constructor(window) {
        // window can be a MetaWindow or a WindowDescriptor
        this.id = window.id !== undefined ? `mask_${window.id}` : `mask_${window.get_id()}`;
        this.x = window.x;
        this.y = window.y;
        this.width = window.width;
        this.height = window.height;
    }
    draw(_, x, y, _masks, _isDragging, drawingManager) {
        if (drawingManager) {
            // DO NOT call removeBoxes here - it's called once in destroyMasks() at start of tiling
            drawingManager.rect(x, y, this.width, this.height);
        }
    }
}
