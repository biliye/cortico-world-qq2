/**
 * 入站语音的转写(QQ 上别人发来的语音条)。
 *
 * **为什么自己起一条路,而不是复用框架的做法**:框架内建 qq World 的转写是**叫协议端自己转**
 * (`src/worlds/qq/world.ts:930` 的 `PTT_TEXT_ACTIONS`),本包当年没 port 过来;而本机有现成的
 * SenseVoice 服务(`127.0.0.1:50001`,hearing / pet / sensevoice 三处都在用它)。
 * 走本机这条的好处是**不依赖协议端的能力**,坏处是要自己把字节弄进来。
 *
 * 两条实测实底(2026-10-12,详录 `state/design/cortico-world-qq2-入站文件与音频.md`):
 * - QQ 语音段(`record`)**直接带公网地址**,不用另调协议端;
 * - 下到的是 **AMR**,而 `127.0.0.1:50001/asr` **直接吃得下**(HTTP 200 出文字)⇒ **不做转码层**。
 *
 * 交付的措辞有一条硬要求(他定的):**必须写明这是机器转写的、可能识别错**。
 */
import type { Logger } from 'cortico/core/types.ts';
import type { QQAsrConfig } from './config.ts';

export interface AsrDeps {
  cfg: QQAsrConfig;
  log: Logger;
  fetchImpl?: typeof fetch;
}

export interface AsrOutcome {
  /** 渲染好的那一行(正文用) */
  text: string;
  /** 转写成功且拿到了文字 */
  ok: boolean;
}

interface AsrResponse {
  text?: unknown;
  language?: unknown;
  emotion?: unknown;
  event?: unknown;
  audio_seconds?: unknown;
}

/**
 * 下载一条语音并转写。任何一步失败都**不抛** —— 返回一句如实的话交给正文,
 * 那条消息照常投出去(不让一条语音把整条消息卡住)。
 */
export class InboundAsr {
  constructor(private readonly deps: AsrDeps) {}

  async transcribe(url: string, label = '语音'): Promise<AsrOutcome> {
    const cfg = this.deps.cfg;
    if (!cfg.enabled) return { text: `[${label} · 没开转写]`, ok: false };

    let bytes: Uint8Array;
    try {
      bytes = await this.download(url);
    } catch (err) {
      return { text: `[${label} · 没能取到音频:${errText(err)}]`, ok: false };
    }
    if (bytes.length > cfg.maxBytes) {
      return { text: `[${label} · 音频 ${Math.round(bytes.length / 1024)}KB 超过上限,没转写]`, ok: false };
    }

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/amr' }), 'voice.amr');
    form.append('language', cfg.language);
    form.append('use_itn', 'true');
    form.append('vad', 'auto');

    let res: Response;
    try {
      const doFetch = this.deps.fetchImpl ?? fetch;
      res = await doFetch(`http://${cfg.host}:${cfg.port}/asr`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      return { text: `[${label} · 转写服务没连上(${cfg.host}:${cfg.port})]`, ok: false };
    }
    if (!res.ok) return { text: `[${label} · 转写服务回了 ${res.status}]`, ok: false };

    let body: AsrResponse;
    try {
      body = (await res.json()) as AsrResponse;
    } catch {
      return { text: `[${label} · 转写回执不是 JSON]`, ok: false };
    }
    return renderTranscription(body, label);
  }

  private async download(url: string): Promise<Uint8Array> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(this.deps.cfg.timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/**
 * 把转写回执渲染成正文那一行。
 *
 * **开头那个方括号是这条设计里最要紧的几个字**:它是机器听出来的,不是他打的字,
 * 所以措辞里必须有「转写」与「可能有错」—— 她据此决定要不要当真、要不要问他一句。
 */
export function renderTranscription(body: AsrResponse, label = '语音'): AsrOutcome {
  const raw = typeof body.text === 'string' ? body.text.trim() : '';
  const emotion = typeof body.emotion === 'string' && body.emotion && body.emotion !== 'NEUTRAL' ? body.emotion : '';
  const lang = typeof body.language === 'string' && body.language && body.language !== 'zh' ? body.language : '';
  const tags = [label === '语音' ? '语音转写' : label, '可能有错', lang, emotion ? `情感 ${emotion}` : '']
    .filter(Boolean)
    .join(' · ');
  if (!raw) return { text: `[${tags}] 这段没转出文字(可能是空的、太短,或全是噪声)。`, ok: false };
  return { text: `[${tags}] ${raw}`, ok: true };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
