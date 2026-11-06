'use strict';

const MAX_CLUES = 5;
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['background', 'answer', 'clues'],
  properties: {
    background: { type: 'string', minLength: 1, maxLength: 1200 },
    answer: { type: 'string', minLength: 1, maxLength: 200 },
    clues: { type: 'array', minItems: 1, maxItems: MAX_CLUES,
      items: { type: 'string', minLength: 1, maxLength: 500 } },
  },
};
function validateCase(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'answer,background,clues'
    || !['background', 'answer'].every(key => typeof value[key] === 'string' && value[key].trim()
      && value[key].length <= SCHEMA.properties[key].maxLength)
    || !Array.isArray(value.clues) || !value.clues.length || value.clues.length > MAX_CLUES
    || value.clues.some(clue => typeof clue !== 'string' || !clue.trim() || clue.length > 500)) {
    throw Error('invalid detective case');
  }
  return { background: value.background.trim(), answer: value.answer.trim(), clues: value.clues.map(clue => clue.trim()) };
}
function createDetectiveGameProvider({ model }) {
  return { async generate() {
    const result = await model([
      '生成一个完全虚构、可由线索推出唯一合理解的简短推理小游戏案件，一次生成并固定全部真相。',
      'background 只写公开案件背景与明确待解问题，说明答案应提交的简短形式，不写答案或未揭示线索。',
      'answer 是隐藏的唯一简短标准答案；clues 是按调查顺序排列的 1–5 条线索，逐条增加证据，全部线索足以推出答案。',
      '答案使用客观简短词语（例如嫌疑人的名字），供本地精确比对；不要求模型再判题，不生成替代答案。',
      '不以真实聊天内容作剧情素材，不引用或推断主人的真实个人信息。不读取历史、文件、邮件、专业系统、好友聊天，不调用工具。',
      '只返回符合 schema 的 JSON，不建待办、不保存草稿、不发送消息。',
    ].join('\n'), '', [], { schema: SCHEMA, parse: text => validateCase(JSON.parse(text)), stage: 'detective_game_generate' });
    if (!result?.ok) throw Error('detective case generation failed');
    return validateCase(result.value);
  } };
}
module.exports = { createDetectiveGameProvider, validateCase, MAX_CLUES };
