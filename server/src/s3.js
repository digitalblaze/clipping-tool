const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
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

module.exports = { s3, BUCKET, RAW_PREFIX, PROCESSED_PREFIX, listRawFiles, getObject, uploadFile };
