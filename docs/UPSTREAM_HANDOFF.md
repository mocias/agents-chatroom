# HANDOFF

交接文档：给下一个接手 `dsh-agent-room` 的人（或 agent）。本文只写**当前状态、边界和坑**，
不重复 README 与 commit message 已经写清楚的内容。

- 仓库用途与安装：见 [README.md](README.md)
- 本次改造的完整说明：见 commit `d6b3220` "Replace the generic acp backend with per-harness agents"
- 更早的两个 commit：`e701260`（MIT 许可）、`c90f0a5`（初版）

---

## 1. 当前状态

| 项 | 值 |
| --- | --- |
| 分支 | `master`，与 `origin/master` 同步 |
| HEAD | `d6b3220` "Replace the generic acp backend with per-harness agents" |
| 仓库可见性 | private |
| 纳入版本控制的文件 | 17 个（`lib/`、`public/`、README、LICENSE、配置） |
| 离线测试 | 25/25 通过（约 22 秒） |
| 变异测试 | 20/20 全杀 |

已注册的 harness（也就是「添加成员」下拉框里的选项）：

| backend | protocol | 启动方式 |
| --- | --- | --- |
| `codex` | `codex-app-server` | 本机 codex 可执行文件 |
| `dsh` | `acp` | DSH 自带的 `--profile acp` |
| `qoder` | `acp` | `qoder --acp` |

---

## 2. 核心设计：协议 ≠ 产品

这是整个改造的立足点，改任何 harness 相关代码前必须先理解：

> `acp` 说明**怎么**跟一个 agent 对话，不说明**它是哪个** agent。

改造前「添加成员」只有一个 `acp` 选项，把协议和产品混为一谈：所有支持 ACP 的产品塌缩成
同一个选项，而某个具体产品的启动行只能手写。

现在每个产品一个 backend id，各自一条注册表条目。**代码里只有两种协议实现**：

- `codex-app-server` → `lib/codex-pool.cjs`
- `acp` → `lib/acp-backend.cjs`

**加一个 harness = 加一条描述，不是加一条代码路径。** 注册表在 `lib/harnesses.cjs` 的
`HARNESSES` 数组里。

### 后端抽象

`lib/room.cjs` 每个 backend 名一个 pool（`this.pools: Map`）。每个 pool 必须提供同一套方法面：
`start`/`stop`/`pid`、`modelCapabilities`、`openThread`/`getThread`/`closeThread`、`runTurn`、
`interrupt`，可选 `steer`。

### 分层规则（只写在 `mergeLaunch` 一处）

**逐 key 覆盖：配置赢。唯一例外是 `env`，它合并。** 原因：某个 harness 可能需要
`ELECTRON_RUN_AS_NODE` 才能算一个能跑的 node，用户配置里多加一个变量不能把它挤掉。

`launchOptions(id, configured)` 返回**未经合并的默认层**；未知 harness 返回 `{}`，
让 pool 自己的「no ACP agent configured」错误浮上来。

### `enabled === null` 的语义

`lib/harnesses.cjs` 的 `HarnessStore`：

- `null` = **自动**：探测到什么就提供什么，`codex` 永远兜底。
- 存了数组 = **用户决定**，逐字遵从。显式 `[]` 是合法选择，必须存活。

注意：codex 兜底**只属于自动模式**。存了列表就不要再塞 codex 进去，否则等于无视用户。

---

## 3. 可运行入口

```powershell
# 离线全套（安全，不花额度）
node test/run-all.cjs

# ⚠️ 绝不要跑 --online：会起真实 codex，消耗机主的 ChatGPT 额度
# node test/run-all.cjs --online

# 单个测试
node test/harnesses.cjs
```

变异测试（`_research/mutate-harnesses.cjs`，不发布）：

```powershell
node _research/mutate-harnesses.cjs
```

**变异测试是新断言的验收标准。** 每加一条断言，都要问「把它测的代码改坏，这条断言会红吗」。
本轮就是靠它抓出了一个真实 bug（见 §5）。

---

## 4. 环境与路径

用**打包的 node**，它有 `zlib.zstdDecompressSync`，系统 node 没有：

```
<DSH_RUNTIME>/dependencies/node/bin/node.exe    # v24.21.0（用它）
C:\Program Files\nodejs\node.exe                # v24.13.0
```

本文档不写本机绝对路径。实际位置：

- `DSH_RUNTIME`：DSH 的 runtime 目录
- `DSH_HOME`：默认 `%USERPROFILE%\.dsh`
- `PROFILE_DIR`：本机是 `$DSH_HOME\profiles\desktop`，即 `DSH_PROFILE_DIR`

profile 层的现状（**不在仓库里**，属于机主个人配置）：

- `cordis.patch.yml` 里 `workspaceDirs` 有 `codex` 与 `dsh` 两项。
  原先手写的 `backends.acp` 整块已删除，因为 `launchDsh` 会推导出逐字节相同的一行。
- `dsh-peer-account-route.yml`：账号路由补丁。**个人文件，刻意不进仓库**，
  `peerAccountPatch()` 只在 profile 目录里发现它。见 §7。

---

## 5. 已经踩过的坑（照做，别重蹈）

### 5.1 绝不要用 PowerShell 文本 cmdlet 改源码

本机 PowerShell 是 5.1 Desktop，`[System.Text.Encoding]::Default` 是 **gb2312**。
`Get-Content -Raw` + `Set-Content` 会把 UTF-8 当 GBK 读，每个多字节字符塌缩成 `?`
**并吃掉后面一个字节**。

这真实发生过：`lib/harnesses.cjs` 被毁掉 35 处、22292 → 22257 字节，还吃掉一个换行。
当时该文件未被 git 跟踪，没有干净副本。

- 改文件只用 `read`/`write`/`edit` 工具，或 Node 的 `fs.readFileSync`/`writeFileSync`（显式 `'utf8'`）。
- `test/encoding.cjs` 就是为此存在的守卫：对 `lib/`、`public/`、`test/` 做严格 UTF-8 解码。
- `_research/mutate-harnesses.cjs` 全程走 Node 读写字，并有 `finally` 还原 + 逐字节校验。

### 5.2 Windows 上 spawn 一个 npm 安装的 harness

已实测（结论是决定性的）：

- `spawn('npx')` / `spawn('qoder')` → **ENOENT**。Node v24 **不做 PATHEXT 查找**。
- `spawn('<绝对路径>.cmd')` → **同步抛 EINVAL**（Node 20+）。
- `shell: true` 能跑，但报 `DEP0190` 弃用警告，且会弄坏带空格/元字符的参数。
- `cmd.exe /d /s /c <shim.cmd> <args>`：带空格的 shim 路径会失败，`&`/`|`/`"` 也会失败。

**干净路线：`node <pkg>/bin/<entry>.js <args>`，走 pipes。**

所以 `lib/harnesses.cjs` 里的处理是：

- 解析 `.cmd` shim，取出它真正要跑的 `.js` 入口。
- **Windows 上跳过无扩展名的 PATH 命中**——npm 会在每个 `.cmd` 旁边放一个 POSIX shell 脚本
  （`codex`，无扩展名），那个文件在 Windows 上不可执行。返回它只会得到一个必定失败的启动器，
  比报「未找到」更糟。
- 拒绝 `.ps1`。

### 5.3 `canonicalBackend` 的原型链泄漏

`LEGACY_BACKENDS` 若是普通对象字面量，`LEGACY_BACKENDS['constructor']` 会返回 `Object`
**构造函数**，`['__proto__']` 返回一个对象。一个叫 `constructor` 的 backend 名会变成 pool key，
然后在离病因很远的地方炸掉。

现在：`Object.create(null)` 建表 + `typeof mapped === 'string'` 双重守卫。变异测试里
「两个防线同时拆掉」是必杀项——只拆一个测不出来，因为两重防御彼此冗余。

### 5.4 其它

- `which()` 返回**单个路径或 `null`**，不是数组。
- `launchableFrom()` 返回 `{binary, argv, env, via}`，不是 `{command, args}`。
- `git grep --cached`：正确写法是 `git grep --cached -n -I -E <pat>`（`--cached` 在子命令后）。
  退出码 1 = 无匹配。
- 本机跑 `.ps1` 文件被执行策略挡住（未签名），把逻辑写在 `pwsh -Command` 里跑。
- `pwsh` 里的相对路径按会话工作目录解析，**不是** `cd` 之后的目录；用绝对路径。
- PowerShell heredoc 写 commit message 会坏，改成写 `%TEMP%` 文件再 `git commit -F`。
- `gh api ... --jq` 会被 PowerShell 弄坏 jq，去掉 `--jq` 再 `ConvertFrom-Json`。
- `git push` 曾因代理失败（WinINET 代理 `gh` 认、`git` 不认）。若复现：
  `git config --local http.proxy <proxy>`。

---

## 6. 未完成 / 可继续的

### 6.1 待你确认：设置行需要重启 DSH 才可见

`设置 → 通用 → Agent 群聊可用后端` 这一行**已写进代码并已提交**，但宿主模块代码在 DSH
**启动时**载入，所以当前运行中的服务仍对 `/agent-room/harnesses` 返回 404。

**重启 DSH 后才会出现。** 这是重启边界，不是故障。

接口层已在**进程内**跑通（真实路由 handler + 真实 socket）：自动模式、手动选择、强制开启标记、
持久化、`?refresh=1`。但**没有在真实 GUI 里目视确认那一行的渲染**——重启后请过一眼。

### 6.2 有意没做的 harness

用户明确决定**先不做**（原话：「先不做这三个，后面再慢慢补充」）：

- `claude`（`@agentclientprotocol/claude-agent-acp`）
- `gemini`（`gemini --acp`）
- `codebuddy`

加它们只是在 `HARNESSES` 里加一条描述，约 10 行。三个 ACP 启动形态：

- `--acp` 旗标：gemini、qoder、cline、copilot、codebuddy
- `acp` 子命令：bob、devin、goose、kilo、kimi、opencode、cursor 等
- 无参专用二进制：claude-agent-acp、codex-acp、amp-acp 等

ACP harness 权威注册表：<https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json>（42 个 agent）。

注意：`@zed-industries/claude-code-acp` 已**弃用**，现行是 `@agentclientprotocol/claude-agent-acp`。

### 6.3 WorkBuddy：实证否定

`@workbuddy/cli-vnext` 里 "acp" 出现 **0 次**。接不了，且按用户决定**完全没有出现在代码里**，
也没有用 codebuddy 顶替。

### 6.4 codex 的原生协议不是 ACP

codex 走自己的 `app-server` JSON-RPC。不要试图把它挪到 ACP 实现上。

### 6.5 ACP 成员仍是纯文本（有意为之）

`lib/acp-backend.cjs` 刻意忽略 `options.attachments`；图片路径是塞进 prompt 文本里的。
codex 拿到的是真实的 `{type:'localImage', path}` 条目。**这个不对称是设计，不要「修」它。**

---

## 7. 个人配置：不进仓库

上轮清理已把个人/开发残留移出仓库（用户已批准）：

- `FEASIBILITY.md`、`REQUIREMENTS.md` → `_research/design-docs/`（不发布）
- `dsh-peer-account-route.yml` → **从仓库删除**。profile 层有一份逐字节相同的副本，
  且只有 profile 那份真正生效。

**为什么这个账号路由补丁是必需的**：`dsh --profile acp` 默认走
`provider: deepseek-official`（API key 路线），而桌面端登录的是 `deepseek-account` 路线。
没有这个 overlay，ACP peer 每一轮都会失败：

```
llm-deepseek: no API key for provider route "deepseek-official"
```

### 仓库现在的取舍

`test/`（39 个文件）与 `_research/` 都已加进 `.gitignore`：

- **测试仍在磁盘上，仍可运行**（`node test/run-all.cjs`），只是不发布。
- 用户的原话是「测试文件不需要装到仓库中」，本仓库只装插件。

### 一条活着的兼容性约束

本机持久化的名册里，`deepseek` 这个成员的 `backend` 仍是旧的 **`"acp"`**。

`LEGACY_BACKENDS` / `canonicalBackend` 存在的唯一理由就是它：一次天真改名会让
`_createPool` 抛 `unknown backend: acp`，**整间房起不来**。已验证 `acp → dsh` 折叠正常。
改这一块之前请先想清楚这条。

---

## 8. 建议加载的技能（suggested skills）

| 技能 | 什么时候用 |
| --- | --- |
| `diagnose` | 遇到难查的 bug（尤其是 spawn / 进程存活 / 时序类）时，走「复现 → 最小化 → 假设 → 插桩 → 修 → 回归」 |
| `tdd` | 加新 harness 或改 `room.cjs` 行为时，先写红测试 |
| `playwright` | 需要在**真实浏览器**里确认右侧栏 tab、设置行、上传交互的渲染时 |
| `skill-creator` | 想把本仓库的验证套路固化成可复用技能时 |
| `handoff` | 再次交接时 |

另注：本机没有 `code-review` 类技能；代码审查请以「变异测试 + 离线全套」为准。

---

## 9. 首要下一步

1. **重启 DSH**，确认「设置 → 通用 → Agent 群聊可用后端」这一行出现且可交互。
2. 在真实 GUI 里加一个 `qoder` 成员（若本机装了 Qoder）或 `dsh` 成员，验证成员真的能起会话。
   注意 `dsh`/`qoder` 在本机 PATH 上都不存在，`dsh` 只在 DSH 桌面端进程内算「已探测到」。
3. 若要继续补 harness，见 §6.2——加描述即可，然后补测试与变异项。
