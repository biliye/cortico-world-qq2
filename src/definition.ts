import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { join } from 'node:path';
import { type QQConfigSection, QQ_DEFAULTS, QQ_SECRETS } from './config.ts';
import { IMAGES_DEFAULTS, SPLIT_DEFAULTS, VOICE_DEFAULTS, FILES_DEFAULTS, ASR_DEFAULTS, DIGEST_DEFAULTS } from './config.ts';
import { QQ2World, QQ2_TOOL_DECLS, enabledRosterIds } from './world.ts';
import { isQQMode } from './modes.ts';
import { synthesize, saySettingsOf, type SayResult } from './voice.ts';
import { VISION_DEFAULTS, VisionService, type VisionConfig } from './onebot/vision.ts';
import { OpenRouterVLMClient } from './onebot/vlm.ts';

/** 部署时区里的「今天」(YYYY-MM-DD)——记账按他那边的一天算,不按 UTC。 */
function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export const QQ2: WorldDefinition<QQConfigSection> = {
  id: 'qq2',
  label: 'QQ 2',
  defaults: () => ({
    ...QQ_DEFAULTS,
    groups: [],
    privates: [],
    vision: { ...VISION_DEFAULTS },
    images: { ...IMAGES_DEFAULTS },
    split: { ...SPLIT_DEFAULTS },
    voice: { ...VOICE_DEFAULTS },
    files: { ...FILES_DEFAULTS },
    asr: { ...ASR_DEFAULTS },
    digest: { ...DIGEST_DEFAULTS },
  }),
  create: (ctx) => {
    const { cfg } = ctx;
    // 辅助视觉只在开关打开且有 OPENROUTER_API_KEY 时存在;否则图片以占位符进入上下文。
    const openrouterKey = ctx.secret(QQ_SECRETS.vision);
    const vision = cfg.vision.enabled && openrouterKey
      ? new VisionService({
          vlm: new OpenRouterVLMClient(openrouterKey, {
            baseUrl: cfg.vision.baseUrl,
            model: cfg.vision.model,
            maxTokens: cfg.vision.maxTokens,
            timeoutMs: cfg.vision.timeoutMs,
          }),
          cfg: cfg.vision,
          dataDir: ctx.dataDir,
          timezone: ctx.timezone,
        })
      : undefined;
    // 合成和设置面板共用当前配置指向的密钥，每次现读。
    const voiceKey = (): string => validVoiceKeyName() ? ctx.secret(cfg.voice.apiKeySecret) : '';
    function validVoiceKeyName(): boolean {
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.voice.apiKeySecret);
    }
    const say = async (text: string): Promise<SayResult> =>
      synthesize(text, {
        dir: join(ctx.dataDir, 'qq-voice'),
        settings: saySettingsOf(cfg.voice),
        apiKey: voiceKey(),
        // 记账按**部署时区**的一天算,不按 UTC(他后台看到的也是他那边的一天)
        today: todayIn(ctx.timezone),
      });
    // 每群的「图片自动挂载」开关。roster 面板保存时同步更新这张表,所以是热生效的;
    // 缺省(旧配置没有这个字段)是 true,私聊不查这张表。
    let attachOf = new Map<number, boolean>(
      cfg.groups.map((e) => [Number(e.id), e.attachImages !== false]),
    );
    const module = new QQ2World(
      {
        wsUrl: cfg.wsUrl,
        groups: enabledRosterIds(cfg.groups),
        privates: enabledRosterIds(cfg.privates),
        token: cfg.token,
        mode: isQQMode(cfg.mode) ? cfg.mode : undefined,
        timezone: ctx.timezone,
        dataDir: ctx.dataDir,
        attachImages: (groupId) => attachOf.get(Number(groupId)) ?? true,
        // 按引用传进去:控制台改的限额与阈值写回的就是这个对象,所以它们是热生效的。
        images: cfg.images,
        // 压缩窗口同理:控制台改「压缩窗口」写回的就是这一段,下一个窗口起生效。
        digest: cfg.digest,
        // 同理按引用传:拆句旋钮在控制台改完即时生效(旧配置没有这一段时缺省见 SPLIT_DEFAULTS)。
        split: cfg.split,
        // 嗓子同理(旧配置没有这一段时缺省见 VOICE_DEFAULTS)。
        voice: cfg.voice,
        // 收进来的文件与语音(旧配置没有这两段时缺省见 FILES_DEFAULTS / ASR_DEFAULTS)。
        // 同样按引用传:控制台改完即时生效。
        files: cfg.files,
        asr: cfg.asr,
      },
      {
        vision,
        say,
        voiceCredential: {
          configured: () => voiceKey().trim() !== '',
          save: (key) => {
            if (!validVoiceKeyName()) throw new Error('请在 QQ · 语音设置中填写有效的密钥环境变量名。');
            try {
              ctx.storeSecret(cfg.voice.apiKeySecret, key);
            } catch {
              throw new Error('写入 MiniMax API Key 失败，请检查 Coo 数据目录的写入权限。');
            }
          },
        },
        // 模式写回 worlds.qq2.mode:她切换后重启仍在同一模式(睡眠被一次重启悄悄
        // 解除是最糟的失败方式)。要「重启回到默认」就把这个回调去掉。
        setMode: (mode) => ctx.persist({ mode }),
        // 压缩周期也写回:她调过的分钟数重启后仍然算数(与 mode 同一个理由)。
        setDigestMinutes: (minutes) => ctx.persist({ digest: { minutes } }),
        gate: {
          enabled: () => cfg.enabled,
          wsUrl: () => cfg.wsUrl,
          tokenSet: () => !!cfg.token,
          roster: () => ({ groups: cfg.groups, privates: cfg.privates }),
          setRoster: (groups, privates) => {
            // The running module receives only enabled entries; the full roster is persisted.
            attachOf = new Map(groups.map((e) => [Number(e.id), e.attachImages !== false]));
            module.setWatched(enabledRosterIds(groups), enabledRosterIds(privates));
            ctx.persist({ groups, privates });
            const gOn = groups.filter((e) => e.enabled).length;
            const pOn = privates.filter((e) => e.enabled).length;
            return `监听名单已更新:群${groups.length}个(启用${gOn})、私聊${privates.length}个(启用${pOn}),已写回config.json`;
          },
          setEnabled: (enabled) => ctx.persist({ enabled }),
          setConnection: (wsUrl, token) => {
            // 空串 = 保持原 token 不动
            ctx.persist(token === '' ? { wsUrl } : { wsUrl, token });
          },
          restart: () => { void ctx.restart(); },
        },
      },
    );
    return module;
  },
  /**
   * 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
   * 工具名写的是运行时的 `qq2_*`，历史工具也通过 `renameQqTool` 使用这个前缀。
   * 九条里后三条按配置/能力可能出现(看图、取旧图、读文件),一并声明。
   */
  describe: {
    tools: describeTools(QQ2_TOOL_DECLS, {
      qq2_mode: {
        zh: '选群聊消息怎么到你手上:攒批(默认)、专注、压缩、睡眠四档;压缩还能顺手改窗口分钟数。写回配置,重启仍在这一档。',
        en: 'Chooses how group-chat messages reach you — batch (default), focus, digest or sleep; for digest also sets the window in minutes. Written back to config and kept across a restart.',
      },
      qq2_draft: {
        zh: '起草一条 QQ 消息(文字、图片或引用回复),先暂存不发;本轮结束还没确认就作废。',
        en: 'Drafts a QQ message (text, image or quote reply) and holds it unsent; an unconfirmed draft is dropped at end of turn.',
      },
      qq2_confirm: {
        zh: '处理最近一份草稿:发出去,或者作废。',
        en: 'Sends or discards the most recent draft.',
      },
      qq2_say: {
        zh: '把一段话念成语音条发到一个会话;私聊一直可用,群里要他在控制台开过。',
        en: 'Speaks a short text as a QQ voice bar to one conversation; private chats always work, groups only when the owner switched it on.',
      },
      qq2_read_history: {
        zh: '读监听会话的历史消息:某条消息前后,或一段时间内,可按会话与发言人过滤。',
        en: 'Reads past QQ messages, around one message or within a time range, optionally filtered by conversation and sender.',
      },
      qq2_grep_history: {
        zh: '按关键词搜监听会话的历史消息,每处命中带前后三条。',
        en: 'Searches past QQ messages by keyword, with three messages of context around each hit.',
      },
      qq2_view_image: {
        zh: '就一张图向辅助视觉模型追问;配好辅助视觉才有。',
        en: 'Asks the auxiliary vision model a question about an image; present only when auxiliary vision is set up.',
      },
      qq2_get_image: {
        zh: '按 IMG 编号取图，GIF 默认挂九宫图，设 original=true 取原件。盘上有就不联网。',
        en: 'Fetch an image by its IMG id. GIFs default to a nine-frame preview. Set original=true for the GIF file. Uses the local copy when available.',
      },
      qq2_image_tag: {
        zh: '给一张来过的图起个自己的名字和固定类别(表情包/合影/信/截图/其他);同内容的图共用一条标签。',
        en: 'Names an image that came through QQ and gives it one fixed kind; identical copies share the label.',
      },
      qq2_images: {
        zh: '列已命名的图片,可按词或类别筛;format="md" 给出可写进 note/library/表情包.md 的清单。',
        en: 'Lists named images, optionally filtered by word or kind; format="md" returns lines ready for note/library/表情包.md.',
      },
      qq2_read_file: {
        zh: '按行读一个从 QQ 收到的文本文件,一次一段(只给文字,不给字节)。',
        en: 'Reads a text file received over QQ one stretch of lines at a time (text only, never raw bytes).',
      },
    }),
    events: [
      {
        type: 'qq.message',
        description: {
          zh: '监听的群或私聊里来了消息;群里被@时立即投递。',
          en: 'A message in a watched group or private chat; delivered at once when the bot is mentioned in a group.',
        },
      },
      {
        type: 'qq.digest',
        description: {
          zh: '压缩挡到点结账:这一窗的群消息折成一份摘要,每个群几行、只留开头;被@ 与私聊不在这里。',
          en: 'A digest settled at the end of a compression window: the window\'s group messages folded into a few lines per group (beginnings only); @mentions and private chats are not included.',
        },
      },
      {
        type: 'qq.image',
        description: {
          zh: '取图库里没赶在时限内取回的图,稍后补发的正文与附件。',
          en: 'An image from a message, sent once the image library finishes fetching it.',
        },
      },
      {
        type: 'qq.vision',
        description: {
          zh: '辅助视觉模型对一张图的描述(理解闭合后补发,带图字节)。',
          en: "The auxiliary vision model's description of an image, sent once it finishes.",
        },
      },
      {
        type: 'qq.file',
        description: {
          zh: 'QQ 收到的文件:正文(小文件全给、大文件只给头几行),或取不回的原因。',
          en: 'A file received over QQ — its text (whole for small files, first lines for large ones), or why it could not be fetched.',
        },
      },
      {
        type: 'qq.transcript',
        description: {
          zh: '一条语音消息的转写结果,或没转成的原因。',
          en: 'The transcript of a voice message, or why transcription failed.',
        },
      },
      {
        type: 'qq.reply.uncaptured',
        description: {
          zh: '被引用的消息不在记录里时,向协议端查到的原文或查询失败的原因。',
          en: 'For a quoted message missing from the record: the original fetched from the protocol end, or why the fetch failed.',
        },
      },
      {
        type: 'qq.forward',
        description: {
          zh: '转发的聊天记录展开后的内容(取不到时说明为什么)。',
          en: 'The contents of a forwarded chat record, or why it could not be expanded.',
        },
      },
      {
        type: 'qq.recall',
        description: { zh: '群里有人撤回了一条消息。', en: 'Someone in a group recalled a message.' },
      },
      {
        type: 'qq.member',
        description: { zh: '有人加入或退出了群。', en: 'Someone joined or left a group.' },
      },
      {
        type: 'qq.emoji',
        description: { zh: '群里有人给一条消息贴了表情。', en: 'Someone in a group reacted to a message with an emoji.' },
      },
      {
        type: 'qq.poke',
        description: { zh: '群里有人戳了戳某人。', en: 'Someone in a group poked someone.' },
      },
      {
        type: 'qq.watch',
        description: {
          zh: '监听名单加入或移除了一个会话。',
          en: 'A conversation was added to or removed from the watch list.',
        },
      },
      {
        type: 'qq.self',
        description: {
          zh: 'bot 自己发出的 QQ 消息(按条回录,带平台消息号),只记录,不唤醒。',
          en: "One of the bot's own sent QQ messages, recorded per message; never wakes her.",
        },
      },
    ],
  },
};
