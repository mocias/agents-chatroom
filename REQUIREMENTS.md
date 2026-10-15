# 群聊插件：需求定案 v2

> 本文只整理需求，**没有修改任何代码**。
> 依据：用户 m06593 / m06594 对本报告 §8 六个问题的回答 + 对「工作区」含义的澄清，以及 m06603 的进一步澄清与二次确认。
> 证据分级：[实测] 真实跑通观测 / [schema] 协议定义原文 / [源码] 代码逐行 / [推断] 由事实推出未直接观测。

---

## 实施状态（2026-10-14 更新）

R1–R4 已全部落盘，代码与测试都在本目录：

| # | 状态 | 落点 |
|---|------|------|
| R1 | ✅ 已完成 | `room.cjs` 的 `_appendLogLine`/`_loadLog`（JSONL + cursor 恢复）；`server.cjs` 的 `/new-room`、`/delete-room`、`/new-conversation`→410；`room-ui.js` 的房间切换器 |
| R2 | ✅ 已完成 | `room.cjs` 的 `workspaceDirs`/`_workspaceDirFor`；`index.js` 的 `resolveWorkspaceDirs` + `mkdirSync` |
| R3 | ✅ 已完成 | `room.cjs` 的 `_capture`/`_addLineToSegment`/`_boundQueue`/`_formatRecord`/`_tick`/`_deliver`/`_runSegment`（逐条旁听 `_overhear` 已删除） |
| R4 | ✅ 已完成 | `codex-pool.cjs` 的 `steer()`；`room.cjs` 的 `_preempt`（steer 或 interrupt+carryOver） |
| F（兜底） | ✅ 已完成 | `room.cjs` 的 `_enforceStall`（两段式：先 interrupt 一次，仍卡则收回文本释放队列），常量 `DEFAULT_QUEUE_STALL_MS = 120000` |
| 工作区归组 | ✅ 已完成 | codex：`codex-pool.cjs` 的 `syncProject`/`_syncProject`/`_threadsInProject`（轮换 + 并集 + 幂等采用），由 `room.cjs#_scheduleGrouping` 在 turn 后触发；ACP：`index.js` 的 `createSessionFiler`（`ctx.get('workspaceRegistry')` → `create` → `attachSession`），由房间的 `session` 事件经 `server.cjs#onSession` 驱动 |

测试：`node test\run-all.cjs` 跑 24 个**零 codex 额度**的离线测试（新增 `segments.cjs` / `steer.cjs` / `room-registry.cjs` / `session-filing.cjs` / `theme-store.cjs` / `theme-row.cjs` / `attachments.cjs` / `codex-input.cjs` / `encoding.cjs` / `ui-attachments.cjs`）。
**绝不要加 `--online`**，那会花用户的 ChatGPT 额度。

### 追加：上传与主题（本轮）

| # | 状态 | 落点 |
|---|------|------|
| 上传 | ✅ 已完成 | `attachments.cjs`（落盘/取回）+ `server.cjs` 的 `/attach`、`/attachment/<id>`、`_resolveAttachments`（id → 真实路径，只在宿主侧）+ `codex-pool.cjs#buildInput`（图片走 `localImage`）+ `room-ui.js` 的托盘与拖放 |
| 上传链路的最后一跳（复查补漏） | ✅ 已完成 | `codex-input.cjs` 只验 `buildInput` 的形状、`segments.cjs` 只验 segment 把附件交给了 `pool.runTurn`，**没人看 `_runTurn` 实际发出去的东西**。把 `buildInput(options.text, options.attachments)` 改成 `buildInput(options.text, [])`，**24/24 全绿**——图片会被静默降级成「文本里的一条路径」，正是「模型看到图」与「模型只读到文件名」的分界。修法：`stub-app-server.cjs` 新增 `STUB_INPUT_FILE`，把 `turn/start` 的 `input` **原样**记一行 JSON；`steer.cjs` 新增 scenario7 断言该数组里确实有 `localImage` 且带真实路径、非图片没有被提升、无附件时只有文本。变异 4/4 `[CAUGHT]`（含原来漏掉的那一个）。ACP 侧同理：`attachmentLines` 清空 3/3 中 2 个 `[CAUGHT]`，剩下那个是既知等价变异（纯文本后端本就忽略 `attachments`，路径走 `text`） |
| 上传能力位 | ✅ 已完成 | `/state` 的 `uploads:{enabled,maxBytes,maxLabel}`；`filesDir: null` 时 UI 在开选择框**之前**禁用 `＋` 并说明原因，拖放/粘贴各再挡一次（`ui-attachments.cjs` + `attachments.cjs` 的 `filesDir:null` 真 RoomApi 断言） |
| 主题 | ✅ 已完成 | `theme.cjs`（预设 + 严格白名单校验 + 背景图文件）+ `server.cjs` 的 `/theme`、`/theme/background`、`/background` + `client.js` 的「设置 → 通用」行 + `room-ui.js` 的外观面板（两入口靠 `agent-room:theme` 事件同步） |
| 双向同步 | ✅ 已完成 | 两个入口是各自独立的挂载，`agent-room:theme` 是**唯一**的协调机制：房间侧收到就重读并重绘、自己保存时发事件、`destroy` 时退订。两侧各由 `theme-row.cjs`（设置行侧）与 `ui-attachments.cjs`（房间侧）钉住；单向同步会让用户没在操作的那个界面一直显示旧色板 |
| CSS 注入边界（复查补漏） | ✅ 已完成 | 背景 URL 的**相对路径分支**原先只锚定首字符，`/a");}html{display:none}/*` 被接受，而 UI 拼的是 `url("<值>")` → 引号提前闭合即任意 CSS。两条分支现统一对整值做锚定检查并排除 `\`；`background.ext` 同样在边界按 `IMAGE_EXTENSIONS` 白名单收敛（它不构成穿越，但是全文唯一来自网络又命名文件的字段）。钉子：`theme-store.cjs` 的 `quoteEscapes` / `storedExts` 两组，变异测试 5/5 `[CAUGHT]` |
| 附件路由的存储型 XSS | ✅ 已完成 | **已实测可利用**：`/attachment/<id>` 原先直接回 `attachment.mediaType`，而那是客户端自报的。传一个 `.html` 并报 `text/html`，路由即以 `inline` 返回 HTML 文档，其 `<script>` 在 harness 自己的 origin 执行（Chromium 实测 `document.title` 变成 `EXECUTED`）。`nosniff` 挡不住——它只阻止浏览器*猜*类型，不阻止**照声明的类型渲染**。修法：新增 `attachments.cjs#serveMediaType`，只放行惰性类型（位图 + `text/plain`，SVG 刻意排除），其余一律 `application/octet-stream`（浏览器下载而非渲染）；`mediaType` 本身保留给 chip 显示。钉子：`attachments.cjs` 的 `scripted` 循环（html/xhtml/svg/xml/js/伪造类型共 6 种）+ 文件名引号逃逸，变异 4/4 `[CAUGHT]` |
| 背景图的 SVG 同源执行 | ✅ 已完成 | 背景允许 SVG（存成 `.svg`，以 `image/svg+xml` 返回才能当 CSS 背景绘制），而**直接打开该 URL** 时它就是可执行文档——实测 `document.title` 变成 `PWNED`。修法：`/background` 加 `INERT_IMAGE_HEADERS`（`default-src 'none'; style-src 'unsafe-inline'; sandbox`），`sandbox` 使其落入不透明 origin 且禁脚本；实测脚本不再执行（弹窗标题为空）而背景仍照常绘制（`naturalWidth:200`、`computedStyle.backgroundImage` 正常）。注意：**别去掉它**——这是「能画」与「能执行」之间唯一的隔离。钉子：`attachments.cjs` 的 svg 背景组（类型仍为 svg、CSP 含 `sandbox`、字节完整），变异 3/3 `[CAUGHT]` |
| 下载名头部注入 | ✅ 核验后无需改 | `content-disposition` 里的文件名用的是 `encodeURIComponent`，原先怀疑它不管 `"`/`\`。实测**它管**：`"`→`%22`、`\`→`%5C`，且额外把换行/回车转成 `%0A`/`%0D`（手写的 `/["\\]/g` 反而不转，会让 node 抛 `ERR_INVALID_CHAR`）。曾把它改成手写转义——那是**更弱**的等价改动，已回退并留注释说明为什么保持 `encodeURIComponent`。钉子：`attachments.cjs` 的引号组，变异「回填原始名字」`[CAUGHT]` |
| 探测脚本污染插件目录 | ✅ 已完成 | `test/serve.cjs` 与 `serve-nofiles.cjs` 把 `roomsDir` 默认成 `<package>/.rooms`，而 `lib/index.js` 是从 rooms 的**父目录**推上传/主题目录的 → 每次手工探测都往源码树里丢 `agent-room-files/` 与 `agent-room-theme/`（实测积了 9 个上传文件 + 一张跑偏背景 + `theme.json`）。改：默认落到 `os.tmpdir()/agent-room-standalone*`，需要复用就显式给 `AGENT_ROOM_DIR`。已清掉现存残留（先备份到 `%TEMP%`）。钉子：`attachments.cjs` 按**源码**断言两个脚本的默认值不指向 `__dirname/..`，并断言包内无这三个目录；变异 3/3，另用「真的种一个 `agent-room-files/`」验证该断言非空转 |

**范围决定：房间不进主对话区。** 用户原话「那就保持分开，不作为主视图而只是作为边栏」——
不注册 `conversation.view`，主对话区与 DSH 输入框一律不改。上传**不能**复用 DSH 输入框：
DSH 上传回执只有 `{receiptId, attachmentId, name, bytes}`、没有客户端可见路径，而
`ctx.attachments.imageHostPath` 只对同进程可信消费者开放；房间成员要的是真实路径
（codex `localImage.path`；ACP 只吃纯文本），所以路径只能由宿主侧按 id 解析。

> 工作区归组是 m08190 追加的需求，不在下面的原始定案里：用户要的是**每个 agents harness 一个单独
> 工作区，装下该 harness 的所有对话**（不是「一个房间一个工作区」，也不是「同一文件夹被两家 harness 共享」）。
> 两家的「工作区」是不同概念：codex 叫**项目**，DSH 叫**工作区**，所以两边各写各的。

> 下文保留当时的定案原文（含「相对现状」列的旧描述），作为决策依据的历史记录。

---

## 0. 定案一览

| # | 需求 | 定案 | 相对现状 |
|---|------|------|---------|
| R1 | 历史与房间生命周期 | 日志落盘；**去掉「清空本房间」**，改为**可删除房间** | 日志目前纯内存；`/new-conversation` 需下线 |
| R2 | 工作区 | **按 harness（后端）各一个固定目录**：所有 codex 对话一个目录，所有 DSH/ACP 对话另一个目录；目录暂不可变，由用户指定 | 现在是房间级 `this.cwd`，默认等于宿主 cwd |
| R3 | 投递层 | **30s** 分段投递，**投给所有成员**；时间戳编进文本；忙时排队；可合并；**按字符**截断 **2500**；合并段由 agent 自行决定插话或旁听；**取代**逐条旁听 | 现在是逐条即时注入旁听，忙时直接丢弃 |
| R4 | `@` | codex 走 `turn/steer`；ACP 走**抢占**（取消 + 合并重投 + carryOver 结转） | 现在 `@` 只影响「谁被唤醒」，无即时插入 |

---

## 1. R1：历史持久化 + 房间可删除

### 1.1 保存历史
- 每条 `append()` 的记录**追加**写一行 JSON 到 `<roomsDir>/<roomId>.log.jsonl`（追加写，不随对话变长而变慢）。
- `connect()` 时回读重建 `this.log` 与 `logSeq`。
- **必须一并持久化各成员的 `cursor`**，否则重启后每个成员会把整个历史重听一遍、重新回答一遍。
- 附带修好一个既有毛病：房间被回收（30 分钟无访问）后再打开是空房间——落盘后回收只丢进程，不丢记忆。
- 现成设施：`room.cjs:1228 _saveRoster()` 已经在写 `<roomId>.members.json`（`server.cjs:207`），日志落盘照同一模式扩展即可。

### 1.2 房间生命周期（改动）
- **去掉「清空本房间」**：`POST /new-conversation` 下线（它的语义是「本房间清空日志 + 重置所有 thread」）。
- **新增「删除房间」**：删除该房间的进程（`closeRoom`）、内存态、以及 `<roomId>.log.jsonl` 与 `<roomId>.members.json` 两个文件。现有 `POST /close-room` 已经能回收进程，扩展成同时删文件即可（需区分「回收（保留文件）」与「删除（连文件）」）。
- 需要「重新开始」时的做法：删除房间 → 新建一个。

### 1.3 多房间 UI
- 房间切换器（列 `GET /rooms`，点进去）。
- 「新建房间」按钮 → 生成新 room id（**不复用 DSH 会话 id**，否则又会一会话一房间、一房间一进程）。
- 注：当前 tab 用 `props.sessionId` 当 room key（`lib\client.js`），R1 之后需改成「记住上次打开的房间 + 允许切换」。

---

## 2. R2：一个统一的固定工作区

### 2.1 你的意思（我的理解）
**按 harness 分目录**——同一个 harness 的所有对话共用一个文件夹，不同 harness 各用各的：

```
D:\agents-groupchat\codex\          ← 所有 codex 对话共用（目录暂不可变）
   ├─ 群聊 A 里的 codex   → codex thread #1  (cwd = …\codex)
   ├─ 群聊 B 里的 codex   → codex thread #2  (cwd = …\codex)
   └─ 群聊 C 里的 codex   → codex thread #3  (cwd = …\codex)

D:\agents-groupchat\dsh-acp\        ← 所有 DSH/ACP 对话共用
   ├─ 群聊 A 里的 @ds     → ACP session #1   (cwd = …\dsh-acp)
   └─ 群聊 B 里的 @ds     → ACP session #2   (cwd = …\dsh-acp)
```

三个 codex 对话在 codex 侧归入**同一个项目**，后续各对话的 memory 也落在该对话/该目录下；ACP 成员同理，共用 ACP 目录。

### 2.2 这对插件意味着什么
**「工作区」对 harness 而言就是一个 cwd 字符串。** 所以 R2 的实现是：

- 新增**按后端（backend）配置的目录表**：`workspaceDirs: { codex: '<路径>', acp: '<路径>' }`，
- 每个成员的 `cwd = workspaceDirs[member.backend]`，**不再用房间级 `this.cwd`、不再用宿主 cwd**；
- 两个目录都要 `mkdirSync(dir, {recursive:true})` —— **必须**，因为 ACP 的 `session/new {cwd}` 要求目录已存在且必须是绝对路径 [源码]；codex 侧同理更稳；
- 未配置的后端**回落到默认**（建议 `<DSH_PROFILE_DIR>\agent-room-workspace\<backend>`），避免配置遗漏导致某类成员没有 cwd；
- 「暂不可变」= **只从配置读**，不做 UI、不做运行时切换、**不做房间级/成员级覆盖**。

> 注意这比「一个全局目录」多了一层：**cwd 现在是成员级属性，由 `member.backend` 决定**。
> 这恰好是 R2 唯一需要新增的能力——但它是**查表**，不是「可覆盖字段」，所以仍然满足「不可变」。

### 2.3 这样做的代价（必须知道）
- 宿主 cwd 目前是 DSH profile 目录（`$DSH_PROFILE_DIR`，`@ds` 就是这么回答的）。改掉之后，`@ds` 的「工作目录」会变成 ACP 目录 —— 这正是你想要的效果，但也会让 ACP 成员**重新开 session**（`cwd` 创建后不可改，见 §4.3）。
- **同一个 harness 的多个房间共用目录**：它们会看到彼此写的文件。这是你明确要的效果（「共同用一个文件夹」），但要知道隔离性因此只存在于 harness 之间，不在房间之间。
- 房间级/成员级 cwd 覆盖能力**本轮不做**（因为要求目录不可变）。将来若要「一个房间一个目录」，加的就是这个口子。

### 2.4 一个需要留意的前提（[推断]，建议实施时花一次免费 RPC 验证）
codex 的工作区分组是**按 thread 的 cwd 归属**的 [推断]。若要让三个对话真的在 codex 侧显示为同一个项目，取决于：
- codex 桌面版/CLI 是否按 `project.roots` 与 thread `cwd` 匹配分组；
- 以及我们**早期发现过的 catalog 同步停摆问题**（`codex-dev.db#local_thread_catalog` 水位停在 19:13:42，之后的 thread 不进目录）是否还会复现——**如果它复现，thread 不会出现在列表里，同 cwd 也没用**。
→ 验证手段：`project/list` 与 `thread/list {cwd}` 都是**纯本地 RPC，不产生模型调用、不花额度**，可在实施时随手验。

---

## 3. R3：投递层（30s 分段 + 队列 + 合并 + 截断 + 时间戳）

### 3.1 时间戳
- 记录层**已有** `ts`（`room.cjs:661 ts: nowIso()`，ISO 字符串），UI 已在显示。
- 改动只在 `_formatRecord()`（`room.cjs:754-758`）——加时间前缀，例如：
  - `[10:23:41] [用户] 大家好`
  - `[10:23:58] [@codex] …`
- **协议强制**：codex 的 `UserInput` 所有变体（`text`/`image`/`localImage`/`audio`/`localAudio`/`skill`/`mention`）都没有 timestamp 字段 [schema]；ACP 的 prompt 与 `session/update` 也没有任何时间字段 [实测]。→ **只能编进 text 字符串**，与你的预期一致。
- 时间由插件在消息**入日志时**标注（不是 agent 输出时）[实测 `ts` 就是这么来的]。

### 3.2 30s 分段投递（投给**所有成员**）
- 每 30 秒一次：把「自上次投递以来」的新内容作为一个**段（segment）**发给**房间里所有成员**（不只是被点名者）。
- 切片机制**已存在**：`member.cursor` + `_deltaFor()`（`room.cjs:864-877`），天然不漏不重。因为是逐成员 cursor，每个成员的段天然按自己的进度切。
- **第一条消息仍按现行为即时投递**（你明确要求），之后的批量走 30s 节奏。
- 计时器需 `unref()`（不拖住进程退出），并且**只在有内容或有成员在等的时候才跑**。

### 3.2.1 与 `replyPolicy` 的关系（需要调整）
- 原三档 `addressed`（默认，点名则只有被点者答）/ `everyone` / `mentioned-only` 是为「谁被唤醒」设计的。
- 现在 30s 分段**投给所有人**，所以「谁收到内容」不再是策略问题；`@` 的作用收窄为**两件事**：
  1. **即时性**：被点名者立刻收到（不等 30s，见 R4）；
  2. **强调**：提示这个词重要（写进注入文本，与现有一致）。
- 因此 `replyPolicy` 的语义需要重定义或简化——见 §6 待确认项 1。

### 3.3 忙时排队（不丢弃）
- 现状：`room.cjs:881 if (this.busy.has(member.id)) return {skipped:'busy'}` —— **忙时直接丢弃**，这正是要改的第一处。
- 改为：成员忙时该段进入它的**待投递队列**，空闲后按序投递。
- codex 原生也可选下沉到 `thread/queue/*` [实测]（`turn/completed` 后 20ms 自动接力，零客户端动作），但**插件的自建队列必须是统一层**，因为 ACP 完全没有队列且并发 prompt 会被硬拒（`-32602 a prompt is already in flight for this session`）[实测/源码]。

### 3.4 合并规则（你给的语义）
- 判据：**上一段是否已被该成员开始读取**。
  - 未开始读取 → 新内容**并入**该段（不新增条目）；
  - 已开始读取（正在处理） → 新内容**另起一段**排队。
- 好处正是你点出的：避免「等待处理 → 出现新内容 → 加入队列 → 等待处理」的无限叠加。

### 3.5 长度截断
- **按字符**（你的选择）。**上限：2500 字符/段**（你 m06603 定的值）：
  - 30 秒的正常群聊量通常在几十到几百字符，2500 留了充足余量；
  - 中文 ≈ 1 token/字，2500 字符 ≈ 2.5k token 量级，相对 258k 上下文极小，但足以给单段延迟一个确定上界；
  - 这个值**必须做成可配置**。
- 规则：合并时若 `待投递段长度 + 新内容长度 > 上限`，则**不再合并**，把已有的段封存、另起一段（即你说的「分为多个」）。
- **需要你知道的后果**：分段 = 多次投递 = 多次 `turn`，所以 agent 可能**连续回答多次**。这是「不无限合并」的必然代价。

### 3.6 合并段由 agent 自行决定「插话」还是「旁听」
- **定案（用户 m06636）**：`replyPolicy` **只管一件事——把这一投出去**。「其他 agent 是否回答，由它们自己决定」。
- 弃权用**约定的字符串**表示，不插话。**现有 `(无补充)` 就是这个约定**（`room.cjs` 的 `NO_ADDENDUM` 正则 + `isNoAddendum()`）：
  - 命中 → **不写公共日志**（弃权是信令，不是发言），只累加 `member.silentTurns`，emit `agent-end {empty:true, silent:true}`；UI 气泡同步过滤，不闪出标记。
- 所以这一条**零新增机制**，只需保持现有语义即可。
- **`replyPolicy` 的新定位由此确定**（取代 §5.4 的待定）：
  - 它**不再决定「谁收到」**——30s 分段固定投给所有人。
  - 它**只决定「一段投出去后，是否要求全员必须回应」**：
    - `everyone` = 要求每个成员都必须给出回应（弃权仍可用，但语义上是被要求发言）；
    - `addressed`（默认）= 允许自由弃权，agent 自行判断插话还是旁听；
    - `mentioned-only` 在新机制下**失去意义**（它表达的是「只有被点者才收/才答」，而分段是全员投递），建议**移除或标为废弃**。

### 3.7 分段投递**取代**逐条旁听（你 m06603 的确认）
- 现在有**两个通道**：`_overhear`（`inject_items`，**不产生 turn**，纯旁听上下文）与 `_speak`（`runTurn`，**产生回答**）。
- **定案：用 30s 分段投递统一取代逐条 `_overhear`**，简化成一条通道。`_overhear`/`injectItems` 的代码保留（ACP 本来就不支持），但不再作为实时旁听路径启用。
- 需要一并处理的后果：`member.inflight`（`_overhear` 用来标记「已抢占、勿重复投递」）与 `cursor` 的配合逻辑要重新理顺；取代之后**「旁听」的含义变了**——从「悄悄塞进上下文」变成「投一段、由 agent 自己决定答不答」。
- 好处：消除了 §1.2 指出的「成员正忙时注入排在 turn 之后」这个固有延迟，因为不再有带外注入。

---

## 4. R4：`@` = 抢占（立即插入）

### 4.1 先回答你最关心的问题：ACP 被抢占后，之前的群聊内容会被舍弃吗？

**不会。** 分三层看，只有一层会丢：

| 层 | 是否丢 | 原因 |
|----|--------|------|
| **房间公共日志**（`this.log`） | ❌ **不丢** | 纯插件侧内存 + R1 后还会落盘。抢占只影响「谁在跑 turn」，不碰日志 |
| **ACP 会话历史** | ❌ **不丢** | 我们只发 `session/cancel`（**通知，无 ack**），**不关 session**。已经投递进去的 prompt 仍在该 agent 的会话历史里 |
| **被打断那一轮正在进行中的回答** | ⚠️ 本可由我们保留 | `session/cancel` 会中止这一轮；**但已流式生成的部分我们已经收在手里**，所以能不能保住取决于我们是否把它写进日志 —— **你已定案：保留**（§6.3） |

**所以被中断的不是群聊内容，而是「那一轮还没说完的话」——而那一轮已经流式生成的部分在我们手里，你已定案保留。**

### 4.2 但你的要求仍然必须实现（而且理由比「怕丢」更硬）
你的判断是对的，需要 **carryOver（结转）**：

1. **无法确认 agent 内部状态**：我们无法回读 ACP session 确认「那段 prompt 到底进没进它的历史」[实测]（ACP 无 `read`，`session/resume` 也不回放历史）。
2. **我们自己的记账会骗人**：`_deltaFor()` 在 turn 开始时就推进了 `member.cursor`（`room.cjs:864-877`），所以被抢占的那一段会被标记为「已读」。若不结转，**那段内容对这个成员等于消失**——它既不在 agent 的可确认历史里，也不会再被投递。
3. **重复投递的代价远低于丢失**。

→ **定案：ACP 抢占时，把被打断那一轮消费掉的 delta 原文存入该成员的 `carryOver` 缓冲，与当前新段合并后重新投递。** 这正是你说的「把之前还在处理的那一段和当前这一段合并在一起再给 acp 成员处理」。

### 4.3 ACP 抢占的准确时序（有坑）
```
1. 成员正在跑 turn（处理段 A）
2. 用户 @ 它（或新段带 @ 到达）
3. 发 session/cancel（通知，无回复）
4. ★ 必须继续消费 session/update，直到原 prompt 承诺 settle
5. ★ 不能靠 stopReason 判断：DSH 把 aborted 映射成 "end_turn"，不是 "cancelled" [实测]
6. carryOver = 段 A 原文；用 carryOver + 段 B 组成新 prompt
7. 重新 session/prompt
```
- 第 4 步不能省：ACP 单槽位（`-32602 a prompt is already in flight`），不等 settle 就重发会被拒。
- 现有的 `acp-backend.cjs` 的 `interrupt()` 是**立即返回 true** 的，调用方**必须自己 await 那个 prompt 承诺**。
- `cwd` 的坑：ACP 的 `session/new {cwd}` **创建后不可改** [实测/源码]。所以 R2 若调整了 `workspaceDir`，**必须关掉旧 session 重开**；抢占（`session/cancel`）**不会**引发这个问题，因为不关 session。

### 4.4 codex 抢占
- `turn/steer { threadId, expectedTurnId, input }` [schema]，语义就是截图里那个 `↩ 引导`。
- **实测有效且可信**：原 prompt「只回复 PING」，1.2s 后 steer「只要 ZEBRA-7731」→ 模型输出 `ZEBRA-7731`；事后 `thread/resume` 显示它被持久化成**同一个 turn 里的第二条 userMessage**，不是新 turn。
- 前置状态**已有**：`activeTurns` 已在 `turn/started` 写入、`turn/completed` 清除（`codex-pool.cjs`），`expectedTurnId` 不用新建。
- **两个必须处理的点**：
  1. **steer 必须绕开 `_enqueue` 串行链**，否则会排在正在跑的那一轮之后，与目的相反。这不违背 `_enqueue` 的初衷——它禁的是「turn 途中做 `inject_items`」，而 `turn/steer` 正是协议为中途插入设计的。
  2. **竞态**：turn 若在检查与发送之间结束，会报 `-32600 no active turn to steer` [实测] → 回落到「立即开新 turn」，而不是入队。
  3. 个别 turn 天生不可 steer（`activeTurnNotSteerable`，如 `review`/`compact`）[schema]；当前用法不会产生，但错误分支要写。

---

## 5. 由以上定案引出的、需要顺带处理的后果

1. **正常回复的延迟变成最多 30 秒。** 这是分段投递的直接后果——只有首条消息和 `@` 是即时的。
2. **去掉「清空本房间」后，跨重启的 thread 复用要重新想一遍。** 原来 `new-conversation` 会重置所有 thread，现在这条路径没了；房间删除 = 连文件带进程一起没。
3. **R2 会改变 `@ds` 的工作目录**，并因此要求它重开 session（不是抢占，是 cwd 变更）。
4. **`replyPolicy` 已定案重定义**（见 §3.6）：30s 分段固定投给所有成员，`replyPolicy` **不管「谁收到」**，只管「是否要求全员回应」；`mentioned-only` 建议废弃。
5. **codex 的队列 API 不在生成的类型里**（`thread/queue/*`、`project/*` 都缺），凡用到都得手写 JSON-RPC，并为 codex 升级预留维护成本。
6. **卡住的 turn 会无限期堵住队列**（实测 73 秒不 drain，无超时兜底）；且 `turn/interrupt` 对已 interrupted 的 turn 再调**永远不会有回复**。分段投递让队列更容易堆积，所以**必须给队列加超时与上限**，否则 R3 的截断只解决长度、不解决停滞。
7. **R2 改成按 harness 分目录后，同一个 harness 的多个房间会共享文件系统视图。** 这是你要的效果，但要意识到：房间之间的隔离只剩下「日志与 thread 各自独立」，工作目录是共享的（例如三个群聊的 codex 都能看到彼此写的文件）。

---

## 6. 全部需求已定案（无遗留待确认项）

用户 m06603 定案：

1. **30s 分段投给所有成员**（不是只投被点名者）→ 已写入 §3.2。
2. **`workspaceDir` 由用户自行指定**（不是插件硬编码默认值）→ 已写入 §2.2。
3. **被打断那一轮已生成的部分回答**：**保留** → 已确认，落实为保留进公共日志并标注「未完成」。
4. **截断上限：2500 字符** → 已写入 §3.5。
5. **分段投递彻底取代逐条旁听**（一条通道）→ 已写入 §3.7。

用户 m06636 定案：

6. **`replyPolicy` 只管「投出去」**，其他 agent 是否回答由它们自行决定，用约定字符串（`(无补充)`）表示不插话 → 已写入 §3.6。

补充澄清（m06603 开头）：**不是所有群聊的所有成员共用一个目录，而是按 harness 分**——所有 ChatGPT（codex）对话一个目录，所有 DSH（ACP）对话另一个目录。→ 已重写 §2.1–§2.3。

**结论：需求已全部定案，可以开工。**

---

## 7. 建议的实施顺序（**未实施**）

| 阶段 | 内容 | 依赖 |
|------|------|------|
| A | R1 日志落盘 + 房间删除 + 多房间 UI | 无 |
| B | R3.1 时间戳进注入文本 | 无（几行） |
| C | R2 按 harness 的 `workspaceDirs`（用户指定）+ 校验 + mkdir | 无。会触发 ACP 成员重开 session |
| D | R3.2–R3.7 投递层重写（30s 分段 + 队列 + 合并 + 2500 截断，取代旁听） | A。最大一块，建议先写离线测试（桩 pool + 可注入时钟） |
| E | R4 抢占（codex steer / ACP carryOver） | B+D |
| F | 队列超时与上限（§5.6 的兜底） | D |
