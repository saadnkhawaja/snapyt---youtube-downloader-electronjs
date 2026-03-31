const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  windowMinimize:    ()           => ipcRenderer.send('window-minimize'),
  windowClose:       ()           => ipcRenderer.send('window-close'),
  windowDragStart:   (screenX, screenY) => ipcRenderer.send('window-drag-start', { screenX, screenY }),
  windowDragMove:    (screenX, screenY) => ipcRenderer.send('window-drag-move', { screenX, screenY }),
  windowDragEnd:     ()           => ipcRenderer.send('window-drag-end'),
  openExternal:      (url)        => ipcRenderer.invoke('open-external', url),
  getVideos:         ()           => ipcRenderer.invoke('get-videos'),
  deleteVideo:       (filename)   => ipcRenderer.invoke('delete-video', filename),
  trashFile:         (filename)   => ipcRenderer.invoke('trash-file', filename),
  openFile:          (filename)   => ipcRenderer.invoke('open-file', filename),
  showFileInFolder:  (filename)   => ipcRenderer.invoke('show-file-in-folder', filename),
  openFolder:        ()           => ipcRenderer.invoke('open-folder'),
  openOutputFolder:  ()           => ipcRenderer.invoke('open-output-folder'),
  getOutputPath:     ()           => ipcRenderer.invoke('get-output-path'),
  setOutputPath:     (p)          => ipcRenderer.invoke('set-output-path', p),
  getPreferences:    ()           => ipcRenderer.invoke('get-preferences'),
  setPreferences:    (prefs)      => ipcRenderer.invoke('set-preferences', prefs),
  downloadVideo:     (url, opts)  => ipcRenderer.invoke('download-video', url, opts),
  cancelDownload:    ()           => ipcRenderer.invoke('cancel-download'),
  pauseDownload:     ()           => ipcRenderer.invoke('pause-download'),
  resumeDownload:    ()           => ipcRenderer.invoke('resume-download'),
  cleanupTempDownload:(filepath)  => ipcRenderer.invoke('cleanup-temp-download', filepath),
  getVideoInfo:      (url)        => ipcRenderer.invoke('get-video-info', url),
  getVideoFormats:   (url)        => ipcRenderer.invoke('get-video-formats', url),
  onDownloadProgress:(cb)         => ipcRenderer.on('download-progress', (_, data) => cb(data)),
  onDownloadStatus:  (cb)         => ipcRenderer.on('download-status', (_, status) => cb(status)),
  onYtdlpLog:        (cb)         => ipcRenderer.on('ytdlp-log', (_, line) => cb(line)),
  readClipboard:     ()           => {
    try { return navigator.clipboard.readText(); } catch { return Promise.resolve(''); }
  },
});
