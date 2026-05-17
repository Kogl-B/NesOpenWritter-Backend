import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from './env.js';

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET
  ) {
    throw Object.assign(new Error('R2 not configured'), { statusCode: 503 });
  }
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return cachedClient;
}

export function isR2Configured(): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET,
  );
}

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  publicUrl: string | null;
  expiresIn: number;
}

export async function presignUpload(opts: {
  projectId: string;
  userId: string;
  kind: string;
  filename: string;
  contentType: string;
}): Promise<PresignedUpload> {
  const client = getClient();
  const safeName = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `users/${opts.userId}/projects/${opts.projectId}/${opts.kind}/${Date.now()}-${safeName}`;

  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: opts.contentType,
  });

  const expiresIn = 600; // 10 min
  const uploadUrl = await getSignedUrl(client, command, { expiresIn });

  const publicUrl = env.R2_PUBLIC_BASE_URL
    ? `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
    : null;

  return { uploadUrl, key, publicUrl, expiresIn };
}
