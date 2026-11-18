/* Run heavy analysis away from the renderer. Each job owns its worker and PCM
   copies, so cancellation releases them without waiting for a DSP loop. */
(() => {
  const workerUrl = new URL("analysis-worker.js", document.currentScript.src);
  const jobKinds = new Set(["recording", "spectrum", "tempo", "mix"]);
  const framesPerCopy = 512 * 1024;
  const activeWorkers = new Set();

  async function copyAudio(audio, kind, signal) {
    const { length, sampleRate, numberOfChannels } = audio;
    const channelCount = kind === "spectrum" ? 1 : numberOfChannels;
    if (
      !Number.isSafeInteger(length) || length < 1 ||
      !Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32
    ) {
      throw new TypeError("The recording has no usable audio.");
    }
    window.MusicAnalyserDecode.checkPcmSize(length, channelCount);

    const channels = [];
    let copiedFrames = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      signal?.throwIfAborted();
      const samples = new Float32Array(length);
      for (let start = 0; start < length; start += framesPerCopy) {
        const chunk = samples.subarray(start, start + framesPerCopy);
        audio.copyFromChannel(chunk, channel, start);
        copiedFrames += chunk.length;
        if (copiedFrames >= framesPerCopy * 4) {
          // Give the renderer a chance to paint and handle a newer file request.
          copiedFrames = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
          signal?.throwIfAborted();
        }
      }
      channels.push(samples);
    }

    return { sampleRate, channels };
  }

  async function run(kind, audio, { signal, onProgress, settings } = {}) {
    if (!jobKinds.has(kind)) throw new TypeError("Unknown audio analysis job.");
    signal?.throwIfAborted();
    const payload = await copyAudio(audio, kind, signal);
    signal?.throwIfAborted();

    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, { name: `music-analysis-${kind}` });
      // Hold a strong reference while a job is pending. A large decode can
      // trigger garbage collection while its worker is between messages.
      activeWorkers.add(worker);
      const deadline = setTimeout(() => {
        complete(reject, new Error("Analysis timed out. Try a shorter excerpt."));
      }, 90000);
      function complete(settle, value) {
        if (!activeWorkers.delete(worker)) return;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        settle(value);
      }
      function abort() {
        complete(reject, signal.reason);
      }
      signal?.addEventListener("abort", abort, { once: true });

      worker.onmessage = ({ data }) => {
        if (!activeWorkers.has(worker)) return;
        if (data.type === "progress") {
          onProgress?.(data.fraction, data.stage);
        } else if (data.type === "result") {
          complete(resolve, data.result);
        } else {
          complete(reject, new Error(data.message || "The analysis could not finish."));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        complete(reject, new Error(event.message || "The analysis worker could not start."));
      };
      worker.onmessageerror = () => complete(reject, new Error("The analysis worker could not return its result."));
      try {
        worker.postMessage({ kind, settings, ...payload }, payload.channels.map((channel) => channel.buffer));
      } catch (error) {
        complete(reject, error);
      }
    });
  }

  window.MusicAnalyserAnalysis = Object.freeze({ run });
})();
