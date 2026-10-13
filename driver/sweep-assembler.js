// Turns the AD600's scan stream into complete sweeps.
//
// The device does not send sweeps. It sends tiles: a few hundred consecutive
// points of one antenna's curve, addressed by frequency index. A narrow or
// coarse scan is one tile per antenna; a wide, fine one is several, and they
// do not arrive in order or at an even rate — on hardware, the top tile of a
// three-tile scan has been seen to turn up a minute after the bottom one,
// which had repeated many times by then. On top of that, a share of tiles
// never decode at all and are simply missing until the next time round.
//
// So there is no such thing here as "the sweep that just finished". What
// there is, is a picture of the band per antenna that each tile refreshes a
// slice of. Nothing is reported until every antenna has every point of that
// picture; from then on, each tile that arrives is reported as the picture
// with its slice replaced. A point is never invented and a hole is never
// padded: an incomplete picture is not a sweep.
//
// The plan says where the points are: the step is the compression that was
// asked for, not whatever one frame's bounds divide out to, because a short
// boundary tile rounds differently. The plan also predicts where the band
// ends, to within the tolerance below; what is reported is the extent the
// data actually reached.

// A reading outside this is not RF: an occasional tile decodes to garbage
// (thousands of dBm), and a tile with garbage in it is dropped whole.
const SANE_MIN_DBM = -150;
const SANE_MAX_DBM = 20;
const FLOOR_DBM = -130;

// how far short of the predicted ends the data may stop and still be the band
const LOW_TOLERANCE_BINS = 5;
const TOP_TOLERANCE_BINS = 2;

const antennaLabel = (curve) =>
  curve >= 1 && curve <= 26 ? String.fromCharCode(64 + curve) : `Ant${curve}`;

export class SweepAssembler {
  /**
   * @param {{
   *   expectedCurves?: number,
   *   curveGraceMs?: number,
   *   onSweep: (sweep: { grid: { lo: number, top: number, step: number }, amplitudesDbm: number[], series: Array<{ name: string, amplitudesDbm: number[] }> }) => void,
   * }} options
   *   `curveGraceMs` is how long to wait for `expectedCurves` antennas before
   *   settling for the ones that are streaming.
   */
  constructor({ expectedCurves = 6, curveGraceMs = 10_000, onSweep }) {
    this.expectedCurves = expectedCurves;
    this.curveGraceMs = curveGraceMs;
    this.onSweep = onSweep;
    this.reset(null);
  }

  /**
   * Forget the picture, ready for a new session or a different scan.
   *
   * @param {{ startIdx: number, stopIdx: number, compression: number, pointCount: number } | null} plan
   */
  reset(plan) {
    this.base = plan?.startIdx ?? 0;
    this.step = plan?.compression ?? 0;
    // every bin the range could hold, in case the device sends more than predicted
    this.capacity = plan
      ? Math.floor((plan.stopIdx - plan.startIdx) / plan.compression) + 1
      : 0;
    this.predictedTop = plan ? plan.pointCount - 1 : 0;
    this.curves = new Map(); // curve -> { levels: Float64Array, filled: number }
    this.lowBin = Infinity;
    this.topBin = -Infinity;
    this.firstFrameAt = null;
    this.complete = false;
    this.rejected = 0;
    this.foreignStride = null;
  }

  /** Has a full picture been reported since the last reset? */
  get covered() {
    return this.complete;
  }

  /** Tiles dropped since the last reset for holding impossible readings. */
  get rejectedFrames() {
    return this.rejected;
  }

  /**
   * One tile: `amps[k]` is the level at frequency index `lo + k × step`.
   * `hi`, the index the device says the tile ends at, is only a cross-check.
   */
  feed(curve, lo, hi, amps, now = Date.now()) {
    const n = amps.length;
    if (n === 0 || !this.step) return;
    for (let k = 0; k < n; k += 1) {
      const dbm = amps[k];
      if (!(dbm > SANE_MIN_DBM && dbm <= SANE_MAX_DBM)) {
        this.rejected += 1;
        return;
      }
    }
    // a long tile whose bounds imply another step means the device is not
    // scanning what it was asked to; worth a line in the log, once
    if (n >= 8) {
      const stride = Math.round((hi - lo) / (n - 1));
      if (stride !== this.step) this.foreignStride = stride;
    }
    this.firstFrameAt ??= now;

    let state = this.curves.get(curve);
    if (!state) {
      state = { levels: new Float64Array(this.capacity).fill(NaN), filled: 0 };
      this.curves.set(curve, state);
    }
    const first = Math.round((lo - this.base) / this.step);
    for (let k = 0; k < n; k += 1) {
      const bin = first + k;
      if (bin < 0 || bin >= this.capacity) continue;
      if (Number.isNaN(state.levels[bin])) state.filled += 1;
      state.levels[bin] = amps[k];
      if (bin < this.lowBin) this.lowBin = bin;
      if (bin > this.topBin) this.topBin = bin;
    }
    this.#report(now);
  }

  #report(now) {
    // the band is not all here until both of its ends have been seen
    if (this.lowBin > LOW_TOLERANCE_BINS) return;
    if (this.topBin < this.predictedTop - TOP_TOLERANCE_BINS) return;
    const count = this.topBin - this.lowBin + 1;
    if (count < 2) return;
    if (
      this.curves.size < this.expectedCurves &&
      now - this.firstFrameAt < this.curveGraceMs
    )
      return;
    // every bin a curve has filled lies between the two ends, so a curve
    // with `count` of them has them all
    for (const state of this.curves.values()) if (state.filled < count) return;

    this.complete = true;
    const clean = (dbm) => Math.round(Math.max(dbm, FLOOR_DBM) * 10) / 10;
    // the primary trace is the strongest any antenna heard at each point:
    // what matters to a coordination is whether a frequency is occupied
    const strongest = new Array(count).fill(-Infinity);
    const series = [];
    for (const curve of [...this.curves.keys()].sort((a, b) => a - b)) {
      const { levels } = this.curves.get(curve);
      const amplitudesDbm = new Array(count);
      for (let i = 0; i < count; i += 1) {
        const dbm = clean(levels[this.lowBin + i]);
        amplitudesDbm[i] = dbm;
        if (dbm > strongest[i]) strongest[i] = dbm;
      }
      series.push({ name: antennaLabel(curve), amplitudesDbm });
    }
    this.onSweep({
      grid: {
        lo: this.base + this.lowBin * this.step,
        top: this.base + this.topBin * this.step,
        step: this.step,
      },
      amplitudesDbm: strongest,
      series,
    });
  }
}
