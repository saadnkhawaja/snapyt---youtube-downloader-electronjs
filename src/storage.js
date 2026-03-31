const fs = require('fs');
const path = require('path');

function sanitizeTitleForFilename(title) {
  return String(title || '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .trim();
}

class Storage {
  constructor(outputPath) {
    this.outputPath = outputPath;
    this.configPath = path.join(outputPath, '.snapy-config.json');
    this.videosPath = path.join(outputPath, '.videos.json');

    this.ensureFiles();
  }

  ensureFiles() {
    if (!fs.existsSync(this.configPath)) {
      this.writeConfig({
        outputPath: this.outputPath,
        format: 'mp4',
        quality: 'best',
        autoClipboard: true,
        autoUpdate: true,
      });
    }

    if (!fs.existsSync(this.videosPath)) {
      this.writeVideos([]);
    }
  }

  writeConfig(config) {
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  writeVideos(videos) {
    fs.writeFileSync(this.videosPath, JSON.stringify(videos, null, 2));
  }

  readConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      return {};
    }
  }

  readVideos() {
    try {
      return JSON.parse(fs.readFileSync(this.videosPath, 'utf8'));
    } catch {
      return [];
    }
  }

  getOutputPath() {
    const config = this.readConfig();
    return config.outputPath || this.outputPath;
  }

  setOutputPath(newPath) {
    const config = this.readConfig();
    config.outputPath = newPath;
    this.outputPath = newPath;
    this.writeConfig(config);
  }

  getPreferences() {
    const config = this.readConfig();
    return {
      format:           config.format           || 'mp4',
      quality:          config.quality          || 'best',
      autoClipboard:    config.autoClipboard    !== false,
      autoUpdate:       config.autoUpdate       !== false,
      autoStart:        config.autoStart        || false,
      autoStartFormat:  config.autoStartFormat  || 'mp4',
      autoStartQuality: config.autoStartQuality || 'best',
    };
  }

  setPreferences(prefs) {
    const config = this.readConfig();
    Object.assign(config, prefs);
    this.writeConfig(config);
  }

  listOutputFiles() {
    const outputPath = this.getOutputPath();
    if (!fs.existsSync(outputPath)) return [];

    return fs.readdirSync(outputPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => {
        const filepath = path.join(outputPath, entry.name);
        let size = 0;
        let mtimeMs = 0;
        try {
          const stats = fs.statSync(filepath);
          size = stats.size;
          mtimeMs = stats.mtimeMs;
        } catch {}
        return {
          name: entry.name,
          filepath,
          size,
          mtimeMs,
          ext: path.extname(entry.name).toLowerCase(),
        };
      });
  }

  resolveVideoFile(video, files = this.listOutputFiles()) {
    if (!video) return null;

    const outputPath = this.getOutputPath();
    const filename = String(video.filename || '');
    const directPath = filename ? path.join(outputPath, filename) : '';
    if (filename && fs.existsSync(directPath)) {
      return { filename, filepath: directPath };
    }

    const ext = path.extname(filename).toLowerCase()
      || (video.type === 'audio' ? '.m4a' : '.mp4');
    const safeTitle = sanitizeTitleForFilename(video.title);
    const candidates = files
      .filter((file) => file.ext === ext)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (safeTitle) {
      const exact = candidates.find((file) => file.name === `${safeTitle}${ext}`);
      if (exact) return { filename: exact.name, filepath: exact.filepath };

      const numbered = candidates.find((file) => (
        file.name.startsWith(`${safeTitle} (`) && file.name.endsWith(ext)
      ));
      if (numbered) return { filename: numbered.name, filepath: numbered.filepath };
    }

    if (video.size) {
      const sameSize = candidates.find((file) => file.size === video.size);
      if (sameSize) return { filename: sameSize.name, filepath: sameSize.filepath };
    }

    return null;
  }

  getVideos() {
    const videos = this.readVideos();
    const files = this.listOutputFiles();
    let changed = false;

    const repaired = videos.map((video) => {
      const resolved = this.resolveVideoFile(video, files);
      if (!resolved) return video;

      if (resolved.filename !== video.filename) {
        changed = true;
        return { ...video, filename: resolved.filename };
      }
      return video;
    });

    if (changed) {
      this.writeVideos(repaired);
    }

    return repaired
      .map((video) => {
        const resolved = this.resolveVideoFile(video, files);
        if (!resolved) return null;
        return {
          ...video,
          filename: resolved.filename,
          filepath: resolved.filepath,
        };
      })
      .filter(Boolean)
      .reverse();
  }

  addVideo(videoMetadata) {
    const videos = this.readVideos();
    videos.push(videoMetadata);
    this.writeVideos(videos);
  }

  deleteVideo(target) {
    const filename = path.basename(target || '');
    if (!filename) return false;

    const videos = this.readVideos();
    const filtered = videos.filter((v) => v.filename !== filename);
    this.writeVideos(filtered);
    return true;
  }
}

module.exports = Storage;
