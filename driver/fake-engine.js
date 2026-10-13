#!/usr/bin/env node
// A stand-in for the scan engine, so the plugin has something to run in tests
// and on a machine with no AD600 on the network.
//
// It honours the same contract as the real one (driver/protocol.md): the same
// arguments, the same environment, the same milestone lines and the same
// FRAME lines on stdout, the same `quit` line in the command file. What it
// does not do is touch the network. The process plumbing — spawn, line
// parsing, clean stop, a process that dies on its own — is therefore tested
// for real, with only the radio swapped out.
//
// It also behaves the way the hardware has been seen to: floor(span / step)
// points, sent as tiles of a few hundred that share their edge points, and —
// when asked — tiles that go missing, arrive unevenly, or decode to garbage.
//
//   SB_AD600_MOCK=1 npm start        # the whole plugin against this
//
// SB_AD600_FAKE_SCENARIO picks what the pretend device does:
//
//   (unset)         joins, claims the scan, streams until told to quit
//   not-owner       joins, but another controller holds the scan
//   join-refused    the device refuses the session
//   unreachable     nothing ever answers
//   silent          claims the scan, and then no scan data ever arrives
//   no-scan-ready   as an older engine reports a device that never arms
//   crash           the engine itself dies on startup
//   stall:<n>       streams n passes, then goes silent
//   exit:<n>        streams n passes, then leaves as if its session ran out
//   short           streams one point fewer than the settings predict
//   lossy:<pct>     that share of tiles never arrives (a fixed pattern)
//   uneven:<n>      the top tile arrives on every nth pass only
//   no-top          the top tile never arrives
//   corrupt         now and then a tile is garbage (thousands of dBm)
//
// SB_AD600_FAKE_TILE is the number of steps a tile spans (300, as observed).

import { readFileSync } from 'node:fs';

const [, , secondsArg, commandFile] = process.argv;
const env = process.env;
const scenario = env.SB_AD600_FAKE_SCENARIO ?? '';
const [mode, modeArg] = scenario.split(':');
const passMs = Number(env.SB_AD600_FAKE_SWEEP_MS) || 40;
const tileSteps = Number(env.SB_AD600_FAKE_TILE) || 300;

const FREQ_BASE_KHZ = 174_000;
const IDX_KHZ = 25;
const CURVES = 6;

const startKhz = Number(env.AD600_SCAN_START_KHZ) || 470_000;
const stopKhz = Number(env.AD600_SCAN_STOP_KHZ) || 1_000_000;
const compression = Number(env.AD600_RT_COMPRESSION) || 36;
const lo = Math.round((startKhz - FREQ_BASE_KHZ) / IDX_KHZ);
const hi = Math.round((stopKhz - FREQ_BASE_KHZ) / IDX_KHZ);
// floor(span / step) points from the start; the stop is never one of them
const pointCount =
  Math.floor((hi - lo) / compression) - (mode === 'short' ? 1 : 0);

// tiles share their edge points: [0..300], [300..600], … to the last point
const tiles = [];
for (let first = 0; first < pointCount - 1; first += tileSteps)
  tiles.push([first, Math.min(first + tileSteps, pointCount - 1)]);
if (tiles.length === 0) tiles.push([0, pointCount - 1]);

const started = Date.now();
const say = (text) =>
  process.stdout.write(
    `  ${((Date.now() - started) / 1000).toFixed(2).padStart(6)}s  ${text}\n`
  );
const bump = (x, center, width, height) =>
  height * Math.exp(-(((x - center) / width) ** 2));
// repeatable "randomness" for which tiles go missing
let seed = 12345;
const chance = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

let passes = 0;
let timer = null;
let leaving = false;

function leave(code = 0) {
  if (leaving) return;
  leaving = true;
  clearInterval(timer);
  process.stdout.write(
    '→ RELEASE_SCAN_ID bookend sent (slots 0..15 freed) — slot-0 free for next launch\n' +
      '→ clean disconnect sent (disassoc + LEAVING + root-leave)\n',
    () => process.exit(code)
  );
}

// a noise floor, a carrier a third of the way up and another at two thirds,
// and on every seventh pass a transient in the middle
function pass() {
  passes += 1;
  const transient = passes % 7 === 0;
  const lines = [];
  for (let curve = 1; curve <= CURVES; curve += 1) {
    tiles.forEach(([first, last], t) => {
      const top = t === tiles.length - 1;
      if (top && mode === 'no-top') return;
      if (top && mode === 'uneven' && passes % Number(modeArg) !== 0) return;
      if (mode === 'lossy' && chance() < Number(modeArg) / 100) return;
      const count = last - first + 1;
      const raw = Buffer.alloc(count * 2);
      const garbage = mode === 'corrupt' && curve === 2 && passes % 3 === 0;
      for (let k = 0; k < count; k += 1) {
        const x = (first + k) / (pointCount - 1);
        let dbm = -100 - curve + (Math.random() * 4 - 2);
        dbm += bump(x, 1 / 3, 0.01, 45);
        dbm += bump(x, 2 / 3, 0.006, 30);
        if (transient) dbm += bump(x, 0.5, 0.004, 50);
        if (garbage && k % 5 === 0) dbm = 2253;
        raw.writeInt16BE(Math.round(dbm * 10), k * 2);
      }
      const from = lo + first * compression;
      const to = lo + last * compression;
      lines.push(`FRAME ${curve} ${from} ${to} ${raw.toString('base64')}`);
    });
  }
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  if (mode === 'stall' && passes >= Number(modeArg)) clearInterval(timer);
  if (mode === 'exit' && passes >= Number(modeArg)) leave();
}

function begin() {
  if (mode === 'crash') {
    process.stderr.write(
      'Traceback (most recent call last):\n' +
        'RuntimeError: the fake engine was told to crash\n'
    );
    process.exit(1);
  }
  process.stdout.write(
    `our CID=${env.WWB_CID ?? ''}  our chan=0x8A30  src port=64198  dev=${env.WWB_DEVIP ?? ''}:${env.WWB_DEVPORT ?? ''}\n` +
      '→ JOIN sent (leader chan 0x8A30, reliable seq-base=0x8A30 → first reliable=0x8A31)\n'
  );
  if (mode === 'unreachable') return;
  if (mode === 'join-refused') {
    process.stdout.write(
      `← JOIN_REFUSE full=00  leaderCID=${env.WWB_CID ?? ''}(OURS)  reason=6(NO_RECIPROCAL)\n` +
        `   [IDENTITY IN USE] our WWB_CID=${env.WWB_CID ?? ''}\n`
    );
    return;
  }
  process.stdout.write(
    '*** JOINED — us=0x8A30 dev=0x0001  key=00 ***\nCONNECTED\n'
  );
  if (mode === 'not-owner') {
    say(
      '⚠️  NOT OWNER (0x0107010f GFAIL) — need boot-first / WWB off; ABORTING arm to avoid poisoning'
    );
    // the engine gives up the session by itself when the claim is refused
    leave();
    return;
  }
  say('★★★ OWNERSHIP CLAIMED (slot 0) — GET 0x0107010f ANSWERED; arming sweep');
  if (mode === 'no-scan-ready') {
    say(
      '⚠️  scan-ready EVENT 0x01070137=0e NOT pushed within 6.0s of ownership — owner-ready never reached; NOT firing arm (no-op START avoided)'
    );
    return;
  }
  say('✪✪ SCAN-READY gate open — ARM firing');
  if (mode === 'silent') return;
  timer = setInterval(pass, passMs);
}

// the command file is the control channel: `quit` means leave cleanly
let consumed = 0;
setInterval(() => {
  let text = '';
  try {
    text = readFileSync(commandFile, 'utf8');
  } catch {
    return;
  }
  const fresh = text.slice(consumed);
  consumed = text.length;
  if (fresh.split('\n').some((line) => line.trim() === 'quit')) leave();
}, 20);

process.on('SIGINT', () => leave());
process.on('SIGTERM', () => leave());
// like the real launcher: an engine never outlives the plugin that started it
process.stdin.on('end', () => leave());
process.stdin.on('error', () => {});
process.stdin.resume();
setTimeout(
  () => leave(),
  Math.min((Number(secondsArg) || 3600) * 1000, 2 ** 31 - 1)
);

setTimeout(begin, 10);
