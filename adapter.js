// Shure AD600 Axient Digital Spectrum Manager, as a SoundBase spectrum
// analyzer.
//
// This file is the contract-facing half: discovery, capabilities, clamping a
// requested configuration to what the device can do, and handing completed
// sweeps to the shell. Everything that touches the device is in driver/:
//
//   driver/slp.js              finding AD600s (SLP multicast adverts)
//   driver/scan-plan.js        what can be asked for, and what comes back
//   driver/ad600-scanner.js    keeping a scan session alive
//   driver/engine-process.js   the scan engine, as a child process
//   driver/sweep-assembler.js  scan tiles -> sweeps
//
// Two things about this device shape everything below:
//
//   - It scans for ONE controller. Wireless Workbench and this plugin cannot
//     both have it, and a session that is dropped rather than closed keeps the
//     slot until the device is power-cycled.
//   - Its scan settings are latched when a scan is armed. Changing the range
//     or the resolution means a new session, and a session takes 20–30
//     seconds to produce its first data.

import {
  MAX_FREQUENCY_HZ,
  MIN_FREQUENCY_HZ,
  RESOLUTIONS_HZ,
  geometryOf,
  planScan,
} from './driver/scan-plan.js';
import { SweepAssembler } from './driver/sweep-assembler.js';
import { Ad600Scanner } from './driver/ad600-scanner.js';
import { resolveEngine } from './driver/engine-process.js';
import {
  DEFAULT_DEVICE_PORT,
  SlpBrowser,
  StaticDiscovery,
  localInterfaceFor,
} from './driver/slp.js';

// The product this adapter announces its devices as. It MUST be a
// `deviceTypeId` declared in soundbase-plugin.json — the shell warns and the
// host ignores a device naming a product the manifest never declared.
// `npm run rename` keeps them in step; a test asserts they agree.
export const PRODUCT = 'plugin:shure-ad600/ad600';

/** how long open() waits for a unit that has not advertised yet */
const FIND_MS = 6_000;
const FIND_WITH_CID_MS = 1_500;
/** how long a band may take to fill in before it is worth saying why */
const FILLING_NOTICE_MS = 8_000;
// How long SoundBase should expect between traces before it decides the device
// has stalled. This is not a measured sweep time. It is here because a session
// takes 20–30 s on real hardware to produce its first trace, and a wide scan
// at a fine resolution longer still, while a host told nothing calls anything
// slower than 20 s a stall.
const EXPECTED_TRACE_INTERVAL_MS = 10_000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// every stdout line after the handshake is a line in the plugin's log
const log = (level, message) =>
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);

// What the user is told when the scan cannot run. Written for an RF
// coordinator an hour before doors: what is wrong, and what to do about it.
const TROUBLE = {
  'not-owner': {
    id: 'scan-held',
    severity: 'critical',
    message:
      "Another controller holds this AD600's scan, usually Wireless Workbench. " +
      'Quit Wireless Workbench on every computer on this network, then stop this ' +
      'scan and start it again. If it is still refused, power-cycle the AD600: ' +
      'the scan resumes by itself once the AD600 has restarted.',
  },
  'join-refused': {
    id: 'session-refused',
    severity: 'critical',
    message:
      'The AD600 refused the connection, which usually means an earlier session ' +
      'was not closed cleanly. Power-cycle the AD600; the scan resumes by itself ' +
      'once it has restarted.',
  },
  'no-scan': {
    id: 'scan-not-starting',
    severity: 'critical',
    message:
      'The AD600 accepted the connection but did not start scanning. Quit Wireless ' +
      'Workbench on every computer on this network, then power-cycle the AD600. ' +
      'The scan resumes by itself once the AD600 has restarted.',
  },
  reconnecting: {
    id: 'scan-interrupted',
    severity: 'warning',
    message:
      'The AD600 stopped sending scan data and the scan is being restarted. ' +
      'The trace is not updating until it resumes.',
  },
};
const FILLING = {
  id: 'scan-filling',
  severity: 'info',
  message:
    'The AD600 is still sending the first pass of this range, so there is no ' +
    'trace yet. A wide range at a fine RBW arrives in pieces and can take a ' +
    'minute to fill; a narrower range or a coarser RBW is quicker.',
};

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

let discoveryService = null;

function discovery() {
  if (discoveryService) return discoveryService;
  if (process.env.SB_AD600_MOCK === '1') {
    // no network at all: one pretend unit, served by driver/fake-engine.js
    discoveryService = new StaticDiscovery([
      {
        host: '127.0.0.1',
        port: DEFAULT_DEVICE_PORT,
        cid: 'ad600000000011dda000000eddcccccc',
        model: 'AD600',
        name: 'AD600 (mock)',
      },
    ]);
  } else {
    // a fake device on this machine advertises to a port of its own
    const loopbackPort = Number(process.env.SB_AD600_SLP_PORT);
    discoveryService = loopbackPort
      ? new SlpBrowser({ port: loopbackPort, multicast: false, log })
      : new SlpBrowser({ log });
  }
  return discoveryService;
}

/**
 * AD600s advertising on the networks this computer is attached to.
 *
 * Called once a second while SoundBase is enumerating and never otherwise.
 * Each call keeps the listener alive a little longer and returns what it has
 * heard; the listener shuts itself down when the calls stop, so an idle plugin
 * does no network I/O.
 */
export async function discoverDevices() {
  const service = discovery();
  service.touch();
  return service.devices().map((unit) => ({
    // Stable across restarts, because it is the address and nothing else. It
    // goes into URLs and into the user's saved project.
    id: `net:${unit.host}`,
    name: `${unit.name} (${unit.host})`,
    product: PRODUCT,
    transport: { kind: 'network', host: unit.host, port: unit.port },
  }));
}

// ---------------------------------------------------------------------------
// SpectrumAnalyzer
// ---------------------------------------------------------------------------

/**
 * `device.config` holds the manifest's `deviceConfigFields`, filled in from the
 * SoundBase project. The id fallback covers a device this plugin discovered
 * itself, whose id already is the address.
 */
function addressOf(device) {
  const config = device.config ?? {};
  const host =
    (typeof config.host === 'string' && config.host.trim()) ||
    /^net:(.+)$/.exec(device.id ?? '')?.[1];
  if (!host) {
    throw new Error(
      `device ${device.id} has no address: set "IP address" in its configuration`
    );
  }
  const cid = String(config.cid ?? '')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase();
  return { host, cid: cid.length === 32 ? cid : null };
}

class Ad600Adapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.pluginConfig = pluginConfig;
    this.scanner = null;
    this.request = {};
    this.plan = planScan(this.request);
    // the trace geometry the shell was last told, when the device turned out
    // to be sending something other than the plan predicted
    this.observed = null;
    this.sweeping = false;
    this.onTrace = null;
    this.trouble = null;
    this.filling = false;
    this.strideLogged = false;
    this.assembler = new SweepAssembler({
      onSweep: (sweep) => this.#onSweep(sweep),
    });
    // assigned by the shell
    this.onFatal = null;
    this.onWarnings = null;
    this.onEffectiveConfig = null;
  }

  /**
   * Find the unit and work out how a session with it would be set up. No
   * session is opened here: the AD600 scans for whoever holds its one slot, so
   * the slot is claimed when a sweep is started and given back when it stops.
   */
  async open() {
    const { host, cid } = addressOf(this.device);
    const engine = await resolveEngine(this.pluginConfig);

    // The component id and port come from the unit's own advert. A configured
    // component id is the fallback for a network where adverts do not arrive.
    const service = discovery();
    const unit = await service.find(host, cid ? FIND_WITH_CID_MS : FIND_MS);
    if (!unit && !cid) {
      throw new Error(
        `No AD600 is advertising at ${host}. Check that it is powered on and ` +
          'on the same network (subnet) as this computer.'
      );
    }
    const local = await localInterfaceFor(host);

    const scanner = new Ad600Scanner({
      engine,
      device: {
        host,
        port: unit?.port ?? DEFAULT_DEVICE_PORT,
        cid: unit?.cid ?? cid,
      },
      local,
      discovery: service,
      log: (level, message) => log(level, `[${this.device.id}] ${message}`),
    });
    scanner.onFrame = (curve, lo, hi, amps) =>
      this.#onFrame(curve, lo, hi, amps);
    scanner.onStatus = (status) => this.#onStatus(status);
    scanner.onFatal = (failure) => this.#onScannerFatal(host, failure);
    this.scanner = scanner;

    return {
      capabilities: {
        minFrequencyHz: MIN_FREQUENCY_HZ,
        maxFrequencyHz: MAX_FREQUENCY_HZ,
        // one setting gives both: the device delivers a point every
        // `resolution`, each the peak of what it measured across that width
        rbwHz: [...RESOLUTIONS_HZ],
        minStepHz: RESOLUTIONS_HZ[0],
        maxStepHz: RESOLUTIONS_HZ[RESOLUTIONS_HZ.length - 1],
      },
      identity: {
        manufacturer: 'Shure',
        model: unit?.model ?? 'AD600',
        ...(unit?.name ? { name: unit.name } : {}),
      },
    };
  }

  /**
   * Clamp what was asked for to what the device will do, and say what that is.
   *
   * The AD600 has a range and a resolution and nothing else, and the point
   * count follows from those two. `cfg.rbwHz` sets the resolution when it is
   * there; without it the point count asked for picks the nearest resolution,
   * and without either the device's default applies. The start and stop stay
   * as they were when absent.
   *
   * A change takes effect a few seconds later, in a new session. Sweeps of the
   * old configuration stop being reported as soon as this returns.
   */
  async applyConfig(cfg = {}) {
    this.request = {
      startHz: isNum(cfg.startHz) ? cfg.startHz : this.request.startHz,
      stopHz: isNum(cfg.stopHz) ? cfg.stopHz : this.request.stopHz,
      rbwHz: isNum(cfg.rbwHz) ? cfg.rbwHz : undefined,
      pointCount: isNum(cfg.pointCount) ? cfg.pointCount : undefined,
      stepHz: isNum(cfg.stepHz) ? cfg.stepHz : undefined,
    };
    const plan = planScan(this.request);
    if (plan.key !== this.plan.key) {
      this.plan = plan;
      this.observed = null;
      this.assembler.reset(plan);
      this.scanner?.retune(plan);
    }
    return this.#effective();
  }

  #effective() {
    const geometry = this.observed ?? this.plan;
    const effective = {
      startHz: geometry.startHz,
      stopHz: geometry.stopHz,
      pointCount: geometry.pointCount,
    };
    effective.resolved = { sweepTimeMs: EXPECTED_TRACE_INTERVAL_MS };
    // an RBW nobody asked for is the analyzer's choice, reported as resolved
    if (isNum(this.request.rbwHz)) effective.rbwHz = geometry.stepHz;
    else effective.resolved.rbwHz = geometry.stepHz;
    return effective;
  }

  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    this.onTrace = onTrace;
    this.assembler.reset(this.plan);
    this.scanner.start(this.plan);
  }

  async stopSweep() {
    if (!this.sweeping) return;
    this.sweeping = false;
    this.onTrace = null;
    await this.scanner?.stop();
  }

  /** Release the scan. Called on removal, teardown, and after a fatal. */
  async close() {
    try {
      this.sweeping = false;
      this.onTrace = null;
      await this.scanner?.stop();
    } catch {
      // close must not throw
    }
    this.scanner = null;
  }

  #onFrame(curve, lo, hi, amps) {
    if (!this.sweeping) return;
    this.assembler.feed(curve, lo, hi, amps);
    if (this.assembler.foreignStride && !this.strideLogged) {
      this.strideLogged = true;
      log(
        'warn',
        `[${this.device.id}] the AD600 is sending points ` +
          `${this.assembler.foreignStride * 25} kHz apart, not the ` +
          `${this.plan.compression * 25} kHz it was asked for`
      );
    }
    // no trace until every antenna has the whole band; say so if that is slow
    const filling =
      !this.assembler.covered &&
      Date.now() - this.assembler.firstFrameAt > FILLING_NOTICE_MS;
    if (filling !== this.filling) {
      this.filling = filling;
      this.#reportWarnings();
    }
  }

  #onSweep({ grid, amplitudesDbm, series }) {
    if (!this.sweeping || !this.onTrace) return;
    // The plan predicts the grid; the data is the truth. If the device sends
    // something else, say so before the trace is labelled with the wrong axis.
    const told = this.observed ?? this.plan;
    const sent = geometryOf(grid);
    if (
      sent.startHz !== told.startHz ||
      sent.stopHz !== told.stopHz ||
      sent.pointCount !== told.pointCount
    ) {
      log(
        'warn',
        `[${this.device.id}] the AD600 is scanning ${sent.startHz}–${sent.stopHz} Hz ` +
          `in ${sent.pointCount} points, not the ${told.startHz}–${told.stopHz} Hz ` +
          `in ${told.pointCount} that was expected; reporting what it sends`
      );
      this.observed = sent;
      this.onEffectiveConfig?.(this.#effective());
    }
    this.onTrace(amplitudesDbm, series);
  }

  #onStatus({ state, reason }) {
    // a new session starts from an empty picture
    if (state === 'starting') {
      this.assembler.reset(this.plan);
      this.strideLogged = false;
    }
    if (state === 'blocked') this.trouble = TROUBLE[reason] ?? null;
    else if (state === 'reconnecting') this.trouble = TROUBLE.reconnecting;
    else if (state === 'streaming' || state === 'stopped') this.trouble = null;
    if (state !== 'streaming') this.filling = false;
    this.#reportWarnings();
  }

  // the complete current set, every time
  #reportWarnings() {
    this.onWarnings?.(
      [this.trouble, this.filling ? FILLING : null].filter(Boolean)
    );
  }

  #onScannerFatal(host, { kind, detail }) {
    this.sweeping = false;
    this.onTrace = null;
    this.onFatal?.(
      new Error(
        kind === 'unreachable'
          ? `The AD600 at ${host} did not answer. Check that it is powered on ` +
              'and connected to the same network as this computer.'
          : `The AD600 scan engine stopped unexpectedly${detail ? `: ${detail}` : '.'}`
      )
    );
  }
}

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new Ad600Adapter(device, pluginConfig);
}
