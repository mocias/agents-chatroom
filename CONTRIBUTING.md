# 参与 agentschat

欢迎贡献新的 harness 适配、缺陷修复、界面改进、测试与文档。Contributions and pull requests are welcome. You can open an issue or send a PR without repository write access.

## 贡献与合并方式

本项目采用 [MIT 许可证](LICENSE)。外部开发者可以 Fork 后修改，再向 [mocias/agents-chatroom 的 main](https://github.com/mocias/agents-chatroom/pulls) 发起 Pull Request，由维护者审核合并。这里的“开放贡献”是欢迎提交和审查 PR；它不授予所有人直接推送或合并他人 PR 的权限，也不代表已启用自动合并。

后续接入清单见 [ROADMAP.md](ROADMAP.md)。新增后端可先提交 [harness 提案](https://github.com/mocias/agents-chatroom/issues/new?template=harness_request.yml)；普通问题使用 [Bug 模板](https://github.com/mocias/agents-chatroom/issues/new?template=bug_report.yml)。贡献研究、文档或隔离测试也有价值，可以先开 Draft PR 并说明未完成项。

## 本地开发

推荐 Windows x64、Node.js 24 LTS 与 npm。当前产品首先验证 Windows；其他系统的通过结果请单独记录，不据此宣称全部桌面后端都已跨平台。

```sh
git clone https://github.com/YOUR-ACCOUNT/agents-chatroom.git
cd agents-chatroom
npm ci
npm test
```

`YOUR-ACCOUNT` 替换为你的 GitHub 账号。浏览器开发使用 `npm start`；Electron 开发使用 `npm run desktop`。请先阅读 [AGENTS.md](AGENTS.md)、[HANDOFF.md 最新节](HANDOFF.md) 和 [DESKTOP_VALIDATION.md](DESKTOP_VALIDATION.md)。自动检查使用隔离临时目录；启动应用或运行 UI 脚本时也应指定隔离路径，避免使用个人聊天数据。PowerShell 示例：

```powershell
$env:AGENT_ROOM_DESKTOP_HOME = Join-Path $env:TEMP ('agent-room-dev-' + [guid]::NewGuid().ToString('N'))
$env:AGENT_ROOM_WORKSPACE_ROOT = Join-Path $env:AGENT_ROOM_DESKTOP_HOME 'agents'
$env:AGENT_ROOM_DATA = Join-Path $env:AGENT_ROOM_DESKTOP_HOME 'browser-data'
npm run desktop
```

同一终端可用 `npm start` 启动隔离浏览器服务。首次发现、登录、模型查询可能启动用户的 harness；测试前确认相应范围。真实回复测试会消耗所选服务额度，不能放入默认 PR 检查或冒用维护者的账号。

## 提交范围

- 一个 PR 聚焦一个后端或一个完整行为。先提交最小闭环，再补更广的平台、模型和高级功能，避免混入大规模无关重构。
- 新 harness 必须有可核对的上游接口依据。先看 [接入指南](docs/HARNESS_INTEGRATION.md)，不要只加一个下拉选项就称为已适配。
- 不提交账号、认证缓存、凭据、聊天、个人工作区、备份、第三方运行时或 `output/`、`dist/`。截图默认用隔离数据；真实截图需要拥有者明确授权。
- 保留模型选择、会话隔离、工具批准、匿名投票和升级保留数据的行为；不要用全局自动批准、终端文字猜测或共享原生会话来绕过问题。
- 引入外部代码时标明来源并核对其许可证和通知要求；本项目为 MIT，不表示其他项目的代码可直接按 MIT 重发。
- PR 不必自行升级版本号、打包或更新个人安装；发布步骤由维护者协调。若确实修改交付逻辑，应给出隔离副本的验证。

## 验证要求

运行 `npm test` 并在 PR 写明操作系统、Node 版本、通过/失败/跳过项。功能变更增加有行为意义的检查；纯文档、图片不要求编写与实现重复的测试。

新增后端至少覆盖发现/启动、协议交互、模型选择、两会话隔离、取消、错误传播、退出清理以及权限边界。没有相应服务账户时，模拟协议检查与未执行的真实场景必须明确区分，可先提交 Draft PR。外观改动可运行 `node scripts/check-ui-appearance.cjs`（需要本机 Chrome）；最终打包程序另行做 UI 检查，不能把源码浏览器通过等同于安装版通过。

PR 描述请使用仓库模板，简述问题、最终行为、验证证据与已知限制。新增后端在真实验证完成前应保持“实验性”或“待验证”；MCP 投票、图片和原生桌面登记各自单独报告支持情况。维护者会据变更范围审查，再决定合并与发布。

## 目录入口

| 位置 | 用途 |
| --- | --- |
| `lib/harnesses.cjs` | harness 注册、默认发现与启动描述 |
| `standalone/discovery.cjs`、`standalone/windows-harnesses.ps1` | 独立应用发现和手动配置 |
| `lib/acp-backend.cjs`、`lib/codex-pool.cjs`、`lib/workbuddy-pool.cjs` | 协议/运行时适配 |
| `standalone/models.cjs`、`standalone/server.cjs` | 模型目录、持久化与独立 HTTP 服务 |
| `lib/room.cjs`、`lib/message-routing.cjs` | 房间调度、消息可见范围与投递 |
| `standalone/public/` | 桌面/浏览器共用界面；旧 DSH 插件界面为 `public/` |
| `checks/`、`scripts/` | 本地回归、隔离 UI 与显式真实验收 |
| `desktop/` | Electron、安装与增量升级 |

本指南描述贡献流程，未配置强制分支保护或自动审批。发布目标是 `mocias/agents-chatroom`；`mocias/dsh-agent-room` 是保留的原上游，不要误推。
