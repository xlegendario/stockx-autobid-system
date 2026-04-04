console.log("StockX Autobid content script loaded");

let currentTask = null;

// 🔥 Luister naar task van service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "NEW_TASK") {
    currentTask = message.task;
    console.log("Received task:", currentTask);

    setTimeout(() => {
      handleTask();
    }, 2000); // kleine delay zodat page volledig geladen is
  }
});

window.addEventListener("load", () => {
  console.log("Page loaded:", window.location.href);
});

function handleTask() {
  if (!currentTask) return;

  console.log("Handling task:", currentTask);

  selectSize(currentTask.size);
}

function selectSize(targetSize) {
  console.log("Trying to select size:", targetSize);

  const buttons = document.querySelectorAll("button");

  let found = false;

  buttons.forEach((btn) => {
    const text = btn.innerText.trim();

    if (!text) return;

    // match EU sizes (StockX format)
    if (text.includes(targetSize)) {
      console.log("Clicking size button:", text);
      btn.click();
      found = true;
    }
  });

  if (!found) {
    console.log("Size not found yet, retrying...");
    setTimeout(() => selectSize(targetSize), 1000);
  }
}
