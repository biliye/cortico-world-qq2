import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QQ2 } from '../src/definition.ts';

let dataDir: string;

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'qq2-voice-panel-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

function fixture() {
  const cfg = QQ2.defaults();
  const secrets = new Map<string, string>();
  const storeSecret = vi.fn((name: string, value: string) => { secrets.set(name, value); });
  const world = QQ2.create({
    id: 'qq2', cfg, dataDir, timezone: 'Asia/Shanghai', botName: 'test',
    botDir: dataDir, packageDir: dataDir, repoRoot: dataDir,
    secret: (name) => secrets.get(name) ?? '',
    storeSecret,
    persist: vi.fn(),
    restart: vi.fn(),
  });
  const call = (method: string, args: unknown[] = []) => world.webUi!().invoke!('voice', method, args);
  return { call, cfg, secrets, storeSecret };
}

describe('语音密钥面板', () => {
  it('在 World 未启用时也能保存和更换密钥，只返回配置状态', async () => {
    const { call, cfg, storeSecret } = fixture();
    expect(cfg.enabled).toBe(false);
    await expect(call('state')).resolves.toEqual({ keyConfigured: false });
    await expect(call('setApiKey', [' test-token-1 '])).resolves.toEqual({ keyConfigured: true });
    expect(storeSecret).toHaveBeenLastCalledWith('MINIMAX_API_KEY', 'test-token-1');
    await expect(call('setApiKey', ['test-token-2'])).resolves.toEqual({ keyConfigured: true });
    expect(storeSecret).toHaveBeenLastCalledWith('MINIMAX_API_KEY', 'test-token-2');
    await expect(call('state')).resolves.toEqual({ keyConfigured: true });
  });

  it('识别旧密钥并沿用用户选的变量名', async () => {
    const { call, cfg, secrets, storeSecret } = fixture();
    cfg.voice.apiKeySecret = 'QQ_TTS_KEY';
    secrets.set('QQ_TTS_KEY', 'existing-test-token');
    await expect(call('state')).resolves.toEqual({ keyConfigured: true });
    await expect(call('setApiKey', ['replacement-test-token'])).resolves.toEqual({ keyConfigured: true });
    expect(storeSecret).toHaveBeenCalledTimes(1);
    expect(storeSecret).toHaveBeenCalledWith('QQ_TTS_KEY', 'replacement-test-token');
  });

  it('拒绝空值、额外的 .env 行和替换指令，避免覆盖原密钥', async () => {
    const { call, secrets, storeSecret } = fixture();
    secrets.set('MINIMAX_API_KEY', 'existing-test-token');
    for (const key of ['', null, 'test-token\nOTHER=other', 'abc$&def']) {
      await expect(call('setApiKey', [key])).rejects.toThrow('请输入有效的 MiniMax API Key');
    }
    expect(storeSecret).not.toHaveBeenCalled();
    await expect(call('state')).resolves.toEqual({ keyConfigured: true });
  });

  it('保存失败时隐藏宿主错误中的密钥', async () => {
    const { call, storeSecret } = fixture();
    storeSecret.mockImplementationOnce(() => { throw new Error('sensitive-test-token'); });
    await expect(call('setApiKey', ['sensitive-test-token'])).rejects.toThrow(
      /^写入 MiniMax API Key 失败，请检查 Coo 数据目录的写入权限。$/,
    );
    await expect(call('state')).resolves.toEqual({ keyConfigured: false });
  });
});
