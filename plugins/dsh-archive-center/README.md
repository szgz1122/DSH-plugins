# DSH 归档中心 · DSH Archive Center

**中文名 / Chinese name：** DSH 归档中心
**English name：** DSH Archive Center

**中文简介：** 标题栏「已归档」按钮：查看被归档（隐藏）的会话，可恢复（工作区缺失时按原目录重建），或经二次确认后彻底删除（含子会话）。
**English description：** Adds an “Archived” title-bar button to browse archived (hidden) sessions, restore them (recreating the workspace folder when missing), or permanently delete them after confirmation (including child sessions).

**状态 / Status：** 可用 / Active

**安装 / Install：** 用 DSH 自带的「插件管理 → 添加插件」，输入本目录的绝对路径；或使用仓库 `dist/` 中对应的 `.tgz`。
Use DSH’s built-in **Plugins → Add plugin** and paste this folder’s absolute path; or install the matching `.tgz` from the repo’s `dist/`.

---

# 归档中心（dsh-archive-center）

在 DSH 窗口**标题栏**加一个「已归档」按钮：列出所有被归档（从侧边栏收起）的会话，并支持：

- **恢复**：只改工作区记账，绝不改写会话日志。若该会话的工作区记录已缺失（例如工作区被删除），会用它自己的原始 cwd 重建工作区，再把会话挂回去。
- **彻底删除**（红色按钮 + 二次确认）：从本设备删除该会话**及其全部子会话**的日志目录、投影缓存，并从工作区记账 / 归档集合 / 置顶集合中移除。**不可恢复。**

## 背景

DSH 原生没有「永久删除会话」：界面里的删除/收起实际是**归档**。会话日志始终在
`~/.dsh/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd`，归档只改工作区记账
（`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`）。

## 使用

1. 刷新一次 DSH 页面（新的浏览器插件需要刷新才加载）。
2. 标题栏出现「已归档 N」按钮（在插件商店按钮之后）。
3. 点开 → 每行会话有「恢复」和红色「删除」：
   - 点「恢复」：会话回到侧边栏；工作区缺失的行会显示「恢复工作区」，会先重建工作区。
   - 点「删除」：弹出「是否确认删除该会话？」确认窗 → 红底「确认删除」/「取消」。
     确认后彻底删除（含子会话），不可恢复。

## 接口（Host 半侧）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-archive-center/health` | 公开健康检查（含浏览器半侧心跳） |
| POST | `/dsh-archive-center/ping` | 浏览器半侧心跳 |
| GET | `/dsh-archive-center/list` | 归档会话列表（含工作区状态、子会话数、cwd） |
| POST | `/dsh-archive-center/restore` | `{ "sessionId": "..." }` 恢复（必要时重建工作区） |
| POST | `/dsh-archive-center/delete` | `{ "sessionId": "..." }` 级联彻底删除 |

## 开发自测

```bash
node test/smoke-host.mjs
node test/smoke-client.mjs
```

## 窗口背景规范

归档窗口与二次确认层统一遵守 [PLUGIN-UI-CONVENTIONS.md](../PLUGIN-UI-CONVENTIONS.md)：

- 遮罩 `rgba(12,14,18,.46)`，窗口 `background: var(--dsw-alias-bg-base)`
- 窗口与确认层都带 `role="dialog"` + `aria-modal="true"` + `aria-label`
- 不写昔涟/主题专用样式，玻璃效果由主题对 `[role="dialog"]` 统一处理
