const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } = require("electron");
const { mkdirSync } = require("node:fs");
const fs = require("fs/promises");
const { randomUUID } = require("node:crypto");
const path = require("path");
const { pathToFileURL } = require("url");
const { readId3Metadata, readMp4Metadata } = require("./metadata.cjs");
const appUrl = pathToFileURL(path.join(__dirname, "index.html")).href;
const MAX_RECORDING_BYTES = 512 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([".wav", ".wave", ".aif", ".aiff", ".aifc", ".flac", ".mp3", ".m4a", ".mp4", ".alac", ".aac", ".ogg", ".oga", ".opus", ".weba", ".webm", ".mp2", ".mpga", ".m4b", ".caf", ".amr", ".ac3", ".mka", ".mkv", ".wma", ".au"]);

// Resolve the existing profile before setting the new display name.
const profilePath = app.getPath("userData");
mkdirSync(profilePath, { recursive: true });
app.setPath("userData", profilePath);
app.setName("HearPlot");

function openWebLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) void shell.openExternal(parsed.href).catch(() => {});
  } catch { /* Untrusted or unsupported links remain closed. */ }
}

function trustedSender(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url.split("#")[0] !== appUrl) throw new Error("Untrusted file request");
}

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
    title: app.name,
    backgroundColor: "#080808",
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Metronome scheduling and pending recording jobs must keep moving
      // while a file sheet or another application covers the workspace.
      backgroundThrottling: false,
    },
  });

  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openWebLink(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.split("#")[0] !== appUrl) { event.preventDefault(); openWebLink(url); }
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
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

// The native menu must carry its user gesture into the file input. An IPC
// message alone loses that activation and Chromium silently blocks the picker.
function sendSessionMenuAction(action) {
  const targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const contents = targetWindow?.webContents;
  if (!contents || contents.getURL().split("#")[0] !== appUrl) return;
  if (action === "load-session") {
    void contents.executeJavaScript('document.getElementById("loadSessionButton").click()', true)
      .catch(() => console.warn("Session file chooser could not be opened"));
  } else if (action === "save-session") {
    contents.send("menu:action", action);
  }
}

// app.js owns session validation and export for both native and browser use.
function installApplicationMenu() {

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
        { label: "Load Session…", accelerator: "CmdOrCtrl+O", click: () => sendSessionMenuAction("load-session") },
        { label: "Save Session…", accelerator: "CmdOrCtrl+S", click: () => sendSessionMenuAction("save-session") },
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
ipcMain.handle("audio:metadata", async (event, filePath) => { trustedSender(event); return readAudioMetadata(filePath); });
ipcMain.handle("audio:load-file", async (event, filePath) => { trustedSender(event); return readRecentAudioFile(filePath); });
ipcMain.handle("session:save-json", async (event, name, json) => {
  trustedSender(event);
  return saveJsonFile(BrowserWindow.fromWebContents(event.sender), name, json);
});

async function saveJsonFile(window, name, json) {
  if (typeof name !== "string" || !/^[a-z0-9_-]{1,150}\.json$/i.test(name)) throw new Error("Invalid export name");
  if (typeof json !== "string" || Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error("Export exceeds the session size limit");
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: `Save ${app.name} JSON`,
    defaultPath: name,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePath) return false;
  const temporary = path.join(path.dirname(filePath), `.music-analyser-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, json, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    await fs.rename(temporary, filePath);
    return true;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function readRecentAudioFile(filePath) {
  const safePath = normaliseReadablePath(filePath);
  if (!AUDIO_EXTENSIONS.has(path.extname(safePath).toLowerCase())) throw new Error("Unsupported recording file type");
  const stats = await fs.stat(safePath);
  if (!stats.isFile()) throw new Error("Recording is not a regular file");
  if (stats.size > MAX_RECORDING_BYTES) throw new Error("Recording is larger than 512 MB");
  const data = await fs.readFile(safePath);
  return {
    path: safePath,
    name: path.basename(safePath),
    size: stats.size,
    // Chromium File.lastModified truncates fractional milliseconds. Match the picker’s storage key.
    lastModified: Math.trunc(stats.mtimeMs),
    type: mimeTypeForPath(safePath),
    data,
    metadata: { ...metadataFromAudioBytes(safePath, data), roundedLastModified: Math.round(stats.mtimeMs) },
  };
}

async function readAudioMetadata(filePath) {
  try {
    const safePath = normaliseReadablePath(filePath);
    const extension = path.extname(safePath).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(extension)) return {};
    const stats = await fs.stat(safePath);
    if (!stats.isFile()) return {};
    const identity = { roundedLastModified: Math.round(stats.mtimeMs) };
    // The timestamp identifies older autosaves even for formats without supported tags.
    if (stats.size > 256 * 1024 * 1024 || ![".mp3", ".m4a", ".mp4", ".aac", ".alac"].includes(extension)) return identity;
    return { ...metadataFromAudioBytes(safePath, await fs.readFile(safePath)), ...identity };
  } catch (error) {
    console.warn("Audio metadata could not be read:", error.code || error.name);
    return {};
  }
}

function metadataFromAudioBytes(filePath, data) {
  const extension = path.extname(filePath).toLowerCase();
  if (data.length > 256 * 1024 * 1024) return {};
  if (extension === ".mp3") return readId3Metadata(data);
  if (![".m4a", ".mp4", ".aac", ".alac"].includes(extension)) return {};
  return data.subarray(0, 3).toString("latin1") === "ID3" ? readId3Metadata(data) : readMp4Metadata(data);
}

function normaliseReadablePath(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0")) throw new Error("Invalid recording path");
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
