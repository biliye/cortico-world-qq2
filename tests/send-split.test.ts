/**
 * 发送拆句的真回路:一条草稿 → 几条 QQ 消息。
 *
 * 用 MockNapCat(真 WS 服务端)把 `qq2_draft` → `qq2_confirm` 整条路走一遍,
 * 断言的是**协议端真的收到了几条、正文分别是什么**,以及「发到一半失败」不会
 * 变成「整条重发」(那会把已经说出口的再说一遍)。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { MockNapCat } from './helpers/mock-napcat.ts';
import { QQ2World } from '../src/world.ts';
import { SPLIT_DEFAULTS } from '../src/config.ts';

const GROUP = 10001;
const SELF = 5000;

/** 他给的那段真实草稿:空行分段,段落里还有第二个句子 —— 应拆成 4 条。 */
const HIS_EXAMPLE = [
  '落了。',
  '',
  '09:00 那条节律改成了：切专注 + 当场挂一条 40 分钟后的提醒。到点我看一眼，热就续、静就切回攒批。',
  '',
  '今天这条已经补上了，10:12 响。',
].join('\n');

const EXPECTED = [
  '落了。',
  '09:00 那条节律改成了：切专注 + 当场挂一条 40 分钟后的提醒。',
  '到点我看一眼，热就续、静就切回攒批。',
  '今天这条已经补上了，10:12 响。',
];

interface Recorded {
  event: EventEnvelope;
  opts: PushOptions | undefined;
}

/** 只记 pushEvent、并给得出 blob 的假 host(发图那条路要用)。 */
class SendHost {
  readonly pushed: Recorded[] = [];
  readonly blobs = new Map<string, { bytes: Uint8Array; mime: string }>();

  readonly host: WorldHost;

  constructor() {
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
      blob: (handle: string) => self.blobs.get(handle) ?? null,
      reportUsage: () => {},
      log: nullLogger(),
    } as unknown as WorldHost;
  }

  selfEvents(): Recorded[] {
    return this.pushed.filter((p) => p.event.type === 'qq.self');
  }
}

let mock: MockNapCat;
let mod: QQ2World;
let host: SendHost;
let dataDir: string;

async function boot(split: Partial<typeof SPLIT_DEFAULTS> = {}): Promise<void> {
  mock = new MockNapCat({ port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', groupName: '深夜食堂' });
  const port = await mock.start();
  host = new SendHost();
  dataDir = mkdtempSync(join(tmpdir(), 'qq2-send-'));
  mod = new QQ2World({
    wsUrl: `ws://127.0.0.1:${port}`,
    groups: [GROUP],
    privates: [],
    token: '',
    dataDir,
    // 间隔设 0:这是测拆句,不是测节奏
    split: { ...SPLIT_DEFAULTS, intervalMs: 0, ...split },
  });
  await mod.start(host.host);
  await mod.waitReady();
}

function tool(name: string) {
  const found = mod.tools().find((t) => t.name === name);
  if (!found) throw new Error(`没有工具 ${name}`);
  return found;
}

/** 工具 handler 的第二个参数(本轮不经主循环,给个空壳)。 */
const bareCtx = {} as Parameters<ReturnType<typeof tool>['handler']>[1];

/** 一条 send_*_msg 的正文(把 text 段接起来)。 */
function textOf(entry: { params: Record<string, unknown> }): string {
  const segs = entry.params.message as Array<{ type: string; data?: { text?: string; file?: string } }>;
  return segs
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('');
}

type CallApi = (action: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

/**
 * 只换掉真 driver 的 callApi,用来造「发到一半失败」这种协议端不好演的情形。
 * 换掉整个 driver 对象不行 —— 它身上还有 identity(群名)与 stop(),stop 那半截会被 afterEach 用到。
 */
function stubDriver(impl: CallApi): void {
  (mod as unknown as { driver: { callApi: CallApi } }).driver.callApi = impl;
}

/** 真的 callApi(绑好 this),假货要放行时用它转发。 */
let realCallApi: CallApi;

beforeEach(async () => {
  await boot();
  const driver = (mod as unknown as { driver: { callApi: CallApi } }).driver;
  realCallApi = driver.callApi.bind(driver) as CallApi;
});

afterEach(async () => {
  (mod as unknown as { driver: { callApi: CallApi } }).driver.callApi = realCallApi;
  await mod.stop();
  await mock.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('一条草稿拆成几条发(真回路)', () => {
  it('他给的那段:四条,顺序与正文都对得上,回执写明拆了几条与各消息号', async () => {
    const draft = await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
    expect(String(draft)).toContain('群「深夜食堂」');

    const receipt = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));

    expect(mock.outbox).toHaveLength(4);
    expect(mock.outbox.map(textOf)).toEqual(EXPECTED);
    expect(mock.outbox.every((o) => o.action === 'send_group_msg')).toBe(true);
    expect(mock.outbox.every((o) => o.params.group_id === GROUP)).toBe(true);
    // 回执把四个消息号都报出来(她能引用其中任意一条),并说明是拆出来的
    expect(receipt).toContain('拆 4 条');
    for (const o of mock.outbox) expect(receipt).toContain(`#${o.message_id}`);
    // 草稿已生效(再确认一次不会重复发)
    expect(String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx))).toContain('no draft');
    expect(mock.outbox).toHaveLength(4);
  });

  it('回录按每条一条 qq.self(各带自己的消息号),且不投递(不会把她自己叫醒)', async () => {
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);

    const selfs = host.selfEvents();
    expect(selfs).toHaveLength(4);
    expect(selfs.map((s) => s.event.text)).toEqual(
      mock.outbox.map((o) => expect.stringContaining(`#${o.message_id}`) as unknown as string),
    );
    expect(selfs.map((s) => s.event.text)).toEqual(
      EXPECTED.map((t) => expect.stringContaining(`你: ${t}`) as unknown as string),
    );
    expect(selfs.every((s) => s.opts?.deliver === false)).toBe(true);
  });

  it('关掉拆句:整段一次发出,正文一字不改', async () => {
    await mod.stop();
    await mock.close();
    await boot({ enabled: false });

    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
    const receipt = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));

    expect(mock.outbox).toHaveLength(1);
    expect(textOf(mock.outbox[0]!)).toBe(HIS_EXAMPLE);
    expect(receipt).not.toContain('拆 ');
  });

  it('单句草稿:一条,回执不写「拆 N 条」(与今天的行为一样)', async () => {
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: '落了,补上了。' }, bareCtx);
    const receipt = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));

    expect(mock.outbox).toHaveLength(1);
    expect(textOf(mock.outbox[0]!)).toBe('落了,补上了。');
    expect(receipt).not.toContain('拆 ');
  });

  it('上限 2 条:前一条照发,剩下的并成最后一条(不刷屏)', async () => {
    await mod.stop();
    await mock.close();
    await boot({ maxChunks: 2 });

    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);

    expect(mock.outbox.map(textOf)).toEqual([
      '落了。',
      [
        '09:00 那条节律改成了：切专注 + 当场挂一条 40 分钟后的提醒。',
        '到点我看一眼，热就续、静就切回攒批。',
        '今天这条已经补上了，10:12 响。',
      ].join('\n'),
    ]);
  });

  it('首条就失败:抛出去让草稿留着,连着发两次不会丢内容', async () => {
    let broken = true;
    stubDriver(async (action, params) => {
      if (broken) throw new Error('send_group_msg: WS未连接');
      return realCallApi(action, params);
    });

    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
    const failed = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));
    expect(failed).toContain('[send failed]');
    expect(failed).toContain('draft kept');
    expect(mock.outbox).toHaveLength(0);

    // 链路恢复后重试同一份草稿:四条照样发出去(这是「首条失败不吞草稿」的意义)
    broken = false;
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);
    expect(mock.outbox).toHaveLength(4);
    expect(mock.outbox.map(textOf)).toEqual(EXPECTED);
  });
});

describe('等回执的时限', () => {
  it('发送按 30 秒等,别的调用不带时限参数(沿用 driver 默认)', async () => {
    const seen: Array<{ action: string; timeoutMs?: number }> = [];
    stubDriver(async (action, params, timeoutMs) => {
      seen.push({ action, timeoutMs });
      return realCallApi(action, params);
    });

    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: '落了,补上了。' }, bareCtx);
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);

    const sends = seen.filter((s) => s.action === 'send_group_msg');
    expect(sends.length).toBe(1);
    expect(sends[0]!.timeoutMs).toBe(30_000);
  });
});

describe('发到一半失败', () => {
  it('停了手、如实回执「哪几条出去了」,并提醒别整条重发', async () => {
    let n = 0;
    stubDriver(async () => {
      n += 1;
      if (n === 3) throw Object.assign(new Error('第三条被桥拒绝'), { retcode: 100 });
      return { message_id: 100 + n };
    });

    const receipt = await (
      mod as unknown as {
        sendToTarget: (t: { kind: 'group'; id: number }, o: { text: string }) => Promise<string>;
      }
    ).sendToTarget({ kind: 'group', id: GROUP }, { text: HIS_EXAMPLE });

    expect(n).toBe(3); // 第三条炸了就停手,不试第四条
    expect(receipt).toContain('#101');
    expect(receipt).toContain('#102');
    expect(receipt).toContain('第 3/4 条被拒绝或未提交');
    expect(receipt).toContain('别重发');
  });
});

describe('引用与图片只挂首条', () => {
  it('图片跟着第一条走,后面几条是纯文本', async () => {
    host.blobs.set('log:abc123', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE, image: 'log:abc123' }, bareCtx);
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);

    const segTypes = mock.outbox.map(
      (o) => (o.params.message as Array<{ type: string }>).map((s) => s.type).join('+'),
    );
    expect(segTypes).toEqual(['image+text', 'text', 'text', 'text']);
    // 回录里图片标记也只落在首条
    expect(host.selfEvents()[0]?.event.text).toContain('[图片: log:abc123]');
    expect(host.selfEvents()[1]?.event.text).not.toContain('[图片');
  });

  it('只发图没有正文:一条,不因为拆句变成零条', async () => {
    host.blobs.set('log:def456', { bytes: new Uint8Array([4, 5, 6]), mime: 'image/png' });
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, image: 'log:def456' }, bareCtx);
    const receipt = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));

    expect(mock.outbox).toHaveLength(1);
    expect(receipt).not.toContain('拆 ');
  });
});

describe('三态回执与防止误重发', () => {
  it('真实 WS 回执迟于 driver 超时，迟到 echo 不触发重发或伪造成功', async () => {
    mock.holdSendReplies = true;
    // 仅缩短测试等待；30 秒生产参数由另一条测试单独验证。
    stubDriver((action, params) => realCallApi(action, params, 100));
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: '只说一次。' }, bareCtx);
    const pending = tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);
    await vi.waitFor(() => expect(mock.outbox).toHaveLength(1));
    const receipt = String(await pending);
    expect(receipt).toContain('[未知');
    expect(receipt).toContain('调用超时(100ms)');
    mock.releaseSendReplies();
    // get_login_info 的响应在迟到 echo 之后处理，确保已走过 driver 丢弃迟到回执的分支。
    await realCallApi('get_login_info');
    expect(String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx))).toContain('[未知');
    expect(mock.outbox).toHaveLength(1);
    expect(host.selfEvents()).toHaveLength(0);
  });

  it.each(['send_group_msg: 调用超时(30000ms)', 'send_group_msg: WS连接已断开', '未知传输异常'])(
    '已经送达但回执丢失: %s，不重试也不发后续条', async (error) => {
      stubDriver(async (action, params) => {
        await realCallApi(action, params);
        throw new Error(error);
      });
      await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
      const result = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));
      expect(result).toContain('[未知');
      expect(result).toContain(error);
      expect(result).toContain('后续 3 条未提交');
      expect(result).not.toContain('draft kept');
      expect(host.selfEvents()).toHaveLength(0);
      expect(mock.outbox).toHaveLength(1);
      const again = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));
      expect(again).toContain('上次回执，未重复提交');
      expect(again).toContain('[未知');
      expect(mock.outbox).toHaveLength(1);
    },
  );

  it('第三条超时:保留前两条桥确认号，后续不提交', async () => {
    let count = 0;
    stubDriver(async (action, params) => {
      const result = await realCallApi(action, params);
      if (++count === 3) throw new Error('调用超时(30000ms)');
      return result;
    });
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
    const receipt = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));
    expect(receipt).toContain('第 3/4 条结果未知');
    expect(receipt).toContain('桥确认: #1001 #1002');
    expect(receipt).toContain('后续 1 条未提交');
    expect(mock.outbox).toHaveLength(3);
    expect(host.selfEvents()).toHaveLength(2);
  });

  it.each([undefined, {}, { message_id: null }, { message_id: 'invalid' }])('桥受理但没有有效消息号: %j，不伪造 qq.self', async (result) => {
    let calls = 0;
    stubDriver(async () => { calls++; return result; });
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: HIS_EXAMPLE }, bareCtx);
    const receipt = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));
    expect(receipt).toContain('[已入队');
    expect(receipt).toContain('后续 3 条未提交');
    expect(host.selfEvents()).toHaveLength(0);
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);
    expect(calls).toBe(1);
  });

  it('发送中再次确认/取消/起草不会重复提交或覆盖在途草稿', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    stubDriver(async (action, params) => {
      calls++;
      await waiting;
      return realCallApi(action, params);
    });
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: '只说一次。' }, bareCtx);
    const sending = tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);
    try {
      for (const decision of ['send', 'cancel']) {
        expect(String(await tool('qq2_confirm').handler({ decision }, bareCtx))).toContain('[已入队]');
      }
      expect(String(await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: '替换。' }, bareCtx))).toContain('[已入队]');
      expect(calls).toBe(1);
    } finally {
      release();
    }
    expect(String(await sending)).toContain('[桥确认 #1001');
    expect(mock.outbox).toHaveLength(1);
  });

  it('桥确认后本地落库失败，不把草稿留给重发', async () => {
    host.host.pushEvent = async () => { throw new Error('磁盘故障'); };
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: '只说一次。' }, bareCtx);
    const receipt = String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx));
    expect(receipt).toContain('[桥确认 #1001');
    expect(receipt).toContain('本地回录失败: 磁盘故障');
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);
    expect(mock.outbox).toHaveLength(1);
  });

  it('桥明确拒绝首条仍能安全重试', async () => {
    stubDriver(async () => { throw Object.assign(new Error('send_group_msg: retcode=100 拒绝'), { retcode: 100 }); });
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, text: '只说一次。' }, bareCtx);
    expect(String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx))).toContain('draft kept');
    stubDriver(realCallApi);
    expect(String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx))).toContain('[桥确认');
    expect(mock.outbox).toHaveLength(1);
  });

  it('仅图片发送丢回执，同样返回未知且不重复发图', async () => {
    host.blobs.set('log:pic', { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    stubDriver(async (action, params) => {
      await realCallApi(action, params);
      throw new Error('Timeout');
    });
    await tool('qq2_draft').handler({ to: `group:${GROUP}`, image: 'log:pic' }, bareCtx);
    expect(String(await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx))).toContain('[未知');
    await tool('qq2_confirm').handler({ decision: 'send' }, bareCtx);
    expect(mock.outbox).toHaveLength(1);
  });
});
