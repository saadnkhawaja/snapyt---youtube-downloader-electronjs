/*
 * ╔═══════════════════════════════════════════════════════╗
 * ║                                                       ║
 * ║    ██████╗ ██╗  ██╗  │                                ║
 * ║   ██╔════╝ ██║ ██╔╝  │  Saad Khawaja                  ║
 * ║   ╚█████╗  █████╔╝   │  open source apps, dev tools,  ║
 * ║    ╚═══██╗ ██╔═██╗   │  games, utilities etc.         ║
 * ║   ██████╔╝ ██║  ██╗  │  github.com/saadnkhawaja       ║
 * ║   ╚═════╝  ╚═╝  ╚═╝  │  www.saadkhawaja.com           ║
 * ║                                                       ║
 * ╚═══════════════════════════════════════════════════════╝
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeImage,
} = require("electron");
const { execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const DownloadManager = require("./download-manager");
const Storage = require("./storage");

let mainWindow, downloadManager, storage;
let windowDragState = null;
let devWatcher = null;
let devReloadTimer = null;
let devPendingAction = null;
const ROOT = path.join(__dirname, "..");
const isDev = process.argv.includes("--dev");

function getRuntimeIconPath() {
  return path.join(
    __dirname,
    "images",
    process.platform === "win32" ? "icon.ico" : "icon.png",
  );
}

function getRuntimeIcon() {
  const iconPath = getRuntimeIconPath();
  return fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : undefined;
}

function getVenvBinDir() {
  return path.join(
    ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
  );
}

function getVenvYtdlpPath() {
  return path.join(
    getVenvBinDir(),
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
}

function getVenvPipPath() {
  return path.join(
    getVenvBinDir(),
    process.platform === "win32" ? "pip.exe" : "pip",
  );
}

function getPythonCandidates() {
  return process.platform === "win32"
    ? ["python", "py -3.10", "py -3", "python3"]
    : ["python3", "python"];
}

/* ── Auto-setup fast yt-dlp (pip venv) ── */
function ensureFastYtdlp() {
  const venvBin = getVenvYtdlpPath();
  if (fs.existsSync(venvBin)) return;
  const pythonCmd = getPythonCandidates().find((cmd) => {
    try {
      const v = execSync(`${cmd} --version 2>&1`, { encoding: "utf8" });
      const m = v.match(/(\d+)\.(\d+)/);
      return m && +m[1] >= 3 && +m[2] >= 8;
    } catch {
      return false;
    }
  });
  if (!pythonCmd) return;
  try {
    console.log("[snapy-yt] Setting up fast yt-dlp…");
    const venvDir = path.join(ROOT, ".venv");
    execSync(`${pythonCmd} -m venv "${venvDir}"`, { stdio: "inherit" });
    execSync(`"${getVenvPipPath()}" install --quiet yt-dlp`, {
      stdio: "inherit",
    });
  } catch (e) {
    console.warn("[snapy-yt] pip setup failed:", e.message);
  }
}

/* ── Window ── */
function enforceWindowChrome(win) {
  if (process.platform !== "win32" || !win || win.isDestroyed()) return;
  win.setHasShadow(false);
  win.setBackgroundMaterial("none");
}

function resolveManagedTarget(target) {
  const rawTarget = String(target || "").trim();
  if (!rawTarget) return "";
  if (path.isAbsolute(rawTarget)) return path.normalize(rawTarget);
  return path.join(storage.getOutputPath(), rawTarget);
}

function closeDevWatcher() {
  clearTimeout(devReloadTimer);
  devReloadTimer = null;
  devPendingAction = null;
  if (devWatcher) {
    devWatcher.close();
    devWatcher = null;
  }
}

function getDevChangeAction(filename = "") {
  const normalized = String(filename).replace(/\\/g, "/").toLowerCase();
  const basename = path.basename(normalized);
  if (!normalized) return null;
  if (!/\.(css|html|js|json)$/.test(normalized)) return null;
  if (
    basename === "main.js" ||
    basename === "preload.js" ||
    basename === "download-manager.js" ||
    basename === "storage.js"
  ) {
    return "relaunch";
  }
  return "reload";
}

function scheduleDevRefresh(action, filename) {
  if (!action) return;
  if (action === "relaunch" || devPendingAction !== "relaunch")
    devPendingAction = action;
  clearTimeout(devReloadTimer);
  devReloadTimer = setTimeout(async () => {
    const nextAction = devPendingAction;
    devPendingAction = null;
    if (nextAction === "relaunch") {
      console.log(`[snapy-yt:dev] relaunching after change in ${filename}`);
      closeDevWatcher();
      app.relaunch();
      app.exit(0);
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.log(
      `[snapy-yt:dev] reloading renderer after change in ${filename}`,
    );
    try {
      await mainWindow.webContents.session.clearCache();
    } catch {}
    if (!mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
  }, 120);
}

function setupDevWatcher() {
  if (!isDev || devWatcher) return;
  try {
    devWatcher = fs.watch(
      __dirname,
      { recursive: true },
      (_eventType, filename) => {
        const action = getDevChangeAction(filename);
        if (!action) return;
        scheduleDevRefresh(action, filename);
      },
    );
    console.log("[snapy-yt:dev] Watching src/ for changes");
  } catch (error) {
    console.warn("[snapy-yt:dev] Failed to start file watcher:", error.message);
  }
}

const createWindow = () => {
  const isWindows = process.platform === "win32";
  mainWindow = new BrowserWindow({
    width: 1058,
    height: 681,
    minWidth: 852,
    minHeight: 582,
    frame: false,
    resizable: isWindows ? false : true,
    maximizable: isWindows ? false : undefined,
    transparent: isWindows,
    thickFrame: isWindows ? false : undefined,
    hasShadow: isWindows ? false : undefined,
    backgroundMaterial: isWindows ? "none" : undefined,
    backgroundColor: isWindows ? "#00000000" : "#EEF3FA",
    show: false,
    icon: getRuntimeIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  enforceWindowChrome(mainWindow);
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.once("ready-to-show", () => {
    enforceWindowChrome(mainWindow);
    mainWindow.show();
    enforceWindowChrome(mainWindow);
  });
  mainWindow.on("focus", () => enforceWindowChrome(mainWindow));
  mainWindow.on("restore", () => enforceWindowChrome(mainWindow));
  mainWindow.on("move", () => enforceWindowChrome(mainWindow));
  mainWindow.on("closed", () => {
    mainWindow = null;
    closeDevWatcher();
  });

  // Open DevTools with Cmd+Option+I (macOS) or F12
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      (input.meta && input.alt && input.key === "i") ||
      (input.control && input.shift && input.key === "i") ||
      input.key === "F12"
    ) {
      mainWindow.webContents.isDevToolsOpened()
        ? mainWindow.webContents.closeDevTools()
        : mainWindow.webContents.openDevTools();
    }
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
    setupDevWatcher();
  }
};

app.on("ready", () => {
  ensureFastYtdlp();
  if (process.platform === "darwin" && app.dock) {
    const icon = getRuntimeIcon();
    if (icon && !icon.isEmpty()) app.dock.setIcon(icon);
  }
  const docsPath = path.join(os.homedir(), "Documents", "snapy-yt");
  if (!fs.existsSync(docsPath)) fs.mkdirSync(docsPath, { recursive: true });
  storage = new Storage(docsPath);
  createWindow();
  downloadManager = new DownloadManager(docsPath, mainWindow, storage);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!mainWindow) createWindow();
});

/* ── IPC ── */
ipcMain.on("window-minimize", () => mainWindow.minimize());
ipcMain.on("window-close", () => mainWindow.close());
ipcMain.on("window-drag-start", (event, pos) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !pos) return;
  const [winX, winY] = win.getPosition();
  windowDragState = {
    winId: win.id,
    screenX: Number(pos.screenX) || 0,
    screenY: Number(pos.screenY) || 0,
    winX,
    winY,
  };
  enforceWindowChrome(win);
});
ipcMain.on("window-drag-move", (event, pos) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (
    !win ||
    win.isDestroyed() ||
    !windowDragState ||
    windowDragState.winId !== win.id ||
    !pos
  )
    return;
  const screenX = Number(pos.screenX);
  const screenY = Number(pos.screenY);
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  const nextX = Math.round(
    windowDragState.winX + (screenX - windowDragState.screenX),
  );
  const nextY = Math.round(
    windowDragState.winY + (screenY - windowDragState.screenY),
  );
  win.setPosition(nextX, nextY, false);
  enforceWindowChrome(win);
});
ipcMain.on("window-drag-end", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (windowDragState && win && windowDragState.winId === win.id)
    windowDragState = null;
  enforceWindowChrome(win);
});

ipcMain.handle("open-external", async (_, url) => shell.openExternal(url));
ipcMain.handle("get-videos", async () => storage.getVideos());
ipcMain.handle("delete-video", async (_, f) => storage.deleteVideo(f));
ipcMain.handle("trash-file", async (_, target) => {
  const filepath = resolveManagedTarget(target);
  if (!filepath) return false;
  try {
    await shell.trashItem(filepath);
    storage.deleteVideo(path.basename(filepath));
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle("open-file", async (_, target) => {
  const filepath = resolveManagedTarget(target);
  if (!filepath) return "File not found";
  return shell.openPath(filepath);
});
ipcMain.handle("show-file-in-folder", async (_, target) => {
  const filepath = resolveManagedTarget(target);
  if (!filepath) return false;
  shell.showItemInFolder(filepath);
  return true;
});
ipcMain.handle("open-output-folder", async () =>
  shell.openPath(storage.getOutputPath()),
);
ipcMain.handle("open-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    defaultPath: storage.getOutputPath(),
  });
  if (!result.canceled && result.filePaths.length > 0) {
    storage.setOutputPath(result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});
ipcMain.handle("get-output-path", async () => storage.getOutputPath());
ipcMain.handle("set-output-path", async (_, p) => storage.setOutputPath(p));
ipcMain.handle("get-preferences", async () => storage.getPreferences());
ipcMain.handle("set-preferences", async (_, p) => storage.setPreferences(p));
ipcMain.handle("download-video", async (_, url, opts) =>
  downloadManager.download(url, opts),
);
ipcMain.handle("cancel-download", async () => downloadManager.cancel());
ipcMain.handle("pause-download", async () => downloadManager.pause());
ipcMain.handle("resume-download", async () => downloadManager.resume());
ipcMain.handle("cleanup-temp-download", async (_, filepath) =>
  downloadManager.cleanupPartialDownload(filepath),
);
ipcMain.handle("get-video-info", async (_, url) =>
  downloadManager.getVideoInfo(url),
);
ipcMain.handle("get-video-formats", async (_, url) =>
  downloadManager.getVideoFormats(url),
);
