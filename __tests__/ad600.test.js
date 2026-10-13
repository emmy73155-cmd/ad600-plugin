// Contract tests for the adapter, driven through the real shell over real HTTP.
//
// Nothing here needs an AD600. A fake one advertises on a loopback port
// (driver/fake-ad600.js) and the scan engine is replaced by a stand-in that
// honours the same process contract (driver/fake-engine.js), so everything
// between the HTTP request and the engine's stdout is the real thing: shell,
// adapter, discovery, scanner, child process, frame parsing, sweep assembly.
//
// Read these as the executable half of docs/adapter-reference.md, for a device
// whose resolution has one knob and whose scan belongs to one controller.
//
// Nothing here hardcodes the plugin's id: everything that could change when you
// run `npm run rename` is read from soundbase-plugin.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { freeUdpPort, startFakeAd600 } from '../driver/fake-ad600.js';
import { FAKE_ENGINE } from '../driver/engine-process.js';

// before the plugin loads: where it listens for adverts, and what it runs
const slpPort = await freeUdpPort();
process.env.SB_AD600_SLP_PORT = String(slpPort);
process.env.SB_AD600_ENGINE = FAKE_ENGINE;
const unit = await startFakeAd600({ slpPort, name: 'FOH AD600' });

const { PRODUCT } = await import('../adapter.js');
const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const DEVICE_ID = `net:${unit.host}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const RBW_HZ = 350_000;
// The device sends floor(span / step) points from the start and never reaches
// the stop: 146 MHz at 350 kHz is 417 of them, the last 400 kHz short of it.
const POINT_COUNT = 417;
const LAST_POINT_HZ = START_HZ + (POINT_COUNT - 1) * RBW_HZ;

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (
  probe,
  { timeoutMs = 5_000, what = 'the condition' } = {}
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`${what} never happened`);
    await delay(25);
  }
};

const listed = async () => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === DEVICE_ID);
};
const configure = (body) =>
  request('POST', `${DEVICE_PATH}/configuration`, body);
const startSweep = () => request('POST', `${DEVICE_PATH}/sweep/start`);
const stopSweep = () => request('POST', `${DEVICE_PATH}/sweep/stop`);
const trace = () => request('GET', `${DEVICE_PATH}/trace`);

// what the pretend device does on its next session; see driver/fake-engine.js
const scenario = (t, name) => {
  process.env.SB_AD600_FAKE_SCENARIO = name;
  t.after(() => delete process.env.SB_AD600_FAKE_SCENARIO);
};

test.after(async () => {
  await handle.close();
  await unit.close();
});

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores, and the only clue is one
// warning line in the plugin log. Catch it here instead.
test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
  );
  assert.ok(
    PRODUCT.startsWith(`plugin:${manifest.id}/`),
    `a deviceTypeId is namespaced by the plugin id: expected ` +
      `plugin:${manifest.id}/… but adapter.js announces ${PRODUCT}`
  );
});

test('an advertising AD600 is discovered under a stable, address-derived id', async () => {
  const device = await until(listed, { what: 'discovery of the fake AD600' });
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.equal(device.name, `FOH AD600 (${unit.host})`);
  assert.deepEqual(device.transport, {
    kind: 'network',
    host: unit.host,
    port: 57383,
  });
  // a discovered device is not opened until something asks it to do work
  assert.equal(device.capabilities, undefined);
});

test('open() reports what the device can be asked for', async () => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ });

  const caps = (await listed()).capabilities;
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.ok(caps.maxFrequencyHz > caps.minFrequencyHz);
  // resolution is compression × 25 kHz, and nothing in between
  assert.equal(caps.rbwHz[0], 50_000);
  assert.equal(caps.rbwHz.at(-1), 900_000);
  assert.ok(caps.rbwHz.every((hz) => hz % 25_000 === 0));
  assert.equal(caps.minStepHz, 50_000);
  assert.equal(caps.maxStepHz, 900_000);
  // the shell accumulates all four trace modes in software, so every device
  // advertises them whether or not the hardware has the feature
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
});

test('config, start and trace produce a plausible spectrum, one curve per antenna', async (t) => {
  const applied = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: RBW_HZ,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, START_HZ);
  // the echo is what the device will send, not what was asked for
  assert.equal(applied.body.stopHz, LAST_POINT_HZ);
  assert.equal(applied.body.pointCount, POINT_COUNT);
  assert.equal(applied.body.rbwHz, RBW_HZ);
  assert.equal(applied.body.stepHz, RBW_HZ);

  const started = await startSweep();
  assert.equal(started.status, 200);
  assert.equal(started.body.sweeping, true);
  t.after(stopSweep);

  const { status, body } = await trace();
  assert.equal(status, 200);
  assert.equal(body.pointCount, POINT_COUNT);
  assert.equal(body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, LAST_POINT_HZ);
  assert.equal(body.stepHz, RBW_HZ);
  assert.equal(body.unit, 'dBm');
  assert.ok(body.sweepId >= 1);

  // six antennas, each on the primary trace's axis
  assert.deepEqual(
    body.series.map((s) => s.name),
    ['A', 'B', 'C', 'D', 'E', 'F']
  );
  for (const curve of body.series)
    assert.equal(curve.amplitudesDbm.length, POINT_COUNT);
  // the primary trace is the strongest any antenna heard at each point
  for (const i of [0, 139, 278, POINT_COUNT - 1]) {
    assert.equal(
      body.amplitudesDbm[i],
      Math.max(...body.series.map((s) => s.amplitudesDbm[i]))
    );
  }

  const amps = body.amplitudesDbm;
  // carriers sit at one third and two thirds of the span
  const bins = (from, to) => amps.slice(from, to);
  const floorBins = [...bins(10, 100), ...bins(330, 410)];
  const floorMin = Math.min(...floorBins);
  const floorMax = Math.max(...floorBins);
  assert.ok(floorMin >= -106, `noise floor dipped to ${floorMin}`);
  assert.ok(floorMax <= -94, `noise floor rose to ${floorMax}`);

  const floorMean = floorBins.reduce((a, b) => a + b, 0) / floorBins.length;
  const carrierA = Math.max(...bins(132, 146));
  const carrierB = Math.max(...bins(272, 284));
  assert.ok(carrierA >= floorMean + 20, `carrier A only reached ${carrierA}`);
  assert.ok(carrierB >= floorMean + 20, `carrier B only reached ${carrierB}`);
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const caps = (await listed()).capabilities;

  const range = await configure({
    startHz: 0,
    stopHz: caps.maxFrequencyHz * 10,
    rbwHz: 900_000,
  });
  assert.equal(range.status, 200, 'a request outside the range is still a 200');
  assert.equal(range.body.startHz, caps.minFrequencyHz);
  assert.ok(range.body.stopHz <= caps.maxFrequencyHz);
  assert.ok(range.body.stopHz > caps.maxFrequencyHz - 2 * 900_000);

  // finer than the device goes, and coarser
  const narrow = { startHz: 470_000_000, stopHz: 500_000_000 };
  const fine = await configure({ ...narrow, rbwHz: 1_000 });
  assert.equal(fine.status, 200);
  assert.equal(fine.body.rbwHz, 50_000);
  const coarse = await configure({ ...narrow, rbwHz: 5_000_000 });
  assert.equal(coarse.body.rbwHz, 900_000);

  // a fine resolution over a wide range is coarsened to a sensible trace
  const dense = await configure({
    startHz: caps.minFrequencyHz,
    stopHz: caps.maxFrequencyHz,
    rbwHz: 50_000,
  });
  assert.equal(dense.status, 200);
  assert.ok(dense.body.pointCount <= 2000, `${dense.body.pointCount} points`);
  assert.equal(dense.body.rbwHz, 275_000);

  // a span too narrow to hold two points is widened to one that can
  const sliver = await configure({
    startHz: 500_000_000,
    stopHz: 500_010_000,
    rbwHz: 350_000,
  });
  assert.equal(sliver.status, 200);
  assert.equal(sliver.body.pointCount, 2);
  assert.equal(sliver.body.stopHz - sliver.body.startHz, sliver.body.rbwHz);
});

test('what applyConfig returns is what GET /configuration reports', async () => {
  const applied = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: 500_000,
  });
  const reported = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.equal(reported.status, 200);
  assert.deepEqual(reported.body, applied.body);
});

test('a request carrying only the range leaves the resolution in force', async () => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 500_000 });
  const moved = await configure({
    startHz: 520_000_000,
    stopHz: 580_000_000,
  });
  assert.equal(moved.body.startHz, 520_000_000);
  assert.equal(moved.body.rbwHz, 500_000);
  assert.equal(moved.body.pointCount, 60_000_000 / 500_000);
});

// The AD600 has no point count of its own: it delivers a point every
// resolution step. A requested count therefore picks the nearest resolution
// and the echo says how many points that really is.
test('without an RBW, the point count asked for picks the nearest resolution', async () => {
  const applied = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: null,
    pointCount: 401,
  });
  assert.equal(applied.status, 200);
  // 146 MHz in 401 points is 364 kHz each, and the nearest the device has is 375
  assert.equal(applied.body.stepHz, 375_000);
  assert.equal(applied.body.pointCount, 389);
  // nobody asked for an RBW, so it is reported as resolved, not as requested
  assert.equal(applied.body.rbwHz, undefined);
  assert.equal(applied.body.resolved.rbwHz, 375_000);
});

test('successive polls see successive sweeps', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: RBW_HZ });
  await startSweep();
  t.after(stopSweep);

  const first = await trace();
  const startedAt = Date.now();
  const second = await trace();
  const elapsed = Date.now() - startedAt;

  assert.ok(second.body.sweepId > first.body.sweepId);
  // the long poll returns on the next sweep rather than after the hold cap
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);
});

// Raw sweeps are reported and the shell holds them, so a transient no client
// happened to poll for is still on the plot.
test('max-hold keeps the peak of every sweep, including the transient', async (t) => {
  await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: RBW_HZ,
    traceMode: 'max-hold',
  });
  await startSweep();
  t.after(async () => {
    await stopSweep();
    await configure({ traceMode: 'clear-write' });
  });

  // A trace is reported for every tile that arrives, twelve to a pass of the
  // fake's six antennas here, and its transient comes round every seventh pass.
  let latest = await trace();
  const target = latest.body.sweepId + 12 * 10;
  const deadline = Date.now() + 5_000;
  while (latest.body.sweepId < target && Date.now() < deadline) {
    latest = await trace();
  }

  assert.ok(
    latest.body.sweepId >= target,
    `only reached sweep ${latest.body.sweepId}`
  );
  const midband = Math.max(...latest.body.amplitudesDbm.slice(203, 215));
  assert.ok(midband >= -70, `transient never accumulated (peak ${midband})`);
});

// The device latches its scan settings when the scan is armed, so a new range
// means a new session. The old one's sweeps must not turn up labelled with the
// new axis in the meantime.
test('retuning while sweeping re-arms the scan on the new range', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: RBW_HZ });
  await startSweep();
  t.after(stopSweep);
  assert.equal((await trace()).body.startHz, START_HZ);

  const applied = await configure({
    startHz: 500_000_000,
    stopHz: 600_000_000,
    rbwHz: 500_000,
  });
  assert.equal(applied.body.pointCount, 200);

  const retuned = await until(
    async () => {
      const { body } = await trace();
      return body.startHz === 500_000_000 ? body : null;
    },
    { timeoutMs: 8_000, what: 'a sweep of the new range' }
  );
  assert.equal(retuned.stopHz, 599_500_000);
  assert.equal(retuned.pointCount, 200);
  assert.equal(retuned.amplitudesDbm.length, 200);
  assert.equal(retuned.stepHz, 500_000);
});

// The plan predicts the grid; the data is the truth. A device that sends a
// different grid must not have its trace drawn on the predicted axis.
test('a device that sends a different grid than predicted is reported as it is', async (t) => {
  scenario(t, 'short');
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: RBW_HZ });
  await startSweep();
  t.after(stopSweep);

  const body = await until(
    async () => {
      const got = await trace();
      return got.status === 200 && got.body.pointCount === POINT_COUNT - 1
        ? got.body
        : null;
    },
    { what: 'a sweep on the grid the device actually sent' }
  );
  assert.equal(body.amplitudesDbm.length, POINT_COUNT - 1);
  assert.equal(body.startHz, START_HZ);
  assert.equal(body.stopHz, LAST_POINT_HZ - RBW_HZ);
  assert.equal(body.stepHz, RBW_HZ);

  const reported = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.equal(reported.body.pointCount, POINT_COUNT - 1);
  assert.equal(reported.body.stopHz, LAST_POINT_HZ - RBW_HZ);
  // and asking for the same thing again does not put the prediction back
  const again = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    rbwHz: RBW_HZ,
  });
  assert.equal(again.body.pointCount, POINT_COUNT - 1);
});

// One controller at a time: when Wireless Workbench has the scan, the claim is
// refused. That is not a dead device and it is not retried — it is a condition
// a person has to clear, and the message has to say how.
test('a scan held by another controller is a critical warning, not a failure', async (t) => {
  scenario(t, 'not-owner');
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: RBW_HZ });
  await startSweep();

  const device = await until(
    async () => {
      const d = await listed();
      return d.status.warnings?.length ? d : null;
    },
    { what: 'the scan-held warning' }
  );
  assert.equal(device.status.status, 'ok');
  assert.equal(device.status.warnings.length, 1);
  const [warning] = device.status.warnings;
  assert.equal(warning.id, 'scan-held');
  assert.equal(warning.severity, 'critical');
  assert.match(warning.message, /Wireless Workbench/);
  assert.match(warning.message, /power-cycle/);

  // stopping the sweep stops waiting, and the condition goes with it
  await stopSweep();
  assert.equal((await listed()).status.warnings, undefined);
});

// The hardware sends a wide, fine scan as several tiles per antenna, and not
// evenly: the top tile of a band has been seen to arrive a minute after the
// bottom one. Nothing is a sweep until every antenna has every point.
const TILED = { startHz: START_HZ, stopHz: STOP_HZ, rbwHz: 100_000 };
const TILED_POINTS = 1460;

test('tiles that arrive unevenly make a trace only once the band is whole', async (t) => {
  scenario(t, 'uneven:5');
  const applied = await configure(TILED);
  assert.equal(applied.body.pointCount, TILED_POINTS);
  await startSweep();
  t.after(stopSweep);

  const body = await until(
    async () => {
      const got = await trace();
      return got.body?.pointCount === TILED_POINTS ? got.body : null;
    },
    { what: 'a whole sweep of the tiled band' }
  );
  assert.equal(body.stopHz, 615_900_000);
  for (const curve of [body, ...body.series]) {
    assert.equal(curve.amplitudesDbm.length, TILED_POINTS);
    // every point measured, the top tile included: none padded to the floor
    assert.ok(Math.min(...curve.amplitudesDbm) > -115);
  }
});

test('tiles that go missing delay a trace but never put a hole in one', async (t) => {
  scenario(t, 'lossy:30');
  await configure(TILED);
  await startSweep();
  t.after(stopSweep);

  let latest = await until(
    async () => {
      const got = await trace();
      return got.body?.pointCount === TILED_POINTS ? got : null;
    },
    { what: 'a whole sweep despite the losses' }
  );
  const target = latest.body.sweepId + 5;
  while (latest.body.sweepId < target) latest = await trace();
  for (const curve of [latest.body, ...latest.body.series])
    assert.ok(Math.min(...curve.amplitudesDbm) > -115);
});

test('a tile that decodes to garbage never reaches the trace', async (t) => {
  scenario(t, 'corrupt');
  await configure({ ...TILED, traceMode: 'max-hold' });
  await startSweep();
  t.after(async () => {
    await stopSweep();
    await configure({ traceMode: 'clear-write' });
  });

  let latest = await until(
    async () => {
      const got = await trace();
      return got.body?.pointCount === TILED_POINTS ? got : null;
    },
    { what: 'a sweep' }
  );
  // thirty tiles to a pass, and garbage on every third: long enough for several
  const target = latest.body.sweepId + 30 * 8;
  while (latest.body.sweepId < target) latest = await trace();
  for (const curve of [latest.body, ...latest.body.series])
    assert.ok(Math.max(...curve.amplitudesDbm) < 0, 'nothing impossible held');
});

test('a band that will not fill is not drawn in part, and the reason is given', async (t) => {
  scenario(t, 'no-top');
  await configure(TILED);
  await startSweep();
  t.after(stopSweep);

  const device = await until(
    async () => {
      const d = await listed();
      return d.status.warnings?.some((w) => w.id === 'scan-filling') ? d : null;
    },
    { timeoutMs: 15_000, what: 'the scan-filling notice' }
  );
  assert.equal(device.status.status, 'ok');
  assert.equal(device.status.warnings[0].severity, 'info');

  // sinceSweepId=0 answers with the latest sweep at once, rather than holding
  const latest = () => request('GET', `${DEVICE_PATH}/trace?sinceSweepId=0`);
  const before = await latest();
  await delay(300);
  const after = await latest();
  assert.equal(
    after.body.sweepId,
    before.body.sweepId,
    'no partial sweep was served'
  );
});

test('an engine that dies marks the device failed, and the next start recovers', async (t) => {
  scenario(t, 'crash');
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, rbwHz: RBW_HZ });
  await startSweep();

  const failed = await until(
    async () => {
      const d = await listed();
      return d.status.status === 'failed' ? d : null;
    },
    { what: 'the device being marked failed' }
  );
  assert.match(failed.status.message, /scan engine stopped unexpectedly/);
  assert.match(failed.status.message, /told to crash/);

  // a failure is not sticky: the device reopens on the next operation
  delete process.env.SB_AD600_FAKE_SCENARIO;
  const before = (await trace()).body?.sweepId ?? 0;
  const restarted = await startSweep();
  assert.equal(restarted.status, 200);
  t.after(stopSweep);
  const fresh = await until(
    async () => {
      const got = await trace();
      return got.status === 200 && got.body.sweepId > before ? got.body : null;
    },
    { what: 'a sweep after the restart' }
  );
  assert.equal(fresh.amplitudesDbm.length, fresh.pointCount);
  assert.equal((await listed()).status.status, 'ok');
});

test('a device with nothing at its address fails to open with a reason', async (t) => {
  const added = await request('POST', '/devices', {
    id: 'net:127.0.0.9',
    product: PRODUCT,
    config: { host: '127.0.0.9' },
  });
  assert.equal(added.status, 201);
  t.after(() => request('DELETE', '/devices/net%3A127.0.0.9'));

  const device = await until(
    async () => {
      const { body } = await request('GET', '/devices');
      const d = body.devices.find((x) => x.id === 'net:127.0.0.9');
      return d?.status.status === 'failed' ? d : null;
    },
    { timeoutMs: 10_000, what: 'the unreachable device being marked failed' }
  );
  assert.match(
    device.status.message,
    /No AD600 is advertising at 127\.0\.0\.9/
  );
});
