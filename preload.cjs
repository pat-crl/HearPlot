const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The web page runs without Node access. This bridge exposes only the few
// desktop features the music analyser needs: file paths, tag reading, and
// reopening a recent recording.
contextBridge.exposeInMainWorld("musicAnalyserNative", {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  readAudioMetadata(filePath) {
    return ipcRenderer.invoke("audio:metadata", filePath);
  },
  loadAudioFile(filePath) {
    return ipcRenderer.invoke("audio:load-file", filePath);
  },
  onMenuAction(callback) {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
});
