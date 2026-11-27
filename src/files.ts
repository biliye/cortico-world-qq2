/**
 * QQ 文件的落盘与取用(**不含解析**):下载、按 sha256 命名、记一张登记表、判「文本还是二进制」。
 *
 * 同内容共用一份原件，每次来件保留自己的文件名和编号。
 * 正文只交文字，原件通过 qq2_get_attachment 按需取回。
 *
 * 一条要紧的实底(2026-10-12 实测,详录 `state/design/cortico-world-qq2-入站文件与音频.md`):
 * **私聊 `file` 段里没有下载地址**(只有文件名 / `file_id` / 大小),群文件也未必有。
 * 地址要另调协议端(`get_private_file_url` / `get_group_file_url`)—— 而本文件**不认识协议**,
 * 所以「取地址」留成 `deps.resolveUrl` 由 World 注入。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mimeOfHandle } from 'cortico/core/blobs.ts';
import type { Logger } from 'cortico/core/types.ts';
import type { QQFilesConfig } from './config.ts';

export interface FileRecord {
  id: string;
  /** 文件名(原样,含扩展名) */
  name: string;
  /** 段里报的大小(字节);不知道就不填 */
  size?: number;
  /** 下载地址;段里没带(私聊 file 段就是这样)就先空着,resolve 时再要 */
  url: string | null;
  /** 取址凭据(私聊 file_id / 群 file_id+busid)。**本文件不解释它**,由注入的 resolveUrl 认得 */
  ref: unknown;
  hash?: string;
  dupOf?: string;
  /** 盘上的文件名(sha256 + 扩展名) */
  file?: string;
  kind?: 'text' | 'binary';
  /** 文本时用的解码(utf-8 / utf-16le / gbk…) */
  encoding?: string;
  lines?: number;
  chars?: number;
  /** 渲染好的正文(或异步事件正文);resolve 之后才有 */
  rendered?: string;
  /** 失败原因(resolve 失败时) */
  error?: string;
}

export interface FileLibraryDeps {
  dataDir: string;
  cfg: QQFilesConfig;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** 由 World 注入:按凭据去协议端要下载地址(私聊 get_private_file_url / 群 get_group_file_url)。 */
  resolveUrl: (ref: unknown) => Promise<string | null>;
}

export interface FileOutcome {
  /** 正文那一行(小文本含全文;大文本给头几行;二进制只给说明) */
  rendered: string;
  ok: boolean;
}

/** 嗅探结果:是文本就带上解出来的字;不是就只说不是。 */
export type Sniff =
  | { kind: 'text'; text: string; encoding: string }
  | { kind: 'binary' };

/**
 * 一眼就不是文本的文件头。**必须放在试解码之前**:实测一个 PNG 用 GBK 能解出
 * `塒NG\r\n\u001a\nAAAA…` 这种「看着像字」的东西,控制字符只占 1% 出头,`looksTexty` 拦不住。
 */
const BINARY_MAGIC: ReadonlyArray<readonly number[]> = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP(含 Office/APK 那一族)
  [0x1f, 0x8b], // GZIP
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], // RAR
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x00, 0x00, 0x01, 0x00], // ICO
  [0x00, 0x61, 0x73, 0x6d], // wasm
  [0xed, 0xab, 0xee, 0xdb], // Java class
];

/** 头部字节撞上没撞上上面的表。 */
function looksBinary(bytes: Uint8Array): boolean {
  return BINARY_MAGIC.some((magic) => magic.every((b, i) => bytes[i] === b));
}

/**
 * 判「这段字节是不是文本」。
 *
 * 四条路,顺序不能换:
 * 1. **BOM** —— 有就用它指定的编码(fatal 解码,解不开就当二进制);
 * 2. **文件头魔数** —— PNG/PDF/ZIP 这些一眼就不是文本,别去试解码;
 * 3. **严格 UTF-8** —— `fatal:true`,解不开就是「不是 UTF-8」,不是「不是文本」;
 * 4. **GBK** —— Windows 记事本存的中文 txt 常是这一档,所以留在最后兜一次;
 *    但它要过两道筛:不能有替换字符、**不能有任何控制字符**(PNG 那种能从这道缝里钻进来)。
 *
 * 为什么不用扩展名判:`.txt` 可能是 GBK 也可能是二进制,`.log` 也可能是 gzip。
 */
export function sniffText(bytes: Uint8Array, maxChars = 500_000): Sniff {
  if (!bytes.length) return { kind: 'text', text: '', encoding: 'utf-8' };

  // 1. BOM
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const t = decodeWith(bytes.subarray(3), 'utf-8', true);
    return t !== null ? { kind: 'text', text: t, encoding: 'utf-8' } : { kind: 'binary' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    const t = decodeWith(bytes.subarray(2), 'utf-16le', true);
    return t !== null ? { kind: 'text', text: t, encoding: 'utf-16le' } : { kind: 'binary' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const t = decodeWith(bytes.subarray(2), 'utf-16be', true);
    return t !== null ? { kind: 'text', text: t, encoding: 'utf-16be' } : { kind: 'binary' };
  }

  // 2. 文件头魔数
  if (looksBinary(bytes)) return { kind: 'binary' };

  // 3. 严格 UTF-8
  const utf8 = decodeWith(bytes, 'utf-8', true);
  if (utf8 !== null && looksTexty(utf8)) return { kind: 'text', text: utf8, encoding: 'utf-8' };

  // 4. GBK(非 fatal;不支持的运行环境会返回 null,直接跳过)
  const gbk = decodeWith(bytes, 'gbk', false);
  if (gbk !== null && !gbk.includes('\uFFFD') && looksTexty(gbk) && !hasControlChars(gbk)) {
    return { kind: 'text', text: gbk, encoding: 'gbk' };
  }
  return { kind: 'binary' };
}

/** 除 tab / 换行 / 回车之外还有没有控制字符(GBK 那一档用它兜底)。 */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
    if (c === 0x7f) return true;
  }
  return false;
}

function decodeWith(bytes: Uint8Array, encoding: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 「像文本吗」:NUL 一个都不能有(那是二进制的铁证),控制字符(除 tab/换行/回车)占比要低。
 * 阈值 2% 是留宽的 —— 终端日志里带点控制符很常见,不该因此被当成二进制。
 */
export function looksTexty(text: string): boolean {
  if (!text) return false;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) return false;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) bad++;
  }
  return bad / text.length < 0.02;
}

/** 人名读的大小(`12 B` / `240 KB` / `60.7 MB`)。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 渲染正文那一行。三种形态分得很开,她一眼能看出自己拿到的是**内容**还是**只有地址**:
 * - 小文本 → 内容直接在正文里;
 * - 大文本 → 头几行 + 「其余的自己用 `qq2_read_file` 看」;
 * - 二进制 / 超限 → 只给说明(她够不着盘上的字节,所以不承诺任何"打开"动作)。
 */
export function renderFileText(rec: FileRecord, sniff: Sniff | null, cfg: QQFilesConfig): string {
  const size = rec.size !== undefined ? formatBytes(rec.size) : '大小未知';
  if (rec.dupOf) return `[重复文件 ${rec.name} · ${size} · ${rec.id} · 同 ${rec.dupOf}]`;
  const head = `[文件 ${rec.name} · ${size} · ${rec.id}]`;
  if (!sniff) return head;
  if (sniff.kind === 'binary') return `${head} 不是文本(二进制),没有读内容。`;

  const text = sniff.text;
  const enc = sniff.encoding === 'utf-8' ? '' : ` · ${sniff.encoding}`;
  const lines = text.split('\n');
  const chars = text.length;

  if (Buffer.byteLength(text, 'utf8') <= cfg.inlineMaxBytes) {
    return `${head}${enc}\n${text}${text.endsWith('\n') ? '' : '\n'}`;
  }
  const preview = lines.slice(0, Math.max(1, cfg.previewLines)).join('\n');
  const more = `…(共 ${lines.length} 行 / ${chars} 字;要看别的用 qq2_read_file ${rec.id} offset=${Math.max(1, cfg.previewLines)})`;
  return `${head}${enc}\n${preview}\n${more}`;
}

/**
 * 文件库:登记 → 取地址 → 下载 → 落盘 → 嗅探 → 渲染。
 *
 * 登记表(`registry.jsonl`)与编号计数器都跨重启延续 —— 与取图库同一个理由:重启之后
 * 她还能按编号提到「刚才那个文件」。
 */
export class FileLibrary {
  private readonly dir: string;
  private readonly registryPath: string;
  private readonly deps: FileLibraryDeps;
  private readonly log: Logger;
  private readonly records = new Map<string, FileRecord>();
  private readonly firstByHash = new Map<string, FileRecord>();
  private readonly inFlight = new Map<string, { result: Promise<FileOutcome>; retryFailed: boolean }>();
  private counter = 0;

  constructor(deps: FileLibraryDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.dir = join(deps.dataDir, 'qq-files');
    this.registryPath = join(this.dir, 'registry.jsonl');
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /** 登记一条(不下载)。编号从 `FILE-N` 走,与取图库同一个形状。 */
  register(input: { name: string; size?: number; url?: string | null; ref?: unknown }): string {
    const id = `FILE-${++this.counter}`;
    const rec: FileRecord = {
      id,
      name: input.name || `未命名-${id}`,
      size: typeof input.size === 'number' && input.size >= 0 ? input.size : undefined,
      url: input.url ?? null,
      ref: input.ref,
    };
    this.records.set(id, rec);
    this.persist(rec);
    return id;
  }

  get(id: string): FileRecord | undefined {
    return this.records.get(id);
  }

  /** 已渲染好的正文(异步事件用);还没解出来就是 undefined。 */
  rendered(id: string): string | undefined {
    return this.records.get(id)?.rendered;
  }

  /** 限时预取:时限内做完就把结论给出去,否则返回 null(调用方先占位,结果稍后另发)。 */
  async precheckWithin(id: string, deadlineMs: number): Promise<string | null> {
    const work = this.resolve(id);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadlineMs)));
    const got = await Promise.race([work, timeout]);
    if (got === null) return null;
    return got.ok ? got.rendered : got.rendered; // 失败也把说明内联(她知道发生了什么)
  }

  /** 同编号共享在途下载。显式取原件可在预取失败后重试。 */
  resolve(id: string, retryFailed = false): Promise<FileOutcome> {
    const running = this.inFlight.get(id);
    if (running) {
      if (!retryFailed || running.retryFailed) return running.result;
      const rec = this.records.get(id);
      return running.result.then((outcome) =>
        outcome.ok || this.records.get(id) !== rec ? outcome : this.resolve(id, true));
    }
    const result = this.run(id, retryFailed).finally(() => {
      if (this.inFlight.get(id)?.result === result) this.inFlight.delete(id);
    });
    this.inFlight.set(id, { result, retryFailed });
    return result;
  }

  private async run(id: string, retryFailed: boolean): Promise<FileOutcome> {
    const rec = this.records.get(id);
    if (!rec) return { ok: false, rendered: `[文件 ${id}] 没有这个编号。` };
    const retry = retryFailed && (rec.error === 'no-url' || rec.error === 'download-failed');
    if (rec.rendered !== undefined && !retry) return { ok: !rec.error, rendered: rec.rendered };

    // 大小闸门放在最前面:段里报的大小够用就不必下 —— 群里那个实测 60.7 MB。
    if (rec.size !== undefined && rec.size > this.deps.cfg.maxBytes) {
      rec.error = 'too-large';
      rec.rendered = `[文件 ${rec.name} · ${formatBytes(rec.size)} · ${rec.id}] 超过上限 ${formatBytes(this.deps.cfg.maxBytes)},没有下载。`;
      this.persist(rec);
      return { ok: false, rendered: rec.rendered };
    }

    let url = rec.url;
    if (!url || retry) {
      try {
        url = (await this.deps.resolveUrl(rec.ref)) ?? url;
      } catch (err) {
        this.log.warn('取文件地址失败', { id, err: String(err) });
      }
    }
    if (!url) {
      rec.error = 'no-url';
      rec.rendered = `[文件 ${rec.name} · ${rec.id}] 没能从协议端拿到下载地址。`;
      this.persist(rec);
      return { ok: false, rendered: rec.rendered };
    }
    rec.url = url;

    let bytes: Uint8Array;
    try {
      bytes = await this.fetchBytes(url);
    } catch (err) {
      rec.error = 'download-failed';
      rec.rendered = `[文件 ${rec.name} · ${rec.id}] 下载失败:${err instanceof Error ? err.message : String(err)}`;
      this.persist(rec);
      return { ok: false, rendered: rec.rendered };
    }

    // 下载完再看一次大小(段里没报大小时这也是唯一的一道闸)
    if (bytes.length > this.deps.cfg.maxBytes) {
      rec.error = 'too-large';
      rec.rendered = `[文件 ${rec.name} · ${formatBytes(bytes.length)} · ${rec.id}] 超过上限 ${formatBytes(this.deps.cfg.maxBytes)},没有读内容。`;
      this.persist(rec);
      return { ok: false, rendered: rec.rendered };
    }

    if (this.records.get(id) !== rec) return { ok: false, rendered: `[文件 ${id}] 缓存已清空。` };
    const hash = createHash('sha256').update(bytes).digest('hex');
    const first = this.firstByHash.get(hash);
    const file = first?.file ?? `${hash}${extOf(rec.name)}`;
    try {
      this.writeBytes(file, bytes);
    } catch (err) {
      rec.error = 'store-failed';
      rec.rendered = `[文件 ${rec.name} · ${id}] 保存失败：${err instanceof Error ? err.message : String(err)}`;
      this.persist(rec);
      return { ok: false, rendered: rec.rendered };
    }

    const sniff = sniffText(bytes);
    rec.hash = hash;
    rec.file = file;
    rec.size = rec.size ?? bytes.length;
    rec.kind = sniff.kind;
    if (sniff.kind === 'text') {
      rec.encoding = sniff.encoding;
      rec.chars = sniff.text.length;
      rec.lines = sniff.text.split('\n').length;
    }
    if (first) rec.dupOf = first.id;
    else this.firstByHash.set(hash, rec);
    delete rec.error;
    rec.rendered = renderFileText(rec, sniff, this.deps.cfg);
    this.persist(rec);
    return { ok: true, rendered: rec.rendered };
  }

  /** 读取指定来件的原件和原名，复用同编号正在进行的下载。 */
  async readOriginal(id: string): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
    const rec = this.records.get(id);
    const result = await this.resolve(id, true);
    if (!result.ok) throw new Error(result.rendered);
    if (this.records.get(id) !== rec || !rec?.file || !isCachedFilename(rec.file)) {
      throw new Error(`找不到 ${id} 的原件。`);
    }
    const path = join(this.dir, rec.file);
    if (!existsSync(path)) throw new Error(`${id} 的原件已不在 QQ2 缓存中。`);
    const bytes = readFileSync(path);
    const firstFile = rec.hash ? this.firstByHash.get(rec.hash)?.file : undefined;
    const recognizedMime = mimeOfHandle(firstFile ?? rec.file);
    const mime = recognizedMime === 'application/octet-stream' && rec.kind === 'text' ? 'text/plain' : recognizedMime;
    return { bytes, mime, name: rec.name };
  }

  /**
   * 按段读(工具用)。`offset` 是**行号,从 1 数**,`limit` 是行数。
   * 盘的字节不经过上下文 —— 回给她的只有这一段文字。
   */
  read(id: string, offset: number, limit: number): { text: string; failed?: boolean } {
    const rec = this.records.get(id);
    if (!rec) {
      return { text: `[qq2_read_file] 没有 ${id} 这个编号。用正文里出现过的 FILE-N,或 qq2_grep_history 搜 "FILE-"。`, failed: true };
    }
    if (!rec.file) {
      if (rec.error === 'too-large') return { text: `[qq2_read_file] ${rec.name} 超过大小上限,当初没有下载,所以盘上没有内容。`, failed: true };
      return { text: `[qq2_read_file] ${rec.name} 还没落盘(或取回失败)。`, failed: true };
    }
    if (rec.kind !== 'text') return { text: `[qq2_read_file] ${rec.name} 不是文本文件,读不了内容。`, failed: true };

    const path = join(this.dir, rec.file);
    if (!existsSync(path)) return { text: `[qq2_read_file] ${rec.name} 的字节不在盘上了(${rec.file})。`, failed: true };

    let full: string;
    try {
      full = new TextDecoder(rec.encoding ?? 'utf-8', { fatal: false }).decode(new Uint8Array(readFileSync(path)));
    } catch (err) {
      return { text: `[qq2_read_file] 读 ${rec.name} 失败:${err instanceof Error ? err.message : String(err)}`, failed: true };
    }

    const lines = full.split('\n');
    const start = Math.max(1, Math.floor(offset) || 1);
    const want = Math.max(1, Math.floor(limit) || 1);
    const slice = lines.slice(start - 1, start - 1 + want);
    let body = slice.join('\n');
    let cut = false;
    if (body.length > this.deps.cfg.readMaxChars) {
      body = body.slice(0, this.deps.cfg.readMaxChars);
      cut = true;
    }
    const range = `${start}–${start - 1 + slice.length} / 共 ${lines.length} 行`;
    const tail = cut
      ? `\n…(这一段还没给完,接着用 offset=${start + slice.length} 取)`
      : start - 1 + slice.length < lines.length
        ? `\n…(后面还有 ${lines.length - (start - 1 + slice.length)} 行;offset=${start + slice.length} 接着看)`
        : '';
    return { text: `[文件 ${rec.name} · ${rec.id} · 第 ${range}]\n${body}${tail}` };
  }

  /** 登记表里有多少条(控制台「清除存储」显示用)。 */
  fileCount(): number {
    return this.records.size;
  }

  /** 清空落盘与登记表。返回清掉了几个(编号随之归零,历史里的旧 FILE-N 此后查不到)。 */
  clear(): number {
    const n = this.records.size;
    this.records.clear();
    this.firstByHash.clear();
    this.inFlight.clear();
    this.counter = 0;
    try {
      rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.log.warn('清文件缓存失败', { err: String(err) });
    }
    return n;
  }

  private async fetchBytes(url: string): Promise<Uint8Array> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const res = await doFetch(url, { signal: AbortSignal.timeout(this.deps.cfg.fetchTimeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private writeBytes(file: string, bytes: Uint8Array): void {
    const path = join(this.dir, file);
    if (existsSync(path)) return;
    const pending = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(pending, bytes);
      renameSync(pending, path);
    } finally {
      rmSync(pending, { force: true });
    }
  }

  private persist(rec: FileRecord): void {
    if (this.records.get(rec.id) !== rec) return;
    // 登记表是**追加**的流水(与取图库同一取舍):同一条重写一次比原地改写安全得多,
    // 读的时候后写的覆盖先写的。
    try {
      writeFileSync(this.registryPath, `${JSON.stringify(rec)}\n`, { flag: 'a' });
    } catch (err) {
      this.log.warn('文件登记表写入失败', { id: rec.id, err: String(err) });
    }
  }

  private load(): void {
    if (!existsSync(this.registryPath)) return;
    let lines: string[];
    try {
      lines = readFileSync(this.registryPath, 'utf8').split('\n');
    } catch {
      return;
    }
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t) as FileRecord;
        if (!rec?.id) continue;
        this.records.set(rec.id, rec);
        const n = Number(rec.id.replace(/^FILE-/, ''));
        if (Number.isFinite(n) && n > this.counter) this.counter = n;
      } catch {
        // 坏行跳过:登记表是流水,不值得为一行坏数据让整个 World 起不来
      }
    }
    for (const rec of this.records.values()) {
      if (rec.hash && rec.file && isCachedFilename(rec.file) && !rec.dupOf && !this.firstByHash.has(rec.hash)) {
        this.firstByHash.set(rec.hash, rec);
      }
    }
  }
}

function isCachedFilename(name: string): boolean {
  return /^[0-9a-f]{64}(?:\.[a-z0-9]{1,8})?$/.test(name);
}

/** 扩展名(带点);没有就空串。只用于盘上文件的命名,不参与「是不是文本」的判断。 */
export function extOf(name: string): string {
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}
