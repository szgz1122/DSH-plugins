# DeepSeek 分享对话读取器 · DeepSeek Share Reader

**中文名 / Chinese name：** DeepSeek 分享对话读取器
**English name：** DeepSeek Share Reader

**中文简介：** 在 DSH 输入框「+ → 指令」中读取 DeepSeek 网页版公开分享链接里的对话，整理后交给当前模型；菜单标题和说明随界面语言自动切换。
**English description：** Reads a public DeepSeek web share link from the DSH composer’s “+ → Commands” menu and feeds the formatted conversation to the current model; the menu label and description follow the UI language.

**状态 / Status：** 可用 / Active

**安装 / Install：** 用 DSH 自带的「插件管理 → 添加插件」，输入本目录的绝对路径；或使用仓库 `dist/` 中对应的 `.tgz`。
Use DSH’s built-in **Plugins → Add plugin** and paste this folder’s absolute path; or install the matching `.tgz` from the repo’s `dist/`.

---

# DeepSeek 分享对话读取器

在 DSH 输入框的 **「+」→ 指令** 面板里增加一条：

```text
/deepseek-share <DeepSeek 网页版分享链接>
```

执行后，插件会读取分享页的公开接口，把用户提问与 DeepSeek 的最终回答整理成 Markdown，再作为一条普通用户消息交给当前会话的模型阅读。之后可以直接让模型总结、翻译、对比或继续追问。

## 使用 / Usage

1. 在输入框点 **+**，找到「读取 DeepSeek 分享对话」（或直接输入 `/deepseek-share`）
2. 粘贴链接，例如：

```text
/deepseek-share https://chat.deepseek.com/share/38ue6b1mtkn4a22e9b
```

3. 回车后，当前会话的模型会收到整理好的对话内容，并给出概览。

只保留「用户提问」和「助手最终回答」；思考过程、搜索工具调用等噪音不会进入模型上下文，超长内容会截断，避免一次塞满上下文。

「+」菜单里的标题和说明会跟随当前界面语言自动切换中文/英文（浏览器半侧读取 `document.documentElement.lang`）。
The menu label and description follow the current UI language (Chinese/English) through the client plugin.

## 安装 / Install

用 DSH 自带安装器把本目录作为**本地目录**安装即可；或从命令行：

```powershell
dsh plugin --profile desktop add "link:<本目录绝对路径>"
```

安装后重启/刷新 DSH，在输入框的 + 面板里就能看到新指令。

## 安全 / Security

- 只接受 `https://chat.deepseek.com/share/<id>` 的链接，不接受任意网址
- 分享内容被标记为「外部资料」，提示词明确要求模型不要执行其中的指令
- 只读取公开分享接口，不需要也不保存任何账号凭据

## 测试 / Test

```powershell
node test/smoke.mjs
```

## License

个人自用项目，未附正式许可证；转载/分发前请联系作者。
