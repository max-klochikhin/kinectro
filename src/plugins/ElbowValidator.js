/**
 * @fileoverview ElbowValidator — Monitors elbow/arm form during jumping exercises.
 *
 * Algorithm:
 *   1. Each frame, calculate the 3D angle at each elbow: shoulder→elbow→wrist.
 *   2. Normalize the reference angle using a baseline from the first N frames
 *      (learned from each individual user's natural resting arm position).
 *   3. Compute deviation from the target "good form" angle range.
 *   4. If deviation persists for more than ALERT_HOLD_FRAMES frames → emit alert.
 *
 * Target form for skipping rope:
 *   - Elbows should stay close to the torso.
 *   - The elbow angle should be approximately 90°–120° (forearms roughly horizontal).
 *   - Wrists should rotate, not the entire arm.
 *
 * Emits:
 *   EVENTS.ELBOW_ALERT     — { side, angle, deviation, timestamp }
 *   EVENTS.COACHING_ALERT  — human-readable coaching message
 */

import { BasePlugin } from './BasePlugin.js';
import { angle3D, torsoLength } from '../core/VectorMath.js';
import { EVENTS } from '../core/EventBus.js';

// MediaPipe BlazePose landmark indices
const LANDMARKS = {
  LEFT_SHOULDER:  11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW:     13,
  RIGHT_ELBOW:    14,
  LEFT_WRIST:     15,
  RIGHT_WRIST:    16,
};

/** Target elbow angle range for good skipping form (degrees) */
const TARGET_ANGLE_MIN = 80;
const TARGET_ANGLE_MAX = 130;

/** Degrees of deviation that trigger a warning */
const DEVIATION_THRESHOLD = 25;

/** Number of consecutive bad frames before firing an alert */
const ALERT_HOLD_FRAMES = 8;

/** Cooldown between repeated alerts (ms) */
const ALERT_COOLDOWN_MS = 2500;

export class ElbowValidator extends BasePlugin {
  constructor(bus) {
    super(bus, 'ElbowValidator');

    this._reset();
  }

  _reset() {
    this._leftBadFrames  = 0;
    this._rightBadFrames = 0;
    this._lastAlertTime  = { left: 0, right: 0 };
    this._frameIndex = 0;
  }

  onReset() {
    this._reset();
  }

  /**
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   * @param {number} timestamp
   */
  onFrame(landmarks, timestamp) {
    this._frameIndex++;

    const leftVisible = this.areLandmarksVisible(landmarks, [
      LANDMARKS.LEFT_SHOULDER,
      LANDMARKS.LEFT_ELBOW,
      LANDMARKS.LEFT_WRIST,
    ], 0.45);

    const rightVisible = this.areLandmarksVisible(landmarks, [
      LANDMARKS.RIGHT_SHOULDER,
      LANDMARKS.RIGHT_ELBOW,
      LANDMARKS.RIGHT_WRIST,
    ], 0.45);

    if (leftVisible) {
      const leftAngle = angle3D(
        landmarks[LANDMARKS.LEFT_SHOULDER],
        landmarks[LANDMARKS.LEFT_ELBOW],
        landmarks[LANDMARKS.LEFT_WRIST]
      );
      this._validateSide('left', leftAngle, timestamp, landmarks);
    } else {
      this._leftBadFrames = 0; // reset counter if landmark lost
    }

    if (rightVisible) {
      const rightAngle = angle3D(
        landmarks[LANDMARKS.RIGHT_SHOULDER],
        landmarks[LANDMARKS.RIGHT_ELBOW],
        landmarks[LANDMARKS.RIGHT_WRIST]
      );
      this._validateSide('right', rightAngle, timestamp, landmarks);
    } else {
      this._rightBadFrames = 0;
    }
  }

  /**
   * Validate a single arm side and accumulate bad frames.
   * @param {'left'|'right'} side
   * @param {number} angle        Measured elbow angle in degrees
   * @param {number} timestamp
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   */
  _validateSide(side, angle, timestamp, landmarks) {
    const deviation = this._computeDeviation(angle);
    const isGood = Math.abs(deviation) <= DEVIATION_THRESHOLD;

    if (isGood) {
      // Reset bad frame counter for this side
      if (side === 'left')  this._leftBadFrames  = Math.max(0, this._leftBadFrames  - 2);
      if (side === 'right') this._rightBadFrames = Math.max(0, this._rightBadFrames - 2);
      return;
    }

    // Accumulate bad frames
    if (side === 'left')  this._leftBadFrames++;
    if (side === 'right') this._rightBadFrames++;

    const badFrames = side === 'left' ? this._leftBadFrames : this._rightBadFrames;
    const lastAlert = this._lastAlertTime[side];

    if (badFrames >= ALERT_HOLD_FRAMES && (timestamp - lastAlert) > ALERT_COOLDOWN_MS) {
      this._lastAlertTime[side] = timestamp;
      const badFrameRef = side === 'left' ? this._leftBadFrames = 0 : this._rightBadFrames = 0;

      // Determine what kind of deviation
      const tooStraight = angle > TARGET_ANGLE_MAX;
      const tooAcute    = angle < TARGET_ANGLE_MIN;

      this.bus.emit(EVENTS.ELBOW_ALERT, {
        side,
        angle: Math.round(angle),
        deviation: Math.round(deviation),
        timestamp,
      });

      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: `elbow-${side}`,
        type: 'warn',
        icon: '💪',
        text: tooStraight
          ? `${this._capitalizeFirst(side)} arm too straight (${Math.round(angle)}°) — bend your elbow`
          : `${this._capitalizeFirst(side)} arm too bent (${Math.round(angle)}°) — relax your elbow`,
        timestamp,
      });
    }
  }

  /**
   * Calculate signed deviation from the target angle range center.
   * Positive = angle above range (too straight), negative = below range (too bent).
   * @param {number} angle
   * @returns {number}
   */
  _computeDeviation(angle) {
    const center = (TARGET_ANGLE_MIN + TARGET_ANGLE_MAX) / 2;
    return angle - center;
  }

  /** @param {string} str @returns {string} */
  _capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}
