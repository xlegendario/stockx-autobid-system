console.log("StockX Autobid content script loaded");

let currentTask = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "NEW_TASK") {
    currentTask = message.task;
    console.log("Received task:", currentTask);

    chrome.storage.local.set({ currentTask });
  }
});

window.addEventListener("load", async () => {
  console.log("Page loaded:", window.location.href);

  const stored = await chrome.storage.local.get("currentTask");
  currentTask = stored.currentTask || null;

  if (!currentTask) {
    console.log("No currentTask in storage");
    return;
  }

  if (window.location.pathname.includes("/buy/")) {
    setTimeout(() => {
      handleBuyPage();
    }, 1500);
    return;
  }

  setTimeout(() => {
    handleTask();
  }, 2000);
});

function handleTask() {
  if (!currentTask) return;

  if (currentTask.type !== "PLACE_OR_UPDATE") {
    console.log("Not a PLACE_OR_UPDATE task, skipping placement flow");
    return;
  }

  console.log("Handling task:", currentTask);
  openSizeDropdownAndSelect(currentTask.size);
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(",", ".");
}

function openSizeDropdownAndSelect(targetSize) {
  console.log("Trying to open size dropdown for:", targetSize);

  const buttons = Array.from(document.querySelectorAll("button"));

  const dropdownButton = buttons.find((btn) => {
    const text = normalizeText(btn.innerText);
    return text.includes("eu ") || text === "size:" || text.includes("size");
  });

  if (!dropdownButton) {
    console.log("Size dropdown not found yet, retrying...");
    setTimeout(() => openSizeDropdownAndSelect(targetSize), 1000);
    return;
  }

  const currentText = normalizeText(dropdownButton.innerText);
  const normalizedTarget = normalizeText(targetSize);

  if (
    currentText === normalizedTarget ||
    currentText === `eu ${normalizedTarget}` ||
    currentText.includes(`eu ${normalizedTarget}`)
  ) {
    console.log("Size already selected:", dropdownButton.innerText);

    setTimeout(() => {
      goToOfferPage(targetSize);
    }, 800);

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

  setTimeout(() => {
    goToOfferPage(targetSize);
  }, 1200);
}

function goToOfferPage(size) {
  const currentUrl = new URL(window.location.href);
  const slug = currentUrl.pathname.replace(/^\/+/, "");

  if (!slug) {
    console.log("Could not determine product slug from URL");
    return;
  }

  const offerUrl = `https://stockx.com/buy/${slug}?defaultBid=true&size=${encodeURIComponent(String(size).trim())}`;

  console.log("🔥 Navigating directly to offer page:", offerUrl);
  window.location.href = offerUrl;
}

function handleBuyPage(attempt = 0) {
  if (!currentTask) {
    console.log("No currentTask available on buy page");
    return;
  }

  if (currentTask.type !== "PLACE_OR_UPDATE") {
    console.log("Buy page skipped: not a PLACE_OR_UPDATE task");
    return;
  }

  // If we're already on the price form, skip size tile selection
  const priceInput = findBidInput();
  if (priceInput) {
    console.log("Bid input screen detected directly");
    setTimeout(() => fillBidPrice(), 800);
    return;
  }

  if (attempt > 20) {
    console.log("BUY page size not found after multiple attempts");
    return;
  }

  console.log("📍 On BUY page, selecting size again...");

  const targetSize = normalizeText(currentTask.size);

  const candidates = Array.from(
    document.querySelectorAll("button, [role='button'], li, span, p, div")
  ).filter((el) => {
    const text = normalizeText(el.innerText);
    if (!text) return false;
    if (text.length > 20) return false;

    return text === `eu ${targetSize}` || text === targetSize;
  });

  if (candidates.length === 0) {
    console.log("Buy page size not found yet, retrying...");
    setTimeout(() => handleBuyPage(attempt + 1), 800);
    return;
  }

  const match = candidates[0];

  console.log("🔥 Clicking BUY page size:", match.innerText);
  match.click();

  setTimeout(() => {
    fillBidPrice();
  }, 1500);
}

function findBidInput() {
  const inputs = Array.from(document.querySelectorAll("input"));

  return inputs.find((input) => {
    const type = (input.getAttribute("type") || "").toLowerCase();
    const inputMode = (input.getAttribute("inputmode") || "").toLowerCase();
    const value = input.value || "";

    return (
      type === "text" ||
      type === "number" ||
      inputMode === "numeric" ||
      inputMode === "decimal" ||
      value.length > 0
    );
  });
}

function formatBidValue(value) {
  if (value === null || value === undefined || value === "") return "";

  const num = Number(value);
  if (!Number.isFinite(num)) return "";

  // veilige optie: nooit boven maxBid gaan
  return String(Math.floor(num));
}

function fillBidPrice(attempt = 0) {
  if (!currentTask) {
    console.log("No currentTask for fillBidPrice");
    return;
  }

  if (attempt > 15) {
    console.log("Could not find bid input after multiple attempts");
    return;
  }

  const input = findBidInput();

  if (!input) {
    console.log("Bid input not found yet, retrying...");
    setTimeout(() => fillBidPrice(attempt + 1), 800);
    return;
  }

  const bidValue = formatBidValue(currentTask.maxBid);

  if (!bidValue) {
    console.log("No valid maxBid available on task");
    return;
  }

  console.log("🔥 Filling bid price:", bidValue);

  input.focus();

  // clear
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  // React-safe setter
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, bidValue);
  } else {
    input.value = bidValue;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));

  // Sometimes StockX needs a second pass
  setTimeout(() => {
    const currentVal = String(input.value || "").trim();
    console.log("Input value after fill attempt:", currentVal);

    // if not accepted properly, try once more
    if (!currentVal || currentVal === "0") {
      console.log("Input still empty/invalid, retrying fill...");

      input.focus();

      if (nativeSetter) {
        nativeSetter.call(input, bidValue);
      } else {
        input.value = bidValue;
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    waitForReviewBidEnabled();
  }, 1200);
}

function waitForReviewBidEnabled(attempt = 0) {
  if (attempt > 15) {
    console.log("Review Bid never became enabled");
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const btn = buttons.find((b) => {
    const text = (b.innerText || "").trim().toLowerCase();
    return text.includes("review bid");
  });

  if (!btn) {
    console.log("Review Bid button not found yet, retrying...");
    setTimeout(() => waitForReviewBidEnabled(attempt + 1), 1000);
    return;
  }

  const isDisabled =
    btn.disabled ||
    btn.getAttribute("aria-disabled") === "true" ||
    btn.innerText.trim() === "";

  if (isDisabled) {
    console.log("Review Bid still disabled, waiting...");
    setTimeout(() => waitForReviewBidEnabled(attempt + 1), 1000);
    return;
  }

  console.log("✅ Review Bid enabled");
  clickReviewBid();
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

function clickReviewBid(attempt = 0) {
  if (attempt > 15) {
    console.log("Review Bid button not found after multiple attempts");
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const btn = buttons.find((b) => {
    const text = (b.innerText || "").trim().toLowerCase();
    return text.includes("review bid");
  });

  if (!btn) {
    console.log("Review Bid button not found yet, retrying...");
    setTimeout(() => clickReviewBid(attempt + 1), 1000);
    return;
  }

  console.log("🔥 Clicking Review Bid");
  btn.click();

  // wacht op confirm scherm en klik dan Confirm Bid
  setTimeout(() => {
    clickConfirmBid();
  }, 2500);
}

function clickConfirmBid(attempt = 0) {
  if (attempt > 20) {
    console.log("Confirm Bid button not found/enabled after multiple attempts");
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const btn = buttons.find((b) => {
    const text = (b.innerText || "").trim().toLowerCase();
    return text.includes("confirm bid");
  });

  if (!btn) {
    console.log("Confirm Bid button not found yet, retrying...");
    setTimeout(() => clickConfirmBid(attempt + 1), 1000);
    return;
  }

  const isDisabled =
    btn.disabled ||
    btn.getAttribute("aria-disabled") === "true";

  if (isDisabled) {
    console.log("Confirm Bid still disabled, waiting...");
    setTimeout(() => clickConfirmBid(attempt + 1), 1000);
    return;
  }

  console.log("🔥 Clicking Confirm Bid");
  clickElement(btn);

  setTimeout(() => {
    reportTaskSuccess();
  }, 2500);
}

function reportTaskSuccess() {
  if (!currentTask) {
    console.log("No currentTask available to report success");
    return;
  }

  const submittedBid = Number(formatBidValue(currentTask.maxBid));

  const payload = {
    recordId: currentTask.recordId,
    type: currentTask.type,
    maxBid: submittedBid,
    action: "BID_CREATED"
  };

  console.log("✅ Reporting task success:", payload);

  chrome.runtime.sendMessage(
    {
      type: "TASK_COMPLETED",
      payload
    },
    (response) => {
      console.log("Backend result response:", response);
    }
  );
}
