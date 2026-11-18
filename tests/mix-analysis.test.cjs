const test = require("node:test");
const assert = require("node:assert/strict");
const { analyseLoudness } = require("../loudness.js");
const { analyseMix, explainComparison, normaliseMixAnalysis, BAND_DEFINITIONS } = require("../mix-analysis.js");

function makeBuffer(channels, sampleRate = 48000) {
  return {
    sampleRate,
    length: channels[0].length,
    numberOfChannels: channels.length,
    getChannelData(channel) { return channels[channel]; },
  };
}

function tone({ frequency = 1000, duration = 4, gain = 0.25, sampleRate = 48000 } = {}) {
  const samples = new Float32Array(Math.round(sampleRate * duration));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = gain * Math.sin(2 * Math.PI * frequency * index / sampleRate);
  }
  return samples;
}

function assertNear(actual, expected, tolerance = 0.001) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

test("Mix Lab distinguishes a centred mix from phase cancellation without losing tonal energy", () => {
  const left = tone();
  const centred = analyseMix(makeBuffer([left, left]));
  const inverted = analyseMix(makeBuffer([left, left.map((sample) => -sample)]));
  assertNear(centred.correlation, 1);
  assertNear(centred.sidePercent, 0);
  assertNear(centred.monoDeltaDb, 0);
  assertNear(centred.spectralCentroidHz, 1000, 1);
  assertNear(inverted.correlation, -1);
  assertNear(inverted.sidePercent, 100);
  assert.equal(inverted.monoDeltaDb, -Infinity);
  assertNear(inverted.spectralCentroidHz, centred.spectralCentroidHz);
  const mids = inverted.bands.find((band) => band.id === "mids");
  assert.ok(mids.energyPercent > 99);
  assertNear(mids.sidePercent, 100);
  assertNear(mids.correlation, -1);
});

test("Mix Lab locates high and low tones in their bands and respects the decoded Nyquist limit", () => {
  const low = analyseMix(makeBuffer([tone({ frequency: 120 })]));
  const high = analyseMix(makeBuffer([tone({ frequency: 8500, sampleRate: 22050 })], 22050));
  assert.ok(low.bands.find((band) => band.id === "bass").energyPercent > 99);
  assert.ok(high.bands.find((band) => band.id === "highs").energyPercent > 99);
  assert.equal(high.bands.find((band) => band.id === "air").sidePercent, null);
  assertNear(high.spectralCentroidHz, 8500, 2);
  assert.equal(normaliseMixAnalysis(high).spectralCentroidHz, high.spectralCentroidHz);
  assert.ok(high.spectralRolloffHz < high.sampleRate / 2);
  assertNear(high.bands.reduce((total, band) => total + band.energyPercent, 0), 100);
});

test("A short edge interval can estimate a peak above the stored samples", () => {
  const result = analyseMix(makeBuffer([new Float32Array([0.9, 0.9])]));
  assertNear(result.samplePeakDb, 20 * Math.log10(0.9));
  assertNear(result.estimatedTruePeakDb, 20 * Math.log10(0.9 * 1.125));
  assert.equal(result.clippedSamplePercent, 0);
  assert.match(result.truePeakMethod, /estimate/);
});

test("Detailed loudness retains programme calibration and measures 400 ms, 3 s and LRA", () => {
  // The first generated tone segment represents -20 LUFS and the second
  // -30 LUFS. See EBU Tech 3342 test 1 for expected LRA of 10 ±1 LU.
  const samples = tone({ duration: 40, gain: 0.1 });
  for (let index = 20 * 48000; index < samples.length; index += 1) samples[index] *= 10 ** (-10 / 20);
  const buffer = makeBuffer([samples, samples]);
  const detailed = analyseLoudness(buffer, { detailed: true });
  const basic = analyseLoudness(buffer);
  assertNear(detailed.lufs, basic.lufs, 1e-10);
  assertNear(detailed.momentary[0].time, 0.2);
  assertNear(detailed.shortTerm[0].time, 1.5);
  assertNear(detailed.maxMomentaryLufs, -20, 0.1);
  assertNear(detailed.maxShortTermLufs, -20, 0.1);
  assertNear(detailed.loudnessRange, 10, 0.1);
});

test("Mix Lab bounds timeline data and preserves its extrema", () => {
  const samples = tone({ duration: 47 });
  samples.fill(0, 5 * 48000, 13 * 48000);
  for (let index = 30 * 48000; index < 34 * 48000; index += 1) samples[index] *= 2;
  const audio = makeBuffer([samples, samples]);
  const progress = [];
  const result = analyseMix(audio, { onProgress: (fraction, stage) => progress.push({ fraction, stage }) });
  assert.equal(progress[0].fraction, 0);
  assert.equal(progress.at(-1).fraction, 1);
  assert.deepEqual([...new Set(progress.map(({ stage }) => stage))], ["loudness", "dynamics", "spectrum"]);
  assert.ok(result.shortTerm.length <= 360 && result.momentary.length <= 360);
  assertNear(result.shortTerm[0].time, 1.5);
  assertNear(result.shortTerm.at(-1).time, 45.5);
  assert.ok(result.shortTerm.some(({ lufs }) => lufs === null || lufs < -80));
  assertNear(Math.max(...result.shortTerm.map(({ lufs }) => lufs ?? -Infinity)), result.maxShortTermLufs);
});

test("No loudness or tone is invented for silence or windows the recording cannot fill", () => {
  const silent = analyseMix(makeBuffer([new Float32Array(4 * 48000)]));
  const short = analyseMix(makeBuffer([tone({ duration: 0.3 })]));
  for (const key of ["integratedLufs", "maxMomentaryLufs", "maxShortTermLufs", "loudnessRange",
    "spectralCentroidHz", "spectralFlatness", "loudnessDensity", "plr"]) assert.equal(silent[key], null);
  assert.equal(short.shortTerm.length, 0);
  assert.equal(short.momentary.length, 0);
  assert.equal(short.loudnessRange, null);
  assert.equal(short.integratedLufs, null);
  assert.ok(Number.isFinite(short.samplePeakDb));
  const explanations = explainComparison(silent, short);
  assert.ok(explanations.some(({ track }) => track === "unavailable"));
  assert.ok(explanations.every(({ track }) => track !== "matched"));
});

test("Comparison direction maps a lower PLR to the correct recording", () => {
  const first = { integratedLufs: -16, plr: 7, loudnessDensity: 80 };
  const second = { integratedLufs: -16, plr: 11, loudnessDensity: 55 };
  const explanations = explainComparison(first, second, "Track A", "Track B");
  assert.ok(explanations.some(({ metric, track, text }) =>
    metric === "peak-to-loudness ratio" && track === "Track A" && /denser/.test(text)));
  assert.ok(explanations.some(({ metric, track }) => metric === "loudness density" && track === "Track A"));
});

test("Comparison identifies incompatible spectral methods and phase cancellation in both tracks", () => {
  // Identical mixed-frequency material can produce both of these centroids.
  // The older method weighted spectral magnitude and the current one power.
  const first = { measurementVersion: 2, integratedLufs: -6.3, spectralCentroidHz: 692, correlation: -1 };
  const second = { measurementVersion: 1, integratedLufs: -6.3, spectralCentroidHz: 1707, correlation: -1 };
  const notes = explainComparison(first, second);
  assert.ok(notes.some(({ metric, text }) => metric === "tone measurements" && /different method/.test(text)));
  assert.ok(notes.every(({ metric }) => metric !== "spectral centre"));
  assert.ok(notes.some(({ metric, track }) => metric === "phase relationship" && track === "both"));
  assert.ok(explainComparison(first, { ...second, measurementVersion: 2 }).some(({ metric }) => metric === "spectral centre"));
});

test("Restoring Mix Lab snapshots preserves existing sessions and rejects malformed measurements", () => {
  const legacy = {
    sampleRate: 48000, channelCount: 2, duration: 12, integratedLufs: -20, monoDeltaDb: null,
    correlation: -20, highLowTiltDb: "5", truePeakMethod: "<img>",
    bands: [{ id: "mids", label: "<img>", min: 3, energyPercent: 34, sidePercent: 120 }],
    shortTerm: [{ time: 3, lufs: -21 }, null, { time: -1, lufs: 12 }, { time: 2, lufs: -22 }],
    momentary: new Array(700).fill({ time: 1, lufs: -20 }),
  };
  const result = normaliseMixAnalysis(legacy);
  assert.equal(result.measurementVersion, 1);
  assert.equal(result.integratedLufs, -20);
  assert.equal(result.correlation, null);
  assert.equal(result.highLowTiltDb, null);
  assert.equal(result.bands.length, BAND_DEFINITIONS.length);
  assert.deepEqual(result.bands.find(({ id }) => id === "mids"), {
    id: "mids", label: "mids", min: 500, max: 2000, energyPercent: 34, sidePercent: null, correlation: null,
  });
  assert.deepEqual(result.shortTerm, [{ time: 2, lufs: -22 }, { time: 3, lufs: -21 }]);
  assert.equal(result.momentary.length, 360);
  assert.equal(normaliseMixAnalysis({ ...legacy, duration: -1 }), null);
  assert.equal(normaliseMixAnalysis({ ...legacy, measurementVersion: 100 }), null);
  const snapshot = normaliseMixAnalysis({ ...legacy, monoDeltaDb: -Infinity, leftRightBalanceDb: Infinity }, { forJSON: true });
  const restored = normaliseMixAnalysis(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.monoDeltaDb, -Infinity);
  assert.equal(restored.leftRightBalanceDb, Infinity);
});
