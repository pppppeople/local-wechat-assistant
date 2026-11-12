'use strict';

// Deliberately narrow admission, not a replacement intent parser. Unknown text
// stays on the existing public host text/feature path.
const EXECUTION = /提醒|记账|账单|待办|天气|地点|想去箱|转告|接力|发送|发给|保存|存入|记下|记上|设置|设定|安排|创建|删除|取消|修改|更新|开启|关闭|打开|查询|查一下|查查|查一查|查找|搜索|搜一下|检索|执行|运行|下载|上传|读取|文件|邮件|邮箱|日历|闹钟|笔记|模板|任务|电脑|浏览器|通知|导航|打车|订票|预订|购买|下单|启动|停止|截屏|备份|部署|安装|导出|导入|验证码|权限|API|remind|todo|weather|search|send|save|delete|execute/iu;
const AMBIGUOUS = /这个|那个|这些|那些|刚才|上次|之前|照旧|继续|同上|那就|它|他|她|还是|第[一二三四五六七八九十\d]|帮我|替我/iu;
const INJECTION = /忽略|无视|系统提示|提示词|越狱|开发者|system\s*prompt|ignore.*instruct/iu;
const TEMPORAL = /\d|[零〇一二两三四五六七八九十百千万亿]+(?:元|块|点|时|分|秒|年|月|日|号)|今天|明天|后天|昨天|今晚|明早|本周|下周|星期|周末|最近|现在|实时|最新|目前/iu;
const L0 = /^(?:你好|嗨|哈喽|早|早安|午安|晚安|晚上好|早上好|谢谢|谢谢你|谢啦|多谢|辛苦啦|辛苦了|不客气|嗯|嗯嗯|好|好的|好呀|好哒|收到|明白了|知道啦|哈哈|哈哈哈|嘿嘿|我好累|有点累|我好开心|好开心|有点难过|我有点难过|有点烦|我好烦|想躺平|抱抱)[呀啊哦呢啦～~！!。,.，\s]*$/u;
// Stable, self-contained text questions only. Anything else is uncertain (L2).
const L1 = /^(?:为什么(?:天空(?:看起来)?是蓝色的|树叶(?:会)?变黄|猫(?:爱|喜欢)睡觉|海水是咸的|冰会浮在水面|月亮有圆缺|会出现彩虹)|什么是(?:光合作用|比喻|散文|小说|惯性|质数|修辞|共情|押韵|反讽)|(?:画龙点睛|守株待兔|共情|反讽)是什么意思|(?:散文和小说|比喻和拟人|同情和共情)有什么区别|你觉得(?:独处有什么乐趣|阅读有意思吗|散步能让人放松吗|音乐能表达情绪吗|友谊需要经常联系吗)|你喜欢(?:安静的音乐|音乐|阅读|猫|狗|什么颜色)[吗呢？?]*|(?:如何|怎样|怎么)(?:把道歉说得自然|缓解紧张|理解比喻|表达感谢)|我(?:感觉|觉得|有时候(?:觉得)?|总是(?:觉得)?)(?:独处|阅读|散步|休息|工作|学习|和朋友相处)?(?:很|有点|特别)?(?:舒服|疲惫|紧张|焦虑|开心|难过|孤独|委屈|烦躁|平静|有趣|放松))[？?。！!]*$/u;

// Generic short language shapes; all existing exclusions and whitelists run first.
const SHORT_SHAPES = [
  ['L0', 'short_acknowledgement', /^(?:(?:好|行)吧|嗯+|哦+|噢+|喔+|好+|明白|明白了|知道了|知道啦|了解|收到|没事|没关系|不用谢)[啊呀哦噢喔呢啦哒哈诶耶～~！!。,.，\s]*$/u],
  ['L0', 'short_confirmation', /^(?:行|可以|对|是的|是呀|没错)[啊呀哦噢喔呢啦哒哈诶耶～~！!。,.，\s]*$/u],
  ['L0', 'repeated_laughter', /^(?:哈{2,}|嘿{2,}|嘻{2,}|呵{2,})[啊呀哦啦～~！!。\s]*$/u],
  ['L0', 'short_personal_state', /^(?:我)?(?:好|很|有点|有些|太|真的|真|特别|超级)?(?:累|困|饿|冷|热|开心|难过|烦|无聊|紧张|焦虑|委屈|孤独|疲惫|放松|舒服|高兴|快乐|幸福|难受|不开心)(?:了|啊|呀|呢|啦|哦|死了|极了|得很|得慌)*[！!。～~\s]*$/u],
  ['L1', 'identity_question', /^(?:你(?:是谁|叫什么(?:名字)?)|(?:该)?怎么称呼你|你的(?:名字|称呼)是什么)[啊呀呢？?！!。～~\s]*$/u],
];

function classifyChatLane({ text, state, imagePaths = [], hasAttachment = false, fragments = 1 } = {}) {
  const result = (lane, ...reasonCodes) => ({ lane, reasonCodes });
  if (!state || state.known !== true) return result('L2', 'state_unknown');
  if (!Array.isArray(imagePaths) || state.history !== undefined && !Array.isArray(state.history)) return result('L2', 'invalid_features');
  if (state.pending || state.pendingReasons?.length) return result('L2', 'pending_state');
  if (state.recovery || state.forceOrdinary || state.featureHints || state.hasEffects) return result('L2', 'existing_route');
  const last = state.history?.at(-1);
  if (last && (last.kind && last.kind !== 'chat' || /[？?]|待确认|请选择|请回复|看用法回|等你|确认码/u.test(last.assistant || '')))
    return result('L2', 'context_followup');
  if (typeof text !== 'string' || !text.trim()) return result('L2', 'empty_text');
  const value = text.trim();
  if (imagePaths.length || hasAttachment || /https?:|www\.|\[[^\]]*\]\(|附件|图片|截图|语音|视频/iu.test(value)) return result('L2', 'media_or_link');
  if (INJECTION.test(value)) return result('L2', 'instruction_override');
  if (EXECUTION.test(value)) return result('L2', 'feature_or_execution');
  if (AMBIGUOUS.test(value)) return result('L2', 'ambiguous_reference');
  if (fragments > 1 || /[\r\n]|然后|另外|顺便|同时|还有|并且|以及|先.+再|[；;]|[，,、].*\S/u.test(value)) return result('L2', 'multiple_or_fragments');
  if (value.length > 100) return result('L2', 'long_or_uncertain');
  if (TEMPORAL.test(value)) return result('L2', 'numeric_or_temporal');
  if (value.length <= 16 && L0.test(value)) return result('L0', 'smalltalk_whitelist');
  if (L1.test(value)) return result('L1', 'self_contained_text');
  if (value.length <= 16) {
    for (const [lane, reason, shape] of SHORT_SHAPES) if (shape.test(value)) return result(lane, reason);
  }
  return result('L2', 'uncertain_text');
}

function localDraftGate(reply) {
  if (typeof reply !== 'string' || !reply.trim()) return { ok: false, reason: 'empty' };
  if (reply.length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|^\s*(?:```|\{\s*"(?:reply|actions|needs_tool)")/u.test(reply)) return { ok: false, reason: 'format' };
  // No execution exists in either fast lane, so every completion assertion is
  // unsupported. Conservative matches (including quotes/negation) fall back.
  if (/(?:已(?:经)?|刚刚|刚才).{0,32}(?:提醒|记上|记下|记好|记住|记入|记录|保存|设置|设好|设定|安排|创建|建好|添加|发出|发送|发给|转告|转发|删除|取消|更新|查到|查过|查好|查了|执行|提交|完成|打开|关闭|订好|定好|预约|付款|转账)|(?:提醒|待办|闹钟|邮件|任务|消息).{0,8}(?:已|设置好了|设好了|记好了|发出去了)|(?:帮你|给你|为你|替你).{0,24}(?:好了|成功|完成|记了|保存了|发送了|设置了)|\b(?:I(?:'ve| have)?\s+(?:already\s+)?(?:set|saved|sent|scheduled|created|deleted)|(?:reminder|task|message)\s+(?:is|has been)\s+(?:set|saved|sent|created))\b/iu.test(reply.replace(/\s+/gu, ' ')))
    return { ok: false, reason: 'execution_claim' };
  return { ok: true, reason: null };
}

const FAST_ANSWER_SCHEMA = { type: 'object', additionalProperties: false,
  properties: { reply: { type: 'string' }, needs_tool: { type: 'boolean' } }, required: ['reply', 'needs_tool'] };
function parseFastAnswer(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || Object.keys(value).some(key => !['reply', 'needs_tool'].includes(key))
    || typeof value.reply !== 'string' || typeof value.needs_tool !== 'boolean') throw Error('Invalid fast answer');
  return value;
}

module.exports = { classifyChatLane, localDraftGate, FAST_ANSWER_SCHEMA, parseFastAnswer };
