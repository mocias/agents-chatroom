# GitHub 相似项目调研

调研日期：2026-10-23。依据各项目的当前 GitHub README、许可证文件和仓库元数据；未安装或实测这些项目，不以 README 描述代替运行验收。以下“相近程度”“可借鉴点”和优先建议是比较后的判断，不是上游项目的承诺。功能与维护状态会变化，实施前需重查；本页不记录易失效的 Star 排名。

Agent Room 当前方向是 Windows 优先的本地多 harness 单聊/群聊，结合会话隔离、点名/私聊、MCP 投票、工作区保留和桌面集成。相似项目确实存在，不能宣称“首个”“唯一”或把不同应用/会话放在一处当成独有能力。

## 最接近的聊天与桌面项目

| 项目与一手来源 | 官方文档描述的相关能力 | 与 Room 的比较及可借鉴点 | 许可证快照 |
| --- | --- | --- | --- |
| [agentchattr](https://github.com/bcurts/agentchattr) | 本地 Agent/人类共享多频道聊天；@ 提及触发终端提示，Agent 通过 MCP 读写房间；提供 Windows 启动方式和接力防护 | **直接相似，优先研究**。可借鉴频道、状态、接力暂停；其终端唤醒 + MCP 与 Room 的 pool/原生协议调度不同，比较时应说明控制方式 | MIT |
| [Agent Chat / multi-agent-collaboration-mcp](https://github.com/Alex-R-A/multi-agent-collaboration-mcp) | 让已经运行的本地 MCP 客户端加入房间，含角色、认领、回复、提及、历史与浏览器观察；README 明确不负责启动 Agent | **直接相似**。可借鉴任务认领与一次性监听生命周期；它主要提供协调通道，Room 同时承担启动、会话和模型管理 | Apache-2.0 |
| [AionUi](https://github.com/iOfficeAI/AionUi) | 多 CLI 的桌面 Cowork 客户端、独立上下文、MCP 管理、Team MCP 的 Leader/Teammate 协作和任务板，外部 Agent 通过 ACP 接入 | **桌面与协作方向高度相近**，不能仅把它描述为多窗口聊天。可借鉴适配目录、能力协商、逐 Agent 权限提示与任务状态；Room 可继续聚焦轻量群聊和国内 harness 实测 | Apache-2.0 |

## 相邻的并行开发与任务编排项目

| 项目与一手来源 | 官方文档描述的相关能力 | 与 Room 的比较及可借鉴点 | 许可证快照 |
| --- | --- | --- | --- |
| [Claude Squad](https://github.com/smtg-ai/claude-squad) | 在终端管理多个编程 Agent；基于 tmux 与 Git worktree 隔离任务，预览与检查变更 | 更偏并行开发会话。可借鉴 worktree 和变更审查；不能把 tmux 隔离解释为权限沙箱，或照搬自动批准模式 | AGPL-3.0 |
| [Orchestrator.inc / agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) | 为任务分配 Agent/工作区/反馈循环；桌面与移动入口，将会话、终端、改动、PR、CI/审查状态关联到任务 | 更偏任务到 PR 的开发工作流。可借鉴“任务—执行—结果—审查”关联；属于未来可选工作模式，不要求群聊立即变成 IDE | Apache-2.0 |
| [Superset](https://github.com/superset-sh/superset) | 并行 Agent 的 IDE/工作区、worktree、终端、差异审查、远程与调度等；当前 README 标明 Windows 尚未提供 | 更偏开发工作区。可借鉴上下文与产物预览，但不能据此假定其已支持 Windows；其 [LICENSE.md](https://github.com/superset-sh/superset/blob/main/LICENSE.md) 为 Elastic License 2.0，不能将其一概称为 MIT/Apache 开源项目 | Elastic License 2.0 |

仓库名迁移也需留意：原 `ComposioHQ/agent-orchestrator` 当前跳转到 `OrchestratorInc/agent-orchestrator`。`mocias/dsh-agent-room` 是本项目保留的原上游，不应当作为独立竞品计数。

还检索到 [AgentsRoom.dev 的 GitHub 组织](https://github.com/AgentsRoomDev)，其名称与本项目接近，但本次未确认完整桌面产品对应的公开源码仓库，因此不把它列为已核实的完整开源实现，也不推断本项目与其有关系。

## 对本项目的建议

1. **先做稳定的适配基础，再拼数量**：可扩展的 harness 描述、真实能力矩阵、版本化验证和示例实现，会比持续追加散落的分支更利于社区接入。
2. **将聊天协作做得可控**：接力上限、暂停/恢复、任务认领和引用上下文值得借鉴。现有 @ 接力本来就有预算，下一步应展示并完善，而不是宣称从零新增。
3. **清楚展示真实执行状态**：诊断阶段、工具授权、后端拒绝与未知结果、模型/版本、工作区和恢复状态，直接影响用户能否判断“正在工作还是卡住”。
4. **保留轻量产品定位**：Markdown、附件能力、历史定位与上下文摘要先服务日常对话；worktree、差异审查和 PR 联动可以是后续工作模式。
5. **欢迎可验证的 PR**：先开放独立适配与测试贡献，提供明确证据等级。许可证列仅记录一手文件，不构成兼容性结论；借鉴设计不等于可以直接复制其他项目代码。

本次对比没有证明任何一方的完整性能、可靠性或隐私优劣，也没有逐项确认所有项目是否存在与 Room 相同的匿名投票或原生桌面同步功能。后续可按一个具体场景开展同环境实测，再作结论。
