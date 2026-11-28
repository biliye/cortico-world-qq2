/**
 * 入站文件与语音:嗅探、渲染、文件库,以及「一条 QQ 文件消息真的走到推送点」的真回路。
 *
 * 为什么单测之外还要一层真回路:单测只验了纯函数与库,验不到「段被替换、正文里真有内容、
 * 编号真落盘、工具真读得回来」。上一轮的教训(见设计记录「按住说话」那节)是:
 * 要验一条路,就用那条路自己灌一次已知输入。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import { LogBlobStore } from 'cortico/core/blobs.ts';
import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { ASR_DEFAULTS, FILES_DEFAULTS, type QQAsrConfig, type QQFilesConfig } from '../src/config.ts';
import { FileLibrary, formatBytes, renderFileText, sniffText } from '../src/files.ts';
import { MockNapCat } from './helpers/mock-napcat.ts';
import { QQ2World } from '../src/world.ts';

// ————— 纯函数 —————

const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

describe('判文本还是二进制', () => {
  it('UTF-8 中文认成文本', () => {
    expect(sniffText(utf8('哈喽哈喽\n第二行'))).toEqual({ kind: 'text', text: '哈喽哈喽\n第二行', encoding: 'utf-8' });
  });

  it('GBK 中文也认(Windows 记事本存的旧文件就是这一档)', () => {
    // 「你好」的 GBK 字节
    const got = sniffText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    expect(got.kind).toBe('text');
    expect(got).toMatchObject({ encoding: 'gbk' });
    expect((got as { text: string }).text).toBe('你好');
  });

  it('带 BOM 的 UTF-8 走 BOM 那条路(BOM 本身不进正文)', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('嗯')]);
    expect(sniffText(bytes)).toEqual({ kind: 'text', text: '嗯', encoding: 'utf-8' });
  });

  it('PNG 一眼判成二进制 —— 别让它被 GBK 解出「塒NG…」那种像字的垃圾', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0x41)]);
    expect(sniffText(png)).toEqual({ kind: 'binary' });
  });

  it('ZIP / PDF 同样拦下(Office 与 APK 都是 ZIP 那一族)', () => {
    expect(sniffText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toEqual({ kind: 'binary' });
    expect(sniffText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toEqual({ kind: 'binary' });
  });

  it('含 NUL 的字节判成二进制', () => {
    expect(sniffText(new Uint8Array([0x41, 0x00, 0x42, 0x00]))).toEqual({ kind: 'binary' });
  });

  it('空文件算文本(空文本),不是二进制', () => {
    expect(sniffText(new Uint8Array(0))).toEqual({ kind: 'text', text: '', encoding: 'utf-8' });
  });
});

describe('正文怎么渲染', () => {
  const cfg = (over: Partial<QQFilesConfig> = {}): QQFilesConfig => ({ ...FILES_DEFAULTS, ...over });
  const rec = { id: 'FILE-3', name: '备注.txt', size: 12, url: null, ref: null };

  it('小文本:全文直接进正文', () => {
    const text = renderFileText(rec, { kind: 'text', text: '哈喽哈喽', encoding: 'utf-8' }, cfg());
    expect(text).toContain('[文件 备注.txt · 12 B · FILE-3]');
    expect(text).toContain('哈喽哈喽');
    expect(text).not.toContain('qq2_read_file');
  });

  it('大文本:只给头几行,并告诉她怎么接着看', () => {
    const big = Array.from({ length: 900 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const text = renderFileText(rec, { kind: 'text', text: big, encoding: 'utf-8' }, cfg({ previewLines: 3 }));
    expect(text).toContain('第 1 行');
    expect(text).toContain('第 3 行');
    expect(text).not.toContain('第 4 行');
    expect(text).toContain('共 900 行');
    expect(text).toContain('qq2_read_file FILE-3 offset=3');
  });

  it('二进制:只有一句说明,不承诺任何「打开」动作', () => {
    const text = renderFileText({ ...rec, name: 'x.apk', size: 60 * 1024 * 1024 }, { kind: 'binary' }, cfg());
    expect(text).toContain('x.apk');
    expect(text).toContain('60.0 MB');
    expect(text).toContain('不是文本');
    expect(text).toContain('没有读内容');
  });

  it('非 UTF-8 的文本会标出编码(她据此知道那是编码问题、不是乱码)', () => {
    const text = renderFileText(rec, { kind: 'text', text: '你好', encoding: 'gbk' }, cfg());
    expect(text).toContain('gbk');
  });
});

describe('大小怎么写给人看', () => {
  it('三档', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(240 * 1024)).toBe('240 KB');
    expect(formatBytes(60.7 * 1024 * 1024)).toBe('60.7 MB');
  });
});

// ————— 文件库(注入假 fetch,真落盘) —————

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qq-files-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(table: Record<string, Uint8Array>): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('boom')) throw new Error('连接被重置');
    const body = table[String(url)];
    if (!body) return new Response('nope', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-length': String(body.byteLength) } });
  }) as unknown as typeof fetch;
}

function makeLib(
  table: Record<string, Uint8Array> = {},
  over: Partial<QQFilesConfig> = {},
  resolveUrl: (ref: unknown) => Promise<string | null> = async () => null,
): FileLibrary {
  return new FileLibrary({
    dataDir: dir,
    cfg: { ...FILES_DEFAULTS, ...over },
    log: nullLogger(),
    fetchImpl: fakeFetch(table),
    resolveUrl,
  });
}

const registry = (): string => join(dir, 'qq-files', 'registry.jsonl');

describe('文件库', () => {
  it('登记给 FILE-N,解析后落盘、正文带内容', async () => {
    const lib = makeLib({ 'http://x/a.txt': utf8('哈喽哈喽') });
    const id = lib.register({ name: 'a.txt', size: 12, url: 'http://x/a.txt' });
    expect(id).toBe('FILE-1');
    const got = await lib.resolve(id);
    expect(got.ok).toBe(true);
    expect(got.rendered).toContain('哈喽哈喽');
    expect(readFileSync(registry(), 'utf8')).toContain('"kind":"text"');
    expect(existsSync(join(dir, 'qq-files', lib.get(id)!.file!))).toBe(true);
  });

  it('段里没给地址时,去 resolveUrl 要(私聊 file 段就是这条路)', async () => {
    const lib = makeLib({ 'http://x/b.txt': utf8('要来的内容') }, {}, async () => 'http://x/b.txt');
    const id = lib.register({ name: 'b.txt', size: undefined, url: null, ref: { fileId: 'fid' } });
    expect((await lib.resolve(id)).rendered).toContain('要来的内容');
  });

  it('要不到地址:如实说,不假装读到了', async () => {
    const lib = makeLib();
    const id = lib.register({ name: 'c.txt', size: 10, url: null });
    const got = await lib.resolve(id);
    expect(got.ok).toBe(false);
    expect(got.rendered).toContain('没能从协议端拿到下载地址');
  });

  it('超过大小上限:不下、不读,并说清是超过上限(群里那个 60MB 就是这一档)', async () => {
    const lib = makeLib({}, { maxBytes: 1024 });
    const id = lib.register({ name: 'big.apk', size: 60 * 1024 * 1024, url: 'http://x/none' });
    const got = await lib.resolve(id);
    expect(got.ok).toBe(false);
    expect(got.rendered).toContain('超过上限');
    expect(got.rendered).toContain('没有下载');
  });

  it('下载失败:照实回,不编内容', async () => {
    const lib = makeLib({ 'http://x/boom.txt': utf8('x') });
    const id = lib.register({ name: 'd.txt', size: 1, url: 'http://x/boom.txt' });
    const got = await lib.resolve(id);
    expect(got.ok).toBe(false);
    expect(got.rendered).toContain('下载失败');
  });

  it('按段读:行号从 1 数,一次给一段,并提示后面还有多少', async () => {
    const body = Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n');
    const lib = makeLib({ 'http://x/e.txt': utf8(body) }, { inlineMaxBytes: 16 });
    const id = lib.register({ name: 'e.txt', size: 300, url: 'http://x/e.txt' });
    await lib.resolve(id);
    const first = lib.read(id, 1, 5);
    expect(first.text).toContain('L1\nL2\nL3\nL4\nL5');
    expect(first.text).toContain('共 50 行');
    expect(first.text).toContain('offset=6');
    const later = lib.read(id, 46, 10);
    expect(later.text).toContain('L46');
    expect(later.text).toContain('L50');
    expect(later.text).not.toContain('offset=56');
  });

  it('读一个不认识/不是文本/超限的编号,各给一句人话', async () => {
    const lib = makeLib({ 'http://x/f.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) });
    expect(lib.read('FILE-99', 1, 10).failed).toBe(true);
    const img = lib.register({ name: 'f.png', size: 7, url: 'http://x/f.png' });
    await lib.resolve(img);
    expect(lib.read(img, 1, 10).text).toContain('不是文本文件');
    const big = lib.register({ name: 'g.apk', size: 99 * 1024 * 1024, url: 'http://x/none' });
    await lib.resolve(big);
    expect(lib.read(big, 1, 10).text).toContain('超过大小上限');
  });

  it('重启后编号接着走,旧记录还在(她还能提到上一次那个 FILE-N)', async () => {
    const first = makeLib({ 'http://x/h.txt': utf8('第一份') });
    const id = first.register({ name: 'h.txt', size: 9, url: 'http://x/h.txt' });
    await first.resolve(id);

    const again = makeLib();
    expect(again.fileCount()).toBe(1);
    expect(again.get('FILE-1')?.kind).toBe('text');
    expect(again.register({ name: 'i.txt' })).toBe('FILE-2');
  });

  it('重启后改名重发只给引用，且两个编号读回同一份原件', async () => {
    const bytes = utf8('具体需求只预览一次');
    const url = 'http://x/request';
    const first = makeLib({ [url]: bytes });
    const original = first.register({ name: 'request.txt', url });
    expect((await first.resolve(original)).rendered).toContain('具体需求只预览一次');

    const restarted = makeLib({ [url]: bytes });
    const renamed = restarted.register({ name: '更新.json', url });
    const got = await restarted.resolve(renamed);
    expect(got.rendered).toContain(`更新.json · ${formatBytes(bytes.length)} · ${renamed} · 同 ${original}`);
    expect(got.rendered).not.toContain('具体需求只预览一次');
    expect(readdirSync(join(dir, 'qq-files')).filter((name) => name !== 'registry.jsonl')).toHaveLength(1);

    const offline = makeLib();
    expect(await offline.readOriginal(original)).toEqual({ bytes: Buffer.from(bytes), name: 'request.txt', mime: 'text/plain' });
    expect(await offline.readOriginal(renamed)).toEqual({ bytes: Buffer.from(bytes), name: '更新.json', mime: 'text/plain' });
    expect(offline.read(renamed, 1, 1).text).toContain('具体需求只预览一次');
  });

  it('预取返回 503 后，并发取原件共用一次刷新与下载，重启后仍可读取', async () => {
    const expired = 'http://x/expired';
    const fresh = 'http://x/fresh';
    const attempts: string[] = [];
    const bytes = utf8('重试取回的文件');
    let finishPrefetch!: (response: Response) => void;
    const prefetchResponse = new Promise<Response>((resolve) => { finishPrefetch = resolve; });
    const lib = new FileLibrary({
      dataDir: dir, cfg: FILES_DEFAULTS, log: nullLogger(),
      resolveUrl: async () => fresh,
      fetchImpl: async (url) => {
        attempts.push(String(url));
        return url === expired ? prefetchResponse : new Response(bytes);
      },
    });
    const id = lib.register({ name: '需求.txt', url: expired });
    const prefetch = lib.resolve(id);
    const reading = Promise.all([lib.readOriginal(id), lib.readOriginal(id)]);
    finishPrefetch(new Response(null, { status: 503 }));

    expect(await prefetch).toMatchObject({ ok: false, rendered: expect.stringContaining('HTTP 503') });
    expect((await reading).map(({ bytes }) => bytes)).toEqual([Buffer.from(bytes), Buffer.from(bytes)]);
    expect(attempts).toEqual([expired, fresh]);
    expect((await makeLib().readOriginal(id)).bytes).toEqual(Buffer.from(bytes));
  });

  it('第一次取址失败后可按原编号恢复，实际超限的文件保持拒绝', async () => {
    const url = 'http://x/file';
    const bytes = utf8('12345');
    let lookups = 0;
    const restored = makeLib({ [url]: bytes }, {}, async () => ++lookups === 1 ? null : url);
    const id = restored.register({ name: '恢复.txt' });
    expect((await restored.resolve(id)).ok).toBe(false);
    expect((await restored.readOriginal(id)).bytes).toEqual(Buffer.from(bytes));
    expect(lookups).toBe(2);

    const limited = makeLib({ [url]: bytes }, { maxBytes: 4 }, async () => {
      lookups++;
      return url;
    });
    const tooBig = limited.register({ name: '超限.txt', url });
    expect(await limited.resolve(tooBig)).toMatchObject({ ok: false, rendered: expect.stringContaining('超过上限') });
    expect(limited.get(tooBig)?.error).toBe('too-large');
    await expect(limited.readOriginal(tooBig)).rejects.toThrow('超过上限');
    expect(lookups).toBe(2);
  });
});

// ————— 真回路:MockNapCat ⇄ qq2 ⇄ 记录型 host —————

const GROUP = 424242;
const PEER = 200002;

interface Recorded {
  event: EventEnvelope;
  opts: PushOptions | undefined;
}

class RecordingHost {
  readonly pushed: Recorded[] = [];
  readonly host: WorldHost;

  constructor() {
    const self = this;
    this.host = {
      pushEvent: async (event: Parameters<WorldHost['pushEvent']>[0], opts?: PushOptions): Promise<EventEnvelope> => {
        const stored = { cursor: self.pushed.length + 1, origin: 'external', contextDelivery: 'immediate', ...event } as unknown as EventEnvelope;
        self.pushed.push({ event: stored, opts });
        return stored;
      },
      store: { range: () => [], grep: () => [] },
      drainPendingEvents: async () => [],
      modelFacts: { model: () => 'test', accepts: () => false, contextWindow: () => undefined },
      blob: () => null,
      reportUsage: () => {},
      log: nullLogger(),
    } as unknown as WorldHost;
  }

  texts(type = 'qq.message'): string[] {
    return this.pushed.filter((p) => p.event.type === type).map((p) => p.event.text ?? '');
  }

  last(type = 'qq.message'): string {
    const all = this.texts(type);
    return all[all.length - 1] ?? '';
  }
}

let mock: MockNapCat;
let mod: QQ2World;
let host: RecordingHost;
let dataDir: string;
let asrConfig: QQAsrConfig;
let filesConfig: QQFilesConfig;
let fileServer: { url: (name: string) => string; server: Server };

/** 一个真 HTTP 服务:按文件名给字节(都是文本,便于断言内容)。 */
async function serveFiles(table: Record<string, string>): Promise<{ url: (n: string) => string; server: Server }> {
  const server = createServer((req, res) => {
    const name = (req.url ?? '/').replace(/^\//, '').split('?')[0]!;
    const body = table[name];
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(buf.byteLength) });
    res.end(buf);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: (n: string) => `http://127.0.0.1:${port}/${n}`, server };
}

async function waitUntil(check: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时');
}

beforeEach(async () => {
  mock = new MockNapCat({ port: 0, groupId: GROUP, selfId: 5000, selfNickname: 'bot', selfCard: 'botcard', groupName: '深夜食堂' });
  const port = await mock.start();
  host = new RecordingHost();
  dataDir = mkdtempSync(join(tmpdir(), 'qq2-inbound-'));
  asrConfig = { ...ASR_DEFAULTS };
  filesConfig = { ...FILES_DEFAULTS, waitMs: 5000 };
  fileServer = await serveFiles({
    'notes.txt': '哈喽哈喽',
    'fixture.pdf': '%PDF-1.5\n原件内容',
    // 500 行 × 约 40 字节 ≈ 20 KB,稳稳超过 8 KB 的内联线,于是走「前几行 + 编号」那条路
    'big.log': Array.from({ length: 500 }, (_, i) => `第 ${i + 1} 行 ${'填充内容'.repeat(5)}`).join('\n'),
  });
  mod = new QQ2World(
    {
      wsUrl: `ws://127.0.0.1:${port}`,
      groups: [GROUP],
      privates: [PEER],
      token: '',
      dataDir,
      files: filesConfig,
      asr: asrConfig,
    },
  );
  await mod.start(host.host);
  await mod.waitReady();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
  await new Promise<void>((resolve) => fileServer.server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('文件消息真的走到推送点(真回路)', () => {
  it('群文件段(段里带地址):正文里就是文件内容,不是 [file]', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'file', data: { file: 'notes.txt', file_id: 'fid-1', file_size: '12', url: fileServer.url('notes.txt') } }],
    });
    await waitUntil(() => host.texts().length === 1);
    const text = host.last();
    expect(text).not.toContain('[file]');
    expect(text).toContain('notes.txt');
    expect(text).toContain('哈喽哈喽');
  });

  it('重复二进制文件只推文字，按两个编号导出都得到可复用的 Core 句柄', async () => {
    const send = (file: string, fileId: string) => mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'file', data: { file, file_id: fileId, url: fileServer.url('fixture.pdf') } }],
    });
    send('需求草案.pdf', 'first');
    await waitUntil(() => host.texts().length === 1);
    send('需求终版.pdf', 'second');
    await waitUntil(() => host.texts().length === 2);
    expect(host.last()).toContain('重复文件 需求终版.pdf');
    expect(host.last()).toContain('FILE-2 · 同 FILE-1');
    expect(host.pushed.map(({ event }) => event.blobs)).toEqual([undefined, undefined]);

    const tool = mod.tools().find((t) => t.name === 'qq2_get_attachment')!;
    const coreMedia = new LogBlobStore(dataDir);
    expect(coreMedia.stat().count).toBe(0);
    const handles: string[] = [];
    for (const [id, name] of [['FILE-1', '需求草案.pdf'], ['FILE-2', '需求终版.pdf']]) {
      const out = await tool.handler({ attachment_id: id }, {} as never);
      expect(out).toMatchObject({ text: expect.stringContaining(name), blobs: [{ name, mime: 'application/pdf' }] });
      if (typeof out === 'string') throw new Error(out);
      const blob = out.blobs?.[0];
      if (!blob || !('bytes' in blob)) throw new Error(`缺少 ${id} 的原件`);
      handles.push(coreMedia.put(blob.bytes, blob.mime));
    }
    expect(handles[0]).toMatch(/^log:.*\.pdf$/);
    expect(handles[1]).toBe(handles[0]);
    expect(coreMedia.stat().count).toBe(1);
    expect(coreMedia.read(handles[1]!)?.bytes).toEqual(Buffer.from('%PDF-1.5\n原件内容'));
    expect(await tool.handler({ attachment_id: 'FILE-99' }, {} as never)).toMatchObject({ failed: true });
    expect(await tool.handler({ attachment_id: '1' }, {} as never)).toMatchObject({ failed: true });
  });

  it('私聊文件段(段里没地址,要问协议端):同样拿到内容 —— 这正是实测里最要紧的一条', async () => {
    mock.setMockFileUrl('fid-2', fileServer.url('notes.txt'));
    mock.emitRaw({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      user_id: PEER,
      message_id: 7001,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: PEER, nickname: '他' },
      message: [{ type: 'file', data: { file: 'notes.txt', file_id: 'fid-2', file_size: '12' } }],
      raw_message: '',
    });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('哈喽哈喽');
  });

  it('协议端不认取址动作时:正文如实说「没能拿到下载地址」,不编内容', async () => {
    mock.emitRaw({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      user_id: PEER,
      message_id: 7002,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: PEER, nickname: '他' },
      message: [{ type: 'file', data: { file: 'x.txt', file_id: 'nope', file_size: '3' } }],
      raw_message: '',
    });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('没能从协议端拿到下载地址');
  });

  it('大文件:正文只给头几行 + 编号;qq2_read_file 按段读得回来', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'file', data: { file: 'big.log', file_id: 'fid-3', file_size: '3000', url: fileServer.url('big.log') } }],
    });
    await waitUntil(() => host.texts().length === 1);
    const text = host.last();
    expect(text).toContain('第 1 行');
    expect(text).not.toContain('第 500 行');
    expect(text).toContain('qq2_read_file FILE-1');

    const tool = mod.tools().find((t) => t.name === 'qq2_read_file');
    expect(tool).toBeTruthy();
    const out = (await tool!.handler({ file_id: 'FILE-1', offset: 499, limit: 5 }, {} as never)) as { text?: string } | string;
    const body = typeof out === 'string' ? out : (out.text ?? '');
    expect(body).toContain('第 499 行');
    expect(body).toContain('第 500 行');
  });

  it('关掉文件开关:file 段退回框架的占位(不动既有行为)', async () => {
    filesConfig.enabled = false;
    mock.emitGroupMessage({ user_id: 111, segments: [{ type: 'file', data: { file: 'a.txt', file_id: 'f', url: fileServer.url('notes.txt') } }] });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('[file]');
  });
});

describe('QQ 原生语音转写', () => {
  const segments = [{ type: 'record', data: { file: 'v.amr' } }];

  it('群聊按消息号转写无下载地址的语音，快回执写入正文', async () => {
    mock.transcribeVoice = () => ' 明天下午三点开会 ';
    const messageId = mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('[语音转写 · 可能有错] 明天下午三点开会');
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
    expect(host.texts('qq.transcript')).toEqual([]);
  });

  it('多段语音各自保留占位，只补发一份消息级转写', async () => {
    mock.transcribeVoice = () => '归属未知的转写';
    const messageId = mock.emitGroupMessage({
      user_id: 111,
      segments: [
        { type: 'record', data: { file: 'first.amr' } },
        { type: 'text', data: { text: '下一段' } },
        { type: 'record', data: { file: 'second.amr' } },
      ],
    });
    await waitUntil(() => host.texts('qq.transcript').length === 1);
    expect(host.last()).toContain('[语音] 下一段 [语音]');
    expect(host.last()).not.toContain('归属未知的转写');
    expect(host.last('qq.transcript')).toBe(
      '[本条消息含多段语音，转写对应的语音段未知] [语音转写 · 可能有错] 归属未知的转写',
    );
    expect(host.pushed.filter(({ event }) => ['qq.message', 'qq.transcript'].includes(event.type))
      .map(({ event }) => [event.type, event.meta?.message_id]))
      .toEqual([['qq.message', messageId], ['qq.transcript', messageId]]);
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
  });

  it('私聊慢回执稍后投递，并复用已经发出的请求', async () => {
    filesConfig.waitMs = 20;
    mock.transcribeVoice = async () => {
      await waitUntil(() => host.texts().length === 1);
      return '私聊语音';
    };
    const messageId = 218;
    mock.emitRaw({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      user_id: PEER,
      message_id: messageId,
      message: segments,
    });
    await waitUntil(() => host.texts('qq.transcript').length === 1);
    expect(host.last()).toContain('[语音 · 正在转写…]');
    expect(host.last('qq.transcript')).toBe('[语音转写 · 可能有错] 私聊语音');
    expect(host.pushed.find((entry) => entry.event.type === 'qq.transcript')?.event.meta).toMatchObject({
      message_id: messageId,
      conv: { kind: 'private', id: PEER },
    });
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
  });

  it.each([
    ['NapCat 暂未取到结果', { retcode: 1200, message: '获取语音转文字结果失败' }],
    ['SnowLuma 未收到结果推送', { retcode: 100, wording: '语音转文字超时（未收到结果推送）' }],
    ['协议端返回空文本', ' '],
  ] as const)('%s时重取同一条消息的转写', async (_scenario, firstResult) => {
    mock.transcribeVoice = () => {
      if (mock.transcriptionRequests.length === 1) return firstResult;
      return '稍后写回的文字';
    };
    const messageId = mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('[语音转写 · 可能有错] 稍后写回的文字');
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }, { message_id: messageId }]);
  });

  it('协议端不支持时保留消息并说明原因', async () => {
    const messageId = mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('[语音 · 当前 OneBot 实现不支持 QQ 原生转写]');
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
  });

  it.each(['消息不存在或已被撤回', 'ptt translate failed: error=9'])(
    'SnowLuma 返回 %s 时显示 wording，直接结束转写',
    async (wording) => {
      mock.transcribeVoice = () => ({ retcode: 100, wording });
      const messageId = mock.emitGroupMessage({ user_id: 111, segments });
      await waitUntil(() => host.texts().length === 1);
      expect(host.last()).toContain(`[语音 · QQ 转写失败（fetch_ptt_text: retcode=100 ${wording}）]`);
      expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
    },
  );

  it('NapCat 返回消息不存在时保留 message，直接结束转写', async () => {
    mock.transcribeVoice = () => ({ retcode: 1200, message: '消息不存在' });
    const messageId = mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('fetch_ptt_text: retcode=1200 消息不存在');
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
  });

  it('收到空文本且重取时间不足时说明没转出文字', async () => {
    asrConfig.timeoutMs = 1000;
    mock.transcribeVoice = () => '  ';
    const messageId = mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('[语音 · QQ 转写失败（没转出文字）]');
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
  });

  it('调用超时后补发失败原因，后续消息照常投递', async () => {
    filesConfig.waitMs = 0;
    asrConfig.timeoutMs = 1000;
    mock.transcribeVoice = async () => {
      await waitUntil(() => host.texts('qq.transcript').length === 1);
      return '已超时的回执';
    };
    const messageId = mock.emitGroupMessage({ user_id: 111, segments });
    mock.emitGroupMessage({ user_id: 111, text: '第二条消息' });
    await waitUntil(() => host.texts().length === 2);
    expect(host.texts()[0]).toContain('[语音 · 正在转写…]');
    expect(host.texts()[1]).toContain('第二条消息');
    await waitUntil(() => host.texts('qq.transcript').length === 1);
    expect(host.last('qq.transcript')).toContain('调用超时');
    expect(mock.transcriptionRequests).toEqual([{ message_id: messageId }]);
  });

  it('转写关闭时保留普通语音占位', async () => {
    asrConfig.enabled = false;
    mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.texts().length === 1);
    expect(host.last()).toContain('[语音]');
    expect(mock.transcriptionRequests).toEqual([]);
  });
});
