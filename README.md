# dsh-desktop-alerts · QQ 风格的 DSH 桌面提醒

> 会话需要你处理、回复完成或中途被打断时，响一声提示音，并让系统托盘图标像未读消息一样闪动。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](packages/dsh-desktop-alerts/LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4.svg)](#环境要求)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4f46e5.svg)](https://github.com/deepseek-ai/deepseek-harness)

这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Windows 桌面客户端的插件。

<p align="center">
  <img src="packages/dsh-desktop-alerts/icon.svg" width="96" alt="插件图标">
</p>

## 它解决什么问题

DSH 跑一个长任务时，你多半切去干别的了。等它需要审批、需要你做个选择、或者已经答完——你不一定在屏幕前，于是它就那么干等着。

这个插件把「有人等你」这件事推到你能看见的地方：**一声短促的提示音，加上右下角托盘图标整体的闪动**，像 QQ 收到消息那样。

## 功能

| 触发条件 | 表现 |
| --- | --- |
| 会话在等你审批 / 回答 / 确认计划 | 提示音 + 托盘闪动 + 未读浮窗 |
| 回合被中断（`aborted` / `error` / `max-tokens` / `interrupted` / `blocked`） | 同上 |
| 回复完成但还没读（`completed` / `forked`） | 同上 |
| 当前会话就在眼前，且你正在看 | 只静音声音，托盘仍闪到你读掉为止 |

三个细节值得单独说：

**所有提醒共用同一个提示音。** 五次短促的「滴滴滴滴滴」，不按类型分音效——那样反而要你在脑子里做二次判断。

**闪动是整颗图标在闪，不是角落上的小红点。** 托盘图标在两种状态间交替：原色，和染红的同一颗图标。

**停止的条件是「没有未读」，不是「窗口在前台」。** 只要还有任何一个触发过提醒的会话没被读掉，托盘就继续闪。切走再切回来不会让它停下来。

## 安装

**推荐：从插件市场安装**，之后升级点一下就行。

在「插件市场 → 索引源」添加：

```
https://raw.githubusercontent.com/fishingninja/ds-harness-notice-QQlike/main/market/index.json
```

搜索 `桌面提醒` 或 `dsh-desktop-alerts`，点安装。

**或者直接用 Git 安装：**

```powershell
dsh plugin install "git+https://github.com/fishingninja/ds-harness-notice-QQlike.git#main&path:/packages/dsh-desktop-alerts"
```

`path:` 是必须的——这个仓库是 monorepo，插件本体在 `packages/dsh-desktop-alerts`。

## 仓库结构

```
packages/
  dsh-desktop-alerts/     ← 插件本体，可独立安装
    index.js              宿主端：路由、回合结果记录、调用 PowerShell 助手
    client.js             客户端：监听会话状态、分类提醒、提示音、未读浮窗、设置页
    lib/flash-window.ps1  托盘叠加层助手
    lib/alert.m4a         提示音（MP4/AAC，0.93 秒）
    locale/{zh,en}.json   插件展示信息
    icon.svg              插件图标
market/
  index.json              DSH 插件市场索引
```

根目录的 `package.json` 是 workspace 清单，不参与安装。

## 实现上值得一说的两件事

**托盘闪动用的是叠加层，不是改图标。** 托盘图标归 Electron 主进程所有；插件宿主进程以 `ELECTRON_RUN_AS_NODE` 运行，拿不到 `Tray` API，也没法用 `Shell_NotifyIcon` 的 `NIM_MODIFY` 去改别的进程的图标（系统会拒绝）。所以改用：`Shell_NotifyIconGetRect` 跨进程查到图标矩形 → 在上面盖一个点击穿透、不抢焦点的分层窗口 → `UpdateLayeredWindow` 画染红的图标副本，与透明帧交替。鼠标点击照样能穿透到托盘图标。

**「完成」和「中断」的区别来自宿主事件，不是猜的。** `turn/end` 事件带 `reason`，`completed` / `forked` 才算正常完成，其余（`aborted`、`error`、`max-tokens`、`interrupted`、`blocked`）都算被打断。页面上的状态推断做不到这一点。

## 环境要求

- Windows 10 / 11，DSH 桌面端
- 浏览器要求先有一次用户手势才允许播放音频：点一下窗口任意位置即可

## 设置

设置页可调整：提示音开关与音量、是否把声音让给 `dsh-notify-me`、托盘闪动与未读浮窗、是否忽略子会话、当前会话在眼前时是否保持安静。

## 许可

MIT。`lib/alert.m4a` 是本仓库的一部分，采用同一许可。

---

[English](packages/dsh-desktop-alerts/README.en.md) · [插件详细说明](packages/dsh-desktop-alerts/README.md)
