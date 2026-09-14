const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { uploadStream, presignGet, PROCESSED_PREFIX } = require('./s3');
const { updateJob } = require('./jobs');
const { updateRow } = require('./sheets');

ffmpeg.setFfmpegPath(ffmpegPath);

// The Apps Script pipeline on the sheet skips a row in step 1 only when its
// status starts with "Assets Ready", "Moments", "Clips", or "Published". Any
// other value (the old "Processing"/"Clipped") makes step 1 re-pull the Zoom
// assets and write duplicate VTT/transcript files to Drive. Keep the prefix.
const STATUS = {
  PROCESSING: 'Clips: processing',
  DONE: 'Clips: done',
  ERROR: 'Clips: error',
};

const MAX_REDIRECTS = 5;

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

function downloadFile(url, destPath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { headers: { 'User-Agent': 'clipping-tool/1.0' } }, res => {
      const { statusCode, headers } = res;

      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects downloading source'));
        return downloadFile(headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${statusCode}`));
      }

      // An expired Zoom access_token doesn't 401 — Zoom serves an HTML login
      // page with a 200. Without this check ffmpeg would get handed HTML and
      // fail with something unreadable.
      const contentType = headers['content-type'] || '';
      if (/text\/html/i.test(contentType)) {
        res.resume();
        return reject(new Error(
          'Zoom returned an HTML page instead of video — the source URL\'s access_token has ' +
          'expired. Run "Refresh expired Zoom source URLs" on the sheet, then retry.'
        ));
      }

      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', err => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Cuts one clip. Re-encodes rather than stream-copying: `-c copy` can only cut
 * on keyframes, so it snaps the start backwards to the previous one (several
 * seconds on Zoom recordings). The moments are chosen to begin on a sentence
 * and are only padded 1.5s, so that snap would drag in unrelated speech.
 */
function cutClip(inputPath, outputPath, startMs, endMs) {
  const startSec = startMs / 1000;
  const durationSec = (endMs - startMs) / 1000;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(startSec)
      .duration(durationSec)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-preset veryfast',
        '-crf 20',
        '-b:a 128k',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`ffmpeg failed: ${err.message}`)))
      .run();
  });
}

/**
 * Runs a clip job posted by the sheet's step 3.
 *
 * Expects the Apps Script payload shape:
 *   { row, classTitle, sourceUrl, clips: [{ index, startMs, endMs, title, outputKey }] }
 *
 * startMs/endMs already include the pipeline's 1.5s/1.0s padding, so nothing
 * further is added here.
 */
async function processClipJob(jobId, job) {
  const { row, classTitle, sourceUrl, clips } = job;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));

  try {
    updateJob(jobId, { status: 'downloading', progress: 5, totalClips: clips.length });
    await updateRow(row, { status: STATUS.PROCESSING, jobId, error: '' });

    const videoPath = path.join(tmpDir, 'input.mp4');
    await downloadFile(sourceUrl, videoPath);

    const bytes = fs.statSync(videoPath).size;
    if (bytes < 1024 * 1024) {
      throw new Error(`Downloaded source is only ${bytes} bytes — not a usable recording`);
    }

    updateJob(jobId, { status: 'processing', progress: 15 });

    const clipUrls = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      // Honour the name the sheet chose, but always land it in SAT/PROCESSED/.
      const fileName = clip.outputKey
        ? path.basename(clip.outputKey)
        : `${slugify(classTitle)}-clip${clip.index || i + 1}.mp4`;
      const clipPath = path.join(tmpDir, fileName);

      await cutClip(videoPath, clipPath, clip.startMs, clip.endMs);

      const s3Key = `${PROCESSED_PREFIX}${fileName}`;
      await uploadStream(s3Key, fs.createReadStream(clipPath), 'video/mp4');

      // Plain S3 URLs 403 for Brightcove ingest — the bucket is private.
      clipUrls.push(await presignGet(s3Key));

      updateJob(jobId, {
        progress: 15 + Math.round(((i + 1) / clips.length) * 80),
        clipsProcessed: i + 1,
      });
      fs.unlinkSync(clipPath);
    }

    await updateRow(row, {
      status: STATUS.DONE,
      clip1Url: clipUrls[0] || '',
      clip2Url: clipUrls[1] || '',
      clip3Url: clipUrls[2] || '',
      error: '',
    });

    updateJob(jobId, { status: 'done', progress: 100, clips: clipUrls });
  } catch (err) {
    await updateRow(row, { status: STATUS.ERROR, error: err.message.slice(0, 300) }).catch(() => {});
    updateJob(jobId, { status: 'error', error: err.message });
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Entry point for the React UI, which posts a row number instead of a full
 * payload. Reshapes the sheet row into the same job the sheet's step 3 sends.
 */
async function processRow(jobId, row) {
  return processClipJob(jobId, {
    row: row.rowNum,
    classTitle: row.title,
    sourceUrl: row.zoomUrl,
    clips: row.moments.map((m, idx) => ({
      index: idx + 1,
      startMs: m.startMs,
      endMs: m.endMs,
      title: m.title,
      outputKey: `${slugify(row.title)}-clip${idx + 1}.mp4`,
    })),
  });
}

module.exports = { processRow, processClipJob, STATUS };
