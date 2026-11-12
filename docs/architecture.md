# Architecture and integration contract

`main.js` selects the playable pair console or the single-owner WeChat transport. `public-pair-console.js` handles local speaker selection and routes four pair features to their existing parsers/stores. `public-assistant.js` retains the todo, expense, temporary-note and habit routes with their original owner-only permissions. Only unmatched primary text enters the conservative ordinary lanes; fast lanes use bounded same-side context and cannot dispatch tools. Without quota fallback, L2/off retains current-text-only model input. Enabling fallback adds the bounded context and tool flow described below; authenticated role selection remains outside model control. See [ordinary lanes, budgets and batching](chat-performance.md).

## Local two-role experience

`npm start` starts as fictional 小林 (`owner`); `切换 小周` or `/as friend` selects fictional 小周 (`friend`). `切换 小林` or `/as owner` switches back. The prompt names the active speaker. This is a trusted local simulation, not account authentication. The WeChat host never uses this switch parser and cannot acquire another role from message text. Personal commands work for `owner`; the existing stores refuse `friend` before accessing personal records.

| Console route | Existing implementation | Runtime feature directory |
| --- | --- | --- |
| Place add/list/visited/restore | `shared-place-commands` + `shared-place-box` | `shared-place` |
| Daily question/status/answer/reveal | `pair-daily-question-commands` + `pair-daily-question-store` | `pair-daily-question` |
| Challenge/start/answer/stats/cancel | `pair-challenge-commands` + `pair-challenge-store` | `pair-challenge` |
| Savings/create/contribute/progress/undo | `pair-savings-commands` + `pair-savings-store` | `pair-savings` |

The place provider is explicitly unavailable in this console: names are saved locally without map lookups. Shared places keep side-specific recent-list references. Daily-question and savings binding is the fixed local simulation binding, scoped to that runtime. No account identity or real relay is implied. Daily answers remain sealed until both submit; incomplete days expire on the next Shanghai day. Challenge answers remain sealed until both submit or the round expires after 24 hours. Savings is a text ledger, with each participant able to revoke only their own contribution before completion.

The place-added callback and challenge `onNotice` callback append only to local in-memory per-role display queues. Notices are consumed on a role switch or command and never sent over the network. Challenge comparison text is delivered by that callback; it is not discarded in favor of the store's acknowledgement. These queues disappear on exit; challenge statistics persist but its completed comparison text does not. Daily-question pending reveals use the existing durable `takePending` mechanism. All responses are rendered through the stores' existing visibility rules. Terminal inputs/scrollback and local files remain accessible to the local operator; this simulation does not provide account-level secrecy.

`npm run demo` uses this same console with a temporary runtime and fixed fictional clock/question selection. It walks through both viewpoints for shared places, daily answers, a challenge and combined savings, and removes its own files in `finally`, including on failure. It makes no network or model calls. More pair modules (decisions, goals, date turns) remain libraries for explicit integration.

## Storage

The default root is `${XDG_DATA_HOME}/wechat-assistant-framework/runtime`, falling back to `${HOME}/.local/share/wechat-assistant-framework/runtime`. `WECHAT_ASSISTANT_HOME` replaces the root; relative overrides resolve against the caller's current directory. No sibling projects or old credential locations are discovered.

- `state/features/<feature>/state.json`: the feature's index, plus classified `records/` bodies when supported by that store.
- Pair console feature names: `shared-place`, `pair-daily-question`, `pair-challenge`, `pair-savings`. Personal feature names remain `todo`, `expense`, `notes`, `habit`; their existing paths and schemas are unchanged. Speaker selection and local callback queues are in memory, not a parallel pair database.
- `state/transport/checkpoint.json`: account/sender/base-URL binding, polling cursor, bounded processed IDs, buffered/queued ordinary batches and a pending operation/output checkpoint. Context tokens stay in this private file until the pending result is completed.
- `state/chat/threads.json`: bounded visible same-side conversation, also retained without quota fallback; see the history/privacy contract below.
- `logs/`, `tmp/` and `backups/`: reserved for integrator-managed diagnostic, scratch and recovery material. The default host does not create them. Keep these purposes separate if you extend the host.

The default worker is serial while ingress polling continues independently; L1 model-only draft/admission calls run in parallel. Feature-store constructors accept explicit paths; custom integrations must pass purpose-specific locations within their own private runtime. Do not share files between concurrent writers. Corrupt durable records fail visibly; some stores preserve corrupt records by quarantine. Lane probes are read-only and fail closed without quarantining. Runtime is not encrypted, and there is no automatic retention or backup service. Expiring notes apply their own expiry rules. Inspect and preserve unresolved state before any manual reconciliation.

## WeChat transport

This optional transport supports one authorized owner, not the console's two-role experience. There is no real-account relay or two-account wiring. To connect two real participants, supply your own protocol access, authenticated role mapping, consent checks and notification wiring. Use a separate runtime from local simulation.

Provide your own HTTPS base URL and compatible, authorized account. `ilink/bot/getupdates` receives `get_updates_buf` and `base_info.channel_version`. A successful JSON response contains `msgs` and optionally the next `get_updates_buf`. Each accepted text message requires:

```json
{
  "message_id": "synthetic-message",
  "from_user_id": "synthetic-owner",
  "to_user_id": "synthetic-account",
  "context_token": "synthetic-context-placeholder",
  "item_list": [{ "type": 1, "text_item": { "text": "帮助" } }]
}
```

All identifiers above are fictional protocol examples. The sender must equal your configured owner. A supplied recipient must equal your configured account; transports that omit the recipient rely on the authenticated polling account. Missing message IDs, context tokens and empty text are skipped. Media-only messages are skipped; text accompanying unsupported media is kept with an attachment flag that excludes fast lanes. No media download/interpretation is added. Invalid HTTP/API outcomes stop polling without saving a new cursor. HTTP bodies are not logged by the host. Accepted ordinary fragments are persisted immediately, then flush after one second of quiet or at the 3.5-second first-fragment limit; known commands stay separate.

`ilink/bot/sendmessage` uses `AuthorizationType: ilink_bot_token`, a bearer credential, a random encoded UIN header, and a `msg` with `to_user_id`, stable `client_id`, text `item_list`, `context_token`, `message_type: 2` and `message_state: 2`. A numeric `ret: 0`, or the supported successful message-ID receipt, confirms server acceptance. Explicit error fields override success-looking fields. Protocol details come from the adapter implementation and are not a guarantee that an arbitrary gateway or account supports it.

## Recovery and operator action

Before a feature call, the checkpoint records `executing`. After a result is saved it becomes `ready`, with a random delivery ID, split text and the next unsent chunk. Before each network invocation it becomes `sending`; only a confirmed receipt advances the next chunk. A cleanly saved `ready` result can resume without executing the feature again.

Buffered/queued records have not invoked the assistant and can resume through L2 after restart, using the original first-ingress deadline. An expired unstarted job receives a timeout response without generation/dispatch. First-ingress 150-second primary/dispatch limits never abandon a real in-flight action/result or pending delivery. The original uncertain-operation rule below still applies.

If a process stops while `executing` or `sending`, the next run refuses to proceed. A failed network request can still have reached the server, and a feature may have written before its result was saved. Inspect the feature records and recipient-side result in your own private environment. Preserve a recovery copy of your checkpoint before making a deliberate reconciliation. After verifying a send, advance the private pending `next` index and set `status` to `ready`; after verifying a feature operation, supply its known result as `chunks`, `next: 0`, `status: ready`. If you cannot establish the outcome, leave it held. Do not reset `executing` or replay the original request merely to dismiss the warning. There is no automated reconciliation CLI.

Changing account identity, owner identity or base URL requires a new runtime; existing state is not transferred automatically. Use one consumer, do not copy another installation's account/login/state, and separately verify recipient delivery. The transport retains only the latest 500 processed IDs and assumes the provider cursor advances correctly; it does not promise permanent deduplication of arbitrary old replays.

## Extending modules

The default host does not use the old orchestration loop. Independent modules take explicit file paths, clocks, provider/model callbacks and optional notification callbacks. These callbacks grant authority: never derive a side or recipient directly from message text, and never let model output bypass host checks. Bind journals/outboxes to both the original account and sender. Enforce expiry, cancellation, consent and visibility in your host before connecting friend features or notifications. Generic side labels do not authenticate a caller.

Task-intent parsing and journal utilities remain reusable library APIs; no shell/Codex executor is connected. Media utilities operate on caller-supplied buffers/files and provider callbacks; the foreground host is text-only. The map library calls external public services when explicitly invoked; some providers need your own key and attribution. These are opt-in integrations, independently subject to provider availability and terms.

## Quota fallback

`public-fallback.js` wires `codex-errors`, `codex-quota-state`, `deepseek-client`, `deepseek-fallback`, `fallback-tools`, `fallback-journal` and `chat-history` into both public hosts. The Codex-named classifier/state modules preserve typed protocol compatibility; the public CLI does not launch Codex or load private context. The primary HTTPS adapter accepts this failure envelope on a non-2xx response:

```json
{
  "error": { "codexErrorInfo": "usageLimitExceeded" },
  "rateLimits": {
    "primary": { "usedPercent": 100, "resetsAt": 1800000300 }
  }
}
```

`error.code: "insufficient_quota"` is also accepted. HTTP 401/403 remain authentication errors. Bare 429 and upstream free-text messages never count as exhaustion. The adapter copies only known error variants and numeric rate-limit fields, never raw messages/headers/bodies. A gateway hiding structured quota evidence cannot trigger fallback automatically. Reset timestamps are Unix seconds; the latest future reset among exhausted primary/secondary windows wins, with a five-hour fallback if none is valid.

The persisted breaker uses a generation counter so an older successful probe cannot clear a newer exhaustion. A process-local 30-second timer checks the persisted due time; first probe after 15 minutes, then 30/60-minute backoff, shortened by a future reset. Each HTTP probe is a fresh 15-second request for `{"ok":true}`, without persona, history or tools. A fallback request in flight keeps its provider even if a probe succeeds. Host `close()` releases the timer. Custom model callbacks should implement `model.probe()` with the same timeout and fresh-context contract.

`DEEPSEEK_API_KEY` enables the adapter; absent credentials disable its breaker, probes and tool flow. Ordinary chat lanes and the bounded visible-reply transcript remain available independently. The client uses `https://api.deepseek.com/chat/completions`, non-streaming requests, optional JSON/function-call output, and bounded calls. It refuses redirects and incomplete responses, and sanitizes transport errors. No credentials are bundled. Node's explicit `--env-file` loading or service-manager environment injection replaces machine-specific shell sourcing.

Admission and authorization review are independent requests. Only the admitted ordinary-chat branch receives a generic example style. The tool branch gets a side-specific catalog: weather for either side, personal todo/expense tools for owner, and places only when the console injects its existing place store. No model parameter can supply a side, recipient, account or path. Todo completion rechecks the stable item ID before changing the current numbered item. Existing place callbacks still produce only local notices.

While exhausted, ingress bypasses direct mutating parsers. Unadapted, ambiguous, multi-step, delete/cancel and unsupported requests go to `queues/model-fallback/pending.jsonl`; they never replay automatically on recovery. Tool journals live in `state/model-fallback/operations/`, separate from `state/model-fallback/codex-quota.json`. An account/sender/turn key binds each operation; saved completed results are reused, unresolved started operations are held. This is not an atomic transaction with feature stores and does not promise exactly-once execution. New turn IDs are new requests, not semantic deduplication. Transport checkpoints still hold uncertain execution or sending across restarts.

Visible host replies, and labelled tool receipts when fallback is enabled, join `state/chat/threads.json`, keyed by account/sender/role. Console role selection stays local; WeChat supplies the authenticated account, sender and message ID to the assistant. Fast lanes and fallback-enabled providers read only the requesting side's last 12 entries; no-fallback L2/off retains current-text-only input. Storage retains 24 entries per thread and expires inactive threads after 30 days on reading, without promising disk erasure; retained transcripts, pending text and operation payloads are private runtime data, not repository assets. No prior installation is discovered, imported or migrated. Pair notices and sealed answers still follow existing visibility rules; no other side's raw conversation is loaded.
