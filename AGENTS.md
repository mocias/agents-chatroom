# Agent Room 开发与交付约定

## 当前入口

- 先读 `HANDOFF.md` 的最新版本节、`README.md` 和 `DESKTOP_VALIDATION.md`。版本以 `package.json` 为准，历史验收数字不能当成当前检查结果。
- 主产品是 `desktop/main.cjs`、`standalone/` 与 `lib/room.cjs`；`lib/index.js` 和 `public/` 是旧 DSH 插件入口。投票目前接入独立应用，不能宣称旧插件也已支持。
- GitHub 发布目标为 remote `agents-chatroom` 的 `main`，即 https://github.com/mocias/agents-chatroom。本地分支名和默认 upstream 可能仍是 `master` / `origin`，不要据此误推旧仓库。提交、推送或发布须有用户授权；推送前 fetch 并检查远端分歧，不强推。
- 后续计划见 `ROADMAP.md`，社区贡献与适配验收见 `CONTRIBUTING.md`、`docs/HARNESS_INTEGRATION.md`；候选清单不代表已接入，不能未验证就改 README 的已适配状态。外部贡献通过 Fork/PR，由维护者审核合并。

## 功能边界

- 每个 Agent 使用稳定工作区，每个群聊有独立原生会话；不得用共同会话代替隔离。尊重用户选择的模型，不能静默换模型。
- 长期 memory 按稳定的 Agent ID 隔离，不能按 harness 或群聊划分归属。同一 Agent 在单聊和各群聊中有权接收的内容，默认进入该 Agent 的同一份共享记忆，并可跨会话检索；即使使用相同 harness，不同 Agent 也不共用 memory。
- 群聊独立的原生会话负责当前上下文、消息路由与运行状态，不切断该 Agent 的长期记忆。0.1.32 的 Room 记忆实现位于 `lib/agent-memory.cjs`，由独立宿主共享实例自动写入，并在每轮向原生会话提供本地检索片段；不发起摘要/embedding 模型请求。记忆保留来源房间、消息与可见范围，沿用私聊和匿名投票的输出边界；不能把共享工作区或原生恢复等同于 Room 记忆服务。
- 新建/修改工作区必须检查不同 Agent 的重复、嵌套和链接别名。旧共享目录不自动搬动或删除；保留路径与文件，提示冲突并阻止相关 Agent 创建/使用原生会话，待用户选定独立目录。不得通过复制账号配置或放宽工具权限实现隔离。
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
- 外观改动运行 `node scripts/check-ui-appearance.cjs`：使用本机 Chrome 与隔离 HTTP/SSE 服务，不调用模型或扫描安装；截图及报告写入 `output/playwright/appearance-*/`。同时保留现有输入栏、键盘和滚动回归。深浅色应跟随保存的背景色，新增颜色使用主题变量，不写死浅色控件。
- README 界面示例默认使用隔离演示数据，保留 harness 名称可见，并注明演示消息不是真实模型回复；用户明确指定上传的截图可按其要求使用，并据实更新图片说明。示例图片位于 `docs/images/`；未经用户授权不得上传真实聊天截图，不得把整个 `output/` 纳入提交。
- 投票回归 `node --test checks/polls.test.cjs`；显式真实检查 `node scripts/check-live-polls.cjs codex,dsh`，其他可用组合见 DESKTOP_VALIDATION.md。
- 记忆/目录回归 `node --test checks/agent-memory.test.cjs checks/workspaces.test.cjs`，使用临时数据和模拟 CLI，不消费真实模型额度。打包后运行 `node scripts/check-packaged-memory.cjs`，核对 ASAR、旧历史回填、重启去重与原文件校验；它不替换真实安装。
- 构建前同步 `package.json` 与 `package-lock.json` 版本。运行 `npm run desktop:dist`，再验收最终 `dist/win-unpacked` 的程序和 ASAR 内容，检查源码匹配与污染文件。
- 完整安装包、增量包和 SHA-256 放在 `dist/`，不得提交进 Git。增量包必须基于准确旧版本文件，并在隔离副本上验证文件校验和数据保留。
- 报告分清：源码已实现、自动测试、真实后端、打包程序、安装器、用户实际安装。没有执行安装更新，就不要宣称用户已升级；未经请求不要发布 GitHub Release。
- 更新 HANDOFF、AGENTS 与验收记录，给出实际证据路径。`output/` 是本地证据，不随源码上传。

## 建议技能

- `handoff`：更新交接内容；用户要求更新仓库现有文档时，以用户指定位置为准。
- `diagnose`：复杂后端或并发故障；先复现再做最小修复。
- `playwright`：实际界面操作与状态恢复验证。
- `openai-docs`：需要核对 Codex/MCP 官方接口时使用。
