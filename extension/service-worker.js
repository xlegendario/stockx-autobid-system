import { CONFIG } from "./config.js";

let isRunnerEnabled = false;
let isTaskInProgress = false;
let isRunLoopActive = false;

const LOOP_DELAY_MS = 8000;
const ERROR_RETRY_DELAY_MS = 15000;
const ORDER_PLACED_NEXT_TASK_DELAY_MS = 8000;
const BID_RESULT_NEXT_TASK_DELAY_MS = 4000;
// A place flow can legitimately take ~2 minutes (retries on input, review,
// confirm and the outcome screen), so the timeout leaves room for that.
const TASK_TIMEOUT_MS = 180000; // 3 minuten
const FETCH_TIMEOUT_MS = 30000;
const RUN_LOOP_STALE_MS = 90000;
const RUNNER_ALARM_NAME = "stockx-runner-loop";

/*
 * The runner loop is a chain of one-shot alarms, and the chain breaks
 * whenever a task is opened: from then on only the page reporting back
 * restarts it. A page that never reports (load event missed, SPA navigation
 * not followed, captcha, StockX error page) left the runner idle until
 * someone clicked Start Runner again.
 *
 * This periodic alarm does not depend on anything finishing. Every minute it
 * runs the loop, which times out a stuck task and moves on.
 */
const WATCHDOG_ALARM_NAME = "stockx-runner-watchdog";
const WATCHDOG_PERIOD_MINUTES = 1;

let currentTaskStartedAt = null;
let runLoopStartedAt = null;

function resetInProgressState() {
  isTaskInProgress = false;
  currentTaskStartedAt = null;
}

async function clearCurrentTaskState() {
  resetInProgressState();

  await chrome.storage.local.set({
    currentTask: null,
    currentTaskStartedAt: null
  });
}

async function ensureWatchdog() {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM_NAME);
  if (existing) return;

  await chrome.alarms.create(WATCHDOG_ALARM_NAME, {
    delayInMinutes: WATCHDOG_PERIOD_MINUTES,
    periodInMinutes: WATCHDOG_PERIOD_MINUTES
  });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/*
 * The failure action a page would have reported for this task type.
 *
 * Reporting it on timeout matters for more than bookkeeping: verify and sync
 * tasks are picked by oldest LastSyncAt, so a task that times out without
 * writing anything is handed out again straight away and blocks the queue.
 */
function getTimeoutFailureAction(type) {
  switch (type) {
    case "CALCULATE_STOCKX_LIMITS":
      return "STOCKX_LIMITS_CALCULATION_FAILED";
    case "PLACE_SECOND_BID":
      return "SECOND_BID_FAILED";
    case "REMOVE":
      return "BID_REMOVE_FAILED";
    case "REMOVE_SECOND_BID":
      return "SECOND_BID_REMOVE_FAILED";
    case "VERIFY_BID_STATUS":
    case "VERIFY_SECOND_BID_STATUS":
      return "VERIFY_FAILED";
    case "SYNC_ORDER_STATUS":
      return "ORDER_STATUS_SYNC_FAILED";
    case "SYNC_SECOND_ORDER_STATUS":
      return "SECOND_ORDER_STATUS_SYNC_FAILED";
    default:
      return "BID_UPDATE_FAILED";
  }
}


/*
 * Once a minute the runner tells the backend it is alive, which posts to
 * Discord when the pings stop or the failure streak below gets long. Sent
 * from the loop itself, so a ping only goes out while the loop really runs.
 */
const HEARTBEAT_INTERVAL_MS = 50000;
let lastHeartbeatAt = 0;

// Results that mean the page could not do its job. A logged-out account or a
// captcha turns every task into one of these.
function isFailureAction(action) {
  return /FAILED$/.test(String(action || "")) || action === "NO_FUNDS";
}

async function updateFailureStreak(failed) {
  const { consecutiveFailures = 0 } = await chrome.storage.local.get(["consecutiveFailures"]);
  await chrome.storage.local.set({ consecutiveFailures: failed ? consecutiveFailures + 1 : 0 });
}

async function sendHeartbeat({ force = false, runnerEnabled = true } = {}) {
  if (!force && Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = Date.now();

  const data = await chrome.storage.local.get([
    "lastLoopAt",
    "lastResultAt",
    "lastResultAction",
    "lastErrorAt",
    "lastError",
    "lastTimeoutTask",
    "consecutiveFailures"
  ]);

  try {
    await fetchWithTimeout(`${CONFIG.BACKEND_URL}/runner/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerName: CONFIG.RUNNER_NAME,
        accountGroupKey: CONFIG.ACCOUNT_GROUP_KEY,
        runnerEnabled,
        ...data
      })
    });
  } catch (err) {
    // A missed ping is exactly what the backend watches for; nothing to do here.
    console.warn("Heartbeat failed:", err.message);
  }
}

async function describeRunnerTab() {
  const { runnerTabId } = await chrome.storage.local.get(["runnerTabId"]);
  if (!runnerTabId) return "no runner tab";

  try {
    const tab = await chrome.tabs.get(runnerTabId);
    return `${tab.url || "?"} (${tab.title || "no title"})`;
  } catch {
    return "runner tab closed";
  }
}

async function reportTimedOutTask(task) {
  const data = await chrome.storage.local.get(["pendingInstantOrderMeta"]);
  const instantMeta = data.pendingInstantOrderMeta;
  const where = await describeRunnerTab();

  let payload;

  // The order went through and we have its number; only the price lookup on
  // the orders page did not finish. Reporting a failure here would put the
  // record back in the queue and the next run would buy the pair again.
  if (instantMeta?.orderNumber && instantMeta.recordId === task.recordId) {
    payload = {
      recordId: task.recordId,
      type: task.type,
      action: instantMeta.resultAction || "ORDER_PLACED_WITH_DETAILS",
      orderNumber: instantMeta.orderNumber,
      firstBuyNowPrice: instantMeta.firstBuyNowPrice || null,
      errorMessage: `Runner timeout before final price was read; last page: ${where}`
    };

    await chrome.storage.local.remove(["pendingInstantOrderMeta"]);
  } else {
    payload = {
      recordId: task.recordId,
      type: task.type,
      action: getTimeoutFailureAction(task.type),
      errorMessage: `Runner timeout: page did not report a result within ${TASK_TIMEOUT_MS / 1000}s; last page: ${where}`
    };
  }

  try {
    await submitTaskResult(payload);
  } catch (err) {
    console.error("Could not report timed-out task:", err);
  }
}

async function recoverIfTaskTimedOut() {
  if (!isTaskInProgress) return false;
  if (!currentTaskStartedAt) return false;

  const elapsed = Date.now() - currentTaskStartedAt;
  if (elapsed < TASK_TIMEOUT_MS) return false;

  console.warn("Task timed out, reporting failure and resetting runner state");

  const { currentTask } = await chrome.storage.local.get(["currentTask"]);

  await clearCurrentTaskState();

  if (currentTask?.recordId) {
    await reportTimedOutTask(currentTask);
  }

  await updateFailureStreak(true);

  const { timeoutRecoveries = 0 } = await chrome.storage.local.get(["timeoutRecoveries"]);
  await chrome.storage.local.set({
    timeoutRecoveries: timeoutRecoveries + 1,
    lastTimeoutAt: new Date().toISOString(),
    lastTimeoutTask: currentTask
      ? { recordId: currentTask.recordId, type: currentTask.type }
      : null
  });

  return true;
}

async function recoverIfBrokenTaskState() {
  const data = await chrome.storage.local.get([
    "currentTask",
    "currentTaskStartedAt"
  ]);

  if (data.currentTask && !data.currentTaskStartedAt) {
    console.warn("Broken task state detected, resetting runner state");
    await clearCurrentTaskState();
    return true;
  }

  return false;
}

async function loadState() {
  const data = await chrome.storage.local.get([
    "runnerEnabled",
    "forceStop",
    "currentTaskStartedAt",
    "currentTask"
  ]);

  if (typeof data.runnerEnabled === "boolean") {
    isRunnerEnabled = data.runnerEnabled;
  }

  currentTaskStartedAt =
    typeof data.currentTaskStartedAt === "number"
      ? data.currentTaskStartedAt
      : null;

  isTaskInProgress = !!data.currentTask;
}

async function saveState(forceStop = false) {
  await chrome.storage.local.set({
    runnerEnabled: isRunnerEnabled,
    forceStop
  });
}

async function scheduleNextRun(delayMs) {
  if (!isRunnerEnabled) return;

  const delayMinutes = Math.max(delayMs / 60000, 0.1);

  console.log("⏰ Scheduling next run in", delayMs, "ms");

  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  await chrome.alarms.create(RUNNER_ALARM_NAME, {
    delayInMinutes: delayMinutes
  });
}

async function continueRunnerAfterTaskCompletion() {
  if (!isRunnerEnabled) return;

  // duurzame fallback als de worker toch gesuspend wordt
  await scheduleNextRun(500);

  // probeer meteen door te pakken
  await runLoop();
}

function isImmediateOrderPlacementAction(action) {
  return (
    action === "ORDER_PLACED" ||
    action === "ORDER_PLACED_FALLBACK" ||
    action === "FIRST_ORDER_PLACED" ||
    action === "SECOND_ORDER_PLACED"
  );
}

function isBidResultAction(action) {
  return (
    action === "BID_CREATED" ||
    action === "BID_UPDATED" ||
    action === "SECOND_BID_CREATED" ||
    action === "SECOND_BID_UPDATED" ||
    action === "STOCKX_LIMITS_CALCULATED"
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("📩 Message received:", message.type, message);
  if (message.type === "FETCH_NEXT_TASK") {
    handleSingleTask()
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err.message
        });
      });

    return true;
  }

  if (message.type === "START_RUNNER") {
    startRunner()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (message.type === "STOP_RUNNER") {
    stopRunner()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (message.type === "FORCE_STOP_RUNNER") {
    forceStopRunner()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (message.type === "GET_RUNNER_STATUS") {
    loadState().then(async () => {
      const data = await chrome.storage.local.get([
        "forceStop",
        "lastLoopAt",
        "lastResultAt",
        "lastResultAction",
        "lastErrorAt",
        "lastError",
        "timeoutRecoveries",
        "lastTimeoutAt",
        "lastTimeoutTask"
      ]);
      const watchdog = await chrome.alarms.get(WATCHDOG_ALARM_NAME);

      sendResponse({
        ok: true,
        isRunnerEnabled,
        isTaskInProgress,
        forceStop: data.forceStop === true,
        watchdogActive: !!watchdog,
        lastLoopAt: data.lastLoopAt || null,
        lastResultAt: data.lastResultAt || null,
        lastResultAction: data.lastResultAction || null,
        lastErrorAt: data.lastErrorAt || null,
        lastError: data.lastError || null,
        timeoutRecoveries: data.timeoutRecoveries || 0,
        lastTimeoutAt: data.lastTimeoutAt || null,
        lastTimeoutTask: data.lastTimeoutTask || null
      });
    });

    return true;
  }

  if (message.type === "WAKE_RUNNER") {
    runLoop().catch(async (err) => {
      console.error("WAKE_RUNNER loop error:", err);

      await clearCurrentTaskState();

      if (isRunnerEnabled) {
        await scheduleNextRun(ERROR_RETRY_DELAY_MS);
      }
    });

    sendResponse({ ok: true, message: "Runner wake requested" });
    return true;
  }

  if (message.type === "TASK_COMPLETED") {
    handleTaskCompleted(message.payload)
      .then((response) => sendResponse(response))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }
});

/*
 * A page from an earlier task can still report after that task timed out and
 * the next one started. Its result is real, so it still goes to the backend,
 * but it must not clear the task that is running now.
 */
async function isReportForCurrentTask(payload) {
  if (!payload?.runId) return true;

  const { currentTask } = await chrome.storage.local.get(["currentTask"]);
  return !currentTask || currentTask.runId === payload.runId;
}

async function handleTaskCompleted(payload) {
  if (!(await isReportForCurrentTask(payload))) {
    console.warn("Late result from an earlier task, submitting without touching the current one", {
      recordId: payload.recordId,
      action: payload.action
    });

    const result = await submitTaskResult(payload);
    return { ok: true, result, stale: true };
  }

  await loadState();

  try {
    const result = await submitTaskResult(payload);

    await clearCurrentTaskState();
    await chrome.storage.local.set({
      lastResultAt: new Date().toISOString(),
      lastResultAction: payload?.action || null
    });
    await updateFailureStreak(isFailureAction(payload?.action));

    if (isRunnerEnabled) {
      const action = payload?.action;

      const delay = isImmediateOrderPlacementAction(action)
        ? ORDER_PLACED_NEXT_TASK_DELAY_MS
        : isBidResultAction(action)
          ? BID_RESULT_NEXT_TASK_DELAY_MS
          : 1000;

      await scheduleNextRun(delay);
    }

    return { ok: true, result };
  } catch (err) {
    console.error("Submitting task result failed:", err);

    await clearCurrentTaskState();
    await chrome.storage.local.set({
      lastErrorAt: new Date().toISOString(),
      lastError: `Result submit failed: ${err.message}`
    });

    if (isRunnerEnabled) {
      await scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }

    return { ok: false, error: err.message };
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RUNNER_ALARM_NAME && alarm.name !== WATCHDOG_ALARM_NAME) return;

  console.log(`⏰ Alarm fired (${alarm.name}) → running loop`);

  runLoop().catch(async (err) => {
    console.error("Runner loop error:", err);

    await chrome.storage.local.set({
      lastErrorAt: new Date().toISOString(),
      lastError: err.message
    });

    await clearCurrentTaskState();

    if (isRunnerEnabled) {
      await scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }
  });
});

async function startRunner() {
  isRunnerEnabled = true;

  await chrome.alarms.clear(RUNNER_ALARM_NAME);
  await ensureWatchdog();

  await chrome.storage.local.set({
    currentTask: null,
    currentTaskStartedAt: null,
    forceStop: false,
    consecutiveFailures: 0
  });

  resetInProgressState();

  await saveState(false);

  await scheduleNextRun(500);

  runLoop().catch(async (err) => {
    console.error("Runner loop error after start:", err);
    await clearCurrentTaskState();

    if (isRunnerEnabled) {
      await scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }
  });

  return {
    ok: true,
    message: "Runner started",
    isRunnerEnabled,
    isTaskInProgress,
    forceStop: false
  };
}

async function stopRunner() {
  isRunnerEnabled = false;
  await saveState(false);
  await chrome.alarms.clear(RUNNER_ALARM_NAME);
  await chrome.alarms.clear(WATCHDOG_ALARM_NAME);
  await chrome.storage.local.set({ runnerTabId: null });
  await sendHeartbeat({ force: true, runnerEnabled: false });

  return {
    ok: true,
    message: "Runner will stop after current task",
    isRunnerEnabled,
    isTaskInProgress,
    forceStop: false
  };
}

async function forceStopRunner() {
  isRunnerEnabled = false;
  resetInProgressState();

  await chrome.alarms.clear(RUNNER_ALARM_NAME);
  await chrome.alarms.clear(WATCHDOG_ALARM_NAME);

  await chrome.storage.local.set({
    runnerEnabled: false,
    forceStop: true,
    currentTask: null,
    runnerTabId: null
  });

  await sendHeartbeat({ force: true, runnerEnabled: false });

  const tabs = await chrome.tabs.query({ url: ["*://stockx.com/*"] });

  for (const tab of tabs) {
    if (tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (err) {
        console.warn("Could not close tab", tab.id, err);
      }
    }
  }

  return {
    ok: true,
    message: "Runner force stopped",
    isRunnerEnabled,
    isTaskInProgress,
    forceStop: true
  };
}

async function runLoop() {
  // A loop that hangs on an API call must not lock out every later trigger.
  const isStale =
    runLoopStartedAt !== null && Date.now() - runLoopStartedAt > RUN_LOOP_STALE_MS;

  if (isRunLoopActive && !isStale) {
    console.log("⏳ runLoop already active, skipping duplicate trigger");
    return;
  }

  isRunLoopActive = true;
  runLoopStartedAt = Date.now();

  try {
    console.log("🔄 runLoop triggered");

    await loadState();

    if (!isRunnerEnabled) {
      console.log("⛔ Runner not enabled");
      return;
    }

    await ensureWatchdog();
    await chrome.storage.local.set({ lastLoopAt: new Date().toISOString() });
    await sendHeartbeat();

    await recoverIfBrokenTaskState();
    await recoverIfTaskTimedOut();

    await loadState();

    if (isTaskInProgress) {
      console.log("⏳ Task still in progress, retrying soon...");
      await scheduleNextRun(2000);
      return;
    }

    const result = await handleSingleTask();

    if (!isRunnerEnabled) return;

    if (!result.task) {
      console.log("😴 No task, scheduling next loop");
      await scheduleNextRun(LOOP_DELAY_MS);
      return;
    }
  } finally {
    isRunLoopActive = false;
    runLoopStartedAt = null;
  }
}

async function openOrReuseRunnerTab(url) {
  const data = await chrome.storage.local.get(["runnerTabId"]);
  const existingTabId = data.runnerTabId;

  if (existingTabId) {
    try {
      const existingTab = await chrome.tabs.get(existingTabId);

      if (existingTab?.id) {
        const updatedTab = await chrome.tabs.update(existingTab.id, {
          url,
          active: true
        });

        return updatedTab;
      }
    } catch (err) {
      console.warn("Stored runner tab no longer exists, creating new one");
    }
  }

  const newTab = await chrome.tabs.create({
    url,
    active: true
  });

  if (newTab?.id) {
    await chrome.storage.local.set({ runnerTabId: newTab.id });
  }

  return newTab;
}

async function handleSingleTask() {
  if (isTaskInProgress) {
    return {
      ok: true,
      message: "Task already in progress"
    };
  }

  const taskData = await fetchNextTask();

  await loadState();

  const stopData = await chrome.storage.local.get(["forceStop"]);

  if (!isRunnerEnabled || stopData.forceStop === true) {
    console.log("🛑 Runner stopped after fetchNextTask; aborting task open");
    await clearCurrentTaskState();

    return {
      ok: true,
      message: "Runner stopped after fetch",
      task: null
    };
  }

  if (!taskData.task) {
    return {
      ok: true,
      message: "No task available",
      task: null
    };
  }

  // runId lets a late report from an earlier page be told apart from this one.
  const task = { ...taskData.task, runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };

  isTaskInProgress = true;
  currentTaskStartedAt = Date.now();

  await chrome.storage.local.set({
    currentTask: task,
    forceStop: false,
    currentTaskStartedAt
  });

  const url = buildStockXUrl(task);

  const tab = await openOrReuseRunnerTab(url);

  return {
    ok: true,
    task,
    openedUrl: url,
    tabId: tab.id
  };
}

async function fetchNextTask() {
  const res = await fetchWithTimeout(`${CONFIG.BACKEND_URL}/tasks/next`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      runnerName: CONFIG.RUNNER_NAME,
      accountGroupKey: CONFIG.ACCOUNT_GROUP_KEY,
      minOrderDate: CONFIG.MIN_ORDER_DATE || null
    })
  });

  const data = await res.json();

  console.log("📦 fetchNextTask response:", {
    runnerName: CONFIG.RUNNER_NAME,
    accountGroupKey: CONFIG.ACCOUNT_GROUP_KEY,
    data
  });
  
  if (!data.ok) {
    throw new Error(data.error || "Backend error");
  }
  
  return data;
}

const SUBMIT_RETRY_DELAYS_MS = [3000, 10000];

/*
 * A result that does not reach Airtable is worse than a slow one: a placed
 * bid or order would be done again once the record leaves BID_IN_PROGRESS.
 * So a failed submit (Render restarting, Airtable 429) is retried before
 * giving up. The backend only PATCHes the record, so a repeat is harmless.
 */
async function submitTaskResult(payload) {
  let lastError;

  for (let attempt = 0; attempt <= SUBMIT_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_RETRY_DELAYS_MS[attempt - 1]));
    }

    try {
      const res = await fetchWithTimeout(`${CONFIG.BACKEND_URL}/tasks/${payload.recordId}/result`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();

      if (!data.ok) {
        throw new Error(data.error || "Failed to submit task result");
      }

      return data;
    } catch (err) {
      lastError = err;
      console.warn(`Submit attempt ${attempt + 1} failed:`, err.message);

      // The backend answered and refused this result; asking again won't change that.
      if (/Unknown task result type/.test(err.message)) break;
    }
  }

  throw lastError;
}

function buildStockXUrl(task) {
  // VERIFY flows → direct naar bids page
  if (
    task.type === "VERIFY_BID_STATUS" ||
    task.type === "VERIFY_SECOND_BID_STATUS"
  ) {
    return "https://stockx.com/buying/bids";
  }

  // ORDER SYNC flows → direct naar orders page
  if (
    task.type === "SYNC_ORDER_STATUS" ||
    task.type === "SYNC_SECOND_ORDER_STATUS"
  ) {
    return "https://stockx.com/buying/orders";
  }

  if (task.stockxUrl) {
    const url = new URL(task.stockxUrl);
    let slug = url.pathname.replace(/^\/+/, "");

    if (!slug) {
      return task.stockxUrl;
    }

    if (
      task.type === "PLACE_OR_UPDATE" ||
      task.type === "PLACE_SECOND_BID" ||
      task.type === "CALCULATE_STOCKX_LIMITS"
    ) {
      return `https://stockx.com/buy/${slug}?defaultBid=true`;
    }

    if (task.type === "PLACE_OR_BUY_WITH_SECOND_BID_CHECK") {
      return `https://stockx.com/buy/${slug}`;
    }

    return `https://stockx.com/${slug}`;
  }

  const sku = task.sku;
  return `https://stockx.com/search?s=${sku}`;
}

// Runs on every worker start, including the first one after Chrome restarts.
loadState().then(async () => {
  console.log("🔄 Worker booted");

  if (isRunnerEnabled) {
    console.log("🔄 Restoring runner loop after reload");

    await ensureWatchdog();
    await scheduleNextRun(1000);

    try {
      await runLoop();
    } catch (err) {
      console.error("Runner loop error after worker boot:", err);
      await clearCurrentTaskState();
      await scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }
  }
});
