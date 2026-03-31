/**
 * Setup yt-dlp: prefer fast pip install in a venv, fallback to standalone binary.
 *
 * The pip-installed yt-dlp starts in ~0.5s vs ~24s for the PyInstaller binary on macOS.
 */
const { execSync, spawnSync } = require('child_process');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT     = path.join(__dirname, '..');
const BIN_DIR  = path.join(ROOT, 'bin');
const VENV_DIR = path.join(ROOT, '.venv');
const MARKER   = path.join(BIN_DIR, '.ytdlp-method'); // 'venv' or 'binary'

const PLATFORM_ASSET = {
  darwin: 'yt-dlp_macos',
  linux:  'yt-dlp_linux',
  win32:  'yt-dlp.exe',
};

function getVenvBinDir() {
  return path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts' : 'bin');
}

function getPipPath() {
  return path.join(getVenvBinDir(), process.platform === 'win32' ? 'pip.exe' : 'pip');
}

function getVenvYtdlpPath() {
  return path.join(getVenvBinDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function getPythonCandidates() {
  return process.platform === 'win32'
    ? ['python', 'py -3.10', 'py -3', 'python3']
    : ['python3', 'python'];
}

/* ── helpers ──────────────────────────────── */

function hasPython() {
  for (const cmd of getPythonCandidates()) {
    try {
      const ver = execSync(`${cmd} --version 2>&1`, { encoding: 'utf8' }).trim();
      const m = ver.match(/(\d+)\.(\d+)/);
      if (m && parseInt(m[1], 10) >= 3 && parseInt(m[2], 10) >= 8) {
        return cmd;
      }
    } catch {}
  }
  return null;
}

function setupVenv(pythonCmd) {
  console.log(`Creating venv with ${pythonCmd}…`);
  execSync(`${pythonCmd} -m venv "${VENV_DIR}"`, { stdio: 'inherit' });

  const pip = getPipPath();
  console.log('Installing yt-dlp in venv…');
  execSync(`"${pip}" install --quiet yt-dlp`, { stdio: 'inherit' });

  const ytdlp = getVenvYtdlpPath();
  if (!fs.existsSync(ytdlp)) throw new Error('yt-dlp not found after pip install');

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(MARKER, 'venv');
  console.log('yt-dlp installed via pip (fast mode).');
  return true;
}

function getLatestVersion() {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path: '/repos/yt-dlp/yt-dlp/releases/latest',
      headers: { 'User-Agent': 'snapy-yt' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).tag_name); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadBinary(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'snapy-yt' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const total = parseInt(res.headers['content-length'], 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) process.stdout.write(`\r  Downloading yt-dlp binary… ${Math.round((received/total)*100)}%`);
        });
        res.pipe(file);
        file.on('finish', () => { process.stdout.write('\n'); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function setupBinary() {
  const binPath = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(binPath)) {
    console.log('yt-dlp binary already present.');
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(MARKER, 'binary');
    return;
  }

  const asset = PLATFORM_ASSET[process.platform];
  if (!asset) { console.error('Unsupported platform:', process.platform); process.exit(1); }

  console.log('Fetching latest yt-dlp release…');
  const version = await getLatestVersion();
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${asset}`;
  console.log(`  Version: ${version}  Asset: ${asset}`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  await downloadBinary(url, binPath);
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(MARKER, 'binary');
  console.log('yt-dlp binary ready at', binPath);
}

/* ── main ─────────────────────────────────── */

async function main() {
  // Try pip venv first (40x faster startup)
  const py = hasPython();
  if (py) {
    try {
      setupVenv(py);
      return;
    } catch (e) {
      console.warn('Venv setup failed, falling back to binary:', e.message);
    }
  } else {
    console.log('Python 3.8+ not found, using standalone binary (slower startup).');
  }

  // Fallback: download standalone binary
  await setupBinary();
}

main().catch((err) => {
  console.error('Failed to setup yt-dlp:', err.message);
  process.exit(1);
});
