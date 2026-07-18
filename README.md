# Kinectro — Phase 0 Local Web MVP

> **Gamified real-time motion coaching for children**  
> On-device AI pose analysis · Zero servers · MediaPipe Tasks WebAssembly

---

## Prerequisites

| Requirement | Details |
|---|---|
| **Browser** | Chrome 90+ or Edge 90+ (required for WASM + camera) |
| **Python 3** | For the local dev server (built-in) |
| **Camera** | Laptop webcam or USB camera |

> ⚠️ **Safari is not supported** — WebAssembly SIMD and camera permissions behave differently. Use Chrome or Edge.

---

## Quick Start

### 1. Download the MediaPipe Pose Model

The model binary (~5MB) is not included in the repository. Run **one** of the following:

**Option A — curl (fastest):**
```bash
curl -L \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task" \
  -o src/models/pose_landmarker_lite.task
```

**Option B — wget:**
```bash
wget -O src/models/pose_landmarker_lite.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
```

**Option C — skip download (CDN fallback):**  
The app will automatically download the model from Google's CDN on first run if the local file is missing. This requires an internet connection on first launch only.

---

### 2. Start a Local Web Server

The app uses ES6 Modules (`type="module"`) which require HTTP — you cannot open `index.html` directly from the filesystem.

**Option A — Python 3 (no install required):**
```bash
python3 -m http.server 8080
```

**Option B — Node.js `serve`:**
```bash
npx serve . -p 8080
```

**Option C — Docker + Nginx (production-equivalent):**
```bash
docker run --rm -p 8080:80 -v "$(pwd)":/usr/share/nginx/html:ro nginx:alpine
```

### 3. Open the App

```
http://localhost:8080
```

Allow camera permissions when prompted. Stand 1.5–2m from the camera, ensuring your full body is visible.

---

## Project Structure

```
kinectro/
├── index.html                        # Main UI layout
├── style.css                         # Dark glassmorphism stylesheet
├── README.md                         # This file
└── src/
    ├── app.js                        # Main orchestrator (MediaPipe + camera + rAF loop)
    ├── core/
    │   ├── EventBus.js               # Pub/Sub event bus (60fps optimized)
    │   └── VectorMath.js             # 3D angle, distance, normalization helpers
    ├── models/
    │   └── pose_landmarker_lite.task # MediaPipe model (download separately)
    ├── data/
    │   └── reference_skipping.json   # Reference jump cycle time-series
    └── plugins/
        ├── BasePlugin.js             # Abstract base class
        ├── JumpCounter.js            # Rep counting via hip Y-axis velocity
        ├── ElbowValidator.js         # 3D elbow angle form checker
        └── DTWComparator.js          # Dynamic Time Warping phase matcher
```

---

## Architecture

The system is built as an **event-driven plugin pipeline**:

```
[Camera Stream]
      │
      ▼
[MediaPipe WASM PoseLandmarker]   ← runs on GPU via WebGL delegate
      │ 33 normalized landmarks {x, y, z, visibility}
      ▼
[EventBus.emit('frame', landmarks)]
      │
      ├─► [JumpCounter]    → counts reps, emits RPM
      ├─► [ElbowValidator] → monitors arm angles
      └─► [DTWComparator]  → compares vs reference session
              │
              ▼
         [HUD UI] ← purely reactive to EventBus events
```

### Adding a New Plugin

1. Create `src/plugins/MyPlugin.js`
2. Extend `BasePlugin` and implement `onFrame(landmarks, timestamp)`:

```js
import { BasePlugin } from './BasePlugin.js';

export class MyPlugin extends BasePlugin {
  constructor(bus) {
    super(bus, 'MyPlugin');
  }

  onFrame(landmarks, timestamp) {
    // Your analysis logic here
    // landmarks[N] = { x, y, z, visibility }
    // Emit results: this.bus.emit('my:event', { ... })
  }

  onReset() {
    // Clear your plugin state when session resets
  }
}
```

3. Register it in `src/app.js`:
```js
import { MyPlugin } from './plugins/MyPlugin.js';
// ... inside init():
const myPlugin = new MyPlugin(bus);
```

---

## MediaPipe Landmark Reference

| Index | Name | Index | Name |
|---|---|---|---|
| 0 | Nose | 12 | Right Shoulder |
| 11 | Left Shoulder | 13 | Left Elbow |
| 14 | Right Elbow | 15 | Left Wrist |
| 16 | Right Wrist | 23 | Left Hip |
| 24 | Right Hip | 25 | Left Knee |
| 26 | Right Knee | 27 | Left Ankle |
| 28 | Right Ankle | — | — |

Full reference: https://developers.google.com/mediapipe/solutions/vision/pose_landmarker

---

## HUD Features

| Widget | Description |
|---|---|
| **Jumps** | Live rep counter + session best |
| **Form %** | DTW accuracy score vs. reference session |
| **Rhythm** | Jumps per minute + hip oscillation graph |
| **Coaching** | Real-time alerts from all active plugins |
| **Phase Δ** | Raw DTW deviation from master session |

---

## Roadmap

| Phase | Status | Description |
|---|---|---|
| **0 — Web MVP** | ✅ Current | Vanilla JS, MediaPipe WASM, local camera |
| **1 — Mobile Core** | 🔜 Planned | Flutter / React Native wrapper |
| **2 — Gamification** | 🔜 Planned | Avatar blendshapes, child-facing UX |
| **3 — Backend-Light** | 🔜 Planned | RevenueCat, SQLite session persistence |

---

## Troubleshooting

**Camera permission denied**  
→ Allow camera in browser settings. Reload the page.

**"WASM compilation failed" or blank screen**  
→ Ensure you're using Chrome or Edge, not Safari or Firefox.

**Model download fails**  
→ Run `curl` download manually (see Step 1) and place the file at `src/models/pose_landmarker_lite.task`.

**Jump counter not firing**  
→ Ensure your full body (head to ankles) is visible. Stand 1.5–2m from the camera.

**Low FPS**  
→ The app prefers GPU delegate. If your GPU is unavailable, it falls back to CPU. Try closing other browser tabs.

---

## License

MIT — Built for the Kinectro Phase 0 proof-of-concept.
