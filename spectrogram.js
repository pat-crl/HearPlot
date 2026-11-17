/*
  MUSIC ANALYSER — OFFLINE SPECTROGRAM MEASUREMENTS

  A spectrogram turns a recording into a small grid of numbers:
  - each column represents a moment in the recording;
  - each row represents a frequency, from high at the top to low at the bottom;
  - each value says how strong that frequency is at that moment, in decibels.

  Keeping this maths outside app.js makes it possible to test the audio analysis
  without opening the full Electron interface. The returned Float32Array is also
  much smaller and faster to scan than a nested JavaScript array.
*/

(function attachSpectrogramTools(root, createTools) {
  const tools = createTools();

  // Browsers receive one global object. Node receives the same functions through
  // module.exports, which lets the generated-audio tests run from the terminal.
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserSpectrogram = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function createSpectrogramTools() {
  const DEFAULT_FFT_SIZE = 2048;
  const DEFAULT_MIN_FREQUENCY = 20;
  const DEFAULT_FRAMES_PER_SECOND = 12;
  const MIN_COLUMNS = 320;
  const MIN_ROWS = 256;
  const MAX_COLUMNS = 4096;
  const MAX_ROWS = 1024;
  const MIN_DECIBELS = -160;
  const DISPLAY_RANGE_DECIBELS = 78;

  /*
    This helper chooses enough detail for a large Retina canvas without allowing
    an unusually long recording or giant display to create an unbounded matrix.
    targetWidth and targetHeight are physical pixels, after devicePixelRatio has
    already been applied by the interface.
  */
  function chooseSpectrogramSettings({
    duration = 0,
    targetWidth = 0,
    targetHeight = 0,
    framesPerSecond = DEFAULT_FRAMES_PER_SECOND,
    minColumns = MIN_COLUMNS,
    minRows = MIN_ROWS,
    maxColumns = MAX_COLUMNS,
    maxRows = MAX_ROWS,
  } = {}) {
    const safeDuration = nonNegativeNumber(duration);
    const safeTargetWidth = nonNegativeNumber(targetWidth);
    const safeTargetHeight = nonNegativeNumber(targetHeight);
    const safeFramesPerSecond = positiveNumber(framesPerSecond, DEFAULT_FRAMES_PER_SECOND);

    // Callers can ask for a smaller cap, but never exceed the practical limits
    // used by the desktop app. This keeps the largest Float32 matrix at 16 MiB.
    const columnCap = integerInRange(maxColumns, 1, MAX_COLUMNS, MAX_COLUMNS);
    const rowCap = integerInRange(maxRows, 2, MAX_ROWS, MAX_ROWS);
    const columnFloor = Math.min(columnCap, integerInRange(minColumns, 1, columnCap, Math.min(MIN_COLUMNS, columnCap)));
    const rowFloor = Math.min(rowCap, integerInRange(minRows, 2, rowCap, Math.min(MIN_ROWS, rowCap)));

    // Long tracks benefit from several measurements each second, while short
    // tracks need at least one source column for each physical display pixel.
    const durationColumns = Math.ceil(safeDuration * safeFramesPerSecond);
    const requestedColumns = Math.ceil(Math.max(columnFloor, safeTargetWidth, durationColumns));
    const requestedRows = Math.ceil(Math.max(rowFloor, safeTargetHeight));

    return {
      fftSize: DEFAULT_FFT_SIZE,
      columns: Math.min(columnCap, requestedColumns),
      rows: Math.min(rowCap, requestedRows),
    };
  }

  /*
    Analyse the first channel of an AudioBuffer-like object. The options are
    configurable so the app can make a quick preview or a detailed cached image.
    Values are stored column-by-column, matching app.js's existing canvas loop:

      values[column * rows + row]
  */
  function analyseSpectrogram(audioBuffer, options = {}) {
    const source = readAudioSource(audioBuffer);
    const duration = source.samples.length / source.sampleRate;
    const suggested = chooseSpectrogramSettings({
      duration,
      targetWidth: options.targetWidth,
      targetHeight: options.targetHeight,
      framesPerSecond: options.framesPerSecond,
      minColumns: options.minColumns,
      minRows: options.minRows,
      maxColumns: options.maxColumns,
      maxRows: options.maxRows,
    });

    const fftSize = validateFftSize(options.fftSize ?? suggested.fftSize);
    const columns = integerInRange(options.columns, 1, MAX_COLUMNS, suggested.columns);
    const rows = integerInRange(options.rows, 2, MAX_ROWS, suggested.rows);
    const nyquist = source.sampleRate / 2;
    const minFrequency = Math.min(
      nyquist,
      Math.max(Number.EPSILON, positiveNumber(options.minFrequency, DEFAULT_MIN_FREQUENCY)),
    );

    const values = new Float32Array(columns * rows);
    const real = new Float32Array(fftSize);
    const imaginary = new Float32Array(fftSize);
    const magnitudes = new Float32Array(fftSize / 2);
    const window = createHannWindow(fftSize);
    const halfWindow = Math.floor(fftSize / 2);
    let peakDb = MIN_DECIBELS;

    for (let column = 0; column < columns; column += 1) {
      // The first and final windows are allowed to extend past the recording.
      // Missing samples are treated as silence, keeping every column centred on
      // its correct time rather than pushing the visible recording sideways.
      const centre = Math.floor((column / Math.max(1, columns - 1)) * Math.max(0, source.samples.length - 1));
      const windowStart = centre - halfWindow;

      for (let index = 0; index < fftSize; index += 1) {
        const sourceIndex = windowStart + index;
        const sample = sourceIndex >= 0 && sourceIndex < source.samples.length
          ? source.samples[sourceIndex]
          : 0;
        real[index] = sample * window[index];
        imaginary[index] = 0;
      }

      fft(real, imaginary);

      for (let bin = 0; bin < magnitudes.length; bin += 1) {
        magnitudes[bin] = Math.hypot(real[bin], imaginary[bin]);
      }

      // Logarithmic rows devote much more screen space to bass and mid-range
      // frequencies, which is more useful for music than a linear frequency axis.
      for (let row = 0; row < rows; row += 1) {
        const frequency = frequencyForRow(row, rows, minFrequency, nyquist);
        const exactBin = (frequency / nyquist) * (magnitudes.length - 1);
        const lowerBin = Math.floor(exactBin);
        const upperBin = Math.min(lowerBin + 1, magnitudes.length - 1);
        const blend = exactBin - lowerBin;
        const magnitude = magnitudes[lowerBin] * (1 - blend) + magnitudes[upperBin] * blend;
        const decibels = Math.max(MIN_DECIBELS, 20 * Math.log10(magnitude / fftSize + 1e-12));

        values[column * rows + row] = decibels;
        if (decibels > peakDb) peakDb = decibels;
      }
    }

    // A completely silent recording has no dynamic range. Giving it the same
    // floor and peak lets the colour renderer safely draw it as the darkest tone.
    const floorDb = peakDb <= MIN_DECIBELS
      ? MIN_DECIBELS
      : Math.max(MIN_DECIBELS, peakDb - DISPLAY_RANGE_DECIBELS);

    return {
      values,
      columns,
      rows,
      fftSize,
      peakDb,
      floorDb,
      nyquist,
      minFrequency,
    };
  }

  // A Hann window gently fades both ends of each short audio slice. Without it,
  // the cut edges would create false frequency streaks in the spectrogram.
  function createHannWindow(length) {
    const window = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
    }
    return window;
  }

  /*
    This is an in-place radix-2 Fast Fourier Transform. It changes time-domain
    samples in `real` into frequency-bin values. Keeping the arrays in place avoids
    creating thousands of temporary objects while a long recording is analysed.
  */
  function fft(real, imaginary) {
    const length = real.length;
    let reversed = 0;

    for (let index = 1; index < length; index += 1) {
      let bit = length >> 1;
      while (reversed & bit) {
        reversed ^= bit;
        bit >>= 1;
      }
      reversed ^= bit;

      if (index < reversed) {
        [real[index], real[reversed]] = [real[reversed], real[index]];
        [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
      }
    }

    for (let size = 2; size <= length; size *= 2) {
      const angle = (-2 * Math.PI) / size;
      const cosineStep = Math.cos(angle);
      const sineStep = Math.sin(angle);

      for (let offset = 0; offset < length; offset += size) {
        let cosine = 1;
        let sine = 0;

        for (let index = 0; index < size / 2; index += 1) {
          const even = offset + index;
          const odd = even + size / 2;
          const oddReal = real[odd] * cosine - imaginary[odd] * sine;
          const oddImaginary = real[odd] * sine + imaginary[odd] * cosine;
          real[odd] = real[even] - oddReal;
          imaginary[odd] = imaginary[even] - oddImaginary;
          real[even] += oddReal;
          imaginary[even] += oddImaginary;

          const nextCosine = cosine * cosineStep - sine * sineStep;
          sine = sine * cosineStep + cosine * sineStep;
          cosine = nextCosine;
        }
      }
    }
  }

  function frequencyForRow(row, rows, minFrequency, nyquist) {
    const ratio = rows <= 1 ? 0 : row / (rows - 1);
    return nyquist * Math.pow(minFrequency / nyquist, Math.max(0, Math.min(1, ratio)));
  }

  function rowForFrequency(frequency, rows, minFrequency, nyquist) {
    const safeFrequency = Math.max(minFrequency, Math.min(nyquist, Number(frequency) || minFrequency));
    const ratio = Math.log(safeFrequency / nyquist) / Math.log(minFrequency / nyquist);
    return ratio * (rows - 1);
  }

  function readAudioSource(audioBuffer) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== "function") {
      throw new TypeError("analyseSpectrogram needs an AudioBuffer-like object");
    }

    const sampleRate = Number(audioBuffer.sampleRate);
    const samples = audioBuffer.getChannelData(0);
    if (!(sampleRate > 0) || !samples || typeof samples.length !== "number" || samples.length < 1) {
      throw new TypeError("The audio buffer needs a sample rate and at least one sample");
    }

    return { sampleRate, samples };
  }

  function validateFftSize(value) {
    const fftSize = Number(value);
    const isPowerOfTwo = Number.isInteger(fftSize) && fftSize >= 32 && fftSize <= 32768 && (fftSize & (fftSize - 1)) === 0;
    if (!isPowerOfTwo) throw new RangeError("fftSize must be a power of two from 32 to 32768");
    return fftSize;
  }

  function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function integerInRange(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
  }

  return {
    analyseSpectrogram,
    chooseSpectrogramSettings,
    frequencyForRow,
    rowForFrequency,
    DEFAULT_FFT_SIZE,
    MAX_COLUMNS,
    MAX_ROWS,
    MIN_DECIBELS,
  };
}));
