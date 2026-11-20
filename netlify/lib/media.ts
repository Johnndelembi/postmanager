import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getPool } from './db.js';
import { ApiError, json, readJson } from './http.js';

const BUCKET = 'videos';
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
let storageClient: S3Client | undefined;

type UploadClaim = {
  userId: number;
  key: string;
  filename: string;
  size: number;
  expiresAt: number;
};

export function storageConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_ENDPOINT_URL_S3?.startsWith('https://') &&
    process.env.AWS_REGION,
  );
}

function storage(): S3Client {
  if (!storageConfigured()) throw new ApiError(503, 'Video storage is not configured.');
  if (!storageClient) {
    storageClient = new S3Client({
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }
  return storageClient;
}

function signingKey(): string {
  const key = process.env.SESSION_SECRET;
  if (!key || key.length < 32) throw new ApiError(503, 'Upload signing is not configured.');
  return key;
}

function signClaim(claim: UploadClaim): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const signature = createHmac('sha256', signingKey()).update(`media-upload:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyClaim(token: unknown, userId: number): UploadClaim {
  if (typeof token !== 'string' || token.length > 2048) throw new ApiError(400, 'Upload confirmation is invalid.');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new ApiError(400, 'Upload confirmation is invalid.');
  const expected = createHmac('sha256', signingKey()).update(`media-upload:${payload}`).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); }
  catch { throw new ApiError(400, 'Upload confirmation is invalid.'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ApiError(400, 'Upload confirmation is invalid.');
  }
  let claim: UploadClaim;
  try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UploadClaim; }
  catch { throw new ApiError(400, 'Upload confirmation is invalid.'); }
  if (claim.userId !== userId || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt < Date.now() / 1000 ||
      !Number.isSafeInteger(claim.size) || claim.size <= 0 || claim.size > MAX_VIDEO_BYTES ||
      typeof claim.filename !== 'string' || claim.filename.length > 255 ||
      typeof claim.key !== 'string' || !/^users\/[0-9]+\/[a-f0-9]{32}\.mp4$/.test(claim.key) ||
      !claim.key.startsWith(`users/${userId}/`)) {
    throw new ApiError(400, 'Upload confirmation has expired or is invalid.');
  }
  return claim;
}

function safeFilename(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'Choose an MP4 video.');
  const filename = value.trim().split(/[\\/]/).at(-1)?.slice(0, 255) || '';
  if (!filename.toLowerCase().endsWith('.mp4')) throw new ApiError(400, 'Choose an MP4 video.');
  return filename;
}

function safeSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_VIDEO_BYTES) {
    throw new ApiError(413, 'MP4 videos must be 500 MB or smaller.');
  }
  return value;
}

async function uploadIntent(request: Request, userId: number): Promise<Response> {
  const data = await readJson(request);
  const filename = safeFilename(data.filename);
  const size = safeSize(data.size);
  if (data.content_type !== 'video/mp4') throw new ApiError(400, 'Choose an MP4 video.');
  const key = `users/${userId}/${randomBytes(16).toString('hex')}.mp4`;
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 60;
  try {
    const uploadUrl = await getSignedUrl(
      storage(),
      new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: 'video/mp4' }),
      { expiresIn: UPLOAD_TTL_SECONDS },
    );
    return json(200, {
      upload_url: uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      upload_token: signClaim({ userId, key, filename, size, expiresAt }),
      expires_in: UPLOAD_TTL_SECONDS,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('Could not issue a video upload URL', error);
    throw new ApiError(503, 'Video upload is unavailable. Try again.');
  }
}

async function hasMp4Header(key: string): Promise<boolean> {
  const object = await storage().send(new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: 'bytes=0-11' }));
  if (!object.ContentRange?.startsWith('bytes 0-') || (object.ContentLength ?? 13) > 12) {
    (object.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw new ApiError(503, 'Video storage could not inspect this file. Try again.');
  }
  const bytes = await object.Body?.transformToByteArray();
  return Boolean(bytes && bytes.length >= 8 && Buffer.from(bytes).toString('ascii', 4, 8) === 'ftyp');
}

async function completeUpload(request: Request, userId: number): Promise<Response> {
  const data = await readJson(request);
  const claim = verifyClaim(data.upload_token, userId);
  try {
    const head = await storage().send(new HeadObjectCommand({ Bucket: BUCKET, Key: claim.key }));
    if (head.ContentLength !== claim.size || head.ContentType?.split(';')[0]?.trim() !== 'video/mp4' ||
        !(await hasMp4Header(claim.key))) {
      await storage().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: claim.key }));
      throw new ApiError(400, 'The uploaded file is not the selected MP4 video. Choose it again.');
    }
    const pool = getPool();
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO media_assets(user_id, storage_key, original_filename, content_type, size_bytes)
       VALUES ($1, $2, $3, 'video/mp4', $4)
       ON CONFLICT (storage_key) DO NOTHING RETURNING id`,
      [userId, claim.key, claim.filename, claim.size],
    );
    const id = inserted.rows[0]?.id ?? (await pool.query<{ id: string }>(
      'SELECT id FROM media_assets WHERE storage_key = $1 AND user_id = $2',
      [claim.key, userId],
    )).rows[0]?.id;
    if (!id) throw new ApiError(500, 'The video could not be saved. Try again.');
    return json(200, { id, original_filename: claim.filename, size_bytes: claim.size, preview_url: `/api/media/${id}/preview` });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('Could not confirm a video upload', error);
    throw new ApiError(503, 'The video could not be confirmed. Try again.');
  }
}

async function preview(userId: number, id: string): Promise<Response> {
  const result = await getPool().query<{ storage_key: string }>(
    'SELECT storage_key FROM media_assets WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  const key = result.rows[0]?.storage_key;
  if (!key) throw new ApiError(404, 'Video not found.');
  try {
    const url = await getSignedUrl(storage(), new GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseContentDisposition: 'inline' }), { expiresIn: 15 * 60 });
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('Could not issue a video preview URL', error);
    throw new ApiError(503, 'The video preview could not be opened. Try again.');
  }
}

export async function handleMedia(request: Request, userId: number, pathname: string): Promise<Response | null> {
  if (pathname === '/api/media/status' && request.method === 'GET') return json(200, { configured: storageConfigured() });
  if (pathname === '/api/media/upload-intent' && request.method === 'POST') return uploadIntent(request, userId);
  if (pathname === '/api/media/complete' && request.method === 'POST') return completeUpload(request, userId);
  const match = /^\/api\/media\/(\d+)\/preview$/.exec(pathname);
  if (match && request.method === 'GET') return preview(userId, match[1]);
  if (pathname === '/api/media' && request.method === 'POST') {
    throw new ApiError(410, 'Use the direct video upload flow. Refresh this page and try again.');
  }
  return null;
}
