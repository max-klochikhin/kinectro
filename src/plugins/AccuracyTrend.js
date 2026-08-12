/**
 * @fileoverview AccuracyTrend — Tracks DTW accuracy trend over a sliding window.
 *
 * Inspired by Formright's "Accuracy up / down / holding steady" coaching pattern.
 * Instead of reacting to individual DTW scores (noisy), this plugin watches the
 * *direction* of change over the last N cycles and emits trend-based feedback.
 *
 * Algorithm:
 *   1. Collect DTW accuracy scores into a sliding window (default: 5 cycles).
 *   2. Compute the linear slope across the window (least-squares or simple
 *      first→last delta — both are equivalent for small windows).
 *   3. Classify: slope > +THRESHOLD → 'up', slope < -THRESHOLD → 'down', else 'steady'.
 *   4. Emit ACCURACY_TREND + COACHING_ALERT when trend changes, with a cooldown.
 *
 * Emits:
 *   EVENTS.ACCURACY_TREND  — { trend, slope, avg, window, timestamp }
 *   EVENTS.COACHING_ALERT  — trend-based human message
 */

import { BasePlugin } from './BasePlugin.js';
import { EVENTS } from '../core/EventBus.js';

/** Number of DTW cycles to include in the trend window */
const WINDOW_SIZE = 5;

/**
 * Minimum slope (accuracy % per cycle) to classify as trending up/down.
 * E.g., 3 means accuracy must change by 3% per cycle on average to register.
 */
const SLOPE_THRESHOLD = 3;

/** Minimum ms between trend coaching alerts */
const ALERT_COOLDOWN_MS = 10_000;

/** @typedef {'up'|'down'|'steady'} Trend */

export class AccuracyTrend extends BasePlugin {
  constructor(bus) {
    super(bus, 'AccuracyTrend');

    /** @type {number[]} Sliding window of recent accuracy scores [0..100] */
    this._window = [];

    /** @type {Trend|null} Last emitted trend (to avoid repeating same state) */
    this._lastTrend = null;

    /** @type {number} Timestamp of last coaching alert */
    this._lastAlertTime = 0;

    // AccuracyTrend doesn't use FRAME events
    this.disable();

    // Subscribe to DTW scores
    this._dtwUnsub = bus.on(EVENTS.DTW_SCORE, ({ accuracy, timestamp }) => {
      this._onScore(accuracy, timestamp);
    });
  }

  onReset() {
    this._window = [];
    this._lastTrend = null;
    this._lastAlertTime = 0;
  }

  /**
   * @param {number} accuracy  [0..100]
   * @param {number} timestamp
   */
  _onScore(accuracy, timestamp) {
    // Add to sliding window
    this._window.push(accuracy);
    if (this._window.length > WINDOW_SIZE) {
      this._window.shift();
    }

    // Need at least 3 data points to compute a meaningful trend
    if (this._window.length < 3) return;

    const slope = this._computeSlope(this._window);
    const avg   = this._window.reduce((a, b) => a + b, 0) / this._window.length;

    /** @type {Trend} */
    let trend;
    if (slope > SLOPE_THRESHOLD) {
      trend = 'up';
    } else if (slope < -SLOPE_THRESHOLD) {
      trend = 'down';
    } else {
      trend = 'steady';
    }

    this.bus.emit(EVENTS.ACCURACY_TREND, {
      trend,
      slope: Math.round(slope * 10) / 10,
      avg: Math.round(avg),
      window: [...this._window],
      timestamp,
    });

    // Only emit coaching alerts when trend changes and cooldown passed
    const trendChanged = trend !== this._lastTrend;
    const cooldownOk   = timestamp - this._lastAlertTime >= ALERT_COOLDOWN_MS;

    if (trendChanged || cooldownOk) {
      if (trendChanged) this._lastTrend = trend;
      if (cooldownOk || trendChanged) {
        this._lastAlertTime = timestamp;
        this._emitTrendAlert(trend, Math.round(avg), timestamp);
      }
    }
  }

  /**
   * Compute linear slope of a series using simple first→last delta per step.
   * Equivalent to least-squares slope for evenly spaced data.
   * @param {number[]} series
   * @returns {number} slope in units/step
   */
  _computeSlope(series) {
    if (series.length < 2) return 0;
    return (series[series.length - 1] - series[0]) / (series.length - 1);
  }

  /**
   * @param {Trend} trend
   * @param {number} avg  Average accuracy in the window
   * @param {number} timestamp
   */
  _emitTrendAlert(trend, avg, timestamp) {
    const messages = {
      up:     { icon: '📈', type: 'good', text: `Accuracy improving — great work! (avg ${avg}%)` },
      steady: { icon: '📊', type: 'good', text: `Accuracy holding steady at ${avg}%` },
      down:   { icon: '⚠️', type: 'warn', text: `Accuracy dropping — slow down and focus on form` },
    };

    const m = messages[trend];
    this.bus.emit(EVENTS.COACHING_ALERT, {
      id: 'accuracy-trend',
      ...m,
      timestamp,
    });
  }

  destroy() {
    super.destroy();
    if (this._dtwUnsub) this._dtwUnsub();
  }
}
