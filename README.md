# Shure AD600 for SoundBase

A SoundBase plugin that turns a Shure **AD600 Axient Digital Spectrum Manager**
into a live spectrum analyzer: its scan becomes the trace on the plot, one
curve per antenna, with no Wireless Workbench in between.

> **Status: this plugin has not yet been run against a real AD600.** The scan
> engine it runs has been — its authors verified it on hardware — and the
> rules this plugin applies to what the engine reports (how many points a scan
> has, how they arrive, how long a session takes to start) are theirs,
> measured on a device. The code that applies them is tested against a fake
> device and a stand-in engine built to behave the same way.
> [Bringing it up on hardware](#bringing-it-up-on-hardware) lists what to
> check first.

## Before you start

- **macOS, with Python 3.8 or newer.** The scan engine is Python. The plugin
  finds a Homebrew, python.org or Xcode command-line-tools Python by itself
  (`xcode-select --install` provides one); otherwise set **Python 3 path** in
  the plugin's settings.
- **The AD600 on the same subnet as this computer**, on a show network or
  cabled straight to it. Discovery and the scan both rely on traffic that does
  not cross a router.
- **Wireless Workbench quit, on every computer on that network.** An AD600
  gives its scan to one controller at a time. If Wireless Workbench has it,
  this plugin cannot, and the reverse.

## Using it

An AD600 on the network appears in SoundBase's device picker by itself, as
`<its name> (<its address>)`. To add one by hand, give its IP address.

| SoundBase setting | What the AD600 does |
|---|---|
| Start / stop frequency | Scans that range, within 470–1000 MHz, on its 25 kHz channel plan. The last point sits just short of the stop: the device sends `floor(span / step)` points from the start. |
| RBW | Picks the delivered resolution: 50 kHz to 900 kHz (the default), in 25 kHz steps. Each point is the peak of everything the device measured across that width. A fine RBW over a wide range is coarsened to keep the trace within 2000 points. |
| Point count | Not a setting the device has. Without an RBW, the count asked for picks the nearest resolution; the count reported back is what that really gives. |
| Trace mode | Held by SoundBase, per antenna, from the raw data. |

The trace is the strongest level any antenna saw at each frequency; the six
antennas are also there individually as curves **A–F**.

Things that are different from other analyzers:

- **Starting takes 20–30 seconds.** The AD600 wants a paced session handshake
  and a claim on its scan before it sends anything. Changing the range or the
  RBW costs the same again: the device fixes its scan settings when a scan is
  armed, so a change means closing the session and arming a new one.
- **A wide range at a fine RBW fills in slowly.** The device sends such a scan
  in pieces, at very uneven rates — the top of the band has been seen to
  arrive a minute after the bottom. No trace is drawn until every antenna has
  the whole band, and the device says so while you wait. After that, each
  piece that arrives updates its part of the trace.
- **If another controller has the scan, the device shows a critical warning**
  rather than a trace, and says what to do: quit Wireless Workbench and
  restart the scan, or power-cycle the AD600, after which the scan resumes by
  itself. The plugin deliberately does not keep retrying in the meantime — a
  refused claim that is retried can leave the device needing a restart anyway.
- **The scan renews itself once an hour.** The engine's session has a fixed
  length; when it runs out the plugin starts another, and the trace pauses
  while it does. `SB_AD600_SESSION_SECS` changes the length.

## Bringing it up on hardware

In rough order of how much each matters:

1. **Does it stream at all.** Quit Wireless Workbench, then `npm start` and
   drive it with `curl`, or load it into SoundBase Desktop
   (`docs/running-in-soundbase.md`). The plugin log shows the engine's
   milestones: `JOINED`, `OWNERSHIP CLAIMED`, `SCAN-READY`.
2. **Does SoundBase wait for it.** The plugin tells the host to expect ten
   seconds between traces (`resolved.sweepTimeMs`) so that the 20–30 second
   start is not taken for a stall. That figure is a placeholder for patience,
   not a measurement; replace it with one.
3. **Is the trace on the right axis.** The predicted point counts match every
   scan its authors measured, and if the device sends a different extent the
   plugin adopts it and logs `the AD600 is scanning … not the … that was
   expected`. A log line saying it is sending points some other distance apart
   than was asked for is more serious, and means the trace is mislabelled.
4. **Does a retune survive.** Change the range a few times while sweeping and
   confirm each new session still gets the scan.
5. **Frequencies outside 470–1000 MHz.** The hardware covers 174 MHz–2 GHz,
   and the web app this engine comes from offers presets across all of it, but
   the engine subscribes to scan data for 470–1000 MHz only and every scan its
   notes record a check of lies inside that. Widening it means finding out
   what the device sends for the rest, then moving the two limits in
   `driver/scan-plan.js`.

`SB_AD600_ENGINE_LOG=/tmp/ad600.log npm start` keeps the engine's full log.
It grows by a line per scan packet.

## Developing

```sh
npm install
npm run doctor      # is the plugin well-formed?
npm test            # the contract and the driver, with nothing attached
npm run smoke       # boots main.js as a child process, as SoundBase does
SB_AD600_MOCK=1 npm start    # a pretend AD600, for poking at with curl
```

```
adapter.js                  discovery, capabilities, clamp-and-echo, warnings
driver/
  scan-plan.js              what can be asked for, and what comes back
  slp.js                    finding AD600s from their SLP adverts
  ad600-scanner.js          keeping a scan session alive; when to stop trying
  engine-process.js         the engine as a child process that can be killed
  sweep-assembler.js        scan tiles -> complete sweeps
  engine/                   the scan engine itself (Python, vendored unmodified)
  fake-engine.js            a stand-in engine: same contract, no network
  fake-ad600.js             a fake unit that advertises on loopback
  protocol.md               the contract between the driver and the engine
```

The engine runs in its own process on purpose
([docs/native-runtimes.md](docs/native-runtimes.md)): the plugin stays
responsive whatever the session is doing, and can always end it. Ending it
*cleanly* is what matters for this device, so the engine is asked to leave
before it is signalled, and it exits by itself if the plugin dies.

**Scan engine override** runs a different engine in place of the bundled one:
the bridge app's `ad600_console.py`, or a compiled `ad600_engine_bin`, which
needs no Python. Neither is shipped here.

Environment variables, all optional:

| | |
|---|---|
| `SB_AD600_MOCK=1` | No network: one pretend unit, served by `driver/fake-engine.js`. |
| `SB_AD600_PYTHON` | The Python 3 to run the engine under. |
| `SB_AD600_ENGINE` | An engine to run instead of the bundled one. |
| `SB_AD600_ENGINE_LOG` | A file for the engine's full log. Off by default. |
| `SB_AD600_SESSION_SECS` | Length of one engine session. Default 3600. |
| `SB_AD600_SLP_PORT` | Listen for adverts on this loopback port only (tests). |

The guide set the plugin template ships is in [docs/](docs/README.md), and
[CLAUDE.md](CLAUDE.md) is the short version of the plugin model.

## Known limits

- **macOS only.** The engine's own repository ships a Windows launcher, but
  nobody has run this plugin there, so `win32-x64` is left out of the
  manifest's `platforms` until someone has.
- **Python is a prerequisite, not bundled.** A frozen runtime under `runtime/`
  is the way to remove that, and is not built yet.
- **One controller.** This plugin and Wireless Workbench cannot scan the same
  AD600 at the same time, and that is the device's rule, not the plugin's.
- **470–1000 MHz, 50–900 kHz.** What the engine covers and has been validated
  at, not what the hardware can do. 25 kHz does not decode.
- **Antenna bias is read by the engine and not surfaced.** The engine can
  switch the 12 V bias too; this plugin offers no control for it.

## Where the engine came from

`driver/engine/` is an independently written implementation of the AD600's ACN
(ANSI E1.17) session and scan protocol, developed by reverse engineering for
interoperability with hardware its users own. It is copied unmodified from
[mbsound/AD600-Web-Based-Spectrum-Scan](https://github.com/mbsound/AD600-Web-Based-Spectrum-Scan)
(MIT), which is itself a later revision of the engine in the *AD600 SoundBase
Bridge* app. [driver/engine/README.md](driver/engine/README.md) records
exactly which files, why this revision, and what they do on the wire. Read it
before publishing this plugin.

This plugin is not affiliated with, authorized or endorsed by Shure
Incorporated. "Shure", "AD600", "Axient" and "Wireless Workbench" are
trademarks of their owner, used here only to say what the plugin works with.
