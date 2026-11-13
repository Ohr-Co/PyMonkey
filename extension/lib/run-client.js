// Start a script from an extension page (the side panel) and wait for its result.
//
// A run is not one request that waits for an answer, because the background
// service worker may be shut down by Chrome long before a slow script is done
// (see "running a script" in background.js). Instead:
//   * "run-in-tab" starts the run and is answered at once
//   * "run-finished" arrives later as a separate message
//   * meanwhile we ask "run-status" every few seconds, in case that message
//     was missed or the run no longer exists
//
// Pure logic when `send` and `events` are passed in: see tests/run-client.test.mjs.

const POLL_MS = 2000;
const MAX_FAILED_POLLS = 3;

const LOST = "The result of this run was lost: the Python runtime was restarted while the script was running. Run it again.";
const UNREACHABLE = "PyMonkey stopped answering, so the result of this run is unknown. Reload the extension at chrome://extensions.";

const failure = (error) => ({ ok: false, stdout: "", error });

/**
 * `timeout` is the script's time limit in seconds (see lib/timeout.js).
 * `scriptId` is the saved script the code belongs to (null for an unsaved one);
 * it decides whose `page.store` the run uses.
 *
 * Returns { runId, started, result, stop }:
 *   started -- Promise<boolean>, true once the run was accepted
 *   result  -- Promise<{ok, stdout, error}>, always resolves (never hangs, never rejects)
 *   stop()  -- end the run now; `result` then resolves with "Stopped by user."
 */
export function startRun(
  tabId,
  code,
  {
    timeout,
    scriptId = null,
    send = (message) => chrome.runtime.sendMessage({ ...message, target: "background" }),
    events = chrome.runtime.onMessage,
    pollMs = POLL_MS,
  } = {},
) {
  const runId = crypto.randomUUID();
  let finish;
  const result = new Promise((resolve) => (finish = resolve));

  let done = false;
  let timer = null;
  let failedPolls = 0;

  const settle = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    events.removeListener(onMessage);
    finish(value);
  };

  function onMessage(msg) {
    if (msg?.target === "panel" && msg.type === "run-finished" && msg.runId === runId) settle(msg.result);
  }

  async function poll() {
    const status = await send({ type: "run-status", runId }).catch(() => null);
    if (done) return;
    if (status?.state === "done") return settle(status.result);
    if (status?.state === "unknown") return settle(failure(LOST));
    // "queued" or "running": keep waiting. No usable answer: give up after a few tries.
    failedPolls = status?.state ? 0 : failedPolls + 1;
    if (failedPolls >= MAX_FAILED_POLLS) return settle(failure(UNREACHABLE));
    timer = setTimeout(poll, pollMs);
  }

  // Listen before sending, so a script that finishes instantly is not missed.
  events.addListener(onMessage);

  const started = send({ type: "run-in-tab", runId, tabId, scriptId, code, timeout }).then(
    (reply) => {
      if (!reply?.ok) settle(failure(reply?.error ?? "PyMonkey could not start the script."));
      else if (!done) timer = setTimeout(poll, pollMs);
      return Boolean(reply?.ok);
    },
    (err) => {
      settle(failure(String(err?.message ?? err)));
      return false;
    },
  );

  // The result of a stopped run arrives like any other: as "run-finished".
  const stop = () => send({ type: "stop-run", runId }).catch(() => {});

  return { runId, started, result, stop };
}
