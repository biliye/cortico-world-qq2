/**
 * 嗓子(QQ 版):MiniMax 的语音合成(文字 → 音频字节)。
 *
 * 与 pet 那份 `src/voice.ts` **同源**:计费口径(一个汉字算 2 个字符)、同句缓存、
 * 按天记账、失败不抛错只回一条能直接念给她听的话 —— 都照抄。两处不同:
 *
 * - 这里返回**字节**,不是文件路径。语音条要走 OneBot 的 `record` 段,字节要塞进消息里
 *   (`base64://`),所以缓存命中时也要把文件读回字节。
 * - 回执面朝 QQ(不提 pet_bubble 这些桌面上的东西)。
 *
 * **计费口径必须与 pet 那份保持一致**(他后台的账单按同一口径看)。要改就两处一起改。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitForSending } from './split.ts';
import type { QQVoiceConfig } from './config.ts';

/** 这一层要知道的配置(World 从 `worlds.qq2.voice` 现读,热改即生效)。 */
export interface SaySettings {
  /** 密钥住部署 .env,值经 `ctx.secret(apiKeySecret)` 取。 */
  apiKeySecret: string;
  endpoint: string;
  model: string;
  voiceId: string;
  speed: number;
  vol: number;
  pitch: number;
  /** 一句话合成的等待上限(毫秒)。 */
  timeoutMs: number;
  /** **单条**语音的上限(字符,一个汉字算 2);0 = 不设。 */
  maxCharsPerBar: number;
  /** 一段话最多念几条;超了就回绝并让她改用文字。 */
  maxBars: number;
  /** 日累计上限(字符);0 = 不设。 */
  dailyChars: number;
}

export interface SayOk {
  ok: true;
  bytes: Uint8Array;
  mime: 'audio/mpeg';
  /** 音频时长(毫秒),取自接口的 `extra_info.audio_length`;拿不到时报 0。 */
  ms: number;
  /** 这次算掉的字符数(账单口径)。 */
  chars: number;
  /** 命中缓存 = 这一句没花钱。 */
  cached: boolean;
}

export interface SayFail {
  ok: false;
  /** 给她的回执原文 —— 她会照着这句决定下一步。 */
  error: string;
  kind: 'config' | 'too-long' | 'quota' | 'api' | 'network';
  detail?: string;
}

export type SayResult = SayOk | SayFail;

export interface SayLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const SILENT: SayLogger = { info: () => {}, warn: () => {} };

/**
 * 计费字符数:**一个汉字算 2 个字符**,其余 1 个(与 pet 同一口径,照 MiniMax 的账单)。
 */
export function billableChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    const wide = /[\u3000-\u303f\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(ch);
    n += wide ? 2 : 1;
  }
  return n;
}

/** 缓存键:换了音色、语速这些就不再命中——同一句在不同音色下是两份音频。 */
function cacheKey(settings: SaySettings, text: string): string {
  return createHash('sha1')
    .update(
      [settings.model, settings.voiceId, String(settings.speed), String(settings.vol), String(settings.pitch), text].join(
        '\u0000',
      ),
    )
    .digest('hex')
    .slice(0, 24);
}

interface CacheNote {
  ms: number;
  chars: number;
  text: string;
  at: string;
}

export interface QuotaState {
  date: string;
  chars: number;
}

/**
 * 读今天的账。**日期对不上就从零开始**——这是「按天」的意思,也顺手把隔天的旧账清了。
 * 文件坏了当作没有(不因此拦她出声;账本丢一次比哑一天轻)。
 */
export function readQuota(file: string, today: string): QuotaState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<QuotaState>;
    if (raw && raw.date === today && Number.isFinite(Number(raw.chars))) {
      return { date: today, chars: Math.max(0, Math.round(Number(raw.chars))) };
    }
  } catch {
    /* 没有、坏了:当今天从零开始 */
  }
  return { date: today, chars: 0 };
}

/** 一段话该念成几条:能一条就一条,最多 maxBars 条;装不下就回绝。 */
export function planVoiceBars(
  text: string,
  opts: { maxCharsPerBar: number; maxBars: number },
): { bars: string[] } | { tooLong: string } {
  const whole = billableChars(text);
  if (opts.maxCharsPerBar <= 0 || whole <= opts.maxCharsPerBar) return { bars: [text.trim()] };

  // 按句子切,再贪心装进条里(顺序不变,只挑断点)。
  // 句子直接相接(不加换行):换行也算一个字符,会把「正好顶满上限」的那一条顶出去。
  const sentences = splitForSending(text, { maxChunks: 999 });
  const bars: string[] = [];
  let buf = '';
  for (const s of sentences) {
    const joined = buf + s;
    if (buf && billableChars(joined) > opts.maxCharsPerBar) {
      bars.push(buf);
      buf = s;
    } else {
      buf = joined;
    }
  }
  if (buf) bars.push(buf);

  if (bars.some((b) => billableChars(b) > opts.maxCharsPerBar)) {
    // 单句就超上限:切不动(不硬切词)。
    return {
      tooLong:
        `这句话里有单句太长(按 MiniMax 的口径算 ${whole} 个字符,单条上限 ${opts.maxCharsPerBar}),`
        + '切成两条也装不下。改成文字发,或者把话拆短一点再说。',
    };
  }
  if (bars.length > opts.maxBars) {
    return {
      tooLong:
        `这段话按口径算 ${whole} 个字符,最多只能念 ${opts.maxBars} 条(单条上限 ${opts.maxCharsPerBar})。`
        + '语音尽量用短句——说重点一两句就够;长内容改用文字发。',
    };
  }
  return { bars };
}

/**
 * 从 `worlds.qq2.voice` 里取这一层要的那几项。
 *
 * 只此一份映射:装配层与 `pnpm voicecheck` 探针都走它,免得两处各写一遍、各自漂移。
 */
export function saySettingsOf(cfg: QQVoiceConfig): SaySettings {
  return {
    apiKeySecret: cfg.apiKeySecret,
    endpoint: cfg.endpoint,
    model: cfg.model,
    voiceId: cfg.voiceId,
    speed: cfg.speed,
    vol: cfg.vol,
    pitch: cfg.pitch,
    timeoutMs: cfg.timeoutMs,
    maxCharsPerBar: cfg.maxCharsPerBar,
    maxBars: cfg.maxBars,
    dailyChars: cfg.dailyChars,
  };
}

export interface SayDeps {
  /** 音频与账本放哪儿(World 传 `<dataDir>/qq-voice`)。 */
  dir: string;
  settings: SaySettings;
  /** 密钥;空串 = 没配(回执里要告诉他自己缺什么)。 */
  apiKey: string;
  /** 今天(YYYY-MM-DD),由 World 按**部署时区**给——记账按他那边的一天算。 */
  today: string;
  /** 测试用的替身;生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
  log?: SayLogger;
}

/**
 * 合成一句话。**不抛错**:每一种失败都变成一条能直接念给她听的 `error`。
 * 这样工具侧只有一条路(拿结果、看 ok),不必在外面写一遍 try。
 */
export async function synthesize(text: string, deps: SayDeps): Promise<SayResult> {
  const log = deps.log ?? SILENT;
  const { settings } = deps;

  if (deps.apiKey.trim() === '') {
    return {
      ok: false,
      kind: 'config',
      error: '没配 MiniMax 的密钥。请让用户在「QQ 2 → 语音」面板保存 MiniMax API Key。',
    };
  }

  const chars = billableChars(text);
  if (settings.maxCharsPerBar > 0 && chars > settings.maxCharsPerBar) {
    // 单条上限在工具那一层已经按句切过了;走到这里说明是单句超限。
    return {
      ok: false,
      kind: 'too-long',
      error:
        `这一条按 MiniMax 的口径算 ${chars} 个字符(一个汉字算 2 个),超过单条上限 ${settings.maxCharsPerBar}。`
        + '这句话太长了,拆成短句再说,或者改用文字发。',
    };
  }

  const quotaFile = join(deps.dir, 'quota.json');
  const quota = readQuota(quotaFile, deps.today);
  if (settings.dailyChars > 0 && quota.chars + chars > settings.dailyChars) {
    return {
      ok: false,
      kind: 'quota',
      error:
        `今天在 QQ 上的语音配额用完了(已用 ${quota.chars}/${settings.dailyChars} 字符,这句还要 ${chars})。`
        + '今天改用文字发;要调上限他在控制台的「QQ · 语音」那组里改。',
    };
  }

  const key = cacheKey(settings, text);
  const file = join(deps.dir, key + '.mp3');
  const noteFile = join(deps.dir, key + '.json');
  if (existsSync(file)) {
    try {
      const bytes = readFileSync(file);
      const note = readNote(noteFile);
      return { ok: true, bytes, mime: 'audio/mpeg', ms: note?.ms ?? 0, chars: 0, cached: true };
    } catch {
      /* 缓存读不出来就当没有:重合成一遍 */
    }
  }

  const body = {
    model: settings.model,
    text,
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: settings.voiceId,
      speed: settings.speed,
      vol: settings.vol,
      pitch: settings.pitch,
    },
    // mp3:同一句话体积小一半以上,而且协议端(NapCat)自己会把它转成 QQ 要的语音格式。
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  };

  let res: Response;
  let payload: unknown;
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    res = await doFetch(settings.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.apiKey.trim()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, settings.timeoutMs)),
    });
    payload = await res.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('合成请求没走通', { reason });
    return {
      ok: false,
      kind: 'network',
      error: `没做到:MiniMax 那边没连上(${reason})。联网或代理不通时会这样,改用文字发吧。`,
      detail: reason,
    };
  }

  const parsed = payload as {
    data?: { audio?: unknown } | null;
    extra_info?: { audio_length?: unknown; audio_format?: unknown } | null;
    base_resp?: { status_code?: unknown; status_msg?: unknown } | null;
  };
  // HTTP 200 不代表业务成功:成败以 base_resp.status_code 为准(官方文档明说)。
  const code = Number(parsed?.base_resp?.status_code ?? NaN);
  if (code !== 0) {
    const msg = String(parsed?.base_resp?.status_msg ?? '没给原因');
    log.warn('MiniMax 拒了这一句', { code, msg, http: res.status });
    return {
      ok: false,
      kind: 'api',
      error: `没做到:MiniMax 回了错误 ${Number.isFinite(code) ? code : res.status}:${msg}。改用文字发吧。`,
      detail: `${code} ${msg}`,
    };
  }

  const hex = parsed?.data?.audio;
  if (typeof hex !== 'string' || hex.trim() === '') {
    return {
      ok: false,
      kind: 'api',
      error: '没做到:MiniMax 的回执里没有音频(data.audio 是空的)。改用文字发吧。',
      detail: 'data.audio missing',
    };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(hex, 'hex');
  } catch (error) {
    return {
      ok: false,
      kind: 'api',
      error: '没做到:MiniMax 回的音频解不开(不是十六进制)。改用文字发吧。',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  // 几百字节不可能是这句话的音频;当真发出去 QQ 里只会是一声爆音。
  if (bytes.length < 512) {
    return {
      ok: false,
      kind: 'api',
      error: `没做到:MiniMax 回的音频只有 ${bytes.length} 字节,不像一句话,丢掉。改用文字发吧。`,
      detail: `audio too small: ${bytes.length}`,
    };
  }

  const ms = Math.max(0, Math.round(Number(parsed?.extra_info?.audio_length ?? 0)) || 0);
  try {
    mkdirSync(deps.dir, { recursive: true });
    writeFileSync(file, bytes);
    writeNote(noteFile, { ms, chars, text, at: deps.today });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'config',
      error: `没做到:音频存不下来(${reason})。检查这个部署的 data 目录能不能写。`,
      detail: reason,
    };
  }

  writeQuota(quotaFile, { date: deps.today, chars: quota.chars + chars });
  log.info('合成好了', { chars, bytes: bytes.length, ms, voice: settings.voiceId });
  return { ok: true, bytes, mime: 'audio/mpeg', ms, chars, cached: false };
}

function readNote(file: string): CacheNote | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CacheNote>;
    if (raw && Number.isFinite(Number(raw.ms))) {
      return {
        ms: Math.max(0, Math.round(Number(raw.ms))),
        chars: Number(raw.chars ?? 0),
        text: String(raw.text ?? ''),
        at: String(raw.at ?? ''),
      };
    }
  } catch {
    /* 小账丢了不影响出声:时长不知道就报 0 */
  }
  return null;
}

function writeNote(file: string, note: CacheNote): void {
  try {
    writeFileSync(file, JSON.stringify(note));
  } catch {
    /* 小账写不下去不该拦住她出声 */
  }
}

function writeQuota(file: string, state: QuotaState): void {
  try {
    writeFileSync(file, JSON.stringify(state));
  } catch {
    /* 同上:账本写不进去不该让她哑掉 */
  }
}
