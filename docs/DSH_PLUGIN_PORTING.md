# 给 DSH：Qoder 桌面后端与 Agent 工作区移植

目标：把独立应用已完成的能力移植到 DSH 内的 agent-room 插件。**原插件尚未完整接入**。独立应用入口在 standalone/；原插件入口在 lib/index.js 和 public/room-ui.js。请结合根目录 HANDOFF.md 阅读。

## 1. Qoder 桌面版为什么不能按普通 CLI 检测

已实测 Qoder CN 0.4.8，附带 SDK 1.0.52 / Worker 1.1.69。它不是一个可直接加 --acp 的桌面窗口，而是提供了可运行的 SDK Worker。相关安装结构：

```text
Qoder CN.exe
resources/app.asar
  node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/index.js
resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/
  dist/_worker/qoder-worker-runtime.obf.mjs
```

国际版候选包名 qoder-agent-sdk，代码支持识别但未做真实国际版验收。安装目录可能位于 .qoder-versions/<版本>/，不要写死盘符、用户目录、版本号。优先选正在运行且结构验证通过的桌面后端。

## 2. 已实现的启动链

阅读 standalone/discovery.cjs 的 qoderDesktopLaunch、adapt、archiveHas，以及 standalone/qoder-worker.cjs。

1. 同时验证 EXE、ASAR 内 SDK 条目、外部 Worker 文件。
2. 启动 Qoder 自身 EXE，环境 ELECTRON_RUN_AS_NODE=1；参数为本项目桥接脚本与 Worker 绝对路径。
3. 桥接通过 worker_threads.Worker 运行内置模块，argv 为 --acp，传入 cwd/runtimeRoot。
4. 转发标准输入/输出/错误；stdout 只能输出协议 JSON-RPC。
5. 复用 lib/acp-backend.cjs 完成 initialize、session/new、session/prompt、取消和释放。

保留 EOF/信号退出处理；不要启用绕过权限参数，不要拼 shell 命令，不要复制或提交 Qoder 专有运行时。后端与本项目保持分别安装。

Electron 的 fs 会把 ASAR 虚拟化成目录。读取外部归档头及判断是否为文件时使用 original-fs；普通 Node 使用 node:fs。曾出现浏览器发现成功、打包桌面失败，原因就在这里，不能只跑 Node 测试。

## 3. 认证、模型与推理

- 发现入口、initialize、新会话、真实回复是四层独立验证。
- 初次 session/new 返回 Authentication required；使用内置 Worker 官方浏览器登录后已通过真实回复。
- 开发辅助：在项目根运行 `node scripts/login-qoder.cjs`；不用另装 CLI。插件侧应设计自己的登录交互，不依赖独立应用的数据目录假设。
- 不读取、打印、复制用户令牌。官方认证说明：https://docs.qoder.cn/cli/authentication 。
- standalone/models.cjs 读取 ACP configOptions，保留原始模型 value。当前本机 Qoder 返回 15 项，不能写死数量或名称。
- auto 是自动选模策略，锁定它不等于锁定某个具体模型。
- 当前 Qoder 未返回 thought_level，不提供虚构的 low/high 开关。CLI 有 reasoning 参数不代表 ACP 支持动态切换。
- DSH 的模型 value 可能是 JSON 字符串 `["provider","model"]`。同名模型可能来自不同提供商，不能以显示名称去重。

## 4. 工作区产品规则

Agent 保存 workspace 绝对路径。选择自定义目录时要求已存在；留空创建：

```text
<插件专属数据目录>/workspaces/<backend>/<Agent名称>/
```

复用 standalone/workspaces.cjs：替换非法文件名字符、处理 Windows 保留名、同名已有目录追加数字，不复用碰撞目录。不要把误输的自定义路径静默创建出来。

同一 Agent 被拉入 A/B 群，cwd 相同，但分别创建后端会话。文件共享、对话独立。cwd 不是访问权限沙箱。重启后本地历史恢复不等于原生 session ID 恢复，当前仍可能重建会话并重放历史。

旧 Agent 保留原目录，不移动已有文件。当前没有编辑/迁移已有 Agent 工作区的界面。

## 5. 原 DSH 插件必须补的地方

| 位置 | 待移植内容 |
| --- | --- |
| lib/harnesses.cjs | 原插件 detect/launch 仍主要使用 PATH；接入桌面发现和 Worker 桥接，不能依赖 standalone HTTP 服务 |
| lib/index.js | 插件扫描许可、配置持久化、宿主文件夹选择器与插件数据根目录 |
| public/room-ui.js | 添加工作区字段、真实模型下拉、扫描说明和手动路径提示 |
| lib/room.cjs | _newMember/ensureThread 已认识 workspace；但原插件 roster 序列化与公开字段还要补 workspace、modelLocked、effort |
| lib/index.js:createSessionFiler | 当前优先使用 backend 共用目录，应优先采用会话事件的实际 cwd，避免归错工作区 |
| lib/server.cjs | 检查成员增改 API、字段校验、公开快照，防止新字段丢失或被旧逻辑覆盖 |

只能把 DSH 自己的会话交给宿主 workspaceRegistry.attachSession；不能把 Qoder session ID 当作 DSH session ID。

## 6. 扫描前必须取得选择

独立应用用 discovery-consent.json 保存 automatic/manual；不存在代表未选择。未选择/manual 时禁止查询安装记录、进程、PATH和遍历目录，仅校验用户明确选择的程序文件及相邻运行时。

**BackendDiscovery 工具类的 allowAuto 默认是 true。插件必须显式传入许可状态，并审计旧 detectHarnesses/launchOptions 调用是否绕过限制。** 开发验收脚本直接调用发现器，不代表 UI 可跳过告知。

手动路径提示建议：右键桌面或开始菜单 Agent 快捷方式 → 打开文件所在位置；若仍是快捷方式，查看属性中的目标，复制程序文件完整路径。桌面可用原生选择器；手动模式不扫描目录。

## 7. 验收清单

1. 中文/空格路径、自定义盘符、只有桌面没装 CLI、程序运行/退出两种状态。
2. 拒绝/未决定时系统发现函数调用次数为零，手动配置仍可用。
3. Node 与真实打包 Electron 都验证初始化、新会话和一条真实回复。
4. 同后端两个 Agent 的 cwd 不同；同 Agent 两个群聊 cwd 相同但 session ID 不同。
5. 重载插件不丢字段；旧目录不被移动。
6. 固定模型失败要报错；缺少推理能力时不编造选项。
7. 释放房间/关闭插件不残留自建后端，也不能结束宿主或别的 Agent 进程。

参考 checks/discovery.test.cjs、checks/workspaces.test.cjs、scripts/check-live-qoder.cjs、scripts/check-desktop-qoder.cjs。真实脚本会创建会话，部分会发送模型请求；应使用隔离目录并记录实际边界。
