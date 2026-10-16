# Agents Chatroom — Handoff

交接日期：2026-10-16。源码版本 0.1.7，新仓库 agents-chatroom。保留包名 dsh-agent-room、原 MIT LICENSE 和插件入口。本文区分已实现、已验证和未完成事项。

## 1. 产品目标与接手任务

独立多 Agent 聊天应用，微信式左侧联系人/群聊、右侧对话。Codex、DSH、Qoder 是三类后端，同一类可以添加多位联系人。搜索旁 + 添加 Agent；多选联系人建群。第一版仅 CHAT、附件和外观设置。

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
| desktop/main.cjs | Electron 窗口、原生选择器、每次启动本地服务访问凭证 |
| desktop/builder.cjs | Windows x64 NSIS 构建 |
| lib/room.cjs | 群聊调度、分段投递、CHAT 策略、会话与历史 |
| lib/codex-pool.cjs | Codex app-server 协议、模型和推理能力 |
| lib/acp-backend.cjs | ACP 启动、会话、流式回复、取消、配置 |
| lib/index.js、public/ | 原 DSH 插件入口/UI，非 standalone |
| checks/、scripts/ | 自动回归和真实/桌面验收工具 |

## 3. 当前数据模型与行为

Agent 字段：id、label、backend、model、modelLocked、modelName、effort、workspace、persona、aliases、createdAt。新 Agent 从真实列表选模型并固定；旧联系人保留兼容行为。

Conversation 字段：id、kind、title、agentIds、updatedAt、preview，可含 efforts[agentId]。推理覆盖只作用于当前会话；群内不提供模型修改。后端模型不可用或拒绝应用时应报错，不静默切换。Qoder auto 是策略，不是固定具体模型。

workspace 自定义目录须存在；留空创建 workspaces/backend/Agent名称。非法字符/保留名/冲突由工具函数处理。新房间创建独立后端会话，但同一 Agent 使用同一 cwd。旧 Agent 保存原共用路径，不搬文件。

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

- 当前离线/本地接口回归 21/21 通过：扫描许可、持久化、目录规则、模型锁定、推理隔离、附件和群聊。
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
4. 暂无 Agent 编辑/删除、群成员增删、已有 workspace 迁移、跨设备同步、WORK UI、代码签名和自动升级。
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
