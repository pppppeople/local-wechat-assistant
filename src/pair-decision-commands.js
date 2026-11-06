'use strict';

function cleanOption(value) {
  return String(value || '').replace(/^\s*(?:\d+[.、)）]|[-•])\s*/u, '').trim().slice(0, 80);
}

function splitOptions(text) {
  return String(text || '').split(/[、|｜/，,；;\n]+/u).map(cleanOption).filter(Boolean).slice(0, 8);
}

function parseNaturalChoice(value) {
  if (/(?:不想|不要|拒绝|也?可以|接受|首选|最想)/u.test(value)) return null;
  const match = String(value || '').match(/^(.{0,40}?)(吃|去|看|玩|买|选|用)([^？?]{1,200}?)(?:好|合适|比较好)?[？?]?$/u);
  if (!match || !/(?:还是|、|，|,)/u.test(match[3])) return null;
  if (!/还是/u.test(match[3]) && !/[？?]\s*$/u.test(value)) return null;
  const choiceText = match[3].replace(/(?:哪个|哪家|哪一个)(?:好|合适|比较好)?$/u, '');
  const choices = choiceText.split(/(?:还是|、|，|,)/u).map(cleanOption).filter(Boolean);
  const options = [...new Set(choices)].slice(0, 8);
  if (options.length < 2) return null;
  const context = match[1].trim();
  return { type: 'create', title: `${context}${match[2]}什么`.slice(0, 120), options };
}

function parseOpenDecision(value) {
  const text = String(value || '').trim().replace(/[？?。！!]+$/u, '');
  let match = text.match(/^(?:请)?帮我们(?:俩)?(?:一起)?(?:决定|看看|选选|规划)?[，,：:\s]*(.{2,120})$/u);
  if (!match) match = text.match(/^我们(?:俩)?(?:周末|这周末|今晚|明天|下周)?(?:吃什么|去哪(?:里)?|干嘛|怎么玩|看什么(?:电影)?|买哪个|几点出门)$/u);
  if (!match) return null;
  const title = String(match[1] || text).trim().slice(0, 120);
  return { type: 'create', title, options: [], mode: 'constraints' };
}

function parsePairDecisionCommand(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (/^(?:双人)?(?:私密)?(?:决策|投票)(?:帮助|说明|怎么用)$/u.test(value)) return { type: 'help' };
  if (/^(?:查看|看看|列出)(?:我们的|当前的)?(?:双人)?(?:私密)?(?:决策|投票)(?:列表)?[？?。]?$/u.test(value)) return { type: 'list' };
  let match = value.match(/^取消(?:双人)?(?:私密)?(?:决策|投票)\s*[#＃]?([A-Za-z0-9-]+)[。！!~～]?$/u);
  if (match) return { type: 'cancel', id: match[1].toUpperCase() };
  match = value.match(/^(?:(?:发起|创建|开)(?:一个)?|我们来)?(?:双人)?(?:私密)?(?:决策|投票)\s*[：:]\s*(.+?)\s*[；;]\s*(?:选项|候选|方案)\s*[：:]\s*(.+)$/u);
  if (!match) match = value.match(/^我们(?:一起)?(?:选|决定)\s*(.+?)\s*[，,；;]\s*(?:选项|候选|方案)(?:有|是)?\s*[：:]?\s*(.+)$/u);
  if (match) {
    const candidates = splitOptions(match[2]);
    if (candidates.length < 2) throw new Error('请至少给两个候选，用顿号或逗号隔开');
    return { type: 'create', title: match[1].trim().slice(0, 120), options: candidates };
  }
  const naturalChoice = parseNaturalChoice(value);
  if (naturalChoice) return naturalChoice;
  const openDecision = parseOpenDecision(value);
  if (openDecision) return openDecision;
  match = value.match(/^(?:双人)?(?:私密)?(?:决策|投票)(?:\s*[#＃]?([A-Za-z0-9-]+))?\s*[：:]\s*(.+)$/u);
  if (match && /(?:首选|最想|我选|可以|接受|都行|都可以|不要|不想|拒绝|\d\s*[>＞])/u.test(match[2])) {
    return { type: 'submit', id: String(match[1] || '').toUpperCase(), preferenceText: match[2].trim() };
  }
  if (options.hasPending === true
    && /(?:(?:我)?(?:首选|最想|选|想吃|想去|想看|想玩|喜欢|偏向)|(?:我)?(?:可以|接受|都行|都可以)|(?:我)?(?:不要|不想|拒绝)|预算|人均|室内|室外|远|近|随便|都可|\d\s*[>＞])/u.test(value)) {
    return { type: 'submit', id: '', preferenceText: value };
  }
  return null;
}

module.exports = { parseNaturalChoice, parseOpenDecision, parsePairDecisionCommand, splitOptions };
