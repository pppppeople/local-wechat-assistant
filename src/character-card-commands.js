'use strict';

const HELP = '用“新建角色卡：名字｜设定描述”建卡；“查看角色卡：名字”查看；“角色卡列表”列出；“修改角色卡：原名字｜新名字｜新设定描述”修改；“删除角色卡：名字”删除；“用角色卡<名字>开始故事”开故事。';

function parseCharacterCardCommand(input) {
  const text = String(input || '').trim();
  if (text === '角色卡列表') return { type: 'list' };
  const start = text.match(/^用角色卡(.+?)开始故事$/su);
  if (start) return start[1].trim() ? { type: 'start', name: start[1].trim() } : { type: 'invalid' };
  const match = text.match(/^(新建角色卡|查看角色卡|修改角色卡|删除角色卡)[：:]([\s\S]*)$/u);
  if (!match) return /^(?:新建角色卡|查看角色卡|修改角色卡|删除角色卡|角色卡列表|用角色卡)/u.test(text) ? { type: 'invalid' } : null;
  const body = match[2].trim();
  if (match[1] === '查看角色卡' || match[1] === '删除角色卡') {
    return body ? { type: match[1] === '查看角色卡' ? 'view' : 'delete', name: body } : { type: 'invalid' };
  }
  const parts = body.split(/[｜|]/u).map(value => value.trim());
  const add = match[1] === '新建角色卡';
  if (parts.length !== (add ? 2 : 3) || parts.some(value => !value)) return { type: 'invalid' };
  return add ? { type: 'add', name: parts[0], description: parts[1] }
    : { type: 'update', name: parts[0], newName: parts[1], description: parts[2] };
}

module.exports = { parseCharacterCardCommand, HELP };
