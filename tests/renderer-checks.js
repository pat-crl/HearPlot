(async () => {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const test = async (name, action) => {
    try { await action(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  };
  const frame = () => new Promise(requestAnimationFrame);
  const session = (annotations = []) => ({ format: "music-analyser-session", version: 3, track: { duration: 12 }, annotations });
  const note = { id: "first", start: 1, end: 3, source: "spectrogram", minFrequency: 200, maxFrequency: 2000, category: "timbre", note: "A sustained layer" };

  await test("fresh preferences use readable grid opacity and supported playback rate", () => {
    check(state.barMarkerOpacity === 1, "Fresh bar opacity must be 100%");
    check([0.5, 0.75, 1, 1.25].includes(state.playbackRate), "Invalid playback rate");
  });
  await test("a generated recording loads, renders, and parses numbered file names", async () => {
    check(await loadAudioFile(createDemoAudioFile(), { path: "/local/recording.wav" }), "Load failed");
    await frame();
    check(state.audioBuffer.duration === 12 && !ui.analysisState.hidden, "No populated workspace");
    check(state.audioBuffer.sampleRate === 44100, "Decoded WAV sample rate changed with the playback device");
    check(ui.spectrogramCanvas.width > 0 && state.spectrogramRaster, "No spectrogram");
    check(waveformEnvelopes.get(state.audioBuffer)?.length > 0, "No prepared waveform envelope");
    check(!state.spectrumData.rgba, "The renderer retained the raster transfer buffer");
    const parsed = parseTrackIdentity("01 - Bounty Hill - Drastic Indifference");
    check(parsed.artist === "Bounty Hill" && parsed.title === "Drastic Indifference", "Track number interpreted as artist");
  });
  await test("worker results preserve source samples and an active job can be cancelled", async () => {
    const audio = state.audioBuffer;
    const before = audio.getChannelData(0).slice(100, 150);
    const spectrum = await runAnalysis("spectrum", audio, { settings: { columns: 8, rows: 16 } });
    check(spectrum.rgba.length === 8 * 16 * 4, "Worker did not return transferable display pixels");
    check(before.every((value, i) => value === audio.getChannelData(0)[100 + i]), "Worker detached or changed original samples");
    const controller = new AbortController();
    try {
      await runAnalysis("recording", audio, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      });
      throw new Error("The cancelled worker returned a recording");
    } catch (error) {
      check(error.name === "AbortError", `Wrong cancellation result: ${error.message}`);
    }
  });
  await test("analysis rejects non-finite PCM instead of reporting misleading measurements", async () => {
    const audio = new AudioBuffer({ length: 128, sampleRate: 48000 });
    audio.getChannelData(0)[0] = Infinity;
    try {
      await runAnalysis("spectrum", audio, { settings: { columns: 2, rows: 4 } });
      throw new Error("The worker accepted invalid audio samples");
    } catch (error) {
      check(error.message === "The recording contains invalid audio samples.", error.message);
    }
  });
  await test("keyboard range inputs validate time and frequency before selecting", async () => {
    regionEntry.open = true;
    await frame();
    regionStart.value = "2";
    regionEnd.value = "4";
    regionLow.value = "600";
    regionHigh.value = "400";
    document.querySelector("#regionForm").requestSubmit();
    check(!regionError.hidden && regionEntry.open, "Invalid frequency was accepted");
    regionHigh.value = "2400";
    document.querySelector("#regionForm").requestSubmit();
    check(state.selection?.minFrequency === 600 && state.selection?.end === 4 && !regionEntry.open, "Valid range was not installed");
    check(document.activeElement === ui.noteInput, "Focus did not move to the observation");
  });
  await test("MixLab opens on demand and compares, saves and restores a reference snapshot", async () => {
    const panel = document.getElementById("mixLabPanel");
    const results = document.getElementById("mixResults");
    const input = document.getElementById("mixReferenceInput");
    const playB = document.getElementById("mixPlayB");
    const waitUntil = async (condition) => {
      const until = performance.now() + 8000;
      while (!condition() && performance.now() < until) await frame();
      check(condition(), "MixLab did not finish");
    };
    check(!panel.open && results.hidden, "MixLab did work before it opened");
    panel.open = true;
    await waitUntil(() => !results.hidden && !document.getElementById("mixPlayA").disabled);
    const transfer = new DataTransfer();
    transfer.items.add(createDemoAudioFile());
    input.files = transfer.files;
    input.dispatchEvent(new Event("change"));
    await waitUntil(() => !playB.disabled);
    const portable = JSON.parse(JSON.stringify(buildSessionData()));
    check(portable.mixLab?.reference?.analysis?.bands.length === 7, "Comparison measurements missing from export");
    check(portable.mixLab.reference.analysis.shortTerm.length > 0, "Timeline missing from export");
    document.getElementById("mixRemoveReference").click();
    applySessionData(portable);
    check(playB.disabled && !document.getElementById("mixBandMeasurements").querySelector("tbody").textContent.includes("NaN"), "Restored metadata exposed unavailable audio or invalid values");
    check(mixLab.getSessionData()?.reference.name === "demonstration-study", "Reference snapshot was lost");
    panel.open = false;
    mixLab.restoreSessionData(null);
  });
  await test("malformed sessions are sanitised while valid notes remain usable", () => {
    const clean = applySessionData({ ...session([null, note, { start: -3, end: -1 }]), categories: [null, {}, "review"] });
    check(clean.skipped === 2 && state.annotations.length === 1, "Invalid entries were not isolated");
    check(state.categories.every((category) => typeof category === "string"), "Non-string category survived");
  });
  await test("portable exports omit local paths and imports preserve the selected local file", () => {
    state.filePath = "/local/recording.wav";
    state.fileIdentity = "/local/recording.wav::123";
    applySessionData({ ...session([note]), track: { duration: 12, filePath: "/sender/private/recording.wav", artist: "Sender", title: "Shared Study" } });
    check(state.filePath === "/local/recording.wav", "Sender replaced local path");
    const exported = JSON.stringify(buildSessionData());
    check(!exported.includes("/local/") && !exported.includes("/sender/"), "Private file path leaked");
  });
  await test("import resets stale editors and is undoable as one analysis operation", () => {
    state.annotations = [{ ...note, id: "old" }]; state.undoStack = []; state.redoStack = [];
    state.artistName = "Original Artist"; state.trackTitle = "Original Study";
    state.editingId = "old"; state.pendingAttachmentId = "old"; ui.noteInput.value = "stale editor";
    applySessionData({ ...session([{ ...note, id: "new" }]), track: { duration: 12, artist: "New Artist", title: "New Study" } });
    check(state.editingId === null && state.pendingAttachmentId === null && ui.noteInput.value === "", "Editor state survived import");
    undoAnalysis();
    check(state.annotations[0].id === "old" && state.artistName === "Original Artist", "Undo did not restore analysis and metadata");
    redoAnalysis();
    check(state.annotations[0].id === "new" && state.artistName === "New Artist", "Redo did not restore import");
  });
  await test("annotation creation, linked regions, edit, delete and history preserve invariants", () => {
    state.selection = { start: 4, end: 5, source: "waveform" };
    const created = commitAnnotation("rhythm", "A new observation");
    state.selection = { start: 7, end: 8, source: "spectrogram", minFrequency: 80, maxFrequency: 400 };
    attachSelectionToAnnotation(created);
    check(created.links.length === 1, "Linked selection missing");
    editAnnotation(created); ui.noteInput.value = "Edited observation"; saveAnnotation();
    check(state.annotations.find((item) => item.id === created.id).links.length === 1, "Edit lost linked regions");
    deleteAnnotation(created.id); check(!state.annotations.some((item) => item.id === created.id), "Delete failed");
    undoAnalysis(); check(state.annotations.some((item) => item.id === created.id), "Undo delete failed");
  });
  await test("failed decoding preserves the prior buffer, notes and recording identity", async () => {
    const previous = { buffer: state.audioBuffer, notes: JSON.stringify(state.annotations), path: state.filePath, url: state.audioUrl };
    check(!await loadAudioFile(new File(["invalid audio"], "broken.wav")), "Invalid audio was accepted");
    check(state.audioBuffer === previous.buffer && JSON.stringify(state.annotations) === previous.notes && state.filePath === previous.path && state.audioUrl === previous.url, "Previous analysis changed after failure");
  });
  await test("a slower earlier recording cannot replace the most recently requested recording", async () => {
    const source = createDemoAudioFile();
    const bytes = await source.arrayBuffer();
    const original = window.OfflineAudioContext;
    let calls = 0;
    let release;
    window.OfflineAudioContext = class DelayedDecoder extends original {
      async decodeAudioData(payload) {
        if (calls++ === 0) await new Promise((resolve) => { release = resolve; });
        return await super.decodeAudioData(payload);
      }
    };
    try {
      const earlier = loadAudioFile(new File([bytes], "slow.wav", { type: "audio/wav", lastModified: 1 }));
      while (!release) await frame();
      const fast = new File([bytes], "latest.wav", { type: "audio/wav", lastModified: 2 });
      check(await loadAudioFile(fast), "Latest load failed");
      release();
      check(!await earlier && state.fileName === "latest", "Earlier request overwrote latest recording");
    } finally {
      release?.();
      window.OfflineAudioContext = original;
    }
  });
  await test("superseded file reads stop and cannot reach the decoder", async () => {
    const controller = new AbortController();
    const pending = window.MusicAnalyserDecode.readRecordingBytes(createDemoAudioFile(), controller.signal);
    controller.abort();
    try {
      await pending;
      throw new Error("An aborted file read returned bytes");
    } catch (error) {
      check(error.name === "AbortError", `Wrong read cancellation result: ${error.message}`);
    }
  });
  await test("starting another import aborts analysis already running in the worker", async () => {
    const previous = state.audioBuffer;
    const stage = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (ui.projectStatus.textContent !== "analysing spectrum…") return;
        observer.disconnect();
        clearTimeout(deadline);
        resolve(recordingAnalysisController.signal);
      });
      const deadline = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 5000);
      observer.observe(ui.projectStatus, { childList: true });
    });
    const earlier = loadAudioFile(createDemoAudioFile());
    const workerSignal = await stage;
    check(workerSignal, "The first import did not reach the analysis worker");
    const newer = loadAudioFile(new File(["bad input"], "broken-while-busy.wav"));
    check(workerSignal.aborted, "The superseded worker was still running");
    check(!await earlier && !await newer && state.audioBuffer === previous && !audioLoadInProgress,
      "An interrupted load replaced the committed recording or left the app busy");
  });
  await test("a rejected pending-session mismatch does not overwrite the new recording", async () => {
    const originalConfirm = window.confirm; let prompts = 0;
    window.confirm = () => { prompts += 1; return false; };
    state.pendingSession = { ...session([{ ...note, id: "wrong-session" }]), track: { duration: 99 } };
    try {
      await loadAudioFile(new File([await createDemoAudioFile().arrayBuffer()], "different.wav", { type: "audio/wav", lastModified: 3 }));
      check(prompts === 1 && state.pendingSession, "No mismatch check or pending session was discarded");
      check(!state.annotations.some((item) => item.id === "wrong-session"), "Mismatched session was applied");
    } finally { window.confirm = originalConfirm; state.pendingSession = null; }
  });
  await test("storage quota failures keep editing available and show a persistent backup warning", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
    try {
      state.selection = { start: 1, end: 2, source: "waveform" };
      commitAnnotation("form", "Still available in memory");
      check(!document.querySelector("#storageWarning").hidden, "No visible storage warning");
      check(state.annotations.some((item) => item.note === "Still available in memory"), "Edit lost on quota failure");
      check(buildSessionData().annotations.length === state.annotations.length, "Session export unavailable");
    } finally { Storage.prototype.setItem = original; }
  });
  await test("extreme imported rhythm origins cannot create non-advancing beat loops", () => {
    const grid = normaliseRhythmGrid({ bpm: 120, barOneAtSeconds: 1e300 });
    check(Number.isFinite(grid.barOneAtSeconds) && Math.abs(grid.barOneAtSeconds) <= 604800, "Unbounded grid origin");
  });
  await test("large annotation text and category names cannot inject HTML or overlap card controls", () => {
    applySessionData(session([{ ...note, category: "toString", note: "<img src=x onerror=alert(1)>\n" + "Long observation ".repeat(100) }]));
    const card = document.querySelector(".timeline-item");
    check(!card.querySelector("img") && card.querySelector(".timeline-item__note").textContent.includes("<img"), "Unescaped note rendered HTML");
    check(card.style.getPropertyValue("--category-colour").startsWith("hsl("), "Prototype category used as a CSS colour");
    const timing = card.querySelector(".timeline-item__time").getBoundingClientRect();
    const category = card.querySelector(".timeline-item__category").getBoundingClientRect();
    const controls = card.querySelector(".timeline-item__actions").getBoundingClientRect();
    check(category.left >= timing.right || category.top >= timing.bottom, "Category overlaps timing text");
    check(category.right <= controls.left, "Category overlaps edit/delete controls");
  });
  await test("ordinary full-spectrum playback does not attenuate the original mix", async () => {
    const previous = { context: state.meterContext, nodes: state.filterNodes, preset: state.activeBandPreset };
    const context = new OfflineAudioContext(1, 4096, 48000);
    state.meterContext = context;
    state.filterNodes = Array.from({length:8}, (_,i) => { const f=context.createBiquadFilter(); f.type=i<4?"highpass":"lowpass"; f.Q.value=0.707; return f; });
    state.activeBandPreset = null;
    try {
      resetAuditionFilter();
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 4096, 48000);
      source.buffer.getChannelData(0)[1024] = 1;
      source.connect(state.filterNodes[0]);
      state.filterNodes.forEach((filter,i)=>filter.connect(state.filterNodes[i+1] || context.destination));
      source.start();
      const output = (await context.startRendering()).getChannelData(0);
      check(output.every((v,i)=>Math.abs(v-(i===1024?1:0))<0.00001), "Full mix changed the original impulse");
    } finally { state.meterContext=previous.context;state.filterNodes=previous.nodes;state.activeBandPreset=previous.preset; }
  });
  await test("isolated playback keeps its requested band on a low-rate audio output", () => {
    const previous = { context: state.meterContext, nodes: state.filterNodes, preset: state.activeBandPreset };
    const edges = [];
    const frequency = { cancelScheduledValues() {}, setValueAtTime: (value) => edges.push(value) };
    state.meterContext = { currentTime: 0, sampleRate: 24000 };
    state.filterNodes = [{ type: "highpass", frequency }, { type: "lowpass", frequency }];
    state.activeBandPreset = null;
    try {
      const available = configureAuditionFilter({ source: "spectrogram", minFrequency: 11800, maxFrequency: 20000 }, "iso");
      check(available && edges.join(",") === "11800,12000", "The playback graph moved the selected lower edge");
      const unavailable = configureAuditionFilter({ source: "spectrogram", minFrequency: 12500, maxFrequency: 20000 }, "iso");
      check(!unavailable && edges.length === 2, "An unavailable region was silently translated to another band");
      syncBandControls();
      check(ui.spectrumBandControls.querySelector('[data-band="air"]').disabled, "The preset exceeded the playback range");
    } finally {
      state.meterContext = previous.context;
      state.filterNodes = previous.nodes;
      state.activeBandPreset = previous.preset;
      syncBandControls();
    }
  });
  await test("very short recordings do not draw phantom waveform columns", () => {
    const previous = state.audioBuffer;
    state.audioBuffer = { duration: 1/48000, sampleRate: 48000, length:1, getChannelData:()=>new Float32Array([0]) };
    try {
      drawWaveform();
      const context=ui.waveformCanvas.getContext("2d");
      const alpha=context.getImageData(ui.waveformCanvas.width-4,10,1,1).data[3];
      check(alpha===0,"Short silence drew a full-height waveform");
    } finally { state.audioBuffer=previous; drawWaveform(); }
  });
  await test("manual seeking cancels the old region boundary and isolated playback", () => {
    state.isScrubbingSeek = false;
    state.auditionAnnotationId = "old";
    state.auditionSelection = { start:1,end:3,source:"spectrogram",minFrequency:200,maxFrequency:1000 };
    state.auditionSelectionKey = "primary";
    state.auditionPlaybackMode = "iso";
    state.auditionLoop = true;
    beginSeekScrub();
    check(!state.auditionSelection && !state.auditionAnnotationId && !state.auditionLoop, "Manual seek retained the old region");
    finishSeekScrub();
  });
  await test("500 overlapping notes stay separate and within their timeline", () => {
    const started=performance.now();
    applySessionData(session(Array.from({length:500},(_,i)=>({...note,id:`stress-${i}`,category:i%2?"timbre":"a custom category with a deliberately long name",note:`Observation ${i}: `+"content ".repeat(20)}))));
    const cards=[...document.querySelectorAll(".timeline-item")];
    check(cards.length===500,"Stress notes lost");
    for(let i=1;i<cards.length;i++)check(parseFloat(cards[i].style.top)>=parseFloat(cards[i-1].style.top)+cards[i-1].offsetHeight,"Overlapping annotation lanes");
    check(parseFloat(ui.timeline.style.minHeight)>=parseFloat(cards.at(-1).style.top)+cards.at(-1).offsetHeight,"Last card clipped");
    check(performance.now()-started<15000,"Stress rendering exceeded the bounded 15-second budget");
  });
  return results;
})()
