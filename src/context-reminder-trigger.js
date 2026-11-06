'use strict';

const { parseContextReminderCommand } = require('./context-reminder-commands');

function createContextReminderTrigger({ store, loadAccount, sendText, sendLongText, log }) {
  async function trigger(senderId, event, onCheckError = () => {}) {
    let deliveryStarted = false;
    try {
      const account = loadAccount();
      if (!account || senderId !== account.userId) return false;
      return await store.trigger('owner', event, (text, clientId) => {
        deliveryStarted = true;
        return sendText(account, senderId, text, { clientId, record: false, proactive: true });
      });
    } catch (error) {
      log(`context reminder trigger failed: ${error.message || String(error)}`);
      if (!deliveryStarted) onCheckError(error);
      return false;
    }
  }
  async function message(senderId, text) {
    const account = loadAccount();
    if (!account || senderId !== account.userId) return false;
    // Check the old reminders before creating a new one from this message.
    let triggerError;
    await trigger(senderId, { type: 'message', text }, error => { triggerError = error; });
    const command = parseContextReminderCommand(text);
    if (!command) return false;
    let reply;
    try {
      if (triggerError) throw triggerError;
      reply = store.handle('owner', command);
    } catch (error) { reply = `情境提醒本次未处理：${error.message || String(error)}`; }
    await sendLongText(account, senderId, reply, 1700, { record: false, numberChunks: true });
    return true;
  }
  return { trigger, message };
}

module.exports = { createContextReminderTrigger };
