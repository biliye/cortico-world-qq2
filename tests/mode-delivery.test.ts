/**
 * 完整回路测试:MockNapCat(真 WS 服务端)⇄ QQ2World ⇄ 记录型 host。
 *
 * 为什么要有这一层:单测只验了策略函数与包装器,验不到「一条群消息真的走到推送点、
 * 经过包装、变成哪种投递」。上一轮的教训就在这——只数个数看不出错位,要验一条路,
 * 就用那条路自己灌一次已知输入(见设计记录「按住说话」那一节的根因)。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { nullLogger } from 'cortico/core/util.ts';
import type { EventEnvelope, Logger, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { MockNapCat } from './helpers/mock-napcat.ts';
import { animatedGif, GIF_COLORS, GIF_HEIGHT, GIF_WIDTH } from './helpers/gif.ts';
import { QQ2World } from '../src/world.ts';
import type { QQMode } from '../src/modes.ts';

const GROUP = 424242;
const PEER = 200002;
const SELF = 5000;

interface Recorded {
  event: EventEnvelope;
  opts: PushOptions | undefined;
}

/** 记录每一次推送,并给出 World 启动时要用到的那几件(store / log / modelFacts)。 */
class RecordingHost {
  readonly pushed: Recorded[] = [];

  readonly host: WorldHost;

  constructor() {
    const log: Logger = nullLogger();
    const self = this;
    this.host = {
      pushEvent: async (
        event: Parameters<WorldHost['pushEvent']>[0],
        opts?: PushOptions,
      ): Promise<EventEnvelope> => {
        const stored = {
          cursor: self.pushed.length + 1,
          origin: 'external',
          contextDelivery: 'immediate',
          ...event,
        } as unknown as EventEnvelope;
        self.pushed.push({ event: stored, opts });
        return stored;
      },
      store: {
        range: () => [],
        grep: () => [],
      },
      drainPendingEvents: async () => [],
      modelFacts: { model: () => 'test', accepts: () => false, contextWindow: () => undefined },
      blob: () => null,
      reportUsage: () => {},
      log,
    } as unknown as WorldHost;
  }

  /** 最近一次 qq.message 推送的投递选项。 */
  lastMessageOpts(): PushOptions | undefined {
    for (let i = this.pushed.length - 1; i >= 0; i -= 1) {
      const p = this.pushed[i]!;
      if (p.event.type === 'qq.message') return p.opts;
    }
    return undefined;
  }

  messageCount(): number {
    return this.pushed.filter((p) => p.event.type === 'qq.message').length;
  }
}

let mock: MockNapCat;
let mod: QQ2World;
let host: RecordingHost;
/** 取图要用到的落盘目录(每个用例一个) */
let dataDir: string;
/** 假图床:给图片段一个真能下到的地址 */
let imageServer: { url: (name: string) => string; close: () => Promise<void> };

/** 起一个只发一张图的 HTTP 服务;其它路径 404。 */
async function serveImage(png: Uint8Array): Promise<typeof imageServer> {
  const { createServer } = await import('node:http');
  const gif = animatedGif();
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/gif')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(gif);
      return;
    }
    if (req.url?.startsWith('/a.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.byteLength) });
      res.end(Buffer.from(png));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: (name: string) => `http://127.0.0.1:${port}/${name}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 一张真 PNG(ffmpeg 造;没有 ffmpeg 就用一块假字节,sha256 那几条照样能验) */
function pngBytes(): Uint8Array {
  try {
    return new Uint8Array(
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=200x150', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { stdio: ['pipe', 'pipe', 'ignore'] }),
    );
  } catch {
    return new Uint8Array(2048).fill(7);
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时');
}

async function boot(
  mode?: QQMode,
  attachImages?: (groupId: number) => boolean,
  waitMs = 4000,
  digestMinutes?: number,
): Promise<void> {
  mock = new MockNapCat({
    port: 0,
    groupId: GROUP,
    selfId: SELF,
    selfNickname: 'bot',
    selfCard: 'botcard',
    groupName: '深夜食堂',
  });
  const port = await mock.start();
  host = new RecordingHost();
  dataDir = mkdtempSync(join(tmpdir(), 'qq2-live-'));
  mod = new QQ2World({
    wsUrl: `ws://127.0.0.1:${port}`,
    groups: [GROUP],
    privates: [PEER],
    token: '',
    dataDir,
    images: { enabled: true, maxImageBytes: 8 * 1024 * 1024, waitMs },
    ...(attachImages ? { attachImages } : {}),
    ...(mode ? { mode } : {}),
    ...(digestMinutes !== undefined ? { digest: { minutes: digestMinutes } } : {}),
  });
  await mod.start(host.host);
  await mod.waitReady();
}

/** 重开一遍(换模式要新实例:库与模式都是构造期读的配置)。 */
async function reboot(
  mode?: QQMode,
  attachImages?: (groupId: number) => boolean,
  waitMs = 4000,
  digestMinutes?: number,
): Promise<void> {
  await mod.stop();
  await mock.close();
  await boot(mode, attachImages, waitMs, digestMinutes);
}

beforeEach(async () => {
  imageServer = await serveImage(pngBytes());
  await boot();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
  await imageServer.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('群消息按模式投递(真回路)', () => {
  it('攒批:群消息走 debounce(不动内置的合批行为)', async () => {
    mock.emitGroupMessage({ user_id: 111, text: '在吗' });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ trigger: 'debounce' });
  });

  it('攒批下被@ 仍然立即投递(这条是内置今天的行为,保留)', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [
        { type: 'at', data: { qq: String(SELF) } },
        { type: 'text', data: { text: '看看这个' } },
      ],
    });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ trigger: 'flush' });
  });

  it('专注:同一条群消息变成 flush', async () => {
    await reboot('focus');
    mock.emitGroupMessage({ user_id: 111, text: '在吗' });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ trigger: 'flush' });
  });

  it('睡眠:群消息仍然交给 core 落库,但只落库不投递', async () => {
    await reboot('sleep');
    mock.emitGroupMessage({ user_id: 111, text: '在吗' });
    await waitUntil(() => host.messageCount() === 1);
    // 「不投递」= 交给 core 时写 deliver:false;事件本身照样进库,所以她以后查得到。
    expect(host.lastMessageOpts()).toEqual({ deliver: false });
    expect(host.pushed[host.pushed.length - 1]?.event.text).toContain('在吗');
  });

  it('睡眠只作用于群:私聊照旧合批', async () => {
    await reboot('sleep');
    mock.emitPrivateMessage({ user_id: PEER, text: '在忙吗' });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ trigger: 'debounce' });
  });

  it('睡眠也管住群里的其他事件(戳一戳同样是只落库)', async () => {
    await reboot('sleep');
    mock.emitPoke({ user_id: 111, target_id: SELF });
    await waitUntil(() => host.pushed.some((p) => p.event.type === 'qq.poke'));
    const poke = host.pushed.find((p) => p.event.type === 'qq.poke');
    expect(poke?.opts).toEqual({ deliver: false });
  });

  it('她在运行中切模式,下一条消息当场按新模式走', async () => {
    mock.emitGroupMessage({ user_id: 111, text: '第一条' });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ trigger: 'debounce' });

    const tool = mod.tools().find((t) => t.name === 'qq2_mode')!;
    await tool.handler({ mode: 'sleep' }, {} as Parameters<typeof tool.handler>[1]);

    mock.emitGroupMessage({ user_id: 111, text: '第二条' });
    await waitUntil(() => host.messageCount() === 2);
    expect(host.lastMessageOpts()).toEqual({ deliver: false });
  });

  it('压缩:群消息只落库,窗口到点才折成一份摘要给她', async () => {
    await reboot('digest', undefined, 4000, 0.02); // 1.2 秒一窗(第一条消息本身要几百毫秒,别用更短的)
    mock.emitGroupMessage({ user_id: 111, text: '在吗' });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ deliver: false });
    expect(digests()).toHaveLength(0);

    await waitUntil(() => digests().length === 1);
    const digest = digests()[0]!;
    expect(digest.opts).toEqual({ trigger: 'flush' });
    expect(digest.event.text).toContain('在吗');
    expect(digest.event.text).toContain('深夜食堂');
  });

  it('压缩:被@ 仍然立刻叫醒,而且不进摘要(不重复说两遍)', async () => {
    await reboot('digest', undefined, 4000, 0.004);
    mock.emitGroupMessage({
      user_id: 111,
      segments: [
        { type: 'at', data: { qq: String(SELF) } },
        { type: 'text', data: { text: '看看这个' } },
      ],
    });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ trigger: 'flush' });

    // 那条没有被攒下,所以这一窗没有摘要可结。
    await new Promise((r) => setTimeout(r, 500));
    expect(digests()).toHaveLength(0);
  });

  it('压缩只管群:私聊照旧合批', async () => {
    await reboot('digest', undefined, 4000, 0.004);
    mock.emitPrivateMessage({ user_id: PEER, text: '在忙吗' });
    await waitUntil(() => host.messageCount() === 1);
    expect(host.lastMessageOpts()).toEqual({ trigger: 'debounce' });
    await new Promise((r) => setTimeout(r, 500));
    expect(digests()).toHaveLength(0);
  });

  it('压缩:结过一次账以后,下一条消息开新窗,摘要不重复上一窗', async () => {
    await reboot('digest', undefined, 4000, 0.02);
    mock.emitGroupMessage({ user_id: 111, text: '第一条' });
    await waitUntil(() => digests().length === 1);
    expect(digests()[0]!.event.text).toContain('第一条');

    mock.emitGroupMessage({ user_id: 111, text: '第二条' });
    await waitUntil(() => digests().length === 2);
    expect(digests()[1]!.event.text).toContain('第二条');
    expect(digests()[1]!.event.text).not.toContain('第一条');
  });

  it('压缩里切到攒批:已经攒下的那一窗当场结账', async () => {
    await reboot('digest', undefined, 4000, 0.1); // 6 秒,测试里不会自己到点
    mock.emitGroupMessage({ user_id: 111, text: '攒着的一句' });
    await waitUntil(() => host.messageCount() === 1);
    expect(digests()).toHaveLength(0);

    const tool = mod.tools().find((t) => t.name === 'qq2_mode')!;
    await tool.handler({ mode: 'batch' }, {} as Parameters<typeof tool.handler>[1]);
    await waitUntil(() => digests().length === 1);
    expect(digests()[0]!.event.text).toContain('攒着的一句');
    expect(digests()[0]!.opts).toEqual({ trigger: 'debounce' });
  });

  it('压缩里切到睡眠:攒下的那一窗直接丢掉,不叫醒她', async () => {
    await reboot('digest', undefined, 4000, 0.1);
    mock.emitGroupMessage({ user_id: 111, text: '睡着以前的一句' });
    await waitUntil(() => host.messageCount() === 1);

    const tool = mod.tools().find((t) => t.name === 'qq2_mode')!;
    await tool.handler({ mode: 'sleep' }, {} as Parameters<typeof tool.handler>[1]);
    await new Promise((r) => setTimeout(r, 300));
    expect(digests()).toHaveLength(0);
  });
});

/** 所有 qq.digest 推送(压缩挡的结账)。 */
function digests(): Recorded[] {
  return host.pushed.filter((p) => p.event.type === 'qq.digest');
}

describe('连接与提示词(真回路)', () => {
  it('连上以后环境提示词里有群名、QQ 号与当前模式', async () => {
    const vars = mod.envPromptVars();
    expect(vars['qq.conversations']).toContain('深夜食堂');
    expect(vars['qq.conversations']).toContain(String(GROUP));
    expect(vars['qq.identity']).toContain(String(SELF));
    expect(vars['qq.mode']).toBe('攒批(batch)');
  });

  it('切模式后提示词里的模式跟着变', () => {
    mod.setMode('sleep');
    expect(mod.envPromptVars()['qq.mode']).toBe('睡眠(sleep)');
  });
});

/** 最近一条 qq.message 事件(取图那两条 describe 共用)。 */
const lastMessage = (): Record<string, unknown> => {
  const hit = [...host.pushed].reverse().find((p) => p.event.type === 'qq.message');
  if (!hit) throw new Error('还没有 qq.message');
  return hit.event as unknown as Record<string, unknown>;
};

const blobsOf = (event: Record<string, unknown>): Array<{ bytes?: Uint8Array; name?: string; mime?: string }> =>
  (event.blobs as Array<{ bytes?: Uint8Array; name?: string; mime?: string }> | undefined) ?? [];

/** 直接调本实例上的一个工具(测试不走模型)。 */
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = mod.tools().find((t) => t.name === name);
  if (!tool) throw new Error(`没有工具 ${name}`);
  return tool.handler(args, {} as Parameters<typeof tool.handler>[1]);
}

describe('取图(真回路:真 HTTP 图床)', () => {
  it.each([4000, 0])('GIF 预览投递、保存原件与重复跳过（等待 %d ms）', async (waitMs) => {
    if (!waitMs) await reboot(undefined, undefined, waitMs);
    const events = () => host.pushed.filter((p) => p.event.type === (waitMs ? 'qq.message' : 'qq.image'));
    const emit = (token: number) => mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'image', data: { url: imageServer.url(`gif?token=${token}`) } }],
    });
    emit(1);
    await waitUntil(() => events().length === 1);
    const ev = events()[0]!.event as unknown as Record<string, unknown>;
    const [blob] = blobsOf(ev);
    expect(blob?.mime).toBe('image/png');
    expect(String(ev.text)).toContain('GIF 九宫图');
    const png = PNG.sync.read(Buffer.from(blob!.bytes!));
    const gap = 3;
    expect([png.width, png.height]).toEqual([GIF_WIDTH * 3 + gap * 2, GIF_HEIGHT * 3 + gap * 2]);
    for (let slot = 0; slot < 9; slot++) {
      const offset = 4 * (Math.floor(slot / 3) * (GIF_HEIGHT + gap) * png.width + (slot % 3) * (GIF_WIDTH + gap));
      expect(png.data.readUIntBE(offset, 3)).toBe(GIF_COLORS[Math.round(slot * 10 / 8)]);
    }

    emit(2);
    await waitUntil(() => events().length === 2);
    const dup = events()[1]!.event as unknown as Record<string, unknown>;
    expect(String(dup.text)).toContain('与 IMG-1 是同一份文件');
    expect(blobsOf(dup)).toHaveLength(0);
    const store = join(dataDir, 'qq-images');
    const files = readdirSync(store);
    const originals = files.filter(file => file.endsWith('.gif'));
    expect(originals).toHaveLength(1);
    expect(readFileSync(join(store, originals[0]!))).toEqual(animatedGif());
    const previews = files.filter(file => file.endsWith('.gif-preview.png'));
    expect(previews).toHaveLength(1);
    expect(readFileSync(join(store, previews[0]!))).toEqual(Buffer.from(blob!.bytes!));
    const retrieved = await callTool('qq2_get_image', { image_id: 'IMG-2' }) as Record<string, unknown>;
    expect(blobsOf(retrieved)[0]?.mime).toBe('image/png');
    expect(Buffer.from(blobsOf(retrieved)[0]!.bytes!)).toEqual(Buffer.from(blob!.bytes!));
    const original = await callTool('qq2_get_image', { image_id: 'IMG-2', original: true }) as Record<string, unknown>;
    expect(blobsOf(original)[0]?.mime).toBe('image/gif');
    expect(Buffer.from(blobsOf(original)[0]!.bytes!)).toEqual(animatedGif());
  });

  it('群里的一张图:取回、落盘、挂成附件,正文里有 IMG-N 与大小', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [
        { type: 'text', data: { text: '看这个' } },
        { type: 'image', data: { url: imageServer.url('a.png') } },
      ],
    });
    await waitUntil(() => host.messageCount() === 1);
    const ev = lastMessage();
    const blobs = blobsOf(ev);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.name).toBe('IMG-1');
    expect(blobs[0]?.bytes?.byteLength).toBeGreaterThan(0);
    expect(String(ev.text)).toContain('[图片 IMG-1');
    expect(String(ev.text)).toContain('看这个');
  });

  it('同一张图再发一次:只给文字,不带字节;要看用 qq2_get_image', async () => {
    const segments = [
      { type: 'image', data: { url: imageServer.url('a.png') } },
    ];
    mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.messageCount() === 1);
    mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.messageCount() === 2);
    const ev = lastMessage();
    expect(String(ev.text)).toContain('IMG-2');
    expect(String(ev.text)).toContain('与 IMG-1 是同一份文件');
    expect(String(ev.text)).toContain('还没贴标签');
    expect(String(ev.text)).toContain('qq2_get_image');
    expect(blobsOf(ev)).toHaveLength(0);
  });

  it('贴过标签的重复图:正文带标签与类别,仍不带字节', async () => {
    const segments = [{ type: 'image', data: { url: imageServer.url('a.png') } }];
    mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.messageCount() === 1);

    const tagged = String(await callTool('qq2_image_tag', {
      image_id: 'IMG-1',
      label: '无语猫',
      kind: 'sticker',
      saved: 'mem:external/qq/images/表情-无语猫.png',
    }));
    expect(tagged).toContain('[tagged]');
    expect(tagged).toContain('无语猫');

    mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => host.messageCount() === 2);
    const ev = lastMessage();
    expect(String(ev.text)).toContain('标签:无语猫');
    expect(String(ev.text)).toContain('类别:表情包');
    expect(blobsOf(ev)).toHaveLength(0);

    const listed = String(await callTool('qq2_images', { query: '无语' }));
    expect(listed).toContain('无语猫');
    const md = String(await callTool('qq2_images', { format: 'md' }));
    expect(md).toContain('# 表情包');
    expect(md).toContain('| 表情包 | IMG-1 | mem:external/qq/images/表情-无语猫.png');
  });

  it('没赶上时限的重复图:补投的 qq.image 也不带字节', async () => {
    await reboot(undefined, undefined, 0);
    const segments = [{ type: 'image', data: { url: imageServer.url('a.png') } }];
    const imageEvents = () => host.pushed.filter((p) => p.event.type === 'qq.image');
    mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => imageEvents().length >= 1);
    mock.emitGroupMessage({ user_id: 111, segments });
    await waitUntil(() => imageEvents().length >= 2);

    const duplicate = imageEvents()[1]!.event as unknown as Record<string, unknown>;
    expect(String(duplicate.text)).toContain('与 IMG-1 是同一份文件');
    expect(blobsOf(duplicate)).toHaveLength(0);
  });

  it('群图开关关掉:新图不挂字节、正文告诉她去取;图仍然取得回来', async () => {
    await reboot(undefined, () => false);
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'image', data: { url: imageServer.url('a.png') } }],
    });
    await waitUntil(() => host.messageCount() === 1);
    const ev = lastMessage();
    expect(blobsOf(ev)).toHaveLength(0);
    expect(String(ev.text)).toContain('本群自动看图已关');
    expect(String(ev.text)).toContain('qq2_get_image');

    const got = (await callTool('qq2_get_image', { image_id: 'IMG-1' })) as { blobs?: unknown[] };
    expect(got.blobs).toHaveLength(1);
  });

  it('草稿的 image 可以直接填 IMG-N,确认后按那份字节发出去', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'image', data: { url: imageServer.url('a.png') } }],
    });
    await waitUntil(() => host.messageCount() === 1);

    const staged = String(await callTool('qq2_draft', {
      to: `group:${GROUP}`,
      text: '看这个',
      image: 'IMG-1',
    }));
    expect(staged).toContain('will send image: IMG-1');

    const receipt = String(await callTool('qq2_confirm', { decision: 'send' }));
    expect(receipt).toContain('[桥确认');
    const sent = mock.outbox.at(-1);
    expect(sent?.action).toBe('send_group_msg');
    const segs = sent?.params.message as Array<{ type: string; data?: { file?: string } }> | undefined;
    expect(segs?.some((s) => s.type === 'image' && String(s.data?.file).startsWith('base64://'))).toBe(true);

    // 回录里按字节挂上自己发的那张图,正文标的是 IMG-N
    const self = [...host.pushed].reverse().find((p) => p.event.type === 'qq.self');
    expect(String(self?.event.text)).toContain('[图片: IMG-1]');
    expect(blobsOf(self!.event as unknown as Record<string, unknown>)).toHaveLength(1);
  });

  it('图取不到:正文写明原因,而且不带附件(不是崩掉,也不是无声无息)', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'image', data: { url: imageServer.url('missing.png') } }],
    });
    await waitUntil(() => host.messageCount() === 1);
    const ev = lastMessage();
    expect(String(ev.text)).toContain('取回失败');
    expect(blobsOf(ev)).toHaveLength(0);
  });
});

/** 同一个 dataDir 上的第二个实例:等于重启——登记表从盘上重读,内存缓存是空的。 */
function revivedWorld(): QQ2World {
  return new QQ2World({
    wsUrl: 'ws://127.0.0.1:1',
    groups: [GROUP],
    privates: [PEER],
    token: '',
    dataDir,
    images: { enabled: true, maxImageBytes: 8 * 1024 * 1024, waitMs: 4000 },
  });
}

describe('按编号取回旧图(真回路:真的从盘上读那份字节)', () => {
  const getImage = (world: QQ2World) => {
    const tool = world.tools().find((t) => t.name === 'qq2_get_image');
    expect(tool, '开了取图库就该有这个工具').toBeTruthy();
    return tool!;
  };
  const call = (world: QQ2World, imageId: unknown) =>
    getImage(world).handler({ image_id: imageId }, {} as Parameters<ReturnType<typeof getImage>['handler']>[1]);

  it('旧 GIF 只有原件，重启后离线补建九宫图', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'image', data: { url: imageServer.url('gif') } }],
    });
    await waitUntil(() => host.messageCount() === 1);
    const store = join(dataDir, 'qq-images');
    const preview = readdirSync(store).find(file => file.endsWith('.gif-preview.png'));
    expect(preview).toBeTruthy();
    rmSync(join(store, preview!));
    await imageServer.close();

    const outcome = await call(revivedWorld(), 'IMG-1');
    const rebuilt = readFileSync(join(store, preview!));
    expect(outcome).toMatchObject({
      text: expect.stringContaining('original=true'),
      blobs: [{ mime: 'image/png', bytes: rebuilt }],
    });
    expect(rebuilt).toEqual(Buffer.from(blobsOf(lastMessage())[0]!.bytes!));
  });

  it('换一个实例(重启)之后,仍能按编号把前几天那些图取回来', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'image', data: { url: imageServer.url('a.png') } }],
    });
    await waitUntil(() => host.messageCount() === 1);
    const firstBytes = blobsOf(lastMessage())[0]?.bytes?.byteLength ?? 0;
    expect(firstBytes).toBeGreaterThan(0);

    // 新实例没 start,所以它手上既没有 WS 也没有内存里的字节——只能靠登记表 + 盘上那份文件。
    const out = await call(revivedWorld(), 'IMG-1');
    expect(typeof out).toBe('object');
    const outcome = out as { text: string; blobs?: Array<{ bytes?: Uint8Array; name?: string }> };
    expect(outcome.blobs).toHaveLength(1);
    expect(outcome.blobs?.[0]?.name).toBe('IMG-1');
    // 同一份字节,不是又下一遍、也不是空壳子
    expect(outcome.blobs?.[0]?.bytes?.byteLength).toBe(firstBytes);
    expect(outcome.text).toContain('IMG-1');
    expect(outcome.text).toContain('save_blob');
  });

  it('「img1」「1」这种写法也认得(归一化成 IMG-1)', async () => {
    mock.emitGroupMessage({
      user_id: 111,
      segments: [{ type: 'image', data: { url: imageServer.url('a.png') } }],
    });
    await waitUntil(() => host.messageCount() === 1);
    for (const spelling of ['img1', '1']) {
      const out = (await call(mod, spelling)) as { blobs?: unknown[] };
      expect(out.blobs, spelling).toHaveLength(1);
    }
  });

  it('编号不认识、写坏:各回一句能读懂的话,不是静默也不是崩', async () => {
    const missing = String(await call(mod, 'IMG-404'));
    expect(missing).toContain('[not found]');
    // 认不出的编号给她一条找编号的路,而不是干瞪眼
    expect(missing).toContain('qq2_grep_history');
    expect(String(await call(mod, '那张农夫猫'))).toContain('[bad input]');
    expect(String(await call(mod, ''))).toContain('[bad input]');
  });
});
