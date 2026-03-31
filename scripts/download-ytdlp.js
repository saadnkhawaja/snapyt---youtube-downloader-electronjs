const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BIN_DIR  = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const PLATFORM_ASSET = {
  darwin: 'yt-dlp_macos',
  linux:  'yt-dlp_linux',
  win32:  'yt-dlp.exe',
};

const asset = PLATFORM_ASSET[process.platform];
if (!asset) {
  console.error('Unsupported platform:', process.platform);
  process.exit(1);
}

function getLatestVersion() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path:     '/repos/yt-dlp/yt-dlp/releases/latest',
      headers:  { 'User-Agent': 'snapy-yt' },
    };
    https.get(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).tag_name); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'snapy-yt' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const total = parseInt(res.headers['content-length'], 10);
        let received = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.round((received / total) * 100);
            process.stdout.write(`\r  Downloading yt-dlp... ${pct}%`);
          }
        });
        res.pipe(file);
        file.on('finish', () => { process.stdout.write('\n'); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  if (fs.existsSync(BIN_PATH)) {
    console.log('yt-dlp binary already present, skipping download.');
    return;
  }

  console.log('Fetching latest yt-dlp release...');
  const version = await getLatestVersion();
  const url     = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${asset}`;
  console.log(`  Version : ${version}`);
  console.log(`  Asset   : ${asset}`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  await download(url, BIN_PATH);
  fs.chmodSync(BIN_PATH, 0o755);
  console.log('yt-dlp ready at', BIN_PATH);
}

main().catch((err) => {
  console.error('Failed to download yt-dlp:', err.message);
  process.exit(1);
});
