/**
 * @fileoverview JumpCounter — Tracks jump repetitions via hip midpoint Y-axis velocity.
 *
 * Algorithm:
 *   1. Each frame, compute the Y position of the hip midpoint (avg of landmarks 23 & 24).
 *   2. Track the velocity (delta Y per frame).
 *   3. A jump is counted when the velocity crosses zero from negative (rising) to positive
 *      (falling), i.e., when the body passes through its apex.
 *   4. A minimum displacement threshold (normalized to torso length) prevents noise
 *      from small sways being counted as jumps.
 *
 * Emits:
 *   EVENTS.JUMP_COUNTED  — { count, timestamp, hipY, rpm }
 *   EVENTS.COACHING_ALERT — when cadence is too slow or too fast
 */

import { BasePlugin } from './BasePlugin.js';
import { midpoint, torsoLength, velocityY, ema } from '../core/VectorMath.js';
import { EVENTS } from '../core/EventBus.js';

// MediaPipe landmark indices
const LEFT_HIP  = 23;
const RIGHT_HIP = 24;

/** Minimum normalized hip displacement to count as a real jump (not noise) */
const MIN_JUMP_AMPLITUDE_RATIO = 0.04; // 4% of torso length

/** Minimum milliseconds between two jumps (debounce) */
const MIN_JUMP_INTERVAL_MS = 250; // ~240 BPM max

/** Frames to accumulate before computing rhythm RPM */
const RPM_WINDOW = 10;

export class JumpCounter extends BasePlugin {
  constructor(bus) {
    super(bus, 'JumpCounter');

    this._reset();
  }

  _reset() {
    /** @type {number} Current total jump count */
    this.count = 0;

    /** @type {number|null} Y position of hip midpoint in previous frame */
    this._prevHipY = null;

    /** @type {number} Smoothed Y velocity (EMA) */
    this._smoothedVelocityY = 0;

    /** @type {number} Lowest hip Y seen since last jump peak (local minimum = peak of jump in image coords) */
    this._localMinY = Infinity;

    /** @type {number} Highest hip Y seen since last jump valley (local maximum = bottom of descent) */
    this._localMaxY = -Infinity;

    /** @type {'rising'|'falling'|'idle'} Current movement phase */
    this._phase = 'idle';

    /** @type {number} Timestamp of last counted jump */
    this._lastJumpTime = 0;

    /** @type {number[]} Last N inter-jump intervals for RPM calculation */
    this._intervals = [];

    /** @type {number} Smoothed RPM */
    this._smoothedRPM = 0;

    /** @type {number} Torso reference length for normalization */
    this._torsoRef = 0;
  }

  onReset() {
    this._reset();
  }

  /**
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   * @param {number} timestamp
   */
  onFrame(landmarks, timestamp) {
    // Require both hips to be visible
    if (!this.areLandmarksVisible(landmarks, [LEFT_HIP, RIGHT_HIP], 0.4)) return;

    // Compute hip center Y
    const hipCenter = midpoint(landmarks[LEFT_HIP], landmarks[RIGHT_HIP]);
    const hipY = hipCenter.y;

    // Update body reference for normalization (torso length)
    // Only recalculate every ~10 frames for performance
    this._frameCount = (this._frameCount ?? 0) + 1;
    if (this._frameCount % 10 === 0) {
      this._torsoRef = torsoLength(landmarks);
    }

    if (this._prevHipY === null) {
      this._prevHipY = hipY;
      return;
    }

    // Raw velocity: positive = body moving DOWN in image (descending), negative = going UP (rising)
    const rawVelocity = velocityY({ y: this._prevHipY }, { y: hipY });
    this._smoothedVelocityY = ema(this._smoothedVelocityY, rawVelocity, 0.35);

    // Track local extrema
    if (hipY < this._localMinY) this._localMinY = hipY;
    if (hipY > this._localMaxY) this._localMaxY = hipY;

    // Phase detection: rising = body going UP (hipY decreasing)
    if (this._smoothedVelocityY < -0.001 && this._phase !== 'rising') {
      this._phase = 'rising';
      this._localMaxY = hipY; // start tracking new potential valley
    }

    // Phase flip: was rising, now falling = we just passed the APEX of a jump
    if (this._smoothedVelocityY > 0.001 && this._phase === 'rising') {
      this._phase = 'falling';

      // Measure the amplitude of this jump (how far up the hip traveled)
      const amplitude = this._localMaxY - this._localMinY;
      const normalizedAmplitude = this._torsoRef > 0 ? amplitude / this._torsoRef : amplitude;

      const timeSinceLast = timestamp - this._lastJumpTime;

      if (
        normalizedAmplitude >= MIN_JUMP_AMPLITUDE_RATIO &&
        timeSinceLast >= MIN_JUMP_INTERVAL_MS
      ) {
        this.count += 1;
        this._lastJumpTime = timestamp;

        // Track interval for RPM
        if (this._intervals.length >= RPM_WINDOW) {
          this._intervals.shift();
        }
        this._intervals.push(timeSinceLast);

        const rpm = this._computeRPM();
        this._smoothedRPM = ema(this._smoothedRPM, rpm, 0.4);

        // Emit jump event
        this.bus.emit(EVENTS.JUMP_COUNTED, {
          count: this.count,
          timestamp,
          hipY,
          amplitude: normalizedAmplitude,
          rpm: Math.round(this._smoothedRPM),
        });

        // Coaching: cadence feedback
        this._emitCadenceAlert(this._smoothedRPM, timestamp);

        // Reset local min for next cycle
        this._localMinY = hipY;
      }

      this._localMaxY = -Infinity;
    }

    this._prevHipY = hipY;
  }

  /**
   * Compute jumps per minute from the last N inter-jump intervals.
   * @returns {number}
   */
  _computeRPM() {
    if (this._intervals.length === 0) return 0;
    const avgInterval = this._intervals.reduce((a, b) => a + b, 0) / this._intervals.length;
    if (avgInterval === 0) return 0;
    return (60000 / avgInterval); // ms → RPM
  }

  /**
   * Emit coaching alerts for cadence.
   * @param {number} rpm
   * @param {number} timestamp
   */
  _emitCadenceAlert(rpm, timestamp) {
    if (rpm < 40) {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'cadence-low',
        type: 'warn',
        icon: '🐢',
        text: 'Speed up your rhythm!',
        timestamp,
      });
    } else if (rpm > 180) {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'cadence-high',
        type: 'warn',
        icon: '🔥',
        text: 'Great pace — keep it consistent!',
        timestamp,
      });
    } else {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'cadence-good',
        type: 'good',
        icon: '✅',
        text: `Nice rhythm — ${Math.round(rpm)} RPM`,
        timestamp,
      });
    }
  }
}
