const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
require('dotenv').config();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET;
const RAW_PREFIX = process.env.SAT_RAW_PREFIX;
const PROCESSED_PREFIX = process.env.SAT_PROCESSED_PREFIX;

async function listRawFiles() {
  const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: RAW_PREFIX });
  const res = await s3.send(cmd);
  return (res.Contents || []).map(obj => obj.Key);
}

async function listPrefix(prefix) {
  const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix });
  const res = await s3.send(cmd);
  return (res.Contents || []).filter(o => o.Size > 0);
}

async function getObject(key) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const res = await s3.send(cmd);
  return res.Body;
}

async function uploadFile(key, body, contentType = 'video/mp4') {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  return s3.send(cmd);
}

// Streams from a readable (e.g. fs.createReadStream) so a clip never has to
// sit in memory in one piece — Render's free instance only has 512MB.
async function uploadStream(key, body, contentType = 'video/mp4') {
  const upload = new Upload({
    client: s3,
    params: { Bucket: BUCKET, Key: key, Body: body, ContentType: contentType },
  });
  return upload.done();
}

// The bucket is private: an unauthenticated GET of SAT/PROCESSED/* returns 403.
// Brightcove's ingest API fetches the URL server-side, so it needs a presigned
// one. SigV4 caps expiry at 7 days, which is far longer than an ingest needs.
const PRESIGN_MAX_SECONDS = 7 * 24 * 60 * 60;

async function presignGet(key, expiresIn = PRESIGN_MAX_SECONDS) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: Math.min(expiresIn, PRESIGN_MAX_SECONDS) });
}

module.exports = {
  s3, BUCKET, RAW_PREFIX, PROCESSED_PREFIX,
  listRawFiles, listPrefix, getObject, uploadFile, uploadStream, presignGet,
  PRESIGN_MAX_SECONDS,
};
