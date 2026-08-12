/**
 * @fileoverview SessionGoal — Tracks progress toward a user-defined rep target.
 *
 * Listens to JUMP_COUNTED and emits progress updates + GOAL_REACHED when
 * the target is hit. Also emits milestone coaching alerts (25%, 50%, 75%).
 *
 * Emits:
 *   EVENTS.GOAL_REACHED   — { target, timestamp } when count === target
 *   EVENTS.COACHING_ALERT — milestone messages ("Halfway there!", etc.)
 */

import { BasePlugin } from './BasePlugin.js';
import { EVENTS } from '../core/EventBus.js';

/** Rep counts for milestone alerts (fractions of target) */
const MILESTONES = [0.25, 0.5, 0.75];

export class SessionGoal extends BasePlugin {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {number} [target=30] Initial rep target
   */
  constructor(bus, target = 30) {
    super(bus, 'SessionGoal');

    /** @type {number} Rep target for this session */
    this.target = target;

    /** @type {boolean} Whether the goal has been reached this session */
    this._reached = false;

    /** @type {Set<number>} Which milestone fractions have already been announced */
    this._announcedMilestones = new Set();

    // SessionGoal doesn't process FRAME events — disable the base subscription
    this.disable();

    // Subscribe to universal rep event (covers all exercises)
    this._repUnsub = bus.on(EVENTS.REP_COUNTED, ({ count, timestamp }) => {
      this._onJump(count, timestamp);
    });

    // Also handle skipping (which emits both JUMP_COUNTED and REP_COUNTED — dedupe via count)
    this._lastCount = 0;
  }

  /**
   * Update the rep target (called from UI controls).
   * @param {number} target
   */
  setTarget(target) {
    this.target = Math.max(1, Math.round(target));
    this._reached = false;
    this._announcedMilestones.clear();
  }

  onReset() {
    this._reached = false;
    this._announcedMilestones.clear();
  }

  /**
   * @param {number} count  Current jump count
   * @param {number} timestamp
   */
  _onJump(count, timestamp) {
    if (this._reached || this.target <= 0) return;

    const progress = count / this.target;

    // Milestone alerts
    for (const fraction of MILESTONES) {
      if (!this._announcedMilestones.has(fraction) && progress >= fraction) {
        this._announcedMilestones.add(fraction);
        this._emitMilestone(fraction, count, timestamp);
      }
    }

    // Goal reached
    if (count >= this.target) {
      this._reached = true;
      this.bus.emit(EVENTS.GOAL_REACHED, { target: this.target, timestamp });
      this.bus.emit(EVENTS.COACHING_ALERT, {
        id: 'goal-reached',
        type: 'good',
        icon: '🎉',
        text: `Goal reached! ${this.target} jumps done!`,
        timestamp,
      });
    }
  }

  /**
   * @param {number} fraction  0.25 / 0.5 / 0.75
   * @param {number} count
   * @param {number} timestamp
   */
  _emitMilestone(fraction, count, timestamp) {
    const messages = {
      0.25: { icon: '💪', text: `${count} down — keep going!` },
      0.5:  { icon: '🔥', text: 'Halfway there — keep going!' },
      0.75: { icon: '⚡', text: 'Almost there — final push!' },
    };
    const m = messages[fraction];
    if (!m) return;
    this.bus.emit(EVENTS.COACHING_ALERT, {
      id: `milestone-${fraction}`,
      type: 'good',
      ...m,
      timestamp,
    });
  }

  destroy() {
    super.destroy();
    if (this._repUnsub) this._repUnsub();
  }
}
