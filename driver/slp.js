// Finding AD600s on the network.
//
// A Shure ACN component announces itself as an SLPv2 AttrRply (RFC 2608)
// multicast to 239.255.254.253:8427. The attribute list carries everything a
// controller needs to open a session:
//
//   (cid=DDAC0650-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=AD600),
//   (acn-uacn=…),(csl-esta.dmp=esta.sdt/192.168.5.101:57383;esta.dmp/cd:…)
//
// SlpBrowser listens for those and remembers when each device was last heard,
// which answers three questions: what is out there, what is the component id
// and port of the unit at this address, and has a unit that was there gone
// away and come back (a power-cycle).
//
// Multicast does not cross a router, so only units on a subnet this computer
// is attached to are ever seen. That is also the only place the scan works.

import dgram from 'node:dgram';
import os from 'node:os';

export const SLP_GROUP = '239.255.254.253';
export const SLP_PORT = 8427;
export const DEFAULT_DEVICE_PORT = 57383;

const SOLICIT_MS = 2_000;
const IDLE_STOP_MS = 5_000;
/** how long after its last advert a unit is still listed */
const LISTED_MS = 15_000;
/** how long without an advert, while being asked for one, means it is off */
const ABSENT_MS = 8_000;

const hexOnly = (text) => String(text ?? '').replace(/[^0-9a-f]/gi, '');

/** `(key=value),(key=value)` → `{ key: value }`, keys lowercased. */
function parseAttributes(list) {
  const attrs = {};
  for (const [, key, value] of list.matchAll(/\(([^()=]+)=([^()]*)\)/g))
    attrs[key.trim().toLowerCase()] = value.trim();
  return attrs;
}

/**
 * An SLPv2 AttrRply datagram → its attributes, or null for anything else.
 *
 * Header: version(1) function(1) length(3) flags(2) next-ext(3) xid(2)
 * lang-tag-length(2) lang-tag; then error(2) attr-list-length(2) attr-list.
 */
export function parseAttrRply(datagram) {
  if (datagram.length < 16 || datagram[0] !== 0x02 || datagram[1] !== 0x07)
    return null;
  let offset = 14 + datagram.readUInt16BE(12);
  if (offset + 4 > datagram.length) return null;
  if (datagram.readUInt16BE(offset) !== 0) return null;
  const length = datagram.readUInt16BE(offset + 2);
  offset += 4;
  return parseAttributes(
    datagram.subarray(offset, offset + length).toString('utf8')
  );
}

/** Advert attributes → the AD600 they describe, or null if they describe something else. */
export function deviceFromAttributes(attrs, sender) {
  if (!attrs) return null;
  const model = attrs['acn-fctn'] ?? '';
  const name = attrs['acn-uacn'] ?? '';
  // other Shure hardware advertises the same way; a receiver is not an analyzer
  if (!`${model} ${name}`.toUpperCase().includes('AD600')) return null;
  const cid = hexOnly(attrs.cid).toLowerCase();
  if (cid.length !== 32) return null;
  const sdt = /esta\.sdt\/(\d+\.\d+\.\d+\.\d+):(\d+)/.exec(
    attrs['csl-esta.dmp'] ?? ''
  );
  const host = sdt?.[1] ?? sender;
  if (!host) return null;
  return {
    host,
    port: sdt ? Number(sdt[2]) : DEFAULT_DEVICE_PORT,
    cid,
    model: model || 'AD600',
    name: name || model || 'AD600',
  };
}

/** A minimal SLPv2 SrvRqst, which nudges a listening component to advertise now. */
export function buildSrvRqst(serviceType, xid = 0x1234) {
  const type = Buffer.from(serviceType);
  const body = Buffer.concat([
    Buffer.from([0, 0]), // previous-responder list
    Buffer.from([type.length >> 8, type.length & 0xff]),
    type,
    Buffer.from([0, 0, 0, 0, 0, 0]), // scope list, predicate, SPI: all empty
  ]);
  const header = Buffer.from([
    0x02,
    0x01,
    0,
    0,
    0,
    0x20,
    0x00,
    0,
    0,
    0,
    xid >> 8,
    xid & 0xff,
    0,
    2,
    0x65,
    0x6e, // "en"
  ]);
  const packet = Buffer.concat([header, body]);
  packet.writeUIntBE(packet.length, 2, 3);
  return packet;
}

/** An AttrRply such as a device sends — used by the fake, and by the tests of the parser. */
export function buildAttrRply(attributeList, xid = 0x223d) {
  const list = Buffer.from(attributeList);
  const packet = Buffer.concat([
    Buffer.from([0x02, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, xid >> 8, xid & 0xff]),
    Buffer.from([0, 2, 0x65, 0x6e]),
    Buffer.from([0, 0, list.length >> 8, list.length & 0xff]),
    list,
    Buffer.from([0]),
  ]);
  packet.writeUIntBE(packet.length, 2, 3);
  return packet;
}

const externalIpv4 = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);

export class SlpBrowser {
  /**
   * @param {{ port?: number, multicast?: boolean, listedMs?: number, absentMs?: number, log?: (level: string, message: string) => void }} [options]
   *   `multicast: false` listens on loopback only and solicits nothing — for a
   *   fake device on this machine.
   */
  constructor({
    port = SLP_PORT,
    multicast = true,
    listedMs = LISTED_MS,
    absentMs = ABSENT_MS,
    log = () => {},
  } = {}) {
    this.port = port;
    this.multicast = multicast;
    this.listedMs = listedMs;
    this.absentMs = absentMs;
    this.log = log;
    this.socket = null;
    this.joined = new Set();
    this.seen = new Map(); // host -> { ...device, at }
    this.waiters = new Set();
    this.holds = 0;
    this.touchedAt = 0;
    this.timer = null;
    this.usable = false;
    this.complained = false;
  }

  /** Discovery is being polled: keep listening for a little longer. */
  touch() {
    this.touchedAt = Date.now();
    this.#start();
  }

  /** Something needs presence watched until it calls the function this returns. */
  hold() {
    this.holds += 1;
    this.#start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
    };
  }

  /** AD600s heard from recently. */
  devices() {
    const cutoff = Date.now() - this.listedMs;
    return [...this.seen.values()].filter((d) => d.at >= cutoff);
  }

  /**
   * Is the unit at `host` advertising? `null` when listening is not working
   * on this machine, so nothing can be concluded either way.
   */
  isPresent(host) {
    if (!this.usable) return null;
    const device = this.seen.get(host);
    return Boolean(device) && Date.now() - device.at < this.absentMs;
  }

  /** The unit at `host`, waiting up to `timeoutMs` for it to advertise. */
  async find(host, timeoutMs) {
    const release = this.hold();
    try {
      const fresh = this.seen.get(host);
      if (fresh && Date.now() - fresh.at < this.listedMs) return fresh;
      return await new Promise((resolve) => {
        const waiter = { host, resolve: null };
        const timer = setTimeout(() => waiter.resolve(null), timeoutMs);
        waiter.resolve = (device) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(device);
        };
        this.waiters.add(waiter);
      });
    } finally {
      release();
    }
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    for (const waiter of [...this.waiters]) waiter.resolve(null);
    const socket = this.socket;
    this.socket = null;
    this.usable = false;
    this.joined.clear();
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }

  #start() {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (err) => {
      // Wireless Workbench holding the port exclusively is the usual cause
      if (!this.complained) {
        this.complained = true;
        this.log(
          'warn',
          `cannot listen for AD600 adverts on UDP ${this.port}: ${err.message}`
        );
      }
      if (this.socket === socket) this.close();
    });
    socket.on('message', (datagram, sender) =>
      this.#onDatagram(datagram, sender)
    );
    socket.bind(this.port, this.multicast ? undefined : '127.0.0.1', () => {
      if (this.socket !== socket) return;
      this.usable = true;
      this.complained = false;
      this.#solicit();
    });
    socket.unref();
    this.timer = setInterval(() => this.#tick(), SOLICIT_MS);
    this.timer.unref?.();
  }

  #tick() {
    const idle = Date.now() - this.touchedAt > IDLE_STOP_MS;
    if (idle && this.holds <= 0 && this.waiters.size === 0) {
      // nobody is enumerating and nothing is being watched: do no I/O at all
      this.close();
      return;
    }
    this.#solicit();
  }

  async #solicit() {
    const socket = this.socket;
    if (!socket || !this.usable || !this.multicast) return;
    for (const address of externalIpv4()) {
      if (this.socket !== socket) return;
      try {
        if (!this.joined.has(address)) {
          socket.addMembership(SLP_GROUP, address);
          this.joined.add(address);
        }
        socket.setMulticastInterface(address);
        for (const type of ['service:esta.sdt', 'service:acn.esta']) {
          await new Promise((resolve) =>
            socket.send(buildSrvRqst(type), this.port, SLP_GROUP, resolve)
          );
        }
      } catch {
        // an interface that went away, or one that cannot do multicast
      }
    }
  }

  #onDatagram(datagram, sender) {
    let device = null;
    try {
      device = deviceFromAttributes(parseAttrRply(datagram), sender.address);
    } catch {
      // not ours to understand
    }
    if (!device) return;
    const record = { ...device, at: Date.now() };
    this.seen.set(device.host, record);
    for (const waiter of [...this.waiters])
      if (waiter.host === device.host) waiter.resolve(record);
  }
}

/** Discovery that always sees the same units — the plugin's mock mode. */
export class StaticDiscovery {
  constructor(devices) {
    this.list = devices;
  }
  touch() {}
  hold() {
    return () => {};
  }
  devices() {
    return this.list.map((d) => ({ ...d, at: Date.now() }));
  }
  isPresent(host) {
    return this.list.some((d) => d.host === host);
  }
  async find(host) {
    return this.devices().find((d) => d.host === host) ?? null;
  }
  close() {}
}

const ipv4ToInt = (address) =>
  String(address)
    .split('.')
    .reduce((sum, part) => sum * 256 + Number(part), 0);

/**
 * The local interface a session with `host` leaves through: its name and its
 * address.
 *
 * The interface whose own subnet contains the device, when there is one. That
 * is right for a show network and for an AD600 cabled straight to this
 * computer on link-local addresses alike, where the operating system's idea
 * of the default route is often some other interface entirely. Only when no
 * interface's subnet contains the device is the route asked for.
 */
export async function localInterfaceFor(host) {
  const target = ipv4ToInt(host);
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family !== 'IPv4' || !a.netmask) continue;
      const size = 2 ** 32 - ipv4ToInt(a.netmask);
      if (Math.floor(ipv4ToInt(a.address) / size) === Math.floor(target / size))
        return { name, address: a.address };
    }
  }

  const address = await new Promise((resolve, reject) => {
    const probe = dgram.createSocket('udp4');
    const fail = (err) => {
      probe.removeAllListeners('error');
      probe.on('error', () => {});
      try {
        probe.close();
      } catch {
        // never opened
      }
      reject(
        new Error(`no route from this computer to ${host}: ${err.message}`)
      );
    };
    probe.on('error', fail);
    // connecting a datagram socket sends nothing; it only picks the route
    probe.connect(9, host, (err) => {
      if (err) return fail(err);
      const local = probe.address().address;
      probe.close();
      resolve(local);
    });
  });
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (
      (addresses ?? []).some(
        (a) => a.family === 'IPv4' && a.address === address
      )
    )
      return { name, address };
  }
  throw new Error(
    `no network interface on this computer has address ${address}`
  );
}
