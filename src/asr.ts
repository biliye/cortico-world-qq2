import { setTimeout as delay } from 'node:timers/promises';
import type { OneBotDriver } from './onebot/driver.ts';

const RETRY_WINDOW_MS = 30_000;
const FIRST_RETRY_DELAY_MS = 1000;

/** 按消息号向 NapCat 请求 QQ 原生转写，返回可直接投递的文字。 */
export async function transcribeVoice(
  driver: OneBotDriver,
  messageId: number | string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const retryDeadline = Math.min(deadline, startedAt + RETRY_WINDOW_MS);

  for (let retryDelay = FIRST_RETRY_DELAY_MS; ; retryDelay *= 2) {
    const reply = await driver.callExtension(
      'fetch_ptt_text', { message_id: messageId }, Math.max(1, deadline - Date.now()),
    );
    if (!reply.ok && reply.retcode === 1404) return '[语音 · NapCat 不支持 QQ 原生转写]';

    const raw = reply.ok ? (reply.data as { text?: unknown } | null)?.text : undefined;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) return `[语音转写 · 可能有错] ${text}`;

    // QQ 异步写回结果。协议端已回执时可以稍后重取，断线或调用超时则直接结束。
    const canRetry = reply.ok || reply.retcode !== undefined;
    if (!canRetry || Date.now() + retryDelay >= retryDeadline) {
      const reason = reply.ok ? '没转出文字' : reply.error;
      return `[语音 · QQ 转写失败（${reason}）]`;
    }
    await delay(retryDelay, undefined, { ref: false });
    if (Date.now() >= retryDeadline) return '[语音 · QQ 转写超时]';
  }
}
