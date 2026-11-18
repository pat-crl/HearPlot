(async () => {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  async function test(name, action) {
    try { await action(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  }
  const demo = createDemoAudioFile();
  const makeNote = (id) => ({ id, start: 1, end: 2, category: "timbre", note: id });
  const session = (id) => ({ format: "music-analyser-session", version: 3,
    track: { duration: 12 }, annotations: [makeNote(id)] });
  await loadAudioFile(demo, { path: "/wash/session.wav" });
  await test("annotation history leaves live MixLab playback available across undo and redo", async () => {
    applySessionData(session("first"));
    state.selection = { start: 3, end: 4, source: "waveform" };
    commitAnnotation("rhythm", "second");
    const panel = document.getElementById("mixLabPanel");
    panel.open = true;
    const input = document.getElementById("mixReferenceInput");
    const files = new DataTransfer();
    files.items.add(demo);
    input.files = files.files;
    input.dispatchEvent(new Event("change"));
    const play = document.getElementById("mixPlayB");
    const deadline = performance.now() + 8000;
    while (play.disabled && performance.now() < deadline) await new Promise(requestAnimationFrame);
    check(!play.disabled, "B never loaded");
    state.artistName = "Revised metadata";
    state.audioDownloadUrl = "https://example.com/updated";
    undoAnalysis();
    check(state.artistName === "Revised metadata" && state.audioDownloadUrl.endsWith("/updated"), "Undo reverted unrelated edits");
    check(state.annotations.length === 1 && !play.disabled, "Undo discarded the loaded reference");
    redoAnalysis();
    check(state.annotations.length === 2 && !play.disabled, "Redo discarded the loaded reference");
    const savedName = mixLab.getSessionData().reference.name;
    applySessionData(session("replacement"));
    undoAnalysis();
    check(mixLab.getSessionData()?.reference?.name === savedName, "Undo of imported session lost reference measurements");
    redoAnalysis();
    check(!mixLab.getSessionData()?.reference, "Redo restored the wrong session comparison");
    panel.open = false;
  });
  await test("a paused seek with Loop selection enabled keeps its requested position", async () => {
    state.selection = { start: 1, end: 3, source: "waveform" };
    state.loopSelection = true;
    try {
      ui.audio.pause();
      ui.audio.currentTime = 7;
      ui.audio.dispatchEvent(new Event("timeupdate"));
      check(ui.audio.paused && Math.abs(ui.audio.currentTime - 7) < 0.02, "Loop started or redirected a paused seek");
    } finally { state.loopSelection = false; ui.audio.pause(); }
  });
  await test("copied analysis describes every linked range with time and band", () => {
    const value = session("linked note");
    value.annotations[0].links = [{ id: "link", start: 6, end: 8, source: "spectrogram", minFrequency: 300, maxFrequency: 800 }];
    applySessionData(value);
    const report = buildTextExport();
    check(report.includes("00:06.000") && report.includes("00:08.000") && report.includes("300 hz") && report.includes("800 hz"), "Copy omitted the linked observation range");
  });
  await test("a newly accepted session supersedes earlier pending audio requests", async () => {
    const value = session("newly accepted");
    const transfer = new DataTransfer();
    transfer.items.add(new File([JSON.stringify(value)], "new.json"));
    state.pendingSession = session("obsolete");
    ui.sessionInput.files = transfer.files;
    ui.sessionInput.dispatchEvent(new Event("change"));
    const deadline = performance.now() + 3000;
    while (state.annotations[0]?.id !== "newly accepted" && performance.now() < deadline) await new Promise(requestAnimationFrame);
    check(state.annotations[0]?.id === "newly accepted" && !state.pendingSession, "Superseded session was still queued");
    state.pendingSession = null;
  });
  await test("slow older JSON reads cannot overwrite the latest imported session", async () => {
    let release;
    const first = importSessionFile({ size: 100, text: () => new Promise((resolve) => { release = resolve; }) });
    await importSessionFile(new File([JSON.stringify(session("latest"))], "second.json"));
    release(JSON.stringify(session("stale")));
    await first;
    check(state.annotations[0]?.id === "latest", "Earlier JSON replaced the last requested file");
  });
  await test("opening and editing after a damaged autosave preserves both the original and recovered notes", async () => {
    const key = projectStorageKey();
    storage.setItem(key, '{"annotations":[');
    restoreProject();
    check(!ui.projectRecoveryWarning.hidden, "Unreadable local data was not disclosed");
    applySessionData(session("recovered note"));
    check(storage.getItem(key) === '{"annotations":[', "Unreadable data was overwritten");
    restoreProject();
    check(state.annotations[0]?.id === "recovered note", "Recovery edits did not reopen");
  });
  await test("an earlier rounded Recent shortcut recovers its existing annotations", async () => {
    const path = "/wash/rounded.wav";
    const oldKey = `music-analyser-project::${path}::${demo.size}::2`;
    storage.setItem(oldKey, JSON.stringify(session("restored")));
    storage.setItem("music-analyser-recent-analyses", JSON.stringify([{filePath: path, projectKey: oldKey}]));
    await loadAudioFile(demo, { path });
    check(state.annotations[0]?.id === "restored", "Rounded-key notes disappeared");
    check(JSON.parse(storage.getItem(projectStorageKey())).annotations[0].id === "restored", "Picker identity did not retain the notes");
  });
  await test("a blank picker autosave recovers the populated older copy only once", async () => {
    const path = "/wash/dual.wav";
    const key = `music-analyser-project::${path}::${demo.size}::1`;
    const previous = `music-analyser-project::${path}::${demo.size}::2`;
    storage.setItem(key, JSON.stringify({ annotations: [], categories: [...DEFAULT_CATEGORIES] }));
    storage.setItem(previous, JSON.stringify({ annotations: [], mixLab: { format: "music-analyser-mix-lab", levelMatch: false } }));
    const details = { path, metadata: { roundedLastModified: 2 } };
    await loadAudioFile(demo, details);
    check(mixLab.getSessionData()?.levelMatch === false, "The empty autosave hid the earlier comparison");
    applySessionData(session("intentional replacement"));
    await loadAudioFile(demo, details);
    check(!mixLab.getSessionData() && state.annotations[0].id === "intentional replacement", "Reopening resurrected old edits");
  });
  await test("conflicting earlier autosaves keep active notes and a portable alternate", async () => {
    const path = "/wash/conflicts.wav";
    const key = `music-analyser-project::${path}::${demo.size}::1`;
    const previous = `music-analyser-project::${path}::${demo.size}::2`;
    storage.setItem(key, JSON.stringify(session("picker notes")));
    const alternate = { ...session("earlier recent notes"), filePath: "/Users/private/recording.wav" };
    const raw = JSON.stringify(alternate);
    storage.setItem(previous, raw);
    const details = { path, metadata: { roundedLastModified: 2 } };
    for (let open = 0; open < 2; open++) {
      await loadAudioFile(demo, details);
      check(state.annotations[0]?.id === "picker notes" && !document.getElementById("alternateAutosave").hidden, "Autosave conflict was hidden or overwritten");
      const portable = validateSession(alternateSessionData(state.alternateAutosave));
      check(portable.annotations[0].id === "earlier recent notes" && !JSON.stringify(portable).includes("/Users/"), "Alternate export lost work or leaked paths");
      check(storage.getItem(previous) === raw, "Older copy was modified");
    }
  });
  await test("millisecond displays round consistently across second and minute boundaries", () => {
    check(formatTime(1.001, true) === "00:01.001", "Dropped a typed millisecond");
    check(formatTime(59.9999, true) === "01:00.000", "Minute rollover displayed the wrong millisecond");
  });
  await test("selection loops ending at the file boundary continue until paused", async () => {
    const audio = ui.audio;
    const selection = { start: 11.8, end: 12, source: "waveform" };
    state.selection = selection;
    state.loopSelection = true;
    audio.muted = true;
    try {
      seekAudioTo(selection.start);
      await audio.play();
      await new Promise((resolve) => setTimeout(resolve, 750));
      check(!audio.paused && audio.currentTime >= selection.start - 0.02 && audio.currentTime <= selection.end, "Loop stopped at the recording's end");
    } finally {
      state.loopSelection = false;
      pauseAudioTransport();
      audio.muted = false;
    }
  });
  return results;
})()
