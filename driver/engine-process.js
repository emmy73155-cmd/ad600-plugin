// One run of the scan engine, as a child process this plugin can always kill.
//
// The engine (driver/engine/, Python) is what speaks the AD600's protocol:
// SLP advert, SDT join, session keys, the scan-ownership claim, the arm, and
// the decode of the scan stream. It is run exactly as its authors ran it —
//
//   <engine> <run-for-seconds> <command-file> <log-file>
//
// with the session's identity and the scan settings in the environment — and
// it reports on stdout: one `FRAME <curve> <lo> <hi> <base64>` line per decoded
// scan tile, and human-readable milestone lines in between. This module
// spawns it, turns those lines into callbacks, and stops it cleanly.
//
// "Cleanly" matters more here than for most devices. An AD600 serves one scan
// controller, and a session that is dropped rather than closed leaves it
// holding the slot until it is power-cycled. So stopping asks first (a `quit`
// line in the command file, which makes the engine release the slot and leave)
// and only then escalates through SIGINT and SIGTERM to SIGKILL.
//
// On Windows there are no signals to escalate through: Node's kill() there is
// TerminateProcess, which gives the engine no chance to leave. So on Windows
// the second request is closing the engine's stdin — the launcher
// (engine/run_console.py) turns that into the same clean exit — and only the
// last resort kills.
//
// driver/protocol.md describes the contract with the engine in full.

import { execFile, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = fileURLToPath(new URL('./engine/', import.meta.url));
const LAUNCHER = join(ENGINE_DIR, 'run_console.py');
export const FAKE_ENGINE = fileURLToPath(
  new URL('./fake-engine.js', import.meta.url)
);

// Wireless Workbench's source port, which the engine binds and advertises. A
// second AD600 scanned at the same time gets the next one up.
const BASE_SOURCE_PORT = 64198;
// The engine's own default session length. When it runs out the engine leaves
// cleanly and the scanner starts another; see README.md, "Known behaviour".
const DEFAULT_SESSION_SECS = 3600;

const IS_WINDOWS = process.platform === 'win32';

const QUIT_GRACE_MS = 3_000;
// Windows only: after the stdin pipe closes, the launcher's clean exit
const STDIN_CLOSE_GRACE_MS = 3_000;
const SIGINT_GRACE_MS = 2_000;
const SIGTERM_GRACE_MS = 1_000;
const KEPT_LINES = 30;

// The scan recipe: late ownership claim, scan-ready-gated arm. These select
// the start sequence the engine was validated with; anything already in the
// environment wins. The engine's own defaults are left alone for how long it
// waits at each stage, since those were tuned on hardware and differ between
// engine versions.
const RECIPE = {
  AD600_REACTIVE_ACK: '1',
  AD600_DROP_SPURIOUS: '1',
  AD600_ARM_ON_STATUS: '1',
  AD600_OWNER_CLAIM: '1',
  AD600_PERSIST_UNTIL_STATUS: '0',
  AD600_LOOP_UNTIL_OWN: '0',
  AD600_AUTO_ARM: '0',
  AD600_ACCESS_PROBE: '0',
  AD600_SOCK_TIMEOUT: '0.004',
  AD600_POLL: '0.003',
};

// The fixed tail of a Shure ACN component id.
const CID_TAIL = '000011dda000000eddcccccc';

/**
 * A component id for one session, never used before. An id the device has
 * seen recently — one derived from this computer's MAC, say — is refused as
 * already in use when a session is reopened quickly, which is exactly what a
 * retune does.
 */
export const sessionCid = () =>
  randomInt(0x10000000, 0xf0000000).toString(16).padStart(8, '0') + CID_TAIL;

/** The engine cannot be started on this machine, and the message says what to do. */
export class EngineUnavailableError extends Error {}

const run = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      // windowsHide: no console window flashing up for each probe
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout).trim())
    );
  });

/**
 * The Python 3.8+ that `command` runs, as the path of its interpreter, or
 * null when it is not one. The path matters on Windows: `py` and the
 * Microsoft Store's `python` are launchers that start the real interpreter as
 * a child of their own, and a launcher in between would stand between this
 * plugin and the engine when it has to be stopped.
 */
async function probePython(command) {
  const answer = await run(command, [
    '-c',
    'import sys; print("%d.%d" % sys.version_info[:2]); print(sys.executable)',
  ]);
  const [version = '', executable = ''] = (answer ?? '').split(/\r?\n/);
  const [major, minor] = version.trim().split('.').map(Number);
  if (major !== 3 || !(minor >= 8)) return null;
  if (!IS_WINDOWS) return command;
  const real = executable.trim();
  return real && existsSync(real) ? real : command;
}

/** Every python.exe under `dir`\\Python3*, newest version first. */
function windowsInstalls(dir) {
  if (!dir) return [];
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^Python3\d+/i.test(name));
  } catch {
    return [];
  }
  const minor = (name) => Number(/^Python3(\d+)/i.exec(name)?.[1] ?? 0);
  return names
    .sort((a, b) => minor(b) - minor(a))
    .map((name) => join(dir, name, 'python.exe'));
}

function pythonCandidates(env) {
  if (IS_WINDOWS) {
    // `py` is the launcher python.org's installer puts on every PC, whether or
    // not "Add python.exe to PATH" was ticked; then whatever is on PATH; then
    // the places python.org's installer uses, for a PATH that has neither.
    return [
      'py',
      'python',
      'python3',
      ...windowsInstalls(
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Python')
      ),
      ...windowsInstalls(env.ProgramFiles),
      ...windowsInstalls(env['ProgramFiles(x86)']),
    ].filter((path, i, all) => all.indexOf(path) === i);
  }
  if (process.platform !== 'darwin') return ['python3', 'python'];
  // Not /usr/bin/python3: on a Mac without the command-line tools that is a
  // stub which answers by opening an "install developer tools?" dialog.
  const onPath = (env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir && dir !== '/usr/bin')
    .map((dir) => join(dir, 'python3'));
  return [
    ...onPath,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
    '/Library/Developer/CommandLineTools/usr/bin/python3',
    '/Applications/Xcode.app/Contents/Developer/usr/bin/python3',
  ].filter((path, i, all) => all.indexOf(path) === i && existsSync(path));
}

let foundPython = null;

async function resolvePython(explicit, env) {
  if (explicit) {
    if (await probePython(explicit)) return explicit;
    throw new EngineUnavailableError(
      `The Python path set for this plugin, "${explicit}", is not a working Python 3.8 or newer.`
    );
  }
  if (foundPython) return foundPython;
  for (const candidate of pythonCandidates(env)) {
    const python = await probePython(candidate);
    if (python) return (foundPython = python);
  }
  throw new EngineUnavailableError(
    IS_WINDOWS
      ? 'The AD600 scan engine needs Python 3.8 or newer, and none was found ' +
          'on this PC. Install it from python.org (tick "Add python.exe to ' +
          'PATH" in the installer), then restart SoundBase, or set ' +
          '"Python 3 path" in this plugin\'s settings.'
      : process.platform === 'darwin'
      ? 'The AD600 scan engine needs Python 3, and none was found on this Mac. ' +
          'Run `xcode-select --install` in Terminal (or install Python from python.org), ' +
          'or set "Python 3 path" in this plugin\'s settings.'
      : 'The AD600 scan engine needs Python 3.8 or newer, and none was found. ' +
          'Install it, or set "Python 3 path" in this plugin\'s settings.'
  );
}

/**
 * How to start the engine on this machine: an explicit override first, then
 * the bundled Python engine under whichever Python 3 can be found.
 *
 * @param {{ enginePath?: string, pythonPath?: string }} [pluginConfig]
 * @returns {Promise<{ command: string, args: string[], label: string }>}
 */
export async function resolveEngine(pluginConfig = {}, env = process.env) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const pythonPath = text(pluginConfig.pythonPath) ?? text(env.SB_AD600_PYTHON);
  const override =
    text(pluginConfig.enginePath) ??
    text(env.SB_AD600_ENGINE) ??
    (env.SB_AD600_MOCK === '1' ? FAKE_ENGINE : null);

  if (override) {
    if (!existsSync(override)) {
      throw new EngineUnavailableError(
        `The scan engine set for this plugin, "${override}", does not exist.`
      );
    }
    const kind = extname(override).toLowerCase();
    if (kind === '.js' || kind === '.mjs')
      return { command: process.execPath, args: [override], label: override };
    if (kind === '.py') {
      const python = await resolvePython(pythonPath, env);
      return { command: python, args: ['-u', override], label: override };
    }
    // a compiled build of the engine takes the same arguments
    return { command: override, args: [], label: override };
  }

  const python = await resolvePython(pythonPath, env);
  return {
    command: python,
    args: ['-u', LAUNCHER],
    label: `${python} (bundled engine)`,
  };
}

const sourcePorts = new Set();
const claimSourcePort = () => {
  let port = BASE_SOURCE_PORT;
  while (sourcePorts.has(port)) port += 1;
  sourcePorts.add(port);
  return port;
};

/** each running engine, with its command file */
const children = new Map();
// a plugin that is exiting cannot wait, but it can still ask
process.once('exit', () => {
  for (const [child, commandFile] of children) {
    if (IS_WINDOWS) {
      // kill() would be TerminateProcess, which is exactly the unclean exit
      // this is trying to avoid. Ask instead: the engine reads `quit`, and its
      // launcher also leaves cleanly once our end of its stdin closes, which
      // happens as this process goes.
      try {
        appendFileSync(commandFile, 'quit\n');
      } catch {
        // already gone
      }
      continue;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
});

const MILESTONES = [
  ['joined', /\*\*\* JOINED/],
  ['join-refused', /JOIN_REFUSE/],
  ['owner', /OWNERSHIP CLAIMED/],
  ['not-owner', /NOT OWNER/],
  ['scan-ready', /SCAN-READY gate open|SCAN-READY EVENT 0x01070137/],
  ['no-scan-ready', /NOT firing arm/],
];
// one of these per scan tile or sweep: never worth keeping
const CHATTER =
  /RF_SCAN_DATA curve=|FIREHOSE EVENT|SWEEP-ID EVENT|SWEEP-STATE EVENT|BIG PACKET|wrapper {3}device reliable-seq/;

export class EngineRun {
  /**
   * @param {{
   *   engine: { command: string, args: string[] },
   *   device: { host: string, port: number, cid: string },
   *   local: { name: string, address: string },
   *   plan: { startKhz: number, stopKhz: number, compression: number },
   *   extraEnv?: Record<string, string>,
   *   onFrame: (curve: number, lo: number, hi: number, amps: number[]) => void,
   *   onMilestone?: (name: string, line: string) => void,
   * }} options
   */
  constructor({ engine, device, local, plan, extraEnv, onFrame, onMilestone }) {
    this.engine = engine;
    this.device = device;
    this.local = local;
    this.plan = plan;
    this.extraEnv = extraEnv ?? {};
    this.onFrame = onFrame;
    this.onMilestone = onMilestone ?? (() => {});
    this.child = null;
    this.lines = [];
    this.stopping = null;
    this.scratch = null;
    this.sourcePort = null;
    /** resolves with `{ code, signal, requested }` when the process is gone */
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));
  }

  start() {
    const base = process.env.SB_PLUGIN_DATA_DIR || os.tmpdir();
    this.scratch = mkdtempSync(join(base, 'ad600-engine-'));
    this.commandFile = join(this.scratch, 'console_cmd.txt');
    // the engine builds its scan commands itself; this tells it to
    writeFileSync(this.commandFile, 'genfeed\n');
    // It logs a line per scan frame, without limit, so by default it logs to
    // nowhere. Point SB_AD600_ENGINE_LOG at a file to keep a session.
    const logFile = process.env.SB_AD600_ENGINE_LOG || os.devNull;
    const seconds = String(
      Number(process.env.SB_AD600_SESSION_SECS) || DEFAULT_SESSION_SECS
    );

    this.sourcePort = claimSourcePort();
    const env = {
      ...RECIPE,
      ...process.env,
      WWB_DEVCID: this.device.cid,
      WWB_DEVIP: this.device.host,
      WWB_DEVPORT: String(this.device.port),
      WWB_CID: sessionCid(),
      WWB_MYIP: this.local.address,
      AD600_MCAST_IF: this.local.name,
      AD600_RT_COMPRESSION: String(this.plan.compression),
      AD600_SCAN_START_KHZ: String(this.plan.startKhz),
      AD600_SCAN_STOP_KHZ: String(this.plan.stopKhz),
      AD600_EMIT_FRAMES: '1',
      AD600_CONSOLE_SECS: seconds,
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      // the milestone lines carry non-ASCII markers, and a process started by
      // a desktop app has no locale to say how to encode them
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...this.extraEnv,
    };
    if (this.sourcePort !== BASE_SOURCE_PORT)
      env.WWB_SRCPORT = String(this.sourcePort);

    const child = spawn(
      this.engine.command,
      [...this.engine.args, seconds, this.commandFile, logFile],
      {
        cwd: ENGINE_DIR,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // python.exe is a console program: without this, a console window
        // opens for each session when SoundBase starts the plugin
        windowsHide: true,
        // Windows: Node puts every child it starts in a job object that is
        // killed outright the moment this process exits. Detached, the engine
        // is outside it, so if the plugin dies the engine still gets to see
        // its stdin close and leave the AD600's session cleanly.
        detached: IS_WINDOWS,
      }
    );
    this.child = child;
    children.set(child, this.commandFile);
    // held open, never written: the engine's launcher exits when it closes
    child.stdin?.on('error', () => {});

    this.#readLines(child.stdout);
    this.#readLines(child.stderr);
    let settled = false;
    const settle = (code, signal, error) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      sourcePorts.delete(this.sourcePort);
      try {
        rmSync(this.scratch, { recursive: true, force: true });
      } catch {
        // a scratch directory left behind is not worth failing over
      }
      this.resolveExited({
        code,
        signal,
        error,
        requested: this.stopping !== null,
      });
    };
    child.on('error', (err) => settle(null, null, err));
    child.on('exit', (code, signal) => settle(code, signal, null));
  }

  /** The engine's last few lines, for a log entry explaining a failure. */
  recentOutput() {
    return this.lines.join('\n');
  }

  /** Ask the engine to leave the session and exit; insist if it does not. */
  stop() {
    if (!this.child) return Promise.resolve();
    this.stopping ??= this.#stop();
    return this.stopping;
  }

  async #stop() {
    const child = this.child;
    const gone = (ms) =>
      Promise.race([
        this.exited.then(() => true),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          timer.unref?.();
        }),
      ]);
    try {
      appendFileSync(this.commandFile, 'quit\n');
    } catch {
      // the scratch directory is gone, so the process is too
    }
    if (await gone(QUIT_GRACE_MS)) return;
    if (IS_WINDOWS) {
      // what SIGINT is elsewhere: the launcher exits cleanly when stdin closes
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      if (await gone(STDIN_CLOSE_GRACE_MS)) return;
      child.kill();
      await this.exited;
      return;
    }
    child.kill('SIGINT');
    if (await gone(SIGINT_GRACE_MS)) return;
    child.kill('SIGTERM');
    if (await gone(SIGTERM_GRACE_MS)) return;
    child.kill('SIGKILL');
    await this.exited;
  }

  #readLines(stream) {
    if (!stream) return;
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        this.#onLine(buffered.slice(0, end).trimEnd());
        buffered = buffered.slice(end + 1);
      }
    });
    stream.on('error', () => {});
  }

  #onLine(line) {
    if (line.startsWith('FRAME ')) {
      const [, curve, lo, hi, encoded] = line.split(' ');
      const raw = Buffer.from(encoded ?? '', 'base64');
      const count = raw.length >> 1;
      if (count === 0) return;
      // int16 big-endian, tenths of a dBm
      const amps = new Array(count);
      for (let i = 0; i < count; i += 1) amps[i] = raw.readInt16BE(i * 2) / 10;
      this.onFrame(Number(curve), Number(lo), Number(hi), amps);
      return;
    }
    if (!line.trim() || CHATTER.test(line)) return;
    this.lines.push(line.trim());
    if (this.lines.length > KEPT_LINES) this.lines.shift();
    for (const [name, pattern] of MILESTONES)
      if (pattern.test(line)) this.onMilestone(name, line.trim());
  }
}
