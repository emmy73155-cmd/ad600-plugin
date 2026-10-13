// A fake AD600, for tests: the half of the device that discovery sees.
//
// It advertises the way the real unit does — an SLPv2 AttrRply naming its
// component id, model and SDT address — but to a loopback port instead of the
// multicast group, so nothing leaves the machine. Point a browser at the same
// port (`new SlpBrowser({ port, multicast: false })`, or SB_AD600_SLP_PORT for
// the whole plugin) and it finds this.
//
// The other half, the scan itself, is driver/fake-engine.js: the engine that
// would talk to the unit is replaced, rather than the unit it talks to.
//
// It can be switched off and on again, which is how a power-cycle looks from
// the network and what the scanner waits for when the scan is held by someone
// else.

import dgram from 'node:dgram';
import { DEFAULT_DEVICE_PORT, buildAttrRply } from './slp.js';

/** A UDP port on loopback that nothing is using right now. */
export async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export async function startFakeAd600({
  slpPort,
  host = '127.0.0.1',
  cid = 'DDAC0650-0000-11DD-A000-000EDDCCCCCC',
  model = 'AD600',
  name = 'AD600',
  intervalMs = 100,
} = {}) {
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => {});
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));

  const advert = buildAttrRply(
    `(cid=${cid}),(acn-fctn=${model}),(acn-uacn=${name}),(acn-services=esta.dmp),` +
      `(csl-esta.dmp=esta.sdt/${host}:${DEFAULT_DEVICE_PORT};esta.dmp/cd:00000000-0000-0000-0000-000000000000),` +
      `(device-description=$:tftp://${host}/$.ddl)`
  );
  let powered = true;
  const advertise = () => {
    if (powered) socket.send(advert, slpPort, '127.0.0.1', () => {});
  };
  advertise();
  const timer = setInterval(advertise, intervalMs);

  return {
    host,
    cid: cid.replace(/-/g, '').toLowerCase(),
    powerOff() {
      powered = false;
    },
    powerOn() {
      powered = true;
      advertise();
    },
    async close() {
      clearInterval(timer);
      await new Promise((resolve) => socket.close(resolve));
    },
  };
}
