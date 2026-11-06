'use strict';
const path = require('node:path');
const { parsePersonalTodoCommand } = require('./personal-todo-commands');
const { createPersonalTodoStore } = require('./personal-todo-store');
const { parseExpenseLedgerCommand } = require('./expense-ledger-commands');
const { createExpenseLedgerStore } = require('./expense-ledger-store');
const { parseTemporaryNoteCommand } = require('./temporary-note-commands');
const { createTemporaryNoteStore } = require('./temporary-note-store');
const { parseHabitCommand } = require('./habit-commands');
const { createHabitStore } = require('./habit-store');
const { resultText } = require('./feature-result');

const HELP = '支持：记一下 明天买牛奶；我的待办；记账 12元 餐饮 示例午餐；今日账单；存临时信息 示例备忘；临时信息；创建习惯：散步；我的习惯。普通问答需要自备模型。';
function createPublicAssistant({ runtime, model = null, helpText = HELP }) {
  const stateFile = feature => path.join(runtime, 'state', 'features', feature, 'state.json');
  const routes = [
    [parsePersonalTodoCommand, createPersonalTodoStore({ stateFile: stateFile('todo') })],
    [parseExpenseLedgerCommand, createExpenseLedgerStore({ stateFile: stateFile('expense') })],
    [parseTemporaryNoteCommand, createTemporaryNoteStore({ stateFile: stateFile('notes') })],
    [parseHabitCommand, createHabitStore({ stateFile: stateFile('habit') })],
  ];
  return {
    async reply(text, side = 'owner') {
      if (!['owner', 'friend'].includes(side)) throw new Error('invalid assistant side');
      const value = String(text || '').trim();
      if (!value || /^(?:帮助|help)$/iu.test(value)) return helpText;
      for (const [parse, store] of routes) {
        const command = parse(value);
        if (command) {
          const result = await (store.execute ? store.execute(side, command) : store.handle(side, command));
          return resultText(result);
        }
      }
      // Text generation cannot select tools or mutate feature stores.
      return model ? model(value) : helpText;
    },
  };
}
module.exports = { createPublicAssistant, HELP };
