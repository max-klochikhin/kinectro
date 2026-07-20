import { BasePlugin } from './BasePlugin.js';
import { midpoint } from '../core/VectorMath.js';

const LEFT_HIP = 23;
const RIGHT_HIP = 24;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;

export class ReferenceRecorder extends BasePlugin {
  constructor(bus) {
    super(bus, 'ReferenceRecorder');
    this.disable();
    this._reset();
  }

  _reset() {
    this.isRecording = false;
    this.frames = [];
    this.startTime = null;
  }

  onReset() {
    this._reset();
  }

  start(timestamp) {
    this.frames = [];
    this.startTime = timestamp;
    this.isRecording = true;
    this.enable();
    console.info('[ReferenceRecorder] Recording started.');
  }

  /**
   * Stop the recording session.
   * @param {number} timestamp
   * @returns {Object|null} The recorded session in reference_skipping.json format, or null if invalid.
   */
  stop(timestamp) {
    if (!this.isRecording) return null;
    this.isRecording = false;
    this.disable();

    if (this.frames.length < 15) {
      console.warn('[ReferenceRecorder] Capture too short (less than 15 frames). Discarded.');
      this._reset();
      return null;
    }

    const duration = timestamp - this.startTime;
    const sampleRate = Math.round((this.frames.length / (duration / 1000)));

    const result = {
      _meta: {
        description: 'User-recorded reference session',
        recorded: new Date().toISOString(),
        frameCount: this.frames.length,
        sampleRateHz: sampleRate || 30,
        notes: [
          'hipY is the normalized Y coordinate of the hip midpoint (landmarks 23 & 24).',
          'Values in [0..1] where 0 = top of image, 1 = bottom.'
        ]
      },
      frames: this.frames
    };

    console.info(`[ReferenceRecorder] Recording stopped successfully. Captured ${this.frames.length} frames.`);
    this._reset();
    return result;
  }

  /**
   * @param {import('../core/VectorMath.js').Landmark[]} landmarks
   * @param {number} timestamp
   */
  onFrame(landmarks, timestamp) {
    if (!this.isRecording) return;

    // Check if hips and wrists are visible
    if (!this.areLandmarksVisible(landmarks, [LEFT_HIP, RIGHT_HIP, LEFT_WRIST, RIGHT_WRIST], 0.4)) {
      return;
    }

    const hipCenter = midpoint(landmarks[LEFT_HIP], landmarks[RIGHT_HIP]);

    // Reject frames where key landmarks are outside the [0..1] image bounds —
    // this filters out "walking into frame" and "walking out of frame" noise.
    const hipY = hipCenter.y;
    const leftWristY = landmarks[LEFT_WRIST].y;
    const rightWristY = landmarks[RIGHT_WRIST].y;
    if (
      hipY < 0 || hipY > 1 ||
      leftWristY < 0 || leftWristY > 1 ||
      rightWristY < 0 || rightWristY > 1
    ) {
      return;
    }

    const relativeTime = timestamp - this.startTime;

    this.frames.push({
      t: Math.round(relativeTime),
      hipY: parseFloat(hipY.toFixed(4)),
      leftWristY: parseFloat(leftWristY.toFixed(4)),
      rightWristY: parseFloat(rightWristY.toFixed(4))
    });

    // Auto-stop at 300 frames to avoid memory exhaustion
    if (this.frames.length >= 300) {
      console.warn('[ReferenceRecorder] Maximum frames (300) reached. Stopping recording.');
      this.bus.emit('recorder:timeout', { timestamp });
    }
  }
}
