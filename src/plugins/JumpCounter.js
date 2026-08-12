/**
 * @fileoverview JumpCounter — Tracks jump repetitions via a 5-phase state machine.
 *
 * Algorithm (inspired by Formright's RepStateMachine):
 *   Tracks the SMOOTHED Y position of the hip midpoint through 5 explicit phases:
 *
 *     idle → descending → bottom → ascending → peaked → idle → …
 *
 *   A rep is counted on the `ascending → peaked` transition.
 *   After counting, the machine returns to `idle` (not descending) to force
 *   a full fresh cycle — this prevents landing-bounce double counts.
 *
 * Key robustness fixes vs. naive velocity-flip approach:
 *   1. EMA smoothing on hipY — eliminates jitter from arm movements
 *   2. Minimum phase frame duration — ignores transitions shorter than MIN_PHASE_FRAMES
 *   3. PHASE_MARGIN_RATIO / MIN_JUMP_AMPLITUDE_RATIO tuned to real jump scale
 *   4. Post-count idle lockout — landing bounce cannot start a new cycle
 *   5. MIN_JUMP_INTERVAL_MS debounce — hard floor between any two counts
 *   6. Ankle corroboration — real jumps move the whole body, arm waves don't
 *
 * Emits:
 *   EVENTS.JUMP_COUNTED   — { count, timestamp, hipY, amplitude, rpm }
 *   EVENTS.COACHING_ALERT — cadence feedback
 */

import { BasePlugin } from './BasePlugin.js';
import { midpoint, torsoLength, ema } from '../core/VectorMath.js';
import { EVENTS } from '../core/EventBus.js';

// MediaPipe landmark indices
const LEFT_HIP    = 23;
const RIGHT_HIP   = 24;
const LEFT_ANKLE  = 27;
const RIGHT_ANKLE = 28;

// ── Tuning constants ────────────────────────────────────────────────────────

/**
 * EMA smoothing factor for hip Y signal.
 * Lower = smoother (less reactive to noise). 0.35 kills hand-movement jitter
 * while still tracking a ~1Hz jump cycle cleanly.
 */
const HIP_Y_SMOOTHING = 0.35;

/**
 * Minimum hip displacement (as fraction of torso length) per state transition.
 * 0.06 = 6% of torso. Typical noise from arm movement is <2%, real jumps are >15%.
 */
const PHASE_MARGIN_RATIO = 0.06;

/**
 * Minimum full-cycle amplitude (bottom Y − peak Y, normalized by torso).
 * 0.12 = 12% of torso. Eliminates weight-shifts and micro-sways.
 * Real skipping rope jumps are typically 20–40%.
 */
const MIN_JUMP_AMPLITUDE_RATIO = 0.12;

/**
 * Minimum number of frames each phase must last before it can transition.
 * At 30 fps: 4 frames ≈ 133ms. Prevents 1-2 frame noise spikes from flipping state.
 */
const MIN_PHASE_FRAMES = 4;

/**
 * Hard debounce between two counted jumps.
 * 400ms = max 150 jumps/min. Normal skipping rope is 60–120 RPM.
 */
const MIN_JUMP_INTERVAL_MS = 400;

/**
 * Minimum ankle Y displacement (normalized) required on the ascending phase
 * to confirm body is actually airborne.
 * If ankles barely move while hips "jump", it's arm movement, not a jump.
 */
const MIN_ANKLE_LIFT_RATIO = 0.025; // 2.5% of torso

/** Sliding window size for RPM calculation */
const RPM_WINDOW = 10;

/** @typedef {'idle'|'descending'|'bottom'|'ascending'} Phase */

export class JumpCounter extends BasePlugin {
  constructor(bus) {
    super(bus, 'JumpCounter');
    this._reset();
  }

  _reset() {
    /** @type {number} Total jump count this session */
    this.count = 0;

    /** @type {Phase} Current state machine phase */
    this._phase = 'idle';

    /** @type {number} Smoothed hip Y (EMA output) */
    this._smoothHipY = 0;

    /** @type {boolean} Whether smoothHipY has been seeded */
    this._seeded = false;

    /** @type {number} Highest Y (lowest body position) seen during descent */
    this._bottomY = 0;

    /** @type {number} Lowest Y (highest body position) seen during ascent */
    this._peakY = 1;

    /** @type {number} Ankle Y baseline recorded at phase start */
    this._ankleBaselineY = 0;

    /** @type {number} Torso reference length for normalization */
    this._torsoRef = 0;

    /** @type {number} Timestamp of last counted jump */
    this._lastJumpTime = 0;

    /** @type {number} Frames spent in the current phase */
    this._phaseFrames = 0;

    /** @type {number[]} Jump timestamps for RPM */
    this._intervals = [];

    /** @type {number} Smoothed RPM */
    this._smoothedRPM = 0;

    /** @type {number} Internal frame counter */
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

    // Recompute torso reference every 10 frames
    this._frameCount++;
    if (this._frameCount % 10 === 0) {
      this._torsoRef = torsoLength(landmarks);
    }

    const rawHipY = midpoint(landmarks[LEFT_HIP], landmarks[RIGHT_HIP]).y;

    // Seed the EMA on the first valid frame
    if (!this._seeded) {
      this._smoothHipY = rawHipY;
      this._seeded = true;
      this._bottomY = rawHipY;
      this._peakY = rawHipY;
      return;
    }

    // Apply EMA smoothing — this is the core fix for hand-movement false positives
    this._smoothHipY = ema(this._smoothHipY, rawHipY, HIP_Y_SMOOTHING);

    const hipY = this._smoothHipY;

    const margin = this._torsoRef > 0
      ? this._torsoRef * PHASE_MARGIN_RATIO
      : PHASE_MARGIN_RATIO;

    // Get ankle midpoint Y for corroboration (visible ankles only)
    const anklesVisible = this.areLandmarksVisible(
      landmarks, [LEFT_ANKLE, RIGHT_ANKLE], 0.3
    );
    const ankleY = anklesVisible
      ? midpoint(landmarks[LEFT_ANKLE], landmarks[RIGHT_ANKLE]).y
      : null;

    this._phaseFrames++;
    this._advance(hipY, margin, ankleY, timestamp);
  }

  /**
   * Advance the state machine.
   * Y increases downward in image coords:
   *   hipY increases → body moving DOWN (descending)
   *   hipY decreases → body moving UP   (ascending)
   *
   * @param {number} hipY     Smoothed hip midpoint Y
   * @param {number} margin   Minimum movement per state transition
   * @param {number|null} ankleY  Smoothed ankle midpoint Y (null if not visible)
   * @param {number} timestamp
   */
  _advance(hipY, margin, ankleY, timestamp) {
    switch (this._phase) {

      case 'idle': {
        // Track standing baseline — only move reference up (lower Y) while idle.
        // Do NOT reset _bottomY to hipY every frame — that makes the descent check impossible.
        if (hipY < this._bottomY) this._bottomY = hipY;

        // Transition to descending on a clear downward movement from baseline
        if (hipY > this._bottomY + margin) {
          this._enterPhase('descending');
          this._bottomY = hipY;
          if (ankleY !== null) this._ankleBaselineY = ankleY;
        }
        break;
      }

      case 'descending': {
        // Track the lowest point
        if (hipY > this._bottomY) this._bottomY = hipY;

        // Transition to ascending when body clearly reverses upward
        // Require MIN_PHASE_FRAMES to prevent noise spikes
        if (
          this._phaseFrames >= MIN_PHASE_FRAMES &&
          hipY < this._bottomY - margin * 1.5
        ) {
          this._enterPhase('ascending');
          this._peakY = hipY;
          if (ankleY !== null) this._ankleBaselineY = ankleY;
        }
        break;
      }

      case 'ascending': {
        // Track the highest point (minimum Y = peak)
        if (hipY < this._peakY) this._peakY = hipY;

        // Transition to peaked when body reverses back downward
        if (
          this._phaseFrames >= MIN_PHASE_FRAMES &&
          hipY > this._peakY + margin
        ) {
          // ── Validation gate ─────────────────────────────────────────────
          const amplitude = this._bottomY - this._peakY;
          const minAmplitude = this._torsoRef > 0
            ? this._torsoRef * MIN_JUMP_AMPLITUDE_RATIO
            : MIN_JUMP_AMPLITUDE_RATIO;

          const timeSinceLast = timestamp - this._lastJumpTime;

          // Ankle corroboration: ankles must have lifted by MIN_ANKLE_LIFT_RATIO
          const minAnkleLift = this._torsoRef > 0
            ? this._torsoRef * MIN_ANKLE_LIFT_RATIO
            : MIN_ANKLE_LIFT_RATIO;
          const ankleLifted = ankleY === null
            ? true // can't check — allow it
            : (this._ankleBaselineY - ankleY) >= minAnkleLift;

          if (
            amplitude     >= minAmplitude &&
            timeSinceLast >= MIN_JUMP_INTERVAL_MS &&
            ankleLifted
          ) {
            this._countJump(amplitude, hipY, timestamp);
          }

          // Return to IDLE (not descending) — forces a full fresh cycle.
          // This is the core fix for landing-bounce double counts.
          this._enterPhase('idle');
          this._bottomY = hipY;
          this._peakY   = hipY;
        }
        break;
      }
    }
  }

  /**
   * Enter a new phase and reset the frame counter.
   * @param {Phase} phase
   */
  _enterPhase(phase) {
    this._phase       = phase;
    this._phaseFrames = 0;
  }

  /**
   * Register a counted jump and emit events.
   * @param {number} amplitude
   * @param {number} hipY
   * @param {number} timestamp
   */
  _countJump(amplitude, hipY, timestamp) {
    this.count++;
    this._intervals.push(timestamp);
    this._lastJumpTime = timestamp;
    if (this._intervals.length > RPM_WINDOW) this._intervals.shift();

    const rpm = this._computeRPM();
    this._smoothedRPM = ema(this._smoothedRPM, rpm, 0.4);

    const repPayload = {
      exercise:  'skipping',
      count:     this.count,
      timestamp,
      hipY,
      amplitude,
      rpm: Math.round(this._smoothedRPM),
    };

    this.bus.emit(EVENTS.JUMP_COUNTED, repPayload);
    this.bus.emit(EVENTS.REP_COUNTED,  repPayload);

    this._emitCadenceAlert(this._smoothedRPM, timestamp);
  }

  /**
   * Compute jumps per minute from the last N jump timestamps.
   * @returns {number}
   */
  _computeRPM() {
    if (this._intervals.length < 2) return 0;
    const span = this._intervals[this._intervals.length - 1] - this._intervals[0];
    if (span <= 0) return 0;
    return ((this._intervals.length - 1) / span) * 60_000;
  }

  /**
   * Emit cadence coaching alert.
   * @param {number} rpm
   * @param {number} timestamp
   */
  _emitCadenceAlert(rpm, timestamp) {
    if (rpm < 40) {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'cadence-low', type: 'warn', icon: '🐢',
        text: 'Speed up your rhythm!', timestamp,
      });
    } else if (rpm > 150) {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'cadence-high', type: 'good', icon: '🔥',
        text: 'Great pace — keep it consistent!', timestamp,
      });
    } else {
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'cadence-good', type: 'good', icon: '✅',
        text: `Nice rhythm — ${Math.round(rpm)} RPM`, timestamp,
      });
    }
  }
}
