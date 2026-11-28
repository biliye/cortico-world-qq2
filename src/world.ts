/**
 * QQ World(第二份,id `qq2`)。源码自 `src/worlds/qq/world.ts` 迁出,协议与渲染的
 * 零件(driver / normalize / history-tools / conversation / vision)仍从框架 import;
 * 本包自己持有的是消息处理、起草-确认门、发送、控制台面板,以及**新的群聊模式**。
 *
 * 仅监听配置名单中的群与私聊,名单可通过 Web 热更新。其他会话与请求不落盘。
 * 每条消息渲染带会话标签(`[群「X」HH:MM]` / `[私聊 HH:MM]`),事件 meta.conv
 * 记录归属,发送/回复据此路由。
 *
 * 发送使用起草-确认门:draft 暂存单槽草稿并形成一次推理屏障。起草期间已经
 * 到达的会话消息会作为新的 user 事件紧随其后投递；下一次推理可确认或取消。
 *
 * **群聊模式**(`worlds.qq2.mode`,四态,全局一套,只作用于群会话;她可以用 `qq2_mode` 切):
 * 攒批(默认,`debounce`;被@ 仍立即给)/ 专注(每条 `flush`,立刻给)/
 * 压缩(只落库 + 进账本,每 N 分钟折成一份摘要投一次;被@ 与私聊仍立刻给)/
 * 睡眠(只落库、不投递也不进队列)。落点是 {@link modeAwareHost}:所有推送统一过一层策略。
 */
import { createHash } from 'node:crypto';
import type {
  ConfigGroup,
  PushOptions,
  WorldWebUiDecl,
  World,
  WorldHost,
  Logger,
  StoragePart,
  ToolDef,
  ToolOutcome,
  BlobInput,
} from 'cortico/core/types.ts';
import { DEFAULT_MODE, MENTION_META_KEY, MODE_LABEL, MODE_RECEIPT, QQ_MODES, convOf, isQQMode, planDelivery, type QQMode } from './modes.ts';
import { DigestLedger, renderDigest } from './digest.ts';
import { splitForSending } from './split.ts';
import { ImageLibrary, type PrecheckResult } from './images.ts';
import { IMAGE_KIND_IDS, LabelStore, kindLabel, normalizeKind } from './labels.ts';
import { FileLibrary, extOf, formatBytes, type FileRecord } from './files.ts';
import { isGif } from './gif-preview.ts';
import { transcribeVoice } from './asr.ts';
import { SPLIT_DEFAULTS, VOICE_DEFAULTS, FILES_DEFAULTS, ASR_DEFAULTS, DIGEST_DEFAULTS, type QQImagesConfig, type QQSendSplitConfig, type QQVoiceConfig, type QQFilesConfig, type QQAsrConfig, type QQDigestConfig } from './config.ts';
import { planVoiceBars, billableChars, type SayResult } from './voice.ts';

/** `qq_draft` → `qq2_draft`:本包的工具名与内建 qq World 的错开(内建那些名字已被占用)。 */
function renameQqTool(name: string): string {
  return name.replace(/^qq_/, 'qq2_');
}
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nowIso, shortTime, nullLogger } from 'cortico/core/util.ts';
import {
  eventInConversation,
  parseConversationAddress,
  sameConversation,
  type Conv,
} from './onebot/conversation.ts';
import { OneBotDriver, type OneBotEvent } from './onebot/driver.ts';
import { HISTORY_TOOL_DECLS, createHistoryTools } from './onebot/history-tools.ts';
import { detectImageMime, MIME_EXT } from './onebot/image-download.ts';
import {
  buildOutgoing,
  makeImagePolicy,
  parseJsonCard,
  renderIncoming,
  renderSegmentsPlain,
  type ImageRenderPolicy,
  type JsonCardRenderPolicy,
  type OneBotGroupMessage,
  type Segment,
} from './onebot/normalize.ts';
import type { VisionService } from './onebot/vision.ts';
import { QQ_DEFAULTS, QQ_SECRETS, QQ_CONFIG_GROUP, QQ_MODE_CONFIG_GROUP, QQ_SEND_CONFIG_GROUP, QQ_VOICE_CONFIG_GROUP, QQ_INBOUND_CONFIG_GROUP, type QQRosterEntry } from './config.ts';

export type { Conv } from './onebot/conversation.ts';
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** QQ在查不到账号资料时返回的昵称占位,等于「没有名字」。 */
const PLACEHOLDER_NICKNAME = 'QQ用户';

/** 合并转发里再套合并转发时,往里摊几层。现实里极少超过两层。 */
const MAX_FORWARD_NEST = 2;

/** 一次展开最多列多少行:一份转发记录可以是几百条,别让它把一条事件的正文撑爆。 */
const MAX_FORWARD_LINES = 300;

/**
 * 一份转发记录里最多给几张图编号。转发正文只给编号、不挂附件(附件每轮重发),
 * 所以编号多了没有代价;真正有代价的是**取回**(下载 + 落盘),所以要有个上限。
 */
const MAX_FORWARD_IMAGES = 12;

/**
 * 发送一条消息愿意等多久回执。默认的 10 秒(`driver.ts` 的 `DEFAULT_API_TIMEOUT_MS`)对
 * 这条公网线太紧:协议端忙起来回执要 6~15 秒(实测 p99 约 7 秒、最长 15.8 秒)。超时那一刻
 * 消息**可能已经送达**,而回执写着「没发出去、草稿留着」,照着重发就是两条一样的话。
 *
 * 只给发送这一路放宽:查历史、取消息那种读操作失败得快一点更好,读错了重来没有副作用。
 */
const SEND_TIMEOUT_MS = 30_000;

type SendResult = { state: 'queued' | 'confirmed' | 'unknown' | 'failed'; receipt: string; ids: string[] };

/** driver 只有协议端拒绝带 retcode；其余异常保守视作结果未知。 */
function definitelyNotSent(error: unknown): boolean {
  return error instanceof Error && (
    ('retcode' in error && typeof error.retcode === 'number')
    || /^send_(group|private)_msg: WS未连接$/.test(error.message)
  );
}

/**
 * 事件与历史查询用的 source,**沿用内置的 `qq`**,而不是本 World 的 id `qq2`。
 *
 * 这是有意的不一致,理由在数据那一侧:`source` 是历史命名空间——`store.range({source})`、
 * 历史工具、控制台事件面板、引用回复用的消息号索引,全部按它找。迁移那一刻事件库里已有
 * **682 条** source=qq 的记录(其中 534 条是他的消息);换成 `qq2` 就等于把她的 QQ 历史
 * 劈成两半,`qq2_read_history` 从此查不到迁移前说过的话,面板里也只剩一半。
 *
 * `source` 在 core 里只当过滤键用,不对照 World id(`event-store.ts:249/275`、
 * `web/server.ts:1302`),所以这样写没有副作用;唯一要守的是:内置那个 qq World 必须
 * 关掉(`worlds.qq.enabled: false`),否则两个 World 往同一个命名空间里写。
 */
export const EVENT_SOURCE = 'qq';



export function enabledRosterIds(entries: QQRosterEntry[]): number[] {
  return entries.filter((e) => e.enabled).map((e) => e.id);
}

/*
 * 下面这一组是**工具的静态声明**:名字、描述、参数、标签只有一份,`tools()` 拿它拼 handler,
 * 定义里的 `describe.tools` 也拿它(见 definition.ts)。描述与参数一个字都不许在这里现算 ——
 * `check:extension` 会把 describe.json 与这里的字段逐字比对。
 *
 * 这里列的是 `tools()` **可能返回的全部**工具,含按配置/能力出现的三条(看图、取旧图、读文件)。
 */

/** `qq2_mode` */
const MODE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_mode',
  description:
    'Choose how group-chat QQ messages reach you. "batch": hold group messages and hand them over as one batch '
    + 'once the room goes quiet; a direct @mention still comes through at once (the default). '
    + '"focus": hand over every group message immediately — use it while you want to answer without waiting. '
    + '"digest": keep group messages in a window and hand over one compact summary per window (default 10 minutes); '
    + 'a direct @mention still wakes you at once. '
    + '"sleep": keep recording group messages but stop waking you, and do not pile them up for later; read them '
    + 'back with qq2_read_history when you want. Group chats only: private messages are unaffected either way. '
    + 'The setting is written back to config and survives a restart.',
  tags: ['act'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: {
        type: 'string',
        enum: [...QQ_MODES],
        description: 'batch=攒批(默认)、focus=专注、digest=压缩、sleep=睡眠。',
      },
      minutes: {
        type: 'number',
        minimum: 0.1,
        maximum: 1440,
        description:
          'Only for "digest": how long one window lasts, in minutes (default 10). Omit to keep the current value. '
          + 'Written back to config, so it survives a restart.',
      },
    },
    required: ['mode'],
  },
};

/** `qq2_draft` */
const DRAFT_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_draft',
  description:
    'Stage a QQ message without sending. This ends the current tool sequence so you can review the draft and any newly arrived user events once before calling confirm (send or cancel). An unconfirmed draft is discarded at end of turn.',
  tags: ['speak'],
  barrierAfter: true,
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'Target conversation: "group:<id>" or "private:<id>" (numeric QQ group/user id, not a name). Optional when reply_to is given (taken from the quoted message).',
      },
      text: { type: 'string', description: 'Message text. Optional if image is given.' },
      image: {
        type: 'string',
        description:
          'Optional. An image to send, given by IMG-N (e.g. IMG-3, for one that came through QQ even if you '
          + 'did not keep it), a log: handle from a [blob ...] line you saw, or a mem: handle of one kept '
          + 'in your workspace. Prefer mem: for pictures you want to keep sending; IMG-N stops working '
          + 'when the image cache is cleared.',
      },
      reply_to: {
        type: 'string',
        description:
          'Optional. The QQ message id to quote-reply — the `#<id>` shown at the start of that message line.',
      },
    },
    required: [],
  },
};

/** `qq2_confirm` */
const CONFIRM_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_confirm',
  description:
    'Act on the last draft: decision="send" sends it, decision="cancel" discards it. Receipts distinguish queued, bridge-confirmed (not a read receipt), and unknown. Never resend queued or unknown messages; timeout does not mean failure. Only a failure known to precede sending or a definite rejection keeps the draft for retry.',
  tags: ['speak'],
  parameters: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['send', 'cancel'],
        description: '"send" or "cancel".',
      },
    },
    required: ['decision'],
  },
};

/** `qq2_say` */
const SAY_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_say',
  description:
    'Say it out loud: send a **QQ voice bar** (your own voice) to one conversation ("group:<id>" or "private:<id>"). '
    + 'A voice bar is a message of its own — it carries no text, no image and no quote-reply. '
    + 'Keep it short: what you would actually say out loud is one or two sentences. '
    + 'Longer text is spoken as at most a couple of bars, and if it still does not fit you are told to send text instead. '
    + 'Private chats always work; in groups it only works when the owner has switched it on. '
    + 'Queued or unknown receipts may already have been delivered: do not repeat them or send the same content as text.',
  tags: ['speak'],
  barrierAfter: true,
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Target conversation: "group:<id>" or "private:<id>" (numeric QQ group/user id, not a name).',
      },
      text: {
        type: 'string',
        description: 'What to say. Short — one or two sentences, like a person speaking.',
      },
    },
    required: ['to', 'text'],
  },
};

/** `qq2_read_file`(文件库在时才有) */
const READ_FILE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_read_file',
  description:
    'Read a text file that came through QQ, by its FILE-N id, one stretch at a time. Small files already '
    + 'reach you in full inside the message; this is for the bigger ones, where the message only showed the '
    + 'first few lines. offset/limit count LINES and offset starts at 1. You get the text only — never raw bytes.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      file_id: { type: 'string', description: 'File id from a "[文件 … FILE-3]" line, e.g. FILE-3 (file3 and 3 work too).' },
      offset: { type: 'integer', description: 'First line to read, 1-based. Defaults to 1.' },
      limit: { type: 'integer', description: 'How many lines to read. Defaults to 200.' },
    },
    required: ['file_id'],
  },
};

const GET_ATTACHMENT_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_get_attachment',
  description:
    'Retrieve the original bytes of a QQ attachment by its IMG-N or FILE-N id. The receipt gives a filename '
    + 'and a Cortico log: handle you can pass to another tool, such as devshop_start. Choose an accepted '
    + 'destination filename if that tool rejects the original name. Image originals, '
    + 'including animated GIFs, are handed off as binary files. Use qq2_get_image to see the preview, or qq2_read_file to read text.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachment_id: { type: 'string', description: 'The full QQ attachment id, e.g. IMG-3 or FILE-8.' },
    },
    required: ['attachment_id'],
  },
};

/** `qq2_get_image`(视觉或取图库任一在时才有) */
const GET_IMAGE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_get_image',
  description:
    'Bring back a QQ image by its IMG-N id, using the local copy when available. '
    + 'GIFs return a nine-frame PNG preview when possible. Set original=true for the original GIF bytes. '
    + 'The image comes back as an ordinary attachment with a fresh log: handle. '
    + 'If you want to keep it, save_blob it: this only puts the picture back within reach, and an '
    + 'attachment you do not save is out of reach again once this leaves your context.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      image_id: {
        type: 'string',
        description: 'Image id from a "[图片 IMG-N …]" line, e.g. IMG-3 (img3 and 3 work too).',
      },
      original: { type: 'boolean', description: 'Return the original GIF instead of the PNG preview.' },
    },
    required: ['image_id'],
  },
};

/** `qq2_image_tag`(标签库在时才有) */
const IMAGE_TAG_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_image_tag',
  description:
    'Give an image that came through QQ a name of your own and one fixed kind, so later copies of the '
    + 'same picture arrive as text you can recognize instead of bytes. The label is keyed by content: '
    + 'every copy with identical bytes shares it. Use it for stickers you want to find again, and for '
    + 'photos/letters/screenshots worth remembering. If you saved the picture with save_blob, pass the '
    + 'mem: handle as saved so the album can point at your copy.',
  tags: ['write'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      image_id: { type: 'string', description: 'Image id from a "[图片 IMG-N …]" line, e.g. IMG-3.' },
      label: { type: 'string', description: 'One short name of your own, e.g. "无语猫" (max 80 characters).' },
      kind: {
        type: 'string',
        enum: [...IMAGE_KIND_IDS],
        description: 'sticker=表情包, photo=合影, letter=信, screenshot=截图, other=其他.',
      },
      saved: {
        type: 'string',
        description: 'Optional mem: handle of the copy you kept in your workspace (from save_blob).',
      },
    },
    required: ['image_id', 'label', 'kind'],
  },
};

/** `qq2_images`(标签库在时才有) */
const IMAGE_LIST_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_images',
  description:
    'List the images you have named, newest label first; filter with a word or a kind. With format="md" '
    + 'you get the lines to write into note/library/表情包.md (the label store stays the source of truth, '
    + 'so regenerate that file instead of editing it by hand). An image you have not named will not be '
    + 'listed; bring it back by its IMG-N with qq2_get_image first.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Match the label, kind, IMG-N or saved path. Omit for all.' },
      kind: {
        type: 'string',
        enum: [...IMAGE_KIND_IDS],
        description: 'Only this kind: sticker=表情包, photo=合影, letter=信, screenshot=截图, other=其他.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many to return. Default 50.' },
      format: {
        type: 'string',
        enum: ['text', 'md'],
        description: 'text (default): one line per image; md: ready to write into note/library/表情包.md.',
      },
    },
    required: [],
  },
};

/** `qq2_view_image`(配了辅助视觉才有) */
const VIEW_IMAGE_DECL: Omit<ToolDef, 'handler'> = {
  name: 'qq2_view_image',
  description: 'Ask the auxiliary vision model a specific question about an image.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      image_id: { type: 'string', description: 'Image id, e.g. IMG-3.' },
      prompt: { type: 'string', description: 'Your question about the image.' },
    },
    required: ['image_id', 'prompt'],
  },
};

/**
 * 历史工具那两条的声明是**框架给的**(`HISTORY_TOOL_DECLS`),这里只改名。
 * `tools()` 里跑的是 `createHistoryTools` 现造的那份 —— 两者出自框架同一个常量,名字与字段不会走偏。
 */
export const QQ2_HISTORY_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> =
  HISTORY_TOOL_DECLS.map((decl) => ({ ...decl, name: renameQqTool(decl.name) }));

/** 全部工具的静态声明,顺序与 `tools()` 一致;定义里的 `describe.tools` 直接取它。 */
export const QQ2_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  MODE_DECL,
  DRAFT_DECL,
  CONFIRM_DECL,
  SAY_DECL,
  ...QQ2_HISTORY_TOOL_DECLS,
  VIEW_IMAGE_DECL,
  GET_IMAGE_DECL,
  IMAGE_TAG_DECL,
  IMAGE_LIST_DECL,
  READ_FILE_DECL,
  GET_ATTACHMENT_DECL,
];

/** `host.pushEvent` 的入参;包装器只改 opts,不动事件本身。 */
type PushedEvent = Parameters<WorldHost['pushEvent']>[0];

/**
 * 包装器在「压缩挡」里要回调 World 的那一下:把这条并进窗口账本。
 * 为什么放在包装层的钩子里而不是各推送点:账本要的正是「过了一遍投递策略、确实
 * 被压下来的那些事件」—— 她自己发出去的回录(显式 deliver:false)不该进来。
 */
export interface ModeAwareHooks {
  onAccumulate?: (event: PushedEvent, conv: NonNullable<ReturnType<typeof convOf>>) => void;
}

/**
 * 把 WorldHost 原样透传,只给 pushEvent 加一层模式策略:带会话的事件按当前模式决定
 * 「投递」「仅落库」或「仅落库 + 进压缩账本」。
 *
 * 为什么包在 host 上、而不是在每个推送点各判一次:模式是这个 World 的**投递总策略**,
 * 一个地方说得清;而推送点有十几处(消息、识图、撤回、入退群、表情、戳、转发、引用补取、
 * 监听变化、收文件/转写),漏一处就是一个「睡觉/压缩时还被叫醒」的洞。
 *
 * 为什么是 Proxy 而不是 `{ ...host, pushEvent }`:host 上有个 getter(`cognition` 每次
 * 访问重新检查 Persona 开关),展开会把它的值在包装那一刻冻住。
 */
export function modeAwareHost(real: WorldHost, modeOf: () => QQMode, hooks: ModeAwareHooks = {}): WorldHost {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'pushEvent') {
        return (event: PushedEvent, options?: PushOptions) => {
          // 调用方显式写的 deliver:false(她自己发出去那条 qq.self 回录)优先,模式不改写它。
          if (options?.deliver === false) return target.pushEvent(event, options);
          const conv = convOf(event);
          const plan = planDelivery(modeOf(), conv, {
            mention: event.meta?.[MENTION_META_KEY] === true,
          });
          if (!plan.deliver) {
            // 压缩挡:先记账,再按「仅落库」交给 core —— 原始事件一条不丢,她要细节能翻历史。
            if (plan.accumulate && conv) hooks.onAccumulate?.(event, conv);
            return target.pushEvent(event, { deliver: false });
          }
          // 专注要把调用方给的 debounce 也换成 flush,所以这里是「plan 覆盖 trigger」而不是
          // 「options 优先」;`PushOptions` 只有 deliver 与 trigger 两项,换掉 trigger 不丢别的。
          if (plan.trigger) return target.pushEvent(event, { trigger: plan.trigger });
          return target.pushEvent(event, options);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}



interface QQWorldConfig {
  wsUrl: string;
  /** 监听的群号集合 */
  groups: number[];
  /** 监听的私聊QQ号集合 */
  privates: number[];
  token: string;
  /** 群聊模式初值;缺省用 DEFAULT_MODE(攒批) */
  mode?: QQMode;
  /** 压缩挡的窗口长度;按引用读,控制台改完下一个窗口生效 */
  digest?: QQDigestConfig;
  /** 发送拆句旋钮(按引用传,热生效);缺省用 SPLIT_DEFAULTS */
  split?: QQSendSplitConfig;
  /** 嗓子旋钮(按引用传,热生效);缺省用 VOICE_DEFAULTS */
  voice?: QQVoiceConfig;
  /** 取图库的旋钮(按引用传,热生效);缺省或 enabled=false 时不建库 */
  images?: QQImagesConfig;
  /** 收进来文件的旋钮(按引用传,热生效);缺省用 FILES_DEFAULTS */
  files?: QQFilesConfig;
  /** 收进来语音的旋钮(按引用传,热生效);缺省用 ASR_DEFAULTS */
  asr?: QQAsrConfig;
  /**
   * 每个群的图片自动挂载开关:返回 false 时该群的新图只给文字、不挂字节。
   * 缺省全挂;私聊不走这个开关(始终挂)。
   */
  attachImages?: (groupId: number) => boolean;
  /** 数据目录;取图库要在这里落盘。缺省则不建库(测试与干装载可以不给) */
  dataDir?: string;
  /** Event rendering timezone. */
  timezone?: string;
  /** 重连退避参数透传(测试用短退避) */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  apiTimeoutMs?: number;
}

/**
 * 「QQ 接入」面板的装配数据面。装配层管理 roster、enabled、持久化与重启；
 * World 管理面板语义和校验。缺少该依赖时 gate/roster 面板不可用。
 */
interface QQGatePanelDeps {
  /** config.worlds.qq2.enabled(当前进程装配态;改它要重启才生效) */
  enabled(): boolean;
  wsUrl(): string;
  /** 是否已配置 access token(只报有无,不回明文) */
  tokenSet(): boolean;
  /** 完整监听名单,包含未进入 World 监听集合的 disabled 条目。 */
  roster(): { groups: QQRosterEntry[]; privates: QQRosterEntry[] };
  /** 整体替换名单并写回 config.json;返回一句结果描述 */
  setRoster(groups: QQRosterEntry[], privates: QQRosterEntry[]): string;
  /** 持久化 worlds.qq.enabled;本身不重启,重启由调用方另行触发 */
  setEnabled(enabled: boolean): void;
  /** 持久化 NapCat 连接(wsUrl + token);token 空串=保持原值不动 */
  setConnection(wsUrl: string, token: string): void;
  /** 落重启标志并让进程退出(启动器重新拉起,回来是暂停态) */
  restart(): void;
}

interface QQWorldDeps {
  vision?: VisionService;
  gate?: QQGatePanelDeps;
  voiceCredential?: { configured(): boolean; save(key: string): void };
  /** 模式变更的持久化回调(装配层写回 `worlds.qq2.mode`);缺省只改运行态。 */
  setMode?: (mode: QQMode) => void;
  /** 压缩周期的持久化回调(装配层写回 `worlds.qq2.digest.minutes`);缺省只改运行态。 */
  setDigestMinutes?: (minutes: number) => void;
  /**
   * 嗓子:文字 → 音频。装配层用 `ctx.secret` + `dataDir` 建一个真的;测试注入替身,
   * 于是「不发一个字节、不花一分钱」也能把 qq2_say 整条路走完。
   */
  say?: (text: string) => Promise<SayResult>;
}

/** 暂存的草稿(单槽,一进一出;不确认到本轮末即作废) */
interface PendingDraft {
  target: Conv;
  text: string;
  /** 引用回复的平台message_id(已从游标解析好) */
  replyMessageId?: number | string;
  /** 要发送的图片的句柄(`log:` 她看见过的 / `mem:` 她收藏的);无=纯文本 */
  imageRef?: string;
}

interface ForwardNode {
  line: string;
  /** 正文(不带发言人前缀),身份塌掉时重新渲染用 */
  body: string;
  /** 协议给了可用的发言人名字(不是空、也不是「QQ用户」占位) */
  named: boolean;
  /**
   * 我们自己插的说明行(「下面这层是转发里又套着的一份转发记录」那种),不是协议里的话。
   * 身份塌掉判定与自身节点补回都要把它们排除掉。
   */
  note?: boolean;
  time?: number;
  userId?: string;
  messageType?: string;
}

/** 转发里登记好编号的一张图:正文给句柄,字节由 lookupForward 在后台取回。 */
interface ForwardImage {
  id: string;
  gif: boolean;
}

/** 一次转发展开里收集的图(以及「超过上限没给编号」的计数)。 */
interface ForwardImageSink {
  images: ForwardImage[];
  skipped: number;
}

export class QQ2World implements World {
  readonly id = 'qq2';

  private readonly cfg: QQWorldConfig;
  private readonly timezone: string;
  private host?: WorldHost;
  private driver?: OneBotDriver;
  private log: Logger = nullLogger();
  private imagePolicy: ImageRenderPolicy = () => '[图片]';

  /** 群聊模式(运行态副本;初值来自配置,她切换时经 setMode 写回) */
  private mode: QQMode;
  private readonly setModeSink?: (mode: QQMode) => void;

  /** 压缩挡的账本与计时器:只在 digest 挡里攒东西,到点结一次账。 */
  private readonly digest = new DigestLedger();
  private digestTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly setDigestMinutesSink?: (minutes: number) => void;

  /** 外挂视觉(注入=auxVLM生效);null=无,一切保持[图片]占位现状 */
  private readonly vision?: VisionService;

  /** 图片标签库(按内容哈希);没有 dataDir 时不建 */
  private readonly labels?: LabelStore;

  /** 每个群的图片自动挂载开关;缺省全挂 */
  private readonly attachImages?: (groupId: number) => boolean;

  /** 嗓子(注入);undefined=没接,qq2_say 会告诉她是哪一步缺的 */
  private readonly say?: (text: string) => Promise<SayResult>;

  /**
   * 取图库(无 VLM 的那半截:下载/落盘/sha256/查重)。
   * **与视觉互斥**:视觉在时它退场,免得同一张图下两次、写两份缓存。
   */
  private readonly images?: ImageLibrary;

  /**
   * 收进来的**文件**(下载/落盘/判文本/按段读)。与取图库不同,它**不挂附件** ——
   * 附件字节每轮重发,文件只把文字递进正文;大文件给编号,她自己按段取。
   */
  private readonly files?: FileLibrary;

  /** 监听集合(可web端热改) */
  private watchedGroups: Set<number>;
  private watchedPrivates: Set<number>;

  /**
   * 已记录的 QQ 消息:平台 message_id → 所在会话与时间(内存索引,启动时从store重建)。
   * QQ 消息身份即平台自身的 message_id,不使用 core 事件游标。
   */
  private knownMessages = new Map<string, { conv: Conv; ts: string }>();
  /** QQ号 → 最近见到的显示名(撤回/入退群/私聊寻址渲染用;同样从store重建) */
  private nameByUserId = new Map<string, string>();

  /** 单槽草稿(起草-确认门) */
  private pendingDraft: PendingDraft | null = null;
  private sendingDraft = false;
  private lastSendReceipt: string | null = null;


  /** 最近一次成功组装的动态账号/会话事实(断线期间沿用；不缓存可编辑固定文本) */
  private cachedDynamicContext?: string;

  /**
   * 消息处理串行链:所有消息严格按到达顺序处理。图片去重预判(precheckDup)
   * 是每条消息内部的异步等待点,不排队会导致连续到达的消息乱序落库。
   */
  private msgChain: Promise<void> = Promise.resolve();

  constructor(cfg: QQWorldConfig, deps?: QQWorldDeps) {
    this.cfg = cfg;
    this.timezone = cfg.timezone ?? 'Asia/Shanghai';
    this.vision = deps?.vision;
    this.gate = deps?.gate;
    this.voiceCredential = deps?.voiceCredential;
    this.say = deps?.say;
    this.setModeSink = deps?.setMode;
    this.setDigestMinutesSink = deps?.setDigestMinutes;
    this.mode = isQQMode(cfg.mode) ? cfg.mode : DEFAULT_MODE;
    this.watchedGroups = new Set(cfg.groups);
    this.watchedPrivates = new Set(cfg.privates);
    this.attachImages = cfg.attachImages;
    // 标签库只住 dataDir 根上,与取图库的 qq-images/ 分开:清空取图库不能把标签一起抹掉。
    if (cfg.dataDir) this.labels = new LabelStore(cfg.dataDir);
    // 取图库要有落盘的地方才建;开了视觉就不建(视觉那条路已经在下载并挂附件)。
    const imagesCfg = cfg.images;
    if (!deps?.vision && imagesCfg?.enabled && cfg.dataDir) {
      this.images = new ImageLibrary({
        dataDir: cfg.dataDir,
        timezone: this.timezone,
        cfg: imagesCfg,
        labelFor: (hash) => this.labels?.formatForMessage(hash) ?? null,
        log: this.log.child('images'),
      });
    }
    // 文件库需要数据目录。库本身总是建(关掉只是不处理段,可以热开关);
    // 「去协议端要下载地址」那一步由 World 提供 —— 私聊走 get_private_file_url、
    // 群走 get_group_file_url,而那时 driver 才有(所以留成闭包,而不是构造时取)。
    if (cfg.dataDir) {
      this.files = new FileLibrary({
        dataDir: cfg.dataDir,
        cfg: cfg.files ?? FILES_DEFAULTS,
        log: this.log.child('files'),
        resolveUrl: (ref) => this.fetchFileUrl(ref),
      });
    }
  }

  /**
   * 按凭据去协议端要下载地址。**这是本 World 唯一认识协议的地方**,文件库那边只当一个黑盒。
   *
   * 两个动作都是**扩展动作**(非 OneBot v11 标准),所以走 `callExtension` —— 它不抛,
   * 失败回 `{ok:false}`,我们据此说一句实话,而不是让整条消息崩掉。
   */
  private async fetchFileUrl(ref: unknown): Promise<string | null> {
    const driver = this.driver;
    if (!driver) return null;
    const r = (ref ?? {}) as { fileId?: string; busid?: number; groupId?: number; isPrivate?: boolean };
    if (!r.fileId) return null;
    const action = r.isPrivate ? 'get_private_file_url' : r.groupId ? 'get_group_file_url' : 'get_private_file_url';
    const params: Record<string, unknown> = r.isPrivate || !r.groupId
      ? { file_id: r.fileId }
      : { group_id: r.groupId, file_id: r.fileId, busid: r.busid ?? 102 };
    const got = await driver.callExtension(action, params);
    if (!got.ok) {
      this.log.warn('取文件地址被拒', { action, err: got.error });
      return null;
    }
    const url = (got.data as { url?: unknown })?.url;
    return typeof url === 'string' && url ? url : null;
  }

  private readonly gate?: QQGatePanelDeps;
  private readonly voiceCredential?: QQWorldDeps['voiceCredential'];

  /** 当前群聊模式(控制台徽标与环境提示词读它)。 */
  currentMode(): QQMode {
    return this.mode;
  }

  /**
   * 切模式。写回配置(装配层给的回调),并落一条日志——这是环境层面的状态变更,
   * 但**不推事件**:推事件本身就要过投递策略,刚切进睡眠那一刻推一条「我睡了」会
   * 走模式判断,而她的回执已经把这件事说给他听了。
   *
   * 离开压缩挡时,已经攒下的那一窗要有个去处:
   * - 切到攒批/专注 → 当场结一次账(这些消息本来就该到她手上只是晚了一点);
   * - 切到睡眠 → 直接丢掉账本,不叫醒她(睡就是不听;原始事件仍在事件库里)。
   */
  setMode(mode: QQMode): QQMode {
    const before = this.mode;
    this.mode = mode;
    this.setModeSink?.(mode);
    if (before === 'digest' && mode !== 'digest') {
      this.clearDigestTimer();
      if (mode === 'sleep') this.digest.reset();
      else void this.settleDigest('debounce');
    }
    this.log.info('群聊模式已切换', { from: before, to: mode });
    return mode;
  }

  /** 当前压缩窗口的分钟数:读配置(控制台与她自己的工具改的是同一处),缺省 10。 */
  currentDigestMinutes(): number {
    const raw = this.cfg.digest?.minutes ?? DIGEST_DEFAULTS.minutes;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DIGEST_DEFAULTS.minutes;
  }

  /**
   * 改压缩周期(保留一位小数),写回配置。
   * **写的是活对象 `cfg.digest`**:装配层的 `persist` 深合并进同一段,于是控制台之后
   * 再改一次仍然算数(两边共用一处真源,不会出现「她调过以后控制台就改不动了」)。
   */
  setDigestMinutes(minutes: number): number {
    const value = Math.round(Math.min(1440, Math.max(0.1, Number(minutes))) * 10) / 10;
    this.cfg.digest = { ...(this.cfg.digest ?? DIGEST_DEFAULTS), minutes: value };
    this.setDigestMinutesSink?.(value);
    // 窗口已经在跑时就按新长度重排;没在跑就什么也不做(等第一条群事件再开窗)。
    this.armDigestTimer();
    this.log.info('压缩周期已调整', { minutes: value });
    return value;
  }

  /**
   * 压缩挡:把过完投递策略的群事件并进账本,并按当前周期排一次结账。
   * 已经开着的窗口不会因为后续消息而延长到「最后一条 + N 分钟」——它从**第一条**
   * 算起,满 N 分钟就结;这样热闹的群也不会一直结不了账。
   */
  private accumulateDigest(event: PushedEvent, conv: Conv): void {
    if (this.mode !== 'digest') return;
    this.digest.push(event, conv);
    this.armDigestTimer();
  }

  /** 窗口到点(或已过期)就排一个零延迟的结账;没有攒东西就不排。 */
  private armDigestTimer(): void {
    if (this.mode !== 'digest' || this.digest.empty) return;
    const due = this.digest.startedAtMs + Math.max(1, Math.round(this.currentDigestMinutes() * 60_000));
    if (this.digestTimer) clearTimeout(this.digestTimer);
    this.digestTimer = setTimeout(() => {
      this.digestTimer = null;
      void this.settleDigest();
    }, Math.max(0, due - Date.now()));
  }

  private clearDigestTimer(): void {
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
  }

  /**
   * 结账:把这一窗折成一份摘要推给她。空账本返回(群里有动静才有摘要)。
   *
   * 摘要事件**不带 meta.conv**:它不是任何一个会话里的一条消息,于是投递策略把它
   * 当普通事件放行;带 conv 的话它会被自己的模式重新压回账本,永远投不出去。
   */
  private async settleDigest(trigger: 'flush' | 'debounce' = 'flush'): Promise<void> {
    this.clearDigestTimer();
    if (this.mode === 'sleep') {
      this.digest.reset();
      return;
    }
    const snapshot = this.digest.take();
    if (!snapshot.entries.length) return;
    const host = this.host;
    if (!host) return;
    const text = renderDigest(snapshot.entries, {
      labelOf: (conv) => this.groupName(conv.id),
      timeOf: (ts) => shortTime(this.timezone, new Date(ts)),
      clock: (ms) => shortTime(this.timezone, new Date(ms)),
      fromMs: snapshot.fromMs,
      toMs: snapshot.toMs,
      droppedOldest: snapshot.droppedOldest,
    });
    try {
      await host.pushEvent(
        {
          type: 'qq.digest',
          ts: nowIso(this.timezone),
          source: EVENT_SOURCE,
          text,
          meta: {
            digest: {
              count: snapshot.entries.length + snapshot.droppedOldest,
              groups: [...new Set(snapshot.entries.map((e) => e.conv.id))],
              minutes: this.currentDigestMinutes(),
            },
          },
        },
        { trigger },
      );
    } catch (e) {
      this.log.warn('压缩摘要投递失败', { err: String(e) });
    }
  }

  /** 被动识图在视觉服务可用时启用；识图描述写入事件库作为可检索记忆。 */
  private passiveEnabled(): boolean {
    return !!this.vision;
  }

  /**
   * 去重预判在消息渲染前就有结果时,直接内联进这条消息(不走占位+异步事件)。
   * meta 来自 VisionService.precheckDup：dup_of 表示命中去重，ok=false 表示下载失败。
   */
  private inlineVisionText(
    id: string,
    gifMark: string,
    meta: Record<string, unknown>,
    label = '图片',
  ): string {
    if (meta.dup_of) {
      const dup = String(meta.dup_of);
      const name = this.visionDuplicateName(id);
      return `[${label} ${id}${gifMark}，与 ${dup} 是同一张图，已识别过;${name};要看用 qq2_get_image("${id}")]`;
    }
    return `[${label} ${id}${gifMark} 识别失败]`;
  }

  /** 异步识图事件里的重复图:英文那句后面补上她自己的标签与取回入口。 */
  private visionDuplicateText(text: string, meta: Record<string, unknown>): string {
    const id = typeof meta.image_id === 'string' ? meta.image_id : '';
    return `${text}\n(${this.visionDuplicateName(id)};要看用 qq2_get_image("${id}"))`;
  }

  private visionDuplicateName(id: string): string {
    const tag = this.labels?.formatForMessage(this.vision?.imageHash(id));
    const name = this.vision?.filename(id);
    return tag ?? (name ? `文件名:${name}` : '还没贴标签');
  }

  /** 这个会话要不要自动把新图挂进上下文。私聊始终挂;群聊看每群开关,缺省挂。 */
  private shouldAttachImages(conv: Conv): boolean {
    if (conv.kind !== 'group') return true;
    return this.attachImages ? this.attachImages(conv.id) : true;
  }


  /** 当前监听集合(web面板读取用) */
  getWatched(): { groups: number[]; privates: number[] } {
    return { groups: [...this.watchedGroups], privates: [...this.watchedPrivates] };
  }

  /**
   * 连接与身份快照(web「QQ 接入」控制台的连接状态卡数据源)。
   * 断线期间 connected=false,但 selfId/群名沿用上次身份;私聊名字随消息填充。
   */
  getConnection(): {
    connected: boolean;
    selfId: number | null;
    nickname: string;
    groups: Array<{ id: number; name: string; card: string }>;
    privates: Array<{ id: number; name: string }>;
  } {
    const idn = this.driver?.identity;
    return {
      connected: this.driver?.connected ?? false,
      selfId: idn?.selfId ?? null,
      nickname: idn?.nickname ?? '',
      groups: [...this.watchedGroups].map((id) => {
        const g = idn?.groups.get(id);
        return { id, name: g?.groupName ?? String(id), card: g?.card ?? '' };
      }),
      privates: [...this.watchedPrivates].map((id) => ({
        id,
        name: this.nameByUserId.get(String(id)) ?? '',
      })),
    };
  }

  /**
   * 热改监听集合(roster 里 enabled 的子集)。新群的身份在下次重连(或已连接时
   * 的后台刷新)时补齐;私聊名字随后续消息自然填充。进入/离开监听的每个 id
   * 各推一条 qq.watch 事件——监听名单变化属于环境事件,不静默修改。
   */
  setWatched(groups: number[], privates: number[]): void {
    const oldGroups = this.watchedGroups;
    const oldPrivates = this.watchedPrivates;
    const newGroups = new Set(groups.filter((g) => Number.isFinite(g)));
    const newPrivates = new Set(privates.filter((p) => Number.isFinite(p)));

    this.watchedGroups = newGroups;
    this.watchedPrivates = newPrivates;
    this.cachedDynamicContext = undefined;
    this.driver?.setGroups([...newGroups]);
    this.log.info('监听配置已更新', {
      groups: [...newGroups],
      privates: [...newPrivates],
    });

    this.announceWatchDiff('group', oldGroups, newGroups);
    this.announceWatchDiff('private', oldPrivates, newPrivates);
  }

  /** 推送监听集合的差集通知:每个进入/离开监听的id各一条qq.watch事件 */
  private announceWatchDiff(kind: 'group' | 'private', before: Set<number>, after: Set<number>): void {
    if (!this.host) return;
    for (const id of after) if (!before.has(id)) this.pushWatchEvent(kind, id, true);
    for (const id of before) if (!after.has(id)) this.pushWatchEvent(kind, id, false);
  }

  private pushWatchEvent(kind: 'group' | 'private', id: number, joined: boolean): void {
    const host = this.host!;
    const label = kind === 'group' ? `群(群号${id})` : `私聊(QQ号${id})`;
    host.pushEvent({
      type: 'qq.watch',
      ts: nowIso(this.timezone),
      source: EVENT_SOURCE,
      text: `[系统] ${label} ${joined ? '已加入监听' : '已从监听移除'}`,
      senderKey: String(id),
      meta: { conv: { kind, id } },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }


  /**
   * 会话清单、自身账号、当前群聊模式(含压缩窗口)几个洞。措辞(含"下面是你正在参与的会话:"那句和
   * 两条降级文案)全在 ENV_PROMPT.md 里,这里只算值。
   *
   * 三态,中间那态是有意的:**掉线时沿用断线前的群名快照**。若把群名换成"未知",
   * 整段前缀内容就变了,前缀缓存全部失效、下一次调用要重新 prefill 一整份 system。
   * 为省这个钱才留着旧快照——别当成可以顺手简化掉的分支。
   *
   * 模式也在这一段里:她得能从环境提示词里看见自己现在在哪一档(否则切了也说不清)。
   * 代价是切模式会让前缀重建一次——模式切换很稀,值得。
   */
  envPromptVars(): Record<string, string> {
    const idn = this.driver?.identity;
    const minutes = this.currentDigestMinutes();
    const mode = this.mode === 'digest'
      ? `${MODE_LABEL.digest}(digest, 每 ${minutes} 分钟一份摘要)`
      : `${MODE_LABEL[this.mode]}(${this.mode})`;
    if (!idn && this.cachedDynamicContext !== undefined) {
      return {
        'qq.conversations': this.cachedDynamicContext,
        'qq.identity': '',
        'qq.mode': mode,
        'qq.digest': String(minutes),
      };
    }
    const lines: string[] = [];
    for (const gid of this.watchedGroups) {
      const g = idn?.groups.get(gid);
      lines.push(
        g
          ? `- 群「${g.groupName}」(群号${gid});你在这个群的昵称是「${g.card}」`
          : `- 群(群号${gid});群信息尚未就绪`,
      );
    }
    if (this.watchedPrivates.size > 0) {
      const names = [...this.watchedPrivates].map((uid) => {
        const n = this.nameByUserId.get(String(uid));
        return n ? `${n}(${uid})` : String(uid);
      });
      lines.push(`- 私聊:${names.join('、')}`);
    }
    const conversations = lines.join('\n');
    if (idn) this.cachedDynamicContext = conversations;
    return {
      'qq.conversations': conversations,
      'qq.identity': idn ? `你的QQ号是${idn.selfId}。` : '',
      'qq.mode': mode,
      'qq.digest': String(minutes),
    };
  }

  /**
   * 控制台里露出什么:连接状态徽标 + 本 World 的三个专用面板 + 视觉旋钮。
   * 控制台不认识 'qq2' 这个 id,它只照这份声明渲染。
   */
  webUi(): WorldWebUiDecl {
    const conn = this.getConnection();
    return {
      // 两条链路各一颗:协议端连着没有、监听名单空不空。
      //
      // 接入门关着 = 灰(拨下来的);开着却连不上协议端 = 红:这个渠道存在的全部意义
      // 就是连着那个协议端,连不上就是她在 QQ 上失联了。名单空着不算故障,但那时候
      // 连着也收不到任何消息——所以它值一颗自己的灯。
      lamps: [
        {
          label: '协议端',
          ...(this.gate?.enabled() === false
            ? { state: 'offline' as const, hint: '接入门关闭' }
            : conn.connected
              ? { state: 'online' as const, hint: conn.nickname || String(conn.selfId ?? '') }
              : { state: 'error' as const, hint: '未连接' }),
        },
        {
          label: '监听',
          ...(conn.groups.length + conn.privates.length > 0
            ? {
                state: 'online' as const,
                hint: `群 ${conn.groups.length} · 私聊 ${conn.privates.length}`,
              }
            : { state: 'offline' as const, hint: '名单为空' }),
        },
      ],
      badges: [
        {
          label: '协议端',
          value: conn.connected ? `已连接 ${conn.nickname || conn.selfId || ''}`.trim() : '未连接',
          tone: conn.connected ? 'on' : 'off',
        },
        { label: '监听', value: `群 ${conn.groups.length} · 私聊 ${conn.privates.length}` },
        {
          label: '群聊模式',
          value: this.mode === 'digest'
            ? `${MODE_LABEL.digest}(digest, ${this.currentDigestMinutes()} 分钟)`
            : `${MODE_LABEL[this.mode]}(${this.mode})`,
          // 睡眠时这颗灯按灰画:不是故障,是它此刻本来就不该看群。
          ...(this.mode === 'sleep' ? { tone: 'off' as const } : {}),
        },
        ...(this.images ? [{ label: '取图', value: `${this.images.imageCount()} 张` }] : []),
        {
          // 语音条:私聊一直可用,群聊那道闸在他手上——徽标把这两句一起说清。
          label: '语音',
          value:
            this.cfg.voice?.enabled === false
              ? '关'
              : this.cfg.voice?.groupEnabled === true
                ? '私聊·群聊'
                : '仅私聊',
          ...(this.cfg.voice?.enabled === false || this.cfg.voice?.groupEnabled !== true
            ? { tone: 'off' as const }
            : {}),
        },
      ],
      // 局部 id 与 src/webui/client.ts 的面板注册对应。
      panels: [
        { id: 'gate', title: '接入门', description: '接入开关、连接状态与 NapCat 地址。' },
        { id: 'voice', title: '语音', getMethods: ['state'] },
        { id: 'roster', title: '监听名单', description: '监听哪些群、哪些私聊;改动热生效。' },
        { id: 'events', title: '事件', description: '事件库里 source=qq 的历史,按会话翻。' },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.qq2.envPrompt',
          title: 'QQ · 环境提示词',
          description: 'QQ 渠道的常驻事实(消息形态、起草确认门、图片、群聊模式)。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            {
              name: 'qq.conversations',
              description: '当前监听的群与私聊清单,每行一条:群名、群号、你在该群的昵称。',
              multiline: true,
            },
            {
              name: 'qq.identity',
              description: '你自己的 QQ 号;未连接协议端时为空(此时用缺省文案)。',
            },
            {
              name: 'qq.mode',
              description: '当前群聊模式,形如「攒批(batch)」;用 qq2_mode 切换。',
            },
            {
              name: 'qq.digest',
              description: '压缩挡的窗口长度(分钟)。攒批/专注/睡眠挡下这个值不影响任何行为。',
            },
          ],
        },
      ],
      config: [QQ_CONFIG_GROUP, QQ_MODE_CONFIG_GROUP, QQ_SEND_CONFIG_GROUP, QQ_VOICE_CONFIG_GROUP, QQ_INBOUND_CONFIG_GROUP],
      // 视觉与取图库互斥,所以那里最多一项;文件库是独立的一项(与图片无关)。
      ...(this.vision || this.images || this.files
        ? {
            storage: [
              ...(this.vision
                ? [this.visionStorage(this.vision)]
                : this.images
                  ? [this.imageStorage(this.images)]
                  : []),
              ...(this.files ? [this.fileStorage(this.files)] : []),
            ],
          }
        : {}),
    };
  }

  /** 文件库的落盘(文件字节 + 登记表)作为可清除存储上报。 */
  private fileStorage(files: FileLibrary): StoragePart {
    return {
      key: 'files',
      label: 'QQ 收到的文件(字节 + 登记表)',
      kind: 'disk',
      location: 'qq-files/',
      note: '文件字节与登记表全部抹除,FILE 编号归零;历史消息里的旧 FILE-N 此后查不到',
      stat: () => `${files.fileCount()}个文件`,
      clear: () => `已清除${files.clear()}个文件的缓存`,
    };
  }

  /** 取图库的落盘(图片字节 + 登记表)作为可清除存储上报。 */
  private imageStorage(images: ImageLibrary): StoragePart {
    return {
      key: 'images',
      label: 'QQ 取图缓存(图片字节 + 哈希登记表)',
      kind: 'disk',
      location: 'qq-images/',
      note: '图片字节与登记表全部抹除,IMG 编号归零;历史消息里的旧 IMG-N 此后查不到',
      stat: () => `${images.imageCount()}张图`,
      clear: () => `已清除${images.clear()}张图的取图缓存`,
    };
  }

  /** 辅助视觉的缓存(图片字节 + 被动描述 + 追问 session)作为可清除存储上报。 */
  private visionStorage(vision: VisionService): StoragePart {
    return {
      key: 'vision',
      label: '外挂视觉缓存(图片+描述+追问session)',
      kind: 'disk',
      location: 'data/vision/',
      note: '图片字节/被动描述/追问轮次全部抹除,IMG计数器归零;历史消息里旧IMG-N此后查不到',
      stat: () => `${vision.imageCount()}张图`,
      clear: () => `已清除${vision.clear()}张图的视觉缓存`,
    };
  }

  /**
   * 面板调用按 (panel, method, args) 透传；panel 为 console() 声明中的局部 id。
   */
  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'gate') return this.invokeGate(method, args);
    if (panel === 'voice') return this.invokeVoice(method, args);
    if (panel === 'roster') return this.invokeRoster(method, args);
    if (panel === 'events') return this.invokeEvents(method, args);
    throw new Error(`未知面板: ${panel}`);
  }

  private invokeVoice(method: string, args: unknown[]): { keyConfigured: boolean } {
    const credential = this.voiceCredential;
    if (!credential) throw new Error('MiniMax 密钥设置不可用。');
    if (method === 'setApiKey') {
      const key = typeof args[0] === 'string' ? args[0].trim() : '';
      // '$' 会被宿主替换现有 .env 行时当成替换指令。
      if (!key || /[^!-~]|\$/.test(key)) throw new Error('请输入有效的 MiniMax API Key。');
      credential.save(key);
    } else if (method !== 'state') {
      throw new Error(`未知面板方法: voice.${method}`);
    }
    return { keyConfigured: credential.configured() };
  }

  /**
   * 会话名字快照(群名/我的群昵称/私聊称呼)。roster 与 events 两个面板都要拿它
   * 把号码渲染成人看得懂的名字,而 `ctx.invoke` 只能打到**本面板**——所以两边
   * 各开一个 `names`,而不是让它们去借 gate 的 `state`。
   */
  private convNames(): {
    groups: Array<{ id: number; name: string; card: string }>;
    privates: Array<{ id: number; name: string }>;
  } {
    const conn = this.getConnection();
    return { groups: conn.groups, privates: conn.privates };
  }

  private async invokeGate(method: string, args: unknown[]): Promise<unknown> {
    const gate = this.gate;
    if (!gate) throw new Error('QQ 接入控制不可用(装配层没提供 gate 数据面)');
    if (method === 'state') {
      const conn = this.getConnection();
      const roster = gate.roster();
      return {
        enabled: gate.enabled(),
        wsUrl: gate.wsUrl(),
        tokenSet: gate.tokenSet(),
        connected: conn.connected,
        selfId: conn.selfId,
        nickname: conn.nickname,
        groups: conn.connected || conn.groups.length > 0
          ? conn.groups
          : enabledRosterIds(roster.groups).map((id) => ({ id, name: String(id), card: '' })),
        privates: conn.connected || conn.privates.length > 0
          ? conn.privates
          : enabledRosterIds(roster.privates).map((id) => ({ id, name: '' })),
      };
    }
    if (method === 'setEnabled') {
      const enabled = args[0];
      if (typeof enabled !== 'boolean') throw new Error('enabled 必须是布尔');
      gate.setEnabled(enabled);
      this.log.warn('QQ 接入开关已改,即将重启', { enabled });
      this.scheduleGateRestart(gate);
      return { ok: true, restarting: true, enabled };
    }
    if (method === 'setConnection') {
      const wsUrl = typeof args[0] === 'string' ? args[0].trim() : '';
      const token = typeof args[1] === 'string' ? args[1] : '';
      if (!/^wss?:\/\/.+/i.test(wsUrl)) throw new Error('wsUrl 必须是 ws:// 或 wss:// 地址');
      gate.setConnection(wsUrl, token);
      this.log.warn('NapCat 连接配置已改,即将重启', { wsUrl, tokenChanged: token !== '' });
      this.scheduleGateRestart(gate);
      return { ok: true, restarting: true };
    }
    throw new Error(`未知面板方法: gate.${method}`);
  }

  /** HTTP 响应冲刷后再写重启标志并退出进程。 */
  private scheduleGateRestart(gate: QQGatePanelDeps): void {
    setTimeout(() => {
      try { gate.restart(); } catch (err) { this.log.error('触发重启失败', { error: String(err) }); }
    }, 300);
  }

  private async invokeRoster(method: string, args: unknown[]): Promise<unknown> {
    // 名字快照不依赖装配层的 gate 数据面:名单读不出来的时候,至少还能显示名字
    if (method === 'names') return this.convNames();
    const gate = this.gate;
    if (!gate) throw new Error('QQ 监听配置不可用(装配层没提供 gate 数据面)');
    if (method === 'get') return gate.roster();
    if (method === 'set') {
      const coerce = (raw: unknown, field: string): QQRosterEntry[] => {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) throw new Error(`${field}必须是数组`);
        const out: QQRosterEntry[] = [];
        const seen = new Set<number>();
        for (const item of raw) {
          if (!item || typeof item !== 'object') throw new Error(`${field}的每一项必须是{id,enabled}对象`);
          const rec = item as Record<string, unknown>;
          const id = Number(rec.id);
          if (!Number.isInteger(id) || id <= 0) {
            throw new Error(`${field}的每一项id必须是>0的整数,收到: ${String(rec.id)}`);
          }
          if (seen.has(id)) throw new Error(`${field}里号码${id}重复`);
          seen.add(id);
          // 群卡上的「看图」勾选框;私聊不认这一格。缺省(旧客户端/旧配置)不写,保持 true。
          const attach = typeof rec.attachImages === 'boolean' ? rec.attachImages : undefined;
          out.push({
            id,
            enabled: rec.enabled !== false,
            ...(field === 'groups' && attach !== undefined ? { attachImages: attach } : {}),
          });
        }
        return out;
      };
      const groups = coerce(args[0], 'groups');
      const privates = coerce(args[1], 'privates');
      const result = gate.setRoster(groups, privates);
      this.log.warn('QQ监听配置已修改', { groups, privates });
      return { ok: true, result, config: gate.roster() };
    }
    throw new Error(`未知面板方法: roster.${method}`);
  }

  /** 事件历史按会话分组(读事件库 source=qq;World 未启动时不可用) */
  private async invokeEvents(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'names') return this.convNames();
    if (method !== 'list') throw new Error(`未知面板方法: events.${method}`);
    const store = this.host?.store;
    if (!store) throw new Error('QQ World 未启动,事件历史不可用');
    const opts = (args[0] ?? {}) as { conv?: unknown; limit?: unknown };
    const all = store.range({ source: EVENT_SOURCE });
    const convMap = new Map<string, { kind: string; id: number; count: number; lastTs: string }>();
    for (const e of all) {
      const c = e.meta?.conv as { kind?: string; id?: number } | undefined;
      if (!c || (c.kind !== 'group' && c.kind !== 'private') || c.id === undefined) continue;
      const key = `${c.kind}:${Number(c.id)}`;
      const cur = convMap.get(key);
      if (cur) { cur.count++; cur.lastTs = e.ts; }
      else convMap.set(key, { kind: c.kind, id: Number(c.id), count: 1, lastTs: e.ts });
    }
    const conversations = [...convMap.values()].sort((a, b) => (a.lastTs < b.lastTs ? 1 : -1));

    const convRaw = typeof opts.conv === 'string' ? opts.conv.trim() : '';
    let events = all;
    const m = convRaw ? /^(group|private):(\d+)$/i.exec(convRaw) : null;
    if (convRaw && !m) {
      events = [];
    } else if (m) {
      const kind = m[1].toLowerCase();
      const id = Number(m[2]);
      events = all.filter((e) => {
        const c = e.meta?.conv as { kind?: string; id?: number } | undefined;
        return !!c && c.kind === kind && Number(c.id) === id;
      });
    }
    const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 300));
    if (events.length > limit) events = events.slice(events.length - limit);
    const lean = events.map((e) => ({
      cursor: e.cursor,
      type: e.type,
      ts: e.ts,
      text: e.text,
      senderKey: e.senderKey,
      senderName: (e.meta?.sender_name as string | undefined) ?? '',
      conv: e.meta?.conv ?? null,
    }));
    return { conversations, events: lean, total: all.length };
  }


  async start(host: WorldHost): Promise<void> {
    // 一切推送都从这层走:群事件按当前模式决定投递还是仅落库(见 modeAwareHost)。
    // 其余 host 成员(store / log / modelFacts / drainPendingEvents…)也经包装透传。
    this.host = modeAwareHost(host, () => this.mode, {
      onAccumulate: (event, conv) => this.accumulateDigest(event, conv),
    });
    this.log = host.log;
    // 主模型支持 image/png 或 World 配置了视觉模型时启用取图。
    this.imagePolicy = makeImagePolicy(!!this.vision || host.modelFacts.accepts('image/png'));
    // 外挂视觉的用量自愿上报进 core 的成本账(不报就在成本页看不到)
    this.vision?.setUsageSink((usage, model) =>
      host.reportUsage(usage, { model, label: 'QQ2World·辅助视觉' }),
    );
    this.rebuildMaps();

    const driver = new OneBotDriver({
      wsUrl: this.cfg.wsUrl,
      groups: [...this.watchedGroups],
      token: this.cfg.token,
      log: this.log.child('driver'),
      reconnectBaseMs: this.cfg.reconnectBaseMs,
      reconnectMaxMs: this.cfg.reconnectMaxMs,
      apiTimeoutMs: this.cfg.apiTimeoutMs,
    });
    this.driver = driver;
    driver.onEvent((ev) => this.handleEvent(ev));
    driver.onReady(() => {
      this.envPromptVars(); // 为副作用调用:趁 identity 在,把群名快照存进缓存
      this.log.info('身份就绪', { context: this.cachedDynamicContext });
    });
    await driver.start();
  }

  async stop(): Promise<void> {
    // 停之前把压缩窗口的计时器撤掉:进程退出时欠着的一个 setTimeout 会把结账推迟到
    // 下一次启动之后,而那时账本已经空了 —— 留着只会是噪音。
    this.clearDigestTimer();
    this.digest.reset();
    await this.driver?.stop();
  }

  /** 测试/联调辅助:等驱动连接并完成身份初始化 */
  waitReady(timeoutMs = 10000): Promise<void> {
    if (!this.driver) return Promise.reject(new Error('World 未启动'));
    return this.driver.waitReady(timeoutMs);
  }

  /** 每轮起点调用:上一轮未确认的草稿作废(起草-确认门的"默认擦除") */
  /** 一轮自然收束:未确认的草稿只在本轮内有效。draft 屏障后紧接的 user 事件仍属同一轮,不在这里作废。 */
  onTurnEnded(): void {
    this.discardPendingDraft();
  }

  discardPendingDraft(): void {
    if (this.pendingDraft) {
      this.log.debug('未确认的草稿已作废');
      this.pendingDraft = null;
    }
  }


  private handleEvent(ev: OneBotEvent): void {
    const host = this.host;
    if (!host) return;

    if (ev.post_type === 'message') {
      if (ev.message_type === 'group' && ev.group_id !== undefined) {
        if (this.watchedGroups.has(Number(ev.group_id))) {
          this.enqueueMessage(ev as unknown as OneBotGroupMessage, {
            kind: 'group',
            id: Number(ev.group_id),
          });
        }
        return;
      }
      if (ev.message_type === 'private' && ev.user_id !== undefined) {
        if (this.watchedPrivates.has(Number(ev.user_id))) {
          this.enqueueMessage(ev as unknown as OneBotGroupMessage, {
            kind: 'private',
            id: Number(ev.user_id),
          });
        }
        return;
      }
      return; // 其他消息类型丢弃
    }

    if (ev.post_type === 'notice') {
      // 群通知仅处理监听中的群;私聊/名单外一律丢弃
      if (ev.group_id === undefined || !this.watchedGroups.has(Number(ev.group_id))) return;
      const gid = Number(ev.group_id);
      switch (ev.notice_type) {
        case 'group_recall':
          this.handleRecall(ev, gid);
          return;
        case 'group_increase':
          this.handleMemberChange(ev, gid, 'join');
          return;
        case 'group_decrease':
          this.handleMemberChange(ev, gid, 'leave');
          return;
        case 'group_msg_emoji_like':
          this.handleEmojiLike(ev, gid);
          return;
        case 'notify':
          if (ev.sub_type === 'poke') this.handlePoke(ev, gid);
          return;
        default:
          return;
      }
    }
    // request(好友/加群请求)/meta_event(心跳)全部丢弃
  }

  /**
   * 入队一条消息:严格按到达顺序处理(见msgChain字段注释)。单条消息内部
   * 出错不冲垮后续消息——记录日志,链继续往下走。
   */
  private enqueueMessage(msg: OneBotGroupMessage, conv: Conv): void {
    this.msgChain = this.msgChain.then(() => this.handleMessage(msg, conv)).catch((e) => {
      this.log.error('消息处理异常', { err: String(e) });
    });
  }

  private async handleMessage(msg: OneBotGroupMessage, conv: Conv): Promise<void> {
    const host = this.host!;
    const idn = this.driver?.identity;
    const selfId = idn?.selfId ?? -1;

    // 自己账号的回声消息丢弃(自己说的话由 confirm(send) 回录 qq.self)
    if (Number(msg.user_id) === selfId) return;

    const senderKey = String(msg.user_id);
    const displayName = msg.sender?.card || msg.sender?.nickname || senderKey;
    this.nameByUserId.set(senderKey, displayName);

    /** 这个会话要不要把新图的字节挂进上下文;重复图无论如何都不挂。 */
    const attachAllowed = this.shouldAttachImages(conv);

    // 图片渲染策略(外挂视觉,群/私聊同处理)。被动开启时,每张图先做一次限时的
    // 内容去重预判(下载+算hash+查重复,不跑VLM);时限内出结果(命中或下载失败)
    // 则直接内联进消息,跳过占位与异步qq.vision事件,否则显示占位符。
    const collected: Array<{ id: string; url: string }> = [];
    const earlyResolved: Array<{ text: string; meta: Record<string, unknown> } | null> = [];
    /** 取图库那条路的结果(与 earlyResolved 对应同一次 renderImage 调用;两者只会用一个) */
    const imageResults: Array<PrecheckResult | null> = [];
    let renderImage: ImageRenderPolicy;
    let renderJsonCard: JsonCardRenderPolicy;
    if (this.vision) {
      const vision = this.vision;
      const passive = this.passiveEnabled();
      const items = (msg.message ?? [])
        .filter((seg) => seg.type === 'image')
        .map((seg) => {
          const data = seg.data ?? {};
          const url = extractImageUrl(data);
          const gif = looksLikeGif(data);
          return { url, gif, id: vision.registerImage(url, { gif, name: extractImageName(data) }) };
        });
      const precheck =
        passive && items.length
          ? await Promise.all(items.map((it) => vision.precheckDup(it.id)))
          : items.map(() => null);

      let idx = 0;
      renderImage = () => {
        const it = items[idx];
        const early = precheck[idx];
        idx++;
        collected.push({ id: it.id, url: it.url });
        earlyResolved.push(early);
        const gifMark = it.gif ? '(GIF)' : '';
        if (early) {
          const text = this.inlineVisionText(it.id, gifMark, early.meta);
          const newAndOk = !early.meta.dup_of && early.meta.ok !== false;
          return !attachAllowed && newAndOk ? withNote(text, attachOffNote(it.id)) : text;
        }
        return passive
          ? `[图片 ${it.id}${gifMark} 正在载入VLM理解中...]`
          : `[图片 ${it.id}${gifMark}]`;
      };

      // JSON 卡片封面复用图片的去重预判与被动识图路径；下载失败由识别失败分支呈现。
      const cardItems = (msg.message ?? [])
        .filter((seg) => seg.type === 'json')
        .map((seg) => {
          const info = parseJsonCard(seg.data ?? {});
          return {
            ...info,
            id: info.previewUrl ? vision.registerImage(info.previewUrl, { gif: false }) : undefined,
          };
        });
      const cardPrecheck =
        passive && cardItems.some((it) => it.id)
          ? await Promise.all(cardItems.map((it) => (it.id ? vision.precheckDup(it.id) : null)))
          : cardItems.map(() => null);

      let cIdx = 0;
      renderJsonCard = () => {
        const it = cardItems[cIdx];
        const early = cardPrecheck[cIdx];
        cIdx++;
        const promptText = it.prompt ? `[分享:${it.prompt}]` : '[json]';
        if (!it.id) return promptText;
        collected.push({ id: it.id, url: it.previewUrl! });
        earlyResolved.push(early);
        if (early) return `${promptText} ${this.inlineVisionText(it.id, '', early.meta, '封面')}`;
        return passive
          ? `${promptText} [封面 ${it.id} 正在载入VLM理解中...]`
          : `${promptText} [封面 ${it.id}]`;
      };
    } else if (this.images) {
      // 取图库那条路(不开辅助视觉:下载、落盘、按原图 SHA-256 查重)。
      const images = this.images;
      const items = (msg.message ?? [])
        .filter((seg) => seg.type === 'image')
        .map((seg) => {
          const data = seg.data ?? {};
          const url = extractImageUrl(data);
          const gif = looksLikeGif(data);
          return { url, gif, id: images.register(url, { gif, name: extractImageName(data) }) };
        });
      // 有时限的取回:时限内做完就把结论内联进这条消息(字节同时作为附件挂上去),
      // 没做完先给占位符,结果作为单独的 qq.image 事件随后到(见下面的收尾块)。
      const early = items.length
        ? await Promise.all(items.map((it) => images.precheckWithin(it.id, this.cfg.images?.waitMs ?? 2500)))
        : [];
      let idx = 0;
      renderImage = () => {
        const it = items[idx];
        const done = early[idx];
        idx++;
        collected.push({ id: it.id, url: it.url });
        imageResults.push(done);
        if (!done) return images.placeholder(it.id, it.gif);
        const newAndOk = !done.record.dupOf && !done.record.failedReason;
        if (attachAllowed && done.preview) return withNote(done.text, GIF_PREVIEW_NOTE);
        return !attachAllowed && newAndOk ? withNote(done.text, attachOffNote(it.id)) : done.text;
      };
      // 分享卡片的封面**不取**:那是链接预览图,不是她要看的东西,不值得占流量与上下文。
      renderJsonCard = (info) =>
        !info.prompt
          ? '[json]'
          : info.previewUrl
            ? `[分享:${info.prompt}]`
            : `[分享:${info.prompt}]`;
    } else {
      renderImage = this.imagePolicy;
      renderJsonCard = (info) =>
        !info.prompt
          ? '[json]'
          : info.previewUrl
            ? `[分享:${info.prompt}] ${this.imagePolicy({ url: info.previewUrl })}`
            : `[分享:${info.prompt}]`;
    }

    const selfName =
      conv.kind === 'group'
        ? idn?.groups.get(conv.id)?.card || idn?.nickname || '你'
        : idn?.nickname || '你';

    const inbound = await this.prepareInboundFiles(msg, conv);
    const asr = this.cfg.asr ?? ASR_DEFAULTS;
    const driver = this.driver;
    const voice = asr.enabled && driver && msg.message?.some((seg) => seg.type === 'record')
      ? transcribeVoice(driver, msg.message_id, asr.timeoutMs)
      : undefined;
    const transcript = voice ? await withTimeout(voice, (this.cfg.files ?? FILES_DEFAULTS).waitMs) : null;

    const { text, mentionedSelf } = renderIncoming(inbound.patched, {
      selfId,
      selfName,
      timezone: this.timezone,
      convLabel: this.convLabel(conv),
      knowsMessage: (mid) => this.knownMessages.has(String(mid)),
      nameOf: (qq) => this.nameByUserId.get(qq),
      renderImage,
      renderJsonCard,
      recordText: voice ? (transcript ?? '[语音 · 正在转写…]') : undefined,
    });

    const when =
      typeof msg.time === 'number' ? new Date(msg.time * 1000) : new Date();
    // 去重预判阶段已经拿到字节的图随这条消息落库(她因此有句柄可以存、可以转发);
    // 还在下载/识别中的图随稍后的 qq.vision 事件落库。
    const blobs: BlobInput[] = [];
    if (this.vision) {
      for (let i = 0; i < collected.length; i++) {
        if (!earlyResolved[i]) continue;
        // 重复图与「本群只看文字」都不交字节;编号还在,要看再 qq2_get_image。
        if (!attachAllowed || earlyResolved[i]!.meta.dup_of) continue;
        const got = await this.vision.getDisplayImage(collected[i].id).catch(() => null);
        if (got) blobs.push(imageAttachment(collected[i].id, got.buffer, got.mime, got.preview));
      }
    } else if (this.images) {
      // 取图库里赶在时限内拿到的字节随这条消息一起落库:她因此有句柄,能存进自己的 blobs/。
      // 同一份文件已经见过、或这个群关掉了自动看图,就不挂字节。
      for (let i = 0; i < collected.length; i += 1) {
        const done = imageResults[i];
        if (!done?.bytes) continue;
        if (!attachAllowed || done.record.dupOf) continue;
        blobs.push(imageAttachment(collected[i].id, done.preview ?? done.bytes,
          done.preview ? 'image/png' : (done.mime ?? 'image/jpeg'), !!done.preview));
      }
    }
    // 私聊照常合批;群里被@立即投递
    const trigger = conv.kind === 'group' && mentionedSelf ? 'flush' as const : 'debounce' as const;
    const env = await host.pushEvent(
      {
        type: 'qq.message',
        ts: nowIso(this.timezone, when),
        source: EVENT_SOURCE,
        text,
        senderKey,
        meta: {
          message_id: msg.message_id,
          user_id: msg.user_id,
          sender_name: displayName,
          conv,
          // 点名说她(@):睡眠模式下它是唯一的唤醒依据(见 modes.ts 的 planDelivery)
          ...(mentionedSelf ? { [MENTION_META_KEY]: true } : {}),
        },
        ...(blobs.length ? { blobs } : {}),
      },
      { trigger },
    );
    this.knownMessages.set(String(msg.message_id), { conv, ts: env.ts });

    // 图片:回填所属消息号,被动识图(理解闭合后作为qq.vision事件延迟到达)。
    // 已经被上面的去重预判内联进消息本身的图,不用再走这条异步路径。
    if (this.vision && collected.length) {
      collected.forEach((img, i) => {
        this.vision!.attachMessage(img.id, msg.message_id);
        if (this.passiveEnabled() && !earlyResolved[i]) {
          this.vision!.startPassive(img.id, (visionText, visionMeta) => {
            const isDup = !!visionMeta.dup_of;
            const attach = attachAllowed && !isDup;
            const text = isDup
              ? this.visionDuplicateText(visionText, visionMeta)
              : attachAllowed || visionMeta.ok === false
                ? visionText
                : withNote(visionText, attachOffNote(img.id));
            const display = attach ? this.vision!.getDisplayImage(img.id).catch(() => null) : Promise.resolve(null);
            void display.then((got) => host.pushEvent({
              type: 'qq.vision',
              ts: nowIso(this.timezone),
              source: EVENT_SOURCE,
              text: got?.preview ? withNote(text, GIF_PREVIEW_NOTE) : text,
              meta: { ...visionMeta, conv },
              ...(got ? { blobs: [imageAttachment(img.id, got.buffer, got.mime, got.preview)] } : {}),
            })).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
          });
        }
      });
    }

    // 取图库:没赶在时限内取回的图,结果作为单独的 qq.image 事件到达。
    // 与视觉那条的 qq.vision 是同一个路子:先让消息本身出去,别让下载拖住投递。
    if (this.images && collected.length) {
      collected.forEach((img, i) => {
        this.images!.attachMessage(img.id, msg.message_id);
        if (imageResults[i]) return;
        void this.images!.resolve(img.id).then((got) => {
          const isDup = !!got.record.dupOf;
          const newAndOk = !isDup && !got.record.failedReason;
          const attach = attachAllowed && !isDup ? (got.preview ?? got.bytes) : undefined;
          const text = attach && got.preview
            ? withNote(got.text, GIF_PREVIEW_NOTE)
            : attachAllowed || !newAndOk ? got.text : withNote(got.text, attachOffNote(img.id));
          return host.pushEvent({
            type: 'qq.image',
            ts: nowIso(this.timezone),
            source: EVENT_SOURCE,
            text,
            meta: { conv, message_id: msg.message_id, image_id: img.id },
            ...(attach
              ? { blobs: [imageAttachment(img.id, attach, got.preview ? 'image/png' : (got.mime ?? 'image/jpeg'), !!got.preview)] }
              : {}),
          });
        }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
      });
    }
    // 引用回复指向的消息不在索引里(未被记录):异步取原文,不阻塞当前投递
    const replySeg = msg.message.find((s) => s.type === 'reply');
    if (replySeg) {
      const rid = String(replySeg.data?.id ?? '');
      if (rid && !this.knownMessages.has(rid)) {
        this.lookupUncapturedReply(rid, conv, msg.message_id);
      }
    }

    // 转发的聊天记录:异步展开内容,不阻塞当前投递(同一套延迟到达风格)
    const forwardSeg = msg.message.find((s) => s.type === 'forward');
    if (forwardSeg) {
      const resId = String(forwardSeg.data?.id ?? '');
      if (resId) this.lookupForward(resId, conv, msg.message_id);
    }

    // 文件/语音**没赶上时限**的:先让消息本身出去,内容稍后作为单独事件到达
    // (与 qq.image / qq.vision 同一个路子;语音那条的措辞里始终带「转写·可能有错」)。
    for (const id of inbound.deferredFiles) {
      const files = this.files;
      if (!files) break;
      void files
        .resolve(id)
        .then((got) =>
          host.pushEvent({
            type: 'qq.file',
            ts: nowIso(this.timezone),
            source: EVENT_SOURCE,
            text: got.rendered,
            meta: { conv, message_id: msg.message_id, file_id: id },
          }),
        )
        .catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
    }
    if (voice && transcript === null) {
      void voice
        .then((got) =>
          host.pushEvent({
            type: 'qq.transcript',
            ts: nowIso(this.timezone),
            source: EVENT_SOURCE,
            text: got,
            meta: { conv, message_id: msg.message_id },
          }),
        )
        .catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
    }
  }

  /** 将文件段换成预览或占位。消息按序处理，慢下载的结果稍后补发。 */
  private async prepareInboundFiles(
    msg: OneBotGroupMessage,
    conv: Conv,
  ): Promise<{ patched: OneBotGroupMessage; deferredFiles: string[] }> {
    const files = this.files;
    const config = this.cfg.files ?? FILES_DEFAULTS;
    const deferredFiles: string[] = [];
    const segments = msg.message ?? [];
    if (!files || !config.enabled || !segments.some((s) => s.type === 'file')) {
      return { patched: msg, deferredFiles };
    }

    const patched: Segment[] = [];
    for (const seg of segments) {
      if (seg.type === 'file') {
        const text = await this.inlineFile(files, conv, seg, deferredFiles, config.waitMs);
        patched.push({ type: 'text', data: { text } });
        continue;
      }
      patched.push(seg);
    }
    return { patched: { ...msg, message: patched }, deferredFiles };
  }

  /** 一条文件的正文那一行;没赶上时限就先占位并把编号记下。 */
  private async inlineFile(
    files: FileLibrary,
    conv: Conv,
    seg: Segment,
    deferred: string[],
    waitMs: number,
  ): Promise<string> {
    const d = (seg.data ?? {}) as Record<string, unknown>;
    const name = String(d.file ?? d.name ?? '').trim();
    const sizeNum = Number(d.file_size);
    const fileId = String(d.file_id ?? '').trim();
    const url = typeof d.url === 'string' && d.url ? d.url : null;
    // 私聊 file 段**段里没有地址**(实测),所以 url 多半是 null,真正取址在 resolve 里做;
    // 群文件有时带 url,那就省一次往返。
    const id = files.register({
      name,
      size: Number.isFinite(sizeNum) && sizeNum >= 0 ? sizeNum : undefined,
      url,
      ref: {
        fileId,
        busid: Number(d.busid) || undefined,
        groupId: conv.kind === 'group' ? conv.id : undefined,
        isPrivate: conv.kind !== 'group',
      },
    });
    const got = await withTimeout(files.resolve(id), waitMs);
    if (got) return got.rendered;
    deferred.push(id);
    const size = Number.isFinite(sizeNum) && sizeNum >= 0 ? formatBytes(sizeNum) : '大小未知';
    return `[文件 ${name || id} · ${size} · ${id} 正在取…]`;
  }

  /**
   * 引用回复的原消息不在 knownMessages 里(可能发生在开始关注这个会话
   * 之前,或跨重启丢失):尽力用标准动作 get_msg 取回原文。取到与否都追加一条
   * 系统事件说明情况;不在当前消息处理里同步等待,避免打乱事件的到达顺序
   * (与被动识图的延迟到达是同一套非阻塞风格)。
   */
  private lookupUncapturedReply(rid: string, conv: Conv, ofMessageId: number | string): void {
    const host = this.host;
    const driver = this.driver;
    if (!host || !driver) return;
    const midNum = Number(rid);
    void driver
      .callApi('get_msg', { message_id: Number.isFinite(midNum) ? midNum : rid })
      .then(
        (data) => {
          const d = data as {
            sender?: { nickname?: string; card?: string; user_id?: number };
            message?: Segment[] | string;
          };
          const uid = d?.sender?.user_id;
          const name = d?.sender?.card || d?.sender?.nickname || (uid !== undefined ? String(uid) : rid);
          const body = typeof d?.message === 'string' ? d.message : renderSegmentsPlain(d?.message ?? []);
          host.pushEvent({
            type: 'qq.reply.uncaptured',
            ts: nowIso(this.timezone),
            source: EVENT_SOURCE,
            text: `[系统] #${ofMessageId} 引用的消息不在你的记录里(未被捕获);查到的原文是 ${name}${uid !== undefined ? `(${uid})` : ''}: ${body}`,
            meta: { conv, message_id: rid },
          }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
        },
        (err) => {
          host.pushEvent({
            type: 'qq.reply.uncaptured',
            ts: nowIso(this.timezone),
            source: EVENT_SOURCE,
            text: `[系统] #${ofMessageId} 引用的消息不在你的记录里(未被捕获),原文也没能取到:${err instanceof Error ? err.message : String(err)}`,
            meta: { conv, message_id: rid },
          }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
        },
      );
  }

  /** 解开 NapCat 记录与 OneBot 标准 node 段这两种外壳,拿到装着字段的那一层。 */
  private unwrapNode(value: unknown): Record<string, unknown> {
    const outer =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    const data = outer.data;
    return outer.type === 'node' && data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : outer;
  }

  /**
   * 转发消息的单个节点(发言人+内容)。
   *
   * 内容段里的 `forward` **不算正文**:节点里只有一张转发卡片时,正文留空,由
   * `expandForwardNodes` 往里走一层摊开(见那里的理由)。
   *
   * 图片段换成**带编号的文字段**(见 `forwardSegment`):否则框架只渲染成 `[图片]`,
   * 她既看不见、也没有句柄去取 —— 他 2026-10-17 报的就是这个。
   */
  private renderForwardNode(value: unknown, sink?: ForwardImageSink): ForwardNode {
    const n = this.unwrapNode(value);
    const sender =
      n.sender !== null && typeof n.sender === 'object'
        ? (n.sender as Record<string, unknown>)
        : {};
    const uidValue = sender.user_id ?? n.user_id;
    const uid =
      typeof uidValue === 'string' || typeof uidValue === 'number'
        ? uidValue
        : undefined;
    const nicknameValue = sender.nickname ?? sender.card ?? n.nickname;
    const nickname =
      typeof nicknameValue === 'string' && nicknameValue && nicknameValue !== PLACEHOLDER_NICKNAME
        ? nicknameValue
        : undefined;
    const isSelf =
      uid !== undefined && String(uid) === String(this.driver?.identity?.selfId);
    const name = isSelf ? '你' : (nickname ?? (uid !== undefined ? String(uid) : '?'));
    const raw = n.content ?? n.message ?? n.raw_message;
    const segs = Array.isArray(raw) ? (raw as Segment[]) : [];
    const body =
      typeof raw === 'string'
        ? raw
        : renderSegmentsPlain(
            segs
              .filter((seg) => seg.type !== 'forward')
              .map((seg) => this.forwardSegment(seg, sink)),
          );
    return {
      line: `${name}${uid !== undefined ? `(${uid})` : ''}: ${body}`,
      body,
      named: isSelf || nickname !== undefined,
      time: typeof n.time === 'number' ? n.time : undefined,
      userId: uid !== undefined ? String(uid) : undefined,
      messageType: typeof n.message_type === 'string' ? n.message_type : undefined,
    };
  }

  /**
   * 转发节点里的一段:图片换成 `[图片 IMG-N]`,别的段原样返回。
   *
   * 为什么只给编号、不挂附件:附件随上下文每轮重发,一份转发十几张图会把她的上下文
   * 压死;编号 + `qq2_get_image` 是按需取(见那条工具的说明)。字节仍会在后台取回来
   * 落进取图库(`prefetchForwardImages`)—— 转发里那些 URL 会过期,等她要时再抓就晚了。
   *
   * 没有取图库/视觉、或已经到单次上限时,保持框架的 `[图片]`:不给她一个取不回来的编号。
   */
  private forwardSegment(seg: Segment, sink?: ForwardImageSink): Segment {
    if (seg.type !== 'image' || !sink) return seg;
    if (sink.images.length >= MAX_FORWARD_IMAGES) {
      sink.skipped += 1;
      return seg;
    }
    const data = (seg.data ?? {}) as Record<string, unknown>;
    const url = extractImageUrl(data);
    if (!url) return seg;
    const gif = looksLikeGif(data);
    const name = extractImageName(data);
    const id = this.images
      ? this.images.register(url, { gif, name })
      : this.vision?.registerImage(url, { gif, name });
    if (!id) return seg;
    sink.images.push({ id, gif });
    return { type: 'text', data: { text: `[图片 ${id}${gif ? '(GIF)' : ''}]` } };
  }

  /**
   * 把转发里登记的图的字节取回来 **存进取图库**(不推事件、不进上下文)。
   * 两个并发就够了:这是后台活,别跟她的正常收发抢带宽。
   */
  private prefetchForwardImages(picked: ForwardImage[]): void {
    const images = this.images;
    if (!images || !picked.length) return;
    const queue = picked.slice();
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        await images.resolve(item.id).catch(() => undefined);
      }
    };
    void Promise.all([worker(), worker()]);
  }

  /**
   * 摊开一条转发记录的节点,**包括里面还套着的转发记录**。
   *
   * 「把一份合并转发再转发出去」在 QQ 里很常见。这时 NapCat 回的外层记录里,每个
   * 节点的内容本身就是一段 `forward` —— 只看节点自己的段,就只能渲染出
   * `[转发消息]`(她 2026-10-15 收到的那次:他转了两份记录,她看到两行空壳)。
   * 好消息是 NapCat 4.18 会把内层内容**内联**在 `forward.data.content` 里,往里走
   * 一层就是真话;没有内联内容的(老版本)留一句说明,别假装展开成功。
   */
  private expandForwardNodes(value: unknown, depth: number, sink?: ForwardImageSink): ForwardNode[] {
    const node = this.renderForwardNode(value, sink);
    const n = this.unwrapNode(value);
    const raw = n.content ?? n.message;
    const nested = Array.isArray(raw)
      ? (raw as Segment[]).filter((seg) => seg.type === 'forward')
      : [];
    if (!nested.length) return [node];
    const out: ForwardNode[] = [];
    // 节点自己除了转发卡片以外还有话(正文+卡片混排)时,照常给一行;没有就整行省掉
    if (node.body) out.push(node);
    for (const seg of nested) {
      const data = (seg.data ?? {}) as Record<string, unknown>;
      const inner = Array.isArray(data.content) ? data.content : [];
      const innerId = String(data.id ?? '');
      const note = (text: string): ForwardNode => ({ line: text, body: text, named: true, note: true });
      if (inner.length && depth < MAX_FORWARD_NEST) {
        out.push(note(`(下面是转发里又套着的一份转发记录,${inner.length} 条)`));
        for (const item of inner) out.push(...this.expandForwardNodes(item, depth + 1, sink));
      } else if (inner.length) {
        out.push(note(`(里面还套着一份转发记录,${inner.length} 条;层级太深,没往里展开)`));
      } else {
        out.push(note(`(里面套着一份转发记录,没能自动展开;id=${innerId})`));
      }
    }
    return out;
  }

  /**
   * NapCat 对「私聊合并转发被转发进群」只提供协议兼容路径:该路径下所有节点的
   * 发言人一律填成转发者本人、昵称落回「QQ用户」占位,身份信息实质丢失。命中时
   * 调用方去掉发言人前缀只留正文,并在标题注明身份未取到,避免把多人对话误读
   * 成一个人的独白。
   */
  private forwardIdentityCollapsed(nodes: ForwardNode[]): boolean {
    const real = nodes.filter((n) => !n.note);
    if (real.length < 2 || real.some((n) => n.named)) return false;
    const ids = new Set(real.map((n) => n.userId));
    return ids.size === 1 && !ids.has(undefined);
  }

  private forwardMessages(data: unknown): unknown[] {
    if (data === null || typeof data !== 'object') return [];
    const response = data as Record<string, unknown>;
    if (Array.isArray(response.messages)) return response.messages;
    return Array.isArray(response.message) ? response.message : [];
  }

  /**
   * NapCat目前会把私聊合并转发中bot自己的节点全部漏掉。事件库已经捕获了这些
   * qq.self消息；只在协议结果完全没有自身节点时，按同一私聊和紧邻时间补回。
   */
  private recoverForwardSelfNodes(nodes: ForwardNode[]): ForwardNode[] {
    const host = this.host;
    const selfId = this.driver?.identity?.selfId;
    // 说明行不是协议里的话,不参与「有没有自身节点」与其后的时间窗判断
    const real = nodes.filter((n) => !n.note);
    if (!host || selfId === undefined || real.some((n) => n.userId === String(selfId))) {
      return [];
    }
    const timed = real.filter(
      (n): n is ForwardNode & { time: number } =>
        n.messageType === 'private' && n.time !== undefined,
    );
    if (timed.length !== real.length || timed.length === 0) return [];
    const peerIds = new Set(
      timed.map((n) => n.userId).filter((id): id is string => Boolean(id)),
    );
    peerIds.delete(String(selfId));
    if (peerIds.size !== 1) return [];
    const peerId = Number([...peerIds][0]);
    if (!Number.isSafeInteger(peerId)) return [];

    const recoveryWindowSeconds = 120;
    const from = Math.min(...timed.map((n) => n.time));
    const to = Math.max(...timed.map((n) => n.time)) + recoveryWindowSeconds;
    return host.store
      .range({
        source: EVENT_SOURCE,
        senderKey: String(selfId),
      })
      .filter(
        (event) =>
          event.type === 'qq.self' &&
          eventInConversation(event, { kind: 'private', id: peerId }) &&
          Date.parse(event.ts) / 1000 >= from &&
          Date.parse(event.ts) / 1000 <= to,
      )
      .filter((event) => {
        const eventTime = Date.parse(event.ts) / 1000;
        return timed.some(
          (node) =>
            eventTime >= node.time &&
            eventTime <= node.time + recoveryWindowSeconds,
        );
      })
      .map((event) => {
        const marker = '] 你: ';
        const markerAt = event.text.indexOf(marker);
        const body = markerAt >= 0 ? event.text.slice(markerAt + marker.length) : event.text;
        return {
          line: `你(${selfId}): ${body} [本地记录补回]`,
          body: `${body} [本地记录补回]`,
          named: true,
          time: Date.parse(event.ts) / 1000,
          userId: String(selfId),
          messageType: 'private',
        };
      });
  }

  /**
   * 转发(合并转发)消息:异步用扩展动作 get_forward_msg 取具体内容,取到与否都
   * 追加一条系统事件;不阻塞当前消息投递(同上,非阻塞延迟到达风格)。
   */
  private lookupForward(resId: string, conv: Conv, ofMessageId: number | string): void {
    const host = this.host;
    const driver = this.driver;
    if (!host || !driver) return;
    void driver.callApi('get_forward_msg', { message_id: resId }).then(
      (data) => {
        const sink: ForwardImageSink = { images: [], skipped: 0 };
        const nodes = this.forwardMessages(data).flatMap((m) => this.expandForwardNodes(m, 0, sink));
        const collapsed = this.forwardIdentityCollapsed(nodes);
        const recovered = this.recoverForwardSelfNodes(nodes);
        const all = [...nodes, ...recovered];
        const shown = all.slice(0, MAX_FORWARD_LINES);
        const lines = shown
          .map((node, order) => ({ node, order }))
          .sort((a, b) =>
            a.node.time !== undefined && b.node.time !== undefined
              ? a.node.time - b.node.time || a.order - b.order
              : a.order - b.order,
          )
          .map(({ node }) => (collapsed && !node.named ? node.body : node.line));
        if (all.length > shown.length) {
          lines.push(`(一共 ${all.length} 条,只列了前 ${shown.length} 条)`);
        }
        if (sink.skipped) {
          lines.push(`(这份转发里还有 ${sink.skipped} 张图没给编号:一次最多 ${MAX_FORWARD_IMAGES} 张)`);
        }
        const body = lines.length ? lines.join('\n') : '(转发记录是空的)';
        const header = collapsed
          ? `[系统] #${ofMessageId} 引用的转发消息展开如下(里面的发言人身份没能取到,可能是多个人在说话):`
          : `[系统] #${ofMessageId} 引用的转发消息展开如下:`;
        host.pushEvent({
          type: 'qq.forward',
          ts: nowIso(this.timezone),
          source: EVENT_SOURCE,
          text: `${header}\n${body}`,
          meta: { conv, forward_id: resId },
        })
          // 正文先出去;图的字节随后在后台取回(编号已给她,要的时候用 qq2_get_image)
          .then(() => this.prefetchForwardImages(sink.images))
          .catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
      },
      (err) => {
        host.pushEvent({
          type: 'qq.forward',
          ts: nowIso(this.timezone),
          source: EVENT_SOURCE,
          text: `[系统] #${ofMessageId} 转发的消息没能展开:${err instanceof Error ? err.message : String(err)}`,
          meta: { conv, forward_id: resId },
        }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
      },
    );
  }

  private handleRecall(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const mid = String(ev.message_id ?? '');
    const t = shortTime(this.timezone);
    const tail = this.knownMessages.has(mid) ? `一条消息(#${mid})` : '一条消息';
    host.pushEvent({
      type: 'qq.recall',
      ts: nowIso(this.timezone),
      source: EVENT_SOURCE,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) 撤回了${tail}`,
      senderKey: userId,
      meta: { message_id: ev.message_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  private handleMemberChange(ev: OneBotEvent, gid: number, kind: 'join' | 'leave'): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const verb = kind === 'join' ? '加入了群' : '退出了群';
    host.pushEvent({
      type: 'qq.member',
      ts: nowIso(this.timezone),
      source: EVENT_SOURCE,
      text: `[${this.convLabel(conv)} 系统] ${name}(${userId})${verb}`,
      senderKey: userId,
      meta: { user_id: ev.user_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  private handleEmojiLike(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const userId = String(ev.user_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const mid = String(ev.message_id ?? '');
    const t = shortTime(this.timezone);
    const tail = this.knownMessages.has(mid) ? `给#${mid}贴了个表情` : '给一条消息贴了个表情';
    host.pushEvent({
      type: 'qq.emoji',
      ts: nowIso(this.timezone),
      source: EVENT_SOURCE,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) ${tail}`,
      senderKey: userId,
      meta: { message_id: ev.message_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  /**
   * 尽力从NapCat戳一戳notify的raw_info里拼出动作文案(如"戳了戳"/"拍了拍");
   * 不同协议端/版本这个字段形状不保证,取不到就退回通用"戳了戳"(防御性解析)。
   */
  private extractPokeAction(rawInfo: unknown): string {
    if (Array.isArray(rawInfo)) {
      const texts = rawInfo
        .map((seg) => (seg && typeof seg === 'object' ? (seg as Record<string, unknown>).txt : undefined))
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      if (texts.length > 0) return texts.join('').trim();
    }
    return '戳了戳';
  }

  private handlePoke(ev: OneBotEvent, gid: number): void {
    const host = this.host!;
    const conv: Conv = { kind: 'group', id: gid };
    const idn = this.driver?.identity;
    const selfId = idn?.selfId ?? -1;
    const userId = String(ev.user_id ?? '');
    const targetId = String(ev.target_id ?? '');
    const name = this.nameByUserId.get(userId) ?? userId;
    const targetLabel =
      Number(targetId) === selfId
        ? `${idn?.nickname ?? '你'}(你)`
        : `${this.nameByUserId.get(targetId) ?? targetId}(${targetId})`;
    const action = this.extractPokeAction(ev.raw_info);
    const t = shortTime(this.timezone);
    host.pushEvent({
      type: 'qq.poke',
      ts: nowIso(this.timezone),
      source: EVENT_SOURCE,
      text: `[${this.convLabel(conv)} ${t}] ${name}(${userId}) ${action} ${targetLabel}`,
      senderKey: userId,
      meta: { user_id: ev.user_id, conv },
    }).catch((e) => host.log.warn('事件投递失败', { err: String(e) }));
  }

  /** 启动时从事件库meta重建 已记录消息索引 与 QQ号→称呼 映射 */
  private rebuildMaps(): void {
    const host = this.host!;
    const events = host.store.range({ source: EVENT_SOURCE });
    for (const e of events) {
      const mid = e.meta?.message_id;
      const conv = e.meta?.conv as Conv | undefined;
      if (mid !== undefined && conv && (conv.kind === 'group' || conv.kind === 'private')) {
        this.knownMessages.set(String(mid), {
          conv: { kind: conv.kind, id: Number(conv.id) },
          ts: e.ts,
        });
      }
      const uid = e.meta?.user_id;
      const name = e.meta?.sender_name;
      if (uid !== undefined && typeof name === 'string') {
        this.nameByUserId.set(String(uid), name);
      }
    }
    this.log.debug('映射重建完成', {
      messages: this.knownMessages.size,
      names: this.nameByUserId.size,
    });
  }


  private groupName(gid: number): string {
    return this.driver?.identity?.groups.get(gid)?.groupName ?? String(gid);
  }

  private convLabel(conv: Conv): string {
    return conv.kind === 'group' ? `群「${this.groupName(conv.id)}」` : '私聊';
  }

  private targetDesc(t: Conv): string {
    if (t.kind === 'group') return `群「${this.groupName(t.id)}」`;
    const n = this.nameByUserId.get(String(t.id));
    return n ? `私聊 ${n}` : `私聊 ${t.id}`;
  }

  /**
   * 解析发送目标:显式 to("group:群号"/"private:QQ号",数字寻址,不支持按群名/好友
   * 名匹配——昵称/群名可被随意改,QQ号才是稳定标识),或 to 省略时从 reply_to 引用
   * 的消息推断其所在会话(查 World 自己的消息索引,不经事件库)。
   */
  private resolveTarget(
    toArg: string | undefined,
    replyToMessageId: string | undefined,
  ): Conv | { error: string } {
    if (!toArg && replyToMessageId !== undefined) {
      const known = this.knownMessages.get(replyToMessageId);
      if (known) {
        const t = known.conv;
        // 会话可能已被移出监听名单,不能再往里发
        const watched =
          t.kind === 'group' ? this.watchedGroups.has(t.id) : this.watchedPrivates.has(t.id);
        if (!watched) {
          return { error: `the conversation of #${replyToMessageId} is no longer on the watch list` };
        }
        return t;
      }
      return { error: `no conversation found for #${replyToMessageId}; specify a recipient with to` };
    }
    if (!toArg) {
      return { error: 'specify a recipient: to="group:<id>" or "private:<id>", or use reply_to' };
    }
    const s = toArg.trim();
    const target = parseConversationAddress(s);
    if (target?.kind === 'group') {
      if (!this.watchedGroups.has(target.id)) {
        return { error: `group ${target.id} is not on the watch list` };
      }
      return target;
    }
    if (target?.kind === 'private') {
      if (!this.watchedPrivates.has(target.id)) {
        return { error: `QQ ${target.id} is not on the private watch list` };
      }
      return target;
    }
    return { error: `"${s}" is not a valid target; use to="group:<id>" or "private:<id>" (numeric QQ group/user id, not a name)` };
  }

  /**
   * 校验 reply_to 的平台 message_id 已被记录;是则原样用于引用回复。
   * 消息行首的 `#<message_id>` 直接表示该平台标识。
   */
  private resolveReplyMessageId(replyTo: unknown): { mid?: string } | { error: string } {
    if (replyTo === undefined || replyTo === null || replyTo === '') return {};
    const mid = String(replyTo).trim().replace(/^#/, '');
    if (!this.knownMessages.has(mid)) {
      return { error: `no recorded QQ message with id #${mid}; cannot quote-reply` };
    }
    return { mid };
  }

  /**
   * 实际发送到目标会话。正文先按 `src/split.ts` 拆句,逐条发出(条与条之间留间隔);
   * 只有图没有正文时就是一条。引用与图片只挂首条——每句都挂一次引用会刷屏。
   *
   * **语音条是另一回事**:它是**独立的一条消息**(OneBot 的 `record` 段,不带文字/图片/引用),
   * 所以给了 `voice` 就只发它一条,拆句不参与。
   *
   * 「分批发」这件事以前靠她自己记(他嘱咐过很多次,一次重启就没了),现在由这里机械执行:
   * 她照旧写一整段草稿。
   *
   * 回录按**每条**一条 `qq.self` 事件,各带自己的平台消息号:她以后能引用其中任何一条,
   * 历史里看到的也是她真正发出去的样子,而不是把一段压成一条。
   *
   * 仅发送前未连接/桥明确拒绝允许首条重试。超时、断线都不能证明没发出去。
   * 未拿到消息号就停下后续分条；回录失败也不能把桥确认降格成发送失败。
   */
  private async sendToTarget(
    target: Conv,
    opts: {
      text: string;
      replyMessageId?: number | string;
      imageRef?: string;
      imageBytes?: Uint8Array;
      imageMime?: string;
      /** 语音条:字节 + (可选)它已有的句柄(句柄只影响回录时怎么记) */
      voice?: { bytes: Uint8Array; mime: string; ref?: string };
    },
  ): Promise<string> {
    return (await this.sendParts(target, opts)).receipt;
  }

  /** 发送的实现,连同**每一条的平台消息号**一起回(`qq2_say` 要按条报给她)。 */
  private async sendParts(
    target: Conv,
    opts: {
      text: string;
      replyMessageId?: number | string;
      imageRef?: string;
      imageBytes?: Uint8Array;
      imageMime?: string;
      voice?: { bytes: Uint8Array; mime: string; ref?: string };
    },
  ): Promise<SendResult> {
    const host = this.host!;
    const driver = this.driver!;
    let imageBase64: string | undefined;
    if (opts.imageBytes) {
      imageBase64 = Buffer.from(opts.imageBytes).toString('base64');
    }

    const splitCfg = this.cfg.split;
    const chunks =
      splitCfg?.enabled === false
        ? (opts.text.trim() ? [opts.text] : [])
        : splitForSending(opts.text, { maxChunks: splitCfg?.maxChunks ?? SPLIT_DEFAULTS.maxChunks });
    const parts: Array<{ text: string; image: boolean; reply: boolean; voice: boolean }> = opts.voice
      ? [{ text: '', image: false, reply: false, voice: true }]
      : chunks.length
        ? chunks.map((text, i) => ({ text, image: i === 0 && !!imageBase64, reply: i === 0, voice: false }))
        : [{ text: '', image: !!imageBase64, reply: true, voice: false }];
    const intervalMs = Math.max(0, splitCfg?.intervalMs ?? SPLIT_DEFAULTS.intervalMs);
    const action = target.kind === 'group' ? 'send_group_msg' : 'send_private_msg';

    const sentIds: string[] = [];
    const recordWarnings: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (i > 0 && intervalMs > 0) await delay(intervalMs);
      const message = buildOutgoing({
        text: part.text,
        reply_to_message_id: part.reply ? opts.replyMessageId : undefined,
        image_base64: part.image ? imageBase64 : undefined,
        ...(part.voice && opts.voice ? { record_base64: Buffer.from(opts.voice.bytes).toString('base64') } : {}),
      });
      const params =
        target.kind === 'group' ? { group_id: target.id, message } : { user_id: target.id, message };
      let data: { message_id?: number | string };
      try {
        data = (await driver.callApi(action, params, SEND_TIMEOUT_MS)) as typeof data;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        const failed = definitelyNotSent(e);
        if (failed && i === 0) throw e;
        return {
          state: failed ? 'failed' : 'unknown',
          receipt:
            `[${failed ? '发送失败' : '未知'} → ${this.targetDesc(target)}] 第 ${i + 1}/${parts.length} 条${failed ? '被拒绝或未提交' : '结果未知，可能已经送达'}: ${why}\n`
            + `桥确认: ${sentIds.join(' ') || '无'}；后续 ${parts.length - i - 1} 条未提交。\n`
            + (failed ? '别重发整份草稿；核对后仅补未提交的部分。' : '没有自动重试；别重发，也别换成语音或文字再发同样内容。先核对 QQ 实际聊天记录；本地历史缺失不能证明未送达。')
            + recordWarnings.join(''),
          ids: sentIds,
        };
      }
      const messageId = data?.message_id;
      if (!(typeof messageId === 'number' && Number.isFinite(messageId))
        && !(typeof messageId === 'string' && /^-?\d+$/.test(messageId))) {
        return {
          state: 'queued', ids: sentIds,
          receipt: `[已入队 → ${this.targetDesc(target)}] 第 ${i + 1}/${parts.length} 条桥已受理，但未返回消息号，尚未确认发送完成。\n`
            + `桥确认: ${sentIds.join(' ') || '无'}；后续 ${parts.length - i - 1} 条未提交。别重发；先核对 QQ 实际聊天记录。`
            + recordWarnings.join(''),
        };
      }
      sentIds.push(`#${messageId}`);

      // 回录正文:文字 + (如有)图片/语音标记,保证自己发的图与语音在历史里也可见。
      // 行首保留平台消息号,使历史查询结果可引用自身消息。
      const imgMark = part.image && opts.imageRef ? `[图片: ${opts.imageRef}]` : '';
      const voiceMark = part.voice ? `[语音${opts.voice?.ref ? `: ${opts.voice.ref}` : ''}]` : '';
      const selfBody = [part.text, imgMark, voiceMark].filter(Boolean).join(' ');
      const idTag = messageId !== undefined ? `#${messageId} ` : '';
      try {
        const env = await host.pushEvent(
          {
            type: 'qq.self',
            ts: nowIso(this.timezone),
            source: EVENT_SOURCE,
            text: `${idTag}[${this.convLabel(target)} ${shortTime(this.timezone)}] 你: ${selfBody}`,
            // 发出去的附件按句柄或字节附在自己这条记录上:时间线与吃图的模型都看得到发了什么。
            // 语音是**新合成的字节**(没有现成句柄),就按字节附——core 落成 log: 句柄,她以后能取回。
            ...(part.image && opts.imageBytes && parseImageId(opts.imageRef ?? '')
              ? { blobs: [{ bytes: opts.imageBytes, mime: opts.imageMime ?? 'image/jpeg', fallbackText: '你发出的图片' }] }
              : part.image && opts.imageRef
                ? { blobs: [{ handle: opts.imageRef, fallbackText: '你发出的图片' }] }
                : part.voice && opts.voice
                  ? {
                      blobs: [
                        opts.voice.ref
                          ? { handle: opts.voice.ref, fallbackText: '你发出的语音' }
                          : { bytes: opts.voice.bytes, mime: opts.voice.mime, fallbackText: '你发出的语音' },
                      ],
                    }
                  : {}),
            senderKey: String(driver.identity?.selfId ?? 'self'),
            meta: {
              message_id: messageId,
              user_id: driver.identity?.selfId,
              sender_name: driver.identity?.nickname,
              conv: target,
            },
          },
          { deliver: false },
        );
        // 自己发出去的也进索引:可以引用回复自己刚说过的话
        if (messageId !== undefined) {
          this.knownMessages.set(String(messageId), { conv: target, ts: env.ts });
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        recordWarnings.push(`\n#${messageId} 桥已确认，但本地回录失败: ${why}。别重发。`);
        this.log.warn('QQ 桥已确认，本地回录失败', { messageId, error: why });
      }
    }
    // 语音那条路每次只发一条(多句由 qq2_say 自己分条循环),所以这里最多是「拆 N 条」。
    const barNote = parts[0]?.voice ? '(语音)' : parts.length > 1 ? `(拆 ${parts.length} 条)` : '';
    return {
      state: 'confirmed',
      receipt: `[桥确认 ${sentIds.join(' ')} → ${this.targetDesc(target)}${barNote}] 桥已返回消息号，不代表对方已读。${recordWarnings.join('')}`,
      ids: sentIds,
    };
  }


  /**
   * 工具名一律 `qq2_` 起头。内建 qq World 的 `qq_draft`/`qq_confirm`/`qq_read_history`/
   * `qq_grep_history`/`qq_view_image` 已占用这些名字,而 `check:extension` 是拿**全部内建
   * World 的工具名**做重名检查的(`scripts/extension-check.ts` 的 `collectToolNames`),
   * 撞名的包装不上。历史工具那份是框架给的(不抄 209 行),创建后只改名。
   *
   * 每个工具的名字/描述/参数/标签只有一份,在上面的 `*_DECL` 里;这里只补 handler。
   * `describe.tools` 取 `QQ2_TOOL_DECLS`,下面的 if 决定它此刻返回哪一个子集 —— **改这里的
   * 条件就要同时改 describe 里列的那些名字**,否则 `check:extension` 会说漏了工具。
   */
  tools(): ToolDef[] {
    // 0.2.0 起框架那份历史工具多要两项:时间参数按本地时区读、以及 `#编号 → 首次见到的时刻`。
    const history = createHistoryTools({
      source: EVENT_SOURCE,
      host: () => this.host,
      messageTs: (mid) => this.knownMessages.get(mid)?.ts,
      timezone: this.timezone,
    })
      .map((tool) => ({ ...tool, name: renameQqTool(tool.name) }));
    const list = [
      this.modeTool(),
      this.draftTool(),
      this.confirmTool(),
      this.sayTool(),
      ...history,
    ];
    // 看图追问依赖 IMG-N(外挂视觉),随视觉出现/消失
    if (this.vision) list.push(this.viewImageTool());
    // 按编号取回旧图:两条路各自有取字节的能力,哪条在就挂哪条;都不在就不摆这个工具
    if (this.vision || this.images) {
      list.push(this.getImageTool());
      // 标签库要有图才谈得上贴标签;没有 dataDir 时整个标签库不建。
      if (this.labels) list.push(this.imageTagTool(), this.imagesTool());
    }
    // 读文件只有文件库在时才有意义(它也是「够不着盘上那个目录」的补丁)
    if (this.files) list.push(this.readFileTool());
    if (this.files || this.images || this.vision) list.push(this.getAttachmentTool());
    return list;
  }

  /**
   * 群聊模式开关。四态,全局一套,只作用于群会话;写回配置,重启后仍在同一档。
   * 回执里把这一档的规矩当场说给她——她能选的只是档位,得同时知道这个档位意味着什么。
   * 压缩挡还多一个 `minutes`:她可以顺手把窗口改掉(与模式一起写回配置)。
   */
  private modeTool(): ToolDef {
    return {
      ...MODE_DECL,
      handler: async (args) => {
        const mode = args.mode;
        if (!isQQMode(mode)) return `[bad input] mode must be one of ${QQ_MODES.join(', ')}`;
        const rawMinutes = args.minutes;
        if (rawMinutes !== undefined) {
          const n = Number(rawMinutes);
          if (!Number.isFinite(n) || n <= 0 || n > 1440) {
            return '[bad input] minutes must be a positive number of minutes (up to 1440)';
          }
          this.setDigestMinutes(n);
        }
        this.setMode(mode);
        const period = `现在每 ${this.currentDigestMinutes()} 分钟结一次账。`;
        return `[mode → ${MODE_LABEL[mode]}(${mode})] ${MODE_RECEIPT[mode]}`
          + `${mode === 'digest' || rawMinutes !== undefined ? ` ${period}` : ''}`;
      },
    };
  }

  private draftTool(): ToolDef {
    return {
      ...DRAFT_DECL,
      handler: async (args, ctx) => {
        const host = this.host;
        const driver = this.driver;
        if (!host || !driver) return '[tool failed] QQ module not started';
        if (this.sendingDraft) return '[已入队] 上一份草稿正在发送，尚未拿到最终回执；别重发，等待原调用返回。';
        const rawText = typeof args.text === 'string' ? args.text : '';
        const imageArg =
          typeof args.image === 'string' && args.image.trim() ? args.image.trim() : undefined;
        if (!rawText.trim() && !imageArg) return '[bad input] provide at least one of text or image';
        // 纯空白正文视为不带字(避免只发图时混进一个空白 text 段)
        const text = rawText.trim() ? rawText : '';

        const toArg = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined;
        const replyToId =
          args.reply_to !== undefined && args.reply_to !== null && String(args.reply_to) !== ''
            ? String(args.reply_to).trim().replace(/^#/, '')
            : undefined;

        const target = this.resolveTarget(toArg, replyToId);
        if ('error' in target) return `[send failed] ${target.error}`;

        const rep = this.resolveReplyMessageId(args.reply_to);
        if ('error' in rep) return `[send failed] ${rep.error}`;

        // 引用回复必须与发送目标同会话(否则 reply 段带的是别会话的 message_id)
        if (replyToId !== undefined) {
          const replyConv = this.knownMessages.get(replyToId)?.conv;
          if (replyConv && !sameConversation(replyConv, target)) {
            return `[send failed] #${replyToId} is not in ${this.targetDesc(target)}; cannot quote-reply across conversations`;
          }
        }

        // 图片:句柄走 host.blob;IMG-N 走图片库/视觉缓存。都当场确认取得到,
        // 并用字节内容弹出已有的识别描述作为 preview(省一次 qq2_view_image)。
        let imageRef: string | undefined;
        let previewLine = '';
        if (imageArg) {
          const imgId = parseImageId(imageArg);
          if (imgId) {
            const got = await this.readStoredImage(imgId);
            if (!got) return `[send failed] ${imageNotFound(imgId)}`;
            if (!got.mime.startsWith('image/')) return `[send failed] ${imgId} is ${got.mime}, not an image`;
            imageRef = imgId;
            const desc = this.vision?.descriptionByHash(createHash('sha256').update(got.bytes).digest('hex'));
            previewLine = desc
              ? `[will send image: ${imgId} — cached description: ${desc}]`
              : `[will send image: ${imgId}]`;
          } else {
            const got = host.blob(imageArg);
            if (!got) return `[send failed] no blob for ${imageArg}; use an IMG-N, a log: handle from a [blob ...] line, or a mem: handle from your workspace`;
            if (!got.mime.startsWith('image/')) return `[send failed] ${imageArg} is ${got.mime}, not an image`;
            imageRef = imageArg;
            const desc = this.vision?.descriptionByHash(createHash('sha256').update(got.bytes).digest('hex'));
            previewLine = desc
              ? `[will send image: ${imageArg} — cached description: ${desc}]`
              : `[will send image: ${imageArg}]`;
          }
        }

        this.pendingDraft = { target, text, replyMessageId: rep.mid, imageRef };
        this.lastSendReceipt = null;

        // 排出当下已积、尚未投递的QQ会话事件(consume-once)。正文不能伪装成
        // draft 工具结果:交回 loop 按常规投递,本轮下一次推理前它们就在眼前,
        // 要不要据此改口由 agent 决定。
        const drained = await host.drainPendingEvents((e) => e.source === EVENT_SOURCE);
        ctx.queueExternalEvents?.(drained);

        const lines = [`[draft staged → ${this.targetDesc(target)}]`];
        lines.push(text.trim() ? `Text: ${text}` : '(image only, no text)');
        if (previewLine) lines.push(previewLine);
        lines.push(
          '',
          drained.length > 0
            ? `${drained.length} message(s) arrived while staging; they are queued for delivery.`
            : 'No messages arrived while staging.',
          'Review once, then call confirm(decision="send") to send or confirm(decision="cancel") to discard. An unconfirmed draft is dropped at end of turn.',
        );
        return lines.join('\n');
      },
    };
  }

  private confirmTool(): ToolDef {
    return {
      ...CONFIRM_DECL,
      handler: async (args) => {
        const host = this.host;
        const driver = this.driver;
        if (!host || !driver) return '[tool failed] QQ module not started';
        if (this.sendingDraft) return '[已入队] 草稿正在发送，尚未拿到最终回执；未重复提交，不能撤回在途发送。';
        const draft = this.pendingDraft;
        if (!draft) return this.lastSendReceipt
          ? `${this.lastSendReceipt}\n[no draft to confirm; 上次回执，未重复提交]`
          : '[no draft to confirm; draft one first]';

        if (args.decision === 'cancel') {
          this.pendingDraft = null;
          return `[draft discarded (${this.targetDesc(draft.target)})]`;
        }
        if (args.decision === 'send') {
          this.sendingDraft = true;
          try {
            // 发送时才把字节取回来(草稿只记引用;取消的草稿一次都不读)
            let imageBytes: Uint8Array | undefined;
            let imageMime: string | undefined;
            if (draft.imageRef) {
              const imgId = parseImageId(draft.imageRef);
              if (imgId) {
                const got = await this.readStoredImage(imgId);
                if (!got) return `[send failed] ${imageNotFound(imgId)} (draft kept)`;
                imageBytes = got.bytes;
                imageMime = got.mime;
              } else {
                const got = host.blob(draft.imageRef);
                if (!got) return `[send failed] blob ${draft.imageRef} is gone (draft kept)`;
                imageBytes = got.bytes;
                imageMime = got.mime;
              }
            }
            const receipt = await this.sendToTarget(draft.target, {
              text: draft.text,
              replyMessageId: draft.replyMessageId,
              imageRef: draft.imageRef,
              imageBytes,
              imageMime,
            });
            if (this.pendingDraft === draft) this.pendingDraft = null;
            this.lastSendReceipt = receipt;
            return receipt;
          } catch (e) {
            return `[send failed] ${e instanceof Error ? e.message : String(e)} (draft kept; confirm again to retry or cancel)`;
          } finally {
            this.sendingDraft = false;
          }
        }
        return '[bad input] decision must be send or cancel';
      },
    };
  }

  /**
   * 说话(`qq2_say`):把一段话念成**语音条**发出去。
   *
   * 三条边界写死在代码里,不靠她记:
   * - **发不发由她决定**——这个工具只有她主动调才出声,没有「自动念」这种东西;
   * - **群里能不能发由他决定**——`voice.groupEnabled` 关着时群里直接回绝(私聊不受影响);
   * - **长话最多念 `maxBars` 条**(默认 2):先按句子切;装不下就回绝并让她改用文字
   *   (不硬切词,也不假装念了)。
   *
   * 每条语音单发一条消息(语音条不能带文字/图片/引用);回执按条报出平台消息号,
   * 并把音频按字节交回给她(core 落成 `log:` 句柄)——她以后想再发同一条就有句柄了。
   */
  private sayTool(): ToolDef {
    return {
      ...SAY_DECL,
      handler: async (args) => {
        const host = this.host;
        const driver = this.driver;
        if (!host || !driver) return '[tool failed] QQ module not started';

        const cfg = this.cfg.voice;
        if (cfg?.enabled === false) {
          return '[voice off] 语音开关关着(worlds.qq2.voice.enabled),他说了才算。先用 qq2_draft 发文字。';
        }
        const text = String(args.text ?? '').trim();
        if (!text) return '[bad input] text 不能为空';

        const toArg = typeof args.to === 'string' && args.to.trim() ? args.to.trim() : undefined;
        const target = this.resolveTarget(toArg, undefined);
        if ('error' in target) return `[send failed] ${target.error}`;

        // 群聊那道硬开关是他的:关着时她连试都不必试,回执要说得像人话,别像报错。
        if (target.kind === 'group' && cfg?.groupEnabled !== true) {
          return '群里发语音他还没打开(控制台的「QQ · 语音 → 允许在群聊里发语音」)。'
            + '私聊可以发;群里先用 qq2_draft 发文字。';
        }
        if (!this.say) {
          return '[tool failed] 这个部署没有接上嗓子(装配时没建合成器);先用 qq2_draft 发文字。';
        }

        const plan = planVoiceBars(text, {
          maxCharsPerBar: cfg?.maxCharsPerBar ?? VOICE_DEFAULTS.maxCharsPerBar,
          maxBars: cfg?.maxBars ?? VOICE_DEFAULTS.maxBars,
        });
        if ('tooLong' in plan) return `[not spoken] ${plan.tooLong}`;

        const blobs: BlobInput[] = [];
        const receipts: string[] = [];
        const ids: string[] = [];
        let spokenMs = 0;
        for (let i = 0; i < plan.bars.length; i += 1) {
          const bar = plan.bars[i]!;
          const made = await this.say(bar);
          if (!made.ok) {
            // 回执是给她看的;这一行是给他查的(合成层拿不到 World 的 logger,在这里补)。
            this.log.warn('语音合成没成', { kind: made.kind, detail: made.detail, chars: billableChars(bar) });
            if (i === 0) return `[not spoken] ${made.error}`;
            // 第一条已经出去了:不重发、不假装,如实说哪条没出来。
            return `[spoken${ids.length ? ` ${ids.join(' ')}` : ''} → ${this.targetDesc(target)},`
              + ` 第 ${i + 1}/${plan.bars.length} 条没合成出来: ${made.error}]\n`
              + '已经发出去的那条别重发;剩下的改用文字发。';
          }
          try {
            const sent = await this.sendParts(target, {
              text: '',
              voice: { bytes: made.bytes, mime: made.mime },
            });
            receipts.push(sent.receipt);
            ids.push(...sent.ids);
            if (sent.state !== 'confirmed') {
              return `${receipts.join('\n')}\n后续 ${plan.bars.length - i - 1} 条语音未提交；别重发整段，也别直接换成文字补发。`;
            }
            spokenMs += made.ms;
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            if (i === 0) return `[send failed] ${why}（语音没发出去,QQ 上什么也没有）`;
            return `[spoken${ids.length ? ` ${ids.join(' ')}` : ''} → ${this.targetDesc(target)},`
              + ` 第 ${i + 1}/${plan.bars.length} 条没发出去: ${why}]\n`
              + '已经发出去的那条别重发;剩下的改用文字发。';
          }
          // 交回给她:core 把字节落成 log: 句柄,她以后能再发同一条 / 存进工作区
          blobs.push({
            bytes: made.bytes,
            mime: made.mime,
            name: `qq-voice-${i + 1}.mp3`,
            fallbackText: '你发出的语音',
          });
        }

        const secs = spokenMs > 0 ? `,${Math.round(spokenMs / 100) / 10} 秒` : '';
        const note =
          plan.bars.length > 1
            ? `已念成 ${plan.bars.length} 条语音发到 ${this.targetDesc(target)}${secs}。`
            : `已念成一条语音发到 ${this.targetDesc(target)}${secs}。`;
        return {
          text: `${receipts.join('\n')}\n${note}音频句柄在下面,要再发同一条就用它。`,
          blobs,
        };
      },
    };
  }

  /**
   * 按编号把旧图取回来给她。**只读**:不登记、不落新盘、盘上有就不联网。
   *
   * 为什么要有它:`{dataDir}/qq-images/` 属部署数据目录,而她的文件工具钉在 `<部署>/workspace/`
   * 上(`insideWorkspace` 拒越界),所以那堆自动留下来的图她一张也够不着。这条工具把字节递到
   * 她手边,要不要留住由她自己的 `save_blob` 决定 —— World 不写 Memory,留哪张是她的判断。
   */
  /**
   * 按段读一个已经落盘的 QQ 文件。
   *
   * 为什么要有它:文件住在**部署数据目录**(`qq-files/`),而她的文件工具钉在
   * `<部署>/workspace/` 上(越界一律拒)、`read_file` 也只把 `blobs/` 下的当图交回 ——
   * 所以那个目录里的东西她够不着。这个工具把**文字片段**递到她手边;
   * **不回字节**(字节走了附件通道就会每轮重发,那是另一条账)。
   */
  private readFileTool(): ToolDef {
    return {
      ...READ_FILE_DECL,
      handler: async (args) => {
        const files = this.files;
        if (!files) return '[tool failed] this World has no file store to read from';
        const raw = String(args.file_id ?? '').trim();
        const id = normalizeFileId(raw);
        if (!/^FILE-\d+$/.test(id)) {
          return `[bad input] file_id must look like a file id, e.g. FILE-3 (got "${raw}")`;
        }
        const offset = Number.isFinite(Number(args.offset)) ? Number(args.offset) : 1;
        const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 200;
        const got = files.read(id, offset, limit);
        return got.failed ? { text: got.text, failed: true } : got.text;
      },
    };
  }

  private getImageTool(): ToolDef {
    return {
      ...GET_IMAGE_DECL,
      handler: async (args) => {
        const raw = String(args.image_id ?? '').trim();
        const id = normalizeImageId(raw);
        if (!/^IMG-\d+$/.test(id)) {
          return `[bad input] image_id must look like an image id, e.g. IMG-3 (got "${raw}")`;
        }
        const original = args.original === true;
        if (this.vision) return this.getImageViaVision(id, original);
        if (this.images) return this.getImageViaLibrary(id, original);
        return '[tool failed] this World has no image store to read from';
      },
    };
  }

  private getAttachmentTool(): ToolDef {
    return {
      ...GET_ATTACHMENT_DECL,
      handler: async ({ attachment_id }) => {
        const id = typeof attachment_id === 'string' ? attachment_id.trim().toUpperCase() : '';
        if (!/^(IMG|FILE)-\d+$/.test(id)) {
          return { text: '请提供完整的 QQ 附件编号，例如 IMG-3 或 FILE-8。', failed: true };
        }
        try {
          const original = id.startsWith('FILE-')
            ? await this.files?.readOriginal(id)
            : await this.readOriginalImage(id);
          if (!original) return { text: `取不到 ${id} 的原件。请检查编号或 QQ2 缓存。`, failed: true };
          // Core 会把 image/* 附件送给视觉模型，原图交接使用二进制句柄。
          const asBinary = original.mime.startsWith('image/') || isGif(original.bytes);
          return {
            text: `已取回 ${id} 的原件「${original.name}」（${formatBytes(original.bytes.byteLength)}）。可将下方 log: 句柄和文件名交给需要原件的工具。`,
            blobs: [{ ...original, mime: asBinary ? 'application/octet-stream' : original.mime, fallbackText: `QQ 原件 ${id}` }],
          };
        } catch (err) {
          return { text: `取回 ${id} 失败：${err instanceof Error ? err.message : String(err)}`, failed: true };
        }
      },
    };
  }

  /** `qq2_image_tag`:把一张图的 hash 与她的名字/类别写进标签库。 */
  private imageTagTool(): ToolDef {
    return {
      ...IMAGE_TAG_DECL,
      handler: async (args) => {
        const raw = String(args.image_id ?? '').trim();
        const id = parseImageId(raw);
        if (!id) {
          return `[bad input] image_id must look like an image id, e.g. IMG-3 (got "${raw}")`;
        }
        const label = typeof args.label === 'string' ? args.label : '';
        if (!label.trim()) return '[bad input] label must not be empty';
        const kind = normalizeKind(args.kind);
        if (!kind) {
          return `[bad input] kind must be one of ${IMAGE_KIND_IDS.join(', ')} (or 表情包/合影/信/截图/其他)`;
        }
        const labels = this.labels;
        if (!labels) return '[tool failed] this World has no label store (no data directory)';
        const hash = await this.hashOfImage(id);
        if (!hash) {
          return `[tag failed] ${id} has no stored bytes yet; wait for it to be fetched, or call qq2_get_image("${id}") first`;
        }
        const saved = typeof args.saved === 'string' && args.saved.trim() ? args.saved.trim() : undefined;
        try {
          const rec = labels.tag({ hash, imageId: id, label, kind, ...(saved ? { saved } : {}) });
          return `[tagged] ${id} = ${rec.label} / ${kindLabel(rec.kind)}${rec.saved ? ` / ${rec.saved}` : ''}`
            + `;同内容的 ${rec.imageIds.length} 个编号共用这条标签`;
        } catch (e) {
          return `[tag failed] ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  }

  /** `qq2_images`:按词/类别列标签,或导出成可写进 `表情包.md` 的清单。 */
  private imagesTool(): ToolDef {
    return {
      ...IMAGE_LIST_DECL,
      handler: async (args) => {
        const labels = this.labels;
        if (!labels) return '[tool failed] this World has no label store';
        const kindRaw = args.kind;
        const kind = kindRaw === undefined ? undefined : normalizeKind(kindRaw);
        if (kindRaw !== undefined && !kind) {
          return `[bad input] kind must be one of ${IMAGE_KIND_IDS.join(', ')} (or 表情包/合影/信/截图/其他)`;
        }
        // 生成 md 时默认多给一些(200 条),不然大相册会被 50 条默认值悄悄截断。
        const limit = Number.isFinite(Number(args.limit))
          ? Number(args.limit)
          : args.format === 'md'
            ? 200
            : undefined;
        const rows = labels.list({
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
          ...(kind ? { kind } : {}),
          ...(limit ? { limit } : {}),
        });
        if (args.format === 'md') return labels.formatMd(rows);
        if (!rows.length) {
          return args.query || kind
            ? '没有匹配的标签。'
            : '还没有贴过标签。先用 qq2_image_tag 给表情包/合影等起个名字。';
        }
        const lines = rows.map((rec) => {
          const id = rec.imageIds[rec.imageIds.length - 1] ?? '—';
          return `- ${id} | ${rec.label} | ${kindLabel(rec.kind)}${rec.saved ? ` | ${rec.saved}` : ''}`;
        });
        return [`共 ${rows.length} 条:`, ...lines].join('\n');
      },
    };
  }

  /** 标签库要的 hash:取图库直接有;视觉那条要现算一次。 */
  private async hashOfImage(id: string): Promise<string | undefined> {
    if (this.images) {
      const rec = this.images.get(id);
      if (rec?.hash) return rec.hash;
      if (rec) return (await this.images.resolve(id)).record.hash;
      return undefined;
    }
    if (this.vision?.hasImage(id)) {
      try {
        const got = await this.vision.getImageBytes(id);
        return got ? createHash('sha256').update(got.buffer).digest('hex') : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** 按 IMG-N 从任一条图片路读原始字节(发送图片、给标签算 hash 用)。 */
  private async readStoredImage(id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (this.images) {
      if (!this.images.has(id)) return null;
      const cached = await this.images.readBytes(id);
      if (cached) return cached;
      const got = await this.images.resolve(id);
      return got.bytes && got.mime ? { bytes: got.bytes, mime: got.mime } : null;
    }
    if (this.vision?.hasImage(id)) {
      try {
        const got = await this.vision.getImageBytes(id);
        return got ? { bytes: got.buffer, mime: got.mime } : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async readOriginalImage(id: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    const original = await this.readStoredImage(id);
    if (!original) return null;
    const name = this.images?.filename(id) ?? this.vision?.filename(id);
    const detectedMime = detectImageMime(original.bytes);
    const mime = detectedMime ?? original.mime;
    const extension = detectedMime && MIME_EXT[detectedMime];
    if (!extension) return { bytes: original.bytes, mime, name: name ?? `${id}.img` };
    const ext = `.${extension}`;
    const suffix = name ? extOf(name) : '';
    if (name && (suffix === ext || (ext === '.jpg' && suffix === '.jpeg'))) return { bytes: original.bytes, mime, name };
    const stem = name ? name.slice(0, name.length - suffix.length) : id;
    return { bytes: original.bytes, mime, name: `${stem}${ext}` };
  }

  /** 取图库那条路:先读盘上那份(离线可),盘上没有才现取一次 —— 地址多半已过期,失败也照实回。 */
  private async getImageViaLibrary(id: string, original: boolean): Promise<string | ToolOutcome> {
    const images = this.images;
    if (!images) return '[tool failed] no image library to read from';
    if (!images.has(id)) return imageNotFound(id);
    let got = await images.readBytes(id);
    if (!got) {
      const res = await images.resolve(id);
      if (!res.bytes) return `[取回失败] ${res.text}`;
      got = { bytes: res.bytes, mime: res.mime ?? 'image/jpeg' };
    }
    const preview = original ? undefined : images.readGifPreview(id, got.bytes);
    return preview
      ? attachImage(id, preview, 'image/png', images.describeId(id), true)
      : attachImage(id, got.bytes, got.mime, images.describeId(id));
  }

  /** 辅助视觉那条路:它的缓存里也有原始字节(已下载读本地,否则现下载)。 */
  private async getImageViaVision(id: string, original: boolean): Promise<string | ToolOutcome> {
    const vision = this.vision;
    if (!vision) return '[tool failed] no vision cache to read from';
    if (!vision.hasImage(id)) return imageNotFound(id);
    try {
      const got = original ? await vision.getImageBytes(id) : await vision.getDisplayImage(id);
      if (!got) return imageNotFound(id);
      return attachImage(id, got.buffer, got.mime, undefined, 'preview' in got && got.preview === true);
    } catch (e) {
      return `[取回失败] ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private viewImageTool(): ToolDef {
    return {
      ...VIEW_IMAGE_DECL,
      handler: async (args) => {
        const vision = this.vision;
        if (!vision) return '[tool failed] auxiliary vision not configured';
        const id = normalizeImageId(String(args.image_id ?? ''));
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) return '[bad input] prompt must not be empty';
        if (!vision.hasImage(id)) {
          return `[bad input] image ${id} not found (may be from an earlier run or cleared)`;
        }
        try {
          return await vision.ask(id, prompt);
        } catch (e) {
          return `[tool failed] ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  }
}

function extractImageUrl(data: Record<string, unknown>): string {
  if (typeof data.url === 'string' && data.url) return data.url;
  if (typeof data.file === 'string' && data.file) return data.file;
  return '';
}

/** 使用 QQ 给出的文件名，跳过 URL、路径和协议端以哈希命名的占位值。 */
function extractImageName(data: Record<string, unknown>): string | undefined {
  for (const value of [data.name, data.filename, data.file]) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!name || name.length > 200 || /[<>:"/\\|?*\x00-\x1f\x7f]|\.$/.test(name)) continue;
    if (/^(?:[a-f0-9]{32}|[a-f0-9]{64})(?:\.[a-z0-9]+)?$/i.test(name)) continue;
    return name;
  }
  return undefined;
}

/** 渲染阶段的 GIF 提示仅依据 url/file 的 .gif 后缀。 */
function looksLikeGif(data: Record<string, unknown>): boolean {
  const gifExt = /\.gif(\?|#|$)/i;
  const url = typeof data.url === 'string' ? data.url : '';
  const file = typeof data.file === 'string' ? data.file : '';
  return gifExt.test(url) || gifExt.test(file);
}

/** 归一化主agent写的图片ID:"IMG-3"/"img3"/"3" → "IMG-3" */
function normalizeImageId(raw: string): string {
  const m = raw.match(/(\d+)/);
  return m ? `IMG-${m[1]}` : raw.trim();
}

/**
 * 只把**看起来就是图片编号**的输入当 IMG-N;`log:...` / `mem:...` 里也有数字,
 * 不能拿 normalizeImageId 去猜。
 */
function parseImageId(raw: string): string | null {
  const s = raw.trim();
  if (!/^(?:img-?)?\d+$/i.test(s)) return null;
  return normalizeImageId(s);
}

/** 在「[图片 …]」这类整行后面补一句;不是方括号行就另起一行。 */
function withNote(text: string, note: string): string {
  return text.endsWith(']') ? `${text.slice(0, -1)};${note}]` : `${text}\n${note}`;
}

function attachOffNote(id: string): string {
  return `本群自动看图已关,要看用 qq2_get_image("${id}")`;
}

const GIF_PREVIEW_NOTE = '附件为 GIF 九宫图，从左到右、从上到下按顺序取帧';

/** 归一化文件编号,口径与图片一致:"FILE-3"/"file3"/"3" → "FILE-3" */
function normalizeFileId(raw: string): string {
  const m = raw.match(/(\d+)/);
  return m ? `FILE-${m[1]}` : raw.trim();
}

/**
 * 限时等待:超时(或对方抛错)回 `null`,由调用方决定占位与稍后重取。
 *
 * 用它而不是 `Promise.race` 裸写,是因为要**清掉定时器** —— 否则每处理一条文件/语音
 * 就留一个挂着的 timer,量上来会拖住进程退出。
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * 取不回时的那句话。说清"可能为什么"比一句 not found 有用:编号是跨重启接着走的,
 * 所以不认识一个编号,多半是它属于上一次运行、或缓存被清过。顺带教她怎么翻还有哪些。
 */
function imageNotFound(id: string): string {
  return `[not found] ${id} is not in the image store — the number is most likely from an earlier run, `
    + 'or the cache was cleared. Try another id, or search the history for the ones that exist: '
    + 'qq2_grep_history with pattern IMG-.';
}

function imageAttachment(id: string, bytes: Uint8Array, mime: string, gifPreview = false): BlobInput {
  return { bytes, mime, name: id, fallbackText: `图片 ${id}${gifPreview ? '（GIF 九宫图）' : ''}` };
}

/** 按编号取回一张图片或它的 GIF 预览。 */
function attachImage(id: string, bytes: Uint8Array, mime: string, described?: string, gifPreview = false): ToolOutcome {
  const head = described ?? `[图片 ${id}${mime === 'image/gif' ? '(GIF)' : ''} ${Math.round(bytes.byteLength / 1024)}KB]`;
  const note = gifPreview ? ` ${GIF_PREVIEW_NOTE}。要取原 GIF，请用 qq2_get_image 并设 original=true。` : '';
  return {
    text: `${head} 取回来了。${note} 要留就用 save_blob 存进你的工作区;不存的话它只在这次上下文里。`,
    blobs: [imageAttachment(id, bytes, mime, gifPreview)],
  };
}

/** 逐条发送之间的停顿(拆句用)。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
