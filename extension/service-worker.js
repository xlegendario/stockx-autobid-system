import { CONFIG } from "./config.js";

let isRunnerEnabled = false;
let isTaskInProgress = false;

const LOOP_DELAY_MS = 8000;
const ERROR_RETRY_DELAY_MS = 15000;
const ORDER_PLACED_NEXT_TASK_DELAY_MS = 8000;
const TASK_TIMEOUT_MS = 120000; // 2 minuten
const RUNNER_ALARM_NAME = "stockx-runner-loop";

let currentTaskStartedAt = null;

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

async function recoverIfTaskTimedOut() {
  if (!isTaskInProgress) return false;
  if (!currentTaskStartedAt) return false;

  const elapsed = Date.now() - currentTaskStartedAt;
  if (elapsed < TASK_TIMEOUT_MS) return false;

  console.warn("Task timed out, resetting runner state");

  await clearCurrentTaskState();

  return true;
}

async function loadState() {
  const data = await chrome.storage.local.get([
    "runnerEnabled",
    "forceStop",
    "currentTaskStartedAt"
  ]);

  isRunnerEnabled = data.runnerEnabled === true;
  currentTaskStartedAt =
    typeof data.currentTaskStartedAt === "number"
      ? data.currentTaskStartedAt
      : null;
}

chrome.storage.local.get(["currentTask"]).then((data) => {
  if (data.currentTask) {
    isTaskInProgress = true;
  }
});

async function saveState(forceStop = false) {
  await chrome.storage.local.set({
    runnerEnabled: isRunnerEnabled,
    forceStop
  });
}

async function scheduleNextRun(delayMs) {
  if (!isRunnerEnabled) return;

  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  const delayMinutes = Math.max(delayMs / 60000, 0.1);

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
  return action === "ORDER_PLACED" || action === "ORDER_PLACED_FALLBACK";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    chrome.storage.local.get(["forceStop"]).then((data) => {
      sendResponse({
        ok: true,
        isRunnerEnabled,
        isTaskInProgress,
        forceStop: data.forceStop === true
      });
    });

    return true;
  }

  if (message.type === "TASK_COMPLETED") {
    submitTaskResult(message.payload)
      .then(async (result) => {
        await clearCurrentTaskState();

        if (isRunnerEnabled) {
          try {
            await continueRunnerAfterTaskCompletion();

            if (isImmediateOrderPlacementAction(message.payload?.action)) {
              await scheduleNextRun(ORDER_PLACED_NEXT_TASK_DELAY_MS);
            } else {
              await continueRunnerAfterTaskCompletion();
            }
          } catch (err) {
            console.error("Runner loop error after success:", err);
            await clearCurrentTaskState();

            if (isRunnerEnabled) {
              await scheduleNextRun(ERROR_RETRY_DELAY_MS);
            }
          }
        }

        sendResponse({ ok: true, result });
      })
      .catch(async (err) => {
        await clearCurrentTaskState();

        if (isRunnerEnabled) {
          await scheduleNextRun(ERROR_RETRY_DELAY_MS);
        }

        sendResponse({ ok: false, error: err.message });
      });

    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RUNNER_ALARM_NAME) return;

  runLoop().catch(async (err) => {
    console.error("Runner loop error:", err);

    await clearCurrentTaskState();

    if (isRunnerEnabled) {
      await scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }
  });
});

async function startRunner() {
  isRunnerEnabled = true;
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
  await chrome.storage.local.set({ runnerTabId: null });

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

  await chrome.storage.local.set({
    runnerEnabled: false,
    forceStop: true,
    currentTask: null,
    runnerTabId: null
  });

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
  if (!isRunnerEnabled) return;

  await recoverIfTaskTimedOut();

  if (isTaskInProgress) return;

  const result = await handleSingleTask();

  if (!isRunnerEnabled) return;

  if (!result.task) {
    scheduleNextRun(LOOP_DELAY_MS);
    return;
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

  if (!taskData.task) {
    return {
      ok: true,
      message: "No task available",
      task: null
    };
  }

  const task = taskData.task;

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
  const res = await fetch(`${CONFIG.BACKEND_URL}/tasks/next`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      runnerName: CONFIG.RUNNER_NAME,
      accountGroupKey: CONFIG.ACCOUNT_GROUP_KEY
    })
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(data.error || "Backend error");
  }

  return data;
}

async function submitTaskResult(payload) {
  const res = await fetch(`${CONFIG.BACKEND_URL}/tasks/${payload.recordId}/result`, {
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
}

function buildStockXUrl(task) {
  // VERIFY flow → direct naar bids page
  if (task.type === "VERIFY_BID_STATUS") {
    return "https://stockx.com/buying/bids";
  }

  if (task.type === "SYNC_ORDER_STATUS") {
    return "https://stockx.com/buying/orders";
  }

  if (task.stockxUrl) {
    const url = new URL(task.stockxUrl);
    let slug = url.pathname.replace(/^\/+/, "");

    if (!slug) {
      return task.stockxUrl;
    }

    // PLACE flow → direct naar buy page
    if (task.type === "PLACE_OR_UPDATE") {
      return `https://stockx.com/buy/${slug}?defaultBid=true`;
    }

    // REMOVE flow → normale productpagina
    return `https://stockx.com/${slug}`;
  }

  // fallback
  const sku = task.sku;
  return `https://stockx.com/search?s=${sku}`;
}

loadState().then(() => {
  if (isRunnerEnabled) {
    console.log("🔄 Restoring runner loop after reload");

    scheduleNextRun(1000);

    runLoop().catch(async (err) => {
      console.error("Runner loop error after restore:", err);
      await clearCurrentTaskState();

      if (isRunnerEnabled) {
        await scheduleNextRun(ERROR_RETRY_DELAY_MS);
      }
    });
  }
});
