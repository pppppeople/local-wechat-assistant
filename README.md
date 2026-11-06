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
| `设置天气城市：城市名` | Resolve and save only the current role's city; an unresolved city leaves the old setting intact |
| `开启天气早报` / `关闭天气早报` | Set only the current role's morning switch; delivery requires a host |
| `天气早报测试` | Display today + tomorrow now, without consuming a scheduled delivery |
| `天气说明` / `天气帮助` | Compact catalog; select 1–4 or a section keyword to expand; long sections use `继续` |

The console uses the existing keyless provider: OpenStreetMap/Nominatim resolves cities and Open-Meteo supplies forecasts. A host may inject `createPlaceProvider({ apiKey })` for Amap weather with Open-Meteo fallback. City lookup must match returned place metadata; unavailable or unmatched lookup is reported instead of guessing. Weather replies include day/night conditions, high/low temperatures, winds, rain/snow advice when supported, source attribution, and `看用法回：天气说明`. Open-Meteo supplies a daily summary; separate day/night conditions and wind direction/force are marked unavailable. Forecasts can change and are for reference only; consult official local warnings for decisions.

中文：双方天气设置、待选城市和早报状态分别保存。没有默认城市；首次查天气先选城，选好立即补查。查不到就明确说明，缺失字段不补造。说明书先给「怎么查天气 / 怎么切换城市 / 早报：时间与开关 / 数据来源与说明」目录，选择后只展开该节；15 分钟无操作过期，其他功能命令自动退出，按角色隔离，重启清空说明书会话。

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

Unmatched text receives command help unless you configure an optional model. The model receives only the current unmatched question and a fixed instruction. It cannot select commands, read saved answers or history, access local files, or invoke a computer executor.

## Included modules and wiring

| Layer | Included behavior | Integration status |
| --- | --- | --- |
| Pair console | Shared place box, daily question, compatibility challenge, shared savings; speaker switch and local notices | Playable now with `npm start` and `npm run demo`, using existing `shared-*` / `pair-*` stores and command parsers |
| Weather | Role-local city selection, current/next-day forecasts, progressive manual; injectable morning scheduler | Queries work in the console and text host; real morning timer and delivery are host responsibilities |
| More pair modules | Pair decisions, shared goals, date/outing turns, wishes and other shared records | Exported library modules; require explicit host integration; not console commands yet |
| Personal assistant | Todos with dependencies, expenses, expiring notes, habits | Available in the console for `owner` and in the single-owner WeChat text host |
| Optional model | One current-question chat-completion request, bounded output and timeout | Requires your HTTPS endpoint, model name and API credential; no tools or history loading |
| WeChat text transport | Exact owner/account binding, polling, message-ID deduplication, chunked replies, durable checkpoints | Single-owner transport only; requires your own authorized compatible protocol access; real account acceptance remains unverified |
| Extension libraries | Reminders, inventory, route planning, inbox/tickets/gifts, work/learning/writing, media adapters, games, recovery utilities | Separate modules with injected stores/providers; not registered in the default host unless listed above |

`main.js` selects `public-pair-console` for local use and `public-assistant` for the single-owner WeChat transport. Speaker-switch text is interpreted **only** in the local console; a WeChat message cannot choose a pair role. The console calls the existing command parsers and stores directly, with no new pair data implementation. See [architecture and recovery](docs/architecture.md) and [module inventory](docs/modules.md).

The original private host, shell execution, personality/history loaders, professional-system integrations, mail bridge, operations dashboard, cross-project broker and private vendor packages are not included.

## Runtime and configuration

Console writes persist under `state/features/<feature>/` inside your runtime, with an index and classified bodies when supported. The pair features use `shared-place`, `pair-daily-question`, `pair-challenge` and `pair-savings`; weather settings and per-role delivery status use `state/features/weather/state.json`; existing personal paths are unchanged. The text transport keeps account binding, cursor, message IDs and pending output under `state/transport/`. It never imports another installation's state. Feature dates follow each module's `Asia/Shanghai` calendar rules.

Keep runtime and credentials private and outside Git. `.env.example` lists environment variable names and defaults; the application does **not** automatically load it. Export your own values through your shell or service manager.

| Variable | Default / meaning |
| --- | --- |
| `WECHAT_ASSISTANT_HOME` | `${XDG_DATA_HOME}/wechat-assistant-framework/runtime`; when `XDG_DATA_HOME` is unset, use `${HOME}/.local/share`. A relative override resolves against the current directory. |
| `WECHAT_BASE_URL` | Empty. Your compatible WeChat protocol HTTPS base URL. |
| `WECHAT_ACCOUNT_ID` | Empty. Your own bot account identity; required in WeChat mode. |
| `WECHAT_OWNER_ID` | Empty. The one authorized sender; required in WeChat mode. |
| `WECHAT_TOKEN` | Empty. Your own protocol credential; required in WeChat mode. |
| `MODEL_ENDPOINT` | Empty, model disabled. A complete HTTPS chat-completion URL. |
| `MODEL_NAME`, `MODEL_API_KEY` | Empty. Required when the model endpoint is enabled. |
| `MODEL_TIMEOUT_MS` | `30000`; integer from `1000` to `120000`. |
| `WEATHER_STATE_FILE` | `state/features/weather/state.json`, relative to the configured runtime; an explicit custom path overrides it. Stores settings, pending city queries and delivery controls only. |
| `WEATHER_MORNING_TIME` | `08:00`, Shanghai `HH:MM`; read by the injected scheduler. No timer starts automatically. |
| `AMAP_WEB_SERVICE_KEY` | Empty. Optional library only; pass your own key as `apiKey` to a map provider. The console does not read it. |

For the optional **single-owner** transport, configure your own account, then run `npm run wechat`. The adapter expects `ilink/bot/getupdates` and `ilink/bot/sendmessage`, text items, inbound message IDs and context tokens. There is no QR login, account provisioning/discovery, gateway installation, credential acquisition, second-account binding or relay. Integrators must authenticate both real participants outside message text and enforce consent/visibility before using pair APIs. See the [protocol contract](docs/architecture.md).

Run one foreground consumer per account/runtime. Multiple consumers can steal messages or race state writes; concurrent writers are unsupported. Use separate runtimes for console simulation and real account bindings. The optional model expects a `messages` request and `choices[0].message.content` response; other protocols need an adapter.

## Privacy, testing and limits

No real personal information, account configuration, conversation, customer material, token, database, runtime snapshot or original private Git history is included. Local-first means local storage and configuration control. Enabling WeChat sends traffic outside your computer; a configured model receives the current question; optional map/media providers receive explicitly supplied inputs. Consult your providers' retention policies. Runtime files and tokens are sensitive and are not encrypted by this framework.

The WeChat transport checkpoints before feature execution or sending. A restart with an unresolved `executing` / `sending` operation stops for local inspection. A saved `ready` result resumes only unsent chunks with stable client IDs. Automatic uncertain-result reconciliation, exactly-once delivery, scheduler/broker wiring and live account acceptance are not provided. Server acceptance does not prove recipient delivery. See [recovery instructions](docs/architecture.md).

```sh
npm test
npm run check
```

Tests run with an isolated temporary HOME and runtime, without inherited account/model credentials. Fictional fixtures cover pair-console switching, shared visibility, sealed answers, challenge notices, contribution totals, personal permissions, the actual console entrypoint, demo scenes and temporary-file cleanup, role-isolated weather/city selection, scheduler restart and failure controls, progressive manuals, and offline simulated weather delivery, plus the existing module and transport suites. HTTP, model, map and media providers are mocked. Passing tests and the demo do not certify real WeChat connectivity, model quality, provider authorization or deployment. See [verification scope](SCAN.md).

中文：本版把双人玩法接到了默认本地控制台，单人待办、记账、临时信息和习惯仍按原权限可用。双人决策、共同目标、约会轮次等附带模块尚需使用者自行接入宿主。所有示例均为虚构；真实微信双账号、relay、通知送达与部署不在本地测试验收范围内。

This is an independent project, not an official WeChat product or SDK. Use only accounts and data you are authorized to operate. Provided **AS IS**, without warranty. Project code is MIT licensed and uses the Node.js standard library only; third-party services and any dependencies you add retain their own terms.
