'use strict';

function parseExperienceCommand(text) {
  const value = String(text || '').trim().replace(/^(?:助手|codex|Codex)\s*[,，:：]?\s*/i, '');
  if (/^(取消|取消回答|停止回答|停止搜索|别查了|不用查了)$/i.test(value)) return { type: 'cancel' };
  if (/^(换个话题|退出知识库|退出\s*知识库|退出\s*专业系统|清空上下文|重新开始)$/i.test(value)) return { type: 'reset' };
  if (/^(重试|再试一次|重试刚才(?:的)?问题|重新回答)$/i.test(value)) return { type: 'retry' };
  if (/^(改用|切换到|用)\s*专业系统(?:回答)?$/i.test(value)) return { type: 'switch', route: 'specialist' };
  if (/^(改用|切换到|用)\s*(?:知识库|知识库)(?:回答)?$/i.test(value)) return { type: 'switch', route: 'knowledge' };
  if (/^(改用|切换到|用)\s*(?:普通|普通助手|普通模型)(?:回答)?$/i.test(value)) return { type: 'switch', route: 'ordinary' };
  if (/^(更多功能|高级功能|全部功能)$/i.test(value)) return { type: 'more-help' };
  if (/^(运维状态|系统健康|服务健康|健康检查)$/i.test(value)) return { type: 'ops-status' };
  return null;
}

module.exports = { parseExperienceCommand };
