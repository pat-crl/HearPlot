/*
  MUSIC ANALYSER — APPLICATION LOGIC

  This file is organised in sections that follow the user's journey:
  1. shared state and page references
  2. loading and decoding audio
  3. drawing the waveform, high-detail spectrogram, and musical grid
  4. selecting parts of those drawings
  5. creating, displaying, saving, and exporting notes

  Everything runs locally in the desktop app. The audio file is decoded into
  memory and is never sent to a server.
*/

// ---------- 1. Shared state and page references ----------

const DEFAULT_CATEGORIES = ["form", "melody", "rhythm", "harmony", "timbre", "texture", "dynamics"];
const MIN_SPECTRUM_FREQUENCY = 20;
// These colours are sampled from the spectrogram palette so category overlays feel native to the visual field.
const CATEGORY_COLOURS = {
  form: "#3977ff",
  melody: "#f4c95d",
  rhythm: "#41c77a",
  harmony: "#32c4d8",
  timbre: "#8b6de9",
  texture: "#f072a9",
  dynamics: "#f0744f",
};
// Approximate colour-wheel positions let custom categories avoid the built-in colours as well as one another.
const CATEGORY_HUES = [219, 46, 145, 188, 252, 331, 13];
// Arrangement colours use the same family as the spectrogram and annotation
// palette, but sections keep their own colour so they do not imply a category.
const SECTION_COLOURS = ["#3977ff", "#f4c95d", "#41c77a", "#32c4d8", "#8b6de9", "#f072a9", "#f0744f"];
// The preset edges follow common mix-engineering bands. The steep filter chain
// below makes them useful for listening, while the soft overlay shows the area.
const BAND_PRESETS = {
  sub: { min: 20, max: 60 },
  bass: { min: 60, max: 250 },
  "low-mids": { min: 250, max: 500 },
  mids: { min: 500, max: 2000 },
  "high-mids": { min: 2000, max: 6000 },
  highs: { min: 6000, max: 12000 },
  air: { min: 12000, max: 20000 },
};
const ANNOTATION_PROMPT_LEAD_SECONDS = 3;
// A short look-ahead gives the Web Audio clock time to place each click
// accurately, while the small interval lets seeks and grid edits react quickly.
const METRONOME_TIMER_MS = 25;
const METRONOME_LOOKAHEAD_SECONDS = 0.14;
const METRONOME_SCHEDULE_LEAD_SECONDS = 0.006;
// After a seek, a few advancing clock samples give us a fresh relationship
// between the recording clock and the Web Audio clock. This avoids rebuilding
// the clicks while the recording is still waiting at its new position.
const METRONOME_TRANSPORT_POLL_MS = 20;
const METRONOME_TRANSPORT_CONFIRM_SECONDS = 0.04;
const METRONOME_TRANSPORT_TOLERANCE_SECONDS = 0.012;
const METRONOME_ANCHOR_TOLERANCE_SECONDS = 0.06;
// The standards-based measurement maths lives in loudness.js so it can be
// tested independently from the rest of this interface.
const { analyseLoudness } = window.MusicAnalyserLoudness;
// Tempo, spectrogram, and metronome maths live in small separate files so their
// results can be checked without relying only on visual or listening tests.
const { analyseTempo, snapRangeToBarStarts } = window.MusicAnalyserTempo;
const { analyseSpectrogram, chooseSpectrogramSettings } = window.MusicAnalyserSpectrogram;
const {
  playbackAnchorIsCurrent,
  playbackSnapshotCanSchedule,
  scheduleBeatEvents,
  transportAdvanceIsConfirmed,
} = window.MusicAnalyserMetronome;
const nativeAudioApi = window.musicAnalyserNative || null;

const state = {
  audioBuffer: null,
  audioUrl: null,
  fileIdentity: null,
  legacyFileIdentity: null,
  filePath: "",
  fileName: "",
  artistName: "",
  trackTitle: "",
  artworkDataUrl: "",
  artworkThumbnailDataUrl: "",
  // This optional link travels with a shared JSON session. It points to audio
  // stored by the sender; the app never uploads or embeds the recording.
  audioDownloadUrl: "",
  pendingSession: null,
  selection: null,
  annotations: [],
  sections: [],
  categories: [...DEFAULT_CATEGORIES],
  editingId: null,
  drag: null,
  spectrumData: null,
  loopSelection: false,
  hoveredAnnotation: null,
  hoveredCard: null,
  selectedAnnotationId: null,
  showHoverRegions: localStorage.getItem("music-analyser-hover-regions") !== "off",
  showAnnotationRegions: localStorage.getItem("music-analyser-show-annotations") === "on",
  // Bar lines can be made quieter without reducing the finer beat reference.
  barMarkerOpacity: storedBarMarkerOpacity(),
  meterContext: null,
  meterSource: null,
  meterAnalysers: [],
  filterNodes: [],
  meterAnimationFrame: null,
  meterLevels: [0, 0],
  // The metronome follows the musical grid, but only makes sound while the
  // recording itself is playing and the listener has explicitly turned it on.
  metronomeEnabled: localStorage.getItem("music-analyser-metronome") === "on",
  metronomeTimer: null,
  metronomeScheduledThrough: null,
  metronomeScheduledClicks: new Set(),
  metronomeGeneration: 0,
  // A seek has a brief unsettled period: currentTime may already show the new
  // value even though the recording has not started producing sound there.
  metronomeAnchor: null,
  metronomeNeedsTransportSync: false,
  metronomeTransportTimer: null,
  isScrubbingSeek: false,
  auditionAnnotationId: null,
  auditionSelection: null,
  auditionSelectionKey: null,
  auditionPlaybackMode: null,
  auditionLoop: false,
  auditionStopTimer: null,
  playbackRate: Number(localStorage.getItem("music-analyser-playback-rate")) || 1,
  annotationPrompts: localStorage.getItem("music-analyser-annotation-prompts") === "on",
  activePromptId: null,
  activeBandPreset: null,
  isFocusedView: false,
  resizeTimer: null,
  pendingAttachmentId: null,
  undoStack: [],
  redoStack: [],
  lastCreatedAnnotationId: null,
  // The grid keeps the musical coordinate system separate from the audio.
  // Correcting it never moves or changes the recording or any saved selection.
  rhythmGrid: null,
  detectedRhythmGrid: null,
  spectrogramRaster: null,
  spectrogramDetailTimer: null,
};

// Keeping page references together makes later functions shorter and easier to read.
const ui = {
  root: document.documentElement,
  audioInput: document.querySelector("#audioInput"),
  audioDropzone: document.querySelector("#audioDropzone"),
  sessionInput: document.querySelector("#sessionInput"),
  audio: document.querySelector("#audioElement"),
  emptyState: document.querySelector("#emptyState"),
  analysisState: document.querySelector("#analysisState"),
  projectStatus: document.querySelector("#projectStatus"),
  statusGroup: document.querySelector(".topbar__status"),
  newAnalysisButton: document.querySelector("#newAnalysisButton"),
  loadSessionButton: document.querySelector("#loadSessionButton"),
  saveSessionButton: document.querySelector("#saveSessionButton"),
  shareAnalysisButton: document.querySelector("#shareAnalysisButton"),
  sessionShareDialog: document.querySelector("#sessionShareDialog"),
  sessionShareForm: document.querySelector("#sessionShareForm"),
  sessionShareDialogTitle: document.querySelector("#sessionShareDialogTitle"),
  sessionShareCancel: document.querySelector("#sessionShareCancel"),
  sessionAudioLinkInput: document.querySelector("#sessionAudioLinkInput"),
  sessionShareSubmit: document.querySelector("#sessionShareForm button[type=submit]"),
  sharedAudioDialog: document.querySelector("#sharedAudioDialog"),
  sharedAudioClose: document.querySelector("#sharedAudioClose"),
  sharedAudioDownloadLink: document.querySelector("#sharedAudioDownloadLink"),
  sharedAudioChooseButton: document.querySelector("#sharedAudioChooseButton"),
  themeButton: document.querySelector("#themeButton"),
  recentAnalysesList: document.querySelector("#recentAnalysesList"),
  artworkFrame: document.querySelector("#artworkFrame"),
  albumArtwork: document.querySelector("#albumArtwork"),
  artistName: document.querySelector("#artistName"),
  trackTitle: document.querySelector("#trackTitle"),
  durationValue: document.querySelector("#durationValue"),
  sampleRateValue: document.querySelector("#sampleRateValue"),
  peakLevelValue: document.querySelector("#peakLevelValue"),
  lufsValue: document.querySelector("#lufsValue"),
  rmsLevelValue: document.querySelector("#rmsLevelValue"),
  annotationCount: document.querySelector("#annotationCount"),
  playButton: document.querySelector("#playButton"),
  loopButton: document.querySelector("#loopButton"),
  metronomeButton: document.querySelector("#metronomeButton"),
  playbackSpeedSelect: document.querySelector("#playbackSpeedSelect"),
  currentTime: document.querySelector("#currentTime"),
  totalTime: document.querySelector("#totalTime"),
  seekSlider: document.querySelector("#seekSlider"),
  volumeSlider: document.querySelector("#volumeSlider"),
  waveformFrame: document.querySelector("#waveformFrame"),
  waveformCanvas: document.querySelector("#waveformCanvas"),
  waveformAnnotationRegionsLayer: document.querySelector("#waveformAnnotationRegionsLayer"),
  waveSelection: document.querySelector("#waveSelection"),
  wavePlayhead: document.querySelector("#wavePlayhead"),
  spectrogramFrame: document.querySelector("#spectrogramFrame"),
  spectrogramCanvas: document.querySelector("#spectrogramCanvas"),
  annotationRegionsLayer: document.querySelector("#annotationRegionsLayer"),
  spectrogramSelection: document.querySelector("#spectrogramSelection"),
  spectrumPlayhead: document.querySelector("#spectrumPlayhead"),
  showAnnotationsButton: document.querySelector("#showAnnotationsButton"),
  activeBandOverlay: document.querySelector("#activeBandOverlay"),
  spectrumBandControls: document.querySelector("#spectrumBandControls"),
  frequencyScale: document.querySelector(".frequency-scale"),
  timeRuler: document.querySelector("#timeRuler"),
  rulerPrimaryLabel: document.querySelector("#rulerPrimaryLabel"),
  rulerSecondaryLabel: document.querySelector("#rulerSecondaryLabel"),
  waveformBeatGrid: document.querySelector("#waveformBeatGrid"),
  spectrogramBeatGrid: document.querySelector("#spectrogramBeatGrid"),
  levelMeterCanvas: document.querySelector("#levelMeterCanvas"),
  selectionTime: document.querySelector("#selectionTime"),
  selectionFrequency: document.querySelector("#selectionFrequency"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  annotationForm: document.querySelector("#annotationForm"),
  categorySelect: document.querySelector("#categorySelect"),
  noteInput: document.querySelector("#noteInput"),
  addButton: document.querySelector(".add-button"),
  customCategoryRow: document.querySelector("#customCategoryRow"),
  customCategoryInput: document.querySelector("#customCategoryInput"),
  saveCategoryButton: document.querySelector("#saveCategoryButton"),
  filterSelect: document.querySelector("#filterSelect"),
  annotationSearch: document.querySelector("#annotationSearch"),
  annotationPromptsButton: document.querySelector("#annotationPromptsButton"),
  annotationPrompt: document.querySelector("#annotationPrompt"),
  hoverRegionsButton: document.querySelector("#hoverRegionsButton"),
  hoverConnectorOverlay: document.querySelector("#hoverConnectorOverlay"),
  hoverConnectorPath: document.querySelector("#hoverConnectorPath"),
  focusedViewButton: document.querySelector("#focusedViewButton"),
  rhythmGridToggle: document.querySelector("#rhythmGridToggle"),
  rhythmGridSummary: document.querySelector("#rhythmGridSummary"),
  rhythmGridPanel: document.querySelector("#rhythmGridPanel"),
  rhythmGridStatus: document.querySelector("#rhythmGridStatus"),
  bpmInput: document.querySelector("#bpmInput"),
  barMarkerOpacityInput: document.querySelector("#barMarkerOpacityInput"),
  barMarkerOpacityValue: document.querySelector("#barMarkerOpacityValue"),
  halveTempoButton: document.querySelector("#halveTempoButton"),
  doubleTempoButton: document.querySelector("#doubleTempoButton"),
  beatsPerBarSelect: document.querySelector("#beatsPerBarSelect"),
  reanalyseTempoButton: document.querySelector("#reanalyseTempoButton"),
  resetTempoButton: document.querySelector("#resetTempoButton"),
  setBarOneButton: document.querySelector("#setBarOneButton"),
  gridEarlierButton: document.querySelector("#gridEarlierButton"),
  gridLaterButton: document.querySelector("#gridLaterButton"),
  beatEarlierButton: document.querySelector("#beatEarlierButton"),
  beatLaterButton: document.querySelector("#beatLaterButton"),
  barEarlierButton: document.querySelector("#barEarlierButton"),
  barLaterButton: document.querySelector("#barLaterButton"),
  timeline: document.querySelector("#timeline"),
  timelineEmpty: document.querySelector("#timelineEmpty"),
  timelineSummary: document.querySelector("#timelineSummary"),
  copyButton: document.querySelector("#copyButton"),
  sectionMarkerForm: document.querySelector("#sectionMarkerForm"),
  arrangementTrack: document.querySelector("#arrangementTrack"),
  arrangementSummary: document.querySelector("#arrangementSummary"),
  quickNoteForm: document.querySelector("#quickNoteForm"),
  quickNoteClose: document.querySelector("#quickNoteClose"),
  quickNoteRange: document.querySelector("#quickNoteRange"),
  quickCategorySelect: document.querySelector("#quickCategorySelect"),
  quickCustomCategoryRow: document.querySelector("#quickCustomCategoryRow"),
  quickCustomCategoryInput: document.querySelector("#quickCustomCategoryInput"),
  quickSaveCategoryButton: document.querySelector("#quickSaveCategoryButton"),
  quickNoteInput: document.querySelector("#quickNoteInput"),
  toast: document.querySelector("#toast"),
};

let toastTimer = null;
// The same dialog is used by File > Save Session and the visible share action.
let sessionExportMode = "save";

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove("is-visible"), 2200);
}

// The full status remains available as a tooltip while CSS truncates the
// visible line whenever the menu actions need more room.
function setProjectStatus(message) {
  ui.projectStatus.textContent = message;
  ui.projectStatus.title = message;
}

// A history snapshot is deliberately small: it stores the editable analysis,
// not the decoded audio, canvases, or playback state.
function analysisSnapshot() {
  return JSON.stringify({
    annotations: state.annotations,
    sections: state.sections,
    categories: state.categories,
    rhythmGrid: state.rhythmGrid,
  });
}

function rememberUndoPoint() {
  const snapshot = analysisSnapshot();
  if (state.undoStack.at(-1) !== snapshot) state.undoStack.push(snapshot);
  if (state.undoStack.length > 80) state.undoStack.shift();
  state.redoStack = [];
}

function restoreHistorySnapshot(snapshot) {
  const saved = JSON.parse(snapshot);
  state.annotations = Array.isArray(saved.annotations) ? saved.annotations.map(normaliseAnnotation) : [];
  state.sections = Array.isArray(saved.sections) ? saved.sections.filter(isUsableSelection).map(normaliseSection) : [];
  state.categories = Array.isArray(saved.categories) ? [...new Set([...DEFAULT_CATEGORIES, ...saved.categories])] : [...DEFAULT_CATEGORIES];
  if (isUsableRhythmGrid(saved.rhythmGrid)) state.rhythmGrid = normaliseRhythmGrid(saved.rhythmGrid);
  state.selection = null;
  state.selectedAnnotationId = null;
  state.editingId = null;
  state.pendingAttachmentId = null;
  renderCategoryOptions();
  syncRhythmGridUi();
  drawTimeRuler();
  drawBeatGridOverlays();
  renderTimeline();
  renderArrangement();
  saveProject();
  resyncMetronome();
}

function undoAnalysis() {
  const previous = state.undoStack.pop();
  if (!previous) return showToast("nothing to undo");
  state.redoStack.push(analysisSnapshot());
  restoreHistorySnapshot(previous);
  showToast("undone");
}

function redoAnalysis() {
  const next = state.redoStack.pop();
  if (!next) return showToast("nothing to redo");
  state.undoStack.push(analysisSnapshot());
  restoreHistorySnapshot(next);
  showToast("redone");
}

// Theme choice is remembered separately from individual analysis projects.
function applyTheme(theme) {
  ui.root.dataset.theme = theme;
  ui.themeButton.textContent = theme === "night" ? "[ ● night ]" : "[ ○ day ]";
  localStorage.setItem("music-analyser-theme", theme);
  if (state.audioBuffer) {
    drawWaveform();
    drawSpectrogram();
    drawLevelMeterFrame(...state.meterLevels);
  }
}

applyTheme(localStorage.getItem("music-analyser-theme") || "day");

// ---------- 2. Loading and decoding audio ----------

ui.audioInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (file) await loadAudioFile(file);
});

// The whole empty field accepts a dropped recording, while still keeping a normal file input.
["dragenter", "dragover"].forEach((eventName) => ui.audioDropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  ui.audioDropzone.classList.add("is-dragging");
}));
["dragleave", "drop"].forEach((eventName) => ui.audioDropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  ui.audioDropzone.classList.remove("is-dragging");
}));
ui.audioDropzone.addEventListener("drop", async (event) => {
  const file = [...event.dataTransfer.files].find((candidate) => candidate.type.startsWith("audio/"));
  if (file) await loadAudioFile(file);
  else showToast("drop an audio file here");
});

async function loadAudioFile(file, nativeDetails = {}) {
  setProjectStatus("decoding recording…");
  showToast("decoding recording…");
  // A previous recording may still be playing while a new file is chosen.
  // Stop both transports before replacing their shared timeline.
  pauseAudioTransport();

  try {
    const nativePath = nativeDetails.path || await pathForFile(file);
    const metadata = nativeDetails.metadata || await metadataForPath(nativePath);
    const rawAudio = await file.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextClass();
    const decoded = await audioContext.decodeAudioData(rawAudio.slice(0));
    await audioContext.close();

    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = URL.createObjectURL(file);
    state.audioBuffer = decoded;
    state.fileName = file.name.replace(/\.[^.]+$/, "");
    state.filePath = nativePath || "";
    state.legacyFileIdentity = `${file.name}::${file.size}::${file.lastModified}`;
    state.fileIdentity = state.filePath ? `${state.filePath}::${file.size}::${file.lastModified}` : state.legacyFileIdentity;
    const parsedIdentity = parseTrackIdentity(state.fileName);
    state.artistName = metadata.artist || metadata.albumArtist || parsedIdentity.artist;
    state.trackTitle = metadata.title || parsedIdentity.title;
    state.artworkDataUrl = metadata.artwork || "";
    state.artworkThumbnailDataUrl = await createArtworkThumbnail(state.artworkDataUrl);
    state.audioDownloadUrl = "";
    state.selection = null;
    state.sections = [];
    state.hoveredAnnotation = null;
    state.hoveredCard = null;
    state.selectedAnnotationId = null;
    state.editingId = null;
    state.pendingAttachmentId = null;
    state.undoStack = [];
    state.redoStack = [];
    state.spectrogramRaster = null;

    // These are whole-track calculations, so the status changes before they
    // begin. Yielding one frame lets Electron paint that message first.
    setProjectStatus("analysing tempo, loudness and spectrum…");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const detectedGrid = normaliseRhythmGrid(analyseTempo(decoded));
    state.detectedRhythmGrid = { ...detectedGrid, confidence: { ...detectedGrid.confidence } };
    state.rhythmGrid = { ...detectedGrid, confidence: { ...detectedGrid.confidence } };
    const spectrumSettings = spectrogramSettingsForViewport(decoded.duration);
    installSpectrogramData(analyseSpectrogram(decoded, spectrumSettings));
    const loudness = analyseLoudness(decoded);

    ui.audio.src = state.audioUrl;
    ui.audio.volume = Number(ui.volumeSlider.value);
    // Chromium performs its built-in real-time time stretch when playbackRate
    // changes. Explicit pitch preservation keeps musical pitch stable.
    ui.audio.preservesPitch = true;
    ui.audio.playbackRate = state.playbackRate;
    ui.playbackSpeedSelect.value = String(state.playbackRate);
    ui.seekSlider.max = String(decoded.duration);
    ui.durationValue.textContent = formatTime(decoded.duration, false);
    ui.sampleRateValue.textContent = `${(decoded.sampleRate / 1000).toFixed(1)} khz`;
    ui.peakLevelValue.textContent = formatDecibels(loudness.peakDb);
    ui.lufsValue.textContent = formatLufs(loudness.lufs);
    ui.rmsLevelValue.textContent = formatDecibels(loudness.rmsDb);
    ui.totalTime.textContent = formatTime(decoded.duration, true);
    ui.currentTime.textContent = formatTime(0, true);
    ui.saveSessionButton.disabled = false;
    ui.shareAnalysisButton.disabled = false;
    ui.statusGroup.classList.add("is-active");
    ui.emptyState.hidden = true;
    ui.analysisState.hidden = false;

    restoreProject();
    if (state.pendingSession) {
      applySessionData(state.pendingSession);
      state.pendingSession = null;
    }
    syncTrackIdentity();
    // Saving immediately makes artwork and the zero-note project appear in
    // Recent Analyses before the listener writes their first annotation.
    saveProject();
    renderCategoryOptions();
    syncRhythmGridUi();
    renderTimeline();
    updateSelectionDisplay();

    // The page needs one layout frame before canvas widths can be measured correctly.
    requestAnimationFrame(() => {
      drawAllVisuals();
      showToast("recording ready");
    });
  } catch (error) {
    console.error("Audio decoding failed:", error);
    setProjectStatus("could not load recording");
    showToast("could not decode this audio file");
  } finally {
    ui.audioInput.value = "";
  }
}

async function pathForFile(file) {
  try {
    return nativeAudioApi?.getPathForFile ? nativeAudioApi.getPathForFile(file) : "";
  } catch {
    return "";
  }
}

async function metadataForPath(filePath) {
  if (!filePath || !nativeAudioApi?.readAudioMetadata) return {};
  try {
    return await nativeAudioApi.readAudioMetadata(filePath);
  } catch (error) {
    console.warn("Native audio metadata failed:", error);
    return {};
  }
}

async function createArtworkThumbnail(dataUrl) {
  if (!dataUrl) return "";
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    canvas.getContext("2d").drawImage(image, 0, 0, 48, 48);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return "";
  }
}

function parseTrackIdentity(fileName) {
  const parts = fileName.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts.shift(), title: parts.join(" — ") };
  return { artist: "unknown artist", title: fileName || "untitled track" };
}

function syncTrackIdentity() {
  ui.artistName.value = state.artistName;
  ui.trackTitle.value = state.trackTitle;
  setProjectStatus(`${state.artistName} · ${state.trackTitle}`);
  ui.artworkFrame.hidden = !state.artworkDataUrl;
  ui.albumArtwork.src = state.artworkDataUrl || "";
  ui.albumArtwork.alt = state.artworkDataUrl ? `${state.artistName} ${state.trackTitle} artwork` : "";
}

[ui.artistName, ui.trackTitle].forEach((input) => input.addEventListener("input", () => {
  state.artistName = ui.artistName.value.trim() || "unknown artist";
  state.trackTitle = ui.trackTitle.value.trim() || state.fileName || "untitled track";
  setProjectStatus(`${state.artistName} · ${state.trackTitle}`);
  saveProject();
}));

ui.newAnalysisButton.addEventListener("click", () => {
  ui.audioInput.click();
});

ui.saveSessionButton.addEventListener("click", () => openSessionExportDialog("save"));
ui.shareAnalysisButton.addEventListener("click", () => openSessionExportDialog("share"));

// Session files hold the editable analysis, while the matching audio stays in
// the sender's own cloud folder or storage service.
function buildSessionData() {
  return {
    format: "music-analyser-session",
    version: 3,
    savedAt: new Date().toISOString(),
    audioDownloadUrl: state.audioDownloadUrl || null,
    track: {
      fileName: state.fileName,
      fileIdentity: state.fileIdentity,
      duration: state.audioBuffer.duration,
      sampleRate: state.audioBuffer.sampleRate,
      artist: state.artistName,
      title: state.trackTitle,
      filePath: state.filePath,
    },
    categories: state.categories,
    annotations: state.annotations,
    sections: state.sections,
    rhythmGrid: state.rhythmGrid,
  };
}

function openSessionExportDialog(mode) {
  if (!state.audioBuffer) return;
  sessionExportMode = mode;
  ui.sessionAudioLinkInput.value = state.audioDownloadUrl;
  ui.sessionAudioLinkInput.setCustomValidity("");
  ui.sessionShareDialogTitle.textContent = mode === "share" ? "share editable session" : "save session";
  ui.sessionShareSubmit.textContent = mode === "share" ? "share JSON session" : "save JSON session";
  if (!ui.sessionShareDialog.open) ui.sessionShareDialog.showModal();
  window.setTimeout(() => ui.sessionAudioLinkInput.focus(), 0);
}

// Only web links are allowed here. This prevents a hand-edited session from
// turning the download button into a local-file or script link.
function normaliseSharedAudioUrl(value) {
  const rawUrl = String(value || "").trim();
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function sessionAudioDownloadUrl(session) {
  // The extra locations keep early hand-edited or future session files easy to
  // open, while new exports always use the clear top-level field above.
  return normaliseSharedAudioUrl(
    session?.audioDownloadUrl || session?.audio?.downloadUrl || session?.track?.audioDownloadUrl,
  );
}

ui.sessionAudioLinkInput.addEventListener("input", () => ui.sessionAudioLinkInput.setCustomValidity(""));
ui.sessionShareCancel.addEventListener("click", () => ui.sessionShareDialog.close());
ui.sessionShareForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const suppliedUrl = ui.sessionAudioLinkInput.value.trim();
  const audioDownloadUrl = normaliseSharedAudioUrl(suppliedUrl);
  if (suppliedUrl && !audioDownloadUrl) {
    ui.sessionAudioLinkInput.setCustomValidity("Use a full https:// link to the audio file.");
    ui.sessionAudioLinkInput.reportValidity();
    return;
  }

  state.audioDownloadUrl = audioDownloadUrl;
  saveProject();
  ui.sessionShareDialog.close();
  await exportSessionFile(sessionExportMode);
});

async function exportSessionFile(mode) {
  const fileName = `${safeAnalysisName()}.json`;
  const blob = new Blob([JSON.stringify(buildSessionData(), null, 2)], { type: "application/json" });
  if (mode === "share") {
    const file = new File([blob], fileName, { type: "application/json" });
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `${state.artistName} — ${state.trackTitle}`, text: "Editable Music Analyser session", files: [file] });
        showToast("JSON session shared");
        return;
      }
    } catch (error) {
      if (error.name === "AbortError") return;
      console.warn("Native session sharing was unavailable:", error);
    }
  }

  downloadBlob(blob, fileName);
  showToast(mode === "share" ? "shareable JSON session saved" : "session saved as JSON");
}

function safeAnalysisName() {
  return `${state.artistName}-${state.trackTitle}`.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "music-analysis";
}

function downloadBlob(blob, fileName) {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

ui.loadSessionButton.addEventListener("click", () => ui.sessionInput.click());

// The standalone app exposes Load and Save in the macOS File menu. Keeping the
// hidden buttons as the shared action targets avoids duplicating session logic.
nativeAudioApi?.onMenuAction?.((action) => {
  if (action === "load-session") ui.loadSessionButton.click();
  if (action === "save-session" && !ui.saveSessionButton.disabled) ui.saveSessionButton.click();
});

ui.sessionInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const session = JSON.parse(await file.text());
    if (session?.format !== "music-analyser-session" || !Array.isArray(session.annotations)) throw new Error("Unsupported session format");

    if (!state.audioBuffer) {
      state.pendingSession = session;
      setProjectStatus(`session ready · drop ${session.track?.fileName || "the matching audio file"}`);
      if (showSharedAudioDialog(session)) {
        showToast("session loaded — download or choose the matching audio file");
      } else {
        showToast("session loaded — now drop the matching audio file");
      }
    } else {
      const durationMatches = Math.abs((session.track?.duration || 0) - state.audioBuffer.duration) < 1;
      if (!durationMatches && !window.confirm("This session appears to belong to a different recording. Load its annotations anyway?")) return;
      applySessionData(session);
      syncTrackIdentity();
      renderCategoryOptions();
      renderTimeline();
      showToast("session restored");
    }
  } catch (error) {
    console.warn("Session import failed:", error);
    showToast("this JSON file is not a valid session");
  } finally {
    ui.sessionInput.value = "";
  }
});

function showSharedAudioDialog(session) {
  const audioDownloadUrl = sessionAudioDownloadUrl(session);
  if (!audioDownloadUrl) return false;
  ui.sharedAudioDownloadLink.href = audioDownloadUrl;
  if (!ui.sharedAudioDialog.open) ui.sharedAudioDialog.showModal();
  return true;
}

ui.sharedAudioClose.addEventListener("click", () => ui.sharedAudioDialog.close());
ui.sharedAudioChooseButton.addEventListener("click", () => {
  ui.sharedAudioDialog.close();
  ui.audioInput.click();
});

function applySessionData(session) {
  state.annotations = session.annotations
    .filter((annotation) => Number.isFinite(annotation.start) && Number.isFinite(annotation.end))
    .map(normaliseAnnotation);
  state.sections = Array.isArray(session.sections)
    ? session.sections.filter(isUsableSelection).map(normaliseSection)
    : [];
  // Including categories found inside notes keeps older or hand-edited session files usable.
  const annotationCategories = state.annotations.map((annotation) => annotation.category).filter(Boolean);
  state.categories = [...new Set([...DEFAULT_CATEGORIES, ...(Array.isArray(session.categories) ? session.categories : []), ...annotationCategories])];
  state.artistName = session.track?.artist || state.artistName;
  state.trackTitle = session.track?.title || state.trackTitle;
  state.filePath = session.track?.filePath || state.filePath;
  state.audioDownloadUrl = sessionAudioDownloadUrl(session);
  if (isUsableRhythmGrid(session.rhythmGrid)) state.rhythmGrid = normaliseRhythmGrid(session.rhythmGrid);
  state.selection = null;
  state.selectedAnnotationId = null;
  syncRhythmGridUi();
  saveProject();
  resyncMetronome();
}

// Arrangement markers use only a time span and a chapter name. Keeping their
// shape small makes older hand-edited session files easy to understand.
function normaliseSection(section) {
  return {
    id: section.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    name: String(section.name || "Section 1").trim() || "Section 1",
    colour: sectionColour(section.colour),
    start: Number(section.start),
    end: Number(section.end),
  };
}

function sectionColour(colour) {
  // Older sessions did not save a colour, so they receive the original blue.
  return SECTION_COLOURS.includes(colour) ? colour : SECTION_COLOURS[0];
}

function normaliseAnnotation(annotation) {
  return {
    ...annotation,
    links: Array.isArray(annotation.links)
      ? annotation.links.filter(isUsableSelection).map(normaliseLinkedSelection)
      : [],
  };
}

function isUsableSelection(selection) {
  return Number.isFinite(selection?.start) && Number.isFinite(selection?.end) && selection.end > selection.start;
}

function normaliseLinkedSelection(selection) {
  return {
    id: selection.id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    start: selection.start,
    end: selection.end,
    source: selection.source === "spectrogram" ? "spectrogram" : "waveform",
    minFrequency: selection.source === "spectrogram" ? selection.minFrequency : null,
    maxFrequency: selection.source === "spectrogram" ? selection.maxFrequency : null,
  };
}

// Standard media controls update both the audio element and our visual playhead.
ui.playButton.addEventListener("click", async () => {
  if (!state.audioBuffer) return;
  if (ui.audio.paused) {
    // Start both operations inside the same user gesture so Chrome grants audio playback.
    const meterReady = ensurePlaybackMeter();
    state.auditionAnnotationId = null;
    state.auditionSelection = null;
    state.auditionSelectionKey = null;
    state.auditionPlaybackMode = null;
    state.auditionLoop = false;
    resetAuditionFilter();
    updateAuditionButtons();
    const playbackStarted = ui.audio.play();
    try {
      await Promise.all([meterReady, playbackStarted]);
    } catch (error) {
      console.warn("Playback could not start:", error);
      showToast("playback could not start");
    }
  } else {
    pauseAudioTransport();
  }
});

ui.audio.addEventListener("play", () => {
  ui.playButton.textContent = "pause";
  startLevelMeter();
  updateAuditionButtons();
});
// `playing` is later and more useful than `play`: it means decoded audio has
// actually resumed after any seek or buffering pause. Only then is it safe to
// attach a fresh metronome clock anchor to the new play position.
ui.audio.addEventListener("playing", () => {
  if (state.isScrubbingSeek) return;
  if (state.metronomeNeedsTransportSync) {
    // Start the clock check from the moment sound is reported as flowing. The
    // check itself still verifies that both clocks advance together.
    confirmMetronomeTransportAfterSeek();
  } else {
    void startMetronomeScheduler();
  }
});
ui.audio.addEventListener("pause", () => {
  ui.playButton.textContent = "play";
  state.metronomeNeedsTransportSync = false;
  stopMetronomeScheduler();
  clearAuditionStopTimer();
  state.auditionAnnotationId = null;
  state.auditionSelection = null;
  state.auditionSelectionKey = null;
  state.auditionPlaybackMode = null;
  state.auditionLoop = false;
  resetAuditionFilter();
  updateAuditionButtons();
  updateAnnotationPrompt();
});
ui.audio.addEventListener("ended", () => {
  ui.playButton.textContent = "play";
  state.metronomeNeedsTransportSync = false;
  stopMetronomeScheduler();
  clearAuditionStopTimer();
  state.auditionAnnotationId = null;
  state.auditionSelection = null;
  state.auditionSelectionKey = null;
  state.auditionPlaybackMode = null;
  state.auditionLoop = false;
  resetAuditionFilter();
  updateAuditionButtons();
  updateAnnotationPrompt();
});

ui.audio.addEventListener("timeupdate", () => {
  if (!state.audioBuffer) return;

  const audition = state.auditionSelection;
  if (audition && ui.audio.currentTime >= audition.end) {
    handleAuditionBoundary();
  } else if (state.loopSelection && state.selection && ui.audio.currentTime >= state.selection.end) {
    // When looping is active, jump back as soon as playback reaches the selected end.
    seekAudioTo(state.selection.start);
    if (ui.audio.paused) ui.audio.play();
  }

  updatePlayhead(ui.audio.currentTime);
  updateAnnotationPrompt();
});

function beginSeekScrub() {
  if (state.isScrubbingSeek) return;
  state.isScrubbingSeek = true;
  markMetronomeTransportUnsettled();
}

function finishSeekScrub() {
  if (!state.isScrubbingSeek) return;
  state.isScrubbingSeek = false;
  if (ui.audio.paused) {
    state.metronomeNeedsTransportSync = false;
  } else if (!ui.audio.seeking) {
    confirmMetronomeTransportAfterSeek();
  }
}

// While the thumb is being dragged, every input is a new seek target. The old
// clicks are cancelled before currentTime changes, and scheduling resumes only
// after the final target has begun advancing with the recording clock.
ui.seekSlider.addEventListener("pointerdown", beginSeekScrub);
ui.seekSlider.addEventListener("input", () => {
  beginSeekScrub();
  const seekTime = seekAudioTo(Number(ui.seekSlider.value));
  updatePlayhead(seekTime);
});
["change", "pointerup", "pointercancel", "blur"].forEach((eventName) => {
  ui.seekSlider.addEventListener(eventName, finishSeekScrub);
});

// Browser media events remain as a safety net for seeks started anywhere else.
// `waiting` also cancels future clicks if the recording temporarily runs dry.
ui.audio.addEventListener("seeking", markMetronomeTransportUnsettled);
ui.audio.addEventListener("waiting", markMetronomeTransportUnsettled);
ui.audio.addEventListener("seeked", () => {
  if (state.isScrubbingSeek) return;
  if (ui.audio.paused || !state.metronomeEnabled) {
    state.metronomeNeedsTransportSync = false;
    return;
  }
  confirmMetronomeTransportAfterSeek();
});
ui.audio.addEventListener("ratechange", resyncMetronome);
ui.audio.addEventListener("emptied", () => {
  state.metronomeNeedsTransportSync = false;
  stopMetronomeScheduler();
});

ui.volumeSlider.addEventListener("input", () => { ui.audio.volume = Number(ui.volumeSlider.value); });

ui.playbackSpeedSelect.addEventListener("change", () => {
  // Cancel clicks before changing the rate. The browser's `ratechange` event is
  // asynchronous, so relying on that event can leave one old-rate ping queued.
  stopMetronomeScheduler();
  state.playbackRate = Number(ui.playbackSpeedSelect.value) || 1;
  ui.audio.preservesPitch = true;
  ui.audio.playbackRate = state.playbackRate;
  localStorage.setItem("music-analyser-playback-rate", String(state.playbackRate));
  if (state.auditionSelection && !ui.audio.paused) scheduleAuditionBoundary();
  showToast(`${Math.round(state.playbackRate * 100)}% playback · pitch locked`);
});

ui.loopButton.addEventListener("click", () => {
  state.loopSelection = !state.loopSelection;
  ui.loopButton.setAttribute("aria-pressed", String(state.loopSelection));
  ui.loopButton.textContent = `loop selection: ${state.loopSelection ? "on" : "off"}`;
  if (state.loopSelection && !state.selection) showToast("select a time range to loop");
});

function syncMetronomeButton() {
  ui.metronomeButton.setAttribute("aria-pressed", String(state.metronomeEnabled));
  ui.metronomeButton.textContent = `metronome: ${state.metronomeEnabled ? "on" : "off"}`;
  ui.metronomeButton.title = state.metronomeEnabled
    ? "Following the current grid · higher ping marks beat 1"
    : "Follow the current tempo and bar grid";
}

ui.metronomeButton.addEventListener("click", async () => {
  state.metronomeEnabled = !state.metronomeEnabled;
  localStorage.setItem("music-analyser-metronome", state.metronomeEnabled ? "on" : "off");
  syncMetronomeButton();

  if (!state.metronomeEnabled) {
    state.metronomeNeedsTransportSync = false;
    stopMetronomeScheduler();
    showToast("metronome off");
    return;
  }

  // The button press is a user gesture, so it is the safest time to unlock the
  // browser audio clock even when the track is currently paused.
  try {
    await ensurePlaybackMeter();
    if (!ui.audio.paused) {
      if (state.metronomeNeedsTransportSync) confirmMetronomeTransportAfterSeek();
      else void startMetronomeScheduler();
    }
    showToast("metronome on · higher ping marks beat 1");
  } catch (error) {
    console.warn("Metronome audio could not start:", error);
    showToast("metronome will start with playback");
  }
});

// Pitch preservation is deliberately explicit even though modern Chromium
// enables it by default. This guards the musical behaviour across app updates.
ui.playbackSpeedSelect.value = String(state.playbackRate);
ui.audio.preservesPitch = true;
ui.audio.playbackRate = state.playbackRate;
syncMetronomeButton();
syncBarMarkerOpacity();

function syncAnnotationPromptsButton() {
  ui.annotationPromptsButton.setAttribute("aria-pressed", String(state.annotationPrompts));
  ui.annotationPromptsButton.textContent = `read ahead: ${state.annotationPrompts ? "on" : "off"}`;
  if (!state.annotationPrompts) {
    state.activePromptId = null;
    ui.annotationPrompt.hidden = true;
  }
}

ui.annotationPromptsButton.addEventListener("click", () => {
  state.annotationPrompts = !state.annotationPrompts;
  localStorage.setItem("music-analyser-annotation-prompts", state.annotationPrompts ? "on" : "off");
  syncAnnotationPromptsButton();
  updateAnnotationPrompt();
});

function updateAnnotationPrompt() {
  if (!state.annotationPrompts || ui.audio.paused || !state.annotations.length) {
    ui.annotationPrompt.hidden = true;
    state.activePromptId = null;
    return;
  }

  const now = ui.audio.currentTime;
  const lead = ANNOTATION_PROMPT_LEAD_SECONDS * state.playbackRate;
  const candidates = state.annotations
    .filter((annotation) => now >= Math.max(0, annotation.start - lead) && now <= annotation.end)
    .sort((first, second) => first.start - second.start || first.end - second.end);
  const annotation = candidates[0];
  if (!annotation) {
    ui.annotationPrompt.hidden = true;
    state.activePromptId = null;
    return;
  }

  if (state.activePromptId !== annotation.id) {
    state.activePromptId = annotation.id;
    ui.annotationPrompt.replaceChildren();
    const meta = document.createElement("div");
    meta.className = "annotation-prompt__meta";
    const category = document.createElement("span");
    category.textContent = annotation.category;
    const time = document.createElement("span");
    time.textContent = formatMusicalRange(annotation.start, annotation.end, false);
    time.title = `${formatTime(annotation.start, true)} — ${formatTime(annotation.end, true)}`;
    meta.append(category, time);
    const note = document.createElement("p");
    note.textContent = annotation.note;
    ui.annotationPrompt.append(meta, note);
    ui.annotationPrompt.style.setProperty("--prompt-colour", categoryColour(annotation.category));
  }
  ui.annotationPrompt.hidden = false;
}

syncAnnotationPromptsButton();

function syncBandControls() {
  ui.spectrumBandControls.querySelectorAll("button[data-band]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.band === state.activeBandPreset));
  });

  const preset = BAND_PRESETS[state.activeBandPreset];
  if (!preset || !state.audioBuffer) {
    ui.activeBandOverlay.hidden = true;
    return;
  }
  const nyquist = state.audioBuffer.sampleRate / 2;
  const top = ratioFromFrequency(Math.min(preset.max, nyquist), nyquist) * 100;
  const bottom = ratioFromFrequency(Math.min(preset.min, nyquist), nyquist) * 100;
  ui.activeBandOverlay.style.top = `${top}%`;
  ui.activeBandOverlay.style.height = `${Math.max(0.5, bottom - top)}%`;
  ui.activeBandOverlay.hidden = false;
}

ui.spectrumBandControls.addEventListener("pointerdown", (event) => event.stopPropagation());
ui.spectrumBandControls.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-band]");
  if (!button) return;
  event.stopPropagation();
  state.activeBandPreset = state.activeBandPreset === button.dataset.band ? null : button.dataset.band;
  resetAuditionFilter();
  syncBandControls();
  showToast(state.activeBandPreset ? `${button.textContent} listening band on` : "listening band off");
  try {
    await ensurePlaybackMeter();
    resetAuditionFilter();
  } catch (error) {
    // The visual choice remains selected if a browser preview is still waiting
    // for audio permission; the filter is applied when playback starts.
    console.warn("Listening band will start with playback:", error);
  }
});

function updatePlayhead(seconds) {
  const duration = state.audioBuffer?.duration || 1;
  const percentage = Math.max(0, Math.min(100, (seconds / duration) * 100));
  // At the exact end, keep the two-pixel line inside the visible canvas edge.
  const position = percentage >= 100 ? "calc(100% - 2px)" : `${percentage}%`;
  ui.wavePlayhead.style.left = position;
  ui.spectrumPlayhead.style.left = position;
  // A normal playback update must not pull the range thumb away from the user
  // while they are choosing a new position.
  if (!state.isScrubbingSeek) ui.seekSlider.value = String(seconds);
  ui.currentTime.textContent = formatTime(seconds, true);
}

/*
  The audio element is connected to two analyser nodes the first time playback
  begins. An analyser only observes the signal; it does not change the sound.
*/
async function ensurePlaybackMeter() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!state.meterContext) {
    state.meterContext = new AudioContextClass();
    state.meterSource = state.meterContext.createMediaElementSource(ui.audio);
    const splitter = state.meterContext.createChannelSplitter(2);

    // Four high-pass and four low-pass biquads create a steep 48 dB/octave band-pass audition filter.
    const highPasses = Array.from({ length: 4 }, () => {
      const filter = state.meterContext.createBiquadFilter();
      filter.type = "highpass";
      filter.Q.value = 0.707;
      return filter;
    });
    const lowPasses = Array.from({ length: 4 }, () => {
      const filter = state.meterContext.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.707;
      return filter;
    });
    state.filterNodes = [...highPasses, ...lowPasses];

    state.meterAnalysers = [0, 1].map((channel) => {
      const analyser = state.meterContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      splitter.connect(analyser, channel);
      return analyser;
    });

    state.meterSource.connect(state.filterNodes[0]);
    state.filterNodes.forEach((filter, index) => {
      const next = state.filterNodes[index + 1];
      if (next) filter.connect(next);
    });
    const filteredOutput = state.filterNodes[state.filterNodes.length - 1];
    filteredOutput.connect(splitter);
    filteredOutput.connect(state.meterContext.destination);
    resetAuditionFilter();
  }

  if (state.meterContext.state === "suspended") await state.meterContext.resume();
}

/*
  METRONOME PLAYBACK

  JavaScript timers are useful for checking what should happen next, but they
  are not accurate enough to make the sound themselves. Every 25 ms, this
  scheduler asks the tested helper for beats inside a short future window and
  places each ping on the Web Audio clock. That clock then plays the click at
  the requested instant even if the next timer check is a few milliseconds late.
*/
async function startMetronomeScheduler() {
  stopMetronomeScheduler();
  if (!state.metronomeEnabled
    || !state.audioBuffer
    || !state.rhythmGrid
    || ui.audio.paused
    || ui.audio.seeking
    || state.isScrubbingSeek
    || state.metronomeNeedsTransportSync) return;

  // A generation number prevents two nearly simultaneous play events from
  // leaving two timers running after their shared AudioContext resumes.
  const generation = state.metronomeGeneration;
  try {
    await ensurePlaybackMeter();
  } catch (error) {
    console.warn("Metronome clock could not start:", error);
    return;
  }

  const snapshot = currentMetronomePlaybackSnapshot();
  if (generation !== state.metronomeGeneration || !metronomeCanSchedule(snapshot)) return;

  // This anchor remains stable during ordinary playback. Reusing one mapping
  // prevents small currentTime read variations from nudging each click window.
  state.metronomeAnchor = {
    mediaTimeSeconds: snapshot.mediaTimeSeconds,
    wallClockSeconds: snapshot.wallClockSeconds,
    playbackRate: snapshot.playbackRate,
  };

  scheduleMetronomeWindow();
  if (state.metronomeAnchor) {
    state.metronomeTimer = window.setInterval(scheduleMetronomeWindow, METRONOME_TIMER_MS);
  }
}

function stopMetronomeScheduler() {
  state.metronomeGeneration += 1;
  if (state.metronomeTimer !== null) window.clearInterval(state.metronomeTimer);
  if (state.metronomeTransportTimer !== null) window.clearTimeout(state.metronomeTransportTimer);
  state.metronomeTimer = null;
  state.metronomeTransportTimer = null;
  state.metronomeScheduledThrough = null;
  state.metronomeAnchor = null;

  // Oscillators placed slightly ahead of the playhead remain scheduled unless
  // they are explicitly stopped. Disconnecting them prevents an old-grid ping
  // after pause, seek, playback-speed change, or a manual tempo correction.
  state.metronomeScheduledClicks.forEach(({ oscillator, gain }) => {
    oscillator.onended = null;
    try { oscillator.stop(); } catch { /* It may already have finished naturally. */ }
    try { oscillator.disconnect(); } catch { /* A disconnected node is already silent. */ }
    try { gain.disconnect(); } catch { /* A disconnected node is already silent. */ }
  });
  state.metronomeScheduledClicks.clear();
}

function resyncMetronome() {
  const transportWasUnsettled = state.metronomeNeedsTransportSync
    || ui.audio.seeking
    || state.isScrubbingSeek
    || !audioHasFutureData();
  stopMetronomeScheduler();
  if (!state.metronomeEnabled || ui.audio.paused) {
    state.metronomeNeedsTransportSync = false;
    return;
  }

  state.metronomeNeedsTransportSync = transportWasUnsettled;
  if (transportWasUnsettled) {
    if (!state.isScrubbingSeek) confirmMetronomeTransportAfterSeek();
  } else {
    void startMetronomeScheduler();
  }
}

// Read the two clocks as close together as JavaScript allows. This small object
// is also passed through tested validation helpers in metronome.js.
function currentMetronomePlaybackSnapshot() {
  return {
    mediaTimeSeconds: Number(ui.audio.currentTime),
    wallClockSeconds: state.meterContext ? state.meterContext.currentTime : Number.NaN,
    playbackRate: Number(ui.audio.playbackRate) || 1,
    paused: ui.audio.paused,
    seeking: ui.audio.seeking,
    hasFutureData: audioHasFutureData(),
  };
}

function audioHasFutureData() {
  return ui.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

function metronomeCanSchedule(snapshot = currentMetronomePlaybackSnapshot()) {
  return state.metronomeEnabled
    && Boolean(state.audioBuffer)
    && Boolean(state.rhythmGrid)
    && !state.isScrubbingSeek
    && !state.metronomeNeedsTransportSync
    && snapshot.hasFutureData
    && playbackSnapshotCanSchedule(snapshot);
}

// Set this flag before changing currentTime. The browser sends its `seeking`
// event later, so waiting for that event alone can leave one old click queued.
function markMetronomeTransportUnsettled() {
  state.metronomeNeedsTransportSync = true;
  stopMetronomeScheduler();
}

function seekAudioTo(seconds) {
  if (!state.audioBuffer) return 0;
  const target = Math.max(0, Math.min(state.audioBuffer.duration, Number(seconds) || 0));
  markMetronomeTransportUnsettled();
  ui.audio.currentTime = target;
  return target;
}

function pauseAudioTransport() {
  // The pause event arrives later. Cancelling first prevents a click that is a
  // few milliseconds ahead from sounding after the recording has stopped.
  stopMetronomeScheduler();
  ui.audio.pause();
}

/*
  `seeked` says the requested position was found, but the recording may still
  be momentarily silent. We watch for media time to move, then check one more
  short interval. At that point the media clock and Web Audio clock describe
  the same resumed transport and can safely become the new click anchor.
*/
function confirmMetronomeTransportAfterSeek() {
  markMetronomeTransportUnsettled();
  if (!state.metronomeEnabled || !state.audioBuffer || !state.rhythmGrid || ui.audio.paused) {
    if (!state.metronomeEnabled || ui.audio.paused) state.metronomeNeedsTransportSync = false;
    return;
  }

  const generation = state.metronomeGeneration;
  let previousSnapshot = currentMetronomePlaybackSnapshot();
  let candidateAnchor = null;

  const scheduleNextTransportCheck = () => {
    state.metronomeTransportTimer = window.setTimeout(
      watchTransport,
      METRONOME_TRANSPORT_POLL_MS,
    );
  };

  const watchTransport = () => {
    state.metronomeTransportTimer = null;
    if (generation !== state.metronomeGeneration
      || !state.metronomeEnabled
      || ui.audio.paused
      || state.isScrubbingSeek) return;

    const snapshot = currentMetronomePlaybackSnapshot();
    if (!snapshot.hasFutureData || !playbackSnapshotCanSchedule(snapshot)) {
      previousSnapshot = snapshot;
      candidateAnchor = null;
      scheduleNextTransportCheck();
      return;
    }

    if (!candidateAnchor) {
      const mediaMoved = snapshot.mediaTimeSeconds > previousSnapshot.mediaTimeSeconds + 0.001;
      if (mediaMoved) {
        candidateAnchor = {
          mediaTimeSeconds: snapshot.mediaTimeSeconds,
          wallClockSeconds: snapshot.wallClockSeconds,
          playbackRate: snapshot.playbackRate,
        };
      }
      previousSnapshot = snapshot;
      scheduleNextTransportCheck();
      return;
    }

    if (transportAdvanceIsConfirmed(
      candidateAnchor,
      snapshot,
      METRONOME_TRANSPORT_CONFIRM_SECONDS,
      METRONOME_TRANSPORT_TOLERANCE_SECONDS,
    )) {
      state.metronomeNeedsTransportSync = false;
      void startMetronomeScheduler();
      return;
    }

    // Once a candidate has had enough time to prove itself, replace it if the
    // two clocks did not advance together and try the next moving sample.
    if (snapshot.wallClockSeconds - candidateAnchor.wallClockSeconds
      >= METRONOME_TRANSPORT_CONFIRM_SECONDS) {
      candidateAnchor = null;
      previousSnapshot = snapshot;
    }
    scheduleNextTransportCheck();
  };

  scheduleNextTransportCheck();
}

function scheduleMetronomeWindow() {
  const context = state.meterContext;
  const grid = state.rhythmGrid;
  const snapshot = currentMetronomePlaybackSnapshot();
  if (!grid || !context || !state.metronomeAnchor || !metronomeCanSchedule(snapshot)) return;

  // A seek can be visible in currentTime before a media event reaches us. The
  // anchor check catches that gap and immediately cancels the old click window.
  if (!playbackAnchorIsCurrent(
    state.metronomeAnchor,
    snapshot,
    METRONOME_ANCHOR_TOLERANCE_SECONDS,
  )) {
    confirmMetronomeTransportAfterSeek();
    return;
  }

  const mediaNow = snapshot.mediaTimeSeconds;
  const playbackRate = snapshot.playbackRate;
  const beatPeriod = 60 / grid.bpm;
  const lookaheadInMediaSeconds = METRONOME_LOOKAHEAD_SECONDS * playbackRate;
  const latestUsefulTime = Math.min(state.audioBuffer.duration, mediaNow + lookaheadInMediaSeconds);
  let windowStart = state.metronomeScheduledThrough;

  // If the browser delayed this timer or the media position jumped without a
  // seeking event, begin again at the live playhead rather than playing catch-up.
  const scheduleFellBehind = !Number.isFinite(windowStart)
    || windowStart < mediaNow - METRONOME_TIMER_MS * playbackRate / 1000;
  const scheduleJumpedAhead = Number.isFinite(windowStart)
    && windowStart > mediaNow + lookaheadInMediaSeconds + beatPeriod;
  if (scheduleFellBehind || scheduleJumpedAhead) windowStart = mediaNow;
  if (!(latestUsefulTime > windowStart)) return;

  const events = scheduleBeatEvents({
    fromMediaTimeSeconds: windowStart,
    toMediaTimeSeconds: latestUsefulTime,
    barOneAtSeconds: grid.barOneAtSeconds,
    beatPeriodSeconds: beatPeriod,
    beatsPerBar: grid.beatsPerBar,
    anchor: state.metronomeAnchor,
  });

  events.forEach((event) => {
    // Moving a late click forwards makes it sound off-grid. Skipping that one
    // beat keeps every audible click locked to its true musical position.
    if (event.wallClockSeconds >= context.currentTime + METRONOME_SCHEDULE_LEAD_SECONDS) {
      scheduleMetronomeClick(event.wallClockSeconds, event.isDownbeat);
    }
  });
  state.metronomeScheduledThrough = latestUsefulTime;
}

function scheduleMetronomeClick(startTime, isDownbeat) {
  const context = state.meterContext;
  if (!context) return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const duration = isDownbeat ? 0.065 : 0.045;
  const peakLevel = isDownbeat ? 0.24 : 0.13;
  const endTime = startTime + duration;

  // Beat 1 gets a higher, rounder ping. The remaining beats use a lower,
  // shorter triangle click so the bar is obvious without becoming intrusive.
  oscillator.type = isDownbeat ? "sine" : "triangle";
  oscillator.frequency.setValueAtTime(isDownbeat ? 1760 : 880, startTime);
  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(peakLevel, startTime + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, endTime);
  oscillator.connect(gain);
  // The click bypasses the spectrogram audition filters, so a Bass or Air
  // listening preset cannot accidentally remove the metronome.
  gain.connect(context.destination);

  const scheduledClick = { oscillator, gain };
  state.metronomeScheduledClicks.add(scheduledClick);
  oscillator.onended = () => {
    state.metronomeScheduledClicks.delete(scheduledClick);
    oscillator.disconnect();
    gain.disconnect();
  };
  oscillator.start(startTime);
  oscillator.stop(endTime + 0.01);
}

function resetAuditionFilter() {
  if (!state.filterNodes.length || !state.meterContext) return;
  const now = state.meterContext.currentTime;
  const nyquist = state.meterContext.sampleRate / 2;
  const preset = BAND_PRESETS[state.activeBandPreset];
  const lower = preset ? Math.max(20, Math.min(nyquist * 0.95, preset.min)) : 20;
  const upper = preset ? Math.max(lower + 10, Math.min(nyquist * 0.98, preset.max)) : nyquist * 0.98;
  state.filterNodes.forEach((filter) => {
    const frequency = filter.type === "highpass" ? lower : upper;
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setValueAtTime(frequency, now);
  });
}

function configureAuditionFilter(selection, mode) {
  resetAuditionFilter();
  if (mode !== "iso" || selection.source !== "spectrogram" || !state.filterNodes.length || !state.meterContext) return;
  const now = state.meterContext.currentTime;
  const nyquist = state.meterContext.sampleRate / 2;
  const lower = Math.max(20, Math.min(nyquist * 0.95, selection.minFrequency));
  const upper = Math.max(lower + 10, Math.min(nyquist * 0.98, selection.maxFrequency));
  state.filterNodes.forEach((filter) => {
    filter.frequency.cancelScheduledValues(now);
    filter.frequency.setValueAtTime(filter.type === "highpass" ? lower : upper, now);
  });
}

async function auditionAnnotation(annotation, mode = "full") {
  return auditionSelection(annotation, selectionFromAnnotation(annotation), mode, false, "primary");
}

// A region can be auditioned once or looped. Spectrogram regions use the same
// steep isolation filters as the former card-level "iso" control.
async function auditionSelection(annotation, selection, mode = "full", shouldLoop = false, selectionKey = "primary") {
  if (!state.audioBuffer) return;
  const sameAudition = state.auditionAnnotationId === annotation.id
    && state.auditionSelectionKey === selectionKey
    && state.auditionPlaybackMode === mode
    && state.auditionLoop === shouldLoop;
  if (sameAudition && !ui.audio.paused) {
    pauseAudioTransport();
    return;
  }

  const audioReady = ensurePlaybackMeter();
  clearAuditionStopTimer();
  // Clearing the last error makes browser diagnostics easier without adding anything to the visible interface.
  delete ui.audio.dataset.playbackError;
  configureAuditionFilter(selection, mode);
  state.auditionAnnotationId = annotation.id;
  state.auditionSelection = { ...selection };
  state.auditionSelectionKey = selectionKey;
  state.auditionPlaybackMode = mode;
  state.auditionLoop = shouldLoop;
  seekAudioTo(selection.start);
  updatePlayhead(selection.start);
  updateAuditionButtons();

  try {
    const playbackStarted = ui.audio.play();
    await Promise.all([audioReady, playbackStarted]);
    // timeupdate events are fairly slow, so this timer keeps short selections exact.
    scheduleAuditionBoundary();
  } catch (error) {
    console.warn("Annotation audition could not start:", error);
    ui.audio.dataset.playbackError = `${error.name}: ${error.message}`;
    state.auditionAnnotationId = null;
    state.auditionSelection = null;
    state.auditionSelectionKey = null;
    state.auditionPlaybackMode = null;
    state.auditionLoop = false;
    resetAuditionFilter();
    updateAuditionButtons();
    showToast("annotation playback could not start");
  }
}

function scheduleAuditionBoundary() {
  clearAuditionStopTimer();
  if (!state.auditionSelection || ui.audio.paused) return;
  const remainingTrackSeconds = Math.max(0, state.auditionSelection.end - ui.audio.currentTime);
  state.auditionStopTimer = window.setTimeout(handleAuditionBoundary, (remainingTrackSeconds / state.playbackRate) * 1000);
}

function handleAuditionBoundary() {
  const selection = state.auditionSelection;
  if (!selection) return;
  if (state.auditionLoop) {
    seekAudioTo(selection.start);
    updatePlayhead(selection.start);
    scheduleAuditionBoundary();
    return;
  }
  pauseAudioTransport();
  seekAudioTo(selection.end);
  updatePlayhead(selection.end);
}

function clearAuditionStopTimer() {
  window.clearTimeout(state.auditionStopTimer);
  state.auditionStopTimer = null;
}

function updateAuditionButtons() {
  document.querySelectorAll(".audition-button").forEach((button) => {
    const isPlaying = button.dataset.id === state.auditionAnnotationId && button.dataset.mode === state.auditionPlaybackMode && !ui.audio.paused;
    button.classList.toggle("is-playing", isPlaying);
  });
  document.querySelectorAll(".annotation-region__control").forEach((button) => {
    const sameRegion = button.dataset.annotationId === state.auditionAnnotationId
      && button.dataset.selectionKey === state.auditionSelectionKey;
    const isLoopButton = button.dataset.action === "loop";
    const isActive = sameRegion && !ui.audio.paused && (isLoopButton ? state.auditionLoop : !state.auditionLoop);
    button.classList.toggle("is-playing", isActive);
    if (isLoopButton) button.setAttribute("aria-pressed", String(isActive));
  });
}

function startLevelMeter() {
  if (state.meterAnimationFrame) return;
  state.meterAnimationFrame = requestAnimationFrame(updateLevelMeter);
}

function updateLevelMeter() {
  const measured = state.meterAnalysers.map((analyser) => {
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    const sumOfSquares = samples.reduce((sum, sample) => sum + sample * sample, 0);
    const rms = Math.sqrt(sumOfSquares / samples.length);
    const decibels = 20 * Math.log10(Math.max(rms, 0.000001));
    return Math.max(0, Math.min(1, (decibels + 60) / 60));
  });

  // Mono recordings have no right channel, so mirroring the left meter is clearer than showing silence.
  if (state.audioBuffer?.numberOfChannels === 1) measured[1] = measured[0];

  state.meterLevels = state.meterLevels.map((previous, index) => {
    const target = ui.audio.paused ? 0 : measured[index];
    return target > previous ? target : previous * 0.9;
  });
  drawLevelMeterFrame(...state.meterLevels);

  if (!ui.audio.paused || state.meterLevels.some((level) => level > 0.002)) {
    state.meterAnimationFrame = requestAnimationFrame(updateLevelMeter);
  } else {
    state.meterAnimationFrame = null;
  }
}

function drawLevelMeterFrame(leftLevel = 0, rightLevel = 0) {
  if (!ui.levelMeterCanvas) return;
  const { context, width, height } = prepareCanvas(ui.levelMeterCanvas, ui.levelMeterCanvas);
  const channelGap = Math.max(2, Math.round(width * 0.16));
  const channelWidth = Math.max(2, (width - channelGap) / 2);
  const inactive = themeColour("--border");

  context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, height, 0, 0);
  gradient.addColorStop(0, themeColour("--meter-low"));
  gradient.addColorStop(0.68, themeColour("--meter-low"));
  gradient.addColorStop(0.82, themeColour("--meter-mid"));
  gradient.addColorStop(1, themeColour("--meter-high"));

  [leftLevel, rightLevel].forEach((level, channel) => {
    const x = channel * (channelWidth + channelGap);
    const activeHeight = Math.max(0, level * height);
    context.fillStyle = inactive;
    context.fillRect(x, 0, channelWidth, height);
    context.fillStyle = gradient;
    context.fillRect(x, height - activeHeight, channelWidth, activeHeight);
  });
}

// ---------- 3. Drawing the waveform and spectrogram ----------

function prepareCanvas(canvas, frame) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(frame.clientWidth));
  const height = Math.max(1, Math.round(frame.clientHeight));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function themeColour(variable) {
  return getComputedStyle(ui.root).getPropertyValue(variable).trim();
}

function drawWaveform() {
  if (!state.audioBuffer) return;
  const { context, width, height } = prepareCanvas(ui.waveformCanvas, ui.waveformFrame);
  const samples = state.audioBuffer.getChannelData(0);
  const samplesPerPixel = Math.max(1, Math.floor(samples.length / width));
  const centre = height / 2;

  context.clearRect(0, 0, width, height);
  context.strokeStyle = themeColour("--border");
  context.beginPath();
  context.moveTo(0, centre + 0.5);
  context.lineTo(width, centre + 0.5);
  context.stroke();

  context.fillStyle = themeColour("--fg");
  for (let x = 0; x < width; x += 1) {
    const start = x * samplesPerPixel;
    const end = Math.min(samples.length, start + samplesPerPixel);
    let minimum = 1;
    let maximum = -1;

    // Looking for both extremes preserves sharp transients better than averaging.
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const value = samples[sampleIndex];
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }

    const top = centre + minimum * centre * 0.88;
    const bottom = centre + maximum * centre * 0.88;
    context.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

// This palette is turned into a raster once per analysis resolution. Resizing
// or entering focused view can then draw that cached detail immediately.
const SPECTROGRAM_PALETTE = [
  [7, 16, 34],
  [20, 49, 118],
  [35, 112, 178],
  [55, 177, 198],
  [111, 214, 188],
  [246, 201, 105],
  [255, 246, 215],
];

function spectrogramSettingsForViewport(duration) {
  const ratio = window.devicePixelRatio || 1;
  // Focused view can use most of the window. Preparing for that size up front
  // avoids stretching the ordinary, smaller panel when focus mode is opened.
  return chooseSpectrogramSettings({
    duration,
    targetWidth: Math.ceil(window.innerWidth * ratio),
    targetHeight: Math.ceil(window.innerHeight * 0.68 * ratio),
  });
}

function createSpectrogramRaster(spectrumData) {
  const { values, columns, rows, peakDb, floorDb } = spectrumData;
  const offscreen = document.createElement("canvas");
  offscreen.width = columns;
  offscreen.height = rows;
  const offscreenContext = offscreen.getContext("2d");
  const image = offscreenContext.createImageData(columns, rows);

  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const decibels = values[column * rows + row];
      let energy = (decibels - floorDb) / Math.max(1, peakDb - floorDb);
      energy = Math.pow(Math.max(0, Math.min(1, energy)), 1.15);
      const palettePosition = energy * (SPECTROGRAM_PALETTE.length - 1);
      const lowerColour = SPECTROGRAM_PALETTE[Math.floor(palettePosition)];
      const upperColour = SPECTROGRAM_PALETTE[Math.min(SPECTROGRAM_PALETTE.length - 1, Math.ceil(palettePosition))];
      const colourBlend = palettePosition - Math.floor(palettePosition);
      const pixel = (row * columns + column) * 4;
      image.data[pixel] = Math.round(lowerColour[0] + (upperColour[0] - lowerColour[0]) * colourBlend);
      image.data[pixel + 1] = Math.round(lowerColour[1] + (upperColour[1] - lowerColour[1]) * colourBlend);
      image.data[pixel + 2] = Math.round(lowerColour[2] + (upperColour[2] - lowerColour[2]) * colourBlend);
      image.data[pixel + 3] = 255;
    }
  }

  offscreenContext.putImageData(image, 0, 0);
  return offscreen;
}

function installSpectrogramData(spectrumData) {
  state.spectrogramRaster = createSpectrogramRaster(spectrumData);
  // These data attributes are harmless in production and make it easy to
  // verify that focused view is using real source detail rather than upscaling.
  ui.spectrogramCanvas.dataset.sourceWidth = String(spectrumData.columns);
  ui.spectrogramCanvas.dataset.sourceHeight = String(spectrumData.rows);
  ui.spectrogramCanvas.dataset.fftSize = String(spectrumData.fftSize);
  // The coloured canvas now holds the display pixels, so the large matrix can
  // be released. Keeping only its dimensions avoids retaining two full copies.
  state.spectrumData = { ...spectrumData, values: null };
}

function drawSpectrogram() {
  if (!state.spectrumData || !state.spectrogramRaster) return;
  const { context, width, height } = prepareCanvas(ui.spectrogramCanvas, ui.spectrogramFrame);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, width, height);
  context.drawImage(state.spectrogramRaster, 0, 0, width, height);
}

function ensureSpectrogramDetail() {
  if (!state.audioBuffer || !state.spectrumData) return;
  const requested = spectrogramSettingsForViewport(state.audioBuffer.duration);
  const needsMoreColumns = requested.columns > state.spectrumData.columns * 1.15;
  const needsMoreRows = requested.rows > state.spectrumData.rows * 1.15;
  if (!needsMoreColumns && !needsMoreRows) return;

  window.clearTimeout(state.spectrogramDetailTimer);
  state.spectrogramDetailTimer = window.setTimeout(() => {
    setProjectStatus("refining spectrogram detail…");
    const detailed = analyseSpectrogram(state.audioBuffer, requested);
    installSpectrogramData(detailed);
    drawSpectrogram();
    setProjectStatus(`${state.artistName} · ${state.trackTitle}`);
  }, 220);
}

function isUsableRhythmGrid(grid) {
  const bpm = Number(grid?.bpm);
  const origin = Number(grid?.barOneAtSeconds ?? grid?.originSeconds ?? grid?.downbeatTime);
  return Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 && Number.isFinite(origin);
}

function normaliseRhythmGrid(grid = {}) {
  const rawConfidence = typeof grid.confidence === "object" && grid.confidence ? grid.confidence : {};
  const confidenceNumber = typeof grid.confidence === "number" ? grid.confidence : null;
  const bpm = Math.max(30, Math.min(300, Number(grid.bpm) || 120));
  return {
    bpm,
    beatsPerBar: Math.max(3, Math.min(7, Math.round(Number(grid.beatsPerBar) || 4))),
    barOneAtSeconds: Number(grid.barOneAtSeconds ?? grid.originSeconds ?? grid.downbeatTime ?? 0) || 0,
    source: grid.source === "manual" ? "manual" : "automatic",
    tempoMode: grid.tempoMode === "variable" ? "variable" : "constant",
    analysisStatus: grid.analysisStatus || grid.details?.status || "ok",
    confidence: {
      tempo: boundedConfidence(grid.tempoConfidence ?? rawConfidence.tempo ?? rawConfidence.overall ?? confidenceNumber),
      phase: boundedConfidence(grid.phaseConfidence ?? rawConfidence.phase ?? rawConfidence.beatPhase ?? rawConfidence.beat ?? confidenceNumber),
      downbeat: boundedConfidence(grid.downbeatConfidence ?? rawConfidence.downbeat ?? rawConfidence.bar ?? confidenceNumber),
    },
  };
}

function boundedConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function confidenceWord(value) {
  if (value >= 0.72) return "high";
  if (value >= 0.42) return "medium";
  return "low";
}

function beatDurationSeconds(grid = state.rhythmGrid) {
  return grid ? 60 / grid.bpm : 0;
}

function barDurationSeconds(grid = state.rhythmGrid) {
  return beatDurationSeconds(grid) * (grid?.beatsPerBar || 4);
}

function storedBarMarkerOpacity() {
  const saved = Number(localStorage.getItem("music-analyser-bar-marker-opacity"));
  return Number.isFinite(saved) ? Math.max(0.15, Math.min(1, saved)) : 1;
}

function syncBarMarkerOpacity() {
  const percent = Math.round(state.barMarkerOpacity * 100);
  ui.root.style.setProperty("--bar-marker-opacity", String(state.barMarkerOpacity));
  ui.barMarkerOpacityInput.value = String(percent);
  ui.barMarkerOpacityValue.textContent = `${percent}%`;
}

function syncRhythmGridUi() {
  const grid = state.rhythmGrid;
  if (!grid) {
    ui.rhythmGridSummary.textContent = "tempo pending";
    ui.rhythmGridStatus.textContent = "waiting for tempo analysis · confidence —";
    ui.rulerPrimaryLabel.textContent = "time";
    ui.rulerSecondaryLabel.textContent = "min:sec";
    return;
  }

  ui.bpmInput.value = grid.bpm.toFixed(2);
  ui.beatsPerBarSelect.value = String(grid.beatsPerBar);
  ui.rhythmGridSummary.textContent = `${grid.bpm.toFixed(2)} bpm · ${grid.beatsPerBar}/4`;
  ui.rulerPrimaryLabel.textContent = "bars";
  ui.rulerSecondaryLabel.textContent = "beats";

  const automaticBpm = state.detectedRhythmGrid?.bpm;
  if (grid.source === "manual") {
    ui.rhythmGridStatus.textContent = `manual grid${automaticBpm ? ` · automatic scan ${automaticBpm.toFixed(2)} bpm` : ""}`;
  } else if (grid.analysisStatus !== "ok") {
    ui.rhythmGridStatus.textContent = "automatic scan uncertain · enter BPM and set bar 1 manually";
  } else {
    const changingWarning = grid.tempoMode === "variable" ? " · tempo may change" : "";
    ui.rhythmGridStatus.textContent = `automatic · tempo ${confidenceWord(grid.confidence.tempo)} · bar 1 ${confidenceWord(grid.confidence.downbeat)}${changingWarning}`;
  }
}

function refreshRhythmGridViews() {
  syncRhythmGridUi();
  drawTimeRuler();
  drawBeatGridOverlays();
  if (state.audioBuffer) renderTimeline();
  updateAnnotationPrompt();
  // BPM, meter, and Bar 1 all change click placement, so no previously queued
  // oscillator is allowed to survive a grid edit.
  resyncMetronome();
}

function changeRhythmGrid(changes, message) {
  if (!state.rhythmGrid) return;
  rememberUndoPoint();
  state.rhythmGrid = normaliseRhythmGrid({ ...state.rhythmGrid, ...changes, source: "manual" });
  saveProject();
  refreshRhythmGridViews();
  if (message) showToast(message);
}

function restoreAutomaticRhythmGrid(message = "automatic grid restored") {
  if (!state.detectedRhythmGrid) return;
  rememberUndoPoint();
  state.rhythmGrid = normaliseRhythmGrid(state.detectedRhythmGrid);
  saveProject();
  refreshRhythmGridViews();
  showToast(message);
}

ui.rhythmGridToggle.addEventListener("click", () => {
  const opening = ui.rhythmGridPanel.hidden;
  ui.rhythmGridPanel.hidden = !opening;
  ui.rhythmGridToggle.setAttribute("aria-expanded", String(opening));
});

ui.barMarkerOpacityInput.addEventListener("input", () => {
  state.barMarkerOpacity = Math.max(0.15, Math.min(1, Number(ui.barMarkerOpacityInput.value) / 100));
  localStorage.setItem("music-analyser-bar-marker-opacity", String(state.barMarkerOpacity));
  syncBarMarkerOpacity();
});

function commitBpmInput() {
  const bpm = Number(ui.bpmInput.value);
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) {
    syncRhythmGridUi();
    return showToast("enter a tempo from 30 to 300 bpm");
  }
  if (Math.abs(bpm - state.rhythmGrid.bpm) < 0.0001) return syncRhythmGridUi();
  changeRhythmGrid({ bpm }, `tempo set to ${bpm.toFixed(2)} bpm`);
}

ui.bpmInput.addEventListener("change", commitBpmInput);
ui.bpmInput.addEventListener("blur", commitBpmInput);
ui.bpmInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  commitBpmInput();
  ui.bpmInput.select();
});

ui.beatsPerBarSelect.addEventListener("change", () => {
  const beatsPerBar = Number(ui.beatsPerBarSelect.value);
  changeRhythmGrid({ beatsPerBar }, `${beatsPerBar} beats per bar`);
});

function multiplyTempo(multiplier) {
  const bpm = state.rhythmGrid?.bpm * multiplier;
  if (!Number.isFinite(bpm) || bpm < 30 || bpm > 300) return showToast("that tempo falls outside 30–300 bpm");
  changeRhythmGrid({ bpm }, `tempo set to ${bpm.toFixed(2)} bpm`);
}

ui.halveTempoButton.addEventListener("click", () => multiplyTempo(0.5));
ui.doubleTempoButton.addEventListener("click", () => multiplyTempo(2));
ui.resetTempoButton.addEventListener("click", () => restoreAutomaticRhythmGrid());
ui.setBarOneButton.addEventListener("click", () => {
  changeRhythmGrid({ barOneAtSeconds: ui.audio.currentTime || 0 }, `bar 1 set at ${formatTime(ui.audio.currentTime || 0, true)}`);
});

// Fine changes move the lines themselves. Whole-beat and whole-bar changes keep
// the beat spacing intact while correcting downbeat choice or bar numbering.
ui.gridEarlierButton.addEventListener("click", () => changeRhythmGrid({ barOneAtSeconds: state.rhythmGrid.barOneAtSeconds - 0.01 }, "grid moved 10 ms earlier"));
ui.gridLaterButton.addEventListener("click", () => changeRhythmGrid({ barOneAtSeconds: state.rhythmGrid.barOneAtSeconds + 0.01 }, "grid moved 10 ms later"));
ui.beatEarlierButton.addEventListener("click", () => changeRhythmGrid({ barOneAtSeconds: state.rhythmGrid.barOneAtSeconds - beatDurationSeconds() }, "bar 1 moved one beat earlier"));
ui.beatLaterButton.addEventListener("click", () => changeRhythmGrid({ barOneAtSeconds: state.rhythmGrid.barOneAtSeconds + beatDurationSeconds() }, "bar 1 moved one beat later"));
ui.barEarlierButton.addEventListener("click", () => changeRhythmGrid({ barOneAtSeconds: state.rhythmGrid.barOneAtSeconds - barDurationSeconds() }, "bar numbering moved one bar earlier"));
ui.barLaterButton.addEventListener("click", () => changeRhythmGrid({ barOneAtSeconds: state.rhythmGrid.barOneAtSeconds + barDurationSeconds() }, "bar numbering moved one bar later"));

ui.reanalyseTempoButton.addEventListener("click", async () => {
  if (!state.audioBuffer) return;
  ui.reanalyseTempoButton.disabled = true;
  ui.rhythmGridStatus.textContent = "analysing tempo again…";
  setProjectStatus("analysing tempo again…");
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  try {
    const detected = normaliseRhythmGrid(analyseTempo(state.audioBuffer));
    state.detectedRhythmGrid = { ...detected, confidence: { ...detected.confidence } };
    restoreAutomaticRhythmGrid("tempo analysis refreshed");
  } catch (error) {
    console.warn("Tempo analysis could not be repeated:", error);
    showToast("tempo analysis could not be repeated");
  } finally {
    ui.reanalyseTempoButton.disabled = false;
    setProjectStatus(`${state.artistName} · ${state.trackTitle}`);
  }
});

function drawTimeRuler() {
  if (!state.audioBuffer) return;
  if (!state.rhythmGrid) return drawSecondsRuler();

  const duration = state.audioBuffer.duration;
  const grid = state.rhythmGrid;
  const beatDuration = beatDurationSeconds(grid);
  const beatSpacing = (beatDuration / duration) * ui.timeRuler.clientWidth;
  const barSpacing = beatSpacing * grid.beatsPerBar;
  const labelEveryBars = niceGridStep(82 / Math.max(1, barSpacing));
  const firstBeat = Math.ceil((0 - grid.barOneAtSeconds) / beatDuration - 1e-7);
  const finalBeat = Math.floor((duration - grid.barOneAtSeconds) / beatDuration + 1e-7);
  const showIndividualBeats = beatSpacing >= 4;
  const fragment = document.createDocumentFragment();
  ui.timeRuler.replaceChildren();

  for (let beatIndex = firstBeat; beatIndex <= finalBeat; beatIndex += 1) {
    const isBar = positiveModulo(beatIndex, grid.beatsPerBar) === 0;
    if (!isBar && !showIndividualBeats) continue;
    const seconds = grid.barOneAtSeconds + beatIndex * beatDuration;
    const mark = document.createElement("div");
    mark.className = `time-mark ${isBar ? "is-bar" : "is-beat"}`;
    if (beatIndex === 0) mark.classList.add("is-bar-one");
    mark.style.left = `${(seconds / duration) * 100}%`;

    if (isBar) {
      const barIndex = Math.floor(beatIndex / grid.beatsPerBar);
      const barNumber = displayedBarNumber(barIndex);
      if (positiveModulo(barIndex, labelEveryBars) === 0) {
        const label = document.createElement("span");
        label.textContent = `bar ${barNumber}`;
        mark.append(label);
      }
    }
    fragment.append(mark);
  }
  ui.timeRuler.append(fragment);
}

function drawSecondsRuler() {
  const duration = state.audioBuffer.duration;
  const targetMarks = Math.max(4, Math.floor(ui.timeRuler.clientWidth / 150));
  const rawStep = duration / targetMarks;
  const usefulSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = usefulSteps.find((candidate) => candidate >= rawStep) || Math.ceil(rawStep / 600) * 600;
  ui.timeRuler.replaceChildren();
  for (let seconds = 0; seconds <= duration; seconds += step) {
    const mark = document.createElement("div");
    mark.className = "time-mark";
    mark.style.left = `${(seconds / duration) * 100}%`;
    const label = document.createElement("span");
    label.textContent = formatTime(seconds, false);
    mark.append(label);
    ui.timeRuler.append(mark);
  }
}

function drawBeatGridOverlays() {
  const layers = [ui.waveformBeatGrid, ui.spectrogramBeatGrid];
  if (!state.audioBuffer || !state.rhythmGrid) {
    layers.forEach((layer) => { layer.hidden = true; layer.replaceChildren(); });
    return;
  }

  const duration = state.audioBuffer.duration;
  const grid = state.rhythmGrid;
  const beatDuration = beatDurationSeconds(grid);
  const beatSpacing = (beatDuration / duration) * Math.max(1, ui.waveformFrame.clientWidth);
  const barSpacing = beatSpacing * grid.beatsPerBar;
  const showIndividualBeats = beatSpacing >= 4;
  const showEveryBar = niceGridStep(3 / Math.max(0.1, barSpacing));
  const firstBeat = Math.ceil((0 - grid.barOneAtSeconds) / beatDuration - 1e-7);
  const finalBeat = Math.floor((duration - grid.barOneAtSeconds) / beatDuration + 1e-7);

  layers.forEach((layer) => {
    const fragment = document.createDocumentFragment();
    for (let beatIndex = firstBeat; beatIndex <= finalBeat; beatIndex += 1) {
      const isBar = positiveModulo(beatIndex, grid.beatsPerBar) === 0;
      const barIndex = Math.floor(beatIndex / grid.beatsPerBar);
      if (!isBar && !showIndividualBeats) continue;
      if (isBar && beatIndex !== 0 && positiveModulo(barIndex, showEveryBar) !== 0) continue;
      const line = document.createElement("span");
      line.className = "beat-grid__line";
      if (isBar) line.classList.add("is-bar");
      if (beatIndex === 0) line.classList.add("is-bar-one");
      const seconds = grid.barOneAtSeconds + beatIndex * beatDuration;
      line.style.left = `${(seconds / duration) * 100}%`;
      fragment.append(line);
    }
    layer.replaceChildren(fragment);
    layer.hidden = false;
  });
}

function niceGridStep(rawStep) {
  const safe = Math.max(1, Number(rawStep) || 1);
  const power = 10 ** Math.floor(Math.log10(safe));
  const scaled = safe / power;
  const multiplier = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 4 ? 4 : 8;
  return Math.max(1, Math.ceil(multiplier * power));
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

// Musical bar numbering usually moves from Bar -1 straight to Bar 1. Skipping
// zero makes any pre-roll before the chosen Bar 1 easier to recognise.
function displayedBarNumber(barIndex) {
  return barIndex >= 0 ? barIndex + 1 : barIndex;
}

function drawFrequencyScale() {
  if (!state.audioBuffer) return;
  const nyquist = state.audioBuffer.sampleRate / 2;
  const fractions = [0, 0.2, 0.4, 0.6, 0.8, 1];
  ui.frequencyScale.replaceChildren(...fractions.map((fraction) => {
    const marker = document.createElement("span");
    marker.textContent = shortFrequency(frequencyFromRatio(fraction, nyquist));
    return marker;
  }));
}

function drawAllVisuals() {
  drawWaveform();
  drawSpectrogram();
  drawTimeRuler();
  drawBeatGridOverlays();
  drawFrequencyScale();
  drawLevelMeterFrame(...state.meterLevels);
  updateSelectionDisplay();
  updatePlayhead(ui.audio.currentTime || 0);
  syncBandControls();
  renderTimeline();
}

window.addEventListener("resize", () => {
  window.clearTimeout(state.resizeTimer);
  state.resizeTimer = window.setTimeout(() => {
    drawAllVisuals();
    ensureSpectrogramDetail();
  }, 120);
});

ui.themeButton.addEventListener("click", () => applyTheme(ui.root.dataset.theme === "night" ? "day" : "night"));

ui.focusedViewButton.addEventListener("click", () => setFocusedView(!state.isFocusedView));

function setFocusedView(enabled) {
  if (!state.audioBuffer) return;
  state.isFocusedView = enabled;
  document.body.classList.toggle("is-focused", enabled);
  ui.focusedViewButton.setAttribute("aria-pressed", String(enabled));
  ui.focusedViewButton.textContent = enabled ? "exit focused view" : "focused view";
  if (!enabled) {
    closeQuickNote();
    /*
      The level meter has no fixed normal-view height, so its enlarged canvas can
      otherwise keep the surrounding grid tall. Resetting the backing canvas
      lets the normal waveform/spectrogram rows determine its size again.
    */
    ui.levelMeterCanvas.width = 1;
    ui.levelMeterCanvas.height = 1;
  }
  requestAnimationFrame(() => {
    drawAllVisuals();
    ensureSpectrogramDetail();
  });
}

function openQuickNote(pointerEvent) {
  if (!state.selection) return;
  renderCategoryOptions(state.selection.category || ui.categorySelect.value);
  ui.quickCustomCategoryRow.hidden = ui.quickCategorySelect.value !== "__new__";
  ui.quickNoteForm.hidden = false;
  ui.quickNoteRange.textContent = state.selection.source === "spectrogram"
    ? `${formatMusicalRange(state.selection.start, state.selection.end)} · ${formatFrequency(state.selection.minFrequency)} — ${formatFrequency(state.selection.maxFrequency)}`
    : formatMusicalRange(state.selection.start, state.selection.end);

  const panelWidth = 300;
  const panelHeight = 230;
  const preferredX = pointerEvent.clientX + 16;
  const preferredY = pointerEvent.clientY + 16;
  ui.quickNoteForm.style.left = `${Math.max(12, Math.min(window.innerWidth - panelWidth - 12, preferredX))}px`;
  ui.quickNoteForm.style.top = `${Math.max(58, Math.min(window.innerHeight - panelHeight - 12, preferredY))}px`;
  ui.quickNoteInput.value = "";
  ui.quickNoteInput.focus();
}

function closeQuickNote() {
  ui.quickNoteForm.hidden = true;
  ui.quickCustomCategoryRow.hidden = true;
  ui.quickCustomCategoryInput.value = "";
  ui.quickNoteInput.value = "";
}

ui.quickNoteClose.addEventListener("click", closeQuickNote);
ui.quickNoteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const note = ui.quickNoteInput.value.trim();
  if (!note) return showToast("write an observation first");
  if (ui.quickCategorySelect.value === "__new__") return showToast("save the new category first");
  commitAnnotation(ui.quickCategorySelect.value, note);
  closeQuickNote();
});
ui.quickNoteInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    ui.quickNoteForm.requestSubmit();
  }
});

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "z") {
    const active = document.activeElement;
    const isEditingText = active?.matches?.("input, textarea, [contenteditable='true']");
    if (isEditingText) return;
    event.preventDefault();
    if (event.shiftKey) redoAnalysis();
    else undoAnalysis();
    return;
  }
  if (event.key !== "Escape") return;
  if (state.pendingAttachmentId) cancelPendingAttachment();
  else if (!ui.quickNoteForm.hidden) closeQuickNote();
  else if (!ui.rhythmGridPanel.hidden) {
    ui.rhythmGridPanel.hidden = true;
    ui.rhythmGridToggle.setAttribute("aria-expanded", "false");
  }
  else if (state.isFocusedView) setFocusedView(false);
});

// ---------- 4. Selecting time and frequency regions ----------

function beginDrag(event, source) {
  if (!state.audioBuffer || event.button !== 0) return;
  state.hoveredAnnotation = null;
  state.hoveredCard = null;
  state.selectedAnnotationId = null;
  hideHoverConnector();
  updateTimelineSelectionClasses();
  renderAnnotationRegions();
  const frame = source === "waveform" ? ui.waveformFrame : ui.spectrogramFrame;
  const point = pointWithinFrame(event, frame);
  state.drag = { source, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
  frame.setPointerCapture(event.pointerId);
  renderDragPreview();
}

function continueDrag(event, source) {
  if (!state.drag || state.drag.source !== source) return;
  const frame = source === "waveform" ? ui.waveformFrame : ui.spectrogramFrame;
  const point = pointWithinFrame(event, frame);
  state.drag.currentX = point.x;
  state.drag.currentY = point.y;
  renderDragPreview();
}

function finishDrag(event, source) {
  if (!state.drag || state.drag.source !== source) return;
  const frame = source === "waveform" ? ui.waveformFrame : ui.spectrogramFrame;
  const horizontalDistance = Math.abs(state.drag.currentX - state.drag.startX);
  const verticalDistance = Math.abs(state.drag.currentY - state.drag.startY);

  if (horizontalDistance < 4 && (source === "waveform" || verticalDistance < 4)) {
    // A click is treated as a seek command, while a drag creates a note range.
    const seekTime = (state.drag.currentX / frame.clientWidth) * state.audioBuffer.duration;
    seekAudioTo(seekTime);
    updatePlayhead(seekTime);
    state.drag = null;
    updateSelectionDisplay();
    return;
  }

  const startX = Math.min(state.drag.startX, state.drag.currentX);
  const endX = Math.max(state.drag.startX, state.drag.currentX);
  const start = (startX / frame.clientWidth) * state.audioBuffer.duration;
  const end = (endX / frame.clientWidth) * state.audioBuffer.duration;
  state.selection = { start, end, source };

  if (source === "spectrogram") {
    const top = Math.min(state.drag.startY, state.drag.currentY) / frame.clientHeight;
    const bottom = Math.max(state.drag.startY, state.drag.currentY) / frame.clientHeight;
    const nyquist = state.audioBuffer.sampleRate / 2;
    state.selection.maxFrequency = frequencyFromRatio(top, nyquist);
    state.selection.minFrequency = frequencyFromRatio(bottom, nyquist);
  }

  state.drag = null;
  updateSelectionDisplay();
  if (state.pendingAttachmentId) completePendingAttachment();
  else if (state.isFocusedView) openQuickNote(event);
  else ui.noteInput.focus();
}

function pointWithinFrame(event, frame) {
  const rectangle = frame.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rectangle.width, event.clientX - rectangle.left)),
    y: Math.max(0, Math.min(rectangle.height, event.clientY - rectangle.top)),
  };
}

function renderDragPreview() {
  if (!state.drag) return;
  const frame = state.drag.source === "waveform" ? ui.waveformFrame : ui.spectrogramFrame;
  const selectionBox = state.drag.source === "waveform" ? ui.waveSelection : ui.spectrogramSelection;
  selectionBox.classList.remove("is-hover-preview");
  const left = Math.min(state.drag.startX, state.drag.currentX);
  const width = Math.abs(state.drag.currentX - state.drag.startX);
  selectionBox.hidden = false;
  selectionBox.style.left = `${left}px`;
  selectionBox.style.width = `${Math.max(1, width)}px`;

  if (state.drag.source === "spectrogram") {
    const top = Math.min(state.drag.startY, state.drag.currentY);
    selectionBox.style.top = `${top}px`;
    selectionBox.style.height = `${Math.max(1, Math.abs(state.drag.currentY - state.drag.startY))}px`;
  }
}

function updateSelectionDisplay() {
  ui.waveSelection.hidden = true;
  ui.spectrogramSelection.hidden = true;
  ui.waveSelection.classList.remove("is-hover-preview");
  ui.spectrogramSelection.classList.remove("is-hover-preview");

  const visualSelection = state.hoveredAnnotation ? selectionFromAnnotation(state.hoveredAnnotation) : state.selection;
  const visualCategory = state.hoveredAnnotation?.category || visualSelection?.category || ui.categorySelect.value;
  const selectionColour = categoryColour(visualCategory);

  // Hover previews affect the canvases only. The composer always describes the persistent selection.
  if (!state.selection) {
    ui.selectionTime.textContent = "select a range above";
    ui.selectionFrequency.textContent = "full spectrum";
  } else {
    ui.selectionTime.textContent = `${formatMusicalRange(state.selection.start, state.selection.end)} · ${formatTime(state.selection.start, true)} — ${formatTime(state.selection.end, true)}`;
    ui.selectionFrequency.textContent = state.selection.source === "spectrogram"
      ? `${formatFrequency(state.selection.minFrequency)} — ${formatFrequency(state.selection.maxFrequency)}`
      : "full spectrum";
  }

  if (!visualSelection || !state.audioBuffer) return;

  const duration = state.audioBuffer.duration;
  const left = (visualSelection.start / duration) * 100;
  const width = ((visualSelection.end - visualSelection.start) / duration) * 100;
  const isHoverPreview = Boolean(state.hoveredAnnotation);

  // Every annotation has a time span, so the waveform always shows the active horizontal range.
  ui.waveSelection.hidden = false;
  ui.waveSelection.style.left = `${left}%`;
  ui.waveSelection.style.width = `${width}%`;
  ui.waveSelection.style.setProperty("--selection-colour", selectionColour);
  ui.waveSelection.classList.toggle("is-hover-preview", isHoverPreview);

  if (visualSelection.source === "spectrogram") {
    const nyquist = state.audioBuffer.sampleRate / 2;
    const top = ratioFromFrequency(visualSelection.maxFrequency, nyquist) * 100;
    const bottom = ratioFromFrequency(visualSelection.minFrequency, nyquist) * 100;
    ui.spectrogramSelection.hidden = false;
    ui.spectrogramSelection.style.left = `${left}%`;
    ui.spectrogramSelection.style.width = `${width}%`;
    ui.spectrogramSelection.style.top = `${top}%`;
    ui.spectrogramSelection.style.height = `${bottom - top}%`;
  }

  if (!ui.spectrogramSelection.hidden) {
    ui.spectrogramSelection.style.setProperty("--selection-colour", selectionColour);
    ui.spectrogramSelection.classList.toggle("is-hover-preview", isHoverPreview);
  }
}

function attachSelectionEvents(frame, source) {
  frame.addEventListener("pointerdown", (event) => beginDrag(event, source));
  frame.addEventListener("pointermove", (event) => continueDrag(event, source));
  frame.addEventListener("pointerup", (event) => finishDrag(event, source));
  frame.addEventListener("pointercancel", () => { state.drag = null; updateSelectionDisplay(); });
}

attachSelectionEvents(ui.waveformFrame, "waveform");
attachSelectionEvents(ui.spectrogramFrame, "spectrogram");

ui.clearSelectionButton.addEventListener("click", () => {
  state.selection = null;
  state.hoveredAnnotation = null;
  state.hoveredCard = null;
  state.selectedAnnotationId = null;
  state.editingId = null;
  ui.noteInput.value = "";
  ui.addButton.innerHTML = "add annotation <span>↵</span>";
  hideHoverConnector();
  updateTimelineSelectionClasses();
  renderAnnotationRegions();
  updateSelectionDisplay();
});

// ---------- 5. Annotation creation, persistence, and export ----------

function renderCategoryOptions(selectedCategory = ui.categorySelect.value) {
  ui.categorySelect.replaceChildren();
  state.categories.forEach((category) => {
    ui.categorySelect.append(createCategoryOption(category));
  });
  ui.categorySelect.append(createNewCategoryOption());
  if (state.categories.includes(selectedCategory)) ui.categorySelect.value = selectedCategory;
  updateCategoryControlColour();

  const activeFilter = ui.filterSelect.value || "all";
  ui.filterSelect.replaceChildren(new Option("all categories", "all"));
  state.categories.forEach((category) => ui.filterSelect.append(new Option(category, category)));
  ui.filterSelect.value = state.categories.includes(activeFilter) ? activeFilter : "all";

  const quickCategory = ui.quickCategorySelect.value;
  ui.quickCategorySelect.replaceChildren();
  state.categories.forEach((category) => {
    ui.quickCategorySelect.append(createCategoryOption(category));
  });
  ui.quickCategorySelect.append(createNewCategoryOption());
  const nextQuickCategory = state.categories.includes(selectedCategory) ? selectedCategory : quickCategory;
  if (state.categories.includes(nextQuickCategory)) ui.quickCategorySelect.value = nextQuickCategory;
  updateQuickCategoryControlColour();
  syncCategoryPicker(ui.categorySelect);
  syncCategoryPicker(ui.quickCategorySelect);
}

function createCategoryOption(category) {
  const option = document.createElement("option");
  option.value = category;
  option.textContent = `■ ${category}`;
  option.style.color = categoryColour(category);
  return option;
}

function createNewCategoryOption() {
  const option = document.createElement("option");
  option.value = "__new__";
  option.textContent = "+ new category";
  return option;
}

function syncCategoryPicker(select) {
  let picker = select.nextElementSibling;
  if (!picker?.classList.contains("category-picker")) {
    picker = document.createElement("div");
    picker.className = "category-picker";
    picker.innerHTML = `<button class="category-picker__button" type="button" aria-haspopup="listbox" aria-expanded="false"><i class="category-picker__dot"></i><span></span></button><div class="category-picker__menu" role="listbox" hidden></div>`;
    select.classList.add("category-native-select");
    select.after(picker);

    const trigger = picker.querySelector(".category-picker__button");
    trigger.addEventListener("click", () => {
      const menu = picker.querySelector(".category-picker__menu");
      const opening = menu.hidden;
      closeCategoryPickers(picker);
      menu.hidden = !opening;
      trigger.setAttribute("aria-expanded", String(opening));
    });
  }

  const selected = select.value || state.categories[0];
  const colour = categoryColour(selected === "__new__" ? "form" : selected);
  const trigger = picker.querySelector(".category-picker__button");
  trigger.style.setProperty("--category-colour", colour);
  trigger.querySelector(".category-picker__dot").style.setProperty("--option-colour", colour);
  trigger.querySelector("span").textContent = selected === "__new__" ? "+ new category" : selected;

  const menu = picker.querySelector(".category-picker__menu");
  menu.replaceChildren(...[...select.options].map((option) => {
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "category-picker__option";
    choice.setAttribute("role", "option");
    choice.setAttribute("aria-selected", String(option.value === selected));
    const optionColour = categoryColour(option.value === "__new__" ? "form" : option.value);
    choice.style.setProperty("--option-colour", optionColour);
    choice.innerHTML = option.value === "__new__" ? `<span>+ new category</span>` : `<i class="category-picker__option-dot"></i><span>${escapeHtml(option.value)}</span>`;
    choice.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      syncCategoryPicker(select);
    });
    return choice;
  }));
}

function closeCategoryPickers(except = null) {
  document.querySelectorAll(".category-picker").forEach((picker) => {
    if (picker === except) return;
    picker.querySelector(".category-picker__menu").hidden = true;
    picker.querySelector(".category-picker__button").setAttribute("aria-expanded", "false");
  });
}

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".category-picker")) closeCategoryPickers();
});

ui.categorySelect.addEventListener("change", () => {
  const adding = ui.categorySelect.value === "__new__";
  ui.customCategoryRow.hidden = !adding;
  if (adding) ui.customCategoryInput.focus();
  updateCategoryControlColour();
  updateSelectionDisplay();
});

function updateCategoryControlColour() {
  const category = ui.categorySelect.value === "__new__" ? "form" : ui.categorySelect.value;
  ui.categorySelect.style.setProperty("--category-colour", categoryColour(category));
  syncCategoryPicker(ui.categorySelect);
}

function updateQuickCategoryControlColour() {
  const category = ui.quickCategorySelect.value === "__new__" ? "form" : ui.quickCategorySelect.value;
  ui.quickCategorySelect.style.setProperty("--category-colour", categoryColour(category));
  syncCategoryPicker(ui.quickCategorySelect);
}

ui.saveCategoryButton.addEventListener("click", saveCustomCategory);
ui.customCategoryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveCustomCategory();
  }
});

function saveCustomCategory() {
  const category = addCustomCategory(ui.customCategoryInput.value);
  if (!category) return;
  ui.customCategoryInput.value = "";
  ui.customCategoryRow.hidden = true;
}

ui.quickCategorySelect.addEventListener("change", () => {
  const adding = ui.quickCategorySelect.value === "__new__";
  ui.quickCustomCategoryRow.hidden = !adding;
  if (adding) ui.quickCustomCategoryInput.focus();
  updateQuickCategoryControlColour();
});

ui.quickSaveCategoryButton.addEventListener("click", saveQuickCustomCategory);
ui.quickCustomCategoryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    saveQuickCustomCategory();
  }
});

function saveQuickCustomCategory() {
  const category = addCustomCategory(ui.quickCustomCategoryInput.value);
  if (!category) return;
  ui.quickCustomCategoryInput.value = "";
  ui.quickCustomCategoryRow.hidden = true;
}

function addCustomCategory(rawCategory) {
  const category = rawCategory.trim().toLowerCase();
  if (!category) {
    showToast("enter a category name");
    return "";
  }
  if (!state.categories.includes(category)) {
    rememberUndoPoint();
    state.categories.push(category);
  }
  renderCategoryOptions(category);
  saveProject();
  return category;
}

ui.annotationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAnnotation();
});

// Enter submits quickly; Shift+Enter still makes a new line inside the note.
ui.noteInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    saveAnnotation();
  }
});

function saveAnnotation() {
  const note = ui.noteInput.value.trim();
  const category = ui.categorySelect.value;
  if (!state.selection) return showToast("select a time or frequency range first");
  if (!note) return showToast("write an observation first");
  if (category === "__new__") return showToast("save the new category first");

  commitAnnotation(category, note);
}

function commitAnnotation(category, note) {
  rememberUndoPoint();
  const existingAnnotation = state.editingId
    ? state.annotations.find((item) => item.id === state.editingId)
    : null;
  const annotation = {
    id: state.editingId || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
    category,
    note,
    start: state.selection.start,
    end: state.selection.end,
    source: state.selection.source,
    minFrequency: state.selection.minFrequency ?? null,
    maxFrequency: state.selection.maxFrequency ?? null,
    links: existingAnnotation?.links || [],
    createdAt: new Date().toISOString(),
  };

  if (state.editingId) {
    const index = state.annotations.findIndex((item) => item.id === state.editingId);
    annotation.createdAt = state.annotations[index]?.createdAt || annotation.createdAt;
    state.annotations[index] = annotation;
    showToast("annotation updated");
  } else {
    state.annotations.push(annotation);
    state.lastCreatedAnnotationId = annotation.id;
    showToast("annotation added");
  }

  state.editingId = null;
  state.selectedAnnotationId = annotation.id;
  state.selection = selectionFromAnnotation(annotation);
  ui.noteInput.value = "";
  ui.addButton.innerHTML = "add annotation <span>↵</span>";
  saveProject();
  renderTimeline();
  return annotation;
}

function attachSelectionToAnnotation(annotation) {
  if (!state.selection) return showToast("select another area first");
  const target = state.annotations.find((item) => item.id === annotation.id);
  if (!target) return;
  const linkedSelection = normaliseLinkedSelection(state.selection);
  const alreadyAttached = annotationSelections(target).some((selection) => selectionsOverlap(selection, linkedSelection));
  if (alreadyAttached) return showToast("that area is already attached");
  rememberUndoPoint();
  target.links = [...(target.links || []), linkedSelection];
  state.selectedAnnotationId = target.id;
  state.selection = selectionFromAnnotation(target);
  saveProject();
  renderTimeline();
  showToast("area attached to annotation");
}

// Clicking the small plus toggles linking mode. While it is active, every drag
// on either audio view becomes another region for the same annotation.
function beginPendingAttachment(annotation) {
  if (state.pendingAttachmentId === annotation.id) {
    stopPendingAttachment(annotation);
    return;
  }
  state.pendingAttachmentId = annotation.id;
  state.selectedAnnotationId = annotation.id;
  state.selection = null;
  state.hoveredAnnotation = null;
  state.hoveredCard = null;
  hideHoverConnector();
  renderTimeline();
  showToast("select one or more areas · press + again when finished");
}

function completePendingAttachment() {
  const annotation = state.annotations.find((item) => item.id === state.pendingAttachmentId);
  if (!annotation || !state.selection) return;
  attachSelectionToAnnotation(annotation);
}

function cancelPendingAttachment() {
  const annotation = state.annotations.find((item) => item.id === state.pendingAttachmentId);
  stopPendingAttachment(annotation, "attachment mode stopped");
}

function stopPendingAttachment(annotation, message = "finished attaching areas") {
  state.pendingAttachmentId = null;
  if (annotation) {
    state.selectedAnnotationId = annotation.id;
    state.selection = selectionFromAnnotation(annotation);
  }
  renderTimeline();
  showToast(message);
}

function selectionsOverlap(first, second) {
  const sameTime = Math.abs(first.start - second.start) < 0.01 && Math.abs(first.end - second.end) < 0.01;
  const sameSource = first.source === second.source;
  if (!sameTime || !sameSource) return false;
  if (first.source !== "spectrogram") return true;
  return Math.abs(first.minFrequency - second.minFrequency) < 1 && Math.abs(first.maxFrequency - second.maxFrequency) < 1;
}

// Section markers describe arrangement chapters, not analytical observations.
// A neutral sequential name keeps the mapping open to any musical structure.
ui.sectionMarkerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.selection) return showToast("select a time range for the section first");
  const name = nextSectionName();
  const sectionRange = snapArrangementRangeToBars(state.selection);
  rememberUndoPoint();
  state.sections.push(normaliseSection({ name, start: sectionRange.start, end: sectionRange.end }));
  saveProject();
  renderArrangement();
  showToast(`${name} added · snapped to bar starts`);
});

function snapArrangementRangeToBars(selection) {
  const grid = state.rhythmGrid;
  if (!grid || !state.audioBuffer) return selection;

  // Analytical notes retain their exact freehand seconds. Only a new
  // arrangement chapter becomes a bar-aligned musical section.
  const snapped = snapRangeToBarStarts(
    selection.start,
    selection.end,
    grid.barOneAtSeconds,
    barDurationSeconds(grid),
    state.audioBuffer.duration,
  );
  return snapped ? { ...selection, ...snapped } : selection;
}

function nextSectionName() {
  // Continue the numbering even if an earlier marker was deleted, which keeps
  // default names unique until the listener replaces them with meaningful ones.
  const highestNumber = state.sections.reduce((highest, section) => {
    const match = /^section\s+(\d+)$/i.exec(section.name);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `Section ${highestNumber + 1}`;
}

function renderArrangement() {
  if (!ui.arrangementTrack) return;
  const sorted = [...state.sections].sort((first, second) => first.start - second.start || first.end - second.end);
  ui.arrangementSummary.textContent = sorted.length === 1 ? "1 section marker" : sorted.length ? `${sorted.length} section markers` : "no section markers yet";
  ui.arrangementTrack.replaceChildren();
  if (!state.audioBuffer || !sorted.length) {
    const empty = document.createElement("p");
    empty.className = "arrangement-empty";
    empty.textContent = "Select a time range, then map it as a section.";
    ui.arrangementTrack.append(empty);
    return;
  }

  const trackRect = ui.arrangementTrack.getBoundingClientRect();
  const waveformRect = ui.waveformFrame.getBoundingClientRect();
  const spine = document.createElement("div");
  spine.className = "arrangement-spine";
  spine.style.left = `${waveformRect.left - trackRect.left}px`;
  spine.style.width = `${waveformRect.width}px`;

  sorted.forEach((section) => {
    const chapter = document.createElement("div");
    chapter.className = "arrangement-chapter";
    chapter.tabIndex = 0;
    chapter.style.setProperty("--section-colour", section.colour);
    chapter.style.left = `${(section.start / state.audioBuffer.duration) * 100}%`;
    chapter.style.width = `${Math.max(0.3, ((section.end - section.start) / state.audioBuffer.duration) * 100)}%`;
    chapter.title = `Click to rename ${section.name} · ${formatMusicalRange(section.start, section.end)} · ${formatTime(section.start, true)} — ${formatTime(section.end, true)}`;
    const name = document.createElement("strong");
    name.textContent = section.name;
    const time = document.createElement("time");
    time.textContent = formatMusicalRange(section.start, section.end);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "arrangement-chapter__delete";
    remove.textContent = "×";
    remove.title = `Delete ${section.name} marker`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      rememberUndoPoint();
      state.sections = state.sections.filter((item) => item.id !== section.id);
      saveProject();
      renderArrangement();
      showToast("section marker deleted");
    });

    // This small circle opens a local palette. It is separate from the chapter
    // click so choosing a colour never starts the section-name editor.
    const colourButton = document.createElement("button");
    colourButton.type = "button";
    colourButton.className = "arrangement-chapter__colour";
    colourButton.title = `Change colour for ${section.name}`;
    colourButton.setAttribute("aria-label", colourButton.title);
    colourButton.setAttribute("aria-expanded", "false");
    const palette = document.createElement("div");
    palette.className = "arrangement-chapter__palette";
    palette.hidden = true;
    palette.setAttribute("role", "menu");
    palette.setAttribute("aria-label", `Colours for ${section.name}`);

    SECTION_COLOURS.forEach((colour) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "arrangement-chapter__colour-option";
      option.style.setProperty("--option-colour", colour);
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-label", `Use ${colour} for ${section.name}`);
      option.setAttribute("aria-checked", String(colour === section.colour));
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        if (colour === section.colour) {
          palette.hidden = true;
          chapter.classList.remove("is-colour-picker-open");
          colourButton.setAttribute("aria-expanded", "false");
          return;
        }
        rememberUndoPoint();
        state.sections = state.sections.map((item) => item.id === section.id ? { ...item, colour } : item);
        saveProject();
        renderArrangement();
        showToast(`${section.name} colour changed`);
      });
      palette.append(option);
    });

    colourButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const opening = palette.hidden;
      palette.hidden = !opening;
      chapter.classList.toggle("is-colour-picker-open", opening);
      colourButton.setAttribute("aria-expanded", String(opening));
    });
    palette.addEventListener("click", (event) => event.stopPropagation());
    const beginRename = () => {
      if (chapter.classList.contains("is-editing")) return;
      chapter.classList.add("is-editing");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "arrangement-chapter__rename";
      input.value = section.name;
      input.maxLength = 40;
      input.setAttribute("aria-label", `Rename ${section.name}`);

      let finished = false;
      const finish = (saveName) => {
        if (finished) return;
        finished = true;
        const nextName = input.value.trim();
        if (saveName && nextName && nextName !== section.name) {
          rememberUndoPoint();
          state.sections = state.sections.map((item) => item.id === section.id ? { ...item, name: nextName } : item);
          saveProject();
          showToast(`renamed to ${nextName}`);
        }
        renderArrangement();
      };

      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      });
      chapter.replaceChildren(input, remove);
      input.focus();
      input.select();
    };
    chapter.addEventListener("click", beginRename);
    chapter.addEventListener("keydown", (event) => {
      // Keyboard events from the text field bubble up to the chapter. Only the
      // chapter itself should treat Space as the shortcut to begin renaming.
      if (event.target !== chapter) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        beginRename();
      }
    });
    chapter.append(name, time, remove, colourButton, palette);
    spine.append(chapter);
  });
  ui.arrangementTrack.append(spine);
}

function renderTimeline() {
  const activeFilter = ui.filterSelect.value || "all";
  const searchQuery = ui.annotationSearch.value.trim().toLowerCase();
  const sorted = [...state.annotations].sort((a, b) => a.start - b.start || a.end - b.end);
  const visible = sorted.filter((item) => {
    if (activeFilter !== "all" && item.category !== activeFilter) return false;
    if (!searchQuery) return true;
    const searchableText = [
      item.category,
      item.note,
      formatTime(item.start, true),
      formatTime(item.end, true),
      formatBarBeat(item.start),
      formatBarBeat(item.end),
      item.source === "spectrogram" ? formatFrequency(item.minFrequency) : "full spectrum",
      item.source === "spectrogram" ? formatFrequency(item.maxFrequency) : "",
    ].join(" ").toLowerCase();
    return searchableText.includes(searchQuery);
  });
  state.hoveredAnnotation = null;
  state.hoveredCard = null;
  hideHoverConnector();
  ui.timeline.replaceChildren();
  ui.timeline.style.minHeight = "230px";
  const geometry = getTimelineTrackGeometry();
  const spine = createTimelineSpine(visible, geometry);
  ui.timeline.append(spine);

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.innerHTML = `<span>00</span><p>${state.annotations.length ? "No annotations match this search or category." : "Your annotations will collect here in chronological order."}</p>`;
    ui.timeline.append(empty);
  } else {
    const cardWidth = window.innerWidth <= 640 ? 214 : 236;
    const laneStep = 112;
    const laneEnds = [];
    const cards = [];

    visible.forEach((annotation, index) => {
      const midpointRatio = ((annotation.start + annotation.end) / 2) / state.audioBuffer.duration;
      const eventX = geometry.left + midpointRatio * geometry.width;
      const left = Math.max(10, Math.min(ui.timeline.clientWidth - cardWidth - 10, eventX - cardWidth / 2));
      let lane = laneEnds.findIndex((laneEnd) => left >= laneEnd + 14);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = left + cardWidth;

      const top = 66 + lane * laneStep;
      const item = createTimelineItem(annotation, index);
      if (annotation.id === state.lastCreatedAnnotationId) item.classList.add("is-entering");
      const anchorOffset = Math.max(8, Math.min(cardWidth - 8, eventX - left));
      item.style.left = `${left}px`;
      item.style.top = `${top}px`;
      item.dataset.anchorOffset = String(anchorOffset);

      annotationSelections(annotation).forEach((selection) => {
        const selectionMidpointRatio = ((selection.start + selection.end) / 2) / state.audioBuffer.duration;
        const connectorX = geometry.left + selectionMidpointRatio * geometry.width;
        const connector = document.createElement("span");
        connector.className = "timeline-card-connector";
        connector.dataset.id = annotation.id;
        connector.style.left = `${connectorX}px`;
        connector.style.height = `${top - 34}px`;
        connector.style.setProperty("--category-colour", categoryColour(annotation.category));
        if (annotation.id === state.selectedAnnotationId) connector.classList.add("is-selected");
        ui.timeline.append(connector);
      });
      cards.push(item);
    });

    cards.forEach((item) => ui.timeline.append(item));

    ui.timeline.style.minHeight = `${66 + laneEnds.length * laneStep + 16}px`;
    state.lastCreatedAnnotationId = null;
  }

  ui.annotationCount.textContent = String(state.annotations.length).padStart(2, "0");
  ui.timelineSummary.textContent = state.annotations.length === 1 ? "1 annotation" : `${state.annotations.length} annotations`;
  renderAnnotationRegions();
  updateTimelineSelectionClasses();
  updateSelectionDisplay();
  updateAuditionButtons();
  renderArrangement();
}

function getTimelineTrackGeometry() {
  const timelineRect = ui.timeline.getBoundingClientRect();
  const waveformRect = ui.waveformFrame.getBoundingClientRect();
  const fallbackInset = window.innerWidth <= 640 ? 10 : 18;
  return {
    left: waveformRect.width ? waveformRect.left - timelineRect.left : fallbackInset,
    width: waveformRect.width || Math.max(1, ui.timeline.clientWidth - fallbackInset * 2),
  };
}

function createTimelineSpine(annotations, geometry) {
  const spine = document.createElement("div");
  spine.className = "timeline-spine";
  spine.style.left = `${geometry.left}px`;
  spine.style.right = "auto";
  spine.style.width = `${geometry.width}px`;

  const rulerMarks = state.rhythmGrid
    ? musicalBarMarks(geometry.width)
    : [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({ ratio, label: formatTime((state.audioBuffer?.duration || 0) * ratio, false) }));

  rulerMarks.forEach(({ ratio, label: labelText }, index, ticks) => {
    const tick = document.createElement("span");
    tick.className = "timeline-tick";
    if (index === ticks.length - 1) tick.classList.add("is-end");
    tick.style.left = `${ratio * 100}%`;
    const label = document.createElement("span");
    label.textContent = labelText;
    tick.append(label);
    spine.append(tick);
  });

  annotations.forEach((annotation) => {
    annotationSelections(annotation).forEach((selection) => {
    const range = document.createElement("span");
    range.className = "timeline-range";
    range.dataset.id = annotation.id;
    range.style.setProperty("--category-colour", categoryColour(annotation.category));
    range.style.left = `${(selection.start / state.audioBuffer.duration) * 100}%`;
    range.style.width = `${Math.max(0.25, ((selection.end - selection.start) / state.audioBuffer.duration) * 100)}%`;
    if (annotation.id === state.selectedAnnotationId) range.classList.add("is-selected");
    spine.append(range);
    });
  });

  return spine;
}

function musicalBarMarks(width) {
  const duration = state.audioBuffer?.duration || 1;
  const grid = state.rhythmGrid;
  const barDuration = barDurationSeconds(grid);
  const barSpacing = (barDuration / duration) * width;
  const every = niceGridStep(92 / Math.max(1, barSpacing));
  const firstBarIndex = Math.ceil((0 - grid.barOneAtSeconds) / barDuration - 1e-7);
  const finalBarIndex = Math.floor((duration - grid.barOneAtSeconds) / barDuration + 1e-7);
  const marks = [];

  for (let barIndex = firstBarIndex; barIndex <= finalBarIndex; barIndex += 1) {
    const barNumber = displayedBarNumber(barIndex);
    if (barIndex !== 0 && positiveModulo(barIndex, every) !== 0) continue;
    const seconds = grid.barOneAtSeconds + barIndex * barDuration;
    marks.push({ ratio: seconds / duration, label: `bar ${barNumber}` });
  }
  return marks;
}

function annotationSelections(annotation) {
  const primary = selectionFromAnnotation(annotation);
  const links = Array.isArray(annotation.links) ? annotation.links.filter(isUsableSelection) : [];
  return [primary, ...links];
}

function createTimelineItem(annotation) {
  const item = document.createElement("article");
  item.className = "timeline-item";
  item.dataset.id = annotation.id;
  item.tabIndex = 0;
  item.style.setProperty("--category-colour", categoryColour(annotation.category));
  if (annotation.id === state.selectedAnnotationId) item.classList.add("is-selected");
  if (annotation.id === state.pendingAttachmentId) item.classList.add("is-awaiting-attachment");
  item.setAttribute("aria-label", `${annotation.category} annotation from ${formatMusicalRange(annotation.start, annotation.end)}`);

  const content = document.createElement("div");
  content.className = "timeline-item__content";

  const head = document.createElement("div");
  head.className = "timeline-item__head";

  const category = document.createElement("span");
  category.className = "timeline-item__category";
  category.textContent = annotation.category;
  const time = document.createElement("div");
  time.className = "timeline-item__time";
  time.innerHTML = `<span>${formatMusicalRange(annotation.start, annotation.end)}</span><span class="timeline-item__frequency">${annotation.source === "spectrogram" ? `${formatFrequency(annotation.minFrequency)} — ${formatFrequency(annotation.maxFrequency)}` : "full spectrum"}</span>`;
  time.title = `${formatTime(annotation.start, true)} — ${formatTime(annotation.end, true)}`;
  head.append(time, category);

  const note = document.createElement("p");
  note.className = "timeline-item__note";
  note.textContent = annotation.note;

  const actions = document.createElement("div");
  actions.className = "timeline-item__actions";
  const attachButton = document.createElement("button");
  attachButton.type = "button";
  attachButton.className = "timeline-item__attach";
  attachButton.textContent = "+";
  attachButton.title = "Attach another waveform or spectrogram region";
  attachButton.setAttribute("aria-label", attachButton.title);
  attachButton.addEventListener("click", (event) => {
    event.stopPropagation();
    beginPendingAttachment(annotation);
  });
  const locateButton = document.createElement("button");
  locateButton.type = "button";
  locateButton.textContent = "locate";
  locateButton.addEventListener("click", (event) => {
    event.stopPropagation();
    locateAnnotation(annotation);
  });
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.textContent = "edit";
  editButton.addEventListener("click", (event) => {
    event.stopPropagation();
    editAnnotation(annotation);
  });
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-button";
  deleteButton.textContent = "delete";
  deleteButton.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteAnnotation(annotation.id);
  });
  actions.append(locateButton, editButton, deleteButton);

  item.addEventListener("mouseenter", () => previewAnnotation(annotation, item));
  item.addEventListener("mouseleave", () => stopAnnotationPreview(item));
  item.addEventListener("focusin", () => previewAnnotation(annotation, item));
  item.addEventListener("focusout", (event) => {
    if (!item.contains(event.relatedTarget)) stopAnnotationPreview(item);
  });
  item.addEventListener("click", () => selectAnnotation(annotation));
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectAnnotation(annotation);
    }
  });

  content.append(head, note);
  item.append(content, actions, attachButton);
  return item;
}

function previewAnnotation(annotation, item) {
  if (!state.showHoverRegions) return;
  state.hoveredAnnotation = annotation;
  state.hoveredCard = item;
  item.classList.add("is-previewing");
  document.querySelectorAll(`.timeline-card-connector[data-id="${CSS.escape(annotation.id)}"]`).forEach((connector) => connector.classList.add("is-previewing"));
  renderAnnotationRegions();
  updateSelectionDisplay();
  requestAnimationFrame(() => showHoverConnectors(annotation, item));
}

function stopAnnotationPreview(item) {
  if (state.hoveredAnnotation?.id === item.dataset.id) state.hoveredAnnotation = null;
  if (state.hoveredCard === item) state.hoveredCard = null;
  item.classList.remove("is-previewing");
  document.querySelectorAll(`.timeline-card-connector[data-id="${CSS.escape(item.dataset.id)}"]`).forEach((connector) => connector.classList.remove("is-previewing"));
  hideHoverConnector();
  renderAnnotationRegions();
  updateSelectionDisplay();
}

function selectAnnotation(annotation) {
  state.selectedAnnotationId = annotation.id;
  state.selection = selectionFromAnnotation(annotation);
  state.hoveredAnnotation = null;
  state.hoveredCard = null;
  hideHoverConnector();
  updateTimelineSelectionClasses();
  renderAnnotationRegions();
  updateSelectionDisplay();
}

function updateTimelineSelectionClasses() {
  document.querySelectorAll(".timeline-item").forEach((item) => item.classList.toggle("is-selected", item.dataset.id === state.selectedAnnotationId));
  document.querySelectorAll(".timeline-card-connector").forEach((connector) => connector.classList.toggle("is-selected", connector.dataset.id === state.selectedAnnotationId));
  document.querySelectorAll(".timeline-range").forEach((range) => range.classList.toggle("is-selected", range.dataset.id === state.selectedAnnotationId));
}

function showHoverConnectors(annotation, item) {
  if (!state.showHoverRegions || state.hoveredAnnotation?.id !== annotation.id) return;
  const rootRect = ui.analysisState.getBoundingClientRect();
  const cardRect = item.getBoundingClientRect();
  const anchorOffset = Number(item.dataset.anchorOffset) || cardRect.width / 2;
  const startX = cardRect.left + anchorOffset - rootRect.left;
  const startY = cardRect.top - rootRect.top;

  ui.hoverConnectorOverlay.replaceChildren();
  ui.hoverConnectorOverlay.setAttribute("viewBox", `0 0 ${rootRect.width} ${rootRect.height}`);
  ui.hoverConnectorOverlay.style.setProperty("--connector-colour", categoryColour(annotation.category));
  annotationSelections(annotation).forEach((selection) => {
    const targetRect = selectionRect(selection);
    if (!targetRect) return;
    const targetX = targetRect.left + targetRect.width / 2 - rootRect.left;
    const targetY = targetRect.bottom - rootRect.top;
    const bridgeY = Math.max(targetY + 14, startY - 22);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${startX} ${startY} L ${startX} ${bridgeY} L ${targetX} ${bridgeY} L ${targetX} ${targetY}`);
    ui.hoverConnectorOverlay.append(path);
  });
  ui.hoverConnectorOverlay.classList.add("is-visible");
}

function hideHoverConnector() {
  ui.hoverConnectorOverlay.classList.remove("is-visible");
  ui.hoverConnectorOverlay.replaceChildren();
}

function selectionRect(selection) {
  if (!state.audioBuffer) return null;
  const frame = selection.source === "spectrogram" ? ui.spectrogramFrame : ui.waveformFrame;
  const frameRect = frame.getBoundingClientRect();
  const duration = state.audioBuffer.duration;
  const left = frameRect.left + (selection.start / duration) * frameRect.width;
  const width = Math.max(1, ((selection.end - selection.start) / duration) * frameRect.width);
  if (selection.source !== "spectrogram") return { left, width, top: frameRect.top, bottom: frameRect.bottom, height: frameRect.height };

  const nyquist = state.audioBuffer.sampleRate / 2;
  const topRatio = ratioFromFrequency(selection.maxFrequency, nyquist);
  const bottomRatio = ratioFromFrequency(selection.minFrequency, nyquist);
  const top = frameRect.top + topRatio * frameRect.height;
  const height = Math.max(1, (bottomRatio - topRatio) * frameRect.height);
  return { left, width, top, bottom: top + height, height };
}

function locateAnnotation(annotation) {
  selectAnnotation(annotation);
  seekAudioTo(annotation.start);
  updatePlayhead(annotation.start);
  updateSelectionDisplay();
  ui.waveformFrame.scrollIntoView({ behavior: "smooth", block: "center" });
}

function editAnnotation(annotation) {
  locateAnnotation(annotation);
  state.editingId = annotation.id;
  ui.categorySelect.value = annotation.category;
  ui.noteInput.value = annotation.note;
  ui.addButton.innerHTML = "update annotation <span>↵</span>";
  ui.noteInput.focus();
}

function deleteAnnotation(id) {
  rememberUndoPoint();
  state.hoveredAnnotation = null;
  state.hoveredCard = null;
  if (state.selectedAnnotationId === id) {
    state.selectedAnnotationId = null;
    state.selection = null;
  }
  state.annotations = state.annotations.filter((annotation) => annotation.id !== id);
  if (state.editingId === id) state.editingId = null;
  saveProject();
  renderTimeline();
  showToast("annotation deleted");
}

function selectionFromAnnotation(annotation) {
  return {
    start: annotation.start,
    end: annotation.end,
    source: annotation.source,
    minFrequency: annotation.minFrequency,
    maxFrequency: annotation.maxFrequency,
    category: annotation.category,
    annotationId: annotation.id,
  };
}

function categoryColour(category) {
  if (CATEGORY_COLOURS[category]) return CATEGORY_COLOURS[category];

  // Build custom colours in category order, moving any crowded hue until it has useful separation.
  const usedHues = [...CATEGORY_HUES];
  const customCategories = state.categories.filter((item) => !CATEGORY_COLOURS[item]);
  for (const customCategory of customCategories) {
    let hash = 0;
    for (const character of String(customCategory || "")) hash = (hash * 31 + character.charCodeAt(0)) | 0;
    let hue = Math.abs(hash * 137.508) % 360;
    let attempts = 0;
    const circularDistance = (first, second) => Math.min(Math.abs(first - second), 360 - Math.abs(first - second));
    while (usedHues.some((usedHue) => circularDistance(hue, usedHue) < 24) && attempts < 36) {
      hue = (hue + 29) % 360;
      attempts += 1;
    }
    usedHues.push(hue);
    if (customCategory === category) return `hsl(${hue.toFixed(1)} 72% 58%)`;
  }

  return "hsl(285 72% 58%)";
}

function renderAnnotationRegions() {
  ui.waveformAnnotationRegionsLayer.replaceChildren();
  ui.annotationRegionsLayer.replaceChildren();
  syncShowAnnotationsButton();
  if (!state.audioBuffer) return;

  const duration = state.audioBuffer.duration;
  const nyquist = state.audioBuffer.sampleRate / 2;
  state.annotations.forEach((annotation) => {
    const isActive = annotation.id === state.selectedAnnotationId || annotation.id === state.hoveredAnnotation?.id;
    if (!state.showAnnotationRegions && !isActive) return;
    annotationSelections(annotation).forEach((selection, index) => {
      const selectionKey = selectionRegionKey(selection, index);
      const region = document.createElement("div");
      region.className = "annotation-region";
      region.dataset.id = annotation.id;
      region.dataset.selectionKey = selectionKey;
      region.style.setProperty("--category-colour", categoryColour(annotation.category));
      region.style.left = `${(selection.start / duration) * 100}%`;
      region.style.width = `${Math.max(0.2, ((selection.end - selection.start) / duration) * 100)}%`;

      let targetLayer = ui.waveformAnnotationRegionsLayer;
      if (selection.source === "spectrogram") {
        const top = ratioFromFrequency(selection.maxFrequency, nyquist) * 100;
        const bottom = ratioFromFrequency(selection.minFrequency, nyquist) * 100;
        region.style.top = `${top}%`;
        region.style.height = `${bottom - top}%`;
        targetLayer = ui.annotationRegionsLayer;
      } else {
        region.style.top = "0%";
        region.style.height = "100%";
      }

      const controls = document.createElement("span");
      controls.className = "annotation-region__controls";
      const mode = selection.source === "spectrogram" ? "iso" : "full";
      controls.append(
        createRegionAuditionButton(annotation, selection, selectionKey, mode, false),
        createRegionAuditionButton(annotation, selection, selectionKey, mode, true),
      );
      region.append(controls);
      if (isActive) region.classList.add("is-selected");
      targetLayer.append(region);
    });
  });
  updateAuditionButtons();
}

function selectionRegionKey(selection, index) {
  return selection.id || (index === 0 ? "primary" : `link-${index}`);
}

function createRegionAuditionButton(annotation, selection, selectionKey, mode, shouldLoop) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "annotation-region__control";
  button.dataset.annotationId = annotation.id;
  button.dataset.selectionKey = selectionKey;
  button.dataset.action = shouldLoop ? "loop" : "play";
  button.textContent = shouldLoop ? "↻" : "▶";
  const filterText = selection.source === "spectrogram" ? " with its frequency band isolated" : "";
  button.title = `${shouldLoop ? "Loop" : "Play"} this saved region${filterText}`;
  button.setAttribute("aria-label", button.title);
  if (shouldLoop) button.setAttribute("aria-pressed", "false");
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    auditionSelection(annotation, selection, mode, shouldLoop, selectionKey);
  });
  return button;
}

function syncShowAnnotationsButton() {
  ui.showAnnotationsButton.setAttribute("aria-pressed", String(state.showAnnotationRegions));
  ui.showAnnotationsButton.textContent = `show annotations: ${state.showAnnotationRegions ? "on" : "off"}`;
}

ui.showAnnotationsButton.addEventListener("pointerdown", (event) => event.stopPropagation());
ui.showAnnotationsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  state.showAnnotationRegions = !state.showAnnotationRegions;
  localStorage.setItem("music-analyser-show-annotations", state.showAnnotationRegions ? "on" : "off");
  renderAnnotationRegions();
});

syncShowAnnotationsButton();

ui.filterSelect.addEventListener("change", renderTimeline);
ui.annotationSearch.addEventListener("input", renderTimeline);

function syncHoverRegionsButton() {
  ui.hoverRegionsButton.setAttribute("aria-pressed", String(state.showHoverRegions));
  ui.hoverRegionsButton.textContent = `hover regions: ${state.showHoverRegions ? "on" : "off"}`;
}

ui.hoverRegionsButton.addEventListener("click", () => {
  state.showHoverRegions = !state.showHoverRegions;
  localStorage.setItem("music-analyser-hover-regions", state.showHoverRegions ? "on" : "off");
  if (!state.showHoverRegions) {
    state.hoveredAnnotation = null;
    state.hoveredCard = null;
    document.querySelectorAll(".timeline-item.is-previewing").forEach((item) => item.classList.remove("is-previewing"));
    document.querySelectorAll(".timeline-card-connector.is-previewing").forEach((connector) => connector.classList.remove("is-previewing"));
    hideHoverConnector();
    updateSelectionDisplay();
  }
  syncHoverRegionsButton();
});

syncHoverRegionsButton();

function projectStorageKey() {
  return state.fileIdentity ? `music-analyser-project::${state.fileIdentity}` : null;
}

function legacyProjectStorageKey() {
  return state.legacyFileIdentity ? `music-analyser-project::${state.legacyFileIdentity}` : null;
}

function saveProject() {
  const key = projectStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify({
    annotations: state.annotations,
    sections: state.sections,
    categories: state.categories,
    artistName: state.artistName,
    trackTitle: state.trackTitle,
    artworkDataUrl: state.artworkDataUrl,
    filePath: state.filePath,
    audioDownloadUrl: state.audioDownloadUrl,
    rhythmGrid: state.rhythmGrid,
  }));
  rememberRecentAnalysis(key);
}

function restoreProject() {
  state.annotations = [];
  state.sections = [];
  state.categories = [...DEFAULT_CATEGORIES];
  const key = projectStorageKey();
  if (!key) return;

  try {
    const saved = JSON.parse(localStorage.getItem(key) || localStorage.getItem(legacyProjectStorageKey()));
    if (Array.isArray(saved?.annotations)) state.annotations = saved.annotations.map(normaliseAnnotation);
    if (Array.isArray(saved?.sections)) state.sections = saved.sections.filter(isUsableSelection).map(normaliseSection);
    if (Array.isArray(saved?.categories)) state.categories = [...new Set([...DEFAULT_CATEGORIES, ...saved.categories])];
    if (saved?.artistName) state.artistName = saved.artistName;
    if (saved?.trackTitle) state.trackTitle = saved.trackTitle;
    if (saved?.artworkDataUrl && !state.artworkDataUrl) state.artworkDataUrl = saved.artworkDataUrl;
    if (saved?.filePath && !state.filePath) state.filePath = saved.filePath;
    state.audioDownloadUrl = normaliseSharedAudioUrl(saved?.audioDownloadUrl);
    if (isUsableRhythmGrid(saved?.rhythmGrid)) state.rhythmGrid = normaliseRhythmGrid(saved.rhythmGrid);
  } catch (error) {
    console.warn("Saved analysis could not be read:", error);
  }
}

function rememberRecentAnalysis(projectKey) {
  if (!state.audioBuffer || !state.filePath) return;
  const recent = readRecentAnalyses().filter((item) => item.projectKey !== projectKey && item.filePath !== state.filePath);
  recent.unshift({
    projectKey,
    filePath: state.filePath,
    artistName: state.artistName,
    trackTitle: state.trackTitle,
    artworkDataUrl: state.artworkThumbnailDataUrl,
    annotationCount: state.annotations.length,
    updatedAt: new Date().toISOString(),
  });
  localStorage.setItem("music-analyser-recent-analyses", JSON.stringify(recent.slice(0, 12)));
  renderRecentAnalyses();
}

function readRecentAnalyses() {
  try {
    const saved = JSON.parse(localStorage.getItem("music-analyser-recent-analyses"));
    return Array.isArray(saved) ? saved.filter((item) => item?.filePath && item?.projectKey) : [];
  } catch {
    return [];
  }
}

function renderRecentAnalyses() {
  if (!ui.recentAnalysesList) return;
  const recent = readRecentAnalyses();
  if (!recent.length) {
    const empty = document.createElement("p");
    empty.className = "recent-analyses__empty";
    empty.textContent = "No recent analyses yet.";
    ui.recentAnalysesList.replaceChildren(empty);
    return;
  }

  ui.recentAnalysesList.replaceChildren(...recent.map((item) => {
    const card = document.createElement("article");
    card.className = "recent-analysis-card";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "recent-analysis-card__open";
    const artwork = item.artworkDataUrl ? document.createElement("img") : document.createElement("span");
    artwork.className = item.artworkDataUrl ? "recent-analysis-card__art" : "recent-analysis-card__art recent-analysis-card__art--empty";
    if (item.artworkDataUrl) {
      artwork.src = item.artworkDataUrl;
      artwork.alt = "";
    } else {
      artwork.textContent = "♪";
      artwork.setAttribute("aria-hidden", "true");
    }
    const artist = document.createElement("span");
    artist.textContent = item.artistName || "unknown artist";
    const title = document.createElement("strong");
    title.textContent = item.trackTitle || "untitled track";
    const count = document.createElement("small");
    count.textContent = String(Number(item.annotationCount) || 0).padStart(2, "0");
    count.title = `${Number(item.annotationCount) || 0} annotations`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "recent-analysis-card__remove";
    remove.textContent = "×";
    remove.title = `Remove ${item.trackTitle || "this track"} from recent analyses`;
    remove.setAttribute("aria-label", remove.title);
    // The remove button is separate from the open button, so removing an entry
    // never tries to open its audio file at the same time.
    remove.addEventListener("click", () => {
      forgetRecentAnalysis(item);
      showToast("removed from recent analyses");
    });
    open.append(artwork, artist, title, count);
    open.addEventListener("click", () => openRecentAnalysis(item));
    card.append(open, remove);
    return card;
  }));
}

async function openRecentAnalysis(item) {
  if (!nativeAudioApi?.loadAudioFile) return showToast("recent analyses need the desktop app");
  setProjectStatus("opening recent analysis…");
  try {
    const nativeFile = await nativeAudioApi.loadAudioFile(item.filePath);
    const file = new File([nativeFile.data], nativeFile.name, {
      type: nativeFile.type,
      lastModified: nativeFile.lastModified,
    });
    await loadAudioFile(file, { path: nativeFile.path, metadata: nativeFile.metadata });
    showToast("recent analysis opened");
  } catch (error) {
    console.warn("Recent analysis could not be opened:", error);
    forgetRecentAnalysis(item);
    showToast("that recording could not be found");
  }
}

function forgetRecentAnalysis(itemToForget) {
  const recent = readRecentAnalyses().filter((item) => item.projectKey !== itemToForget.projectKey);
  localStorage.setItem("music-analyser-recent-analyses", JSON.stringify(recent));
  renderRecentAnalyses();
}

ui.copyButton.addEventListener("click", async () => {
  if (!state.annotations.length && !state.sections.length) return showToast("add an annotation or section before exporting");
  const exportText = buildTextExport();

  try {
    await navigator.clipboard.writeText(exportText);
    showToast("analysis copied to clipboard");
  } catch {
    // execCommand is an older fallback for local files where clipboard permission is unavailable.
    const temporary = document.createElement("textarea");
    temporary.value = exportText;
    document.body.append(temporary);
    temporary.select();
    document.execCommand("copy");
    temporary.remove();
    showToast("analysis copied to clipboard");
  }
});

function buildTextExport() {
  const sorted = [...state.annotations].sort((a, b) => a.start - b.start || a.end - b.end);
  const usedCategories = state.categories.filter((category) => sorted.some((annotation) => annotation.category === category));
  const gridSummary = state.rhythmGrid
    ? ` · ${formatBarCount(state.audioBuffer.duration)} · ${state.rhythmGrid.bpm.toFixed(2)} bpm · ${state.rhythmGrid.beatsPerBar}/4`
    : "";
  const lines = [state.artistName.toUpperCase(), state.trackTitle.toUpperCase(), `duration: ${formatTime(state.audioBuffer.duration, false)}${gridSummary}`, ""];

  if (state.sections.length) {
    lines.push("ARRANGEMENT");
    [...state.sections].sort((a, b) => a.start - b.start).forEach((section) => {
      lines.push(`${formatRangeWithTime(section.start, section.end)} · ${section.name}`);
    });
    lines.push("", "");
  }

  usedCategories.forEach((category, categoryIndex) => {
    lines.push(category.toUpperCase());
    sorted.filter((annotation) => annotation.category === category).forEach((annotation) => {
      const frequency = annotation.source === "spectrogram"
        ? ` · ${formatFrequency(annotation.minFrequency)}–${formatFrequency(annotation.maxFrequency)}`
        : "";
      lines.push(`${formatRangeWithTime(annotation.start, annotation.end)}${frequency}`);
      lines.push(annotation.note, "");
    });
    if (categoryIndex < usedCategories.length - 1) lines.push("");
  });

  return lines.join("\n").trim();
}

// ---------- Small formatting and coordinate helpers ----------

function formatBarBeat(seconds) {
  if (!state.rhythmGrid) return formatTime(seconds, true);
  const grid = state.rhythmGrid;
  const beatPosition = (Number(seconds) - grid.barOneAtSeconds) / beatDurationSeconds(grid);
  // Hundredths keep manual, off-grid selections visible without pretending that
  // every musical observation starts exactly on a sixteenth-note boundary.
  const totalHundredths = Math.round(beatPosition * 100);
  const wholeBeat = Math.floor(totalHundredths / 100);
  const hundredths = positiveModulo(totalHundredths, 100);
  const bar = displayedBarNumber(Math.floor(wholeBeat / grid.beatsPerBar));
  const beat = positiveModulo(wholeBeat, grid.beatsPerBar) + 1;
  return `${bar}.${beat}${hundredths ? `+${String(hundredths).padStart(2, "0")}` : ""}`;
}

function formatBarCount(seconds) {
  if (!state.rhythmGrid) return "";
  const bars = Math.max(0, Number(seconds) || 0) / barDurationSeconds();
  const nearestWhole = Math.round(bars);
  const number = Math.abs(bars - nearestWhole) < 0.015
    ? String(nearestWhole)
    : bars.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return `${number} ${number === "1" ? "bar" : "bars"}`;
}

function formatMusicalRange(start, end, includeLength = true) {
  if (!state.rhythmGrid) return `${formatTime(start, true)} — ${formatTime(end, true)}`;
  const length = includeLength ? ` · ${formatBarCount(end - start)}` : "";
  return `bars ${formatBarBeat(start)} — ${formatBarBeat(end)}${length}`;
}

function formatRangeWithTime(start, end) {
  const exactTime = `${formatTime(start, true)}–${formatTime(end, true)}`;
  return state.rhythmGrid ? `${formatMusicalRange(start, end)} · ${exactTime}` : exactTime;
}

function formatTime(seconds, includeMilliseconds = false) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const wholeSeconds = Math.floor(safeSeconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  const base = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  if (!includeMilliseconds) return base;
  const milliseconds = Math.floor((safeSeconds - wholeSeconds) * 1000);
  return `${base}.${String(milliseconds).padStart(3, "0")}`;
}

function formatFrequency(frequency) {
  const safe = Math.max(0, Number(frequency) || 0);
  return safe >= 1000 ? `${(safe / 1000).toFixed(safe >= 10000 ? 1 : 2).replace(/\.0+$/, "")} khz` : `${Math.round(safe)} hz`;
}

function formatDecibels(decibels) {
  return decibels <= -120 ? "-inf dbfs" : `${decibels.toFixed(1)} dbfs`;
}

function formatLufs(lufs) {
  return lufs <= -120 ? "-inf lufs" : `${lufs.toFixed(1)} lufs`;
}

function shortFrequency(frequency) {
  return frequency >= 1000 ? `${Math.round(frequency / 1000)}k` : `${Math.round(frequency)}`;
}

function frequencyFromRatio(verticalRatio, nyquist) {
  return nyquist * Math.pow(MIN_SPECTRUM_FREQUENCY / nyquist, Math.max(0, Math.min(1, verticalRatio)));
}

function ratioFromFrequency(frequency, nyquist) {
  return Math.log(Math.max(MIN_SPECTRUM_FREQUENCY, frequency) / nyquist) / Math.log(MIN_SPECTRUM_FREQUENCY / nyquist);
}

renderCategoryOptions();
renderRecentAnalyses();

// Native details elements open instantly, so this small height animation makes
// the help and recent-analysis drawers feel calmer without changing their HTML.
document.querySelectorAll("details").forEach((details) => {
  const summary = details.querySelector(":scope > summary");
  if (!summary) return;
  summary.addEventListener("click", (event) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    event.preventDefault();
    const startHeight = details.offsetHeight;
    if (!details.open) details.open = true;
    const endHeight = details.open && startHeight < details.scrollHeight ? details.scrollHeight : summary.offsetHeight;
    details.style.overflow = "hidden";
    details.animate([{ height: `${startHeight}px` }, { height: `${endHeight}px` }], { duration: 180, easing: "ease-out" })
      .finished.then(() => {
        if (endHeight === summary.offsetHeight) details.open = false;
        details.style.removeProperty("overflow");
      });
  });
});

/*
  Adding ?demo=1 to the local URL creates a short synthetic recording. This is
  deliberately invisible in the interface: it gives developers and future AI
  agents a repeatable way to test canvases and annotations without keeping a
  copyrighted audio file inside the project.
*/
if (new URLSearchParams(window.location.search).has("demo")) {
  loadAudioFile(createDemoAudioFile());
}

function createDemoAudioFile() {
  const sampleRate = 44100;
  const duration = 12;
  const sampleCount = sampleRate * duration;
  const headerSize = 44;
  const buffer = new ArrayBuffer(headerSize + sampleCount * 2);
  const view = new DataView(buffer);

  const writeText = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const time = sampleIndex / sampleRate;
    const section = Math.floor(time / 3);
    const baseFrequency = [110, 220, 165, 330][section];
    const pulse = Math.pow(Math.max(0, Math.sin(Math.PI * (time % 0.75) / 0.75)), 2);
    const sweep = baseFrequency + (time % 3) * 55;
    const sample = (Math.sin(2 * Math.PI * sweep * time) * 0.42 + Math.sin(2 * Math.PI * sweep * 2.5 * time) * 0.16) * pulse;
    view.setInt16(headerSize + sampleIndex * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }

  return new File([buffer], "demonstration-study.wav", { type: "audio/wav", lastModified: 1 });
}
