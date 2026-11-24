/**
 * 压缩挡的账本与摘要渲染。
 *
 * 这一层**不碰 host、不碰计时器**:它只负责「把一条事件压成一行」和「把一窗行折成
 * 一段摘要」。计时与投递在 `world.ts`(谁在什么时候把摘要推出去,那里才说得清)。
 *
 * 为什么要压而不是整批倒出去:一个热闹的群十分钟可能上百条,整批原文一次叫醒她,
 * 上下文和账单都跟着涨;摘要每条只留开头,细节她随时能用 `qq2_read_history` 翻。
 * 原始事件一条都没丢 —— 它们照常以 `deliver:false` 落进事件库(与睡眠挡同一套)。
 */
import type { Conv } from './modes.ts';

/** 账本只认这几个字段;core 的 EventEnvelope 与 World 推送时的入参都给得起。 */
export interface DigestEventInput {
  type: string;
  ts?: string;
  text?: string;
  meta?: Record<string, unknown>;
}

/**
 * 渲染上限。都是「防一条摘要把上下文撑爆」的闸,不是功能边界:
 * - `maxLinesPerConv`:每个群最多列多少条(列最后这些);
 * - `maxLineChars`:单行正文最多多少字;
 * - `maxTotalChars`:整份摘要的上限;
 * - `maxEntries`:账本最多记多少条(超了丢最老的,并在摘要里报数)。
 */
export const DIGEST_RENDER_DEFAULTS = {
  maxLinesPerConv: 30,
  maxLineChars: 90,
  maxTotalChars: 4000,
  maxEntries: 2000,
} as const;

/** 一条被压成行的账本记录。 */
export interface DigestEntry {
  conv: Conv;
  /** 事件时间(ISO 字符串,渲染时交给调用方的 timeOf) */
  ts: string;
  /** 发言人(只有 qq.message 有) */
  sender: string;
  /** 已经去掉会话前缀的正文(还没截断) */
  body: string;
  /** 非消息事件的类型标签,如 `[撤回]`;普通消息为空串 */
  tag: string;
}

export interface DigestSnapshot {
  entries: DigestEntry[];
  /** 这一窗第一条到达的时刻(毫秒) */
  fromMs: number;
  /** 结账时刻(毫秒) */
  toMs: number;
  /** 因为账本上限被丢掉的最老条数 */
  droppedOldest: number;
}

export const DIGEST_EMPTY_SNAPSHOT: DigestSnapshot = {
  entries: [],
  fromMs: 0,
  toMs: 0,
  droppedOldest: 0,
};

/**
 * 窗口账本。`push` 只记账,`take` 把整窗取走并清空 —— 取走之后下一个事件开新窗。
 *
 * 窗口的起点是**第一条被攒的事件到达的时刻**,不是进入压缩挡的时刻:压缩挡里
 * 群里一直没动静时,不该凭空每十分钟叫醒她一次。
 */
export class DigestLedger {
  private entries: DigestEntry[] = [];
  private fromMs = 0;
  private droppedOldest = 0;
  private readonly maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? DIGEST_RENDER_DEFAULTS.maxEntries));
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }

  get size(): number {
    return this.entries.length;
  }

  /** 这一窗的起点;空账本返回 0。 */
  get startedAtMs(): number {
    return this.fromMs;
  }

  push(event: DigestEventInput, conv: Conv, nowMs = Date.now()): void {
    if (this.entries.length === 0) this.fromMs = nowMs;
    const entry = entryOf(event, conv);
    if (!entry) return;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
      this.droppedOldest += 1;
    }
  }

  /** 取走整窗(空账本也给一个空快照,`fromMs` 为 0)。 */
  take(nowMs = Date.now()): DigestSnapshot {
    const snapshot: DigestSnapshot = {
      entries: this.entries,
      fromMs: this.fromMs,
      toMs: nowMs,
      droppedOldest: this.droppedOldest,
    };
    this.reset();
    return snapshot;
  }

  reset(): void {
    this.entries = [];
    this.fromMs = 0;
    this.droppedOldest = 0;
  }
}

/** 非消息事件的短标签;没列到的用类型名兜底。 */
const TYPE_TAG: Record<string, string> = {
  'qq.image': '[图]',
  'qq.vision': '[识图]',
  'qq.file': '[文件]',
  'qq.transcript': '[语音]',
  'qq.forward': '[转发]',
  'qq.recall': '[撤回]',
  'qq.member': '[成员]',
  'qq.emoji': '[表情]',
  'qq.poke': '[戳]',
  'qq.reply.uncaptured': '[引用]',
  'qq.watch': '[监听]',
};

function entryOf(event: DigestEventInput, conv: Conv): DigestEntry | null {
  const text = typeof event.text === 'string' ? event.text : '';
  const ts = typeof event.ts === 'string' ? event.ts : new Date().toISOString();
  const sender = typeof event.meta?.sender_name === 'string' ? event.meta.sender_name : '';
  if (event.type === 'qq.message') {
    if (!text) return null;
    return { conv, ts, sender, body: messageBody(text), tag: '' };
  }
  const tag = TYPE_TAG[event.type] ?? `[${event.type.replace(/^qq\./, '')}]`;
  return { conv, ts, sender: '', body: stripConvPrefix(text), tag };
}

/**
 * 消息正文:去掉 `#<消息号> [<会话> <时间>] 名(号): ` 这一段前缀。
 * 前缀里的冒号是「会话标签 + 发言人」的结尾,正文里的冒号不动。
 */
function messageBody(text: string): string {
  const m = /^#\d+\s+\[[^\]]*\]\s+[\s\S]*?:\s+([\s\S]*)$/.exec(text);
  return m ? m[1]! : text;
}

/** 非消息事件正文:去掉行首那颗 `[群「…」 12:00]` / `[系统]` 前缀。 */
function stripConvPrefix(text: string): string {
  return text.replace(/^\[[^\]]*\]\s*/, '').trim();
}

/** 压成一行:折叠空白、去首尾、超长截断。 */
export function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}

export interface DigestRenderOptions {
  /** 群名(只给名字,不带引号) */
  labelOf: (conv: Conv) => string;
  /** 事件的显示时刻(如 `12:34`) */
  timeOf: (ts: string) => string;
  /** 毫秒时间戳的显示时刻(窗口起止用) */
  clock: (ms: number) => string;
  /** 窗口起点(毫秒);摘要头写它 */
  fromMs: number;
  /** 结账时刻(毫秒);摘要头写它 */
  toMs: number;
  /** 账本上限丢掉的最老条数;>0 时在末尾写一句 */
  droppedOldest?: number;
  maxLinesPerConv?: number;
  maxLineChars?: number;
  maxTotalChars?: number;
}

/**
 * 把一窗记录折成一份摘要正文。
 *
 * 形状:
 * ```
 * [QQ 压缩摘要 12:00–12:10] 群里 37 条,来自 2 个群
 * 群「深夜食堂」(424242) · 25 条
 *   12:01 甲: 今天有人来吗
 *   …
 *   …这个群还有 7 条没列出
 * 群「…」(…) · 12 条
 * ```
 * 细节没列全时明确写出「没列出 N 条」,并指路 `qq2_read_history` —— 不给她一个
 * 「看起来全都在这里」的假象。
 */
export function renderDigest(entries: readonly DigestEntry[], opts: DigestRenderOptions): string {
  const maxLines = Math.max(1, opts.maxLinesPerConv ?? DIGEST_RENDER_DEFAULTS.maxLinesPerConv);
  const maxChars = Math.max(16, opts.maxLineChars ?? DIGEST_RENDER_DEFAULTS.maxLineChars);
  let budget = Math.max(200, opts.maxTotalChars ?? DIGEST_RENDER_DEFAULTS.maxTotalChars);

  const groups = new Map<number, DigestEntry[]>();
  for (const e of entries) {
    const list = groups.get(e.conv.id);
    if (list) list.push(e);
    else groups.set(e.conv.id, [e]);
  }

  const header = `[QQ 压缩摘要 ${opts.clock(opts.fromMs)}–${opts.clock(opts.toMs)}]`;
  const lines: string[] = [];
  lines.push(`${header} 群里 ${entries.length} 条,来自 ${groups.size} 个群`);
  budget -= lines[0]!.length;

  let omittedForBudget = 0;
  for (const [id, list] of groups) {
    if (budget <= 0) {
      omittedForBudget += list.length;
      continue;
    }
    const title = `群「${opts.labelOf({ kind: 'group', id })}」(${id}) · ${list.length} 条`;
    lines.push(title);
    budget -= title.length;
    const shown = list.slice(-maxLines);
    const omitted = list.length - shown.length;
    for (const e of shown) {
      if (budget <= 0) {
        omittedForBudget += 1;
        continue;
      }
      const time = opts.timeOf(e.ts);
      const body = oneLine(e.body, maxChars);
      const line = e.tag
        ? `  ${time} ${e.tag}${body ? ` ${body}` : ''}`
        : `  ${time} ${e.sender ? `${e.sender}: ` : ''}${body}`;
      lines.push(line);
      budget -= line.length + 1;
    }
    if (omitted > 0) {
      const note = `  …这个群还有 ${omitted} 条没列出(用 qq2_read_history 看)`;
      lines.push(note);
      budget -= note.length;
    }
  }
  if (omittedForBudget > 0) {
    lines.push(`(摘要太长,还有 ${omittedForBudget} 条没列出,用 qq2_read_history 看)`);
  }
  if ((opts.droppedOldest ?? 0) > 0) {
    lines.push(`(更早的 ${opts.droppedOldest} 条已略过,用 qq2_read_history 看)`);
  }
  return lines.join('\n');
}
