# dsh-desktop-alerts

中文 | [English](README.en.md)

QQ 风格的 DSH 桌面提醒插件（Windows 桌面端）。

当一个会话进入「需要你」的状态时 —— 需要审批 / 需要回答 / 需要确认计划，
或会话被外部打断（停止、报错、额度用尽），或会话在后台完成了回复而你还未查看 ——
本插件会像 QQ 一样提醒你：

- **一个提示音**：所有情况都用同一段录音，五声短促的「滴」，每次发生只响一遍。
- **托盘图标闪动**：右下角系统托盘里的图标像 QQ 未读消息那样**整体**闪动，
  只有把所有触发提醒的会话都读掉之后才停；跟你当前在看哪条会话无关。
- **未读浮窗**：右下角列出待处理会话，点击直达该会话。

## 安装

**推荐：从 DSH 插件市场安装**，之后升级只需点一下按钮。

在「插件市场 → 索引源」里添加这个地址：

```
https://raw.githubusercontent.com/fishingninja/ds-harness-notice-QQlike/main/market/index.json
```

然后搜索 `桌面提醒` 或 `dsh-desktop-alerts`，点安装即可。市场会自动读取你已装的版本，有新版本时那一行会变成「更新」，点一下就升级。

**或者直接用 Git 安装**（不配置索引源）：

```powershell
# 在你运行 DSH 所用的 profile 里
dsh plugin install "git+https://github.com/fishingninja/ds-harness-notice-QQlike.git#main&path:/packages/dsh-desktop-alerts"
```

注意 `path:` 指向子目录：这个仓库是 monorepo，插件本体在 `packages/dsh-desktop-alerts`。

**从源码目录安装**（开发时用这个，改完源码重新启用即可生效）：

```js
plugin_manager({ action: "install_bundle", target: "E:\\path\\to\\ds-harness-notice-QQlike\\packages\\dsh-desktop-alerts" })
```

插件只插入一个宿主条目和一个客户端模块，装好即用，无需额外配置。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主端：注册 `/flash`、`/state`、`/sound` 三条路由，记录每次 `turn/end` 的结果，调用 PowerShell 助手 |
| `lib/flash-window.ps1` | 托盘叠加层助手：在托盘图标上盖一层点击穿透的透明窗口，用染红的图标副本与原图交替闪动 |
| `lib/alert.m4a` | 唯一的提示音（MP4/AAC，0.93 秒） |
| `client.js` | 客户端：监听会话状态，分类提醒，播放提示音，绘制未读浮窗与设置页 |
| `locale/{zh,en}.json` | 插件展示信息 |
| `icon.svg` | 插件图标 |

## 什么情况会提醒

| 情形 | 判断依据 |
| --- | --- |
| 会话在等待审批 / 回答 / 确认计划 | `sessionStatus.pendingInteraction` |
| 回合被中断（`aborted` / `error` / `max-tokens` / `interrupted` / `blocked`） | 宿主 `session/event` 的 `turn/end` 原因，经 `/state` 路由查询 |
| 回复完成且仍未读 | `sessionStatus.completionUnread` |

正常完成（`completed` / `forked`）永远算「完成」，不会被误判成中断：
这个事实来自宿主端的 `turn/end` 事件，而不是页面上的猜测。

## 更新

这个插件走 DSH 插件市场，升级是市场自带的能力，不需要插件自己实现：

1. 维护者在 `market/index.json` 里追加一个新版本条目（新的 `version` +
   `publishTimestamp` + 指向新 commit 的 `source`），推到 GitHub。
2. 你打开插件市场，那一行会从「已安装」变成「更新」—— 市场用已装包的
   `package.json` 里的 `version` 与索引里的版本做比较，判定逻辑是
   `update-available`。
3. 点「更新」即可，市场会把该版本对应的 git commit 装上来。

因为索引是纯静态 JSON，GitHub 的 raw 地址天然带 CDN 缓存，所以**不需要**
任何服务器。发布新版本时唯一要记得的是：**先 push 代码，拿到新的 40 位
commit，再更新索引**，否则市场装到的还是旧代码。

## 为什么闪动是「叠加层」

托盘图标属于 Electron 主进程。插件既拿不到 Electron 的 `Tray` API
（宿主进程以 `ELECTRON_RUN_AS_NODE` 运行），也无法用 `Shell_NotifyIcon` 的
`NIM_MODIFY` 去改别的进程的图标（会被系统拒绝）。可行且已逐像素验证的做法是：

1. 用 `Shell_NotifyIconGetRect` 跨进程查到 DSH 托盘图标的真实矩形；
2. 在它上面盖一个 `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`
   的分层窗口；
3. 用 `UpdateLayeredWindow` 画一个**染红的图标副本**，与全透明帧交替。

实测：鼠标点击能穿透到下面的托盘图标，叠加层不抢焦点，停止后不残留像素。

## 设置

设置页里可以调整：

- 提示音开关、音量，以及是否把声音让给 `dsh-notify-me`
- 托盘闪动与未读浮窗
- 是否忽略子会话
- 当前会话在眼前时是否保持安静（**只静音声音**，托盘图标仍会闪，直到你读掉）

## 环境要求

- Windows 10 / 11，DSH 桌面端
- 提示音走 Web Audio / `Audio` 元素，浏览器要求先有一次用户手势：
  点一下窗口任意位置即可。

## 许可

MIT。`lib/alert.m4a` 是本仓库的一部分，采用同一许可。
