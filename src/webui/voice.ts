import type { WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import { autoload, errText } from './client.ts';

interface VoiceState {
  keyConfigured: boolean;
}

export const voicePanel: WebUiPanel = {
  mount(ctx) {
    autoload<VoiceState>(ctx, {
      loading: '加载 MiniMax 密钥状态…',
      failed: 'MiniMax 密钥状态不可用',
      load: () => ctx.invoke<VoiceState>('state'),
      render: (state) => [keySheet(ctx, state)],
    });
  },
};

function keySheet(ctx: WebUiPanelContext, state: VoiceState): HTMLElement {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: 'MiniMax API Key', desc: '保存后，下一次 QQ 语音合成即可使用。' });
  const status = ui.rowbar();
  const message = ui.msgline('');
  message.setAttribute('role', 'status');
  const keyInput = ui.input({
    type: 'password',
    onInput: (value) => { save.disabled = !value.trim(); },
    onCommit: () => { void submit(); },
  });
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  const save = ui.button('保存密钥', {
    variant: 'primary',
    onClick: () => { void submit(); },
  });
  save.disabled = true;
  const actions = ui.actions();
  actions.append(message, ui.h('span', 'grow'), save);
  sheet.body.append(status, ui.field('API Key', keyInput), actions);
  showState(state);
  return sheet.el;

  function showState({ keyConfigured }: VoiceState): void {
    status.replaceChildren(ui.pill(keyConfigured ? '已配置' : '未配置', keyConfigured ? 'on' : 'off'));
    keyInput.placeholder = keyConfigured ? '输入新 Key 以更换' : '填入 MiniMax API Key';
  }

  async function submit(): Promise<void> {
    const key = keyInput.value.trim();
    if (save.disabled || !key) return;
    save.disabled = keyInput.disabled = true;
    message.classList.remove('bad');
    message.textContent = '正在保存…';
    try {
      const updated = await ctx.invoke<VoiceState>('setApiKey', [key]);
      if (ctx.signal.aborted) return;
      keyInput.value = '';
      showState(updated);
      message.textContent = '已保存';
    } catch (error) {
      if (ctx.signal.aborted) return;
      message.classList.add('bad');
      message.textContent = errText(error);
    } finally {
      if (!ctx.signal.aborted) {
        keyInput.disabled = false;
        save.disabled = !keyInput.value.trim();
      }
    }
  }
}
