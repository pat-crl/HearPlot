# Project Overview

## What this project is

HearPlot is a standalone desktop prototype for close listening and structured musical analysis. A user loads a recording, inspects its waveform and high-detail spectrogram, follows an automatically estimated tempo/bar grid, selects a passage, and attaches an observation to that exact time or time-and-frequency region.

The result is a spatial annotation timeline: compact note cards sit in lanes beneath a shared time spine, with connector lines returning to the passages they describe. The timeline can be filtered by musical category and copied as clean, categorised text. The core interface still runs as local HTML/CSS/JavaScript, but it is now wrapped by Electron so it can launch as a macOS app while keeping the recording on the user's computer.

## Project direction

This is an ongoing project by Pat Carroll exploring spectrogram annotation as a platform for music education and precise feedback on recordings. The teaching aim is to help students connect close listening, detailed observations and the visual structure of an existing work. A second intended application is the exchange of specific listening references between artists, engineers, collaborators, labels and A&R teams. These applications remain questions for evaluation, not demonstrated learning or communication outcomes. The present sharing workflow uses exported JSON sessions and separately supplied audio; live collaboration is a future possibility.

## Purpose

The project tests a more spatial way to take music-analysis notes. Instead of writing timestamps by hand, the listener points directly at what they hear:

- dragging across the waveform selects a time range;
- dragging a box on the spectrogram selects both a time range and frequency range;
- the recording is scanned for BPM, beat phase, and a likely Bar 1, then shown against a DAW-like beat/bar grid;
- BPM, beats per bar, fine grid position, downbeat position, and Bar 1 numbering can all be corrected without moving or changing the audio;
- an optional transport metronome follows the current detected or corrected grid, with a higher ping on Beat 1 of every bar;
- each note is filed under a built-in or user-created category;
- timeline cards are positioned by time and connected to their recorded location;
- hovering or focusing a card temporarily reveals its original waveform or spectrogram region;
- selecting a card keeps the card, timeline stem, time range and audio region highlighted. The selected card’s Play button auditions its primary saved passage;
- saved regions reveal play and loop controls when a note is selected or previewed. Spectrogram regions use steep frequency-isolation playback;
- user-named arrangement sections are mapped separately from analytical categories; their edges snap to bar starts when mapped, each begins as `Section 1`, `Section 2`, and so on, then can be renamed directly on the map and given its own saved colour from the spectrogram-inspired palette;
- annotations can be searched, and an optional read-ahead view surfaces a note shortly before playback reaches its passage;
- focused view enlarges the recording field to the full window and turns each drag into a temporary quick-note form;
- copied text groups observations under category headings and orders each group chronologically.

## Main technologies

- **HTML** provides the single-page structure and accessible labels.
- **CSS** provides a wide, responsive interface based on IBM Plex Mono and the supplied Raster-Noton/Ryoji Ikeda-inspired design specification, with restrained blue accents.
- **Vanilla JavaScript** handles audio decoding, standards-based loudness and tempo measurement, bar/beat formatting, metronome scheduling, pitch-locked playback speed, region loops, read-ahead notes, arrangement chapters, search, canvas drawing, persistence, recent analyses, and export.
- **Electron** wraps the local web interface in a desktop window, provides the standalone macOS app bundle, and exposes a narrow native bridge for reading audio metadata and reopening recent recordings.
- **Web Audio API** decodes the selected local recording, measures live left/right playback levels, builds the steep high-pass/low-pass filter chain used for spectrogram regions and Sub/Bass/Mids/Highs listening presets, and places the short metronome oscillators on its accurate audio clock.
- **Canvas API** draws the waveform, cached high-resolution amplitude-coloured spectrogram, and smooth stereo level meter efficiently.
- **`localStorage`** remembers the day/night theme, hover-region preference, spectrogram-overlay preference, bar-marker opacity, metronome preference, recent analyses, artist and track metadata, custom categories, annotations, arrangement sections, and corrected rhythm grid for each individual audio file.
- **JSON session files** provide an editable per-track copy of the metadata, categories, arrangement sections, rhythm grid, and annotations. When sharing, the sender can optionally include an HTTPS download link to their cloud-hosted recording; the JSON never contains the audio recording itself.

There is no frontend framework, backend, account system, or upload service.

## Important files

- `index.html` — the complete page structure: import state, transport, canvases, annotation composer, and timeline.
- `styles.css` — visual tokens, wide desktop layout, responsive rules, and all component states.
- `app.js` — application behaviour, organised into labelled sections with beginner-friendly comments.
- `loudness.js` — the separately testable ITU-R BS.1770-5 integrated-LUFS, sample-peak, and RMS measurement code.
- `tempo.js` — dependency-free onset, autocorrelation, beat-phase, straight-grid, and likely-downbeat estimation for constant-tempo recordings. It exposes separate tempo, beat-phase, and downbeat confidence values.
- `audio-decode.js` — decoder independent of the current audio output. It preserves supported WAV, AIFF and FLAC source rates and uses 48 kHz for other inputs.
- `analysis-client.js`, `analysis-worker.js` and `analysis-core.js` — cancellable recording, spectrum, tempo and MixLab jobs. Decoded samples move to per-job workers as transferable buffers. The renderer retains transport, selection and project state.
- `mix-analysis.js` and `mix-lab.js` — DSP and controller for the optional MixLab workspace. The reference snapshot is validated before storage or display.
- `spectrogram.js` — separately testable 2,048–8,192-point FFT spectrogram analysis with display-aware detail and practical 4096 × 1024 source limits.
- `metronome.js` — pure beat-window and media-time-to-audio-clock calculations used by the transport's short look-ahead scheduler.
- `tests/loudness.test.cjs` — generated-audio checks based on the official EBU Tech 3341 minimum-requirements signals.
- `tests/tempo.test.cjs`, `tests/spectrogram.test.cjs`, and `tests/metronome.test.cjs` — generated click-track, silence, sizing, sine-frequency, downbeat, window-boundary, seek, and playback-rate checks; no copyrighted test recordings are stored.
- `session.js` — shared validation of session, local-save and history data, including bounded regions, category/ID repair and safe HTTPS links.
- `storage.js` — resilient local storage with in-memory continuation and a visible warning when saving fails.
- `metadata.cjs` — bounded, separately tested ID3/MP4 tag parsing.
- `scripts/test-renderer.cjs` and `tests/renderer-checks.js` — disposable-profile Electron integration and layout checks.
- `main.cjs` — the small Electron desktop shell that opens `index.html` in a native window and reads MP3/M4A metadata when available.
- `preload.cjs` — the narrow bridge between the isolated page and Electron's native file helpers.
- `legal-content.js` — the single source for the in-app Privacy Policy and Terms of Use; `npm run sync:legal` recreates the Markdown versions from it.
- `PRIVACY.md` and `TERMS.md` — plain-language legal templates shown from the `about & legal` side-rail panel.
- `scripts/sync-legal-docs.cjs` — the small maintenance script that keeps those Markdown documents aligned with the in-app text.
- `package.json` and `package-lock.json` — npm scripts and locked desktop dependencies.
- `assets/app-icon.svg` — editable icon source; `assets/app-icon.png` and `assets/app-icon.icns` are generated desktop icon outputs.
- `Project Overview.md` and `project-overview.md` — synced orientation documents for people and future AI agents.

## How to run it

For the standalone desktop version:

```bash
npm install
npm start
```

To build a local unsigned macOS app bundle:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build
```

The built app appears at `dist/mac-arm64/HearPlot.app`, with a DMG and zip beside it in `dist/`.

To run the generated-audio loudness, tempo, spectrogram, and metronome-timing checks:

```bash
npm test
npm run test:integration
```

The interface can still be opened directly through `index.html` for quick browser checks. Running a small local server is more reliable for browser permissions:

```bash
python3 -m http.server 4173
```

Then open `http://127.0.0.1:4173` in Chrome.

For development testing, `http://127.0.0.1:4173/?demo=1` generates a short synthetic recording in the browser. This is intentionally not shown as a normal interface option and avoids storing copyrighted test audio in the project.

## Main user flow

1. The starting screen is the empty recording workspace. The user drops an audio file onto it or clicks `drop audio file here` to choose one supported by the app's audio decoder.
2. The app decodes the recording locally and calculates a waveform, display-aware logarithmic spectrogram, sample peak, whole-track channel-average RMS, ITU-R BS.1770-5 integrated LUFS, and an estimated constant-tempo rhythm grid. The scan estimates BPM, quarter-note phase, and a likely first downbeat; its separate confidence values keep uncertainty visible.
   The `tempo & beat grid` panel provides decimal BPM entry, half/double tempo, 3–7 beats per bar, reanalysis/reset, `set bar 1 · beat 1 at playhead`, 10 ms nudges, one-beat downbeat shifts, whole-bar numbering shifts, and a remembered bar-marker opacity slider. Grid corrections are saved and undoable, while annotations remain stored in exact seconds.
3. The artist name, track title, and album artwork are read from common MP3 ID3 and M4A/MP4 metadata when present, then shown as editable fields with the artist above the track title.
4. Playback controls allow play/pause with the transport or Space, seeking, volume changes, optional selection looping, and an optional metronome. The metronome follows the detected or manually corrected BPM, Bar 1 position, and beats-per-bar value; a 1,760 Hz ping marks Beat 1 while the other beats use a shorter 880 Hz click. Slider drags, waveform clicks, loops, and annotation jumps cancel the old queued clicks immediately; the scheduler waits for audio to advance at the new location before attaching a fresh track-to-audio-clock anchor. Grid edits and pitch-locked speed changes also resynchronise it. A narrow, continuous stereo meter shows the live signal level.
5. A waveform drag records start and end times. A spectrogram drag additionally records minimum and maximum frequencies.
6. On wide screens, the sticky composer remains beside the visual field while the user chooses a musical category and writes an observation. Category dropdowns show coloured markers that match the annotation cards and spectrogram overlays. Enter saves; Shift+Enter creates a line break.
7. In `focused view`, the waveform and spectrogram fill the window. Finishing a drag opens a small floating composer beside the pointer; the same category list, colours, and `+ new category` creation flow are available there. Saving the note dismisses it, and Escape returns to the normal view.
8. The note appears as a compact time-positioned card in the analysis timeline. Hovering reveals a small `+`; clicking it starts a gently pulsing continuous-link mode, where every subsequent waveform or spectrogram drag becomes another region for that card. Clicking `+` again finishes.
9. Saved boxes on the waveform and spectrogram contain small play and loop symbols. Waveform regions play normally; spectrogram regions pass through the saved 48 dB/octave isolation boundaries. Sub, Bass, Low Mids, Mids, High Mids, Highs, and Air buttons apply the same style of filter to normal transport playback.
10. Playback speed offers 50%, 75%, 100%, and 125%. Electron's Chromium media engine performs pitch-preserving time stretching (`preservesPitch = true`), keeping the existing media-element filter and level-meter path stable. This is not presented as Ableton's proprietary Complex algorithm.
11. A selected time range can also become a separate arrangement chapter. Its two edges snap to the closest bar starts, with at least one complete bar retained, while analytical annotations keep their raw selected seconds. These markers are shown on their own waveform-aligned strip and are saved, undone/redone, copied, and shared independently of annotation categories.
12. Search filters cards by note, category, time, and frequency text. Optional `read ahead` prompts show the next relevant annotation roughly three seconds of listening time before its start, then keep it visible through the annotated passage.
13. `Cmd+Z` and `Cmd+Shift+Z` undo and redo analysis edits. `copy text` creates plain text, while the macOS File menu and `share analysis` export editable JSON sessions. Before saving or sharing, the sender can optionally paste an HTTPS Dropbox, Google Drive, or similar audio-download link. When a recipient opens that session without audio already loaded, the app presents a `download the audio file here` link and then lets them choose the downloaded matching file.

## Data and privacy

Audio is held in app memory and played from a temporary local object URL. It is never uploaded by the app. The project saves only metadata, note data, category names, arrangement sections, rhythm-grid settings, recent-analysis pointers, optional MixLab reference measurements, interface and playback preferences such as the metronome setting, and an optional sender-provided HTTPS audio-download link in `localStorage`.

The interface uses system fonts. Optional sharing uses the chosen system destination, and an optional HTTPS recording link opens in the browser. Native JSON exports stage the write in the selected folder and replace the destination only after the data has been written. Data handling is described in `PRIVACY.md` and `TERMS.md`.

Saved notes are matched to a recording using its file path when available, plus byte size and last-modified time. The recent analyses rail stores compact artwork/artist/title entries with annotation counts that reopen the original local file and its notes when the file is still in place. Each recent card also has its own small remove control, which forgets only that shortcut and its saved recent-list entry. A track is added as soon as it loads, even with zero notes, and artwork is reduced to a small thumbnail for this list. Clearing app storage removes these saved notes.

Version 3 JSON sessions give the user an explicit backup and transfer route for annotations, arrangement chapters, and the rhythm grid. Loading a session before its audio file keeps the session waiting, then applies it after the recording is dropped. The duration is checked when a session is applied to an already-loaded recording.

## Visual and interaction notes

The current repository does not contain a separate design-system document. The implementation details below are inferred from `index.html` and `styles.css`.

- The interface adapts Album Builder’s system typography, indigo accents, rounded panels, quiet borders, light and dark themes, and library rail.
- The simplified app icon uses a transparent outside edge, dark rounded frame, enlarged white waveform, translucent blue selected region, and vertical analysis line so it remains legible at Dock size.
- A quiet `how to use` drawer and a collapsible `recent analyses` list sit in a dedicated rail fixed 16px from the left side of wide windows. Below 1280px it returns to normal document flow and stacks above the workspace.
- A soft `(c) Pat Carroll` credit appears at the bottom of the tool and is hidden during focused view.
- The desktop workspace now uses almost the full window width, capped at 1900px, with only 16px side gutters on screens below that cap.
- The starting screen gives a single drop target and a file chooser. The Session menu holds load, save and share. MixLab is collapsed on launch and has a library rail shortcut.
- The omitted floating braille characters and plus/minus background animations are not included.
- The spectrogram maps amplitude through a fixed midnight-blue, cobalt, cyan, mint, warm-gold, and cream palette. Dark blue represents quiet energy and warm light colours represent the strongest energy.
- Spectrogram analysis prepares enough physical source pixels for focused Retina view, uses a Hann-windowed FFT scaled from 2,048 to 8,192 samples, caches the coloured raster, and rebuilds only when a substantially larger viewport needs more detail.
- Frequency is shown on a logarithmic vertical scale so low and mid frequencies receive enough visual space for musical analysis.
- A bar/beat ruler sits above the waveform. The annotation timeline repeats labelled bar positions below, while the transport continues to show exact elapsed seconds.
- Pointer-transparent beat lines cross both waveform and spectrogram; bar lines are stronger and Bar 1 is strongest. The listener can reduce only the bar-marker opacity from the tempo panel, leaving beat lines visible. Pre-roll before Bar 1 uses negative bar numbers and skips Bar 0.
- The metronome button lives beside selection looping. Its 25 ms timer only prepares a 140 ms look-ahead window; the Web Audio clock performs the actual click timing. Pause, seek, rate, and grid changes cancel already queued oscillators. After a seek, two advancing playback samples confirm that the recording has resumed before one stable media-to-audio-clock anchor is used for the new schedule; an accidentally late click is skipped rather than shifted off-grid.
- The annotation spine is measured directly from the rendered waveform, so their left edge and width stay exactly aligned at every breakpoint.
- The arrangement chapter spine uses the same live waveform measurement, so chapters, cards, waveform regions, and spectrogram regions share one exact time geometry.
- Timeline stems are separate, low-layer elements so they always pass behind cards in higher lanes rather than drawing across their text.
- The `hover regions` control turns temporary card-to-selection previews and the dashed card-to-spectrogram connector on or off.
- **Show annotations** displays each primary or linked passage as a category-coloured time span on the main waveform. Time-and-frequency boxes also remain visible on the spectrogram. **Waveform categories** changes which categories are visible on the main waveform while the notes list keeps its own filter. Built-in categories have distinct colours, and custom categories receive a stable hash-derived hue.
- The centre top-bar status truncates long artist/track names with an ellipsis and preserves the full name as a tooltip, preventing collisions with global actions.
- Cards omit sequence numbers and unused footer space. Their time and frequency sit above the note, while locate, edit, and delete form a compact vertical action rail. The selected card has a Play control, and each saved visual region can be played or looped when revealed. The extra-region `+` appears on card hover or keyboard focus.
- Responsive grids allow the waveform column, playback slider, and composer to shrink or stack before they can overlap. The level meter is only 44px wide on desktop, and the end playhead stays two pixels inside the canvas so it remains visible at 100% playback.
- Card creation, dropdowns, and collapsible side panels use restrained slide/fade motion, with the operating system's reduced-motion preference respected.
- Thin centred calibration ticks, paired micro-marks, symmetrical spacing, and sparse framing borrow from the local `Design/nautical-technical-dark-minimal` references without importing their fictional interface language.
- Each annotation can store extra linked selections in a `links` array. These extra links draw additional timeline stems and region overlays from the same card without duplicating the note.
- A spectrogram region uses four cascaded 12 dB/octave high-pass stages at the lower saved frequency and four matching low-pass stages at the upper saved frequency. This produces a deliberately steep 48 dB/octave boundary on each side of the audition band.
- Listening-band presets use fixed mix-oriented ranges: Sub 20–60 Hz, Bass 60–250 Hz, Low Mids 250–500 Hz, Mids 500 Hz–2 kHz, High Mids 2–6 kHz, Highs 6–12 kHz, and Air 12–20 kHz. Each range is clamped safely to the decoded sample rate's Nyquist frequency.
- Loudness stats are calculated from the decoded audio buffer on import. `sample peak` is the highest decoded PCM sample, not an inter-sample true-peak measurement. `rms average` is the unweighted whole-track scientific RMS averaged across channel samples, so a full-scale sine reads about -3.01 dBFS.
- `integrated lufs` follows ITU-R BS.1770-5: continuous two-stage K-weighting, complete 400 ms blocks at 100 ms steps, standard channel energy weights, a -70 LUFS absolute gate, and a relative gate 10 LU below the first gated result. It is rounded only for display.
- The LUFS code remaps the standard's exact 48 kHz filter response to the decoded buffer's analysis rate. Automated tests cover the first six EBU Tech 3341 integrated-loudness cases, 44.1 kHz calibration, sample peak, RMS, silence, and sub-400 ms audio.

## Likely places to edit

- Change the page structure or add controls in `index.html`.
- Change spacing, typography, colours, or breakpoints in `styles.css`.
- Change selection behaviour in the `Selecting time and frequency regions` section of `app.js`.
- Change categories, note fields, filtering, or export format in the `Annotation creation, persistence, and export` section of `app.js`.
- Change tempo/beat detection in `tempo.js`, then add or update generated click-track cases in `tests/tempo.test.cjs`.
- Change metronome grid-to-clock maths in `metronome.js` and its sound/scheduler integration in the `METRONOME PLAYBACK` section of `app.js`, then update `tests/metronome.test.cjs`.
- Change spectrogram FFT/detail selection in `spectrogram.js`; change palette and cached waveform envelopes in `analysis-core.js`.
- Change imported-track loudness measurements in `loudness.js`, then add or update a corresponding case in `tests/loudness.test.cjs`.
- Change legal wording in `legal-content.js`, then run `npm run sync:legal`; do not edit only one of the generated Markdown documents.

## Current prototype limits and future questions

- The original audio file itself is not copied into the analysis data. Recent analyses reopen the file by path, so they stop working if the audio file is moved, renamed, or deleted.
- Autosaved notes are local to this app install and do not sync automatically, although editable JSON sessions can be shared manually.
- Tempo analysis assumes one straight grid. Live performances, rubato, deliberate tempo changes, or heavy syncopation can drift away from it and would need a future variable-tempo beat map.
- Half/double-tempo choice and downbeat placement are musically ambiguous in some recordings. Confidence is shown separately, and the manual correction controls are part of the intended workflow rather than an exceptional fallback.
- Audio does not contain a semantic label saying which downbeat should be called Bar 1. The automatic scan chooses an early rhythmically meaningful downbeat, but pickups, ambient intros, and phrase conventions may require `set bar 1 at playhead` or whole-bar shifts.
- The spectrogram currently analyses the first audio channel. Its window length scales with higher sample rates to retain bass resolution; future versions could offer channel choice and adjustable time/frequency resolution.
- The peak display is a sample peak, not a true peak. A future true-peak display would need standards-compliant oversampling and should use dBTP rather than dBFS.
- The Web Audio decoder may convert a recording to the computer's current audio-analysis sample rate. The LUFS filter adapts to that rate, but the displayed `sample rate` describes the decoded analysis buffer rather than necessarily reporting the file header's original rate.
- Mono, stereo, common four-/five-channel layouts, and common 5.1 order are handled explicitly for LUFS. Unusual advanced speaker layouts do not provide position metadata through `AudioBuffer`, so their channels use a neutral fallback weight.
- There is no zoomed editing view yet, so very short events in long recordings may be difficult to select precisely.
- Pitch-locked speed uses Chromium's built-in real-time stretcher. It is reliable for the modest 50–125% analysis range but is not a replacement for a dedicated offline spectral engine such as Ableton Complex Pro or Signalsmith Stretch.
- Annotation boxes can be shown together on the spectrogram, while the working, selected, or hovered annotation remains visually stronger.
- A future hosted collaboration layer could add shared playback, comments, permissions, and live editing without changing the local-first core.

## Local Wash — 17–18 November 2026

Version 0.2.4 adds validated and undoable session restoration, portable path-free exports, atomic recording loads, resilient autosaving, proper full-mix filter bypass, manual-seek cancellation of region auditions, keyboard fixes, readable default timing markers, bounded native metadata/navigation, and responsive annotation cards. Electron is 43.8.10 and electron-builder 26.18.1. Six moderate build-chain audit findings remain; no high-severity findings remain. Native Load Session also preserves the menu gesture required by Chromium’s file chooser. Final validation passed 47 unit checks, 22 integration/layout checks, installed-app launch and native JSON save/load round-trips. Changes are local until separately published.

## 0.3.0 verification

The Apple Silicon macOS bundle uses sandboxed Electron with a narrow preload, local resources, and no network dependency for analysis. Version 3 session import accepts optional MixLab data from the spin-off. Source, reports and portable sessions exclude recording files. A MixLab reference restored from disk requires the reference audio to audition. Calibration and comparison checks are descriptive, and cubic true peak remains an estimate.
