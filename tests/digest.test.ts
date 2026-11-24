import { describe, expect, it } from 'vitest';
import { DigestLedger, oneLine, renderDigest, type DigestEntry, type DigestEventInput } from '../src/digest.ts';

const G1 = { kind: 'group' as const, id: 424242 };
const G2 = { kind: 'group' as const, id: 777 };

const msg = (body: string, sender = '甲', uid = 111): DigestEventInput => ({
  type: 'qq.message',
  ts: '2026-10-19T12:00:00+08:00',
  text: `#9001 [群「深夜食堂」 12:00] ${sender}(${uid}): ${body}`,
  meta: { conv: G1, sender_name: sender },
});

const opts = {
  labelOf: (c: { id: number }) => (c.id === G1.id ? '深夜食堂' : '另一个群'),
  timeOf: () => '12:00',
  clock: (ms: number) => (ms === 1_000 ? '12:00' : '12:10'),
  fromMs: 1_000,
  toMs: 1_000_000,
};

describe('DigestLedger', () => {
  it('窗口起点是第一条到达的时刻;take 之后清空', () => {
    const ledger = new DigestLedger();
    expect(ledger.empty).toBe(true);
    ledger.push(msg('在吗'), G1, 1_000);
    ledger.push(msg('在的'), G1, 2_000);
    expect(ledger.startedAtMs).toBe(1_000);
    expect(ledger.size).toBe(2);
    const snap = ledger.take(9_000);
    expect(snap.entries).toHaveLength(2);
    expect(snap.fromMs).toBe(1_000);
    expect(snap.toMs).toBe(9_000);
    expect(ledger.empty).toBe(true);
    expect(ledger.startedAtMs).toBe(0);
  });

  it('没有正文的消息不进账本', () => {
    const ledger = new DigestLedger();
    ledger.push({ type: 'qq.message', ts: '2026-10-19T12:00:00+08:00', text: '' }, G1);
    expect(ledger.empty).toBe(true);
  });

  it('超过账本上限丢最老的,并记住丢了几条', () => {
    const ledger = new DigestLedger({ maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) ledger.push(msg(`第${i}条`), G1, 1_000 + i);
    const snap = ledger.take(9_000);
    expect(snap.entries).toHaveLength(3);
    expect(snap.entries[0]!.body).toBe('第2条');
    expect(snap.droppedOldest).toBe(2);
  });
});

describe('renderDigest', () => {
  it('去掉会话前缀,留下时刻、发言人与正文', () => {
    const entries: DigestEntry[] = [
      { conv: G1, ts: '2026-10-19T12:00:00+08:00', sender: '甲', body: '今天有人来吗', tag: '' },
      { conv: G1, ts: '2026-10-19T12:00:00+08:00', sender: '乙', body: '我晚点到', tag: '' },
    ];
    const text = renderDigest(entries, opts);
    expect(text).toContain('[QQ 压缩摘要 12:00–12:10] 群里 2 条,来自 1 个群');
    expect(text).toContain('群「深夜食堂」(424242) · 2 条');
    expect(text).toContain('  12:00 甲: 今天有人来吗');
    expect(text).toContain('  12:00 乙: 我晚点到');
    expect(text).not.toContain('#9001');
  });

  it('两个群分组,顺序按第一次出现', () => {
    const entries: DigestEntry[] = [
      { conv: G1, ts: 't', sender: '甲', body: '一', tag: '' },
      { conv: G2, ts: 't', sender: '丙', body: '二', tag: '' },
      { conv: G1, ts: 't', sender: '甲', body: '三', tag: '' },
    ];
    const text = renderDigest(entries, opts);
    const g1 = text.indexOf('群「深夜食堂」');
    const g2 = text.indexOf('群「另一个群」');
    expect(g1).toBeGreaterThan(-1);
    expect(g2).toBeGreaterThan(g1);
    expect(text).toContain('来自 2 个群');
  });

  it('非消息事件带标签,并去掉会话前缀', () => {
    const entries: DigestEntry[] = [
      { conv: G1, ts: 't', sender: '', body: '某人(111) 撤回了「在吗」', tag: '[撤回]' },
    ];
    const text = renderDigest(entries, opts);
    expect(text).toContain('  12:00 [撤回] 某人(111) 撤回了「在吗」');
  });

  it('每个群只列最后几条,并写明还有多少条没列', () => {
    const entries: DigestEntry[] = ['一', '二', '三', '四', '五'].map((body) => ({
      conv: G1,
      ts: 't',
      sender: '甲',
      body,
      tag: '',
    }));
    const text = renderDigest(entries, { ...opts, maxLinesPerConv: 2 });
    expect(text).toContain('甲: 四');
    expect(text).toContain('甲: 五');
    expect(text).not.toContain('甲: 一');
    expect(text).toContain('这个群还有 3 条没列出(用 qq2_read_history 看)');
  });

  it('单行太长就截断(留一个省略号)', () => {
    const entries: DigestEntry[] = [{ conv: G1, ts: 't', sender: '甲', body: '啊'.repeat(50), tag: '' }];
    const text = renderDigest(entries, { ...opts, maxLineChars: 20 });
    // 19 个字 + 省略号 = 20 字符上限;渲染里有 16 的下限保护,所以用 20 来验。
    expect(text).toContain(`甲: ${'啊'.repeat(19)}…`);
    expect(text).not.toContain('啊'.repeat(21));
  });

  it('总长度预算用完时明确报出还有多少条没列', () => {
    const entries: DigestEntry[] = Array.from({ length: 30 }, (_, i) => ({
      conv: G1,
      ts: 't',
      sender: '甲',
      body: `${i} ${'长'.repeat(60)}`,
      tag: '',
    }));
    const text = renderDigest(entries, { ...opts, maxTotalChars: 300 });
    expect(text).toMatch(/摘要太长,还有 \d+ 条没列出/);
  });

  it('账本丢过的最老条目也要报数', () => {
    const text = renderDigest(
      [{ conv: G1, ts: 't', sender: '甲', body: '最后一条', tag: '' }],
      { ...opts, droppedOldest: 7 },
    );
    expect(text).toContain('(更早的 7 条已略过,用 qq2_read_history 看)');
  });
});

describe('oneLine', () => {
  it('折叠换行与多余空白', () => {
    expect(oneLine('  今天\n\n有人  来吗 ', 90)).toBe('今天 有人 来吗');
  });
});
