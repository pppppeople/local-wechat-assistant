# 通用功能说明书与天气宿主接入

公开版提供通用的渐进说明书，目前接入天气与可选额度降级说明。每条天气回复，包括错误、设置回执、测试与早报，最后独占一行显示 `看用法回：天气说明`。仅内部跳过不生成回复。

## 注册与回复

`createFeatureManual({ now, ttlMs })` 创建注册表与进程内会话，默认 15 分钟无操作后过期。调用 `register({ triggerWord, aliases, intro, sections })` 注册：

- `triggerWord` 是标准入口，`aliases` 是可选别名；天气使用 `天气说明` / `天气帮助`。
- `intro` 是一句话简介；`sections` 是有序 `{ title, keywords, body }`。
- 先只显示简介及编号目录。编号从 1 开始，标题与关键词精确匹配。
- 选节后只显示该节；长节的 `body` 可写成短段数组，每次回 `继续` 才展开下一段。

`select(side, text, { isCommand })` 返回说明书文本或 `null`。`footer(triggerWord, reply)` 追加固定页脚；已有相同结尾不重复追加。`exit(side)` 退出该角色会话。

## 会话与命令优先级

`owner` / `friend` 会话分别保存在内存，重启清空。不保存聊天历史，也不授权功能动作。其他文字退出说明书；已识别的其他功能命令应优先分发，调用 `exit(side)` 或传 `isCommand: true`，避免把命令当成章节关键词或待选城市。控制台切换角色保留各自会话，不会将一方的章节选择交给另一方。

公开版 `public-assistant` 接入个人命令与天气，`public-pair-console` 先识别双人命令，再交给该处理器。说明书不调用模型；选中的天气输入直接返回天气结果，解析失败也明确呈现，不静默转普通问答或模型。含「天气」的文字不作裸城市候选；其他文字仍按现有路由处理。

## 天气说明目录

1. 怎么查天气：`天气` 查询今日＋明日；`今日天气`、`明天天气` / `明日天气`、`后天天气` 查询指定日期。`苏州天气` 解析并保存本侧城市，先确认再查今日＋明日；`苏州今日天气`、`苏州明天天气` / `苏州明日天气`、`苏州后天天气` 则只查对应单日，覆盖原待选日期；没有待选或正在看说明书时也可使用。日期按上海日历计算。
2. 怎么切换城市：首次没有默认城市，先提示选城；直接回城市名或 `设置天气城市：城市名`，解析成功后保存并立即补查原查询日期。两种角色各存各的城市。无匹配、返回其他城市或服务异常时回复「解析不了这个天气城市，请换个城市名再试；原设置未修改。」，保留原设置与待选状态，可换名重试。
3. 早报：时间与开关：双方都可独立执行 `开启天气早报` / `关闭天气早报`、`天气早报测试`。测试查询不占定时次数。推送需要宿主自备通道。
4. 数据来源与说明：默认用 OpenStreetMap/Nominatim 解析地点及 Open-Meteo 天气；可注入 Amap provider，并沿用按坐标的 Open-Meteo 兜底。查不到不编造；Open-Meteo 全天预报不当作独立昼夜数据，缺失的风向风力、温度均明确标注。天气仅供参考，重要决策请核对当地官方预警。

## 天气状态与调度

`createWeatherStore({ runtime, env, stateFile, now })` 只保存每个角色的城市、待选查询、早报开关、首次选城提示及发送状态。默认路径是 runtime 内 `state/features/weather/state.json`，`WEATHER_STATE_FILE` 可覆盖，相对值基于 runtime；runtime 沿用 `WECHAT_ASSISTANT_HOME` / XDG 数据目录规则。显式 `stateFile` 优先。文件按私有权限原子写入，损坏时拒绝覆盖；不存预报正文或会话历史。单 runtime 只支持一个写入宿主。

待选查询记录毫秒时间戳 `createdAt` / `expiresAt`，创建满 24 小时静默失效，重启保留期限，失败重试及早报 tick 不延长已有显式待答；缺少时间记录的旧待答在读取时失效。过期不删除已存城市或修改早报开关，裸城市文字按普通路由处理，可重新发「天气」开始选城。注入模拟时钟时，store 与 commands / morning / assistant 使用同一个 `now`。

两种公开处理器均暴露 `contextLeases`：宿主用 `refresh({ senderId, token })` 更新已认证角色的上下文，以 `warningStatus({ senderId, token })` 判断提醒时机；仅在刷新提醒确认发送后调用 `recordWarning({ senderId, token })`。标记与租约存于 runtime 的 `state/transport/context-leases.json`。提醒后的同侧下一条入站在 24 小时内由 dispatch 一次性消费标记，再照常处理消息，仅跳过天气裸城市待答识别，保留天气待答原期限。新 token 不抹掉未消费标记，其他角色与控制台切换不消费本侧标记；默认宿主不自动调度或发送刷新提醒。直接使用天气模块的自定义宿主应先消费刷新标记，并向 `selectInput` 传入 `{ skipPendingCity: true }`。

`createWeatherCommands({ store, provider, now, morningTime, log })` 接受现有 provider 的 `searchPlace(name)` / `weather(place, date)`。地点必须与城市元数据匹配且具备编码或坐标；不会把搜索第一项无条件当作城市。没有隐式环境默认城市。宿主调用 `selectInput(side, text)` 后将命令交给 `handle(side, command)`，结果为 `{ ok, reply }`；即使 `ok: false` 也应呈现 `reply`，不忽略或重投普通路由。可选 `log` 仅记录城市解析失败的命令类型与类别（`no_match` / `provider_error`），不含城市、消息正文或服务错误详情；`briefing(side)` 生成今日＋明日早报。

`createWeatherMorning({ store, weather, send, now, time, sides, log })` 返回 `tick()`，不创建定时器。`send(side, text, clientId)` 和调用频率均由宿主负责；默认角色为 `owner` / `friend`，单人宿主可指定 `sides: ['owner']`。默认时间为上海时间 08:00，`time` 或 `WEATHER_MORNING_TIME` 覆盖，必须是 `HH:MM`。`now` 返回毫秒时间戳，便于离线模拟。

- 未选城时最多发送一次选城提示，选城后从次日开始早报；显式待选查询仍立即补查。
- 启用状态默认允许调度。08:00 后重启可补发当天早报，12:00 起不补发；若配置中午或下午时间，仅在配置的那一分钟可执行。
- 每角色每天先持久化 claim，再查询和发送；并发 tick、重启以及发送结果不确定时不自动重放。
- 预报查不到记为 `unavailable`，发送失败记为 `failed`，跨截止时间记为 `expired`；一天内不重试。成功记为 `sent`，仅表示回调成功，不能证明用户收到了消息。
- 本地控制台与默认文字宿主均不自动启动天气推送。README 给出注入示例；真实身份绑定、授权、定时器生命周期、发送回执由集成者实现。

## 验证入口

```sh
node --test tests/feature-manual.test.js tests/weather.test.js tests/public-pair-console.test.js tests/amap-place-provider.test.js
npm run demo
npm run check
```

测试使用虚构角色、合成地点与天气及模拟发送；demo 第五幕按照要求输入苏州，所有预报均明确标注为离线模拟。默认控制台的网络 provider 合同由 mock 验证，测试与 demo 不证明实时天气可用、真实微信连通或消息送达。

## 降级说明

启用 DeepSeek 兜底后，两个宿主均提供「降级说明」（别名「降级帮助」），目录含能力、待处理、恢复与隐私三节。会话按角色隔离，15 分钟无操作过期，其他功能命令退出。降级回复带独立页脚 `看用法回：降级说明`。未配置时明确提示配置入口，不调用模型。

个人待办/记账仍仅 owner 可用，想去箱仅双人控制台接入；提醒等未接入功能进入待处理，恢复后不自动重放。详见 README 的额度兜底部分。

## 普通问答与等待状态

普通主模型文字默认启用 L0/L1/L2 三车道；天气待选城、说明书会话、控制台的每日一问/默契挑战/地点待选及最近列表都会保守阻止快道。状态读取不明同样走 L2。功能命令仍按现有权限与回执处理，快道不会执行或伪称保存功能。微信普通文字攒批为静默一秒、首条起最多 3.5 秒；控制台每次提交独立处理。配置 `WECHAT_CHAT_LANES=off` 可关闭快道，保留分阶段预算与原有功能。150 秒是首条入站起的主模型/后续派发截止，不是投递硬封顶。详见 [普通聊天合同](chat-performance.md)。
