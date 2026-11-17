const { app, BrowserWindow, ipcMain, Menu, nativeImage } = require("electron");
const fs = require("fs/promises");
const path = require("path");

// This file is the small desktop-app shell around the existing HTML prototype.
// Electron provides the native window; index.html still owns the actual tool UI.
function createMainWindow() {
  const iconPath = path.join(__dirname, "assets", "app-icon.png");
  const appIcon = nativeImage.createFromPath(iconPath);

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    title: "Music Analyser",
    backgroundColor: "#080808",
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

app.whenReady().then(() => {
  installApplicationMenu();
  createMainWindow();

  // macOS apps usually reopen a window when the Dock icon is clicked.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

// Session commands belong in the normal macOS File menu. The menu sends a
// simple action name to the focused window; app.js still owns the actual file
// pickers and session data so there is only one implementation to understand.
function installApplicationMenu() {
  const sendAction = (action) => {
    const targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    targetWindow?.webContents.send("menu:action", action);
  };

  const template = [
    ...(process.platform === "darwin" ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "Load Session…", accelerator: "CmdOrCtrl+O", click: () => sendAction("load-session") },
        { label: "Save Session…", accelerator: "CmdOrCtrl+S", click: () => sendAction("save-session") },
        { type: "separator" },
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        // Undo/redo stay in app.js so Cmd+Z can switch intelligently between
        // annotation history and ordinary typing inside a text field.
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// These handlers are deliberately narrow: the page can ask for metadata or for
// a recent audio file it already knows about, but it cannot browse the whole Mac.
ipcMain.handle("audio:metadata", async (_event, filePath) => readAudioMetadata(filePath));
ipcMain.handle("audio:load-file", async (_event, filePath) => readRecentAudioFile(filePath));

async function readRecentAudioFile(filePath) {
  const safePath = normaliseReadablePath(filePath);
  const [data, stats] = await Promise.all([fs.readFile(safePath), fs.stat(safePath)]);
  return {
    path: safePath,
    name: path.basename(safePath),
    size: stats.size,
    lastModified: Math.round(stats.mtimeMs),
    type: mimeTypeForPath(safePath),
    data,
    metadata: await readAudioMetadata(safePath),
  };
}

async function readAudioMetadata(filePath) {
  try {
    const safePath = normaliseReadablePath(filePath);
    const data = await fs.readFile(safePath);
    const extension = path.extname(safePath).toLowerCase();
    if (extension === ".mp3" || data.slice(0, 3).toString("latin1") === "ID3") return readId3Metadata(data);
    if (extension === ".m4a" || extension === ".mp4" || extension === ".aac" || extension === ".alac") return readMp4Metadata(data);
    return {};
  } catch (error) {
    console.warn("Audio metadata could not be read:", error.message);
    return {};
  }
}

function normaliseReadablePath(filePath) {
  if (!filePath || typeof filePath !== "string") throw new Error("Missing file path");
  return path.resolve(filePath);
}

function mimeTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a" || extension === ".mp4" || extension === ".alac") return "audio/mp4";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".aiff" || extension === ".aif") return "audio/aiff";
  if (extension === ".flac") return "audio/flac";
  return "audio/*";
}

function readId3Metadata(data) {
  if (data.slice(0, 3).toString("latin1") !== "ID3") return {};
  const version = data[3];
  const tagSize = readSyncSafeInteger(data, 6);
  const end = Math.min(data.length, 10 + tagSize);
  const metadata = {};
  let offset = 10;

  while (offset + 10 <= end) {
    const frameId = data.slice(offset, offset + 4).toString("latin1").replace(/\0/g, "");
    if (!frameId) break;
    const frameSize = version === 4 ? readSyncSafeInteger(data, offset + 4) : data.readUInt32BE(offset + 4);
    const frameStart = offset + 10;
    const frameEnd = Math.min(end, frameStart + frameSize);
    const frame = data.slice(frameStart, frameEnd);

    if (frameId === "TIT2") metadata.title = decodeId3TextFrame(frame);
    if (frameId === "TPE1") metadata.artist = decodeId3TextFrame(frame);
    if (frameId === "TPE2") metadata.albumArtist = decodeId3TextFrame(frame);
    if (frameId === "TALB") metadata.album = decodeId3TextFrame(frame);
    if (frameId === "APIC" && !metadata.artwork) metadata.artwork = decodeId3Artwork(frame);

    offset = frameEnd;
  }

  return cleanMetadata(metadata);
}

function readMp4Metadata(data) {
  const metadata = {};
  walkMp4Atoms(data, 0, data.length, (atom, payloadStart, payloadEnd) => {
    if (atom === "\u00a9nam") metadata.title = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "\u00a9ART") metadata.artist = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "aART") metadata.albumArtist = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "\u00a9alb") metadata.album = readMp4DataText(data, payloadStart, payloadEnd);
    if (atom === "covr" && !metadata.artwork) metadata.artwork = readMp4Artwork(data, payloadStart, payloadEnd);
  });
  return cleanMetadata(metadata);
}

function walkMp4Atoms(data, start, end, visit) {
  const containerAtoms = new Set(["moov", "udta", "ilst", "trak", "mdia", "minf", "stbl"]);
  let offset = start;

  while (offset + 8 <= end) {
    let size = data.readUInt32BE(offset);
    const atom = data.slice(offset + 4, offset + 8).toString("latin1");
    let headerSize = 8;
    if (size === 1 && offset + 16 <= end) {
      size = Number(data.readBigUInt64BE(offset + 8));
      headerSize = 16;
    }
    if (size < headerSize || offset + size > end) break;

    let payloadStart = offset + headerSize;
    const payloadEnd = offset + size;
    visit(atom, payloadStart, payloadEnd);

    if (atom === "meta") payloadStart += 4; // version and flags sit before child atoms.
    if (containerAtoms.has(atom) || atom === "meta") walkMp4Atoms(data, payloadStart, payloadEnd, visit);
    offset += size;
  }
}

function readMp4DataText(data, start, end) {
  const payload = findMp4DataPayload(data, start, end);
  return payload ? data.slice(payload.start, payload.end).toString("utf8").replace(/\0/g, "").trim() : "";
}

function readMp4Artwork(data, start, end) {
  const payload = findMp4DataPayload(data, start, end);
  if (!payload) return "";
  const mime = payload.type === 14 ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${data.slice(payload.start, payload.end).toString("base64")}`;
}

function findMp4DataPayload(data, start, end) {
  let offset = start;
  while (offset + 16 <= end) {
    const size = data.readUInt32BE(offset);
    const atom = data.slice(offset + 4, offset + 8).toString("latin1");
    if (size < 16 || offset + size > end) break;
    if (atom === "data") {
      return {
        type: data.readUInt32BE(offset + 8) & 0xff,
        start: offset + 16,
        end: offset + size,
      };
    }
    offset += size;
  }
  return null;
}

function readSyncSafeInteger(data, offset) {
  return ((data[offset] & 0x7f) << 21) | ((data[offset + 1] & 0x7f) << 14) | ((data[offset + 2] & 0x7f) << 7) | (data[offset + 3] & 0x7f);
}

function decodeId3TextFrame(frame) {
  if (!frame.length) return "";
  return decodeId3Text(frame.slice(1), frame[0]);
}

function decodeId3Text(bytes, encoding) {
  if (encoding === 1 || encoding === 2) {
    const littleEndian = encoding === 1 ? !(bytes[0] === 0xfe && bytes[1] === 0xff) : false;
    const start = encoding === 1 && (bytes[0] === 0xff || bytes[0] === 0xfe) ? 2 : 0;
    const swapped = Buffer.alloc(Math.max(0, bytes.length - start));
    for (let index = start; index + 1 < bytes.length; index += 2) {
      const target = index - start;
      swapped[target] = littleEndian ? bytes[index] : bytes[index + 1];
      swapped[target + 1] = littleEndian ? bytes[index + 1] : bytes[index];
    }
    return swapped.toString("utf16le").replace(/\0/g, "").trim();
  }
  return bytes.toString(encoding === 3 ? "utf8" : "latin1").replace(/\0/g, "").trim();
}

function decodeId3Artwork(frame) {
  if (!frame.length) return "";
  const encoding = frame[0];
  let offset = 1;
  const mimeEnd = frame.indexOf(0, offset);
  if (mimeEnd === -1) return "";
  const mime = frame.slice(offset, mimeEnd).toString("latin1") || "image/jpeg";
  offset = mimeEnd + 2; // skip MIME terminator and picture type byte.
  const terminatorLength = encoding === 0 || encoding === 3 ? 1 : 2;
  while (offset + terminatorLength < frame.length) {
    const ended = terminatorLength === 1
      ? frame[offset] === 0
      : frame[offset] === 0 && frame[offset + 1] === 0;
    offset += terminatorLength;
    if (ended) break;
  }
  return `data:${mime};base64,${frame.slice(offset).toString("base64")}`;
}

function cleanMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => Boolean(value)));
}
