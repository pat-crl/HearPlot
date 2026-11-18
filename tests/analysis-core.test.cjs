const test = require("node:test");
const assert = require("node:assert/strict");
const { waveformEnvelope, colourSpectrogram } = require("../analysis-core.js");

test("bounded waveform buckets preserve both polarities and the last recording sample", () => {
  const samples = new Float32Array(32771);
  samples[0] = 0.75;
  samples[1] = -0.5;
  samples[samples.length - 1] = -0.875;
  const envelope = waveformEnvelope(samples);
  assert.equal(envelope.length, 8192 * 2);
  assert.deepEqual([...envelope.slice(0, 2)], [-0.5, 0.75]);
  assert.deepEqual([...envelope.slice(-2)], [-0.875, 0]);
  assert.deepEqual([...waveformEnvelope(new Float32Array([0]))], [0, 0]);
});

test("the worker raster has the expected row order and handles silent spectra", () => {
  const floor = [7, 16, 34, 255];
  const peak = [255, 246, 215, 255];
  const raster = colourSpectrogram({
    columns: 2, rows: 2, peakDb: -12, floorDb: -90, values: new Float32Array([-90, -12, -12, -90]),
  });
  assert.deepEqual([...raster.rgba], [...floor, ...peak, ...peak, ...floor]);
  assert.ok(!("values" in raster));
  const silent = colourSpectrogram({
    columns: 1, rows: 2, peakDb: -160, floorDb: -160, values: new Float32Array([-160, -160]),
  });
  assert.deepEqual([...silent.rgba], [...floor, ...floor]);
});
