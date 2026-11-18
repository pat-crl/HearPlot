/*
 * Mix Lab measurements for decoded PCM. The worker and Node tests use the
 * same engine. Engineering descriptors and the inter-sample peak estimate
 * are listening aids. Loudness uses the shared K-weighted measurement engine.
 */
(function attachMixAnalysis(root, createTools) {
  if (typeof module === "object" && module.exports) {
    module.exports = createTools(require("./loudness.js"), require("./spectrogram.js"));
  } else {
    root.MusicAnalyserMixAnalysis = createTools(root.MusicAnalyserLoudness, root.MusicAnalyserSpectrogram);
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function createMixAnalysisTools(loudness, spectrum) {
  const MEASUREMENT_VERSION = 2;
  const TRUE_PEAK_METHOD = "4× cubic inter-sample estimate";
  const MAX_SPECTRAL_FRAMES = 480;
  const MAX_PLOT_POINTS = 360;
  const NEAR_FULL_SCALE = 0.9999;
  const RATIO_FIELDS = ["monoDeltaDb", "leftRightBalanceDb", "highLowTiltDb"];
  const BAND_DEFINITIONS = Object.freeze([
    { id: "sub", label: "sub", min: 20, max: 60 },
    { id: "bass", label: "bass", min: 60, max: 250 },
    { id: "lowMids", label: "low mids", min: 250, max: 500 },
    { id: "mids", label: "mids", min: 500, max: 2000 },
    { id: "highMids", label: "high mids", min: 2000, max: 6000 },
    { id: "highs", label: "highs", min: 6000, max: 12000 },
    { id: "air", label: "air", min: 12000, max: null },
  ].map(Object.freeze));
  const scalarFields = [
    "integratedLufs", "maxMomentaryLufs", "maxShortTermLufs", "loudnessRange",
    "samplePeakDb", "rmsDb", "estimatedTruePeakDb", "plr", "crestFactor",
    "loudnessDensity", "clippedSamplePercent", "dcOffset",
    "correlation", "sidePercent", "monoDeltaDb", "leftRightBalanceDb",
    "spectralCentroidHz", "spectralRolloffHz", "spectralFlatness", "highLowTiltDb",
  ];

  function analyseMix(audioBuffer, { onProgress = () => {} } = {}) {
    const { length, sampleRate, numberOfChannels } = audioBuffer ?? {};
    if (!Number.isInteger(length) || length < 1 || !Number.isFinite(sampleRate) || sampleRate < 1000
      || !Number.isInteger(numberOfChannels) || numberOfChannels < 1
      || typeof audioBuffer.getChannelData !== "function") {
      throw new TypeError("Mix Lab requires decoded audio");
    }
    const duration = length / sampleRate;

    onProgress(0, "loudness");
    const levels = loudness.analyseLoudness(audioBuffer, { detailed: true });
    onProgress(0.38, "dynamics");
    const dynamics = analyseDynamics(audioBuffer);
    onProgress(0.72, "spectrum");
    const frequency = analyseSpectrum(audioBuffer);
    onProgress(1, "spectrum");

    return {
      measurementVersion: MEASUREMENT_VERSION,
      duration,
      sampleRate,
      channelCount: numberOfChannels,
      integratedLufs: finiteValue(levels.lufs),
      maxMomentaryLufs: levels.maxMomentaryLufs,
      maxShortTermLufs: levels.maxShortTermLufs,
      loudnessRange: levels.loudnessRange,
      samplePeakDb: finiteValue(levels.peakDb),
      rmsDb: finiteValue(levels.rmsDb),
      plr: finiteDifference(dynamics.estimatedTruePeakDb, levels.lufs),
      crestFactor: finiteDifference(dynamics.estimatedTruePeakDb, levels.rmsDb),
      loudnessDensity: loudnessDensity(levels.momentary, levels.lufs),
      ...dynamics,
      ...frequency,
      shortTerm: plotSeries(levels.shortTerm),
      momentary: plotSeries(levels.momentary),
      lraStable: duration >= 60 && levels.loudnessRange !== null,
      truePeakMethod: TRUE_PEAK_METHOD,
    };
  }

  function analyseDynamics(audioBuffer) {
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    let leftPower = 0;
    let rightPower = 0;
    let crossPower = 0;
    let midPower = 0;
    let sidePower = 0;
    let dcSum = 0;

    // The spatial descriptors use the first two channels. Mono is treated
    // as a centred signal. Other channels still count towards peak and LUFS.
    for (let index = 0; index < left.length; index += 1) {
      const l = left[index];
      const r = right[index];
      const mid = (l + r) / 2;
      const side = (l - r) / 2;
      leftPower += l * l;
      rightPower += r * r;
      crossPower += l * r;
      midPower += mid * mid;
      sidePower += side * side;
      dcSum += mid;
    }

    let peak = 0;
    let nearFullScaleCount = 0;
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
      const samples = audioBuffer.getChannelData(channel);
      // The interpolation taps use zero outside the recording. Rolling the
      // four samples forward gives the same work per phase at both edges.
      let a = 0;
      let b = 0;
      let c = samples[0];
      let d = samples[1] ?? 0;
      for (let index = -1; index < samples.length; index += 1) {
        if (Math.abs(b) >= NEAR_FULL_SCALE) nearFullScaleCount += 1;
        peak = Math.max(peak, Math.abs(b), intervalPeak(a, b, c, d));
        a = b;
        b = c;
        c = d;
        d = samples[index + 3] ?? 0;
      }
    }

    return {
      estimatedTruePeakDb: peak > 0 ? 20 * Math.log10(peak) : null,
      clippedSamplePercent: 100 * nearFullScaleCount / (audioBuffer.length * audioBuffer.numberOfChannels),
      dcOffset: dcSum / left.length,
      correlation: correlation(crossPower, leftPower, rightPower),
      sidePercent: shareOfPower(sidePower, midPower + sidePower),
      monoDeltaDb: powerRatioDb(midPower, (leftPower + rightPower) / 2),
      leftRightBalanceDb: powerRatioDb(leftPower, rightPower),
    };
  }

  // Catmull-Rom interpolation at 1/4, 1/2 and 3/4 of a sample interval.
  // The exact fixed coefficients avoid recomputing the cubic per phase.
  function intervalPeak(a, b, c, d) {
    const quarter = (-9 * a + 111 * b + 29 * c - 3 * d) / 128;
    const half = (-a + 9 * b + 9 * c - d) / 16;
    const threeQuarters = (-3 * a + 29 * b + 111 * c - 9 * d) / 128;
    return Math.max(Math.abs(quarter), Math.abs(half), Math.abs(threeQuarters));
  }

  function analyseSpectrum(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const left = audioBuffer.getChannelData(0);
    const isMono = audioBuffer.numberOfChannels === 1;
    const right = isMono ? left : audioBuffer.getChannelData(1);
    // Keep sub-band resolution comparable when the sample rate changes.
    const fftSize = Math.max(1024, Math.min(16384, 2 ** Math.ceil(Math.log2(sampleRate / 15))));
    const halfSize = fftSize / 2;
    const binWidth = sampleRate / fftSize;
    const firstBin = Math.ceil(BAND_DEFINITIONS[0].min / binWidth);
    const window = spectrum.createHannWindow(fftSize);
    const frameCount = Math.max(1, Math.min(MAX_SPECTRAL_FRAMES, Math.ceil(left.length / fftSize)));
    const lastStart = left.length - fftSize;
    const step = frameCount > 1 ? lastStart / (frameCount - 1) : 0;
    const leftReal = new Float64Array(fftSize);
    const leftImaginary = new Float64Array(fftSize);
    const rightReal = isMono ? leftReal : new Float64Array(fftSize);
    const rightImaginary = isMono ? leftImaginary : new Float64Array(fftSize);
    const bandForBin = new Uint8Array(halfSize + 1);
    const totalBinPower = new Float64Array(halfSize + 1);
    const bands = BAND_DEFINITIONS.map(() => ({ left: 0, right: 0, cross: 0 }));
    let weightedFlatness = 0;
    let totalPower = 0;

    for (let bin = firstBin, band = 0; bin <= halfSize; bin += 1) {
      while (band + 1 < BAND_DEFINITIONS.length && bin * binWidth >= BAND_DEFINITIONS[band + 1].min) band += 1;
      bandForBin[bin] = band;
    }

    for (let frame = 0; frame < frameCount; frame += 1) {
      const start = lastStart < 0 ? Math.floor(lastStart / 2) : Math.round(frame * step);
      windowedFft(left, start, window, leftReal, leftImaginary);
      if (!isMono) windowedFft(right, start, window, rightReal, rightImaginary);
      let framePower = 0;
      let logPower = 0;

      for (let bin = firstBin; bin <= halfSize; bin += 1) {
        // Other positive-frequency bins have a mirrored partner. Relative to
        // those bins, the single Nyquist bin should carry half their weight.
        const weight = bin === halfSize ? 0.5 : 1;
        const leftPower = weight * (leftReal[bin] ** 2 + leftImaginary[bin] ** 2);
        const rightPower = weight * (rightReal[bin] ** 2 + rightImaginary[bin] ** 2);
        const binPower = leftPower + rightPower;
        const band = bands[bandForBin[bin]];
        band.left += leftPower;
        band.right += rightPower;
        band.cross += weight * (leftReal[bin] * rightReal[bin] + leftImaginary[bin] * rightImaginary[bin]);
        totalBinPower[bin] += binPower;
        framePower += binPower;
        logPower += Math.log(Math.max(binPower, 1e-30));
      }

      if (framePower > 0) {
        const count = halfSize - firstBin + 1;
        const flatness = Math.exp(logPower / count) / (framePower / count);
        weightedFlatness += framePower * Math.min(1, flatness);
        totalPower += framePower;
      }
    }

    let lowPower = 0;
    let highPower = 0;
    let weightedFrequency = 0;
    let cumulativePower = 0;
    let rolloff = null;
    for (let bin = firstBin; bin <= halfSize; bin += 1) {
      const power = totalBinPower[bin];
      const hz = bin * binWidth;
      weightedFrequency += power * hz;
      cumulativePower += power;
      if (rolloff === null && totalPower > 0 && cumulativePower >= totalPower * 0.85) rolloff = hz;
      if (hz < 500) lowPower += power;
      if (hz >= 2000) highPower += power;
    }

    return {
      spectralCentroidHz: totalPower > 0 ? weightedFrequency / totalPower : null,
      spectralRolloffHz: rolloff,
      spectralFlatness: totalPower > 0 ? weightedFlatness / totalPower : null,
      highLowTiltDb: powerRatioDb(highPower, lowPower),
      bands: bands.map(({ left, right, cross }, index) => ({
        ...BAND_DEFINITIONS[index],
        energyPercent: shareOfPower(left + right, totalPower),
        sidePercent: left + right > 0 ? clamp(50 * (1 - 2 * cross / (left + right)), 0, 100) : null,
        correlation: correlation(cross, left, right),
      })),
    };
  }

  function windowedFft(samples, start, window, real, imaginary) {
    for (let index = 0; index < real.length; index += 1) {
      real[index] = (samples[start + index] ?? 0) * window[index];
      imaginary[index] = 0;
    }
    spectrum.fft(real, imaginary);
  }

  function loudnessDensity(points, integratedLufs) {
    if (!Number.isFinite(integratedLufs) || points.length === 0) return null;
    let aboveThreshold = 0;
    for (const { lufs } of points) if (lufs >= integratedLufs - 1) aboveThreshold += 1;
    return 100 * aboveThreshold / points.length;
  }

  function plotSeries(points) {
    if (points.length <= MAX_PLOT_POINTS) return points.map(toPlotPoint);
    // Retain quiet and loud extrema in chronological order so large sessions
    // do not erase the short peaks and drops that an analyser should reveal.
    const result = [toPlotPoint(points[0])];
    const bucketCount = (MAX_PLOT_POINTS - 2) / 2;
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const start = 1 + Math.floor(bucket * (points.length - 2) / bucketCount);
      const end = 1 + Math.floor((bucket + 1) * (points.length - 2) / bucketCount);
      let low = start;
      let high = start;
      for (let index = start + 1; index < end; index += 1) {
        if (points[index].lufs < points[low].lufs) low = index;
        if (points[index].lufs > points[high].lufs) high = index;
      }
      result.push(toPlotPoint(points[Math.min(low, high)]));
      if (low !== high) result.push(toPlotPoint(points[Math.max(low, high)]));
    }
    result.push(toPlotPoint(points.at(-1)));
    return result;
  }

  function toPlotPoint({ time, lufs }) {
    return { time, lufs: finiteValue(lufs) };
  }

  function normaliseMixAnalysis(value, { forJSON = false } = {}) {
    if (!value || typeof value !== "object" || !Number.isFinite(value.duration) || value.duration <= 0
      || !Number.isFinite(value.sampleRate) || value.sampleRate < 1000 || value.sampleRate > 768000
      || value.duration * value.sampleRate > 2 ** 32
      || !Number.isInteger(value.channelCount) || value.channelCount < 1 || value.channelCount > 32) return null;
    const measurementVersion = value.measurementVersion ?? 1;
    if (measurementVersion !== 1 && measurementVersion !== MEASUREMENT_VERSION) return null;

    const importedBands = new Map();
    if (Array.isArray(value.bands)) {
      for (const band of value.bands.slice(0, BAND_DEFINITIONS.length)) {
        if (typeof band?.id === "string") importedBands.set(band.id, band);
      }
    }

    const data = Object.fromEntries(scalarFields.map((key) => [key, numberInRange(value[key], -2000, 2000)]));
    for (const key of ["loudnessDensity", "clippedSamplePercent", "sidePercent"]) {
      data[key] = numberInRange(data[key], 0, 100);
    }
    data.correlation = numberInRange(data.correlation, -1, 1);
    data.spectralFlatness = numberInRange(data.spectralFlatness, 0, 1);
    data.spectralCentroidHz = numberInRange(value.spectralCentroidHz, 0, value.sampleRate / 2);
    data.spectralRolloffHz = numberInRange(value.spectralRolloffHz, 0, value.sampleRate / 2);
    data.loudnessRange = numberInRange(data.loudnessRange, 0, 2000);
    data.dcOffset = numberInRange(value.dcOffset, -(2 ** 128), 2 ** 128);
    for (const key of RATIO_FIELDS) data[key] = convertRatio(value[key], forJSON);

    return {
      ...data,
      measurementVersion,
      duration: value.duration,
      sampleRate: value.sampleRate,
      channelCount: value.channelCount,
      lraStable: value.duration >= 60 && data.loudnessRange !== null,
      truePeakMethod: TRUE_PEAK_METHOD,
      bands: BAND_DEFINITIONS.map((definition) => {
        const band = importedBands.get(definition.id);
        return {
          ...definition,
          energyPercent: numberInRange(band?.energyPercent, 0, 100),
          sidePercent: numberInRange(band?.sidePercent, 0, 100),
          correlation: numberInRange(band?.correlation, -1, 1),
        };
      }),
      momentary: normaliseTimeline(value.momentary, value.duration),
      shortTerm: normaliseTimeline(value.shortTerm, value.duration),
    };
  }

  // Infinity is meaningful for an exactly cancelled or entirely one-sided
  // signal. Preserve it in snapshots without confusing it with a missing value.
  function convertRatio(value, forJSON) {
    if (value === -Infinity || value === "-Infinity") return forJSON ? "-Infinity" : -Infinity;
    if (value === Infinity || value === "Infinity") return forJSON ? "Infinity" : Infinity;
    return numberInRange(value, -2000, 2000);
  }

  function normaliseTimeline(points, duration) {
    if (!Array.isArray(points)) return [];
    return points.slice(0, MAX_PLOT_POINTS)
      .filter((point) => point && numberInRange(point.time, 0, duration) !== null)
      .map(({ time, lufs }) => ({ time, lufs: numberInRange(lufs, -2000, 2000) }))
      .sort((a, b) => a.time - b.time);
  }

  function explainComparison(first, second, firstLabel = "Track A", secondLabel = "Track B") {
    if (!first || !second) return [];
    const explanations = [];
    const explainHigher = (metric, difference, threshold, message) => {
      if (!Number.isFinite(difference) || Math.abs(difference) < threshold) return;
      const track = difference > 0 ? firstLabel : secondLabel;
      explanations.push({ metric, track, text: `${track} ${message}` });
    };
    const integratedDifference = finiteDifference(first.integratedLufs, second.integratedLufs);
    if (integratedDifference === null) {
      explanations.push({ metric: "programme loudness", track: "unavailable",
        text: "At least one recording has no gated integrated loudness. A level-matched comparison is unavailable." });
    } else if (Math.abs(integratedDifference) < 1) {
      explanations.push({ metric: "programme loudness", track: "matched",
        text: "Integrated loudness is within 1 LU. Look at the loudness timeline, tone balance and stereo image for other differences." });
    } else {
      explainHigher("programme loudness", integratedDifference, 1, "is measurably louder overall. Enable level match before judging the difference by ear.");
    }

    explainHigher("peak-to-loudness ratio", finiteDifference(second.plr, first.plr), 1.2,
      "has the lower PLR, which can indicate a denser presentation.");
    explainHigher("loudness density", finiteDifference(first.loudnessDensity, second.loudnessDensity), 8,
      "spends more time at or above the level 1 LU below its integrated loudness.");
    explainHigher("short-term maximum", finiteDifference(first.maxShortTermLufs, second.maxShortTermLufs), 1,
      "reaches a higher maximum in a three-second loudness window.");
    const centroidDifference = finiteDifference(first.spectralCentroidHz, second.spectralCentroidHz);
    if ((first.measurementVersion ?? 1) !== (second.measurementVersion ?? 1)) {
      explanations.push({ metric: "tone measurements", track: "different methods",
        text: "The saved tone measurements use a different method. Reload the reference audio to compare tone with the current method." });
    } else if (centroidDifference !== null && Math.max(first.spectralCentroidHz, second.spectralCentroidHz) > 0) {
      explainHigher("spectral centre", 100 * centroidDifference / Math.max(first.spectralCentroidHz, second.spectralCentroidHz), 15,
        "has a higher spectral centre, which can be heard as increased brightness.");
    }
    explainHigher("stereo side energy", finiteDifference(first.sidePercent, second.sidePercent), 7,
      "has more side energy and may feel wider.");
    if (first.lraStable && second.lraStable) {
      explainHigher("loudness range", finiteDifference(second.loudnessRange, first.loudnessRange), 2,
        "has a narrower range of short-term loudness across the recording.");
    }
    const firstCorrelation = first.correlation ?? 1;
    const secondCorrelation = second.correlation ?? 1;
    if (firstCorrelation < 0 && secondCorrelation < 0) {
      explanations.push({ metric: "phase relationship", track: "both",
        text: "Both tracks show negative average stereo correlation. Check how each sounds folded to mono." });
    } else if (Math.min(firstCorrelation, secondCorrelation) < 0) {
      const track = firstCorrelation < 0 ? firstLabel : secondLabel;
      explanations.push({ metric: "phase relationship", track,
        text: `${track} shows negative average stereo correlation. Check how it sounds folded to mono.` });
    }
    if (explanations.length === 1 && integratedDifference !== null) {
      explanations.push({ metric: "result", track: "subtle",
        text: "No other measured difference crossed the comparison thresholds. Compare by ear and inspect the plots for local differences." });
    }
    return explanations;
  }

  function correlation(cross, left, right) {
    const denominator = Math.sqrt(left * right);
    return denominator > 0 ? clamp(cross / denominator, -1, 1) : null;
  }

  function shareOfPower(part, total) {
    return total > 0 ? clamp(100 * part / total, 0, 100) : null;
  }

  function powerRatioDb(numerator, denominator) {
    if (numerator > 0 && denominator > 0) return 10 * Math.log10(numerator / denominator);
    if (numerator > 0) return Infinity;
    return denominator > 0 ? -Infinity : null;
  }

  function finiteDifference(a, b) {
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
  }

  function finiteValue(value) {
    return Number.isFinite(value) ? value : null;
  }

  function numberInRange(value, min, max) {
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  return { BAND_DEFINITIONS, analyseMix, explainComparison, normaliseMixAnalysis };
}));
