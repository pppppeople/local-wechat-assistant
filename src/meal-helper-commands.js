'use strict';

const { inventoryNameKey } = require('./shared-life-store');
const { expiryDaysLeft } = require('./belonging-expiry');
const { validateRecipe } = require('./meal-helper-provider');
const REFUSAL = '做饭助手仅主人可用，好友不能查询食材或获取菜谱。';
const USAGE = '请用「做饭：番茄 半颗、鸡蛋 2个、盐 一点」指定 1 至 10 项食材；数量可省略，仅作参考。仅支持纯文字。';
const FAILURE = '做饭建议生成失败，请稍后重新指定食材再试。';

function ingredientEntry(raw) {
  // Explicit whitespace/parentheses separate arbitrary free-text quantities.
  // Also accept common attached quantities without estimating or converting them.
  const match = raw.match(/^(.+?)(?:\s+(.+)|[（(]([^（）()]+)[）)]|((?:约|大约)?(?:一点|少许|适量|半[颗个根块盒袋瓶碗勺斤两]?|[\d一二两三四五六七八九十]+(?:\.[\d]+)?[颗个根块盒袋瓶碗勺斤两克]+)))$/u);
  return match ? { name: match[1].trim(), quantity: match[2] || match[3] || match[4], raw }
    : { name: raw, quantity: '', raw };
}

function parseMealHelperCommand(text) {
  const value = String(text || '').trim();
  if (value === '换一道') return { type: 'change' };
  const match = value.match(/^做饭\s*[：:]([\s\S]*)$/u);
  if (!match && value !== '做饭') return null;
  return { type: 'generate', ingredients: (match?.[1] || '').split(/[、，,\n]/u)
    .map(item => item.trim()).filter(Boolean).map(ingredientEntry) };
}

function createMealHelperCommands({ provider, inventory, now = () => Date.now() }) {
  let session = null; // One current bound owner session; never a file or model thread.
  return { async execute(side, command, { sessionKey = 'owner', hasMedia = false } = {}) {
    if (side !== 'owner') return { reply: REFUSAL, wrote: false };
    const result = reply => ({ reply, wrote: false });
    if (session && session.key !== sessionKey) session = null;
    if (hasMedia) return result(USAGE);
    if (!command || !['generate', 'change'].includes(command.type)) return result(USAGE);
    if (command.type === 'generate') {
      session = null;
      if (!Array.isArray(command.ingredients) || !command.ingredients.length) return result(USAGE);
      if (command.ingredients.length > 10) return result('一次最多指定 10 项食材，请删减后重试。');
      session = { key: sessionKey, ingredients: command.ingredients.map(item => ({ ...item })), previousDish: '', busy: false };
    } else if (!session || session.key !== sessionKey || !session.previousDish) {
      return result('没有本次会话的菜谱，请先用「做饭：食材1、食材2」指定食材。');
    }
    const current = session;
    if (current.busy) return result('上一道菜谱仍在生成，请稍后再换一道。');
    current.busy = true;
    let warning = '';
    try {
      // The adapter can only project explicitly named inventory entries. Never use a list as ingredients.
      const rows = inventory.readNamedInventory('owner', current.ingredients.map(item => item.name));
      const ingredients = current.ingredients.map(item => {
        const expired = rows.some(row => {
          if (inventoryNameKey(row.name) !== inventoryNameKey(item.name) || !row.expiresAt) return false;
          try { return expiryDaysLeft(row.expiresAt, now()) < 0; } catch { return false; }
        });
        return { ...item, expired };
      });
      const expiredNames = ingredients.filter(item => item.expired).map(item => item.name);
      if (expiredNames.length) warning = `\n\n过期提示：${expiredNames.join('、')}已过期，建议不要使用。`;
      const recipe = validateRecipe(await provider.generate({ ingredients, previousDish: current.previousDish }));
      if (recipe.used.some(index => !ingredients[index - 1] || ingredients[index - 1].expired)
        || (ingredients.some(item => !item.expired) && !recipe.used.length)
        || recipe.missing.some(name => ingredients.some(item => inventoryNameKey(item.name) === inventoryNameKey(name)))
        || (current.previousDish && inventoryNameKey(recipe.dish) === inventoryNameKey(current.previousDish))) throw Error('invalid meal selection');
      if (session === current) current.previousDish = recipe.dish;
      return result([
        `推荐菜名：\n${recipe.dish}`,
        `做法要点：\n${recipe.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
        ['所用食材与缺口：', ...recipe.used.map(index => {
          const item = ingredients[index - 1];
          return `所用：${item.name}｜${item.quantity ? `${item.quantity}（主人原文，仅供参考）` : '适量'}`;
        }), ...(recipe.missing.length ? recipe.missing.map(name => `需另备：${name}｜适量`) : ['缺口：无另备建议。']),
        `主人指定原文：${ingredients.map(item => item.raw).join('、')}`, '可回复「换一道」；菜谱质量待人工抽查。'].join('\n') + warning,
      ].join('\n\n'));
    } catch {
      if (session === current) session = null;
      return result(FAILURE + warning);
    } finally { current.busy = false; }
  } };
}

module.exports = { REFUSAL, USAGE, FAILURE, parseMealHelperCommand, createMealHelperCommands };
