(async () => {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const test = async (name, action) => {
    try { await action(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  };
  const find = (selector) => document.querySelector(selector);
  const key = (target, name, options = {}) => target.dispatchEvent(new KeyboardEvent("keydown", {
    key: name, bubbles: true, cancelable: true, ...options,
  }));
  const space = (target, options = {}) => key(target, " ", { code: "Space", ...options });
  const waitFor = async (condition, message) => {
    const deadline = performance.now() + 3000;
    while (!condition() && performance.now() < deadline) await new Promise(requestAnimationFrame);
    check(condition(), message);
  };
  const testNote = { id: "ui-note", start: 1, end: 3, source: "waveform", category: "timbre", note: "Compare the original and isolated region." };
  const record = (sections = []) => applySessionData({
    format: "music-analyser-session",
    version: 3,
    track: { duration: state.audioBuffer.duration },
    annotations: [testNote],
    sections,
  });

  await test("editing and creating categories keep the visible selection and keyboard focus in sync", () => {
    record();
    const trigger = find("#annotationForm .category-picker__button");
    ui.categorySelect.value = "melody";
    ui.categorySelect.dispatchEvent(new Event("change"));
    editAnnotation(state.annotations[0]);
    check(trigger.getAttribute("aria-label") === "Choose category: timbre", "Editing shows a stale category");
    key(trigger, "ArrowUp");
    check(document.activeElement.textContent === "+ new category", "ArrowUp does not open the final palette choice");
    document.activeElement.click();
    check(document.activeElement === ui.customCategoryInput, "New category did not focus its input");
    for (const name of ["all", "__new__"]) {
      ui.customCategoryInput.value = name;
      ui.saveCategoryButton.click();
      check(!state.categories.includes(name) && !ui.customCategoryRow.hidden, "Reserved category was accepted");
    }
    ui.customCategoryInput.value = "Test texture";
    ui.saveCategoryButton.click();
    check(ui.categorySelect.value === "test texture" && document.activeElement === trigger, "Saving a category lost focus or the selection");
  });

  await test("closing the session dialog restores the disclosure focus", async () => {
    const summary = find("#sessionMenu summary");
    summary.focus();
    sessionMenu.open = true;
    ui.saveSessionButton.focus();
    ui.saveSessionButton.click();
    check(ui.sessionShareDialog.open && document.activeElement === ui.sessionAudioLinkInput, "Session dialog did not take focus");
    const closed = new Promise((resolve) => ui.sessionShareDialog.addEventListener("close", resolve, { once: true }));
    ui.sessionShareCancel.click();
    await closed;
    check(!sessionMenu.open && document.activeElement === summary, "Dialog closed without restoring the Session control");
  });

  await test("native disclosures stay usable and settle after rapid clicks", async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
    const failures = [];
    for (const id of ["sessionMenu", "mixLabPanel", "regionEntry"]) {
      const details = find(`#${id}`);
      const summary = details.querySelector("summary");
      details.open = false;
      summary.click();
      const clippedDuringOpening = details.style.overflow === "hidden";
      await settle();
      const opened = details.open;
      summary.click();
      await settle();
      const closed = !details.open;
      summary.click();
      summary.click();
      await settle();
      const rapidClosed = !details.open;
      details.open = false;
      if (!opened || !closed || !rapidClosed || clippedDuringOpening) {
        failures.push(`${id}: opened=${opened}, closed=${closed}, rapidClosed=${rapidClosed}, clipped=${clippedDuringOpening}`);
      }
    }
    check(!failures.length, failures.join("; "));
  });

  await test("arrangement colour palettes fit at the recording start and support keyboard selection", () => {
    record([{ id: "opening", name: "Opening", start: 0, end: 0.2 }]);
    const button = find(".arrangement-chapter__colour");
    button.click();
    const palette = find(".arrangement-chapter__palette");
    const geometry = palette.getBoundingClientRect();
    const track = ui.arrangementTrack.getBoundingClientRect();
    check(geometry.left >= track.left && geometry.right <= track.right, "Colour choices escape the arrangement track");
    check(document.activeElement.getAttribute("aria-checked") === "true", "Palette opened without focusing the selected colour");
    key(document.activeElement, "ArrowRight");
    check(document.activeElement.getAttribute("aria-label") === "Use Gold for Opening", "Arrow navigation did not reach the next colour");
    document.activeElement.click();
    check(state.sections[0].colour === "#f4c95d" && document.activeElement === button, "Selecting a colour lost the section or focus");
    button.click();
    key(document.activeElement, "Escape");
    check(palette.hidden && document.activeElement === button, "Escape did not close the palette and restore focus");
    const chapter = find(".arrangement-chapter");
    chapter.focus();
    key(chapter, "Enter");
    const rename = find(".arrangement-chapter__rename");
    rename.value = "Warm intro";
    key(rename, "Enter");
    check(state.sections[0].name === "Warm intro" && document.activeElement.matches(".arrangement-chapter"), "Renaming did not return focus to its marker");
  });

  await test("keyboard range entry links a region and Escape closes the visible grid first", async () => {
    record();
    find(".timeline-item__attach").click();
    check(document.activeElement === find("#regionEntry summary"), "Keyboard attachment lost focus instead of offering precise entry");
    regionEntry.open = true;
    await new Promise(requestAnimationFrame);
    regionStart.value = "5.250";
    regionEnd.value = "6.500";
    regionLow.value = "90";
    regionHigh.value = "400";
    find("#regionForm").requestSubmit();
    const [linked] = state.annotations[0].links;
    check(linked?.start === 5.25 && linked.maxFrequency === 400, "Exact region did not attach to the selected note");
    ui.rhythmGridToggle.click();
    ui.bpmInput.focus();
    key(ui.bpmInput, "Escape");
    check(ui.rhythmGridPanel.hidden && document.activeElement === ui.rhythmGridToggle, "Escape failed to dismiss and return from the grid");
    check(state.pendingAttachmentId === testNote.id, "Dismissal interrupted the underlying attachment");
    key(ui.rhythmGridToggle, "Escape");
    check(!state.pendingAttachmentId, "Escape failed to end attachment after dismissing the grid");
  });

  await test("Space plays, pauses and resumes at the current position without repeat toggles", async () => {
    record();
    const wasMuted = ui.audio.muted;
    ui.audio.muted = true;
    try {
      await waitFor(() => ui.audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, "Recording data unavailable");
      ui.waveformFrame.focus();
      seekAudioTo(2);
      check(!space(ui.waveformFrame), "Space did not reserve the recording-view shortcut");
      await waitFor(() => !ui.audio.paused && ui.audio.currentTime > 2.12, "Space did not start advancing the recording");
      space(ui.waveformFrame, { repeat: true });
      check(!ui.audio.paused, "Holding Space paused playback again");
      space(ui.waveformFrame);
      check(ui.audio.paused, "Second Space press did not pause");
      const pausedAt = ui.audio.currentTime;
      space(ui.waveformFrame, { repeat: true });
      check(ui.audio.paused, "Holding Space resumed paused playback");
      space(ui.waveformFrame);
      check(ui.audio.currentTime >= pausedAt - 0.03, "Space restarted the recording instead of resuming");
      await waitFor(() => !ui.audio.paused && ui.audio.currentTime > pausedAt + 0.08, "Space did not resume playback");
      check(ui.playButton.getAttribute("aria-label") === "Pause recording", "Transport did not announce the playing state");
    } finally {
      pauseAudioTransport();
      ui.audio.muted = wasMuted;
    }
  });

  await test("Space leaves editing, interactive controls, dialogs and note selection in charge", async () => {
    record();
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    const dialog = document.createElement("dialog");
    ui.analysisState.append(editor, dialog);
    try {
      for (const control of [ui.noteInput, editor, ui.seekSlider, ui.playbackSpeedSelect, ui.copyButton, sessionMenu.querySelector("summary")]) {
        control.focus();
        check(document.activeElement === control, `Could not focus ${control.id || control.tagName}`);
        check(space(control) && ui.audio.paused, `Space hijacked ${control.id || control.tagName}`);
      }
      dialog.showModal();
      check(space(dialog) && ui.audio.paused, "Space started playback from an open dialog");
      dialog.close();
      const card = find(".timeline-item");
      card.focus();
      space(card);
      check(state.selectedAnnotationId === testNote.id && ui.audio.paused, "Space did not keep selection on the focused annotation card");
    } finally {
      dialog.remove();
      editor.remove();
      pauseAudioTransport();
    }
  });

  await test("Selecting notes stays silent and the selected card plays only its saved primary region", async () => {
    const notes = [
      { ...testNote, id: "wave-play", links: [{ id: "secondary", start: 8, end: 9, source: "spectrogram", minFrequency: 125, maxFrequency: 350 }] },
      { ...testNote, id: "spectrum-play", start: 4.5, end: 6.5, source: "spectrogram", minFrequency: 350, maxFrequency: 1300 },
    ];
    applySessionData({ format: "music-analyser-session", version: 3, track: { duration: state.audioBuffer.duration }, annotations: notes });
    const playFor = (id) => find(`.timeline-item[data-id="${id}"] .timeline-item__play`);
    const visible = (button) => button?.getClientRects().length > 0 && getComputedStyle(button).visibility === "visible";
    const wasMuted = ui.audio.muted;
    ui.audio.muted = true;
    try {
      check(notes.every(({ id }) => !visible(playFor(id))), "Unselected cards showed an audition action");
      for (const note of notes) {
        find(`.timeline-item[data-id="${note.id}"]`).click();
        check(ui.audio.paused && !state.auditionSelection, "Selecting a saved note started playback");
        const button = playFor(note.id);
        check(visible(button) && button.textContent === "Play", "Selected card has no visible Play button");
        check(notes.filter(({ id }) => visible(playFor(id))).length === 1, "Selecting a note left a second card Play button visible");
        button.click();
        await waitFor(() => !ui.audio.paused && ui.audio.currentTime >= note.start, "The selected Play button did not reach the saved time range");
        const { auditionSelection, auditionPlaybackMode, auditionSelectionKey } = state;
        check(auditionSelection?.start === note.start && auditionSelection.end === note.end && auditionSelectionKey === "primary",
          "Play auditioned the wrong range or a linked region");
        const expectedMode = note.source === "spectrogram" ? "iso" : "full";
        check(auditionPlaybackMode === expectedMode && auditionSelection.minFrequency === (note.minFrequency ?? null)
          && auditionSelection.maxFrequency === (note.maxFrequency ?? null), "Play used the wrong frequency scope");
        await waitFor(() => playFor(note.id)?.textContent === "Pause", "Selected card did not show its Pause action during audition");
        playFor(note.id).click();
        await waitFor(() => ui.audio.paused && !state.auditionSelection && playFor(note.id)?.textContent === "Play",
          "Card Pause did not stop and clear the audition");
      }
    } finally {
      pauseAudioTransport();
      ui.audio.muted = wasMuted;
    }
  });

  await test("Waveform category controls filter saved spans without changing notes or the lower timeline filter", async () => {
    const notes = [
      { ...testNote, id: "built-in", source: "spectrogram", minFrequency: 300, maxFrequency: 1000,
        links: [{ id: "linked", source: "waveform", start: 3, end: 4 }] },
      { ...testNote, id: "custom", category: "feedback texture", start: 3.5, end: 6, source: "spectrogram", minFrequency: 700, maxFrequency: 1800 },
    ];
    applySessionData({ format: "music-analyser-session", version: 3, track: { duration: state.audioBuffer.duration }, annotations: notes });
    const savedNotes = JSON.stringify(buildSessionData().annotations);
    const master = find("#showAnnotationsCheckbox");
    const picker = find("#waveformCategories");
    const choices = () => [...document.querySelectorAll('#waveformCategoryList input[type="checkbox"]')];
    const category = (name) => choices().find((input) => input.value === name);
    const highlights = () => [...document.querySelectorAll("#waveformAnnotationHighlights .waveform-annotation-highlight")];
    const spansFor = (id) => highlights().filter((span) => span.dataset.annotationId === id);
    const masterWasChecked = master?.checked;
    const selectAll = find("#selectAllWaveformCategories");
    const deselectAll = find("#deselectAllWaveformCategories");
    try {
      picker.querySelector("summary").click();
      check(picker.open && category("timbre") && category("feedback texture"), "Category choices omitted a built-in or custom category");
      selectAll.click();
      if (!master.checked) master.click();
      const builtIn = spansFor("built-in");
      const custom = spansFor("custom");
      check(builtIn.length === 2 && custom.length === 1, "Primary or linked time spans were missing from the waveform");
      for (const highlight of highlights()) {
        check(highlight.style.getPropertyValue("--category-colour") === categoryColour(highlight.dataset.category),
          "Waveform highlight did not use its note category’s colour");
      }
      category("timbre").click();
      check(spansFor("built-in").length === 0 && spansFor("custom").length === 1, "Turning off a built-in category hid the wrong spans");
      category("timbre").click();
      category("feedback texture").click();
      check(spansFor("built-in").length === 2 && spansFor("custom").length === 0, "Turning off a custom category hid the wrong spans");
      check(ui.annotationRegionsLayer.querySelector('.annotation-region[data-id="custom"]'), "Waveform categories removed a spectrogram annotation");
      master.click();
      check(!highlights().length && !ui.annotationRegionsLayer.childElementCount, "Master Show annotations did not hide saved annotations");
      master.click();
      check(!category("feedback texture").checked && spansFor("custom").length === 0, "Master toggle forgot waveform category choices");

      ui.filterSelect.value = "timbre";
      ui.filterSelect.dispatchEvent(new Event("change"));
      deselectAll.click();
      check(!highlights().length && choices().every((input) => !input.checked), "Deselect all left checked categories or spans");
      selectAll.click();
      check(highlights().length === 3 && choices().every((input) => input.checked), "Select all did not restore all saved spans");
      check(JSON.stringify(buildSessionData().annotations) === savedNotes && ui.filterSelect.value === "timbre"
        && ui.timeline.querySelectorAll(".timeline-item").length === 1, "Waveform filters changed saved notes or the lower timeline filter");

      // Click through the visible saved range. Synthetic pointers need a capture stub.
      picker.open = false;
      const waveform = ui.waveformFrame;
      waveform.scrollIntoView({ behavior: "instant", block: "center" });
      await new Promise(requestAnimationFrame);
      const bounds = waveform.getBoundingClientRect();
      const seconds = 3.75;
      const clientX = bounds.left + bounds.width * seconds / state.audioBuffer.duration;
      const clientY = bounds.top + bounds.height * 0.65;
      const span = spansFor("custom")[0].getBoundingClientRect();
      const linkedSpan = spansFor("built-in")[1].getBoundingClientRect();
      check([span, linkedSpan].every((rect) => rect.height > 0 && rect.left < clientX && rect.right > clientX),
        "Overlapping saved ranges were not painted at their waveform positions");
      const hit = document.elementFromPoint(clientX, clientY);
      check(hit && waveform.contains(hit) && !hit.closest(".waveform-annotation-highlight"), "A passive highlight intercepted a waveform click");
      const capture = waveform.setPointerCapture;
      waveform.setPointerCapture = () => {};
      try {
        const pointer = { clientX, clientY, button: 0, pointerId: 1, bubbles: true };
        hit.dispatchEvent(new PointerEvent("pointerdown", pointer));
        waveform.dispatchEvent(new PointerEvent("pointerup", pointer));
        check(Math.abs(ui.audio.currentTime - seconds) < 0.03 && ui.audio.paused, "Clicking a highlighted span did not seek normally");
      } finally {
        waveform.setPointerCapture = capture;
      }
    } finally {
      if (master && master.checked !== masterWasChecked) master.click();
      picker.open = false;
      selectAll.click();
      ui.filterSelect.value = "all";
      ui.filterSelect.dispatchEvent(new Event("change"));
    }
  });

  return results;
})()
