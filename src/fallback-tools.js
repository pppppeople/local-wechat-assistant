'use strict';
const { CATEGORIES } = require('./expense-ledger-commands');

// This validator intentionally supports exactly the JSON Schema subset emitted
// below. Unknown keywords fail closed rather than silently skipping validation.
function validateSchema(schema, value) {
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'items', 'minItems', 'maxItems']);
  if (Object.keys(schema).some(key => !supported.has(key))) throw Error('Unsupported tool schema');
  if (schema.enum && !schema.enum.includes(value)) throw Error('Invalid tool enum');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected tool object');
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) throw Error('Missing tool parameter');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw Error('Unknown tool parameter');
      validateSchema(schema.properties[key], value[key]);
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)
      || schema.minLength > 0 && !value.trim()) throw Error('Invalid tool text');
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw Error('Invalid tool integer');
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw Error('Invalid tool array');
    value.forEach(item => validateSchema(schema.items, item));
  } else throw Error('Unsupported tool schema type');
  return value;
}
const text = (maxLength = 1000, minLength = 1) => ({ type: 'string', minLength, maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
function createFallbackTools({ side, personalTodos, expenseLedger, weatherCommands, placeBox }) {
  if (!['owner', 'friend'].includes(side)) throw Error('Invalid fallback side');
  const registry = new Map();
  const add = (name, description, risk, parameters, execute) => registry.set(name, { name, description, risk, parameters, execute });
  add('weather_query', '查询当前角色的天气，可选明确城市；显式城市沿用现有选城设置。', 'reversible_write',
    object({ city: text(60), days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 2 }, minItems: 1, maxItems: 3 } }, ['days']),
    input => weatherCommands.handle(side, { type: 'query', ...input }));
  if (side === 'owner') {
    add('todo_add', '新增一条本人待办。', 'reversible_write', object({ text: text() }),
      input => personalTodos.execute(side, { type: 'add', ...input }));
    add('todo_list', '查看本人未完成待办。', 'read', object({}), () => personalTodos.execute(side, { type: 'list' }));
    add('todo_complete', '完成一条当前列表中明确指定的待办；执行前核对稳定项目。', 'reversible_write',
      object({ number: { type: 'integer', minimum: 1, maximum: 1000 } }), (input, context) => {
        const before = context.todos?.find(item => item.number === input.number);
        const current = personalTodos.readOpenItems(side).find(item => item.number === input.number);
        if (!before || before.id !== current?.id) return { reply: '待办列表已变化，请重新指定项目。', wrote: false, continue: false };
        return personalTodos.execute(side, { type: 'complete', ...input });
      });
    add('expense_add', '记录一笔支出，金额为整数分，不是支付。', 'reversible_write',
      object({ amountCents: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, category: { type: 'string', enum: CATEGORIES }, note: text(1000, 0) }),
      input => expenseLedger.execute(side, { type: 'add', ...input }));
  }
  // The pair console alone owns this existing local store and its notice callback.
  // No broker, reminder scheduler or network recipient is introduced here.
  if (placeBox) {
    add('place_list', '查看本地双人想去箱，沿用现有可见范围。', 'read', object({}),
      () => placeBox.handleResult(side, { type: 'list' }));
    add('place_add', '新增一个明确指定的想去地点；沿用现有重复校验和本地通知。', 'reversible_write',
      object({ name: text(200), note: text(1000) }, ['name']),
      input => placeBox.handleResult(side, { type: 'add', ...input }));
  }
  return {
    registry,
    catalog: () => [...registry.values()].map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } })),
    validate(name, input) { const tool = registry.get(name); if (!tool) throw Error('Tool not adapted'); validateSchema(tool.parameters, input); return tool; },
  };
}
module.exports = { createFallbackTools, validateSchema };
