/**
 * File storage behind one small interface. Backend now: MongoDB GridFS (backed up with the database).
 * Later: an S3-compatible bucket — add a backend here, set STORAGE_BACKEND, and copy files across;
 * callers keep using put / get / remove with the stored key.
 */
import { GridFSBucket, ObjectId } from 'mongodb';
import mongoose from 'mongoose';

const bucket = () => new GridFSBucket(mongoose.connection.db as any, { bucketName: 'files' });

export async function putFile(data: Buffer, filename: string, mime: string, meta: Record<string, unknown> = {}): Promise<{ backend: string; key: string }> {
  const id = new ObjectId();
  await new Promise<void>((ok, fail) => {
    const up = bucket().openUploadStreamWithId(id, filename, { metadata: { ...meta, contentType: mime } });
    up.on('finish', () => ok());
    up.on('error', fail);
    up.end(data);
  });
  return { backend: 'gridfs', key: String(id) };
}

export async function getFile(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((ok, fail) => {
    bucket().openDownloadStream(new ObjectId(key)).on('data', (c: Buffer) => chunks.push(c)).on('end', () => ok()).on('error', fail);
  });
  return Buffer.concat(chunks);
}

export async function removeFile(key: string) {
  await bucket().delete(new ObjectId(key)).catch(() => undefined);
}
