/* ── snapyt! renderer ── */
const GITHUB_URL = 'https://github.com/saadnkhawaja/snapyt---youtube-downloader-electronjs';
const YT_REGEX   = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?.*v=|shorts\/)|youtu\.be\/).+/i;
const ITEMS_PER_PAGE = 10;
const GALLERY_SORT_LABELS = {
  'date-desc': 'Newest first',
  'date-asc': 'Oldest first',
  'name-asc': 'Name A-Z',
  'name-desc': 'Name Z-A',
  'size-desc': 'Largest first',
  'duration-desc': 'Longest first',
};

class SnapyYT {
  constructor() {
    this.currentUrl      = '';
    this.currentInfo     = null;
    this.selectedQuality = 'best';
    this.selectedFormat  = 'mp4';
    this._fetchToken     = 0;

    // Auto Start settings
    this.autoClipboard    = true;
    this.autoStart        = false;
    this.autoStartQuality = 'best';
    this.autoStartFormat  = 'mp4';

    // Clipboard monitoring
    this._lastClipboard   = '';
    this._clipboardTimer  = null;

    // Queue
    this.downloadQueue   = [];   // { id, url, info, quality, format, title, thumb }
    this.isDownloading   = false;
    this._dlIdCounter    = 0;
    this._isPaused       = false;
    this._settingsScrollbarFadeTimer = null;
    this._settingsScrollbarSyncFrame = 0;
    this._settingsScrollbarMetrics   = null;
    this._customScrollbars = Object.create(null);

    // Session downloads (active + recent)
    this.sessionDownloads = []; // { id, title, thumb, url, percent, status, size, filename, type, speed, eta }

    // Gallery state
    this._galleryAll     = [];
    this._gallerySelected = new Set();
    this._galleryFilter  = 'all';
    this._gallerySearch  = '';
    this._gallerySort    = 'date-desc';
    this._galleryPage    = 1;
    this._gallerySortShuffleTimer = null;

    this.bindTitlebar();
    this.bindNav();
    this.initTheme();
    this.bindFab();
    this.bindDownloader();
    this.bindGallery();
    this.bindSettings();
    this.bindDownloadsScrollbar();
    this.bindGalleryScrollbar();
    this.bindSettingsScrollbar();

    window.electronAPI.onDownloadProgress((d) => this.handleProgress(d));
    window.electronAPI.onDownloadStatus((s)   => this.handleStatus(s));

    this.outputDir = '';
    this.loadOutputPath();
    this.loadSettings();
    this.loadRecentDownloads();
    this.loadGallery();
    this.startClipboardMonitor();
  }

  /* ═══ TITLEBAR ═══════════════════════════════ */
  bindTitlebar() {
    document.getElementById('btnMinimize').onclick = () => window.electronAPI.windowMinimize();
    document.getElementById('btnClose').onclick    = () => window.electronAPI.windowClose();
  }

  /* ═══ NAVIGATION ═════════════════════════════ */
  bindNav() {
    document.querySelectorAll('.nav-item').forEach(btn =>
      btn.addEventListener('click', () => this.navigate(btn.dataset.page))
    );
  }
  navigate(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById(page).classList.add('active');
    document.querySelector(`[data-page="${page}"]`).classList.add('active');
    if (page === 'downloader') this.queueDownloadsScrollbarSync();
    if (page === 'gallery') {
      this.loadGallery();
      this.queueGalleryScrollbarSync();
    }
    if (page === 'settings') this.queueSettingsScrollbarSync();
  }

  /* ═══ THEME ═══════════════════════════════════ */
  initTheme() {
    const saved = localStorage.getItem('theme');
    const hasExplicitPreference = localStorage.getItem('theme-choice') === 'user';
    const initialTheme = hasExplicitPreference && saved ? saved : 'light';
    this.applyTheme(initialTheme, { persistChoice: hasExplicitPreference });
    document.getElementById('themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      this.applyTheme(cur === 'dark' ? 'light' : 'dark', { persistChoice: true });
    });
  }
  applyTheme(t, { persistChoice = true } = {}) {
    const themeToggle = document.getElementById('themeToggle');
    const themeIcon = document.getElementById('themeIcon');
    const nextThemeLabel = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';

    document.documentElement.setAttribute('data-theme', t);
    if (themeIcon) themeIcon.className = `fa-solid ${t === 'dark' ? 'fa-sun' : 'fa-moon'}`;
    if (themeToggle) {
      themeToggle.title = nextThemeLabel;
      themeToggle.setAttribute('aria-label', nextThemeLabel);
    }
    localStorage.setItem('theme', t);
    if (persistChoice) localStorage.setItem('theme-choice', 'user');
  }

  /* ═══ FAB ═════════════════════════════════════ */
  bindFab() {
    document.getElementById('fabBtn').addEventListener('click', async () => {
      this.navigate('downloader');
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (YT_REGEX.test(text)) {
          document.getElementById('urlInput').value = text;
          this.toast('YouTube URL pasted!', 'success');
        }
      } catch { document.getElementById('urlInput').focus(); }
    });
    document.getElementById('sidebarGithubLink')?.addEventListener('click', () => window.electronAPI.openExternal(GITHUB_URL));
  }

  /* ═══ DOWNLOADER ══════════════════════════════ */
  bindDownloader() {
    document.getElementById('fetchBtn').addEventListener('click', () => this.fetchInfo());
    document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.fetchInfo(); });
    document.getElementById('downloadBtn').addEventListener('click', () => this.startDownload());
    document.getElementById('addToQueueBtn').addEventListener('click', () => this.addCurrentToQueue());
    document.getElementById('closeVideoCardBtn').addEventListener('click', () => this.hideVideoCard());
    document.getElementById('clearCompletedBtn').addEventListener('click', () => this.clearCompleted());
    document.getElementById('clearQueueBtn').addEventListener('click', () => this.clearQueue());
    document.getElementById('folderChipBtn').addEventListener('click', async () => {
      const p = await window.electronAPI.openFolder();
      if (p) { this.outputDir = p; this.setOutputPathLabel(p); }
    });
    this.bindHorizontalPillScroller(document.getElementById('qualityPills'));

    document.getElementById('qualityPills').addEventListener('click', (event) => {
      const btn = event.target.closest('.pill[data-quality]');
      if (!btn) return;
      document.querySelectorAll('#qualityPills .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.selectedQuality = btn.dataset.quality;
    });

    // Format pills — hide quality when audio selected
    document.querySelectorAll('#formatPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#formatPills .pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedFormat = btn.dataset.format;
        this.refreshQualityPills(this.selectedQuality);
      });
    });
  }

  hideVideoCard() {
    const card = document.getElementById('videoCard');
    card.classList.remove('fadein');
    card.classList.add('hidden');
  }

  bindHorizontalPillScroller(scroller) {
    if (!scroller || scroller.dataset.dragScrollBound === 'true') return;
    scroller.dataset.dragScrollBound = 'true';

    let dragging = false;
    let pressedOnInteractive = false;
    let startX = 0;
    let startScrollLeft = 0;
    let didDrag = false;
    let suppressClickUntil = 0;

    const stopDragging = () => {
      dragging = false;
      pressedOnInteractive = false;
      scroller.classList.remove('is-dragging');
    };

    scroller.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      dragging = true;
      didDrag = false;
      pressedOnInteractive = !!event.target.closest('button, .pill');
      startX = event.clientX;
      startScrollLeft = scroller.scrollLeft;
      scroller.classList.add('is-dragging');
      if (!pressedOnInteractive) scroller.setPointerCapture?.(event.pointerId);
    });

    scroller.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const deltaX = event.clientX - startX;
      if (pressedOnInteractive && Math.abs(deltaX) <= 4) return;
      if (Math.abs(deltaX) > 4) didDrag = true;
      if (pressedOnInteractive && !scroller.hasPointerCapture?.(event.pointerId)) {
        scroller.setPointerCapture?.(event.pointerId);
      }
      scroller.scrollLeft = startScrollLeft - deltaX;
    });

    scroller.addEventListener('pointerup', (event) => {
      if (scroller.hasPointerCapture?.(event.pointerId)) {
        scroller.releasePointerCapture?.(event.pointerId);
      }
      if (didDrag) suppressClickUntil = Date.now() + 220;
      didDrag = false;
      stopDragging();
    });
    scroller.addEventListener('pointercancel', () => {
      didDrag = false;
      stopDragging();
    });
    scroller.addEventListener('mouseleave', () => { if (!dragging) scroller.classList.remove('is-dragging'); });
    scroller.addEventListener('wheel', (event) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      scroller.scrollLeft += delta;
    }, { passive: false });
    scroller.addEventListener('click', (event) => {
      if (Date.now() >= suppressClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  _icon(name, extra = '') { return `<i class="fa-solid fa-${name}${extra ? ` ${extra}` : ''}" aria-hidden="true"></i>`; }
  _pauseIcon()  { return this._icon('pause'); }
  _resumeIcon() { return this._icon('play'); }
  _stopIcon()   { return this._icon('stop'); }

  async loadOutputPath() {
    try { const p = await window.electronAPI.getOutputPath(); this.outputDir = p; this.setOutputPathLabel(p); } catch {}
  }
  setOutputPathLabel(p) {
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    document.getElementById('outputPathLabel').textContent = parts.length >= 2 ? parts.slice(-2).join('/') : p;
  }

  /* ─── Clipboard monitor ─── */
  startClipboardMonitor() {
    const checkClipboard = async () => {
      if (!this.autoClipboard) return;
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (text && text !== this._lastClipboard && YT_REGEX.test(text)) {
          this._lastClipboard = text;
          const input = document.getElementById('urlInput');
          if (input.value.trim() !== text) {
            input.value = text;
            this.fetchInfo(true); // silent=true: suppress empty-URL toast
          }
        }
      } catch { /* clipboard permission denied or not available */ }
    };

    // Check on window focus (user switches to app)
    window.addEventListener('focus', checkClipboard);

    // Also poll every 2s while app is running (catches clipboard changes mid-session)
    this._clipboardTimer = setInterval(checkClipboard, 2000);

    // Do one check immediately on startup
    checkClipboard();
  }

  /* ─── Fetch ─── */
  async fetchInfo(silent = false) {
    const raw = document.getElementById('urlInput').value.trim();
    if (!raw) { if (!silent) this.toast('Paste a YouTube URL first.', 'error'); return; }
    const fetchToken = ++this._fetchToken;

    const btn = document.getElementById('fetchBtn');
    btn.querySelector('span').textContent = 'Fetching…';
    btn.disabled = true;

    this.currentUrl = '';
    this.currentInfo = null;

    // Hide previous result
    this.hideVideoCard();
    document.getElementById('fetchProgress').classList.remove('hidden');
    document.getElementById('fetchProgressLabel').textContent = 'Fetching video information…';
    this.updateDownloadActionState(false);

    const infoTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Request timed out. Check your connection.')), 14000));
    const formatsTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Loading available qualities took too long. Please try again.')), 20000));
    try {
      const quickInfoPromise = window.electronAPI.getVideoInfo(raw);
      const detailedInfoPromise = window.electronAPI.getVideoFormats(raw);
      const quickInfo = await Promise.race([quickInfoPromise, infoTimeout]);
      if (fetchToken !== this._fetchToken) return;

      this.currentUrl = raw;
      this.currentInfo = { ...quickInfo, formatsLoaded: false, formats: [], qualitiesByFormat: null };

      if (!this.autoStart) {
        this.showVideoCard(this.currentInfo);
        this.setQualityPillsMessage('Loading available qualities…');
      }

      const detailedInfo = await Promise.race([detailedInfoPromise, formatsTimeout]);
      if (fetchToken !== this._fetchToken) return;

      this.currentInfo = {
        ...quickInfo,
        ...detailedInfo,
        title: detailedInfo.title || quickInfo.title,
        author: detailedInfo.author || quickInfo.author,
        duration: detailedInfo.duration || quickInfo.duration,
        thumbnail: detailedInfo.thumbnail || quickInfo.thumbnail,
        formatsLoaded: true,
      };

      // Auto Start: skip video card, directly download with auto-start settings
      if (this.autoStart) {
        const autoFormat = this.autoStartFormat || 'mp4';
        const autoQuality = autoFormat === 'audio'
          ? 'best'
          : this.resolvePreferredQuality(this.autoStartQuality, this.getAvailableQualitiesForFormat(this.currentInfo, autoFormat));
        const item = {
          id:      ++this._dlIdCounter,
          url:     this.currentUrl,
          info:    { ...this.currentInfo },
          quality: autoQuality,
          format:  autoFormat,
          title:   this.currentInfo.title || 'Unknown',
          thumb:   this.currentInfo.thumbnail || '',
        };
        // Clear input so same URL isn't re-triggered by clipboard monitor
        document.getElementById('urlInput').value = '';
        this._lastClipboard = raw;
        this.currentUrl  = '';
        this.currentInfo = null;
        if (!this.isDownloading) {
          this.executeDownload(item).catch(() => {});
        } else {
          this.downloadQueue.push(item);
          this.renderQueueSection();
          this.toast('Added to queue (auto-start).', 'success');
        }
        return;
      }

      this.showVideoCard(this.currentInfo);
      this.refreshQualityPills(this.selectedQuality);
    } catch (err) {
      if (fetchToken !== this._fetchToken) return;
      if (this.currentInfo && !this.currentInfo.formatsLoaded) {
        this.setQualityPillsMessage('Could not load available qualities');
      }
      this.toast(err.message || 'Failed to fetch video info.', 'error');
    } finally {
      if (fetchToken === this._fetchToken) {
        document.getElementById('fetchProgress').classList.add('hidden');
        btn.querySelector('span').textContent = 'Snapyt!';
        btn.disabled = false;
      }
    }
  }

  showVideoCard(info) {
    document.getElementById('videoThumb').src           = info.thumbnail;
    document.getElementById('videoTitle').textContent   = info.title;
    document.getElementById('videoAuthor').textContent  = '';
    document.getElementById('videoDurationBadge').textContent = this.fmtDuration(info.duration);
    document.getElementById('videoCard').classList.remove('hidden');
    document.getElementById('videoCard').classList.add('fadein');
    setTimeout(() => document.getElementById('videoCard').classList.remove('fadein'), 300);
  }

  updateDownloadActionState(enabled = !!(this.currentUrl && this.currentInfo?.formatsLoaded)) {
    document.getElementById('downloadBtn').disabled = !enabled;
    document.getElementById('addToQueueBtn').disabled = !enabled;
  }

  getAvailableQualitiesForFormat(info = this.currentInfo, format = this.selectedFormat) {
    if (!info?.qualitiesByFormat || format === 'audio') return ['best'];
    const values = info.qualitiesByFormat[format];
    return Array.isArray(values) && values.length ? values : ['best'];
  }

  resolvePreferredQuality(preferredQuality, availableQualities) {
    if (!Array.isArray(availableQualities) || !availableQualities.length) return 'best';
    if (!preferredQuality || preferredQuality === 'best') return 'best';

    const target = parseInt(preferredQuality, 10);
    const numericQualities = availableQualities
      .map((quality) => parseInt(quality, 10))
      .filter(Number.isFinite)
      .sort((a, b) => b - a);

    if (!Number.isFinite(target) || !numericQualities.length) return availableQualities[0] || 'best';
    if (numericQualities.includes(target)) return String(target);

    const lower = numericQualities.find((quality) => quality < target);
    if (Number.isFinite(lower)) return String(lower);

    return String(numericQualities[numericQualities.length - 1]);
  }

  updateQualityRowVisibility() {
    const qualityRow = document.getElementById('qualityPills').closest('.opt-row');
    qualityRow.style.display = this.selectedFormat === 'audio' ? 'none' : '';
  }

  setQualityPillsMessage(message) {
    document.getElementById('qualityPills').innerHTML = `<span class="pills-status">${message}</span>`;
    this.updateQualityRowVisibility();
    this.updateDownloadActionState(false);
  }

  refreshQualityPills(preferredQuality = this.selectedQuality) {
    this.updateQualityRowVisibility();
    if (!this.currentInfo) {
      this.setQualityPillsMessage('Fetch a video to load available qualities');
      return;
    }
    if (this.selectedFormat === 'audio') {
      this.selectedQuality = 'best';
      this.updateDownloadActionState(!!this.currentUrl && !!this.currentInfo?.formatsLoaded);
      return;
    }

    if (!this.currentInfo?.formatsLoaded) {
      this.setQualityPillsMessage('Loading available qualities…');
      return;
    }

    const availableQualities = this.getAvailableQualitiesForFormat(this.currentInfo, this.selectedFormat);
    this.selectedQuality = this.resolvePreferredQuality(preferredQuality, availableQualities);
    document.getElementById('qualityPills').innerHTML = availableQualities.map((quality) => {
      const label = quality === 'best' ? 'Best' : `${quality}p`;
      const active = quality === this.selectedQuality ? ' active' : '';
      return `<button class="pill${active}" data-quality="${quality}">${label}</button>`;
    }).join('');
    this.updateDownloadActionState(!!this.currentUrl && !!this.currentInfo?.formatsLoaded);
  }

  /* ─── Start Download ─── */
  async startDownload() {
    if (!this.currentUrl) { this.toast('Fetch a video first.', 'error'); return; }
    if (!this.currentInfo?.formatsLoaded) { this.toast('Available qualities are still loading.', 'error'); return; }
    const item = this._makeQueueItem();
    await this.executeDownload(item);
  }

  /* ─── Queue ─── */
  addCurrentToQueue() {
    if (!this.currentUrl) { this.toast('Fetch a video first.', 'error'); return; }
    if (!this.currentInfo?.formatsLoaded) { this.toast('Available qualities are still loading.', 'error'); return; }
    const item = this._makeQueueItem();
    this.downloadQueue.push(item);
    this.renderQueueSection();
    this.toast('Added to queue!', 'success');
    // Clear the current fetch
    this.hideVideoCard();
    document.getElementById('urlInput').value = '';
    this.currentUrl = '';
    this.currentInfo = null;
    this.updateDownloadActionState(false);
    // Auto-start if not currently downloading
    if (!this.isDownloading) this.processQueue();
  }

  _makeQueueItem() {
    return {
      id:      ++this._dlIdCounter,
      url:     this.currentUrl,
      info:    { ...this.currentInfo },
      quality: this.selectedQuality,
      format:  this.selectedFormat,
      title:   this.currentInfo?.title || 'Unknown',
      thumb:   this.currentInfo?.thumbnail || '',
    };
  }

  async processQueue() {
    if (this.downloadQueue.length === 0) { this.isDownloading = false; return; }
    this.isDownloading = true;
    const next = this.downloadQueue.shift();
    this.renderQueueSection();
    await this.executeDownload(next).catch(() => {});
    this.processQueue();
  }

  async executeDownload(qItem) {
    const { id, url, info, quality, format, title, thumb } = qItem;

    const dlItem = {
      id,
      title,
      thumb,
      url,
      percent: 0,
      status: 'active',
      type: format === 'audio' ? 'audio' : 'video',
      speed: '',
      eta: '',
      currentSize: 0,
      totalSize: 0,
      statusText: '',
      filepath: '',
    };
    this.sessionDownloads.unshift(dlItem);
    this.renderDownloadsList();

    // Hide video card while downloading
    this.hideVideoCard();
    document.getElementById('downloadBtn').disabled = true;
    this._isPaused = false;

    try {
      const result = await window.electronAPI.downloadVideo(url, { quality, format, videoInfo: info });
      dlItem.status   = 'completed';
      dlItem.percent  = 100;
      dlItem.size     = result.size;
      dlItem.filename = result.filename;
      dlItem.filepath = result.filepath || dlItem.filepath;
      dlItem.type     = result.type || dlItem.type;
      dlItem.currentSize = result.size || dlItem.currentSize;
      dlItem.totalSize = result.size || dlItem.totalSize;
      dlItem.statusText = '';

      document.getElementById('downloadBtn').disabled = false;
      this.toast('Download complete!', 'success');
    } catch (err) {
      dlItem.status = err.message?.includes('cancelled') ? 'cancelled' : 'failed';
      dlItem.statusText = '';
      document.getElementById('downloadBtn').disabled = false;
      if (dlItem.status !== 'cancelled') this.toast(err.message || 'Download failed.', 'error');
      else this.toast('Download cancelled.', 'error');
    } finally {
      this.trimSessionDownloads();
      this.renderDownloadsList();
      this.loadGallery();
    }
  }

  trimSessionDownloads() {
    const completed = this.sessionDownloads.filter(d => d.status !== 'active');
    const active    = this.sessionDownloads.filter(d => d.status === 'active');
    const trimmed   = completed.slice(0, ITEMS_PER_PAGE);
    this.sessionDownloads = [...active, ...trimmed];
  }

  async cancelDownload() {
    await window.electronAPI.cancelDownload();
  }
  async clearCompleted() {
    const stopped = this.sessionDownloads.filter(d => d.status === 'cancelled' || d.status === 'failed');
    await Promise.all(stopped.map((dl) => this.cleanupStoppedDownload(dl)));
    this.sessionDownloads = this.sessionDownloads.filter(d => d.status === 'active');
    this.renderDownloadsList();
  }
  clearQueue() {
    this.downloadQueue = [];
    this.renderQueueSection();
  }

  /* ─── Progress handlers ─── */
  handleProgress(data) {
    const pct    = data.percent || 0;
    const active = this.sessionDownloads.find(d => d.status === 'active');
    if (!active) return;

    active.percent = pct;
    active.speed   = data.speed || '';
    active.eta     = data.eta   || '';
    active.currentSize = data.currentSize || active.currentSize || 0;
    active.totalSize   = data.totalSize   || active.totalSize   || 0;
    active.filepath    = data.filepath    || active.filepath    || '';
    if (active.speed || active.eta || active.totalSize || active.currentSize) active.statusText = '';

    const el = document.querySelector(`.dl-item[data-dl-id="${active.id}"]`);
    if (el) {
      const fill = el.querySelector('.dl-bar-fill');
      const pct2 = el.querySelector('.dl-pct');
      const meta = el.querySelector('.dl-speed-eta');
      if (fill) fill.style.width = `${pct}%`;
      if (pct2) pct2.textContent = `${pct}%`;
      if (meta) meta.textContent = this.formatDownloadMeta(active);
    }
  }

  handleStatus(status) {
    const active = this.sessionDownloads.find(d => d.status === 'active');
    if (!active) return;
    active.statusText = status || '';
    const el = document.querySelector(`.dl-item[data-dl-id="${active.id}"] .dl-speed-eta`);
    if (el) el.textContent = this.formatDownloadMeta(active);
  }

  /* ─── Load recent downloads from storage ─── */
  async loadRecentDownloads() {
    try {
      const videos = await window.electronAPI.getVideos();
      const recent = videos.slice(0, ITEMS_PER_PAGE);
      // Only add if not already in session
      const sessionIds = new Set(this.sessionDownloads.map(d => d.filename));
      for (const v of recent) {
        if (!sessionIds.has(v.filename)) {
          this.sessionDownloads.push({
            id:       ++this._dlIdCounter,
            title:    v.title || v.filename,
            thumb:    v.thumbnail || '',
            url:      v.url || '',
            percent:  100,
            status:   'completed',
            size:     v.size || 0,
            filename: v.filename,
            filepath: v.filepath || '',
            type:     v.type || 'video',
            speed:    '',
            eta:      '',
          });
        }
      }
      this.trimSessionDownloads();
      this.renderDownloadsList();
    } catch {}
  }

  /* ─── Render downloads list ─── */
  renderDownloadsList() {
    const list  = document.getElementById('downloadsList');
    const empty = document.getElementById('downloadsEmpty');

    const active    = this.sessionDownloads.filter(d => d.status === 'active');
    const completed = this.sessionDownloads.filter(d => d.status !== 'active');

    const countEl = document.getElementById('activeCount');
    if (active.length > 0) {
      countEl.textContent = `${active.length} active`; countEl.classList.remove('hidden');
    } else { countEl.classList.add('hidden'); }

    if (this.sessionDownloads.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      this.queueDownloadsScrollbarSync();
      return;
    }
    empty.classList.add('hidden');

    // Only rebuild if structure changed, otherwise use in-place updates
    const all = [...active, ...completed].slice(0, ITEMS_PER_PAGE);
    const existingIds = new Set([...list.querySelectorAll('.dl-item')].map(el => el.dataset.dlId));
    const newIds = new Set(all.map(d => String(d.id)));

    // Remove items no longer in list
    existingIds.forEach(id => {
      if (!newIds.has(id)) list.querySelector(`.dl-item[data-dl-id="${id}"]`)?.closest('.dl-wrapper')?.remove();
    });

    all.forEach((dl, idx) => {
      const existing = list.querySelector(`.dl-item[data-dl-id="${dl.id}"]`);
      if (existing && dl.status !== 'completed' && existing.dataset.status === dl.status) return; // skip unchanged
      if (existing) existing.closest('.dl-wrapper')?.remove();
      list.insertBefore(this.buildDlItem(dl), list.children[idx] || null);
    });

    this.queueDownloadsScrollbarSync();
  }

  formatDownloadMeta(dl) {
    const parts = [];
    if (dl.totalSize || dl.currentSize) {
      const current = this.fmtTransferSize(dl.currentSize || 0);
      const total = dl.totalSize ? this.fmtTransferSize(dl.totalSize) : '—';
      parts.push(`${current} / ${total}`);
    }
    if (dl.speed) parts.push(dl.speed);
    if (dl.eta) parts.push(`ETA ${dl.eta}`);
    if (parts.length) return parts.join(' · ');
    return dl.statusText || '';
  }

  async cleanupStoppedDownload(dl) {
    if (!dl?.filepath) return;
    try { await window.electronAPI.cleanupTempDownload(dl.filepath); } catch {}
  }

  async removeDownloadItem(dl) {
    if (!dl) return;
    if (dl.status === 'cancelled' || dl.status === 'failed') {
      await this.cleanupStoppedDownload(dl);
    }
    this.sessionDownloads = this.sessionDownloads.filter(d => d.id !== dl.id);
    this.renderDownloadsList();
  }

  buildDlItem(dl) {
    const isActive    = dl.status === 'active';
    const isCompleted = dl.status === 'completed';
    const isFailed    = dl.status === 'failed';
    const isCancelled = dl.status === 'cancelled';
    const keepDownloadRowStyle = isActive || isCompleted;
    const progressPercent = isCompleted ? 100 : Math.max(0, Math.min(100, dl.percent || 0));
    const metaText = isActive
      ? this.formatDownloadMeta(dl)
      : isCompleted
        ? `Completed${dl.size ? ` · ${this.fmtSize(dl.size)}` : ''}`
        : '';
    const showMetaText = isActive || isCompleted || !!metaText;

    const wrapper = document.createElement('div');
    wrapper.className = 'dl-wrapper';

    const item = document.createElement('div');
    item.className = `dl-item${keepDownloadRowStyle ? ' active-dl' : ''}${isCompleted ? ' completed-dl' : ''}`;
    item.setAttribute('data-dl-id', dl.id);
    item.setAttribute('data-status', dl.status);

    const thumbHtml = dl.thumb
      ? `<div class="dl-thumb-wrap"><img src="${dl.thumb}" class="dl-thumb" alt=""></div>`
      : `<div class="dl-thumb-wrap"><div class="dl-thumb-placeholder">${this._icon('circle-play')}</div></div>`;

    const typeBadge = `<span class="dl-type-badge ${dl.type || 'video'}">${dl.type === 'audio' ? 'Audio' : 'Video'}</span>`;

    let rightHtml = '';
    if (isActive) {
      rightHtml = `
        <div class="dl-right">
          <div class="dl-dl-controls">
            <button class="dl-ctrl-btn pause" title="Pause">
              ${this._pauseIcon()}
            </button>
            <button class="dl-ctrl-btn stop" title="Stop download">
              ${this._stopIcon()}
            </button>
          </div>
        </div>`;
    } else if (isCompleted) {
      rightHtml = `
        <div class="dl-right">
          <div class="dl-actions">
            <button class="dl-act play" title="${dl.type === 'audio' ? 'Play Audio' : 'Play Video'}">
              ${this._icon('circle-play')}
            </button>
            <button class="dl-act folder" title="Show in Finder">
              ${this._icon('folder-open')}
            </button>
            <button class="dl-act copy-link" title="Copy YouTube URL">
              ${this._icon('copy')}
            </button>
            <button class="dl-act view-yt" title="View on YouTube">
              ${this._icon('up-right-from-square')}
            </button>
          </div>
        </div>`;
    } else {
      const statusColor = isFailed ? 'color:var(--red)' : 'color:var(--text3)';
      const statusText  = isFailed ? 'Failed' : 'Cancelled';
      rightHtml = `
        <div class="dl-right">
          <span class="dl-size" style="${statusColor}">${statusText}</span>
          <div class="dl-actions">
            <button class="dl-act remove" title="Remove from list">
              ${this._icon('xmark')}
            </button>
          </div>
        </div>`;
    }

    item.innerHTML = `
      ${thumbHtml}
      <div class="dl-body">
        <div class="dl-title">${dl.title}</div>
        <div class="dl-meta">
          ${typeBadge}
          ${showMetaText ? `<span class="dl-speed-eta">${metaText}</span>` : ''}
        </div>
        ${keepDownloadRowStyle ? `
        <div class="dl-progress-row">
          <div class="dl-bar"><div class="dl-bar-fill" style="width:${progressPercent}%"></div></div>
          <span class="dl-pct">${progressPercent}%</span>
        </div>` : ''}
      </div>
      ${rightHtml}
    `;

    // Bind buttons
    if (isCompleted) {
      item.querySelector('.dl-act.play')?.addEventListener('click', () => {
        const fileTarget = dl.filepath || dl.filename;
        if (fileTarget) window.electronAPI.openFile(fileTarget);
      });
      item.querySelector('.dl-act.folder')?.addEventListener('click', () => {
        const fileTarget = dl.filepath || dl.filename;
        if (fileTarget) window.electronAPI.showFileInFolder(fileTarget);
        else window.electronAPI.openOutputFolder();
      });
      item.querySelector('.dl-act.copy-link')?.addEventListener('click', () => {
        navigator.clipboard.writeText(dl.url || '').then(() => this.toast('Link copied!', 'success'));
      });
      item.querySelector('.dl-act.view-yt')?.addEventListener('click', () => {
        if (dl.url) window.electronAPI.openExternal(dl.url);
      });
    }
    if (isActive) {
      const pauseBtn = item.querySelector('.dl-ctrl-btn.pause');
      let paused = false;
      pauseBtn?.addEventListener('click', async () => {
        pauseBtn.disabled = true;
        try {
          if (paused) {
            const resumed = await window.electronAPI.resumeDownload();
            if (!resumed) {
              this.toast('Could not resume download.', 'error');
              return;
            }
            paused = false;
            pauseBtn.innerHTML = this._pauseIcon();
            pauseBtn.classList.remove('resume');
            pauseBtn.title = 'Pause';
          } else {
            const pausedOk = await window.electronAPI.pauseDownload();
            if (!pausedOk) {
              this.toast('Could not pause download.', 'error');
              return;
            }
            paused = true;
            pauseBtn.innerHTML = this._resumeIcon();
            pauseBtn.classList.add('resume');
            pauseBtn.title = 'Resume';
          }
        } finally {
          pauseBtn.disabled = false;
        }
      });
      item.querySelector('.dl-ctrl-btn.stop')?.addEventListener('click', () => window.electronAPI.cancelDownload());
    }
    if (!isActive && !isCompleted) {
      item.querySelector('.dl-act.remove')?.addEventListener('click', async () => {
        await this.removeDownloadItem(dl);
      });
    }

    // Right-click context menu
    item.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showItemContextMenu(e, dl); });

    wrapper.appendChild(item);
    return wrapper;
  }

  setupDragToDelete(itemEl, wrapper, dl) {
    let startX = 0, currentX = 0, dragging = false;
    const THRESHOLD = 80; // drag this far left to trigger delete

    itemEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX; dragging = true; currentX = 0;
      itemEl.style.transition = 'none';
      itemEl.setPointerCapture(e.pointerId);
    });

    itemEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (dx >= 0) return;
      currentX = dx; // no cap — let it slide freely so delete zone fully reveals
      itemEl.style.transform = `translateX(${currentX}px)`;
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      if (currentX < -THRESHOLD) {
        // Past threshold — animate out and delete
        itemEl.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        itemEl.style.transform = `translateX(-110%)`;
        itemEl.style.opacity   = '0';
        setTimeout(() => {
          this.removeDownloadItem(dl);
        }, 200);
      } else {
        // Snap back
        itemEl.style.transition = 'transform 0.2s ease';
        itemEl.style.transform  = 'translateX(0)';
      }
    };
    itemEl.addEventListener('pointerup',     endDrag);
    itemEl.addEventListener('pointercancel', endDrag);
  }

  showItemContextMenu(e, dl) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.id = 'ctxMenu';

    const isCompleted = dl.status === 'completed';
    const isAudio     = dl.type === 'audio';

    menu.innerHTML = `
      ${isCompleted ? `
      <button class="ctx-item" id="ctxPlay">
        ${this._icon('circle-play')}
        ${isAudio ? 'Play Audio' : 'Play Video'}
      </button>
      <button class="ctx-item" id="ctxFolder">
        ${this._icon('folder-open')}
        Open in Folder
      </button>` : ''}
      ${dl.url ? `
      <button class="ctx-item" id="ctxCopy">
        ${this._icon('copy')}
        Copy YouTube Link
      </button>
      <button class="ctx-item" id="ctxYT">
        ${this._icon('up-right-from-square')}
        View on YouTube
      </button>` : ''}
      ${dl.url ? `
      <button class="ctx-item" id="ctxRedownload">
        ${this._icon('rotate-right')}
        Re-download
      </button>` : ''}
      <div class="ctx-sep"></div>
      <button class="ctx-item" id="ctxRemoveList">
        ${this._icon('xmark')}
        Remove from list
      </button>
      ${isCompleted && dl.filename ? `
      <button class="ctx-item danger" id="ctxDeleteFile">
        ${this._icon('trash-can')}
        Delete file
      </button>` : ''}
    `;

    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
    menu.style.top  = `${Math.min(e.clientY, window.innerHeight - 250)}px`;
    document.body.appendChild(menu);

    menu.querySelector('#ctxPlay')?.addEventListener('click', () => {
      const fileTarget = dl.filepath || dl.filename;
      if (fileTarget) window.electronAPI.openFile(fileTarget);
      this.closeContextMenu();
    });
    menu.querySelector('#ctxFolder')?.addEventListener('click', () => {
      const fileTarget = dl.filepath || dl.filename;
      if (fileTarget) window.electronAPI.showFileInFolder(fileTarget);
      else window.electronAPI.openOutputFolder();
      this.closeContextMenu();
    });
    menu.querySelector('#ctxCopy')?.addEventListener('click', () => { navigator.clipboard.writeText(dl.url); this.toast('Link copied!', 'success'); this.closeContextMenu(); });
    menu.querySelector('#ctxYT')?.addEventListener('click', () => { window.electronAPI.openExternal(dl.url); this.closeContextMenu(); });
    menu.querySelector('#ctxRedownload')?.addEventListener('click', () => {
      document.getElementById('urlInput').value = dl.url;
      this.navigate('downloader');
      this.closeContextMenu();
      this.fetchInfo();
    });
    menu.querySelector('#ctxRemoveList')?.addEventListener('click', async () => {
      await this.removeDownloadItem(dl);
      this.closeContextMenu();
    });
    menu.querySelector('#ctxDeleteFile')?.addEventListener('click', async () => {
      this.closeContextMenu();
      const fileTarget = dl.filepath || dl.filename;
      if (fileTarget) {
        await window.electronAPI.trashFile(fileTarget);
        this.sessionDownloads = this.sessionDownloads.filter(d => d.id !== dl.id);
        this.renderDownloadsList();
        this.loadGallery();
        this.toast('File moved to trash.', 'success');
      }
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { this.closeContextMenu(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 50);
  }

  closeContextMenu() { document.getElementById('ctxMenu')?.remove(); }

  /* ─── Queue section render ─── */
  renderQueueSection() {
    const section = document.getElementById('queueSection');
    const list    = document.getElementById('queueList');
    const badge   = document.getElementById('queueCount');

    if (this.downloadQueue.length === 0) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    badge.textContent = this.downloadQueue.length;
    list.innerHTML = '';

    this.downloadQueue.forEach(item => {
      const el = document.createElement('div');
      el.className = 'queue-item';
      el.innerHTML = `
        ${item.thumb ? `<img src="${item.thumb}" class="queue-item-thumb" alt="">` : ''}
        <span class="queue-item-title">${item.title}</span>
        <span class="queue-item-badge">${item.format?.toUpperCase()}</span>
      `;
      list.appendChild(el);
    });
  }

  /* ═══ GALLERY ═════════════════════════════════ */
  bindGallery() {
    document.getElementById('gallerySearch').addEventListener('input', (e) => {
      this._gallerySearch = e.target.value; this._galleryPage = 1; this.renderGalleryFromCache();
    });
    document.querySelectorAll('.g-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.g-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._galleryFilter = btn.dataset.filter;
        this._galleryPage   = 1;
        this.renderGalleryFromCache();
      });
    });
    const sortTrigger = document.getElementById('gallerySortTrigger');
    const sortMenu = document.getElementById('gallerySortMenu');
    sortTrigger?.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = sortMenu && !sortMenu.classList.contains('hidden');
      this.toggleGallerySortMenu(!isOpen);
    });
    document.querySelectorAll('.g-sort-item').forEach(btn => {
      btn.addEventListener('click', () => {
        this.toggleGallerySortMenu(false);
        this.animateGallerySortChange(btn.dataset.sort || 'date-desc');
      });
    });
    document.addEventListener('click', (event) => {
      const sortWrap = document.querySelector('.g-sort');
      if (sortWrap && !sortWrap.contains(event.target)) this.toggleGallerySortMenu(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.toggleGallerySortMenu(false);
    });
    this.syncGallerySortUi();
    document.getElementById('galPrevBtn').addEventListener('click', () => { this._galleryPage--; this.renderGalleryFromCache(); });
    document.getElementById('galNextBtn').addEventListener('click', () => { this._galleryPage++; this.renderGalleryFromCache(); });
    document.getElementById('librarySelectAllBtn').addEventListener('click', () => this.selectAllGalleryItems());
    document.getElementById('libraryClearSelectionBtn').addEventListener('click', () => this.clearGallerySelection());
    document.getElementById('libraryDeleteSelectedBtn').addEventListener('click', () => this.deleteSelectedGalleryItems());
    this.updateLibraryBulkActions();
  }

  getGalleryItemKey(video) {
    return video?.filepath || video?.filename || video?.url || video?.title || '';
  }

  getFilteredGalleryVideos() {
    let videos = [...this._galleryAll];

    if (this._galleryFilter === 'video') videos = videos.filter(v => v.type !== 'audio');
    if (this._galleryFilter === 'audio') videos = videos.filter(v => v.type === 'audio');

    if (this._gallerySearch) {
      const q = this._gallerySearch.toLowerCase();
      videos = videos.filter(v => (v.title || v.filename || '').toLowerCase().includes(q));
    }

    const s = this._gallerySort;
    if (s === 'date-desc')     videos.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    if (s === 'date-asc')      videos.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
    if (s === 'name-asc')      videos.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    if (s === 'name-desc')     videos.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    if (s === 'size-desc')     videos.sort((a, b) => (b.size || 0) - (a.size || 0));
    if (s === 'duration-desc') videos.sort((a, b) => (b.duration || 0) - (a.duration || 0));

    return videos;
  }

  reconcileGallerySelection() {
    const availableKeys = new Set(this._galleryAll.map((video) => this.getGalleryItemKey(video)).filter(Boolean));
    this._gallerySelected.forEach((key) => {
      if (!availableKeys.has(key)) this._gallerySelected.delete(key);
    });
  }

  updateLibraryBulkActions(totalFiltered = this.getFilteredGalleryVideos().length) {
    const selectAllBtn = document.getElementById('librarySelectAllBtn');
    const clearBtn = document.getElementById('libraryClearSelectionBtn');
    const deleteBtn = document.getElementById('libraryDeleteSelectedBtn');
    if (!selectAllBtn || !clearBtn || !deleteBtn) return;

    const selectedCount = this._gallerySelected.size;
    const filteredKeys = this.getFilteredGalleryVideos()
      .map((video) => this.getGalleryItemKey(video))
      .filter(Boolean);
    const filteredSelectedCount = filteredKeys.filter((key) => this._gallerySelected.has(key)).length;

    selectAllBtn.disabled = totalFiltered === 0 || (filteredKeys.length > 0 && filteredSelectedCount === filteredKeys.length);
    clearBtn.disabled = selectedCount === 0;
    deleteBtn.disabled = selectedCount === 0;
    deleteBtn.textContent = `Delete ${selectedCount} videos`;
  }

  selectAllGalleryItems() {
    this.getFilteredGalleryVideos().forEach((video) => {
      const key = this.getGalleryItemKey(video);
      if (key) this._gallerySelected.add(key);
    });
    this.renderGalleryFromCache();
  }

  clearGallerySelection() {
    if (!this._gallerySelected.size) return;
    this._gallerySelected.clear();
    this.renderGalleryFromCache();
  }

  async deleteSelectedGalleryItems() {
    if (!this._gallerySelected.size) return;

    const selectedItems = this._galleryAll.filter((video) => this._gallerySelected.has(this.getGalleryItemKey(video)));
    if (!selectedItems.length) {
      this._gallerySelected.clear();
      this.updateLibraryBulkActions();
      return;
    }

    const deleteBtn = document.getElementById('libraryDeleteSelectedBtn');
    if (deleteBtn) deleteBtn.disabled = true;

    const results = await Promise.all(selectedItems.map((video) => window.electronAPI.deleteVideo(video.filepath || video.filename)));
    const deletedCount = results.filter(Boolean).length;

    this._gallerySelected = new Set(
      selectedItems
        .filter((_video, index) => !results[index])
        .map((video) => this.getGalleryItemKey(video))
        .filter(Boolean)
    );

    await this.loadGallery();

    if (deletedCount > 0) this.toast(`Removed ${deletedCount} videos from Library.`, 'success');
    else this.toast('Failed to remove selected videos from Library.', 'error');
  }

  syncGallerySortUi() {
    const sortLabel = document.getElementById('gallerySortLabel');
    if (sortLabel) sortLabel.textContent = GALLERY_SORT_LABELS[this._gallerySort] || GALLERY_SORT_LABELS['date-desc'];
    document.querySelectorAll('.g-sort-item').forEach(btn => {
      const active = btn.dataset.sort === this._gallerySort;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }

  toggleGallerySortMenu(force) {
    const sortTrigger = document.getElementById('gallerySortTrigger');
    const sortMenu = document.getElementById('gallerySortMenu');
    if (!sortTrigger || !sortMenu) return;
    const shouldOpen = typeof force === 'boolean' ? force : sortMenu.classList.contains('hidden');
    sortMenu.classList.toggle('hidden', !shouldOpen);
    sortTrigger.classList.toggle('open', shouldOpen);
    sortTrigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }

  async loadGallery() {
    try {
      this._galleryAll = await window.electronAPI.getVideos();
      this.reconcileGallerySelection();
      this.renderGalleryFromCache();
      this.queueGalleryScrollbarSync();
    } catch {}
  }

  animateGallerySortChange(nextSort) {
    if (!nextSort || nextSort === this._gallerySort) return;

    this._gallerySort = nextSort;
    this._galleryPage = 1;
    this.syncGallerySortUi();

    const wrap = document.querySelector('.gallery-table-wrap');
    const rows = [...document.querySelectorAll('#galleryTableBody tr')];

    clearTimeout(this._gallerySortShuffleTimer);

    if (!wrap || rows.length === 0) {
      this.renderGalleryFromCache({ animateSort: true });
      return;
    }

    wrap.classList.add('is-sorting');
    rows.forEach((row, index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      row.classList.add('g-sort-shuffle');
      row.style.setProperty('--sort-shift', `${direction * (10 + (index % 3) * 6)}px`);
      row.style.setProperty('--sort-delay', `${index * 70}ms`);
    });

    this._gallerySortShuffleTimer = setTimeout(() => {
      this.renderGalleryFromCache({ animateSort: true });
      wrap.classList.remove('is-sorting');
    }, 1200);
  }

  renderGalleryFromCache({ animateSort = false } = {}) {
    let videos = this.getFilteredGalleryVideos();
    this.updateLibraryBulkActions(videos.length);

    // Pagination
    const total     = videos.length;
    const pages     = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
    this._galleryPage = Math.max(1, Math.min(this._galleryPage, pages));
    const start = (this._galleryPage - 1) * ITEMS_PER_PAGE;
    const paged = videos.slice(start, start + ITEMS_PER_PAGE);

    this.renderGallery(paged, { animateSort });

    // Pagination controls
    const pag = document.getElementById('galleryPagination');
    const lbl = document.getElementById('galPageLabel');
    const prev = document.getElementById('galPrevBtn');
    const next = document.getElementById('galNextBtn');
    if (pages > 1) {
      pag.classList.remove('hidden');
      lbl.textContent = `Page ${this._galleryPage} of ${pages}`;
      prev.disabled = this._galleryPage <= 1;
      next.disabled = this._galleryPage >= pages;
    } else {
      pag.classList.add('hidden');
    }

    this.queueGalleryScrollbarSync();
  }

  renderGallery(videos, { animateSort = false } = {}) {
    const tbody = document.getElementById('galleryTableBody');
    const empty = document.getElementById('galleryEmpty');
    tbody.innerHTML = '';

    if (!videos || videos.length === 0) {
      empty.classList.remove('hidden');
      this.queueGalleryScrollbarSync();
      return;
    }
    empty.classList.add('hidden');

    videos.forEach((v, index) => {
      const tr = document.createElement('tr');
      const itemKey = this.getGalleryItemKey(v);
      const isSelected = itemKey && this._gallerySelected.has(itemKey);
      const thumbHtml = v.thumbnail
        ? `<div class="g-thumb-wrap"><img src="${v.thumbnail}" class="g-thumb" alt=""></div>`
        : `<div class="g-thumb-wrap"><div class="g-thumb-placeholder">${this._icon('circle-play')}</div></div>`;

      const type    = v.type || 'video';
      const typeLabel = type === 'audio' ? 'Audio' : 'Video';
      const ext     = v.filename?.split('.').pop()?.toUpperCase() || '';
      const dateLabel = v.dateAdded ? this.fmtDate(v.dateAdded).replace(', ', ',<br>') : '—';

      tr.innerHTML = `
        <td class="g-select-cell">
          <input
            type="checkbox"
            class="g-row-check"
            aria-label="Select library item"
            ${isSelected ? 'checked' : ''}
          />
        </td>
        <td>${thumbHtml}</td>
        <td>
          <div class="g-row-name">${v.title || v.filename}</div>
          <div class="g-row-meta">${ext}${v.filename && v.filename !== v.title ? '' : ''}</div>
        </td>
        <td><span class="g-type-badge ${type}">${typeLabel}</span></td>
        <td>${this.fmtDuration(v.duration)}</td>
        <td>${this.fmtSize(v.size)}</td>
        <td><span class="g-date">${dateLabel}</span></td>
      `;

      tr.querySelector('.g-row-check')?.addEventListener('click', (e) => e.stopPropagation());
      tr.querySelector('.g-row-check')?.addEventListener('pointerdown', (e) => e.stopPropagation());
      tr.querySelector('.g-row-check')?.addEventListener('change', (e) => {
        if (!itemKey) return;
        if (e.target.checked) this._gallerySelected.add(itemKey);
        else this._gallerySelected.delete(itemKey);
        this.updateLibraryBulkActions();
      });
      tr.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showGalleryRowMenu(e, v); });

      // Drag-to-delete on gallery rows
      this.setupGalleryRowDrag(tr, v);

      if (animateSort) {
        tr.classList.add('g-sort-enter');
        tr.style.setProperty('--sort-enter-delay', `${index * 90}ms`);
      }

      tbody.appendChild(tr);
    });

    this.queueGalleryScrollbarSync();
  }

  setupGalleryRowDrag(row, v) {
    let startX = 0, currentX = 0, dragging = false;
    const THRESH = 80;

    row.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, label')) return;
      startX = e.clientX; dragging = true; currentX = 0;
      row.style.transition = 'none';
    });
    document.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (dx < 0) { currentX = Math.max(-THRESH, dx); row.style.transform = `translateX(${currentX}px)`; row.style.background = 'rgba(255,0,0,0.08)'; }
    });
    const endRow = async () => {
      if (!dragging) return; dragging = false;
      row.style.transition = 'transform 0.2s ease, background 0.2s ease';
      if (currentX < -THRESH / 2) {
        row.style.transform = 'translateX(-100%)';
        row.style.opacity = '0';
        await window.electronAPI.deleteVideo(v.filepath || v.filename);
        await this.loadGallery();
        this.toast('Removed from list.', 'success');
      } else {
        row.style.transform = 'translateX(0)'; row.style.background = '';
      }
    };
    document.addEventListener('pointerup', endRow);
  }

  showGalleryRowMenu(e, v) {
    this.closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu library-ctx-menu'; menu.id = 'ctxMenu';
    const isAudio = v.type === 'audio';
    menu.innerHTML = `
      <button class="ctx-item" id="gctxPlay">
        ${this._icon('circle-play')}
        ${isAudio ? 'Play Audio' : 'Play Video'}
      </button>
      <button class="ctx-item" id="gctxFolder">
        ${this._icon('folder-open')}
        Open in Folder
      </button>
      ${v.url ? `
      <button class="ctx-item" id="gctxCopy">
        ${this._icon('copy')}
        Copy YouTube Link
      </button>
      <button class="ctx-item" id="gctxYT">
        ${this._icon('up-right-from-square')}
        View on YouTube
      </button>
      <button class="ctx-item" id="gctxRedownload">
        ${this._icon('rotate-right')}
        Re-download
      </button>` : ''}
      <div class="ctx-sep"></div>
      <button class="ctx-item" id="gctxRemove">
        ${this._icon('xmark')}
        Remove from list
      </button>
      <button class="ctx-item danger" id="gctxDeleteFile">
        ${this._icon('trash-can')}
        Delete file
      </button>
    `;
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
    menu.style.top  = `${Math.min(e.clientY, window.innerHeight - 280)}px`;
    document.body.appendChild(menu);

    menu.querySelector('#gctxPlay')?.addEventListener('click', () => {
      const fileTarget = v.filepath || v.filename;
      if (fileTarget) window.electronAPI.openFile(fileTarget);
      this.closeContextMenu();
    });
    menu.querySelector('#gctxFolder')?.addEventListener('click', () => {
      const fileTarget = v.filepath || v.filename;
      if (fileTarget) window.electronAPI.showFileInFolder(fileTarget);
      else window.electronAPI.openOutputFolder();
      this.closeContextMenu();
    });
    menu.querySelector('#gctxCopy')?.addEventListener('click', () => { if (v.url) navigator.clipboard.writeText(v.url); this.toast('Link copied!', 'success'); this.closeContextMenu(); });
    menu.querySelector('#gctxYT')?.addEventListener('click', () => { if (v.url) window.electronAPI.openExternal(v.url); this.closeContextMenu(); });
    menu.querySelector('#gctxRedownload')?.addEventListener('click', () => {
      if (v.url) { document.getElementById('urlInput').value = v.url; this.navigate('downloader'); this.fetchInfo(); }
      this.closeContextMenu();
    });
    menu.querySelector('#gctxRemove')?.addEventListener('click', async () => {
      await window.electronAPI.deleteVideo(v.filepath || v.filename); await this.loadGallery(); this.closeContextMenu(); this.toast('Removed from list.', 'success');
    });
    menu.querySelector('#gctxDeleteFile')?.addEventListener('click', async () => {
      await window.electronAPI.trashFile(v.filepath || v.filename); await this.loadGallery(); this.closeContextMenu(); this.toast('File moved to trash.', 'success');
    });

    const close = (ev) => {
      if (!menu.contains(ev.target)) { this.closeContextMenu(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 50);
  }

  /* ═══ SETTINGS ════════════════════════════════ */
  bindSettings() {
    document.getElementById('changePathBtn').addEventListener('click', async () => {
      const p = await window.electronAPI.openFolder();
      if (p) { document.getElementById('settingsOutputPath').textContent = p; this.setOutputPathLabel(p); }
    });
    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
    document.querySelectorAll('[data-pref]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll(`[data-pref="${btn.dataset.pref}"]`).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Auto Start toggle
    const autoClipboardToggle = document.getElementById('autoClipboardToggle');
    const autoStartToggle = document.getElementById('autoStartToggle');
    const autoStartOptions = document.getElementById('autoStartOptions');
    autoClipboardToggle?.addEventListener('change', () => {
      this.autoClipboard = autoClipboardToggle.checked;
    });
    autoStartToggle?.addEventListener('change', () => {
      this.autoStart = autoStartToggle.checked;
      if (this.autoStart) {
        autoStartOptions?.classList.remove('hidden');
      } else {
        autoStartOptions?.classList.add('hidden');
      }
      this.queueSettingsScrollbarSync();
    });

    // Auto Start quality pills
    document.querySelectorAll('[data-as-quality]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-as-quality]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.autoStartQuality = btn.dataset.asQuality;
      });
    });

    // Auto Start format pills
    document.querySelectorAll('[data-as-format]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-as-format]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.autoStartFormat = btn.dataset.asFormat;
      });
    });
  }

  initCustomScrollbar(key, { shellId, scrollId, contentId, scrollbarId, thumbId }) {
    const shell = document.getElementById(shellId);
    const scroll = document.getElementById(scrollId);
    const content = contentId ? document.getElementById(contentId) : scroll;
    const scrollbar = document.getElementById(scrollbarId);
    const thumb = document.getElementById(thumbId);
    if (!shell || !scroll || !scrollbar || !thumb) return;

    const state = {
      shell,
      scroll,
      content: content || scroll,
      scrollbar,
      thumb,
      fadeTimer: null,
      syncFrame: 0,
      metrics: null,
      resizeObserver: null,
    };

    this._customScrollbars[key] = state;

    const bumpActivity = () => this.bumpCustomScrollbarActivity(key);
    const queueSync = () => this.queueCustomScrollbarSync(key);

    scroll.addEventListener('scroll', () => {
      queueSync();
      bumpActivity();
    }, { passive: true });
    scroll.addEventListener('wheel', bumpActivity, { passive: true });
    scroll.addEventListener('mouseenter', bumpActivity);
    scroll.addEventListener('mousemove', bumpActivity);
    scroll.addEventListener('mouseleave', () => this.scheduleCustomScrollbarFade(key));
    scrollbar.addEventListener('mouseenter', bumpActivity);
    scrollbar.addEventListener('mouseleave', () => this.scheduleCustomScrollbarFade(key));
    scrollbar.addEventListener('wheel', (event) => {
      event.preventDefault();
      scroll.scrollTop += event.deltaY;
      bumpActivity();
      queueSync();
    }, { passive: false });
    scrollbar.addEventListener('pointerdown', (event) => this.handleCustomScrollbarTrackPointerDown(key, event));
    thumb.addEventListener('pointerdown', (event) => this.handleCustomScrollbarThumbPointerDown(key, event));

    window.addEventListener('resize', queueSync);

    if (typeof ResizeObserver !== 'undefined') {
      state.resizeObserver = new ResizeObserver(queueSync);
      state.resizeObserver.observe(scroll);
      state.resizeObserver.observe(state.content);
    }

    queueSync();
  }

  bindDownloadsScrollbar() {
    this.initCustomScrollbar('downloads', {
      shellId: 'downloadsScrollShell',
      scrollId: 'downloadsScroll',
      contentId: 'downloadsScrollContent',
      scrollbarId: 'downloadsScrollbar',
      thumbId: 'downloadsScrollbarThumb',
    });
  }

  bindGalleryScrollbar() {
    this.initCustomScrollbar('gallery', {
      shellId: 'galleryTableShell',
      scrollId: 'galleryTableScroll',
      contentId: 'galleryTableContent',
      scrollbarId: 'galleryScrollbar',
      thumbId: 'galleryScrollbarThumb',
    });
  }

  bindSettingsScrollbar() {
    this.initCustomScrollbar('settings', {
      shellId: 'settingsScrollShell',
      scrollId: 'settingsScroll',
      contentId: 'settingsScrollContent',
      scrollbarId: 'settingsScrollbar',
      thumbId: 'settingsScrollbarThumb',
    });
  }

  queueCustomScrollbarSync(key) {
    const state = this._customScrollbars[key];
    if (!state || state.syncFrame) return;
    state.syncFrame = requestAnimationFrame(() => {
      state.syncFrame = 0;
      this.syncCustomScrollbar(key);
    });
  }

  syncCustomScrollbar(key) {
    const state = this._customScrollbars[key];
    if (!state?.shell || !state.scroll || !state.scrollbar || !state.thumb) return;

    const clientHeight = state.scroll.clientHeight;
    const scrollHeight = state.scroll.scrollHeight;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const trackHeight = state.scrollbar.clientHeight;

    if (!clientHeight || !trackHeight || maxScrollTop <= 0) {
      state.metrics = null;
      state.shell.classList.add('scrollbar-hidden');
      state.thumb.style.height = '0px';
      state.thumb.style.transform = 'translateY(0)';
      return;
    }

    state.shell.classList.remove('scrollbar-hidden');

    const thumbHeight = Math.max(48, Math.round((clientHeight / scrollHeight) * trackHeight));
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxScrollTop > 0
      ? Math.round((state.scroll.scrollTop / maxScrollTop) * maxThumbTop)
      : 0;

    state.metrics = { maxScrollTop, maxThumbTop, thumbHeight, trackHeight };
    state.thumb.style.height = `${thumbHeight}px`;
    state.thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  bumpCustomScrollbarActivity(key) {
    const state = this._customScrollbars[key];
    if (!state?.shell || state.shell.classList.contains('scrollbar-hidden')) return;
    state.shell.classList.add('is-scrollbar-active');
    this.scheduleCustomScrollbarFade(key);
  }

  scheduleCustomScrollbarFade(key, delay = 720) {
    const state = this._customScrollbars[key];
    if (!state?.shell) return;
    clearTimeout(state.fadeTimer);
    state.fadeTimer = setTimeout(() => {
      state.shell?.classList.remove('is-scrollbar-active');
    }, delay);
  }

  handleCustomScrollbarTrackPointerDown(key, event) {
    const state = this._customScrollbars[key];
    if (!state?.metrics || event.target === state.thumb) return;
    event.preventDefault();
    event.stopPropagation();
    this.bumpCustomScrollbarActivity(key);

    const railRect = state.scrollbar.getBoundingClientRect();
    const clickOffset = event.clientY - railRect.top - (state.metrics.thumbHeight / 2);
    const nextThumbTop = this.clamp(clickOffset, 0, state.metrics.maxThumbTop);
    const ratio = state.metrics.maxThumbTop > 0
      ? nextThumbTop / state.metrics.maxThumbTop
      : 0;

    state.scroll.scrollTop = ratio * state.metrics.maxScrollTop;
    this.queueCustomScrollbarSync(key);
  }

  handleCustomScrollbarThumbPointerDown(key, event) {
    const state = this._customScrollbars[key];
    if (!state?.metrics) return;
    event.preventDefault();
    event.stopPropagation();
    this.bumpCustomScrollbarActivity(key);

    const railRect = state.scrollbar.getBoundingClientRect();
    const thumbRect = state.thumb.getBoundingClientRect();
    const pointerOffset = event.clientY - thumbRect.top;

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const nextThumbTop = this.clamp(
        moveEvent.clientY - railRect.top - pointerOffset,
        0,
        state.metrics.maxThumbTop
      );
      const ratio = state.metrics.maxThumbTop > 0
        ? nextThumbTop / state.metrics.maxThumbTop
        : 0;

      state.scroll.scrollTop = ratio * state.metrics.maxScrollTop;
      this.queueCustomScrollbarSync(key);
      this.bumpCustomScrollbarActivity(key);
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      this.scheduleCustomScrollbarFade(key, 420);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  queueDownloadsScrollbarSync() {
    this.queueCustomScrollbarSync('downloads');
  }

  queueGalleryScrollbarSync() {
    this.queueCustomScrollbarSync('gallery');
  }

  queueSettingsScrollbarSync() {
    this.queueCustomScrollbarSync('settings');
  }

  async loadSettings() {
    try {
      const [prefs, outputPath] = await Promise.all([window.electronAPI.getPreferences(), window.electronAPI.getOutputPath()]);
      document.getElementById('settingsOutputPath').textContent = outputPath;

      const fmtBtn = document.querySelector(`[data-pref="format"][data-value="${prefs.format}"]`);
      const qBtn   = document.querySelector(`[data-pref="quality"][data-value="${prefs.quality}"]`);
      if (fmtBtn) { document.querySelectorAll('[data-pref="format"]').forEach(b => b.classList.remove('active')); fmtBtn.classList.add('active'); }
      if (qBtn)   { document.querySelectorAll('[data-pref="quality"]').forEach(b => b.classList.remove('active')); qBtn.classList.add('active'); }

      this.autoClipboard = prefs.autoClipboard !== false;
      document.getElementById('autoClipboardToggle').checked = this.autoClipboard;
      document.getElementById('autoUpdateToggle').checked = prefs.autoUpdate !== false;
      this.selectedFormat  = prefs.format  || 'mp4';
      this.selectedQuality = prefs.quality || 'best';

      // Auto Start
      this.autoStart        = prefs.autoStart        || false;
      this.autoStartQuality = prefs.autoStartQuality || 'best';
      this.autoStartFormat  = prefs.autoStartFormat  || 'mp4';

      const autoStartToggle  = document.getElementById('autoStartToggle');
      const autoStartOptions = document.getElementById('autoStartOptions');
      if (autoStartToggle) autoStartToggle.checked = this.autoStart;
      if (this.autoStart) autoStartOptions?.classList.remove('hidden');
      else                autoStartOptions?.classList.add('hidden');

      // Restore auto-start quality pill
      const asQBtn = document.querySelector(`[data-as-quality="${this.autoStartQuality}"]`);
      if (asQBtn) { document.querySelectorAll('[data-as-quality]').forEach(b => b.classList.remove('active')); asQBtn.classList.add('active'); }

      // Restore auto-start format pill
      const asFBtn = document.querySelector(`[data-as-format="${this.autoStartFormat}"]`);
      if (asFBtn) { document.querySelectorAll('[data-as-format]').forEach(b => b.classList.remove('active')); asFBtn.classList.add('active'); }

      // Sync download pills
      const dlFmt = document.querySelector(`#formatPills [data-format="${this.selectedFormat}"]`);
      if (dlFmt) { document.querySelectorAll('#formatPills .pill').forEach(b => b.classList.remove('active')); dlFmt.classList.add('active'); }
      this.refreshQualityPills(this.selectedQuality);
      this.queueSettingsScrollbarSync();
    } catch {}
  }

  async saveSettings() {
    try {
      const fmt  = document.querySelector('[data-pref="format"].active')?.dataset.value  || 'mp4';
      const q    = document.querySelector('[data-pref="quality"].active')?.dataset.value || 'best';
      const asQ  = document.querySelector('[data-as-quality].active')?.dataset.asQuality  || 'best';
      const asFmt = document.querySelector('[data-as-format].active')?.dataset.asFormat   || 'mp4';
      const autoClipboard = document.getElementById('autoClipboardToggle')?.checked !== false;
      const autoStart = document.getElementById('autoStartToggle')?.checked || false;

      await window.electronAPI.setPreferences({
        format: fmt, quality: q,
        autoClipboard,
        autoUpdate:       document.getElementById('autoUpdateToggle').checked,
        autoStart,
        autoStartQuality: asQ,
        autoStartFormat:  asFmt,
      });

      this.selectedFormat   = fmt;
      this.selectedQuality  = q;
      this.autoClipboard    = autoClipboard;
      this.autoStart        = autoStart;
      this.autoStartQuality = asQ;
      this.autoStartFormat  = asFmt;

      // Sync download pills with new defaults
      const dlFmt = document.querySelector(`#formatPills [data-format="${fmt}"]`);
      if (dlFmt) { document.querySelectorAll('#formatPills .pill').forEach(b => b.classList.remove('active')); dlFmt.classList.add('active'); }
      this.refreshQualityPills(q);

      this.toast('Settings saved!', 'success');
    } catch { this.toast('Failed to save settings.', 'error'); }
  }

  /* ═══ HELPERS ═════════════════════════════════ */
  fmtDuration(secs) {
    if (!secs) return '—';
    const s = parseInt(secs, 10), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    return `${m}:${String(sec).padStart(2,'0')}`;
  }
  fmtSize(bytes) {
    if (!bytes) return '—';
    const b = parseInt(bytes, 10);
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576)    return (b / 1048576).toFixed(0)    + ' MB';
    if (b >= 1024)       return (b / 1024).toFixed(0)       + ' KB';
    return b + ' B';
  }
  fmtTransferSize(bytes) {
    const b = Math.max(0, parseInt(bytes || 0, 10));
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024)       return (b / 1024).toFixed(0) + ' KB';
    return b + ' B';
  }
  fmtDate(iso) {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  toast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast ${type}`; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'slideOutRight 0.25s cubic-bezier(0.4,0,0.2,1) forwards';
      setTimeout(() => t.remove(), 280);
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', () => new SnapyYT());
