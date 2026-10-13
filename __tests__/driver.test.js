// The driver, a layer at a time, with nothing attached.
//
// ad600.test.js drives the whole plugin through the shell. This file is for
// what is awkward to stage from out there: the arithmetic of the scan plan,
// sweep assembly from frames that arrive in awkward orders, and the scanner's
// decisions about a device that is held, absent, silent or power-cycled —
// each with timings short enough to run in a test.
//
// The last test is the only one that runs the real engine. It needs Python and
// says so loudly when it is skipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {
  COMPRESSION_MAX,
  COMPRESSION_MIN,
  MAX_FREQUENCY_HZ,
  MAX_POINTS,
  MIN_FREQUENCY_HZ,
  geometryOf,
  gridOf,
  hzToIdx,
  idxToHz,
  planScan,
} from '../driver/scan-plan.js';
import { SweepAssembler } from '../driver/sweep-assembler.js';
import {
  SlpBrowser,
  buildAttrRply,
  buildSrvRqst,
  deviceFromAttributes,
  localInterfaceFor,
  parseAttrRply,
} from '../driver/slp.js';
import {
  EngineRun,
  EngineUnavailableError,
  FAKE_ENGINE,
  resolveEngine,
  sessionCid,
} from '../driver/engine-process.js';
import { Ad600Scanner } from '../driver/ad600-scanner.js';
import { freeUdpPort, startFakeAd600 } from '../driver/fake-ad600.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (
  probe,
  { timeoutMs = 8_000, what = 'the condition' } = {}
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`${what} never happened`);
    await delay(15);
  }
};

// ---------------------------------------------------------------------------
// scan plan
// ---------------------------------------------------------------------------

test('the channel plan is 25 kHz per index from 174 MHz', () => {
  assert.equal(idxToHz(0), 174_000_000);
  assert.equal(idxToHz(11_840), 470_000_000);
  assert.equal(hzToIdx(470_000_000), 11_840);
  assert.equal(hzToIdx(470_012_000), 11_840, 'rounds to the nearest index');
});

test('with nothing asked for, the plan is the full band at the default resolution', () => {
  const plan = planScan();
  assert.equal(plan.startHz, MIN_FREQUENCY_HZ);
  assert.equal(plan.startKhz, 470_000);
  assert.equal(plan.stopKhz, 1_000_000);
  assert.equal(plan.compression, COMPRESSION_MAX);
  assert.equal(plan.stepHz, 900_000);
  assert.equal(plan.pointCount, 588);
  assert.equal(plan.stopHz, 998_300_000);
});

// Every row here was measured on an AD600 by someone who had one: the device
// sends floor(span / step) points from the start and never reaches the stop.
test('the point count predicted is the one the hardware has been seen to send', () => {
  const measured = [
    [470e6, 524e6, 350e3, 154],
    [470e6, 524e6, 100e3, 540],
    [470e6, 616e6, 100e3, 1460],
    [470e6, 1000e6, 900e3, 588],
  ];
  for (const [startHz, stopHz, rbwHz, points] of measured) {
    const plan = planScan({ startHz, stopHz, rbwHz });
    assert.equal(plan.pointCount, points, `${startHz}-${stopHz} @ ${rbwHz}`);
    assert.ok(plan.stopHz < stopHz);
  }
  assert.equal(
    planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 100e3 }).stopHz,
    615.9e6
  );
});

test('the plan stays inside what the device does, whatever is asked for', () => {
  const wide = planScan({ startHz: -5, stopHz: 9e12, rbwHz: 1 });
  assert.equal(wide.startHz, MIN_FREQUENCY_HZ);
  assert.ok(wide.stopHz <= MAX_FREQUENCY_HZ);
  // the finest the device goes would be 10 600 points here; it is coarsened
  assert.ok(wide.pointCount <= MAX_POINTS);
  assert.ok(wide.pointCount > MAX_POINTS * 0.9);

  const narrow = planScan({ startHz: 470e6, stopHz: 500e6, rbwHz: 1 });
  assert.equal(narrow.compression, COMPRESSION_MIN);
  assert.equal(narrow.stepHz, 50_000);

  // a start past the top still leaves room for two points
  const high = planScan({ startHz: 5e9, stopHz: 6e9 });
  assert.ok(high.startHz < high.stopHz);
  assert.ok(high.stopHz <= MAX_FREQUENCY_HZ);
  assert.equal(high.pointCount, 2);

  // reversed, the stop is pushed above the start rather than rejected
  const reversed = planScan({ startHz: 600e6, stopHz: 500e6 });
  assert.ok(reversed.stopHz > reversed.startHz);
});

test('resolution comes from RBW, then point count, then step', () => {
  const range = { startHz: 470e6, stopHz: 616e6 };
  assert.equal(
    planScan({ ...range, rbwHz: 500e3, pointCount: 50 }).stepHz,
    500e3
  );
  assert.equal(planScan({ ...range, pointCount: 292 }).stepHz, 500e3);
  assert.equal(planScan({ ...range, stepHz: 610e3 }).stepHz, 600e3);
  assert.equal(
    planScan({ ...range, pointCount: 292, stepHz: 900e3 }).stepHz,
    500e3
  );
});

test('the trace geometry of a plan is self-consistent', () => {
  for (const request of [
    {},
    { startHz: 470e6, stopHz: 616e6, rbwHz: 350e3 },
    { startHz: 512.3e6, stopHz: 698.7e6, rbwHz: 425e3 },
    { startHz: 900e6, stopHz: 900.4e6 },
  ]) {
    const plan = planScan(request);
    assert.equal(
      plan.stopHz,
      plan.startHz + (plan.pointCount - 1) * plan.stepHz,
      JSON.stringify(request)
    );
    // the last point is short of the stop, and one more would not be
    assert.ok(plan.stopHz < plan.stopKhz * 1000);
    assert.ok(plan.stopHz + 2 * plan.stepHz > plan.stopKhz * 1000);
    assert.deepEqual(geometryOf(gridOf(plan)), {
      startHz: plan.startHz,
      stopHz: plan.stopHz,
      stepHz: plan.stepHz,
      pointCount: plan.pointCount,
    });
  }
});

test('two requests for the same scan make the same plan, so no re-arm', () => {
  const a = planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 350e3 });
  const b = planScan({
    startHz: 470_004_000,
    stopHz: 615_990_000,
    rbwHz: 352e3,
  });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, planScan({ startHz: 470e6, stopHz: 616e6 }).key);
});

// ---------------------------------------------------------------------------
// sweep assembly
// ---------------------------------------------------------------------------

// 470–616 MHz at 100 kHz: the scan the hardware notes describe, 1460 points in
// five tiles of 300 steps that share their edge points
const PLAN = planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 100e3 });
const TILES = [
  [0, 300],
  [300, 600],
  [600, 900],
  [900, 1200],
  [1200, 1459],
];
const ALL = [1, 2, 3, 4, 5, 6];

// one tile of one antenna, as the engine reports it
const tile = (plan, curve, [first, last], level) => [
  curve,
  plan.startIdx + first * plan.compression,
  plan.startIdx + last * plan.compression,
  Array.from({ length: last - first + 1 }, (_, k) =>
    typeof level === 'function' ? level(first + k) : level
  ),
];

function assemble(plan = PLAN, options = {}) {
  const sweeps = [];
  const assembler = new SweepAssembler({
    onSweep: (sweep) => sweeps.push(sweep),
    ...options,
  });
  assembler.reset(plan);
  let now = 1_000;
  const feed = (curve, bounds, level) => {
    now += 1;
    assembler.feed(...tile(plan, curve, bounds, level), now);
  };
  return { assembler, sweeps, feed, advance: (ms) => (now += ms) };
}

test('nothing is a sweep until every antenna has every point', () => {
  const { assembler, sweeps, feed } = assemble();
  for (const curve of ALL)
    for (const bounds of TILES.slice(0, 4)) feed(curve, bounds, -90 - curve);
  for (const curve of ALL.slice(0, 5)) feed(curve, TILES[4], -90 - curve);
  assert.equal(sweeps.length, 0);
  assert.equal(assembler.covered, false);

  feed(6, TILES[4], -96);
  assert.equal(sweeps.length, 1);
  assert.equal(assembler.covered, true);
  const [sweep] = sweeps;
  assert.deepEqual(sweep.grid, gridOf(PLAN));
  assert.deepEqual(
    sweep.series.map((s) => s.name),
    ['A', 'B', 'C', 'D', 'E', 'F']
  );
  for (const curve of [sweep, ...sweep.series])
    assert.equal(curve.amplitudesDbm.length, 1460);
  // the primary is the strongest any antenna heard, which is A throughout
  assert.ok(sweep.amplitudesDbm.every((v) => v === -91));
  assert.ok(sweep.series[5].amplitudesDbm.every((v) => v === -96));
});

// What the hardware does: the bottom tile comes round again and again while
// the top one is still on its way, and the order is nobody's to rely on.
test('tiles in any order, at any rate, refresh their own slice of the picture', () => {
  const { sweeps, feed } = assemble();
  for (let round = 0; round < 3; round += 1)
    for (const curve of ALL) feed(curve, TILES[0], -80);
  for (const curve of ALL)
    for (const bounds of [TILES[3], TILES[1], TILES[2]])
      feed(curve, bounds, -85);
  assert.equal(sweeps.length, 0, 'no top tile yet, so no sweep');
  for (const curve of ALL) feed(curve, TILES[4], -70);
  assert.equal(sweeps.length, 1);

  // from here each tile that arrives is the whole picture with its slice replaced
  feed(1, TILES[0], -60);
  assert.equal(sweeps.length, 2);
  const latest = sweeps.at(-1);
  assert.equal(latest.series[0].amplitudesDbm[0], -60);
  assert.equal(
    latest.series[0].amplitudesDbm[1459],
    -70,
    'the top tile was not disturbed'
  );
  assert.equal(
    latest.series[1].amplitudesDbm[0],
    -80,
    'nor was another antenna'
  );
  assert.equal(latest.amplitudesDbm[0], -60);
  assert.equal(latest.amplitudesDbm[450], -85);
});

test('a tile that never decoded is simply waited for', () => {
  const { sweeps, feed } = assemble();
  for (const curve of ALL)
    for (const [t, bounds] of TILES.entries())
      if (!(curve === 4 && t === 2)) feed(curve, bounds, -90);
  assert.equal(sweeps.length, 0, 'antenna D is missing a tile');
  for (const curve of ALL) feed(curve, TILES[0], -88);
  assert.equal(
    sweeps.length,
    0,
    'and repeats of other tiles do not make up for it'
  );
  feed(4, TILES[2], -90);
  assert.equal(sweeps.length, 1);
});

test('a tile with an impossible reading in it is dropped whole', () => {
  const { assembler, sweeps, feed } = assemble();
  for (const curve of ALL) for (const bounds of TILES) feed(curve, bounds, -90);
  const before = sweeps.length;

  // one decode artifact among plausible-looking values
  feed(2, TILES[1], (i) => (i === 450 ? 2253 : -40));
  feed(3, TILES[1], (i) => (i === 500 ? -1459.4 : -40));
  assert.equal(sweeps.length, before, 'nothing was reported for them');
  assert.equal(assembler.rejectedFrames, 2);

  feed(1, TILES[0], -90);
  const latest = sweeps.at(-1);
  assert.ok(latest.series.every((s) => Math.max(...s.amplitudesDbm) === -90));
});

test('the step is the one that was asked for, whatever a short tile divides out to', () => {
  const { sweeps, feed, assembler } = assemble();
  for (const curve of ALL) for (const bounds of TILES) feed(curve, bounds, -90);
  // a two-point boundary tile whose stated end is off by an index
  assembler.feed(
    1,
    PLAN.startIdx + 1458 * 4,
    PLAN.startIdx + 1459 * 4 + 1,
    [-50, -51],
    9_999
  );
  const latest = sweeps.at(-1);
  assert.equal(latest.amplitudesDbm.length, 1460);
  assert.equal(latest.series[0].amplitudesDbm[1458], -50);
  assert.equal(latest.series[0].amplitudesDbm[1459], -51);
  assert.equal(
    assembler.foreignStride,
    null,
    'too short a tile to judge the device by'
  );
});

test('the extent reported is the one the data reached, not the one predicted', () => {
  // one point fewer than predicted
  const short = assemble();
  for (const curve of ALL) {
    for (const bounds of TILES.slice(0, 4)) short.feed(curve, bounds, -90);
    short.feed(curve, [1200, 1458], -90);
  }
  assert.equal(short.sweeps.length, 1);
  assert.equal(short.sweeps[0].amplitudesDbm.length, 1459);
  assert.equal(short.sweeps[0].grid.top, gridOf(PLAN).top - PLAN.compression);

  // one more than predicted: nothing lost, the picture grows when it turns up
  const long = assemble();
  for (const curve of ALL)
    for (const bounds of TILES) long.feed(curve, bounds, -90);
  assert.equal(long.sweeps.at(-1).amplitudesDbm.length, 1460);
  for (const curve of ALL) long.feed(curve, [1200, 1460], -90);
  assert.equal(long.sweeps.at(-1).amplitudesDbm.length, 1461);

  // but a band that stops well short of where it should is not a band yet
  const stub = assemble();
  for (const curve of ALL)
    for (const bounds of TILES.slice(0, 4)) stub.feed(curve, bounds, -90);
  assert.equal(stub.sweeps.length, 0);
});

test('fewer antennas than expected are settled for, after a wait', () => {
  const { sweeps, feed, advance } = assemble(PLAN, { curveGraceMs: 5_000 });
  for (const curve of [1, 2, 3])
    for (const bounds of TILES) feed(curve, bounds, -90);
  assert.equal(sweeps.length, 0, 'the other three may be on their way');
  advance(6_000);
  feed(1, TILES[0], -90);
  assert.equal(sweeps.length, 1);
  assert.deepEqual(
    sweeps[0].series.map((s) => s.name),
    ['A', 'B', 'C']
  );
});

test('a new session starts from an empty picture', () => {
  const { assembler, sweeps, feed } = assemble();
  for (const curve of ALL) for (const bounds of TILES) feed(curve, bounds, -90);
  assert.equal(sweeps.length, 1);
  assembler.reset(PLAN);
  assert.equal(assembler.covered, false);
  for (const curve of ALL) feed(curve, TILES[0], -90);
  assert.equal(
    sweeps.length,
    1,
    'old values are not carried into the new session'
  );
});

test('levels are floored and rounded to a tenth of a dB', () => {
  const plan = planScan({ startHz: 470e6, stopHz: 480e6, rbwHz: 900e3 });
  const { sweeps, feed } = assemble(plan, { expectedCurves: 1 });
  feed(1, [0, plan.pointCount - 1], (i) => (i === 0 ? -140 : -77.349));
  assert.equal(sweeps[0].amplitudesDbm[0], -130);
  assert.equal(sweeps[0].amplitudesDbm[1], -77.3);
});

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

const ADVERT =
  '(cid=DDAC0650-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=AD600),(acn-uacn=Monitor World),' +
  '(acn-services=esta.dmp),(csl-esta.dmp=esta.sdt/192.168.5.101:57383;esta.dmp/cd:1234),' +
  '(device-description=$:tftp://192.168.5.101/$.ddl)';

test('an AD600 advert yields its address, port and component id', () => {
  const attrs = parseAttrRply(buildAttrRply(ADVERT));
  assert.equal(attrs['acn-fctn'], 'AD600');
  assert.deepEqual(deviceFromAttributes(attrs, '10.0.0.9'), {
    host: '192.168.5.101',
    port: 57383,
    cid: 'ddac0650000011dda000000eddcccccc',
    model: 'AD600',
    name: 'Monitor World',
  });
});

test('adverts that are not an AD600 are not devices', () => {
  const receiver = ADVERT.replace('acn-fctn=AD600', 'acn-fctn=AD4Q_RX');
  assert.equal(
    deviceFromAttributes(parseAttrRply(buildAttrRply(receiver)), '10.0.0.9'),
    null
  );
  // Wireless Workbench, and this plugin's own engine, advertise as controllers
  const controller = ADVERT.replace('acn-fctn=AD600', 'acn-fctn=WWB6').replace(
    'Monitor World',
    'WWB 6X'
  );
  assert.equal(
    deviceFromAttributes(parseAttrRply(buildAttrRply(controller)), '10.0.0.9'),
    null
  );
  // and whatever else turns up on the port is ignored, not thrown on
  assert.equal(parseAttrRply(Buffer.from('not slp at all, just noise')), null);
  assert.equal(parseAttrRply(buildSrvRqst('service:esta.sdt')), null);
  assert.equal(parseAttrRply(Buffer.alloc(3)), null);
});

test('a service request is well-formed SLPv2', () => {
  const packet = buildSrvRqst('service:esta.sdt');
  assert.equal(packet[0], 2, 'version');
  assert.equal(packet[1], 1, 'SrvRqst');
  assert.equal(packet.readUIntBE(2, 3), packet.length);
  assert.ok(packet.includes(Buffer.from('service:esta.sdt')));
});

test('the local interface is the one whose subnet holds the device', async () => {
  // loopback is 127.0.0.0/8 on every machine these tests run on
  const local = await localInterfaceFor('127.0.0.9');
  assert.equal(local.address, '127.0.0.1');
  assert.ok(local.name);
});

test('the browser lists a unit while it advertises and notices when it stops', async (t) => {
  const slpPort = await freeUdpPort();
  const unit = await startFakeAd600({ slpPort, intervalMs: 30 });
  const browser = new SlpBrowser({
    port: slpPort,
    multicast: false,
    absentMs: 200,
  });
  t.after(async () => {
    browser.close();
    await unit.close();
  });

  assert.equal(
    browser.isPresent(unit.host),
    null,
    'nothing is known before listening'
  );
  const found = await browser.find(unit.host, 3_000);
  assert.equal(found?.cid, unit.cid);
  assert.deepEqual(
    browser.devices().map((d) => d.host),
    [unit.host]
  );
  assert.equal(
    await browser.find('127.0.0.77', 50),
    null,
    'an address with nothing on it'
  );

  const release = browser.hold();
  assert.equal(browser.isPresent(unit.host), true);
  unit.powerOff();
  await until(() => browser.isPresent(unit.host) === false, {
    what: 'the unit going absent',
  });
  unit.powerOn();
  await until(() => browser.isPresent(unit.host) === true, {
    what: 'the unit returning',
  });
  release();
});

// ---------------------------------------------------------------------------
// the engine process
// ---------------------------------------------------------------------------

const FAKE = { command: process.execPath, args: [FAKE_ENGINE] };
const DEVICE = {
  host: '127.0.0.1',
  port: 57383,
  cid: 'ddac0650000011dda000000eddcccccc',
};
const LOCAL = { name: 'lo0', address: '127.0.0.1' };

const scenario = (t, name) => {
  process.env.SB_AD600_FAKE_SCENARIO = name;
  t.after(() => delete process.env.SB_AD600_FAKE_SCENARIO);
};

test('an engine run decodes frames, reports milestones and leaves when asked', async () => {
  const plan = planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 350e3 });
  const seen = [];
  const milestones = [];
  const run = new EngineRun({
    engine: FAKE,
    device: DEVICE,
    local: LOCAL,
    plan,
    onFrame: (curve, lo, hi, amps) => seen.push({ curve, lo, hi, amps }),
    onMilestone: (name) => milestones.push(name),
  });
  run.start();
  await until(() => seen.length >= 12, { what: 'a pass of tiles' });

  // 417 points arrive as two tiles per antenna, sharing the point between them
  const [low, high] = seen;
  assert.equal(low.curve, 1);
  assert.equal(low.lo, plan.startIdx);
  assert.equal(low.hi, plan.startIdx + 300 * plan.compression);
  assert.equal(low.amps.length, 301);
  assert.equal(high.lo, low.hi);
  assert.equal(high.hi, gridOf(plan).top);
  assert.ok(
    low.amps.every((v) => v > -110 && v < -40),
    'tenths of a dBm, decoded'
  );
  assert.deepEqual(milestones, ['joined', 'owner', 'scan-ready']);

  await run.stop();
  const exit = await run.exited;
  assert.equal(exit.code, 0, 'it left by itself, cleanly');
  assert.equal(exit.requested, true);
  assert.match(run.recentOutput(), /clean disconnect sent/);
});

// A component id the device has seen recently is refused as already in use,
// and a retune reopens the session within seconds.
test('every session goes by a component id of its own', async () => {
  const ids = new Set(Array.from({ length: 200 }, sessionCid));
  assert.equal(ids.size, 200);
  for (const id of ids)
    assert.match(id, /^[1-9a-e][0-9a-f]{7}000011dda000000eddcccccc$/);

  const announced = [];
  for (let i = 0; i < 2; i += 1) {
    const run = new EngineRun({
      engine: FAKE,
      device: DEVICE,
      local: LOCAL,
      plan: planScan(),
      onFrame: () => {},
    });
    run.start();
    await until(() => /our CID=/.test(run.recentOutput()), {
      what: 'the engine starting',
    });
    announced.push(/our CID=([0-9a-f]{32})/.exec(run.recentOutput())[1]);
    await run.stop();
  }
  assert.notEqual(announced[0], announced[1]);
});

test('an engine that cannot be found says what to do about it', async () => {
  await assert.rejects(
    resolveEngine({ enginePath: '/nowhere/ad600_engine_bin' }, {}),
    (err) =>
      err instanceof EngineUnavailableError &&
      /does not exist/.test(err.message)
  );
  await assert.rejects(
    resolveEngine({ pythonPath: process.execPath }, {}),
    (err) =>
      err instanceof EngineUnavailableError && /Python 3/.test(err.message)
  );
  const mock = await resolveEngine({}, { SB_AD600_MOCK: '1' });
  assert.deepEqual(mock.args, [FAKE_ENGINE]);
});

// ---------------------------------------------------------------------------
// the scanner's decisions
// ---------------------------------------------------------------------------

const PATIENT = {
  joinMs: 6_000,
  firstFrameMs: 8_000,
  stallMs: 6_000,
  backoffMs: 30,
  settleMs: 30,
  quietMs: 60,
  presencePollMs: 25,
};

async function scannerWith(t, timings = {}) {
  const slpPort = await freeUdpPort();
  const unit = await startFakeAd600({ slpPort, intervalMs: 25 });
  const browser = new SlpBrowser({
    port: slpPort,
    multicast: false,
    absentMs: 150,
  });
  const statuses = [];
  const fatals = [];
  const frames = [];
  const scanner = new Ad600Scanner({
    engine: FAKE,
    device: DEVICE,
    local: LOCAL,
    discovery: browser,
    timings: { ...PATIENT, ...timings },
  });
  scanner.onStatus = (status) =>
    statuses.push(
      status.reason ? `${status.state}:${status.reason}` : status.state
    );
  scanner.onFatal = (failure) => fatals.push(failure);
  scanner.onFrame = (curve, lo) => frames.push({ curve, lo });
  t.after(async () => {
    await scanner.stop();
    browser.close();
    await unit.close();
  });
  return { scanner, unit, browser, statuses, fatals, frames };
}

test('the scanner streams, and stopping it ends the session', async (t) => {
  const { scanner, statuses, frames } = await scannerWith(t);
  scanner.start(planScan());
  await until(() => frames.length > 12, { what: 'frames' });
  assert.deepEqual(statuses, ['starting', 'streaming']);
  await scanner.stop();
  assert.equal(statuses.at(-1), 'stopped');
  const count = frames.length;
  await delay(150);
  assert.equal(frames.length, count, 'nothing arrives after stop');
});

test('a refused scan claim is not retried: the scanner waits for a power-cycle', async (t) => {
  scenario(t, 'not-owner');
  const { scanner, unit, statuses, frames, fatals } = await scannerWith(t);
  scanner.start(planScan());
  await until(() => statuses.includes('blocked:not-owner'), {
    what: 'the block',
  });

  // however long it is left, it does not try again by itself
  await delay(400);
  assert.equal(statuses.filter((s) => s === 'starting').length, 1);
  assert.equal(frames.length, 0);

  // Wireless Workbench is quit, and the device is switched off and on again
  delete process.env.SB_AD600_FAKE_SCENARIO;
  unit.powerOff();
  await delay(350);
  assert.equal(
    statuses.filter((s) => s === 'starting').length,
    1,
    'still waiting while it is off'
  );
  unit.powerOn();
  await until(() => statuses.at(-1) === 'streaming', {
    what: 'the scan resuming',
  });
  assert.equal(statuses.filter((s) => s === 'starting').length, 2);
  assert.deepEqual(fatals, []);
});

test('a refused session is tried again under a new identity, then waited out', async (t) => {
  scenario(t, 'join-refused');
  const { scanner, statuses, fatals } = await scannerWith(t);
  scanner.start(planScan());
  await until(() => statuses.includes('blocked:join-refused'), {
    what: 'the block',
  });
  assert.equal(statuses.filter((s) => s === 'starting').length, 3);
  assert.deepEqual(fatals, []);
});

test('a session that is accepted but never sends scan data is not waited on forever', async (t) => {
  scenario(t, 'silent');
  const { scanner, statuses, fatals } = await scannerWith(t, {
    firstFrameMs: 300,
  });
  scanner.start(planScan());
  await until(() => statuses.includes('blocked:no-scan'), {
    what: 'giving up',
  });
  assert.equal(statuses.filter((s) => s === 'starting').length, 3);
  assert.deepEqual(fatals, []);
});

test('a device that never answers is fatal', async (t) => {
  scenario(t, 'unreachable');
  const { scanner, statuses, fatals } = await scannerWith(t, { joinMs: 400 });
  scanner.start(planScan());
  await until(() => fatals.length > 0, { what: 'the fatal' });
  assert.equal(fatals[0].kind, 'unreachable');
  assert.ok(!statuses.includes('streaming'));
});

test('a scan that never starts gets three attempts, then waits', async (t) => {
  scenario(t, 'no-scan-ready');
  const { scanner, statuses, fatals } = await scannerWith(t);
  scanner.start(planScan());
  await until(() => statuses.includes('blocked:no-scan'), {
    what: 'giving up',
  });
  assert.equal(statuses.filter((s) => s === 'starting').length, 3);
  assert.deepEqual(fatals, []);
});

test('a stream that goes silent is restarted', async (t) => {
  scenario(t, 'stall:3');
  const { scanner, statuses } = await scannerWith(t, { stallMs: 500 });
  scanner.start(planScan());
  await until(() => statuses.includes('reconnecting'), {
    what: 'noticing the stall',
  });
  delete process.env.SB_AD600_FAKE_SCENARIO;
  await until(() => statuses.filter((s) => s === 'streaming').length >= 2, {
    what: 'streaming again',
  });
});

test('a session that runs out is followed by another', async (t) => {
  scenario(t, 'exit:3');
  const { scanner, statuses, fatals } = await scannerWith(t);
  scanner.start(planScan());
  await until(() => statuses.filter((s) => s === 'streaming').length >= 3, {
    what: 'three sessions',
  });
  assert.deepEqual(fatals, []);
  // routine, so not reported as an interruption
  assert.ok(statuses.includes('renewing'));
  assert.ok(!statuses.includes('reconnecting'));
});

test('a burst of retunes costs the device one new session, on the last of them', async (t) => {
  const { scanner, statuses, frames } = await scannerWith(t);
  scanner.start(planScan());
  await until(() => frames.length > 6, { what: 'frames' });

  let last;
  for (let mhz = 480; mhz <= 520; mhz += 10) {
    last = planScan({ startHz: mhz * 1e6, stopHz: 700e6 });
    scanner.retune(last);
    await delay(10);
  }
  frames.length = 0;
  await until(() => frames.length > 6, { what: 'frames of the retuned scan' });
  assert.ok(
    frames.every((f) => f.lo >= last.startIdx),
    'only the new scan is reported'
  );
  assert.equal(statuses.filter((s) => s === 'starting').length, 2);
});

// ---------------------------------------------------------------------------
// the real engine
// ---------------------------------------------------------------------------

// No AD600 is needed to prove the bundled engine starts under this driver:
// pointed at a loopback socket, it must send that socket an ACN session join
// carrying the identities it was given, and leave cleanly when told to.
test('the bundled Python engine boots, joins the address it is given, and quits cleanly', async (t) => {
  if (process.platform === 'win32') {
    t.skip('NOT RUN: the bundled engine has not been run on Windows');
    return;
  }
  let engine;
  try {
    engine = await resolveEngine({}, { PATH: process.env.PATH });
  } catch (err) {
    t.skip(`NOT RUN — the real engine was not exercised: ${err.message}`);
    return;
  }

  const device = dgram.createSocket('udp4');
  await new Promise((resolve) => device.bind(0, '127.0.0.1', resolve));
  const datagrams = [];
  device.on('message', (datagram) => datagrams.push(datagram));
  t.after(() => device.close());

  const plan = planScan({ startHz: 470e6, stopHz: 616e6, rbwHz: 350e3 });
  const run = new EngineRun({
    engine,
    device: { ...DEVICE, port: device.address().port },
    local: LOCAL,
    plan,
    // no multicast advert, and a source port nothing else is using
    extraEnv: { AD600_NO_SLP: '1', WWB_SRCPORT: String(await freeUdpPort()) },
    onFrame: () => {},
  });
  run.start();
  t.after(() => run.stop());

  await until(() => datagrams.length > 0, {
    timeoutMs: 15_000,
    what: `a datagram from the engine (its output:\n${run.recentOutput()})`,
  });
  const [join] = datagrams;
  assert.equal(
    join.subarray(4, 13).toString('latin1'),
    'ASC-E1.17',
    'an ACN root-layer packet'
  );
  const output = run.recentOutput();
  const ours = /our CID=([0-9a-f]{32})/.exec(output)?.[1];
  assert.ok(ours, `the engine did not say who it is:\n${output}`);
  assert.ok(join.includes(Buffer.from(ours, 'hex')), 'from our component id');
  assert.ok(join.includes(Buffer.from(DEVICE.cid, 'hex')), "to the device's");

  assert.match(output, /LOCKSTEP LOADED \d+ wrappers/);
  assert.match(
    output,
    /REAL_TIME_COMPRESSION → 14 \(delivered RBW = 350 kHz\)/
  );
  assert.match(output, /SCAN_START\/STOP → 470000-616000 kHz/);

  await run.stop();
  const exit = await run.exited;
  assert.equal(
    exit.code,
    0,
    `the engine exited ${exit.signal ?? exit.code}:\n${run.recentOutput()}`
  );
});
