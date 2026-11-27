/** Shared QQ image download limits and MIME handling for event capture and vision. */
import { isGif } from '../gif-preview.ts';

export interface ImageDownloadOptions {
  timeoutMs: number;
  maxImageBytes: number;
}

export const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export async function downloadImageBytes(
  url: string,
  options: ImageDownloadOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ buffer: Uint8Array; mime: string }> {
  if (!url) throw new Error('图片地址为空');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), options.timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    if (ab.byteLength > options.maxImageBytes) {
      throw new Error(`图片过大(${ab.byteLength}字节 > 上限${options.maxImageBytes})`);
    }
    const buffer = new Uint8Array(ab);
    return { buffer, mime: pickImageMime(buffer, res.headers.get('content-type'), url) };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('下载超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function pickImageMime(bytes: Uint8Array, contentType: string | null, name: string): string {
  const startsWith = (signature: readonly number[], offset = 0) =>
    signature.every((byte, i) => bytes[offset + i] === byte);
  if (isGif(bytes)) return 'image/gif';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith([0x42, 0x4d])) return 'image/bmp';
  const mime = contentType?.split(';')[0].trim().toLowerCase();
  if (mime?.startsWith('image/')) return mime === 'image/jpg' ? 'image/jpeg' : mime;
  const ext = (name.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase();
  if (ext === 'jpeg') return 'image/jpeg';
  for (const [mime, extension] of Object.entries(MIME_EXT)) {
    if (extension === ext) return mime;
  }
  return 'image/jpeg';
}
