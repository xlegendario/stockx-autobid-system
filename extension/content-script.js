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
  openDropdownThenSelect(currentTask.size, 0);
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(",", ".");
}

function clickElement(el) {
  if (!el) return false;

  el.scrollIntoView({ block: "center", inline: "center" });

  ["pointerdown", "mousedown", "mouseup", "click"].forEach((eventName) => {
    el.dispatchEvent(
      new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
  });

  return true;
}

function getClickableAncestor(el) {
  let node = el;
  let depth = 0;

  while (node && depth < 5) {
    if (
      node.tagName === "BUTTON" ||
      node.getAttribute?.("role") === "button" ||
      node.getAttribute?.("role") === "option" ||
      typeof node.onclick === "function"
    ) {
      return node;
    }

    node = node.parentElement;
    depth++;
  }

  return el;
}

function findSizeDropdownControl() {
  // Eerst expliciet zoeken naar het huidige size-control element
  const candidates = Array.from(
    document.querySelectorAll('button, div, span, [role="button"]')
  );

  // Zoek naar iets dat "all" of "eu ..." toont
  const direct = candidates.find((el) => {
    const text = normalizeText(el.innerText);
    return text === "all" || text.startsWith("eu ");
  });

  if (direct) {
    return getClickableAncestor(direct);
  }

  // Fallback: zoek iets rondom "Size:"
  const sizeLabel = candidates.find((el) => normalizeText(el.innerText) === "size:");
  if (sizeLabel) {
    const parent = sizeLabel.parentElement;
    if (parent) {
      const clickableInside = parent.querySelector('button, [role="button"], div');
      if (clickableInside) return getClickableAncestor(clickableInside);
      return getClickableAncestor(parent);
    }
  }

  return null;
}

function openDropdownThenSelect(targetSize, attempt = 0) {
  if (attempt > 10) {
    console.log("Failed to open size dropdown after multiple attempts");
    return;
  }

  const dropdown = findSizeDropdownControl();

  if (!dropdown) {
    console.log("Size dropdown control not found, retrying...", attempt);
    setTimeout(() => openDropdownThenSelect(targetSize, attempt + 1), 1000);
    return;
  }

  console.log("Clicking size dropdown control:", dropdown.innerText || dropdown.outerHTML);
  clickElement(dropdown);

  setTimeout(() => {
    selectSizeOption(targetSize, 0);
  }, 1200);
}

function selectSizeOption(targetSize, attempt = 0) {
  if (attempt > 15) {
    console.log("Failed to find size option after multiple attempts");
    return;
  }

  const normalizedTarget = normalizeText(targetSize);

  const candidates = Array.from(
    document.querySelectorAll(
      'button, div, span, li, p, [role="option"], [role="button"], [role="menuitem"]'
    )
  );

  const match = candidates.find((el) => {
    const text = normalizeText(el.innerText);

    return (
      text === normalizedTarget ||
      text === `eu ${normalizedTarget}` ||
      text.includes(`eu ${normalizedTarget}`) ||
      text === `${normalizedTarget} eu`
    );
  });

  if (!match) {
    console.log("Size option not found yet, retrying...", normalizedTarget, "attempt", attempt);
    setTimeout(() => selectSizeOption(targetSize, attempt + 1), 800);
    return;
  }

  const clickable = getClickableAncestor(match);

  console.log("Clicking size option:", match.innerText);
  clickElement(clickable);
}
