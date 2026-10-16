# Agents Chatroom

本地多 Agent 聊天应用，基于 [dsh-agent-room](https://github.com/mocias/dsh-agent-room) 开发。支持 Codex、DSH、Qoder 单聊与群聊，提供浏览器和 Windows 桌面版。当前版本 **0.1.7**。

- 微信式联系人和群聊界面，目前只开放 CHAT。
- 真实模型列表、固定 Agent 模型、按会话调整推理档位（取决于后端能力）。
- Agent 独立工作区，默认 `workspaces/后端名称/Agent名称`。
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

- [详细交接与架构](HANDOFF.md)
- [产品范围](PRODUCT.md) / [验证记录](DESKTOP_VALIDATION.md)
- [原插件 README](docs/UPSTREAM_README.md) / [原交接记录](docs/UPSTREAM_HANDOFF.md)

MIT 许可证，保留上游归属。包名与插件入口继续使用 `dsh-agent-room`，以保留 DSH 插件兼容性；仓库名为 `agents-chatroom`。
