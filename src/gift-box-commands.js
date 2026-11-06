'use strict';

function inferGiftCategory(text) {
  const value = String(text || '');
  if (/(?:尺码|码数|尺寸|穿.{0,8}[码号]|鞋.{0,8}[码号])/u.test(value)) return 'size';
  if (/(?:生日|纪念日|周年|相识日|日期)/u.test(value)) return 'occasion';
  if (/(?:喜欢|偏好|爱吃|口味|颜色|不喜欢|不吃|忌口)/u.test(value)) return 'preference';
  return 'idea';
}

function parseGiftBoxCommand(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (/^(?:惊喜模式|礼物箱)(?:帮助|说明|怎么用)$/u.test(value)) return { type: 'help' };
  if (/^(?:(?:查看|打开|看看|列出)(?:我的)?|我的)?(?:惊喜|礼物)(?:箱|清单|列表|线索)[？?。]?$/u.test(value)) return { type: 'list' };
  const indexOf = (raw) => ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[raw] || Number(raw));
  let match = value.match(/^(?:删除|移除)(?:我的)?(?:惊喜|礼物)箱(?:里)?(?:的)?第?([一二两三四五六七八九]|[1-9]\d*)个?[。！!~～]?$/u)
    || value.match(/^(?:惊喜|礼物)箱第?([一二两三四五六七八九]|[1-9]\d*)个?\s*(?:删除|移除)[。！!~～]?$/u);
  if (match) return { type: 'update', index: indexOf(match[1]), action: 'remove' };
  match = value.match(/^(?:惊喜|礼物)箱第?([一二两三四五六七八九]|[1-9]\d*)个?\s*(?:已经)?(?:买好|买了|已买)[了。！!~～]?$/u);
  if (match) return { type: 'update', index: indexOf(match[1]), action: 'bought' };
  match = value.match(/^(?:惊喜|礼物)箱第?([一二两三四五六七八九]|[1-9]\d*)个?\s*(?:已经)?(?:送了|送出|已送)[了。！!~～]?$/u);
  if (match) return { type: 'update', index: indexOf(match[1]), action: 'given' };
  match = value.match(/^(?:把)?(?:惊喜|礼物)箱第?([一二两三四五六七八九]|[1-9]\d*)个?\s*(?:设为|改成|改为)?(?:仅自己可见|私密|不给对方看|别让对方看到)[了。！!~～]?$/u);
  if (match) return { type: 'update', index: indexOf(match[1]), action: 'private' };
  match = value.match(/^(?:把)?(?:惊喜|礼物)箱第?([一二两三四五六七八九]|[1-9]\d*)个?\s*(?:设为|改成|改为)?(?:双方可见|共享|给对方看|让对方看到)[了。！!~～]?$/u);
  if (match) return { type: 'update', index: indexOf(match[1]), action: 'share' };
  const peers = (options.peerNames || []).map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).filter(Boolean);
  const peer = peers.length ? `(?:${peers.join('|')}|对方|他|她)` : '(?:对方|他|她)';
  const privateMatch = value.match(new RegExp(`^(?:这个|这件事)?\\s*(?:先)?别(?:告诉|通知|让)\\s*${peer}(?:知道)?[，,:：]?\\s*(?:我)?(?:想|准备|打算|考虑)(?:买|送|准备)(?:给)?\\s*${peer}?[：:,，]?\\s*(.+)$`, 'u'))
    || value.match(/^(?:把|将)?(.+?)(?:私密放进|私密加入|私密记进|私密存进)(?:我的)?(?:惊喜|礼物)箱[。！!~～]?$/u);
  if (privateMatch) {
    const title = String(privateMatch[1] || '').trim();
    return { type: 'add', title, category: inferGiftCategory(title), visibility: 'owner_only' };
  }
  match = value.match(/^(?:把|将)?(.+?)(?:放进|加入|记进|存进)(?:我的)?(?:惊喜|礼物)箱[。！!~～]?$/u)
    || value.match(/^(?:惊喜|礼物)箱[：:,，]\s*(.+)$/u);
  if (match) {
    const title = String(match[1] || '').trim();
    return { type: 'add', title, category: inferGiftCategory(title), visibility: 'fixed_pair' };
  }
  return null;
}

module.exports = { inferGiftCategory, parseGiftBoxCommand };
