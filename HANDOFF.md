# Agents Chatroom — Handoff

交接日期：2026-10-16。源码版本 0.1.10，新仓库 agents-chatroom。保留包名 dsh-agent-room、原 MIT LICENSE 和插件入口。本文区分已实现、已验证和未完成事项。

0.1.8 更新：默认工作区改为桌面安装目录/agents/backend/Agent名称；浏览器默认源码根/agents，支持 AGENT_ROOM_WORKSPACE_ROOT；旧路径不迁移。添加删除操作，默认保留文件，删除文件需完整路径确认，禁止共用/嵌套工作区、磁盘根、应用数据祖先、符号链接/联接。删除联系人移除单聊入口与群成员，保留群聊记录、底层日志和原后端记录。安装包构建不等于用户已安装版本更新。

同步未完成：standalone/desktop-sync.cjs 使用新版 project/create + thread/start.projectId，为每个 Agent 创建稳定项目，不采用原来的项目轮换删除。真实两次 SYNC_OK 已验证后端持久化关联，但 Codex 桌面 list_projects 没有显示新项目；本机桌面还维护 local-projects 缓存，不能宣称 GUI 可见。DSH workspaceRegistry 在桌面宿主；Qoder 的 chat_sessions / sidebar / messages 与 ACP 存储分离，目前返回 unsupported。不要绕过接口直接覆盖运行中应用的状态文件或数据库。下一步必须接通各宿主的受支持注册/导入接口并做 GUI 验收。

提示词精确结构见 docs/PROMPTS.md。创建 Agent/群聊无生成请求，首次消息才打开会话。新增 checks/desktop-sync.test.cjs、删除目录检查；真实脚本 scripts/check-native-codex.cjs 只证明后端关联，不证明桌面可见。

0.1.8 初始阶段验证：26/26 回归；打包 smoke `output/desktop-smoke-exb3Jx/report.json`；默认 EXE 同级 agents 根 `output/default-root-tDy4F6/report.json`；NSIS 保留宏隔离执行 `output/installer-preserve-lRIIFE/report.json`；DSH/Qoder 角色指令真实回复 `output/persona-live-J3wtcF/report.json`。宏位于 desktop/preserve-agents.nsh，升级/卸载保留 agents，不能退回默认递归删除安装目录。详细证据边界见 DESKTOP_VALIDATION.md。

0.1.10 WorkBuddy：通过已登录桌面的 supervisor 创建本机 ACP HTTP 运行时，复用桌面登录，每位群成员使用独立运行时。**当前只实测过 WorkBuddy AI 国际版 5.8.4；WorkBuddy 国内版没有实测。** 国内版仅有后端注册、安装识别和离线测试，不能据此宣称真实接入成功。完整实现流程、复现命令、证据及限制见文末“0.1.10 WorkBuddy 接入流程与实测边界”。

## 1. 产品目标与接手任务

独立多 Agent 聊天应用，微信式左侧联系人/群聊、右侧对话。原有后端为 Codex、DSH、Qoder，0.1.10 新增 WorkBuddy 接入（国际版已实测，国内版未实测）；同一类可以添加多位联系人。搜索旁 + 添加 Agent；多选联系人建群。第一版仅 CHAT、附件和外观设置。

后续用户要交给 DSH，把 Qoder 桌面后端和工作区能力移植回原插件。独立应用已接入，原插件未完整移植。Qoder 接入与工作区移植指南由用户另行提供，作为本地独立文档保存，不纳入本仓库；不要将其中待办描述为已实现。

## 2. 架构地图

| 文件 | 职责 |
| --- | --- |
| standalone/server.cjs | 通讯录/群聊持久化、HTTP、扫描许可、模型和推理接口、房间生命周期 |
| standalone/public/ | 独立前端，无构建步骤 |
| standalone/discovery.cjs | 自动发现、手动配置、候选优先级、ASAR 识别、启动参数 |
| standalone/windows-harnesses.ps1 | 只读 Windows 安装记录、进程、应用包和快捷方式发现 |
| standalone/models.cjs | Codex model/list、DSH/Qoder ACP configOptions 查询 |
| standalone/workspaces.cjs | 路径校验、默认目录创建、名称冲突处理 |
| standalone/qoder-worker.cjs | Qoder 内置 Worker 到 ACP 标准输入输出的桥接 |
| standalone/workbuddy.cjs | WorkBuddy 版本识别、安装包校验和桌面运行时启动配置 |
| desktop/main.cjs | Electron 窗口、原生选择器、每次启动本地服务访问凭证 |
| desktop/builder.cjs | Windows x64 NSIS 构建 |
| lib/room.cjs | 群聊调度、分段投递、CHAT 策略、会话与历史 |
| lib/codex-pool.cjs | Codex app-server 协议、模型和推理能力 |
| lib/acp-backend.cjs | ACP 启动、会话、流式回复、取消、配置 |
| lib/workbuddy-pool.cjs | 复用当前用户 WorkBuddy 桌面登录、独立运行时和 ACP HTTP 传输 |
| lib/index.js、public/ | 原 DSH 插件入口/UI，非 standalone |
| checks/、scripts/ | 自动回归和真实/桌面验收工具 |

## 3. 当前数据模型与行为

Agent 字段：id、label、backend、model、modelLocked、modelName、effort、workspace、persona、aliases、createdAt。新 Agent 从真实列表选模型并固定；旧联系人保留兼容行为。

Conversation 字段：id、kind、title、agentIds、updatedAt、preview，可含 efforts[agentId]。推理覆盖只作用于当前会话；群内不提供模型修改。后端模型不可用或拒绝应用时应报错，不静默切换。Qoder auto 是策略，不是固定具体模型。

workspace 自定义目录须存在；留空创建 agents/backend/Agent名称。非法字符/保留名/冲突由工具函数处理。新房间创建独立后端会话，但同一 Agent 使用同一 cwd。旧 Agent 保存原路径，不搬文件。

Codex 自动选择优先运行中的桌面托管后端，其次其他桌面入口，最后 npm/PATH；手动指定优先。DSH 通过自身 EXE + ASAR CLI + acp profile 启动，并使用已有账户路由补丁。Qoder 使用已安装产品附带的 Worker，不重新分发运行时。

## 4. 扫描许可与安全边界

首次启动或升级旧数据时，discovery-consent.json 不存在就先弹窗。automatic 表示允许后续自动发现，manual 表示只检查用户明确指定文件。后台限制不能只靠 UI；目录输入在手动模式拒绝。

读取范围包括安装记录、进程可执行路径、快捷方式、PATH、相关安装目录，不读取聊天或认证内容。允许扫描不等于允许删除旧安装。

桌面本地服务使用随机端口和每次启动的访问凭证，渲染器 sandbox/contextIsolation 开启，无 Node 集成。普通浏览器模式是 loopback 服务；两种数据目录分开。

cwd 不是权限沙箱；Codex 有只读策略，ACP 实际权限取决于后端。不得统一宣称完全禁止写文件或访问目录外文件。

## 5. 运行、构建和数据目录

```sh
npm start
npm ci
npm test
npm run desktop
npm run desktop:dist
```

浏览器默认 127.0.0.1:4318，数据 .agent-room-data/；AGENT_ROOM_DATA 可覆盖。桌面默认 %APPDATA%/Agent Room/data，AGENT_ROOM_DESKTOP_HOME 可隔离测试用户目录。聊天数据不放安装目录。

主要持久化文件：catalog.json、backend-preferences.json、discovery-consent.json、rooms/*.log.jsonl。旧 backends.json 仍兼容。附件/主题由 RoomApi 原有模块维护。

固定构建依赖：Electron 44.7.2、electron-builder 26.15.3。构建使用 node_modules/electron/dist，首次安装依赖需要下载 Electron。代理使用目标环境自己的配置，不照抄原机器端口。

源码不包含 node_modules、dist、output、用户数据、凭据、第三方运行时。安装包未签名，无自动更新；构建新包不等于升级用户已安装版本。

## 6. 验证证据与复现

详见 [DESKTOP_VALIDATION.md](DESKTOP_VALIDATION.md)。里面 output/ 路径为本机历史报告，不随源码上传；新环境应重新生成，不能要求仓库中一定有这些报告。

- 当前离线/本地接口回归 50/50 通过：扫描许可、持久化、目录规则、模型锁定、推理隔离、附件和群聊。
- Codex/DSH 真实模型选择，low/high 各一轮回复通过；各创建两个同 cwd、不同 session ID 的会话通过。
- Qoder CN 0.4.8 内置 Worker 的 initialize、新会话、真实回复通过；打包 Electron 也完成真实回复。官方登录已在原机器完成，不代表新机器无需登录。
- 当前本机 Qoder 返回 15 个模型，无 thought_level。数量和模型随账户/版本变化。
- 0.1.7 打包 smoke 通过首次拒绝→允许扫描、三种后端添加、群聊、工作区、附件、主题和重启恢复。选择器返回值是模拟，不算人工原生选择器验收。
- 0.1.0 曾实际安装/卸载；之后主要验证打包 EXE，未逐版重复安装器全流程。

```sh
node scripts/check-live-models.cjs
node scripts/check-live-workspaces.cjs
node scripts/check-live-qoder.cjs
node scripts/check-desktop-qoder.cjs
npm run desktop:smoke
```

真实脚本要求安装及登录；部分会发送模型请求并消耗额度，部分仅创建会话。使用隔离目录。check-desktop-discovery.cjs 可用 CHECK_REAL_DSH=1 验证 DSH 初始化。开发脚本直接调用发现器，不代表产品 UI 能绕过许可。

## 7. 重要已知限制

1. 原插件的发现/UI/roster 序列化/宿主归档尚未完整接入；详细修改点见用户另行提供的本地移植指南。
2. 本地历史恢复不等于原生 session ID 恢复。runtime 闲置释放或进程重启后可能新建后端会话并重放历史。跨重启 session resume 仍需专门实现与测试。
3. ACP 附件主要传本地路径。即使 Qoder 宣告图片能力，也未接原生 ACP 图片块；Codex 使用原生图片输入。
4. 暂无 Agent 编辑、单独增删群成员、已有 workspace 迁移、跨设备同步、WORK UI、代码签名和自动升级。0.1.8 已添加全局删除 Agent。
5. 发现入口不等于账号/网络可用。模型查询会启动后端，ACP 可能创建能力查询会话。
6. Qoder 内部布局随升级可能变化。本次实测 CN 0.4.8，不能泛称所有版本都支持；国际版识别只是候选逻辑。
7. 模型查询目前使用后端默认工作目录，没有按 Agent 自定义 workspace 枚举项目级提供商配置；未来应把 cwd 纳入查询及缓存键。
8. BackendDiscovery 默认 allowAuto=true；应用层显式关闭直到授权。插件侧不得遗漏这个开关，也需审计旧注册表自动发现路径。
9. 旧历史文档的分支、测试数量、已实现范围仅代表上游当时状态。新 README/HANDOFF 与最新验收记录优先。
10. 扫描关闭时，尚未配置后端的旧会话浏览可能被 runtime 校验阻止。后续可解耦历史查看和后端初始化；必须保证不会因此触发未授权发现。

## 8. 建议接手顺序

先跑回归，结合用户另行提供的本地移植指南，从一个 Qoder Agent + 一个工作区做插件纵向闭环，再扩展群聊和 UI。每一步记录发现→initialize→session/new→prompt，不能把握手成功当完整聊天成功。

优先补插件字段持久化和 createSessionFiler 的 cwd 优先级，再验证独立会话及更新兼容。避免复制 standalone DOM ID、默认数据目录等宿主专属假设。

新私有远程名 agents-chatroom；origin 保持上游 mocias/dsh-agent-room。后续推送前检查 git remote -v，避免误推上游。本次保留原 Git 历史及 MIT 归属。

## 9. Suggested skills

- diagnose：先复现协议/进程/Electron 差异，再修复。
- playwright / computer-use：界面与真实打包程序验收，注明模拟步骤。
- handoff：持续记录已实现、已测试、待验证，不把历史测试冒充当前结果。

用户习惯：完成授权范围内的实际工作；不要把构建宣称为已安装版本升级；未经明确要求不要删除后端旧版本或移动工作区。

## 2026-10-16 界面与点名修复

- 单聊成员按钮直接打开 Agent 设置，可改工作区及当前会话推理强度；群聊先选择成员。固定模型只读。
- 工作区修改作用于该 Agent 所有会话；等待相关回复结束，释放旧运行会话并保留历史与原文件，不自动迁移文件。
- 左侧 Agent 右键菜单提供置顶/取消置顶与删除；置顶持久化，删除继续使用工作区保留/删除确认。
- 身份指令、发言人标签、每轮成员名册改用显示名；点名匹配支持小数点、空格、中文，旧内部 ID 仍兼容解析。历史正文不改写。
- 回归 28/28 通过；打包桌面实测 12 项通过，证据 output/desktop-smoke-4mkvqt/report.json。原桌面同步仍未完成。

## 2026-10-16 滚动、输入提及和重命名

- 页面锁定为窗口高度，消息区和联系人列表分别滚动；头部、输入框、左侧底部操作固定。
- 输入 @ 弹出当前会话成员，按显示名筛选，支持方向键、Enter/Tab、鼠标选择与 Escape；候选存在时 Enter 不发送。
- Agent 和群聊右键菜单增加重命名。Agent 重名被拒绝；名称更新到单聊及提及候选，工作区路径保持原值。历史正文不改写；Agent 改名等待相关回复结束并释放旧运行会话，下次回复使用新身份。
- npm test 29/29；最终打包程序交互检查 output/composer-ui-3RNEFD/report.json 通过（长列表/历史采用隔离测试数据，不调用模型）。
- 桌面数据：%APPDATA%/Agent Room/data/catalog.json 保存联系人和会话索引，rooms/*.log.jsonl 保存历史，agent-room-files 保存已上传附件（使用后创建）。卸载默认保留用户数据及安装目录 agents；浏览器数据独立在源码 .agent-room-data（可由环境变量覆盖）。

## 2026-10-16 用户自定义数据目录

用户明确选择手动迁移。后端管理新增数据目录入口，保存 pending，下次启动校验手动复制结果后激活；不复制或删除源数据。可取消 pending，失败继续使用旧目录。桌面定位文件保存在 userData/data-location.json（位于 data 外）；浏览器在源码根 .agent-room-location.json（gitignored）。有已保存选择时优先该设置，AGENT_ROOM_DATA 作为浏览器初始默认值。

启动时核对源目录普通文件哈希与目标副本，缺失/不同拒绝切换。源目录已不存在时仍要求目标 catalog.json 与 rooms 有效。历史附件重新绑定当前附件目录；workspace 的绝对路径不自动迁移。桌面菜单打开当前生效的数据目录。旧目录保留，不修改用户工作区文件。

验证：npm test 32/32；打包桌面检查 output/data-location-ui-1Q2MWm/report.json 通过，涵盖 UI 保存、未复制时回退、完整手动复制后重启激活与 Agent 保留。

## 0.1.9 性能与群体提及

群聊输入 @ 候选和工具栏提及弹窗都支持“所有人”，仅路由给当前群聊成员，仍受现有接力轮次上限控制。parseMentions 同时兼容 @all、@全体。

流式 delta 不再重建历史 DOM：requestAnimationFrame 合并同帧更新，仅更新当前输出气泡；持久化快照仍刷新完整历史，未做历史分页或虚拟列表。scripts/benchmark-render.cjs 的 500 条历史 + 200 次同步 delta 合成对照：旧版 dispatch 6533.4 ms / 总计 6578.3 ms，新版 dispatch 0.2 ms / 总计 58.4 ms，历史节点保留且最终文本完整。此结果不代表真实网络/模型生成加速。

打包使用 maximum 压缩，Electron locale 保留 en-US、zh-CN、zh-TW。Windows 安装包由 111232183 降至 102699065 字节，减少约 7.7%；不裁剪 Chromium 核心、GPU 库或许可证。业务 app.asar 约 0.46 MB，体积主要来自 Electron。

33/33 回归；最终优化版桌面核心验收 output/desktop-smoke-CWhsSh/report.json 12 项通过；@所有人 两入口验收 output/composer-ui-uu7WUT/report.json。基准证据 output/render-benchmark-79Jfcj/report.json 和 output/render-benchmark-p4GH7n/report.json。输出报告本地忽略，脚本随源码提供。桌面原生项目同步仍未完成。

## 0.1.10 WorkBuddy 接入流程与实测边界

### 验证范围：只实测国际版，国内版没有实测

| 版本 | 后端标识 | 当前证据 |
| --- | --- | --- |
| WorkBuddy AI 国际版 5.8.4 | `workbuddy-ai` | 已在真实安装上验证桌面登录复用、ACP 初始化、模型读取与应用、独立会话、两位群成员真实回复，以及 UI 发送和 @ 提及 |
| WorkBuddy 国内版 | `workbuddy` | **没有实测。** 仅完成代码中的后端注册、安装识别及离线模拟测试；未完成真实桌面的初始化、登录复用、模型查询或聊天回复验证 |

本机国内版运行在另一个 Windows 用户下。当前连接器只查找当前用户的桌面运行时，尚未实现跨用户 helper/转发。国内版未实测不代表已确认不兼容，也不能把国际版成功推广为国内版成功。`checks/standalone.test.cjs` 中双版本同群测试使用模拟后端，`checks/workbuddy.test.cjs` 的国内版安装识别使用构造的安装目录，均不算国内版实测。

### 接入原理与前提

连接链路为：群聊 → 当前用户 WorkBuddy 桌面的 supervisor 控制管道 → 桌面创建的独立后端进程 → 本机 ACP HTTP/SSE → 群聊回复。

这里的 HTTP/SSE 是群聊与本机 `127.0.0.1` 运行时之间的通信。模型请求仍由 WorkBuddy 后端按其已有账号和网络配置处理；这不表示模型在本地运行。无需另行部署云端 ACP 服务，也无需在群聊中重新登录。

1. 在同一个 Windows 用户下打开对应版本的 WorkBuddy，保持桌面已登录，并先在桌面发送一条消息，以启动桌面的运行时及凭据引导。
2. 在群聊“后端管理”中保存对应桌面程序的完整路径。此次实测国际版为 `D:\WorkBuddy mocias\WorkBuddyAI.exe`；这是本机路径，其他机器必须重新选择，不能硬编码。
3. 添加 Agent 时读取后端实际返回的模型列表，选择并固定模型，再加入群聊。创建联系人/群本身不发送生成请求；读取模型会启动能力查询运行时，发送消息才触发实际回复。

### 实现步骤

1. **识别安装包和版本。** `standalone/discovery.cjs` 调用 `standalone/workbuddy.cjs` 的 `desktopLaunch()`，校验程序名及安装目录中的 `resources/app.asar.unpacked/cli/bin/codebuddy`、`cli/product.json`。国际版要求 `product.authentication.id` 为 `workbuddy-desktop-ai`，国内版候选要求 `workbuddy-desktop`，防止两个版本入口混用。启动配置带 `workbuddySupervisor: true`；`lib/room.cjs` 据此选择 `WorkbuddyPool`，`standalone/models.cjs` 也使用同一连接器。
2. **寻找当前用户的 supervisor。** `connectSupervisor()` 在当前用户主目录的 `.workbuddy-ai`、`.workbuddy` 候选中查找运行时描述文件。国际版本次实际使用 `.workbuddy`，因此不能仅凭配置目录名判断版本。对每个 `path.resolve(configDir)` 计算 SHA-1，取前 12 个十六进制字符作为 `hash`，读取 `os.tmpdir()/wb/<hash>/sidecar.pid`。描述文件包含 PID、控制管道 UUID 和本地控制身份信息；不得把其中的 token 写入日志或交接材料。
3. **核对桌面身份。** 查询描述文件 PID 对应的可执行文件，必须与用户选择的程序路径一致。连接 Windows 命名管道 `\\.\pipe\workbuddy-<hash>-sidecar-control-<controlPipeUuid>`，使用按行分隔的 JSON-RPC 调用 `sidecar.ping`，核对返回的 PID/token 与描述文件一致。仅连接已有桌面 supervisor，不另建登录流程。
4. **由桌面创建群聊运行时。** 生成本应用独有的 `agent-room-<UUID>`，向 supervisor 调用 `session.create`，指定已安装桌面 EXE、内置 CLI 入口、现有工作目录和 `port: 0`。supervisor 通过桌面的正常凭据引导把已有授权提供给子进程；群聊不读取/导出账号密钥，不复制账号凭据文件，也不调用 ACP `authenticate`。此前直接启动独立后端、要求单独登录的尝试已被这条流程替代。
5. **建立带认证的本机 ACP 连接。** 从创建结果取得 `acpEndpoint`、PID、`runtimeId`，仅接受有效的 `http://127.0.0.1:<port>` 地址。先 `POST <endpoint>/connect` 取得 `connectionId` 和可选 `sessionToken`，随后请求携带本应用临时生成的网关认证及 ACP 连接标识。`GET <endpoint>` 订阅 SSE；`POST <endpoint>` 发送 JSON-RPC，并兼容 JSON/SSE 响应。端口由运行时返回，不能复用历史报告里的端口。
6. **打开会话并传递消息。** 调用 `initialize`，再以每位 Agent 的实际工作区调用 `session/new`，从返回的 `configOptions` 学习模型和推理选项，通过 `session/set_config_option` 应用固定模型。发送使用 `session/prompt`，文本增量来自 `session/update` 的 `agent_message_chunk`，由现有 ACP/群聊逻辑显示并持久化。`session/cancel` 用于取消。
7. **按成员隔离运行时。** `WorkbuddyPool` 为每个成员分配独立的 `WorkbuddyConnection`，每个连接对应独立后端进程和 ACP 会话。此前共享单个运行时时出现过旧会话无回复/并发卡住；每成员独立运行时是当前已验证的方案。启动进程使用已有的房间数据目录，具体会话仍使用成员工作区，避免新后端缺少旧版默认目录导致启动失败。
8. **清理本应用创建的资源。** 关闭时中断 SSE、拒绝未完成请求、尝试 `DELETE <endpoint>` 关闭连接，并向 supervisor 调用 `session.kill`，只传本应用生成的 `sessionId` 及已返回的 `expectedRuntimeId`。不关闭 supervisor，不结束桌面原有任务，不调用 `sidecar.shutdown`。

### 启动配置与权限

由 supervisor 启动桌面 EXE 时设置 `ELECTRON_RUN_AS_NODE=1`，执行其安装包中的 CLI，主要参数为：

```text
<cli/bin/codebuddy> --serve --acp --acp-transport streamable-http
--strict-mcp-config --mcp-config {"mcpServers":{}}
--permission-mode plan --tools ""
```

这些参数由程序以参数数组传递，以上仅用于说明，不应复制成忽略空参数/引号的启动命令。supervisor 负责动态端口和凭据引导；不要绕过它直接启动并期待自动继承桌面授权。

环境中指定安装包自己的 `ACC_PRODUCT_CONFIG_PATH`、`CODEBUDDY_HOST=workbuddy-desktop`，以及已核验的 `CODEBUDDY_CONFIG_DIR` / `WORKBUDDY_CONFIG_DIR`；其余产品启动设置见 `desktopLaunch()`。`CODEBUDDY_GATEWAY_AUTH=password`，`CODEBUDDY_GATEWAY_PASSWORD` 是本应用随机生成、只用于这次本机连接的临时密码，**不是桌面账号密码或模型 API key**，不得落日志。保持接口认证开启。

当前用于 CHAT：不向 ACP 宣告客户端文件读写能力，运行时关闭工具及额外 MCP，权限请求返回 cancelled。这里只记录当前启动配置；未验证 WORK、文件修改、附件工具读取等能力，不能从聊天成功推断这些能力已接通。

### 复现与验收证据

在 `D:\agents-group\dsh-agent-room` 下运行；路径含空格时整体加引号，换机器须改为实际安装路径：

```powershell
# 初始化、模型枚举及两个独立会话，不发送生成请求
node scripts/check-live-workbuddy.cjs "workbuddy-ai=D:\WorkBuddy mocias\WorkBuddyAI.exe"

# 另发送固定文字的真实模型测试请求
node scripts/check-live-workbuddy.cjs "workbuddy-ai=D:\WorkBuddy mocias\WorkBuddyAI.exe" --chat

# 启动本地服务后，在另一终端验证真实群聊
npm start
node scripts/check-live-workbuddy-group.cjs "D:\WorkBuddy mocias\WorkBuddyAI.exe"
```

群聊脚本默认访问 `http://127.0.0.1:4318`（可用 `AGENT_ROOM_URL` 指定），会保存国际版后端路径，创建或复用 `WorkBuddy AI`、`WorkBuddy AI 测试伙伴` 联系人和“WorkBuddy AI 接入验证”群，发送 `@所有人` 的真实模型请求并保留聊天记录。该脚本针对国际版；不得当作国内版验收。带 `--chat` 的检查和群聊脚本会使用现有账号额度。脚本只证明它们实际检查到的行为，不能仅因脚本存在就宣称已执行通过。

2026-10-16 已完成的国际版证据：

| 检查 | 本机证据 | 结论 |
| --- | --- | --- |
| supervisor → ACP → 模型回复 | `output/workbuddy-sidecar-ZvITYn/report.json` | `passed: true`，返回 `WORKBUDDY_SUPERVISOR_API_OK`，未重新登录，测试运行时已关闭 |
| 两位群成员真实回复 | `output/workbuddy-group-OXkHEQ/report.json` | `passed: true`；两位 `fast-model` 成员有不同会话 ID/工作区，各自返回 `WORKBUDDY_GROUP_OK` |
| 群聊 UI 发送及 @ 提及 | 同报告 `uiVerification` 与 `output/workbuddy-group-OXkHEQ/group-ui.png` | 从页面发送，只提及 `WorkBuddy AI`，得到 `WORKBUDDY_UI_OK` |
| 自动回归 | 当次 `npm test`，41/41 通过 | 包含安装识别、流解析、独立运行时、断线清理/重连、工作区等；属于自动测试，不能替代国内版实测 |

这些 `output/` 文件是本机历史验收产物，已被 Git 忽略；新环境可通过脚本重新生成。0.1.10 安装包已构建，不能把构建成功说成已经在另一台机器或另一个 Windows 用户下完成验收。

### 未完成事项与排查入口

- **国内版没有实测**；另一个 Windows 用户的连接程序、经过认证的跨用户转发、真实登录复用/模型/回复验证均待实现或执行。不能读取另一用户的凭据文件来替代连接设计。
- 国际版目前仅确认本机 5.8.4；supervisor 控制管道、描述文件和内置 CLI 属于产品内部接口，版本升级后需重新核验，不能当作长期稳定的公开接口契约。
- WorkBuddy 原生桌面任务列表是否显示群聊会话尚未验证；本应用的联系人和历史持久化不等于原生任务列表同步，也不等于跨重启恢复原 session ID。
- 未发现运行时时先检查：是否同一 Windows 用户、选对版本/安装路径、桌面已登录且发送过消息、supervisor 进程路径是否匹配。不要转而要求群聊单独登录；不要记录描述文件 token、网关密码或 ACP sessionToken。

## 0.1.10 代理与新工作区启动修复

用户报告：开启全局代理时 Room 无法与 Codex 聊天，切成系统代理又影响 Dot；后端安装在不同盘时曾报错。没有原始报错或代理软件/模式信息，不能断言已复现用户所有网络模式。

确认并修复的原因：

- 旧 Codex/ACP 环境构造默认覆盖为 socks5h://127.0.0.1:10808，Codex 的 proxy:false 仍回落到固定值。改为共用 lib/backend-env.cjs：默认保留现有代理环境，未配置则不注入；只有显式后端代理或 AGENT_ROOM_PROXY 才追加。保留并合并 NO_PROXY/no_proxy，始终绕过 localhost、127.0.0.1、::1。proxy:false 或空字符串表示不追加应用代理，仍继承进程已有环境。
- 后端管理新增“仅此后端使用的代理”可选地址，按后端保存在 backend-preferences.json，模型查询和聊天使用同一配置。留空恢复继承；支持 HTTP/HTTPS/SOCKS5/SOCKS5H，不接受含账号密码、路径或查询参数的 URL。WorkBuddy 继续使用桌面网络配置，该输入对 WorkBuddy 禁用。此设置不改变系统代理或 Dot。
- 新 Agent 使用独立工作区时，旧 workspaces/<backend> 目录可能从未创建，spawn 使用不存在的 cwd 导致 ENOENT；Codex 可能停在初始化等待。进程启动现在优先使用已有后端目录，否则使用现有房间数据目录；具体 thread/session 仍传成员的工作区。没有同盘限制，也没有迁移或复制后端安装。

验证：新增回归先在旧实现上失败，修复后 npm test 50/50 通过。checks/launch-workspace.test.cjs 真实启动 C 盘 Node 进程，执行 D 盘协议测试程序并创建 D 盘成员会话；这验证启动路径，不冒充真实 DSH 模型回复。checks/network-env.test.cjs 验证不强制代理、继承/显式代理和本地绕过；checks/discovery.test.cjs 验证代理持久化和非法地址拒绝。

真实 Codex 端到端证据：output/codex-launch-live-EiaSzX/report.json，passed:true。通过本地应用 HTTP API 添加新 Agent、发送并收到 ROOM_CODEX_LAUNCH_OK；后端在 C 盘，应用数据和工作区在 D 盘，旧共享 workspaces/codex 目录不存在。仅为该测试后端配置本机现有 HTTP 代理，未改系统代理。先前未设置代理的一轮在当前网络下等待 90 秒无回复（output/codex-launch-live-PncL8Q/report.json），因此不能声称当前网络无需代理，也未对用户未说明的 TUN/全局/系统模式或 Dot 进行切换验收。

复现：node scripts/check-live-codex-launch.cjs <codex.exe绝对路径>；可用 CHECK_BACKEND_PROXY 为隔离应用中的此后端指定代理。会发送一次真实模型请求并使用已有账号额度；报告和数据存入 output/codex-launch-live-*。该脚本跳过原生项目注册，未改变现有联系人/历史。

代理设置 UI 验收：output/proxy-ui-a7GfI8/report.json 与 proxy-settings.png，验证手动配置、保存并重新打开后地址仍保留、切换 WorkBuddy 时禁用代理输入并提示使用桌面配置；测试在独立数据目录执行。

## 2026-10-17 私聊与多消息第一版

用户选择复用现有后端会话，通过收件人过滤实现私聊；用户可见所有消息，不另建私聊会话，也不新增发送消息工具。

- lib/message-routing.cjs：完整输出按代码块外独占一行 --- 拆分；每块开头 #完整显示名 路由至该成员，普通文本与 @ 公开。支持带空格名称、#用户；未知/歧义对象拒绝整批，绝不转公开。
- room.cjs：记录 visibility、recipientIds、recipientLabels。捕获、附件与重放按稳定 ID 过滤；接收方记录标明私聊双方，正文保留 #接收者。全部块入队后才唤醒接收者，每批对同一目标只触发一次接力。中断输出不发布。
- 用户多块输入也解析；附件只绑定第一块。无 visibility 的旧记录保持公开，不重新解析历史正文。
- agent-room-skill.md 为完整统一规则；Codex developerInstructions 与 ACP 首次 prompt 复用已有注入路径。新会话/重建注入，普通轮次仅简短提醒。进程启动读取文件，修改需重启；尚未实现热更新和压缩后检测补发。
- standalone 输入支持 # 成员补全；私聊淡紫色气泡与文字标识。用户看到的流式输出标为尚未投递的生成预览。原插件 UI 同步添加私聊颜色/标签，但本轮仅实际验收 standalone 页面。
- 打包配置包含技能文件。未构建新安装包，未升级现有安装。

验证：npm test 56/56（含 6 个新增私聊用例）。隔离真实 Edge + 本机服务 + 真实群聊引擎 + 模拟模型的 scripts/check-private-chat-ui.cjs 验收 9 项通过，证据 output/private-chat-ui-uK5zUx/report.json 与 chat.png；涵盖补全、拆分、接收者标记、第三 Agent 排除、颜色、刷新和失败草稿恢复。未进行真实 harness 模型格式遵循验收。

边界：这是模型消息投递过滤，不是本机文件访问隔离；私聊参与者共用原会话，后续公开发言仍可能引用已知内容，规则只能约束行为。用户可见完整日志和生成过程。

## 2026-10-17 0.1.11：闹钟、统一前缀与桌面升级

新增一次性本地闹钟 `/alarm 10m #成员 备注`，支持 s/m/h/d、带时区的 ISO 时间、公开 @成员/@所有人 和私密 #成员/#用户。Agent 在回复中单独一块输出指令即可调用，创建成功回执只对创建者及用户可见；当前群待触发上限 100、最长 366 天。独立服务持久化 alarms.json，运行期间按秒检查，退出/休眠期间到期的闹钟恢复后补发。事件带 alarmId 并根据已保存历史去重；目标删除则取消。UI 增加闹钟列表与取消。

群聊显示和模型输入统一 @发送者：@接收者 / #发送者：#接收者，发送者由真实会话确定；普通无点名内容是 @发送者：正文。兼容原简写，历史原文保持不变，动态增加 displayText。闹钟到期为系统 authorId 和 kind=alarm，过滤与重放不再把它当 UI-only 状态忽略。当前时间以 Asia/Shanghai 提供。skill 升级 v2；原 DSH 插件宿主未接入闹钟存储，能力提示明确不可用。

打包验收发现并复现退出错误 ERR_STREAM_WRITE_AFTER_END：SSE 已 end，但 room.dispose 再次广播。修复 standalone 服务退出时停止广播、清空连接集合并跳过已结束连接；增加保持 SSE 打开时关闭服务的回归。首次打包验收原先未检查主进程退出异常，其通过记录不能作为最终结果；脚本已增加异常采集和退出后断言。

最终验证：63/63 自动回归；浏览器 13 项通过 output/private-chat-ui-6uwoud/report.json（真实 UI/引擎、模拟模型）。修复后打包验收 output/packaged-alarms-tehXHi/report.json；实际安装路径验收 output/packaged-alarms-HvelYY/report.json（闹钟、取消、重启无重复、退出无主进程异常；均未调用真实模型）。未验证各真实模型对闹钟文本格式的遵循率。

安装包 dist/Agent-Room-Setup-0.1.11-x64.exe；已通过静默安装将 D:\Agent Room 从 0.1.9 升至 0.1.11.0，桌面快捷方式仍指向原路径。安装后 app.asar 与测试构建哈希一致，9 个既有聊天数据文件哈希未变。旧 exe、app.asar 与数据哈希清单在 output/desktop-backup-20261017-151612。用户文件与 output/dist 不进入 Git 源码提交。
