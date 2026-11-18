/*
  MUSIC ANALYSER — OFFLINE LOUDNESS MEASUREMENTS

  This file keeps the technical audio measurements separate from the interface.
  That makes the maths easier to read and lets the same functions be tested
  without opening the whole app.

  Integrated LUFS follows ITU-R BS.1770-5 / EBU R 128:
  1. each channel passes through the two-part K-weighting filter;
  2. the filtered energy is collected in 400 ms blocks, 100 ms apart;
  3. blocks below -70 LUFS are removed;
  4. a second gate removes blocks more than 10 LU below the first result;
  5. the remaining blocks are averaged to make the final integrated reading.
*/

(function attachLoudnessTools(root, createTools) {
  const tools = createTools();

  // A normal browser receives one global object. Node receives the same object
  // through module.exports so the measurement code can be unit-tested.
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserLoudness = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function createLoudnessTools() {
  const LOUDNESS_OFFSET = -0.691;
  const ABSOLUTE_GATE_LUFS = -70;
  const RELATIVE_GATE_LU = -10;
  const BLOCK_SECONDS = 0.4;
  const BLOCK_STEP_SECONDS = 0.1;
  const REFERENCE_SAMPLE_RATE = 48000;

  /*
    These are the official 48 kHz K-weighting coefficients from BS.1770-5.
    A biquad is a small filter that remembers the previous two samples. The
    first stage is a high-frequency shelf; the second removes very low sound.
  */
  const K_WEIGHTING_48K = [
    {
      b0: 1.53512485958697,
      b1: -2.69169618940638,
      b2: 1.19839281085285,
      a1: -1.69065929318241,
      a2: 0.73248077421585,
    },
    {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: -1.99004745483398,
      a2: 0.99007225036621,
    },
  ];

  function analyseLoudness(audioBuffer, { detailed = false } = {}) {
    const sampleRate = Number(audioBuffer.sampleRate);
    const channelCount = Number(audioBuffer.numberOfChannels);
    const sampleCount = Number(audioBuffer.length || audioBuffer.getChannelData(0).length);

    if (!(sampleRate > 0) || !(channelCount > 0) || !(sampleCount > 0)) {
      return detailed
        ? { peakDb: -Infinity, rmsDb: -Infinity, lufs: -Infinity, momentary: [], shortTerm: [],
          maxMomentaryLufs: null, maxShortTermLufs: null, loudnessRange: null }
        : { peakDb: -Infinity, rmsDb: -Infinity, lufs: -Infinity };
    }

    // BS.1770 uses complete 400 ms blocks with 75% overlap, which means a new
    // block begins every 100 ms. An unfinished block at the end is ignored.
    const blockLength = Math.max(1, Math.round(sampleRate * BLOCK_SECONDS));
    const blockStep = Math.max(1, Math.round(sampleRate * BLOCK_STEP_SECONDS));
    const blockCount = sampleCount < blockLength
      ? 0
      : 1 + Math.floor((sampleCount - blockLength) / blockStep);
    const blockPowers = new Float64Array(blockCount);
    // At standard sample rates every 400 ms block is four 100 ms segments.
    // Collect each segment once instead of shifting a sample-sized ring for
    // every channel. Keep the exact complete-block path at unusual rates.
    const blocksAlign = blockLength === 4 * blockStep;
    const segmentCount = blockCount && (blocksAlign || detailed) ? Math.floor(sampleCount / blockStep) : 0;
    const segmentPowers = new Float64Array(segmentCount);
    const [shelf, highPass] = K_WEIGHTING_48K.map((filter) => remapBiquad(filter, sampleRate));

    let peak = 0;
    let rmsSum = 0;
    let rmsCount = 0;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const samples = audioBuffer.getChannelData(channel);
      const loudnessWeight = channelWeight(channel, channelCount);
      const recentPowers = blockCount && !blocksAlign ? new Float64Array(blockLength) : null;
      let recentPowerSum = 0;
      let recentPowerPosition = 0;
      let nextBlock = 0;
      let nextBlockEnd = blockLength;
      let segmentPower = 0;
      let segment = 0;
      let nextSegmentEnd = blockStep;

      // Each filter stage keeps two small state values. Direct Form II
      // Transposed is both efficient and numerically stable for this job.
      let shelfState1 = 0;
      let shelfState2 = 0;
      let highPassState1 = 0;
      let highPassState2 = 0;

      for (let index = 0; index < sampleCount; index += 1) {
        const sample = samples[index];
        const absolute = Math.abs(sample);
        const rawPower = sample * sample;

        if (absolute > peak) peak = absolute;
        rmsSum += rawPower;
        rmsCount += 1;

        // The LFE channel has a loudness weight of zero. Its samples still
        // count towards sample peak and RMS, but do not enter integrated LUFS.
        if (!blockCount || loudnessWeight === 0) continue;

        const shelfOutput = shelf.b0 * sample + shelfState1;
        shelfState1 = shelf.b1 * sample - shelf.a1 * shelfOutput + shelfState2;
        shelfState2 = shelf.b2 * sample - shelf.a2 * shelfOutput;

        const filtered = highPass.b0 * shelfOutput + highPassState1;
        highPassState1 = highPass.b1 * shelfOutput - highPass.a1 * filtered + highPassState2;
        highPassState2 = highPass.b2 * shelfOutput - highPass.a2 * filtered;

        const filteredPower = filtered * filtered;
        const samplesSeen = index + 1;
        segmentPower += filteredPower;
        if (samplesSeen === nextSegmentEnd) {
          if (segment < segmentCount) segmentPowers[segment] += loudnessWeight * segmentPower / blockStep;
          segmentPower = 0;
          segment += 1;
          nextSegmentEnd += blockStep;
        }
        if (recentPowers) {
          recentPowerSum += filteredPower - recentPowers[recentPowerPosition];
          recentPowers[recentPowerPosition] = filteredPower;
          recentPowerPosition += 1;
          if (recentPowerPosition === blockLength) recentPowerPosition = 0;
          if (samplesSeen === nextBlockEnd) {
            blockPowers[nextBlock] += loudnessWeight * recentPowerSum / blockLength;
            nextBlock += 1;
            nextBlockEnd += blockStep;
          }
        }
      }
    }

    const rms = Math.sqrt(rmsSum / Math.max(1, rmsCount));

    if (blocksAlign) {
      for (let index = 0; index < blockCount; index += 1) {
        blockPowers[index] = (segmentPowers[index] + segmentPowers[index + 1]
          + segmentPowers[index + 2] + segmentPowers[index + 3]) / 4;
      }
    }

    const basic = {
      peakDb: amplitudeToDb(peak),
      rmsDb: amplitudeToDb(rms),
      lufs: integratedLoudnessFromBlocks(blockPowers),
    };
    if (!detailed) return basic;

    const stepSeconds = blockStep / sampleRate;
    const momentary = Array.from(blockPowers, (power, index) => ({
      time: index * stepSeconds + blockLength / (2 * sampleRate),
      lufs: powerToLufs(power),
    }));
    const shortTerm = threeSecondSeries(segmentPowers, stepSeconds);
    return { ...basic, momentary, shortTerm,
      maxMomentaryLufs: maximumLufs(momentary),
      maxShortTermLufs: maximumLufs(shortTerm),
      loudnessRange: loudnessRangeFromShortTerm(shortTerm.map(({ lufs }) => lufs)),
    };
  }

  function threeSecondSeries(segmentPowers, stepSeconds) {
    const windowSegments = 30;
    const points = [];
    for (let start = 0; start + windowSegments <= segmentPowers.length; start += 1) {
      let power = 0;
      for (let index = start; index < start + windowSegments; index += 1) power += segmentPowers[index];
      points.push({ time: (start + windowSegments / 2) * stepSeconds, lufs: powerToLufs(power / windowSegments) });
    }
    return points;
  }

  function maximumLufs(points) {
    let max = -Infinity;
    for (const point of points) max = Math.max(max, point.lufs);
    return Number.isFinite(max) ? max : null;
  }

  // EBU Tech 3342 (2023), https://tech.ebu.ch/docs/tech/tech3342.pdf.
  // This implementation uses complete three-second windows from the decoded
  // signal at 100 ms hops, and does not append synthetic trailing silence.
  function loudnessRangeFromShortTerm(values) {
    const absolute = values.filter((value) => Number.isFinite(value) && value >= ABSOLUTE_GATE_LUFS);
    if (absolute.length < 2) return null;
    const relativeGate = 10 * Math.log10(mean(absolute.map((value) => 10 ** (value / 10)))) - 20;
    const gated = absolute.filter((value) => value >= relativeGate).sort((a, b) => a - b);
    if (gated.length < 2) return null;
    const indexAt = (fraction) => Math.round((gated.length - 1) * fraction);
    return gated[indexAt(0.95)] - gated[indexAt(0.10)];
  }

  function integratedLoudnessFromBlocks(blockPowers) {
    if (!blockPowers.length) return -Infinity;

    // First gate: remove silence and extremely quiet blocks below -70 LUFS.
    const absolutePowers = [];
    for (const power of blockPowers) {
      if (powerToLufs(power) > ABSOLUTE_GATE_LUFS) absolutePowers.push(power);
    }
    if (!absolutePowers.length) return -Infinity;

    // Second gate: measure the first set, then keep blocks no more than 10 LU
    // below it. Both gates are checked, as the standard specifies.
    const absoluteGatedLufs = powerToLufs(mean(absolutePowers));
    const relativeThreshold = absoluteGatedLufs + RELATIVE_GATE_LU;
    const finalPowers = absolutePowers.filter((power) => powerToLufs(power) > relativeThreshold);

    return finalPowers.length ? powerToLufs(mean(finalPowers)) : -Infinity;
  }

  function channelWeight(channelIndex, channelCount) {
    // Mono and stereo music use a weight of 1 for every channel.
    if (channelCount <= 3) return 1;

    // Web Audio's common 5.1 order is L, R, C, LFE, Ls, Rs. BS.1770 excludes
    // LFE and gives the two surround channels a 1.41 energy multiplier.
    if (channelCount === 6) {
      if (channelIndex === 3) return 0;
      return channelIndex >= 4 ? 1.41 : 1;
    }

    // Common four- and five-channel layouts end with their surround pair.
    if (channelCount === 4) return channelIndex >= 2 ? 1.41 : 1;
    if (channelCount === 5) return channelIndex >= 3 ? 1.41 : 1;

    // Advanced layouts need speaker-position metadata that AudioBuffer does
    // not provide. A neutral weight is the safest fallback for those files.
    return 1;
  }

  function remapBiquad(coefficients, sampleRate) {
    if (sampleRate === REFERENCE_SAMPLE_RATE) return { ...coefficients };

    /*
      The standard publishes exact coefficients at 48 kHz and asks other
      sample rates to keep the same response. Here we convert the 48 kHz
      digital filter to its underlying continuous form, then map that form to
      the decoded buffer's sample rate. This avoids using 48 kHz coefficients
      unchanged on 44.1 or 96 kHz material.
    */
    const referenceScale = 2 * REFERENCE_SAMPLE_RATE;
    const targetScale = 2 * sampleRate;
    const { b0, b1, b2, a1, a2 } = coefficients;

    const numerator0 = b0 + b1 + b2;
    const numerator1 = (2 * b0 - 2 * b2) / referenceScale;
    const numerator2 = (b0 - b1 + b2) / (referenceScale * referenceScale);
    const denominator0 = 1 + a1 + a2;
    const denominator1 = (2 - 2 * a2) / referenceScale;
    const denominator2 = (1 - a1 + a2) / (referenceScale * referenceScale);

    const targetSquared = targetScale * targetScale;
    const targetB0 = numerator0 + numerator1 * targetScale + numerator2 * targetSquared;
    const targetB1 = 2 * numerator0 - 2 * numerator2 * targetSquared;
    const targetB2 = numerator0 - numerator1 * targetScale + numerator2 * targetSquared;
    const targetA0 = denominator0 + denominator1 * targetScale + denominator2 * targetSquared;
    const targetA1 = 2 * denominator0 - 2 * denominator2 * targetSquared;
    const targetA2 = denominator0 - denominator1 * targetScale + denominator2 * targetSquared;

    return {
      b0: targetB0 / targetA0,
      b1: targetB1 / targetA0,
      b2: targetB2 / targetA0,
      a1: targetA1 / targetA0,
      a2: targetA2 / targetA0,
    };
  }

  function mean(values) {
    let total = 0;
    for (const value of values) total += value;
    return total / values.length;
  }

  function powerToLufs(power) {
    return power > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(power) : -Infinity;
  }

  function amplitudeToDb(amplitude) {
    return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
  }

  return {
    analyseLoudness,
    amplitudeToDb,
    // The helpers below are exported so small, focused tests can check the
    // standard's gates and sample-rate conversion directly if needed later.
    integratedLoudnessFromBlocks,
    remapBiquad,
  };
}));
