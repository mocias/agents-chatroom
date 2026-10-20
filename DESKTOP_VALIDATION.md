# Windows 桌面版验收 · 2026-10-16

## WorkBuddy refusal 复查 · 2026-10-20

- 同一 WorkBuddy AI 安装、`deepseek-v4.1-flash`，单运行时/单会话/单 prompt 成功返回 `WORKBUDDY_LOCAL_OK`：`output/workbuddy-diagnosis-ji48xn/report.json`。
- 与当前 Agent 配置对齐的模型和 `effort=enabled`，经过真实 HTTP、Room 引擎、WorkBuddy 后端成功返回 `WORKBUDDY_ROOM_OK`：`output/workbuddy-room-live-InTgbw/report.json`。均使用隔离数据目录。
- 当前已安装 0.1.28 的原始服务代码也通过同样的完整流程：`output/workbuddy-room-live-XbxPC9/report.json`。因此本次恢复不依赖安装 0.1.29；未修改用户配置或正式代码来改变请求行为。
- 昨日探测日志确认上游 HTTP 429 出现在生成前，WorkBuddy 内部等待 474 ms 后重试一次仍失败。可见日志没有可用于区分具体原因的业务码。未证明账号额度耗尽、本机并发超限或服务过载中的哪一种；当前未复现，不把暂时恢复表述为根因修复。
- 初版完整流程夹具遗漏 effort，触发本地 `none` 不支持；补齐用户真实的 `enabled` 设置后通过。这一夹具失败不是用户 refusal 的根因。

## 0.1.29 消息发送与后端错误 · 2026-10-19

- 已复现旧版慢模型期间第二次 `/say` 返回 409；新增测试先失败，修复后通过。桌面提交只等待消息落入房间，不等待整个模型回复。其他调用方默认仍等待回复。
- 全部 `checks/*.test.cjs` 105/105 通过。覆盖慢成员不阻塞其他成员、同成员补充、固定模型失败原因和会话清理、WorkBuddy 错误详情脱敏与部分输出后失败。
- 真实浏览器 + HTTP + SSE + 房间引擎验证通过；仅推理使用可控慢回复替身。覆盖鼠标/Enter 发送、群聊、单聊、Codex steering、ACP 取消后接续、切换会话保留草稿、停止、无重复用户消息及无浏览器异常。证据：`output/concurrent-chat-ui-r7Kunw/report.json` 和 `send-while-thinking.png`。
- 真实 WorkBuddy AI 当前固定模型 `deepseek-v4.1-flash` 探测失败，返回 `Quota exceeded: 429 too many requests`。这是上游额度/限流，未声称模型回复恢复。证据：`output/workbuddy-live-ogV5Ab/report.json`。
- 真实 Claude 默认模型初始化通过，未发送聊天。截图中的 `claude-opus-5-5` 可从目录读取，但实际应用固定模型返回 `Model 'claude-opus-5-5' not found`，聊天未发出。目录选择已不再触发多余的 `set_model`；固定模型会话仍严格校验，不静默换模型。证据：`output/claude-live-fruUAy/report.json`、`output/claude-live-XtHAGI/report.json`。
- 0.1.29 安装包与 0.1.28 → 0.1.29 增量包已生成。独立桌面启动通过，修复文件与源码逐字节一致：`output/packaged-chat-fix-NmbECp/report.json`。增量包以本机已安装 0.1.28 为基线，三个文件重建 SHA-256 校验通过；未执行用户安装目录的更新。

## 0.1.8 工作区、删除与原生归档边界

- 最终回归 26/26 通过，包含删除确认、共用/祖先路径保护、模型与角色指令隔离。
- 最终打包桌面验收 `output/desktop-smoke-exb3Jx/report.json` 通过；实际交互覆盖取消删除、保留目录、确认完整路径后删除、重启恢复。原生文件选择器仍用模拟返回值。
- 无工作区环境变量覆盖的打包程序默认根目录验证：`output/default-root-tDy4F6/report.json`，确认为 EXE 同级 `agents/`。已有 Agent 不搬目录。
- 安装器清理宏隔离执行：`output/installer-preserve-lRIIFE/report.json`，应用文件删除而 `agents/` 保留。实际执行的是同一 NSIS 宏的无注册表测试程序，不是覆盖用户已安装版本或完整卸载验收。
- Codex：`output/native-codex-vN7bjq/report.json`，同一 Agent 项目下两段独立会话均回复 SYNC_OK，并读回 projectId。当前桌面 read_thread 能读回验证对话；list_projects 未显示新项目，GUI 自动项目同步仍未完成。成员菜单提供 `codex://threads/<id>` 打开入口；该系统协议的用户点击跳转未纳入自动 UI 验收。
- DSH/Qoder：`output/persona-live-J3wtcF/report.json`，实际回复 DSH_PERSONA_OK / QODER_PERSONA_OK，验证首次 ACP prompt 已接入身份和角色设定。0.1.7 的 ACP 实现曾遗漏这些指令。
- DSH 的 workspaceRegistry 和 Qoder 的桌面项目/消息库尚未对接；界面明确标记未支持，不将 ACP 聊天成功视为原桌面可见。
- 浏览器服务已更新，默认工作区根为源码目录/agents。安装包 `dist/Agent-Room-Setup-0.1.8-x64.exe` 已构建；用户原已安装版本未覆盖。

## 0.1.7 扫描前告知与手动配置

- 首次使用（含升级后的旧数据）未作选择前不自动发现；弹窗说明读取范围，提供允许扫描与不扫描手动配置。选择按数据目录保存。
- 手动模式不查询系统安装信息、进程、PATH，不遍历安装目录；仅检查用户指定的程序文件及对应入口。目录输入会被拒绝。
- 后端管理增加扫描设置入口，手动查找指引覆盖快捷方式、打开文件位置和属性目标。
- 21/21 回归通过，包含无许可/手动模式下扫描计数为零、重启保持选择、授权后开始扫描。
- 打包桌面首次拒绝、重新授权、功能回归和重启验收通过：`output/desktop-smoke-SVCCtN/report.json`。
- 浏览器服务已更新且保留未选择状态，等待用户自行决定。安装包 `dist/Agent-Room-Setup-0.1.7-x64.exe`，未替换已安装版本。

## 0.1.6 Qoder 桌面 Worker 适配

- 本机 Qoder CN 0.4.8 内置 SDK 1.0.52 / Worker 1.1.69，支持隐藏的 `--acp` 参数。新增 Worker 标准输入输出桥接，使用 Qoder 自带 Electron Node 运行，无需另装 CLI。
- 自动发现必须同时验证 ASAR 内 SDK 和外部 Worker 文件；优先运行中的桌面版。无入口的普通桌面程序仍不宣称可用。
- 初次 session/new 返回 Authentication required；通过内置运行时官方浏览器登录成功后，两个独立会话及真实 QODER_OK 回复通过。报告：`output/qoder-live-dcv9cw/report.json`。
- 打包桌面 ASAR 环境真实 QODER_DESKTOP_OK 回复通过。报告：`output/qoder-desktop-4d6ODU/report.json`。
- 模型查询/固定模型选择已接入，当前返回 15 个模型选项。当前未返回 thought_level，不提供虚构推理档位。auto 是后端自动选模策略，不代表具体模型固定。
- 20/20 自动回归通过；浏览器实际返回 Qoder detected 与 15 个模型选项。
- 完整桌面界面验收通过三种后端添加、Qoder 固定模型保存及重启恢复：`output/desktop-smoke-10tCks/report.json`。前一轮在截图步骤超时，未算通过；重跑成功。
- 安装包 `dist/Agent-Room-Setup-0.1.6-x64.exe`，尚未替换已安装版本。本次只实际验证 Qoder CN 0.4.8，其他版本需另行验证。

## 0.1.5 Codex 桌面后端优先

- 自动选择优先正在运行的桌面托管后端，再选择其他桌面后端，最后回退 npm/PATH。手动指定仍优先。
- 19/19 回归通过；打包界面验收报告 `output/desktop-smoke-aldAfO/report.json`。
- 浏览器版恢复自动选择后，实际选择桌面托管 `0.163.0`，成功读取 8 个模型。没有删除任何旧版本或应用安装文件。
- 安装包 `dist/Agent-Room-Setup-0.1.5-x64.exe`；已安装版本需要更新。如曾手动指定 npm 路径，更新后点击「恢复自动选择」。

## 0.1.4 Agent 工作区

- 添加界面支持自定义已有目录和默认 `workspaces/后端/Agent名称`；默认名称兼容 Windows 非法字符、保留名称及重名。
- 18/18 回归通过，包含同一 Agent 在不同房间使用相同 cwd、不同 Agent 使用独立目录、创建与重启持久化。
- 打包桌面界面验收通过默认目录创建、自定义目录保存及原有功能；原生目录选择器模拟返回。报告：`output/desktop-smoke-VnUPRq/report.json`。
- `scripts/check-live-workspaces.cjs` 为 Codex、DSH 各创建两个真实会话，验证 cwd 相同而会话 ID 不同；没有发送模型消息。证据：`output/live-workspaces-1xexn5/report.json`。
- 旧联系人继续使用原有目录；不自动移动用户文件。当前工作区在添加时配置，不提供已有 Agent 的迁移界面。
- 安装包：`dist/Agent-Room-Setup-0.1.4-x64.exe`；没有替换用户已安装的旧版。

## 0.1.3 固定模型与会话推理强度

- 本机 Codex 返回 7 个模型，DSH 返回 5 个提供商/模型组合；DSH 报告 off/low/high/max。以上为本机测试结果，不是对所有安装的固定列表。
- `scripts/check-live-models.cjs`：两种后端分别选择实际模型，同一会话以 low、high 完成两次真实模型回复，共 4 次。DSH 校验模型与推理配置应用成功，Codex 校验会话模型。报告：`output/model-live-aDt16r/report.json`。
- 16/16 回归通过：包含模型锁定、群聊推理隔离和恢复、ACP 提供商标识不碰撞、不虚构推理选项。
- 打包桌面应用在 PATH 无系统 Node 的环境通过真实模型下拉、Codex/DSH 群内推理设置与只读模型 UI，以及原有附件/群聊/恢复验收。报告：`output/desktop-smoke-o3ApXO/report.json`。
- 新安装包 `dist/Agent-Room-Setup-0.1.3-x64.exe`，没有替换用户已安装的旧版本；本次未重跑安装/卸载流程。Qoder 模型能力未验证，单 Agent 自定义工作区尚未实现。

## 0.1.2 Electron 下的 DSH 发现修复

0.1.1 的桌面界面验收没有断言本机真实 DSH 发现成功，遗漏了 Electron 将 ASAR 虚拟化为目录的差异。普通 `fs.openSync` 在 Electron 下无法读取外部 ASAR 文件头，错误被转为“未识别聊天入口”。现改用 `original-fs` 检查外部归档及其文件头；同样修复 Codex/Qoder 桌面主程序过滤中的 ASAR 文件判断。

- `scripts/check-desktop-discovery.cjs` 使用真实 ASAR 测试样本和打包 Electron，旧版复现失败，修复版通过。
- 设置 `CHECK_REAL_DSH=1` 额外验证本机 DSH 自动发现及真实 ACP initialize；已在修复后的打包 EXE 内通过，未发送模型消息。
- 界面实际显示“DSH · 已发现入口”，路径由系统安装记录提供。截图和报告：`output/discovery-desktop-4PyJOf/`。
- 13/13 Node 回归通过。产物：`dist/Agent-Room-Setup-0.1.2-x64.exe`。未重新执行安装/卸载流程。

## 0.1.1 自动发现与手动配置

新增安装包：`dist/Agent-Room-Setup-0.1.1-x64.exe`。

- 13/13 自动回归通过，新增自定义安装目录、Codex 桌面主程序过滤与内置 CLI 识别、版本刷新、手动配置持久化和失效处理、npm 启动器参数、配置 API 验证。
- 最终打包应用在 PATH 不包含系统 Node.js 的条件下通过界面验收：后端路径校验、浏览选择结果处理、保存与恢复自动选择，以及联系人、群聊、图片和外观恢复。
- 后端程序选择弹窗采用模拟返回值；未把这项测试描述为人工操作系统选择器验收。证据：`output/desktop-smoke-6KOySM/report.json`。
- 本机发现 Codex CLI 和桌面附带后端，通过系统安装记录发现 D 盘 DSH，并用自动生成的启动配置完成真实 ACP initialize 握手；未创建模型对话。
- 本机 Qoder CN 桌面版识别为已安装、需要补充聊天入口；未验证其 ACP 回复。
- 浏览器服务已重启加载新功能，原有数据保留。此次未重复进行安装/卸载验收；下面是 0.1.0 的历史结果。安装包仍未进行发布者签名。

## 0.1.0 历史验收

产物：`dist/Agent-Room-Setup-0.1.0-x64.exe`，111,215,455 字节。SHA-256：`6f321db0987087745ad0deb981a981313ec9b1d4d78ccea80cd7cb590d438012`。

Electron 44.7.2 / electron-builder 26.15.3，Windows x64 NSIS 安装向导。运行时 ZIP 已与 Electron npm 包提供的官方 SHA-256 核对。安装包尚未进行发布者代码签名；构建日志中的 signing 步骤不表示已签名。

## 已验证

- `npm test`：5/5 通过，涵盖联系人/群聊持久化、CHAT 策略、附件及记录恢复、后端失败隔离、桌面服务访问凭证。
- 已打包 EXE 实测：窗口载入、渲染进程隔离、添加 Agent、多选建群、原生文件选择与图片预览、退出后本地服务释放、再次启动恢复联系人/群聊/主题。
- 安装器实际静默安装到 `output/安装验收 Agent Room`，退出码 0。
- 实际安装后的 EXE 在子进程 PATH 不含系统 Node.js 的条件下再次通过相同桌面验收。
- 测试副本通过自身卸载器卸载，退出码 0，安装的 EXE 已不存在；隔离的测试聊天数据仍保留。
- 检查 `app.asar`：不包含用户数据、测试样本或构建依赖。

证据：`output/desktop-smoke-EMOFNY/report.json`（打包后）、`output/desktop-smoke-XRJB6h/report.json`（安装后）。同目录保存界面截图。

## 验收边界

未调用真实模型，未重复宣称 Codex / DSH / Qoder 真实回复通过。后端仍依赖用户本机的安装、登录或显式启动配置。未验证不同 Windows 版本/架构、自动升级或发布者签名。

构建依赖审计报告 7 项 moderate，来自 electron-builder 的下载/日志工具间接依赖；未执行破坏性的自动降级修复。它们不包含在已核对的运行安装包中。

桌面运行数据默认为 `%APPDATA%\Agent Room\data`，不写入安装目录。测试使用单独的 `AGENT_ROOM_DESKTOP_HOME`，未改动浏览器版已有数据。

2026-10-16 新界面验证：output/desktop-smoke-4mkvqt/report.json，12 项通过。新增右键置顶/取消置顶、Escape 关闭、重启持久化、直接编辑工作区并保留旧文件；既有模型读取、推理设置及删除确认也通过。npm test 28/28。已重新生成 0.1.8 安装包，未覆盖用户安装。

2026-10-16：29/29 回归通过；最终安装包对应的桌面程序通过 scripts/check-composer-ui.cjs，报告 output/composer-ui-3RNEFD/report.json。验证独立滚动、@ 输入候选筛选/键鼠选择/取消、Agent 与群聊重命名及名称更新。使用隔离的 30 联系人和 80 条模拟历史，不代表真实模型调用测试。

2026-10-16 数据目录：32/32 回归通过，包含手动迁移后的附件路径。打包桌面检查 output/data-location-ui-1Q2MWm/report.json：配置待切换、未复制回退、完整复制后启动切换及原目录保留通过。测试使用隔离目录，未迁移用户实际数据。

0.1.9：33/33 回归通过；最终优化打包核心桌面检查 output/desktop-smoke-CWhsSh/report.json 12 项通过。@所有人 双入口检查 output/composer-ui-uu7WUT/report.json。渲染合成基准及包体对照见 HANDOFF 0.1.9 节，不能解释为模型加速。

## 2026-10-20：群聊公开与匿名投票（源码验收）

- 最终 `npm test`：115/115 通过，0 跳过，记录 `output/polls-regression-final.log`。覆盖去重与改票、权限隔离、匿名读取和导出、持久化恢复、截止、成员退出、忙碌等待、重试上限和停止后的暂停。
- Electron 实际以 Node 模式从隔离 `app.asar` 启动 MCP 桥接，握手及工具调用通过；这项检查没有构建或覆盖安装器。
- 真实 MCP 闭环：Codex + DSH（`output/polls-live-impMex/report.json`）、DSH + Qoder（`output/polls-live-rVwBnd/report.json`）、DSH + WorkBuddy AI（`output/polls-live-r2Mpbg/report.json`），均完成创建、独立投票和全员自动结算。WorkBuddy 使用实际权限元数据中的工具名，只放行绑定的七个 Room 工具。
- 浏览器真实操作验证：匿名进行中隐藏票数和归属、公开详情、创建、提前结束、取消、切群保留草稿和刷新恢复。截图 `output/playwright/polls-public-anonymous.png`、`output/playwright/polls-final.png`。
- Claude 的桥接配置与工具权限通过自动化验证；本轮未验证其真实模型投票。WorkBuddy 国内版也未单独实测。匿名保证范围见 README。
- 使用隔离测试数据和新后端会话；没有迁移用户聊天数据，没有发布或覆盖已安装的桌面程序。

## 2026-10-20：0.1.30 构建交付

- 发布版本回归 `output/release-0.1.30-elxHfk/tests.log`：115/115 通过。
- 完整安装包 `dist/Agent-Room-Setup-0.1.30-x64.exe`；增量包 `dist/Agent-Room-Update-0.1.29-to-0.1.30-x64.zip`；校验清单 `dist/SHA256SUMS-0.1.30.txt`。
- 最终打包程序启动、版本和源文件匹配：`output/packaged-chat-fix-oXjEVV/report.json`。登记生命周期隔离检查：`output/registration-lifecycle-roPGOW`，退出暂停、重开恢复、无脱离主程序的登记 worker。
- ASAR 检查与实际增量应用：`output/release-0.1.30-elxHfk/artifact-audit.json`。47 个打包源文件与工作树一致；投票桥接在包内；私有数据和测试输出不在包内。升级副本的 3 个目标文件校验正确，测试数据与工作区保持完整。
- 本轮没有执行 NSIS 安装/卸载，没有更新用户已安装程序。构建与隔离验收成功不代表用户已经升级。
