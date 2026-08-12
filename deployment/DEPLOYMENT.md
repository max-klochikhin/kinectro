# Kinectro — Deployment Guide

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML + CSS + JS (ES Modules) |
| AI model | MediaPipe PoseLandmarker (local `.task` or CDN fallback) |
| Hosting | Vercel (static site) |
| Repository | https://github.com/max-klochikhin/kinectro |
| Production URL | https://kinectro.vercel.app |

> **Important:** the camera API in browsers only works over **HTTPS**. Vercel provides SSL for free — that's why it was chosen.

---

## First Deploy (from scratch)

### 1. Install Vercel CLI
```bash
npm install -g vercel
```

### 2. Log in
```bash
vercel login
# A browser window will open — confirm via GitHub or email
```

### 3. Deploy to production
```bash
cd /path/to/kinectro
vercel --prod --yes
```

Vercel will automatically detect this as a static site (no `package.json`),
serve the current directory, and create the `kinectro.vercel.app` alias.

---

## Updating Production

After any code changes:

```bash
# 1. Commit changes
git add .
git commit -m "feat: describe the change"
git push origin main

# 2. Deploy
vercel --prod --yes
```

Or set up auto-deploy via GitHub (see below) — then step 2 is not needed.

---

## Auto-deploy via GitHub

1. Open [vercel.com/max-klochikhins-projects/kinectro](https://vercel.com/max-klochikhins-projects/kinectro)
2. Settings → Git → Connect Repository → `max-klochikhin/kinectro`
3. After that, every `git push origin main` will automatically trigger a deployment

---

## Local Development

Kinectro is a static site — no build step needed. Any HTTP server works:

```bash
# Python (built into macOS)
cd /path/to/kinectro
python3 -m http.server 8081
# → http://localhost:8081

# Or via npx
npx serve . -p 8081
```

> The camera works on `localhost` during local development — browsers treat it as a secure origin.

---

## AI Model (MediaPipe)

The app tries to load the model locally first, falling back to CDN if not found:

| Path | Description |
|------|-------------|
| `src/models/pose_landmarker_lite.task` | Local model (~5 MB), works offline |
| CDN fallback | `storage.googleapis.com/mediapipe-models/...` |

To enable offline mode — place the model in `src/models/`. Download command:
```bash
curl -L -o src/models/pose_landmarker_lite.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
```

---

## Vercel — Useful Commands

```bash
vercel whoami                  # check login status
vercel ls                      # list deployments
vercel inspect <deploy-url>    # inspect a specific deployment
vercel rollback                # roll back to the previous deployment
vercel alias <deploy-url> kinectro.vercel.app  # manually switch alias
```

---

## Project Structure

```
kinectro/
├── index.html               # entry point
├── style.css
├── src/
│   ├── app.js               # app initializer and orchestrator
│   ├── core/
│   │   ├── EventBus.js      # pub/sub event bus
│   │   └── VectorMath.js    # pose math utilities
│   ├── plugins/             # analytical modules (one feature per plugin)
│   │   ├── BasePlugin.js
│   │   ├── JumpCounter.js
│   │   ├── SquatCounter.js
│   │   ├── SquatValidator.js
│   │   ├── PositioningValidator.js
│   │   ├── VoiceCoach.js
│   │   ├── SessionGoal.js
│   │   ├── AccuracyTrend.js
│   │   ├── DTWComparator.js
│   │   ├── ElbowValidator.js
│   │   └── ReferenceRecorder.js
│   ├── data/
│   │   └── reference_skipping.json   # reference motion data for DTW
│   └── models/
│       └── pose_landmarker_lite.task # (optional) local AI model
├── playground/
│   └── calls.html           # UI experiments
├── deployment/
│   ├── DEPLOYMENT.md        # this file
│   └── deploy.sh            # one-command deploy script
└── research/
    └── formright/           # Formright APK reverse engineering materials
```
