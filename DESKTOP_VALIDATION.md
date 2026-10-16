# Windows 桌面版验收 · 2026-10-16

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
