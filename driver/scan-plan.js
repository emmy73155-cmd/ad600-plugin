// What an AD600 can be asked to scan, and what it will then send back.
//
// The device has exactly two scan settings a controller can move: the range
// (SCAN_START_FREQ / SCAN_STOP_FREQ, in kHz) and REAL_TIME_COMPRESSION. It
// always measures every 25 kHz and peak-bins `compression` of those
// measurements into each point it delivers, so the delivered resolution is
// compression × 25 kHz and nothing else — there is no independent RBW, VBW or
// point count. Everything SoundBase asks for is therefore mapped onto those
// two settings here, clamped, and echoed as what the device will really send.
//
// It sends floor(span / step) points, starting at the start frequency and
// never reaching the stop. That is measured, not assumed: 470–524 MHz at
// 350 kHz comes back as 154 points and at 100 kHz as 540; 470–616 MHz at
// 100 kHz as 1460, the last at 615.9 MHz; 470–1000 MHz at 900 kHz as 588.
//
// Pure functions, no I/O: this is the half of the driver worth unit-testing.

/** The channel plan: frequency index 0 is 174.000 MHz, 25 kHz per index. */
export const FREQ_BASE_KHZ = 174_000;
export const IDX_KHZ = 25;

// The band the engine can deliver. The AD600's front end reaches further in
// both directions, but the engine subscribes to scan data for frequency
// indexes 11840–33040 only, which is this band, and every scan on record that
// was checked against hardware lies inside it.
export const MIN_FREQUENCY_HZ = 470_000_000;
export const MAX_FREQUENCY_HZ = 1_000_000_000;

// REAL_TIME_COMPRESSION. 36 (900 kHz) is what the device streams by default.
// Everything down to 2 (50 kHz) streams clean on hardware; at 1 (25 kHz) the
// scan data arrives in a layout the engine does not decode, so 2 is the floor.
export const COMPRESSION_MIN = 2;
export const COMPRESSION_MAX = 36;
export const DEFAULT_COMPRESSION = COMPRESSION_MAX;

// As many points as the shell itself will ask for from a step size. A fine
// resolution over a wide range is also slow: the device sends it in tiles, at
// very uneven rates, and the last of them can take a minute to turn up.
export const MAX_POINTS = 2000;

export const DEFAULT_START_HZ = MIN_FREQUENCY_HZ;
export const DEFAULT_STOP_HZ = MAX_FREQUENCY_HZ;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const idxToKhz = (idx) => FREQ_BASE_KHZ + idx * IDX_KHZ;
export const idxToHz = (idx) => idxToKhz(idx) * 1000;
export const hzToIdx = (hz) =>
  Math.round((hz / 1000 - FREQ_BASE_KHZ) / IDX_KHZ);
export const compressionToHz = (compression) => compression * IDX_KHZ * 1000;

const MIN_IDX = hzToIdx(MIN_FREQUENCY_HZ);
const MAX_IDX = hzToIdx(MAX_FREQUENCY_HZ);
// the narrowest range that still holds two points
const MIN_SPAN_IDX = 2 * COMPRESSION_MIN;

/** Every resolution the device can deliver, finest first. */
export const RESOLUTIONS_HZ = Array.from(
  { length: COMPRESSION_MAX - COMPRESSION_MIN + 1 },
  (_, i) => compressionToHz(COMPRESSION_MIN + i)
);

/**
 * Turn a requested configuration into the scan the device will run.
 *
 * Resolution has one knob, so the request's three ways of asking for it are
 * read in order of how explicit they are: `rbwHz`, then `pointCount`, then
 * `stepHz`. With none of them the device's own default applies.
 *
 * @param {{ startHz?: number, stopHz?: number, rbwHz?: number, pointCount?: number, stepHz?: number }} request
 * @returns {{
 *   startIdx: number, stopIdx: number, compression: number,
 *   startKhz: number, stopKhz: number,
 *   startHz: number, stopHz: number, stepHz: number, pointCount: number,
 *   key: string,
 * }}
 */
export function planScan(request = {}) {
  const wantStart = isNum(request.startHz) ? request.startHz : DEFAULT_START_HZ;
  const wantStop = isNum(request.stopHz) ? request.stopHz : DEFAULT_STOP_HZ;

  // room for two points at the finest resolution, wherever the range lands
  const startIdx = clamp(hzToIdx(wantStart), MIN_IDX, MAX_IDX - MIN_SPAN_IDX);
  const stopIdx = clamp(hzToIdx(wantStop), startIdx + MIN_SPAN_IDX, MAX_IDX);
  const spanIdx = stopIdx - startIdx;

  let wanted = DEFAULT_COMPRESSION;
  if (isNum(request.rbwHz) && request.rbwHz > 0) {
    wanted = request.rbwHz / compressionToHz(1);
  } else if (isNum(request.pointCount) && request.pointCount > 1) {
    wanted = spanIdx / Math.round(request.pointCount);
  } else if (isNum(request.stepHz) && request.stepHz > 0) {
    wanted = request.stepHz / compressionToHz(1);
  }
  const compression = clamp(
    Math.round(wanted),
    // no finer than the device goes, or than fits in MAX_POINTS
    Math.max(COMPRESSION_MIN, Math.ceil(spanIdx / MAX_POINTS)),
    // no coarser than the device goes, or than leaves two points
    Math.min(COMPRESSION_MAX, Math.floor(spanIdx / 2))
  );

  const pointCount = Math.floor(spanIdx / compression);
  const topIdx = startIdx + (pointCount - 1) * compression;

  return {
    startIdx,
    stopIdx,
    compression,
    // what the device is told: the requested range, on the 25 kHz plan
    startKhz: idxToKhz(startIdx),
    stopKhz: idxToKhz(stopIdx),
    // what it sends back
    startHz: idxToHz(startIdx),
    stopHz: idxToHz(topIdx),
    stepHz: compressionToHz(compression),
    pointCount,
    key: `${startIdx}:${stopIdx}:${compression}`,
  };
}

/** The grid a plan predicts, in the frequency-index terms scan data arrives in. */
export const gridOf = (plan) => ({
  lo: plan.startIdx,
  top: plan.startIdx + (plan.pointCount - 1) * plan.compression,
  step: plan.compression,
});

/** The trace geometry of a grid observed in scan data. */
export const geometryOf = (grid) => ({
  startHz: idxToHz(grid.lo),
  stopHz: idxToHz(grid.top),
  stepHz: compressionToHz(grid.step),
  pointCount: Math.floor((grid.top - grid.lo) / grid.step) + 1,
});
