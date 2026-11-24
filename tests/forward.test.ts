/**
 * 合并转发(转发聊天记录)展开:真回路测试 —— MockNapCat ⇄ QQ2World ⇄ 记录型 host。
 *
 * 这一层必须用真回路:出问题的地方不是「怎么渲染一段文字」,而是「他转出来的东西到底
 * 长什么样」。2026-10-15 他实测的那次(她只收到两行空壳 `[转发消息]`)就是形状问题:
 * QQ 里把一份合并转发**再转发一次**,NapCat 回的外层记录里每个节点的内容本身就是一段
 * `forward`,内层内容内联在 `forward.data.content` 里 —— 只看节点自己的段就永远是空壳。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import type { EventEnvelope, Logger, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { MockNapCat } from './helpers/mock-napcat.ts';
import { QQ2World } from '../src/world.ts';
import { IMAGES_DEFAULTS } from '../src/config.ts';

const GROUP = 424242;
const PEER = 200002;
const SELF = 5000;

interface Recorded {
  event: EventEnvelope;
  opts: PushOptions | undefined;
}

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
      store: { range: () => [], grep: () => [] },
      drainPendingEvents: async () => [],
      modelFacts: { model: () => 'test', accepts: () => false, contextWindow: () => undefined },
      blob: () => null,
      reportUsage: () => {},
      log,
    } as unknown as WorldHost;
  }

  /** 最近一次的某类事件正文(没有就是 undefined)。 */
  textOf(type: string): string | undefined {
    for (let i = this.pushed.length - 1; i >= 0; i -= 1) {
      const p = this.pushed[i]!;
      if (p.event.type === type) return String(p.event.text ?? '');
    }
    return undefined;
  }
}

let mock: MockNapCat;
let mod: QQ2World;
let host: RecordingHost;
let dataDir: string;
let imageServer: { url: (name: string) => string; close: () => Promise<void> };

/** 一张 2×2 的真 PNG。 */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAF0lEQVR4nGP8z8DAwMDAxMDAwMAAAAwBAAGjC0kAAAAASUVORK5CYII=',
    'base64',
  ),
);

/** 起一个只会回同一张图的 HTTP 服务;其它路径 404。 */
async function serveImage(bytes: Uint8Array): Promise<typeof imageServer> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/a.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) });
      res.end(Buffer.from(bytes));
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

/** 取图库登记表里的那一行(没有就 undefined)。 */
function registryLine(id: string): Record<string, unknown> | undefined {
  const p = join(dataDir, 'qq-images', 'registry.jsonl');
  if (!existsSync(p)) return undefined;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec.id === id) return rec;
    } catch {
      // 半行(并发写)跳过即可
    }
  }
  return undefined;
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时');
}

/** 私聊里发一段带 forward 段的消息(照 NapCat 真实事件的形状)。 */
function emitForwardToPrivate(resId: string): void {
  mock.emitRaw({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: PEER,
    message_id: 900001,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: PEER, nickname: '筆離嘢', card: '' },
    message: [{ type: 'forward', data: { id: resId } }],
    raw_message: `[CQ:forward,id=${resId}]`,
  });
}

/** NapCat 4.18 里一条「群消息」节点的样子(字段直接铺在节点上)。 */
function node(args: {
  uid: number;
  nickname?: string;
  body: unknown[];
  time?: number;
  messageType?: string;
}): Record<string, unknown> {
  return {
    self_id: SELF,
    user_id: args.uid,
    time: args.time ?? 3000,
    message_id: 691576977,
    message_type: args.messageType ?? 'group',
    sender: { user_id: args.uid, nickname: args.nickname ?? 'QQ用户', card: '' },
    message: args.body,
    message_format: 'array',
    post_type: 'message',
    group_id: GROUP,
  };
}

const text = (t: string) => ({ type: 'text', data: { text: t } });

beforeEach(async () => {
  imageServer = await serveImage(PNG);
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
  dataDir = mkdtempSync(join(tmpdir(), 'qq2-forward-'));
  mod = new QQ2World({
    wsUrl: `ws://127.0.0.1:${port}`,
    groups: [GROUP],
    privates: [PEER],
    token: '',
    dataDir,
    images: { ...IMAGES_DEFAULTS },
  });
  await mod.start(host.host);
  await mod.waitReady();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
  await imageServer.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('合并转发展开', () => {
  it('普通合集:节点就是一条条消息,按时间排,带发言人', async () => {
    mock.setMockForward('F-plain', [
      node({ uid: 111, nickname: '甲', body: [text('第一句')], time: 1000 }),
      node({ uid: 222, nickname: '乙', body: [text('第二句')], time: 2000 }),
    ]);
    emitForwardToPrivate('F-plain');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    expect(body).toContain('甲(111): 第一句');
    expect(body).toContain('乙(222): 第二句');
    expect(body.indexOf('第一句')).toBeLessThan(body.indexOf('第二句'));
  });

  it('转发里再套转发:NapCat 把内层内容内联在 forward.data.content 里,要摊出来', async () => {
    // 外层两条，每条的内容是一张转发卡片。
    mock.setMockForward('F-outer', [
      node({
        uid: 300003,
        body: [
          {
            type: 'forward',
            data: {
              id: 'F-inner-1',
              content: [
                node({ uid: 300003, body: [text('第一组第一条')], time: 1000 }),
                node({ uid: 300003, body: [text('第一组第二条')], time: 2000 }),
              ],
            },
          },
        ],
      }),
      node({
        uid: 300003,
        body: [
          {
            type: 'forward',
            data: { id: 'F-inner-2', content: [node({ uid: 300003, body: [text('第二组第一条')] })] },
          },
        ],
      }),
    ]);
    emitForwardToPrivate('F-outer');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    expect(body).toContain('第一组第一条');
    expect(body).toContain('第一组第二条');
    expect(body).toContain('第二组第一条');
    expect(body).toContain('转发里又套着的一份转发记录,2 条');
    expect(body).not.toContain('[转发消息]');
  });

  it('节点是转发卡片但内容没内联(老协议端):说清楚没展开,不假装收到', async () => {
    mock.setMockForward('F-nocontent', [
      node({ uid: 300003, body: [{ type: 'forward', data: { id: 'F-unknown' } }] }),
    ]);
    emitForwardToPrivate('F-nocontent');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    expect(body).toContain('没能自动展开');
    expect(body).toContain('F-unknown');
  });

  it('正文和转发卡片混在一个节点里:两边都留', async () => {
    mock.setMockForward('F-mixed', [
      node({
        uid: 111,
        nickname: '甲',
        body: [
          text('上面这句是正文'),
          { type: 'forward', data: { id: 'F-in', content: [node({ uid: 222, nickname: '乙', body: [text('卡片里的话')] })] } },
        ],
      }),
    ]);
    emitForwardToPrivate('F-mixed');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    expect(body).toContain('上面这句是正文');
    expect(body).toContain('卡片里的话');
  });

  it('标准 OneBot 的 { message: node[] } 形状照样认', async () => {
    mock.setMockForwardResponse('F-std', {
      message: [
        { type: 'node', data: { user_id: 333, nickname: '丙', time: 1000, content: [text('标准形状')] } },
      ],
    });
    emitForwardToPrivate('F-std');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    expect(host.textOf('qq.forward')!).toContain('丙(333): 标准形状');
  });

  it('嵌套 + 身份全塌(NapCat 把发言人填成转发者本人):说明行不该把「身份没能取到」顶掉', async () => {
    // 所有 sender 使用相同的测试号码和「QQ用户」占位。
    const inner = Array.from({ length: 3 }, (_, i) =>
      node({ uid: 300003, body: [text(`里面第${i}句`)] }),
    );
    mock.setMockForward('F-nest-collapsed', [
      node({ uid: 300003, body: [{ type: 'forward', data: { id: 'F-in', content: inner } }] }),
      node({ uid: 300003, body: [text('外面这句')] }),
    ]);
    emitForwardToPrivate('F-nest-collapsed');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    expect(body).toContain('发言人身份没能取到');
    expect(body).toContain('(下面是转发里又套着的一份转发记录,3 条)');
    expect(body).toContain('里面第0句');
    // 身份塌了就别再逐行重复那个号
    expect(body).not.toContain('300003(300003)');
  });

  it('转发里的图给编号,字节在后台取回落盘,她能按编号取回', async () => {
    mock.setMockForward('F-img', [
      node({
        uid: 111,
        nickname: '甲',
        body: [
          { type: 'image', data: { url: imageServer.url('a.png'), file: 'a.png', file_size: '2048' } },
          text('配一张图'),
        ],
      }),
    ]);
    emitForwardToPrivate('F-img');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    // 正文里是句柄,不是框架默认那个 `[图片]`(她既看不见、也取不到)
    const match = /\[图片 (IMG-\d+)\]/.exec(body);
    expect(match).toBeTruthy();
    const id = match![1]!;
    expect(body).toContain('配一张图');

    // 后台取回:登记表里出现这一行,字节落到盘上(她之后按编号要就有,不靠过期的 URL)
    await waitUntil(() => {
      const rec = registryLine(id);
      return rec !== undefined && typeof rec.size === 'number' && rec.size > 0;
    }, 15000);
    const rec = registryLine(id)!;
    expect(String(rec.mime)).toBe('image/png');
    expect(String(rec.url)).toBe(imageServer.url('a.png'));

    // 工具那条路:盘上有字节,能交回附件
    const tool = mod.tools().find((t) => t.name === 'qq2_get_image')!;
    const out = (await tool.handler(
      { image_id: id },
      {} as Parameters<typeof tool.handler>[1],
    )) as { text?: string; blobs?: unknown[] };
    expect(String(out.text ?? '')).toContain(id);
    expect(out.blobs?.length ?? 0).toBe(1);
  });

  it('一份转发里图太多时:只给前 12 张编号,多出来的说清楚', async () => {
    const imgs = Array.from({ length: 13 }, () => ({
      type: 'image',
      data: { url: imageServer.url('a.png'), file: 'a.png', file_size: '2048' },
    }));
    mock.setMockForward('F-many', [node({ uid: 111, nickname: '甲', body: imgs })]);
    emitForwardToPrivate('F-many');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    const ids = [...body.matchAll(/\[图片 (IMG-\d+)\]/g)].map((m) => m[1]);
    expect(ids).toHaveLength(12);
    expect(body).toContain('还有 1 张图没给编号');
    expect(body).toContain('一次最多 12 张');
  });

  it('太长的合集截断,并说明一共多少条', async () => {
    const many = Array.from({ length: 350 }, (_, i) =>
      node({ uid: 111, nickname: '甲', body: [text(`第${i}条`)], time: 1000 + i }),
    );
    mock.setMockForward('F-huge', many);
    emitForwardToPrivate('F-huge');
    await waitUntil(() => host.textOf('qq.forward') !== undefined);
    const body = host.textOf('qq.forward')!;
    expect(body).toContain('一共 350 条,只列了前 300 条');
    expect(body).not.toContain('第349条');
  });
});
