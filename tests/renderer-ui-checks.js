(async () => {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const test = async (name, action) => {
    try { await action(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  };
  const find = (selector) => document.querySelector(selector);
  const key = (target, name) => target.dispatchEvent(new KeyboardEvent("keydown", {
    key: name, bubbles: true, cancelable: true,
  }));
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

  return results;
})()
