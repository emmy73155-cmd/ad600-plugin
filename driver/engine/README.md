# The scan engine

The Python in this directory is what speaks to the AD600. It is not part of
the plugin template and was not written for this plugin: the plugin runs it as
a child process and reads its output.

## What is here

| File | Origin |
|---|---|
| `ad600_console.py` | [mbsound/AD600-Web-Based-Spectrum-Scan](https://github.com/mbsound/AD600-Web-Based-Spectrum-Scan), unmodified. The whole session: SLP advert, SDT join, association, the scan-ownership claim, the arm, decode, `FRAME` output, clean teardown. This is the program that runs. |
| `ad600_native.py` | Same repository, unmodified. ACN/SDT/DMP encoding and the cryptography. |
| `LICENSE` | That repository's licence (MIT), which covers the two files above. |
| `run_console.py` | Written for this plugin. Starts the console and makes it exit, cleanly, if the plugin dies. |

Copied from that repository's `engine/` at commit
`b0a3cd86d0cf5915a7393ba3f2f8b912c1d70047` ("verified on hardware",
2026-09-23). SHA-256 at the time of copying:

```
c7d00ddc27332fcf01b860e62e7295a217ef42ac76469c0d6016d6c0d939a02a  ad600_console.py
989f64aeca1aa055d939437475944ce365303f9b26618640cf9984dc9f476b4e  ad600_native.py
```

**Keep the two vendored files unmodified.** They are tuned against real
hardware by people who had it, most of their behaviour is selected by
environment variables, and a diff against upstream is only useful while it is
empty. Anything the plugin needs differently belongs in `run_console.py` or in
`../engine-process.js`, which sets the environment the console runs in.

Stdlib only. Runs on Python 3.8 and newer.

## Lineage

This engine began as the one inside the standalone *AD600 SoundBase Bridge*
menubar app. The first version of this plugin vendored that app's 1.4 release
directly. The copy here is a later revision of the same code, and was chosen
over it because its changes are the kind only hardware can prompt:

- it tries the position a scan packet states for itself before searching for
  one, which its authors report roughly halves the packets it fails to decode;
- it waits longer for the scan claim and the arm (12 s each, up from 3 s and
  6 s), and arms anyway if the device's ready signal is late;
- it tolerates malformed packets instead of dying on one;
- it reports antenna bias state, which the plugin currently ignores.

Not copied from that repository: its Python bridge, supervisor and discovery
modules and its web server, which `adapter.js` and the JavaScript beside this
directory do the work of. Their handling of the scan stream is where
`../sweep-assembler.js` and `../scan-plan.js` get their rules from.

That repository's comments cite an `AD600_Reverse_Engineering_Findings.md` and
"the SoundBase plugin's console" as the source of some fixes. Neither is in
the repository. If they exist somewhere, they are a more direct source than
this is.

The bridge app's own engine, or a compiled build of it, still runs under this
plugin: point **Scan engine override** at its `ad600_console.py` or
`ad600_engine_bin`.

## What it does on the wire

Worth knowing before this is shipped to anyone, because the engine does not
present itself as a new kind of controller:

- **It announces itself as Wireless Workbench.** Its SLP advert carries
  component type `WWB6`, name `WWB 6X`, and the component-definition UUID of
  Shure's Wireless Workbench controller (`ad600_console.py`, `_build_slp`).
  The AD600 therefore records the session in its event log as `wwb`.
- **It opens the session the way Wireless Workbench does**: an SDT join, then
  a session key derived from the two component ids and channel numbers
  exchanged in it. No key, password or other credential is stored in the
  source, and none is asked of the user.
- **The key-derivation function is a reimplementation of the one in the
  Wireless Workbench binary.** `ad600_native.py` documents `sk_util` as
  byte-exact with a routine at a specific address in that binary. It was
  obtained by reverse engineering Shure's software rather than from a
  published specification, and whoever publishes the plugin should know that.
- **The scan commands are embedded as bytes.** `INIT_COMMANDS` in
  `ad600_console.py` is 49 command blocks in hexadecimal. The bridge app's
  notes say the same 49 blocks are byte-identical to a capture of Wireless
  Workbench's own traffic, which is why that app generated them from a table
  instead of shipping them; this revision ships them.
- **It takes the device's single scan slot**, and gives it back on a clean
  exit. While it holds the slot, Wireless Workbench cannot scan that AD600.

What it writes to the device: the scan configuration block (range, step,
resolution bandwidth, repeat, curve selection, sweep rate, compression), the
scan start, two writes to property `0x01010201` that Wireless Workbench also
makes when it starts a scan, and the release of the scan slot on the way out.
Everything else it sends is a read or a subscription. It can switch the 12 V
antenna bias if a `set` line is put in its command file; the plugin never
writes one. It does not touch firmware.
