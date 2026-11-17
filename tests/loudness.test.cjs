/*
  These tests use simple generated audio, so they can check the loudness maths
  without storing music files in the project. The expected LUFS figures come
  from the official EBU Tech 3341 minimum-requirements tests.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyseLoudness } = require("../loudness.js");

function makeAudioBuffer(channels, sampleRate) {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0].length,
    getChannelData(channel) {
      return channels[channel];
    },
  };
}

function makeStereoTone({ peakDb, duration = 20, sampleRate = 48000, frequency = 1000 }) {
  const length = Math.round(duration * sampleRate);
  const amplitude = 10 ** (peakDb / 20);
  const channel = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    channel[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }

  // Both channels receive the same tone, as the EBU calibration signal does.
  return makeAudioBuffer([channel, channel.slice()], sampleRate);
}

function makeSegmentedStereoTone(segments, sampleRate = 48000) {
  const totalLength = segments.reduce((sum, segment) => sum + Math.round(segment.duration * sampleRate), 0);
  const channel = new Float32Array(totalLength);
  let writePosition = 0;

  for (const segment of segments) {
    const segmentLength = Math.round(segment.duration * sampleRate);
    const amplitude = 10 ** (segment.peakDb / 20);
    for (let index = 0; index < segmentLength; index += 1) {
      channel[writePosition] = amplitude * Math.sin((2 * Math.PI * 1000 * writePosition) / sampleRate);
      writePosition += 1;
    }
  }

  return makeAudioBuffer([channel, channel.slice()], sampleRate);
}

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

test("EBU calibration: -23 dBFS stereo tone measures -23 LUFS", () => {
  const result = analyseLoudness(makeStereoTone({ peakDb: -23 }));
  assertNear(result.lufs, -23, 0.1, "integrated loudness");
});

test("EBU calibration remains correct at -33 dBFS", () => {
  const result = analyseLoudness(makeStereoTone({ peakDb: -33 }));
  assertNear(result.lufs, -33, 0.1, "integrated loudness");
});

test("relative gate removes quiet beginning and ending sections", () => {
  const audio = makeSegmentedStereoTone([
    { duration: 10, peakDb: -36 },
    { duration: 60, peakDb: -23 },
    { duration: 10, peakDb: -36 },
  ]);
  assertNear(analyseLoudness(audio).lufs, -23, 0.1, "gated integrated loudness");
});

test("absolute and relative gates work together", () => {
  const audio = makeSegmentedStereoTone([
    { duration: 10, peakDb: -72 },
    { duration: 10, peakDb: -36 },
    { duration: 60, peakDb: -23 },
    { duration: 10, peakDb: -36 },
    { duration: 10, peakDb: -72 },
  ]);
  assertNear(analyseLoudness(audio).lufs, -23, 0.1, "gated integrated loudness");
});

test("EBU boundary case around the relative gate measures -23 LUFS", () => {
  const audio = makeSegmentedStereoTone([
    { duration: 20, peakDb: -26 },
    { duration: 20.1, peakDb: -20 },
    { duration: 20, peakDb: -26 },
  ]);
  assertNear(analyseLoudness(audio).lufs, -23, 0.1, "relative-gate boundary loudness");
});

test("EBU five-channel weights measure the standard calibration signal correctly", () => {
  const sampleRate = 48000;
  const duration = 20;
  const length = sampleRate * duration;
  const peakLevels = [-28, -28, -24, -30, -30];
  const channels = peakLevels.map((peakDb) => {
    const channel = new Float32Array(length);
    const amplitude = 10 ** (peakDb / 20);
    for (let index = 0; index < length; index += 1) {
      channel[index] = amplitude * Math.sin((2 * Math.PI * 1000 * index) / sampleRate);
    }
    return channel;
  });

  assertNear(
    analyseLoudness(makeAudioBuffer(channels, sampleRate)).lufs,
    -23,
    0.1,
    "five-channel integrated loudness",
  );
});

test("sample-rate conversion keeps the 44.1 kHz calibration within tolerance", () => {
  const result = analyseLoudness(makeStereoTone({ peakDb: -23, sampleRate: 44100 }));
  assertNear(result.lufs, -23, 0.1, "44.1 kHz integrated loudness");
});

test("sample peak and channel-average RMS keep their defined meanings", () => {
  const audio = makeStereoTone({ peakDb: -12, duration: 1 });
  const result = analyseLoudness(audio);
  assertNear(result.peakDb, -12, 0.001, "sample peak");
  assertNear(result.rmsDb, -15.0103, 0.01, "scientific RMS of a sine wave");
});

test("silence and recordings shorter than one complete block have no integrated value", () => {
  const silence = makeAudioBuffer([new Float32Array(48000), new Float32Array(48000)], 48000);
  const shortTone = makeStereoTone({ peakDb: -23, duration: 0.2 });
  assert.equal(analyseLoudness(silence).lufs, -Infinity);
  assert.equal(analyseLoudness(shortTone).lufs, -Infinity);
});
