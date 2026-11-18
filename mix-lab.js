// MixLab owns comparison measurements and its audition transport.
// Recording playback and annotation editing stay in the main workspace.
(function attach(root) {
  const measures = [
    ["Loudness and dynamics", [
      ["Integrated loudness", "integratedLufs", "LUFS", 1],
      ["Maximum momentary", "maxMomentaryLufs", "LUFS", 1],
      ["Maximum short-term", "maxShortTermLufs", "LUFS", 1],
      ["Loudness range", "loudnessRange", "LU", 1],
      ["Estimated true peak", "estimatedTruePeakDb", "dBTP", 2],
      ["Sample peak", "samplePeakDb", "dBFS", 2],
      ["RMS", "rmsDb", "dBFS", 1],
      ["Peak-to-loudness ratio", "plr", "dB", 1],
      ["Crest factor", "crestFactor", "dB", 1],
      ["Loudness density", "loudnessDensity", "%", 1],
      ["Near-full-scale samples", "clippedSamplePercent", "%", 4],
      ["DC offset", "dcOffset", "", 6],
    ]],
    ["Stereo", [
      ["Correlation", "correlation", "", 2],
      ["Side energy", "sidePercent", "%", 1],
      ["Mono level change", "monoDeltaDb", "dB", 1],
      ["Left/right balance", "leftRightBalanceDb", "dB", 1],
    ]],
    ["Tone", [
      ["Spectral centre", "spectralCentroidHz", "Hz", 0],
      ["85% rolloff", "spectralRolloffHz", "Hz", 0],
      ["Spectral flatness", "spectralFlatness", "", 3],
      ["High/low tilt", "highLowTiltDb", "dB", 1],
    ]],
  ];

  const element = (id) => document.getElementById(id);
  function node(tag, text = "", className = "") {
    const output = document.createElement(tag);
    output.textContent = text;
    if (className) output.className = className;
    return output;
  }

  function formatted(value, unit, precision) {
    const suffix = unit && unit !== "%" ? ` ${unit}` : unit;
    if (value === -Infinity) return `−∞${suffix}`;
    if (value === Infinity) return `∞${suffix}`;
    return Number.isFinite(value) ? `${value.toFixed(precision)}${suffix}` : "—";
  }

  function storedLabel(value) {
    // Keep both live and saved metadata in the same representation. Avoid
    // splitting a Unicode code point when bounding an imported label.
    return typeof value === "string" ? value.slice(0, 240).replace(/[\uD800-\uDBFF]$/u, "") : "";
  }

  function portableComparison(reference, levelMatch) {
    const analysis = reference && root.MusicAnalyserMixAnalysis.normaliseMixAnalysis(reference.analysis, { forJSON: true });
    if (!analysis && levelMatch) return null;
    return {
      format: "music-analyser-mix-lab", levelMatch,
      reference: analysis ? { name: storedLabel(reference.name), fileName: storedLabel(reference.fileName), analysis } : null,
    };
  }

  function chartTime(seconds, duration) {
    if (duration < 1) return `${seconds.toFixed(2)}s`;
    if (duration < 10) return `${seconds.toFixed(1)}s`;
    const wholeSeconds = Math.round(seconds);
    return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
  }

  function table(title, headers, rows, detail) {
    const section = node("section", "", "mixlab-section");
    const wrap = node("div", "", "mixlab-table-wrap");
    const grid = node("table", "", "mixlab-table");
    grid.setAttribute("aria-label", title);
    const head = grid.createTHead().insertRow();
    for (const label of headers) {
      const cell = node("th", label);
      cell.scope = "col";
      head.append(cell);
    }
    const body = grid.createTBody();
    for (const row of rows) {
      const tr = body.insertRow();
      const label = node("th", row[0]);
      label.scope = "row";
      tr.append(label);
      for (const [index, value] of row.slice(1).entries()) {
        const cell = node("td", typeof value === "object" ? value.text : value);
        if (typeof value === "object" && Number.isFinite(value.percent)) {
          const bar = node("span", "", "mixlab-band-bar");
          bar.dataset.track = index === 0 ? "A" : "B";
          bar.setAttribute("aria-hidden", "true");
          bar.style.setProperty("--band-width", `${Math.max(0, Math.min(100, value.percent))}%`);
          cell.append(bar);
        }
        tr.append(cell);
      }
    }
    wrap.append(grid);
    section.append(node("h3", title), wrap);
    if (detail) section.append(node("p", detail, "mixlab-status"));
    return section;
  }

  function create({ mainAudio, pauseMain, getVolume, onChange, saveJson, notify }) {
    const panel = element("mixLabPanel");
    const shortcut = element("mixLabShortcut");
    const ui = {
      primaryName: element("mixPrimaryName"), primaryStatus: element("mixPrimaryStatus"),
      referenceName: element("mixReferenceName"), referenceStatus: element("mixReferenceStatus"),
      playA: element("mixPlayA"), playB: element("mixPlayB"), choose: element("mixChooseReference"),
      input: element("mixReferenceInput"), remove: element("mixRemoveReference"),
      match: element("mixLevelMatch"), playbackStatus: element("mixPlaybackStatus"),
      copy: element("mixCopyReport"), save: element("mixSaveReport"),
      results: element("mixResults"), measurements: element("mixMeasurements"),
      chart: element("mixLoudnessChart"), description: element("mixLoudnessDescription"),
      bands: element("mixBandMeasurements"), comparison: element("mixComparison"),
      comparisonNotes: element("mixComparisonNotes"),
    };
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.preservesPitch = true;
    ui.chart.setAttribute("aria-describedby", ui.description.id);
    let primary = null;
    let reference = null;
    let primaryJob = null;
    let referenceJob = null;
    let referenceError = "";
    let primaryError = "";
    let audition = null;
    let auditionRequest = 0;
    let lastPosition = 0;
    let primaryProgress = "";
    let referenceProgress = "";

    function stopAudition({ release = false, reset = false } = {}) {
      auditionRequest++;
      if (audition && Number.isFinite(audio.currentTime)) lastPosition = audio.currentTime;
      audio.pause();
      if (release) {
        audition = null;
        audio.removeAttribute("src");
        audio.load();
      }
      if (reset) lastPosition = 0;
      renderTransport();
    }

    function referenceFromSession(saved) {
      if (saved?.format !== "music-analyser-mix-lab") return null;
      const analysis = root.MusicAnalyserMixAnalysis.normaliseMixAnalysis(saved.reference?.analysis);
      if (!analysis) return null;
      const name = storedLabel(saved.reference.name);
      const fileName = storedLabel(saved.reference.fileName);
      return { name: name || fileName || "Saved reference", fileName, analysis, url: "" };
    }

    function cancelReferenceLoad() {
      referenceJob?.abort();
      referenceJob = null;
      referenceError = "";
    }

    function releaseReference() {
      cancelReferenceLoad();
      if (audition?.track === reference) stopAudition({ release: true });
      if (reference?.url) URL.revokeObjectURL(reference.url);
      reference = null;
    }

    function setPrimary(buffer, url, name) {
      if (!buffer) return;
      if (primary?.buffer === buffer) {
        if (primary.name !== name) {
          primary.name = name;
          renderStatus();
        }
        return;
      }
      primaryJob?.abort();
      primaryJob = null;
      primaryError = "";
      stopAudition({ release: true, reset: true });
      releaseReference();
      ui.match.checked = true;
      primary = { buffer, url, name, analysis: null };
      shortcut.hidden = false;
      render();
      if (panel.open) void analysePrimary();
    }

    function getSessionData() {
      return portableComparison(reference, ui.match.checked);
    }

    function restoreSessionData(saved) {
      const restored = referenceFromSession(saved);
      if (restored && reference && reference.fileName === restored.fileName && reference.name === restored.name
        && JSON.stringify(root.MusicAnalyserMixAnalysis.normaliseMixAnalysis(reference.analysis)) === JSON.stringify(restored.analysis)) {
        cancelReferenceLoad();
        ui.match.checked = saved.levelMatch !== false;
      } else {
        releaseReference();
        reference = restored;
        ui.match.checked = saved?.format !== "music-analyser-mix-lab" || saved.levelMatch !== false;
      }
      render();
    }

    function progressText(stage) {
      const label = typeof stage === "string" ? stage : stage?.stage;
      const friendly = { loudness: "Measuring loudness", dynamics: "Measuring peaks and stereo", spectrum: "Measuring tone and frequency bands" };
      return friendly[label] || "Analysing recording";
    }

    async function analysePrimary() {
      if (!panel.open || !primary || primary.analysis || primaryJob) return;
      const track = primary;
      const job = new AbortController();
      primaryJob = job;
      primaryError = "";
      primaryProgress = "Preparing analysis";
      renderStatus();
      try {
        track.analysis = await root.MusicAnalyserAnalysis.run("mix", track.buffer, {
          signal: job.signal,
          onProgress: (_fraction, stage) => {
            if (primaryJob !== job) return;
            primaryProgress = progressText(stage);
            renderStatus();
          },
        });
      } catch {
        if (!job.signal.aborted) primaryError = "Analysis failed. Close and reopen MixLab to retry.";
      } finally {
        if (primaryJob === job) {
          primaryJob = null;
          render();
        }
      }
    }

    async function loadReference(file) {
      referenceJob?.abort();
      const job = new AbortController();
      referenceJob = job;
      referenceError = "";
      referenceProgress = "Decoding reference";
      renderStatus();
      try {
        const { buffer, playback } = await root.MusicAnalyserDecode.prepareRecording(file, job.signal);
        if (job.signal.aborted) return;
        const analysis = await root.MusicAnalyserAnalysis.run("mix", buffer, {
          signal: job.signal,
          onProgress: (_fraction, stage) => {
            if (referenceJob !== job) return;
            referenceProgress = progressText(stage);
            renderStatus();
          },
        });
        if (job.signal.aborted) return;
        const url = URL.createObjectURL(playback);
        if (audition?.track === reference) stopAudition({ release: true });
        if (reference?.url) URL.revokeObjectURL(reference.url);
        const fileName = storedLabel(file.name);
        const name = storedLabel(file.name.replace(/\.[^.]+$/, "")) || fileName || "Reference recording";
        reference = { name, fileName, analysis, url };
        onChange();
      } catch (error) {
        if (!job.signal.aborted) {
          const reason = error instanceof RangeError || error.name === "AudioFormatError" ? error.message : "Could not analyse this reference file.";
          referenceError = reference ? `${reason} The previous reference is still available.` : reason;
        }
      } finally {
        if (referenceJob === job) {
          referenceJob = null;
          render();
        }
      }
    }

    function adjustments() {
      const a = primary?.analysis?.integratedLufs;
      const b = reference?.analysis?.integratedLufs;
      if (!ui.match.checked || !Number.isFinite(a) || !Number.isFinite(b)) return [0, 0];
      const target = Math.min(a, b);
      return [target - a, target - b];
    }

    function syncAuditionVolume() {
      if (!audition) return;
      const offset = adjustments()[audition.side === "A" ? 0 : 1];
      audio.volume = Math.max(0, Math.min(1, getVolume() * Math.pow(10, offset / 20)));
    }

    async function play(side) {
      const track = side === "A" ? primary : reference;
      if (!track?.url || !track.analysis) return;
      if (audition?.side === side && !audio.paused) {
        stopAudition();
        return;
      }
      if (audition && Number.isFinite(audio.currentTime)) lastPosition = audio.currentTime;
      else lastPosition = Math.max(lastPosition, mainAudio.currentTime || 0);
      const request = ++auditionRequest;
      pauseMain();
      if (audition?.track !== track) {
        audio.pause();
        audio.src = track.url;
      }
      audition = { side, track };
      const duration = track.analysis.duration;
      audio.currentTime = lastPosition < duration ? lastPosition : 0;
      syncAuditionVolume();
      try {
        await audio.play();
      } catch {
        if (request === auditionRequest) notify("Could not start comparison playback.");
      }
      if (request === auditionRequest) renderTransport();
    }

    function renderStatus() {
      ui.primaryName.textContent = primary ? `A · ${primary.name}` : "A · Current recording";
      ui.primaryName.title = primary?.name || "";
      ui.primaryStatus.textContent = primaryJob ? `${primaryProgress}…` : primaryError ||
        (primary?.analysis ? "Measurements ready" : "Analysis runs when MixLab opens.");
      ui.referenceName.textContent = reference ? `B · ${reference.name}` : "B · Reference";
      ui.referenceName.title = reference?.name || "";
      ui.referenceStatus.textContent = referenceJob ? `${referenceProgress}…` : referenceError ||
        (reference?.url ? "Measurements ready" : reference ? "Saved measurements. Choose the recording to audition it." : "Choose a reference to compare.");
      ui.choose.textContent = referenceJob ? "Choose a different file" : reference ? "Replace reference" : "Choose reference";
      ui.remove.hidden = !reference && !referenceJob;
      ui.remove.textContent = referenceJob ? "Cancel load" : "Remove";
    }

    function renderTransport() {
      // The active trim depends on both measurement results, even if neither
      // the play button nor the volume slider changed.
      syncAuditionVolume();
      ui.playA.disabled = !primary?.analysis;
      ui.playB.disabled = !reference?.url;
      for (const [button, side] of [[ui.playA, "A"], [ui.playB, "B"]]) {
        button.textContent = audition?.side === side && !audio.paused ? `Pause ${side}` : `Play ${side}`;
      }
      const [a, b] = adjustments();
      const bothMeasured = Number.isFinite(primary?.analysis?.integratedLufs) && Number.isFinite(reference?.analysis?.integratedLufs);
      let matchStatus = "Playback at original levels.";
      if (ui.match.checked && bothMeasured) matchStatus = `Playback trim · A ${a.toFixed(1)} dB · B ${b.toFixed(1)} dB`;
      else if (ui.match.checked) matchStatus = "Level matching needs finite loudness measurements for both tracks.";
      ui.playbackStatus.textContent = matchStatus;
    }

    function comparisonNotes() {
      if (!primary?.analysis || !reference?.analysis) return [];
      return root.MusicAnalyserMixAnalysis.explainComparison(primary.analysis, reference.analysis, "Track A", "Track B");
    }

    function renderMeasurements() {
      const a = primary?.analysis;
      const b = reference?.analysis;
      const hasResults = Boolean(a || b);
      ui.results.hidden = !hasResults;
      ui.copy.disabled = !hasResults;
      ui.save.disabled = !hasResults;
      if (!hasResults) {
        ui.measurements.replaceChildren();
        ui.bands.replaceChildren();
        return;
      }
      ui.measurements.replaceChildren(...measures.map(([group, metrics]) =>
        table(group, ["Measurement", "Track A", "Track B"], metrics.map(([label, key, unit, digits]) =>
          [label, formatted(a?.[key], unit, digits), formatted(b?.[key], unit, digits)]),
        group === "Loudness and dynamics" ? "True peak uses a 4× cubic estimate. Loudness range is most informative on sustained programme material." : "")));
      const readBand = (result, id, metric, unit, digits) => {
        const value = result?.bands.find((band) => band.id === id)?.[metric];
        const text = formatted(value, unit, digits);
        return unit === "%" ? { text, percent: value } : text;
      };
      ui.bands.replaceChildren(...[
        ["Frequency balance", "energyPercent", "%", 1],
        ["Stereo width by band", "sidePercent", "%", 1],
        ["Stereo correlation by band", "correlation", "", 2],
      ].map(([title, metric, unit, digits]) =>
        table(title, ["Frequency band", "Track A", "Track B"], root.MusicAnalyserMixAnalysis.BAND_DEFINITIONS.map(({ id, label }) =>
          [label, readBand(a, id, metric, unit, digits), readBand(b, id, metric, unit, digits)]))));
      const notes = comparisonNotes();
      ui.comparisonNotes.replaceChildren(...notes.map((item) => node("li", `${item.metric} · ${item.text}`)));
      ui.comparison.hidden = notes.length === 0;
      drawChart();
    }

    function drawChart() {
      if (!panel.open || ui.results.hidden) return;
      const canvas = ui.chart;
      const width = Math.round(canvas.getBoundingClientRect().width);
      const height = Math.round(canvas.getBoundingClientRect().height);
      if (width < 90 || height < 80) return;
      const dpi = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpi);
      canvas.height = Math.round(height * dpi);
      const context = canvas.getContext("2d");
      context.scale(dpi, dpi);
      const theme = getComputedStyle(panel);
      const a = primary?.analysis;
      const b = reference?.analysis;
      const colours = [theme.getPropertyValue("--accent").trim() || "#4263d8", theme.getPropertyValue("--mixlab-reference").trim() || "#c26336"];
      const series = [a, b].flatMap((track, index) => track ? [
        { points: track.shortTerm || [], colour: colours[index], dashed: false },
        { points: track.momentary || [], colour: colours[index], dashed: true },
      ] : []);
      const values = series.flatMap(({ points }) => points.map((point) => point.lufs).filter(Number.isFinite));
      const upper = Math.max(0, Math.ceil(Math.max(-10, ...values) / 10) * 10);
      const lower = Math.min(-40, Math.floor(Math.max(-90, Math.min(-30, ...values)) / 10) * 10);
      const duration = Math.max(a?.duration || 0, b?.duration || 0) || 1;
      const plot = { x: 37, y: 12, width: width - 52, height: height - 38 };
      const y = (value) => plot.y + (upper - Math.max(lower, value)) / (upper - lower) * plot.height;
      context.font = "11px system-ui";
      context.fillStyle = theme.getPropertyValue("--fg-muted");
      context.strokeStyle = theme.getPropertyValue("--border");
      for (let i = 0; i <= 4; i++) {
        const value = Math.round(upper - (upper - lower) * i / 4);
        const row = y(value);
        context.beginPath();
        context.moveTo(plot.x, row);
        context.lineTo(plot.x + plot.width, row);
        context.stroke();
        context.fillText(value, 3, row + 4);
        const label = chartTime(duration * i / 4, duration);
        context.textAlign = i === 4 ? "right" : i === 0 ? "left" : "center";
        context.fillText(label, plot.x + plot.width * i / 4, height - 6);
        context.textAlign = "left";
      }
      for (const { points, colour, dashed } of series) {
        context.strokeStyle = colour;
        context.lineWidth = dashed ? 1 : 2;
        context.globalAlpha = dashed ? 0.55 : 1;
        context.setLineDash(dashed ? [4, 4] : []);
        context.beginPath();
        const xFor = (point) => plot.x + Math.min(duration, point.time) / duration * plot.width;
        let previousPoint = null;
        const isolated = [];
        for (const [index, point] of points.entries()) {
          if (!Number.isFinite(point.lufs)) { previousPoint = null; continue; }
          if (previousPoint) context.lineTo(xFor(point), y(point.lufs));
          else {
            context.moveTo(xFor(point), y(point.lufs));
            if (!Number.isFinite(points[index + 1]?.lufs)) isolated.push(point);
          }
          previousPoint = point;
        }
        context.stroke();
        context.fillStyle = colour;
        for (const point of isolated) {
          context.beginPath();
          context.arc(xFor(point), y(point.lufs), 2.5, 0, 2 * Math.PI);
          context.fill();
        }
      }
      ui.description.textContent = values.length
        ? `Track A is blue${b ? " and Track B is orange" : ""}. Solid lines show 3 second short-term loudness. Dashed lines show 400 ms momentary loudness. Values reflect the source recordings.`
        : "No loudness timeline is available for the current material.";
    }

    function render() {
      renderStatus();
      renderTransport();
      if (panel.open) renderMeasurements();
    }

    function reportText() {
      const lines = ["Music Analyser · MixLab"];
      for (const [side, track] of [["A", primary], ["B", reference]]) {
        if (!track?.analysis) continue;
        lines.push("", `Track ${side} · ${track.name}`);
        for (const [group, metrics] of measures) {
          lines.push(group);
          for (const [label, key, unit, digits] of metrics) {
            lines.push(`  ${label} · ${formatted(track.analysis[key], unit, digits)}`);
          }
        }
        lines.push("Frequency bands (energy / side energy / correlation)");
        for (const band of track.analysis.bands) {
          lines.push(`  ${band.label} · ${formatted(band.energyPercent, "%", 1)} / ${formatted(band.sidePercent, "%", 1)} / ${formatted(band.correlation, "", 2)}`);
        }
      }
      const notes = comparisonNotes();
      if (notes.length) lines.push("", "What to listen for", ...notes.map(({ text }) => text));
      return lines.join("\n");
    }

    panel.addEventListener("toggle", () => {
      if (panel.open) {
        render();
        void analysePrimary();
      } else {
        stopAudition();
        primaryJob?.abort();
        primaryJob = null;
      }
    });
    shortcut.addEventListener("click", (event) => {
      event.preventDefault();
      panel.open = true;
      panel.querySelector("summary").focus({ preventScroll: true });
      panel.scrollIntoView({ block: "start" });
    });
    ui.choose.addEventListener("click", () => ui.input.click());
    ui.input.addEventListener("change", () => {
      const file = ui.input.files[0];
      ui.input.value = "";
      if (file) void loadReference(file);
    });
    ui.remove.addEventListener("click", () => {
      if (referenceJob) {
        cancelReferenceLoad();
        render();
      } else {
        releaseReference();
        render();
        onChange();
      }
    });
    ui.match.addEventListener("change", () => { renderTransport(); onChange(); });
    ui.playA.addEventListener("click", () => void play("A"));
    ui.playB.addEventListener("click", () => void play("B"));
    mainAudio.addEventListener("play", () => stopAudition({ release: true, reset: true }));
    mainAudio.addEventListener("volumechange", syncAuditionVolume);
    audio.addEventListener("playing", renderTransport);
    audio.addEventListener("pause", renderTransport);
    audio.addEventListener("ended", () => stopAudition({ release: true, reset: true }));
    new ResizeObserver(drawChart).observe(ui.chart);
    new MutationObserver(drawChart).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    ui.copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(reportText());
        notify("MixLab report copied.");
      } catch {
        const field = node("textarea");
        field.value = reportText();
        panel.append(field);
        let copied = false;
        try {
          field.select();
          copied = document.execCommand("copy");
        } catch { /* The clipboard can be unavailable in both paths. */ }
        finally {
          field.remove();
          ui.copy.focus();
        }
        notify(copied ? "MixLab report copied." : "Could not copy the MixLab report.");
      }
    });
    ui.save.addEventListener("click", async () => {
      const snapshot = (track) => track?.analysis ? {
        name: track.name,
        analysis: root.MusicAnalyserMixAnalysis.normaliseMixAnalysis(track.analysis, { forJSON: true }),
      } : null;
      const json = JSON.stringify({ format: "music-analyser-mix-report", version: 1,
        primary: snapshot(primary), reference: snapshot(reference), comparison: comparisonNotes() }, null, 2);
      try {
        if (await saveJson("mixlab-measurements.json", json)) notify("MixLab measurements saved.");
      } catch { notify("Could not save the MixLab measurements."); }
    });

    return { setPrimary, getSessionData, restoreSessionData, pauseAudition: stopAudition };
  }

  root.MusicAnalyserMixLab = { create, portableComparison };
}(window));
