/**
 * 图片标签库:按内容哈希存、按 IMG-N 找回、按词/类别筛、导出 md、跨重启保留。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LabelStore, kindLabel, normalizeKind } from '../src/labels.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qq-labels-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('标签库', () => {
  it('按 hash 存;同内容的第二个 IMG-N 也能找回同一条', () => {
    const labels = new LabelStore(dir);
    labels.tag({ hash: 'aaa', imageId: 'IMG-1', label: '无语猫', kind: 'sticker' });
    labels.tag({ hash: 'aaa', imageId: 'IMG-9', label: '无语猫', kind: 'sticker' });
    const rec = labels.getByImageId('IMG-9');
    expect(rec?.label).toBe('无语猫');
    expect(rec?.imageIds).toEqual(['IMG-1', 'IMG-9']);
    expect(labels.formatForMessage('aaa')).toBe('标签:无语猫;类别:表情包');
  });

  it('改成另一句标签时保留没重给的 saved 与已见编号', () => {
    const labels = new LabelStore(dir);
    labels.tag({ hash: 'h', imageId: 'IMG-1', label: '旧名字', kind: 'sticker', saved: 'mem:external/qq/images/a.png' });
    const rec = labels.tag({ hash: 'h', imageId: 'IMG-2', label: '新名字', kind: 'sticker' });
    expect(rec.label).toBe('新名字');
    expect(rec.saved).toBe('mem:external/qq/images/a.png');
    expect(rec.imageIds).toEqual(['IMG-1', 'IMG-2']);
  });

  it('重启后从 jsonl 恢复(label 文件不在取图库里,清取图库不影响)', () => {
    const first = new LabelStore(dir);
    first.tag({ hash: 'h1', imageId: 'IMG-1', label: '合影一', kind: 'photo' });
    const again = new LabelStore(dir);
    expect(again.size).toBe(1);
    expect(again.getByImageId('IMG-1')?.label).toBe('合影一');
  });

  it('按词/类别筛,新改的在前;md 给出可直接写的行', () => {
    const labels = new LabelStore(dir);
    labels.tag({ hash: 'h1', imageId: 'IMG-1', label: '无语猫', kind: 'sticker', saved: 'mem:external/qq/images/表情-无语猫.png' });
    labels.tag({ hash: 'h2', imageId: 'IMG-2', label: '国庆合影', kind: 'photo' });

    expect(labels.list({ query: '无语' }).map((r) => r.label)).toEqual(['无语猫']);
    expect(labels.list({ kind: 'photo' }).map((r) => r.label)).toEqual(['国庆合影']);
    expect(labels.list({ query: 'IMG-2' }).map((r) => r.label)).toEqual(['国庆合影']);

    const md = labels.formatMd(labels.list());
    expect(md).toContain('# 表情包');
    expect(md).toContain('无语猫 | 表情包 | IMG-1 | mem:external/qq/images/表情-无语猫.png');
    expect(md).toContain('国庆合影 | 合影 | IMG-2');
  });

  it('标签压成一行;md 里的竖线被转义', () => {
    const labels = new LabelStore(dir);
    const rec = labels.tag({ hash: 'h', imageId: 'IMG-1', label: ' 猫\n | 无语 ', kind: 'sticker' });
    expect(rec.label).toBe('猫 | 无语');
    expect(labels.formatMd([rec])).toContain('猫 \\| 无语');
  });

  it('类别收英文键也收中文名;认不出的返回 null', () => {
    expect(normalizeKind('sticker')).toBe('sticker');
    expect(normalizeKind('表情包')).toBe('sticker');
    expect(normalizeKind('合影')).toBe('photo');
    expect(normalizeKind('')).toBe('other');
    expect(normalizeKind('乱七八糟')).toBeNull();
    expect(kindLabel('letter')).toBe('信');
  });
});
