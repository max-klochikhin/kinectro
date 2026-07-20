# Formright APK — Reverse Engineering Analysis

> **Note:** This repo is private. These files are for internal research only.
> Do not redistribute or use code directly in any commercial product.

## App Info

| Field | Value |
|---|---|
| Package | `app.wiztech.formright` |
| Version | See `manifest.json` |
| Technology | **Flutter** (AOT compiled, Dart → native) |
| Pose Detection | **Google ML Kit** (BlazePose / `pose_detection`) |
| Models | TFLite (see `asset_listing.txt`) |

## Architecture

Flutter app with a modular Dart codebase. Since Dart is AOT compiled to `libapp.so`,
the actual source code is not recoverable — only string literals and class names via binary analysis.

### Core Modules (inferred from strings/assets)

```
features/
  camera/data/         – Camera feed, permissions, frame capture
  exercise_engine/
    rules/             – Per-exercise form-check logic
    rep_counter/       – RepStateMachine (state: down → bottom → up → peak)
  motion_engine/data/  – ML Kit pose result processing
  coaching/            – VoiceCoachService, feedback messages
  positioning/         – PositioningValidator (user framing guide)
core/
  math/                – Angle calculations, vector ops
  vision/              – Landmark extraction from ML Kit results
```

## Key Algorithms

### Repetition Counter — State Machine

Tracks phases of a movement:
```
going_down → bottom → going_up → peak → (repeat)
```
- Based on primary landmark Y-position crossing thresholds
- Counts a full rep on `peak → going_down` transition
- Anti-jitter: requires threshold to be crossed by a margin

### Exercise Rules

Per-exercise classes with configurable thresholds. Verified exercises:
- **Squat** — knee angle, hip angle, torso lean
- **Push-up** — elbow angle, hip sag
- **Lunge** — knee alignment, hip drop
- **Deadlift** — back angle, knee tracking
- And more (see coaching messages below)

### Strictness Modes

| Mode | Threshold multiplier |
|---|---|
| Beginner | relaxed (~0.7×) |
| Standard | 1.0× |
| Advanced | stricter (~1.3×) |
| Strict | strictest (~1.6×) |

### Key Landmarks Used

ML Kit BlazePose landmarks used in rules:
- `LEFT_HIP`, `RIGHT_HIP` — rep counter baseline
- `LEFT_KNEE`, `RIGHT_KNEE` — squat depth, lunge form
- `LEFT_ELBOW`, `RIGHT_ELBOW` — push-up angle
- `LEFT_SHOULDER`, `RIGHT_SHOULDER` — torso position
- `LEFT_ANKLE`, `RIGHT_ANKLE` — foot placement
- `LEFT_WRIST`, `RIGHT_WRIST` — overhead position

## Coaching Feedback Strings (extracted)

Form errors (verbal + on-screen):
```
"Go deeper"
"Keep torso still"
"Uneven hips"
"Don't let knees cave in"
"Keep your back straight"
"Slow down on the way down"
"Full range of motion"
"Keep elbows closer to body"
"Don't flare elbows"
"Land softly"
"Feet too narrow / too wide"
"Toes pointing out too much"
```

Positioning guide:
```
"Move back"
"Move closer"
"Step left / right"
"Full body should be visible"
"Center yourself in frame"
```

## Included Files

| File | Description |
|---|---|
| `AndroidManifest.xml` | App permissions, activities, services |
| `manifest.json` | XAPK package manifest |
| `strings.xml` | Android resource strings (UI labels) |
| `asset_listing.txt` | Full list of bundled assets (models, fonts, etc.) |
| `decompiled_java/` | Decompiled Java wrapper (Flutter boilerplate, minimal insight) |

## Takeaways for Kinectro

1. **RepStateMachine** — implement the same 4-phase state machine for rep counting
2. **Per-exercise strictness** — configurable threshold multipliers via a settings slider
3. **Positioning validator** — show guidance overlay before session starts
4. **Coaching messages** — use short, specific verbal cues (not generic "good job")
5. **Landmark focus** — hips as primary rep-count anchor, angles at joints for form
6. **ML Kit vs MediaPipe** — Formright uses ML Kit; Kinectro uses MediaPipe Tasks. Both use BlazePose architecture, landmark indices are compatible.
