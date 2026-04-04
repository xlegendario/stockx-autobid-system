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

  // Alleen direct naar price form als er OOK een Review Bid knop zichtbaar is
  const priceInput = findBidInput();
  const hasReviewBidButton = Array.from(document.querySelectorAll("button")).some((btn) =>
    (btn.innerText || "").trim().toLowerCase().includes("review bid")
  );

  if (priceInput && hasReviewBidButton) {
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
    const placeholder = (input.getAttribute("placeholder") || "").toLowerCase();
    const ariaLabel = (input.getAttribute("aria-label") || "").toLowerCase();

    const rect = input.getBoundingClientRect();
    const isVisible =
      rect.width > 0 &&
      rect.height > 0 &&
      window.getComputedStyle(input).visibility !== "hidden" &&
      window.getComputedStyle(input).display !== "none";

    if (!isVisible) return false;

    const looksNumeric =
      type === "number" ||
      inputMode === "numeric" ||
      inputMode === "decimal";

    const looksLikeBidField =
      placeholder.includes("price") ||
      placeholder.includes("bid") ||
      ariaLabel.includes("price") ||
      ariaLabel.includes("bid");

    return looksNumeric || looksLikeBidField;
  });
}

function formatBidValue(value) {
  if (value === null || value === undefined || value === "") return "";

  const num = Number(value);
  if (!Number.isFinite(num)) return "";

  // veilige optie: nooit boven maxBid gaan
  return String(Math.floor(num));
}

function normalizeNumericString(value) {
  return String(value || "")
    .replace(/[^\d.,]/g, "")
    .replace(",", ".")
    .trim();
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

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  // clear first
  if (nativeSetter) {
    nativeSetter.call(input, "");
  } else {
    input.value = "";
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));

  // fill desired bid
  if (nativeSetter) {
    nativeSetter.call(input, bidValue);
  } else {
    input.value = bidValue;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));

  setTimeout(() => {
    const currentVal = normalizeNumericString(input.value);
    const expectedVal = normalizeNumericString(bidValue);

    console.log("Input value after fill attempt:", currentVal);
    console.log("Expected bid value:", expectedVal);

    if (currentVal !== expectedVal) {
      console.log("❌ Bid value mismatch, retrying fill...");
      setTimeout(() => fillBidPrice(attempt + 1), 1000);
      return;
    }

    console.log("✅ Bid input matches expected value");
    waitForReviewBidEnabled();
  }, 1200);
}

function waitForReviewBidEnabled(attempt = 0) {
  if (attempt > 15) {
    console.log("Review button never became enabled");
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const btn = buttons.find((b) => {
    const text = (b.innerText || "").trim().toLowerCase();
    return text.includes("review bid") || text.includes("review order");
  });

  if (!btn) {
    console.log("Review button not found yet, retrying...");
    setTimeout(() => waitForReviewBidEnabled(attempt + 1), 1000);
    return;
  }

  const isDisabled =
    btn.disabled ||
    btn.getAttribute("aria-disabled") === "true" ||
    btn.innerText.trim() === "";

  if (isDisabled) {
    console.log("Review button still disabled, waiting...");
    setTimeout(() => waitForReviewBidEnabled(attempt + 1), 1000);
    return;
  }

  console.log("✅ Review button enabled:", btn.innerText);
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
    console.log("Review button not found after multiple attempts");
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const btn = buttons.find((b) => {
    const text = (b.innerText || "").trim().toLowerCase();
    return text.includes("review bid") || text.includes("review order");
  });

  if (!btn) {
    console.log("Review button not found yet, retrying...");
    setTimeout(() => clickReviewBid(attempt + 1), 1000);
    return;
  }

  console.log("🔥 Clicking review button:", btn.innerText);
  clickElement(btn);

  setTimeout(() => {
    clickConfirmBid();
  }, 2500);
}

function clickConfirmBid(attempt = 0) {
  if (attempt > 20) {
    console.log("Confirm/Place button not found after multiple attempts");
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const btn = buttons.find((b) => {
    const text = (b.innerText || "").trim().toLowerCase();
    return text.includes("confirm bid") || text.includes("place order");
  });

  if (!btn) {
    console.log("Confirm/Place button not found yet, retrying...");
    setTimeout(() => clickConfirmBid(attempt + 1), 1000);
    return;
  }

  const isDisabled =
    btn.disabled ||
    btn.getAttribute("aria-disabled") === "true";

  if (isDisabled) {
    console.log("Confirm/Place button still disabled, waiting...");
    setTimeout(() => clickConfirmBid(attempt + 1), 1000);
    return;
  }

  const finalButtonText = (btn.innerText || "").trim();

  console.log("🔥 Clicking final submit button:", finalButtonText);
  clickElement(btn);

  setTimeout(() => {
    waitForFinalOutcome(finalButtonText);
  }, 2500);
}

function getPageText() {
  return (document.body?.innerText || "").toLowerCase();
}

function reportTaskResult(action, extra = {}) {
  if (!currentTask) {
    console.log("No currentTask available to report result");
    return;
  }

  const submittedBid = Number(formatBidValue(currentTask.maxBid));

  const payload = {
    recordId: currentTask.recordId,
    type: currentTask.type,
    maxBid: submittedBid,
    action,
    ...extra
  };

  console.log("✅ Reporting task result:", payload);

  chrome.runtime.sendMessage(
    {
      type: "TASK_COMPLETED",
      payload
    },
    (response) => {
      console.log("Backend result response:", response);

      setTimeout(() => {
        window.close();
      }, 1000);
    }
  );
}

function waitForFinalOutcome(finalButtonText = "", attempt = 0) {
  if (attempt > 20) {
    console.log("Final outcome not detected after multiple attempts");

    // fallback: use button type if nothing else detected
    const normalized = String(finalButtonText || "").trim().toLowerCase();

    if (normalized.includes("place order")) {
      reportTaskResult("ORDER_PLACED_FALLBACK", {
        errorMessage: "No success/failure screen detected after Place Order"
      });
      return;
    }

    if (normalized.includes("confirm bid")) {
      reportTaskResult("BID_CREATED_FALLBACK", {
        errorMessage: "No success/failure screen detected after Confirm Bid"
      });
      return;
    }

    return;
  }

  const pageText = getPageText();

  // ORDER SUCCESS
  if (
    pageText.includes("your order has been placed successfully") ||
    pageText.includes("congratulations! your order has been placed successfully")
  ) {
    console.log("✅ Order success page detected");
    reportTaskResult("ORDER_PLACED");
    return;
  }

  // BID SUCCESS
  if (
    pageText.includes("your bid is live") ||
    pageText.includes("success") && pageText.includes("your bid")
  ) {
    console.log("✅ Bid success page detected");
    reportTaskResult("BID_CREATED");
    return;
  }

  // PAYMENT / FUNDS FAILURE
  if (
    pageText.includes("there was an error with your payment method") ||
    pageText.includes("please enter a new payment method and try again") ||
    pageText.includes("payment method")
  ) {
    console.log("❌ Payment failure / no funds detected");
    reportTaskResult("NO_FUNDS", {
      errorMessage: "Payment method declined or insufficient balance"
    });
    return;
  }

  console.log("Waiting for final outcome...");
  setTimeout(() => {
    waitForFinalOutcome(finalButtonText, attempt + 1);
  }, 1500);
}
