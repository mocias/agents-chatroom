# 可行性评估：群聊插件的四条新需求

> 本文只做判定，**没有修改任何插件代码**。
> 证据标注：`[实测]` = 真实跑通并观察到结果；`[schema]` = 协议/类型定义原文；`[源码]` = 本仓库或 DSH 代码逐行；
> `[推断]` = 由上述事实推出，未直接观测。

---

## 追加评估（本轮）：搬进主对话区？上传？主题？

后来用户提出三条新想法。评估与定案如下——**第 1 条被用户否决，2、3 已实施**：

| # | 需求 | 判定 | 依据 |
|---|------|------|------|
| 1 | 把房间做成主对话区视图、复用 DSH 输入框 | ❌ **不做（用户决定）** | 主对话区归 DSH 自己，插进去会与它的会话/模型语义纠缠。用户原话：「那就保持分开，不作为主视图而只是作为边栏」 |
| 2 | 上传文件/图片 | ✅ **已实施，但必须插件自建** | DSH 上传回执 `{receiptId, attachmentId, name, bytes}` **无客户端可见路径** `[源码]`；`ctx.attachments.imageHostPath` 只限同进程可信消费者 `[源码]`。而房间成员要**真实路径**：codex `localImage.path` `[schema v2/TurnStartParams.json]`；ACP 的 `session/prompt` 只吃纯文本 `[源码]`。故：浏览器发裸字节 → 宿主落盘 → **只回 id** → 发言时宿主按 id 解析成路径 |
| 3 | 用户可配置主题（颜色、背景图） | ✅ **已实施** | 房间自有 `--ar-*` 变量就是天然钩子。但自定义属性即活 CSS，`red;}html{...}` 能注入任意样式 `[推断→实测]`，故必须**宿主侧**按严格白名单语法校验，且**不许**改 `--dsw-alias-*`（全局主题） |

> 第 2 条的边界值得记住：**「像 DSH 一样上传」在实现上不可能等价**，因为 DSH 的
> 上传产物对客户端是不透明的。房间只能自己拥有字节，才能自己拥有路径。

**补充（本轮复查发现并修掉的一处）**：`/state` 早就带了 `uploads:{enabled,maxBytes,maxLabel}`，
但 `room-ui.js` **从来没有读过它**。于是当宿主用 `filesDir: null` 关掉上传时，`＋` 依然可点，
用户选完文件才会收到「uploads are unavailable here」——一个用户无法自行解决的问题被推迟到
最浪费他操作的那一刻才说。现已改为：载入 `/state` 时立即 `applyUploads()`，禁用 `＋` 与
file input 并在 tooltip 里说明原因；拖放与粘贴各自再挡一次（禁用按钮拦不住拖放）。
老宿主缺这个字段时按可用处理（`enabled !== false`），避免把上传误关。
回归钉子：`test\ui-attachments.cjs`（UI 侧）与 `test\attachments.cjs`（真 `RoomApi` + `filesDir:null`）。

**补充（本轮复查发现并修掉的两处注入口）**：上面第 3 条写了「自定义属性即活 CSS，故必须宿主侧严格校验」，
颜色那半边确实做到了，但**背景图 URL 那半边漏了**，而且是同一种漏洞：

1. `normalizeBackgroundUrl` 的相对路径分支只锚定了**首字符**（`/^\/[^\s"'<>\\/]/`，无 `$`），
   于是 `/a");}html{display:none}/*` 被**接受**。UI 把它拼成 `url("/a");}html{display:none}/*")`
   ——引号提前闭合、`}` 结束声明，剩下的是任意 CSS，正是文件头注释声称要挡住的东西。
   `https://` 分支有 `$`，相对路径分支没有，两条分支的严格程度不一致才是根因。
   现改为两条分支都对**整个值**做一次锚定检查（`SAFE_URL_CHARS`），
   并且 `\` 一并排除——它虽然被 CSS 当作转义，却能吃掉 UI 补的那个收尾引号。
2. `background.ext` 直接 `String(raw.ext || '.png')` **原样取自网络并回显**。
   `backgroundFile()` 的白名单兜底使它不构成路径穿越（实测 `../../../../evil` → `background.png`），
   但它是这份文档里**唯一一个来自网络、且命名文件**的字段，却唯一没在边界上校验，还能无界增长。
   现改为在 `normalizeTheme` 里按 `IMAGE_EXTENSIONS` 白名单收敛，`saveBackground` 写入的值原样往返。

回归钉子：`test\theme-store.cjs` 的 `quoteEscapes` 与 `storedExts` 两组。
真实性由变异测试确认——把两条正则改回原来的宽松写法，各断言立刻失败（3/3 + 2/2 `[CAUGHT]`），
并经真 HTTP 复验：`POST /theme` 带引号逃逸 → `background:null`，合法 https URL 正常往返。

**再补充（又一轮复查：同样思路下的两个存储型 XSS，均已实测可利用并修掉）**：
上面两条修的是「值被拼进 CSS」。顺着同一个问题往下问「还有哪个值决定了浏览器**怎么解释**字节」，
找到两处，都比 CSS 注入更严重——**脚本确实执行了**，在 harness 自己的 origin 上：

1. **`/attachment/<id>` 信任客户端自报的 `mediaType`。** 传一个 `.html`、`type` 报 `text/html`，
   路由就以 `content-type: text/html` + `inline` 把用户文件当**文档**发回去。
   Chromium 实测：脚本执行，`document.title` 变成 `EXECUTED`。
   `nosniff` 在这里是**无效**的——它只阻止浏览器*猜*类型，不阻止按**声明的**类型渲染；
   原注释把 `nosniff` 当成了解药，这是误判。修法：`attachments.cjs#serveMediaType`
   只放行惰性类型（位图 + `text/plain`，SVG 刻意排除），其余一律 `application/octet-stream`。
   注意修的是**返回时**，`mediaType` 字段本身照旧留着给 chip 显示。
   顺带：原测试 `attachments.cjs` 里那句 `the served type is the upload type`
   恰好把这个不安全行为**钉死**了，已改成断言收敛后的类型。
2. **`/background` 的 SVG。** 背景允许 SVG（必须以 `image/svg+xml` 返回才画得出来），
   而**直接打开这个 URL** 时它就是可执行文档——实测 `document.title` 变成 `PWNED`。
   （第一次探测时 `?type=image/svg+xml` 被误报成 `unsupported image type`，
   是因为 `+` 在查询串里解码成空格；用 `%2B` 才测到真身。）
   修法：给 `/background` 加 `INERT_IMAGE_HEADERS`（`default-src 'none'; style-src 'unsafe-inline'; sandbox`）。
   `sandbox` 让它落入不透明 origin 且禁脚本；**实测脚本不再执行（弹窗标题为空）而背景照常绘制**
   （`naturalWidth:200`、`computedStyle.backgroundImage` 正常）。

一个**核验后判定无需修改**的：`content-disposition` 的文件名。曾怀疑 `encodeURIComponent`
不管 `"`/`\`，实测**它管**（`"`→`%22`、`\`→`%5C`），而且比手写的 `/["\\]/g` **更严**——
它还把换行/回车转义，手写版不转，会让 node 直接抛 `ERR_INVALID_CHAR`。
当时已改成手写转义，属**更弱**的等价改动，已回退并留注释说明。

回归钉子：`test\attachments.cjs` 的 `scripted` 循环（html / xhtml / svg / xml / js / 伪造类型 6 种）
与 svg 背景组。变异测试 4/4 + 3/3 `[CAUGHT]`。

---

## 0. 结论速览

| # | 需求 | 可行性 | 主要拦路石 | 改动面 |
|---|------|--------|-----------|--------|
| 1 | 保存历史群聊 + 增加新群聊 | ✅ **完全可行** | 无。日志目前纯内存，但名册落盘设施已存在，照扩展即可 | 中：`room.cjs` + `server.cjs` + UI 各加一段 |
| 2 | 每个群聊绑定一个工作区目录 | ✅ **完全可行** | 无。真正的「工作区」对插件来说就是给 harness 传 `cwd`；DSH 侧的 workspace 注册是可选加分项 | 小到中：cwd 已经是房间级字段，加成员级即可 |
| 3 | 时间戳 + 周期性分段投递 + 队列 + 合并 + 长度截断 | ✅ **可行** | 全部是客户端记账逻辑；codex 甚至原生带服务端队列（实测自动接力）。难点在设计取舍，不在能力 | 大：这是投递层的重写 |
| 4 | `@` = 立即 steer 插入正在跑的对话 | ⚠️ **codex 可行，ACP 不可行** | ACP 协议**根本不存在**任何中途插入能力；codex 有 `turn/steer` 但没有服务端队列式 steer，且必须绕开现有串行队列 | 中：需给 `codex-pool` 加 steer 通道并**刻意绕开 `_enqueue`** |

一句话总结：**1、2、3 是纯工程问题；4 分成两半——codex 成员能做到截图里「点击引导」的效果，ACP 成员（比如 `@ds`，即 DSH 自己）物理上做不到，只能降级成「取消当前回答再重问」或「等它答完」。**

---

## 1. 先说清现状，因为需求 3、4 都是冲着它来的

### 1.1 当前投递机制（三步）

```
用户发言 / agent 发言
   → room.append()            写入内存日志，记录带 ts 时间戳
   → room._overhear()         给每个「已有 thread 且支持注入」的成员推 inject_items
   → room._speak()（被点名/全员时）算 delta（cursor 之后未见过的行）→ runTurn
```

- `agent-room\lib\room.cjs:174` `this.log = [];` —— **日志纯内存，没有任何落盘**。
- `agent-room\lib\room.cjs:656-675` `append(entry)` 构造的记录**已经带 `ts`**（`nowIso()`，ISO 字符串），UI 也在显示它。缺的只是**注入给 agent 的文本里没有时间**。
- `agent-room\lib\room.cjs:754-758` `_formatRecord()` 只产出 `[用户] 文本` / `[@id] 文本` / `[你自己 @id] 文本`，**无时间前缀**。
- `agent-room\lib\room.cjs:698-742` `_overhear()` —— 每有一条新记录就立刻推一次。
- `agent-room\lib\room.cjs:864-877` `_deltaFor()` —— 真正意义上的「上次发送节点到现在」切片，靠 `member.cursor` 实现。**你要的「最新一段」，机制上已经存在**，只是目前只在「该它说话」时才用它。
- `agent-room\lib\room.cjs:880-975` `_speak()` —— 开头的 `if (this.busy.has(member.id)) return {skipped:'busy'};` 是**丢弃**，不是排队：成员正在思考时这一轮的点名**直接消失**，既不排队也不补投。

### 1.2 一个必须挑明的真相：现在的「实时旁听」其实不是实时的

`injectItems` 和 `runTurn` **共用同一条 per-thread Promise 链**（`agent-room\lib\codex-pool.cjs:499-504 _enqueue`）。设计理由写在该函数的注释里：`thread/inject_items` 是带外追加，在 turn 途中触发会把消息插进模型已经开始的那一轮中间。

后果：**成员正在跑 turn 时，推给它的旁听消息会排在 turn 后面，等这一轮结束才落地。** 所以「实时旁听」在「成员正忙」这个恰恰最需要它的场景下，退化成了一次 turn 的延迟。

> 这不是 bug，是当时为了正确性（不把消息插进已开始的 turn）付出的代价。
> **你的需求 3 和 4 正好是解决它的两条正路**：3 = 干脆显式地「成批、成段、带队列」地投递，不再假装逐条实时；4 = 用协议真正允许中途插入的 `turn/steer`。

---

## 2. 需求 1：保存历史群聊 + 增加新群聊 —— ✅ 可行

### 判定依据

| 事实 | 位置 |
|------|------|
| 日志纯内存，无落盘 | `agent-room\lib\room.cjs:174` |
| **名册已经在落盘**，可照抄 | `agent-room\lib\room.cjs:1228 _saveRoster()`；`agent-room\lib\server.cjs:207` `rosterFile: path.join(this.roomsDir, \`${key}.members.json\`)` |
| 落盘目录已存在且可写 | `agent-room\lib\index.js:62` `roomsDir = config.roomsDir \|\| defaultRoomsDir(cwd)`，读 `DSH_PROFILE_DIR` |
| 多房间机制**本来就有** | `server.cjs` 的 `this.rooms` Map + `GET /rooms` + `POST /close-room`；房间 id 就是 DSH 会话 id |
| 空房间会被回收（30 分钟无访问） | `agent-room\lib\server.cjs:22` `DEFAULT_IDLE_ROOM_TTL_MS = 30*60*1000` |

### 结论

- **「保存历史」**：把 `append()` 的每条记录**追加**写一行 JSON 到 `<roomsDir>/<roomId>.log.jsonl` 即可，`connect()` 时回读重建 `this.log` 与 `logSeq`。用**追加写**而非全量重写，所以每条消息只多一次 append I/O，不会随对话变长而变慢。
  - 需要一并持久化的：`logSeq`、各成员的 `cursor`（否则重启后每个人会把整个历史重听一遍）。
  - 顺带能解决的旧问题：现在房间被回收后再打开是「空的新房间」——因为日志不落盘。落盘后回收只丢进程，不丢记忆。
- **「增加新群聊」**：两道 UI 而已。
  1. 房间切换器（列出 `GET /rooms`，点进某个 room）；
  2. 「新建群聊」按钮 → 生成一个新 room id（不要复用 DSH 会话 id）→ `POST /new-room` 之类。
  - 现有 `POST /new-conversation` 是**在同一个房间里清空日志 + 重置所有 thread**，语义是「这个房间重新开始」；你要的「新群聊」是**另开一个房间**。两者都要保留，不能混。

### 工作量：中。无技术风险。

---

## 3. 需求 2：每个群聊一个工作区 —— ✅ 可行（核心是 cwd，DSH workspace 是可选加分）

### 判定依据

**A. 对插件来说，harness 的「工作区」就是一个 cwd 字符串。**

| 后端 | 设定方式 | 限制 |
|------|---------|------|
| codex | `ThreadStartParams.cwd`（开 thread 时）；`TurnStartParams.cwd` 文档逐字 *"Override the working directory for this turn and subsequent turns."* `[schema]` | 可中途改 |
| ACP | `session/new { cwd }`，**必填且必须是绝对路径**；DSH 侧对非绝对路径报 `cwd must be an absolute path` `[源码]` | **创建后无法更改**——要「搬家」只能关掉 session 重开 |

- 房间**已经有** `this.cwd`（`agent-room\lib\room.cjs:151`），并已传进 codex pool（`codex-pool.cjs:345` `cwd: options.cwd || this.cwd`）和 ACP 的 `session/new`。
- **成员级没有 cwd 字段** → 这是要加的那一块。
- ACP 成员换工作区必须 `closeThread` + 重开（会丢该 member 的会话上下文，需重新简报房间日志）。codex 成员可以直接在 turn 上覆盖 cwd，代价小得多。

**B. 你提的「先在 codex 里创建工作区文件夹」，有两种接法：**

1. **只把它当目录**（最简单）：用户在资源管理器/Codex 里建好文件夹，在插件 UI 里选它（或填路径），插件把它钉给这个房间的成员。**完全可行，零依赖。**
2. **真的读 codex 的 Project 列表**：codex 0.162.1 **确实有**命名工作区概念 `[实测]` —— `project/{list,read,create,import,update,move,delete}`，`Project = {id, name, roots[], metadata, position, ...}`，多根工作区就是一个 Project 带多个 `roots`。实测 `project/list` 返回了你真实的项目（`soccer`→`D:\soccer`、`卡牌游戏`→`D:\pokemon-game\poke-game` 等）。
   - **可行，但要注意**：`project/*` **不在** codex 生成的 `ClientRequest` 类型联合里 `[实测]`，必须手写 JSON-RPC；而且我们的协议文档是旧版生成的（见 §6 风险）。属于「能做，但要为升级维护买单」。
   - 好处很实在：可以做成下拉框「选一个 codex 项目作为本群聊工作区」，完全贴合你的描述。

**C. DSH 侧的 workspace（可选加分，不是必需）：**

- 第三方 host 插件**可以**创建工作区：`await ctx.workspaceRegistry.create('<已存在的绝对目录>')` `[源码]`（`_research\asar12\...\dsh-workspace\lib\index.js:406-410`）。纯 JS，**不需要 codegen**。
- 三个硬约束：① **目录必须已存在，插件不能 mkdir**；② 工作区**只是一个注册记录**（UUID + 规范化路径 + 标题 + 有序 sessionIds），**不往目录里写任何东西**，也不是什么「文件夹标记」；③ 唯一的删除/归档/置顶在 domain 全局里。
- 意义：做了之后，这个文件夹会出现在 DSH 左栏的工作区列表里。
- **但要注意**：我们的群聊成员**不是 DSH 会话**，是插件自己 spawn 的 codex/ACP 子进程。所以注册 DSH 工作区只是「让它在侧栏可见」，**跟成员的 cwd 无关**——成员 cwd 是我们自己传给 harness 的。

### 结论

**可行。** 建议分两层做：
1. **房间级 cwd**（必做）：加一个 room 级 `cwd` 配置 + UI 选择器 → 传给所有成员。
2. **成员级 cwd 覆盖**（建议做）：ACP 成员换目录时明确提示「会重置该成员的会话」。
3. **codex Project 下拉**（可选，体验最好）：手写 `project/list`。
4. **DSH workspace 注册**（可选）：让文件夹出现在 DSH 侧栏。

---

## 4. 需求 3：时间戳 + 分段投递 + 队列 + 合并 + 长度截断 —— ✅ 可行

这是四条里**最需要设计、但技术上完全没障碍**的一条。逐项拆：

### 3a. 时间戳 —— ✅ 最简单

- 记录层**已有 `ts`**（`room.cjs:656-675`，ISO 字符串）。
- 只改 `_formatRecord()`（`room.cjs:754-758`）加前缀：`[10:23:41] [用户] 大家好` / `[10:23:58] [@codex] ...`。
- 两个协议**都禁止**在消息上带时间 `[实测/schema]`：codex 的 `UserInput` 全部变体（`text`/`image`/`localImage`/`audio`/`localAudio`/`skill`/`mention`）**没有任何时间戳字段**；ACP 的 prompt 与 `session/update` 也**没有任何时间字段**。所以**必须把时间编进 text 字符串**——这正是你说的「单独使用某个工具来标注上，agents 读取群聊消息时带上时间」。
- codex 侧的 `text` 是裸 `string`，有 `text_elements` 但那是 UI 渲染用的 span，**没有净化/改写钩子** → 任意格式合法。
- 附赠：turn 级时间在 codex 是有的（`Turn.startedAt/completedAt/durationMs`），但那是**整轮**的时间，不能替代逐行时间。

### 3b. 周期性分段投递 —— ✅ 可行

- 「上次发送节点到现在」的切片机制**已经存在**：`member.cursor` + `_deltaFor()`（`room.cjs:864-877`）。
- 改动本质：把「每来一条就 `_overhear` 推一次」换成「**定时器每 N 秒，把 cursor 之后的整段作为一批投递**」。
- 时间基准已经够用：`_deltaFor` 按 `seq` 切，天然不会漏、不会重。

### 3c. 队列（忙时排队，不丢） —— ✅ 可行，且 codex 有原生支持

**当前行为**：`_speak()` 开头 `if (this.busy.has(member.id)) return {skipped:'busy'};`（`room.cjs:880`）——忙时**直接丢弃**，这就是要改的第一处。

**codex 原生队列（重大发现）** `[实测]`：
- codex 0.162.1 **有**一个只存在于运行时的服务端队列 API：`thread/queue/{add,list,update,delete,reorder,start}`。
- **自动接力已实测**：`turn/completed` 之后 **20 毫秒**，排队的提交自动开了一个新 turn，客户端零动作。
- `QueuedSubmission.clientUserMessageId` 会变成后续 turn 上 `ThreadItem.clientId` → **这就是你要的相关性句柄**（能追踪「这一段是给哪一批的」）。
- **坑一**：`thread/queue/*` **不在**生成的 `ClientRequest` 类型里（旧版和新生成的都缺），必须手写 JSON-RPC。协议表面明显还在快速变动。
- **坑二** `[实测]`：**卡住的 turn 会无限期堵住队列**——子代理实测遇到一次 73 秒的重连停滞，队列一直不 drain，**没有任何超时兜底**。

**ACP 侧**：**完全没有队列概念，且并发会被拒绝** `[实测/源码]` —— DSH 的 ACP server 对同一 session 的第二个 `session/prompt` 直接抛 `-32602 "a prompt is already in flight for this session"`（`_research\asar3\...\dsh-acp\lib\index.js:798`，单一 `inflight` 槽位）。
→ **队列只能由插件自己实现**；好消息是 `agent-room\lib\acp-backend.cjs:841` 的 `_enqueue` 已经在串行化了，往上加一层「分段队列」是自然的。

**结论**：建议**插件自建队列作为统一层**，codex 后端可以选择性地把队列下沉到原生 `thread/queue/*`（换来进程重启后仍在排队的鲁棒性），但两条路都要留。

### 3d. 合并（上一段还没被读，就把新的并进去） —— ✅ 可行

- 判据很干净：「上一段是否已被 agent 开始读取」。对 codex 原生队列：`thread/queue/list` 里还在的条目就是「未读」`[实测]`；对自建队列：条目状态 `pending | delivered`。
- 合并 = 把新 segment 的文本拼到 pending 条目尾部，而不是新增条目。
- **注意一个真实的语义陷阱**：合并意味着这段文本会**作为一个 turn 的输入**被消费，而不是像现在的 `inject_items` 那样只做「旁听」。这两个是不同的机制——
  - `thread/inject_items`：**不产生 turn**，纯上下文补充（但读不回来，无法确认投递）；
  - `thread/queue/add`：**会产生 turn**，agent 会针对它作答。
  - 你的描述（「以队列的形式发送」「上一段还没开始读取」）指向的是**后者**。所以这次改动实际上是把「逐条注入旁听」升级成「分段排队 + 批量投递」，语义更接近真群聊。

### 3e. 长度截断（过长就拆成多条，不无限合并） —— ✅ 可行

- 纯客户端记账：`if (pending.text.length + delta.length > LIMIT) { 封存 pending 为新条目; 另起一条 })`。
- 上限值需要你定（按字符还是按估算 token）。**建议按 token 估**，因为瓶颈是模型的 context 和「处理—新内容—入队」循环的延迟，不是字符数。
- 这一条正好解掉你自己点出的死循环：`等待处理 → 出现新内容 → 加入队列 → 等待处理`。截断让每批有确定上界，队列总长度因此收敛。

### 工作量：大。是投递层的重写，但**全部是插件内部逻辑**，不依赖任何协议扩展。

---

## 5. 需求 4：`@` = 立即 steer 插入 —— ⚠️ codex 可行 / ACP 不可行

### 5.1 codex：✅ 可行，而且证据非常硬

**`turn/steer` 确实存在且语义就是「插进正在跑的那一轮」** `[schema]`：
```ts
TurnSteerParams = {
  threadId: string,
  expectedTurnId: string,   // 必填：要求与当前 active turn 匹配，否则失败
  input: Array<UserInput>,
  clientUserMessageId?: string | null,
}
TurnSteerResponse = { turnId: string }   // 返回的是【当前那个 turn 的 id】，不新建 turn
```

**实测证据（决定性）** `[实测]`：
- 原 prompt 说「只回复 PING」；1.2 秒后 steer 说「不要 PING，只回复 ZEBRA-7731」；
- 结果模型输出 `ZEBRA-7731` —— **steered 文本真的在 turn 中途到达了模型**，原指令被覆盖；
- 事后 `thread/resume` 复原该 thread：`items types=["userMessage","userMessage","agentMessage"]` —— steer 被持久化为**同一个 turn 里的第二条 userMessage**，而不是新 turn。

**这跟截图里那个 `↩ 引导` 按钮是同一个东西。** 顺带解释了 `↩ 1`：那是 codex 客户端自己队列里的待发条数。

**已经具备的前置条件**：
- `codex-pool.cjs:443` `this.activeTurns = new Map()`，在 `turn/started` 时写入（`:626`）、`turn/completed` 时清除（`:661`/`:676`），`interrupt` 时读取（`:771`）。
  → **`expectedTurnId` 已经有了，不用新建状态。**

**三个必须处理的设计点：**

1. **steer 必须绕开 `_enqueue`。** 现在所有操作都走 per-thread 串行链（`codex-pool.cjs:499-504`）。如果 steer 也走这条链，它会**排在正在跑的 turn 后面**——正好与需求相反。
   - 但这**不违反** `_enqueue` 存在的理由：该注释禁止的是「在 turn 途中做 `inject_items`」（会插进模型已开始的那轮中间），而 `turn/steer` **就是协议为中途插入设计的**。所以给 steer 开一条带外路径是正确的，不是妥协。
2. **竞态兜底。** `expectedTurnId` 是必填前置条件，turn 恰好在检查与发送之间结束 → 报 `-32600 no active turn to steer` `[实测]`。
   → 需要回落：捕获这个错误后，把内容按普通 turn（或送入队列）处理。
3. **有个别 turn 天生不可 steer** `[schema]`：`activeTurnNotSteerable`，`turnKind` 为 `review` / `compact` 的 turn 不接受。我们目前的用法不会产生这类 turn（不是 `/review`、`/compact`），但错误分支要写。

> 附带一个反直觉的实测事实：**在忙 thread 上再发 `turn/start` 也是 steer，不是排队** `[实测]` —— 它返回 200 OK 且携带**已在运行的那个 turn 的 id**，输入被合并进那个 turn。服务端自己的注释逐字：*"Ignored when this request adds input to an active turn."* 所以「想排队却发 `turn/start`」是错的，要排队必须显式 `thread/queue/add`。

### 5.2 ACP：❌ 不可行（协议层面不存在）

- ACP 的完整方法表（`AGENT_METHODS` / `CLIENT_METHODS`，共 42 个）里**没有任何** steer / inject / append / interrupt-with-text `[实测]`。codex 的 `turn/steer` **没有 ACP 对应物**。
- `session/update` 里的 `user_message_chunk` **确实存在，但方向是 agent→client**（schema 标记 `"x-side": "client"`，即客户端是接收方）——它是 agent 回放/回声用户消息用的，**不是客户端注入 API** `[实测]`。
- 唯一能影响进行中 turn 的手段都不是「输入」：`session/set_config_option`（改模型/effort）和 `session/cancel`（**结束**这一轮，而不是 steer 它）。
- **对 ACP 成员，「@ 立刻插进去」只剩两条路，都有代价：**
  - (a) **取消再重问**：`session/cancel` → **必须 await 原 prompt 返回 `stopReason: "cancelled"`** → 再 `session/prompt`。跳过 await 会撞上单槽位限制（`-32602`）。代价是**正在生成的回答被丢弃**。
  - (b) **等它答完再问**：即普通排队，没有「立刻」。
  - 具体到你的 `@ds`（就是 DSH 自己作为 ACP 成员）：**只有这两条路**。

### 5.3 一个建议的折中

对 ACP 成员，把「立刻插入」降级为「**抢占**」：取消当前 turn 并把已生成的部分保留在房间里（而不是丢弃），然后立刻用新内容开一轮。这样用户感知上仍是「@ 立刻见效」，代价是那一轮的回答不完整——而且这在 UI 上必须**明示**，否则会被当成 bug。

---

## 6. 跨需求的共同风险（三条，都值得先知道）

1. **我们的 codex 协议资料是旧版生成的，而且已经被证明不完整。** `[实测]`
   - 实际运行的是 codex **0.162.1**；仓库里的 `schema/` 和 `ts/` 是更早版本生成的。
   - 更关键：**即使重新生成，`ClientRequest` 类型联合里也不含 `thread/queue/*`**，而运行中的服务端**实现了它**。`project/*` 同理。
   - ⇒ 凡是新能力（队列、项目）都得**手写 JSON-RPC**，并且**为每次 codex 升级预留维护成本**。
2. **卡住的 turn 会无限期堵住一切。** `[实测]` 一次上游停滞导致队列 73 秒不 drain，**没有超时兜底**。`turn/interrupt` 也不能救：对**已经是 interrupted 状态的 turn** 再调一次，**永远不会有 JSON-RPC 回复**（不是报错，是彻底静默）`[实测]`。只能自己跟踪 `turn/completed status=="interrupted"` 并保证只打断一次。
3. **ACP 的能力上限比 codex 低一大截，而且这个不对称无法抹平** `[实测]`：没有中途插入、没有队列、没有时间戳、`cwd` 创建后不可改、`session/resume` 不回放历史（DSH 甚至没实现 `session/load`，调用得 `-32601`）。
   ⇒ **任何以「所有成员行为一致」为前提的设计都会在 ACP 上破功。** 建议把「能力档位」显式暴露到房间状态里（我们已经这么做了：`supportsInject`），UI 上对 ACP 成员的能力差异给出提示。

---

## 7. 建议的实施顺序（**未实施，等你拍板**）

| 阶段 | 内容 | 依赖 |
|------|------|------|
| A | 需求 1（日志落盘 + 多群聊 UI） | 无。建议先做，因为它是 3 的前置：分段投递要记 `cursor`，落盘才能跨重启 |
| B | 需求 3a（时间戳进注入文本） | 无，几行改动，立竿见影 |
| C | 需求 2（房间 cwd + 成员 cwd） | 无。ACP 侧换目录要明确提示「会重置会话」 |
| D | 需求 3b–3e（分段投递 + 队列 + 合并 + 截断） | A。这是最大的一块，建议把它当成独立的「投递层」重写，先写离线测试（桩 pool + 可注入时钟） |
| E | 需求 4（@ = steer） | B/D 之后。codex 分支先做；ACP 分支明确降级为「抢占」并在 UI 注明 |
| F | 可选：codex `project/list` 下拉；DSH workspace 注册 | 独立，随时可加 |

---

## 8. 需要你先定的几个问题

1. **分段投递的节奏**：多久发一段？（现在你写的是「每隔一段时间」）——这个值直接决定「像不像群聊」，也决定延迟。
2. **长度截断按什么计量**：字符数，还是估算 token？上限大概多少？
3. **合并后的语义**：合并的那一段是给 agent **作答**的（产生 turn），还是只做**旁听上下文**（`inject_items`，不产生 turn）？——这决定了它是「@ 谁谁答」还是「大家都在读」。
4. **ACP 成员（如 `@ds`）在 @ 被触发时**：接受「抢占（取消当前回答）」，还是接受「只能排队」？两者必选其一，因为协议不支持第三种。
5. **`new-conversation` 和「新群聊」的区分**：前者清空当前房间，后者另开房间——确认这个划分。
6. **是否要 codex Project 下拉**（手写 `project/*` RPC，有升级维护成本），以及**是否要注册成 DSH 工作区**（让文件夹出现在 DSH 侧栏）。

---

## 9. 一句话回答你的四个问题

1. **保存历史 + 新群聊**：能做，设施基本都有了，主要是写日志文件和加 UI。
2. **给每个群聊绑工作区**：能做。对插件而言「工作区」就是给 harness 传的 `cwd`——房间级已经有了，加成员级即可；ACP 成员换目录要重开会话。想让它出现在 DSH 侧栏、或者直接下拉选 codex 项目，也都能做（后者要手写 RPC）。
3. **时间戳 + 分段投递 + 队列 + 合并 + 截断**：能做，全是插件内部逻辑。时间戳协议不支持，必须编进文本（这正是你要的「插件里自动标注」）。codex 甚至原生带服务端队列且实测自动接力；ACP 只能自建。
4. **`@` = 立即插入（点击引导）**：**codex 能，ACP 不能。** codex 的 `turn/steer` 实测有效（steered 文本真的改变了模型输出），前置状态也已有（`activeTurns` 已跟踪 turn id）；但必须**绕开现有串行队列**并处理「turn 刚好结束」的竞态。ACP 协议里**根本不存在**这个能力——`@ds` 只能降级为「取消当前回答再重问」或「等它答完」。
