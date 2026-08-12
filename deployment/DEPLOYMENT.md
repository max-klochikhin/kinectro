# Kinectro — Deployment Guide

## Stack

| Слой | Технология |
|------|-----------|
| Фронтенд | Vanilla HTML + CSS + JS (ES Modules) |
| AI модель | MediaPipe PoseLandmarker (локальный `.task` или CDN) |
| Хостинг | Vercel (static site) |
| Репозиторий | https://github.com/max-klochikhin/kinectro |
| Прод URL | https://kinectro.vercel.app |

> **Важно:** камера в браузере работает **только по HTTPS**. Vercel даёт SSL бесплатно — поэтому он выбран как хостинг.

---

## Первый деплой (с нуля)

### 1. Установить Vercel CLI
```bash
npm install -g vercel
```

### 2. Залогиниться
```bash
vercel login
# Откроется браузер — подтвердить вход через GitHub/email
```

### 3. Задеплоить в продакшн
```bash
cd /path/to/kinectro
vercel --prod --yes
```

Vercel автоматически определит что это статический сайт (нет `package.json`),
выложит папку `.` и создаст алиас `kinectro.vercel.app`.

---

## Обновление продакшна

После любых изменений в коде:

```bash
# 1. Закоммитить изменения
git add .
git commit -m "feat: описание изменения"
git push origin main

# 2. Задеплоить
vercel --prod --yes
```

Или настроить автодеплой через GitHub (см. ниже) — тогда шаг 2 не нужен.

---

## Автодеплой через GitHub

1. Открыть [vercel.com/max-klochikhins-projects/kinectro](https://vercel.com/max-klochikhins-projects/kinectro)
2. Settings → Git → Connect Repository → `max-klochikhin/kinectro`
3. После этого каждый `git push origin main` автоматически триггерит деплой

---

## Локальная разработка

Kinectro — статический сайт, сборщик не нужен. Достаточно любого HTTP-сервера:

```bash
# Python (встроен в macOS)
cd /path/to/kinectro
python3 -m http.server 8081
# → http://localhost:8081

# Или через npx
npx serve . -p 8081
```

> Для работы камеры при локальной разработке используй `localhost` (браузеры считают его безопасным).

---

## AI-модель (MediaPipe)

Приложение пытается загрузить модель локально, при неудаче — с CDN:

| Путь | Описание |
|------|----------|
| `src/models/pose_landmarker_lite.task` | Локальная модель (~5 MB), работает офлайн |
| CDN fallback | `storage.googleapis.com/mediapipe-models/...` |

Если нужен офлайн-режим — положи модель в `src/models/`. Скачать:
```bash
curl -L -o src/models/pose_landmarker_lite.task \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
```

---

## Vercel — полезные команды

```bash
vercel whoami                  # проверить авторизацию
vercel ls                      # список деплоев
vercel inspect <deploy-url>    # детали конкретного деплоя
vercel rollback                # откатиться на предыдущий деплой
vercel alias <deploy-url> kinectro.vercel.app  # переключить алиас вручную
```

---

## Структура проекта

```
kinectro/
├── index.html               # точка входа
├── style.css
├── src/
│   ├── app.js               # инициализация, оркестратор
│   ├── core/
│   │   ├── EventBus.js      # pub/sub шина событий
│   │   └── VectorMath.js    # утилиты для работы с позами
│   ├── plugins/             # аналитические модули (по одному на фичу)
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
│   │   └── reference_skipping.json   # эталонное движение для DTW
│   └── models/
│       └── pose_landmarker_lite.task # (опционально) локальная модель
├── playground/
│   └── calls.html           # UI-эксперименты
├── deployment/
│   └── DEPLOYMENT.md        # этот файл
└── research/
    └── formright/           # материалы reverse engineering Formright APK
```
