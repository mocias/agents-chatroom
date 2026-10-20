# Agent Room 开发与交付约定

## 当前入口

- 先读 `HANDOFF.md` 的最新版本节、`README.md` 和 `DESKTOP_VALIDATION.md`。版本以 `package.json` 为准，历史验收数字不能当成当前检查结果。
- 主产品是 `desktop/main.cjs`、`standalone/` 与 `lib/room.cjs`；`lib/index.js` 和 `public/` 是旧 DSH 插件入口。投票目前接入独立应用，不能宣称旧插件也已支持。
- GitHub 发布目标为 remote `agents-chatroom` 的 `main`，即 https://github.com/mocias/agents-chatroom。本地分支名和默认 upstream 可能仍是 `master` / `origin`，不要据此误推旧仓库。提交、推送或发布须有用户授权；推送前 fetch 并检查远端分歧，不强推。

## 功能边界

- 每个 Agent 使用稳定工作区，每个群聊有独立原生会话；不得用共同会话代替隔离。尊重用户选择的模型，不能静默换模型。
- 投票由 `lib/polls.cjs` 持久化，`lib/poll-mcp.cjs` 绑定房间和成员身份，`lib/poll-mcp-stdio.cjs` 向后端提供七个 MCP 工具。身份来自绑定，不能接受模型自报 voter/room 身份。
- 匿名投票的 API、SSE、界面、聊天日志和导出必须经过授权视图；不得直接返回内部 ballots/history/attempts。匿名轮次不展示生成文本或工具参数，结果仅汇总。内部磁盘和后端会话可能保存归属，因此不能宣称密码学匿名。
- 用户可以创建、管理投票但不计票；参与者是创建时成员快照，发起 Agent 也参与。重复调用不得增加票数；退出、忙碌、改票、弃权、截止和重启要保持一致。
- 保持原有文件/执行权限边界。Codex 按工具批准、Claude 精确工具白名单、WorkBuddy 依据 `_meta["codebuddy.ai/toolName"]` 判断身份；不能靠 rawInput 或显示标题批准工具。
- 打包后的桥接使用 Electron Node 模式读取 ASAR，不依赖系统 Node。

## 数据与工作区

- 不提交或打包聊天、账户、凭据、个人工作区、测试输出和第三方运行时；遵循 `.gitignore`。
- 不覆盖用户数据或运行中的桌面状态文件。桌面登记的退出等待、备份、原生入口和冲突检查必须保留，详见 README。
- 升级/卸载保留 agents 工作区；不得移除 `desktop/preserve-agents.nsh` 的保护。删除或移动前核对绝对路径，禁止目录穿越和祖先目录误操作。
- 修改已有混合工作树时保留其他改动，明确本次提交范围。原生会话登记不等于聊天历史同步。

## 验证与交付

- 基础回归 `npm test`；按改动运行相关真实 UI 或后端检查。真实模型检查使用隔离数据，会消耗用户额度；不得把 fixture 测试当成真实回复验证。
- 投票回归 `node --test checks/polls.test.cjs`；显式真实检查 `node scripts/check-live-polls.cjs codex,dsh`，其他可用组合见 DESKTOP_VALIDATION.md。
- 构建前同步 `package.json` 与 `package-lock.json` 版本。运行 `npm run desktop:dist`，再验收最终 `dist/win-unpacked` 的程序和 ASAR 内容，检查源码匹配与污染文件。
- 完整安装包、增量包和 SHA-256 放在 `dist/`，不得提交进 Git。增量包必须基于准确旧版本文件，并在隔离副本上验证文件校验和数据保留。
- 报告分清：源码已实现、自动测试、真实后端、打包程序、安装器、用户实际安装。没有执行安装更新，就不要宣称用户已升级；未经请求不要发布 GitHub Release。
- 更新 HANDOFF、AGENTS 与验收记录，给出实际证据路径。`output/` 是本地证据，不随源码上传。

## 建议技能

- `handoff`：更新交接内容；用户要求更新仓库现有文档时，以用户指定位置为准。
- `diagnose`：复杂后端或并发故障；先复现再做最小修复。
- `playwright`：实际界面操作与状态恢复验证。
- `openai-docs`：需要核对 Codex/MCP 官方接口时使用。
