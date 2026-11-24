/**
 * 图片标签库:她给一张图起的名字、类别、以及（可选）存进工作区后的 `mem:` 句柄。
 *
 * 键是**内容哈希 `sha256`**,不是 `IMG-N`:同一张图在群里发十次、换到私聊再发一次,
 * `IMG-N` 会变,字节不会。这样重复图收到的文字里能直接带出她之前起过的名字。
 *
 * 文件放在 `{dataDir}/qq-image-labels.jsonl`,**不在 `qq-images/` 里**:
 * 控制台「清空取图库」会删掉整个 `qq-images/` 目录,标签不能跟着陪葬。
 * 清空后 `IMG-N` 归零,但标签、类别和 `mem:` 路径都还在。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 固定类别:她选的五个,英文键给人写参数,中文给人读。 */
export const IMAGE_KINDS = {
  sticker: '表情包',
  photo: '合影',
  letter: '信',
  screenshot: '截图',
  other: '其他',
} as const;

export type ImageKind = keyof typeof IMAGE_KINDS;

export const IMAGE_KIND_IDS = Object.keys(IMAGE_KINDS) as ImageKind[];

/** 工具参数里允许中文直接写「表情包」;归一化成英文键。空/不认识返回 null。 */
export function normalizeKind(raw: unknown): ImageKind | null {
  if (raw === undefined || raw === null || raw === '') return 'other';
  const s = String(raw).trim();
  if ((IMAGE_KIND_IDS as string[]).includes(s)) return s as ImageKind;
  for (const [id, label] of Object.entries(IMAGE_KINDS) as Array<[ImageKind, string]>) {
    if (s === label) return id;
  }
  return null;
}

export function kindLabel(kind: ImageKind): string {
  return IMAGE_KINDS[kind] ?? IMAGE_KINDS.other;
}

export interface LabelRecord {
  /** 内容哈希(sha256),标签的键 */
  hash: string;
  /** 她自己起的一句名字 */
  label: string;
  kind: ImageKind;
  /** 她存进工作区后的 `mem:` 句柄(可选) */
  saved?: string;
  /** 见过这份内容的 IMG-N(同内容可能有好几个) */
  imageIds: string[];
  /** 最后一次改标签的时刻(ISO) */
  updatedAt: string;
}

export interface TagInput {
  hash: string;
  imageId: string;
  label: string;
  kind: ImageKind;
  saved?: string;
}

export interface ListOptions {
  query?: string;
  kind?: ImageKind;
  limit?: number;
}

const LABEL_MAX_CHARS = 80;
const SAVED_MAX_CHARS = 300;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

/** 把一个可能带换行的标签压成一行;类别说明与 md 都靠这一条。 */
function oneLine(raw: string, max: number): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('');
}

/** md 表格里的 `|` 会断列;只在这一处转义。 */
function mdCell(raw: string): string {
  return raw.replace(/\|/g, '\\|');
}

export class LabelStore {
  private readonly path: string;
  /** hash → 记录 */
  private readonly records = new Map<string, LabelRecord>();
  /** IMG-N → hash(重复图/旧图查标签用) */
  private readonly byImage = new Map<string, string>();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'qq-image-labels.jsonl');
    this.load();
  }

  get size(): number {
    return this.records.size;
  }

  get(hash: string | undefined): LabelRecord | undefined {
    return hash ? this.records.get(hash) : undefined;
  }

  getByImageId(imageId: string): LabelRecord | undefined {
    const hash = this.byImage.get(imageId);
    return hash ? this.records.get(hash) : undefined;
  }

  /**
   * 贴标签(或改标签)。同 hash 的记录只有一条;`imageIds` 累积,
   * 这样以后从任何一个 IMG-N 都能找回这条标签。
   */
  tag(input: TagInput): LabelRecord {
    const label = oneLine(input.label, LABEL_MAX_CHARS);
    if (!label) throw new Error('标签不能为空');
    const saved = input.saved === undefined ? undefined : oneLine(input.saved, SAVED_MAX_CHARS);
    const existing = this.records.get(input.hash);
    const imageIds = new Set(existing?.imageIds ?? []);
    if (input.imageId) imageIds.add(input.imageId);
    const rec: LabelRecord = {
      hash: input.hash,
      label,
      kind: input.kind,
      ...(saved !== undefined && saved !== '' ? { saved } : existing?.saved !== undefined ? { saved: existing.saved } : {}),
      imageIds: [...imageIds],
      updatedAt: new Date().toISOString(),
    };
    this.records.set(input.hash, rec);
    for (const id of rec.imageIds) this.byImage.set(id, input.hash);
    this.persist();
    return rec;
  }

  /**
   * 按标签词/类别/IMG-N/哈希前缀筛。没有 query 与 kind 时列出全部(最多 limit 条)。
   * 排序按最后改动时间倒序。
   */
  list(opts: ListOptions = {}): LabelRecord[] {
    const query = String(opts.query ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(LIST_MAX, Math.trunc(opts.limit ?? LIST_DEFAULT) || LIST_DEFAULT));
    const rows = [...this.records.values()].filter((rec) => {
      if (opts.kind && rec.kind !== opts.kind) return false;
      if (!query) return true;
      return (
        rec.label.toLowerCase().includes(query)
        || kindLabel(rec.kind).includes(query)
        || rec.hash.startsWith(query)
        || rec.imageIds.some((id) => id.toLowerCase().includes(query))
        || (rec.saved ?? '').toLowerCase().includes(query)
      );
    });
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.label.localeCompare(b.label)));
    return rows.slice(0, limit);
  }

  /** 消息正文里那一小段:「标签:无语猫;类别:表情包」;没有标签时 null。 */
  formatForMessage(hash: string | undefined): string | null {
    const rec = this.get(hash);
    return rec ? this.formatRecord(rec) : null;
  }

  /** 一条记录的正文片段(重复图用 `dup_of` 查到时也走这里)。 */
  formatRecord(rec: LabelRecord): string {
    return `标签:${rec.label};类别:${kindLabel(rec.kind)}`;
  }

  /**
   * 给她写 `note/library/表情包.md` 的清单。标签库是唯一真源;这张表是快照,
   * 手改不会回写 —— 要改标签用 `qq2_image_tag`,再重新生成一次。
   */
  formatMd(rows: LabelRecord[]): string {
    const lines = ['# 表情包', '', `共 ${rows.length} 张已命名。要改标签用 \`qq2_image_tag\`,这张表可以重新生成。`, ''];
    if (!rows.length) {
      lines.push('(还没有贴过标签)');
      return lines.join('\n');
    }
    for (const rec of rows) {
      const id = rec.imageIds[rec.imageIds.length - 1] ?? '—';
      const saved = rec.saved ? ` | ${mdCell(rec.saved)}` : '';
      lines.push(`- ${mdCell(rec.label)} | ${kindLabel(rec.kind)} | ${id}${saved}`);
    }
    return lines.join('\n');
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Partial<LabelRecord>;
        if (!raw?.hash || !raw.label || !normalizeKind(raw.kind)) continue;
        const rec: LabelRecord = {
          hash: String(raw.hash),
          label: oneLine(String(raw.label), LABEL_MAX_CHARS),
          kind: normalizeKind(raw.kind) ?? 'other',
          ...(raw.saved ? { saved: oneLine(String(raw.saved), SAVED_MAX_CHARS) } : {}),
          imageIds: Array.isArray(raw.imageIds) ? raw.imageIds.map(String) : [],
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
        };
        this.records.set(rec.hash, rec);
        for (const id of rec.imageIds) this.byImage.set(id, rec.hash);
      } catch {
        /* 单行坏了不该拦住启动 */
      }
    }
  }

  private persist(): void {
    const lines = [...this.records.values()].map((rec) => JSON.stringify(rec));
    writeFileSync(this.path, lines.join('\n') + (lines.length ? '\n' : ''));
  }
}
