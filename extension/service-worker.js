import { CONFIG } from "./config.js";

let isRunnerEnabled = false;
let isTaskInProgress = false;

const LOOP_DELAY_MS = 8000;
const NEXT_TASK_DELAY_AFTER_SUCCESS_MS = 5000;
const ERROR_RETRY_DELAY_MS = 15000;
const RUNNER_ALARM_NAME = "stockx-runner-loop";

async function loadState() {
  const data = await chrome.storage.local.get(["runnerEnabled", "forceStop"]);
  isRunnerEnabled = data.runnerEnabled === true;
}

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
      .then((result) => {
        isTaskInProgress = false;

        if (isRunnerEnabled) {
          scheduleNextRun(NEXT_TASK_DELAY_AFTER_SUCCESS_MS);
        }

        sendResponse({ ok: true, result });
      })
      .catch((err) => {
        isTaskInProgress = false;

        if (isRunnerEnabled) {
          scheduleNextRun(ERROR_RETRY_DELAY_MS);
        }

        sendResponse({ ok: false, error: err.message });
      });

    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RUNNER_ALARM_NAME) return;
  
  runLoop().catch((err) => {
    console.error("Runner loop error:", err);
  
    isTaskInProgress = false;
  
    if (isRunnerEnabled) {
      scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }
  });
});

async function startRunner() {
  isRunnerEnabled = true;
  await saveState(false);

  await scheduleNextRun(500);

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
  isTaskInProgress = false;

  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  await chrome.storage.local.set({
    runnerEnabled: false,
    forceStop: true,
    currentTask: null
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
  if (isTaskInProgress) return;

  const result = await handleSingleTask();

  if (!isRunnerEnabled) return;

  if (!result.task) {
    scheduleNextRun(LOOP_DELAY_MS);
    return;
  }
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

  await chrome.storage.local.set({
    currentTask: task,
    forceStop: false
  });

  const url = buildStockXUrl(task);

  const tab = await chrome.tabs.create({
    url
  });

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
  if (task.stockxUrl) {
    // extract slug uit bestaande URL
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
  }
});
