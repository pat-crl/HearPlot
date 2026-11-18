/* Decode independently of the playback device. A Bluetooth output can report
   a 24 kHz context even when the recording contains usable higher frequencies. */
(function attach(root, create) {
  const tools = create(root);
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserDecode = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function create(root) {
  const defaultRate = 48000;
  const minimumRate = 8000;
  const maximumRate = 192000;
  const maxRecordingBytes = 512 * 1024 * 1024;

  function nameAt(view, offset) {
    return String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
  }

  function findChunk(view, target, littleEndian) {
    let offset = 12;
    // Limit work even on files made entirely of tiny, unrecognised chunks.
    for (let count = 0; count < 256 && offset + 8 <= view.byteLength; count += 1) {
      const length = view.getUint32(offset + 4, littleEndian);
      const start = offset + 8;
      if (length > view.byteLength - start) return null;
      if (nameAt(view, offset) === target) return { start, length };
      offset = start + length + (length % 2);
    }
    return null;
  }

  function readWaveInfo(view, signature) {
    const littleEndian = signature !== "RIFX";
    const chunk = findChunk(view, "fmt ", littleEndian);
    if (!chunk || chunk.length < 16) return null;
    const sampleRate = view.getUint32(chunk.start + 4, littleEndian);
    const channels = view.getUint16(chunk.start + 2, littleEndian);
    let format = view.getUint16(chunk.start, littleEndian);
    // WAVE_FORMAT_EXTENSIBLE stores the underlying PCM or float format.
    if (format === 0xfffe && chunk.length >= 40) format = view.getUint32(chunk.start + 24, littleEndian);
    const alignment = view.getUint16(chunk.start + 12, littleEndian);
    const data = format === 1 || format === 3 ? findChunk(view, "data", littleEndian) : null;
    const frames = data && alignment > 0 ? Math.floor(data.length / alignment) : null;
    return { sampleRate, channels, frames };
  }

  function readAiffInfo(view, chunk = findChunk(view, "COMM", false)) {
    if (!chunk || chunk.length < 18) return null;
    const offset = chunk.start + 8;
    const exponent = view.getUint16(offset);
    // AIFF uses an unsigned 64-bit significand with an explicit leading bit.
    if (exponent < 16383 || exponent > 16418) return null;
    const highBits = view.getUint32(offset + 2);
    const lowBits = view.getUint32(offset + 6);
    const sampleRate = (highBits * 2 ** -31 + lowBits * 2 ** -63) * 2 ** (exponent - 16383);
    return {
      sampleRate,
      channels: view.getUint16(chunk.start),
      frames: view.getUint32(chunk.start + 2),
    };
  }

  function recordingInfo(bytes) {
    const view = new DataView(bytes);
    if (view.byteLength < 12) return null;
    const signature = nameAt(view, 0);
    const form = nameAt(view, 8);
    if ((signature === "RIFF" || signature === "RIFX" || signature === "RF64") && form === "WAVE") {
      return readWaveInfo(view, signature);
    }
    if (signature === "FORM" && (form === "AIFF" || form === "AIFC")) return readAiffInfo(view);
    if (signature === "fLaC" && view.byteLength >= 42 && (view.getUint32(4) & 0x7fffffff) === 34) {
      // STREAMINFO packs the sample rate, channels and 36-bit frame count.
      return {
        sampleRate: view.getUint32(18) >>> 12,
        channels: ((view.getUint8(20) >>> 1) & 7) + 1,
        frames: (view.getUint8(21) & 15) * 2 ** 32 + view.getUint32(22),
      };
    }
    return null;
  }

  function sourceRate(info) {
    const rate = info?.sampleRate;
    return Number.isInteger(rate) && rate >= minimumRate && rate <= maximumRate ? rate : null;
  }

  function detectSampleRate(bytes) {
    return sourceRate(recordingInfo(bytes));
  }

  function checkPcmSize(frames, channels) {
    if (frames * channels * Float32Array.BYTES_PER_ELEMENT > maxRecordingBytes) {
      throw new RangeError("The recording expands beyond 512 MiB of decoded audio. Try a shorter excerpt.");
    }
  }

  function checkEncodedSize(size) {
    if (size > maxRecordingBytes) throw new RangeError("The recording is larger than 512 MiB. Try a shorter excerpt.");
  }

  async function readRecordingBytes(file, signal) {
    signal?.throwIfAborted();
    checkEncodedSize(file.size);
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      function abort() {
        reader.abort();
      }
      function detach() {
        signal?.removeEventListener("abort", abort);
      }
      reader.addEventListener("load", () => resolve(reader.result), { once: true });
      reader.addEventListener("error", () => reject(reader.error), { once: true });
      reader.addEventListener("abort", () => reject(signal?.reason || new DOMException("Read aborted", "AbortError")), { once: true });
      reader.addEventListener("loadend", detach, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        reader.readAsArrayBuffer(file);
      } catch (error) {
        detach();
        reject(error);
      }
    });
  }

  async function convertAiffToWave(bytes, signal) {
    const view = new DataView(bytes);
    if (view.byteLength < 12 || nameAt(view, 0) !== "FORM") return null;
    const form = nameAt(view, 8);
    if (form !== "AIFF" && form !== "AIFC") return null;
    const description = findChunk(view, "COMM", false);
    const info = readAiffInfo(view, description);
    const sound = findChunk(view, "SSND", false);
    if (!info?.frames || !info.channels || info.channels > 32 || !sourceRate(info) || !sound || sound.length < 8) {
      throw new DOMException("Could not read the AIFF audio data.", "AudioFormatError");
    }
    checkPcmSize(info.frames, info.channels);
    const bits = view.getUint16(description.start + 6);
    const isAiffC = form === "AIFC";
    if (isAiffC && description.length < 22) throw new DOMException("Could not read the AIFF-C format.", "AudioFormatError");
    const format = isAiffC ? nameAt(view, description.start + 18) : "NONE";
    const littleEndian = format === "sowt";
    if (!["NONE", "twos", "sowt"].includes(format) || ![8, 16, 24, 32].includes(bits)) {
      throw new DOMException("This AIFF encoding is unsupported. Use uncompressed AIFF or WAV.", "AudioFormatError");
    }

    const bytesPerSample = bits / 8;
    const frameBytes = info.channels * bytesPerSample;
    const dataBytes = info.frames * frameBytes;
    const soundOffset = view.getUint32(sound.start);
    const dataOffset = sound.start + 8 + soundOffset;
    if (soundOffset + dataBytes > sound.length - 8) throw new DOMException("The AIFF audio data is incomplete.", "AudioFormatError");

    // Chromium's audio decoder and media player both support WAV. Keep the
    // converted PCM in memory and keep the original recording path untouched.
    const wave = new ArrayBuffer(44 + dataBytes + dataBytes % 2);
    const header = new DataView(wave);
    header.setUint32(0, 0x52494646); // RIFF
    header.setUint32(4, wave.byteLength - 8, true);
    header.setUint32(8, 0x57415645); // WAVE
    header.setUint32(12, 0x666d7420); // fmt
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true); // PCM
    header.setUint16(22, info.channels, true);
    header.setUint32(24, info.sampleRate, true);
    header.setUint32(28, info.sampleRate * frameBytes, true);
    header.setUint16(32, frameBytes, true);
    header.setUint16(34, bits, true);
    header.setUint32(36, 0x64617461); // data
    header.setUint32(40, dataBytes, true);

    const source = new Uint8Array(bytes, dataOffset, dataBytes);
    const target = new Uint8Array(wave, 44, dataBytes);
    const chunkBytes = 524288 * bytesPerSample;
    for (let start = 0; start < dataBytes; start += chunkBytes) {
      signal?.throwIfAborted();
      const end = Math.min(dataBytes, start + chunkBytes);
      if (bits === 8) {
        // AIFF PCM 8-bit values are signed while WAV PCM 8-bit is unsigned.
        for (let i = start; i < end; i += 1) target[i] = source[i] ^ 0x80;
      } else if (littleEndian) {
        target.set(source.subarray(start, end), start);
      } else {
        for (let i = start; i < end; i += bytesPerSample) {
          for (let byte = 0; byte < bytesPerSample; byte += 1) {
            target[i + byte] = source[i + bytesPerSample - 1 - byte];
          }
        }
      }
      if (end < dataBytes) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return wave;
  }

  async function decodeRecording(bytes) {
    checkEncodedSize(bytes.byteLength);
    const info = recordingInfo(bytes);
    // Refuse known oversized sources before handing them to Chromium's decoder.
    // Unknown containers still receive the post-decode size check below.
    if (info?.frames && info.channels > 0) checkPcmSize(info.frames, info.channels);
    const OfflineContext = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const rate = sourceRate(info) || defaultRate;
    let context;
    try {
      context = new OfflineContext(1, 1, rate);
    } catch (error) {
      if (rate === defaultRate || error.name !== "NotSupportedError") throw error;
      context = new OfflineContext(1, 1, defaultRate);
    }
    if (info?.frames && info.channels > 0 && info.sampleRate > 0 && context.sampleRate > info.sampleRate) {
      checkPcmSize(Math.ceil(info.frames * context.sampleRate / info.sampleRate), info.channels);
    }
    // The decoder consumes the provided ArrayBuffer. Playback still uses the
    // original File through its object URL, so no duplicate encoded copy is needed.
    const decoded = await context.decodeAudioData(bytes);
    checkPcmSize(decoded.length, decoded.numberOfChannels);
    return decoded;
  }

  async function prepareRecording(file, signal) {
    let bytes = await readRecordingBytes(file, signal);
    const converted = await convertAiffToWave(bytes, signal);
    signal?.throwIfAborted();
    let playback = file;
    if (converted) {
      bytes = converted;
      playback = new Blob([bytes], { type: "audio/wav" });
    }
    const buffer = await decodeRecording(bytes);
    signal?.throwIfAborted();
    return { buffer, playback };
  }

  return { prepareRecording, convertAiffToWave, decodeRecording, detectSampleRate, checkEncodedSize, checkPcmSize, readRecordingBytes };
}));
