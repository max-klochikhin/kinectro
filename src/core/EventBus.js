/**
 * @fileoverview EventBus — Ultra-lightweight Pub/Sub system.
 *
 * Designed to handle high-frequency landmark coordinate payloads (30–60 events/sec)
 * with minimal GC pressure. No external dependencies.
 *
 * Usage:
 *   const bus = new EventBus();
 *   const unsub = bus.on('frame', (data) => console.log(data));
 *   bus.emit('frame', { landmarks: [...] });
 *   unsub(); // or bus.off('frame', handler)
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    /** @type {Map<string, Set<Function>>} */
    this._onceListeners = new Map();

    /** Debug: count total events emitted per channel */
    this._stats = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} Unsubscribe function
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);

    // Return unsubscribe fn for convenience
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event exactly once.
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} Unsubscribe function
   */
  once(event, handler) {
    if (!this._onceListeners.has(event)) {
      this._onceListeners.set(event, new Set());
    }
    this._onceListeners.get(event).add(handler);
    return () => {
      const set = this._onceListeners.get(event);
      if (set) set.delete(handler);
    };
  }

  /**
   * Unsubscribe a handler from an event.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const persistent = this._listeners.get(event);
    if (persistent) persistent.delete(handler);

    const oneShot = this._onceListeners.get(event);
    if (oneShot) oneShot.delete(handler);
  }

  /**
   * Emit an event with a payload.
   * All handlers are called synchronously in subscription order.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    // Update debug stats
    this._stats.set(event, (this._stats.get(event) ?? 0) + 1);

    // Persistent listeners
    const persistent = this._listeners.get(event);
    if (persistent && persistent.size > 0) {
      for (const handler of persistent) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[EventBus] Error in handler for "${event}":`, err);
        }
      }
    }

    // One-shot listeners — fire and clear
    const oneShot = this._onceListeners.get(event);
    if (oneShot && oneShot.size > 0) {
      for (const handler of oneShot) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[EventBus] Error in once-handler for "${event}":`, err);
        }
      }
      oneShot.clear();
    }
  }

  /**
   * Remove all listeners for a given event, or clear everything.
   * @param {string} [event] If omitted, clears all channels.
   */
  clear(event) {
    if (event) {
      this._listeners.delete(event);
      this._onceListeners.delete(event);
    } else {
      this._listeners.clear();
      this._onceListeners.clear();
      this._stats.clear();
    }
  }

  /**
   * Debug: return emission counts per channel.
   * @returns {Object}
   */
  getStats() {
    return Object.fromEntries(this._stats.entries());
  }

  /**
   * Debug: return active listener counts per channel.
   * @returns {Object}
   */
  getListenerCounts() {
    const result = {};
    for (const [event, set] of this._listeners.entries()) {
      result[event] = set.size;
    }
    return result;
  }
}

// ── Named Event Constants ──────────────────────────────────────────────────
// Use these to avoid magic strings throughout the codebase.

export const EVENTS = {
  /** Raw 33-point landmark array from MediaPipe, fired every frame */
  FRAME: 'frame',

  /** Fired when a full jump repetition is counted */
  JUMP_COUNTED: 'jump:counted',

  /** Fired when elbow form deviates beyond threshold */
  ELBOW_ALERT: 'elbow:alert',

  /** Fired every cycle with DTW phase deviation score */
  DTW_SCORE: 'dtw:score',

  /** Fired when a coaching alert should be shown in the HUD */
  COACHING_ALERT: 'coaching:alert',

  /** Fired when the camera/session is reset */
  SESSION_RESET: 'session:reset',
};
