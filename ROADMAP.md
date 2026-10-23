# Agent Room 路线图

更新：2026-10-23。当前源码为 0.1.32；本页包含已完成的记忆基础版与后续计划，不表示新 harness 已接入，也不承诺发布日期。欢迎通过 [Issue](https://github.com/mocias/agents-chatroom/issues) 认领研究、实现或实测，并提交 PR；维护者依据 [贡献指南](CONTRIBUTING.md) 审核合并。

## 产品方向

把已经安装、登录的不同 harness 放进同一个可控的聊天空间：用户能与它们单聊、群聊、点名、私聊和投票，同时保留每位 Agent 的身份、工作区、模型选择与独立会话。

这里的 harness 是能运行会话、调用工具的 Agent 应用或运行时。模型名、模型 API 服务商、编辑器插件和完整 harness 不等价；接入一个模型 API 不代表接入了对应应用。ACP 指 Agent Client Protocol，MCP 用于工具连接，两者不能互相替代。

当前已登记的后端为 Codex、DSH、Qoder、Claude Code、WorkBuddy 国内版和 WorkBuddy AI 国际版；后两项仍为实验性适配。具体边界见 [README](README.md#harness-适配)，本页不重复宣称历史验证结果。

### Agent 的工作区、会话与记忆

记忆的归属是 **Agent**。两个 Agent 即使使用同一个 harness，也各有稳定工作区和独立 memory；同一 Agent 在单聊、不同群聊中接收到的内容，默认汇入它自己的同一份共享记忆，后续可跨会话检索，不额外要求开启跨群共享。

群聊仍分别创建原生 CLI/ACP 会话，用于维护当前上下文、消息路由、取消和运行状态；独立会话不意味着把长期记忆按群聊切开。例如 CC-1 在甲群记住的项目约定，可在乙群继续使用；CC-2 不会因为同为 Claude Code 就继承 CC-1 的记忆。

0.1.32 已实现 Room 管理的记忆基础版：自动记录、历史回填、本地检索、来源查看和跨会话注入，不调用额外模型。新建/修改目录拒绝重复、嵌套和链接别名；旧共享目录保留并阻止相关 Agent 生成，待用户选择独立目录。自动复制旧工作区、语义检索和记忆编辑/清理仍未实现。具体使用与边界见 [README](README.md#记忆会话与工作区)。

## 后续 harness 清单

以下优先级是根据官方接口文档和当前 Room 架构作出的实施判断，不是本机已完成兼容性测试。所有候选均尚未接入 Agent Room；Windows 原生、WSL 和 macOS/Linux 的验证必须分别记录。优先复用本地 ACP 子进程；如有 HTTP 服务，需要另行验证认证和进程生命周期。

### 第一批：优先验证端到端接入

| 候选应用 | 已核对的入口 / 依据 | 首个贡献范围与主要检查点 | 状态 |
| --- | --- | --- | --- |
| OpenCode | [官方 ACP 文档](https://opencode.ai/docs/acp/)：`opencode acp`，stdio JSON-RPC | 程序发现、模型/权限能力协商、单聊与双 Agent 群聊；验证 Windows 路径、取消和资源清理 | 待接入，欢迎认领 |
| Qwen Code | [官方架构](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/)：`qwen --acp` | 复用 ACP 层；核对配置选项、流式事件、取消和项目级模型提供商；与 Qoder 使用不同后端 ID | 待接入，欢迎认领 |
| Kimi Code CLI | [当前仓库](https://github.com/MoonshotAI/kimi-code)、[ACP 能力表](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp)：`kimi acp` | 按当前实现验证登录、模型、会话恢复与 MCP 传输；Windows 需检查 Git Bash；不能沿用旧 Python CLI 的假设 | 待接入，欢迎认领 |
| GitHub Copilot CLI | [官方 ACP 服务参考](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)：`copilot --acp --stdio` | 验证用户/组织授权、模型目录、逐工具权限、取消；ACP 文档仍标注 public preview，记录测试版本 | 待接入，欢迎认领 |

Kimi 的 [旧 kimi-cli 仓库](https://github.com/MoonshotAI/kimi-cli) 已标注归档并指向 Kimi Code CLI；实施以新仓库的发布和接口为准。以上命令用于说明已发现的上游入口，不是 Room 当前支持的配置方法。

### 第二批：扩展已有 ACP 生态

| 候选应用 | 官方依据与接入路线 | 尚需解决的问题 | 状态 |
| --- | --- | --- | --- |
| CodeBuddy Code CLI | [官方 ACP 文档](https://www.codebuddy.ai/docs/cli/acp)：`codebuddy --acp` | 单独验证登录、模型和权限；它与当前 WorkBuddy 桌面 supervisor 接入是不同产品入口，不能直接视作已支持 | 待接入 |
| Cursor CLI | [官方 ACP 文档](https://cursor.com/docs/cli/acp)：`agent acp` | 识别实际 Cursor 入口，避免与其他名为 agent 的程序混淆；核对认证、模式和 Windows/WSL 边界，不驱动 IDE 表单 | 待接入 |
| Goose | [当前仓库的 ACP 指南](https://github.com/aaif-goose/goose/blob/main/documentation/docs/gdk/acp/index.md)：`goose acp`；另有服务模式 | 区分模型提供商与扩展配置，核对权限及本地服务生命周期；不把 Goose 桌面客户端和 ACP 服务能力混为一谈 | 待接入 |
| Mistral Vibe | [官方仓库](https://github.com/mistralai/mistral-vibe) 的 Editors/IDEs 与 ACP Setup | 核对所选发布版本的实际启动命令、运行依赖、模型锁定和取消；Windows 原生/WSL 分开验收 | 待调研与接入 |
| Auggie / Augment Code CLI | [官方 ACP 模式](https://docs.augmentcode.com/cli/acp/agent)：`auggie --acp` | 核对账户权限、项目上下文来源、模型配置和终端授权；交互模式的功能不自动等于 ACP 功能 | 待接入 |
| Factory Droid | [ACP 官方 Agent 目录](https://agentclientprotocol.com/get-started/agents) 已收录 | 先补当前厂商接口、启动命令与授权依据，再验证 Windows 和 MCP；目录收录本身不能代替实测 | 待调研 |

### 第三批：迁移、额外运行时和社区适配

| 候选应用 | 官方 / 项目依据 | 接入前置条件 | 状态 |
| --- | --- | --- | --- |
| Gemini CLI | [当前官方仓库说明](https://github.com/google-gemini/gemini-cli)；ACP 目录收录 | 仓库提示部分用户路径已迁往 Antigravity CLI；先确认账户类型和仍受支持的入口，不沿用旧的免费额度/登录假设 | 条件调研 |
| Google Antigravity CLI | [官方 CLI 入门](https://antigravity.google/docs/getting-started?tab=cli) | 与 Gemini CLI 分开登记；先核对结构化控制、认证、模型、MCP 和取消，不能只因支持终端启动就宣称可接入 | 待调研 |
| Kiro CLI | [官方 ACP 文档](https://kiro.dev/docs/cli/acp/) | 核对当前 CLI 代际、安装平台、认证和权限模式，记录具体测试版本 | 待调研与接入 |
| OpenHands | [官方 IDE/ACP 文档](https://docs.openhands.dev/openhands/usage/cli/ide/overview) | 先确认当前维护的产品入口；区分 CLI/SDK、容器与远程运行时，单独定义工作区挂载、网络和销毁边界 | 待调研 |
| Pi coding agent | [ACP 目录](https://agentclientprotocol.com/get-started/agents)、[社区 pi-acp 适配器](https://github.com/svkozak/pi-acp) | 社区适配器需单独核对维护者、版本、许可证与权限，不把桥接兼容当作原生支持 | 社区候选 |
| Aider | [官方脚本接口](https://aider.chat/docs/scripting.html) | 现有脚本入口不等于可持续的 ACP/MCP 会话；先验证输出、取消、会话和工具权限，能力不足时只提供明确的有限模式 | 待调研 |

另有 Cline、TRAE、Windsurf、通义灵码等值得跟踪的应用/插件。它们尚未纳入上述 16 项实施队列；贡献者可提供当前官方 CLI、ACP 或 SDK 依据后提案，不默认依赖鼠标操作、终端画面解析或私有数据库修改。

## 项目优化顺序

### P0：降低扩展和日常使用的风险

- [x] **Agent 独立工作区与共享记忆基础版（0.1.32）**：按稳定 Agent ID 保存记忆，跨单聊/群聊自动记录与本地检索；保留来源、显式私聊可见范围、历史日志及原工作区，支持同进程多群并发追加、去重、重启恢复和查看。拒绝新目录冲突，旧目录冲突保留并提示处理；原生 CLI 会话仍独立。匿名个人选票和原始投票工具调用不进入记忆。
- [ ] **记忆管理与迁移体验**：补充可审阅的编辑/清理/导出，以及旧共享工作区的安全复制与迁移入口；再评估语义检索和摘要，明确成本与来源，不把基础关键词检索描述成语义理解。
- [ ] **统一 harness 描述与能力信息**：收敛注册、发现、启动、模型、UI 标签之间重复维护的清单；声明模型、推理档位、附件、恢复、取消、MCP 传输和权限能力。先接通第一批一个后端，再推广，避免一次重写全部适配。
- [ ] **诊断与错误分类**：分别展示程序发现、协议握手、登录/授权、模型目录、请求接受和首段输出状态；记录阶段耗时和脱敏错误码。已派发但结果未知时不自动重发，429 不直接归因为并发。
- [ ] **会话连续性与重启恢复**：分开显示 Room 历史、后端原生会话恢复和桌面工作区登记；恢复失败必须可见。当前历史重放不能描述为所有后端的原生 resume。
- [ ] **贡献回归自动化**：先建立无真实账户、无模型请求的 Windows PR 检查，再逐步增加 Linux/平台矩阵；真实后端和安装包检查另列证据。Issue/PR 模板与接入指南已提供，不等于分支保护或 CI 已配置。

### P1：让群聊更可控、更适合长任务

- [ ] **接力预算可见**：现有引擎已有有限 @ 接力；在界面展示/配置接力上限、暂停与人工接管，增加按群/Agent 的并发与用量边界，不把“增加无限自动讨论”作为默认目标。
- [ ] **上下文与用量管理**：提供可追溯的摘要和消息引用，减少重复重放；仅展示后端实际返回的 token/用量，未返回时标记未知。摘要继续遵守私聊可见范围与匿名投票边界。
- [ ] **长消息阅读**：安全的 Markdown/代码块渲染、复制、搜索定位与长历史增量加载；渲染前明确转义/清洗和外链策略，保留滚动位置与流式性能。
- [ ] **附件能力协商**：区分“文件已上传”“路径已传给 harness”“原生图片块已发送”；逐后端验证多模态，不能统一假定图片已被模型识别。
- [ ] **Agent 与群成员管理**：补充编辑角色/名称与成员变更；定义已有原生会话、投票参与者快照和历史署名如何处理，保留稳定身份。

### P2：交付和可选协作模式

- [ ] **备份、恢复与升级体验**：在现有数据保留与增量校验上增加可理解的备份/恢复入口；签名、版本兼容和回滚流程单独验收。
- [ ] **可选工作模式**：为编码任务提供隔离 worktree、变更预览和明确的执行批准；讨论/投票结果不自动执行代码或合并。
- [ ] **跨平台与远程**：先验证 Windows 路径、进程和数据生命周期，再扩展 macOS/Linux。远程/多人访问需要先设计认证、房间授权和访问记录，不能直接把本地端口暴露出去。

## 如何参与

1. 从上述清单选择一项，使用 [harness 接入提案](https://github.com/mocias/agents-chatroom/issues/new?template=harness_request.yml) 给出当前官方入口、版本、系统和拟验证范围；没有账户也可先贡献研究或模拟协议测试。
2. 在 Issue 说明认领意向；没有认领不代表已有人实现，也不要求贡献者必须完成真实模型验证才能先提交 Draft PR。
3. 按 [适配接入与验收指南](docs/HARNESS_INTEGRATION.md) 做小范围、可回退的变更；在 PR 中分别列源码、模拟协议、真实后端、打包和安装的结果。
4. 向 `mocias/agents-chatroom` 的 `main` 提交 PR，由维护者审查合并。第一批优先，其他候选同样欢迎有证据的 PR；无需申请仓库写权限。

相似项目与可借鉴的设计见 [GitHub 项目调研](docs/SIMILAR_PROJECTS.md)。本次路线图不新增任何运行中的 harness、真实模型调用或自动合并机制。
