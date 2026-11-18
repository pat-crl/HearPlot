(async () => {
  const results = [];
  const byId = (id) => document.getElementById(id);
  const panel = byId("mixLabPanel");
  const match = byId("mixLevelMatch");
  const playA = byId("mixPlayA");
  const playB = byId("mixPlayB");
  const remove = byId("mixRemoveReference");
  const status = byId("mixReferenceStatus");
  const frame = () => new Promise(requestAnimationFrame);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (condition, message) => {
    const deadline = performance.now() + 7500;
    while (!condition() && performance.now() < deadline) await frame();
    check(condition(), message);
  };
  const test = async (name, action) => {
    try { await action(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  };
  let audition;
  let quietFile;
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (this !== ui.audio) audition = this;
    this.muted = true;
    return originalPlay.call(this);
  };
  function setMatch(checked) {
    match.checked = checked;
    match.dispatchEvent(new Event("change"));
  }
  function choose(file) {
    const input = byId("mixReferenceInput");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change"));
  }
  function referenceFile(name, bytes = quietFile) {
    return new File([bytes], name, { type: "audio/wav" });
  }

  try {
    await test("MixLab keeps the playing gain in sync as the reference and level matching change", async () => {
      const fixture = createDemoAudioFile();
      const bytes = await fixture.arrayBuffer();
      const wave = new DataView(bytes);
      for (let index = 44; index < wave.byteLength; index += 2) {
        wave.setInt16(index, Math.round(wave.getInt16(index, true) / 4), true);
      }
      quietFile = referenceFile("quiet-reference.wav", bytes);
      state.pendingSession = null;
      check(await loadAudioFile(new File([fixture], "MixLab primary.wav", { type: "audio/wav" })), "Primary fixture did not load");
      panel.open = true;
      await waitFor(() => !playA.disabled, "Primary measurements never appeared");
      setMatch(true);
      choose(quietFile);
      await waitFor(() => !playB.disabled, "Reference did not load");
      const baseVolume = Number(ui.volumeSlider.value);
      playA.click();
      await waitFor(() => audition && !audition.paused, "Audition A did not start");
      check(Math.abs(audition.volume - baseVolume / 4) < 0.005, "Level matching did not apply the expected −12 dB trim");
      remove.click();
      check(!audition.paused && Math.abs(audition.volume - baseVolume) < 0.005, "Removing B left A playing silently at the old trim");
      choose(quietFile);
      await waitFor(() => !playB.disabled, "Reference did not reload");
      check(Math.abs(audition.volume - baseVolume / 4) < 0.005, "Reconnecting B did not reapply the trim");
      audition.currentTime = 3;
      await waitFor(() => !audition.seeking, "Track A seek did not finish");
      playB.click();
      await waitFor(() => playB.textContent === "Pause B" && !audition.seeking, "Track B did not start");
      check(audition.currentTime >= 2.9 && audition.currentTime <= 4, "A/B switch did not carry elapsed position");
      check(ui.audio.paused && Math.abs(audition.volume - baseVolume) < 0.005, "A/B playback overlapped or boosted the quieter source");
      await ui.audio.play();
      await waitFor(() => audition.paused, "Starting the main transport did not stop MixLab");
      ui.audio.pause();
      ui.audio.muted = false;
      playA.click();
      await waitFor(() => !audition.paused, "Second audition did not start");
      try {
        setFocusedView(true);
        check(audition.paused && ui.audio.paused, "Focused view hid the audition's controls while audio kept playing");
      } finally {
        setFocusedView(false);
      }
    });

    await test("MixLab restores its own long Unicode reference and remembers match-off without audio", async () => {
      const file = referenceFile("Ref-" + "x".repeat(235) + "𐐀-tail.wav");
      choose(file);
      await waitFor(() => remove.textContent === "Remove" && !playB.disabled, "Long-name reference did not load");
      const saved = JSON.parse(JSON.stringify(mixLab.getSessionData()));
      mixLab.restoreSessionData(saved);
      check(!playB.disabled, "Own session round-trip discarded a live reference");
      check(!/[\uD800-\uDBFF]$/u.test(saved.reference.fileName), "Export split a Unicode code point");
      remove.click();
      setMatch(false);
      const preference = JSON.parse(JSON.stringify(buildSessionData())).mixLab;
      check(preference?.levelMatch === false && preference.reference === null, "Match-off did not save before a reference was chosen");
      mixLab.restoreSessionData(null);
      check(match.checked, "Default matching state was not restored");
      mixLab.restoreSessionData(preference);
      check(!match.checked && playB.disabled, "Match-off did not restore without a reference");
    });

    await test("MixLab preserves a valid reference if replacement fails, is cancelled, or loses a race", async () => {
      const originalPrepare = window.MusicAnalyserDecode.prepareRecording;
      choose(quietFile);
      await waitFor(() => !playB.disabled, "Reference fixture did not load");
      choose(new File(["bad file"], "bad.wav", { type: "audio/wav" }));
      await waitFor(() => status.textContent.includes("previous reference"), "A failed replacement produced no recovery feedback");
      check(!playB.disabled && mixLab.getSessionData()?.reference.fileName === quietFile.name, "Failed replacement removed live audio");
      let delayedSignal;
      const release = [];
      window.MusicAnalyserDecode.prepareRecording = (file, signal) => {
        if (!file.name.startsWith("delayed")) return originalPrepare(file, signal);
        delayedSignal = signal;
        return new Promise((resolve) => release.push(() => resolve({ buffer: state.audioBuffer, playback: file })));
      };
      try {
        choose(referenceFile("delayed-cancel.wav"));
        check(remove.textContent === "Cancel load" && !playB.disabled, "Loading hid the available reference or mislabeled cancellation");
        remove.click();
        check(delayedSignal.aborted && !playB.disabled && mixLab.getSessionData()?.reference.fileName === quietFile.name,
          "Cancelling replacement removed the existing reference");
        await release.shift()();
        choose(referenceFile("delayed-stale.wav"));
        const staleSignal = delayedSignal;
        choose(referenceFile("latest.wav"));
        await waitFor(() => mixLab.getSessionData()?.reference.fileName === "latest.wav", "Replacement did not complete");
        check(staleSignal.aborted, "Selecting a newer reference failed to cancel the earlier job");
        await release.shift()();
        await frame();
        check(mixLab.getSessionData()?.reference.fileName === "latest.wav", "A stale replacement overwrote the newest result");
      } finally {
        window.MusicAnalyserDecode.prepareRecording = originalPrepare;
      }
    });

    await test("MixLab exports path-free values and recovers cleanly from clipboard failure", async () => {
      const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
      const command = document.execCommand;
      const createUrl = URL.createObjectURL;
      const clickLink = HTMLAnchorElement.prototype.click;
      let report;
      try {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true, value: { writeText: () => Promise.reject(new Error("Clipboard unavailable")) },
        });
        document.execCommand = () => { throw new Error("Fallback unavailable"); };
        byId("mixCopyReport").click();
        await waitFor(() => ui.toast.textContent === "Could not copy the MixLab report.", "Clipboard error did not reach the user");
        check(!panel.querySelector("textarea") && document.activeElement === byId("mixCopyReport"), "Clipboard failure left a stray field or lost focus");
        URL.createObjectURL = (blob) => {
          if (blob.type === "application/json") report = blob;
          return createUrl.call(URL, blob);
        };
        HTMLAnchorElement.prototype.click = function () {
          if (this.download !== "mixlab-measurements.json") return clickLink.call(this);
        };
        byId("mixSaveReport").click();
        await waitFor(() => Boolean(report), "Report export did not produce JSON");
        const payload = JSON.parse(await report.text());
        check(payload.format === "music-analyser-mix-report" && payload.primary.analysis.bands.length === 7
          && payload.reference.analysis.shortTerm.length > 0, "Measurement export lost rows or time series");
        check(Object.keys(payload.primary).every((key) => ["name", "analysis"].includes(key))
          && Object.keys(payload.reference).every((key) => ["name", "analysis"].includes(key)), "Report included live audio state");
      } finally {
        if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
        else delete navigator.clipboard;
        document.execCommand = command;
        URL.createObjectURL = createUrl;
        HTMLAnchorElement.prototype.click = clickLink;
      }
    });

    await test("MixLab charts display an isolated loudness point with distinct short-duration ticks", async () => {
      const sampleRate = 44100;
      const short = (await quietFile.arrayBuffer()).slice(0, 44 + sampleRate * 0.4 * 2);
      const header = new DataView(short);
      header.setUint32(4, short.byteLength - 8, true);
      header.setUint32(40, short.byteLength - 44, true);
      const chart = byId("mixLoudnessChart");
      const context = CanvasRenderingContext2D.prototype;
      const fillText = context.fillText;
      const arc = context.arc;
      const labels = [];
      let dots = 0;
      context.fillText = function (label, ...args) {
        if (this.canvas === chart && typeof label === "string") labels.push(label);
        return fillText.call(this, label, ...args);
      };
      context.arc = function (...args) {
        if (this.canvas === chart) dots += 1;
        return arc.apply(this, args);
      };
      try {
        check(await loadAudioFile(referenceFile("400ms.wav", short)), "Short fixture did not decode");
        await waitFor(() => !playA.disabled, "Short fixture never produced measurements");
        check(dots > 0, "A single valid momentary window drew no marker");
        const xLabels = labels.slice(-5);
        check(new Set(xLabels).size === 5 && xLabels.at(-1) === "0.40s", "Short recording ticks were duplicated or time-stretched");
        check(chart.getAttribute("aria-describedby") === "mixLoudnessDescription", "Accessible chart lost its description");
      } finally {
        context.fillText = fillText;
        context.arc = arc;
      }
    });
  } finally {
    HTMLMediaElement.prototype.play = originalPlay;
    audition?.pause();
    ui.audio.pause();
    ui.audio.muted = false;
    panel.open = false;
    mixLab.restoreSessionData(null);
  }
  return results;
})();
