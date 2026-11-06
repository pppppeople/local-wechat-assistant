'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrdinaryJobStore, handoffOrdinaryAnswer, recoveryReply } = require('../src/ordinary-job-store');
const { createDeliveryOutbox, ordinaryDeliveryBindingValid } = require('../src/delivery-outbox');
const { answerDeliveries } = require('../src/message-chunks');


function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tasks/ordinary.json');
  const account = { accountId: 'account-a', userId: 'owner-a' };
  const job = { id: 'm1', messageIds: ['m1', 'm2'], accountId: account.accountId, senderId: account.userId,
    texts: ['你好', '接着说'], imagePaths: [], receivedAt: Date.now(), status: 'buffering', styleInputs: [{ messageId: 'm1', text: '你好' }] };
  return { directory, file, account, job };
}



test('a restart preserves the accepted merge buffer, original IDs and private write destination', (t) => {
  const { file, job, account } = fixture(t);
  createOrdinaryJobStore(file).save({ ...job, timer: setTimeout(() => {}, 1).unref() });
  const recovered = createOrdinaryJobStore(file).recover(account);
  assert.equal(recovered.ready.length, 1);
  assert.deepEqual(recovered.ready[0].texts, job.texts);
  assert.deepEqual(recovered.ready[0].styleInputs, job.styleInputs);
  assert.equal('timer' in recovered.ready[0], false);
  assert.equal(createOrdinaryJobStore(file).hasMessage('m2'), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('checkpoints survive restart; an interrupted dispatch is explicitly unresolved and not repeated', (t) => {
  const { file, job, account } = fixture(t);
  const store = createOrdinaryJobStore(file);
  store.save(job);
  store.update(job.id, { taskState: { actions: [{ tool: 'life', input: { type: 'inventory_set' } }],
    results: [{ wrote: true, reply: '已经记录牛奶。' }], inFlight: true } });
  const recovered = createOrdinaryJobStore(file).recover(account).ready[0];
  assert.equal(recovered.taskState.results[0].wrote, true);
  assert.equal(recovered.taskState.inFlight, true);
  assert.match(recoveryReply(recovered), /已经记录牛奶/);
  assert.match(recoveryReply(recovered), /没有重新执行/);
});

test('restart during handoff queues the same reply chunks once and no execution job remains', (t) => {
  const { directory, file, job } = fixture(t);
  const store = createOrdinaryJobStore(file);
  const outboxFile = path.join(directory, 'delivery/outbox.json');
  const outbox = createDeliveryOutbox(outboxFile);
  store.save(job);
  const deliveries = answerDeliveries({ id: `ordinary-answer:${job.id}`, senderId: job.senderId, text: '结果'.repeat(2000), userText: '查询', imageCount: 0 });
  // Simulate a process exit after the first outbox write, before handoff removal.
  store.update(job.id, { finalDeliveries: deliveries });
  outbox.enqueue(deliveries[0]);
  assert.equal(handoffOrdinaryAnswer(createOrdinaryJobStore(file), createDeliveryOutbox(outboxFile), job.id, deliveries), true);
  assert.equal(store.count(), 0);
  assert.equal(outbox.count(), deliveries.length);
  assert.deepEqual(outbox.read().deliveries.map((item) => item.clientId), deliveries.map((item) => item.clientId));
  outbox.complete(deliveries[0].id);
  assert.equal(handoffOrdinaryAnswer(store, outbox, job.id, deliveries), false);
  assert.equal(outbox.count(), deliveries.length - 1);
});

test('changed binding holds work and stale requests report expiry without applying remaining changes', (t) => {
  const { file, job, account } = fixture(t);
  const store = createOrdinaryJobStore(file, { now: () => job.receivedAt + 21 * 3600000 });
  store.save(job);
  assert.equal(store.recover({ ...account, accountId: 'account-b' }).ready.length, 0);
  assert.equal(store.read().jobs[0].holdReason, 'account_binding_changed');
  const recovered = store.recover(account).ready[0];
  assert.equal(recovered.expired, true);
  assert.match(recoveryReply(recovered), /超过20小时/);
  store.cancel(job.senderId);
  assert.equal(store.update(job.id, { taskState: { inFlight: true } }), null);
  assert.equal(store.count(), 0);
});

test('a damaged journal fails visibly instead of silently discarding accepted messages', (t) => {
  const { file } = fixture(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  assert.throws(() => createOrdinaryJobStore(file).recover({}));
});

test('mixed journals hold malformed records without losing originals or blocking valid recovery', (t) => {
  const { file, job, account } = fixture(t);
  const { id, ...missingId } = job;
  const { receivedAt, ...missingReceivedAt } = job;
  const malformed = [null, 'broken record', missingId, missingReceivedAt,
    { ...job, receivedAt: 'yesterday' }, [], { ...job, id: '' },
    { ...job, accountId: null }, { ...job, senderId: 42 }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, jobs: [...malformed, job] }));
  const store = createOrdinaryJobStore(file);
  const recovered = store.recover(account);
  assert.deepEqual(recovered.ready.map((item) => item.id), [job.id]);
  assert.equal(recovered.held.length, malformed.length);
  const persisted = store.read().jobs;
  assert.equal(persisted.length, malformed.length + 1);
  malformed.forEach((original, index) => {
    const held = persisted[index];
    assert.equal(held.status, 'held');
    assert.equal(held.holdReason, 'invalid_record');
    if (original === null || typeof original !== 'object' || Array.isArray(original)) {
      assert.deepEqual(held.invalidRecord, original);
    } else {
      const { status, holdReason, ...fields } = held;
      const { status: originalStatus, ...originalFields } = original;
      assert.deepEqual(fields, originalFields);
    }
  });
  assert.equal(store.recover(account).held.length, malformed.length);
  assert.equal(store.count(), 1);
});

test('journal matching skips malformed entries before and after recovery', (t) => {
  const { file, job, account } = fixture(t);
  const malformed = [null, 'broken', { ...job, receivedAt: 'invalid' },
    { senderId: job.senderId, messageIds: ['malformed-message'] }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ jobs: malformed }));
  const store = createOrdinaryJobStore(file);
  assert.equal(store.get(job.id), undefined);
  assert.equal(store.get(undefined), undefined);
  assert.equal(store.hasMessage(job.id), false);
  assert.equal(store.hasMessage('malformed-message'), false);
  assert.equal(store.update(job.id, { status: 'queued' }), null);
  assert.equal(store.count(), 0);
  assert.deepEqual(store.cancel(job.senderId), []);
  store.complete(job.id);
  assert.deepEqual(store.read().jobs, malformed);
  store.save(job);
  store.update(job.id, { texts: ['updated'] });
  assert.deepEqual(store.get(job.id).texts, ['updated']);
  assert.deepEqual(store.read().jobs.slice(0, malformed.length), malformed);
  assert.equal(store.count(), 1);
  store.recover(account);
  assert.equal(store.cancel(job.senderId).length, 1);
  assert.equal(store.count(), 0);
  assert.equal(store.read().jobs.length, malformed.length);
  assert.equal(store.hasMessage(job.id), false);
});

test('delivery recovery retains original account binding and holds legacy unbound ordinary answers', (t) => {
  const { directory, account, job } = fixture(t);
  const outboxFile = path.join(directory, 'delivery/outbox.json');
  const box = createDeliveryOutbox(outboxFile);
  const deliveries = answerDeliveries({ id: 'bound', accountId: account.accountId, senderId: job.senderId, text: '私人答案' });
  box.enqueue(deliveries[0]);
  const recovered = createDeliveryOutbox(outboxFile).read().deliveries[0];
  assert.equal(ordinaryDeliveryBindingValid(account, recovered), true);
  assert.equal(ordinaryDeliveryBindingValid({ ...account, accountId: 'another-account' }, recovered), false);
  assert.equal(ordinaryDeliveryBindingValid(account, { ...recovered, accountId: '' }), false);
  box.waitForContext(recovered.id, Error('original account binding unavailable'));
  assert.equal(box.claim(), null);
});
