// Integration checks run against the real renderer in a disposable Electron profile.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Hold the test process open until cleanup and the actual test exit code are settled.
app.on("window-all-closed", () => {});

let profile;
let timeout;
(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "music-analyser-tests-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest((details, respond) => respond({ cancel: /^https?:/.test(details.url) }));
  timeout = setTimeout(() => { console.error("Renderer checks timed out"); app.exit(1); }, 60000);
  await window.loadFile(path.join(__dirname, "../index.html"));
  const code = await fs.readFile(path.join(__dirname, "../tests/renderer-checks.js"), "utf8");
  const results = await window.webContents.executeJavaScript(code);
  const uiChecks = await fs.readFile(path.join(__dirname, "../tests/renderer-ui-checks.js"), "utf8");
  results.push(...await window.webContents.executeJavaScript(uiChecks));
  const mixChecks = await fs.readFile(path.join(__dirname, "../tests/mixlab-renderer-checks.js"), "utf8");
  results.push(...await window.webContents.executeJavaScript(mixChecks));
  const sessionChecks = await fs.readFile(path.join(__dirname, "../tests/session-workflows.js"), "utf8");
  results.push(...await window.webContents.executeJavaScript(sessionChecks));
  for (const [width, height, zoom] of [[980, 658, 1], [1280, 700, 1], [1440, 900, 1], [1920, 1080, 1], [980, 658, 2], [320, 680, 1], [320, 300, 1]]) {
    const layout = new BrowserWindow({ show: false, width, height, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await layout.loadFile(path.join(__dirname, "../index.html"));
    layout.webContents.setZoomFactor(zoom);
    const measurements = await layout.webContents.executeJavaScript(`(async () => {
      await loadAudioFile(createDemoAudioFile());
      await new Promise(requestAnimationFrame);
      const normalOverflow = document.documentElement.scrollWidth > innerWidth;
      const controls = [ui.newAnalysisButton, sessionMenu.querySelector('summary'), ui.themeButton].map(e=>({width:e.getBoundingClientRect().width,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}));
      sessionMenu.open = true;
      const menu = sessionMenu.querySelector('.session-menu__items').getBoundingClientRect();
      sessionMenu.open = false;
      setFocusedView(true);
      const spectrum=ui.spectrogramFrame.getBoundingClientRect();
      const waveform=ui.waveformFrame.getBoundingClientRect();
      const transport=ui.playButton.closest('.transport').getBoundingClientRect();
      state.selection={start:1,end:3,source:'waveform'};
      openQuickNote({clientX:innerWidth-5,clientY:innerHeight-5});
      ui.quickCustomCategoryRow.hidden=false;
      positionQuickNote();
      const quick=ui.quickNoteForm.getBoundingClientRect();
      return {width:innerWidth,height:innerHeight,normalOverflow,controls,menuLeft:menu.left,menuRight:menu.right,spectrumBottom:spectrum.bottom,waveformBottom:waveform.bottom,spectrumTop:spectrum.top,transportBottom:transport.bottom,waveformTop:waveform.top,quickBottom:quick.bottom,quickRight:quick.right};
    })()`);
    const ok = Math.abs(measurements.width - width / zoom) <= 1
      && !measurements.normalOverflow
      && measurements.controls.every(c=>c.width>0&&c.left>=0&&c.right<=measurements.width+1)
      && measurements.menuLeft >= 0 && measurements.menuRight <= measurements.width + 1
      && measurements.spectrumBottom <= measurements.height+1
      && measurements.waveformBottom <= measurements.spectrumTop+1
      && measurements.transportBottom <= measurements.waveformTop+1
      && measurements.quickBottom <= measurements.height+1
      && measurements.quickRight <= measurements.width+1;
    results.push({ name: `layout ${width}×${height} at ${zoom*100}% zoom`, ok, error: ok ? null : JSON.stringify(measurements) });
    layout.destroy();
  }
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.error ? `: ${result.error}` : ""}`);
  const failed = results.some((result) => !result.ok);
  clearTimeout(timeout);
  window.destroy();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(failed ? 1 : 0);
})().catch(async (error) => {
  clearTimeout(timeout);
  console.error(error);
  if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  app.exit(1);
});
