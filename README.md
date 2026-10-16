# Agents Chatroom

本地多 Agent 聊天应用，基于 [dsh-agent-room](https://github.com/mocias/dsh-agent-room) 开发。支持 Codex、DSH、Qoder 单聊与群聊，并提供 WorkBuddy 国内版与 WorkBuddy AI 国际版的实验性本机接入。提供浏览器和 Windows 桌面版。当前版本 **0.1.10**。

- 微信式联系人和群聊界面，目前只开放 CHAT；支持重命名、Agent 置顶和独立滚动。
- 输入 @ 选择当前成员或“所有人”，流式回复增量渲染。
- 真实模型列表、固定 Agent 模型、按会话调整推理档位（取决于后端能力）。
- Agent 独立工作区，桌面版默认 `安装目录/agents/后端名称/Agent名称`，浏览器版默认 `项目目录/agents/...`；旧 Agent 保持原路径。
- 删除 Agent 时选择保留或删除工作区，默认保留；共享目录和危险路径禁止删除。
- 扫描前告知，可拒绝扫描并手动配置。
- 文件、图片附件及外观设置，数据保存在本机。

## 启动

需要 Node.js 22+；浏览器版没有额外运行依赖：

```sh
npm start
```

打开 http://127.0.0.1:4318 。后端需分别安装并登录。

```sh
npm ci
npm test
npm run desktop
npm run desktop:dist
```

桌面构建面向 Windows x64，产物在 `dist/`。安装包未签名，尚无自动升级；用户数据及构建产物不随源码上传。首次安装开发依赖需要下载 Electron。

## 文档

WorkBuddy：在后端管理中选择对应 WorkBuddy.exe / WorkBuddyAI.exe，保持当前 Windows 用户的桌面应用已登录运行，并先在桌面发送过一条消息。群聊通过该桌面的运行时管理接口启动独立聊天运行时，复用已有登录，无需在群聊中再次授权。每位群成员使用独立运行时、会话和工作区。连接保留本机接口认证，不导出桌面账号凭据。该接口依赖安装版本，目前在 WorkBuddy AI 5.8.4 验证；不保证其他版本兼容。另一个 Windows 用户下运行的国内版，需要在其所属用户会话下运行连接程序，尚未完成跨用户接入。桌面原生任务列表显示尚未验证。

真实检查：`node scripts/check-live-workbuddy.cjs workbuddy=国内版程序完整路径 workbuddy-ai=国际版程序完整路径`；有空格的参数需要整体加引号。加 `--chat` 才发送固定文字的模型测试请求。真实群聊检查：启动本地服务后，运行 `node scripts/check-live-workbuddy-group.cjs 国际版程序完整路径`，会在应用中创建测试联系人和群聊并发送模型请求。脚本不自动登录、不复制桌面凭据。

- [详细交接与架构](HANDOFF.md)
- [实际提示词](docs/PROMPTS.md)
- [产品范围](PRODUCT.md) / [验证记录](DESKTOP_VALIDATION.md)
- [原插件 README](docs/UPSTREAM_README.md) / [原交接记录](docs/UPSTREAM_HANDOFF.md)

MIT 许可证，保留上游归属。包名与插件入口继续使用 `dsh-agent-room`，以保留 DSH 插件兼容性；仓库名为 `agents-chatroom`。

原桌面端同步尚未完整实现：Codex 后端项目创建和会话关联已接入，但当前桌面 UI 的项目列表仍有独立状态；DSH/Qoder 桌面注册尚未接通。同步接口返回具体状态，不宣称全部同步成功。工作区根可用 `AGENT_ROOM_WORKSPACE_ROOT` 覆盖；安装目录不可写时需指定已有可写目录。
重启agent harness后可以看到此前生成的对话

## 代理与安装路径

默认沿用应用进程的代理环境；没有配置时不强制设置代理端口。TUN 网络由系统路由处理。需要单独指定时，在“后端管理 → 仅此后端使用的代理”填写实际 HTTP/SOCKS 地址，留空恢复继承；只影响 Room 启动的该后端，不修改系统代理或 Dot 设置。WorkBuddy 使用其桌面应用的网络配置。

后端程序、Room 数据和 Agent 工作区可以位于不同磁盘。新联系人无需预先创建旧共享工作区；进程使用有效目录启动，会话继续使用各自的工作区。跨盘真实 Codex 验证及尚未覆盖的代理模式见 HANDOFF。

## 自定义数据目录（手动迁移）

在“后端管理 → 数据目录与手动迁移”设置新路径。保存仅登记下次启动的目标，不自动复制、删除或立即切换。完全退出桌面应用（浏览器版停止服务）后，复制当前数据目录内全部内容到新目录，再启动。系统核对旧目录文件与新目录副本，未复制或内容不一致时保留旧目录并显示原因；可取消待切换。

工作区路径不自动修改；安装目录 agents/ 或用户自选工作区仍使用原路径。旧数据目录内的 workspaces 也需自行复制，并在对应 Agent 设置里更新工作区路径。确认数据和工作区可用后再自行处理旧目录。
