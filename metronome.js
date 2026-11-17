/*
  MUSIC ANALYSER — METRONOME TIMING HELPERS

  This file only does timing maths. It does not create an AudioContext, play a
  sound, read the current clock, or change the interface. Keeping those jobs
  separate makes the calculations deterministic and easy to test.

  The important terms are:
  - media time: the current position inside the loaded song;
  - wall-clock time: the AudioContext time at which a click should be played;
  - Bar 1: the song position chosen as Beat 1 of Bar 1;
  - beat index: zero at Bar 1, one at its second beat, and so on.
*/

(function attachMetronomeTools(root, createTools) {
  const tools = createTools();

  // The browser receives one global object. Node receives the same helpers via
  // module.exports so their boundary behaviour can be checked without audio.
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserMetronome = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function createMetronomeTools() {
  const DEFAULT_BEATS_PER_BAR = 4;
  const BOUNDARY_EPSILON_SECONDS = 1e-9;
  const MAX_SCHEDULED_EVENTS = 10000;

  /*
    Find the first beat at or after a media position.

    A very small epsilon prevents ordinary floating-point noise from turning a
    time such as 2.5000000000000004 into the following beat by mistake.
  */
  function beatIndexAtOrAfter(mediaTimeSeconds, barOneAtSeconds, beatPeriodSeconds) {
    if (!validGrid(mediaTimeSeconds, barOneAtSeconds, beatPeriodSeconds)) return null;
    const exactIndex = (mediaTimeSeconds - barOneAtSeconds) / beatPeriodSeconds;
    const epsilonInBeats = BOUNDARY_EPSILON_SECONDS / beatPeriodSeconds;
    const index = Math.ceil(exactIndex - epsilonInBeats);
    // JavaScript has a special -0 value. It behaves like zero in arithmetic,
    // but normalising it here keeps logs, JSON, and strict tests unsurprising.
    return index === 0 ? 0 : index;
  }

  // This companion helper is useful when drawing or resuming from the beat
  // immediately before the playhead. Exact beat boundaries remain included.
  function beatIndexAtOrBefore(mediaTimeSeconds, barOneAtSeconds, beatPeriodSeconds) {
    if (!validGrid(mediaTimeSeconds, barOneAtSeconds, beatPeriodSeconds)) return null;
    const exactIndex = (mediaTimeSeconds - barOneAtSeconds) / beatPeriodSeconds;
    const epsilonInBeats = BOUNDARY_EPSILON_SECONDS / beatPeriodSeconds;
    const index = Math.floor(exactIndex + epsilonInBeats);
    return index === 0 ? 0 : index;
  }

  function beatTimeAtIndex(beatIndex, barOneAtSeconds, beatPeriodSeconds) {
    if (!Number.isInteger(beatIndex) || !Number.isFinite(barOneAtSeconds) || !(beatPeriodSeconds > 0)) {
      return null;
    }
    return barOneAtSeconds + beatIndex * beatPeriodSeconds;
  }

  /*
    Turn a zero-based beat index into the labels a listener sees.

    Beat index 0 is Bar 1 Beat 1. Beat index 4 is Bar 2 Beat 1 in 4/4.
    Negative indices use the same no-Bar-0 convention as the visible ruler:
    index -1 is Bar -1 Beat 4.
  */
  function beatPositionForIndex(beatIndex, beatsPerBar = DEFAULT_BEATS_PER_BAR) {
    const meter = normalizeBeatsPerBar(beatsPerBar);
    if (!Number.isInteger(beatIndex) || meter === null) return null;

    const beatInBar = positiveModulo(beatIndex, meter) + 1;
    const barIndex = Math.floor(beatIndex / meter);
    const barNumber = barIndex >= 0 ? barIndex + 1 : barIndex;
    return {
      beatIndex,
      barNumber,
      beatInBar,
      isDownbeat: beatInBar === 1,
    };
  }

  function isDownbeatIndex(beatIndex, beatsPerBar = DEFAULT_BEATS_PER_BAR) {
    const position = beatPositionForIndex(beatIndex, beatsPerBar);
    return position ? position.isDownbeat : false;
  }

  /*
    Convert a song position into the AudioContext clock.

    The caller supplies one fresh anchor: "the song was at this media time when
    the audio clock read this wall time". A playback rate of 2 means two media
    seconds pass in one wall-clock second, so the media difference is divided
    by the rate. After a seek or playback-rate change, make a new anchor.
  */
  function mediaTimeToWallClock(mediaTimeSeconds, anchor) {
    if (!Number.isFinite(mediaTimeSeconds) || !validAnchor(anchor)) return null;
    return anchor.wallClockSeconds
      + (mediaTimeSeconds - anchor.mediaTimeSeconds) / anchor.playbackRate;
  }

  /*
    Say whether a playback snapshot is safe to schedule from.

    A media element can still report "playing" while it is seeking. Waiting for
    `seeking` to become false prevents a click from being restarted at an old or
    intermediate currentTime before the browser has settled on the seek target.
  */
  function playbackSnapshotCanSchedule(snapshot) {
    return Boolean(snapshot)
      && snapshot.paused === false
      && snapshot.seeking === false
      && Number.isFinite(snapshot.mediaTimeSeconds)
      && Number.isFinite(snapshot.wallClockSeconds)
      && Number.isFinite(snapshot.playbackRate)
      && snapshot.playbackRate > 0;
  }

  /*
    Check whether an older clock anchor still describes current playback.

    During ordinary playback, advancing the wall clock by 50 ms at normal speed
    should also advance media time by about 50 ms. A seek breaks that relation.
    This helper therefore exposes a stale anchor without reading any real clock.
  */
  function playbackAnchorIsCurrent(anchor, snapshot, toleranceSeconds = 0.05) {
    if (!validAnchor(anchor)
      || !playbackSnapshotCanSchedule(snapshot)
      || !Number.isFinite(toleranceSeconds)
      || toleranceSeconds < 0
      || Math.abs(anchor.playbackRate - snapshot.playbackRate) > 1e-9) {
      return false;
    }

    const elapsedWallSeconds = snapshot.wallClockSeconds - anchor.wallClockSeconds;
    if (elapsedWallSeconds < -BOUNDARY_EPSILON_SECONDS) return false;
    const expectedMediaTime = anchor.mediaTimeSeconds + elapsedWallSeconds * anchor.playbackRate;
    return Math.abs(expectedMediaTime - snapshot.mediaTimeSeconds) <= toleranceSeconds;
  }

  /*
    Apply a stricter check while playback is first resuming after a seek.

    Merely seeing currentTime change is not enough: a browser can expose a tiny
    partial movement while decoded audio is still settling. The actual media
    movement must closely match the amount predicted by the Web Audio clock.
  */
  function transportAdvanceIsConfirmed(
    anchor,
    snapshot,
    minimumObservationSeconds = 0.04,
    toleranceSeconds = 0.012,
    minimumMediaAdvanceSeconds = 0.001,
  ) {
    if (!validAnchor(anchor)
      || !playbackSnapshotCanSchedule(snapshot)
      || !Number.isFinite(minimumObservationSeconds)
      || minimumObservationSeconds < 0
      || !Number.isFinite(toleranceSeconds)
      || toleranceSeconds < 0
      || !Number.isFinite(minimumMediaAdvanceSeconds)
      || minimumMediaAdvanceSeconds < 0
      || Math.abs(anchor.playbackRate - snapshot.playbackRate) > 1e-9) {
      return false;
    }

    const elapsedWallSeconds = snapshot.wallClockSeconds - anchor.wallClockSeconds;
    const actualMediaAdvance = snapshot.mediaTimeSeconds - anchor.mediaTimeSeconds;
    const expectedMediaAdvance = elapsedWallSeconds * anchor.playbackRate;
    return elapsedWallSeconds >= minimumObservationSeconds
      && actualMediaAdvance >= minimumMediaAdvanceSeconds
      && Math.abs(actualMediaAdvance - expectedMediaAdvance) <= toleranceSeconds;
  }

  /*
    Build the small list of clicks for one look-ahead window.

    The start is included and the end is excluded: [start, end). This detail is
    deliberate. Two neighbouring windows can meet at exactly the same time
    without scheduling the boundary click twice.
  */
  function scheduleBeatEvents(options) {
    const settings = options || {};
    const start = settings.fromMediaTimeSeconds;
    const end = settings.toMediaTimeSeconds;
    const barOne = settings.barOneAtSeconds;
    const period = settings.beatPeriodSeconds;
    const meter = normalizeBeatsPerBar(
      settings.beatsPerBar === undefined ? DEFAULT_BEATS_PER_BAR : settings.beatsPerBar,
    );
    const anchor = settings.anchor;

    if (!validGrid(start, barOne, period)
      || !Number.isFinite(end)
      || end <= start
      || meter === null
      || !validAnchor(anchor)) {
      return [];
    }

    const events = [];
    let beatIndex = beatIndexAtOrAfter(start, barOne, period);

    while (events.length < MAX_SCHEDULED_EVENTS) {
      const mediaTimeSeconds = beatTimeAtIndex(beatIndex, barOne, period);
      if (mediaTimeSeconds === null || mediaTimeSeconds >= end - BOUNDARY_EPSILON_SECONDS) break;

      // If floating-point tolerance selected a beat just before the requested
      // start, skip it rather than asking the audio engine to play in the past.
      if (mediaTimeSeconds >= start - BOUNDARY_EPSILON_SECONDS) {
        const position = beatPositionForIndex(beatIndex, meter);
        events.push({
          ...position,
          mediaTimeSeconds,
          wallClockSeconds: mediaTimeToWallClock(mediaTimeSeconds, anchor),
        });
      }
      beatIndex += 1;
    }

    return events;
  }

  function validGrid(mediaTimeSeconds, barOneAtSeconds, beatPeriodSeconds) {
    return Number.isFinite(mediaTimeSeconds)
      && Number.isFinite(barOneAtSeconds)
      && Number.isFinite(beatPeriodSeconds)
      && beatPeriodSeconds > 0;
  }

  function validAnchor(anchor) {
    return Boolean(anchor)
      && Number.isFinite(anchor.mediaTimeSeconds)
      && Number.isFinite(anchor.wallClockSeconds)
      && Number.isFinite(anchor.playbackRate)
      && anchor.playbackRate > 0;
  }

  function normalizeBeatsPerBar(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  return {
    beatIndexAtOrAfter,
    beatIndexAtOrBefore,
    beatTimeAtIndex,
    beatPositionForIndex,
    isDownbeatIndex,
    mediaTimeToWallClock,
    playbackSnapshotCanSchedule,
    playbackAnchorIsCurrent,
    transportAdvanceIsConfirmed,
    scheduleBeatEvents,
  };
}));
