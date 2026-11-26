function showIdentity(response) {
  const box = document.getElementById("identity");
  const current = document.getElementById("currentRunner");
  const select = document.getElementById("runnerSelect");
  const profiles = response?.runnerProfiles || [];

  if (!select.options.length) {
    select.add(new Option("— choose —", ""));
    for (const profile of profiles) select.add(new Option(profile.label, profile.key));
  }

  const chosen = profiles.find((profile) => profile.key === response?.runnerProfileKey);
  current.textContent = chosen ? chosen.label : "not chosen yet";
  box.classList.toggle("missing", !chosen);
  select.value = chosen ? chosen.key : "";
}

async function updateStatus() {
  const statusEl = document.getElementById("status");

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_RUNNER_STATUS" });
    showIdentity(response);
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

document.getElementById("saveRunner").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  const key = document.getElementById("runnerSelect").value;
  if (!key) {
    statusEl.textContent = "Choose a runner first";
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "SET_RUNNER_PROFILE", key });
    if (!response?.ok) {
      statusEl.textContent = `Error: ${response?.error || "could not save"}`;
      return;
    }
    await updateStatus();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

updateStatus();
