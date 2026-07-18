/**
 * @fileoverview DTWComparator — Phase matching via simplified Dynamic Time Warping.
 *
 * Algorithm:
 *   1. Load the reference skipping session from JSON (pre-recorded master).
 *   2. Extract the hipY time-series from the reference.
 *   3. Per jump cycle: accumulate the live hipY time-series for one cycle
 *      (detected via JumpCounter events on the EventBus).
 *   4. On cycle completion: run a simplified DTW between the live cycle and
 *      the reference to compute a cumulative deviation score Δ.
 *   5. Map Δ → accuracy percentage [0..100] and emit DTW_SCORE.
 *
 * DTW Complexity:
 *   This implementation uses the standard O(n·m) DP DTW without pruning.
 *   For sequences of 20–60 frames, this is fast enough to run on the main thread.
 *   For longer sequences, consider Sakoe-Chiba band constraint.
 *
 * Emits:
 *   EVENTS.DTW_SCORE      — { score, delta, accuracy, cycleLength }
 *   EVENTS.COACHING_ALERT — accuracy-based feedback
 */

import { BasePlugin } from './BasePlugin.js';
import { midpoint } from '../core/VectorMath.js';
import { EVENTS } from '../core/EventBus.js';

const LEFT_HIP  = 23;
const RIGHT_HIP = 24;

/** Maximum DTW delta considered "perfect" — scale this by reference length */
const PERFECT_DELTA_RATIO = 0.5;

/** Alert cooldown (ms) */
const ALERT_COOLDOWN_MS = 3000;

export class DTWComparator extends BasePlugin {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {string} referenceUrl Path to reference_skipping.json
   */
  constructor(bus, referenceUrl = './src/data/reference_skipping.json') {
    super(bus, 'DTWComparator');

    /** @type {number[]} Reference hipY time-series (extracted from JSON) */
    this._referenceHipY = [];

    /** @type {number[]} Current live cycle hipY buffer */
    this._liveCycleBuffer = [];

    /** @type {number} Last jump count, used to detect new cycle starts */
    this._lastJumpCount = 0;

    /** @type {boolean} Whether reference data is loaded */
    this._loaded = false;

    /** @type {number} Last accuracy % for smoothing */
    this._lastAccuracy = null;

    /** @type {number} Last alert timestamp */
    this._lastAlertTime = 0;

    // Subscribe to jump events to delimit cycles
    this._jumpUnsub = bus.on(EVENTS.JUMP_COUNTED, (data) => {
      this._onJumpCounted(data);
    });

    // Load reference data asynchronously
    this._loadReference(referenceUrl);
  }

  /**
   * Load and parse the JSON reference file.
   * @param {string} url
   */
  async _loadReference(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      // Extract hipY column as a flat float array
      this._referenceHipY = data.frames.map((f) => f.hipY);
      this._loaded = true;
      console.info(`[DTWComparator] Reference loaded: ${this._referenceHipY.length} frames.`);
    } catch (err) {
      console.warn('[DTWComparator] Failed to load reference data. DTW disabled.', err);
      this._loaded = false;
    }
  }

  /** Called every frame — accumulate live hipY into the current cycle buffer */
  onFrame(landmarks, timestamp) {
    if (!this.areLandmarksVisible(landmarks, [LEFT_HIP, RIGHT_HIP], 0.4)) return;

    const hipCenter = midpoint(landmarks[LEFT_HIP], landmarks[RIGHT_HIP]);
    this._liveCycleBuffer.push(hipCenter.y);

    // Guard against runaway buffer (e.g., if JumpCounter isn't running)
    if (this._liveCycleBuffer.length > 300) {
      this._liveCycleBuffer.shift();
    }
  }

  onReset() {
    this._liveCycleBuffer = [];
    this._lastJumpCount = 0;
    this._lastAccuracy = null;
  }

  /**
   * Called when JumpCounter emits a new jump — treat this as cycle boundary.
   * @param {{ count: number, timestamp: number }} data
   */
  _onJumpCounted(data) {
    if (!this._loaded) return;
    if (this._liveCycleBuffer.length < 5) return; // too short to be meaningful

    // Run DTW between live cycle and reference
    const delta = this._dtw(this._liveCycleBuffer, this._referenceHipY);

    // Normalize delta to an accuracy score
    // Perfect delta = PERFECT_DELTA_RATIO * reference_length
    const perfectDelta = PERFECT_DELTA_RATIO * this._referenceHipY.length;
    const rawAccuracy = Math.max(0, 1 - delta / (perfectDelta * 3));
    const accuracy = Math.round(rawAccuracy * 100);

    this.bus.emit(EVENTS.DTW_SCORE, {
      score: delta,
      delta: delta.toFixed(3),
      accuracy,
      cycleLength: this._liveCycleBuffer.length,
      timestamp: data.timestamp,
    });

    // Emit coaching
    this._emitAccuracyAlert(accuracy, data.timestamp);

    // Clear buffer for next cycle — keep last few frames as overlap
    this._liveCycleBuffer = this._liveCycleBuffer.slice(-5);
  }

  /**
   * Compute DTW distance between two sequences using standard DP.
   * Returns the cumulative path cost (lower = more similar).
   *
   * @param {number[]} s  Live sequence
   * @param {number[]} t  Reference sequence
   * @returns {number} DTW distance
   */
  _dtw(s, t) {
    const n = s.length;
    const m = t.length;

    // Use a flat Float32Array for cache efficiency
    const cost = new Float32Array(n * m);

    const idx = (i, j) => i * m + j;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const d = Math.abs(s[i] - t[j]); // L1 distance for scalars

        let min;
        if (i === 0 && j === 0) {
          min = 0;
        } else if (i === 0) {
          min = cost[idx(0, j - 1)];
        } else if (j === 0) {
          min = cost[idx(i - 1, 0)];
        } else {
          min = Math.min(
            cost[idx(i - 1, j)],
            cost[idx(i, j - 1)],
            cost[idx(i - 1, j - 1)]
          );
        }
        cost[idx(i, j)] = d + min;
      }
    }

    // Normalize by path length to make it scale-invariant
    return cost[idx(n - 1, m - 1)] / (n + m);
  }

  /**
   * Emit coaching alert based on accuracy score.
   * @param {number} accuracy  [0..100]
   * @param {number} timestamp
   */
  _emitAccuracyAlert(accuracy, timestamp) {
    if (timestamp - this._lastAlertTime < ALERT_COOLDOWN_MS) return;
    this._lastAlertTime = timestamp;

    let alert;
    if (accuracy >= 85) {
      alert = { type: 'good', icon: '🌟', text: `Excellent form — ${accuracy}% match!` };
    } else if (accuracy >= 60) {
      alert = { type: 'warn', icon: '📊', text: `Form at ${accuracy}% — keep your rhythm steady` };
    } else {
      alert = { type: 'error', icon: '🎯', text: `Form at ${accuracy}% — try to match the reference pace` };
    }

    this.bus.emit(EVENTS.COACHING_ALERT, {
      id: 'dtw-accuracy',
      ...alert,
      timestamp,
    });
  }

  destroy() {
    super.destroy();
    if (this._jumpUnsub) this._jumpUnsub();
  }
}
