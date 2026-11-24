import { GifWriter } from 'omggif';

export const GIF_WIDTH = 8;
export const GIF_HEIGHT = 6;
export const GIF_COLORS = Array.from({ length: 16 }, (_, i) => (i * 16) << 16 | 0x5030);

export function animatedGif(delay = 5): Buffer {
  const target = Buffer.alloc(4096);
  const writer = new GifWriter(target, GIF_WIDTH, GIF_HEIGHT, { palette: GIF_COLORS });
  for (let i = 0; i < 11; i++) {
    writer.addFrame(0, 0, GIF_WIDTH, GIF_HEIGHT, Array<number>(GIF_WIDTH * GIF_HEIGHT).fill(i), { delay });
  }
  return target.subarray(0, writer.end());
}
