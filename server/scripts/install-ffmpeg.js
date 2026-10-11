#!/usr/bin/env node
/**
 * Runs as npm's postinstall. On Linux only, downloads a current static
 * ffmpeg build and drops it into vendor/ffmpeg/ffmpeg, which processor.js
 * prefers over the bundled @ffmpeg-installer/ffmpeg binary.
 *
 * @ffmpeg-installer/linux-x64's binary turned out to be a static build
 * from December 2018 (johnvansickle.com's own numbering - verified via
 * `ffmpeg -version` run live on Render) - roughly eight years stale, and
 * the source of a SIGSEGV crash on real clip jobs that never reproduced
 * locally, where the darwin-arm64 binary is a 2021 build. Same source,
 * same johnvansickle.com builds, just a current one instead of a frozen
 * npm snapshot nobody has updated.
 *
 * Every other platform is a no-op: local development keeps using whatever
 * @ffmpeg-installer/ffmpeg already resolved to for that OS.
 *
 * Deliberately never fails the install - if the download has a hiccup,
 * processor.js's own fallback to the (old but present) npm package binary
 * keeps the deploy from breaking outright over this.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'ffmpeg');
const ARCHIVE_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

function download(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return download(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function main() {
  if (process.platform !== 'linux') {
    console.log(`install-ffmpeg: platform is ${process.platform}, nothing to do`);
    return;
  }

  try {
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    const archivePath = path.join(VENDOR_DIR, 'ffmpeg-release.tar.xz');

    console.log('install-ffmpeg: downloading current static build from johnvansickle.com...');
    await download(ARCHIVE_URL, archivePath);

    console.log('install-ffmpeg: extracting...');
    // The archive's top-level directory is named ffmpeg-<version>-amd64-static/
    execSync(`tar -xJf "${archivePath}" -C "${VENDOR_DIR}" --strip-components=1`, { stdio: 'inherit' });
    fs.unlinkSync(archivePath);

    const binPath = path.join(VENDOR_DIR, 'ffmpeg');
    fs.chmodSync(binPath, 0o755);

    const version = execSync(`"${binPath}" -version`, { encoding: 'utf8' }).split('\n')[0];
    console.log('install-ffmpeg: installed ->', version);
  } catch (err) {
    console.error('install-ffmpeg: failed, will fall back to @ffmpeg-installer/ffmpeg:', err.message);
    // Exit 0 on purpose - see file header.
  }
}

main();
