// Pure image preparation for the analysis worker.
(function attach(root, create) {
  const tools = create();
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserAnalysisCore = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function create() {
  const WAVEFORM_BUCKETS = 8192;
  const PALETTE = [
    [7, 16, 34],
    [20, 49, 118],
    [35, 112, 178],
    [55, 177, 198],
    [111, 214, 188],
    [246, 201, 105],
    [255, 246, 215],
  ];
  const COLOUR_STEPS = 2048;
  const spectrumColours = new Uint8ClampedArray(COLOUR_STEPS * 4);

  for (let step = 0; step < COLOUR_STEPS; step += 1) {
    const energy = (step / (COLOUR_STEPS - 1)) ** 1.15;
    const position = energy * (PALETTE.length - 1);
    const lowerIndex = Math.floor(position);
    const lower = PALETTE[lowerIndex];
    const upper = PALETTE[Math.min(lowerIndex + 1, PALETTE.length - 1)];
    for (let channel = 0; channel < 3; channel += 1) {
      spectrumColours[step * 4 + channel] = Math.round(lower[channel] + (upper[channel] - lower[channel]) * (position - lowerIndex));
    }
    spectrumColours[step * 4 + 3] = 255;
  }

  function waveformEnvelope(samples) {
    const buckets = Math.min(samples.length, WAVEFORM_BUCKETS);
    const peaks = new Float32Array(buckets * 2);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = Math.floor(bucket * samples.length / buckets);
      const end = Math.floor((bucket + 1) * samples.length / buckets);
      let minimum = 0;
      let maximum = 0;
      for (let i = start; i < end; i += 1) {
        const sample = samples[i];
        if (sample < minimum) minimum = sample;
        if (sample > maximum) maximum = sample;
      }
      peaks[bucket * 2] = minimum;
      peaks[bucket * 2 + 1] = maximum;
    }
    return peaks;
  }

  function colourSpectrogram({ values, columns, rows, peakDb, floorDb, ...settings }) {
    const rgba = new Uint8ClampedArray(rows * columns * 4);
    const scale = (COLOUR_STEPS - 1) / Math.max(1, peakDb - floorDb);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const energy = (values[column * rows + row] - floorDb) * scale;
        const step = Math.round(Math.max(0, Math.min(COLOUR_STEPS - 1, energy))) || 0;
        const colour = step * 4;
        const pixel = (row * columns + column) * 4;
        rgba[pixel] = spectrumColours[colour];
        rgba[pixel + 1] = spectrumColours[colour + 1];
        rgba[pixel + 2] = spectrumColours[colour + 2];
        rgba[pixel + 3] = 255;
      }
    }
    return { rgba, columns, rows, peakDb, floorDb, ...settings };
  }

  return { waveformEnvelope, colourSpectrogram };
}));
