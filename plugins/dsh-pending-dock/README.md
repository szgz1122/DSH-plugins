# DSH 待办坞 · DSH Pending Dock

**中文名 / Chinese name：** DSH 待办坞
**English name：** DSH Pending Dock

**中文简介：** 工作区待办与挂起事件面板：把 `_待办/pending.json` 显示在 Harness Web UI 的输入框上方。
**English description：** Workspace pending-items dock: renders `_待办/pending.json` above the Harness Web UI composer.

**状态 / Status：** 可用 / Active

**安装 / Install：** 用 DSH 自带的「插件管理 → 添加插件」，输入本目录的绝对路径；或使用仓库 `dist/` 中对应的 `.tgz`。
Use DSH’s built-in **Plugins → Add plugin** and paste this folder’s absolute path; or install the matching `.tgz` from the repo’s `dist/`.

---

# 待办面板插件 · dsh-pending-dock

把工作区 `_待办/pending.json` 的**挂起事件与待办**显示在 DSH Web UI 输入框上方。

- 宿主半：`index.js` —— 两条带鉴权路由，读写那个 JSON
- 浏览器半：`client.js` —— 面板本体，挂在 `conversation.input.dock`
- **安装：用 `_tools/install_pending_dock.js`**（见下文「安装与迁移」）

## 安装与迁移

**本插件不是公开发布的 npm 包，无法用包名安装**，它随工作区一起走。

在别的设备上（工作区已迁移过去）：

```powershell
& $node _tools\install_pending_dock.js            # 安装 / 修复
& $node _tools\install_pending_dock.js --check    # 只体检
& $node _tools\install_pending_dock.js --uninstall
```

脚本会按**自身位置**推导工作区根，做四件事（幂等，可反复运行）：

1. 校验工作区内插件完好
2. 定位 DSH profile 目录（`$DSH_PROFILE_DIR` → `$DSH_HOME/profiles/<name>` → 兜底）
3. 写 profile 的 `package.json`：补 `link:` 依赖 + 加进 `dsh.profile.bundles`
4. 写 profile 的 `cordis.patch.yml`：补 `pending-dock` 的 insert 行
5. 建立 `node_modules/@local/dsh-pending-dock` **junction**

**装完必须重启 DSH**（宿主半改动不热更新）。

> **为什么必须用脚本**：profile 的 `package.json` 里是 `link:` **绝对路径**，指向
> 工作区内的插件目录。工作区一旦换设备或换位置，这个路径必然失效——所以每次
> 迁移后都要重跑一次安装器，把 link 指向新的实际位置。

## 架构：数据与视图分离

```
_待办/pending.json          ← 唯一数据源（普通文件）
        ↑ 读写
index.js（宿主半）           ← GET /api/pending.list  POST /api/pending.set
        ↑ 同源 fetch
client.js（浏览器半）        ← 折叠条 + 展开列表 + 勾选
```

**关键设计**：数据源是普通文件，**插件不是必需品**。

- 插件没装 / 没重启 / 挂掉了 → 用 `_tools/pending.py` 或直接编辑 JSON，一切照旧
- 插件只是把这些数据变得看得见、点得着

这样避免了"面板一坏，待办就丢了"的单点依赖。

## 依赖的官方 API

按 DSH 0.2.0-rc.2 确认：

| 用途 | API | 来源 |
|---|---|---|
| 注册路由 | `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` | 内置 `dsh-client-ui-deliverables` 的宿主半 |
| 注册插槽 | `ctx.slots.inject(ownerKey, () => ctx.slots.register(opts, Component))` | 官方 `cordis-plugin-development` 技能 |
| 客户端模块 | `window.__ModuleLoader__.load({ id, factory(require) })` | 同上 |

### 两个踩过的坑（重要）

**1. 客户端请求必须用「去掉前导斜杠」的相对路径**

桌面版前端跑在 Electron 的 `dsh-app://` 自定义协议下，不是 HTTP。写成绝对路径
`/api/pending.list` 会被解析成 `dsh-app://app/api/pending.list` → 404。

正确写法是 `api/pending.list`。内置插件同样如此——`deliverables` 的客户端就是
用 `CHANGED_FILES_PATH.slice(1)` 把宿主路由的 `/api/xxx` 转成 `api/xxx`。
**宿主半的路由路径仍然要写前导斜杠**（`/api/xxx`），两侧不对称，别写反。

**2. 挂载插槽是 `conversation.input.dock`**

实测确定的。同类候选的实测结果：

| 插槽 | 结果 |
|---|---|
| **`conversation.input.dock`** | ✅ 正常渲染（当前使用） |
| `conversation.composer.dock` | ❌ 官方文档推荐，但本版本下不显示 |
| `conversation.session.header.utilities` | ❌ 不显示 |
| `sidebar.footer.action` | ❌ 不显示 |

内置的待办面板也在 `input.dock` 这一带。

**3. 客户端改动刷新即生效，宿主半改动需要重启**

客户端 bundle 由宿主从磁盘读取后按 boot 图提供，改完刷新页面就生效（实测）。
宿主半（`index.js`）是新模块代，必须重启应用才重新加载。

## 安装

已装入 profile，接线如下。

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": {
  "@local/dsh-pending-dock": "link:C:/Users/xlszgz_2233/Desktop/锐胜，212汽车/_tools/dsh-pending-dock"
},
"dsh": { "profile": { "bundles": [ ..., "@local/dsh-pending-dock" ] } }
```

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- insert:
    - id: pending-dock
      name: "@local/dsh-pending-dock"
```

另需在 profile 的 `node_modules/@local/` 下建目录联接指向本包目录（已建）。
备份在 `_备份/profile-backup-*/`。

## 卸载

删掉上面两处配置 + 目录联接即可。**数据文件不受影响。**

## 扩展接口

### 加待办条目（不用改插件）

```powershell
$py = "C:\Users\xlszgz_2233\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py _tools/pending.py add --title "标题" --scope 212 --kind blocked --owner user
```

面板展开时每 8 秒自动刷新，无需重启。

### 加新的条目类型（kind）

1. `_tools/pending.py` 的 `KIND_LABEL` 加显示名
2. `index.js` 的 `KINDS` 数组加取值
3. `client.js` 的 `KIND_LABEL` / `KIND_COLOR` 加映射
4. 重启

### 加新的范围（scope）

`_tools/pending.py` 的 `SCOPE_KEYS` 加一项（**必须给 ASCII key**，否则 id 会变成中文前缀）。

### 换插槽位置

改 `client.js` 末尾 `ctx.slots.inject(...)` 的 slot 名。候选：

| 插槽 | 位置 |
|---|---|
| `conversation.input.dock` | 输入框上方（**当前使用，实测可用**） |
| `conversation.composer.dock` | ❌ 官方文档推荐，但本版本不渲染（见上文「两个踩过的坑」） |
| `sidebar.right.pane.tab` | 右侧栏标签页（需 children 树，较复杂） |
| `conversation.session.header.utilities` | ❌ 本版本不显示 |
| `shell.overlay` | 浮层（需自行定位） |

## 已知限制

- **客户端改动需要重启应用**，宿主半改动热生效
- 面板只能勾选完成/未完成；新增与编辑走命令行或直接改 JSON
- 未做优先级、截止日期、子任务——那属于任务管理器
- 浏览器可视化验证需人工确认（我无法操作已连接的页面）
