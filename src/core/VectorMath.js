/**
 * @fileoverview VectorMath — 3D geometry helpers for pose landmark analysis.
 *
 * All functions operate on MediaPipe-style landmark objects: { x, y, z, visibility }.
 * Coordinates are normalized [0..1] relative to image dimensions.
 *
 * Normalization strategy:
 *   Physical measurements (angles, widths) should be normalized relative to
 *   a stable body reference (e.g., torso length = shoulder-to-hip distance)
 *   so the system works for any body size and camera distance.
 */

// ── Type Definitions ──────────────────────────────────────────────────────

/**
 * @typedef {{ x: number, y: number, z: number, visibility?: number }} Landmark
 */

// ── Vector Operations ─────────────────────────────────────────────────────

/**
 * Subtract point B from point A → vector A→B.
 * @param {Landmark} a
 * @param {Landmark} b
 * @returns {{ x: number, y: number, z: number }}
 */
export function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * Dot product of two 3D vectors.
 * @param {{ x: number, y: number, z: number }} u
 * @param {{ x: number, y: number, z: number }} v
 * @returns {number}
 */
export function dot(u, v) {
  return u.x * v.x + u.y * v.y + u.z * v.z;
}

/**
 * Euclidean magnitude of a 3D vector.
 * @param {{ x: number, y: number, z: number }} v
 * @returns {number}
 */
export function magnitude(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * Euclidean distance between two landmarks in 3D space.
 * @param {Landmark} a
 * @param {Landmark} b
 * @returns {number}
 */
export function distance3D(a, b) {
  return magnitude(subtract(a, b));
}

/**
 * Euclidean distance between two landmarks in 2D (ignores z).
 * @param {Landmark} a
 * @param {Landmark} b
 * @returns {number}
 */
export function distance2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Angle Calculation ─────────────────────────────────────────────────────

/**
 * Calculate the 3D angle (in degrees) at vertex point B,
 * formed by the vectors B→A and B→C.
 *
 * Example: angle at elbow = angle3D(shoulder, elbow, wrist)
 *
 * @param {Landmark} a  First outer point
 * @param {Landmark} b  Vertex point (angle is measured here)
 * @param {Landmark} c  Second outer point
 * @returns {number} Angle in degrees [0..180]
 */
export function angle3D(a, b, c) {
  const ba = subtract(a, b); // vector from b to a
  const bc = subtract(c, b); // vector from b to c

  const magBA = magnitude(ba);
  const magBC = magnitude(bc);

  if (magBA === 0 || magBC === 0) return 0;

  // Clamp to [-1, 1] to guard against floating-point drift
  const cosTheta = Math.min(1, Math.max(-1, dot(ba, bc) / (magBA * magBC)));
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

/**
 * Calculate the 2D angle (in degrees) at vertex B, ignoring Z.
 * Useful for side-view analysis or when depth is unreliable.
 *
 * @param {Landmark} a
 * @param {Landmark} b
 * @param {Landmark} c
 * @returns {number} Angle in degrees [0..180]
 */
export function angle2D(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };

  const dotVal = ba.x * bc.x + ba.y * bc.y;
  const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y);
  const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y);

  if (magBA === 0 || magBC === 0) return 0;

  const cosTheta = Math.min(1, Math.max(-1, dotVal / (magBA * magBC)));
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

// ── Midpoint & Centroid ───────────────────────────────────────────────────

/**
 * Return the midpoint between two landmarks.
 * @param {Landmark} a
 * @param {Landmark} b
 * @returns {Landmark}
 */
export function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

/**
 * Return the centroid of an array of landmarks.
 * @param {Landmark[]} points
 * @returns {Landmark}
 */
export function centroid(points) {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0, z: 0 };
  const sum = points.reduce(
    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }),
    { x: 0, y: 0, z: 0 }
  );
  return { x: sum.x / n, y: sum.y / n, z: sum.z / n };
}

// ── Body-Proportional Normalization ──────────────────────────────────────

/**
 * Compute the torso reference length:
 * average of left-shoulder→left-hip and right-shoulder→right-hip distances.
 *
 * This value should be used to normalize all physical measurements
 * so results are body-size and camera-distance agnostic.
 *
 * MediaPipe landmark indices:
 *   11 = left shoulder,  12 = right shoulder
 *   23 = left hip,       24 = right hip
 *
 * @param {Landmark[]} landmarks Full 33-point landmark array
 * @returns {number} Torso length in normalized image coordinates
 */
export function torsoLength(landmarks) {
  const leftLen  = distance3D(landmarks[11], landmarks[23]);
  const rightLen = distance3D(landmarks[12], landmarks[24]);
  return (leftLen + rightLen) / 2;
}

/**
 * Normalize a raw distance by torso length.
 * Returns 1.0 when the distance equals one torso-length.
 *
 * @param {number} rawDistance
 * @param {Landmark[]} landmarks
 * @returns {number}
 */
export function normalizeByTorso(rawDistance, landmarks) {
  const ref = torsoLength(landmarks);
  if (ref === 0) return 0;
  return rawDistance / ref;
}

// ── Velocity Helpers ──────────────────────────────────────────────────────

/**
 * Calculate the Y-axis velocity between two consecutive landmark positions.
 * Positive = moving downward (in image coords where Y increases downward).
 * Negative = moving upward.
 *
 * @param {Landmark} prev Previous frame position
 * @param {Landmark} curr Current frame position
 * @returns {number} Delta Y
 */
export function velocityY(prev, curr) {
  return curr.y - prev.y;
}

/**
 * Smooth a value using exponential moving average (EMA).
 * @param {number} prev  Previous smoothed value
 * @param {number} curr  Current raw value
 * @param {number} alpha Smoothing factor [0..1]; higher = less smoothing
 * @returns {number}
 */
export function ema(prev, curr, alpha = 0.3) {
  return alpha * curr + (1 - alpha) * prev;
}

// ── Coordinate Helpers ────────────────────────────────────────────────────

/**
 * Convert normalized landmark coordinates [0..1] to canvas pixel coordinates.
 * @param {Landmark} lm
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {{ px: number, py: number }}
 */
export function toPixel(lm, canvasWidth, canvasHeight) {
  return {
    px: lm.x * canvasWidth,
    py: lm.y * canvasHeight,
  };
}
