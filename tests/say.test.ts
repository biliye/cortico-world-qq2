/**
 * 说话那条路的真回路:她调 `qq2_say` → 协议端**真的**收到一条 `record` 段。
 *
 * 合成器用一个替身注入(不联网、不花钱、不看 key),其余全是真的:真 WS、真段构造、
 * 真回录。这里验的是四条边界:语音条是独立一条消息、群聊那道闸、长了分两条、装不下回绝。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobInput, EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockNapCat } from './helpers/mock-napcat.ts';
import { QQ2World } from '../src/world.ts';
import { VOICE_DEFAULTS } from '../src/config.ts';
import type { SayResult } from '../src/voice.ts';

const GROUP = 10001;
const PEER = 200002;
const SELF = 5000;

/** 假的「音频」:合成层只要求 ≥512 字节,World 这边不看字节。 */
const AUDIO = new Uint8Array(600).fill(9);

interface Recorded {
  event: EventEnvelope;
  opts: PushOptions | undefined;
}

class SayHost {
  readonly pushed: Recorded[] = [];

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
      blob: () => null,
      reportUsage: () => {},
      log: nullLogger(),
    } as unknown as WorldHost;
  }

  selfs(): Recorded[] {
    return this.pushed.filter((p) => p.event.type === 'qq.self');
  }
}

let mock: MockNapCat;
let mod: QQ2World;
let host: SayHost;
let dataDir: string;
/** 每次合成的入参(断言「切成两条后分别念的是什么」) */
let spoken: string[];
/** 合成成功的字节,可按次改成失败 */
let sayFailsAt: number | null;

function makeSay() {
  return async (text: string): Promise<SayResult> => {
    spoken.push(text);
    if (sayFailsAt !== null && spoken.length === sayFailsAt) {
      return { ok: false, kind: 'api', error: '没做到:MiniMax 回了错误 1004:invalid api key。改用文字发吧。' };
    }
    return { ok: true, bytes: AUDIO, mime: 'audio/mpeg', ms: 2400, chars: text.length, cached: false };
  };
}

async function boot(voice: Partial<typeof VOICE_DEFAULTS> = {}): Promise<void> {
  mock = new MockNapCat({ port: 0, groupId: GROUP, selfId: SELF, selfNickname: 'bot', groupName: '深夜食堂' });
  const port = await mock.start();
  host = new SayHost();
  dataDir = mkdtempSync(join(tmpdir(), 'qq2-say-'));
  spoken = [];
  sayFailsAt = null;
  mod = new QQ2World(
    {
      wsUrl: `ws://127.0.0.1:${port}`,
      groups: [GROUP],
      privates: [PEER],
      token: '',
      dataDir,
      // 间隔设 0:测的是拆条,不是节奏
      split: { enabled: true, maxChunks: 6, intervalMs: 0 },
      voice: { ...VOICE_DEFAULTS, groupEnabled: false, ...voice },
    },
    { say: makeSay() },
  );
  await mod.start(host.host);
  await mod.waitReady();
}

function sayTool() {
  const found = mod.tools().find((t) => t.name === 'qq2_say');
  if (!found) throw new Error('没有 qq2_say');
  return found;
}

const bareCtx = {} as Parameters<ReturnType<typeof sayTool>['handler']>[1];

/** 调一次 qq2_say:把它两种返回形状(字符串 / {text,blobs})抹平。 */
async function say(args: { to: string; text: string }): Promise<{ text: string; blobs?: BlobInput[] }> {
  const out = await sayTool().handler(args, bareCtx);
  return typeof out === 'string' ? { text: out } : { text: out.text, blobs: out.blobs };
}

/** 协议端收到的每一条的段类型(例如 "record" / "image+text")。 */
function segTypes(): string[] {
  return mock.outbox.map((o) =>
    (o.params.message as Array<{ type: string }>).map((s) => s.type).join('+'),
  );
}

/** 一条 record 段的 base64 解出来有多少字节。 */
function recordBytes(i: number): number {
  const seg = (mock.outbox[i]!.params.message as Array<{ type: string; data: { file: string } }>)[0]!;
  return Buffer.from(seg.data.file.replace(/^base64:\/\//, ''), 'base64').length;
}

/** 一句正好 200 字符(99 个汉字 + 。):两条顶满单条上限 400。 */
const SENTENCE = '一'.repeat(99) + '。';

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await mod.stop();
  await mock.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('私聊(她自己去说)', () => {
  it('合成一条语音条:协议端收到的是一个 record 段,不带文字/图片/引用', async () => {
    const receipt = (await say({ to: `private:${PEER}`, text: '晚安,早点睡。' })).text;

    expect(mock.outbox).toHaveLength(1);
    expect(segTypes()).toEqual(['record']);
    expect(mock.outbox[0]!.action).toBe('send_private_msg');
    expect(mock.outbox[0]!.params.user_id).toBe(PEER);
    expect(recordBytes(0)).toBe(AUDIO.length);
    // 回执报出消息号,并说明念成了几条
    expect(receipt).toContain(`#${mock.outbox[0]!.message_id}`);
    expect(receipt).toContain('一条语音');
    expect(spoken).toEqual(['晚安,早点睡。']);
  });

  it('把音频句柄交回给她(工具回执带 blobs),回录里也标出 [语音]', async () => {
    const result = await say({ to: `private:${PEER}`, text: '晚安。' });

    expect(result.blobs).toHaveLength(1);
    expect(result.blobs?.[0]).toMatchObject({ mime: 'audio/mpeg', fallbackText: '你发出的语音' });
    const self = host.selfs();
    expect(self).toHaveLength(1);
    expect(self[0]!.event.text).toContain('[语音]');
    expect(self[0]!.event.text).toContain('你:');
    expect(self[0]!.opts?.deliver).toBe(false);
    expect(self[0]!.event.blobs).toHaveLength(1);
  });
});

describe('群聊那道闸在他手上', () => {
  it('默认关:群里发语音被回绝,协议端一条都没收到(也没白合成)', async () => {
    // 每次用例前先让 mock 认下这个群,免得回绝的原因变成「不在名单里」
    const receipt = (await say({ to: `group:${GROUP}`, text: '晚安。' })).text;

    expect(receipt).toContain('群里发语音他还没打开');
    expect(mock.outbox).toHaveLength(0);
    expect(spoken).toEqual([]); // 回绝发生在合成之前,不花这份钱
  });

  it('他打开后:群里能发;发不发仍由她(这条是她调了才发的)', async () => {
    await mod.stop();
    await mock.close();
    await boot({ groupEnabled: true });

    const receipt = (await say({ to: `group:${GROUP}`, text: '晚安。' })).text;
    expect(mock.outbox).toHaveLength(1);
    expect(segTypes()).toEqual(['record']);
    expect(mock.outbox[0]!.params.group_id).toBe(GROUP);
    expect(receipt).toContain('群「深夜食堂」');
  });

  it('总开关关着:私聊也发不了(他说了才算)', async () => {
    await mod.stop();
    await mock.close();
    await boot({ enabled: false });

    const receipt = (await say({ to: `private:${PEER}`, text: '晚安。' })).text;
    expect(receipt).toContain('语音开关关着');
    expect(mock.outbox).toHaveLength(0);
  });
});

describe('长了分两条、再长回绝', () => {
  it('超出单条上限:按句子念成两条,顺序与切法都对', async () => {
    const text = SENTENCE + SENTENCE + SENTENCE; // 600 字符 → [400, 200]
    const receipt = (await say({ to: `private:${PEER}`, text })).text;

    expect(mock.outbox).toHaveLength(2);
    expect(segTypes()).toEqual(['record', 'record']);
    expect(spoken).toEqual([SENTENCE + SENTENCE, SENTENCE]);
    expect(receipt).toContain('2 条语音');
    // 两条都报出消息号
    for (const o of mock.outbox) expect(receipt).toContain(`#${o.message_id}`);
  });

  it('两条装不下:回绝(不让协议端收到半截),并让她改用文字、用短句', async () => {
    const text = SENTENCE.repeat(5); // 1000 字符 → 三条
    const receipt = (await say({ to: `private:${PEER}`, text })).text;

    expect(receipt).toContain('[not spoken]');
    expect(receipt).toContain('短句');
    expect(mock.outbox).toHaveLength(0);
    expect(spoken).toEqual([]);
  });
});

describe('合成失败不吞掉整条回复', () => {
  it('第一条就没合成出来:回绝,协议端什么也没收到', async () => {
    sayFailsAt = 1;
    const receipt = (await say({ to: `private:${PEER}`, text: '晚安。' })).text;

    expect(receipt).toContain('[not spoken]');
    expect(receipt).toContain('改用文字');
    expect(mock.outbox).toHaveLength(0);
  });

  it('第二条没合成出来:如实说哪条出去了,并提醒别重发', async () => {
    sayFailsAt = 2;
    const text = SENTENCE + SENTENCE + SENTENCE;
    const receipt = (await say({ to: `private:${PEER}`, text })).text;

    expect(mock.outbox).toHaveLength(1);
    expect(receipt).toContain('第 2/2 条没合成出来');
    expect(receipt).toContain('别重发');
    expect(receipt).toContain(`#${mock.outbox[0]!.message_id}`);
  });
});

describe('语音发送回执不确定', () => {
  it.each(['timeout', 'queued'])('%s 时停下后续语音，不误称什么也没发', async (mode) => {
    const driver = (mod as unknown as { driver: { callApi: (action: string, params?: Record<string, unknown>) => Promise<unknown> } }).driver;
    const realCall = driver.callApi.bind(driver);
    driver.callApi = async (action, params) => {
      const result = await realCall(action, params);
      if (action === 'send_private_msg') {
        if (mode === 'timeout') throw new Error('调用超时(30000ms)');
        return {};
      }
      return result;
    };
    const receipt = (await say({ to: `private:${PEER}`, text: SENTENCE + SENTENCE + SENTENCE })).text;
    expect(receipt).toContain(mode === 'timeout' ? '[未知' : '[已入队');
    expect(receipt).toContain('后续 1 条语音未提交');
    expect(receipt).not.toContain('QQ 上什么也没有');
    expect(receipt).not.toContain('改用文字发');
    expect(mock.outbox).toHaveLength(1);
    expect(spoken).toHaveLength(1);
    expect(host.selfs()).toHaveLength(0);
  });
});
