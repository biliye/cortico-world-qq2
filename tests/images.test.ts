/**
 * 取图库(不含 VLM):下载、落盘、sha256 判同、清理。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageLibrary, type ImageLibraryDeps } from '../src/images.ts';
import { VisionService, VISION_DEFAULTS } from '../src/onebot/vision.ts';
import type { VLMMessage } from '../src/onebot/vlm.ts';
import { QQ2World } from '../src/world.ts';
import { animatedGif } from './helpers/gif.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qq-images-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytesOf = (n: number): Uint8Array => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 7) % 251));

/** 假 fetch:url 就是键;键名带 'boom' 的抛错,'big' 的声明超大。 */
function fakeFetch(table: Record<string, Uint8Array>): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('boom')) throw new Error('连接被重置');
    const body = table[String(url)] ?? bytesOf(0);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(body.byteLength) },
    });
  }) as unknown as typeof fetch;
}

function makeLib(over: Partial<ImageLibraryDeps['cfg']> = {}, table: Record<string, Uint8Array> = {}): ImageLibrary {
  return new ImageLibrary({
    dataDir: dir,
    timezone: 'Asia/Shanghai',
    cfg: { maxImageBytes: 1024, ...over },
    fetchImpl: fakeFetch(table),
  });
}

const registry = (): string => join(dir, 'qq-images', 'registry.jsonl');

describe('登记与落盘', () => {
  it('分配 IMG-N;回填消息号后才写登记表', () => {
    const lib = makeLib();
    const a = lib.register('http://x/a.png');
    expect(a).toBe('IMG-1');
    expect(lib.register('http://x/b.png')).toBe('IMG-2');
    expect(existsSync(registry())).toBe(false);
    lib.attachMessage(a, 12345);
    expect(readFileSync(registry(), 'utf8')).toContain('"messageId":"12345"');
  });

  it('重启后编号接着走,旧记录还在', async () => {
    const first = makeLib({}, { 'http://x/a.png': bytesOf(100) });
    const id = first.register('http://x/a.png');
    first.attachMessage(id, 1);
    await first.resolve(id);

    const again = makeLib();
    expect(again.imageCount()).toBe(1);
    expect(again.get('IMG-1')?.hash).toBeTruthy();
    expect(again.register('http://x/c.png')).toBe('IMG-2');
  });
});

describe('同一份文件(sha256)', () => {
  it('两份 GIF 生成同一张预览，仍按原 GIF 的不同字节区分', async () => {
    const lib = makeLib({}, { a: animatedGif(5), b: animatedGif(6) });
    const first = await lib.resolve(lib.register('a'));
    const second = await lib.resolve(lib.register('b'));
    expect(first.preview).toBeDefined();
    expect(second.preview).toEqual(first.preview);
    expect(second.record.dupOf).toBeUndefined();
    expect(second.record.hash).not.toBe(first.record.hash);
  });

  it('解码预算之外的 GIF 仍保留原件', async () => {
    const gif = animatedGif();
    gif.writeUInt16LE(2048, 6);
    gif.writeUInt16LE(2048, 8);
    const lib = makeLib({}, { a: gif });
    const found = await lib.resolve(lib.register('a'));
    expect(found.preview).toBeUndefined();
    expect(found.record.failedReason).toBeUndefined();
    expect((await lib.readBytes(found.record.id))?.bytes).toEqual(new Uint8Array(gif));
  });

  it('字节一样:第二次报 dupOf,盘上只落一份', async () => {
    const same = bytesOf(120);
    const lib = makeLib({}, { 'http://x/a.png': same, 'http://x/b.png': same });
    const a = lib.register('http://x/a.png');
    const b = lib.register('http://x/b.png');
    const ra = await lib.resolve(a);
    const rb = await lib.resolve(b);
    expect(ra.record.hash).toBe(rb.record.hash);
    expect(rb.record.dupOf).toBe(a);
    expect(ra.text).toContain('IMG-1');
    expect(rb.text).toContain(`与 ${a} 是同一份文件`);
    const files = readdirSync(join(dir, 'qq-images')).filter((f) => f !== 'registry.jsonl');
    expect(files).toHaveLength(1);
  });

  it('字节不同:各存各的,不记 dupOf', async () => {
    const lib = makeLib({}, { 'http://x/a.png': new Uint8Array([5, 1, 1]), 'http://x/b.png': new Uint8Array([5, 9, 9, 9]) });
    const a = lib.register('http://x/a.png');
    const b = lib.register('http://x/b.png');
    await lib.resolve(a);
    const rb = await lib.resolve(b);
    expect(rb.record.dupOf).toBeUndefined();
    expect(rb.text).not.toContain('同一份文件');
  });
});

it('辅助视觉也读九宫图，重复 GIF 复用原图哈希的识别结果', async () => {
  const gif = animatedGif();
  const chat = vi.fn(async (_messages: VLMMessage[]) => ({
    text: '测试识图',
    usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
  }));
  const vision = new VisionService({
    dataDir: dir,
    timezone: 'Asia/Shanghai',
    cfg: VISION_DEFAULTS,
    fetchImpl: fakeFetch({ a: gif, b: gif }),
    vlm: { chat },
  });
  const first = vision.registerImage('a');
  await new Promise<void>((resolve) => vision.startPassive(first, () => resolve()));
  const [image] = chat.mock.calls[0]![0][0]!.content;
  expect(image).toMatchObject({ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;/) } });
  expect((await vision.getDisplayImage(first))?.preview).toBe(true);
  expect((await vision.getImageBytes(first))?.buffer).toEqual(new Uint8Array(gif));
  const second = vision.registerImage('b');
  expect((await vision.precheckDup(second))?.meta.dup_of).toBe(first);
  expect(chat).toHaveBeenCalledTimes(1);
  const world = new QQ2World({ wsUrl: 'ws://127.0.0.1:1', groups: [], privates: [], token: '', dataDir: dir }, { vision });
  const tool = world.tools().find(tool => tool.name === 'qq2_get_image')!;
  const ctx = {} as Parameters<typeof tool.handler>[1];
  const preview = await tool.handler({ image_id: second }, ctx);
  const original = await tool.handler({ image_id: second, original: true }, ctx);
  expect(preview).toMatchObject({ blobs: [{ mime: 'image/png' }] });
  expect(original).toMatchObject({ blobs: [{ mime: 'image/gif' }] });
});

describe('取不到的时候', () => {
  it('超过大小上限:声明里就超了,直接不下载,正文写明原因', async () => {
    const lib = makeLib({ maxImageBytes: 10 }, { 'http://x/big.png': bytesOf(50) });
    const id = lib.register('http://x/big.png');
    const got = await lib.resolve(id);
    expect(got.bytes).toBeUndefined();
    expect(got.record.failedReason).toContain('超过上限');
    expect(readdirSync(join(dir, 'qq-images'))).toEqual(['registry.jsonl']);
  });

  it('没声明大小的超限图:下载完才拦住,同样不落盘', async () => {
    const lib = new ImageLibrary({
      dataDir: dir,
      timezone: 'Asia/Shanghai',
      cfg: { maxImageBytes: 10 },
      // 故意不给 content-length:走"下回来再量"那条
      fetchImpl: (async () =>
        new Response(bytesOf(50), { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch,
    });
    const got = await lib.resolve(lib.register('http://x/nolen.png'));
    expect(got.bytes).toBeUndefined();
    expect(got.text).toContain('不下载');
    expect(readdirSync(join(dir, 'qq-images'))).toEqual(['registry.jsonl']);
  });

  it('下载失败:不抛出去,记原因', async () => {
    const lib = makeLib({}, {});
    const id = lib.register('http://x/boom.png');
    const got = await lib.resolve(id);
    expect(got.bytes).toBeUndefined();
    expect(got.text).toContain('取回失败');
    expect(got.record.failedReason).toContain('连接被重置');
  });

  it('没有地址:算失败,不是崩溃', async () => {
    const lib = makeLib();
    const got = await lib.resolve(lib.register(''));
    expect(got.text).toContain('取回失败');
  });
});

describe('时限与幂等', () => {
  it('时限内取回:直接拿到结论与字节', async () => {
    const lib = makeLib({}, { 'http://x/a.png': bytesOf(64) });
    const id = lib.register('http://x/a.png');
    const got = await lib.precheckWithin(id, 2000);
    expect(got?.bytes?.byteLength).toBe(64);
    expect(got?.text).toContain('IMG-1');
  });

  it('时限 0:先给占位符,同一份工作稍后自己走完(不重复下载)', async () => {
    let calls = 0;
    const table = { 'http://x/a.png': bytesOf(30) };
    const lib = new ImageLibrary({
      dataDir: dir,
      timezone: 'Asia/Shanghai',
      cfg: { maxImageBytes: 1024 },
      fetchImpl: (async (url: string) => {
        calls += 1;
        const body = table[String(url) as keyof typeof table] ?? bytesOf(0);
        return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
      }) as unknown as typeof fetch,
    });
    const id = lib.register('http://x/a.png');
    expect(await lib.precheckWithin(id, 0)).toBeNull();
    expect(lib.placeholder(id, false)).toContain('正在取回');
    const later = await lib.resolve(id);
    expect(later.bytes?.byteLength).toBe(30);
    expect(calls).toBe(1);
  });
});

describe('清理', () => {
  it('clear():编号归零、磁盘清空、登记表消失', async () => {
    const lib = makeLib({}, { 'http://x/a.png': bytesOf(10) });
    await lib.resolve(lib.register('http://x/a.png'));
    expect(lib.imageCount()).toBe(1);
    expect(lib.clear()).toBe(1);
    expect(lib.imageCount()).toBe(0);
    expect(existsSync(registry())).toBe(false);
    expect(lib.register('http://x/b.png')).toBe('IMG-1');
  });
});
