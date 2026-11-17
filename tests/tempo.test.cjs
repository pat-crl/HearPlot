/*
  The tempo tests make their own small pieces of audio. Each piece contains a
  click on every beat and a stronger click on the first beat of every bar.
  This keeps the tests deterministic and avoids storing copyrighted music.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyseTempo, snapRangeToBarStarts } = require("../tempo.js");

function makeAudioBuffer(channel, sampleRate) {
  return {
    sampleRate,
    numberOfChannels: 1,
    length: channel.length,
    getChannelData() {
      return channel;
    },
  };
}

function makeClickTrack({
  bpm,
  firstBeatAt = 0.37,
  bars = 14,
  accentPhase = 0,
  sampleRate = 16000,
}) {
  const beatPeriod = 60 / bpm;
  const beatCount = bars * 4;
  const duration = firstBeatAt + beatCount * beatPeriod + 0.8;
  const channel = new Float32Array(Math.ceil(duration * sampleRate));
  const clickLength = Math.round(0.025 * sampleRate);

  for (let beat = 0; beat < beatCount; beat += 1) {
    const beatTime = firstBeatAt + beat * beatPeriod;
    const start = Math.round(beatTime * sampleRate);
    const isDownbeat = beat % 4 === accentPhase;
    const amplitude = isDownbeat ? 0.95 : 0.36;

    // A short, decaying mix of bass and treble gives the analyser something
    // closer to a tiny drum hit than a mathematically impossible one-sample
    // impulse. The formula has no random numbers, so every run is identical.
    for (let index = 0; index < clickLength && start + index < channel.length; index += 1) {
      const seconds = index / sampleRate;
      const decay = Math.exp(-seconds * 125);
      const waveform = index === 0
        ? 1
        : 0.58 * Math.sin(2 * Math.PI * 92 * seconds)
          + 0.42 * Math.cos(2 * Math.PI * 2100 * seconds);
      channel[start + index] += amplitude * decay * waveform;
    }
  }

  return makeAudioBuffer(channel, sampleRate);
}

function assertNear(actual, expected, tolerance, message) {
  assert.ok(Number.isFinite(actual), `${message}: expected a finite number, received ${actual}`);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ± ${tolerance}, received ${actual}`,
  );
}

function assertGrid(result, { bpm, barOneAt }, bpmTolerance = 0.65) {
  assert.equal(result.beatsPerBar, 4);
  assert.equal(result.details.status, "ok");
  assertNear(result.bpm, bpm, bpmTolerance, "detected BPM");
  assertNear(result.barOneAtSeconds, barOneAt, 0.035, "detected Bar 1");
  assert.ok(result.detectedBeatsSeconds.length > 20, "a useful beat grid should be returned");
  assert.ok(result.confidence.tempo > 0.45, `tempo confidence was ${result.confidence.tempo}`);
  assert.ok(result.confidence.beatPhase > 0.45, `phase confidence was ${result.confidence.beatPhase}`);
  assert.ok(result.confidence.downbeat > 0.15, `downbeat confidence was ${result.confidence.downbeat}`);
}

test("detects a steady 90 BPM track and its leading offset", () => {
  const firstBeatAt = 0.31;
  const result = analyseTempo(makeClickTrack({ bpm: 90, firstBeatAt }));
  assertGrid(result, { bpm: 90, barOneAt: firstBeatAt });
});

test("detects a 126 BPM dance grid after more than a second of silence", () => {
  const firstBeatAt = 1.17;
  // 44.1 kHz is common for music files and confirms that calculations use the
  // buffer's real sample rate instead of relying on the faster test default.
  const result = analyseTempo(makeClickTrack({
    bpm: 126,
    firstBeatAt,
    bars: 18,
    sampleRate: 44100,
  }));
  assertGrid(result, { bpm: 126, barOneAt: firstBeatAt });
});

test("keeps a fast 174 BPM track at 174 rather than halving it to 87", () => {
  const firstBeatAt = 0.43;
  const result = analyseTempo(makeClickTrack({ bpm: 174, firstBeatAt, bars: 18 }));
  assertGrid(result, { bpm: 174, barOneAt: firstBeatAt }, 0.9);
  assert.ok(result.bpm > 150, `fast tempo should not be halved, received ${result.bpm}`);
});

test("downbeat accents can place Bar 1 after two pickup beats", () => {
  const bpm = 126;
  const firstBeatAt = 0.52;
  const accentPhase = 2;
  const expectedBarOne = firstBeatAt + accentPhase * (60 / bpm);
  const result = analyseTempo(makeClickTrack({ bpm, firstBeatAt, accentPhase, bars: 18 }));

  assertGrid(result, { bpm, barOneAt: expectedBarOne });
  assert.equal(result.details.detectedDownbeatPhase % 4, positiveModulo(
    Math.round((expectedBarOne - result.beatPhaseAtSeconds) / result.beatPeriodSeconds),
    4,
  ));
});

test("silence returns an honest empty result instead of invented precision", () => {
  const result = analyseTempo(makeAudioBuffer(new Float32Array(16000 * 8), 16000));
  assert.equal(result.bpm, null);
  assert.equal(result.barOneAtSeconds, null);
  assert.deepEqual(result.confidence, { overall: 0, tempo: 0, beatPhase: 0, downbeat: 0 });
  assert.equal(result.details.status, "not-enough-rhythm");
});

test("arrangement ranges snap to bar starts and retain at least one full bar", () => {
  const common = [1, 2, 12]; // Bar 1 at 1s, then a bar every 2s until 11s.

  assert.deepEqual(snapRangeToBarStarts(3.4, 7.6, ...common), { start: 3, end: 7 });
  assert.deepEqual(snapRangeToBarStarts(5.1, 5.4, ...common), { start: 5, end: 7 });
  assert.deepEqual(snapRangeToBarStarts(10.5, 11.8, ...common), { start: 9, end: 11 });
  assert.equal(snapRangeToBarStarts(4, 4, ...common), null);
});

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
