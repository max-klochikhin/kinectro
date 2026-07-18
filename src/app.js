/**
 * @fileoverview app.js — Main Orchestrator for Kinectro Phase 0
 *
 * Responsibilities:
 *   1. Initialize MediaPipe Tasks Vision PoseLandmarker (WASM, on-device).
 *   2. Open camera stream via getUserMedia.
 *   3. Run a requestAnimationFrame loop:
 *        a. Feed the current video frame to PoseLandmarker.
 *        b. Draw the skeleton overlay on the canvas.
 *        c. Publish raw landmarks to the EventBus.
 *   4. Wire up UI event listeners (reset, skeleton toggle).
 *   5. Consume EventBus events to update HUD elements.
 *
 * MediaPipe model: place pose_landmarker_lite.task in /src/models/
 * See README.md for the download command.
 */

import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm';
import { EventBus, EVENTS } from './core/EventBus.js';
import { JumpCounter }    from './plugins/JumpCounter.js';
import { ElbowValidator } from './plugins/ElbowValidator.js';
import { DTWComparator }  from './plugins/DTWComparator.js';

// ── MediaPipe BlazePose connections for skeleton drawing ─────────────────
// Each pair is [from, to] landmark index
const POSE_CONNECTIONS = [
  // Face
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  // Torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left arm
  [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  // Right arm
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // Left leg
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  // Right leg
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

// Skeleton segment colors — grouped by body region
const SEGMENT_COLORS = {
  face:    'rgba(148, 163, 184, 0.7)',
  torso:   'rgba(0, 210, 255, 0.85)',
  armL:    'rgba(0, 245, 160, 0.9)',
  armR:    'rgba(168, 85, 247, 0.9)',
  legL:    'rgba(0, 245, 160, 0.75)',
  legR:    'rgba(168, 85, 247, 0.75)',
};

function connectionColor(from, to) {
  if (from <= 8  && to <= 8)  return SEGMENT_COLORS.face;
  if ((from === 11 || from === 12) && (to === 11 || to === 12 || to === 23 || to === 24)) return SEGMENT_COLORS.torso;
  if (from === 23 && to === 24) return SEGMENT_COLORS.torso;
  if ([11, 13, 15, 17, 19, 21].includes(from) || [13, 15, 17, 19, 21].includes(to)) return SEGMENT_COLORS.armL;
  if ([12, 14, 16, 18, 20, 22].includes(from) || [14, 16, 18, 20, 22].includes(to)) return SEGMENT_COLORS.armR;
  if ([23, 25, 27, 29, 31].includes(from) || [25, 27, 29, 31].includes(to)) return SEGMENT_COLORS.legL;
  return SEGMENT_COLORS.legR;
}

// ── State ─────────────────────────────────────────────────────────────────
let poseLandmarker = null;
let animFrameId    = null;
let showSkeleton   = true;
let lastVideoTime  = -1;

/** @type {import('./core/EventBus.js').EventBus} */
let bus;

/** Plugins */
let jumpCounter;
let elbowValidator;
let dtwComparator;

/** Mini rhythm graph data */
const graphData = new Array(60).fill(0.5);

/** FPS counter state */
let fpsFrameCount = 0;
let fpsLastTime   = performance.now();

// ── DOM Refs ──────────────────────────────────────────────────────────────
const $loadingOverlay  = document.getElementById('loading-overlay');
const $loadingStatus   = document.getElementById('loading-status');
const $app             = document.getElementById('app');
const $video           = document.getElementById('camera-video');
const $canvas          = document.getElementById('pose-canvas');
const $ctx             = $canvas.getContext('2d');
const $jumpCount       = document.getElementById('jump-count');
const $jumpBest        = document.getElementById('jump-best');
const $accuracyValue   = document.getElementById('accuracy-value');
const $accuracyBarFill = document.getElementById('accuracy-bar-fill');
const $accuracyBarTrack= document.getElementById('accuracy-bar-track');
const $velocityValue   = document.getElementById('velocity-value');
const $alertsList      = document.getElementById('alerts-list');
const $dtwValue        = document.getElementById('dtw-value');
const $fpsCounter      = document.getElementById('fps-counter');
const $noPoseBadge     = document.getElementById('no-pose-badge');
const $jumpFlash       = document.getElementById('jump-flash');
const $miniGraph       = document.getElementById('mini-graph');
const $miniCtx         = $miniGraph.getContext('2d');
const $btnReset        = document.getElementById('btn-reset');
const $btnToggleSkel   = document.getElementById('btn-toggle-skeleton');

/** Session best jump count */
let sessionBest = 0;

// ─────────────────────────────────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────

async function init() {
  setLoadingStatus('Loading AI vision runtime…');

  try {
    // Step 1: Resolve MediaPipe WASM fileset
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    setLoadingStatus('Loading pose model…');

    // Step 2: Initialize PoseLandmarker
    // Attempts local model first, falls back to CDN
    poseLandmarker = await createPoseLandmarker(vision);

    setLoadingStatus('Opening camera…');

    // Step 3: Open camera stream
    await openCamera();

    setLoadingStatus('Wiring plugins…');

    // Step 4: Set up EventBus + plugins
    bus = new EventBus();
    jumpCounter    = new JumpCounter(bus);
    elbowValidator = new ElbowValidator(bus);
    dtwComparator  = new DTWComparator(bus);

    // Step 5: Wire up UI event consumers
    wireUIConsumers();
    wireControls();

    // Step 6: Start the main loop
    showApp();
    requestAnimationFrame(renderLoop);

  } catch (err) {
    setLoadingStatus(`❌ Error: ${err.message}`);
    console.error('[app.js] Initialization failed:', err);
  }
}

/**
 * Create PoseLandmarker — tries local model, falls back to remote CDN.
 * @param {*} vision FilesetResolver result
 */
async function createPoseLandmarker(vision) {
  const localModelPath = './src/models/pose_landmarker_lite.task';

  // Try local model first (preferred for offline use)
  try {
    const lm = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: localModelPath,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
    console.info('[app.js] Loaded local model from', localModelPath);
    return lm;
  } catch (localErr) {
    console.warn('[app.js] Local model not found, falling back to CDN…', localErr.message);
    setLoadingStatus('Downloading model (first run, ~5MB)…');

    return await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    });
  }
}

/**
 * Open the device camera using getUserMedia.
 * Prefers the back camera on mobile, front camera on desktop.
 */
async function openCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width:  { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      facingMode: 'user',
    },
    audio: false,
  });

  $video.srcObject = stream;

  return new Promise((resolve, reject) => {
    $video.onloadedmetadata = () => {
      $video.play().then(resolve).catch(reject);
    };
    $video.onerror = reject;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN RENDER LOOP
// ─────────────────────────────────────────────────────────────────────────

function renderLoop(now) {
  animFrameId = requestAnimationFrame(renderLoop);

  // Update FPS counter
  fpsFrameCount++;
  if (now - fpsLastTime >= 1000) {
    $fpsCounter.textContent = `${fpsFrameCount} FPS`;
    fpsFrameCount = 0;
    fpsLastTime = now;
  }

  // Skip if video isn't ready
  if ($video.readyState < 2) return;

  // Sync canvas size to video layout size
  const { offsetWidth, offsetHeight } = $video;
  if ($canvas.width !== offsetWidth || $canvas.height !== offsetHeight) {
    $canvas.width  = offsetWidth;
    $canvas.height = offsetHeight;
  }

  // Only run detection if video frame has advanced
  if ($video.currentTime === lastVideoTime) return;
  lastVideoTime = $video.currentTime;

  // Run MediaPipe pose detection
  const result = poseLandmarker.detectForVideo($video, now);

  // Clear canvas
  $ctx.clearRect(0, 0, $canvas.width, $canvas.height);

  const hasPose = result.landmarks && result.landmarks.length > 0;
  $noPoseBadge.hidden = hasPose;

  if (hasPose) {
    const landmarks = result.landmarks[0];
    const worldLandmarks = result.worldLandmarks?.[0] ?? null;

    // Draw skeleton overlay
    if (showSkeleton) {
      drawSkeleton(landmarks);
    }

    // Publish frame to EventBus → plugins receive it
    bus.emit(EVENTS.FRAME, {
      landmarks,
      worldLandmarks,
      timestamp: now,
    });

    // Update mini rhythm graph with hip Y
    const hipY = (landmarks[23].y + landmarks[24].y) / 2;
    graphData.push(hipY);
    if (graphData.length > 60) graphData.shift();
    drawMiniGraph();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SKELETON DRAWING
// ─────────────────────────────────────────────────────────────────────────

function drawSkeleton(landmarks) {
  const w = $canvas.width;
  const h = $canvas.height;

  $ctx.save();
  $ctx.lineCap  = 'round';
  $ctx.lineJoin = 'round';

  // Draw connections
  for (const [from, to] of POSE_CONNECTIONS) {
    const a = landmarks[from];
    const b = landmarks[to];
    if (!a || !b) continue;

    const visOk = (a.visibility ?? 1) > 0.3 && (b.visibility ?? 1) > 0.3;
    if (!visOk) continue;

    const ax = a.x * w, ay = a.y * h;
    const bx = b.x * w, by = b.y * h;

    $ctx.beginPath();
    $ctx.moveTo(ax, ay);
    $ctx.lineTo(bx, by);
    $ctx.strokeStyle = connectionColor(from, to);
    $ctx.lineWidth   = 3;
    $ctx.stroke();
  }

  // Draw landmark dots
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    if (!lm || (lm.visibility ?? 1) < 0.3) continue;

    const x = lm.x * w;
    const y = lm.y * h;

    // Glow circle
    $ctx.beginPath();
    $ctx.arc(x, y, 5, 0, Math.PI * 2);
    $ctx.fillStyle = 'rgba(0, 245, 160, 0.15)';
    $ctx.fill();

    // Core dot
    $ctx.beginPath();
    $ctx.arc(x, y, 3, 0, Math.PI * 2);
    $ctx.fillStyle = '#00f5a0';
    $ctx.fill();
  }

  $ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────
// MINI RHYTHM GRAPH
// ─────────────────────────────────────────────────────────────────────────

function drawMiniGraph() {
  const w = $miniGraph.width;
  const h = $miniGraph.height;
  const ctx = $miniCtx;

  ctx.clearRect(0, 0, w, h);

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(168, 85, 247, 0.08)');
  bg.addColorStop(1, 'transparent');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  if (graphData.length < 2) return;

  // Normalize the data to [0..1] range using min/max of the window
  const min = Math.min(...graphData);
  const max = Math.max(...graphData);
  const range = max - min || 0.01;

  ctx.beginPath();

  for (let i = 0; i < graphData.length; i++) {
    // Y is inverted: lower hipY (body up) = higher on graph
    const normalizedY = 1 - (graphData[i] - min) / range;
    const x = (i / (graphData.length - 1)) * w;
    const y = normalizedY * h;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  // Gradient fill under line
  const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
  fillGrad.addColorStop(0, 'rgba(168, 85, 247, 0.4)');
  fillGrad.addColorStop(1, 'rgba(168, 85, 247, 0)');

  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth   = 2;
  ctx.stroke();

  // Fill area under curve
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = fillGrad;
  ctx.fill();
}

// ─────────────────────────────────────────────────────────────────────────
// UI CONSUMERS — connect EventBus events to DOM
// ─────────────────────────────────────────────────────────────────────────

function wireUIConsumers() {
  // ── Jump counted ────────────────────────────────────────────────────
  bus.on(EVENTS.JUMP_COUNTED, ({ count, rpm }) => {
    $jumpCount.textContent = count;

    // Animate the number
    $jumpCount.classList.remove('bump');
    void $jumpCount.offsetWidth; // force reflow
    $jumpCount.classList.add('bump');

    // Flash overlay
    $jumpFlash.classList.remove('active');
    void $jumpFlash.offsetWidth;
    $jumpFlash.classList.add('active');

    // Update RPM
    $velocityValue.textContent = rpm > 0 ? rpm : '—';

    // Update best
    if (count > sessionBest) {
      sessionBest = count;
      $jumpBest.textContent = sessionBest;
    }
  });

  // ── DTW score ───────────────────────────────────────────────────────
  bus.on(EVENTS.DTW_SCORE, ({ delta, accuracy }) => {
    $dtwValue.textContent    = delta;
    $accuracyValue.textContent = accuracy;

    // Update progress bar
    $accuracyBarFill.style.width = `${accuracy}%`;
    $accuracyBarTrack.setAttribute('aria-valuenow', accuracy);

    // Color the bar based on accuracy
    if (accuracy >= 80) {
      $accuracyBarFill.style.background = 'linear-gradient(90deg, #00d2ff, #00f5a0)';
    } else if (accuracy >= 50) {
      $accuracyBarFill.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
    } else {
      $accuracyBarFill.style.background = 'linear-gradient(90deg, #f43f5e, #fb7185)';
    }
  });

  // ── Coaching alerts ─────────────────────────────────────────────────
  /** @type {Map<string, HTMLLIElement>} Active alert items by ID */
  const activeAlerts = new Map();
  const MAX_ALERTS = 4;

  bus.on(EVENTS.COACHING_ALERT, ({ id, type, icon, text, timestamp }) => {
    // Remove existing alert with same ID (replace it)
    if (activeAlerts.has(id)) {
      activeAlerts.get(id).remove();
      activeAlerts.delete(id);
    }

    // Remove the idle placeholder
    const idlePlaceholder = $alertsList.querySelector('.alert-item--idle');
    if (idlePlaceholder) idlePlaceholder.remove();

    // Enforce max alerts
    while (activeAlerts.size >= MAX_ALERTS) {
      const firstKey = activeAlerts.keys().next().value;
      activeAlerts.get(firstKey).remove();
      activeAlerts.delete(firstKey);
    }

    const li = document.createElement('li');
    li.className = `alert-item alert-item--${type}`;
    li.dataset.alertId = id;
    li.innerHTML = `
      <span class="alert-icon" aria-hidden="true">${icon}</span>
      <span class="alert-text">${text}</span>
    `;
    $alertsList.appendChild(li);
    activeAlerts.set(id, li);

    // Auto-expire good alerts after 4s
    if (type === 'good') {
      setTimeout(() => {
        if (activeAlerts.get(id) === li) {
          li.style.opacity = '0';
          li.style.transition = 'opacity 500ms';
          setTimeout(() => {
            li.remove();
            activeAlerts.delete(id);
            if ($alertsList.children.length === 0) {
              restoreIdlePlaceholder();
            }
          }, 500);
        }
      }, 4000);
    }
  });
}

function restoreIdlePlaceholder() {
  const li = document.createElement('li');
  li.className = 'alert-item alert-item--idle';
  li.innerHTML = `
    <span class="alert-icon">👋</span>
    <span class="alert-text">Start jumping to begin analysis</span>
  `;
  $alertsList.appendChild(li);
}

// ─────────────────────────────────────────────────────────────────────────
// CONTROLS
// ─────────────────────────────────────────────────────────────────────────

function wireControls() {
  // Reset session
  $btnReset.addEventListener('click', () => {
    // Reset plugin state
    bus.emit(EVENTS.SESSION_RESET, { timestamp: performance.now() });

    // Reset HUD
    $jumpCount.textContent     = '0';
    $velocityValue.textContent = '—';
    $accuracyValue.textContent = '—';
    $dtwValue.textContent      = '—';
    $accuracyBarFill.style.width = '0%';

    // Clear alerts
    $alertsList.innerHTML = '';
    restoreIdlePlaceholder();

    graphData.fill(0.5);
    drawMiniGraph();
  });

  // Toggle skeleton overlay
  $btnToggleSkel.addEventListener('click', () => {
    showSkeleton = !showSkeleton;
    $btnToggleSkel.setAttribute('aria-pressed', String(showSkeleton));
    $btnToggleSkel.style.color = showSkeleton ? '' : 'var(--clr-text-dim)';
  });
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function setLoadingStatus(msg) {
  $loadingStatus.textContent = msg;
}

function showApp() {
  $loadingOverlay.style.opacity = '0';
  $loadingOverlay.style.transition = 'opacity 600ms ease';
  setTimeout(() => {
    $loadingOverlay.hidden = true;
  }, 600);
  $app.hidden = false;
}

// ─────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────

init();
