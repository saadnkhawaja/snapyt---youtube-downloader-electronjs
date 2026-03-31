const { spawn, execFileSync } = require('child_process');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

/* ── Resolve yt-dlp: venv → system → standalone ── */
const ROOT   = path.join(__dirname, '..');
const MARKER = path.join(ROOT, 'bin', '.ytdlp-method');

function getVenvBinDir() {
  return path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
}

function getVenvYtdlpPath() {
  return path.join(getVenvBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function getBundledYtdlpPath() {
  return path.join(ROOT, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function findSystemYtdlp() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const output = execFileSync(cmd, ['yt-dlp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line)) || null;
  } catch {
    return null;
  }
}

function resolveYtdlp() {
  try {
    const m = fs.readFileSync(MARKER, 'utf8').trim();
    if (m === 'venv') {
      const b = getVenvYtdlpPath();
      if (fs.existsSync(b)) return b;
    }
    if (m === 'binary') {
      const b = getBundledYtdlpPath();
      if (fs.existsSync(b)) return b;
    }
  } catch {}
  const venv = getVenvYtdlpPath();
  if (fs.existsSync(venv)) return venv;
  const sys = findSystemYtdlp();
  if (sys) return sys;
  return getBundledYtdlpPath();
}

let _binary = null;
const getBinary = () => { if (!_binary) _binary = resolveYtdlp(); return _binary; };

function controlWindowsProcessTree(pid, action) {
  if (process.platform !== 'win32' || !pid || !['pause', 'resume'].includes(action)) return false;
  const processCommand = action === 'pause' ? 'Suspend-Process' : 'Resume-Process';
  const script = `
$ids = New-Object 'System.Collections.Generic.List[int]'
function Add-ProcessTree([int]$procId) {
  if ($ids.Contains($procId)) { return }
  $null = $ids.Add($procId)
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $procId" | ForEach-Object { Add-ProcessTree $_.ProcessId }
}
Add-ProcessTree ${pid}
foreach ($procId in $ids) {
  ${processCommand} -Id $procId -ErrorAction SilentlyContinue
}
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMGT]iB)(?:\s+at\s+([\d.]+)\s*([KMGT]iB)\/s)?(?:\s+ETA\s+(\S+))?/;

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function httpGet(url) {
  const lib = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function parseSize(num, unit) {
  const n = parseFloat(num);
  const map = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
  return Math.round(n * (map[unit] || 1));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanupRelatedDownloadFiles(filepath) {
  if (!filepath) return 0;

  const dir = path.dirname(filepath);
  const base = path.basename(filepath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  if (!fs.existsSync(dir)) return 0;

  const escapedBase = escapeRegex(base);
  const escapedStem = escapeRegex(stem);
  const patterns = [
    new RegExp(`^${escapedBase}$`),
    new RegExp(`^${escapedBase}\\.part(?:-Frag\\d+)?$`),
    new RegExp(`^${escapedBase}\\.ytdl$`),
    new RegExp(`^${escapedBase}\\.temp$`),
    new RegExp(`^${escapedStem}\\.f\\d+\\.[^.]+(?:\\.part(?:-Frag\\d+)?)?$`, 'i'),
    new RegExp(`^${escapedStem}\\.frag\\d+\\.[^.]+(?:\\.part)?$`, 'i'),
    new RegExp(`^${escapedStem}\\.part-Frag\\d+$`, 'i'),
    new RegExp(`^${escapedStem}\\.temp\\.[^.]+$`, 'i'),
  ];

  let deleted = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!patterns.some((pattern) => pattern.test(entry.name))) continue;
    try {
      fs.unlinkSync(path.join(dir, entry.name));
      deleted++;
    } catch {}
  }

  return deleted;
}

function resolveCompletedFilepath(plannedFilepath, reportedFilepath) {
  if (plannedFilepath && fs.existsSync(plannedFilepath)) return plannedFilepath;
  if (reportedFilepath && fs.existsSync(reportedFilepath)) return reportedFilepath;
  return plannedFilepath || reportedFilepath || '';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function uniqueDescending(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => b - a);
}

function normalizeFormat(format) {
  if (!format || !format.format_id) return null;

  const hasVideo = !!format.vcodec && format.vcodec !== 'none';
  const hasAudio = !!format.acodec && format.acodec !== 'none';
  if (!hasVideo && !hasAudio) return null;

  return {
    formatId: String(format.format_id),
    ext: format.ext || '',
    height: toNumber(format.height),
    width: toNumber(format.width),
    fps: toNumber(format.fps),
    tbr: toNumber(format.tbr),
    vcodec: format.vcodec || 'none',
    acodec: format.acodec || 'none',
    formatNote: format.format_note || '',
    dynamicRange: format.dynamic_range || '',
    hasVideo,
    hasAudio,
    filesize: toNumber(format.filesize) || toNumber(format.filesize_approx),
  };
}

function isVideoFormatForContainer(format, container) {
  if (!format?.hasVideo || !format.height) return false;
  if (container === 'mkv') return true;
  return format.ext === container;
}

function getAvailableQualities(formats, container) {
  const heights = formats
    .filter((format) => isVideoFormatForContainer(format, container))
    .map((format) => format.height);
  return ['best', ...uniqueDescending(heights).map(String)];
}

function buildQualityMap(formats) {
  return {
    mp4: getAvailableQualities(formats, 'mp4'),
    webm: getAvailableQualities(formats, 'webm'),
    mkv: getAvailableQualities(formats, 'mkv'),
  };
}

function pickBestCandidate(candidates, scoreFn) {
  let best = null;
  let bestScore = null;
  for (const candidate of candidates) {
    const score = scoreFn(candidate);
    if (!bestScore) {
      best = candidate;
      bestScore = score;
      continue;
    }
    let isBetter = false;
    for (let i = 0; i < score.length; i++) {
      if ((score[i] || 0) === (bestScore[i] || 0)) continue;
      isBetter = (score[i] || 0) > (bestScore[i] || 0);
      break;
    }
    if (isBetter) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function selectTargetHeight(candidates, quality) {
  const targetHeight = parseInt(quality, 10);
  if (!Number.isFinite(targetHeight)) return null;

  const heights = uniqueDescending(candidates.map((candidate) => candidate.height));
  if (!heights.length) return null;
  if (heights.includes(targetHeight)) return targetHeight;

  const lower = heights.find((height) => height < targetHeight);
  if (lower) return lower;

  return heights[heights.length - 1];
}

function scoreVideoFormat(format) {
  return [
    format.height || 0,
    format.fps || 0,
    format.hasAudio ? 0 : 1,
    format.tbr || 0,
    format.dynamicRange === 'HDR' ? 1 : 0,
  ];
}

function selectVideoFormat(formats, quality, container) {
  const candidates = formats.filter((format) => isVideoFormatForContainer(format, container));
  if (!candidates.length) return null;

  const targetHeight = quality && quality !== 'best'
    ? selectTargetHeight(candidates, quality)
    : null;

  const pool = targetHeight
    ? candidates.filter((candidate) => candidate.height === targetHeight)
    : candidates;

  return pickBestCandidate(pool, scoreVideoFormat);
}

function scoreAudioFormat(format, container) {
  const containerScore = container === 'webm'
    ? (format.ext === 'webm' ? 2 : 0)
    : (format.ext === 'm4a' || format.ext === 'mp4' ? 2 : 0);

  return [
    containerScore,
    format.tbr || 0,
  ];
}

function selectAudioFormat(formats, container) {
  const candidates = formats.filter((format) => !format.hasVideo && format.hasAudio);
  if (!candidates.length) return null;
  return pickBestCandidate(candidates, (format) => scoreAudioFormat(format, container));
}

function normalizeFetchedInfo(info) {
  const formats = Array.isArray(info.formats)
    ? info.formats.map(normalizeFormat).filter(Boolean)
    : [];
  const thumbnail = info.thumbnail
    || info.thumbnails?.slice().sort((a, b) => (b?.height || 0) - (a?.height || 0))[0]?.url
    || '';

  return {
    id: info.id,
    cacheKey: info.id || info.webpage_url || '',
    title: info.title || 'Unknown Title',
    author: info.uploader || info.channel || info.creator || 'Unknown',
    duration: toNumber(info.duration) || 0,
    thumbnail,
    formats,
    qualitiesByFormat: buildQualityMap(formats),
    formatsLoaded: true,
  };
}

function buildDownloadPlan(formats, quality, container) {
  if (container === 'audio') {
    const audio = selectAudioFormat(formats, 'mp4') || selectAudioFormat(formats, 'webm');
    if (!audio) return null;
    return {
      formatSelector: audio.formatId,
      mergeOutputFormat: null,
      remuxVideo: null,
      outputExt: audio.ext || 'm4a',
    };
  }

  const video = selectVideoFormat(formats, quality, container);
  if (!video) return null;

  if (video.hasAudio) {
    return {
      formatSelector: video.formatId,
      mergeOutputFormat: container,
      remuxVideo: container === 'mkv' ? 'mkv' : null,
      outputExt: container,
    };
  }

  const audio = selectAudioFormat(formats, container) || selectAudioFormat(formats, 'mp4') || selectAudioFormat(formats, 'webm');
  if (!audio) return null;

  return {
    formatSelector: `${video.formatId}+${audio.formatId}`,
    mergeOutputFormat: container,
    remuxVideo: container === 'mkv' ? 'mkv' : null,
    outputExt: container,
  };
}

class DownloadManager {
  constructor(outputPath, mainWindow, storage) {
    this.outputPath  = outputPath;
    this.mainWindow  = mainWindow;
    this.storage     = storage;
    this._activeProc = null;
    this._cancelled  = false;
    this._paused     = false;
    this._infoCache  = new Map();
    this._infoLoads  = new Map();
  }

  _log(l)             { try { this.mainWindow.webContents.send('ytdlp-log', l); } catch {} }
  _sendStatus(s)      { try { this.mainWindow.webContents.send('download-status', s); } catch {} }
  _sendProgress(d)    { try { this.mainWindow.webContents.send('download-progress', d); } catch {} }

  _cacheKeyFor(url, info = null) {
    return info?.cacheKey || info?.id || extractVideoId(url) || url;
  }

  async _loadYtdlpInfo(url) {
    return new Promise((resolve, reject) => {
      const proc = spawn(getBinary(), [
        '--ignore-config',
        '--dump-single-json',
        '--skip-download',
        '--no-warnings',
        '--no-playlist',
        '--no-check-certificate',
        '--socket-timeout', '10',
        url,
      ], { env: { ...process.env } });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          const message = stderr.split('\n').map((line) => line.trim()).filter(Boolean).pop();
          return reject(new Error(message || `Failed to fetch video formats (exit ${code})`));
        }

        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Failed to parse available video formats.'));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start yt-dlp: ${err.message}`));
      });
    });
  }

  async getVideoFormats(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error('Could not extract video ID from URL');

    const cached = this._infoCache.get(videoId);
    if (cached?.normalized) return cached.normalized;
    if (this._infoLoads.has(videoId)) return this._infoLoads.get(videoId);

    const loader = this._loadYtdlpInfo(url)
      .then((rawInfo) => {
        const normalized = normalizeFetchedInfo(rawInfo);
        const key = this._cacheKeyFor(url, normalized);
        this._infoCache.set(key, { rawInfo, normalized });
        if (key !== videoId) this._infoCache.set(videoId, { rawInfo, normalized });
        return normalized;
      })
      .finally(() => {
        this._infoLoads.delete(videoId);
      });

    this._infoLoads.set(videoId, loader);
    return loader;
  }

  async getVideoInfo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error('Could not extract video ID from URL');
    this._sendStatus('Fetching video information…');

    const [oembedRes, pageRes] = await Promise.all([
      httpGet(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}&format=json`),
      httpGet(`https://www.youtube.com/watch?v=${videoId}`),
    ]);

    let title = 'Unknown Title', author = 'Unknown';
    let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    try {
      const o = JSON.parse(oembedRes.data);
      title = o.title || title; author = o.author_name || author; thumbnail = o.thumbnail_url || thumbnail;
    } catch {}

    let duration = 0;
    const dm = pageRes.data.match(/"approxDurationMs":"(\d+)"/);
    if (dm) duration = Math.round(parseInt(dm[1], 10) / 1000);

    this._sendStatus('');
    return { id: videoId, title, author, duration, thumbnail };
  }

  async download(url, options) {
    this._cancelled = false; this._paused = false;
    let info = options.videoInfo || await this.getVideoInfo(url);
    const detailedInfo = await this.getVideoFormats(url);
    info = {
      ...detailedInfo,
      ...info,
      title: info?.title || detailedInfo.title,
      author: info?.author || detailedInfo.author,
      duration: info?.duration || detailedInfo.duration,
      thumbnail: info?.thumbnail || detailedInfo.thumbnail,
      formats: detailedInfo.formats,
      qualitiesByFormat: detailedInfo.qualitiesByFormat,
      formatsLoaded: true,
    };

    const plan = buildDownloadPlan(info.formats || [], options.quality, options.format);
    if (!plan) {
      throw new Error('No compatible download format was found for the selected quality.');
    }

    const isAudio = options.format === 'audio';
    const safeTitle = (info.title || 'Unknown Title').replace(/[/\\?%*:|"<>]/g, '-').trim() || 'video';

    let ext = plan.outputExt || 'mp4';
    if (!isAudio && options.format === 'mkv')  ext = 'mkv';
    if (!isAudio && options.format === 'webm') ext = 'webm';

    const outDir = this.storage.getOutputPath();
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let filename = `${safeTitle}.${ext}`, filepath = path.join(outDir, filename), n = 1;
    while (fs.existsSync(filepath)) { filename = `${safeTitle} (${n}).${ext}`; filepath = path.join(outDir, filename); n++; }

    const cacheKey = this._cacheKeyFor(url, info);
    const cached = this._infoCache.get(cacheKey) || this._infoCache.get(extractVideoId(url));

    return this._ytdlpDownload(url, filepath, plan, info, filename, isAudio, cached?.rawInfo || null);
  }

  _writeInfoJson(rawInfo, cacheKey) {
    const tempDir = path.join(os.tmpdir(), 'snapy-yt');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const safeKey = (cacheKey || 'video').replace(/[^a-zA-Z0-9._-]/g, '_');
    const jsonPath = path.join(tempDir, `${safeKey}-${Date.now()}.info.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(rawInfo), 'utf8');
    return jsonPath;
  }

  _ytdlpDownload(url, filepath, plan, info, filename, isAudio, rawInfo) {
    this._sendStatus('Starting download…');
    this._log(`[yt-dlp] binary: ${getBinary()}`);
    this._log(`[yt-dlp] format: ${plan.formatSelector}`);

    return new Promise((resolve, reject) => {
      const cacheKey = this._cacheKeyFor(url, info);
      const infoJsonPath = rawInfo ? this._writeInfoJson(rawInfo, cacheKey) : null;
      const args = [
        '--ignore-config',
        '--output', filepath,
        '--format', plan.formatSelector,
        '--encoding', 'utf-8',
        '--no-warnings', '--no-playlist', '--no-check-certificate',
        '--newline', '--progress', '--no-color', '--socket-timeout', '10',
      ];

      if (plan.mergeOutputFormat) args.push('--merge-output-format', plan.mergeOutputFormat);
      if (plan.remuxVideo) args.push('--remux-video', plan.remuxVideo);

      if (infoJsonPath) {
        args.push('--load-info-json', infoJsonPath);
      } else {
        args.push(url);
      }

      const proc = spawn(getBinary(), args, {
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      });

      this._activeProc = proc;
      let totalSize = 0, stderr = '', started = false, actualFilepath = filepath;
      this._sendProgress({ percent: 0, totalSize: 0, currentSize: 0, speed: '', eta: '', filepath: actualFilepath });

      const handleChunk = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n|\r/)) {
          if (!line.trim()) continue;
          this._log(line);
          const dest = line.match(/^\[(?:download|ExtractAudio)\] Destination: (.+)$/);
          if (dest) actualFilepath = dest[1].trim().replace(/^"|"$/g, '');
          const merged = line.match(/^\[Merger\] Merging formats into "?(.+?)"?$/);
          if (merged) actualFilepath = merged[1].trim();
          const remuxed = line.match(/^\[VideoRemuxer\] Remuxing video from ".+" to "(.+)"$/);
          if (remuxed) actualFilepath = remuxed[1].trim();
          if (!started && /\[download\]/.test(line)) { started = true; this._sendStatus('Downloading…'); }
          const m = PROGRESS_RE.exec(line);
          if (!m) continue;
          const percent = Math.round(parseFloat(m[1]));
          totalSize = parseSize(m[2], m[3]);
          this._sendProgress({
            percent, totalSize, currentSize: Math.round((percent / 100) * totalSize),
            speed: m[4] && m[5] ? `${m[4]} ${m[5]}/s` : '', eta: m[6] || '', filepath: actualFilepath,
          });
        }
      };

      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', (c) => { handleChunk(c); stderr += c.toString(); });

      proc.on('close', (code) => {
        this._activeProc = null;
        if (infoJsonPath) { try { fs.unlinkSync(infoJsonPath); } catch {} }
        if (this._cancelled) {
          cleanupRelatedDownloadFiles(actualFilepath);
          return reject(new Error('Download cancelled'));
        }
        if (code !== 0) {
          cleanupRelatedDownloadFiles(actualFilepath);
          return reject(new Error(stderr.split('\n').filter(Boolean).pop() || `Download failed (exit ${code})`));
        }
        this._sendStatus('Download complete!');
        const finalFilepath = resolveCompletedFilepath(filepath, actualFilepath);
        const actualFilename = path.basename(finalFilepath);
        let fileSize = totalSize;
        try { fileSize = fs.statSync(finalFilepath).size; } catch {}
        this.storage.addVideo({
          filename: actualFilename, title: info.title, duration: info.duration,
          size: fileSize, thumbnail: info.thumbnail, url,
          type: isAudio ? 'audio' : 'video', dateAdded: new Date().toISOString(),
        });
        resolve({ success: true, filename: actualFilename, filepath: finalFilepath, size: fileSize, url, type: isAudio ? 'audio' : 'video' });
      });

      proc.on('error', (err) => {
        this._activeProc = null;
        if (infoJsonPath) { try { fs.unlinkSync(infoJsonPath); } catch {} }
        cleanupRelatedDownloadFiles(actualFilepath);
        reject(new Error(`Failed to start yt-dlp: ${err.message}`));
      });
    });
  }

  cleanupPartialDownload(filepath) {
    return cleanupRelatedDownloadFiles(filepath);
  }

  cancel()  {
    this._cancelled = true;
    if (this._activeProc) {
      if (this._paused && process.platform === 'win32') {
        controlWindowsProcessTree(this._activeProc.pid, 'resume');
        this._paused = false;
      }
      this._activeProc.kill('SIGTERM');
      this._activeProc = null;
    }
  }
  pause()   {
    if (!this._activeProc || this._paused) return false;
    try {
      if (process.platform === 'win32') {
        if (!controlWindowsProcessTree(this._activeProc.pid, 'pause')) return false;
      } else {
        this._activeProc.kill('SIGSTOP');
      }
      this._paused = true;
      this._sendStatus('Paused');
      return true;
    } catch {
      return false;
    }
  }
  resume()  {
    if (!this._activeProc || !this._paused) return false;
    try {
      if (process.platform === 'win32') {
        if (!controlWindowsProcessTree(this._activeProc.pid, 'resume')) return false;
      } else {
        this._activeProc.kill('SIGCONT');
      }
      this._paused = false;
      this._sendStatus('Downloading…');
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = DownloadManager;
