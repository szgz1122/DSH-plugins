# DSH 插件合集 · DSH Plugins Collection

> 自用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件源码合集，按插件分目录存放，方便单独安装、阅读和二次开发。
> A collection of self-made DeepSeek Harness (DSH) plugins, one folder per plugin, kept for installation, reading and further development.

---

## 插件列表 / Plugins

| 插件 / Plugin | 版本 / Version | 状态 / Status | 中文简介 | English description |
| --- | --- | --- | --- | --- |
| **dsh-archive-center** | 0.2.1 | 可用 / Active | 标题栏「已归档」按钮：查看被归档（隐藏）的会话，可恢复（工作区缺失时按原目录重建），或经二次确认后彻底删除（含子会话）。 | Adds an “Archived” title-bar button to browse archived (hidden) sessions, restore them (recreating the workspace folder when missing), or permanently delete them after confirmation (including child sessions). |
| **dsh-token-wave** | 0.2.1 | 可用 / Active | 标题栏显示 DeepSeek Token 当前峰期/谷期（峰红谷绿），点开查看最近 30 天逐小时价格走势；峰段、峰谷单价、窗口天数均可配置。 | Title-bar token pricing indicator: shows the current peak/valley phase (red/green) plus a configurable 30-day hourly price chart; peak windows, prices and range are editable. |
| **dsh-deepseek-share** | 0.1.0 | 可用 / Active | 「+ → 指令」里的「读取 DeepSeek 分享对话」：粘贴 DeepSeek 网页版分享链接，读取对话并交给当前模型；标题与说明中英自动切换。 | “Read DeepSeek shared chat” in the composer’s + → Commands menu: paste a DeepSeek web share link, read the conversation into the current model; label/description follow the UI language. |
| **dsh-pending-dock** | 1.0.0 | 可用 / Active | 工作区待办与挂起事件面板：把 `_待办/pending.json` 显示在 Harness Web UI 的输入框上方。 | Workspace pending-items dock: renders `_待办/pending.json` above the Harness Web UI composer. |
| **dsh-web-search-multi** | 0.1.1 | 可用 / Active | 给 DSH 的 web 搜索 seam 增加多个搜索提供商（Bocha、Tavily、Brave、Exa、Perplexity、智谱、MiniMax、SearXNG、DuckDuckGo）的宿主插件，没有客户端界面。 | Host-only plugin adding extra web-search providers (Bocha, Tavily, Brave, Exa, Perplexity, Zhipu, MiniMax, SearXNG, DuckDuckGo) to DSH’s web search seam; no client UI. |
| **dsh-archived-sessions** | 0.1.0 | 历史版本 / Legacy | 早期版归档面板，列出已归档会话并一键恢复；只改工作区记账，不改写会话日志。已被 `dsh-archive-center` 取代。 | Early archived-sessions panel that lists archived sessions and restores them; only touches workspace bookkeeping, never session logs. Superseded by `dsh-archive-center`. |
| **dsh-session-unarchive** | 1.0.0 | 历史版本 / Legacy | 早期会话恢复的宿主侧能力，无客户端界面。 | Early host-side session-unarchive helper; no client UI. |

> `dsh-plugin-store`（标题栏「演示 DEMO」按钮、插件商店/插件管理/配置迁移，含 174 MB 演示视频）**不包含在本仓库**，它单独打成了压缩包。
> `dsh-plugin-store` (the “Demo” title-bar button plus plugin store / plugin manager / config migration, including its 174 MB demo video) is **not included in this repository**; it is distributed separately as a zip.

---

## 如何安装（使用 DSH 自带的插件安装器）/ How to install (with DSH’s built-in installer)

DSH 自带安装器入口 / Built-in installer entry:

1. 打开 DSH → **插件管理** / Open DSH → **Plugins / 插件管理**
2. 点右上角 **添加插件** / Click **Add plugin** in the top-right corner
3. 在输入框里填插件包名、Git 地址、**本地目录绝对路径**或**压缩包绝对路径** / Paste a package name, Git URL, **absolute local directory path**, or **absolute tarball path**
4. 点 **安装**，安装完成后启用插件，重启/刷新 DSH 生效 / Click **Install**, enable the plugin, then restart or refresh DSH

安装源（npm 官方源 / 镜像源）只影响从 npm 注册表安装的插件；用本地目录或压缩包安装时保持默认即可。
The **Install source** selector only applies to plugins fetched from an npm registry; keep the default when installing from a local directory or tarball.

### 方式 A：从本仓库的本地目录安装（推荐）/ Method A: local directory (recommended)

1. 在本页点 **Code → Download ZIP** 下载整个仓库并解压，或 `git clone` / On this page click **Code → Download ZIP** (or `git clone`) and extract it
2. DSH → 插件管理 → 添加插件 / DSH → Plugins → Add plugin
3. 把对应插件子目录的绝对路径填进输入框 / Paste the plugin subfolder’s absolute path into the input, e.g.:

```text
D:\somewhere\DSH-plugins\plugins\dsh-token-wave
```

4. 安装 → 启用 / Install → enable

> 本仓库是“多插件合集”，仓库根目录不是单个插件，所以**不要直接填整个仓库的 GitHub 地址**；请指向具体插件子目录，或使用下面的压缩包方式。
> This repository is a multi-plugin collection and its root is not a single plugin, so **do not paste the whole repository URL**; point the installer at a specific plugin subfolder, or use the tarball method below.

### 方式 B：用仓库里的 `dist/` 压缩包 / Method B: prebuilt tarballs in `dist/`

1. 从本仓库下载对应插件的 `.tgz` 文件（例如 `dist/dsh-token-wave-0.2.1.tgz`）到本机 / Download the plugin’s `.tgz` from this repository (e.g. `dist/dsh-token-wave-0.2.1.tgz`)
2. DSH → 插件管理 → 添加插件 / DSH → Plugins → Add plugin
3. 粘贴这个 tgz 文件的绝对路径 / Paste the tarball’s absolute path
4. 安装 → 启用 / Install → enable

> 所有插件都带 `cordis.patch.yml`，可以直接用上面的方式安装；`dsh-web-search-multi` 安装后需要在插件配置里选择搜索提供商（见该目录 README）。
> Every plugin ships a `cordis.patch.yml` and can be installed this way; after installing `dsh-web-search-multi`, choose its search provider in the plugin configuration (see its README).

### 使用 dsh-deepseek-share / Using dsh-deepseek-share

安装后，在输入框点 **+ → 指令 → 读取 DeepSeek 分享对话**，粘贴 DeepSeek 网页版分享链接，例如：

```text
/deepseek-share https://chat.deepseek.com/share/38ue6b1mtkn4a22e9b
```

插件会读取公开分享接口，把「用户提问 + DeepSeek 最终回答」整理后交给当前模型；不会把思考过程或搜索工具调用塞进上下文。菜单标题/说明会根据界面语言自动切换中文/英文。

After installing, open **+ → Commands → Read DeepSeek shared chat** and paste a share link:

```text
/deepseek-share https://chat.deepseek.com/share/38ue6b1mtkn4a22e9b
```

The plugin reads the public share API, formats the questions and final answers, and sends them to the current model. The menu label and description follow the UI language.

### 方式 C：高级 / 命令行 / Method C: advanced / CLI

```powershell
git clone https://github.com/<owner>/<repo>.git
dsh plugin --profile desktop add "link:<绝对路径>/DSH-plugin-collection/plugins/dsh-token-wave"
```

---

## 仓库结构 / Repository layout

```text
DSH-plugins/
├── README.md                 ← 本文件 / this file
├── dist/                     ← 可直接安装的 tgz 包 / prebuilt installable tarballs
└── plugins/
    ├── dsh-archive-center/
    ├── dsh-archived-sessions/
    ├── dsh-session-unarchive/
    ├── dsh-token-wave/
    ├── dsh-deepseek-share/
    ├── dsh-pending-dock/
    └── dsh-web-search-multi/
```

每个插件目录都是独立的 DSH 插件包（含自己的 `package.json`、`cordis.patch.yml`、源码和 README）。
Each plugin folder is a standalone DSH plugin package with its own `package.json`, `cordis.patch.yml`, source and README.

---

## 兼容性 / Compatibility

- 目标 DSH：**0.2.x**（在 `0.2.2-rc.5` 上验证） / Target DSH: **0.2.x** (verified on `0.2.2-rc.5`)
- 插件以本机用户权限运行；安装第三方来源的插件前请先阅读源码 / Plugins run with your local user permissions; read the source before installing anything from third parties
- 历史插件（`dsh-archived-sessions`、`dsh-session-unarchive`）保留仅为参考，新环境优先用 `dsh-archive-center` / Legacy plugins are kept for reference; prefer `dsh-archive-center` in new setups

## 许可 / License

这些插件是个人自用项目，未附正式开源许可证；转载、分发或商用前请先联系作者。
These are personal projects without a formal open-source license; contact the author before redistribution or commercial use.
