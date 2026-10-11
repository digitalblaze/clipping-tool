const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { uploadFile, uploadStream, presignGet, PROCESSED_PREFIX, RAW_PREFIX } = require('./s3');
const { updateJob } = require('./jobs');
const { updateRow, updateRowByKey, getRows, slugFor } = require('./sheets');

// @ffmpeg-installer/ffmpeg's Linux binary turned out to be a static build
// from December 2018 (confirmed live on Render via `ffmpeg -version`) -
// the source of a SIGSEGV on real clip jobs that never reproduced locally,
// where the darwin-arm64 build is from 2021. A custom script to fetch a
// fresher binary at install time turned out not to survive every rebuild
// reliably. ffmpeg-static ships ffmpeg 6.0 (2023) and downloads its binary
// via npm's own standard install step - the same mechanism every other
// dependency here already goes through reliably, every single build.
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('processor: using ffmpeg at', ffmpegPath);

// The Apps Script pipeline on the sheet skips a row in step 1 only when its
// status starts with "Assets Ready", "Moments", "Clips", or "Published". Any
// other value (the old "Processing"/"Clipped") makes step 1 re-pull the Zoom
// assets and write duplicate VTT/transcript files to Drive. Keep the prefix.
const STATUS = {
  PROCESSING: 'Clips: processing',
  DONE: 'Clips: done',
  ERROR: 'Clips: error',
};

const USER_AGENT = 'clipping-tool/1.0';
const MAX_REDIRECTS = 5;

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

/**
 * Checks the source is fetchable and seekable before we spend time on ffmpeg,
 * so the sheet gets a readable error instead of an ffmpeg stack trace.
 *
 * Also catches an expired Zoom access_token, which does not 401 — Zoom serves
 * an HTML login page with a 200.
 */
function preflightSource(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, {
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-1023' },
    }, res => {
      const { statusCode, headers } = res;
      res.resume();

      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects on source URL'));
        return preflightSource(headers.location, redirectsLeft - 1).then(resolve, reject);
      }

      if (/text\/html/i.test(headers['content-type'] || '')) {
        return reject(new Error(
          'Zoom returned an HTML page instead of video — the source URL\'s access_token has ' +
          'expired. Run "Refresh expired Zoom source URLs" on the sheet, then retry.'
        ));
      }

      if (statusCode !== 200 && statusCode !== 206) {
        return reject(new Error(`Source URL returned HTTP ${statusCode}`));
      }

      resolve({
        // Without range support ffmpeg has to stream from byte 0 to reach a
        // late moment. It still works, just slowly.
        rangeSupported: statusCode === 206 || headers['accept-ranges'] === 'bytes',
        totalBytes: Number(
          (headers['content-range'] || '').split('/')[1] || headers['content-length'] || 0),
      });
    });

    req.on('error', err => reject(new Error(`Could not reach source URL: ${err.message}`)));
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Timed out connecting to source URL'));
    });
  });
}

/**
 * Downloads the source to a local file, following redirects (plain
 * https.get doesn't). Streamed straight to disk, never buffered whole in
 * memory — proven safe on Render at ~461MB in ~16s.
 */
function downloadToFile(url, destPath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { headers: { 'User-Agent': USER_AGENT } }, res => {
      const { statusCode, headers } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects on source URL'));
        return downloadToFile(headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
      }
      if (statusCode !== 200 && statusCode !== 206) {
        res.resume();
        return reject(new Error(`Source download got HTTP ${statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * Cuts one clip from a local copy of the source. This used to seek directly
 * into the remote Zoom URL - cheap in theory, but ffmpeg's own HTTP client
 * segfaults doing that on Render specifically (confirmed with a throwaway
 * diagnostic endpoint: identical -c copy and libx264 runs both crashed
 * against the remote URL and both succeeded, byte-for-byte, against a local
 * copy of the same file - ruling out the codec, the binary, and the file
 * itself, and pointing squarely at remote seeking on this host). Re-encodes
 * rather than stream-copying: `-c copy` can only cut on keyframes and snaps
 * the start backwards to the previous one (measured 7.83s output for a
 * requested 5.5s cut at 5s keyframe spacing) - moments are padded only
 * 1.5s, so that snap would drag in speech from before the moment.
 */
function cutClip(localSourcePath, outputPath, startMs, endMs) {
  const startSec = startMs / 1000;
  const durationSec = (endMs - startMs) / 1000;
  return new Promise((resolve, reject) => {
    ffmpeg(localSourcePath)
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
 * Uploads the already-downloaded local source to S3, streamed from disk so
 * it's never buffered whole in memory regardless of file size.
 */
async function mirrorSourceToS3(localSourcePath, key) {
  await uploadStream(key, fs.createReadStream(localSourcePath), 'video/mp4');
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
  const { row: initialRow, classTitle, sourceUrl, clips, transcriptVtt } = job;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));

  // Captured now, while initialRow is still guaranteed fresh — the caller
  // just resolved it moments ago. This job can run for several minutes
  // (cutting plus mirroring), during which a row's position can shift if
  // someone edits the sheet elsewhere, so every write below re-resolves by
  // this key rather than trusting initialRow for the rest of the job.
  const startRow = (await getRows()).find(r => r.rowNum === initialRow);
  const meetingKey = startRow ? startRow.meetingId : null;

  function writeRow(patch) {
    return meetingKey ? updateRowByKey(meetingKey, patch) : updateRow(initialRow, patch);
  }

  try {
    updateJob(jobId, { status: 'checking source', progress: 3, totalClips: clips.length });
    await writeRow({ status: STATUS.PROCESSING, jobId, error: '' });

    const source = await preflightSource(sourceUrl);
    updateJob(jobId, {
      status: 'downloading',
      progress: 8,
      sourceBytes: source.totalBytes,
      rangeSupported: source.rangeSupported,
    });

    const localSourcePath = path.join(tmpDir, 'source.mp4');
    await downloadToFile(sourceUrl, localSourcePath);
    updateJob(jobId, { status: 'processing', progress: 15 });

    const clipUrls = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      // Honour the name the sheet chose, but always land it in SAT/PROCESSED/.
      const fileName = clip.outputKey
        ? path.basename(clip.outputKey)
        : `${slugify(classTitle)}-clip${clip.index || i + 1}.mp4`;
      const clipPath = path.join(tmpDir, fileName);

      await cutClip(localSourcePath, clipPath, clip.startMs, clip.endMs);

      const bytes = fs.statSync(clipPath).size;
      if (bytes < 10 * 1024) throw new Error(`Clip ${i + 1} came out empty (${bytes} bytes)`);

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

    await writeRow({
      status: STATUS.DONE,
      clip1Url: clipUrls[0] || '',
      clip2Url: clipUrls[1] || '',
      clip3Url: clipUrls[2] || '',
      error: '',
    });

    // Best-effort: the clip job has already succeeded above, so a failure
    // here (bandwidth, a dropped connection, the Zoom token expiring mid-
    // transfer) only means the Full Recording / Transcript tabs stay empty
    // for this class — it must never overwrite the sheet's error column or
    // flip status away from done.
    try {
      updateJob(jobId, { status: 'mirroring', progress: 97 });
      const rows = await getRows();
      const liveRow = meetingKey
        ? rows.find(r => r.meetingId === meetingKey)
        : rows.find(r => r.rowNum === initialRow);
      const slug = slugFor((liveRow && liveRow.title) || classTitle, (liveRow && liveRow.date) || '');

      const tasks = [mirrorSourceToS3(localSourcePath, `${RAW_PREFIX}${slug}-source.mp4`)];
      if (transcriptVtt && transcriptVtt.trim()) {
        tasks.push(uploadFile(`${RAW_PREFIX}${slug}-transcript.vtt`, Buffer.from(transcriptVtt, 'utf8'), 'text/vtt'));
      }
      await Promise.all(tasks);
    } catch (mirrorErr) {
      console.error(`Job ${jobId} (row ${initialRow}): mirroring source/transcript failed:`, mirrorErr.message);
    }

    updateJob(jobId, { status: 'done', progress: 100, clips: clipUrls });
  } catch (err) {
    await writeRow({ status: STATUS.ERROR, error: err.message.slice(0, 300) }).catch(() => {});
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
