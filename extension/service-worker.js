import { CONFIG } from "./config.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_NEXT_TASK") {
    handleTask()
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err.message
        });
      });

    return true;
  }
});

async function handleTask() {
  const taskData = await fetchNextTask();

  if (!taskData.task) {
    return {
      ok: true,
      message: "No task available"
    };
  }

  const task = taskData.task;

  // Save task so the content script can read it after page navigation
  await chrome.storage.local.set({ currentTask: task });

  const url = buildStockXUrl(task);

  await chrome.tabs.create({
    url
  });

  return {
    ok: true,
    task,
    openedUrl: url
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

function buildStockXUrl(task) {
  if (task.stockxUrl) {
    return task.stockxUrl;
  }

  const sku = task.sku;
  return `https://stockx.com/search?s=${sku}`;
}
