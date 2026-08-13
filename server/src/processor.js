const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { uploadFile, PROCESSED_PREFIX } = require('./s3');
const { updateJob } = require('./jobs');
const { updateRow } = require('./sheets');

ffmpeg.setFfmpegPath(ffmpegPath);

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });

    request.on('error', err => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function cutClip(inputPath, outputPath, startMs, endMs) {
  const startSec = startMs / 1000;
  const durationSec = (endMs - startMs) / 1000;
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startSec)
      .setDuration(durationSec)
      .outputOptions(['-c copy', '-avoid_negative_ts make_zero'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function processRow(jobId, row) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));

  try {
    updateJob(jobId, { status: 'downloading', progress: 5 });
    await updateRow(row.rowNum, { status: 'Processing', jobId });

    // Download video from Zoom URL
    const videoPath = path.join(tmpDir, 'input.mp4');
    await downloadFile(row.zoomUrl, videoPath);

    const moments = row.moments;
    if (!moments || moments.length === 0) {
      throw new Error('No moments found in sheet row');
    }

    updateJob(jobId, { status: 'processing', progress: 15, totalClips: moments.length });

    const s3Urls = [];

    for (let i = 0; i < moments.length; i++) {
      const moment = moments[i];
      const clipName = `${slugify(row.title)}_clip_${String(i + 1).padStart(2, '0')}_${slugify(moment.title)}.mp4`;
      const clipPath = path.join(tmpDir, clipName);

      await cutClip(videoPath, clipPath, moment.startMs, moment.endMs);

      const s3Key = `${PROCESSED_PREFIX}${clipName}`;
      const clipBuffer = fs.readFileSync(clipPath);
      await uploadFile(s3Key, clipBuffer, 'video/mp4');

      const s3Url = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;
      s3Urls.push(s3Url);

      const progress = 15 + Math.round(((i + 1) / moments.length) * 80);
      updateJob(jobId, { progress, clipsProcessed: i + 1 });

      fs.unlinkSync(clipPath);
    }

    // Write S3 URLs back to sheet
    await updateRow(row.rowNum, {
      status: 'Clipped',
      clip1Url: s3Urls[0] || '',
      clip2Url: s3Urls[1] || '',
      clip3Url: s3Urls[2] || '',
    });

    updateJob(jobId, { status: 'done', progress: 100, clips: s3Urls });
  } catch (err) {
    await updateRow(row.rowNum, { status: 'Error', error: err.message }).catch(() => {});
    updateJob(jobId, { status: 'error', error: err.message });
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { processRow };
