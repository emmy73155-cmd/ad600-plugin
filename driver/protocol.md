# The contract between the driver and the scan engine

The driver does not speak to the AD600. It runs an engine that does, and the
two agree on the following. The bundled Python engine (`engine/`), the earlier
bridge-app engine it descends from, a compiled build of either, and the
stand-in used in tests (`fake-engine.js`) all honour it, which is what lets
any of them be swapped for another.

## Starting it

```
<engine> <run-for-seconds> <command-file> <log-file>
```

- `run-for-seconds` — how long the session lasts before the engine leaves by
  itself.
- `command-file` — a text file the engine polls for new lines. The driver
  writes `genfeed` before starting (build the scan commands and begin) and
  appends `quit` to stop.
- `log-file` — where the engine appends its full, timestamped log. The driver
  passes the null device unless `SB_AD600_ENGINE_LOG` is set.

## Environment

Who is talking to whom:

| | |
|---|---|
| `WWB_DEVIP`, `WWB_DEVPORT` | the AD600's address and SDT port |
| `WWB_DEVCID` | the AD600's component id, 32 hex digits |
| `WWB_CID` | this controller's component id: eight random hex digits, new for every session, then `000011dda000000eddcccccc`. An id the device has seen recently is refused as already in use |
| `WWB_MYIP`, `AD600_MCAST_IF` | the local interface's address and name |
| `WWB_SRCPORT` | the local UDP port, when it is not the default 64198 |

What to scan:

| | |
|---|---|
| `AD600_SCAN_START_KHZ`, `AD600_SCAN_STOP_KHZ` | the range |
| `AD600_RT_COMPRESSION` | delivered resolution ÷ 25 kHz |

And `AD600_EMIT_FRAMES=1`, which turns on the `FRAME` lines below, plus the
recipe flags in `engine-process.js` (`AD600_OWNER_CLAIM`, `AD600_ARM_ON_STATUS`
and the rest), which select the scan-start sequence the engine was validated
with. How long the engine waits at each stage is left to its own defaults.

## What it says

On stdout, one line at a time.

```
FRAME <curve> <lo> <hi> <base64>
```

One decoded scan tile: antenna `curve` (1–6), covering frequency indexes `lo`
to `hi` inclusive, where index `i` is `174 MHz + i × 25 kHz`. The payload is
big-endian int16, tenths of a dBm, one value per delivered point. Point `k`
sits at `lo + k × compression`: the compression that was asked for, not
`(hi − lo) / (count − 1)`, which rounds differently for a short tile.

A scan is `floor(span / step)` points per antenna. More than a few hundred of
them arrive as several tiles, which share their edge points, come in no
particular order and at very uneven rates, and now and then do not come at all
because the packet did not decode. A tile can also decode to garbage: readings
of thousands of dBm. `sweep-assembler.js` is what makes sweeps of this.

Every other line is for a person, and the driver looks for these in them:

| Line contains | Means |
|---|---|
| `*** JOINED` | the device accepted the session |
| `JOIN_REFUSE` | it refused it (an identity it has seen recently, or a stale session) |
| `OWNERSHIP CLAIMED` | the scan slot is ours |
| `NOT OWNER` | someone else holds the scan slot. The bundled engine then leaves by itself |
| `SCAN-READY gate open` | the scan is being armed |
| `NOT firing arm` | older engines only: it had the slot but the device never armed |
| `clean disconnect sent` | it released the slot and left the session |

The bundled engine also prints `CONNECTED` once the session is up and
`BIAS <A-F> <0|1>` for each antenna's 12 V bias state. The driver ignores both.

The driver does not depend on any of them to recognise a working scan —
frames arriving is the only proof of that — only to recognise the failures
early instead of by timeout.

## Stopping it

`quit` in the command file, `SIGINT` and `SIGTERM` all do the same thing:
release the scan slot, leave the session, exit 0. The driver tries them in
that order, a few seconds apart, and only then kills the process. The bundled
engine also does this by itself when its stdin closes, which is what happens
when the plugin that started it dies.
