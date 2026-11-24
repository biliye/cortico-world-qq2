/**
 * 嗓子那一层(文字 → 字节)。这里全是**不联网**的:HTTP 用一个假 fetch 顶替。
 *
 * 覆盖两件最容易出钱的事:配额与缓存(同句不花第二遍钱),以及每种失败都给出一句
 * 能直接念给她听的话(不抛错)。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { billableChars, planVoiceBars, readQuota, synthesize, type SaySettings } from '../src/voice.ts';

const settings: SaySettings = {
  apiKeySecret: 'MINIMAX_API_KEY',
  endpoint: 'https://api.minimax.cn/v1/t2a_v2',
  model: 'speech-2.8-turbo',
  voiceId: 'Chinese (Mandarin)_Sweet_Lady',
  speed: 1,
  vol: 1,
  pitch: 0,
  timeoutMs: 5000,
  maxCharsPerBar: 400,
  maxBars: 2,
  dailyChars: 20_000,
};

/** 一段够长的假音频(合成层会拒掉 <512 字节的,视为爆音)。 */
const FAKE_MP3 = new Uint8Array(1024).fill(3);

function okPayload(bytes = FAKE_MP3, ms = 1200) {
  return {
    data: { audio: Buffer.from(bytes).toString('hex') },
    extra_info: { audio_length: ms, audio_format: 'mp3' },
    base_resp: { status_code: 0, status_msg: 'success' },
  };
}

let dir: string;
let calls: number;
let lastBody: Record<string, unknown> | undefined;

function fakeFetch(payload: unknown, opts: { throws?: Error; status?: number } = {}) {
  return (async (_url: string, init?: { body?: string }) => {
    calls += 1;
    lastBody = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (opts.throws) throw opts.throws;
    return { status: opts.status ?? 200, json: async () => payload };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qq2-voice-'));
  calls = 0;
  lastBody = undefined;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('billableChars', () => {
  it('一个汉字算 2 个,ASCII 算 1 个(照 MiniMax 的账单口径)', () => {
    expect(billableChars('好')).toBe(2);
    expect(billableChars('好的')).toBe(4);
    expect(billableChars('ok')).toBe(2);
    // 晚2 安2 (半角逗号)1 早2 点2 睡2 。2 = 13;半角逗号只算一个
    expect(billableChars('晚安,早点睡。')).toBe(13);
    // 全角的逗号算 2:晚2 安2 ，2 早2 点2 睡2 。2 = 14
    expect(billableChars('晚安，早点睡。')).toBe(14);
  });
});

describe('planVoiceBars', () => {
  /** 一句正好 200 字符(99 个汉字 + 。):两条正好顶满单条上限 400。 */
  const sentence = '一'.repeat(99) + '。';

  it('短话就一条', () => {
    expect(planVoiceBars('晚安,早点睡。', { maxCharsPerBar: 400, maxBars: 2 })).toEqual({ bars: ['晚安,早点睡。'] });
  });

  it('超了单条上限:按句子折成两条,顺序不变', () => {
    const text = [sentence, sentence, sentence].join('');
    const plan = planVoiceBars(text, { maxCharsPerBar: 400, maxBars: 2 });
    expect('bars' in plan).toBe(true);
    const bars = (plan as { bars: string[] }).bars;
    expect(bars).toHaveLength(2);
    expect(bars.every((b) => billableChars(b) <= 400)).toBe(true);
    // 顺序不变:去掉条内补的换行后就等于原文
    expect(bars.join('').replace(/\n/g, '')).toBe(text);
  });

  it('两条装不下就回绝,并让她改用文字(提到短句)', () => {
    const text = [sentence, sentence, sentence, sentence, sentence].join('');
    const plan = planVoiceBars(text, { maxCharsPerBar: 400, maxBars: 2 });
    expect('tooLong' in plan).toBe(true);
    expect((plan as { tooLong: string }).tooLong).toContain('短句');
  });

  it('单句本身超上限:不硬切,直接回绝', () => {
    const text = '嗯'.repeat(300) + '。'; // 602 字符,一句话
    const plan = planVoiceBars(text, { maxCharsPerBar: 400, maxBars: 2 });
    expect('tooLong' in plan).toBe(true);
    expect((plan as { tooLong: string }).tooLong).toContain('单句');
  });
});

describe('synthesize', () => {
  const deps = () => ({ dir, settings, apiKey: 'k', today: '2026-09-29' });

  it('没配密钥:提示在语音面板配置(不抛错)', async () => {
    const res = await synthesize('晚安。', { ...deps(), apiKey: '', fetchImpl: fakeFetch(okPayload()) });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('config');
    expect(res.error).toContain('QQ 2 → 语音');
    expect(calls).toBe(0);
  });

  it('成功:拿回字节,落盘做缓存,记今天的账', async () => {
    const res = await synthesize('晚安,早点睡。', { ...deps(), fetchImpl: fakeFetch(okPayload()) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bytes.length).toBe(FAKE_MP3.length);
    expect(res.mime).toBe('audio/mpeg');
    expect(res.ms).toBe(1200);
    expect(res.chars).toBe(billableChars('晚安,早点睡。'));
    expect(res.cached).toBe(false);
    expect(readQuota(join(dir, 'quota.json'), '2026-09-29').chars).toBe(res.chars);
    // 请求体走的是 MiniMax 那一套:hex 输出 + mp3
    expect((lastBody as { output_format?: string }).output_format).toBe('hex');
    expect((lastBody as { model?: string }).model).toBe('speech-2.8-turbo');
  });

  it('同一句第二次:命中缓存,不再联网、不再花钱', async () => {
    const first = await synthesize('晚安,早点睡。', { ...deps(), fetchImpl: fakeFetch(okPayload()) });
    expect(first.ok).toBe(true);
    const before = calls;
    const again = await synthesize('晚安,早点睡。', { ...deps(), fetchImpl: fakeFetch(okPayload()) });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.cached).toBe(true);
    expect(again.chars).toBe(0);
    expect(calls).toBe(before);
    expect(readQuota(join(dir, 'quota.json'), '2026-09-29').chars).toBe(billableChars('晚安,早点睡。'));
  });

  it('换了音色就不再命中同一份缓存(同一句在不同音色下是两份音频)', async () => {
    await synthesize('晚安。', { ...deps(), fetchImpl: fakeFetch(okPayload()) });
    const other = await synthesize('晚安。', {
      ...deps(),
      settings: { ...settings, voiceId: 'female-shaonv' },
      fetchImpl: fakeFetch(okPayload()),
    });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.cached).toBe(false);
  });

  it('额度到顶:回绝并说明已用/上限(改用文字)', async () => {
    const res = await synthesize('晚安。', {
      ...deps(),
      settings: { ...settings, dailyChars: 2 },
      fetchImpl: fakeFetch(okPayload()),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('quota');
    expect(res.error).toContain('配额');
    expect(calls).toBe(0);
  });

  it('HTTP 200 但业务错误码:按 base_resp 判失败(官方文档口径)', async () => {
    const res = await synthesize('晚安。', {
      ...deps(),
      fetchImpl: fakeFetch({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('api');
    expect(res.error).toContain('1004');
  });

  it('回执里没有音频 → 当成失败,不落盘', async () => {
    const res = await synthesize('晚安。', {
      ...deps(),
      fetchImpl: fakeFetch({ data: {}, extra_info: {}, base_resp: { status_code: 0 } }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('api');
  });

  it('音频小得不像一句话(爆音)→ 丢掉,不落盘', async () => {
    const res = await synthesize('晚安。', {
      ...deps(),
      fetchImpl: fakeFetch(okPayload(new Uint8Array(64))),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('api');
    expect(existsSync(join(dir, 'quota.json'))).toBe(false);
  });

  it('连不上:回一句「没连上」,不抛错', async () => {
    const res = await synthesize('晚安。', {
      ...deps(),
      fetchImpl: fakeFetch(null, { throws: new Error('ECONNREFUSED') }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('network');
    expect(res.error).toContain('ECONNREFUSED');
  });
});
