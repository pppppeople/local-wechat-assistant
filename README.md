# local-wechat-assistant · Two people, one assistant

A shared WeChat assistant for two: collect places you want to visit, answer a daily question privately until both are ready, play a compatibility challenge, and track a savings goal together. Local-first, with zero third-party dependencies.

**两个人，一个助手。** 一起攒想去的地方、每天回答同一道题、玩默契挑战、记录共同储蓄。也提供双人决策、共同目标、约会/出行轮值等可接入模块。示例人物小林与小周、地点和测试输入全部虚构。

## Try the pair demo first

Use Node.js 24+. There are no packages to install:

```sh
npm run demo
npm start
```

The demo actually runs five scenes through the same pair console used by `npm start`, printing both fictional participants' viewpoints:

1. **Shared place box:** Xiaolin adds a fictional park; Xiaozhou sees it and marks it visited; both see the shared history.
2. **Daily question:** both receive the same question. The first answer stays sealed; only the second answer unlocks both answers.
3. **Compatibility challenge:** each chooses A–D independently; both receive the comparison and match count.
4. **Shared savings:** each records a contribution; 30 + 50 toward a 200 yuan goal becomes 80 yuan, or 40%.
5. **Weather + daily briefing (simulated):** Xiaolin asks for weather, chooses Suzhou, sees today/tomorrow, then receives one simulated rainy briefing at 08:00 the following day. Xiaozhou opens the weather manual independently. All forecasts are deterministic fictional data from an offline stub.

The demo uses its own temporary runtime, a fixed fictional date and deterministic challenge question, then removes its temporary files even on failure. It makes no network, model or payment requests.

**Public edition boundary:** two people are simulated as **two local roles in one console**, switching the speaker. This is a playable local experience, not two connected WeChat accounts. Connecting two real participants requires your own authorized protocol access and host wiring for identity, consent, notifications and visibility. This repository contains **no real-account relay**.

中文：运行 `npm run demo` 可直接看完整双人五幕；`npm start` 可以自己操作。同一控制台切换小林与小周模拟两人，不是已联通两个真实微信账号。真实双人微信接入须自行准备协议并接线，本仓不含真实账号 relay。

## Play in the local console

The prompt shows `[小林] >` or `[小周] >`. Start as **小林 / Xiaolin (`owner`)**. Enter `切换 小周` or `/as friend` to become **小周 / Xiaozhou (`friend`)**; `切换 小林` or `/as owner` switches back. Enter `帮助` for commands; Ctrl-D exits. Roles reset to Xiaolin on restart; stored feature data remains in your configured runtime.

Try this sequence in `npm start`:

```text
想去箱添加：纸月公园
切换 小周
查看想去箱
把纸月公园标记为去过
切换 小林
去过的地方
每日一问
每日一问答：星星纸船
切换 小周
每日一问揭晓
每日一问答：月亮小屋
切换 小林
每日一问揭晓
来一轮默契挑战
默契答 B
切换 小周
来一轮默契挑战
默契答 B
切换 小林
共同愿望：周末野餐 200元
愿望贡献：30元
切换 小周
愿望贡献：50元
共同愿望进度
```

| Play | Commands and behavior |
| --- | --- |
| Shared places / 想去箱 | `想去箱添加：纸月公园`, `查看想去箱`, `把纸月公园标记为去过`, `去过的地方`, `把纸月公园恢复为想去`. Both roles see the same places. After viewing a list, numbered commands use that role's recent list. The console saves names locally without a map provider. |
| Daily question / 双人每日一问 | `每日一问`, `每日一问答：答案`, `每日一问揭晓`. Answers stay sealed until both respond; they can be revised before reveal. An incomplete day expires on the next Shanghai calendar day. |
| Compatibility / 默契挑战 | `来一轮默契挑战` starts or shows the current round; `默契答 A` submits A–D. Both must answer before comparison. `默契战绩` shows totals; `结束默契挑战` cancels. Unfinished rounds expire after 24 hours. |
| Shared savings / 共同储蓄 | `共同愿望：周末野餐 200元`, `愿望贡献：30元`, `共同愿望进度`. Each contribution belongs to the current role; `撤销愿望贡献：1` can undo only that role's own contribution. One active goal at a time; reaching the target completes it. **Text ledger only, no real funds or payment.** |

Challenge results and place-added notifications appear for the recipient when you switch to that role or enter its next command. These notifications are local, in memory, and disappear on exit; they are not WeChat delivery. Daily-question reveal state and challenge statistics persist in their original stores; challenge result text is not retained after exit. Role switching is a simulation convenience, not authentication or confidentiality from the person operating the terminal. Both roles' inputs are visible in the shared terminal scrollback and records are stored locally.

中文：揭晓前保密指助手不会向未答的一方返回另一方答案；共用终端的输入记录与本地存储并不提供账号级保密。双人模块沿用原有权限和可见性：储蓄只能撤销自己贡献，地点列表编号按各自角色记录。通知仅在本地会话显示，退出不保留通知队列。

## Weather / 天气

Both local roles can query public weather and independently save their own city and morning switch. There is **no default city**: send `天气`, reply with your city name when prompted, and the assistant immediately completes the original query. It remembers the selected city across restarts; changing roles never copies that selection.

| Command | Behavior |
| --- | --- |
| `天气` | Today + tomorrow |
| `今日天气` / `明天天气` / `明日天气` / `后天天气` | Requested day's details |
| `苏州天气` | Resolve and save the current role's city, confirm it, then show today + tomorrow |
| `苏州今日天气` / `苏州明天天气` / `苏州明日天气` / `苏州后天天气` | Save and confirm the city, then show only the requested day; overrides an earlier pending query's dates |
| `设置天气城市：城市名` | Resolve and save only the current role's city; an unresolved city leaves the old setting intact |
| `开启天气早报` / `关闭天气早报` | Set only the current role's morning switch; delivery requires a host |
| `天气早报测试` | Display today + tomorrow now, without consuming a scheduled delivery |
| `天气说明` / `天气帮助` | Compact catalog; select 1–4 or a section keyword to expand; long sections use `继续` |

The console uses the existing keyless provider: OpenStreetMap/Nominatim resolves cities and Open-Meteo supplies forecasts. A host may inject `createPlaceProvider({ apiKey })` for Amap weather with Open-Meteo fallback. City lookup must match returned place metadata; unavailable or unmatched lookup is reported instead of guessing. Weather replies include day/night conditions, high/low temperatures, winds, rain/snow advice when supported, source attribution, and `看用法回：天气说明`. Open-Meteo supplies a daily summary; separate day/night conditions and wind direction/force are marked unavailable. Forecasts can change and are for reference only; consult official local warnings for decisions.

City selection failures (no match, mismatched city or provider error) explicitly reply `解析不了这个天气城市，请换个城市名再试；原设置未修改。`, preserving both the saved city and pending selection for retry. The console and text host display the selected weather reply directly, without falling back to ordinary/model chat. Optional weather logs record only command type and failure category, without the city, message body or provider error details. Text containing `天气` is never treated as a bare city name.

Pending city selections store creation and expiry times and silently expire after 24 hours, including across restarts. Failures and morning ticks do not extend an existing query's lifetime. Undated legacy pending selections expire on access; saved cities and morning switches remain intact. After expiry, a bare city follows ordinary routing; use `天气` to start selection again or `设置天气城市：苏州` / `苏州天气` explicitly.

If a host has sent a context-refresh reminder, the next message from that role within 24 hours consumes its one-shot refresh marker before feature dispatch. That message still follows normal command/chat routing, but cannot be consumed as a pending bare city; the weather pending selection keeps its original deadline. Without a valid refresh marker, an invalid pending city reply still receives the explicit failure above. Role switches in the local console are controls, not inbound messages.

中文：天气待选城市自创建起 24 小时静默过期，失败重试不续期，缺少时间记录的旧待答不续用。刷新提醒确认发出后，同侧 24 小时内下一条消息优先消费一次性刷新标记，消息照常走命令或普通聊天，不误当待答城市；天气待答保留原期限。没有有效刷新标记时，答错城市仍明确提示失败。

Refresh reminder scheduling/sending remains host-owned; the console and default text transport do not send reminders automatically. Both `createPublicAssistant` and `createPairConsole` expose `contextLeases`: call `refresh({ senderId: 'owner', token })` on authenticated inbound context updates, check `warningStatus({ senderId: 'owner', token })`, and call `recordWarning({ senderId: 'owner', token })` **only after confirmed reminder acceptance**. Use `friend` for the other role. Dispatch consumes markers automatically; a fresh token preserves an unconsumed marker. Leases and markers persist in the private runtime at `state/transport/context-leases.json`; use the same runtime and clock for the host and stores, with one writer.

中文：双方天气设置、待选城市和早报状态分别保存。没有默认城市；首次查天气先选城，选好立即补查。也可直接回「苏州天气」保存本侧城市，先确认再查今日＋明日；「苏州今日天气」「苏州明天天气」／「苏州明日天气」「苏州后天天气」只查对应单日，覆盖原待选日期。选城失败明确提示、保留原设置和待选状态，可换名重试，不静默转普通对话。查不到就明确说明，缺失字段不补造。说明书先给「怎么查天气 / 怎么切换城市 / 早报：时间与开关 / 数据来源与说明」目录，选择后只展开该节；15 分钟无操作过期，其他功能命令自动退出，按角色隔离，重启清空说明书会话。

**Morning briefings are an exported scheduling module.** Neither `npm start` nor the single-owner WeChat host starts a weather timer or real push channel. The offline demo calls `tick()` with a simulated clock and send callback. To integrate your own authorized channel:

```js
const { loadPublicConfig } = require('./src/public-config');
const { createPublicAssistant } = require('./src/public-assistant');
const { createWeatherStore } = require('./src/weather-store');
const { createWeatherMorning } = require('./src/weather-morning');

function attachWeather(send) { // async send(side, text, clientId): host-owned delivery
  const { runtime } = loadPublicConfig();
  const store = createWeatherStore({ runtime });
  const assistant = createPublicAssistant({ runtime, weatherStore: store });
  const morning = createWeatherMorning({ store, weather: assistant.weather, send });
  const timer = setInterval(() => { void morning.tick(); }, 30_000);
  void morning.tick(); // restart catch-up
  return { assistant, stop: () => clearInterval(timer) };
}
```

The host must authenticate and bind roles, supply the timer and `send(side, text, clientId)`, and stop its timer on shutdown. By default both roles are scheduled at Shanghai time 08:00 (`WEATHER_MORNING_TIME` overrides); use `sides: ['owner']` for a single-owner host. Switches initially allow scheduling. No-city scheduling sends one city prompt; selection then starts morning forecasts the next day. An explicit pending query is preserved and answered immediately. Restart catch-up ends at 12:00; a configured time at/after noon runs only in its scheduled minute. Claims persist before sending; unavailable forecasts, failed or uncertain sends are recorded without automatic retries that day. A successful callback records channel acceptance, which does not establish recipient delivery. Use one writer per runtime.

公开版早报仅交付调度逻辑，真实推送需宿主自备定时器和发送通道；本地开启开关不会产生微信推送。详见 [说明书与宿主合同](docs/feature-manual.md)。

## Also supports personal features

Todos, expense entries, temporary notes and habits remain available with their original commands and owner-only permissions. Use Xiaolin (`owner`) for these; Xiaozhou (`friend`) cannot read or change the owner's personal records.

```text
切换 小林
记一下 明天买牛奶
我的待办
记账 12元 餐饮 示例午餐
今日账单
存临时信息 示例备忘
临时信息
创建习惯：散步
我的习惯
```

Unmatched text receives command help unless you configure an optional model. Ordinary fast lanes may receive bounded same-side context, with no tools; the no-fallback L2/off path receives only the current unmatched question and a fixed instruction. Optional quota fallback adds its existing reviewed feature calls; neither model gets local-file or computer access.

## Included modules and wiring

| Layer | Included behavior | Integration status |
| --- | --- | --- |
| Pair console | Shared place box, daily question, compatibility challenge, shared savings; speaker switch and local notices | Playable now with `npm start` and `npm run demo`, using existing `shared-*` / `pair-*` stores and command parsers |
| Weather | Role-local city selection, current/next-day forecasts, progressive manual; injectable morning scheduler | Queries work in the console and text host; real morning timer and delivery are host responsibilities |
| More pair modules | Pair decisions, shared goals, date/outing turns, wishes and other shared records | Exported library modules; require explicit host integration; not console commands yet |
| Personal assistant | Todos with dependencies, expenses, expiring notes, habits | Available in the console for `owner` and in the single-owner WeChat text host |
| Optional model | HTTPS chat completion with bounded output and timeout; optional DeepSeek quota fallback | Primary model has no tools. Fallback uses same-side recent context and a bounded adapter over existing stores. |
| WeChat text transport | Exact owner/account binding, polling, message-ID deduplication, chunked replies, durable checkpoints | Single-owner transport only; requires your own authorized compatible protocol access; real account acceptance remains unverified |
| Extension libraries | Reminders, inventory, route planning, inbox/tickets/gifts, work/learning/writing, media adapters, games, recovery utilities | Separate modules with injected stores/providers; not registered in the default host unless listed above |

`main.js` selects `public-pair-console` for local use and `public-assistant` for the single-owner WeChat transport. Speaker-switch text is interpreted **only** in the local console; a WeChat message cannot choose a pair role. The console calls the existing command parsers and stores directly, with no new pair data implementation. See [architecture and recovery](docs/architecture.md) and [module inventory](docs/modules.md).

The original private host, shell execution, personality/history loaders, professional-system integrations, mail bridge, operations dashboard, cross-project broker and private vendor packages are not included.

## Optional DeepSeek quota fallback

Set `DEEPSEEK_API_KEY` alongside your primary `MODEL_*` configuration to enable fallback in both hosts. An empty key keeps the existing behavior. The public edition uses an HTTPS primary-model adapter, not the private Codex App Server host. Your endpoint must return a typed quota failure: `error.codexErrorInfo: "usageLimitExceeded"` or `error.code: "insufficient_quota"`. A plain HTTP 429, authentication error, network failure or quota-like message text does not switch providers. See [the adapter and recovery contract](docs/architecture.md#quota-fallback).

On confirmed exhaustion, the current request and later inputs use DeepSeek. Quota state persists across restarts. Independent, history-free probes start after 15 minutes, then back off to 30 and 60 minutes; a known reset time can bring the next probe forward. Only a successful probe returning `{"ok":true}` restores the primary model. There is no service installation or restart automation.

Fallback supports ordinary chat and one reviewed action per turn: weather for either role; todo add/list/complete and expense add for `owner`; shared-place add/list in the local pair console only. Calls reuse the existing stores, permissions and local place notices. Reminders, deletes/cancels, multi-step work, other features, media and computer/professional tasks enter a private pending queue without execution or automatic replay. The single-owner WeChat host does not gain pair features or a reminder scheduler. During fallback, these restrictions apply before normal command routing; `帮助` and `降级说明` remain available.

Tool parameters are schema-checked and independently reviewed against the current request. Replies use actual handler receipts. A saved operation result is reused; an unresolved `started` record blocks replay. Model-written execution claims and unsupported live facts are rejected. These checks are bounded model-assisted controls, not a guarantee of intent accuracy. Requests have at most six model calls, a 180-second total model budget and a 45-second limit per DeepSeek call.

With fallback enabled, both models receive up to 12 recent same-side entries from a shared local transcript, including visible feature replies and labelled execution receipts. The transcript keeps at most 24 entries per account/sender/role and expires after 30 days of inactivity. DeepSeek tool selection/review may also receive the owner's current open-todo view. No other role's conversation, private personality projection or external history directory is loaded; ordinary answers use a generic example instruction. Keys, request headers and upstream error bodies are not logged. Enabling this option sends this bounded context to the configured providers.

中文：配置自己的 DeepSeek key 后，明确的主模型额度耗尽才启用兜底。单步功能复用公开版现有能力和权限；提醒等未接入功能只进入待处理，恢复后不会自动执行。输入「降级说明」可按章节查看用法。

## Ordinary chat lanes and batching

Ordinary model text uses three conservative lanes, enabled by default. L0/L1 generation defaults to an independently configured secondary provider when available; primary-model review and L2 routing remain in place. `WECHAT_CHAT_LANES=off` (also `false` or `0`, case-insensitive) skips classification, pending probes and speculative calls, using the baseline public text path. This runtime switch does not disable batching, stage budgets or quota fallback.

- **L0:** short self-contained greetings, acknowledgements, confirmations, repeated laughter and personal states use a no-tool request with strict `{reply, needs_tool}` output. A tool requirement, malformed output or unsupported execution claim discards the draft and falls back to L2.
- **L1:** narrowly matched stable questions, identity/name questions, opinions and feelings start the draft, request understanding and independent ordinary-eligibility check concurrently. Both eligibility checks must pass, followed by the local format/execution-claim gate. Reviewers see the original text and same-side history, never the draft or a personality profile.
- **L2:** unknown text/state, pending feature replies, previous assistant questions, fragments, numbers/time, links/media and execution requests keep the existing command/fallback/text routing. The primary model still cannot execute features. Enabled host probes cover weather/manual state and, in the console, daily questions, challenges and place selections/recent lists; unconnected libraries do not add probes.

On an initial L2 text path, a configured secondary provider may start one independent draft alongside the public host's existing primary understanding and independent admission contracts. Both strict `{ordinary:true}` results are required; reviewers never see the draft. At the original answer point, adoption also requires the local deterministic gate, the existing completion-claim exit check, strict `{reply, needs_tool:false}` parsing, a current request within its original deadline, and zero dispatch/actions/results. Any failure discards it and calls the original primary L2 answer with its original history contract. Pending/unknown/recovery/media contexts cannot adopt; L0/L1 fallbacks never start an additional L2 draft. The public edition has no private task controller, planner or executor; these two primary checks are added only for enabled L2 speculation. Their failures reject speculation; the original primary answer retains its existing auth/quota handoff.

`WECHAT_L2_DRAFT=off` (also `false` / `0`) disables L2 speculation per request. It defaults to on only when all three `FASTLANE_MODEL_*` settings are present; missing any setting disables it without adding primary checks. `WECHAT_FASTLANE_PROVIDER=primary` and `WECHAT_CHAT_LANES=off` also disable it. An already exhausted request bypasses speculation, and exhaustion is rechecked before adoption. Drafts never read or update quota/probe/journal state. This uses the same secondary adapter, prompt/persona, last 12 same-side history entries and single `min(20000ms, remainingDeadline)` attempt as L0/L1, without tool results, plans or upstream products. Rejection aborts the draft even if its transport ignores cancellation. Only the final visible answer enters history.

Comma admission uses the source conservative predicate: at least two nonempty sentence-ending/newline pieces, explicit coordination cues, or at least two recognizable question/request starts across comma-separated pieces imply multiple fragments. Commas alone do not. Only `，,、` separators are stripped for full matching against the unchanged whitelists; original length, numeric/time checks and hard-gate order remain intact. Unmatched comma text stays L2.

For primary-model speculative calls, the HTTP endpoint must accept `tool_choice: "none"` and strict `response_format: {type: "json_schema", ...}` for speculative calls. No tools are registered; unexpected function/tool responses are rejected. Primary-model fast drafts may retry once only after a typed first-output watchdog timeout, while still safe and within the original deadline; other draft failures fall back without a draft retry. Rejected drafts are never saved as conversation. HTTP calls are stateless; there is no model thread to resume. Custom `model(text, options)` callbacks must honor stage timeouts, deadlines, schemas and the no-tool contract. The stock adapter enforces those existing limits. It uses non-streaming JSON and has no first-output activity signal, so it does **not** arm a 15-second first-output watchdog or shorten the stage timeout. The 15-second policy hint and watchdog-only draft retry require a custom adapter that observes genuine model output; see the [adapter contract](docs/chat-performance.md#first-output-signal).

Configure `FASTLANE_MODEL_ENDPOINT`, `FASTLANE_MODEL_NAME` and `FASTLANE_MODEL_API_KEY` independently of `MODEL_*` and quota-fallback `DEEPSEEK_*`. The secondary endpoint uses OpenAI-compatible non-streaming chat completions with `response_format: {type: "json_object"}`. Endpoint, model and key have no built-in defaults and come only from env. Missing any of the three selects the primary generator for L0/L1 and disables L2 speculation. `WECHAT_FASTLANE_PROVIDER=primary` selects primary drafts; absent/`secondary` selects the secondary when configured. The switch is read on every request; only `primary` forces primary, other values retain automatic selection. A primary model is still required for L1 review and L2.

The shared speculative output instruction explicitly includes `JSON` beside the existing `{reply, needs_tool}` example for L0/L1/L2. This satisfies the secondary JSON-mode prompt contract without depending on user text or history containing that keyword; all other prompt rules remain unchanged.

Both HTTP generation paths use the **same prompt, generic persona and last 12 same-side history entries**. The secondary has no tools or executor. It makes **one attempt capped at 20 seconds**, clipped by the original request deadline, with abort and a local timeout race even if transport ignores abort. This is a complete-call budget, independent of the primary first-output hint. Error, timeout, malformed JSON, extra fields, tool/function requests, `needs_tool`, local-gate or completion-claim rejection discards the whole draft into L2; L1 never replaces it with a primary draft. Both L1 eligibility checks still run on the primary model in parallel and do not read the draft. L1 may wait beyond 20 seconds for those checks. Already exhausted primary quota bypasses all lanes, and primary auth/quota failures retain their existing handoff. Secondary failures do not update quota state or trigger its probes; the separate DeepSeek fallback budgets and state machine are unchanged.

Example placeholders (supply your authorized provider values):

```sh
export FASTLANE_MODEL_ENDPOINT="https://your-provider.example/v1/chat/completions"
export FASTLANE_MODEL_NAME="your-fast-model"
export FASTLANE_MODEL_API_KEY="your-provider-key"
export WECHAT_FASTLANE_PROVIDER="secondary" # use primary to switch back
export WECHAT_L2_DRAFT="on" # off disables only L2 speculation
```

Custom weather stores need a read-only boolean `hasPending(side)` probe to enable fast lanes and batching. Missing or invalid probe results keep requests on the baseline route and bypass batching.

The single-owner WeChat host persistently batches ordinary text after **1 second of quiet**, resetting silence on each fragment while flushing within **3.5 seconds of the first arrival**. Every nonblank text item in a message, all message IDs and attachment provenance are retained, including buffered recovery; known feature commands stay separate. Polling continues while the serial worker runs. The local console treats each submitted line as one request and does not batch. Neither path gains media download or interpretation.

Primary model stages allow **40 seconds** for understanding/review and **60 seconds** for an ordinary answer; the exported policy reserves **120 seconds** for result planning, which this host does not implement. Batching, queueing, speculation, L2 fallback and pure-stage retries share **150 seconds from first accepted ingress** for primary generation and later dispatch. This is **not an end-to-end hard deadline**: an already invoked operation, transport cleanup and delivery retain their existing lifecycle and actual timing. Only pure model stages may retry once, on a fresh stateless call, before any feature dispatch; auth, quota, budget and unexpected-tool failures never retry. DeepSeek retains its separate six-call/180-second fallback budget.

Visible replies now retain a bounded same-side transcript in `state/chat/threads.json` even without DeepSeek. Fast lanes may send its last 12 entries to the selected generation provider and primary reviewers; the no-fallback L2/off path retains its original current-text-only input. Fallback-enabled L2 and both fallback providers retain their existing same-side history contract. Storage remains 24 entries per account/sender/role, with a 30-day inactive expiry on reading; this does not automatically erase disk files. No external or other-role history is loaded.

The CLI emits body-free `model timing` and `chat timing` records to stderr, including `provider` (`primary`/`secondary`, or `deepseek` for an already exhausted bypass), stage/attempt, lane/reason/fallback, duration and `timeoutReason` / `firstOutputWatchdog` / `firstOutputMs`. Secondary timeouts report `timeoutReason: "fastlane_budget"`; draft fallback reasons carry `primary_`/`secondary_` prefixes, while `check_fail` and `stale_or_budget` remain shared. Per-model records identify the actual caller; request `provider` identifies the selected L0/L1 generator even after fallback. L2 appends `draftProvider`, `draftMs` (actual provider duration or null) and `draftOutcome`, leaving the original fields unchanged. Outcomes are `disabled`, `pending`, `sent`, `discarded_needs_pipeline`, `discarded_check`, `discarded_gate`, `discarded_timeout` and `discarded_error`. `sent` means adopted, not delivered. L2 secondary model rows are buffered until that decision; earlier primary rows may show pending. Stock primary HTTP calls report `firstOutputMs: null` and `firstOutputWatchdog: false`; an actual stage/deadline timeout reports `timeoutReason: "stage_budget"`. WeChat also records batch/queue/delivery durations and server acceptance, using a random trace ID rather than account/sender IDs. These diagnostics do not establish recipient delivery. The 71 fictional offline cases, additional short-shape paraphrases and near-miss traps, watchdog-only retry tests and baseline differential tests run in `npm run check`; they establish wiring and safety boundaries, not real-model quality, production hit rates or measured speed improvements. See the [detailed contract](docs/chat-performance.md) and [round-five local sync report](artifacts/speed-package/public-sync-round5-report.md) (local artifact, ignored by Git by default).

Secondary model timing additionally records `providerErrorCategory` (`http_status`, `network`, `timeout`, `cancelled`, `invalid_response`, `configuration`, `unknown`; null without a provider failure) and `providerHttpStatus` (an integer from 100 to 599 only for `http_status`, otherwise null). Existing `failureReason` values and return shapes remain unchanged; malformed/truncated provider envelopes can have `invalid_response` alongside the existing `invalid_output`, while local answer JSON/schema rejection and unexpected tools retain their existing reasons without a provider-error category.

L2 retains those scalars as `draftProviderErrorCategory` and `draftProviderHttpStatus` in shared timing and the deferred secondary row. It also adds `draftCheckApproved`, `draftCheckNeedsUser`, `draftCheckIssuesCount` and `draftCheckRejectReason`. The public host's strict `{ordinary:boolean}` verdict maps to `draftCheckApproved`; its schema supplies neither `needsUser` nor `issues`, so those two diagnostics remain null. Rejection reasons use the shared vocabulary `call_failed`, `invalid_verdict`, `needs_user`, `issues_present`, `not_approved`; this host can produce the first two or `not_approved`, with null for a passed or unobserved check. This mapping changes no adoption or review rules. A late parallel check may update later snapshots after an earlier discard; it cannot change that decision or rewrite already emitted rows. Logs contain no request, draft, issue text, upstream response body or raw exception. Offline diagnostics tests use synthetic transports; live provider acceptance and delivery require separate verification.

## Runtime and configuration

Console writes persist under `state/features/<feature>/` inside your runtime, with an index and classified bodies when supported. The pair features use `shared-place`, `pair-daily-question`, `pair-challenge` and `pair-savings`; weather settings and per-role delivery status use `state/features/weather/state.json`; existing personal paths are unchanged. The text transport keeps account binding, cursor, message IDs, buffered/queued batches and pending output under `state/transport/`. It never imports another installation's state. Feature dates follow each module's `Asia/Shanghai` calendar rules. Bounded same-side transcripts live in `state/chat/threads.json`. When fallback is enabled, `state/model-fallback/codex-quota.json` stores breaker state, `state/model-fallback/operations/` stores per-turn execution records and `queues/model-fallback/pending.jsonl` stores deferred requests. Deferred fallback requests and operation records are not automatically replayed or cleaned up.

Keep runtime and credentials private and outside Git. `.env.example` lists environment variable names and defaults; the application does **not** automatically load it. Export your own values through your shell or service manager, or explicitly load your own ignored `.env` with Node 24:

```sh
cp .env.example .env
# Fill in your own values locally; never commit this file.
node --env-file=.env src/main.js
# Single-owner transport: node --env-file=.env src/main.js --wechat
```

No private installation path or env file is discovered or sourced automatically. A running process needs a restart to receive changed variables.

| Variable | Default / meaning |
| --- | --- |
| `WECHAT_ASSISTANT_HOME` | `${XDG_DATA_HOME}/wechat-assistant-framework/runtime`; when `XDG_DATA_HOME` is unset, use `${HOME}/.local/share`. A relative override resolves against the current directory. |
| `WECHAT_BASE_URL` | Empty. Your compatible WeChat protocol HTTPS base URL. |
| `WECHAT_ACCOUNT_ID` | Empty. Your own bot account identity; required in WeChat mode. |
| `WECHAT_OWNER_ID` | Empty. The one authorized sender; required in WeChat mode. |
| `WECHAT_TOKEN` | Empty. Your own protocol credential; required in WeChat mode. |
| `MODEL_ENDPOINT` | Empty, model disabled. A complete HTTPS chat-completion URL. |
| `MODEL_NAME`, `MODEL_API_KEY` | Empty. Required when the model endpoint is enabled. |
| `MODEL_TIMEOUT_MS` | `30000`; integer from `1000` to `120000`, for direct adapter calls. The ordinary host applies the stage limits above; primary recovery probes use 15000 ms. |
| `WECHAT_CHAT_LANES` | `on`; `off` / `false` / `0` skip fast lanes and state probes at runtime. |
| `WECHAT_FASTLANE_PROVIDER` | Automatic secondary when configured; `primary` forces primary drafts. Read at runtime. |
| `WECHAT_L2_DRAFT` | `on`; `off` / `false` / `0` disable L2 speculation at runtime. Primary provider selection or missing secondary config also disables it. |
| `FASTLANE_MODEL_ENDPOINT`, `FASTLANE_MODEL_NAME`, `FASTLANE_MODEL_API_KEY` | Empty. Independent HTTPS chat-completion URL, model and key for no-tool L0/L1/L2 drafts; missing any selects primary for L0/L1 and disables L2 speculation. |
| `DEEPSEEK_API_KEY` | Empty, fallback disabled. Your own key; requires a configured primary model. |
| `DEEPSEEK_MODEL` | `deepseek-flash`; override with a model supported by your DeepSeek account. Requests use the fixed official HTTPS chat-completion endpoint. |
| `WEATHER_STATE_FILE` | `state/features/weather/state.json`, relative to the configured runtime; an explicit custom path overrides it. Stores settings, pending city queries and delivery controls only. |
| `WEATHER_MORNING_TIME` | `08:00`, Shanghai `HH:MM`; read by the injected scheduler. No timer starts automatically. |
| `AMAP_WEB_SERVICE_KEY` | Empty. Optional library only; pass your own key as `apiKey` to a map provider. The console does not read it. |

For the optional **single-owner** transport, configure your own account, then run `npm run wechat`. The adapter expects `ilink/bot/getupdates` and `ilink/bot/sendmessage`, text items, inbound message IDs and context tokens. There is no QR login, account provisioning/discovery, gateway installation, credential acquisition, second-account binding or relay. Integrators must authenticate both real participants outside message text and enforce consent/visibility before using pair APIs. See the [protocol contract](docs/architecture.md).

Run one foreground consumer per account/runtime. Multiple consumers can steal messages or race state writes; concurrent writers are unsupported. Use separate runtimes for console simulation and real account bindings. The optional model expects a `messages` request and `choices[0].message.content` response; other protocols need an adapter.

## Privacy, testing and limits

No real personal information, account configuration, conversation, customer material, token, database, runtime snapshot or original private Git history is included. Local-first means local storage and configuration control. Enabling WeChat sends traffic outside your computer; a configured model receives the current question and bounded same-side context as described above; optional map/media providers receive explicitly supplied inputs. Consult your providers' retention policies. Runtime files and tokens are sensitive and are not encrypted by this framework.

The WeChat transport checkpoints before feature execution or sending. A restart with an unresolved `executing` / `sending` operation stops for local inspection. A saved `ready` result resumes only unsent chunks with stable client IDs. Automatic uncertain-result reconciliation, exactly-once delivery, scheduler/broker wiring and live account acceptance are not provided. Server acceptance does not prove recipient delivery. See [recovery instructions](docs/architecture.md).

```sh
npm test
npm run check
```

Tests run with an isolated temporary HOME and runtime, without inherited account/model credentials. Fictional fixtures cover pair-console switching, shared visibility, sealed answers, challenge notices, contribution totals, personal permissions, the actual console entrypoint, demo scenes and temporary-file cleanup, role-isolated weather/city selection, refresh-reply priority and 24-hour expiry across restarts, scheduler restart and failure controls, progressive manuals, and offline simulated weather delivery, quota classification/reset/backoff, fallback role isolation, actual store writes, uncertain-operation replay prevention, explicit env-file loading and same-side cross-model history, plus the existing module and transport suites. HTTP, model, map and media providers are mocked. Passing tests and the demo do not certify real WeChat connectivity, model quality, provider authorization or deployment. See [verification scope](SCAN.md).

中文：本版把双人玩法接到了默认本地控制台，单人待办、记账、临时信息和习惯仍按原权限可用。双人决策、共同目标、约会轮次等附带模块尚需使用者自行接入宿主。所有示例均为虚构；真实微信双账号、relay、通知送达与部署不在本地测试验收范围内。

This is an independent project, not an official WeChat product or SDK. Use only accounts and data you are authorized to operate. Provided **AS IS**, without warranty. Project code is MIT licensed and uses the Node.js standard library only; third-party services and any dependencies you add retain their own terms.
