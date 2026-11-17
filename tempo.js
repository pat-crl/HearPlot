/*
  MUSIC ANALYSER — OFFLINE TEMPO AND BAR-GRID ESTIMATION

  This file turns decoded audio into a useful first attempt at a musical grid.
  It is intentionally self-contained: there is no online service, native add-on,
  or third-party runtime library hidden behind the analysis.

  The broad idea follows Daniel Ellis's dynamic-programming beat work:
  1. reduce the audio to an "onset envelope" that rises at new musical sounds;
  2. autocorrelate that envelope to find repeating beat periods;
  3. test possible beat phases so empty grid lines count against a candidate;
  4. fit a straight, constant-tempo grid through the detected onset peaks;
  5. compare every fourth beat to estimate the likely first beat of each bar.

  This is designed for constant-tempo popular and electronic music. It cannot
  make a perfectly straight DAW grid for rubato performances or tempo changes,
  and a user should always be allowed to correct BPM and Bar 1 in the interface.

  Research reference:
  https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf
*/

(function attachTempoTools(root, createTools) {
  const tools = createTools();

  // Browsers receive one global object. Node receives the same functions via
  // module.exports, which lets the generated click-track tests run without UI.
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserTempo = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function createTempoTools() {
  const DEFAULT_MIN_BPM = 70;
  const DEFAULT_MAX_BPM = 190;
  const BEATS_PER_BAR = 4;
  const TARGET_HOP_SECONDS = 0.01;
  const MINIMUM_PEAKS = 8;

  function analyseTempo(audioBuffer, options = {}) {
    const sampleRate = Number(audioBuffer && audioBuffer.sampleRate);
    const channelCount = Number(audioBuffer && audioBuffer.numberOfChannels);
    const firstChannel = safeChannel(audioBuffer, 0);
    const sampleCount = Number(audioBuffer && (audioBuffer.length || (firstChannel && firstChannel.length)));
    const minBpm = clamp(Number(options.minBpm) || DEFAULT_MIN_BPM, 40, 220);
    const maxBpm = clamp(Number(options.maxBpm) || DEFAULT_MAX_BPM, minBpm + 1, 260);

    if (!(sampleRate > 0) || !(channelCount > 0) || !(sampleCount > 0) || !firstChannel) {
      return emptyResult("invalid-audio");
    }

    const features = makeOnsetFeatures(audioBuffer, sampleRate, channelCount, sampleCount);
    const peaks = findOnsetPeaks(features.onset, features.frameTimes);

    if (peaks.length < MINIMUM_PEAKS) {
      return emptyResult("not-enough-rhythm", {
        frameCount: features.onset.length,
        onsetPeakCount: peaks.length,
      });
    }

    const firstPeakFrame = peaks[0].frame;
    const lastPeakFrame = peaks[peaks.length - 1].frame;
    const paddingFrames = Math.max(2, Math.round(1 / features.hopSeconds));
    const activeStartFrame = Math.max(0, firstPeakFrame - paddingFrames);
    const activeEndFrame = Math.min(features.onset.length - 1, lastPeakFrame + paddingFrames);

    const candidates = findTempoCandidates(
      features.onset,
      peaks,
      features.hopSeconds,
      minBpm,
      maxBpm,
      activeStartFrame,
      activeEndFrame,
    );

    if (!candidates.length) {
      return emptyResult("tempo-not-found", { onsetPeakCount: peaks.length });
    }

    const bestCandidate = candidates[0];
    const fittedGrid = fitGridToPeaks(bestCandidate, peaks, features.hopSeconds);
    const periodSeconds = fittedGrid.periodSeconds;
    const bpm = 60 / periodSeconds;
    const phaseSeconds = positiveModulo(fittedGrid.originSeconds, periodSeconds);
    const durationSeconds = sampleCount / sampleRate;
    const beats = makeBeatGrid(phaseSeconds, periodSeconds, durationSeconds);
    const downbeat = findDownbeatPhase(beats, features, peaks, periodSeconds);
    const barPlacement = chooseBarOne(beats, downbeat, peaks, periodSeconds);
    const barOneAtSeconds = barPlacement.time;

    const secondDistinct = candidates.find((candidate) => (
      Math.abs(candidate.bpm - bestCandidate.bpm) / bestCandidate.bpm > 0.035
    ));
    const tempoSeparation = secondDistinct
      ? clamp((bestCandidate.score - secondDistinct.score) / Math.max(0.08, bestCandidate.score), 0, 1)
      : 1;
    const fitTightness = clamp(1 - fittedGrid.meanResidualSeconds / Math.max(0.015, periodSeconds * 0.12), 0, 1);
    const tempoConfidence = clamp(
      0.35 * bestCandidate.correlation
        + 0.30 * bestCandidate.coverage
        + 0.20 * bestCandidate.gridHitRate
        + 0.15 * tempoSeparation,
      0,
      1,
    );
    const beatPhaseConfidence = clamp(
      0.45 * bestCandidate.coverage
        + 0.35 * fitTightness
        + 0.20 * bestCandidate.phaseSeparation,
      0,
      1,
    );
    const downbeatConfidence = downbeat.confidence;
    const overallConfidence = Math.cbrt(Math.max(
      0,
      tempoConfidence * beatPhaseConfidence * Math.max(0.05, downbeatConfidence),
    ));

    return {
      bpm: round(bpm, 3),
      barOneAtSeconds: barOneAtSeconds === null ? null : round(barOneAtSeconds, 6),
      beatsPerBar: BEATS_PER_BAR,
      beatPeriodSeconds: round(periodSeconds, 9),
      beatPhaseAtSeconds: round(phaseSeconds, 9),
      detectedBeatsSeconds: beats.map((beat) => round(beat.time, 6)),
      confidence: {
        overall: round(overallConfidence, 3),
        tempo: round(tempoConfidence, 3),
        beatPhase: round(beatPhaseConfidence, 3),
        downbeat: round(downbeatConfidence, 3),
      },
      details: {
        status: "ok",
        method: "onset-autocorrelation-grid-fit",
        constantTempoAssumed: true,
        sampleRate,
        hopSeconds: features.hopSeconds,
        onsetPeakCount: peaks.length,
        matchedBeatCount: fittedGrid.matchCount,
        meanGridResidualSeconds: round(fittedGrid.meanResidualSeconds, 6),
        detectedDownbeatPhase: barPlacement.phase,
        downbeatPhaseWasFallback: barPlacement.usedFallback,
        downbeatPhaseScores: downbeat.phaseScores.map((score) => round(score, 4)),
        firstRhythmicOnsetSeconds: round(peaks[0].time, 6),
        tempoCandidates: candidates.slice(0, 5).map((candidate) => ({
          bpm: round(candidate.bpm, 2),
          score: round(candidate.score, 4),
          correlation: round(candidate.correlation, 4),
          coverage: round(candidate.coverage, 4),
        })),
      },
    };
  }

  /*
    Snap a rough time selection to complete musical bars.

    Arrangement mapping describes larger musical sections, so both ends belong
    on a bar start. The function also guarantees at least one complete bar if
    a short freehand selection lands on the same marker at both ends.
  */
  function snapRangeToBarStarts(
    startSeconds,
    endSeconds,
    barOneAtSeconds,
    barDurationSeconds,
    trackDurationSeconds,
  ) {
    if (!Number.isFinite(startSeconds)
      || !Number.isFinite(endSeconds)
      || endSeconds <= startSeconds
      || !Number.isFinite(barOneAtSeconds)
      || !(barDurationSeconds > 0)
      || !(trackDurationSeconds > 0)) {
      return null;
    }

    // Only bar starts inside the actual recording can become arrangement edges.
    const firstBarIndex = Math.ceil((0 - barOneAtSeconds) / barDurationSeconds - 1e-9);
    const lastBarIndex = Math.floor((trackDurationSeconds - barOneAtSeconds) / barDurationSeconds + 1e-9);
    if (firstBarIndex > lastBarIndex) return null;

    const nearestBarIndex = (seconds) => {
      const rawIndex = Math.round((seconds - barOneAtSeconds) / barDurationSeconds);
      return Math.max(firstBarIndex, Math.min(lastBarIndex, rawIndex));
    };

    let startBarIndex = nearestBarIndex(startSeconds);
    let endBarIndex = nearestBarIndex(endSeconds);

    // A section should never collapse to a zero-width marker. Prefer the next
    // bar, but use the preceding complete bar near the end of a recording.
    if (endBarIndex <= startBarIndex) {
      if (startBarIndex < lastBarIndex) endBarIndex = startBarIndex + 1;
      else if (startBarIndex > firstBarIndex) startBarIndex -= 1;
      else return null;
    }

    return {
      start: barOneAtSeconds + startBarIndex * barDurationSeconds,
      end: barOneAtSeconds + endBarIndex * barDurationSeconds,
    };
  }

  /*
    Create a compact description of the audio every roughly 10 milliseconds.

    Ellis uses changes across Mel-frequency spectrogram bands. A complete FFT
    is expensive to carry in a small dependency-free file, so this version uses
    three simple filter bands instead: bass, middle, and high frequencies. The
    positive change in their log energies behaves like spectral flux while the
    whole loop still visits each audio sample only once.
  */
  function makeOnsetFeatures(audioBuffer, sampleRate, channelCount, sampleCount) {
    const frameLength = Math.max(16, Math.round(sampleRate * TARGET_HOP_SECONDS));
    const frameCount = Math.ceil(sampleCount / frameLength);
    const frameTimes = new Float64Array(frameCount);
    const bandLogs = Array.from({ length: frameCount }, () => new Float64Array(4));
    const rawOnset = new Float64Array(frameCount);
    const broadEnergy = new Float64Array(frameCount);
    const lowEnergy = new Float64Array(frameCount);

    // A one-pole low-pass filter only needs its previous output. Subtracting
    // two low-pass versions separates broad bass, middle, and high regions.
    const bassAmount = 1 - Math.exp((-2 * Math.PI * 180) / sampleRate);
    const middleAmount = 1 - Math.exp((-2 * Math.PI * 1600) / sampleRate);
    let bassState = 0;
    let middleState = 0;
    let previousSample = 0;
    let previousBandLogs = new Float64Array(4);
    const channels = [];

    // Asking an AudioBuffer for its channel data is cheap, but doing it again
    // for every individual sample is unnecessary work on a several-minute
    // song. Keep each read-only channel array here for the duration of analysis.
    for (let channel = 0; channel < channelCount; channel += 1) {
      const data = safeChannel(audioBuffer, channel);
      if (data) channels.push(data);
    }

    for (let frame = 0; frame < frameCount; frame += 1) {
      const start = frame * frameLength;
      const end = Math.min(sampleCount, start + frameLength);
      const length = Math.max(1, end - start);
      let bassPower = 0;
      let middlePower = 0;
      let highPower = 0;
      let transientPower = 0;
      let totalPower = 0;

      for (let index = start; index < end; index += 1) {
        let sample = 0;
        for (const data of channels) {
          if (data && index < data.length) sample += data[index];
        }
        sample /= Math.max(1, channels.length);

        bassState += bassAmount * (sample - bassState);
        middleState += middleAmount * (sample - middleState);
        const bass = bassState;
        const middle = middleState - bassState;
        const high = sample - middleState;
        const transient = sample - previousSample;
        previousSample = sample;

        bassPower += bass * bass;
        middlePower += middle * middle;
        highPower += high * high;
        transientPower += transient * transient;
        totalPower += sample * sample;
      }

      const powers = [
        bassPower / length,
        middlePower / length,
        highPower / length,
        transientPower / length,
      ];

      // Log compression makes a quiet but clear beat useful without allowing
      // one very loud hit to overwhelm every other part of the track.
      for (let band = 0; band < powers.length; band += 1) {
        const value = Math.log1p(powers[band] * 1000000);
        bandLogs[frame][band] = value;
        const increase = Math.max(0, value - previousBandLogs[band]);
        const weight = band === 0 ? 1.15 : band === 3 ? 0.8 : 1;
        rawOnset[frame] += increase * weight;
      }

      previousBandLogs = bandLogs[frame];
      broadEnergy[frame] = Math.log1p((totalPower / length) * 1000000);
      lowEnergy[frame] = bandLogs[frame][0];
      frameTimes[frame] = (start + length / 2) / sampleRate;
    }

    const onset = cleanAndNormalizeOnset(rawOnset);
    return {
      onset,
      bandLogs,
      broadEnergy,
      lowEnergy,
      frameTimes,
      hopSeconds: frameLength / sampleRate,
    };
  }

  function cleanAndNormalizeOnset(rawOnset) {
    const cleaned = new Float64Array(rawOnset.length);
    const localRadius = 50; // About half a second on either side at 100 fps.
    const prefix = new Float64Array(rawOnset.length + 1);

    for (let index = 0; index < rawOnset.length; index += 1) {
      prefix[index + 1] = prefix[index] + rawOnset[index];
    }

    for (let index = 0; index < rawOnset.length; index += 1) {
      const start = Math.max(0, index - localRadius);
      const end = Math.min(rawOnset.length, index + localRadius + 1);
      const localMean = (prefix[end] - prefix[start]) / Math.max(1, end - start);
      cleaned[index] = Math.max(0, rawOnset[index] - 0.45 * localMean);
    }

    // A tiny three-point blur avoids making the chosen phase depend on which
    // side of a 10 ms frame boundary a drum transient happens to land.
    const smoothed = new Float64Array(cleaned.length);
    for (let index = 0; index < cleaned.length; index += 1) {
      smoothed[index] = 0.25 * (cleaned[index - 1] || 0)
        + 0.5 * cleaned[index]
        + 0.25 * (cleaned[index + 1] || 0);
    }

    const positive = Array.from(smoothed).filter((value) => value > 0).sort((a, b) => a - b);
    const scale = percentile(positive, 0.9) || positive[positive.length - 1] || 1;
    for (let index = 0; index < smoothed.length; index += 1) {
      smoothed[index] = clamp(smoothed[index] / scale, 0, 3);
    }
    return smoothed;
  }

  function findOnsetPeaks(onset, frameTimes) {
    const peaks = [];
    let maximum = 0;
    for (const value of onset) maximum = Math.max(maximum, value);
    const threshold = Math.max(0.12, maximum * 0.08);

    for (let frame = 1; frame < onset.length - 1; frame += 1) {
      if (onset[frame] < threshold) continue;
      if (onset[frame] < onset[frame - 1] || onset[frame] < onset[frame + 1]) continue;

      // Quadratic interpolation estimates where the top of the peak falls
      // between frames. It is a small step, but reduces long-track BPM drift.
      const left = onset[frame - 1];
      const centre = onset[frame];
      const right = onset[frame + 1];
      const denominator = left - 2 * centre + right;
      const offset = Math.abs(denominator) > 1e-12
        ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5)
        : 0;
      const hopSeconds = frameTimes.length > 1 ? frameTimes[1] - frameTimes[0] : TARGET_HOP_SECONDS;
      peaks.push({
        frame: frame + offset,
        time: frameTimes[frame] + offset * hopSeconds,
        strength: centre,
      });
    }
    return peaks;
  }

  function findTempoCandidates(
    onset,
    peaks,
    hopSeconds,
    minBpm,
    maxBpm,
    activeStartFrame,
    activeEndFrame,
  ) {
    const minimumLag = Math.max(2, Math.floor(60 / (maxBpm * hopSeconds)));
    const maximumLag = Math.min(
      onset.length - 2,
      Math.ceil(60 / (minBpm * hopSeconds)),
    );
    if (maximumLag <= minimumLag) return [];

    const correlations = new Float64Array(maximumLag + 2);
    const orderedPositiveOnsets = Array.from(onset).filter((value) => value > 0).sort((a, b) => a - b);
    const strongScale = percentile(orderedPositiveOnsets, 0.9) || 1;
    for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
      correlations[lag] = normalizedAutocorrelation(onset, lag, activeStartFrame, activeEndFrame);
    }

    const candidates = [];
    for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
      const left = correlations[lag - 1] || correlations[lag];
      const centre = correlations[lag];
      const right = correlations[lag + 1] || correlations[lag];
      const denominator = left - 2 * centre + right;
      const correction = Math.abs(denominator) > 1e-12
        ? clamp(0.5 * (left - right) / denominator, -0.5, 0.5)
        : 0;
      const periodFrames = lag + correction;
      const bpm = 60 / (periodFrames * hopSeconds);
      if (bpm < minBpm || bpm > maxBpm) continue;

      const grid = findBestPhase(
        onset,
        peaks,
        periodFrames,
        activeStartFrame,
        activeEndFrame,
        strongScale,
      );
      const tempoPrior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.2) ** 2);
      const score = 0.38 * centre
        + 0.22 * grid.meanGridStrength
        + 0.17 * grid.hitRate
        + 0.18 * grid.coverage
        + 0.05 * tempoPrior;

      candidates.push({
        bpm,
        periodFrames,
        correlation: centre,
        score,
        phaseFrames: grid.phaseFrames,
        phaseSeparation: grid.phaseSeparation,
        coverage: grid.coverage,
        gridHitRate: grid.hitRate,
      });
    }

    // Adjacent autocorrelation bins describe almost the same BPM. Keep the
    // better one so the alternatives list is musically meaningful.
    candidates.sort((a, b) => b.score - a.score);
    const distinct = [];
    for (const candidate of candidates) {
      if (distinct.some((kept) => Math.abs(kept.bpm - candidate.bpm) / kept.bpm < 0.018)) continue;
      distinct.push(candidate);
    }
    return distinct.sort((a, b) => b.score - a.score);
  }

  function normalizedAutocorrelation(onset, lag, startFrame, endFrame) {
    let product = 0;
    let currentPower = 0;
    let delayedPower = 0;
    const start = Math.max(startFrame + lag, lag);

    for (let frame = start; frame <= endFrame; frame += 1) {
      const current = onset[frame];
      const delayed = onset[frame - lag];
      product += current * delayed;
      currentPower += current * current;
      delayedPower += delayed * delayed;
    }
    return clamp(product / Math.sqrt(Math.max(1e-12, currentPower * delayedPower)), 0, 1);
  }

  function findBestPhase(onset, peaks, periodFrames, startFrame, endFrame, strongScale) {
    const tolerance = Math.max(1, Math.min(5, Math.round(periodFrames * 0.06)));
    const phaseStep = 0.5;
    const phases = [];

    for (let phase = 0; phase < periodFrames; phase += phaseStep) {
      let total = 0;
      let hitCount = 0;
      let gridCount = 0;

      let gridFrame = phase + Math.ceil((startFrame - phase) / periodFrames) * periodFrames;
      while (gridFrame <= endFrame) {
        const strength = strongestNear(onset, gridFrame, tolerance);
        total += strength;
        if (strength >= 0.2 * strongScale) hitCount += 1;
        gridCount += 1;
        gridFrame += periodFrames;
      }

      let coveredStrength = 0;
      let allPeakStrength = 0;
      for (const peak of peaks) {
        if (peak.frame < startFrame || peak.frame > endFrame) continue;
        allPeakStrength += peak.strength;
        const nearestGrid = phase + Math.round((peak.frame - phase) / periodFrames) * periodFrames;
        if (Math.abs(peak.frame - nearestGrid) <= tolerance) coveredStrength += peak.strength;
      }

      const meanGridStrength = clamp((total / Math.max(1, gridCount)) / strongScale, 0, 1);
      const hitRate = hitCount / Math.max(1, gridCount);
      const coverage = coveredStrength / Math.max(1e-12, allPeakStrength);
      const score = 0.45 * meanGridStrength + 0.25 * hitRate + 0.30 * coverage;
      phases.push({ phaseFrames: phase, score, meanGridStrength, hitRate, coverage });
    }

    phases.sort((a, b) => b.score - a.score);
    const best = phases[0];
    const differentPhase = phases.find((phase) => circularFrameDistance(
      phase.phaseFrames,
      best.phaseFrames,
      periodFrames,
    ) > Math.max(1.5, periodFrames * 0.08));
    const phaseSeparation = differentPhase
      ? clamp((best.score - differentPhase.score) / Math.max(0.05, best.score), 0, 1)
      : 1;
    return { ...best, phaseSeparation };
  }

  function fitGridToPeaks(candidate, peaks, hopSeconds) {
    let periodSeconds = candidate.periodFrames * hopSeconds;
    let originSeconds = candidate.phaseFrames * hopSeconds + hopSeconds / 2;
    let matches = [];

    // Two rounds are enough: the first removes 10 ms frame quantisation, and
    // the second rematches peaks to the slightly improved straight grid.
    for (let pass = 0; pass < 2; pass += 1) {
      matches = matchPeaksToGrid(peaks, originSeconds, periodSeconds);
      if (matches.length < 6) break;
      const fit = weightedLineFit(matches);
      if (!(fit.slope > 0)) break;
      periodSeconds = fit.slope;
      originSeconds = fit.intercept;
    }

    matches = matchPeaksToGrid(peaks, originSeconds, periodSeconds);
    let weightedResidual = 0;
    let totalWeight = 0;
    for (const match of matches) {
      const expected = originSeconds + match.beatNumber * periodSeconds;
      weightedResidual += match.weight * Math.abs(match.time - expected);
      totalWeight += match.weight;
    }

    return {
      periodSeconds,
      originSeconds,
      matchCount: matches.length,
      meanResidualSeconds: weightedResidual / Math.max(1e-12, totalWeight),
    };
  }

  function matchPeaksToGrid(peaks, originSeconds, periodSeconds) {
    const tolerance = Math.min(0.08, periodSeconds * 0.16);
    const matches = [];
    const firstBeat = Math.floor((peaks[0].time - originSeconds) / periodSeconds) - 1;
    const lastBeat = Math.ceil((peaks[peaks.length - 1].time - originSeconds) / periodSeconds) + 1;

    for (let beatNumber = firstBeat; beatNumber <= lastBeat; beatNumber += 1) {
      const expected = originSeconds + beatNumber * periodSeconds;
      let bestPeak = null;
      let bestDistance = Infinity;
      for (const peak of peaks) {
        const distance = Math.abs(peak.time - expected);
        if (distance > tolerance || distance >= bestDistance) continue;
        bestPeak = peak;
        bestDistance = distance;
      }
      if (bestPeak) {
        matches.push({
          beatNumber,
          time: bestPeak.time,
          weight: Math.max(0.1, Math.sqrt(bestPeak.strength)),
        });
      }
    }
    return matches;
  }

  function weightedLineFit(points) {
    let totalWeight = 0;
    let meanX = 0;
    let meanY = 0;
    for (const point of points) {
      totalWeight += point.weight;
      meanX += point.weight * point.beatNumber;
      meanY += point.weight * point.time;
    }
    meanX /= Math.max(1e-12, totalWeight);
    meanY /= Math.max(1e-12, totalWeight);

    let covariance = 0;
    let variance = 0;
    for (const point of points) {
      const x = point.beatNumber - meanX;
      covariance += point.weight * x * (point.time - meanY);
      variance += point.weight * x * x;
    }
    const slope = covariance / Math.max(1e-12, variance);
    return { slope, intercept: meanY - slope * meanX };
  }

  function makeBeatGrid(phaseSeconds, periodSeconds, durationSeconds) {
    const beats = [];
    let gridIndex = 0;
    for (let time = phaseSeconds; time <= durationSeconds + periodSeconds * 0.1; time += periodSeconds) {
      beats.push({ time, gridIndex });
      gridIndex += 1;
    }
    return beats;
  }

  /*
    BPM only tells us the distance between vertical lines. To label bars, we
    still need to decide which one of each four beats sounds like "one".

    We compare three clues at every beat: onset accent, bass/broadband accent,
    and change from the preceding beat's four-band energy shape. The spectral
    change clue is a lightweight version of the Davies–Plumbley downbeat idea.
  */
  function findDownbeatPhase(beats, features, peaks, periodSeconds) {
    const accents = [];
    const toleranceFrames = Math.max(1, Math.round((periodSeconds * 0.08) / features.hopSeconds));
    const firstActive = peaks[0].time - periodSeconds * 0.2;
    const lastActive = peaks[peaks.length - 1].time + periodSeconds * 0.2;

    for (const beat of beats) {
      if (beat.time < firstActive || beat.time > lastActive) continue;
      const frame = timeToFrame(beat.time, features.frameTimes);
      const onsetAccent = strongestNear(features.onset, frame, toleranceFrames);
      const energyAccent = strongestNear(features.broadEnergy, frame, toleranceFrames);
      const lowAccent = strongestNear(features.lowEnergy, frame, toleranceFrames);
      const vector = beatBandVector(features, beat.time, periodSeconds);
      accents.push({ ...beat, onsetAccent, energyAccent, lowAccent, vector, spectralChange: 0 });
    }

    for (let index = 1; index < accents.length; index += 1) {
      accents[index].spectralChange = symmetricSpectralDifference(
        accents[index - 1].vector,
        accents[index].vector,
      );
    }

    normalizeProperty(accents, "onsetAccent");
    normalizeProperty(accents, "energyAccent");
    normalizeProperty(accents, "lowAccent");
    normalizeProperty(accents, "spectralChange");

    const phaseScores = new Array(BEATS_PER_BAR).fill(0);
    const phaseCounts = new Array(BEATS_PER_BAR).fill(0);
    for (const accent of accents) {
      const phase = positiveModulo(accent.gridIndex, BEATS_PER_BAR);
      const score = 0.48 * accent.onsetAccent
        + 0.24 * accent.energyAccent
        + 0.13 * accent.lowAccent
        + 0.15 * accent.spectralChange;
      phaseScores[phase] += score;
      phaseCounts[phase] += 1;
    }
    for (let phase = 0; phase < BEATS_PER_BAR; phase += 1) {
      phaseScores[phase] /= Math.max(1, phaseCounts[phase]);
    }

    let phase = 0;
    for (let index = 1; index < phaseScores.length; index += 1) {
      if (phaseScores[index] > phaseScores[phase]) phase = index;
    }
    const orderedScores = phaseScores.slice().sort((a, b) => b - a);
    const margin = (orderedScores[0] - (orderedScores[1] || 0)) / Math.max(0.05, orderedScores[0]);
    const observedBars = accents.length / BEATS_PER_BAR;
    const confidence = clamp(margin * Math.min(1, observedBars / 6), 0, 1);
    return { phase, phaseScores, confidence };
  }

  function beatBandVector(features, beatTime, periodSeconds) {
    const vector = new Float64Array(4);
    const start = timeToFrame(beatTime - periodSeconds * 0.08, features.frameTimes);
    const end = timeToFrame(beatTime + periodSeconds * 0.42, features.frameTimes);
    let count = 0;
    for (let frame = Math.max(0, start); frame <= Math.min(features.bandLogs.length - 1, end); frame += 1) {
      for (let band = 0; band < vector.length; band += 1) vector[band] += features.bandLogs[frame][band];
      count += 1;
    }
    for (let band = 0; band < vector.length; band += 1) vector[band] /= Math.max(1, count);
    return vector;
  }

  function symmetricSpectralDifference(left, right) {
    const leftDistribution = softmaxDistribution(left);
    const rightDistribution = softmaxDistribution(right);
    let difference = 0;
    for (let index = 0; index < leftDistribution.length; index += 1) {
      const middle = (leftDistribution[index] + rightDistribution[index]) / 2;
      difference += 0.5 * leftDistribution[index] * Math.log(leftDistribution[index] / middle);
      difference += 0.5 * rightDistribution[index] * Math.log(rightDistribution[index] / middle);
    }
    return difference;
  }

  function softmaxDistribution(values) {
    let maximum = -Infinity;
    for (const value of values) maximum = Math.max(maximum, value);
    const result = new Float64Array(values.length);
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      result[index] = Math.exp(values[index] - maximum) + 1e-9;
      total += result[index];
    }
    for (let index = 0; index < result.length; index += 1) result[index] /= total;
    return result;
  }

  function chooseBarOne(beats, downbeat, peaks, periodSeconds) {
    if (!beats.length || !peaks.length) return { time: null, phase: 0, usedFallback: true };
    const firstActive = peaks[0].time - periodSeconds * 0.18;

    // If all four beats sound alike there is no honest acoustic basis for
    // calling one of them Bar 1. In that case use the first rhythmic beat as a
    // friendly default, keep downbeat confidence low, and let the UI say that
    // the bar origin needs checking.
    let downbeatPhase = downbeat.phase;
    let usedFallback = downbeat.confidence < 0.08;
    if (usedFallback) {
      const firstActiveBeat = beats.find((beat) => beat.time >= firstActive);
      if (firstActiveBeat) downbeatPhase = positiveModulo(firstActiveBeat.gridIndex, BEATS_PER_BAR);
    }

    for (const beat of beats) {
      if (beat.time < firstActive) continue;
      if (positiveModulo(beat.gridIndex, BEATS_PER_BAR) === downbeatPhase) {
        return { time: beat.time, phase: downbeatPhase, usedFallback };
      }
    }
    usedFallback = true;
    return { time: null, phase: downbeatPhase, usedFallback };
  }

  function normalizeProperty(items, property) {
    if (!items.length) return;
    const ordered = items.map((item) => item[property]).sort((a, b) => a - b);
    const low = percentile(ordered, 0.1);
    const high = percentile(ordered, 0.9);
    const range = Math.max(1e-12, high - low);
    for (const item of items) item[property] = clamp((item[property] - low) / range, 0, 1);
  }

  function strongestNear(values, centre, radius) {
    let strongest = 0;
    const roundedCentre = Math.round(centre);
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = roundedCentre + offset;
      if (index >= 0 && index < values.length) strongest = Math.max(strongest, values[index]);
    }
    return strongest;
  }

  function timeToFrame(time, frameTimes) {
    if (!frameTimes.length) return 0;
    const hop = frameTimes.length > 1 ? frameTimes[1] - frameTimes[0] : TARGET_HOP_SECONDS;
    return Math.round((time - frameTimes[0]) / hop);
  }

  function circularFrameDistance(left, right, period) {
    const direct = Math.abs(left - right);
    return Math.min(direct, period - direct);
  }

  function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function safeChannel(audioBuffer, channel) {
    try {
      return audioBuffer && typeof audioBuffer.getChannelData === "function"
        ? audioBuffer.getChannelData(channel)
        : null;
    } catch (_error) {
      return null;
    }
  }

  function percentile(orderedValues, fraction) {
    if (!orderedValues.length) return 0;
    const position = clamp(fraction, 0, 1) * (orderedValues.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const amount = position - lower;
    return orderedValues[lower] * (1 - amount) + orderedValues[upper] * amount;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function round(value, places) {
    const multiplier = 10 ** places;
    return Math.round(value * multiplier) / multiplier;
  }

  function emptyResult(status, extraDetails = {}) {
    return {
      bpm: null,
      barOneAtSeconds: null,
      beatsPerBar: BEATS_PER_BAR,
      beatPeriodSeconds: null,
      beatPhaseAtSeconds: null,
      detectedBeatsSeconds: [],
      confidence: { overall: 0, tempo: 0, beatPhase: 0, downbeat: 0 },
      details: {
        status,
        method: "onset-autocorrelation-grid-fit",
        constantTempoAssumed: true,
        ...extraDetails,
      },
    };
  }

  return {
    analyseTempo,
    snapRangeToBarStarts,
    // A spelling alias helps code that uses American English, while the app's
    // own interface and primary function keep the project's British English.
    analyzeTempo: analyseTempo,
  };
}));
