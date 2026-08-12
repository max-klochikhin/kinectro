/**
 * @fileoverview SquatCounter — Counts squat repetitions via a 5-phase state machine.
 *
 * Identical algorithm to JumpCounter but tuned for squats:
 *   - Larger minimum amplitude (squats go deeper than jump apex)
 *   - Slower cadence (longer MIN_INTERVAL_MS)
 *   - No ankle-lift check (feet stay on the ground)
 *   - Longer minimum phase duration (squats are controlled movements)
 *
 * State machine:
 *   idle → descending → bottom → ascending → idle (rep counted at ascending→idle)
 *
 * In image coordinates: Y increases downward.
 *   Squatting down = hipY increases  (descending)
 *   Standing up    = hipY decreases  (ascending)
 *
 * Emits:
 *   EVENTS.REP_COUNTED    — { exercise:'squat', count, timestamp, amplitude, rpm }
 *   EVENTS.COACHING_ALERT — cadence feedback
 */

import { BasePlugin } from './BasePlugin.js';
import { midpoint, torsoLength, ema } from '../core/VectorMath.js';
import { EVENTS } from '../core/EventBus.js';

const LEFT_HIP  = 23;
const RIGHT_HIP = 24;

// ── Tuning ──────────────────────────────────────────────────────────────────

/** EMA smoothing on raw hipY — squat movements are slower so we can smooth more */
const HIP_Y_SMOOTHING = 0.30;

/** Minimum hip displacement per state transition (6% → 8% for squats) */
const PHASE_MARGIN_RATIO = 0.08;

/**
 * Minimum full-cycle amplitude to count a rep.
 * Squats should lower hips by ≥20% of torso length.
 * This filters out weight-shifts and half-squats.
 */
const MIN_SQUAT_DEPTH_RATIO = 0.20;

/** Minimum frames per phase (~200ms at 30fps) */
const MIN_PHASE_FRAMES = 6;

/** Hard debounce — squats rarely exceed 60/min = one per second */
const MIN_REP_INTERVAL_MS = 700;

const RPM_WINDOW = 8;

/** @typedef {'idle'|'descending'|'bottom'|'ascending'} Phase */

export class SquatCounter extends BasePlugin {
  constructor(bus) {
    super(bus, 'SquatCounter');
    this._reset();
  }

  _reset() {
    /** @type {number} */
    this.count = 0;

    /** @type {Phase} */
    this._phase = 'idle';

    /** @type {number} Smoothed hip Y */
    this._smoothHipY = 0;

    /** @type {boolean} */
    this._seeded = false;

    /** @type {number} Lowest body position (highest Y) seen during descent */
    this._bottomY = 0;

    /** @type {number} Highest body position (lowest Y) seen during ascent */
    this._peakY = 1;

    /** @type {number} Torso reference length */
    this._torsoRef = 0;

    /** @type {number} Timestamp of last counted rep */
    this._lastRepTime = 0;

    /** @type {number} Frames spent in current phase */
    this._phaseFrames = 0;

    /** @type {number[]} Jump timestamps for RPM */
    this._intervals = [];

    /** @type {number} Smoothed RPM */
    this._smoothedRPM = 0;

    /** @type {number} */
    this._frameCount = 0;
  }

  onReset() {
    this._reset();
  }

  /**
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   * @param {number} timestamp
   */
  onFrame(landmarks, timestamp) {
    if (!this.areLandmarksVisible(landmarks, [LEFT_HIP, RIGHT_HIP], 0.4)) {
      this._phase = 'idle';
      this._seeded = false;
      return;
    }

    this._frameCount++;
    if (this._frameCount % 10 === 0) {
      this._torsoRef = torsoLength(landmarks);
    }

    const rawHipY = midpoint(landmarks[LEFT_HIP], landmarks[RIGHT_HIP]).y;

    if (!this._seeded) {
      this._smoothHipY = rawHipY;
      this._seeded = true;
      this._bottomY = rawHipY;
      this._peakY   = rawHipY;
      return;
    }

    this._smoothHipY = ema(this._smoothHipY, rawHipY, HIP_Y_SMOOTHING);
    const hipY = this._smoothHipY;

    const margin = this._torsoRef > 0
      ? this._torsoRef * PHASE_MARGIN_RATIO
      : PHASE_MARGIN_RATIO;

    this._phaseFrames++;
    this._advance(hipY, margin, timestamp);
  }

  /**
   * @param {number} hipY
   * @param {number} margin
   * @param {number} timestamp
   */
  _advance(hipY, margin, timestamp) {
    switch (this._phase) {

      case 'idle': {
        // Track standing baseline — only move reference up (lower Y) while idle.
        if (hipY < this._bottomY) this._bottomY = hipY;

        // Squat begins: hips drop (hipY increases) from baseline
        if (hipY > this._bottomY + margin) {
          this._enterPhase('descending');
          this._bottomY = hipY;
        }
        break;
      }

      case 'descending': {
        if (hipY > this._bottomY) this._bottomY = hipY;
        // Transition to ascending when body starts rising
        if (
          this._phaseFrames >= MIN_PHASE_FRAMES &&
          hipY < this._bottomY - margin * 1.5
        ) {
          this._enterPhase('ascending');
          this._peakY = hipY;
        }
        break;
      }

      case 'ascending': {
        if (hipY < this._peakY) this._peakY = hipY;
        // Rep counted when body returns close to standing position
        if (
          this._phaseFrames >= MIN_PHASE_FRAMES &&
          hipY > this._peakY + margin
        ) {
          const amplitude    = this._bottomY - this._peakY;
          const minAmplitude = this._torsoRef > 0
            ? this._torsoRef * MIN_SQUAT_DEPTH_RATIO
            : MIN_SQUAT_DEPTH_RATIO;
          const timeSinceLast = timestamp - this._lastRepTime;

          if (amplitude >= minAmplitude && timeSinceLast >= MIN_REP_INTERVAL_MS) {
            this._countRep(amplitude, hipY, timestamp);
          }

          // Return to idle — same post-count lockout as JumpCounter
          this._enterPhase('idle');
          this._bottomY = hipY;
          this._peakY   = hipY;
        }
        break;
      }
    }
  }

  /** @param {Phase} phase */
  _enterPhase(phase) {
    this._phase       = phase;
    this._phaseFrames = 0;
  }

  /**
   * @param {number} amplitude
   * @param {number} hipY
   * @param {number} timestamp
   */
  _countRep(amplitude, hipY, timestamp) {
    this.count++;
    this._intervals.push(timestamp);
    this._lastRepTime = timestamp;
    if (this._intervals.length > RPM_WINDOW) this._intervals.shift();

    const rpm = this._computeRPM();
    this._smoothedRPM = ema(this._smoothedRPM, rpm, 0.4);

    const payload = {
      exercise:  'squat',
      count:     this.count,
      timestamp,
      hipY,
      amplitude,
      rpm: Math.round(this._smoothedRPM),
    };

    this.bus.emit(EVENTS.REP_COUNTED, payload);
    this._emitCadenceAlert(this._smoothedRPM, timestamp);
  }

  _computeRPM() {
    if (this._intervals.length < 2) return 0;
    const span = this._intervals[this._intervals.length - 1] - this._intervals[0];
    if (span <= 0) return 0;
    return ((this._intervals.length - 1) / span) * 60_000;
  }

  /** @param {number} rpm @param {number} timestamp */
  _emitCadenceAlert(rpm, timestamp) {
    if (rpm < 10) {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'squat-cadence-low', type: 'warn', icon: '🐢',
        text: 'Keep moving — slow down between reps is fine, but stay active!',
        timestamp,
      });
    } else if (rpm > 40) {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'squat-cadence-high', type: 'warn', icon: '⚠️',
        text: 'Slow down — control the movement!',
        timestamp,
      });
    } else {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'squat-cadence-good', type: 'good', icon: '✅',
        text: `Good pace — ${Math.round(rpm)} reps/min`,
        timestamp,
      });
    }
  }
}
