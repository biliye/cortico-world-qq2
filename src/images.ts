/**
 * 取图库(不含 VLM):把群里收到的图片**下载、落盘、算 sha256、挂成附件**。
 *
 * 这是「不开辅助视觉也想存图、也想判同」那条路(设计记录里的 C 方案)。它与辅助视觉的分工:
 * 辅助视觉(装了 OPENROUTER_API_KEY 才有)会额外叫模型描述图片;本库只做与模型无关的那半截
 * ——下载、sha256、落盘、查重。两者同时可用时**世界只启用其中一个**(视觉在,本库退场),
 * 免得同一张图下两次。
 *
 * 判同只看 `sha256`:字节一样 → 不重复落盘,记 `dupOf`。感知哈希(dHash)已删除:实测它
 * 分不开「同一张的加工版」与「同模板换一行字」,拿它判“已登记”会把大量不同的图吃掉。
 *
 * 落盘:`{dataDir}/qq-images/registry.jsonl` 记每张图的元数据,字节按 sha256 命名(同内容只一份)。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';
import { nullLogger, shortTime } from 'cortico/core/util.ts';
import { cachedGifPreview, isGif } from './gif-preview.ts';

export interface ImageRecord {
  /** IMG-N(本库自己的编号;历史消息里的引用靠它) */
  id: string;
  url: string;
  /** 图片所在 QQ 消息的平台 message_id(register 时未知,attachMessage 后填) */
  messageId?: string;
  /** 落盘文件名(相对 {dataDir}/qq-images/),按 sha256 命名 */
  file?: string;
  mime?: string;
  /** 原图是 GIF。预览是派生文件，原图始终保留。 */
  gif?: boolean;
  size?: number;
  /** 字节的 sha256(判同键) */
  hash?: string;
  /** 与本图字节相同(sha256 一致)的更早图片 */
  dupOf?: string;
  /** 取不到时的简短原因 */
  failedReason?: string;
  ts: string;
}

export interface PrecheckResult {
  record: ImageRecord;
  /** 原图字节。失败时为 undefined。 */
  bytes?: Uint8Array;
  mime?: string;
  /** 给 Coo 投递的 GIF 九宫图。 */
  preview?: Buffer;
  /** 直接内联进消息正文的一句(带 IMG-N 与查重结论) */
  text: string;
}

export interface ImageLibraryDeps {
  dataDir: string;
  timezone: string;
  /**
   * 旋钮**按对象引用传进来**:控制台改完写回的就是这个对象,所以限额与阈值是热生效的
   * (与 core 的 batching 同一个路子:每次用的时候现读)。
   */
  cfg: { maxImageBytes: number };
  /** 按内容哈希查她起过的标签,返回「标签:…;类别:…」;没贴过返回 null。 */
  labelFor?: (hash: string | undefined) => string | null;
  log?: Logger;
  fetchImpl?: typeof fetch;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export class ImageLibrary {
  private readonly dir: string;
  private readonly registryPath: string;
  private readonly deps: ImageLibraryDeps;
  private readonly log: Logger;
  private records = new Map<string, ImageRecord>();
  private bytesCache = new Map<string, { bytes: Uint8Array; mime: string }>();
  private inFlight = new Map<string, Promise<PrecheckResult>>();
  private counter = 0;

  constructor(deps: ImageLibraryDeps) {
    this.deps = deps;
    this.log = deps.log ?? nullLogger();
    this.dir = join(deps.dataDir, 'qq-images');
    this.registryPath = join(this.dir, 'registry.jsonl');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /** 登记一张待取回的图,分配 IMG-N(消息落库后由 attachMessage 回填消息号) */
  register(url: string, opts?: { gif?: boolean }): string {
    const id = `IMG-${++this.counter}`;
    this.records.set(id, { id, url, ts: shortTime(this.deps.timezone), ...(opts?.gif ? { gif: true } : {}) });
    return id;
  }

  /** 图所在消息落库后回填平台 message_id,并把这条登记持久化 */
  attachMessage(id: string, messageId: number | string | undefined): void {
    const rec = this.records.get(id);
    if (!rec) return;
    if (messageId !== undefined) rec.messageId = String(messageId);
    this.persist(rec);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** 已登记图片数(控制台存储面板用) */
  imageCount(): number {
    return this.records.size;
  }

  get(id: string): ImageRecord | undefined {
    return this.records.get(id);
  }

  /**
   * 有时限的取回:下载 + 算 sha256 + 查重 + 落盘。
   * 时限内做完就返回结果(调用方把结论内联进消息、把字节挂成附件);
   * 没做完返回 null,调用方先给占位符,`resolve()` 的 promise 稍后自己走完。
   */
  async precheckWithin(id: string, deadlineMs: number): Promise<PrecheckResult | null> {
    const work = this.resolve(id);
    if (deadlineMs <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 取回同一张图只跑一次;失败也是终态(记 failedReason),不抛给调用方。 */
  resolve(id: string): Promise<PrecheckResult> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const work = this.run(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, work);
    return work;
  }

  private async run(id: string): Promise<PrecheckResult> {
    const rec = this.records.get(id);
    if (!rec) return { record: { id, url: '', ts: '' }, text: `[图片 ${id} 不在登记表里]` };
    try {
      const got = await this.fetchBytes(rec.url);
      if (got.bytes.byteLength > this.deps.cfg.maxImageBytes) {
        return this.fail(rec, `超过大小上限(${got.bytes.byteLength} > ${this.deps.cfg.maxImageBytes} 字节)`, '不下载');
      }
      const mime = isGif(got.bytes) ? 'image/gif' : got.mime.startsWith('image/') ? got.mime : 'image/jpeg';
      rec.mime = mime;
      rec.size = got.bytes.byteLength;
      rec.gif = rec.gif || mime === 'image/gif';
      rec.hash = createHash('sha256').update(got.bytes).digest('hex');
      this.match(rec);
      this.writeBytes(rec, got.bytes);
      this.bytesCache.set(id, { bytes: got.bytes, mime });
      this.persist(rec);
      const preview = rec.gif && !rec.dupOf ? cachedGifPreview(this.dir, rec.hash, got.bytes) : undefined;
      return { record: rec, bytes: got.bytes, mime, preview, text: this.describe(rec) };
    } catch (error) {
      return this.fail(rec, error instanceof Error ? error.message : String(error), '取回失败');
    }
  }

  private fail(rec: ImageRecord, reason: string, verb: string): PrecheckResult {
    rec.failedReason = reason;
    this.persist(rec);
    this.log.warn('图片取回未完成', { id: rec.id, reason });
    return { record: rec, text: `[图片 ${rec.id} —— ${verb}:${reason}]` };
  }

  /** 同一个 id 重复取回时用内存里的字节;重启后重取。 */
  async readBytes(id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const cached = this.bytesCache.get(id);
    if (cached) return cached;
    const rec = this.records.get(id);
    if (!rec?.file || !rec.mime) return null;
    const path = join(this.dir, rec.file);
    if (!existsSync(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    this.bytesCache.set(id, { bytes, mime: rec.mime });
    return { bytes, mime: rec.mime };
  }

  /** Older cache entries may only have the original GIF. Generate its preview on first lookup. */
  readGifPreview(id: string, bytes: Uint8Array): Buffer | undefined {
    if (!isGif(bytes)) return undefined;
    const hash = this.records.get(id)?.hash ?? createHash('sha256').update(bytes).digest('hex');
    return cachedGifPreview(this.dir, hash, bytes);
  }

  private async fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
    if (!url) throw new Error('没有图片地址');
    const doFetch = this.deps.fetchImpl ?? fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > this.deps.cfg.maxImageBytes) {
      throw new Error(`声明大小 ${declared} 超过上限`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, mime: (res.headers.get('content-type') ?? '').split(';')[0]!.trim() };
  }

  /** 同内容只落一份盘(按 sha256 命名);已有同名文件就不重写。 */
  private writeBytes(rec: ImageRecord, bytes: Uint8Array): void {
    const duplicateFile = rec.dupOf ? this.records.get(rec.dupOf)?.file : undefined;
    if (duplicateFile && existsSync(join(this.dir, duplicateFile))) {
      rec.file = duplicateFile;
      return;
    }
    const ext = MIME_EXT[rec.mime ?? ''] ?? 'img';
    const file = `${rec.hash}.${ext}`;
    rec.file = file;
    const path = join(this.dir, file);
    if (!existsSync(path)) writeFileSync(path, bytes);
  }

  /** 查重:字节相同(sha256 一致)才记 `dupOf`。 */
  private match(rec: ImageRecord): void {
    for (const other of this.records.values()) {
      if (other.id === rec.id) continue;
      if (other.hash && other.hash === rec.hash) {
        rec.dupOf = other.id;
        return;
      }
    }
  }

  /** 内联进消息正文的一句:她据此知道有图、有号、有没有见过。 */
  private describe(rec: ImageRecord, includeFetchHint = true): string {
    const gifMark = rec.gif ? '(GIF)' : '';
    const size = rec.size !== undefined ? `${Math.round(rec.size / 1024)}KB` : '';
    const head = `[图片 ${rec.id}${gifMark} ${size}`.trimEnd();
    if (rec.dupOf) {
      const tag = this.deps.labelFor?.(rec.hash) ?? null;
      const named = tag ? `;${tag}` : ';还没贴标签';
      const hint = includeFetchHint ? `;要看用 qq2_get_image("${rec.id}")` : '';
      return `${head};与 ${rec.dupOf} 是同一份文件,取图库里已有${named}${hint}]`;
    }
    return `${head}]`;
  }

  /** 占位符:消息先发出去,取回结果稍后作为单独事件到达。 */
  placeholder(id: string, gif: boolean): string {
    return `[图片 ${id}${gif ? '(GIF)' : ''} 正在取回中…]`;
  }

  /** 按编号取那句现成的描述(工具回执用,措辞与消息正文同一套);编号不认识返回 undefined。 */
  describeId(id: string): string | undefined {
    const rec = this.records.get(id);
    return rec ? this.describe(rec, false) : undefined;
  }

  /** 清空本库缓存(控制台运维动作):内存表 + 磁盘(登记表与字节)全清,编号归零。 */
  clear(): number {
    const n = this.records.size;
    this.records.clear();
    this.bytesCache.clear();
    this.inFlight.clear();
    this.counter = 0;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* 删不掉不致命,下次写入覆盖 */
    }
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.log.warn('QQ 取图缓存已清空', { cleared: n });
    return n;
  }

  private load(): void {
    if (!existsSync(this.registryPath)) return;
    for (const line of readFileSync(this.registryPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as ImageRecord;
        if (!rec.id) continue;
        this.records.set(rec.id, rec);
        const n = Number.parseInt(rec.id.replace(/^IMG-/, ''), 10);
        if (Number.isFinite(n) && n > this.counter) this.counter = n;
      } catch {
        /* 单行坏了不该拦住启动 */
      }
    }
  }

  /** 追加一行;已存在的 id 覆盖写(登记表是小文件,直接整份重写更简单也更不容易坏) */
  private persist(rec: ImageRecord): void {
    try {
      const lines: string[] = [];
      for (const r of this.records.values()) lines.push(JSON.stringify(r));
      writeFileSync(this.registryPath, lines.join('\n') + '\n');
    } catch (error) {
      this.log.warn('登记表写入失败', { err: String(error), id: rec.id });
    }
  }
}

/** 扩展名过滤:只对看起来是图片的段登记。 */
export function looksLikeImageUrl(url: string): boolean {
  if (!url) return false;
  const ext = extname(url.split('?')[0] ?? '').toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
}
