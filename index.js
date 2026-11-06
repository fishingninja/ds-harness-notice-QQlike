/**
 * dsh-desktop-alerts — host half.
 *
 * The page (client.js) decides WHEN the user must be told something: a session
 * is waiting on an approval / question / plan review, or a reply finished and
 * nobody has read it. Two channels carry that: the Web Audio cue, which only
 * the page can play, and the tray blink, which only this process can raise.
 *
 * The target is the notification-area icon in the lower-right corner, not the
 * taskbar button. That icon belongs to the Electron main process, and neither a
 * page nor a plugin host can ask Windows to animate it: the Electron Tray API
 * is main-process-only (this process runs with ELECTRON_RUN_AS_NODE), and
 * Shell_NotifyIcon NIM_MODIFY against another process's icon is rejected.
 * What does work is parking a layered, click-through, never-activating window
 * exactly over the icon cell and painting a reddened copy of the glyph there,
 * alternating with a fully transparent frame. Measured: clicks reach the tray
 * underneath, the overlay never takes focus, and no pixel survives a stop.
 *
 * So this module owns exactly one loopback route on the host web server and
 * spawns lib/flash-window.ps1 from the process allowed to touch Win32. The page
 * reaches the route with a plain same-origin `fetch`, because the shell
 * forwards every non-static `dsh-app://app` path verbatim to the host web
 * server with the host cookie attached.
 *
 * The route is a small state channel, not a one-shot call:
 *   POST { action: "start" } -> blink the tray icon until "stop" arrives;
 *   POST { action: "stop" }  -> cancel the blink, every alert was handled;
 *   POST { action: "status" }-> report whether a blink is currently running.
 *
 * The blink is driven purely by the page's unread set, never by window focus:
 * like QQ, reading session A does not silence an alert from session B, and the
 * blink ends only when every session that raised a reminder has been read.
 *
 * Every spawn is coalesced per action so a burst of sessions finishing at once
 * costs one PowerShell process, and the child is killed if it does not answer
 * inside {@link FLASH_TIMEOUT_MS}: the user has moved on by then.
 *
 * The cue itself is one short recording, not a synthesised tone: this module
 * also serves {@link SOUND_ROUTE}, which streams the packaged MP4/AAC file to
 * the page. The page cannot read it from the bundle, and a `file:` URL is not
 * reachable from the shell's origin, so the host is the only place it can live.
 */

import { spawn } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Route that carries the tray blink state. */
export const FLASH_ROUTE = "/__dsh-desktop-alerts/flash";

/**
 * Route that streams the alert cue.
 *
 * The recording is packaged next to this module, but the page runs on the
 * shell's own origin and cannot open a file next to the plugin. Serving it from
 * the same loopback server the page already talks to keeps one code path for
 * the desktop shell and a plain browser tab.
 */
export const SOUND_ROUTE = "/__dsh-desktop-alerts/sound";


/**
 * Route that reports how each session's last turn ended.
 *
 * The page can see a session stop running but not why: a reply that finished
 * normally and a turn killed by an exhausted token budget both just go quiet.
 * The host sees `turn/end` with its reason, so it remembers the last reason per
 * session here and the page asks for it when it notices a stop.
 */
export const STATE_ROUTE = "/__dsh-desktop-alerts/state";

/** Turn endings that mean "the reply is ready", as opposed to "it was cut off". */
const NORMAL_TURN_ENDS = new Set(["completed", "forked"]);

/** Per-session turn records kept for the state route; older ones fall out. */
const TURN_CACHE_LIMIT = 200;

/**
 * Request header proving the caller is page code. An intent marker, not the
 * security boundary — the boundary is {@link gateRequest} below.
 */
const FLASH_HEADER = "x-dsh-desktop-alerts";

/** Marker value the page sends in {@link FLASH_HEADER}. */
const FLASH_HEADER_VALUE = "flash";

/** Activation script, resolved next to this module. */
const SCRIPT_URL = new URL("./lib/flash-window.ps1", import.meta.url);

/** The packaged alert cue, resolved next to this module. */
const SOUND_URL = new URL("./lib/alert.m4a", import.meta.url);

/** MIME type for the packaged cue; the file is MP4/AAC, not MP3. */
const SOUND_MIME = "audio/mp4";

/** A helper that has not answered by then is abandoned; the user moved on. */
const FLASH_TIMEOUT_MS = 8000;

/** Two requests inside this window share one helper instead of racing two. */
const FLASH_COALESCE_MS = 400;

/** Longest script output retained for the diagnostic line. */
const OUTPUT_LIMIT = 4096;

/** A flash request body larger than this is a mistake, not an intent. */
const BODY_LIMIT = 4 * 1024;

/** How many recent flash requests the probe reports; enough to see a start/stop pair. */
const CALL_LOG_LIMIT = 40;

/** Plugin identity for cordis.yml rows. */
export const name = "dsh-desktop-alerts";

/** Package version, reported by the probe so a stale module is visible. */
export const VERSION = packageVersion();

/**
 * Defaults for every config key this entry reads.
 *
 * Repeated from the bundled cordis.patch.yml on purpose: a profile patch layer
 * replaces an entry's `config` wholesale instead of deep-merging it, so a
 * profile that only wants `flash: false` would otherwise wipe every other key.
 */
const DEFAULTS = {
  sound: { enabled: true, volume: 0.55 },
  flash: true,
  badge: true,
  ignoreSubagents: true,
  skipVisibleCurrent: true,
  scriptPath: "",
  targetPid: 0,
};

/** Numeric clamps for values a hand-edited patch can put out of range. */
const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/**
 * @param raw - the entry config as the loader resolved it (possibly partial,
 *   possibly not an object at all).
 * @param logger - cordis logger, for at most one diagnostic line.
 * @returns a complete config object; never throws.
 */
export function normalizeConfig(raw, logger) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sound = source.sound && typeof source.sound === "object" ? source.sound : {};
  const config = {
    sound: {
      enabled: bool(sound.enabled, DEFAULTS.sound.enabled),
      volume: clamp(sound.volume, 0, 1, DEFAULTS.sound.volume),
    },
    flash: bool(source.flash, DEFAULTS.flash),
    badge: bool(source.badge, DEFAULTS.badge),
    ignoreSubagents: bool(source.ignoreSubagents, DEFAULTS.ignoreSubagents),
    skipVisibleCurrent: bool(source.skipVisibleCurrent, DEFAULTS.skipVisibleCurrent),
    scriptPath: typeof source.scriptPath === "string" ? source.scriptPath.trim() : "",
    targetPid: Number.isFinite(Number(source.targetPid)) ? Math.max(0, Math.trunc(Number(source.targetPid))) : 0,
  };
  if (config.sound.volume !== sound.volume && logger?.debug) {
    logger.debug(`dsh-desktop-alerts: sound.volume ${String(sound.volume)} clamped to ${config.sound.volume}`);
  }
  return config;
}

/**
 * @returns the running package's version, or "0.0.0" when it cannot be read.
 */
function packageVersion() {
  try {
    const url = new URL("./package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * The desktop shell is the only environment with an Electron window to flash
 * and a PowerShell helper to spawn. A browser tab answers the probe honestly
 * instead of pretending it can flash.
 * @returns whether this host process runs inside the DSH desktop shell.
 */
function isDesktopHost() {
  return process.platform === "win32" && typeof process.versions.electron === "string";
}

/**
 * @param config - normalized config.
 * @returns the script to run: the configured override, the env override, or
 *   the copy shipped beside this module.
 */
function flashScriptPath(config) {
  const env = process.env.DSH_DESKTOP_ALERTS_SCRIPT;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  if (config.scriptPath.length > 0) return config.scriptPath;
  return fileURLToPath(SCRIPT_URL);
}

/**
 * @param config - normalized config.
 * @returns the pid whose window is flashed: the configured pid, the env
 *   override, or the Electron main process (this host's parent).
 */
function flashTargetPid(config) {
  const env = Number(process.env.DSH_DESKTOP_ALERTS_PID);
  if (Number.isFinite(env) && env > 0) return Math.trunc(env);
  if (config.targetPid > 0) return config.targetPid;
  return Number.isFinite(process.ppid) ? process.ppid : 0;
}

/**
 * @returns the Windows PowerShell executable, preferring the system copy over
 *   whatever happens to be first on PATH.
 */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidate = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return candidate;
}

/**
 * @param output - the helper's stdout.
 * @returns the last "FLASHED=1|0" verdict, or null when the script never
 *   reached its final line.
 */
function lastVerdict(output) {
  const lines = String(output).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^FLASHED=([01])$/.exec(lines[i].trim());
    if (match) return match[1] === "1";
  }
  return null;
}

/**
 * @param output - the helper's stdout.
 * @returns the last "DETAIL: ..." line, for the probe's diagnostic field.
 */
function detailLine(output) {
  const lines = String(output).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("DETAIL:")) return line.slice(7).trim();
  }
  return "";
}

/**
 * Run one helper invocation and resolve with its verdict.
 * @param action - "start" | "stop" | "status".
 * @param config - normalized config.
 * @param logger - cordis logger.
 * @returns `{ flashed, detail, reason? }`; never rejects.
 */
function runFlashScript(action, config, logger) {
  return new Promise((resolve) => {
    const script = flashScriptPath(config);
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Action",
      action,
      "-TargetPid",
      String(flashTargetPid(config)),
    ];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(powershellPath(), args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ flashed: false, detail: "", reason: `spawn-failed: ${error?.message ?? String(error)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ flashed: false, detail: detailLine(stdout), reason: "timeout" });
    }, FLASH_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ flashed: false, detail: "", reason: `child-error: ${error?.message ?? String(error)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const verdict = lastVerdict(stdout);
      if (verdict === null) {
        logger?.warn?.(`dsh-desktop-alerts: ${action} helper exited ${code} without a verdict: ${stderr.trim().slice(0, 200)}`);
      }
      finish({
        flashed: verdict === true,
        detail: detailLine(stdout),
        reason: verdict === null ? `no-verdict (exit ${code})` : undefined,
      });
    });
  });
}

/**
 * Build the request handler for {@link STATE_ROUTE}.
 *
 * Answers "how did the last turn of these sessions end" for the page, which
 * otherwise cannot tell a finished reply from a turn killed outside the
 * session. Only ids the caller names are described, so the route never leaks a
 * session list.
 * @param shared - mutable bridge state (`bindHost`, `turns`).
 * @returns an http request handler owning the whole response lifecycle.
 */
function createStateHandler(shared) {
  return (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      respond(res, 405, { ok: false, reason: "method-not-allowed" });
      return;
    }
    const gate = gateRequest(req, { bindHost: shared.bindHost });
    if (gate !== null) {
      respond(res, 403, { ok: false, reason: "forbidden", gate });
      return;
    }
    const ids = new Set();
    try {
      const url = new URL(req.url ?? STATE_ROUTE, "http://localhost");
      for (const id of url.searchParams.getAll("id")) {
        if (id.length > 0) ids.add(id.slice(0, 256));
      }
    } catch {}
    const sessions = {};
    for (const id of ids) {
      const record = shared.turns.get(id);
      if (record) sessions[id] = record;
    }
    respond(res, 200, {
      ok: true,
      desktop: isDesktopHost(),
      version: VERSION,
      // Diagnostics: whether the recorder is listening at all, and how many
      // endings it has seen. A page that gets nothing back needs to know
      // whether the answer is "no such session" or "nothing recorded yet".
      recording: shared.recording === true,
      seen: shared.turns.size,
      sessions,
    });
  };
}

/**
 * Build the request handler for {@link SOUND_ROUTE}.
 *
 * Streams the packaged cue so the page can play it with one `Audio` element.
 * GET only, gated like the other routes, and answered with a long-lived cache
 * header: the file is immutable for a given package version, and the page asks
 * for it again on every occurrence.
 * @param shared - mutable bridge state (`bindHost`).
 * @returns an http request handler owning the whole response lifecycle.
 */
function createSoundHandler(shared) {
  return (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      respond(res, 405, { ok: false, reason: "method-not-allowed" });
      return;
    }
    const gate = gateRequest(req, { bindHost: shared.bindHost });
    if (gate !== null) {
      respond(res, 403, { ok: false, reason: "forbidden", gate });
      return;
    }
    const path = fileURLToPath(SOUND_URL);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // A package that shipped without its asset must say so, not hang the
      // page: the client falls back to a synthesised cue on a non-200.
      respond(res, 404, { ok: false, reason: "sound-missing" });
      return;
    }
    res.writeHead(200, {
      "content-type": SOUND_MIME,
      "content-length": stat.size,
      "cache-control": "private, max-age=604800, immutable",
      "accept-ranges": "none",
    });
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(path);
    stream.on("error", () => {
      try {
        res.destroy();
      } catch {}
    });
    stream.pipe(res);
  };
}

/**
 * Record one flash request so a later probe can explain what the page did.
 *
 * `lastVerdict` alone is not enough: a "start" followed by an immediate "stop"
 * leaves only the stop behind, which reads exactly like "the page never asked".
 * This keeps the recent sequence, capped so a long session cannot grow it.
 * @param shared - bridge state (`calls`).
 * @param entry - `{ action, at, ok, reason, origin, referer }`.
 */
function recordCall(shared, entry) {
  if (!Array.isArray(shared.calls)) shared.calls = [];
  shared.calls.push(entry);
  if (shared.calls.length > CALL_LOG_LIMIT) shared.calls.splice(0, shared.calls.length - CALL_LOG_LIMIT);
}

/**
 * Build the request handler for {@link FLASH_ROUTE}.
 * @param shared - mutable bridge state (`bindHost`, coalescing slots).
 * @param config - normalized config.
 * @param logger - cordis logger.
 * @returns an http request handler owning the whole response lifecycle.
 */
function createHandler(shared, config, logger) {
  return (req, res) => {
    const method = req.method ?? "GET";
    if (method === "GET" || method === "HEAD") {
      respond(res, 200, {
        ok: true,
        route: FLASH_ROUTE,
        version: VERSION,
        enabled: config.flash,
        desktop: isDesktopHost(),
        platform: process.platform,
        script: flashScriptPath(config),
        lastVerdict: shared.lastVerdict,
        calls: shared.calls ?? [],
      });
      return;
    }
    if (method !== "POST") {
      respond(res, 405, { ok: false, reason: "method-not-allowed" });
      return;
    }
    const gate = gateRequest(req, { bindHost: shared.bindHost });
    if (gate !== null) {
      respond(res, 403, { ok: false, reason: "forbidden", gate });
      return;
    }
    if (req.headers[FLASH_HEADER] !== FLASH_HEADER_VALUE) {
      respond(res, 403, { ok: false, reason: "forbidden", gate: "missing-header" });
      return;
    }
    void readBody(req, BODY_LIMIT)
      .then(async (body) => {
        if (!body.ok) {
          respond(res, body.reason === "body-too-large" ? 413 : 400, { ok: false, reason: body.reason });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body.text || "{}");
        } catch {
          respond(res, 400, { ok: false, reason: "bad-json" });
          return;
        }
        const action = parsed && typeof parsed.action === "string" ? parsed.action : "status";
        if (action !== "start" && action !== "stop" && action !== "status" && action !== "hello") {
          respond(res, 400, { ok: false, reason: "bad-action" });
          return;
        }
        // "hello" is the page asking whether this host owns a window at all.
        // The page cannot answer that for itself: its own origin differs between
        // the packaged shell and a browser tab, and a protocol test is exactly
        // what went wrong before. Only the host knows if it is Electron. The
        // page also reports what it thinks it sees, so one round trip explains
        // a dead tray blink instead of guessing at it.
        if (action === "hello") {
          const seen = parsed && typeof parsed.seen === "object" && parsed.seen !== null ? parsed.seen : {};
          recordCall(shared, {
            action,
            at: Date.now(),
            ok: true,
            reason: "",
            origin: req.headers.origin ?? "",
            referer: req.headers.referer ?? "",
            page: {
              protocol: typeof seen.protocol === "string" ? seen.protocol.slice(0, 32) : "",
              flash: seen.flash === true,
              badge: seen.badge === true,
              items: Number.isFinite(seen.items) ? seen.items : -1,
              desktop: seen.desktop === true,
            },
          });
          respond(res, 200, {
            ok: true,
            desktop: isDesktopHost(),
            platform: process.platform,
            version: VERSION,
            enabled: config.flash,
          });
          return;
        }
        if (!config.flash && action !== "status") {
          respond(res, 200, { ok: true, flashed: false, reason: "flash-disabled", desktop: isDesktopHost() });
          return;
        }
        // Only the desktop shell owns an Electron window to flash. A plain web
        // host on Windows must not spawn a helper that can never find a window.
        if (!isDesktopHost()) {
          respond(res, 200, { ok: true, flashed: false, reason: "not-desktop", desktop: false, action });
          return;
        }
        const result = await scheduleFlash(action, shared, config, logger);
        recordCall(shared, {
          action,
          at: Date.now(),
          ok: result.flashed === true,
          reason: result.reason ?? "",
          origin: req.headers.origin ?? "",
          referer: req.headers.referer ?? "",
        });
        respond(res, 200, {
          ok: true,
          flashed: result.flashed,
          action,
          desktop: isDesktopHost(),
          platform: process.platform,
          detail: result.detail,
          reason: result.reason,
        });
      })
      .catch((error) => {
        respond(res, 500, { ok: false, reason: "handler-failed", message: error?.message ?? String(error) });
      });
  };
}

/**
 * Coalesce helper invocations per action.
 *
 * A burst — four sessions finishing together, or the page re-issuing "start"
 * while a "stop" is still in flight — must not become four PowerShell
 * processes. One run per action is in flight at a time; a newer request of the
 * same action replaces the queued one, and the newest queued run starts when
 * the current one settles.
 * @param action - "start" | "stop" | "status".
 * @param shared - bridge state.
 * @param config - normalized config.
 * @param logger - cordis logger.
 * @returns the settled run's result.
 */
function scheduleFlash(action, shared, config, logger) {
  const slot = action;
  const running = shared.running.get(slot);
  if (running) {
    // Join the in-flight run for the same action: the verdict is equivalent.
    return running;
  }
  const last = shared.lastRunAt.get(slot) ?? 0;
  const wait = Math.max(0, FLASH_COALESCE_MS - (Date.now() - last));
  const promise = (wait === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, wait)))
    .then(() => runFlashScript(action, config, logger))
    .then((result) => {
      shared.lastRunAt.set(slot, Date.now());
      shared.lastVerdict = `${action}:${result.flashed ? "1" : "0"}${result.reason ? ` (${result.reason})` : ""}`;
      return result;
    })
    .finally(() => {
      shared.running.delete(slot);
    });
  shared.running.set(slot, promise);
  return promise;
}

/**
 * Normalize a `turn/end` reason.
 *
 * The host appends `reason` as `{ kind: 'completed' | 'aborted' | 'blocked' |
 * 'error' | 'max-tokens' | 'interrupted' | 'forked', … }`, not as a string.
 * Older logs carry a plain string, so both shapes are accepted.
 * @param reason - the raw `event.data.reason` value.
 * @returns the reason kind, or an empty string when there is none.
 */
function turnEndReason(reason) {
  if (typeof reason === "string") return reason;
  if (reason !== null && typeof reason === "object" && typeof reason.kind === "string") return reason.kind;
  return "";
}

/**
 * Subscribe to the host session feed and remember how each turn ended.
 *
 * This is the one fact the page cannot observe. A session that stops running
 * looks the same whether its reply is ready or whether the turn was killed by
 * an exhausted budget, a crash or a user abort — and those deserve different
 * reminders. The page asks this module per session, so the record is a plain
 * lookup, not a push: nothing here ever alerts on its own.
 * @param ctx - host cordis context.
 * @param shared - `{ turns }`, the map the state route reads.
 */
function mountTurnRecorder(ctx, shared) {
  ctx.effect(() => {
    shared.recording = true;
    const offEvent = ctx.on("session/event", (session, event) => {
      try {
        if (!event || typeof event.type !== "string") return;
        const id = String(session?.header?.id ?? "unknown");
        if (event.type === "turn/end") {
          const reason = turnEndReason(event.data?.reason);
          shared.turns.set(id, {
            reason,
            normal: NORMAL_TURN_ENDS.has(reason),
            at: Date.now(),
          });
          if (shared.turns.size > TURN_CACHE_LIMIT) shared.turns.delete(shared.turns.keys().next().value);
          return;
        }
        if (event.type === "session/title" && typeof event.data?.title === "string") {
          const record = shared.turns.get(id);
          if (record) record.title = event.data.title;
        }
      } catch {}
    });
    // Deliberately no `session/disposed` cleanup: a session is disposed the
    // instant it leaves the store — for a short child run that is immediately
    // after its final turn — so dropping the record there would delete the
    // answer microseconds before the page asks for it, and every cut-off run
    // would look "unknown". Growth is already bounded by TURN_CACHE_LIMIT.
    return () => {
      shared.recording = false;
      offEvent?.();
    };
  }, "dsh-desktop-alerts: turn recorder");
}

/**
 * Mount the plugin.
 * @param ctx - host cordis context.
 * @param config - raw entry config (normalized here; see {@link DEFAULTS}).
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config, ctx.logger);
  const shared = {
    bindHost: undefined,
    running: new Map(),
    lastRunAt: new Map(),
    lastVerdict: "never",
    turns: new Map(),
  };

  mountTurnRecorder(ctx, shared);

  ctx.inject(["webServer"], (webCtx) => {
    shared.bindHost = bindHostOf(webCtx.webServer);
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: FLASH_ROUTE,
          handler: createHandler(shared, settings, ctx.logger),
        }),
      "dsh-desktop-alerts: tray blink route",
    );
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: STATE_ROUTE,
          handler: createStateHandler(shared),
        }),
      "dsh-desktop-alerts: turn state route",
    );
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "exact",
          path: SOUND_ROUTE,
          handler: createSoundHandler(shared),
        }),
      "dsh-desktop-alerts: alert cue route",
    );
    ctx.logger?.info?.(
      `dsh-desktop-alerts: routes ready (desktop=${isDesktopHost()}, enabled=${settings.flash}, script=${flashScriptPath(settings)})`,
    );
  });

  ctx.effect(
    () => () => {
      // A plugin disable must not leave a blinking tray icon behind.
      if (settings.flash && isDesktopHost()) void runFlashScript("stop", settings, ctx.logger);
    },
    "dsh-desktop-alerts: stop blinking on dispose",
  );
}

// ─────────────────────────── shared helpers ───────────────────────────

/**
 * Decide whether a request may be answered at all.
 *
 * The desktop page is same-origin with the host it talks to, so the peer must
 * be loopback (or the configured bind address) and the `Origin`, when present,
 * must name that same host and port. A DNS-rebinding page can send any custom
 * header, so the header alone is not a boundary — this is.
 * @param req - the incoming request.
 * @param options - `{ bindHost }`.
 * @returns null when allowed, or a short refusal code.
 */
function gateRequest(req, options) {
  const bindHost = options?.bindHost;
  const remote = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
  if (!isLoopbackHostname(remote) && !isBindAddress(remote, bindHost)) return "bad-remote";

  const host = splitHost(req.headers.host);
  if (host === null) return "bad-host";
  const hostname = bareHostname(host.hostname);
  if (!isLoopbackHostname(hostname) && !isBindAddress(hostname, bindHost)) return "bad-host";

  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return null;
  if (origin === "dsh-app://app") return null; // the desktop page, if not stripped
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return "cross-origin";
  }
  if (bareHostname(parsed.hostname) !== hostname) return "cross-origin";
  const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const connectionPort = req.socket?.encrypted === true ? "443" : "80";
  if (originPort !== (host.port || connectionPort)) return "cross-origin";
  return null;
}

const isLoopbackHostname = (hostname) =>
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  hostname === "localhost" ||
  hostname === "0:0:0:0:0:0:0:1";

const isBindAddress = (value, bindHost) =>
  typeof bindHost === "string" && bindHost.length > 0 && bareHostname(value) === bareHostname(bindHost);

const bareHostname = (hostname) => String(hostname ?? "").trim().toLowerCase().replace(/^::ffff:/, "");

/**
 * @param value - a `Host` header.
 * @returns `{ hostname, port }` or null when it does not parse.
 */
function splitHost(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const trimmed = value.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0 && trimmed.indexOf("]") === -1) {
    return { hostname: trimmed.slice(0, lastColon), port: trimmed.slice(lastColon + 1) };
  }
  return { hostname: trimmed, port: "" };
}

/**
 * Write a JSON response. Route handlers own the whole response lifecycle.
 * @param res - the server response.
 * @param status - HTTP status to send.
 * @param body - JSON-serialisable payload.
 */
function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Buffer a request body up to `limit` bytes.
 * @param req - the incoming request.
 * @param limit - maximum number of body bytes to keep.
 * @returns `{ ok: true, text }` or `{ ok: false, reason }`.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      settle(overflow ? { ok: false, reason: "body-too-large" } : { ok: true, text: Buffer.concat(chunks).toString("utf8") }),
    );
    req.on("error", () => settle({ ok: false, reason: "body-read-error" }));
    req.on("close", () => settle({ ok: false, reason: "body-read-error" }));
  });
}

/**
 * @param webServer - the host web server service.
 * @returns its configured bind address when it exposes one.
 */
function bindHostOf(webServer) {
  try {
    const host = webServer?.host;
    return typeof host === "string" && host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}
