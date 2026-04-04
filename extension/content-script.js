console.log("StockX Autobid content script loaded");

let currentTask = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "NEW_TASK") {
    currentTask = message.task;
    console.log("Received task:", currentTask);

    setTimeout(() => {
      handleTask();
    }, 2000);
  }
});

window.addEventListener("load", () => {
  console.log("Page loaded:", window.location.href);
});

function handleTask() {
  if (!currentTask) return;

  console.log("Handling task:", currentTask);

  openSizeDropdownAndSelect(currentTask.size);
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(",", ".");
}

function openSizeDropdownAndSelect(targetSize) {
  console.log("Checking current selected size...");

  const normalizedTarget = normalizeText(targetSize);

  const candidates = Array.from(
    document.querySelectorAll("button, div")
  );

  const dropdownButton = candidates.find((el) => {
    const text = normalizeText(el.innerText);
    return (
      text === "all" ||
      text === "size:" ||
      text.includes("size") ||
      text.includes("eu ")
    );
  });

  if (!dropdownButton) {
    console.log("Size dropdown not found yet, retrying...");
    setTimeout(() => openSizeDropdownAndSelect(targetSize), 1000);
    return;
  }

  const currentText = normalizeText(dropdownButton.innerText);

  if (
    currentText === normalizedTarget ||
    currentText === `eu ${normalizedTarget}` ||
    currentText.includes(`eu ${normalizedTarget}`)
  ) {
    console.log("Size already selected:", currentText);
    return;
  }

  console.log("Clicking size dropdown:", dropdownButton.innerText);
  dropdownButton.click();

  setTimeout(() => {
    selectSizeFromDropdown(targetSize);
  }, 1000);
}
function selectSizeFromDropdown(targetSize) {
  const normalizedTarget = normalizeText(targetSize);
  console.log("Trying to select size from dropdown:", normalizedTarget);

  const allButtons = Array.from(document.querySelectorAll("button"));
  const allDivs = Array.from(document.querySelectorAll("div"));
  const allSpans = Array.from(document.querySelectorAll("span"));

  const candidates = [...allButtons, ...allDivs, ...allSpans];

  const match = candidates.find((el) => {
    const text = normalizeText(el.innerText);
    return (
      text === normalizedTarget ||
      text === `eu ${normalizedTarget}` ||
      text.includes(`eu ${normalizedTarget}`)
    );
  });

  if (!match) {
    console.log("Size option not found yet, retrying...");
    setTimeout(() => selectSizeFromDropdown(targetSize), 1000);
    return;
  }

  console.log("Clicking size option:", match.innerText);
  match.click();
}
