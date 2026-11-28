import type { ConfigGroup } from 'cortico/core/types.ts';
import type { VisionConfig } from './onebot/vision.ts';
import { DEFAULT_MODE, type QQMode } from './modes.ts';

/** 关闭的 roster 条目仍持久化并显示,仅从监听集合中排除。 */
export interface QQRosterEntry {
  id: number;
  enabled: boolean;
  /**
   * 只对群有意义:收到新图时要不要把字节挂进上下文(缺省 true)。
   * 关掉后仍下载/登记/判同/可打标签,只是正文只给文字,要看再 `qq2_get_image`。
   * 私聊不走这个开关,始终挂。
   */
  attachImages?: boolean;
}

/**
 * 取图库(不含 VLM)的旋钮。
 *
 * **注意一处副作用**:图片是作为附件挂在消息事件上的(这是她拿到 `log:` 句柄、能
 * `save_blob` 存下来的唯一路子),而附件随上下文**每轮重发** —— 群图多的频道,这一项
 * 直接关系花销。嫌贵就把 `enabled` 关掉(关掉后图片只留一行地址文本)。
 * 装了辅助视觉时本库退场(视觉那条路已经在下载并挂附件了),这些旋钮不生效。
 */
export interface QQImagesConfig {
  enabled: boolean;
  /** 超过这个大小不下载 */
  maxImageBytes: number;
  /** 消息渲染前等取回结果的时限;超时就先占位,结果稍后作为单独事件到达 */
  waitMs: number;
}

export const IMAGES_DEFAULTS: QQImagesConfig = {
  enabled: true,
  maxImageBytes: 8 * 1024 * 1024,
  waitMs: 2500,
};

/**
 * 发送侧的自动拆句旋钮(见 `src/split.ts`)。
 *
 * 默认开:他要的就是「她写一整段,QQ 上分成几条」,而他让她自己分批的嘱咐重启就丢
 * —— 靠机械执行才留得住。单句草稿拆出来还是一句,开着与不开着等价,所以默认开没有代价。
 */
export interface QQSendSplitConfig {
  enabled: boolean;
  /** 一条草稿最多拆几条;超出的并成最后一条(防刷屏) */
  maxChunks: number;
  /** 逐条之间的间隔;0 = 不等(不作推荐,连着发离风控更近) */
  intervalMs: number;
}

export const SPLIT_DEFAULTS: QQSendSplitConfig = {
  enabled: true,
  maxChunks: 6,
  intervalMs: 600,
};

/**
 * 压缩挡(digest)的旋钮。只有一项:**一个窗口多长**。
 *
 * 窗口从这一窗的**第一条被攒的群事件**开始算,到点折成一份摘要给她一次;窗里
 * 没有新消息就不发(不会凭空叫醒她)。被@ 与私聊不受影响,仍立刻叫醒。
 *
 * 为什么不做成「固定每 N 分钟一份、空窗也发」:群里没人说话的时段,摘要里只有一句
 * 「没有消息」,除了叫醒她一次没有任何用处。
 */
export interface QQDigestConfig {
  /** 一个窗口的分钟数;正数,可为小数(控制台按整数分钟给)。 */
  minutes: number;
}

export const DIGEST_DEFAULTS: QQDigestConfig = {
  minutes: 10,
};

/**
 * 收进来的**文件**(见 `src/files.ts`)。
 *
 * 与取图库是两件事:图片是「她可能要看」的画面,文件是「内容本身」—— 所以这里**不挂附件**
 * (附件字节每轮重发,那是另一条账),只把**文字**递进正文;超出内联线的给编号,她自己按段取。
 */
export interface QQFilesConfig {
  enabled: boolean;
  /** 超过这个大小不下载、不读内容 */
  maxBytes: number;
  /** 文本小于它就直接进正文;更大的只给头几行 + 编号 */
  inlineMaxBytes: number;
  /** 大文本在正文里给前几行 */
  previewLines: number;
  /** 消息渲染前等取回结果的时限;超时先占位,结果稍后作为单独事件到达 */
  waitMs: number;
  /** `qq2_read_file` 一次最多回多少字 */
  readMaxChars: number;
  /** 单次下载的超时 */
  fetchTimeoutMs: number;
}

export const FILES_DEFAULTS: QQFilesConfig = {
  enabled: true,
  maxBytes: 20 * 1024 * 1024,
  inlineMaxBytes: 8 * 1024,
  previewLines: 30,
  waitMs: 2500,
  readMaxChars: 6000,
  fetchTimeoutMs: 30_000,
};

/** 收到的 QQ 语音条通过 NapCat 请求 QQ 原生转写。 */
export interface QQAsrConfig {
  enabled: boolean;
  timeoutMs: number;
}

export const ASR_DEFAULTS: QQAsrConfig = {
  enabled: true,
  timeoutMs: 60_000,
};

export const QQ_DEFAULTS = {
  enabled: false,
  /** NapCat 正向 WS 地址 */
  wsUrl: 'ws://127.0.0.1:3001',
  groups: [] as QQRosterEntry[],
  privates: [] as QQRosterEntry[],
  token: '',
  /** 群聊投递模式;她可以用 qq2_mode 改,改了就写回这里,重启后仍是这个值。 */
  mode: DEFAULT_MODE,
  /** 压缩挡的窗口长度(分钟);她能在 qq2_mode 里带 minutes 改,控制台也能改。 */
  digest: { minutes: DIGEST_DEFAULTS.minutes },
} as const;

/**
 * 本 World 需要的密钥的**环境变量名**。辅助视觉用的是 OpenRouter——
 * core 不认识这个名字,装配层照 World 声明的名字取值。
 */
export const QQ_SECRETS = { vision: 'OPENROUTER_API_KEY' } as const;

/**
 * 本 World 声明的可调项。只声明**World 自己**的参数:连接与监听名单有
 * 专用面板(要卡片式增删、要重启),这里放的是自带视觉的行为旋钮。
 *
 * 模式不在这里:他说「她自己切」(工具 `qq2_mode`),控制台只把当前值当徽标显示。
 */
export const QQ_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qq2',
  owner: 'world:qq2',
  schema: {
    type: 'object',
    title: 'QQ · 图片与辅助视觉',
    description: '群图的取回、落盘与判同;开了辅助视觉则加一层模型描述。',
    properties: {
      'worlds.qq2.images.enabled': {
        type: 'boolean',
        title: '取回群图',
        'x-hot': false,
        description: '把群里的图片下载、落盘、算 sha256,并作为附件挂在事件上(她因此拿到句柄,能存进自己的 blobs/)。'
          + '代价是图随上下文每轮重发。重启生效;开了辅助视觉时本项不生效(视觉那条路已经在做这件事)。',
      },
      'worlds.qq2.images.maxImageBytes': {
        type: 'integer',
        title: '图片下载上限',
        minimum: 65_536,
        maximum: 104_857_600,
        multipleOf: 65_536,
        'x-scale': 1_048_576,
        'x-suffix': 'MB',
        'x-hot': true,
        description: '超过这个大小的图不下载、不落盘。',
      },
      'worlds.qq2.images.waitMs': {
        type: 'integer',
        title: '取回等待上限',
        minimum: 0,
        maximum: 30_000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '消息渲染前等取回结果的最长时间。超时先给占位符,结果稍后作为单独事件到达。',
      },
      'worlds.qq2.vision.enabled': {
        type: 'boolean',
        title: '开启辅助视觉',
        'x-hot': false,
        description: '关掉后图片只留可读占位。需要重启生效(装配时才创建视觉服务),且需要配好 OPENROUTER_API_KEY。',
      },
      'worlds.qq2.vision.model': {
        type: 'string',
        title: 'VLM 模型',
        'x-hot': false,
        description: 'OpenRouter 上的模型名。重启生效。',
      },
      'worlds.qq2.vision.concurrency': {
        type: 'integer',
        title: '被动识图并发',
        minimum: 1,
        maximum: 16,
        multipleOf: 1,
        'x-suffix': '路',
        'x-hot': true,
        description: '同时最多跑几张图的识别。',
      },
      'worlds.qq2.vision.dedupPrecheckMs': {
        type: 'integer',
        title: '去重预判等待上限',
        minimum: 0,
        maximum: 30_000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '消息渲染前检查图片是否重复的最长等待时间。命中时引用已有图片，下载失败时标记失败；'
          + '新图片或超时先显示占位，识图结果另行投递。',
      },
      'worlds.qq2.vision.maxImageBytes': {
        type: 'integer',
        title: '图片下载上限',
        minimum: 65_536,
        maximum: 104_857_600,
        multipleOf: 65_536,
        'x-scale': 1_048_576,
        'x-suffix': 'MB',
        'x-hot': true,
        description: '超过这个大小的图不下载、不识别。',
      },
      'worlds.qq2.vision.timeoutMs': {
        type: 'integer',
        title: 'VLM 请求超时',
        minimum: 1000,
        maximum: 300_000,
        multipleOf: 1000,
        'x-scale': 1000,
        'x-suffix': 's',
        'x-hot': false,
        description: '单次识别请求的超时。重启生效(客户端构造时固定)。',
      },
    },
  },
};

/**
 * 嗓子(语音条)的旋钮。
 *
 * 两条边界是他定的:
 * - **发不发由她决定**——这里不给「自动念」这种东西,`qq2_say` 是她主动调的;
 * - **群里能不能发由他决定**——`groupEnabled` 是硬开关,默认关。打开之后,群里发不发仍归她。
 *
 * 密钥口径与 pet 那条嗓子一致(同一把 `MINIMAX_API_KEY`、同一个音色),所以她在这两个渠道
 * 是同一个声音。**账本是各自一本**(pet 记 `pet-voice/quota.json`,这里记 `qq-voice/quota.json`)。
 */
export interface QQVoiceConfig {
  /** 总开关。关掉后 `qq2_say` 直接回绝。 */
  enabled: boolean;
  /** 群里能不能发语音;默认关,只有他能在控制台打开。 */
  groupEnabled: boolean;
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
  /** 一段话最多念几条;超出就回绝并让她改用文字(他定的是「分两次说」)。 */
  maxBars: number;
  /** 日累计上限(字符);0 = 不设。 */
  dailyChars: number;
}

export const VOICE_DEFAULTS: QQVoiceConfig = {
  enabled: true,
  groupEnabled: false,
  // 与 pet 那份同源:同一把 key、同一个音色,她在两个渠道是同一个声音
  apiKeySecret: 'MINIMAX_API_KEY',
  endpoint: 'https://api.minimax.cn/v1/t2a_v2',
  model: 'speech-2.8-turbo',
  voiceId: 'Chinese (Mandarin)_Sweet_Lady',
  speed: 1,
  vol: 1,
  pitch: 0,
  timeoutMs: 30_000,
  maxCharsPerBar: 400,
  maxBars: 2,
  dailyChars: 20_000,
};

/** 嗓子那组旋钮。与 pet 的 `worlds.pet.voice` 是同一套含义。 */
export const QQ_VOICE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qq2:voice',
  owner: 'world:qq2',
  schema: {
    type: 'object',
    title: 'QQ · 语音',
    description: '她能不能在 QQ 上说话、说的是什么声音、一天说多少。发不发由她决定,这一组只定边界。',
    properties: {
      'worlds.qq2.voice.enabled': {
        type: 'boolean',
        title: '开启 QQ 语音',
        'x-hot': true,
        description: '关掉后她的 qq2_say 会被回绝,只能发文字。开着也要她主动调才会出声(没有「自动念」)。',
      },
      'worlds.qq2.voice.groupEnabled': {
        type: 'boolean',
        title: '允许在群聊里发语音',
        'x-hot': true,
        description: '**默认关**:群里的语音条比文字显眼,先由你决定要不要。打开之后,群聊里发不发仍由她判断'
          + '(私聊不受这一项影响,一直是可用的)。',
      },
      'worlds.qq2.voice.apiKeySecret': {
        type: 'string',
        title: '密钥的环境变量名',
        'x-hot': false,
        description: '默认 MINIMAX_API_KEY。这里填写变量名，密钥值在「语音」面板保存。',
      },
      'worlds.qq2.voice.model': {
        type: 'string',
        title: '语音模型',
        'x-hot': true,
        description: 'MiniMax 的模型名,默认 speech-2.8-turbo(turbo 便宜些;换成 speech-2.8 音质更好、贵一截)。',
      },
      'worlds.qq2.voice.voiceId': {
        type: 'string',
        title: '音色',
        'x-hot': true,
        description: '系统预设形如 female-tianmei / Chinese (Mandarin)_Sweet_Lady;与 pet 那条嗓子用同一个,'
          + '她在两个渠道就是同一个声音。',
      },
      'worlds.qq2.voice.speed': { type: 'number', title: '语速', minimum: 0.5, maximum: 2, 'x-hot': true, description: '0.5~2。' },
      'worlds.qq2.voice.vol': { type: 'number', title: '音量', minimum: 0.1, maximum: 10, 'x-hot': true, description: '默认 1。' },
      'worlds.qq2.voice.pitch': { type: 'integer', title: '音高', minimum: -12, maximum: 12, 'x-hot': true, description: '默认 0。' },
      'worlds.qq2.voice.maxCharsPerBar': {
        type: 'integer',
        title: '单条语音上限',
        minimum: 40,
        maximum: 2000,
        multipleOf: 10,
        'x-suffix': '字符',
        'x-hot': true,
        description: '一条语音最多多少字符(一个汉字算 2)。超了先按句子分成多条;还是装不下就回绝、让她改用文字。',
      },
      'worlds.qq2.voice.maxBars': {
        type: 'integer',
        title: '最多念几条',
        minimum: 1,
        maximum: 6,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: '一段话最多分成几条语音发出去,默认 2(他定的是「长度到上限就分两次说」)。',
      },
      'worlds.qq2.voice.dailyChars': {
        type: 'integer',
        title: '每天上限',
        minimum: 0,
        maximum: 2_000_000,
        multipleOf: 1000,
        'x-suffix': '字符',
        'x-hot': true,
        description: '一天在 QQ 上最多合成多少字符(一个汉字算 2);到顶她会被回绝并改用文字。'
          + '**与 pet 那条嗓子是两本账**(各自 file 记各自的上限)。0 = 不设上限。',
      },
      'worlds.qq2.voice.endpoint': {
        type: 'string',
        title: '合成端点',
        'x-hot': false,
        description: '默认 MiniMax 的 t2a_v2;换成兼容端点时要连模型名一起改。改完重启。',
      },
    },
  },
};

/** config.json 的 `worlds.qq2` 节。 */
export interface QQConfigSection {
  enabled: boolean;
  /** NapCat 正向 WS 地址 */
  wsUrl: string;
  /** 群 roster,逐项热更新;关闭的条目仍持久化并显示,但不参与监听。 */
  groups: QQRosterEntry[];
  /** 监听的私聊 QQ 号 roster,语义同 groups */
  privates: QQRosterEntry[];
  /** OneBot access token,可空 */
  token: string;
  /** 群聊投递模式(她切,写回这里) */
  mode: QQMode;
  /** 压缩挡的窗口长度;她与控制台都能改,下一个窗口生效 */
  digest: QQDigestConfig;
  /** 发送前的自动拆句;按引用读,改了即时生效 */
  split: QQSendSplitConfig;
  /** 嗓子(语音条);按引用读,改了即时生效 */
  voice: QQVoiceConfig;
  /** 取图库(不含 VLM);开了辅助视觉时它退场 */
  images: QQImagesConfig;
  /** 收进来的文件:下载、落盘、判文本、按段读 */
  files: QQFilesConfig;
  /** 收到的语音使用 QQ 原生转写。 */
  asr: QQAsrConfig;
  vision: VisionConfig;
}

/**
 * 群聊模式这一组。**只有压缩挡有旋钮**:攒批/专注/睡眠三挡没有参数,
 * 而「哪一挡」由她自己切(`qq2_mode`),不在控制台给开关。
 */
export const QQ_MODE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qq2:mode',
  owner: 'world:qq2',
  schema: {
    type: 'object',
    title: 'QQ · 群聊模式',
    description: '压缩挡的一个窗口有多长;被@ 与私聊不受影响,仍立刻叫醒。',
    properties: {
      'worlds.qq2.digest.minutes': {
        type: 'integer',
        title: '压缩窗口',
        minimum: 1,
        maximum: 1440,
        multipleOf: 1,
        'x-suffix': '分钟',
        'x-hot': true,
        description: '群里的消息先攒着,满这么久折成一份摘要给她一次(摘要里每条只留开头,细节用'
          + ' qq2_read_history 翻)。被@ 与私聊仍立刻叫醒。这一窗没有新的群消息就不发摘要。'
          + '改完在**下一个窗口**生效;她自己也能用 qq2_mode(mode="digest", minutes=…) 改。',
      },
    },
  },
};

/**
 * 发送侧的可调项。与「图片与辅助视觉」分开一组,是因为它管的是**出去的东西**,
 * 而那一组管的是**进来的图**。
 */
export const QQ_SEND_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qq2:send',
  owner: 'world:qq2',
  schema: {
    type: 'object',
    title: 'QQ · 发送',
    description: '草稿怎么落到 QQ 上:按句子拆成几条分批发。',
    properties: {
      'worlds.qq2.split.enabled': {
        type: 'boolean',
        title: '自动拆句',
        'x-hot': true,
        description: '把她一条草稿按句子(换行、。！？!?…)拆成几条 QQ 消息分批发出,中间留间隔。'
          + '单句草稿拆出来仍是一条。关掉则整段一次发出。她不必自己拆,也不用记这条规矩。',
      },
      'worlds.qq2.split.maxChunks': {
        type: 'integer',
        title: '最多拆几条',
        minimum: 1,
        maximum: 20,
        multipleOf: 1,
        'x-suffix': '条',
        'x-hot': true,
        description: '一份草稿最多发几条;超出的部分并进最后一条,防一次回复刷成一屏。',
      },
      'worlds.qq2.split.intervalMs': {
        type: 'integer',
        title: '逐条间隔',
        minimum: 0,
        maximum: 5000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '两条之间的停顿。0 = 连着发(不推荐:连着发更像机器,也离风控更近)。',
      },
    },
  },
};

/**
 * 收进来的东西:文件与语音。与「发送」「嗓子」分开一组,是因为那两组管**出去的东西**,
 * 这一组管**进来的**。
 */
export const QQ_INBOUND_CONFIG_GROUP: ConfigGroup = {
  id: 'world:qq2:inbound',
  owner: 'world:qq2',
  schema: {
    type: 'object',
    title: 'QQ · 收进来的文件与语音',
    description: '别人发来的文件与语音条怎么变成她能读的东西:下载、落盘、判文本、转写。',
    properties: {
      'worlds.qq2.files.enabled': {
        type: 'boolean',
        title: '接收文件',
        'x-hot': true,
        description: '打开后,私聊/群里收到的文件会被下载并读成文字交给她(小文本直接进正文,大文本给编号)。'
          + '关掉则文件只留一行「[文件 …]」占位。',
      },
      'worlds.qq2.files.maxBytes': {
        type: 'integer',
        title: '文件大小上限',
        minimum: 65_536,
        maximum: 209_715_200,
        multipleOf: 65_536,
        'x-scale': 1_048_576,
        'x-suffix': 'MB',
        'x-hot': true,
        description: '比这大的文件不下载、不读内容(正文会如实说「超过上限」)。QQ 能传很大的文件,'
          + '而下载会吃掉本机的带宽与磁盘,所以这里要有个闸。',
      },
      'worlds.qq2.files.inlineMaxBytes': {
        type: 'integer',
        title: '直接贴进正文的上限',
        minimum: 256,
        maximum: 262_144,
        multipleOf: 256,
        'x-hot': true,
        description: '小于它的文本文件**全文**进正文(她一眼就看到);更大的只给前几行 + 编号,'
          + '其余用 `qq2_read_file` 按段看。正文进上下文是长期成本,所以这条线要小。',
      },
      'worlds.qq2.files.previewLines': {
        type: 'integer',
        title: '大文件预览行数',
        minimum: 1,
        maximum: 500,
        multipleOf: 1,
        'x-suffix': '行',
        'x-hot': true,
        description: '超过内联上限的文本文件,正文里给前几行让她判断值不值得细看。',
      },
      'worlds.qq2.files.waitMs': {
        type: 'integer',
        title: '取回等待上限',
        minimum: 0,
        maximum: 30_000,
        multipleOf: 100,
        'x-suffix': 'ms',
        'x-hot': true,
        description: '文件读取或语音转写在正文内等待的最长时间。超过后先投递占位，结果稍后补发。',
      },
      'worlds.qq2.files.readMaxChars': {
        type: 'integer',
        title: '单次读取上限',
        minimum: 500,
        maximum: 50_000,
        multipleOf: 500,
        'x-suffix': '字符',
        'x-hot': true,
        description: '`qq2_read_file` 一次最多回给她多少字(超了她接着用 offset 取下一段)。',
      },
      'worlds.qq2.asr.enabled': {
        type: 'boolean',
        title: '转写收到的语音',
        'x-hot': true,
        description: '打开后通过 NapCat 请求 QQ 原生转写，结果会标注「可能有错」。'
          + '关掉则语音只显示「[语音]」。',
      },
      'worlds.qq2.asr.timeoutMs': {
        type: 'integer',
        title: '转写超时',
        minimum: 1000,
        maximum: 300_000,
        multipleOf: 1000,
        'x-scale': 1000,
        'x-suffix': 's',
        'x-hot': true,
        description: '等待 QQ 返回转写结果的总时限，包含重取结果的时间。超时会提示转写失败。',
      },
    },
  },
};
