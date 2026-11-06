'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createTimingSummary} = require('../src/response-timing');
test('timing summary filters request/time and excludes missing metrics and private payloads', () => {
  const s = createTimingSummary({since:Date.parse('2026-10-22'),requestId:'r1'});
  s.add('[2026-10-21T00:00:00Z] model timing {"requestId":"r1","totalMs":9999}');
  s.add('[2026-10-22T00:00:00Z] model timing {"requestId":"r2","totalMs":9999}');
  s.add('[2026-10-22T00:00:00Z] model timing {"requestId":"r1","stage":"reply","totalMs":20,"startupMs":null,"body":"PRIVATE"}');
  s.add('[2026-10-22T00:00:00Z] model timing {"requestId":"r1","stage":"reply","totalMs":40}');
  s.add('[2026-10-22T00:00:00Z] event=codex_stage requestId=r1 stage=task_control phase=理解完整请求 latencyMs=30 user=PRIVATE');
  s.add('[2026-10-22T00:00:00Z] received PRIVATE');
  const out=s.result(); assert.equal(out.matchedRecords,3);
  assert.deepEqual(out.metrics[0],{event:'model timing',stage:'reply',metric:'totalMs',samples:2,p50:20,p95:40,max:40});
  assert.equal(out.metrics[1].stage,'理解完整请求');
  assert.ok(!JSON.stringify(out).includes('PRIVATE')); assert.ok(!JSON.stringify(out).includes('startupMs'));
});

test('end-to-end joins classifications and excludes undelivered latency from delivered percentiles',()=>{
 const s=createTimingSummary({since:0});
 const add=(event,value)=>s.add('[2026-10-22T00:00:00Z] '+event+' '+JSON.stringify(value));
 add('chat timing',{requestId:'a',delivered:true,totalMs:40});
 add('assistant task',{requestId:'a',ordinary:true,reply:'PRIVATE'});
 add('assistant task',{requestId:'b',ordinary:false});
 add('chat timing',{requestId:'b',delivered:false,totalMs:9999});
 add('chat timing',{requestId:'c',delivered:true,totalMs:12});
 const r=s.result();assert.equal(r.endToEnd[0].p50,40);assert.equal(r.endToEnd[1].p50,null);
 assert.equal(r.endToEnd[1].notDelivered,1);assert.equal(r.endToEnd[2].timedSamples,1);
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
});
