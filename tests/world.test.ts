import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PushOptions, WorldHost } from 'cortico/core/types.ts';
import { EVENT_SOURCE, QQ2World, modeAwareHost } from '../src/world.ts';
import { IMAGES_DEFAULTS, type QQRosterEntry } from '../src/config.ts';
import type { QQMode } from '../src/modes.ts';

/** 只记 pushEvent 的假 host;其余成员由 Proxy 透传,这个包装只用到 pushEvent。 */
type PushedEvent = Parameters<WorldHost['pushEvent']>[0];

interface Recorded {
  event: PushedEvent;
  opts: PushOptions | undefined;
}

function fakeHost(recorded: Recorded[], extra: Record<string, unknown> = {}): WorldHost {
  let statReads = 0;
  const host = {
    pushEvent: async (event: PushedEvent, opts?: PushOptions) => {
      recorded.push({ event, opts });
      return { cursor: recorded.length, ts: '2026-01-01T00:00:00+08:00' };
    },
    get statReads(): number {
      statReads += 1;
      return statReads;
    },
    ...extra,
  };
  return host as unknown as WorldHost;
}

/** 一条典型的群消息事件(形状照 world.ts 里真正推的那种)。 */
const groupMessage = (): PushedEvent => ({
  type: 'qq.message',
  ts: '2026-01-01T12:00:00+08:00',
  source: 'qq',
  text: '[群「测试群」12:00] 甲(1): 在吗',
  senderKey: '1',
  meta: { conv: { kind: 'group', id: 100 } },
});

const privateMessage = (): PushedEvent => ({
  type: 'qq.message',
  ts: '2026-01-01T12:00:00+08:00',
  source: 'qq',
  text: '[私聊 12:00] 乙(2): 在吗',
  senderKey: '2',
  meta: { conv: { kind: 'private', id: 200 } },
});

function hostWith(mode: QQMode, recorded: Recorded[]): WorldHost {
  return modeAwareHost(fakeHost(recorded), () => mode);
}

describe('modeAwareHost', () => {
  it('睡眠:群事件改成仅落库', async () => {
    const recorded: Recorded[] = [];
    await hostWith('sleep', recorded).pushEvent(groupMessage(), { trigger: 'debounce' });
    expect(recorded).toEqual([{ event: groupMessage(), opts: { deliver: false } }]);
  });

  it('专注:群事件改成 flush', async () => {
    const recorded: Recorded[] = [];
    await hostWith('focus', recorded).pushEvent(groupMessage(), { trigger: 'debounce' });
    expect(recorded[0]?.opts).toEqual({ trigger: 'flush' });
  });

  it('攒批:调用方给的 trigger 原样传下去(被@ 的 flush 不被抹掉)', async () => {
    const recorded: Recorded[] = [];
    await hostWith('batch', recorded).pushEvent(groupMessage(), { trigger: 'flush' });
    expect(recorded[0]?.opts).toEqual({ trigger: 'flush' });
  });

  it('三种模式下私聊事件都不被动', async () => {
    for (const mode of ['batch', 'focus', 'sleep'] as const) {
      const recorded: Recorded[] = [];
      await hostWith(mode, recorded).pushEvent(privateMessage(), { trigger: 'debounce' });
      expect(recorded[0]?.opts, mode).toEqual({ trigger: 'debounce' });
    }
  });

  it('调用方显式写的 deliver:false 优先,睡眠与专注都不改写它', async () => {
    // 她自己发出去那条 qq.self 的回录就是这种:只落库,不能因为在专注里就被投给她。
    const self = { ...groupMessage(), type: 'qq.self' };
    for (const mode of ['batch', 'focus', 'sleep'] as const) {
      const recorded: Recorded[] = [];
      await hostWith(mode, recorded).pushEvent(self, { deliver: false });
      expect(recorded[0]?.opts, mode).toEqual({ deliver: false });
    }
  });

  it('模式是每次推送现读的,切换立刻生效', async () => {
    let mode: QQMode = 'batch';
    const recorded: Recorded[] = [];
    const host = modeAwareHost(fakeHost(recorded), () => mode);
    await host.pushEvent(groupMessage(), undefined);
    mode = 'sleep';
    await host.pushEvent(groupMessage(), undefined);
    expect(recorded[0]?.opts).toBeUndefined();
    expect(recorded[1]?.opts).toEqual({ deliver: false });
  });

  it('睡眠 + 点名说她(meta.mention):仍然投给她,并且立即', async () => {
    const recorded: Recorded[] = [];
    const mentioned = {
      ...groupMessage(),
      meta: { conv: { kind: 'group', id: 100 }, mention: true },
    } as PushedEvent;
    await hostWith('sleep', recorded).pushEvent(mentioned, { trigger: 'debounce' });
    expect(recorded[0]?.opts).toEqual({ trigger: 'flush' });
  });

  it('睡眠 + 群里的普通事件(没有 mention):还是只落库', async () => {
    const recorded: Recorded[] = [];
    const poke = {
      ...groupMessage(),
      type: 'qq.poke',
      meta: { conv: { kind: 'group', id: 100 } },
    } as PushedEvent;
    await hostWith('sleep', recorded).pushEvent(poke, undefined);
    expect(recorded[0]?.opts).toEqual({ deliver: false });
  });

  it('压缩:群事件只落库,并回调账本一次', async () => {
    const recorded: Recorded[] = [];
    const accumulated: Array<{ type: string; conv: unknown }> = [];
    const host = modeAwareHost(fakeHost(recorded), () => 'digest', {
      onAccumulate: (event, conv) => accumulated.push({ type: event.type, conv }),
    });
    await host.pushEvent(groupMessage(), { trigger: 'debounce' });
    expect(recorded[0]?.opts).toEqual({ deliver: false });
    expect(accumulated).toEqual([{ type: 'qq.message', conv: { kind: 'group', id: 100 } }]);
  });

  it('压缩 + 点名说她:立刻投,而且不进账本', async () => {
    const recorded: Recorded[] = [];
    let calls = 0;
    const host = modeAwareHost(fakeHost(recorded), () => 'digest', {
      onAccumulate: () => { calls += 1; },
    });
    const mentioned = {
      ...groupMessage(),
      meta: { conv: { kind: 'group', id: 100 }, mention: true },
    } as PushedEvent;
    await host.pushEvent(mentioned, { trigger: 'debounce' });
    expect(recorded[0]?.opts).toEqual({ trigger: 'flush' });
    expect(calls).toBe(0);
  });

  it('压缩不碰私聊;调用方显式 deliver:false 也不进账本', async () => {
    const recorded: Recorded[] = [];
    let calls = 0;
    const host = modeAwareHost(fakeHost(recorded), () => 'digest', {
      onAccumulate: () => { calls += 1; },
    });
    await host.pushEvent(privateMessage(), { trigger: 'debounce' });
    await host.pushEvent({ ...groupMessage(), type: 'qq.self' }, { deliver: false });
    expect(recorded[0]?.opts).toEqual({ trigger: 'debounce' });
    expect(recorded[1]?.opts).toEqual({ deliver: false });
    expect(calls).toBe(0);
  });

  it('host 上的 getter 不被冻住(这是用 Proxy 而不是展开对象的原因)', () => {
    const recorded: Recorded[] = [];
    const host = hostWith('batch', recorded) as unknown as { statReads: number };
    expect(host.statReads).toBe(1);
    expect(host.statReads).toBe(2);
  });
});

describe('事件 source', () => {
  it('沿用 qq 这个命名空间:迁移前的历史与消息号才连得上', () => {
    expect(EVENT_SOURCE).toBe('qq');
  });
});

describe('QQ2World', () => {
  const cfg = { wsUrl: 'ws://127.0.0.1:3001', groups: [100], privates: [200], token: '' };

  it('id 是 qq2(内建 qq 的 id 被装配层保留,扩展不能重名)', () => {
    expect(new QQ2World(cfg).id).toBe('qq2');
  });

  it('工具名不与内建 qq World 的撞,且都在', () => {
    const world = new QQ2World(cfg);
    const names = world.tools().map((t) => t.name);
    // 内建 src/worlds/qq 的工具名(它们占着这些名字,check:extension 拿全量做重名检查)
    const builtin = ['qq_draft', 'qq_confirm', 'qq_read_history', 'qq_grep_history', 'qq_view_image'];
    for (const n of builtin) expect(names).not.toContain(n);
    expect(names).toEqual(
      expect.arrayContaining(['qq2_mode', 'qq2_draft', 'qq2_confirm', 'qq2_read_history', 'qq2_grep_history']),
    );
    for (const n of names) expect(n.startsWith('qq2_')).toBe(true);
  });

  it('配置里的初值就是当前模式;缺省是攒批', () => {
    expect(new QQ2World(cfg).currentMode()).toBe('batch');
    expect(new QQ2World({ ...cfg, mode: 'sleep' }).currentMode()).toBe('sleep');
    // 配置里被写坏的值不生效,回落到默认
    expect(new QQ2World({ ...cfg, mode: 'nonsense' as QQMode }).currentMode()).toBe('batch');
  });

  it('环境提示词带上当前模式', () => {
    const vars = new QQ2World({ ...cfg, mode: 'sleep' }).envPromptVars();
    expect(vars['qq.mode']).toBe('睡眠(sleep)');
    expect(vars['qq.conversations']).toContain('100');
  });

  it('监听名单保存时保留 attachImages;私聊不认这一格', async () => {
    let saved: { groups: QQRosterEntry[]; privates: QQRosterEntry[] } | null = null;
    const world = new QQ2World(cfg, {
      gate: {
        enabled: () => true,
        wsUrl: () => cfg.wsUrl,
        tokenSet: () => false,
        roster: () => ({ groups: [], privates: [] }),
        setRoster: (groups, privates) => {
          saved = { groups, privates };
          return 'ok';
        },
        setEnabled: () => {},
        setConnection: () => {},
        restart: () => {},
      },
    });
    await world.webUi().invoke!('roster', 'set', [
      [{ id: 100, enabled: true, attachImages: false }],
      [{ id: 200, enabled: true, attachImages: false }],
    ]);
    expect(saved!.groups[0]).toEqual({ id: 100, enabled: true, attachImages: false });
    expect(saved!.privates[0]!.attachImages).toBeUndefined();
  });

  it('qq2_mode 切模式:写回、回执把规矩讲清;坏输入被挡', async () => {
    const written: QQMode[] = [];
    const world = new QQ2World(cfg, { setMode: (m) => written.push(m) });
    const tool = world.tools().find((t) => t.name === 'qq2_mode')!;
    const call = (mode: unknown): Promise<string> =>
      tool.handler({ mode }, {} as Parameters<typeof tool.handler>[1]) as Promise<string>;

    const receipt = await call('sleep');
    expect(world.currentMode()).toBe('sleep');
    expect(written).toEqual(['sleep']);
    expect(receipt).toContain('睡眠(sleep)');
    expect(receipt).toContain('qq2_read_history');
    expect(receipt).toContain('私聊');

    expect(await call('awake')).toContain('[bad input]');
    expect(world.currentMode()).toBe('sleep');
    expect(written).toEqual(['sleep']);
  });

  it('qq2_mode 切到压缩时能顺手改窗口;回执与提示词都带上分钟数', async () => {
    const periods: number[] = [];
    const written: QQMode[] = [];
    // 每个用例一份自己的 cfg:setDigestMinutes 会改活对象,别串到别的用例里。
    const world = new QQ2World({ ...cfg }, {
      setMode: (m) => written.push(m),
      setDigestMinutes: (n) => periods.push(n),
    });
    const tool = world.tools().find((t) => t.name === 'qq2_mode')!;
    const receipt = await tool.handler(
      { mode: 'digest', minutes: 25 },
      {} as Parameters<typeof tool.handler>[1],
    ) as string;

    expect(written).toEqual(['digest']);
    expect(periods).toEqual([25]);
    expect(world.currentMode()).toBe('digest');
    expect(world.currentDigestMinutes()).toBe(25);
    expect(receipt).toContain('压缩(digest)');
    expect(receipt).toContain('25 分钟');
    expect(receipt).toContain('@');
    expect(world.envPromptVars()['qq.digest']).toBe('25');
    expect(world.envPromptVars()['qq.mode']).toContain('每 25 分钟');
  });

  it('压缩周期的坏值被挡,不改运行态也不写回', async () => {
    const periods: number[] = [];
    const world = new QQ2World({ ...cfg }, { setDigestMinutes: (n) => periods.push(n) });
    const tool = world.tools().find((t) => t.name === 'qq2_mode')!;
    const call = (args: Record<string, unknown>): Promise<string> =>
      tool.handler(args, {} as Parameters<typeof tool.handler>[1]) as Promise<string>;

    expect(await call({ mode: 'digest', minutes: 0 })).toContain('[bad input]');
    expect(await call({ mode: 'digest', minutes: -3 })).toContain('[bad input]');
    expect(await call({ mode: 'digest', minutes: 5000 })).toContain('[bad input]');
    expect(periods).toEqual([]);
    expect(world.currentDigestMinutes()).toBe(10);
  });
});

describe('qq2_get_image(按编号取回旧图)', () => {
  const cfg = { wsUrl: 'ws://127.0.0.1:3001', groups: [100], privates: [200], token: '' };

  /** 开一个真落盘目录的 World(取图库要有地方写才建),用完就删。 */
  function withLibrary(): { world: QQ2World; done: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'qq2-tool-'));
    return {
      world: new QQ2World({ ...cfg, dataDir: dir, images: { ...IMAGES_DEFAULTS } }),
      done: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it('既没视觉也没取图库时不出现(不给她摆一个永远失败的按钮)', () => {
    const names = new QQ2World(cfg).tools().map((t) => t.name);
    expect(names).not.toContain('qq2_get_image');
  });

  it('开了取图库就出现,且名字不撞内建', () => {
    const { world, done } = withLibrary();
    try {
      const names = world.tools().map((t) => t.name);
      expect(names).toContain('qq2_get_image');
      expect(names).not.toContain('qq_get_image');
      // 只读:不结束回合、不在它后面挡一刀
      const tool = world.tools().find((t) => t.name === 'qq2_get_image')!;
      expect(tool.tags).toEqual(['read']);
      expect(tool.endsTurn).toBeUndefined();
      expect(tool.barrierAfter).toBeUndefined();
    } finally {
      done();
    }
  });

  it('空库里按编号取:回 not found 并指一条找编号的路', async () => {
    const { world, done } = withLibrary();
    try {
      const tool = world.tools().find((t) => t.name === 'qq2_get_image')!;
      const out = String(await tool.handler({ image_id: 'IMG-7' }, {} as Parameters<typeof tool.handler>[1]));
      expect(out).toContain('[not found]');
      expect(out).toContain('IMG-7');
      expect(out).toContain('qq2_grep_history');
    } finally {
      done();
    }
  });
});
