'use strict';

// One pool per fixed participant, deliberately process-local and never persisted.
function createRandomDraw({ random = Math.random, sharedPlaceBox } = {}) {
  const pools = new Map();

  function pick(key, options) {
    const selected = options[Math.floor(random() * options.length)];
    pools.set(key, { options: [...options], last: selected });
    return `抽到了：${selected}`;
  }

  function handle(side, command, sender = side) {
    if (!['owner', 'friend'].includes(side)) throw new Error('invalid random draw side');
    const key = JSON.stringify([side, sender]);
    if (command?.type === 'draw') {
      const options = [...new Set((command.options || []).map((value) => String(value).trim()).filter(Boolean))];
      if (options.length < 2) return '选项不够，请至少提供两个不同的选项。';
      return pick(key, options);
    }
    if (command?.type === 'redraw') {
      const pool = pools.get(key);
      if (!pool) return '还没有可重抽的候选，请先抽签。';
      const options = pool.options.filter((option) => option !== pool.last);
      if (!options.length) return '候选池里只剩一个选项，没法再排除上次结果重抽。';
      const selected = options[Math.floor(random() * options.length)];
      pool.last = selected;
      return `抽到了：${selected}`;
    }
    if (command?.type === 'place') {
      const options = [...new Set(sharedPlaceBox.readDrawPlaces(side)
        .filter((place) => place.status === 'active').map((place) => place.name))];
      if (!options.length) return '想去箱里还没有未去的地点。';
      return pick(key, options);
    }
    throw new Error('不支持这个抽签操作');
  }

  function clear(side) {
    for (const key of pools.keys()) {
      if (JSON.parse(key)[0] === side) pools.delete(key);
    }
  }
  return { handle, clear };
}

module.exports = { createRandomDraw };
