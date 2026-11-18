/*
  These tests create simple audio in memory. That gives the spectrogram maths
  repeatable inputs without adding a copyrighted music file to the project.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyseSpectrogram,
  chooseSpectrogramSettings,
  frequencyForRow,
  rowForFrequency,
  MAX_COLUMNS,
  MAX_ROWS,
  MIN_DECIBELS,
} = require("../spectrogram.js");

// This small object supplies the same properties used from a browser AudioBuffer.
function makeAudioBuffer(samples, sampleRate) {
  return {
    sampleRate,
    numberOfChannels: 1,
    length: samples.length,
    duration: samples.length / sampleRate,
    getChannelData(channel) {
      if (channel !== 0) throw new RangeError("This generated buffer has one channel");
      return samples;
    },
  };
}

function makeSineTone({ frequency, duration = 1, sampleRate = 48000, amplitude = 0.8 }) {
  const samples = new Float32Array(Math.round(duration * sampleRate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return makeAudioBuffer(samples, sampleRate);
}

test("high-detail sizing follows the display, track duration, and practical caps", () => {
  assert.deepEqual(
    chooseSpectrogramSettings({ duration: 300, targetWidth: 2500, targetHeight: 700 }),
    { fftSize: 2048, columns: 3600, rows: 700 },
  );

  // Very large inputs stop at the app's memory-safe detail limits.
  assert.deepEqual(
    chooseSpectrogramSettings({ duration: 7200, targetWidth: 9000, targetHeight: 3000 }),
    { fftSize: 2048, columns: MAX_COLUMNS, rows: MAX_ROWS },
  );

  // A tiny preview still receives enough source pixels to avoid obvious blocks.
  assert.deepEqual(
    chooseSpectrogramSettings({ duration: 1, targetWidth: 50, targetHeight: 20 }),
    { fftSize: 2048, columns: 320, rows: 256 },
  );
});

test("silence produces a finite, dark value matrix", () => {
  const audio = makeAudioBuffer(new Float32Array(48000), 48000);
  const result = analyseSpectrogram(audio, { fftSize: 256, columns: 16, rows: 32 });

  assert.ok(result.values instanceof Float32Array);
  assert.equal(result.values.length, 16 * 32);
  assert.equal(result.peakDb, MIN_DECIBELS);
  assert.equal(result.floorDb, MIN_DECIBELS);
  assert.ok(result.values.every((value) => Number.isFinite(value)));
  assert.ok(result.values.every((value) => value === MIN_DECIBELS));
});

test("a 1 kHz sine appears on the expected logarithmic frequency row", () => {
  const sampleRate = 48000;
  const rows = 256;
  const columns = 7;
  const result = analyseSpectrogram(
    makeSineTone({ frequency: 1000, sampleRate }),
    { fftSize: 2048, columns, rows, minFrequency: 20 },
  );

  // The middle column has a complete Hann window, unlike the padded edges.
  const column = Math.floor(columns / 2);
  let strongestRow = 0;
  for (let row = 1; row < rows; row += 1) {
    if (result.values[column * rows + row] > result.values[column * rows + strongestRow]) {
      strongestRow = row;
    }
  }

  const expectedRow = rowForFrequency(1000, rows, result.minFrequency, result.nyquist);
  assert.ok(
    Math.abs(strongestRow - expectedRow) <= 2,
    `expected the 1 kHz ridge near row ${expectedRow.toFixed(1)}, received row ${strongestRow}`,
  );
});

test("high sample rates keep the low-frequency bins close to the source tone", () => {
  const sampleRate = 192000;
  const result = analyseSpectrogram(makeSineTone({ frequency: 40, sampleRate }), { columns: 5, rows: 1024 });
  assert.equal(result.fftSize, 8192);
  const centreColumn = result.values.subarray(result.rows * 2, result.rows * 3);
  const strongestRow = centreColumn.indexOf(Math.max(...centreColumn));
  const frequency = frequencyForRow(strongestRow, result.rows, result.minFrequency, result.nyquist);
  assert.ok(Math.abs(frequency - 40) < sampleRate / result.fftSize, `Expected a ridge near 40 Hz, got ${frequency}`);
});
