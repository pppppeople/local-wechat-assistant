# Architecture and integration contract

The host is deliberately small. `main.js` selects a console or WeChat transport; `public-assistant.js` parses explicit commands and calls the todo, expense, temporary-note or habit store. Only unmatched text can reach the optional model adapter. The model receives no tool catalog, feature results, identity configuration, saved records or previous conversation.

## Storage

The default root is `${XDG_DATA_HOME}/wechat-assistant-framework/runtime`, falling back to `${HOME}/.local/share/wechat-assistant-framework/runtime`. `WECHAT_ASSISTANT_HOME` replaces the root; relative overrides resolve against the caller's current directory. No sibling projects or old credential locations are discovered.

- `state/features/<feature>/state.json`: the feature's index, plus classified `records/` bodies when supported by that store.
- `state/transport/checkpoint.json`: account/sender/base-URL binding, polling cursor, bounded processed IDs and a pending operation/output checkpoint. Context tokens stay in this private file until the pending result is completed.
- `logs/`, `tmp/` and `backups/`: reserved for integrator-managed diagnostic, scratch and recovery material. The default host does not create them. Keep these purposes separate if you extend the host.

The default host is serial. Feature-store constructors accept explicit paths; custom integrations must pass purpose-specific locations within their own private runtime. Do not share files between concurrent writers. Corrupt durable records fail visibly; some stores preserve corrupt records by quarantine. Runtime is not encrypted, and there is no automatic retention or backup service. Expiring notes apply their own expiry rules. Inspect and preserve unresolved state before any manual reconciliation.

## WeChat transport

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

All identifiers above are fictional protocol examples. The sender must equal your configured owner. A supplied recipient must equal your configured account; transports that omit the recipient rely on the authenticated polling account. Missing message IDs, context tokens, empty text and unsupported media are skipped. Invalid HTTP/API outcomes stop polling without saving a new cursor. HTTP bodies are not logged by the host.

`ilink/bot/sendmessage` uses `AuthorizationType: ilink_bot_token`, a bearer credential, a random encoded UIN header, and a `msg` with `to_user_id`, stable `client_id`, text `item_list`, `context_token`, `message_type: 2` and `message_state: 2`. A numeric `ret: 0`, or the supported successful message-ID receipt, confirms server acceptance. Explicit error fields override success-looking fields. Protocol details come from the adapter implementation and are not a guarantee that an arbitrary gateway or account supports it.

## Recovery and operator action

Before a feature call, the checkpoint records `executing`. After a result is saved it becomes `ready`, with a random delivery ID, split text and the next unsent chunk. Before each network invocation it becomes `sending`; only a confirmed receipt advances the next chunk. A cleanly saved `ready` result can resume without executing the feature again.

If a process stops while `executing` or `sending`, the next run refuses to proceed. A failed network request can still have reached the server, and a feature may have written before its result was saved. Inspect the feature records and recipient-side result in your own private environment. Preserve a recovery copy of your checkpoint before making a deliberate reconciliation. After verifying a send, advance the private pending `next` index and set `status` to `ready`; after verifying a feature operation, supply its known result as `chunks`, `next: 0`, `status: ready`. If you cannot establish the outcome, leave it held. Do not reset `executing` or replay the original request merely to dismiss the warning. There is no automated reconciliation CLI.

Changing account identity, owner identity or base URL requires a new runtime; existing state is not transferred automatically. Use one consumer, do not copy another installation's account/login/state, and separately verify recipient delivery. The transport retains only the latest 500 processed IDs and assumes the provider cursor advances correctly; it does not promise permanent deduplication of arbitrary old replays.

## Extending modules

The default host does not use the old orchestration loop. Independent modules take explicit file paths, clocks, provider/model callbacks and optional notification callbacks. These callbacks grant authority: never derive a side or recipient directly from message text, and never let model output bypass host checks. Bind journals/outboxes to both the original account and sender. Enforce expiry, cancellation, consent and visibility in your host before connecting friend features or notifications. Generic side labels do not authenticate a caller.

Task-intent parsing and journal utilities remain reusable library APIs; no shell/Codex executor is connected. Media utilities operate on caller-supplied buffers/files and provider callbacks; the foreground host is text-only. The map library calls external public services when explicitly invoked; some providers need your own key and attribution. These are opt-in integrations, independently subject to provider availability and terms.
