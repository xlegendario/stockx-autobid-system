import { CONFIG } from "./config.js";

let isRunnerEnabled = false;
let isTaskInProgress = false;
let loopTimeout = null;

async function loadState() {
  const data = await chrome.storage.local.get(["runnerEnabled"]);
  isRunnerEnabled = data.runnerEnabled === true;
}

async function saveState() {
  await chrome.storage.local.set({
    runnerEnabled: isRunnerEnabled,
    forceStop: !isRunnerEnabled
  });
}

const LOOP_DELAY_MS = 8000;
const NEXT_TASK_DELAY_AFTER_SUCCESS_MS = 5000;
const ERROR_RETRY_DELAY_MS = 15000;

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
      .then(() => {
        sendResponse({
          ok: true,
          isRunnerEnabled,
          isTaskInProgress
        });
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err.message
        });
      });
  
    return true;
  }

  if (message.type === "GET_RUNNER_STATUS") {
    sendResponse({
      ok: true,
      isRunnerEnabled,
      isTaskInProgress
    });
    return false;
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

async function startRunner() {
  isRunnerEnabled = true;
  await chrome.storage.local.set({
    runnerEnabled: true,
    forceStop: false
  });

  scheduleNextRun(500);

  return {
    ok: true,
    message: "Runner started",
    isRunnerEnabled,
    isTaskInProgress
  };
}

async function stopRunner() {
  isRunnerEnabled = false;

  if (loopTimeout) {
    clearTimeout(loopTimeout);
    loopTimeout = null;
  }

  await chrome.storage.local.set({
    runnerEnabled: false,
    forceStop: true,
    currentTask: null
  });
}

function scheduleNextRun(delayMs) {
  if (!isRunnerEnabled) return;

  if (loopTimeout) {
    clearTimeout(loopTimeout);
    loopTimeout = null;
  }

  loopTimeout = setTimeout(() => {
    runLoop().catch((err) => {
      console.error("Runner loop error:", err);

      isTaskInProgress = false;

      if (isRunnerEnabled) {
        scheduleNextRun(ERROR_RETRY_DELAY_MS);
      }
    });
  }, delayMs);
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

  // if task exists, content script will finish it
  // and TASK_COMPLETED will schedule the next run
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

  await chrome.storage.local.set({ currentTask: task });

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
      runnerName: CONFIG.RUNNER_NAME
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
    return task.stockxUrl;
  }

  const sku = task.sku;
  return `https://stockx.com/search?s=${sku}`;
}

loadState().then(() => {
  if (isRunnerEnabled) {
    console.log("🔄 Restoring runner loop after reload");
    scheduleNextRun(1000);
  }
});
