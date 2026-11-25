# DSH 已归档会话 · DSH Archived Sessions

**中文名 / Chinese name：** DSH 已归档会话
**English name：** DSH Archived Sessions

**中文简介：** 早期版归档面板，列出已归档会话并一键恢复；只改工作区记账，不改写会话日志。已被 dsh-archive-center 取代。
**English description：** Early archived-sessions panel that lists archived sessions and restores them; only edits workspace bookkeeping, never session logs. Superseded by dsh-archive-center.

**状态 / Status：** 历史版本 / Legacy

**安装 / Install：** 用 DSH 自带的「插件管理 → 添加插件」，输入本目录的绝对路径；或使用仓库 `dist/` 中对应的 `.tgz`。
Use DSH’s built-in **Plugins → Add plugin** and paste this folder’s absolute path; or install the matching `.tgz` from the repo’s `dist/`.

---

# 已归档会话（dsh-archived-sessions）

在 DSH 窗口**标题栏**加一个「已归档」按钮：点开可以看到所有被归档（从侧边栏收起）的会话，并一键恢复。

## 背景

DSH 原生没有「永久删除会话」，界面里的删除/收起实际是**归档**：会话日志始终留在
`~/.dsh/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd`，归档只改工作区记账
（`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`）。

本插件因此不需要任何「磁盘恢复」，恢复动作只调用 DSH 原生
`ctx.workspaceRegistry.unarchiveSession`，不读写会话日志。

## 使用

1. 刷新一次 DSH 页面（新的浏览器插件需要刷新才加载）。
2. 标题栏（Windows 标题栏「应用 / 编辑」右侧、插件商店按钮之后）出现「已归档」按钮。
3. 点开 → 列表显示会话标题、所属工作区、最后活动时间 → 点「恢复」。
4. 会话立即回到侧边栏，弹窗中该行标记为已恢复。

## 接口（Host 半侧）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-archived-sessions/health` | 公开健康检查（含浏览器半侧心跳） |
| POST | `/dsh-archived-sessions/ping` | 浏览器半侧心跳 |
| GET | `/dsh-archived-sessions/list` | 已归档会话列表 |
| POST | `/dsh-archived-sessions/restore` | `{ "sessionId": "..." }` 恢复归档 |

## 开发自测

```bash
node test/smoke-host.mjs
node test/smoke-client.mjs
```
