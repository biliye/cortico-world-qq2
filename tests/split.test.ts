/**
 * 拆句器的边界。这里钉的都是「她真会写出来的样子」,以及几种不能拆错的东西
 * (网址、方括号标记、中文引号收尾)。
 */
import { describe, expect, it } from 'vitest';
import { splitForSending } from '../src/split.ts';

const opts = { maxChunks: 6 };

/** 他给的那段真实草稿(她写回复的习惯:段落之间空行)。 */
const HIS_EXAMPLE = [
  '落了。',
  '',
  '09:00 那条节律改成了：切专注 + 当场挂一条 40 分钟后的提醒。到点我看一眼，热就续、静就切回攒批。',
  '',
  '今天这条已经补上了，10:12 响。',
].join('\n');

describe('splitForSending', () => {
  it('他给的那段:空行分段 + 句号断句,4 条', () => {
    expect(splitForSending(HIS_EXAMPLE, opts)).toEqual([
      '落了。',
      '09:00 那条节律改成了：切专注 + 当场挂一条 40 分钟后的提醒。',
      '到点我看一眼，热就续、静就切回攒批。',
      '今天这条已经补上了，10:12 响。',
    ]);
  });

  it('单句(哪怕很长)不拆:拆句不该制造气泡', () => {
    const one = '我把她那条 40 分钟的提醒挂上了，到点看一眼再决定续还是切回攒批，先跟你说一声。';
    expect(splitForSending(one, opts)).toEqual([one]);
  });

  it('问号与叹号也算句末(含半角,但半角要后面跟空白或结尾)', () => {
    expect(splitForSending('在吗？我看一眼。好！', opts)).toEqual(['在吗？', '我看一眼。', '好！']);
    expect(splitForSending('在吗? 我看一眼。好!', opts)).toEqual(['在吗?', '我看一眼。', '好!']);
  });

  it('半角 ?/! 后面紧跟着字时不断句:那是网址的参数,不是句末', () => {
    const one = '真的吗?那就这样!';
    expect(splitForSending(one, opts)).toEqual([one]);
  });

  it('逗号与分号不拆:它们是同一句里的停顿', () => {
    const one = '我先看一眼，热就续；静就切回攒批。';
    expect(splitForSending(one, opts)).toEqual([one]);
  });

  it('ASCII 句点与查询串里的 ? 都不会把网址拆碎', () => {
    const one = '网址是 https://a.b.example/c?x=1.5 记一下。';
    expect(splitForSending(one, opts)).toEqual(['网址是 https://a.b.example/c?x=1.5 记一下。']);
  });

  it('没有句末标点时按换行拆(她分行写就是在分段)', () => {
    expect(splitForSending('第一行\n第二行\n\n第三行', opts)).toEqual(['第一行', '第二行', '第三行']);
  });

  it('方括号标记里的标点不算断句:图片行的省略号不会把标记劈开', () => {
    const one = '看看这个 [图片 IMG-3 42KB;与 IMG-1 是同一份文件…] 再说。';
    expect(splitForSending(one, opts)).toEqual([one]);
  });

  it('断句点后面的收尾引号跟着这一句走', () => {
    expect(splitForSending('他说“走了。”我也走了。', opts)).toEqual(['他说“走了。”', '我也走了。']);
  });

  it('省略号是断句点,连续两个算一次(不拆成两个气泡)', () => {
    expect(splitForSending('嗯……好。', opts)).toEqual(['嗯……', '好。']);
  });

  it('CRLF 当换行', () => {
    expect(splitForSending('落了。\r\n\r\n补上了。', opts)).toEqual(['落了。', '补上了。']);
  });

  it('空白与空串不产出气泡', () => {
    expect(splitForSending('   \n\n  ', opts)).toEqual([]);
    expect(splitForSending('', opts)).toEqual([]);
  });

  it('超过上限:前 max-1 条照发,剩下的并成最后一条(换行接回,保住分段)', () => {
    const text = '一。二。三。四。五。六。七。八。';
    const out = splitForSending(text, { maxChunks: 6 });
    expect(out).toHaveLength(6);
    expect(out.slice(0, 5)).toEqual(['一。', '二。', '三。', '四。', '五。']);
    expect(out[5]).toBe('六。\n七。\n八。');
  });

  it('上限为 1 时整段并成一条', () => {
    expect(splitForSending('一。二。', { maxChunks: 1 })).toEqual(['一。\n二。']);
  });
});
