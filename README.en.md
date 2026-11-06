# dsh-desktop-alerts

[中文](README.md) | English

QQ-style desktop reminders for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) on Windows.

When a session reaches a state that needs you — an approval, a question, a plan
to confirm — or a turn is cut off from outside (stopped, failed, out of budget),
or a background reply finishes and nobody has read it, the plugin does what a QQ
window does:

- **One cue**: the same short five-blip recording plays once per occurrence.
- **Blinking notification-area icon**: the tray icon blinks as a whole, like an
  unread QQ message. It stops only when **every** session that raised a reminder
  has been read — exactly like QQ. What you happen to be reading is irrelevant.
- **Unread dock**: a pill in the bottom-right corner lists the sessions still
  waiting; clicking one opens it.

## Install

```powershell
# inside the profile you run DSH with
dsh plugin install dsh-desktop-alerts
```

Or from a checkout, point `plugin_manager` at the package directory:

```js
plugin_manager({ action: "install_bundle", target: "E:\\path\\to\\dsh-desktop-alerts" })
```

The bundle inserts one Host row and one Client half. Nothing needs configuring
before it works.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Host half: registers the `/flash`, `/state` and `/sound` routes, records every `turn/end` reason, and spawns the PowerShell helper |
| `lib/flash-window.ps1` | Tray overlay helper: parks a click-through window over the tray icon and alternates a reddened copy of the glyph with a transparent frame |
| `lib/alert.m4a` | The one alert cue (MP4/AAC, 0.93 s) |
| `client.js` | Client half: watches session state, classifies reminders, plays the cue, draws the dock and the settings page |
| `locale/{zh,en}.json` | Plugin display metadata |
| `icon.svg` | Plugin icon |

## What counts as an alert

| Situation | How it is known |
| --- | --- |
| A session waits on an approval / question / plan review | `sessionStatus.pendingInteraction` |
| A turn was cut off (`aborted` / `error` / `max-tokens` / `interrupted` / `blocked`) | `session/event` → `turn/end` reason, via the `/state` route |
| A reply finished and is still unread | `sessionStatus.completionUnread` |

Normal completion (`completed` / `forked`) is always "finished"; it never counts
as an interruption. The distinction comes from the host's `turn/end` event, not
from guessing on the page.

## Why the blink is an overlay

The tray icon belongs to the Electron main process. A plugin cannot ask Windows
to animate it:

- the Electron `Tray` API is main-process only, and this Host runs with
  `ELECTRON_RUN_AS_NODE`;
- `Shell_NotifyIcon` with `NIM_MODIFY` against another process's icon is
  rejected by the shell.

What does work, and is verified pixel by pixel:

1. `Shell_NotifyIconGetRect` finds the real rectangle of the DSH tray icon
   across processes.
2. A layered window with
   `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` is
   parked exactly over that rectangle.
3. `UpdateLayeredWindow` paints a **reddened copy of the glyph**, alternating
   with a fully transparent frame.

Clicks pass through to the tray icon underneath, the overlay never takes focus,
and nothing is left behind after a stop.

## Settings

Everything is adjustable on the plugin's settings page:

- the cue on/off, its volume, and whether to defer the sound to `dsh-notify-me`
- the tray blink and the unread dock
- whether subagent sessions are ignored
- whether a session already on screen stays quiet (this mutes the **sound**
  only — the tray icon keeps blinking until you read it)

## Requirements

- Windows 10 or 11, DSH desktop client
- The cue plays through Web Audio / an `Audio` element, so the browser requires
  one user gesture first: click anywhere in the window once.

## License

MIT. The alert cue in `lib/alert.m4a` is part of this repository and is
released under the same license.
