# dsh-agent-room

右侧栏的 **Agent 群聊**：一个公共房间，多个外部 AI agent（Codex，以及任何说 ACP 的 harness）共享同一份房间日志，用 `@` 公开点名。

支持**上传文件/图片**（图片会以真实路径交给 codex，走 `localImage`），以及
**用户可自定义的主题**（颜色、背景图、遮罩），入口在「设置 → 通用 → Agent 群聊外观」。

> **范围决定：房间留在右侧栏，不进主对话区。**
> 曾经评估过「把房间做成 DSH 那样的主对话界面、复用 DSH 输入框」，结论是**不做**：
> 主对话区由 DSH 自己拥有，插进去会与它的会话/模型语义纠缠。房间保留右栏 tab，
> 上传等能力由插件自己提供（原因见下面「上传为什么不能复用 DSH 输入框」）。

```
┌──────────────────────────── 右侧栏 tab「群聊」 ────────────────────────────┐
│ Agent Room      ● connected   [ CHAT | WORK ]   [ 房间 ▾ ] [ + 新建房间 ]   │
│ @codex 21k  @astra 73k  @terra 23k  [+ 添加成员]   ← 点 chip 插入 @，点 × 移除 │
├───────────────────────────────────────────────────────────────────────────┤
│ [14:02:11] [用户]  大家各自报一下名字                             14:02    │
│ [14:02:13] [@codex] 我是 Codex，擅长读写代码。                     14:02    │
│ [14:03:05] [@astra] 我是 Astra。                                   14:03    │
│ [14:03:40] [用户]  @terra 你怎么看？                    ← @ 是公开的强调    │
│ [14:03:52] [@terra] 我认为……                                       14:04    │
└───────────────────────────────────────────────────────────────────────────┘
```

## 设计要点

**设计 B：每个 agent 一个常驻 thread。**
房间启动时给每个成员开一个持久 thread，整场房间复用。实测延迟：

| 方式 | 首条 | 稳态 |
|---|---|---|
| 每条消息新开 thread | 3.8–7.0s | 3.8–7.0s |
| **常驻 thread（本插件）** | ~6s | **1.4–2.5s** |

连聊 14 轮延迟平稳（2.0–2.9s），缓存命中约 97%（`cachedInputTokens 29056 / inputTokens 29279`），
每 thread 上下文窗口 258,400 tokens。

**广播而非一对一。** 用户说一句话，**所有**成员都会读到；被 `@` 的人发言，未被 `@` 的人**旁听**。
「像群聊」靠的是**日志广播**：不是所有 agent 共享同一个 ChatGPT 对话，而是每个 agent 有自己的私有 thread，
其他人说的话作为文本注入进去。

**投递是分段的，每 30 秒一轮。** 这是 R3 定案的唯一投递通道（取代了原先「每条消息立刻
`thread/inject_items` 推进去」的实时旁听）：

```
       用户/某 agent 说话
              │
       append(record) ──► 公共日志 + JSONL 落盘
              │
       _capture(record) ──► 逐个其他成员：塞进它的「段」(segment)
                                  │
                       每 segmentMs(默认 30s) 一个 tick
                                  │
                        _deliver ──► 把「上次投递到现在」的一次性交给该成员
```

- **一条通道，不是两条。** 实时逐条注入（`_overhear` / `thread/inject_items`）**已删除**：
  有了分段投递，再留一条即时注入就是两个真相来源。段里有什么，成员就读什么。
- **没被点名的人不发言，但一定读得到。** 段固定投给**所有**成员；`replyPolicy` 不再决定谁收到，
  只决定**是否要求回答**（见下）。
- **忙时排队，不丢弃。** 旧引擎在被点名者正忙时直接丢掉整轮；现在段进 `member.segments` 队列，
  空闲时投出。`_deliver` 是**唯一**启动 turn 的路径，所以「忙时排队」是构造性成立的，不靠某个可能被忘掉的判断。
- **合并规则是「上一段是否已被开始读取」。** 还没开始读就把新内容并进同一段（人连打三行只会产生一次 turn）；
  已经开读了就把新内容另起一段排在后面。这条规则正是用来掐断
  「等待 → 新内容 → 加入队列 → 等待」那个死循环的。
- **超长截断。** 段超过 `maxSegmentChars`（默认 2500 字符）就封存另起一段；积压段数超过
  `maxQueuedSegments`（默认 8）时先尝试**合并**旧段，合不动才丢弃最旧的并记 `member.shed`。
- **房间第一条消息与任何 `@` 立即投递**，其余等 tick。所以正常回复的延迟上限是 `segmentMs`。

> **ACP 成员也走同一条通道。** 旧版需要为它们解释「只能延迟旁听」，现在没有这个例外了：
> 分段投递对 codex 和 ACP 完全一致（ACP 只是不能像 codex 那样被 `steer` 插话，见 `@` 一节）。

**投递给成员的文本逐字格式**（`lib/room.cjs` 的 `_formatRecord`）：

```
[房间广播] 以下是你还没读到的群聊记录，每一行都标了发言人（方括号里是房间时钟）。

[14:02:11] [用户] 大家好
[14:02:13] [@codex] 我是 Codex。
[14:02:40] [你自己 @astra] 我是 Astra。
---
（本轮指令）
```

时间戳是**插件在写入日志时**打上的，不是 agent 产出的。协议层没有位置放它：codex 的
`UserInput` 七种变体（text/image/localImage/audio/localAudio/skill/mention）**都没有 timestamp 字段**，
ACP 的 prompt 内容块也没有。所以只能编进文本，格式 `[HH:MM:SS]`（房间本地时钟）。
被打断未说完的行会额外标 `（未说完就被打断）`。

> 为什么不用 `role: "assistant"` 注入：实测 assistant-role 注入会让模型把这些话当成**自己说的**
> （自称 `SELF`），user-role 才会判为 `OTHER`。codex 线协议把 turn `input` 一律视为 user-role，
> 所以必须靠文本框架标明归属。

**`@` 是公开强调 + 即时投递，不是私密路由。** 整条消息进公共日志，所有人都看得到；`@` 只买两件事：
① **即时性**——不等下一个 tick，立刻投递；② 文本里的**强调**，以及给被点者一句「这一段点到了你」的指令。
支持 `@all` / `@全体` / `@所有人` 展开为全员，成员 id、label、aliases 都可匹配。

**`@` 到正在发言的成员时是「插话」（steer / 抢占）。** 这是 R4：

| 后端 | 手段 | 结果 |
|---|---|---|
| codex | `turn/steer {threadId, expectedTurnId, input}` | 新文本**并入正在跑的那一轮**，不新建 turn |
| ACP | 无 steer 能力 → `session/cancel` + **carryOver 结转** | 取消当前轮，把「被打断那段的原文 + 新文本」作为下一段的开头重发 |

- codex 的 steer **绕过** per-thread 队列直接写帧。走队列就排在它要插话的那一轮之后，与目的相反。
- 竞态：turn 可能在检查与发送之间结束，此时回 `-32600 no active turn to steer`。引擎**不**把它当
  「排队」处理，而是回落成「下一段立即投递」。
- ACP 的抢占必须 carryOver：`_takePending` 已经把那段从缓冲里取走，而 `session/cancel` 是**通知**（无 ack），
  无法确认 agent 是否已读过。重复投递的代价远低于丢失，所以宁可重发。
- agent→agent 的即时 `@` 受 `maxRelayHops`（默认 2）的**级联预算**限制：两个互相 `@` 的 agent 是房间里
  唯一能无人值守烧钱的路径。预算只限制「即时性」，文本早已被 capture，没拿到即时 turn 的成员下一 tick 照样读到。

**弃权是信令，不是发言。** 旁听者若确实无话可说，回复 `(无补充)`；引擎识别到该标记时**不写进公共日志**，
只记账 `silentTurns`。否则这条标记会变成一条真实发言，后面每个 agent 读回去时都会以为它真的说过这句话——
等于往共享记忆里塞了一条伪造发言。

**`replyPolicy` 现在只管「是否要求回答」**，不再决定谁收到（段永远投给所有成员）：

| 值 | 含义 |
|---|---|
| `addressed`（默认） | 被 `@` 者被要求回答；未被点名的成员自由弃权 |
| `everyone` | 要求每个成员都给出观点（仍可用 `(无补充)` 弃权） |
| `mentioned-only` | 未被点名者只旁听，被要求「除非发现严重问题否则回 `(无补充)`」 |

**历史落盘，房间可删。** 每条记录以一行 JSON 追加到 `<roomsDir>/<roomId>.log.jsonl`，
`connect()` 时回放重建 `this.log`；成员的 `cursor` 随名册（`<roomId>.members.json`）一起持久化。
没有 cursor 的话，重启后每个成员会把整个房间**重听并重答**一遍。
「清空本房间」（`/new-conversation`）已下线（返回 410）——要重新开始就删掉房间再建一个。

**工作目录按 harness 分，不按房间分。** `workspaceDirs: { codex: '…', acp: '…' }`，
成员的 cwd 由它自己的 `backend` 查表；未配置的后端回落到 `<DSH_PROFILE_DIR>\agent-room-workspace\<backend>`，
两个目录都会 `mkdirSync -p`（必须：ACP 的 `session/new {cwd}` 要求目录已存在且是绝对路径）。
只从配置读，不做 UI/运行时切换/房间级或成员级覆盖。
后果：同一个 harness 的多个房间**共享目录**、能看见彼此写的文件；改掉 `acp` 的目录会让 ACP 成员
**重开 session**，因为 session 的 cwd 创建后不可改（ACP 没有 `session/set_cwd`，codex 在 `thread/start` 钉死）。

**每个 harness 一个工作区，装下它的全部对话。** 上面那个目录只是「文件放在哪」；用户要的是
**harness 自己的 GUI 里能按工作区分组**，而两家 harness 对「工作区」各有各的叫法：

| harness | 它自己的概念 | 谁来做 | 落点 |
|---|---|---|---|
| codex | **项目**（project） | 引擎：`codex-pool.cjs#syncProject` 走 app-server RPC | codex 桌面左侧项目列表 |
| DSH/ACP | **工作区**（`workspaceRegistry` 的一行） | host 半：`index.js#createSessionFiler` 调 `create` + `attachSession` | DSH 侧边栏按工作区分组 |

两条都是「一个 harness 一个」，名字来自 harness 而不是房间，所以**所有房间的会话都进同一个组**。

codex 侧必须**轮换**，这不是偷懒：`project/import` 是唯一能给 thread 设 `projectId` 的 API，
而它**无法原地增长**——同一个 `idempotencyKey` 重放会直接返回缓存响应、什么都不挂；换个新 key
又会铸造出**第二个同名项目**（`project/update` 根本不收 thread 列表，`thread/start {cwd}` 也不会
按 root 自动归组）。所以每次同步是：读回现有成员 → 求**并集** → 新 key 全量 import → 删掉被替换的旧组。
求并集是关键，否则一个房间会把别的房间的 thread 挤出去。若现有组已经是想要的集合，就直接沿用
（幂等采用），免得每次说话都把项目 id 换一遍、把用户手工排序冲掉。
代价：一旦真的需要轮换，项目 id 会变，用户对该项目做过的**手工归组会丢**。

ACP 侧没有这个麻烦：`session/new` 返回的 id 就是 DSH 的 session id（裸 uuid，逐字相同），
DSH 会先 flush header 再应答，所以拿到 id 就能 `attachSession`。DSH 工作区只认**规范路径**：
session header 的 `cwd` 必须 realpath 后**严格等于**工作区路径，两个半边的目录天然是同一个
`workspaceDirs.acp`。挂不上的（服务不在、目录不可写、session 本 profile 看不见）只写一行日志，
**绝不会让房间起不来**。

`projectName` 可配（默认 `agent-room`，`null` 关闭 codex 归组）：
`config.projectName` → `RoomApi` → `AgentRoom` → `CodexThreadPool`。


## 群友管理

成员不是写死的：可以在 UI 里**实时增删、改模型、改人设**，改动存盘，活过 DSH 重启。

| 位置 | 操作 |
|---|---|
| 成员 chips 行 `[+ 添加成员]` | 展开表单：id / 显示名 / **后端** / 模型 / 人设 |
| 点 chip 上的模型名 | 就地换成下拉框，选完即改（等价于换一个模型重开 thread） |
| hover chip 右上角 `×` | 移出房间 |
| 点 chip 本体 | 往输入框插入 `@id`（`@` 是强调，不是私聊） |

**两条加群友的路，同一个入口。**

1. **再加一个 codex thread** —— 后端选 `codex`（默认）。同一个 codex app-server 里多开一个独立会话，
   可配不同模型与人设。互相之间完全隔离，靠房间日志交流。
2. **接别家 harness** —— 后端选一个 ACP 后端。房间为每个后端名各持有一个 pool，
   按需惰性创建：`{ acp: { agentCommand, agentArgs, env } }`。成员在第一次发言时才拉起进程，
   所以「先加几个看看」是免费的。

改模型的做法是**关掉旧 thread 重开**，不是热改：thread 的模型在 `thread/start` 时固定。
新 thread 没有历史，所以 cursor 归零、下次发言时从日志重新简报——代价是一次冷启动，不是丢失对话。

**模型留空 = 跟着 agent 走。** 表单里的模型下拉框第一项永远是「默认模型（跟着 agent 走）」，
成员 chip 上显示的也是这个。留空不会被替换成任何具体名字，也不会因为「不在目录里」而报错。
这在 ACP 后端是常态（它的目录要等 `session/new` 才知道），在 codex 后端也可以用。

成员表持久化在 **`$DSH_PROFILE_DIR/agent-room-rooms/<roomId>.members.json`**（可用 `roomsDir` 覆盖）。
配置里的 `members` 优先于文件：配置是运维的声明，文件是 UI 累积的状态。

### 把 DeepSeek Harness 自己接进来（已实盘验证）

DSH 出厂就自带一个 ACP **server**（`@deepseek-ai/dsh-acp` + 出厂 profile `acp`），所以「别家 harness」
这条路的第一个真实对端就是它自己。启动方式（桌面版，`dsh` 不在 PATH，入口在 asar 里）：

```js
backends: {
  acp: {
    agentCommand: '<DSH 安装目录>\\DeepSeek Harness.exe',
    agentArgs: [
      '--expose-internals',
      '<DSH 安装目录>\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
      '--profile', 'acp',
      '--patch', '<一个把 provider 指到 deepseek-account 的 patch.yml>',
    ],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    proxy: false,
  },
},
members: [{ id: 'dsh', label: 'DeepSeek Harness', backend: 'acp', model: 'deepseek-v4-flash' }],
```

> 上面两条路径是**本机专属**的，所以仓库里这份 `cordis.patch.yml` 把它们整块注释掉了。
> 想启用就把自己的路径填进去（本仓库的 `cordis.patch.yml` 只是通用默认值；loader 的 patch
> 是**整体替换** `config` 而不是深合并，所以要么整块写在 profile 层
> `$DSH_PROFILE_DIR/cordis.patch.yml`，要么整块写在这里，别只写一半）。

**那个 `--patch` 是必须的。** 出厂 `acp` profile 的 `agent-default-model` 与 `acp` 行都指向
`deepseek-official`（API-key 路由），而桌面版登录的是 `deepseek-account` 账号路由。不 patch 就会
`no API key for provider route "deepseek-official"`。patch 内容只需两行 provider：

```yaml
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-v4-flash
- id: acp
  config:
    provider: deepseek-account
    model: deepseek-v4-flash
```

实测一次真实 turn（`deepseek-v4-flash`）：连接 1.0–1.2s，回答 0.9–2.7s，约 7.8k tokens。
它的会话目录长这样（`session/new` → `configOptions`，模型是 **JSON 字符串对** `["provider","model"]`，
显示名才是人读的模型名——这就是为什么 ACP 目录学得晚，见上文）：

```
model           : deepseek-account/deepseek-v4-flash | deepseek-official/… | deepseek-account/deepseek-v4-pro
reasoning_effort: off | low | high | max
```

注意 `acp` profile 是 **automation-only** 的：没有 `session/load`、没有 transcript 回放、没有 modes/
commands/计划/终端，`authenticate` 直接成功。够当一个群友用。

`proxy: false` 是必需的（见上一节）：DSH 的 ACP profile 拒绝 SOCKS 代理。
另外把 `{ acp: {...} }` 写进配置之后，「+ 添加成员」的后端下拉里就会出现 `acp`，
**不需要先有一个 ACP 成员**——后端是按配置广告的，pool 仍然到有人真的用它才创建。

## 两种模式

| 开关 | CHAT | WORK | 生效层级 |
|---|---|---|---|
| `effort` | `none`（不支持则 `low`） | `high` | turn 级 |
| `sandboxPolicy` | `readOnly` + 禁网 | `dangerFullAccess` | turn 级（可覆盖） |
| `serviceTierForTurn` | `priority` | 不设 | turn 级 |
| 提示词 | 短回答、别用工具 | 允许工具、要交付物 | turn 级 |

CHAT 与 WORK 实测差 20–40 倍（同一任务：`effort=low` 24.5s / `effort=high` 50.8s），一套参数不可能兼顾。
`readOnly` sandbox 是**物理**限制，不是靠 prompt 约束——实测 CHAT 模式下要求建文件返回 `BLOCKED`、文件确实没被创建。

**effort 自动协商（本插件的关键健壮性设计）。** `model/list` 公布的合法 effort 集合与实际能力不符：
它从不为任何模型列出 `none`，但实测 5/7 模型接受 `none`。所以 `codex-pool.cjs` 会在服务端拒绝时
用正则解析错误消息、把真实合法集合记进 `capabilityOverrides`，下次自动选合法档位：

```
Unsupported value: 'none' is not supported with the 'gpt-6-astra' model.
Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.
```

模型能力实测（本机 `prolite` ChatGPT 账号）：
`gpt-6.1-sol`/`gpt-6-astra` 拒绝 `none`；`gpt-6-sol`/`gpt-6-luna`/`gpt-5.6-sol`/`gpt-5.6-terra`/`gpt-5.6-luna` 接受。

## 后端进程死掉之后

codex app-server（或任何 ACP agent）是**外部进程**，随时可能死：崩了、被任务管理器杀了、被别的
清理逻辑当孤儿回收了。池子必须能察觉，否则房间会一边对 UI 报 `connected: true`、一边把每一轮
都写进一根死管子——**看起来完全健康，实际一句话都答不出来**。

`codex-pool.cjs` / `acp-backend.cjs` 在 `exit` 事件里做三件事：把 `alive` 置 false、拒绝所有在途
请求（`codex app-server exited before replying`）、清掉 `ready` 记忆。于是：

- **`snapshot()` 如实反映。** `pid` 取自 `running`，子进程死后 `pid` 变 `null`，不再报一个尸体的 pid；
  `connected` 也会变 false（`room.cjs` 的 `_poolsAlive()` 逐个查 `pool.running`）。
- **下一轮自动重启。** `ensureThread()` 发现 `pool.running === false` 就先 `pool.start()` 再继续，
  不需要用户手动「重连」。
- **历史重放。** 死掉的进程带走了所有 thread，而 thread 的 id 属于死进程，所以池子随死亡一起丢弃
  线程记录。`ensureThread` 于是发现「没有 thread，但这个成员明明已经读过房间」，把 `cursor` 归零并
  重放全部记录——新线程拿到的是一份完整的房间简报，而不是空上下文。
- **正在飞的那一轮不会挂死。** `exit` 直接 reject 掉 pending 里的请求，所以猝死时正在跑的 turn
  立刻以错误结束（`/exited/`），成员转 `status: 'error'` 并记下原因，而不是静默等满 300 秒超时。

`test\backend-death.cjs` 用 `test\stub-app-server.cjs`（一个假的 codex app-server，**零额度**）
把这条路径钉住了：detect / recover / inflight / repeat 四个场景，其中一个专门验证「连续死两次都能恢复且不漏进程」。

## codex 的对话存在哪里

房间**不额外存一份 codex 对话**——它落在 codex 自己的目录里，两处：

| 位置 | 内容 |
|---|---|
| `%USERPROFILE%\.codex\sessions\<年>\<月>\<日>\rollout-<时间>-<threadId>.jsonl` | 该 thread 的**完整逐条记录**（`environment_context`、注入的房间广播、模型回复），一行一个 JSON 对象 |
| `%USERPROFILE%\.codex\sqlite\codex-dev.db`（+ `-wal`/`-shm`，另有 `codex-thread-summaries-dev.db`） | thread 目录与元数据（标题、时间、`archived` 位、rollout 路径、token 计数） |

**一个 thread 一个 rollout 文件**，文件名里带着 thread id，所以磁盘上的文件数就是「这个成员总共开过几个
thread」。这是排查「设计 B 的常驻 thread 到底有没有复用」最直接的证据——也正因如此才抓到了下面这个缺陷。

## 缺陷记录：thread 每轮被重建（已修）

**症状（实盘）**：房间里 codex 明明收到了消息、状态也正常，但**看起来像没说话**；同时每条消息都
**冷启动 4–7s**，磁盘上**一条消息一个 rollout 文件**。

**根因（类型学）**：`thread/start` 请求里 `sandbox` 是 `SandboxMode` **字符串**，响应里 codex 回显的
`sandbox` 却是 `SandboxPolicy` **对象**（`{type:'readOnly',networkAccess:false}`）。池子把这个回显**原样**
记进了线程记录，而 `room.cjs#ensureThread` 的复用判断是 `existing.sandbox === sandbox`——
**对象永远不等于字符串**，于是每一轮都判定「沙箱变了」，关掉旧 thread、开新 thread，并把 `cursor` 归零重放全部记录。

**后果**：设计 B 的「常驻 thread」实际退化成了「每条消息新开 thread」——每轮冷启动、ChatGPT 侧不留同一个
会话、新 rollout 文件一个比一个多，而且**实时旁听的 `inject_items` 全推进了一个马上要被丢掉的 thread**。
它之所以还能连贯回答，纯粹是因为 `cursor` 归零后每轮都把整个房间记录重放了一遍（用 token 换来的假象）。

**修复**：`codex-pool.cjs` 新增 `sandboxModeOf(value, fallback)`，接受字符串或 `SandboxPolicy` 对象并
**统一归一化成 mode 字符串**（`{type:'readOnly'}` → `'read-only'`），`openThread` 记录归一化后的值；
开新 thread 时把 `started.sandbox` 传进去，`options.sandbox` 作兜底。回归钉子见 `test\thread-reuse.cjs`。

**为什么原来的测试没抓到**：`test\stub-app-server.cjs` 回显的是 `sandbox:'read-only'`（字符串），
**假服务器和客户端的 bug 说法一致**，于是测试全绿。stub 现在照真实形状回显对象，四个场景同时钉住
「unit 归一化 / pool 记录的是字符串 / room 两轮复用同一 thread 且不重播 / 真换模式时仍然重建并重放」。

> **教训**：测试替身必须复刻真实对端的**类型形状**，不只是字段名。一个回显类型与真服务器不同的 stub，
> 会让一整类「对象 vs 字符串」的比较 bug 永久隐形。同类坑：`pool.pid` 不能用 `=== null` 判活
> （`stop()` 不清理 `child` 引用），正确判活是 `process.kill(pid, 0)` 抛不抛错。

## 缺陷记录：房间进程泄漏（已修）

**症状（实盘）**：任务管理器里躺着 **10 个 `codex.exe app-server --listen stdio://`**，父子关系全部指向
DSH 主进程；每个只占 40MB 左右、什么都不做，也永远不会退出。它们来自 `leadprobe` 这类**一次性房间 id**。

**根因**：`RoomApi.ensure(roomId)` 对任何没见过的 id 都**建房间并立刻 `connect()`**，而 `connect()` 会
`pool.start()`——**spawn 一个 codex app-server**。房间只存在 `this.rooms` 这个 Map 里，**没有任何回收**：
没有 TTL、没有上限，唯一的清理路径是 `dispose()`，而它只在插件卸载时跑。于是**任何一个被访问过一次的房间 id
都会永久留下一个 codex 进程**——包括探针 id、拼错的 id、以及每个新 DSH 会话（tab 拿 `sessionId` 当房间名）。

**更深一层**：旧版 tab 直接拿 DSH `sessionId` 当房间名，所以**每换一个 DSH 会话就是一个新房间 → 新进程**。
泄漏速度近似「用户开过多少个会话」。（R1 已把这条路径改掉：房间现在自己铸 id，且 tab 记住上次打开的那一个。）

**修复**（`server.cjs`）：

- **空闲回收**。`roomMeta` 记录每个房间的 `lastUsed`；每 60s（`sweepIntervalMs`）跑一次 `sweepIdle()`，
  回收 `lastUsed` 超过 `idleRoomTtlMs`（默认 **30 分钟**）的房间，走 `closeRoom()` → `room.dispose()`
  → 停掉该房间的**所有** pool。定时器 `unref()`，不会拖住进程退出。
- **读即续命**。每次 `ensure()` 命中已有房间都刷新 `lastUsed`，所以 UI 每秒轮询 `/state` 的房间永远不会过期；
  浏览器 EventSource 断线会自行重连，重连即续命。
- **两条安全线**。`closeRoom()` 拒绝回收**有成员在跑 turn**（`snapshot().busy` 非空）或**挂着 SSE 流**
  （`subscribers > 0`）的房间——把 pool 从正在跑的 turn 底下抽走，会让调用方等一个永远不会来的回包。
  回收器撞上就跳过，下一轮再试；`?force=1` / `{force:true}` 是显式逃生口。
- **软上限**。`maxRooms`（默认 16）满了以后，`_reclaimForCapacity()` 只回收**已经过期**的房间；如果
  没有过期的就照建不误并记一行日志。**硬上限是错的**：正在用的房间不是泄漏，被硬上限踢掉会连同日志和
  thread 一起丢掉，而空闲房间才是唯一真正该收的东西。
- **可观测**。`GET /rooms` 报出 `{rooms, roomCount, idleRoomTtlMs, maxRooms}`——否则唯一的排查手段
  就是去任务管理器数 `codex.exe`（这正是发现这个缺陷的方式）。`POST /close-room` 按需立即回收。
- **可关闭**。`idleRoomTtlMs: 0` 完全关掉回收：既不起定时器，也不回收，**软上限也一并失效**——
  上限只是回收的第二种触发方式，既然部署方说了「房间都留着」，就不该在容量上偷偷丢掉一个。

**回归钉子**：`test\room-lifecycle.cjs`，11 段、零额度（stub 引擎、注入时钟，不用等 30 分钟）。

**已知代价（R1 后已大部分解决）**：回收仍然是「把进程和内存态收掉」，但**日志现在落盘了**，
所以被回收的房间下次被打开时会**回放出完整历史**（成员的 `cursor` 也随名册恢复，不会重听重答）。
仍然失效的是**成员的 thread 上下文**（codex thread / ACP session 都活在进程里）——重新打开后
每个成员是在「刚读完这段历史」的状态下继续，而不是保留原来的推理过程。这仍是「thread 是进程内的」
这条设计选择的直接后果，不是回收引入的。
真正的房间（用户正盯着的那个）有轮询和 SSE 续命，回收不到它。

## 依赖的外部条件

- **codex CLI 已安装并已登录**。插件直接 spawn 原生二进制（绕开 node shim）：
  `…\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`。
- **必须能出网，且本机需要代理**。实测本机直连 `api.openai.com`/`chatgpt.com` 全部超时，
  而本地 SOCKS5 `127.0.0.1:10808` 可达。DSH 宿主进程的环境里**没有任何代理变量**，
  所以插件自己注入 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`（默认 `socks5h://127.0.0.1:10808`，
  用 `AGENT_ROOM_PROXY` 覆盖），同时**删除所有 `DSH_*` 变量**避免泄漏进子进程。
  ACP 后端的子进程默认同样走这套环境，但**可以关掉**：`backends.acp.proxy: false`。
  这条对 DSH 自己是必须的——它的 ACP profile 明确不支持 SOCKS，每次启动会打三条
  `all_proxy names a SOCKS proxy, which is not supported` 警告。codex 之所以需要这个代理，
  是因为本机直连 OpenAI 超时；别家 agent 多半直连即可。
- `~/.codex/config.toml` 里的默认模型可能是失效的（本机曾是 `gpt-6.1-sol`），插件**总是显式传 model**。
- `OPENAI_BASE_URL` / `OPENAI_API_KEY` 在 ChatGPT 鉴权路径上**被 codex 忽略**，不要指望用它们改路由。

## HTTP 接口（供 tab 与测试使用）

所有路径挂在 `/agent-room` 前缀下（可配置）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/`、`/index.html` | 独立页面（与 tab 渲染同一份 UI） |
| GET | `/app.js` | 共享 UI 单文件 bundle |
| GET | `/state?room=` | 房间快照（成员/日志/模式/连接状态） |
| GET | `/events?room=` | SSE 流：`snapshot`/`message`/`stream` 事件 |
| GET | `/models?room=` | 各后端的可用模型（带 backend 标签）+ 成员映射 |
| POST | `/say` | `{room,text}` → `{ok,entry,delivered}`（`delivered` = 本轮真正被服务的成员，每项 `{memberId, record?}`；`record` 缺席 = 该成员没产出回复） |
| POST | `/mode` | `{room,mode}` → `{ok,mode}` |
| POST | `/policy` | `{room,policy}` → `{ok,replyPolicy}` |
| POST | `/members` | `{room,id,label?,model?,persona?,backend?}` → 加一个群友 |
| POST | `/member` | `{room,id,model?,persona?,label?}` → 改（可只传要改的字段） |
| POST | `/remove-member` | `{room,id}` → 移出房间（先打断在跑的 turn） |
| POST | `/new-room` | `{title?}` → 造一个新房间 id（形状 `room-<base36 时间>-<4 随机>`，**永不复用 DSH 会话 id**） |
| POST | `/delete-room` | `{room,force?}` → 回收进程**并删掉** `<room>.log.jsonl` 与 `<room>.members.json` |
| POST | `/new-conversation` | **已下线，返回 410**；要重新开始就删房间再建 |
| POST | `/interrupt` | 中止当前所有进行中的 turn |
| GET | `/rooms` | 活跃房间列表 + 回收配置（`idleRoomTtlMs`/`maxRooms`）+ `details`（每房间 `id`/`title`/`members`/`logFile`） |
| POST | `/close-room` | `{room,force?}` → 立即回收该房间（停进程，**保留文件**）；`force` 越过「在跑/有流」保护 |
| POST | `/attach?name=&type=` | **裸字节**上传（不是 JSON）→ `{attachment:{id,name,bytes,isImage}}`。**响应里没有路径** |
| GET | `/attachment/<id>` | 取回附件字节（`nosniff`；只按 id 取，不接受路径） |
| GET | `/theme` | 当前主题 + 预设表 → `{theme,presets}` |
| POST | `/theme` | `{theme:{colors?,background?,veil?,preset?}}` → 规范化后的`{theme}` |
| POST | `/theme/background?type=` | **裸字节**背景图（上限 16 MB）→ `{theme}` |
| GET | `/background` | 当前背景图字节（没有则 404） |

### 上传与主题（本轮新增）

**上传为什么不能复用 DSH 输入框**：DSH 的上传回执只有 `{receiptId, attachmentId, name, bytes}`，
**没有客户端可见的文件路径**；而 `ctx.attachments.imageHostPath` 只对同进程的可信消费者开放。
房间里的成员要的是**真实路径**（codex 的 `localImage.path`；ACP 只吃纯文本），
所以路径必须在宿主侧解析，浏览器**只拿 id、只发 id**：

```
浏览器 --裸字节--> POST /attach --> 落盘 <profile>/agent-room-files/<id>.<ext>
                                        |
房间发言 --{attachments:[id]}--> 宿主 _resolveAttachments --> 真实绝对路径 --> codex localImage
```

`name` 只是元数据：落盘用的是**生成的 id + 白名单扩展名**，所以 `../../x.png` 这类名字
既不能穿越目录，也不能决定扩展名。`_publicAttachment`/`_publicRecord`/`_publicSnapshot`
在每一个面向浏览器的出口剥掉 `path`（`test\attachments.cjs` 有断言）。

**主题的两个入口，一个存储**：房间面板里的「外观」和「设置 → 通用 → Agent 群聊外观」
是两份独立挂载，靠一个 window `CustomEvent('agent-room:theme')` 互相通知（两边字符串必须一致）。
真正可写的只有 `--ar-*` 这 7 个房间自己的变量；`--dsw-alias-*` 是**全局**主题，房间不许改，
宿主侧直接拒（自定义属性就是活 CSS，`red;}html{...}` 这种值能注入任意样式，
所以在宿主侧按严格白名单语法校验，见 `lib/theme.cjs`）。

背景图落盘在 `<profile>/agent-room-theme/assets/`，由 `/background` 提供，UI 用 `::before` 铺底、
`::after` 用 `--ar-veil` 压一层遮罩，所以深色面板上也能看清字。

**能力位 `uploads`**：`/state` 会带 `uploads:{enabled,maxBytes,maxLabel}`。
宿主可以用 `filesDir: null` 完全关掉上传（没有可写的目录），这时 UI **在打开选择框之前**
就禁用 `＋` 并说明原因（`button.title`），拖放与粘贴也各自再挡一次——因为「没有目录」不是
一个用户能自己解决的问题，让他选完文件再收到报错只是浪费他的操作。老宿主不带这个键时
按可用处理（`enabled !== false`），所以缺字段不会把上传误关掉。
`test\attachments.cjs` 用真 `RoomApi`（`filesDir: null`）断言 `enabled === false` 且 `POST /attach` 返回 400。

**返回类型不由客户端决定**：`/attach` 会把浏览器自报的 `type` 连同文件一起存下来，
那只是给 chip 显示用的元数据。**真正发回去的 `content-type` 走 `serveMediaType`**，
只放行惰性类型（位图 + `text/plain`），其余一律 `application/octet-stream`。
原因是这个路由与 harness **同源**：曾经传一个 `.html`、`type` 报 `text/html`，
就会被当作 HTML 文档 `inline` 返回，脚本在 harness 自己的 origin 上执行（Chromium 实测通过）。
`nosniff` 挡不住这种情况——它只阻止浏览器*猜*类型，不阻止照**声明的**类型渲染。
背景图那侧另有一层：SVG 必须以 `image/svg+xml` 返回才画得出，但直接打开就是可执行文档，
所以 `/background` 带 `INERT_IMAGE_HEADERS`（含 `sandbox`），脚本不执行而背景照常绘制。

`/close-room` 与 `/delete-room` 的区别就是**文件保不保留**：前者只是把进程和内存态收掉，下次打开接着读日志；
后者连日志与名册一起删掉，房间真的没了。

SSE 不被 gzip（宿主对 `text/event-stream` 主动跳过压缩），每 20s 发 `: ping` 保活。

> **测试注意**：PowerShell 的 `Invoke-WebRequest -Body` 会把中文变成 `?`。
> 发中文请用 `test\http-smoke.cjs` / `test\e2e-dsh.cjs` 这类 Node 客户端。

## 文件结构

```
lib\
  index.js       host 入口：注册 webServer prefix 路由 + 装配 RoomApi + roster/files/theme 目录
  client.js      客户端 bundle：注册右栏 tab 类型 + tab 本体 + 「设置 → 通用」的外观行
  server.cjs     HTTP/SSE 层（RoomApi）：状态、发言、上传、附件回取、主题
  room.cjs       房间引擎：公共日志、分段投递、@ 即时投递与抢占、模式、成员管理
  attachments.cjs 附件仓库：落盘（生成 id + 白名单扩展名）、按 id 取回、按 id 回真实路径
  theme.cjs      主题仓库：预设、颜色白名单校验（挡住 CSS 注入）、背景图文件、遮罩
  codex-pool.cjs codex app-server 池：常驻 thread、流式、effort 协商、turn/steer、buildInput
  acp-backend.cjs ACP 后端池：与 codex pool 同方法面，接别家 harness（**纯文本，不吃附件**）
public\
  index.html     独立页面
  room-ui.js     共享 UI（framework-free，两边都用这一份）：日志、成员、上传托盘、外观面板
test\
  engine-smoke.cjs       引擎离线冒烟
  http-smoke.cjs         真实 UTF-8 端到端（含 SSE 帧解析）
  e2e-dsh.cjs            对着**实盘 DSH** 跑（需插件已安装）
  client-bundle-smoke.cjs  用 vm 桩载 client.js 并驱动 apply()
  theme-row.cjs          用自带 React 桩驱动 client.js 的外观行：注册、首绘、预设/取色/背景/遮罩
  host-entry.cjs         用桩 ctx 驱动 lib/index.js：路由、静态资源、目录、上传/主题/附件路由、dispose
  encoding.cjs           全树必须是严格 UTF-8（防 GBK 往返把中文写坏）
  theme-store.cjs        主题校验：注入门、越权 token、预设、遮罩范围、背景 URL 规则、损坏文件
                         背景 URL 的「引号逃逸」单列一组（`/a");}html{display:none}/*` 之类）：
                         UI 拼的是 `url("<值>")`，能让引号提前闭合的值就是任意 CSS。
                         背景 ext 也在这里按白名单收敛（全文唯一来自网络又命名文件的字段）
  attachments.cjs        附件契约：命名/落盘/回取；并驱动真 RoomApi 验「路径不外泄」
                         与「返回类型不由客户端决定」（html/svg/xml/js 一律降级为下载）
  codex-input.cjs        buildInput：文字在前、图片走 localImage、非图片只给文字（对真 schema 校验）
  member-api.cjs         HTTP 成员管理契约（真 socket + 桩引擎）
  member-management.cjs  引擎侧增删改/persist/校验
  room-lifecycle.cjs     房间回收：空闲 TTL、读即续命、安全线、软上限、/rooms、/close-room
  room-registry.cjs      多房间注册表：/new-room、/delete-room、/new-conversation 410、文件去留
  segments.cjs           R3 分段投递 + R4 抢占：合并、截断、排队上限、steer、carryOver、stall 兜底
  session-filing.cjs     会话归档：codex 项目轮换/并集/幂等采用，ACP 工作区 create+attachSession
  steer.cjs              codex pool 的 turn/steer 原语（含「绕过队列」与「文字真到达」）
                         并用 stub 录下的原始 input 断言图片真的以 localImage 上了线
  thread-reuse.cjs       同一模式下的 thread 必须被复用（sandbox 归一化的回归钉子）
  realtime-overhear.cjs  分段投递取代逐条旁听：capture 只记账、_tick 才投、@ 即时
  prewarm.cjs            成员 thread 预热（含 prewarm:false）
  backend-death.cjs      后端进程猝死后：如实报告、自动重启、重放历史、不卡死
  stub-app-server.cjs    假 codex app-server（零额度复现「子进程死掉」的回归钉子）
  acp-backend-smoke.cjs  ACP 池本身：协议、会话、增量、取消、flush、回收
  acp-fixture.cjs        最小 ACP **agent** 端（stdio NDJSON），供上面两个测试当对端
  acp-room.cjs           ACP 成员放进真房间：分段投递不丢消息、生命周期、dispose
  ui-members.cjs         成员管理 UI + 房间切换器：用自带 DOM 桩驱动 room-ui.js（无 jsdom 依赖）
  ui-attachments.cjs     上传/拖放/粘贴 UI：选文件、托盘、只发 id 不发路径、失败不丢文件、能力位
  dom-shim.cjs           上面两个 UI 测试共用的最小 DOM 桩（含事件监听与 contains）
  no-addendum.cjs / silent-turn.cjs  弃权标记的识别与不落日志
  serve.cjs              独立 node:http 服务（不开 DSH 也能看 UI）
  serve-nofiles.cjs      同上但 `filesDir: null`：用来看「宿主关掉上传」时 UI 是否正确禁用
  run-all.cjs            一次跑完所有离线测试（--online 加上真 codex/DSH）
  probe-boot.cjs         探测宿主是否把 client bundle 编入 boot graph
  probe-models.cjs / probe-effort.cjs  模型与 effort 能力实测
  probe-group-live.cjs   对着**真 codex** 只跑本地 RPC 验项目归组（不跑 turn，零额度）
                       `--apply` 才写；不带参数是 dry run
```


## 安装

```powershell
# 通过插件管理器安装（不要手写 profile 的 package.json / cordis.patch.yml）
plugin_manager(action: "install_bundle", target: "<本目录绝对路径>")
```

`cordis.patch.yml` 里的 row `name` 必须与本包 `package.json` 的 `name` **逐字相同**——
宿主用 `nearestPackage` 比对，任何不匹配（包括 bare vs scoped）会**静默丢弃 client bundle，无错误无日志**。

安装后：
- **host 半立即生效**（HTTP 路由可用，可编程驱动房间）；
- **client 半**：新装的 bundle 会进入 boot graph（页面里的 boot 载荷会引用带 `&rev=` 的
  `/plugins/...` 资源；该 URL 带 rev，不能手写一个固定地址去探）。已打开的页面若仍看不到 tab，
  **刷新一次页面**。

> **改 host 侧代码（`lib/room.cjs`、`codex-pool.cjs`、`acp-backend.cjs`、`server.cjs`、`index.js`）必须重启 DSH。**
> 实测只改文件 mtime **不会**热重载 host 插件。`public/room-ui.js` 与 `lib/client.js` 是客户端资源，
> 刷新页面即可拿到新版本。

**怎么确认重启后新代码真的生效了**——老版本的 `/state` 里没有这些字段，所以一条命令就能分辨：

```powershell
$s = (Invoke-RestMethod 'http://127.0.0.1:19387/agent-room/state?room=x').snapshot
$s | Select-Object segmentMs, maxSegmentChars, logFile, workspaceDirs
$s.members | Select-Object id, queued, segmentsSent, steered
```

本轮的「上传 + 主题」也有同样的一眼分辨法（老版本这两个路由直接 404）：

```powershell
# 上传与主题是本次新增的：老版本这里会 404 / 没有 theme、themePresets、uploads 三个键
Invoke-RestMethod 'http://127.0.0.1:19387/agent-room/state?room=x' |
  Select-Object -ExpandProperty snapshot |
  Select-Object theme, themePresets, uploads
Invoke-RestMethod 'http://127.0.0.1:19387/agent-room/theme' | Select-Object presets
```

> **为什么必须重启而不是刷新**：`lib/index.js` 在 apply 时就把 `public\*.js` 读成字符串、
> 把路由注册进 webServer，之后不再读盘；`dsh-base` 的 HMR 只盯 profile 的
> `package.json`/`cordis.patch.yml`（`config.root: []`，module root 是 opt-in），
> 所以 **host 侧代码改了只改 mtime 是不生效的**。client bundle 也按 revision
> 缓存在内存里（URL 带 `&rev=`，rev 由文件 mtime/ctime/size 决定），同样要重启。
> 判断当前跑的是哪一版：`/agent-room/app.js` 的字节数（新版约 66 KB，旧版约 35 KB），
> 或者 `/agent-room/theme` 是不是 404。

新版本输出 `segmentMs=30000  maxSegmentChars=2500`，`logFile` 指向 `<profile>\agent-room-rooms\x.log.jsonl`，
`workspaceDirs` 有 `codex`/`acp` 两项；成员对象里有 `queued`/`segmentsSent`/`steered`。
若这些键全为空（`realtimeOverhear` 反而有值），说明进程还跑着旧代码，需要重启。

**工作区归组**（零额度：只走本地 RPC，不跑 turn）：

```powershell
node test\probe-group-live.cjs           # dry run：只报告现状与将要做的轮换
node test\probe-group-live.cjs --apply   # 真的调 pool.syncProject()
```

输出形如 `ROOM THREADS 5` / `ASSIGNED 5 of 5` / `syncProject -> 01a13e36-…` /
`THREADS IN GROUP 5 of 5`。若现有组已是想要的集合，`syncProject` 会**返回同一个 id**（幂等采用）。


## 已验证的行为（`test\e2e-dsh.cjs`，对着实盘 DSH）

> 下面的输出块是**最后一次实盘运行**留下的记录（R3 改写之前）。R3 之后这个脚本的断言已改为：
> `/new-conversation` 必须回答 **410 且不动日志**、`segmentMs > 0`、至少一个成员手上持有未读段、
> `/state` 必须报出 `logFile` 与 `workspaceDirs.codex`。**它跑一次真 codex，会花额度，
> 所以默认套件不跑它**（`--online` 才跑）。语义部分（`@` 只即时服务被点名者、无 `@` 进队列等 tick、
> agent 能读到别人的行并正确归属）没有变。

```
room     : e2e | connected: true
members  : @codex(gpt-5.6-sol) @astra(gpt-6-astra) @terra(gpt-5.6-terra)

@astra   -> delivered: ["astra"]            ← @ 只即时服务被点名者
            text: 收到
broadcast -> queued: astra=1 codex=1 terra=1   ← 无 @ 时进队列，等下一个 tick
tick     -> delivered: ["codex","astra","terra"]  ← 一次 tick 把段交给所有空闲成员
log authors: ["system","user","astra","user","codex","astra","terra"]
cross-read -> Codex、Terra、用户              ← agent 能读到别人的行并正确归属
mode -> chat
models -> 7 available; codex=ok astra=ok terra=ok
add member -> e2e7f2k codex gpt-5.6-sol
re-model  -> gpt-5.6-terra
remove    -> e2e7f2k | removed member woken by @: 0
problems: none
```

**全新房间的第一条消息**（`test\e2e-prewarm.cjs`，真 codex，这是预热修复的实证）：

```
room    : warmtik32p | connected: true
members : @codex @astra @terra
warm threads before any message: 3/3 | codex:warm astra:warm terra:warm
first message -> @codex | delivered: ["codex"]
queued  : codex=0 astra=1 terra=1      ← 旁听者的段已 capture，等 tick
after tick -> astra=0 terra=0          ← 两段都投出去了，一行不丢
recall -> "@codex"
problems: none
```

`astra` 与 `terra` 从没发过言，却在第一条消息之后各自拿到一个含那行的段；被问起
「上一条是点名给谁的」时直接答出 `@codex`——**分段投递确实把别人的行交到了它们的上下文里**。

### 离线测试（不需要 DSH、不需要网络）

一次跑完全部：

```powershell
node test\run-all.cjs            # 23 个测试，完全不碰 codex
node test\run-all.cjs --online   # 再加上真 codex 与实盘 DSH 的测试（会花额度）
```

```
PASS  encoding.cjs                   40ms  none
PASS  no-addendum.cjs                39ms  none
PASS  silent-turn.cjs                75ms  none
PASS  client-bundle-smoke.cjs        45ms  none
PASS  realtime-overhear.cjs        1879ms  none
PASS  prewarm.cjs                    67ms  none
PASS  thread-reuse.cjs              142ms  none
PASS  backend-death.cjs             596ms  none
PASS  member-management.cjs          88ms  none
PASS  member-api.cjs                152ms  none
PASS  room-lifecycle.cjs            110ms  none
PASS  room-registry.cjs             170ms  none
PASS  session-filing.cjs            311ms  none
PASS  segments.cjs                 2256ms  none
PASS  steer.cjs                    5414ms  none
PASS  host-entry.cjs                115ms  none
PASS  ui-members.cjs                 61ms  none
PASS  ui-attachments.cjs            226ms  none
PASS  theme-store.cjs                44ms  none
PASS  theme-row.cjs                  41ms  none
PASS  attachments.cjs                69ms  none
PASS  codex-input.cjs                38ms  none
PASS  acp-backend-smoke.cjs        1033ms  none
PASS  acp-room.cjs                 8876ms  none

24/24 passed in 21.6s (offline; add --online for codex/DSH tests)
```

> **默认套件零 codex 消耗。** 每个会 spawn codex 的测试都花钱，所以它们只在 `--online` 下跑。
> `engine-smoke.cjs` 曾经错放在离线列表里，每次默认运行都静默烧掉两个 codex thread——这是个错误，
> 现在它在 `--online` 里。`acp-*` 测试用的是本地 fixture 脚本，永远免费。

逐个说明：

```
test\ui-attachments.cjs    上传 UI（room-ui.js，共用 test\dom-shim.cjs）
                           ＋ 打开 picker；change 事件把原始字节 POST 到 /attach
                           名称/类型在 query 里，body 就是字节本身
                           托盘：一文件一 chip，只有图片有缩略图，× 撤下
                           发送只发 **id**，断言消息体里绝不出现盘符路径
                           只有附件、没有文字的消息也允许发送（与服务端同一条规则）
                           发送失败/上传失败都不丢已选文件，且错误点名到具体文件
                           dragover 必须被 preventDefault（否则浏览器会跳走）
                           粘贴图片会上传；只带文字的粘贴不吞
                           host 说 uploads 关闭时，**在打开 picker 之前**就禁用并说明原因
                           主题同步：房间侧订阅 agent-room:theme，收到就重读并**重绘**
                           自己保存时发事件（否则开着的设置行会一直显示旧色板）
                           destroy 时退订（否则每次切 tab 都漏一个订阅）
                           problems: none

test\segments.cjs          R3 分段投递 + R4 抢占（本插件最核心的测试）
                           capture 只记账，不产生 turn
                           first/@ 即时投递，其余等 tick
                           合并规则：上一段没开读就并入，开读了就另起
                           maxSegmentChars 截断成多段，一 tick 每成员只交一段
                           maxQueuedSegments 靠合并而非丢弃限长
                           附件一路带到 pool.runTurn（含合并/限长两条路径都不丢）——
                           这条链断了 codex 就收不到 localImage，而此前没有任何测试看得见
                           @ 到忙的 codex：pool.steer，绕过队列，无幻影回复
                           @ 到忙的 ACP：interrupt + carryOver 结转，用后即清
                           stall 兜底：只 interrupt 一次，第二次释放队列并 requeue
                           problems: none

test\steer.cjs             codex `turn/steer` 原语
                           no-thread / no-active-turn / not-running 分类
                           飞行中 steer 成功，且文字**真的到达**（桩把它折进回复）
                           turn 结束后 steer → no-active-turn
                           steer **绕过** per-thread 队列（墙钟证据）
                           supportsSteer / hasActiveTurn 生命周期
                           附件以 localImage **真的上了线**（stub 录原始 input）
                           problems: none

test\room-registry.cjs     多房间注册表
                           /new-room 铸新 id，永不复用 DSH 会话 id
                           /new-conversation → 410，且不创建房间
                           /close-room 保留文件 vs /delete-room 连文件删掉
                           /rooms 的 details 带 title/members/logFile
                           畸形 body 干净 500，服务器存活
                           problems: none

test\host-entry.cjs        apply()      one prefix route + one teardown effect
                           rosters      under DSH_PROFILE_DIR/agent-room-rooms
                           GET index    html, served with the prefix stripped
                           GET app.js   the real UI bundle, member management included
                           unknown path agent-room's own 404
                           dispose      route unregistered
                           problems: none

test\member-api.cjs        roster + per-backend model catalogue
                           add, duplicate rejected
                           model + persona + label, partial edits safe
                           remove, double-remove rejected
                           malformed body → 500 with a message, server survives
                           two rooms, two rosters
                           problems: none

test\member-management.cjs add / backends(2 pools, 3 models) / re-model(cursor rewound)
                           remove(gone from routing) / validate(blank,dup,spaced refused)
                           roster(restored, config-over-file, corrupt survived) / dispose
                           problems: none

test\realtime-overhear.cjs 分段投递：append 只记账，进每个非作者的 segments
                           segmentMs:0 下非首条非 @ 消息不自动投递，_tick() 才投
                           `@` 立即投递且只给被点名者
                           `@` 打到忙成员时走 steer / preempt 分支
                           正向不变量：逐条 push 通道确实没被使用
                           problems: none

test\prewarm.cjs           每个成员在第一条消息之前就有 thread
                           prewarm:false 退回惰性开线程
                           不能注入的后端（ACP）跳过预热，按需开 session
                           个别成员预热失败不拖垮房间
                           运行时新增的成员下一条消息就能听到
                           problems: none

test\acp-backend-smoke.cjs ACP 池本身：38 项（初始化、会话、流式增量、跨轮记忆、
                           取消、无注入、代理可关、关闭重开、flush 顺序、进程回收）
                           problems: none

test\backend-death.cjs      后端进程猝死后：如实报告、自动重启、重放历史、不卡死
                            detect: 死掉的 child 不再被报成活的连接
                            recover: 房间自动重启并重放全部历史
                            delivery: 猝死时正在飞的那一轮立即失败而不挂死
                            repeat: 连续两次猝死都能恢复且不漏进程
                            problems: none

test\acp-room.cjs          房间跑在 acp 主后端上：模型目录带 backend 标签
                           delivery: ACP 成员与 codex 走同一条分段通道，一行不丢
                           isolation: 每个成员各自 session，复用不冷启动
                           lifecycle: 加 / 删 / 换模型在 ACP 成员上都成立
                           catalogue: session-only 目录学到后不重贴成员标签
                           blank: 留空模型保持 agent 默认，不套用 codex 的名字
                           safety: 删除正在发言的成员不会把房间卡住
                           preempt: @ 到忙的 ACP 成员 → 取消 + carryOver 结转
                           attach: 附件**路径**真的进了纯文本 ACP prompt，图片/文件分别标注
                           （靠 fixture 的 RECALL 把收到的 prompt 原样回显来证明，不是推断）
                           teardown: dispose 真的杀掉 agent 进程
                           problems: none

test\no-addendum.cjs       10 accepted markers, 5 rejected look-alikes
test\silent-turn.cjs       both-decline posted: 0 | real-content posted: 1
test\ui-members.cjs        roster: chips render, model + remove are separate controls
                           mention: clicking a chip inserts @id, does not open an editor
                           add form: built from GET /models, backend switch re-points models
                           add submit: POST /members with id/model/persona/backend
                           re-model: click model -> select -> POST /member, no leak
                           remove: confirm-gated POST /remove-member
                           honesty: a model the catalogue lacks is shown, or refused plainly
                           problems: none
test\client-bundle-smoke.cjs  vm 桩载 client.js：tab 类型 + tab 本体两个 slot 注册
test\room-lifecycle.cjs      distinct ids -> distinct rooms, same id reused
                             idle sweep: stale rooms reaped and disposed, warm kept
                             touch: a read re-touches, so a watched room never expires
                             safety: busy rooms and streamed rooms survive, force overrides
                             soft cap: reclaims stale rooms, never evicts in-use ones
                             ttl=0 disables reaping and the cap, no timer
                             dispose stops the timer, clears rooms + bookkeeping
                             http: /rooms + /close-room, unknown room is a clean no-op
test\http-smoke.cjs        真实 UTF-8 + 真 codex + SSE 帧解析
test\e2e-prewarm.cjs       真 codex：全新房间第一条消息后，没人 @ 的成员也拿到含那行的段
```

在线测试需要一个活的房间服务（`node test\serve.cjs 8796`），或直接对着实盘 DSH（`http://127.0.0.1:19387/agent-room`）。

`test\serve.cjs` 与 `test\serve-nofiles.cjs` 的数据默认落在 **`%TEMP%\agent-room-standalone\`**，
**不在插件目录里**。这一条曾经是反的：两个脚本都把 `roomsDir` 默认成 `<package>/.rooms`，
而 `lib/index.js` 是从 rooms 目录的**父目录**推出上传与主题目录的，于是每次手工探测都会往插件源码树里
丢 `agent-room-files/`（真上传的文件）和 `agent-room-theme/`（`theme.json` + 背景图）——
实测积了 9 个上传文件和一张跑偏的 SVG 背景。它们不是源码也不是依赖，却躺在交付物里。
需要复用时显式给 `AGENT_ROOM_DIR` 指定同一个目录即可。回归钉子在 `test\attachments.cjs`：
既按源码断言两个脚本的默认值不指向 `__dirname/..`，也断言当前包内**没有**这三个目录残留。

## 已知限制

- **公共日志落盘了，但成员的 thread 仍活在进程里。** 每条记录追加进 `<roomsDir>/<roomId>.log.jsonl`，
  `connect()` 会回放重建，所以**历史不会丢**；但 codex thread / ACP session 的上下文本身
  **活不过 DSH 重启**——重启后成员从「刚读完的历史」重新开始，读位置由名册里的 `cursor` 决定。
- **正常回复最多等 `segmentMs`（默认 30 秒）。** 只有房间第一条消息和被 `@` 的消息是即时的，
  其余都要等下一个 tick。这是 R3 定案换来的代价：它买到了「连打三行只产生一次 turn」和
  「忙时排队不丢消息」，但也意味着**不点名的提问会沉默最多 30 秒**。
- **分段意味着一个成员可能连续回答多次。** 一段超 `maxSegmentChars`（默认 2500）会被切成多段，
  每段都是一次独立 turn，所以 agent 可能对同一话题分几次作答——这是按字符截断的定义，不是 bug。
- **积压会被丢弃。** 排队超过 `maxQueuedSegments`（默认 8）时先尝试合并旧段；合不动就丢掉最旧的，
  在段首插入「（更早的 N 条记录因积压被略过）」并累加 `member.shed`。这是防止「等待→新内容→排队→等待」
  死循环的闸门，代价是最旧的旁听内容会消失。
- **`mentioned-only` 语义已收紧。** 它现在不再阻止投递（段永远投给所有人），只是把未点名者的话术改成
  「你只是在旁听，除非发现严重问题否则回 `(无补充)`」。真要「谁都别插话」不再有对应的开关。
- **`turn/interrupt` 有坑**：对已 interrupt 过的 thread 再调可能**永久挂起**（无任何 JSON-RPC 回复）。
  本插件保证每个 active turn 最多 interrupt 一次（`interruptAll()` 和 `_enforceStall()` 都遵守），
  且第二次仍卡住时改为**放弃那一轮**：把它的文本收进 `carryOver` 重排，释放队列。
- **卡住的 turn 会堵住队列，兜底只是兜底。** 实测过 73 秒不 drain 的 turn，服务端没有超时。
  引擎靠 `queueStallMs`（默认 120000）两段式处理：先 `interrupt` 一次，再超期就收回重排。
  这意味着最坏情况下一个成员会被卡住这么久，期间它身后排的段都不会被投递。
- **注入路径已不是投递通道。** `thread/inject_items` 的坑仍然真实（无法用 API 回读确认、
  裸 `{type:'input_text'}` 或 `role:'system'` 会被校验器接受却**不到达模型**），但房间已不再用它投递，
  所以这些坑只影响直接调用该原语的代码。
- **ACP 与 codex 走同一条通道，但抢占手段不同。** ACP 没有 steer，被 `@` 打断时只能
  `session/cancel` + carryOver 重发；它**丢掉的是被打断那一轮还没说完的话**，公共日志与已读内容不受影响。
- 每个 codex thread 启动时会枚举 7 个已配 MCP server，`kernelgen` 因缺 token 报错（非致命，已容忍）。
- **ACP 后端需要你自己有一个说 ACP 的 agent 可执行文件。** 本机 `claude`/`gemini`/`cursor-agent`/
  `opencode`/`goose`/`aider` **都未安装**，codex 本身**不是** ACP agent（它是自己的 app-server 协议）。
  **但 DeepSeek Harness 自己是 ACP agent** —— 见下一节，这是本机唯一实盘验证过的对端。
- **ACP 的模型目录来得晚。** 模型列表在 `session/new` 的 `configOptions` 里，而房间在
  `modelCapabilities()` 时还没有 session。**已修**：后端会给这个「还没看到目录」的状态打上
  `synthetic: true`，房间据此**不做模型纠正**（保留成员配置的模型，也不报假的 `not offered`），
  等会话打开、真目录学到之后再刷新给 UI 看。回归钉子见 `test\acp-room.cjs` 的 `catalogue` 段
  （fixture 用 `--quiet-models` 复现真实 agent 的形态）。
  代价：**加成员的那一刻，ACP 后端在 UI 里还没有可选模型列表**，要等这个后端至少开过一个会话
  之后才会出现。此时把模型**留空**即可——留空是「跟着 agent 走」，房间不会替你编一个模型名，
  也不会因此报错；`GET /state` 里该成员的 `model` 就是 `null`，chip 上显示「默认模型」。
  （留空**不等于**默认成 codex 的 `gpt-5.6-sol`：那是个 ACP 后端从未听说过的名字，第一次刷新
  目录时会被「纠正」并弹出一个用户根本没选过的 `model gpt-5.6-sol not offered` 错误。
  回归钉子见 `test\acp-room.cjs` 的 `blank` 段与 `test\ui-members.cjs` 的 `blank` 段。）
- **同一 harness 的多个房间共享一个工作目录。** 这是 R2 要的效果（codex 自己的项目分组能把这些
  thread 收在一处），代价是房间之间**能看见彼此写的文件**。目录只能从配置改，运行时改不了；
  改掉 `acp` 的目录会让 ACP 成员**重开 session**（cwd 创建后不可改）。
- **codex 归组需要轮换，轮换会换掉项目 id。** 只有集合真的变了才会轮换（同集合走幂等采用），
  但一旦轮换，用户在该 codex 项目里做过的**手工归组会丢**。codex 侧另有更轻的 `threadSection`
  （UI 里叫「分区」），可原地增长且逐 thread 幂等，若将来更在意稳定性可以改走那条。
- **ACP 归组依赖两件事恰好成立**：ACP 子进程与宿主共用 `$DSH_HOME/sessions`，且 session header 的
  `cwd` 就是 `workspaceDirs.acp`。前者靠 `acp-backend.cjs` 剥掉 `DSH_*` 后子进程默认回落到 `~/.dsh`——
  **宿主若用非默认 `DSH_HOME` 启动，ACP 侧的归组会静默失效**（只留一行日志）。
- **跨 harness 工作区同步尚未实现**：现在做到的是「每个 harness 各自一个工作区」，**不是**「同一个
  工作区在两家 harness 里同时存在」（两家没有共享的文件夹概念）。DSH 侧有 `domain/changed` 事件
  （`ctx.on('domain/changed', …)`）可订阅每一次工作区持久变更，这是第二期的基座。

