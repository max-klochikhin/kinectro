/**
 * @fileoverview PositioningValidator — Pre-session body framing check.
 *
 * Inspired by Formright's PositioningValidator. Runs before the session starts
 * and guides the user into a good position for jump detection:
 *   - Full body visible (nose → ankles)
 *   - Body horizontally centered
 *   - Sufficient clearance above head for jump apex
 *   - All key landmarks visible at acceptable confidence
 *
 * State machine:
 *   checking → (N consecutive OK frames) → confirmed → emit POSITIONING_OK → disabled
 *
 * If pose is lost after confirmation, plugin re-enables and emits POSITIONING_STATUS
 * so the overlay can reappear.
 *
 * Emits:
 *   EVENTS.POSITIONING_STATUS — every frame: { ok, message, direction }
 *   EVENTS.POSITIONING_OK     — once when user holds good position for CONFIRM_FRAMES
 */

import { BasePlugin } from './BasePlugin.js';
import { EVENTS } from '../core/EventBus.js';

// MediaPipe landmark indices
const NOSE           = 0;
const LEFT_SHOULDER  = 11;
const RIGHT_SHOULDER = 12;
const LEFT_HIP       = 23;
const RIGHT_HIP      = 24;
const LEFT_KNEE      = 25;
const RIGHT_KNEE     = 26;
const LEFT_ANKLE     = 27;
const RIGHT_ANKLE    = 28;

const MIN_VISIBILITY = 0.35;

/** Consecutive OK frames before emitting POSITIONING_OK (~0.7s at 30fps) */
const CONFIRM_FRAMES = 20;

/** Bad frames after confirmation before re-triggering check */
const RECHECK_FRAMES = 45;

/**
 * Per-exercise positioning config.
 * @typedef {{
 *   centerToleranceX: number,
 *   headMinY: number,
 *   headMaxY: number,
 *   ankleMaxY: number,
 *   requireKnees: boolean,
 * }} PositioningConfig
 */

/** @type {Record<string, PositioningConfig>} */
export const POSITIONING_CONFIGS = {
  skipping: {
    centerToleranceX: 0.18,
    headMinY:         0.12,  // nose must be below this — space above for jump apex
    headMaxY:         0.35,  // nose too low = user too far
    ankleMaxY:        0.95,  // ankles must be in frame
    requireKnees:     false, // knees don't matter for skipping
  },
  squat: {
    centerToleranceX: 0.18,
    headMinY:         0.06,  // less clearance needed (no jump)
    headMaxY:         0.40,  // can be a bit further
    ankleMaxY:        0.97,
    requireKnees:     true,  // SquatValidator needs knees clearly visible
  },
};

export class PositioningValidator extends BasePlugin {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {PositioningConfig} [config]
   */
  constructor(bus, config) {
    super(bus, 'PositioningValidator');

    /** @type {PositioningConfig} */
    this._cfg = config ?? POSITIONING_CONFIGS.skipping;

    /** @type {'checking'|'confirmed'} */
    this._state = 'checking';

    this._okFrames   = 0;
    this._badFrames  = 0;
    this._lastMessage = '';
  }

  /**
   * Hot-swap the positioning config (called when exercise changes).
   * Automatically resets state so calibration runs fresh.
   * @param {PositioningConfig} config
   */
  setConfig(config) {
    this._cfg = config;
    this.onReset();
  }

  onReset() {
    this._state = 'checking';
    this._okFrames = 0;
    this._badFrames = 0;
    this._lastMessage = '';
    this.enable();
  }

  /**
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   * @param {number} timestamp
   */
  onFrame(landmarks, timestamp) {
    const check = this._evaluate(landmarks);

    if (this._state === 'checking') {
      if (check.ok) {
        this._okFrames++;
        if (this._okFrames >= CONFIRM_FRAMES) {
          this._state = 'confirmed';
          this._badFrames = 0;
          this.bus.emit(EVENTS.POSITIONING_OK, { timestamp });
        } else {
          // Show progress: "Hold still..." while accumulating
          this._emit({ ok: true, message: 'Hold still…', direction: null }, timestamp);
        }
      } else {
        this._okFrames = Math.max(0, this._okFrames - 2); // decay on bad frames
        this._emit(check, timestamp);
      }
      return;
    }

    // state === 'confirmed': monitor for pose loss
    if (!check.ok) {
      this._badFrames++;
      if (this._badFrames >= RECHECK_FRAMES) {
        this._state = 'checking';
        this._okFrames = 0;
        this._emit(check, timestamp);
      }
    } else {
      this._badFrames = Math.max(0, this._badFrames - 1);
    }
  }

  /**
   * Evaluate current landmark positions and return a positioning result.
   * Uses this._cfg for all thresholds so behaviour differs per exercise.
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   * @returns {{ ok: boolean, message: string, direction: string|null }}
   */
  _evaluate(landmarks) {
    const cfg = this._cfg;

    // 1. Core landmarks must be visible
    const coreVisible = this.areLandmarksVisible(
      landmarks,
      [NOSE, LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_HIP, RIGHT_HIP],
      MIN_VISIBILITY
    );
    if (!coreVisible) {
      return { ok: false, message: 'Step into frame', direction: null };
    }

    const nose       = landmarks[NOSE];
    const hipCenterX = (landmarks[LEFT_HIP].x + landmarks[RIGHT_HIP].x) / 2;

    // 2. Ankles must be visible and in-frame
    const anklesVisible = this.areLandmarksVisible(
      landmarks, [LEFT_ANKLE, RIGHT_ANKLE], MIN_VISIBILITY
    );
    if (!anklesVisible) {
      return { ok: false, message: 'Move back — show full body', direction: 'back' };
    }

    const ankleAvgY = (landmarks[LEFT_ANKLE].y + landmarks[RIGHT_ANKLE].y) / 2;
    if (ankleAvgY > cfg.ankleMaxY) {
      return { ok: false, message: 'Move back — ankles too low', direction: 'back' };
    }

    // 3. Knees check — only for exercises that need them (e.g. squats)
    if (cfg.requireKnees) {
      const kneesVisible = this.areLandmarksVisible(
        landmarks, [LEFT_KNEE, RIGHT_KNEE], MIN_VISIBILITY
      );
      if (!kneesVisible) {
        return { ok: false, message: 'Move back — knees must be visible', direction: 'back' };
      }
      const kneeAvgY = (landmarks[LEFT_KNEE].y + landmarks[RIGHT_KNEE].y) / 2;
      if (kneeAvgY > 0.92) {
        return { ok: false, message: 'Move back — show full legs', direction: 'back' };
      }
    }

    // 4. Head clearance
    if (nose.y < cfg.headMinY) {
      return { ok: false, message: 'Move back — too close', direction: 'back' };
    }
    if (nose.y > cfg.headMaxY) {
      return { ok: false, message: 'Move closer', direction: 'closer' };
    }

    // 5. Horizontal centering
    const offsetX = hipCenterX - 0.5;
    if (offsetX > cfg.centerToleranceX) {
      return { ok: false, message: 'Move left', direction: 'left' };
    }
    if (offsetX < -cfg.centerToleranceX) {
      return { ok: false, message: 'Move right', direction: 'right' };
    }

    return { ok: true, message: 'Good position!', direction: null };
  }

  /**
   * Emit POSITIONING_STATUS, suppressing duplicate messages.
   */
  _emit(check, timestamp) {
    if (check.message === this._lastMessage) return;
    this._lastMessage = check.message;
    this.bus.emit(EVENTS.POSITIONING_STATUS, { ...check, timestamp });
  }
}
