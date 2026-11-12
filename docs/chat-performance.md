# Ordinary chat performance contract

`ordinary-batch.js` defines a 1,000 ms quiet window capped at 3,500 ms from the first fragment. `public-wechat.js` persists every nonblank text item from each accepted message and its IDs immediately in `state/transport/checkpoint.json`. Multiple text items are joined in original order with newlines. The current batch owns its original `receivedAt`, most recent authenticated context token, concatenated text and `hasAttachment` provenance. A known feature command flushes any preceding ordinary batch and receives a separate job. Only the bound account/owner can enter this queue. The console has no batching timer.

`main.js` calls `pollOnce({waitForIdle:false})`, letting ingress polling continue during the serial model/delivery worker. For tests or custom hosts `pollOnce()` defaults to waiting for buffered work; `idle()` explicitly waits for completion. Neither API should be called concurrently from multiple pollers. A buffered/unstarted job is safe to recover, preserves the original deadline and enters L2; missing media provenance also forces L2. An `executing`/`sending` pending checkpoint continues to stop recovery for inspection. Saved `ready` chunks keep their delivery IDs and resume without re-execution. No expiry cuts off an in-flight result or confirmed chunk bookkeeping.

## Admission and isolation

`chat-lane-policy.js` is a pure no-I/O classifier returning `lane` and `reasonCodes`. Explicitly unknown state fails closed. A narrow greeting whitelist admits L0; a narrow set of stable self-contained text forms admits L1. Anything else stays L2, including media, links, temporal/numeric content, fragments, ambiguous references, instructions to override policy and requested operations. This is not a general natural-language intent recognizer and carries no hit-rate guarantee.

`chat-lane-state.js` aggregates boolean probes from the host, not every library in the repository. The single-owner host checks weather/manual state, history readability and optional fallback manual/operation state. The console additionally checks daily-question collection, challenge rounds and same-role place candidates/suggestions/recent lists. The existing personal record routes and savings route require explicit commands and have no conversational pending probe. Any absent/malformed probe result or read failure forces L2. Feature bodies and error messages do not enter lane diagnostics. These probes read without creating, expiring on disk or quarantining feature records; normal feature entrypoints keep their own lifecycle.

An injected weather store must expose a read-only `hasPending(side)` returning a boolean for fast admission and batching. An absent or nonboolean probe disables both for that host. The lane probe never substitutes the existing `pending(side)` accessor, whose normal command lifecycle may persist expiry.

L0 requests strict `{reply:string, needs_tool:boolean}` output, with no extra fields. L1 runs that independent draft alongside two strict `{ordinary:boolean}` requests. Both eligibility results must be true. Those reviewers receive only the original text and bounded same-side history, without a draft or personality profile. The local gate rejects blank/oversized/control-character/structured replies and unsupported Chinese/English execution claims. Any gate failure discards the draft and invokes the original public text model path; no speculative answer is remembered. The public host has no model-controlled executor or repair/planning loop to lend to speculation.

The stock `public-model.js` sends no tool catalog, adds `tool_choice:"none"` for staged calls and passes strict JSON schema for fast drafts/review. Unexpected function/tool requests and truncated responses fail. Every HTTP invocation is a fresh stateless request. Primary quota/auth failures do not spend an additional L2 request; typed exhaustion uses the existing quota fallback. An already exhausted request skips lane admission entirely. Providers without schema/permission support need an adapter or `WECHAT_CHAT_LANES=off`.

## Budgets and retries

`chat-stage-policy.js` preserves these caps:

| Stage | Milliseconds |
| --- | ---: |
| Request understanding / independent admission / semantic review | 40000 |
| Ordinary answer | 60000 |
| Planning from actual results / unknown stage | 120000 |
| Shared primary model and later-dispatch deadline | 150000 |

This public host calls only understanding, admission and ordinary-answer stages; the other policy entries do not create new features. The HTTP timeout is clipped to the remaining shared deadline. Queueing, batching, all speculative attempts, L2 fallback and retry consume the same first-ingress deadline. A custom supplied deadline can shorten it, never extend it. Already invoked actions and delivery finish under their existing lifecycle, so 150 seconds is not a hard wall-clock response SLA. DeepSeek retains its own established six-call/180-second budget and 45-second per-call limit.

Retries belong solely to the host stage runner. Pure understanding/review/ordinary-answer turns may retry once only when explicitly safe, on a fresh request with the remaining budget. An optional safety callback can revoke retry eligibility as dispatch/cancellation occurs. Planning, feature invocation, cleanup and network sending never gain a retry here; auth, quota, budget and unexpected-tool failures never retry. Fast drafts themselves are single-attempt. The HTTP adapter never retries independently.

## Switch, history and timing

`WECHAT_CHAT_LANES` is read on each request; absent/`on` enables lanes, and `off`/`false`/`0` disables classification, probes and speculative calls. The baseline primary text path, feature parsing, quota fallback and delivery are retained. Batching, stage policy and diagnostic fields remain active with lanes off. The frozen `tests/public-assistant-baseline.cjs` is the pre-change public host with import paths adjusted for the test directory; differential tests compare successful primary and feature routing rather than claiming the newly introduced retry/deadline policy existed in that host.

Visible replies use `state/chat/threads.json`, keyed by account/sender/role, at most 24 entries per thread and a 30-day inactive read expiry. Fast drafts and admission may read the last 12 entries; fallback-enabled primary/DeepSeek retain the same bounded history. Without fallback, L2/off still sends only current text to the primary model. History read failures cannot grant a fast lane; new appends preserve malformed JSON rather than replacing it. No cross-role history or external context loader exists. The console retains its existing visibility rules for pair answers/notices; the local terminal remains visible to its operator.

`main.js` writes timing JSON to stderr with ISO timestamps and existing `model timing` / `chat timing` prefixes. Records include stages, attempts, safe retry/fallback reasons, lane/effective lane and durations; WeChat adds batch/queue/processing/delivery times and confirmed server acceptance. Opaque random trace IDs correlate records without account/sender IDs. No text, prompts, credentials, provider bodies or raw exceptions are logged. Model/processing timing is recorded when that phase finishes; later fallback/rejection is reflected in subsequent/final records, not rewritten into earlier rows. Direct console replies have no network-delivery claim.

## Validation scope

`tests/chat-lanes-cases.json` has 52 fictional cases: L0 10, L1 8, L2 34, including pending traps, mixed requests, fragments, media, unsupported requests, injection attempts and unknown facts/state. Each case states lane, allowed/forbidden tool bounds and a no-execution assertion. The classifier/harness never executes tools; any L2 tool allowance describes the existing fallback adapter's upper bound, not a command to execute. Host/store/transport tests separately exercise actual local writes, role isolation, read-only failure preservation, deadlines, concurrent ingress, uncertain-operation holds and baseline behavior. All model/provider/send responses are synthetic. These checks do not prove real-model quality, latency improvement, production coverage, WeChat connectivity or recipient delivery.
