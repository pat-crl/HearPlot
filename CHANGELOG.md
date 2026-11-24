# Changelog

## 0.3.1 — 24 November 2026

- Play and pause from the recording view with **Space**. The shortcut respects note editing, focused controls and dialogs.
- Play the primary passage from the selected note. Browsing notes is silent, and spectrogram notes audition their saved frequency band.
- See saved and linked passages as colour-coded spans on the main waveform. Show or hide the highlights, choose individual categories, or select and deselect all categories at once.
- Keep the waveform, spectrogram and category controls usable in compact focused view and at high zoom.

## 0.3.0 — 18 November 2026

- Named the app HearPlot for its first signed and notarised macOS download. Existing sessions and local settings carry over.
- Rebuilt the workspace around Album Builder’s panel layout, typography and light and dark palettes. Added a visible Session menu and keyboard entry for exact annotation ranges.
- Moved recording and MixLab measurements, waveform envelopes and spectrogram refinement into cancellable workers. Decode at the recognised source rate or a stable 48 kHz fallback.
- Added an optional MixLab panel for loudness, dynamics, stereo, tone and frequency-band measures. Compare a reference with independent level-matched A/B playback, and copy or export measurements.
- Keep optional reference measurements in editable sessions and local autosaves. Write native JSON exports atomically and report success only after the file is saved.
- Use system fonts and restrict app resource requests to local content.

### Playback, persistence and accessibility

- Reopen annotations under a consistent recording identity. Recover earlier comparison data from a duplicate autosave, offer a portable alternate when both copies have work, and preserve unreadable autosaves. Keep late session-file reads from replacing a newer import. Ordinary annotation undo preserves the live comparison and later track metadata edits.
- Include linked time and frequency ranges in plain-text exports. Keep paused seeking silent and continue active selection loops through the end of a recording.
- Support local playback of uncompressed integer PCM AIFF and AIFF-C in the main workspace and MixLab. Check known decoded sizes before allocation and cancel superseded file reads.
- Improve bass placement on high-sample-rate spectrograms and respect output bandwidth during isolated audition.
- Keep listening gain, playback controls and saved preferences in sync when replacing a reference. Distinguish measurements made with the spin-off's earlier tone-analysis method.
- Restore keyboard focus across annotation controls, dialogs and section markers. Keep narrow palettes and comparison charts usable, including very short recordings.

## 0.2.4 — local Wash, 17–18 November 2026

- Validate imported and restored regions, categories and IDs; keep valid notes from malformed sessions and check pending-session audio mismatches.
- Keep the recipient’s local audio path, omit private paths and identities from portable exports, and make session replacement undoable without stale editors.
- Commit recording loads atomically, ignore stale imports, close failed decoders, and preserve the previous analysis when a new file cannot be decoded.
- Continue editing in memory after storage failures, show a persistent backup warning, and store compact artwork thumbnails.
- Bypass listening filters during ordinary full-mix playback; cancel old region auditions when manually seeking, and guard their delayed callbacks.
- Fix short-file waveform rendering and numbered artist/title parsing; keep recent-file shortcuts when a drive is temporarily unavailable.
- Fix keyboard activation of card controls, add category-picker navigation and accurate playback labels, and restore readable default bar opacity.
- Prevent annotation labels and controls overlapping; size timeline lanes to their content; improve muted-text contrast and focused/short-window layouts.
- Bound metadata parsing, avoid redundant full WAV reads, validate native request senders, and constrain app navigation and resource loading.
- Preserve native File menu activation so Load Session opens its file chooser on current Chromium.
- Update Electron to 43.8.10 and electron-builder to 26.18.1. The audit at the time reported six moderate packaging-chain findings.
- Add session/storage/metadata/native tests and disposable-profile renderer/layout checks. No website or GitHub publication is part of this local audit.

## 0.2.3 — initial public source publication, 17 November 2026

This entry documents the current application version; publication does not introduce a version bump.

- Published the current source with a project overview covering music education, close listening and precise feedback on recordings.
- Included the current tempo and downbeat estimation, manual beat-grid correction, accented metronome and high-detail spectrogram work since the earlier 0.1.0 snapshot.
- Documented current arrangement mapping, frequency-region audition, pitch-preserving speed controls, structured annotations and JSON session exchange.
- Added real product screenshots using Bounty Hill's “Drastic Indifference” and illustrative listening tasks. Audio is excluded.
- Verified all 30 generated-audio tests and an unsigned Apple Silicon macOS build. Documented remaining dependency audit findings and evaluation limits.
