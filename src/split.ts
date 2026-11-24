/**
 * 发送前的自动拆句。
 *
 * 她写草稿的习惯是一整段(句号连句号、段落之间空行),到 QQ 上就是一堵墙。他让她
 * 「分批发」说过很多次,但那条口头规矩只活在上下文里,一次交接或重启就没了
 * (2026-09-28 那轮已有先例:交接后她把回复发去了控制台)。所以改成机械执行:
 * 拆句不再依赖她记得住,也不依赖她在草稿里自己做格式。
 *
 * 断开处只有两类,宁可少拆也不拆错:
 * - 换行(含空行)—— 她分段的地方本来就想断开;
 * - 句末标点 `。！？!?…` —— 一句一个气泡。
 *
 * 不在这里断:`，` 与 `；` 是同一句里的停顿;ASCII `.` 会把网址、小数、`e.g.` 拆碎。
 * `[表情包:x.png]`、`[表情22:白眼]` 这类方括号标记内部的标点不参与断句。
 *
 * 纯函数,边界在 `tests/split.test.ts` 里钉死。
 */

/** 断句标点(句末)。半角 `!?` 与 `…` 都算,`…` 常见于被打断的句子。 */
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '…']);

/**
 * 半角的 `!` `?` 只在下一位是空白或结尾时才断句。
 * 理由是网址与查询串:`…/c?x=1.5` 里的 `?` 后面紧跟参数,不是句末。
 * (半角标点出现在中文里本来就少,少拆一次的代价远小于把一条网址劈成两半。)
 */
const HALF_WIDTH = new Set(['!', '?']);

/** 下一位是空白/结尾就算句末。 */
function endsSentenceHere(chars: readonly string[], i: number): boolean {
  const next = chars[i + 1];
  return next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '\r';
}

/**
 * 断句点之后跟着的收尾符号,要一起留在这一句里:
 * `他说“走了。”` 断在最后一个 `”` 之后,而不是引号前面。
 */
const CLOSERS = new Set(['”', '’', '」', '』', '》', '〉', '）', ')', '】', '"', "'"]);

export interface SplitOptions {
  /**
   * 一条草稿最多发几条。超出的并成最后一条。
   * 防的是「一份长报告拆成二十个气泡」——那既像刷屏,也离 QQ 风控更近一步。
   */
  maxChunks: number;
}

/** 拆成要逐条发送的正文。整段没有断点时返回单元素数组(与不拆等价)。 */
export function splitForSending(text: string, opts: SplitOptions): string[] {
  const max = Number.isFinite(opts.maxChunks) ? Math.max(1, Math.floor(opts.maxChunks)) : 1;
  // 统一换行:Windows 那边来的草稿可能是 CRLF
  const src = text.replace(/\r\n?/g, '\n');

  const chunks: string[] = [];
  let buf = '';
  let depth = 0; // 方括号深度 > 0 = 在标记内部
  let closing = false; // 刚断过句,还在吃收尾符号

  const flush = (): void => {
    const s = buf.trim();
    if (s) chunks.push(s);
    buf = '';
  };

  const chars = [...src];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    // 断句点之后先把收尾符号吃完;遇到别的字符才真的断,并把它当普通字符继续处理。
    if (closing && !TERMINATORS.has(ch) && !CLOSERS.has(ch)) {
      flush();
      closing = false;
    }
    if (ch === '\n') {
      flush();
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']' && depth > 0) depth -= 1;
    buf += ch;
    if (depth > 0 || !TERMINATORS.has(ch)) continue;
    if (HALF_WIDTH.has(ch) && !endsSentenceHere(chars, i)) continue;
    closing = true;
  }
  flush();

  if (chunks.length <= max) return chunks;
  // 超出上限:前 max-1 条照发,剩下的并成一条(用换行接回去,保住原来的分段)。
  return [...chunks.slice(0, max - 1), chunks.slice(max - 1).join('\n')];
}
