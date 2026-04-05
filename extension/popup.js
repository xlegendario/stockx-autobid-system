async function updateStatus() {
  const statusEl = document.getElementById("status");

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_RUNNER_STATUS" });
    statusEl.textContent = JSON.stringify(response, null, 2);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

document.getElementById("startRunner").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "Starting runner...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "START_RUNNER" });
    statusEl.textContent = JSON.stringify(response, null, 2);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

document.getElementById("stopRunner").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "Stopping runner after current task...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "STOP_RUNNER" });
    statusEl.textContent = JSON.stringify(response, null, 2);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

document.getElementById("forceStopRunner").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "Force stopping runner...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "FORCE_STOP_RUNNER" });
    statusEl.textContent = JSON.stringify(response, null, 2);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

document.getElementById("fetchTask").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "Fetching one task...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "FETCH_NEXT_TASK" });
    statusEl.textContent = JSON.stringify(response, null, 2);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

updateStatus();
