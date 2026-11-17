/*
  These tests cover only timing maths. No real clock is read and no sound is
  played, so every answer is identical on every run and every computer.
*/

const test = require("node:test");
const assert = require("node:assert/strict");
const {
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
} = require("../metronome.js");

function assertNear(actual, expected, tolerance = 1e-10) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, received ${actual}`,
  );
}

test("beat-index helpers include exact boundaries and move on after them", () => {
  const barOne = 2;
  const period = 0.5;

  assert.equal(beatIndexAtOrAfter(2, barOne, period), 0);
  assert.equal(beatIndexAtOrAfter(2.5, barOne, period), 1);
  assert.equal(beatIndexAtOrAfter(2.50001, barOne, period), 2);
  assert.equal(beatIndexAtOrBefore(2.5, barOne, period), 1);
  assert.equal(beatIndexAtOrBefore(2.49999, barOne, period), 0);
  assertNear(beatTimeAtIndex(3, barOne, period), 3.5);
});

test("tiny floating-point noise does not skip an exact beat", () => {
  const almostOneSecond = 1 + 4e-13;
  assert.equal(beatIndexAtOrAfter(almostOneSecond, 0, 0.5), 2);
  assert.equal(beatIndexAtOrBefore(1 - 4e-13, 0, 0.5), 2);
});

test("bar and downbeat labels work before and after Bar 1", () => {
  assert.deepEqual(beatPositionForIndex(0), {
    beatIndex: 0,
    barNumber: 1,
    beatInBar: 1,
    isDownbeat: true,
  });
  assert.deepEqual(beatPositionForIndex(3), {
    beatIndex: 3,
    barNumber: 1,
    beatInBar: 4,
    isDownbeat: false,
  });
  assert.deepEqual(beatPositionForIndex(4), {
    beatIndex: 4,
    barNumber: 2,
    beatInBar: 1,
    isDownbeat: true,
  });
  assert.deepEqual(beatPositionForIndex(-1), {
    beatIndex: -1,
    barNumber: -1,
    beatInBar: 4,
    isDownbeat: false,
  });
  assert.equal(isDownbeatIndex(-4), true);
  assert.equal(isDownbeatIndex(6), false);
});

test("media time maps to wall-clock time at different playback rates", () => {
  assertNear(mediaTimeToWallClock(12, {
    mediaTimeSeconds: 10,
    wallClockSeconds: 100,
    playbackRate: 1,
  }), 102);

  assertNear(mediaTimeToWallClock(12, {
    mediaTimeSeconds: 10,
    wallClockSeconds: 100,
    playbackRate: 2,
  }), 101);

  assertNear(mediaTimeToWallClock(9, {
    mediaTimeSeconds: 10,
    wallClockSeconds: 100,
    playbackRate: 0.5,
  }), 98);
});

test("an anchor becomes stale when media time jumps during a seek", () => {
  const oldAnchor = {
    mediaTimeSeconds: 10,
    wallClockSeconds: 100,
    playbackRate: 1,
  };
  const ordinaryPlayback = {
    mediaTimeSeconds: 10.04,
    wallClockSeconds: 100.04,
    playbackRate: 1,
    paused: false,
    seeking: false,
  };
  const afterSeek = {
    mediaTimeSeconds: 40,
    wallClockSeconds: 100.05,
    playbackRate: 1,
    paused: false,
    seeking: false,
  };

  assert.equal(playbackAnchorIsCurrent(oldAnchor, ordinaryPlayback), true);
  assert.equal(playbackAnchorIsCurrent(oldAnchor, afterSeek), false);

  // A fresh anchor starts the new beat near the current audio clock instead of
  // mapping it about thirty seconds into the future through the stale anchor.
  const freshAnchor = {
    mediaTimeSeconds: afterSeek.mediaTimeSeconds,
    wallClockSeconds: afterSeek.wallClockSeconds,
    playbackRate: afterSeek.playbackRate,
  };
  assert.equal(playbackAnchorIsCurrent(freshAnchor, afterSeek), true);
  assertNear(mediaTimeToWallClock(40.5, freshAnchor), 100.55);
  assertNear(mediaTimeToWallClock(40.5, oldAnchor), 130.5);
});

test("a playing media element cannot restart scheduling until seeking finishes", () => {
  const base = {
    mediaTimeSeconds: 12,
    wallClockSeconds: 80,
    playbackRate: 1,
    paused: false,
  };

  assert.equal(playbackSnapshotCanSchedule({ ...base, seeking: true }), false);
  assert.equal(playbackSnapshotCanSchedule({ ...base, seeking: false }), true);
  assert.equal(playbackSnapshotCanSchedule({ ...base, paused: true, seeking: false }), false);
});

test("a playback-rate change also invalidates the previous anchor", () => {
  const anchor = { mediaTimeSeconds: 20, wallClockSeconds: 200, playbackRate: 1 };
  const changedRate = {
    mediaTimeSeconds: 20,
    wallClockSeconds: 200,
    playbackRate: 1.25,
    paused: false,
    seeking: false,
  };
  assert.equal(playbackAnchorIsCurrent(anchor, changedRate), false);
});

test("post-seek confirmation requires media and audio clocks to advance together", () => {
  const resumedAnchor = { mediaTimeSeconds: 40, wallClockSeconds: 100, playbackRate: 1 };
  const healthyAdvance = {
    mediaTimeSeconds: 40.05,
    wallClockSeconds: 100.05,
    playbackRate: 1,
    paused: false,
    seeking: false,
  };
  const barelyMoving = {
    mediaTimeSeconds: 40.002,
    wallClockSeconds: 100.05,
    playbackRate: 1,
    paused: false,
    seeking: false,
  };

  assert.equal(transportAdvanceIsConfirmed(resumedAnchor, healthyAdvance), true);
  assert.equal(transportAdvanceIsConfirmed(resumedAnchor, barelyMoving), false);
  assert.equal(transportAdvanceIsConfirmed(resumedAnchor, {
    ...healthyAdvance,
    seeking: true,
  }), false);
});

test("a schedule includes its start, excludes its end, and marks downbeats", () => {
  const events = scheduleBeatEvents({
    fromMediaTimeSeconds: 1.25,
    toMediaTimeSeconds: 3.76,
    barOneAtSeconds: 1.25,
    beatPeriodSeconds: 0.5,
    beatsPerBar: 4,
    anchor: {
      mediaTimeSeconds: 1.25,
      wallClockSeconds: 10,
      playbackRate: 1,
    },
  });

  assert.deepEqual(events.map((event) => event.beatIndex), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(events.map((event) => event.isDownbeat), [true, false, false, false, true, false]);
  assert.deepEqual(events.map((event) => event.barNumber), [1, 1, 1, 1, 2, 2]);
  assert.deepEqual(events.map((event) => event.beatInBar), [1, 2, 3, 4, 1, 2]);
  assert.deepEqual(events.map((event) => event.wallClockSeconds), [10, 10.5, 11, 11.5, 12, 12.5]);
});

test("neighbouring half-open windows never schedule a boundary twice", () => {
  const common = {
    barOneAtSeconds: 1,
    beatPeriodSeconds: 0.5,
    anchor: { mediaTimeSeconds: 1, wallClockSeconds: 20, playbackRate: 1 },
  };
  const first = scheduleBeatEvents({
    ...common,
    fromMediaTimeSeconds: 1,
    toMediaTimeSeconds: 2,
  });
  const second = scheduleBeatEvents({
    ...common,
    fromMediaTimeSeconds: 2,
    toMediaTimeSeconds: 3,
  });

  assert.deepEqual(first.map((event) => event.mediaTimeSeconds), [1, 1.5]);
  assert.deepEqual(second.map((event) => event.mediaTimeSeconds), [2, 2.5]);
});

test("scheduled wall-clock times account for playback rate", () => {
  const events = scheduleBeatEvents({
    fromMediaTimeSeconds: 5,
    toMediaTimeSeconds: 6.1,
    barOneAtSeconds: 5,
    beatPeriodSeconds: 0.5,
    anchor: { mediaTimeSeconds: 5, wallClockSeconds: 50, playbackRate: 2 },
  });

  assert.deepEqual(events.map((event) => event.mediaTimeSeconds), [5, 5.5, 6]);
  assert.deepEqual(events.map((event) => event.wallClockSeconds), [50, 50.25, 50.5]);
});

test("invalid grids and paused anchors return safe empty answers", () => {
  assert.equal(beatIndexAtOrAfter(1, 0, 0), null);
  assert.equal(beatTimeAtIndex(1.5, 0, 0.5), null);
  assert.equal(mediaTimeToWallClock(1, {
    mediaTimeSeconds: 1,
    wallClockSeconds: 4,
    playbackRate: 0,
  }), null);
  assert.deepEqual(scheduleBeatEvents({
    fromMediaTimeSeconds: 1,
    toMediaTimeSeconds: 2,
    barOneAtSeconds: 1,
    beatPeriodSeconds: 0.5,
    anchor: { mediaTimeSeconds: 1, wallClockSeconds: 4, playbackRate: 0 },
  }), []);
  assert.deepEqual(scheduleBeatEvents({
    fromMediaTimeSeconds: 1,
    toMediaTimeSeconds: 2,
    barOneAtSeconds: null,
    beatPeriodSeconds: 0.5,
    anchor: { mediaTimeSeconds: 1, wallClockSeconds: 4, playbackRate: 1 },
  }), []);
});
