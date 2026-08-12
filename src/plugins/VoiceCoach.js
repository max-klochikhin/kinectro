/**
 * @fileoverview VoiceCoach — Speaks coaching alerts aloud via Web Speech API.
 *
 * Listens to EVENTS.COACHING_ALERT on the EventBus and converts alert text
 * to speech. Designed after Formright's VoiceCoachService but implemented
 * as a clean plugin — zero changes to any existing module required.
 *
 * Behaviour:
 *   - Only speaks 'warn' and 'error' alerts (not 'good' — avoids noise spam).
 *   - Exception: speaks POSITIONING_OK and session-start confirmations.
 *   - Cancels any ongoing utterance before speaking (avoids queue pile-up).
 *   - Per-alert-id cooldown: same message won't repeat within COOLDOWN_MS.
 *   - Silently degrades if SpeechSynthesis is not available.
 *
 * Emits: nothing (output-only plugin)
 */

import { BasePlugin } from './BasePlugin.js';
import { EVENTS } from '../core/EventBus.js';

/** Minimum ms between identical alert IDs being spoken */
const COOLDOWN_MS = 5000;

/**
 * Alert IDs that should always be spoken regardless of type.
 * @type {Set<string>}
 */
const ALWAYS_SPEAK = new Set([
  'positioning-ok',
  'rec-status',
]);

export class VoiceCoach extends BasePlugin {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {object} [options]
   * @param {number} [options.rate=1.05]   Speech rate (0.1–10)
   * @param {number} [options.pitch=1.1]   Pitch (0–2)
   * @param {number} [options.volume=1.0]  Volume (0–1)
   * @param {string} [options.lang='en-US'] BCP 47 language tag
   */
  constructor(bus, options = {}) {
    super(bus, 'VoiceCoach');

    this._supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

    if (!this._supported) {
      console.warn('[VoiceCoach] Web Speech API not available — voice disabled.');
    }

    this._rate   = options.rate   ?? 1.05;
    this._pitch  = options.pitch  ?? 1.1;
    this._volume = options.volume ?? 1.0;
    this._lang   = options.lang   ?? 'en-US';

    /** @type {Map<string, number>} Last spoken timestamp per alert id */
    this._lastSpoken = new Map();

    // Subscribe to coaching alerts
    this._alertUnsub = bus.on(EVENTS.COACHING_ALERT, (alert) => {
      this._handleAlert(alert);
    });
  }

  /**
   * Decide whether to speak an alert and do so.
   * @param {{ id: string, type: string, text: string, timestamp: number }} alert
   */
  _handleAlert({ id, type, text, timestamp }) {
    if (!this._supported || !this.enabled) return;

    const shouldSpeak =
      ALWAYS_SPEAK.has(id) ||
      type === 'warn' ||
      type === 'error';

    if (!shouldSpeak) return;

    // Per-id cooldown
    const last = this._lastSpoken.get(id) ?? 0;
    if (timestamp - last < COOLDOWN_MS) return;
    this._lastSpoken.set(id, timestamp);

    this._speak(text);
  }

  /**
   * Speak a string via SpeechSynthesis.
   * @param {string} text
   */
  _speak(text) {
    if (!this._supported) return;

    // Cancel any ongoing speech immediately
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate   = this._rate;
    utterance.pitch  = this._pitch;
    utterance.volume = this._volume;
    utterance.lang   = this._lang;

    window.speechSynthesis.speak(utterance);
  }

  onReset() {
    if (this._supported) {
      window.speechSynthesis.cancel();
    }
    this._lastSpoken.clear();
  }

  destroy() {
    super.destroy();
    if (this._alertUnsub) this._alertUnsub();
    if (this._supported) window.speechSynthesis.cancel();
  }
}
