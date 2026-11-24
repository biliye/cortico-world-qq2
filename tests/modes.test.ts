import { describe, expect, it } from 'vitest';
import { QQ_MODES, convOf, isQQMode, planDelivery } from '../src/modes.ts';

const group = { kind: 'group' as const, id: 123 };
const priv = { kind: 'private' as const, id: 456 };

describe('convOf', () => {
  it('读 meta.conv,群与私聊都认', () => {
    expect(convOf({ meta: { conv: { kind: 'group', id: 1 } } })).toEqual({ kind: 'group', id: 1 });
    expect(convOf({ meta: { conv: { kind: 'private', id: 2 } } })).toEqual({ kind: 'private', id: 2 });
  });

  it('数字字符串也归一成数字', () => {
    expect(convOf({ meta: { conv: { kind: 'group', id: '77' } } })).toEqual({ kind: 'group', id: 77 });
  });

  it('不是会话事件的返回 null', () => {
    expect(convOf({})).toBeNull();
    expect(convOf({ meta: {} })).toBeNull();
    expect(convOf({ meta: { conv: { kind: 'group' } } })).toBeNull();
    expect(convOf({ meta: { conv: { kind: 'channel', id: 1 } } })).toBeNull();
    expect(convOf({ meta: { conv: { kind: 'group', id: 'x' } } })).toBeNull();
  });
});

describe('isQQMode', () => {
  it('只认四个档位', () => {
    for (const m of QQ_MODES) expect(isQQMode(m)).toBe(true);
    expect(isQQMode('awake')).toBe(false);
    expect(isQQMode(undefined)).toBe(false);
    expect(isQQMode(2)).toBe(false);
  });
});

describe('planDelivery', () => {
  it('私聊与非会话事件在任何模式下都不改投递', () => {
    for (const mode of QQ_MODES) {
      expect(planDelivery(mode, priv)).toEqual({ deliver: true });
      expect(planDelivery(mode, null)).toEqual({ deliver: true });
    }
  });

  it('攒批:不动调用方给的 trigger(被@ 那条 flush 因此仍立即投递)', () => {
    expect(planDelivery('batch', group)).toEqual({ deliver: true });
  });

  it('专注:群里每条都 flush', () => {
    expect(planDelivery('focus', group)).toEqual({ deliver: true, trigger: 'flush' });
  });

  it('睡眠:群里每条都只落库,不进投递队列', () => {
    expect(planDelivery('sleep', group)).toEqual({ deliver: false });
  });

  it('睡眠 + 被@:仍然唤醒她,而且立即给(唯一的例外口)', () => {
    expect(planDelivery('sleep', group, { mention: true })).toEqual({ deliver: true, trigger: 'flush' });
  });

  it('被@ 这条例外只对群生效(私聊与非会话事件本来就不受模式管)', () => {
    expect(planDelivery('sleep', priv, { mention: true })).toEqual({ deliver: true });
    expect(planDelivery('sleep', null, { mention: true })).toEqual({ deliver: true });
  });

  it('攒批与专注下 mention 不改变结论(它们本来就投)', () => {
    expect(planDelivery('batch', group, { mention: true })).toEqual({ deliver: true });
    expect(planDelivery('focus', group, { mention: true })).toEqual({ deliver: true, trigger: 'flush' });
  });

  it('压缩:群里每条只落库并进账本,不立即投', () => {
    expect(planDelivery('digest', group)).toEqual({ deliver: false, accumulate: true });
  });

  it('压缩 + 被@:仍然立刻叫醒,而且不进账本(不会重复说两遍)', () => {
    expect(planDelivery('digest', group, { mention: true })).toEqual({ deliver: true, trigger: 'flush' });
  });

  it('压缩只管群:私聊照旧投', () => {
    expect(planDelivery('digest', priv)).toEqual({ deliver: true });
    expect(planDelivery('digest', null)).toEqual({ deliver: true });
  });
});
