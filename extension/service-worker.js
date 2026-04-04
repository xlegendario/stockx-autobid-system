import { CONFIG } from "./config.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_NEXT_TASK") {
    fetchNextTask()
      .then((task) => sendResponse(task))
      .catch((err) => {
        sendResponse({
          ok: false,
          error: err.message
        });
      });

    return true;
  }
});

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
    throw new Error(data.error || "Unknown backend error");
  }

  return data;
}
