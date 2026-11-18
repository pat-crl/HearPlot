/* This worker receives only decoded PCM and analysis settings. File access,
   playback, project editing and persistence stay with the application. */
"use strict";

self.onmessage = ({ data: { kind, sampleRate, channels, settings } }) => {
  try {
    // Some floating-point WAV decoders can return non-finite sample values.
    // Reject these before they enter measurement or display calculations.
    for (const channel of channels) {
      for (let i = 0; i < channel.length; i += 1) {
        if (!Number.isFinite(channel[i])) throw new Error("The recording contains invalid audio samples.");
      }
    }
    const audio = {
      sampleRate,
      length: channels[0].length,
      duration: channels[0].length / sampleRate,
      numberOfChannels: channels.length,
      getChannelData: (index) => channels[index],
    };
    const report = (fraction, stage) => self.postMessage({ type: "progress", fraction, stage });

    if (kind === "mix") {
      importScripts("spectrogram.js", "loudness.js", "mix-analysis.js");
      const result = self.MusicAnalyserMixAnalysis.analyseMix(audio, { onProgress: report });
      self.postMessage({ type: "result", result });
      return;
    }

    if (kind === "tempo") {
      importScripts("tempo.js");
      const result = self.MusicAnalyserTempo.analyseTempo(audio);
      self.postMessage({ type: "result", result });
      return;
    }

    if (kind !== "recording" && kind !== "spectrum") throw new Error("Unknown audio analysis job.");

    importScripts("spectrogram.js", "analysis-core.js");
    const { colourSpectrogram, waveformEnvelope } = self.MusicAnalyserAnalysisCore;
    const { analyseSpectrogram } = self.MusicAnalyserSpectrogram;
    report(0.1, "spectrum");
    const spectrum = colourSpectrogram(analyseSpectrogram(audio, settings));

    if (kind === "spectrum") {
      self.postMessage({ type: "result", result: spectrum }, [spectrum.rgba.buffer]);
      return;
    }

    importScripts("tempo.js", "loudness.js");
    report(0.45, "tempo");
    const tempo = self.MusicAnalyserTempo.analyseTempo(audio);
    report(0.75, "loudness");
    const loudness = self.MusicAnalyserLoudness.analyseLoudness(audio);
    const waveform = waveformEnvelope(channels[0]);
    self.postMessage({ type: "result", result: { spectrum, tempo, loudness, waveform } }, [spectrum.rgba.buffer, waveform.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "The analysis could not finish." });
  }
};
