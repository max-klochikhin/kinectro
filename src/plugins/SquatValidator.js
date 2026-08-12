/**
 * @fileoverview SquatValidator — Real-time squat form validation.
 *
 * Implements four rules from Formright's squat coaching:
 *
 *   Rule 1 — DEPTH      "Go deeper"
 *     Knee angle (hip→knee→ankle) must be ≤ DEPTH_ANGLE_MAX at bottom.
 *     Angle > threshold → squat is too shallow.
 *
 *   Rule 2 — KNEE CAVE  "Don't let knees cave in"
 *     Left knee caving (facing camera, large X side): knee.x < ankle.x - tolerance
 *     Right knee caving (small X side):               knee.x > ankle.x + tolerance
 *
 *   Rule 3 — LATERAL LEAN "Keep torso upright"
 *     Angle of shoulder_mid → hip_mid from vertical measured in X only.
 *     NOTE: forward lean (Z axis) is NOT measurable from a front-facing camera.
 *     This detects sideways tilt during the squat only.
 *
 *   Rule 4 — HIP SYMMETRY "Uneven hips"
 *     |LEFT_HIP.y − RIGHT_HIP.y| normalized by torso > HIP_DIFF_THRESHOLD
 *
 * Each rule uses a bad-frame accumulator + per-rule cooldown to avoid alert spam.
 *
 * Emits:
 *   EVENTS.FORM_ALERT     — { rule, side, severity, text, timestamp }
 *   EVENTS.COACHING_ALERT — human-readable coaching message
 */

import { BasePlugin } from './BasePlugin.js';
import { midpoint, torsoLength, angle3D } from '../core/VectorMath.js';
import { EVENTS } from '../core/EventBus.js';

// MediaPipe landmark indices
const LEFT_SHOULDER  = 11;
const RIGHT_SHOULDER = 12;
const LEFT_HIP       = 23;
const RIGHT_HIP      = 24;
const LEFT_KNEE      = 25;
const RIGHT_KNEE     = 26;
const LEFT_ANKLE     = 27;
const RIGHT_ANKLE    = 28;

// ── Rule thresholds ─────────────────────────────────────────────────────────

/** Knee angle above this = squat is too shallow ("Go deeper") */
const DEPTH_ANGLE_MAX = 115; // degrees

/** Consecutive bad frames before firing depth alert */
const DEPTH_BAD_FRAMES = 10;

/**
 * Knee cave tolerance as fraction of hip width.
 * If knee.x is more than this fraction of hip-width inside the ankle, flag it.
 */
const KNEE_CAVE_TOLERANCE = 0.04; // normalized units

/** Consecutive bad frames for knee cave */
const KNEE_BAD_FRAMES = 8;

/** Lateral (sideways) torso tilt above this angle triggers alert (degrees from vertical in X) */
const TORSO_LEAN_MAX = 15;

/** Consecutive bad frames for torso lean */
const TORSO_BAD_FRAMES = 12;

/**
 * Hip symmetry threshold as fraction of torso length.
 * |leftHip.y - rightHip.y| / torsoLength > this → "Uneven hips"
 */
const HIP_DIFF_THRESHOLD = 0.04;

/** Consecutive bad frames for hip symmetry */
const HIP_BAD_FRAMES = 12;

/** Cooldown between repeated alerts for the same rule (ms) */
const ALERT_COOLDOWN_MS = 4000;

export class SquatValidator extends BasePlugin {
  constructor(bus) {
    super(bus, 'SquatValidator');
    this._reset();
  }

  _reset() {
    this._depthBad   = 0;
    this._kneeLeftBad  = 0;
    this._kneeRightBad = 0;
    this._torsoLeanBad = 0;
    this._hipDiffBad   = 0;

    /** @type {Object<string, number>} Last alert timestamp per rule */
    this._lastAlert = {};

    this._torsoRef = 0;
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
    // Need hips + knees + ankles to do anything useful
    const coreVisible = this.areLandmarksVisible(
      landmarks,
      [LEFT_HIP, RIGHT_HIP, LEFT_KNEE, RIGHT_KNEE, LEFT_ANKLE, RIGHT_ANKLE],
      0.4
    );
    if (!coreVisible) return;

    this._frameCount++;
    if (this._frameCount % 10 === 0) {
      this._torsoRef = torsoLength(landmarks);
    }

    this._checkDepth(landmarks, timestamp);
    this._checkKneeCave(landmarks, timestamp);
    this._checkTorsoLean(landmarks, timestamp);
    this._checkHipSymmetry(landmarks, timestamp);
  }

  // ── Rule 1: Depth ─────────────────────────────────────────────────────────

  /** @param {import('../core/VectorMath.js').Landmark[]} lm @param {number} ts */
  _checkDepth(lm, ts) {
    const leftAngle  = angle3D(lm[LEFT_HIP],  lm[LEFT_KNEE],  lm[LEFT_ANKLE]);
    const rightAngle = angle3D(lm[RIGHT_HIP], lm[RIGHT_KNEE], lm[RIGHT_ANKLE]);
    const avgAngle = (leftAngle + rightAngle) / 2;

    if (avgAngle > DEPTH_ANGLE_MAX) {
      this._depthBad++;
      if (
        this._depthBad >= DEPTH_BAD_FRAMES &&
        this._cooldownOk('depth', ts)
      ) {
        this._depthBad = 0;
        this._fire('depth', null, 'warn', '⬇️', 'Go deeper — lower your hips', ts);
      }
    } else {
      this._depthBad = Math.max(0, this._depthBad - 2);
    }
  }

  // ── Rule 2: Knee Cave ─────────────────────────────────────────────────────

  /** @param {import('../core/VectorMath.js').Landmark[]} lm @param {number} ts */
  _checkKneeCave(lm, ts) {
    const tol = KNEE_CAVE_TOLERANCE;

    // MediaPipe coordinates are NOT mirrored (raw camera frame).
    // When person faces camera: their LEFT side → large X, RIGHT side → small X.
    // Caving inward = knee moves toward body centre:
    //   Left knee:  large X → caving = X decreases (toward centre) → knee.x < ankle.x - tol
    //   Right knee: small X → caving = X increases (toward centre) → knee.x > ankle.x + tol
    const leftCave  = lm[LEFT_KNEE].x  < lm[LEFT_ANKLE].x  - tol;
    const rightCave = lm[RIGHT_KNEE].x > lm[RIGHT_ANKLE].x + tol;

    if (leftCave) {
      this._kneeLeftBad++;
      if (this._kneeLeftBad >= KNEE_BAD_FRAMES && this._cooldownOk('knee-left', ts)) {
        this._kneeLeftBad = 0;
        this._fire('knee-cave', 'left', 'warn', '🦵', 'Left knee caving in — push it out', ts);
      }
    } else {
      this._kneeLeftBad = Math.max(0, this._kneeLeftBad - 2);
    }

    if (rightCave) {
      this._kneeRightBad++;
      if (this._kneeRightBad >= KNEE_BAD_FRAMES && this._cooldownOk('knee-right', ts)) {
        this._kneeRightBad = 0;
        this._fire('knee-cave', 'right', 'warn', '🦵', 'Right knee caving in — push it out', ts);
      }
    } else {
      this._kneeRightBad = Math.max(0, this._kneeRightBad - 2);
    }
  }

  // ── Rule 3: Torso Lean ────────────────────────────────────────────────────

  /** @param {import('../core/VectorMath.js').Landmark[]} lm @param {number} ts */
  _checkTorsoLean(lm, ts) {
    const shoulderMid = midpoint(lm[LEFT_SHOULDER], lm[RIGHT_SHOULDER]);
    const hipMid      = midpoint(lm[LEFT_HIP],      lm[RIGHT_HIP]);

    // Vector from hip to shoulder (upward)
    const dx = shoulderMid.x - hipMid.x;
    const dy = hipMid.y - shoulderMid.y; // positive = shoulder above hip

    // Angle from vertical in degrees
    const leanAngle = Math.abs(Math.atan2(Math.abs(dx), Math.max(dy, 0.001)) * 180 / Math.PI);

    if (leanAngle > TORSO_LEAN_MAX) {
      this._torsoLeanBad++;
      if (this._torsoLeanBad >= TORSO_BAD_FRAMES && this._cooldownOk('torso-lean', ts)) {
        this._torsoLeanBad = 0;
        this._fire('torso-lean', null, 'warn', '🧍', 'Keep torso upright — you\'re leaning sideways', ts);
      }
    } else {
      this._torsoLeanBad = Math.max(0, this._torsoLeanBad - 2);
    }
  }

  // ── Rule 4: Hip Symmetry ──────────────────────────────────────────────────

  /** @param {import('../core/VectorMath.js').Landmark[]} lm @param {number} ts */
  _checkHipSymmetry(lm, ts) {
    const diff = Math.abs(lm[LEFT_HIP].y - lm[RIGHT_HIP].y);
    const threshold = this._torsoRef > 0
      ? this._torsoRef * HIP_DIFF_THRESHOLD
      : HIP_DIFF_THRESHOLD;

    if (diff > threshold) {
      this._hipDiffBad++;
      if (
        this._hipDiffBad >= HIP_BAD_FRAMES &&
        this._cooldownOk('hip-symmetry', ts)
      ) {
        this._hipDiffBad = 0;
        this._fire('hip-symmetry', 'both', 'warn', '⚖️', 'Uneven hips — keep them level', ts);
      }
    } else {
      this._hipDiffBad = Math.max(0, this._hipDiffBad - 2);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Check if a rule's cooldown has passed.
   * @param {string} ruleId
   * @param {number} timestamp
   */
  _cooldownOk(ruleId, timestamp) {
    const last = this._lastAlert[ruleId] ?? 0;
    return timestamp - last >= ALERT_COOLDOWN_MS;
  }

  /**
   * Emit both FORM_ALERT and COACHING_ALERT.
   * @param {string} rule
   * @param {'left'|'right'|'both'|null} side
   * @param {'warn'|'error'} severity
   * @param {string} icon
   * @param {string} text
   * @param {number} timestamp
   */
  _fire(rule, side, severity, icon, text, timestamp) {
    this._lastAlert[rule + (side ?? '')] = timestamp;

    this.bus.emit(EVENTS.FORM_ALERT, { rule, side, severity, text, timestamp });
    this.bus.emit(EVENTS.COACHING_ALERT, {
      id:   `squat-${rule}${side ? '-' + side : ''}`,
      type: severity,
      icon,
      text,
      timestamp,
    });
  }
}
