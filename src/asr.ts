import { setTimeout as delay } from 'node:timers/promises';
import { RETCODE_UNSUPPORTED_ACTION, type OneBotDriver } from './onebot/driver.ts';

const RETRY_WINDOW_MS = 30_000;
const FIRST_RETRY_DELAY_MS = 1000;
// NapCat 可能在文本写回前读不到结果，SnowLuma 会等待结果推送。
const PENDING_RESULT = /获取语音转文字结果失败|语音转文字超时（未收到结果推送）/;

/** 按消息号通过 OneBot 请求 QQ 原生转写，返回可直接投递的文字。 */
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
    if (!reply.ok && reply.retcode === RETCODE_UNSUPPORTED_ACTION) {
      return '[语音 · 当前 OneBot 实现不支持 QQ 原生转写]';
    }

    const raw = reply.ok ? (reply.data as { text?: unknown } | null)?.text : undefined;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text) return `[语音转写 · 可能有错] ${text}`;

    const canRetry = reply.ok || (reply.retcode !== undefined && PENDING_RESULT.test(reply.error));
    if (!canRetry || Date.now() + retryDelay >= retryDeadline) {
      const reason = reply.ok ? '没转出文字' : reply.error;
      return `[语音 · QQ 转写失败（${reason}）]`;
    }
    await delay(retryDelay, undefined, { ref: false });
    if (Date.now() >= retryDeadline) return '[语音 · QQ 转写超时]';
  }
}
