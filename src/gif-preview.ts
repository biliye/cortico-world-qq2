import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';

const GRID = 3;
const TILE_LIMIT = 240;
const GUTTER = 3;
// Bound the work from unsolicited files independently of the download limit.
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 2 * 1024 * 1024;
const MAX_FRAMES = 512;
const MAX_DECODE_WORK = 32 * 1024 * 1024;
const decoder = new TextDecoder();

export function isGif(bytes: Uint8Array): boolean {
  const signature = decoder.decode(bytes.subarray(0, 6));
  return signature === 'GIF87a' || signature === 'GIF89a';
}

type Frame = ReturnType<GifReader['frameInfo']>;

function fillRect(canvas: Buffer, width: number, rect: Pick<Frame, 'x' | 'y' | 'width' | 'height'>, color: Buffer): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const start = (y * width + rect.x) * 4;
    canvas.fill(color, start, start + rect.width * 4);
  }
}

function backgroundColor(bytes: Uint8Array): Buffer | undefined {
  const packed = bytes[10] ?? 0;
  const index = bytes[11] ?? 0;
  const offset = 13 + index * 3;
  if (!(packed & 0x80) || index >= (2 << (packed & 7)) || offset + 2 >= bytes.length) return undefined;
  return Buffer.from([bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, 255]);
}

/** Nine samples across the frame sequence, including its first and last frames. */
function renderGifPreview(bytes: Uint8Array): Buffer | undefined {
  if (bytes.length < 14 || bytes.length > MAX_INPUT_BYTES) return undefined;
  const gif = new GifReader(bytes);
  const { width, height } = gif;
  const canvasPixels = width * height;
  const count = gif.numFrames();
  if (!count || count > MAX_FRAMES || !canvasPixels || canvasPixels > MAX_CANVAS_PIXELS) return undefined;
  const frames = Array.from({ length: count }, (_, index) => gif.frameInfo(index));
  let work = 0;
  for (const frame of frames) {
    const { x, y, width: w, height: h, data_offset: offset, data_length: length } = frame;
    const codeSize = bytes[offset];
    if (!w || !h || x + w > width || y + h > height || offset + length > bytes.length
      || codeSize === undefined || codeSize < 2 || codeSize > 8) return undefined;
    work += w * h * (frame.disposal === 2 ? 2 : 1);
    if (frame.disposal === 3) work += 2 * canvasPixels;
  }
  if (work > MAX_DECODE_WORK) return undefined;

  const scale = Math.min(1, TILE_LIMIT / Math.max(width, height));
  const tileWidth = Math.max(1, Math.round(width * scale));
  const tileHeight = Math.max(1, Math.round(height * scale));
  const sheet = new PNG({
    width: GRID * tileWidth + (GRID - 1) * GUTTER,
    height: GRID * tileHeight + (GRID - 1) * GUTTER,
  });
  sheet.data.fill(255);
  const canvas = Buffer.alloc(canvasPixels * 4);
  const clear = Buffer.alloc(4);
  const background = backgroundColor(bytes);
  if (background && frames[0]!.transparent_index === null) canvas.fill(background);
  let previous: Buffer | undefined;
  const slots = Array.from({ length: GRID * GRID }, (_, slot) =>
    Math.round(slot * (count - 1) / (GRID * GRID - 1)));
  let slot = 0;
  for (const [index, frame] of frames.entries()) {
    if (frame.disposal === 3) {
      previous ??= Buffer.alloc(canvas.length);
      canvas.copy(previous);
    }
    // Transparent pixels leave whatever was already on the canvas in place.
    gif.decodeAndBlitFrameRGBA(index, canvas);
    while (slots[slot] === index) {
      const left = (slot % GRID) * (tileWidth + GUTTER);
      const top = Math.floor(slot / GRID) * (tileHeight + GUTTER);
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const src = (Math.floor(y * height / tileHeight) * width + Math.floor(x * width / tileWidth)) * 4;
          const dst = ((top + y) * sheet.width + left + x) * 4;
          if (canvas[src + 3]) canvas.copy(sheet.data, dst, src, src + 4);
        }
      }
      slot++;
    }
    if (frame.disposal === 2) {
      fillRect(canvas, width, frame, (frame.transparent_index === null && background) || clear);
    } else if (frame.disposal === 3) {
      previous!.copy(canvas);
    }
  }
  return PNG.sync.write(sheet, { colorType: 2, filterType: 0 });
}

/** The derivative shares the original GIF's hash, and never participates in deduplication. */
export function cachedGifPreview(dir: string, hash: string, bytes: Uint8Array): Buffer | undefined {
  if (!/^[a-f0-9]{64}$/.test(hash) || !isGif(bytes)) return undefined;
  const path = join(dir, `${hash}.gif-preview.png`);
  let preview: Buffer | undefined;
  try {
    if (existsSync(path)) return readFileSync(path);
    preview = renderGifPreview(bytes);
    if (preview) writeFileSync(path, preview);
  } catch {
    // Bad GIF data or an unavailable preview file must not prevent delivery of the original.
  }
  return preview;
}
