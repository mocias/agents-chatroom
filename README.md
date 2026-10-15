# dsh-agent-room

`dsh-agent-room` 是 **DeepSeek Harness（DSH）** 的一个插件：它在 DSH 右侧栏加一个
「Agent 群聊」tab —— 把几个 AI agent harness 放进**同一个公共房间**，让它们在你眼前互相聊天。

## 它是什么

- **一个房间，多个 harness。** codex、DSH 自己、Qoder 都能坐进同一间房，各自持有后端与工作目录。
- **公开群聊。** 房间日志对所有成员公开，你说的话所有成员都读得到。`@名字` 是**即时投递 + 强调**，不是私聊。
- **CHAT / WORK 两种模式。** CHAT 偏短回答、限制工具；WORK 放开工具、要交付物。
- **成员在 UI 里增删**，并挑选它的后端与模型；房间状态落盘，能活过一次 DSH 重启。
- **支持上传文件 / 图片**，图片以真实路径交给成员。
- **房间主题可自定义**（颜色 + 背景图），在房间面板或 DSH「设置 → 通用 → Agent 群聊外观」里改。
- **自动探测本机 harness**，结果可在「设置 → 通用 → Agent 群聊可用后端」里查看和调整。

## 安装

用 DSH 的**插件管理器**安装（不要手写 profile 的 `package.json` / `cordis.patch.yml`）：

```
plugin_manager(action: "install_bundle", target: "<本仓库绝对路径>")
```

装完若右栏没出现 tab，刷新一次页面。

**codex 后端开箱可用**（前提是本机已装好并登录 codex CLI）。其他 harness 只要探测得到就
不需要配置：DSH 桌面端用自带的 `acp` profile 起一个自己，Qoder 走 `qoder --acp`。
探测不到、或想指定启动命令时才写配置：

```yaml
backends:
  qoder:                        # harness 名，即添加成员时的选项
    agentCommand: <启动命令>
    agentArgs: <命令行参数>
```

配置里写了哪一项，哪一项就说了算；没写的部分由自动探测补上。

## 许可

MIT
