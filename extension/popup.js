document.getElementById("fetchTask").addEventListener("click", async () => {
  const status = document.getElementById("status");
  status.textContent = "Fetching task...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "FETCH_NEXT_TASK" });

    status.textContent = JSON.stringify(response, null, 2);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
  }
});
