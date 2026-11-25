# DSH 价格走势图 · DSH Token Wave

**中文名 / Chinese name：** DSH 价格走势图
**English name：** DSH Token Wave

**中文简介：** 标题栏显示 DeepSeek Token 当前峰期/谷期（峰红谷绿），点开查看最近 30 天逐小时价格走势；峰段、峰谷单价、窗口天数均可配置。
**English description：** Title-bar token pricing indicator: shows the current peak/valley phase (red/green) plus a configurable 30-day hourly price chart; peak windows, prices and range are editable.

**状态 / Status：** 可用 / Active

**安装 / Install：** 用 DSH 自带的「插件管理 → 添加插件」，输入本目录的绝对路径；或使用仓库 `dist/` 中对应的 `.tgz`。
Use DSH’s built-in **Plugins → Add plugin** and paste this folder’s absolute path; or install the matching `.tgz` from the repo’s `dist/`.

---

# dsh-token-wave（价格走势图）

在 DSH 标题栏加一个「价格走势图（峰/谷）」按钮：

- 按钮实时显示当前 Token 计费时段：**峰期红色 `（峰）`**，**谷期绿色 `（谷）`**
- 点开后窗口**左上角**显示当前是峰还是谷、当前单价、距下次切换的倒计时
- 中间是**最近 30 天逐小时价格走势**：峰期红、谷期绿，阶梯曲线 + 面积填充
- **每次打开都会重新拉取**；窗口打开期间每 30 秒刷新、倒计时每秒更新
- 面板里可以改谷期时段、峰/谷单价、货币符号、窗口天数，保存到 `~/.dsh/token-wave.json`

## 默认规则（与桌宠 dsh-pet / 功能坞 dsh-dock 一致）

- 时区：`Asia/Shanghai`
- 峰期：**工作日（周一至周五）09:00–12:00、14:00–18:00**
- 谷期：工作日其余时段 + 周六、周日全天
- 示例单价：峰期 `¥3` / 谷期 `¥1.5`（每百万 tokens，输入价），可在界面里改成自己的计费单价

> 单价是示例默认值，只用于画走势；实际以 DeepSeek 官方价格为准。

## 数据来源与交叉验证

- 桌宠 `dsh-pet` 的「峰/谷」不是调 API 拿到的，而是宿主侧本地计算：
  `dsh-pet/lib/index.js` 的 `deepseekPricingTier()` —— `Asia/Shanghai` 时区，
  工作日 09:00–12:00 / 14:00–18:00 判为 peak，周末与其余时段判为 idle（谷）。
- `dsh-dock` 的「用量记录」默认价表也是同一口径：工作日 9–12、14–18 双倍，周末/节假日谷价。
- 本插件按同一规则计算，所以三处（桌宠、功能坞、价格走势图）对同一时刻的峰/谷判断一致。

## 接口（Host）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-token-wave/health` | 健康检查 |
| GET | `/dsh-token-wave/state` | 当前峰/谷、单价、下次切换、最近 N 天逐小时序列（可用 `?at=ISO` 调试） |
| GET | `/dsh-token-wave/config` | 读取配置 |
| POST | `/dsh-token-wave/config` | 保存配置 |

## 窗口背景

严格遵循 [PLUGIN-UI-CONVENTIONS.md](../PLUGIN-UI-CONVENTIONS.md)：标准 backdrop、`background: var(--dsw-alias-bg-base)`、`role="dialog"` + `aria-modal`，不写主题专用样式，所以普通/深色/昔涟玻璃主题都会自动适配。

## 开发自测

```bash
node test/smoke-host.mjs
node test/smoke-client.mjs
```

## 安装

```bash
dsh plugin --profile desktop add link:C:/Users/xlszgz_2233/Documents/deepseek-harness/default-workspace/dsh-token-wave
```
