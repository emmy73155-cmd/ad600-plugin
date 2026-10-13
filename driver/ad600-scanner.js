// Keeps one AD600 scanning: starts the engine, judges how each run went, and
// decides what to do next.
//
// The decisions are the hard-won part, and they come from people who had the
// hardware:
//
//   - An AD600 gives its scan to one controller. If the claim is refused,
//     someone else has it (Wireless Workbench, usually) or a dropped session
//     never released it. Trying again does not help and can leave the device
//     worse off, so the scanner stops, says so, and waits for the one thing
//     that does help: the device going away and coming back. A power-cycle
//     frees the slot, and the scan resumes by itself.
//   - A session that streamed and then ended is simply started again.
//   - A session that never streamed — refused outright, or joined and then
//     never armed — gets a few attempts, each under a fresh identity, then
//     the same wait.
//   - A device that never answers at all is a dead transport, and fatal.
//   - The scan settings are latched when the scan is armed, so a new range or
//     resolution means leaving the session cleanly and arming a new one.
//
// Getting from launch to the first scan data takes 20–30 seconds on real
// hardware: an advert, a pause, the join, a paced exchange of subscriptions,
// a settle, the claim, the arm. The timings below allow for that.
//
// The scanner reports state; it does not word anything for a user. adapter.js
// turns `onStatus` into warnings and `onFatal` into a failed device.

import { EngineRun } from './engine-process.js';

export const DEFAULT_TIMINGS = {
  /** from launch to the device accepting the session */
  joinMs: 15_000,
  /** from launch to the first scan frame */
  firstFrameMs: 60_000,
  /** between scan frames, once they have started */
  stallMs: 15_000,
  /** before relaunching after a run that ended */
  backoffMs: 2_000,
  /** for the device to let go of the slot before it is claimed again */
  settleMs: 1_500,
  /** with no further retune, before a retune takes effect */
  quietMs: 600,
  /** between looks at whether a blocked device has been power-cycled */
  presencePollMs: 2_000,
};

const MAX_FAILED_STARTS = 3;

export class Ad600Scanner {
  /**
   * @param {{
   *   engine: { command: string, args: string[] },
   *   device: { host: string, port: number, cid: string },
   *   local: { name: string, address: string },
   *   discovery: { hold(): () => void, isPresent(host: string): boolean | null },
   *   timings?: Partial<typeof DEFAULT_TIMINGS>,
   *   log?: (level: string, message: string) => void,
   * }} options
   */
  constructor({ engine, device, local, discovery, timings, log = () => {} }) {
    this.engine = engine;
    this.device = device;
    this.local = local;
    this.discovery = discovery;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.log = log;

    /** `(curve, lo, hi, amps)` for every frame of the scan currently wanted */
    this.onFrame = null;
    /**
     * `({ state, reason? })`: `starting`, `streaming`, `renewing` (a session
     * ran its length and another is starting), `reconnecting`,
     * `blocked` (reason `not-owner` | `join-refused` | `no-scan`), `stopped`
     */
    this.onStatus = null;
    /** the device is not there, or the engine cannot run */
    this.onFatal = null;

    this.plan = null;
    this.running = false;
    this.generation = 0;
    this.run = null;
    this.loop = null;
    this.retunedAt = 0;
    this.wake = null;
  }

  /** Begin scanning `plan` and keep scanning until `stop()`. */
  start(plan) {
    this.plan = plan;
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.loop = this.#supervise(this.generation);
  }

  /**
   * Scan something else. Frames of the old scan stop arriving immediately;
   * the new one starts once requests have stopped coming, so a zoom dragged
   * across the plot costs the device one new session rather than twenty.
   */
  retune(plan) {
    if (this.plan?.key === plan.key) return;
    this.plan = plan;
    this.retunedAt = Date.now();
    if (!this.running) return;
    const previous = this.loop;
    this.generation += 1;
    const generation = this.generation;
    this.#interrupt();
    this.loop = (async () => {
      await previous;
      if (!this.#current(generation)) return;
      await this.#settle(generation);
      await this.#supervise(generation);
    })();
  }

  /** Stop scanning and leave the session. Safe when not scanning. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    this.#interrupt();
    await this.loop;
    this.#status('stopped');
  }

  #current(generation) {
    return this.running && generation === this.generation;
  }

  // ends whatever the superseded loop is waiting on
  #interrupt() {
    this.run?.stop();
    this.wake?.();
  }

  #status(state, reason) {
    this.onStatus?.(reason ? { state, reason } : { state });
  }

  #sleep(ms, generation) {
    if (!this.#current(generation)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === done) self.wake = null;
        resolve();
      }
      this.wake = done;
    });
  }

  // long enough for the device to free the slot, and for a burst of retunes
  // to finish
  async #settle(generation) {
    await this.#sleep(this.timings.settleMs, generation);
    while (this.#current(generation)) {
      const quietFor = Date.now() - this.retunedAt;
      if (quietFor >= this.timings.quietMs) return;
      await this.#sleep(this.timings.quietMs - quietFor, generation);
    }
  }

  async #supervise(generation) {
    try {
      await this.#keepScanning(generation);
    } catch (err) {
      // nothing below is expected to throw; if it does, say so rather than
      // leave a device that looks healthy and never produces a trace
      if (!this.#current(generation)) return;
      this.running = false;
      this.onFatal?.({
        kind: 'engine-failed',
        detail: err?.message || String(err),
      });
    }
  }

  async #keepScanning(generation) {
    let failedStarts = 0;
    while (this.#current(generation)) {
      this.#status('starting');
      const outcome = await this.#runOnce(generation);
      if (!this.#current(generation)) return;

      if (outcome.kind === 'unreachable' || outcome.kind === 'engine-failed') {
        this.running = false;
        this.onFatal?.(outcome);
        return;
      }
      if (outcome.kind === 'not-owner') {
        if (!(await this.#awaitPowerCycle('not-owner', generation))) return;
        failedStarts = 0;
        continue;
      }
      if (outcome.kind === 'streamed') {
        failedStarts = 0;
      } else {
        // 'join-refused' or 'no-scan': worth another go under a new identity
        failedStarts += 1;
        if (failedStarts >= MAX_FAILED_STARTS) {
          if (!(await this.#awaitPowerCycle(outcome.kind, generation))) return;
          failedStarts = 0;
          continue;
        }
      }
      this.#status(outcome.expired ? 'renewing' : 'reconnecting');
      await this.#sleep(this.timings.backoffMs, generation);
    }
  }

  /**
   * One engine session, from launch until it is over — because it was
   * stopped, because it ended, or because it was going nowhere and was ended.
   *
   * @returns {Promise<{ kind: 'streamed' | 'not-owner' | 'join-refused' | 'no-scan' | 'unreachable' | 'engine-failed' | 'superseded', detail?: string }>}
   */
  async #runOnce(generation) {
    const plan = this.plan;
    let joined = false;
    let frames = 0;
    let verdict = null;
    let stallTimer = null;
    const timers = [];
    const after = (ms, fn) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      timers.push(timer);
      return timer;
    };
    const end = (kind) => {
      verdict ??= kind;
      run.stop();
    };

    const run = new EngineRun({
      engine: this.engine,
      device: this.device,
      local: this.local,
      plan,
      onFrame: (curve, lo, hi, amps) => {
        if (!this.#current(generation) || verdict) return;
        joined = true;
        frames += 1;
        if (frames === 1) this.#status('streaming');
        clearTimeout(stallTimer);
        stallTimer = after(this.timings.stallMs, () => end('streamed'));
        this.onFrame?.(curve, lo, hi, amps);
      },
      onMilestone: (name, line) => {
        this.log('info', `engine: ${line}`);
        if (name === 'joined' || name === 'owner' || name === 'scan-ready')
          joined = true;
        if (name === 'not-owner') end('not-owner');
        if (name === 'join-refused') end('join-refused');
        if (name === 'no-scan-ready') end('no-scan');
      },
    });
    this.run = run;
    this.log(
      'info',
      `starting a scan session with ${this.device.host}: ` +
        `${plan.startKhz}–${plan.stopKhz} kHz at ${plan.compression * 25} kHz`
    );
    try {
      run.start();
    } catch (err) {
      if (this.run === run) this.run = null;
      return { kind: 'engine-failed', detail: err?.message || String(err) };
    }
    after(this.timings.joinMs, () => {
      if (!joined) end('unreachable');
    });
    after(this.timings.firstFrameMs, () => {
      if (frames === 0) end('no-scan');
    });

    const exit = await run.exited;
    for (const timer of timers) clearTimeout(timer);
    if (this.run === run) this.run = null;

    if (!this.#current(generation)) return { kind: 'superseded' };
    if (exit.error) {
      return { kind: 'engine-failed', detail: exit.error.message };
    }
    if (verdict) return { kind: verdict };
    // It ended without being asked to. Leaving cleanly after streaming is a
    // session that ran its length, which is routine; anything else is not.
    if (frames > 0) return { kind: 'streamed', expired: exit.code === 0 };
    const output = run.recentOutput();
    // one log entry per line: the host keeps the plugin log line by line
    for (const line of output ? output.split('\n') : [])
      this.log('warn', `engine: ${line}`);
    if (!joined) {
      return {
        kind: 'engine-failed',
        detail:
          output.split('\n').pop() ||
          `exit ${exit.signal ?? exit.code ?? 'status unknown'}`,
      };
    }
    return { kind: 'no-scan' };
  }

  /**
   * Wait for the device to disappear from the network and return — the
   * power-cycle that frees its scan slot. Resolves true to try again, false
   * if the scan was stopped or retuned in the meantime.
   */
  async #awaitPowerCycle(reason, generation) {
    this.#status('blocked', reason);
    const release = this.discovery.hold();
    try {
      let wentAway = false;
      while (this.#current(generation)) {
        // null: listening is not possible here, so nothing can be concluded
        const present = this.discovery.isPresent(this.device.host);
        if (present === false) wentAway = true;
        else if (present === true && wentAway) {
          this.log('info', `${this.device.host} has restarted; scanning again`);
          return true;
        }
        await this.#sleep(this.timings.presencePollMs, generation);
      }
      return false;
    } finally {
      release();
    }
  }
}
