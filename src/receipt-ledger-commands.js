'use strict';

const { CATEGORIES, parseAmountCents } = require('./expense-ledger-commands');
const { shanghaiDate, isLedgerDate } = require('./expense-ledger-store');
const { validateReceiptItems } = require('./receipt-ledger-provider');
const { changed, refused, unchanged } = require('./feature-result');
const REFUSAL = '截图记账仅主人可用，好友不能提取、查看或确认账目。';
const HINT = '核对后回复「确认记账」或「确认第1项」；取消回复「算了」。\n补正示例：「补正第1项 实付金额 12.50元」「补正第1项 分类 餐饮」「补正第1项 日期 2026-11-03」。补正后仍须确认才写入。';
const line = value => value.trim().replace(/[\r\n]+/gu, ' ');
function parseReceiptLedgerCommand(text, imagePaths = []) {
  const value = String(text || '').trim();
  if (value === '截图记账') return { type: 'extract', text: value, imagePaths };
  if (value === '确认记账') return { type: 'confirm_all' };
  if (value === '算了') return { type: 'discard' };
  let match = value.match(/^确认第(\d+)项$/u);
  if (match) return { type: 'confirm_selected', number: Number(match[1]) };
  match = value.match(/^补正第(\d+)项\s+(实付金额|分类|日期)\s+([^\r\n]+)$/u);
  if (match) return { type: 'correct', number: Number(match[1]), field: match[2], value: match[3].trim() };
  if (/^补正第\d+项/u.test(value)) return { type: 'invalid' };
  return null;
}
function money(cents) { return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}元`; }
function createReceiptLedgerCommands({ provider, ledger, now = () => Date.now() }) {
  // No receipt state file, image copy, chat memory or box. Restart discards this view.
  let preview = null;
  let queue = Promise.resolve();
  const hasPending = () => Boolean(preview?.some(item => item.status === 'pending'));
  function display() {
    return ['截图记账预览（确认前不写入消费流水）：', ...preview.map((item, i) => {
      const paid = item.amountCents !== null ? money(item.amountCents)
        : !item.paidAmount && (item.orderTotal || item.unclassifiedAmount) ? '未区分（待确认）' : '待确认';
      const orderCents = parseAmountCents(item.orderTotal);
      const order = orderCents !== null ? money(orderCents) : item.orderTotal ? '待确认'
        : item.paidAmount || item.unclassifiedAmount ? '未区分' : '待确认';
      return [`${i + 1}. 实付金额：${paid}；订单总额：${order}`,
        ...(item.unclassifiedAmount ? [`截图金额（性质未区分）：${item.unclassifiedAmount}`] : []),
        `分类：${CATEGORIES.includes(item.category) ? item.category : '待确认分类'}`,
        `日期（上海）：${isLedgerDate(item.date) ? item.date : '待确认'}`,
        ...(item.source ? [`来源：${item.source}`] : []), ...(item.note ? [`备注：${item.note}`] : []),
        ...(item.status === 'written' ? ['已记账'] : [])].join('\n');
    }), HINT].join('\n');
  }
  async function apply(command) {
    if (command?.type === 'extract') {
      preview = null;
      if (!command.imagePaths?.length) return refused('请带图片发送「截图记账」，本次没有写入流水。');
      try {
        const today = shanghaiDate(now());
        preview = validateReceiptItems(await provider.extract({ text: command.text, imagePaths: command.imagePaths, today }))
          .map(raw => {
            const item = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? line(value) : value]));
            return { ...item, date: item.date || today,
              amountCents: item.paidUncertain ? null : parseAmountCents(item.paidAmount), status: 'pending' };
          });
      } catch { return refused('截图记账提取失败，没有保留预览或写入流水，请重新带图发送「截图记账」。'); }
      if (!preview.length) return unchanged('没有识别到消费记录，没有写入流水。');
      return unchanged(display());
    }
    if (!command || !['confirm_all', 'confirm_selected', 'discard', 'correct'].includes(command.type)) return refused(HINT);
    if (!preview?.length) return unchanged('当前没有截图记账预览（重启后会丢弃），请重新带图发送「截图记账」。');
    if (command.type === 'discard') {
      preview = null;
      return unchanged('已取消截图记账，未确认项零写入；已记账项不受影响。');
    }
    if (command.type === 'correct') {
      const item = preview[command.number - 1];
      if (!item || !Number.isSafeInteger(command.number)) return refused('预览编号不存在。');
      if (item.status !== 'pending') return refused(item.status === 'written' ? '该项已记账，不能再补正预览。' : '该项写入结果不明，请先检查流水。');
      if (command.field === '实付金额') {
        const amountCents = parseAmountCents(command.value.replace(/元$/u, ''));
        if (amountCents === null) return refused('实付金额须大于零、最多两位小数且在安全整数分范围内。');
        item.amountCents = amountCents; item.paidAmount = command.value; item.paidUncertain = false;
      } else if (command.field === '分类') {
        if (!CATEGORIES.includes(command.value)) return refused(`请指定五类之一：${CATEGORIES.join('、')}。`);
        item.category = command.value;
      } else if (command.field === '日期') {
        if (!isLedgerDate(command.value)) return refused('日期须为有效的上海日期 YYYY-MM-DD。');
        item.date = command.value;
      } else return refused(HINT);
      return unchanged(display());
    }
    const numbers = command.type === 'confirm_all' ? preview.map((_, i) => i + 1) : [command.number];
    if (numbers.some(n => !Number.isSafeInteger(n) || n < 1 || n > preview.length)) return refused('预览编号不存在，没有写入流水。');
    const blocked = numbers.filter(n => preview[n - 1].status === 'pending'
      && (preview[n - 1].amountCents === null || !CATEGORIES.includes(preview[n - 1].category) || !isLedgerDate(preview[n - 1].date)));
    if (blocked.length) return refused(`第${blocked.join('、')}项的实付金额、分类或日期待确认，请主人先补正，再确认；本次零写入。\n${HINT}`);
    let wrote = false;
    const replies = [];
    for (const number of numbers) {
      const item = preview[number - 1];
      if (item.status === 'written') { replies.push(`第${number}项已记账，不重复写入。`); continue; }
      if (item.status === 'uncertain') { replies.push(`第${number}项写入结果不明，不重复尝试，请先查看流水。`); continue; }
      // A storage exception can happen after a write: never automatically replay it.
      item.status = 'uncertain';
      try {
        const result = await ledger.execute('owner', { type: 'add', amountCents: item.amountCents,
          category: item.category, note: [item.source, item.note].filter(Boolean).join('；'), date: item.date });
        item.status = result.wrote ? 'written' : 'pending';
        wrote ||= result.wrote;
        replies.push(`第${number}项：${result.reply}`);
      } catch {
        replies.push(`第${number}项写入结果不明，请先查看流水并恢复存储；后续项未执行，不自动重试。`);
        break;
      }
    }
    return wrote ? changed(replies.join('\n')) : unchanged(replies.join('\n'));
  }
  function execute(side, command) {
    // Reject before queueing, model access, preview lookup or ledger access.
    if (side !== 'owner') return Promise.resolve(refused(REFUSAL));
    const result = queue.then(() => apply(command));
    queue = result.catch(() => {});
    return result;
  }
  return { execute, hasPending };
}
module.exports = { parseReceiptLedgerCommand, createReceiptLedgerCommands, REFUSAL };
