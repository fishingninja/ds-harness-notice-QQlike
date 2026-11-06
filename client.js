/**
 * dsh-desktop-alerts — client half.
 *
 * Reads the page's own session state and turns it into the three things a QQ
 * window does when a message arrives:
 *   1. a cue — one packaged recording, five short blips, the same for every
 *      class of alert: the agent needs the user (approval / question / plan
 *      review), a reply finished, or a turn was cut off from outside (aborted,
 *      error, token exhaustion);
 *   2. a blinking system-tray icon — requested from the host half, which parks a
 *      click-through overlay on the notification-area icon;
 *   3. an unread dock in the frame-wide overlay: a count pill that expands into
 *      the list of sessions still waiting, and disappears once they are handled.
 *
 * The blink follows the unread set, not the foreground window. Like QQ: reading
 * session A does not silence an alert from session B, and the blink stops only
 * when every session that triggered a reminder has been read.
 *
 * One occurrence rings once: every session carries one alert record keyed by
 * the interaction (or by "this reply is unread"), so a session that keeps
 * waiting does not keep chiming. The record is dropped when the session stops
 * waiting, which is also what lets the next wait announce itself.
 *
 * The page is the only place that knows whether the user is actually looking:
 * with `skipVisibleCurrent` on, an alert for the session already on screen stays
 * quiet until the user switches away or the window loses focus. That gate
 * affects the cue only — it never stops the tray blink while other sessions
 * are still unread.
 */

(function (root) {
  if (!root) return;
  if (!root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== "function") return;

  root.__ModuleLoader__.load({
    id: "dsh-desktop-alerts",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      try {
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      } catch (e) {}

      // react is externalised into the loader's module table; the reminder
      // engine below never needs it, only the dock and the settings page do.
      var React = null;
      try {
        React = require("react") || null;
      } catch (e) {
        React = null;
      }

      // ─────────────────────────── configuration ───────────────────────────
      // Kept in localStorage rather than in the bundle patch so the settings
      // page can change it without a host restart. The patch's `config` seeds
      // the host half (script path, target pid, flash allowed at all).
      var LS_CONFIG = "dshDesktopAlerts.config";
      var DEFAULTS = {
        // One cue for every class of alert: the packaged recording. There is
        // deliberately no per-class split — the user asked for one sound.
        sound: { enabled: true, volume: 0.55 },
        // Tray blink while anything is unread.
        flash: true,
        // The unread dock in the overlay.
        badge: true,
        // A subagent's approval prompt describes a step of another
        // conversation's turn; it is not the user's decision to make.
        ignoreSubagents: true,
        // No reminder for the session already on screen while the window is in
        // front — the user is looking at it.
        skipVisibleCurrent: true,
        // dsh-notify-me, when installed with its sound on, already plays a cue
        // for these same events. Ringing on top of it would be a double beep,
        // so the switch exists — but it starts off, because a reminder plugin
        // whose sound never plays would look broken. The settings page names
        // the trade-off; the flash and the dock are this plugin's own job
        // either way.
        deferSoundToOthers: false,
      };

      var config = null; // live config, refreshed by readConfig()
      var rootCtx = null;
      var listStore = null;
      var localeSvc = null;

      function mergeConfig(raw) {
        var src = raw && typeof raw === "object" ? raw : {};
        var snd = src.sound && typeof src.sound === "object" ? src.sound : {};
        function on(value, fallback) {
          return typeof value === "boolean" ? value : fallback;
        }
        var vol = Number(snd.volume);
        if (!isFinite(vol)) vol = DEFAULTS.sound.volume;
        vol = Math.max(0, Math.min(1, vol));
        return {
          sound: {
            enabled: on(snd.enabled, DEFAULTS.sound.enabled),
            volume: vol,
          },
          flash: on(src.flash, DEFAULTS.flash),
          badge: on(src.badge, DEFAULTS.badge),
          ignoreSubagents: on(src.ignoreSubagents, DEFAULTS.ignoreSubagents),
          skipVisibleCurrent: on(src.skipVisibleCurrent, DEFAULTS.skipVisibleCurrent),
          deferSoundToOthers: on(src.deferSoundToOthers, DEFAULTS.deferSoundToOthers),
        };
      }

      function readConfig() {
        if (config) return config;
        var stored = null;
        try {
          var text = root.localStorage.getItem(LS_CONFIG);
          if (text) stored = JSON.parse(text);
        } catch (e) {
          stored = null;
        }
        config = mergeConfig(stored);
        return config;
      }

      function writeConfig(patch) {
        var next = mergeConfig(readConfig());
        if (patch && typeof patch === "object") {
          for (var key in patch) {
            if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
            if (key === "sound" && patch.sound && typeof patch.sound === "object") {
              for (var s in patch.sound) {
                if (Object.prototype.hasOwnProperty.call(patch.sound, s)) next.sound[s] = patch.sound[s];
              }
            } else {
              next[key] = patch[key];
            }
          }
        }
        next = mergeConfig(next);
        config = next;
        try {
          root.localStorage.setItem(LS_CONFIG, JSON.stringify(next));
        } catch (e) {}
        // Mute rules and the badge decide what the dock shows, so a switch has
        // to take effect now rather than at the next session event.
        try {
          sync();
        } catch (e) {}
        return next;
      }

      // ─────────────────────── host flash channel ───────────────────────
      // The host half (index.js) registers this exact route and spawns the
      // PowerShell helper from the process that owns the window. A cross-origin
      // page cannot send a custom header without a CORS preflight this route
      // never answers, so the header doubles as the CSRF gate.
      var FLASH_ROUTE = "/__dsh-desktop-alerts/flash";
      var FLASH_HEADERS = { "x-dsh-desktop-alerts": "flash", "content-type": "application/json" };
      var STATE_ROUTE = "/__dsh-desktop-alerts/state";
      var flashState = { last: "idle" };

      // The desktop shell is the only place with a tray icon to blink.
      // The page cannot decide that reliably for itself — the packaged shell
      // serves the app under a custom scheme while a browser tab uses http,
      // and both were observed to be wrong about it — so `isDesktopShell`
      // reports the host's answer once it has one, and the host is asked on
      // mount (see `probeDesktop`).
      function isDesktopShell() {
        if (hostDesktop !== "unknown") return hostDesktop === "yes";
        // Before the host answers, fall back to the protocol so the very first
        // seconds still work in the packaged shell.
        try {
          return root.location.protocol === "dsh-app:";
        } catch (e) {
          return false;
        }
      }

      /**
       * Ask the host whether it is the Electron desktop that owns a window.
       *
       * This exists because the page-side protocol test was wrong in practice:
       * with it, `postFlash` returned early and no flash request was ever sent.
       * The host knows `process.versions.electron`; the page does not.
       */
      function probeDesktop() {
        if (typeof root.fetch !== "function") {
          hostDesktop = "no";
          return;
        }
        try {
          root
            .fetch(FLASH_ROUTE, {
              method: "POST",
              headers: FLASH_HEADERS,
              body: JSON.stringify({
                action: "hello",
                // What this page believes about itself, reported so the host's
                // call log can explain a dead tray blink in one round trip.
                seen: {
                  protocol: String((root.location && root.location.protocol) || ""),
                  flash: readConfig().flash === true,
                  badge: readConfig().badge === true,
                  items: unread.items.length,
                  desktop: (function () {
                    try {
                      return root.location.protocol === "dsh-app:";
                    } catch (e) {
                      return false;
                    }
                  })(),
                },
              }),
              cache: "no-store",
            })
            .then(function (res) {
              if (!res || !res.ok || typeof res.json !== "function") throw new Error("bad-response");
              return res.json();
            })
            .then(
              function (body) {
                hostDesktop = body && body.desktop === true ? "yes" : "no";
                // The answer can change what sync() should do (flash becomes
                // possible), so re-derive once it lands.
                try {
                  sync();
                } catch (e) {}
              },
              function () {
                hostDesktop = "no";
              },
            )
            .catch(function () {
              hostDesktop = "no";
            });
        } catch (e) {
          hostDesktop = "no";
        }
      }

      function postFlash(action) {
        // No page-side veto: the host answers "not-desktop" for itself, and
        // guessing wrong here is what made the tray blink silently dead.
        try {
          if (typeof root.fetch !== "function") {
            flashState.last = "no-fetch";
            return;
          }
          flashState.last = action + ":pending";
          root
            .fetch(FLASH_ROUTE, {
              method: "POST",
              headers: FLASH_HEADERS,
              body: JSON.stringify({ action: action }),
              cache: "no-store",
            })
            .then(function (res) {
              if (!res || !res.ok) {
                flashState.last = action + ":http-" + (res ? String(res.status) : "0");
                return;
              }
              if (typeof res.json !== "function") {
                flashState.last = action + ":ok";
                return;
              }
              return res.json().then(
                function (body) {
                  flashState.last =
                    action + ":" + (body && body.flashed ? "flashed" : "off") + (body && body.reason ? " (" + body.reason + ")" : "");
                },
                function () {
                  flashState.last = action + ":ok";
                },
              );
            })
            .catch(function () {
              flashState.last = action + ":error";
            });
        } catch (e) {
          flashState.last = action + ":error";
        }
      }

      // ─────────────────────────── audio cues ───────────────────────────
      // WebAudio, so the plugin ships no audio asset and the cue is the same
      // two voices on every machine. A context only runs after a user gesture,
      // so it is created and resumed on the first pointer/key anywhere in the
      // window; before that the cue stays silent (a browser limit, not a bug).
      var audioCtx = null;

      function unlockAudio() {
        try {
          if (!audioCtx) {
            var AC = root.AudioContext || root.webkitAudioContext;
            if (!AC) return;
            audioCtx = new AC();
          }
          if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
        } catch (e) {}
      }

      function tone(freq, startIn, durMs, vol, type) {
        if (!audioCtx || audioCtx.state !== "running") return;
        try {
          var t0 = audioCtx.currentTime + startIn;
          var osc = audioCtx.createOscillator();
          var gain = audioCtx.createGain();
          osc.type = type || "sine";
          osc.frequency.value = freq;
          // A short attack and a long exponential tail is what makes a
          // two-note figure read as a chime instead of a beep.
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(t0);
          osc.stop(t0 + durMs / 1000 + 0.05);
        } catch (e) {}
      }

      // ──────────────────────── the alert cue ────────────────────────
      // The cue is one short recording served by the host half. One audio
      // element is reused and rewound on every occurrence: creating a fresh
      // element per ring leaks decoders, and rewinding keeps a burst of
      // sessions from stacking into a stutter.
      var cueEl = null;
      var cueBroken = false;
      var SOUND_ROUTE = "/__dsh-desktop-alerts/sound";
      // Bumping this invalidates the browser's cached copy after an upgrade,
      // so a changed recording is not masked by a week-long cache header.
      var CUE_VERSION = "1";

      function cueUrl() {
        return SOUND_ROUTE + "?v=" + CUE_VERSION;
      }

      /**
       * Build the element lazily: nothing touches the network until the first
       * occurrence, and a page that never alerts never downloads the cue.
       */
      function ensureCue() {
        if (cueEl || cueBroken) return cueEl;
        try {
          var El = root.Audio;
          if (!El) {
            cueBroken = true;
            return null;
          }
          cueEl = new El(cueUrl());
          cueEl.preload = "auto";
          // A missing asset or a blocked request must fall back to the
          // synthesised cue rather than going silent.
          cueEl.addEventListener("error", function () {
            cueBroken = true;
          });
        } catch (e) {
          cueBroken = true;
          cueEl = null;
        }
        return cueEl;
      }

      /**
       * Synthesised fallback: five short blips, matching the recording's
       * character closely enough that a missing file is not silence.
       */
      function playFallbackCue(vol) {
        for (var i = 0; i < 5; i++) {
          tone(1046.5, i * 0.13, 70, vol * 0.34, "square");
        }
      }

      /**
       * Play the one cue every alert class shares.
       * @param vol - 0..1 volume from the config.
       */
      function playCue(vol) {
        var el = ensureCue();
        if (!el) {
          playFallbackCue(vol);
          return;
        }
        try {
          el.volume = Math.max(0, Math.min(1, vol));
          // `currentTime = 0` lets a second alert cut the first one short
          // instead of queueing a queue of overlapping copies.
          el.currentTime = 0;
          var p = el.play();
          if (p && typeof p.catch === "function") {
            p.catch(function () {
              // Autoplay refused before the first user gesture, or the file
              // failed: keep the reminder audible through the fallback.
              playFallbackCue(vol);
            });
          }
        } catch (e) {
          playFallbackCue(vol);
        }
      }

      // Another plugin may already own the sound channel. Read its public
      // control API rather than its internals: it exposes `config.sound` for
      // exactly this kind of coordination.
      function soundGivenToOthers() {
        if (!readConfig().deferSoundToOthers) return false;
        try {
          var api = root.__dshNotifyMe;
          var other = api && api.config;
          if (!other || typeof other !== "object") return false;
          if (other.enabled === false) return false;
          return other.sound === true;
        } catch (e) {
          return false;
        }
      }

      var lastRingAt = 0;
      // One cue now serves every class, so this window alone decides whether a
      // batch is heard once: a burst of sessions finishing together rings once,
      // and a second wave less than a moment later is still that same burst.
      var RING_MIN_GAP_MS = 700;

      /**
       * Ring for one batch of occurrences.
       *
       * The class of the occurrence no longer selects a sound — every alert
       * plays the same packaged cue — so `kind` is only kept for the diagnostic
       * API and is not consulted here.
       * @param kind - "completion" | "other"; no longer selects a cue.
       */
      function ring(kind) {
        var cfg = readConfig();
        if (!cfg.sound.enabled) return;
        if (soundGivenToOthers()) return;
        var now = Date.now();
        if (now - lastRingAt < RING_MIN_GAP_MS) return;
        lastRingAt = now;
        unlockAudio();
        playCue(cfg.sound.volume);
      }

      // ───────────────────── session state reading ─────────────────────
      function hidden() {
        try {
          if (typeof document === "undefined") return false;
          if (document.visibilityState === "hidden") return true;
          if (typeof document.hasFocus === "function" && !document.hasFocus()) return true;
        } catch (e) {}
        return false;
      }

      function lookupService(name) {
        var svc = null;
        try {
          if (rootCtx && typeof rootCtx.get === "function") svc = rootCtx.get(name) || null;
        } catch (e) {
          svc = null;
        }
        if (svc) return svc;
        try {
          if (rootCtx && rootCtx.reflect && typeof rootCtx.reflect.get === "function") svc = rootCtx.reflect.get(name) || null;
        } catch (e) {
          svc = null;
        }
        if (svc) return svc;
        try {
          if (rootCtx && name in rootCtx) svc = rootCtx[name] || null;
        } catch (e) {
          svc = null;
        }
        return svc;
      }

      function isStore(s) {
        return !!s && typeof s.getSnapshot === "function" && typeof s.subscribe === "function";
      }

      // sessionStatus is the 0.1.6+ source: one row per session carrying
      // running, pendingInteraction and completionUnread. Older hosts expose
      // the pending-interaction map alone, so that stays as the fallback.
      function interactionStore(svc) {
        if (svc && isStore(svc.sessionStatus)) return { store: svc.sessionStatus, source: "sessionStatus" };
        if (svc && isStore(svc.pendingInteractions)) return { store: svc.pendingInteractions, source: "pendingInteractions" };
        return null;
      }

      function pendingOf(value, source) {
        if (!value) return null;
        if (source === "sessionStatus") return value.pendingInteraction || null;
        return value;
      }

      function listSnapshot() {
        try {
          return (listStore && listStore.getSnapshot()) || null;
        } catch (e) {
          return null;
        }
      }

      // The session on screen. <= 0.1.5-rc.3 carried `current`; 0.1.6+ dropped
      // it and marks the on-screen row with a main-view retention count.
      function currentSessionId() {
        var st = listSnapshot();
        if (!st) return null;
        if (typeof st.current === "string" && st.current) return st.current;
        var byId = st.byId || {};
        for (var id in byId) {
          var row = byId[id];
          if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
        }
        return null;
      }

      function rowOf(sid) {
        var st = listSnapshot();
        return (st && st.byId && st.byId[sid]) || null;
      }

      function labelOf(sid, cur) {
        var row = rowOf(sid);
        if (row) {
          var label = row.displayTitle || row.title || "";
          if (label) return label;
        }
        if (sid === cur) return localeText("current", "当前会话");
        return String(sid).slice(0, 12);
      }

      /**
       * Should this session stay quiet?
       *
       * "Quiet" means no sound: the user is already looking at that session, so
       * ringing at them adds nothing. It must not remove the row from the unread
       * set — the tray keeps blinking for it until it is actually read, exactly
       * like QQ, where an alert that arrived while you were in the window still
       * keeps the tray lit.
       *
       * @param sid - session id.
       * @param cur - the on-screen session id.
       * @returns true when no sound should be raised for it.
       */
      function alertMutedFor(sid, cur) {
        var cfg = readConfig();
        if (cfg.skipVisibleCurrent && sid === cur && !hidden()) return true;
        if (cfg.ignoreSubagents && sid !== cur) {
          var row = rowOf(sid);
          if (row && row.origin === "subagent") return true;
        }
        return false;
      }

      /**
       * Should this session be dropped from the reminder set entirely?
       *
       * Only subagents: with `ignoreSubagents` on, a subagent run is internal
       * work the user never reads directly, so it neither rings nor blinks.
       * Visibility is handled separately by {@link alertMutedFor} because a
       * visible session still counts as unread until the user reads it.
       *
       * @param sid - session id.
       * @param cur - the on-screen session id.
       * @returns true when the session should not appear in the unread set.
       */
      function alertExcluded(sid, cur) {
        var cfg = readConfig();
        if (cfg.ignoreSubagents && sid !== cur) {
          var row = rowOf(sid);
          if (row && row.origin === "subagent") return true;
        }
        return false;
      }

      // A session that stops running looks identical whether its reply is
      // ready or the turn was killed from outside — a token budget that ran out,
      // an abort, a crash. Those deserve different sounds, and the page cannot
      // see the difference: it asks the host, which records `turn/end` with its
      // reason. These are the endings that mean "there is a reply to read".
      // The host answers with its own `normal` flag; this table only covers a
      // record that predates that flag, so a reason alone still classifies.
      var NORMAL_TURN_ENDS = { completed: true, forked: true };

      function turnReasonNormal(reason, flagged) {
        if (typeof flagged === "boolean") return flagged;
        return typeof reason === "string" && NORMAL_TURN_ENDS[reason] === true;
      }

      // The dock is one observable, but two things depend on the unread set:
      // the dock itself (hidden when `badge` is off) and the tray blink (which
      // must follow the set regardless). Track both signatures so turning the
      // dock off cannot also stall the blink.
      var unread = { items: [], signature: "" };
      var alertSignature = "";
      var unreadListeners = [];

      function subscribeUnread(cb) {
        unreadListeners.push(cb);
        return function () {
          for (var i = 0; i < unreadListeners.length; i++) {
            if (unreadListeners[i] === cb) {
              unreadListeners.splice(i, 1);
              return;
            }
          }
        };
      }

      function getUnread() {
        return unread;
      }

      function signatureOf(items) {
        var sig = "";
        for (var i = 0; i < items.length; i++) sig += items[i].id + "~" + items[i].key + "~" + items[i].label + "|";
        return sig;
      }

      /**
       * Publish the unread set to the dock.
       * @param items - rows to render; empty when the dock is disabled.
       * @param allItems - the real unread set, used for the blink signature.
       * @returns true when the real unread set changed since the last call.
       */
      function publish(items, allItems) {
        var nextAlertSig = signatureOf(allItems || items);
        var alertChanged = nextAlertSig !== alertSignature;
        alertSignature = nextAlertSig;

        var sig = signatureOf(items);
        if (sig === unread.signature) return alertChanged;
        unread = { items: items, signature: sig };
        for (var j = 0; j < unreadListeners.length; j++) {
          try {
            unreadListeners[j]();
          } catch (e) {}
        }
        return alertChanged;
      }

      // ──────────────────────── the reminder engine ────────────────────────
      // One record per session: which alert it currently owes the user. The
      // record is the dedupe — it exists while the alert stands, and disappears
      // the moment the session stops standing there.
      var records = Object.create(null); // sid -> { alertKey: true } for rung alerts
      var runningById = Object.create(null); // sid -> bool, for stop edges
      var dismissed = Object.create(null); // sid -> key the user dismissed
      // How the host says each session's last turn ended. `known: false` means
      // the question was asked and no answer came back, which must not be read
      // as "abnormal" — an unknown ending stays quiet rather than crying wolf.
      var turnEnds = Object.create(null); // sid -> { known, normal, reason, at }
      var turnQueries = Object.create(null); // sid -> true while a request is open
      // Stops waiting for that answer, and the abnormal endings that answer
      // produced. The edge is gone by the time the answer arrives, so the
      // finding is kept here until the user deals with it.
      var stopPending = Object.create(null); // sid -> true
      var stopAlerts = Object.create(null); // sid -> { reason, at }
      var uiSub = null;
      var uiStore = null;
      var uiSource = null;
      var flashing = false;
      var disposed = false;
      // Whether this page can blink the tray icon at all. Decided by the
      // host's own answer, never by a page-side guess: the packaged shell and a
      // browser tab can look identical from inside, and a wrong guess here
      // silently disables the whole tray feature.
      //   'unknown' — not asked yet (the host is asked once, on mount)
      //   'yes'     — the host is the Electron desktop and owns the window
      //   'no'      — a plain web host; flash is impossible, not merely failing
      var hostDesktop = "unknown";

      function interactionSource() {
        var found = interactionStore(lookupService("uiSession"));
        return found;
      }

      function bindInteractionSource() {
        if (disposed) return;
        var found = interactionSource();
        if (!found) return;
        if (uiSub && uiStore === found.store) return;
        detachInteractionSource();
        uiStore = found.store;
        uiSource = found.source;
        uiSub = found.store.subscribe(function () {
          try {
            sync();
          } catch (e) {}
        });
        try {
          sync();
        } catch (e) {}
      }

      function detachInteractionSource() {
        if (uiSub) {
          try {
            uiSub();
          } catch (e) {}
          uiSub = null;
        }
        uiStore = null;
        uiSource = null;
      }

      // ───────────────────── asking the host why a turn ended ─────────────────────
      // One request per stopped session, coalesced by id, answered by the host's
      // state route. The answer describes the session's latest ending and is
      // cached until that session runs again — a re-render must not re-ask, and
      // a burst of stops must not become a burst of requests.
      function requestTurnEnd(sid) {
        if (turnQueries[sid]) return;
        var cached = turnEnds[sid];
        if (cached && cached.known) return; // already answered for this ending
        stopPending[sid] = true;
        if (typeof root.fetch !== "function") {
          turnEnds[sid] = { known: false, normal: true, reason: "", at: 0 };
          delete stopPending[sid];
          return;
        }
        turnQueries[sid] = true;
        try {
          var url = STATE_ROUTE + "?id=" + encodeURIComponent(sid);
          root
            .fetch(url, { method: "GET", headers: { "x-dsh-desktop-alerts": "state" }, cache: "no-store" })
            .then(function (res) {
              if (!res || !res.ok || typeof res.json !== "function") throw new Error("bad-response");
              return res.json();
            })
            .then(
              function (body) {
                delete turnQueries[sid];
                var record = body && body.sessions ? body.sessions[sid] : null;
                if (!record) {
                  // The host has no ending for this session: it predates this
                  // page, or the turn ended before the recorder mounted. An
                  // unknown ending must stay quiet rather than cry wolf.
                  turnEnds[sid] = { known: false, normal: true, reason: "", at: 0 };
                  return;
                }
                turnEnds[sid] = {
                  known: true,
                  normal: turnReasonNormal(record.reason, typeof record.normal === "boolean" ? record.normal : undefined),
                  reason: typeof record.reason === "string" ? record.reason : "",
                  at: typeof record.at === "number" ? record.at : 0,
                };
                // The stop edge that asked this question is long gone; if the
                // answer says the run died, that finding becomes the standing
                // reminder for this session.
                if (stopPending[sid]) {
                  delete stopPending[sid];
                  if (!turnEnds[sid].normal) {
                    stopAlerts[sid] = { reason: turnEnds[sid].reason, at: turnEnds[sid].at };
                  }
                }
                try {
                  sync();
                } catch (e) {}
              },
              function () {
                delete turnQueries[sid];
                delete stopPending[sid];
              },
            )
            .catch(function () {
              delete turnQueries[sid];
              delete stopPending[sid];
            });
        } catch (e) {
          delete turnQueries[sid];
          delete stopPending[sid];
        }
      }

      function collect() {
        var cur = currentSessionId();
        var items = [];
        var seen = Object.create(null);

        // 1) Running edges. The baseline is what turns a stop into an alert,
        //    and only a stop whose turn end the host calls abnormal becomes the
        //    "cut off from outside" reminder. A normal end is left to the
        //    unread channel below, which already reports it.
        var st = listSnapshot();
        var byId = (st && st.byId) || {};
        var nextRunning = Object.create(null);
        var stopped = [];
        for (var id in byId) {
          var row = byId[id];
          if (!row) continue;
          nextRunning[id] = !!row.running;
          var was = runningById[id];
          if (was && !row.running && !alertExcluded(id, cur)) stopped.push(id);
          // A session that runs again has a new ending coming, so the answer
          // about the previous one is spent, and so is any reminder it raised.
          if (row.running) {
            if (turnEnds[id]) delete turnEnds[id];
            if (stopAlerts[id]) delete stopAlerts[id];
          }
        }
        runningById = nextRunning;
        // Ask the host why these stopped. The answer arrives on the next sync;
        // the lookup is cached per session so this costs one request, not one
        // per sync.
        for (var s = 0; s < stopped.length; s++) requestTurnEnd(stopped[s]);

        // 2) Waiting interactions: the agent cannot continue without the user.
        var found = interactionSource();
        if (found && typeof found.store.getSnapshot === "function") {
          var snap = found.store.getSnapshot();
          if (snap && typeof snap.forEach === "function") {
            snap.forEach(function (value, sid) {
              var it = pendingOf(value, found.source);
              if (!it) return;
              if (alertExcluded(sid, cur)) return;
              seen[sid] = true;
              items.push({
                id: sid,
                kind: "attention",
                sub: typeof it.kind === "string" ? it.kind : "",
                key: it.key || String(it.kind || "wait") + ":" + sid,
                quiet: alertMutedFor(sid, cur),
              });
            });
            // 3) Replies finished but not read, on hosts that expose the flag.
            if (found.source === "sessionStatus") {
              snap.forEach(function (value, sid) {
                if (!value || !value.completionUnread) return;
                if (value.pendingInteraction) return; // a stop awaiting input is a wait
                if (seen[sid]) return;
                if (alertExcluded(sid, cur)) return;
                seen[sid] = true;
                items.push({
                  id: sid,
                  kind: "completion",
                  sub: "",
                  key: "completion:" + sid,
                  quiet: alertMutedFor(sid, cur),
                });
              });
            }
          }
        }

        // 4) Older hosts keep the unread bit on the list row itself.
        if (!(found && found.source === "sessionStatus")) {
          for (var rid in byId) {
            var r2 = byId[rid];
            if (!r2 || !r2.completed) continue;
            if (seen[rid]) continue;
            if (alertExcluded(rid, cur)) continue;
            seen[rid] = true;
            items.push({
              id: rid,
              kind: "completion",
              sub: "",
              key: "completion:" + rid,
              quiet: alertMutedFor(rid, cur),
            });
          }
        }

        // 5) A turn the host called abnormal is the "其他类" case even though
        //    nothing is left to read: the user is not waiting for a reply, they
        //    are waiting to find out that the run died. The key carries the
        //    ending's timestamp, so the reminder stands until the user deals
        //    with it and a later ending in the same session rings again.
        for (var sid2 in stopAlerts) {
          if (seen[sid2]) continue;
          if (!byId[sid2]) {
            // The session is gone: its interruption has nothing left to point at.
            delete stopAlerts[sid2];
            continue;
          }
          if (alertExcluded(sid2, cur)) continue;
          var alert = stopAlerts[sid2];
          seen[sid2] = true;
          items.push({
            id: sid2,
            kind: "interrupted",
            sub: alert.reason || "",
            key: "interrupted:" + sid2 + ":" + alert.at,
            quiet: alertMutedFor(sid2, cur),
          });
        }

        // 6) Labels last: one list read for everything.
        for (var i = 0; i < items.length; i++) {
          items[i].label = labelOf(items[i].id, cur);
        }

        return { items: items };
      }

      function sync() {
        if (disposed) return;
        var collected;
        try {
          collected = collect();
        } catch (e) {
          return;
        }
        var items = collected.items;
        var ringers = [];
        // Dedupe per session on the alert key, not per item: a session can carry
        // a standing wait and a fresh interruption at once, and only the alert
        // that has not rung before is news. Anything already rung stays in the
        // dock but does not ring again.
        var rung = Object.create(null);

        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (rung[it.id] && rung[it.id][it.key]) continue;
          (rung[it.id] = rung[it.id] || {})[it.key] = true;
          if (dismissed[it.id] === it.key) continue; // the user waved it away
          // A quiet row is unread but already on screen: it stays in the set so
          // the tray keeps blinking, yet it does not ring at the user.
          if (it.quiet === true) continue;
          var prev = records[it.id];
          if (prev && prev[it.key]) continue; // this alert already rang
          ringers.push(it);
        }
        for (var sid in dismissed) {
          if (!records[sid] || !records[sid][dismissed[sid]]) delete dismissed[sid];
        }
        records = rung;

        // One cue for the whole batch. The class still travels along, because
        // the dock and the diagnostic API describe what each row means, but it
        // no longer picks a sound: every alert plays the same recording.
        if (ringers.length > 0) ring(ringers[0].kind);

        // The badge switch hides the dock only; it must not decide whether the
        // tray blinks, so the blink follows the real unread set.
        var shown = readConfig().badge ? items : [];
        var signatureChanged = publish(shown, items);

        // Tray: blink while anything is unread, and stop only once every
        // triggering session has been read. `items` already excludes the rows
        // the user handled, so this is exactly QQ's rule: reading session A does
        // not silence session B, and the blink ends when the set is empty.
        //
        // This deliberately ignores window focus. The overlay sits on the tray
        // icon, so it is visible even while the app is in front — which is the
        // point: an unread session behind the one on screen still needs
        // attention.
        var cfg = readConfig();
        if (cfg.flash) {
          if (items.length > 0) {
            // Re-arm whenever the unread set changed, including a row that only
            // appeared quietly: the tray must blink for it either way.
            if (!flashing || signatureChanged) {
              flashing = true;
              postFlash("start");
            }
          } else if (flashing) {
            flashing = false;
            postFlash("stop");
          }
        } else if (flashing) {
          flashing = false;
          postFlash("stop");
        }
      }

      // Dismissal means different things per kind. A waiting interaction still
      // stands until the agent is answered, so it leaves the dock only when the
      // wait itself goes away — dismissing just stops the nagging. An
      // interruption has nothing left to act on, so dismissing removes it.
      function dismissAll() {
        var cur = currentSessionId();
        for (var i = 0; i < unread.items.length; i++) {
          var it = unread.items[i];
          dismissed[it.id] = it.key;
          if (it.kind === "interrupted") delete stopAlerts[it.id];
        }
        try {
          sync();
        } catch (e) {}
        return cur;
      }

      function dismissOne(sid) {
        for (var i = 0; i < unread.items.length; i++) {
          var it = unread.items[i];
          if (it.id !== sid) continue;
          dismissed[sid] = it.key;
          if (it.kind === "interrupted") delete stopAlerts[sid];
        }
        try {
          sync();
        } catch (e) {}
      }

      // QQ behaviour: clicking the notification takes you to the conversation.
      // Navigation moved with the host API — `sessions.open` through
      // 0.1.5-rc.3, `uiWorkspace.openSession` from 0.1.6 on.
      function openSession(sid) {
        if (!sid) return;
        try {
          var svc = lookupService("sessions");
          if (svc && typeof svc.open === "function") {
            svc.open(sid);
            dismissOne(sid);
            return;
          }
          var ws = lookupService("uiWorkspace");
          if (ws && typeof ws.openSession === "function") {
            ws.openSession(sid);
            dismissOne(sid);
            return;
          }
        } catch (e) {}
        // No navigation verb on this host: still stop nagging about it.
        dismissOne(sid);
      }

      // ─────────────────────────── locale ───────────────────────────
      var NS = "dsh-desktop-alerts";

      function localeText(key, fallback) {
        try {
          if (localeSvc && typeof localeSvc.bind === "function") {
            var tr = localeSvc.bind(NS);
            var value = tr(key);
            if (typeof value === "string" && value && value !== key) return value;
          }
        } catch (e) {}
        return fallback;
      }

      var UI_zh = {
        nav: "桌面提醒",
        blurb: "会话需要你处理，或回复在后台完成时，响一声并让右下角托盘图标像 QQ 未读消息那样闪动。",
        secSound: "提示音",
        soundEnabled: "提示音",
        soundEnabledHint: "所有提醒都用同一段录音：五声短促的「滴」。需要你处理、回复完成、会话被中断，声音都一样。",
        volume: "音量",
        secTaskbar: "托盘与浮窗",
        flash: "托盘图标闪动",
        flashHint: "有未读会话时，让右下角系统托盘里的图标像 QQ 那样闪动；所有触发提醒的会话都读完之后才停，跟你当前在看哪条会话无关。",
        badge: "未读浮窗",
        badgeHint: "右下角显示待处理会话，点一下直接跳到那条会话。",
        secWhen: "什么时候提醒",
        ignoreSubagents: "忽略子会话",
        ignoreSubagentsHint: "子智能体的中间步骤不提醒，只提醒你自己的会话。",
        skipVisibleCurrent: "当前会话在眼前时不响",
        skipVisibleCurrentHint: "窗口在前台，且提醒来自你正看着的这条会话时，不响声音；托盘图标仍然会闪，直到你把它读掉。",
        deferSoundToOthers: "声音让给 dsh-notify-me",
        deferSoundToOthersHint: "检测到 dsh-notify-me 已开启提示音时不再重复响；托盘闪动与未读浮窗仍由本插件负责。",
        secTest: "试一试",
        testSound: "试听提示音",
        testFlash: "试一下托盘闪动",
        testFlashHint: "闪 4 秒后自动停；有未读会话时会继续闪。",
        secDiag: "运行环境",
        diagShell: "运行环境",
        diagShellDesktop: "DSH 桌面端",
        diagShellWeb: "浏览器页面",
        diagRoute: "闪动通道",
        diagLast: "最近一次",
        diagCount: "未读会话",
        soundLocked: "音频还没解锁：先点一下窗口任意位置，浏览器才允许发声。",
        soundOff: "提示音是关的，打开上面的开关再试听。",
        badgeUnit: "条待处理",
        badgeTitle: "待处理",
        badgeClear: "全部忽略",
        kindApproval: "等待审批",
        kindQuestion: "等待回答",
        kindPlan: "等待确认计划",
        kindAttention: "需要你",
        kindDone: "回复已完成",
        kindInterrupted: "被中断",
        current: "当前会话",
        open: "打开",
      };

      var UI_en = {
        nav: "Desktop alerts",
        blurb: "When a session needs you, or a reply finished in the background, play a cue and make the notification-area icon flash like an unread QQ message.",
        secSound: "Sound",
        soundEnabled: "Alert cue",
        soundEnabledHint: "Every reminder plays the same recording: five short blips. A session needing you, a finished reply and an interrupted turn all sound the same.",
        volume: "Volume",
        secTaskbar: "Tray and dock",
        flash: "Flash the tray icon",
        flashHint: "Flashes the icon in the notification area while anything is unread, and stops only once every session that raised a reminder has been read. What you are currently reading does not matter.",
        badge: "Unread dock",
        badgeHint: "Lists the sessions still waiting in the bottom-right corner; clicking one opens it.",
        secWhen: "When to remind",
        ignoreSubagents: "Ignore subagent sessions",
        ignoreSubagentsHint: "Intermediate steps of a subagent run are not your conversation, so they stay quiet.",
        skipVisibleCurrent: "Stay quiet for the session on screen",
        skipVisibleCurrentHint: "No sound while the window is in front and the alert belongs to the session you are reading. The tray icon still flashes until you read it.",
        deferSoundToOthers: "Leave the sound to dsh-notify-me",
        deferSoundToOthersHint: "When dsh-notify-me is installed with its sound on, this plugin does not beep a second time. The tray flash and the dock stay its own job.",
        secTest: "Try it",
        testSound: "Preview the cue",
        testFlash: "Test the tray flash",
        testFlashHint: "Flashes for 4 seconds; it keeps going while anything is unread.",
        secDiag: "Environment",
        diagShell: "Runtime",
        diagShellDesktop: "DSH desktop shell",
        diagShellWeb: "Browser page",
        diagRoute: "Flash channel",
        diagLast: "Last result",
        diagCount: "Unread sessions",
        soundLocked: "Audio is still locked: click anywhere in the window once so the browser allows sound.",
        soundOff: "The cue is switched off; turn it on above before previewing.",
        badgeUnit: "unread",
        badgeTitle: "Pending",
        badgeClear: "Dismiss all",
        kindApproval: "Waiting for approval",
        kindQuestion: "Waiting for your answer",
        kindPlan: "Waiting to confirm a plan",
        kindAttention: "Needs you",
        kindDone: "Reply finished",
        kindInterrupted: "Interrupted",
        current: "Current session",
        open: "Open",
      };

      // ─────────────────────────── styles ───────────────────────────
      // Everything goes through the alias tokens so light and dark themes both
      // work. Namespaced with `dda-` to stay out of anyone else's way.
      var UI_CSS =
        ".dda-dock{position:fixed;right:18px;bottom:18px;z-index:2147483000;pointer-events:auto;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:inherit}" +
        ".dda-pill{display:inline-flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-overlay,#26282c);color:var(--dsw-alias-label-primary,rgba(20,20,20,.9));font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28);transition:transform .12s ease}" +
        ".dda-pill:hover{transform:translateY(-1px)}" +
        ".dda-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}" +
        ".dda-bell{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;line-height:0;color:var(--dsw-alias-brand-primary,#3b82f6)}" +
        ".dda-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:999px;background:var(--dsw-alias-state-error-primary,#ef4444);color:#fff;font-size:11px;font-weight:600;line-height:18px}" +
        ".dda-pillText{font-weight:600}" +
        ".dda-list{width:290px;max-height:min(60vh,420px);overflow:auto;box-sizing:border-box;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-bg-overlay,#26282c);box-shadow:0 14px 40px rgba(0,0,0,.36);padding:6px}" +
        ".dda-row{display:flex;align-items:flex-start;gap:9px;width:100%;box-sizing:border-box;padding:8px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,rgba(20,20,20,.9));font-family:inherit;font-size:13px;line-height:19px;text-align:left;cursor:pointer}" +
        ".dda-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.14))}" +
        ".dda-dot{flex:none;width:8px;height:8px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#f59e0b)}" +
        ".dda-dot.done{background:var(--dsw-alias-state-success-primary,#22c55e)}" +
        ".dda-rowText{min-width:0;display:flex;flex-direction:column;gap:1px}" +
        ".dda-rowTitle{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
        ".dda-rowSub{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9))}" +
        ".dda-foot{display:flex;justify-content:flex-end;padding:4px 4px 2px}" +
        ".dda-btn{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:transparent;color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9));border-radius:8px;padding:4px 10px;font-size:12px;font-family:inherit;cursor:pointer}" +
        ".dda-btn:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.1));color:var(--dsw-alias-label-primary,rgba(20,20,20,.9))}" +
        ".dda-wrap{width:100%;max-width:720px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,rgba(20,20,20,.9))}" +
        ".dda-head{display:flex;align-items:flex-start;gap:12px}" +
        ".dda-headIcon{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;color:var(--dsw-alias-brand-primary,#3b82f6);background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.24)}" +
        ".dda-headText{min-width:0;display:flex;flex-direction:column;gap:3px;padding-top:1px}" +
        ".dda-headTitle{font-size:15px;font-weight:600;line-height:21px}" +
        ".dda-headSub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9))}" +
        ".dda-sec{display:flex;flex-direction:column;gap:8px}" +
        ".dda-secTitle{margin:2px 0 -2px;padding:0 2px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9))}" +
        ".dda-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05));border-radius:10px;overflow:hidden}" +
        ".dda-row2{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 14px;min-height:46px;box-sizing:border-box}" +
        ".dda-row2+.dda-row2{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}" +
        ".dda-rowText2{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}" +
        ".dda-label{font-size:13px;font-weight:600;line-height:20px}" +
        ".dda-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9))}" +
        ".dda-switch{flex:none;position:relative;width:34px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.2));cursor:pointer;padding:0;transition:background .15s ease}" +
        ".dda-switch.on{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent}" +
        ".dda-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s ease}" +
        ".dda-switch.on .dda-knob{left:16px}" +
        ".dda-range{width:160px;accent-color:var(--dsw-alias-brand-primary,#3b82f6)}" +
        ".dda-btnRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
        ".dda-feedback{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9));min-height:18px}" +
        ".dda-diag{display:flex;flex-direction:column;gap:4px;padding:10px 14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(90,90,90,.9))}" +
        ".dda-diag b{color:var(--dsw-alias-label-primary,rgba(20,20,20,.9));font-weight:600}";

      function injectStyle() {
        var el = null;
        try {
          if (typeof document === "undefined" || typeof document.createElement !== "function") return function () {};
          var tagId = "dsh-desktop-alerts/ui";
          if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]")) return function () {};
          el = document.createElement("style");
          el.dataset.plugin = "dsh-desktop-alerts";
          el.dataset.pluginCss = tagId;
          el.textContent = UI_CSS;
          (document.head || document.documentElement).appendChild(el);
        } catch (e) {
          el = null;
        }
        return function () {
          try {
            if (el && el.parentNode) el.parentNode.removeChild(el);
          } catch (e) {}
        };
      }

      // ─────────────────────────── React bits ───────────────────────────
      function h(tag, props) {
        var args = [tag, props || null];
        for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
        return React.createElement.apply(React, args);
      }

      // useSyncExternalStore when the page's React has it (18+), a plain
      // subscribe-on-mount otherwise. The branch is stable for a page's
      // lifetime, so the hook order never changes between renders.
      function useStore(subscribe, getSnapshot) {
        if (typeof React.useSyncExternalStore === "function") {
          return React.useSyncExternalStore(subscribe, getSnapshot);
        }
        var st = React.useState(function () {
          return getSnapshot();
        });
        var value = st[0];
        var setValue = st[1];
        React.useEffect(function () {
          return subscribe(function () {
            setValue(getSnapshot());
          });
        }, []);
        return value;
      }

      function bellIcon() {
        return h(
          "svg",
          { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true", focusable: "false" },
          h("path", {
            d: "M12 2a5 5 0 0 0-5 5v4.2l-1.6 3.2A1 1 0 0 0 6.3 16h11.4a1 1 0 0 0 .9-1.6L17 11.2V7a5 5 0 0 0-5-5Zm0 20a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3Z",
            fill: "currentColor",
          }),
        );
      }

      function kindText(t, item) {
        if (item.kind === "attention") {
          if (item.sub === "approval") return t("kindApproval");
          if (item.sub === "question") return t("kindQuestion");
          if (item.sub === "plan-review") return t("kindPlan");
          return t("kindAttention");
        }
        if (item.kind === "interrupted") return t("kindInterrupted");
        return t("kindDone");
      }

      /**
       * The QQ-style unread dock: a count pill that expands into the list of
       * sessions still waiting. Renders nothing while the list is empty, so a
       * quiet desktop stays a quiet desktop.
       * @param props - `{ t }` injected by the slot registration.
       */
      function UnreadDock(props) {
        var t = props.t;
        var snap = useStore(subscribeUnread, getUnread);
        var openState = React.useState(false);
        var open = openState[0];
        var setOpen = openState[1];
        var items = (snap && snap.items) || [];
        if (!items.length) return null;
        var expanded = open;
        return h(
          "div",
          { className: "dda-dock", "data-dsh-desktop-alerts": "dock" },
          expanded
            ? h(
                "div",
                { className: "dda-list", role: "region", "aria-label": t("badgeTitle") },
                items.map(function (item) {
                  return h(
                    "button",
                    {
                      key: item.id,
                      type: "button",
                      className: "dda-row",
                      title: t("open"),
                      onClick: function () {
                        openSession(item.id);
                      },
                    },
                    h("span", { className: "dda-dot" + (item.kind === "completion" ? " done" : "") }),
                    h(
                      "span",
                      { className: "dda-rowText" },
                      h("span", { className: "dda-rowTitle" }, item.label),
                      h("span", { className: "dda-rowSub" }, kindText(t, item)),
                    ),
                  );
                }),
                h(
                  "div",
                  { className: "dda-foot" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dda-btn",
                      onClick: function () {
                        setOpen(false);
                        dismissAll();
                      },
                    },
                    t("badgeClear"),
                  ),
                ),
              )
            : null,
          h(
            "button",
            {
              type: "button",
              className: "dda-pill",
              title: t("badgeTitle"),
              "aria-expanded": expanded ? "true" : "false",
              onClick: function () {
                setOpen(!expanded);
              },
            },
            h("span", { className: "dda-bell" }, bellIcon()),
            h("span", { className: "dda-count" }, String(items.length)),
            h("span", { className: "dda-pillText" }, expanded ? t("badgeTitle") : items.length + " " + t("badgeUnit")),
          ),
        );
      }

      function Switch(props) {
        var on = !!props.value;
        return h(
          "button",
          {
            type: "button",
            className: "dda-switch" + (on ? " on" : ""),
            role: "switch",
            "aria-checked": on ? "true" : "false",
            "aria-label": props.label,
            onClick: function () {
              props.onChange(!on);
            },
          },
          h("span", { className: "dda-knob" }),
        );
      }

      function SettingRow(props) {
        return h(
          "div",
          { className: "dda-row2" },
          h(
            "div",
            { className: "dda-rowText2" },
            h("div", { className: "dda-label" }, props.label),
            props.hint ? h("div", { className: "dda-hint" }, props.hint) : null,
          ),
          props.children,
        );
      }

      /**
       * Settings page. Every control writes through to localStorage and re-runs
       * the engine, so a switch takes effect on the next event instead of after
       * a restart.
       * @param props - `{ ctx, t }`.
       */
      function SettingsView(props) {
        var ctx = props.ctx;
        var t = props.t;
        useStore(
          function (cb) {
            return ctx.locale.subscribe(cb);
          },
          function () {
            return ctx.locale.getSnapshot();
          },
        );
        var st = React.useState(function () {
          return readConfig();
        });
        var cfg = st[0];
        var setCfg = st[1];
        var fbSt = React.useState("");
        var feedback = fbSt[0];
        var setFeedback = fbSt[1];

        function patch(p) {
          var next = writeConfig(p);
          setCfg(mergeConfig(next));
          try {
            sync();
          } catch (e) {}
        }

        function preview() {
          if (!cfg.sound.enabled) {
            setFeedback(t("soundOff"));
            return;
          }
          unlockAudio();
          setFeedback("");
          // The recording is an `Audio` element, not a WebAudio graph, so it
          // does not need `audioCtx` to be running; the unlock above only
          // satisfies the browser's gesture requirement.
          playCue(cfg.sound.volume);
        }

        function testFlash() {
          // The host decides whether a window exists; a page-side veto here
          // would only reproduce the bug that made the button look broken.
          postFlash("start");
          setTimeout(function () {
            if (!flashing) postFlash("stop");
          }, 4000);
          setFeedback(t("testFlashHint"));
        }

        return h(
          "div",
          { className: "dda-wrap", "data-dsh-desktop-alerts": "settings" },
          h(
            "div",
            { className: "dda-head" },
            h("div", { className: "dda-headIcon" }, bellIcon()),
            h(
              "div",
              { className: "dda-headText" },
              h("div", { className: "dda-headTitle" }, t("nav")),
              h("p", { className: "dda-headSub" }, t("blurb")),
            ),
          ),
          // sound
          h(
            "div",
            { className: "dda-sec" },
            h("div", { className: "dda-secTitle" }, t("secSound")),
            h(
              "div",
              { className: "dda-card" },
              h(SettingRow, { label: t("soundEnabled"), hint: t("soundEnabledHint") }, h(Switch, {
                value: cfg.sound.enabled,
                label: t("soundEnabled"),
                onChange: function (v) {
                  patch({ sound: { enabled: v } });
                },
              })),
              h(
                SettingRow,
                { label: t("volume") },
                h("input", {
                  type: "range",
                  className: "dda-range",
                  min: "0",
                  max: "1",
                  step: "0.05",
                  value: String(cfg.sound.volume),
                  "aria-label": t("volume"),
                  onChange: function (e) {
                    patch({ sound: { volume: Number(e.currentTarget.value) } });
                  },
                }),
              ),
              h(
                SettingRow,
                { label: t("deferSoundToOthers"), hint: t("deferSoundToOthersHint") },
                h(Switch, {
                  value: cfg.deferSoundToOthers,
                  label: t("deferSoundToOthers"),
                  onChange: function (v) {
                    patch({ deferSoundToOthers: v });
                  },
                }),
              ),
            ),
          ),
          // tray + dock
          h(
            "div",
            { className: "dda-sec" },
            h("div", { className: "dda-secTitle" }, t("secTaskbar")),
            h(
              "div",
              { className: "dda-card" },
              h(SettingRow, { label: t("flash"), hint: t("flashHint") }, h(Switch, {
                value: cfg.flash,
                label: t("flash"),
                onChange: function (v) {
                  patch({ flash: v });
                },
              })),
              h(SettingRow, { label: t("badge"), hint: t("badgeHint") }, h(Switch, {
                value: cfg.badge,
                label: t("badge"),
                onChange: function (v) {
                  patch({ badge: v });
                },
              })),
            ),
          ),
          // when
          h(
            "div",
            { className: "dda-sec" },
            h("div", { className: "dda-secTitle" }, t("secWhen")),
            h(
              "div",
              { className: "dda-card" },
              h(SettingRow, { label: t("ignoreSubagents"), hint: t("ignoreSubagentsHint") }, h(Switch, {
                value: cfg.ignoreSubagents,
                label: t("ignoreSubagents"),
                onChange: function (v) {
                  patch({ ignoreSubagents: v });
                },
              })),
              h(SettingRow, { label: t("skipVisibleCurrent"), hint: t("skipVisibleCurrentHint") }, h(Switch, {
                value: cfg.skipVisibleCurrent,
                label: t("skipVisibleCurrent"),
                onChange: function (v) {
                  patch({ skipVisibleCurrent: v });
                },
              })),
            ),
          ),
          // test
          h(
            "div",
            { className: "dda-sec" },
            h("div", { className: "dda-secTitle" }, t("secTest")),
            h(
              "div",
              { className: "dda-card" },
              h(
                "div",
                { className: "dda-row2" },
                h(
                  "div",
                  { className: "dda-rowText2" },
                  h("div", { className: "dda-label" }, t("secTest")),
                  h("div", { className: "dda-feedback" }, feedback || t("testFlashHint")),
                ),
                h(
                  "div",
                  { className: "dda-btnRow" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dda-btn",
                      onClick: preview,
                    },
                    t("testSound"),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dda-btn",
                      onClick: testFlash,
                    },
                    t("testFlash"),
                  ),
                ),
              ),
            ),
          ),
          // diagnostics
          h(
            "div",
            { className: "dda-sec" },
            h("div", { className: "dda-secTitle" }, t("secDiag")),
            h(
              "div",
              { className: "dda-card" },
              h(
                "div",
                { className: "dda-diag" },
                h("div", null, t("diagShell") + ": ", h("b", null, isDesktopShell() ? t("diagShellDesktop") : t("diagShellWeb"))),
                h("div", null, t("diagRoute") + ": ", h("b", null, flashState.last)),
                h("div", null, t("diagCount") + ": ", h("b", null, String(unread.items.length))),
              ),
            ),
          ),
        );
      }

      // ─────────────────────── public control API ───────────────────────
      var api = root.__dshDesktopAlerts;
      if (!api || typeof api !== "object") api = {};
      api.version = "1.0.0";
      api.getConfig = function () {
        return readConfig();
      };
      api.setConfig = function (patch) {
        return writeConfig(patch);
      };
      api.resetConfig = function () {
        try {
          root.localStorage.removeItem(LS_CONFIG);
        } catch (e) {}
        config = null;
        var next = readConfig();
        try {
          sync();
        } catch (e) {}
        return next;
      };
      api.state = function () {
        return {
          unread: unread.items,
          records: records,
          flashing: flashing,
          flash: flashState.last,
          desktop: isDesktopShell(),
          source: uiSource,
          hidden: hidden(),
        };
      };
      api.test = function (kind) {
        if (kind === "flash") {
          postFlash("start");
          setTimeout(function () {
            if (!flashing) postFlash("stop");
          }, 4000);
          return flashState.last;
        }
        unlockAudio();
        playCue(readConfig().sound.volume);
        return cueEl ? "playing" : cueBroken ? "fallback" : "none";
      };
      api.sync = function () {
        sync();
        return unread.items;
      };
      root.__dshDesktopAlerts = api;

      // ─────────────────────────── plugin body ───────────────────────────
      // Hard requirements only: `uiSession` and `uiWorkspace` are looked up
      // lazily, because a cordis inject entry is a hard gate — an entry that
      // never activates fails the web boot audit on hosts that lack the service.
      var inject = ["sessions", "locale", "slots"];

      /**
       * @param ctx - client root context.
       */
      function apply(ctx) {
        rootCtx = ctx;
        readConfig();
        try {
          if (ctx.locale && typeof ctx.locale.getLocale === "function") localeSvc = ctx.locale;
        } catch (e) {}

        ctx.effect(injectStyle, "dsh-desktop-alerts: styles");

        // UI contributions: the dock and the settings page. Both need react +
        // slots + locale; the reminder engine below needs none of them.
        try {
          if (React && typeof React.createElement === "function" && ctx.slots && typeof ctx.slots.inject === "function" && ctx.locale && typeof ctx.locale.register === "function") {
            // register() throws when the namespace already has a locale, so the
            // dictionary lives in an effect whose disposer unregisters it: an
            // HMR reload therefore re-registers cleanly.
            ctx.effect(function () {
              return ctx.locale.register(NS, { zh: UI_zh, en: UI_en });
            }, "dsh-desktop-alerts: dictionaries");
            var t = ctx.locale.bind(NS);
            ctx.slots.inject("shell.overlay", function () {
              return ctx.slots.register(
                {
                  name: "shell.overlay",
                  id: "dsh-desktop-alerts:unread-dock",
                  order: 30,
                  label: function () {
                    return t("badgeTitle");
                  },
                  locale: NS,
                  inject: function () {
                    return { t: t };
                  },
                },
                UnreadDock,
              );
            });
            ctx.slots.inject("settings.section", function () {
              return ctx.slots.register(
                {
                  name: "settings.section",
                  id: "dsh-desktop-alerts",
                  order: 55,
                  label: function () {
                    return t("nav");
                  },
                  locale: NS,
                  inject: function () {
                    return { t: t };
                  },
                },
                function () {
                  return React.createElement(SettingsView, { ctx: ctx, t: t });
                },
              );
            });
          }
        } catch (e) {
          try {
            console.warn("[dsh-desktop-alerts] settings page unavailable", e);
          } catch (e2) {}
        }

        ctx.effect(function () {
          var unsubs = [];
          var retryTimer = null;
          disposed = false;
          try {
            var sessionsSvc = ctx.sessions;
            if (!sessionsSvc || !sessionsSvc.list || typeof sessionsSvc.list.subscribe !== "function") {
              try {
                console.log("[dsh-desktop-alerts] sessions service unavailable — watchers idle");
              } catch (e) {}
              return function () {
                disposed = true;
              };
            }
            listStore = sessionsSvc.list;
            unsubs.push(
              listStore.subscribe(function () {
                try {
                  sync();
                } catch (e) {}
              }),
            );

            // "Went away" and "came back" both change what counts as a
            // reminder, so the derivation re-runs on both.
            var onViewChange = function () {
              try {
                sync();
              } catch (e) {}
            };
            try {
              document.addEventListener("visibilitychange", onViewChange);
              unsubs.push(function () {
                try {
                  document.removeEventListener("visibilitychange", onViewChange);
                } catch (e) {}
              });
            } catch (e) {}
            try {
              root.addEventListener("focus", onViewChange);
              root.addEventListener("blur", onViewChange);
              unsubs.push(function () {
                try {
                  root.removeEventListener("focus", onViewChange);
                  root.removeEventListener("blur", onViewChange);
                } catch (e) {}
              });
            } catch (e) {}

            // A browser only starts an AudioContext after a user gesture.
            var onGesture = function () {
              unlockAudio();
            };
            try {
              root.addEventListener("pointerdown", onGesture, true);
              root.addEventListener("keydown", onGesture, true);
              unsubs.push(function () {
                try {
                  root.removeEventListener("pointerdown", onGesture, true);
                  root.removeEventListener("keydown", onGesture, true);
                } catch (e) {}
              });
            } catch (e) {}

            bindInteractionSource();
            probeDesktop();
            sync();
            // The uiSession entry may apply after this one, and the service
            // instance is replaced on HMR: re-check while idle.
            retryTimer = setInterval(function () {
              if (disposed) return;
              try {
                bindInteractionSource();
              } catch (e) {}
            }, 1500);
            try {
              console.log("[dsh-desktop-alerts] active — window.__dshDesktopAlerts (flash=" + readConfig().flash + ", desktop=" + isDesktopShell() + ")");
            } catch (e) {}
          } catch (e) {
            try {
              console.error("[dsh-desktop-alerts] init failed", e);
            } catch (e2) {}
          }
          return function () {
            disposed = true;
            if (retryTimer) clearInterval(retryTimer);
            for (var i = 0; i < unsubs.length; i++) {
              try {
                unsubs[i]();
              } catch (e) {}
            }
            detachInteractionSource();
            records = Object.create(null);
            runningById = Object.create(null);
            dismissed = Object.create(null);
            turnEnds = Object.create(null);
            turnQueries = Object.create(null);
            stopPending = Object.create(null);
            stopAlerts = Object.create(null);
            if (flashing) {
              flashing = false;
              postFlash("stop");
            }
            publish([]);
          };
        }, "dsh-desktop-alerts: watchers");
      }

      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    },
  });
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null);
