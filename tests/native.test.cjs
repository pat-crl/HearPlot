const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
function harness(window = null, showSaveDialog) {
  const reads = [];
  const profile = "/existing-profile/music-analyser";
  const startup = [];
  const disk = { stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 123 }),
    readFile: async (name) => { reads.push(name); return Buffer.from("not an ID3 tag"); } };
  const context = { __dirname: root, Buffer, URL, console, module: { exports: {} }, require(name) {
    if (name === "electron") return {
      app: {
        getPath: (key) => { startup.push(["read", key]); return profile; },
        setPath: (key, value) => startup.push(["path", key, value]),
        setName: (name) => startup.push(["name", name]),
        whenReady: () => ({ then() {} }),
        on() {},
      },
      ipcMain: { handle() {} },
      BrowserWindow: { getFocusedWindow: () => window, getAllWindows: () => [] },
      dialog: { showSaveDialog },
    };
    if (name === "node:fs") return { mkdirSync: (directory) => startup.push(["mkdir", directory]) };
    if (name === "fs/promises") return disk;
    if (name === "./metadata.cjs") return require("../metadata.cjs");
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "main.cjs"), "utf8") + "\nmodule.exports={readAudioMetadata,readRecentAudioFile,normaliseReadablePath,trustedSender,sendSessionMenuAction,saveJsonFile};", context);
  return { ...context.module.exports, disk, reads, profile, startup };
}
test("the HearPlot display name preserves the existing Electron profile", () => {
  const { startup, profile } = harness();
  assert.deepEqual(startup, [["read", "userData"], ["mkdir", profile], ["path", "userData", profile], ["name", "HearPlot"]]);
});
test("WAV metadata lookup avoids reading the entire recording again", async () => {
  const h = harness(); await h.readAudioMetadata("/recordings/study.wav"); assert.equal(h.reads.length, 0);
});
test("metadata parsing skips oversized tagged files", async () => {
  const h = harness(); h.disk.stat = async () => ({ isFile: () => true, size: 300 * 1024 * 1024 });
  await h.readAudioMetadata("/recordings/study.mp3"); assert.equal(h.reads.length, 0);
});
test("recent-file opening rejects directories and invalid paths before reading", async () => {
  const h = harness(); h.disk.stat = async () => ({ isFile: () => false });
  await assert.rejects(h.readRecentAudioFile("/recordings/folder"));
  for (const p of [null, {}, "relative.wav", "/recordings/a\0.wav"]) assert.throws(() => h.normaliseReadablePath(p));
  assert.equal(h.reads.length, 0);
});
test("native file requests require the main local app frame", () => {
  const h = harness(); const frame = { url: pathToFileURL(path.join(root, "index.html")).href };
  assert.doesNotThrow(() => h.trustedSender({ senderFrame: frame, sender: { mainFrame: frame } }));
  assert.throws(() => h.trustedSender({ senderFrame: { url: "https://example.com" }, sender: { mainFrame: frame } }));
  assert.throws(() => h.trustedSender({ senderFrame: { ...frame }, sender: { mainFrame: frame } }));
});
test("native Load Session preserves user activation only for the local application", () => {
  const calls = [];
  let url = pathToFileURL(path.join(root, "index.html")).href;
  const h = harness({ webContents: {
    getURL: () => url,
    executeJavaScript: (code, gesture) => { calls.push({ code, gesture }); return Promise.resolve(); },
    send: (...args) => calls.push(args),
  } });
  h.sendSessionMenuAction("load-session");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gesture, true);
  assert.match(calls[0].code, /loadSessionButton/);
  h.sendSessionMenuAction("save-session");
  assert.deepEqual(calls[1], ["menu:action", "save-session"]);
  url = "https://example.com";
  h.sendSessionMenuAction("load-session");
  assert.equal(calls.length, 2);
  harness().sendSessionMenuAction("load-session");
});
test("cancelled native JSON exports never touch the filesystem", async () => {
  const h = harness(null, async () => ({ canceled: true }));
  h.disk.writeFile = async () => assert.fail("Cancelled export wrote a file");
  assert.equal(await h.saveJsonFile(null, "session.json", "{}"), false);
  await assert.rejects(() => h.saveJsonFile(null, "../session.json", "{}"));
});
test("a failed native export leaves the existing file intact and cleans its staging file", async () => {
  const chosen = "/exports/session.json";
  let staged;
  let removed;
  const h = harness(null, async () => ({ filePath: chosen }));
  h.disk.writeFile = async (temporary, data) => {
    staged = temporary;
    assert.equal(path.dirname(temporary), path.dirname(chosen));
    assert.notEqual(temporary, chosen);
    assert.equal(data, '{"annotations":[]}');
  };
  h.disk.rename = async (from, to) => {
    assert.equal(from, staged);
    assert.equal(to, chosen);
    throw new Error("Destination not writable");
  };
  h.disk.unlink = async (name) => { removed = name; };
  await assert.rejects(() => h.saveJsonFile(null, "session.json", '{"annotations":[]}'), /not writable/);
  assert.equal(removed, staged);
});
test("Recent uses the same sub-millisecond file identity as the macOS picker and reads tagged audio once", async () => {
  const h = harness();
  h.disk.stat = async () => ({ isFile: () => true, size: 14, mtimeMs: 1700000000123.89 });
  const recording = await h.readRecentAudioFile("/recordings/study.mp3");
  assert.equal(recording.lastModified, 1700000000123);
  assert.equal(recording.metadata.roundedLastModified, 1700000000124);
  assert.equal(h.reads.length, 1);
});
