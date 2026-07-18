/**
 * @fileoverview BasePlugin — Abstract base class for all analytical modules.
 *
 * Every plugin must extend this class. The constructor automatically subscribes
 * to the EventBus 'frame' channel and routes data to the abstract `onFrame` method.
 *
 * Usage:
 *   class MyPlugin extends BasePlugin {
 *     onFrame(landmarks, timestamp) { ... }
 *   }
 *   const plugin = new MyPlugin(bus);
 *   plugin.destroy(); // clean up when done
 */

import { EVENTS } from '../core/EventBus.js';

export class BasePlugin {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {string} [name] Optional display name for debug logging
   */
  constructor(bus, name = 'BasePlugin') {
    if (new.target === BasePlugin) {
      throw new Error('BasePlugin is abstract — extend it, do not instantiate directly.');
    }

    /** @type {import('../core/EventBus.js').EventBus} */
    this.bus = bus;

    /** @type {string} */
    this.name = name;

    /** @type {boolean} Whether this plugin is currently active */
    this.enabled = true;

    /** @private Bound handler stored so we can remove it later */
    this._frameHandler = (payload) => {
      if (!this.enabled) return;
      try {
        this.onFrame(payload.landmarks, payload.timestamp, payload.worldLandmarks);
      } catch (err) {
        console.error(`[${this.name}] Error in onFrame:`, err);
      }
    };

    /** @private Bound reset handler */
    this._resetHandler = () => {
      try {
        this.onReset();
      } catch (err) {
        console.error(`[${this.name}] Error in onReset:`, err);
      }
    };

    // Auto-subscribe to the frame pipeline
    this.bus.on(EVENTS.FRAME, this._frameHandler);
    this.bus.on(EVENTS.SESSION_RESET, this._resetHandler);

    console.debug(`[${this.name}] Plugin registered.`);
  }

  // ── Abstract Methods (must be overridden by subclasses) ─────────────────

  /**
   * Called every frame with the current pose landmarks.
   * Override this in your subclass — this is your main entry point.
   *
   * @abstract
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   *   Normalized 33-point landmark array from MediaPipe Pose Landmarker.
   *   Indices follow the MediaPipe BlazePose topology.
   * @param {number} timestamp  Performance.now() timestamp of the frame (ms)
   * @param {import('../core/VectorMath.js').Landmark[]} [worldLandmarks]
   *   Optional world-space landmarks in meters, centered at the hip.
   */
  // eslint-disable-next-line no-unused-vars
  onFrame(landmarks, timestamp, worldLandmarks) {
    throw new Error(`[${this.name}] onFrame() must be implemented by subclass.`);
  }

  /**
   * Called when the session is reset. Override to clear plugin state.
   * @abstract (optional)
   */
  onReset() {
    // Default: no-op. Subclasses can override.
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Temporarily disable this plugin (frames are skipped).
   */
  disable() {
    this.enabled = false;
    console.debug(`[${this.name}] Plugin disabled.`);
  }

  /**
   * Re-enable this plugin.
   */
  enable() {
    this.enabled = true;
    console.debug(`[${this.name}] Plugin enabled.`);
  }

  /**
   * Permanently destroy this plugin and clean up all EventBus subscriptions.
   * Call this when the plugin is no longer needed.
   */
  destroy() {
    this.bus.off(EVENTS.FRAME, this._frameHandler);
    this.bus.off(EVENTS.SESSION_RESET, this._resetHandler);
    this.enabled = false;
    console.debug(`[${this.name}] Plugin destroyed.`);
  }

  // ── Utility: Landmark visibility guard ─────────────────────────────────

  /**
   * Check if all required landmark indices are sufficiently visible.
   * Use this at the top of onFrame() to skip unreliable frames.
   *
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   * @param {number[]} indices Landmark indices to check
   * @param {number} [minVisibility=0.5] Minimum visibility score [0..1]
   * @returns {boolean}
   */
  areLandmarksVisible(landmarks, indices, minVisibility = 0.5) {
    return indices.every((i) => {
      const lm = landmarks[i];
      return lm && (lm.visibility ?? 1) >= minVisibility;
    });
  }
}
