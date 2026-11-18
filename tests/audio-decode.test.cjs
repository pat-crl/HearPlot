const test = require("node:test");
const assert = require("node:assert/strict");
const { convertAiffToWave, decodeRecording, detectSampleRate } = require("../audio-decode.js");

function bytes(length) {
  const buffer = new ArrayBuffer(length);
  const view = new DataView(buffer);
  const name = (offset, signature) => {
    for (let i = 0; i < signature.length; i += 1) view.setUint8(offset + i, signature.charCodeAt(i));
  };
  return { buffer, view, name };
}

test("WAV keeps its rate even with a padded metadata chunk before fmt", () => {
  const { buffer, view, name } = bytes(46);
  name(0, "RIFF");
  name(8, "WAVE");
  name(12, "JUNK");
  view.setUint32(16, 1, true);
  name(22, "fmt ");
  view.setUint32(26, 16, true);
  view.setUint32(34, 44100, true);
  assert.equal(detectSampleRate(buffer), 44100);
  view.setUint32(34, 96000, true);
  assert.equal(detectSampleRate(buffer), 96000);
  view.setUint32(16, 0xffffffff, true);
  assert.equal(detectSampleRate(buffer), null);
});

test("AIFF and FLAC preserve independently encoded sample rates", () => {
  const aiff = bytes(38);
  aiff.name(0, "FORM");
  aiff.name(8, "AIFF");
  aiff.name(12, "COMM");
  aiff.view.setUint32(16, 18);
  aiff.view.setUint16(28, 16398);
  aiff.view.setUint32(30, 0xbb800000);
  assert.equal(detectSampleRate(aiff.buffer), 48000);

  const flac = bytes(42);
  flac.name(0, "fLaC");
  flac.view.setUint32(4, 0x80000022);
  flac.view.setUint32(18, 96000 << 12);
  assert.equal(detectSampleRate(flac.buffer), 96000);
  flac.view.setUint32(18, 999999 << 12);
  assert.equal(detectSampleRate(flac.buffer), null);
});

test("truncated input and unknown containers leave the rate to the fallback", () => {
  for (let size = 0; size < 42; size += 1) {
    assert.equal(detectSampleRate(new ArrayBuffer(size)), null);
  }
});

test("a known oversized lossless recording is rejected before Chromium allocates decoded PCM", async () => {
  const flac = bytes(42);
  flac.name(0, "fLaC");
  flac.view.setUint32(4, 0x80000022);
  flac.view.setUint32(18, (48000 << 12) | 0x200); // stereo, source rate 48 kHz
  flac.view.setUint32(22, 48000 * 3600);
  const original = globalThis.OfflineAudioContext;
  let constructed = false;
  try {
    globalThis.OfflineAudioContext = function fakeDecoder() { constructed = true; };
    await assert.rejects(decodeRecording(flac.buffer), /expands beyond 512 MiB/);
    assert.equal(constructed, false);
  } finally {
    if (original) globalThis.OfflineAudioContext = original;
    else delete globalThis.OfflineAudioContext;
  }
});

function aiffFixture({ bits, format, samples }) {
  const descriptionSize = format ? 22 : 18;
  const soundHeader = 20 + descriptionSize;
  const soundOffset = 2;
  const soundSize = 8 + soundOffset + samples.length;
  const { buffer, view, name } = bytes(soundHeader + 8 + soundSize + soundSize % 2);
  name(0, "FORM");
  view.setUint32(4, buffer.byteLength - 8);
  name(8, format ? "AIFC" : "AIFF");
  name(12, "COMM");
  view.setUint32(16, descriptionSize);
  view.setUint16(20, 1);
  view.setUint32(22, samples.length / (bits / 8));
  view.setUint16(26, bits);
  view.setUint16(28, 16398);
  view.setUint32(30, 0xac440000);
  if (format) name(38, format);
  name(soundHeader, "SSND");
  view.setUint32(soundHeader + 4, soundSize);
  view.setUint32(soundHeader + 8, soundOffset);
  new Uint8Array(buffer).set(samples, soundHeader + 16 + soundOffset);
  return buffer;
}

test("AIFF conversion preserves 24-bit samples, sound offsets and sample rate", async () => {
  const source = aiffFixture({ bits: 24, samples: [0x12, 0x34, 0x56, 0xab, 0xcd, 0xef] });
  const wave = await convertAiffToWave(source);
  assert.equal(detectSampleRate(wave), 44100);
  assert.deepEqual([...new Uint8Array(wave, 44)], [0x56, 0x34, 0x12, 0xef, 0xcd, 0xab]);
  assert.equal(new DataView(wave).getUint16(34, true), 24);
});

test("signed 8-bit and little-endian AIFF-C PCM keep their values when converted", async () => {
  const small = await convertAiffToWave(aiffFixture({ bits: 8, samples: [0x80, 0, 0x7f] }));
  assert.deepEqual([...new Uint8Array(small, 44)], [0, 128, 255, 0]);
  assert.equal(new DataView(small).getUint32(40, true), 3);
  const little = await convertAiffToWave(aiffFixture({ bits: 16, format: "sowt", samples: [0x46, 0x80] }));
  assert.deepEqual([...new Uint8Array(little, 44)], [0x46, 0x80]);
  await assert.rejects(
    convertAiffToWave(aiffFixture({ bits: 16, format: "ulaw", samples: [0x46, 0x80] })),
    { name: "AudioFormatError" },
  );
});
