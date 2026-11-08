// QQ protocol/hash layout follows the pinned Tencent SDK 1.0.5 (MIT).
// Each network stage is supplied by the cancellable transport; there are no internal retries.
import { createHash } from 'node:crypto';
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
export async function chunkedUpload(bytes, filename, { check, request, put }) {
  check();
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 * 1024 * 1024 || bytes.length > 20 * 1024 * 1024) throw Error('CHUNK_SIZE_INVALID');
  const md5 = digest('md5', bytes);
  const prepared = await request('upload_prepare', {
    file_type: 4, file_name: filename, file_size: bytes.length, md5,
    sha1: digest('sha1', bytes), md5_10m: bytes.length > 10002432 ? digest('md5', bytes.subarray(0,10002432)) : md5
  });
  check();
  const block = prepared.block_size, parts = prepared.parts;
  if (typeof prepared.upload_id !== 'string' || !prepared.upload_id || prepared.upload_id.length > 1024
    || !Number.isSafeInteger(block) || block < 1 || block > 20 * 1024 * 1024 || !Array.isArray(parts)
    || parts.length !== Math.ceil(bytes.length / block) || parts.length > 64
    || new Set(parts.map(part => part.index)).size !== parts.length) throw Error('CHUNK_PLAN_INVALID');
  for (const part of [...parts].sort((a,b) => a.index-b.index)) {
    check();
    if (!Number.isSafeInteger(part.index) || part.index < 1 || part.index > parts.length || typeof part.presigned_url !== 'string') throw Error('CHUNK_PLAN_INVALID');
    const url = new URL(part.presigned_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443'
      || !['myqcloud.com','qq.com','qpic.cn','tencentcos.cn'].some(domain => url.hostname === domain || url.hostname.endsWith('.'+domain))) throw Error('CHUNK_UPLOAD_TARGET_INVALID');
    const offset = (part.index-1)*block, data = bytes.subarray(offset, Math.min(offset+block,bytes.length));
    await put(url.href,data);
    check();
    await request('upload_part_finish', { upload_id: prepared.upload_id, part_index: part.index, block_size: data.length, md5: digest('md5',data) });
  }
  check();
  const completed = await request('files', { upload_id: prepared.upload_id });
  check();
  if (typeof completed.file_info !== 'string' || !completed.file_info) throw Error('CHUNK_RESPONSE_INVALID');
  return { fileInfo: completed.file_info, ttl: Number(completed.ttl) || 300 };
}
