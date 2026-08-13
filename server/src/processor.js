const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getObject, uploadFile, PROCESSED_PREFIX } = require('./s3');
const { parseTranscript, toSeconds } = require('./csv');
const { updateJob } = require('./jobs');

ffmpeg.setFfmpegPath(ffmpegPath);

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function cutClip(inputPath, outputPath, start, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(start)
      .setDuration(duration)
      .outputOptions(['-c copy', '-avoid_negative_ts make_zero'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function processVideo(jobId, videoKey, csvKey) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));

  try {
    updateJob(jobId, { status: 'downloading', progress: 5 });

    // Download video
    const videoExt = path.extname(videoKey) || '.mp4';
    const videoPath = path.join(tmpDir, `input${videoExt}`);
    const videoStream = await getObject(videoKey);
    const videoBuffer = await streamToBuffer(videoStream);
    fs.writeFileSync(videoPath, videoBuffer);

    // Download CSV transcript
    const csvStream = await getObject(csvKey);
    const csvBuffer = await streamToBuffer(csvStream);
    const clips = parseTranscript(csvBuffer.toString('utf8'));

    updateJob(jobId, { status: 'processing', progress: 10, totalClips: clips.length });

    const baseName = path.basename(videoKey, videoExt);
    const processedKeys = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const startSec = toSeconds(clip.start);
      const endSec = toSeconds(clip.end);
      const duration = endSec - startSec;

      if (duration <= 0) {
        console.warn(`Clip ${i + 1} has zero/negative duration, skipping`);
        continue;
      }

      const clipName = `${baseName}_${String(i + 1).padStart(3, '0')}_${slugify(clip.caption)}${videoExt}`;
      const clipPath = path.join(tmpDir, clipName);

      await cutClip(videoPath, clipPath, startSec, duration);

      // Upload to S3
      const s3Key = `${PROCESSED_PREFIX}${clipName}`;
      const clipBuffer = fs.readFileSync(clipPath);
      await uploadFile(s3Key, clipBuffer, 'video/mp4');
      processedKeys.push(s3Key);

      const progress = 10 + Math.round(((i + 1) / clips.length) * 85);
      updateJob(jobId, { progress, clipsProcessed: i + 1 });

      fs.unlinkSync(clipPath);
    }

    updateJob(jobId, { status: 'done', progress: 100, clips: processedKeys });
  } catch (err) {
    updateJob(jobId, { status: 'error', error: err.message });
    throw err;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { processVideo };
