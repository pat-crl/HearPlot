/* Shared validation for portable sessions, local saves and undo snapshots. */
(function attach(root, create) {
  const tools = create();
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserSession = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function create() {
  const DEFAULT_CATEGORIES = ["form", "melody", "rhythm", "harmony", "timbre", "texture", "dynamics"];
  const SECTION_COLOURS = ["#3977ff", "#f4c95d", "#41c77a", "#32c4d8", "#8b6de9", "#f072a9", "#f0744f"];
  const text = (value, fallback = "") => typeof value === "string" ? value : fallback;
  const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

  function normaliseSharedAudioUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value.trim());
      return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }

  function normaliseSelection(value, { duration = Infinity, sampleRate = 48000 } = {}) {
    if (!value || typeof value !== "object" || !Number.isFinite(value.start) || !Number.isFinite(value.end)) return null;
    const start = Math.max(0, value.start);
    const end = Math.min(duration, value.end);
    if (!(end > start)) return null;
    const nyquist = sampleRate / 2;
    const minimum = Number(value.minFrequency);
    const maximum = Number(value.maxFrequency);
    const hasBand = value.source === "spectrogram"
      && Number.isFinite(minimum) && Number.isFinite(maximum)
      && maximum > minimum && maximum > 20 && minimum < nyquist;
    return {
      start, end, source: hasBand ? "spectrogram" : "waveform",
      minFrequency: hasBand ? Math.max(20, minimum) : null,
      maxFrequency: hasBand ? Math.min(nyquist, maximum) : null,
    };
  }

  function uniqueId(value, used) {
    let id = text(value).trim();
    if (!id || used.has(id)) id = newId();
    used.add(id);
    return id;
  }

  function normaliseAnalysis(value = {}, options = {}) {
    const input = value && typeof value === "object" ? value : {};
    const ids = new Set();
    let skipped = 0;
    const annotations = (Array.isArray(input.annotations) ? input.annotations : []).flatMap((note) => {
      const selection = normaliseSelection(note, options);
      if (!selection) { skipped += 1; return []; }
      const linkIds = new Set();
      const links = (Array.isArray(note.links) ? note.links : []).flatMap((link) => {
        const region = normaliseSelection(link, options);
        if (!region) { skipped += 1; return []; }
        return [{ ...region, id: uniqueId(link.id, linkIds) }];
      });
      return [{
        ...selection, id: uniqueId(note.id, ids),
        category: ["__new__", "all"].includes(text(note.category).trim()) ? "form" : text(note.category, "form").trim() || "form",
        note: text(note.note), links,
        createdAt: text(note.createdAt),
      }];
    });
    const sectionIds = new Set();
    const sections = (Array.isArray(input.sections) ? input.sections : []).flatMap((section) => {
      const region = normaliseSelection(section, options);
      if (!region) { skipped += 1; return []; }
      return [{ id: uniqueId(section.id, sectionIds), start: region.start, end: region.end,
        name: text(section.name, "Section 1").trim() || "Section 1",
        colour: SECTION_COLOURS.includes(section.colour) ? section.colour : SECTION_COLOURS[0] }];
    });
    const categories = [...new Set([
      ...DEFAULT_CATEGORIES,
      ...(Array.isArray(input.categories) ? input.categories.filter((c) => typeof c === "string").map((c) => c.trim()).filter(Boolean) : []),
      ...annotations.map((note) => note.category),
    ])].filter((c) => c !== "__new__" && c !== "all");
    return { annotations, sections, categories, skipped };
  }

  function validateSession(value) {
    if (!value || value.format !== "music-analyser-session" || !Array.isArray(value.annotations)) throw new Error("Unsupported session format");
    if (value.version != null && (!Number.isInteger(value.version) || value.version < 1 || value.version > 3)) throw new Error("Unsupported session version");
    return value;
  }

  function sessionMatchesAudio(session, duration, fileName) {
    const track = session?.track;
    if (!Number.isFinite(track?.duration) || Math.abs(track.duration - duration) >= 1) return false;
    // Older sessions may identify their audio only by duration. Newer ones also carry its name.
    if (!fileName || typeof track.fileName !== "string" || !track.fileName.trim()) return true;
    const normaliseName = (name) => name.trim().normalize("NFC").toLowerCase();
    const supplied = normaliseName(track.fileName);
    const selected = normaliseName(fileName);
    return supplied === selected || supplied.replace(/\.(wav|wave|aiff?|aifc|flac|mp[234]|m4[ab]|aac|alac|ogg|oga|opus|webm|weba|caf)$/, "") === selected;
  }

  return { normaliseAnalysis, normaliseSelection, normaliseSharedAudioUrl, validateSession, sessionMatchesAudio };
}));
