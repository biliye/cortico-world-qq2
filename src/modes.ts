/**
 * 群聊投递模式。四态,全局一套(`worlds.qq2.mode`),只作用于**群**会话。
 *
 * core 的 `TriggerMode` 是「这一条事件怎么投」,模式是「这个 World 在群里的总策略」:
 * 收到一条群事件时,由 `planDelivery` 把它翻成一次投递决定。纯函数,好单测。
 *
 * `digest`(压缩)与前三种的不同之处:它不只改变**这一次**的投递,还要**攒**。
 * plan 里的 `accumulate: true` 是给包装器看的信号——这条交给账本,窗口到点再由
 * World 折成一份摘要投出去。
 */
import type { EventEnvelope, TriggerMode } from 'cortico/core/types.ts';

export type QQMode = 'batch' | 'focus' | 'digest' | 'sleep';

export const QQ_MODES = ['batch', 'focus', 'digest', 'sleep'] as const satisfies readonly QQMode[];

export const DEFAULT_MODE: QQMode = 'batch';

export function isQQMode(value: unknown): value is QQMode {
  return typeof value === 'string' && (QQ_MODES as readonly string[]).includes(value);
}

export interface Conv {
  kind: 'group' | 'private';
  id: number;
}

/** 事件所属会话;读不出(不是会话事件)返回 null。 */
export function convOf(event: Pick<EventEnvelope, 'meta'>): Conv | null {
  const raw = event.meta?.conv as Partial<Conv> | undefined;
  if (!raw || (raw.kind !== 'group' && raw.kind !== 'private') || raw.id === undefined) return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  return { kind: raw.kind, id };
}

export interface DeliveryPlan {
  /** false = 仅落库,不进投递队列(睡眠、压缩)。 */
  deliver: boolean;
  /** 指定时覆盖调用方给的 trigger。 */
  trigger?: TriggerMode;
  /** true = 这条要先并进压缩窗口,到点再折成摘要(与 deliver:false 同时出现)。 */
  accumulate?: boolean;
}

/** 判断投递时用得上的、事件本身带的信息。 */
export interface DeliveryContext {
  /** 这条是**点名说她**的(群里被@)。睡眠下它是唯一的例外口。 */
  mention?: boolean;
}

/**
 * 一次投递决定。私聊与非会话事件不受模式影响(他要的是「这些都是用在群聊的」)。
 *
 * - `batch`:不动调用方的 trigger —— 群里被@ 那条由 World 自己给 `flush`,其余是
 *   `debounce`(core 的合批窗口),这正是内置今天的群聊行为。
 * - `focus`:群里的每一条都 `flush`(立即投递整批积压),与内置里被@ 同款。
 * - `digest`:群里的消息**先攒着**(只落库 + 进账本),周期到了由 World 折成一份摘要
 *   投一次;被@ 仍然立刻叫醒她。私聊照旧。
 * - `sleep`:群里的每一条都只落库,不投递也不进队列 —— 醒来没有积压。
 *   **例外:被@ 仍然叫醒她**(`mention`)。她可以什么都不想听,但有人点她的名,那是冲她来的;
 *   这条例外是他明确要的,不是默认。
 */
export function planDelivery(mode: QQMode, conv: Conv | null, ctx: DeliveryContext = {}): DeliveryPlan {
  if (!conv || conv.kind !== 'group') return { deliver: true };
  if (mode === 'sleep') return ctx.mention ? { deliver: true, trigger: 'flush' } : { deliver: false };
  if (mode === 'digest') {
    return ctx.mention
      ? { deliver: true, trigger: 'flush' }
      : { deliver: false, accumulate: true };
  }
  if (mode === 'focus') return { deliver: true, trigger: 'flush' };
  return { deliver: true };
}

/** 模式名(给控制台徽标与工具回执用)。 */
export const MODE_LABEL: Record<QQMode, string> = {
  batch: '攒批',
  focus: '专注',
  digest: '压缩',
  sleep: '睡眠',
};

/** 工具回执里当场把规矩说给她:四种模式各自意味着什么。 */
export const MODE_RECEIPT: Record<QQMode, string> = {
  batch: '群里的消息攒成一批再给你(房间安静两秒半左右);有人直接@你时立刻给你。私聊不受影响。',
  focus: '群里的消息每条都立刻给你,不再攒批。私聊不受影响。',
  digest:
    '群里的消息先攒着,到周期后折成一份摘要给你一次(摘要里每条只留开头,细节用 qq2_read_history 翻);'
    + '**有人直接@你时仍然立刻叫醒你**。私聊也不受影响。周期可以在控制台改,调 qq2_mode 时带上 minutes 也能改。',
  sleep:
    '群里的消息只记进事件库,不叫醒你,也不会攒着等你醒来;想看用 qq2_read_history 自己翻。'
    + '**有人直接@你时仍然叫醒你**;私聊也不受影响。',
};

/** 事件 meta 里点名说她用的键(@ 那条)。 */
export const MENTION_META_KEY = 'mention';
