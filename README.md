# local-wechat-assistant

A local-first WeChat assistant framework with an owner-bound text transport, optional AI replies and reusable feature modules. The foreground host supports personal todos, expense entries, temporary notes and habit tracking. Node.js standard library only.

Examples and test inputs are fictional. No account configuration, real conversation, personal history, customer material, token, database, runtime state or original Git history is included.

## Run locally

Use Node.js 24+ from this directory. There are no packages to install:

```sh
npm test
npm run demo
npm start
```

The demo uses a temporary directory and a fake model, then removes its own temporary files. It never contacts WeChat, a model or a map service. `npm start` opens a local line-based console; ordinary text receives command help until you configure a model. Try these fictional commands:

```text
记一下 明天买牛奶
我的待办
记账 12元 餐饮 示例午餐
今日账单
存临时信息 示例备忘
临时信息
创建习惯：散步
我的习惯
```

Feature dates use the modules' documented `Asia/Shanghai` calendar rules. A console command writes only to the configured runtime. Keep private configuration outside this checkout. `.env.example` lists names and defaults; the application does **not** automatically load it. Export your values through your shell or service manager, then use `npm run wechat` for the foreground WeChat transport.

## Features and architecture

| Layer | Included behavior | Integration status |
| --- | --- | --- |
| Default assistant | Explicit command parsing, local todos with dependencies, expenses, expiring notes and habits | Connected to console and WeChat text host |
| Optional model | One current-question chat-completion request, bounded output and timeout | Requires your HTTPS endpoint, model name and API credential; no tools or chat-history loading |
| WeChat text transport | Polling, exact owner/account checks, message-ID deduplication, chunked replies and durable checkpoints | Requires your own authorized compatible protocol access; live acceptance remains unverified |
| Feature library | Inventory and purchase records, reminders/parsers, saved places and route planning, inbox/tickets/gifts, work notes, learning, writing, image-processing adapters, text games and friend collaboration | Separate modules with injected stores/providers; most are **not** registered in the default host |
| Recovery library | Classified JSON records, context leases, send-result checks, delivery outbox and execution journal | Reusable components; the default host uses its own compact transport checkpoint |

`src/main.js` wires `public-config`, `public-assistant`, the optional `public-model` and `public-wechat`. Feature records are written under `state/features/<feature>/` inside your runtime. Each feature keeps an index and any classified record bodies together. The text transport keeps binding, polling cursor, processed message IDs and pending output under `state/transport/`; it does not import another installation's state. See [architecture and recovery](docs/architecture.md) and [module inventory](docs/modules.md).

The default model receives only your current unmatched question and a fixed instruction. It cannot select commands, access local files or invoke a computer executor. The original multi-purpose private host, shell execution policy, personality/history loaders, professional-system integrations, mail bridge, operations dashboard, cross-project broker and private vendor packages are not part of this framework.

## Configuration and prerequisites

| Variable | Default / meaning |
| --- | --- |
| `WECHAT_ASSISTANT_HOME` | `${XDG_DATA_HOME}/wechat-assistant-framework/runtime`; when `XDG_DATA_HOME` is unset, use `${HOME}/.local/share`. A relative override resolves against the current working directory. |
| `WECHAT_BASE_URL` | Empty. Your compatible WeChat protocol HTTPS base URL. |
| `WECHAT_ACCOUNT_ID` | Empty. Your own bot account identity; required in WeChat mode. |
| `WECHAT_OWNER_ID` | Empty. The one explicitly authorized sender; required in WeChat mode. |
| `WECHAT_TOKEN` | Empty. Your own protocol credential; required in WeChat mode. |
| `MODEL_ENDPOINT` | Empty, model disabled. A complete HTTPS chat-completion URL. |
| `MODEL_NAME`, `MODEL_API_KEY` | Empty. Required when the model endpoint is enabled. |
| `MODEL_TIMEOUT_MS` | `30000`; integer from `1000` to `120000`. |
| `AMAP_WEB_SERVICE_KEY` | Empty. Optional library integration only; explicitly pass your own key as `apiKey` to the map provider. The default host does not read it. |

Supply and verify your own account authorization, compatible server and network access. This repository contains no QR login, account provisioning, account discovery, gateway installation, background-service installer or credential acquisition mechanism. The transport expects `ilink/bot/getupdates` and `ilink/bot/sendmessage`, text items, inbound message IDs and context tokens. See the [protocol contract](docs/architecture.md). Run one foreground consumer per account/runtime. A second consumer or another application using the same account can steal messages or race state writes; concurrent writers are unsupported.

The optional model expects the usual `messages` request and `choices[0].message.content` response; provider-specific protocols require an adapter. Image, map, friend and other advanced modules require their own explicit host integration and provider inputs. Friend APIs use generic `owner` / `friend` roles: the integrating host must authenticate both sides and enforce consent and visibility before calling them. No friend account, relay broker or notification recipient is configured here.

## Privacy, testing and limits

Local-first refers to local storage and configuration control. WeChat traffic leaves your computer; enabling a model sends the current question to your configured service. Optional map/image providers also send the inputs you explicitly provide. Consult your chosen providers' retention policies. Runtime records and context tokens are sensitive local data; they are not encrypted by this framework. Keep runtime private and outside Git, and use a separate runtime for each account binding.

The transport checkpoints before invoking a feature or sending a chunk. A restart with an unresolved `executing` / `sending` operation stops for local inspection rather than repeating it. A saved `ready` result resumes only its remaining unsent chunks with stable client IDs. Automatic reconciliation of uncertain results, exactly-once external delivery, scheduler/broker wiring and live account acceptance are not provided. Server acceptance is not proof of recipient delivery. See [recovery instructions](docs/architecture.md).

```sh
npm run check
```

Tests run with a fresh temporary HOME and runtime, without inherited account/model credentials. They use fictional fixtures, mocked HTTP/model/map/media providers and temporary files. They do not contact a real account or model. Tests and the demo do not certify real WeChat connectivity, model quality, provider authorization or deployment. See [verification scope](SCAN.md).

This is an independent framework, not an official WeChat product or SDK. Protocol availability depends on your own environment and account access. Use it only with accounts and data you are authorized to operate. The software is provided **AS IS**, without warranty. MIT covers project code; third-party services and any dependencies you add retain their own terms.

中文：本地运行的微信助手框架，默认提供本人绑定的文字收发、待办、记账、临时信息和习惯打卡；附带经过泛化的功能模块供二次接入。账号、模型及可选服务须本人配置，示例全部虚构，真实微信收发与部署尚未验收。
