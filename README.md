# ST-Input 输入助手

SillyTavern 的输入框扩展。结合当前聊天整理草稿，遇到影响结果的歧义时先问你，也可以基于最近一条模型回复生成后续问题。

## 安装

要求 SillyTavern **1.19.0 或更新版本**。在 SillyTavern 的「扩展 → 安装扩展」填入仓库地址：

```text
https://github.com/zyx486013/ST-Input
```

刷新页面后，点击发送框旁的「输入助手」。可直接跟随当前聊天连接，或在「连接设置」选择 ST 已保存的连接配置。

### 在输入助手里配置自定义 API

自定义模式需要配套服务端插件。将仓库的 `server` 目录复制为 **SillyTavern 根目录下的 `plugins/st-input`**，确认其中直接包含 `index.mjs` 和 `upstream.mjs`。在 SillyTavern 的 `config.yaml` 中设置 `enableServerPlugins: true`，然后重启 SillyTavern。更新前端扩展后，手动复制新版服务端文件并重启即可更新服务端插件。

用 ST 管理员账号打开「输入助手 → 连接设置 → 自定义 API」，填入：

- **API 地址**。使用 OpenAI 兼容的 Base URL，例如 `https://api.example.com/v1`。也可以粘贴完整的 `/chat/completions` 地址。
- **API Key**。无需认证时可以留空。已保存的 Key 由服务器在对应 ST 用户的数据目录保存。清除 Key 后点保存即可删除。
- **模型 ID**。手动填写，或点「获取模型」后从输入框的候选项选择。
- **测试连接**。用表单中的地址、Key 和模型发一条固定测试消息。测试后点「保存自定义 API」，正式调用使用已保存的配置。

局域网或 localhost 上的 API 由 **SillyTavern 服务端**访问。在启动 ST 前，用 `ST_INPUT_LOCAL_ORIGINS` 允许具体的本地来源，值写协议、主机和端口。多个来源用逗号分开。如果 ST 运行在 Docker 里，按容器实际能访问的主机名填写。

Linux 示例：

```sh
ST_INPUT_LOCAL_ORIGINS=http://127.0.0.1:1234 node server.js
```

Windows PowerShell 示例：

```powershell
$env:ST_INPUT_LOCAL_ORIGINS = 'http://127.0.0.1:1234'
node server.js
```

扩展里的 API 地址可填 `http://127.0.0.1:1234/v1`。公网地址使用 HTTPS。

## 草稿和上下文

| 操作 | 用法 |
| --- | --- |
| 帮我说清楚 | 根据草稿和上下文给出可编辑的建议，或先提出具体问题 |
| 先问我 | 找出影响结果的歧义，支持点选或填写答案，再合并成最终草稿 |
| 帮我追问 | 根据最后一条模型回复拟写追问，输入框可以留空 |

默认读取当前会话最近 8 条可见消息。可以调整消息数、指定一条旧消息作为参考，或关闭聊天上下文。需要参考上一条模型回复的「帮我追问」需开启聊天上下文。

「提示词预览」可查看扩展组装的内容。顺序是系统规则和输出格式、指定参考消息、最近聊天、追问对象（如适用）、草稿、澄清答案、本次任务。用 Chat Completion 时会组装为 `system` 和 `user` 两条消息。ST 使用 Text Completion 时会按其连接或 Instruct 配置转换格式。

「填入输入框」只更新草稿。正式发送时，ST 用主聊天连接和当前预设组装请求。角色卡、世界书和作者注释由 ST 在正式发送时处理。

## 开发验证

```sh
npm test
```
