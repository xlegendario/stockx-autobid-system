console.log("StockX Autobid content script loaded");

let currentTask = null;

async function shouldForceStopRunner() {
  const data = await chrome.storage.local.get(["forceStop"]);
  return data.forceStop === true;
}

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

  if (currentTask?.type === "VERIFY_BID_STATUS") {
    if (window.location.pathname.includes("/buying/bids")) {
      setTimeout(async () => {
        if (await stopIfNeeded("page load verify bids page")) return;
        handleVerifyBidsPage();
      }, 1500);
      return;
    }
  
    if (window.location.pathname.includes("/buying/orders")) {
      setTimeout(async () => {
        if (await stopIfNeeded("page load verify orders page")) return;
        handleVerifyOrdersPage();
      }, 1500);
      return;
    }
  
    if (/^\/buying\/\d+/.test(window.location.pathname)) {
      setTimeout(async () => {
        if (await stopIfNeeded("page load verify order detail page")) return;
        handleVerifyOrderDetailPage();
      }, 1500);
      return;
    }
  }
  
  if (window.location.pathname.includes("/buy/")) {
    setTimeout(async () => {
      if (await stopIfNeeded("page load buy page")) return;
      handleBuyPage();
    }, 1500);
    return;
  }

  setTimeout(async () => {
    if (await stopIfNeeded("page load")) return;
    handleTask();
  }, 2000);
});

async function stopIfNeeded(context = "") {
  const mustStop = await shouldForceStopRunner();

  if (mustStop) {
    console.log(`🛑 Force stop triggered${context ? ` during ${context}` : ""}`);
    return true;
  }

  return false;
}

async function handleTask() {
  if (!currentTask) return;

  if (await stopIfNeeded("handleTask")) return;

  console.log("Handling task:", {
    type: currentTask?.type,
    recordId: currentTask?.recordId,
    sku: currentTask?.sku,
    size: currentTask?.size
  });

  if (currentTask.type === "PLACE_OR_UPDATE") {
    if (window.location.pathname.includes("/buy/")) {
      handleBuyPage();
      return;
    }
  
    goToOfferPage();
    return;
  }
  
  if (currentTask.type === "REMOVE") {
    handleRemoveFlow();
    return;
  }
  
  if (currentTask.type === "VERIFY_BID_STATUS") {
    handleVerifyFlow();
    return;
  }
  
  console.log("Unknown task type, skipping:", currentTask.type);
}

async function handleRemoveFlow() {
  console.log("🧹 Starting REMOVE flow:", {
    recordId: currentTask?.recordId,
    sku: currentTask?.sku,
    size: currentTask?.size
  });

  if (await stopIfNeeded("start remove flow")) return;

  openSizeDropdownAndSelectForRemove(currentTask.size);
}

async function handleVerifyFlow() {
  console.log("🔍 Starting VERIFY flow:", {
    recordId: currentTask?.recordId,
    sku: currentTask?.sku,
    size: currentTask?.size
  });

  if (await stopIfNeeded("start verify flow")) return;

  goToVerifyBidsPage();
}

function goToVerifyBidsPage() {
  console.log("🔍 Navigating to bids page");
  window.location.href = "https://stockx.com/buying/bids";
}

function goToVerifyOrdersPage() {
  console.log("🔍 Navigating to orders page");
  window.location.href = "https://stockx.com/buying/orders";
}

async function storePendingVerifyOrderMeta(meta) {
  await chrome.storage.local.set({
    pendingVerifyOrderMeta: meta
  });
}

async function getPendingVerifyOrderMeta() {
  const data = await chrome.storage.local.get(["pendingVerifyOrderMeta"]);
  return data.pendingVerifyOrderMeta || null;
}

async function clearPendingVerifyOrderMeta() {
  await chrome.storage.local.remove(["pendingVerifyOrderMeta"]);
}

function extractFinalStockXPriceFromText(text) {
  const raw = String(text || "");

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    const label = normalizeText(lines[i]);

    if (label === "total") {
      const candidate = lines[i + 1];
      const match = candidate.match(/€\s*([\d.,]+)/);

      if (match?.[1]) {
        const parsed = Number(match[1].replace(/\./g, "").replace(",", "."));
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }

  const fallbackMatch = raw.match(/Total[\s\S]{0,60}?€\s*([\d.,]+)/i);
  if (fallbackMatch?.[1]) {
    const parsed = Number(fallbackMatch[1].replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function findMatchingOrderRow(expectedSizeText) {
  const allElements = Array.from(
    document.querySelectorAll("tr, [role='row'], li, article, div, a, button, span")
  );

  const matchingElement = allElements.find((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    return (
      text.includes(expectedSizeText) ||
      text.includes(`size: ${expectedSizeText}`)
    );
  });

  if (!matchingElement) return null;

  const clickableAncestor =
    matchingElement.closest('a[href*="/buying/"]') ||
    matchingElement.closest('[role="link"]') ||
    matchingElement.closest('button') ||
    matchingElement.closest('tr') ||
    matchingElement.closest('[role="row"]') ||
    matchingElement.closest('li') ||
    matchingElement.closest('article') ||
    matchingElement.closest('div');

  return clickableAncestor || matchingElement;
}

function clickOrderRowForDetail(row) {
  if (!row) return false;

  const clickableChild = row.querySelector(
    'a, button, [role="link"], [role="button"]'
  );

  if (clickableChild) {
    console.log("🔍 Clicking clickable child inside matching order row");
    return clickElement(clickableChild);
  }

  console.log("🔍 Clicking matching order row directly");
  return clickElement(row);
}

function findVerifySearchInput() {
  const inputs = Array.from(document.querySelectorAll("input"));

  const exactMatch = inputs.find((input) => {
    const rect = input.getBoundingClientRect();
    const style = window.getComputedStyle(input);

    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    const placeholder = normalizeText(input.getAttribute("placeholder") || "");
    return placeholder.includes("search name, order #");
  });

  if (exactMatch) return exactMatch;

  // fallback, mocht StockX de placeholder iets wijzigen
  return inputs.find((input) => {
    const rect = input.getBoundingClientRect();
    const style = window.getComputedStyle(input);

    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    const placeholder = normalizeText(input.getAttribute("placeholder") || "");
    const ariaLabel = normalizeText(input.getAttribute("aria-label") || "");

    return (
      placeholder.includes("order #") ||
      placeholder.includes("search name") ||
      ariaLabel.includes("order #")
    );
  });
}

function setInputValue(input, value) {
  input.focus();

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
}

function handleVerifyBidsPage(attempt = 0) {
  console.log("🔍 Checking bids page...");

  if (!currentTask) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "No currentTask available on bids page"
    });
    return;
  }

  if (attempt > 12) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Could not search bids page"
    });
    return;
  }

  const searchInput = findVerifySearchInput();

  if (!searchInput) {
    console.log("🔍 Bids search input not found yet, retrying...");
    setTimeout(() => handleVerifyBidsPage(attempt + 1), 1000);
    return;
  }

  const currentValue = normalizeText(searchInput.value || "");
  const targetSku = normalizeText(currentTask.sku);
  const expectedSizeText = getExpectedEuSizeText(currentTask.size);

  console.log("🔍 Expected size text:", expectedSizeText);

  if (currentValue !== targetSku) {
    setInputValue(searchInput, currentTask.sku);

    setTimeout(() => {
      handleVerifyBidsPage(attempt + 1);
    }, 2000);
    return;
  }

  const pageText = getPageText();

  // 1. expliciete empty state
  if (
    pageText.includes("you don't have active bids") ||
    pageText.includes("items that you are bidding on will show up here")
  ) {
    console.log("🔍 Verify: no active bids found, checking orders...");
    goToVerifyOrdersPage();
    return;
  }

  // 2. alleen rows/cards checken, niet hele page text
  const rowCandidates = Array.from(
    document.querySelectorAll("tr, [role='row'], li, article, div")
  ).filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    return text.includes(expectedSizeText);
  });

  const matchingBidRow = rowCandidates.find((row) => {
    const text = normalizeText(row.innerText);
    return text.includes(expectedSizeText);
  });

  if (matchingBidRow) {
    console.log("✅ Verify: bid still live");
    reportTaskResult("BID_VERIFIED_STILL_LIVE");
    return;
  }

  console.log("🔍 Verify: bid not found on bids page, checking orders...");
  goToVerifyOrdersPage();
}

function extractOrderNumberFromText(text) {
  const raw = String(text || "");

  // 1. beste match voor StockX order numbers zoals 03-TZCVTVJ5R0
  const explicitStockxMatch = raw.match(/\b\d{2}-[A-Z0-9-]{6,}\b/i);
  if (explicitStockxMatch?.[0]) {
    return explicitStockxMatch[0].trim();
  }

  // 2. split in regels en probeer label-gebaseerde extractie
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    const label = normalizeText(lines[i]);

    if (
      label === "order number" ||
      label === "order #" ||
      label === "ordernumber"
    ) {
      const candidate = lines[i + 1]?.trim();

      if (candidate && /^[A-Za-z0-9-]{6,}$/.test(candidate)) {
        return candidate;
      }
    }
  }

  // 3. fallback: zoek tokens die op ordernummer lijken
  for (const line of lines) {
    const tokenMatches = line.match(/\b[A-Za-z0-9-]{6,}\b/g) || [];

    for (const token of tokenMatches) {
      const normalized = normalizeText(token);

      if (
        normalized === "purchase" ||
        normalized === "pending" ||
        normalized === "status" ||
        normalized === "number" ||
        normalized === "order"
      ) {
        continue;
      }

      return token;
    }
  }

  return null;
}

async function handleVerifyOrdersPage(attempt = 0) {
  console.log("🔍 Checking orders page...");

  if (!currentTask) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "No currentTask available on orders page"
    });
    return;
  }

  if (attempt > 12) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Could not search orders page"
    });
    return;
  }

  const searchInput = findVerifySearchInput();

  if (!searchInput) {
    console.log("🔍 Orders search input not found yet, retrying...");
    setTimeout(() => handleVerifyOrdersPage(attempt + 1), 1000);
    return;
  }

  const currentValue = normalizeText(searchInput.value || "");
  const targetSku = normalizeText(currentTask.sku);
  const expectedSizeText = getExpectedEuSizeText(currentTask.size);

  console.log("🔍 Expected size text:", expectedSizeText);

  if (currentValue !== targetSku) {
    setInputValue(searchInput, currentTask.sku);

    setTimeout(() => {
      handleVerifyOrdersPage(attempt + 1);
    }, 2000);
    return;
  }

  const rawPageText = document.body?.innerText || "";
  const pageText = normalizeText(rawPageText);

  if (
    pageText.includes("you don't have any pending orders") ||
    pageText.includes("items that are being shipped to you will show up here")
  ) {
    console.log("❌ Verify: no pending orders found");
    reportTaskResult("BID_MISSING_NO_ORDER_FOUND");
    return;
  }

  const expectedSizeLine = `size: ${expectedSizeText}`;
  const hasMatchingSize =
    pageText.includes(expectedSizeLine) ||
    pageText.includes(expectedSizeText);

  if (!hasMatchingSize) {
    console.log("❌ Verify: no matching order found");
    reportTaskResult("BID_MISSING_NO_ORDER_FOUND");
    return;
  }

  const orderNumber = extractOrderNumberFromText(rawPageText);

  if (!orderNumber) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Matching order found but could not extract order number"
    });
    return;
  }

  const matchingRow = findMatchingOrderRow(expectedSizeText);

  if (!matchingRow) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: `Matching order found (${orderNumber}) but could not locate clickable order row`
    });
    return;
  }
  
  console.log("✅ Verify: matching order found, clicking order row for detail page", {
    orderNumber
  });
  
  await storePendingVerifyOrderMeta({
    orderNumber,
    recordId: currentTask.recordId
  });
  
  clickOrderRowForDetail(matchingRow);
  
  setTimeout(() => {
    if (/^\/buying\/\d+/.test(window.location.pathname)) {
      console.log("✅ Navigated to order detail page");
      return;
    }
  
    console.log("🔍 Order detail navigation not visible yet, waiting for page load...");
  }, 1000);
}

async function handleVerifyOrderDetailPage(attempt = 0) {
  console.log("🔍 Checking order detail page...");

  if (!currentTask) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "No currentTask available on order detail page"
    });
    return;
  }

  const pendingMeta = await getPendingVerifyOrderMeta();

  if (!pendingMeta?.orderNumber) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Missing pending verify order metadata on detail page"
    });
    return;
  }

  if (attempt > 12) {
    await clearPendingVerifyOrderMeta();
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Could not extract final StockX price from order detail page"
    });
    return;
  }

  const rawPageText = document.body?.innerText || "";
  const pageText = normalizeText(rawPageText);

  if (!pageText.includes("summary") || !pageText.includes("total")) {
    console.log("🔍 Order detail page not ready yet, retrying...");
    setTimeout(() => {
      handleVerifyOrderDetailPage(attempt + 1);
    }, 1000);
    return;
  }

  const finalStockXPrice = extractFinalStockXPriceFromText(rawPageText);

  if (!Number.isFinite(finalStockXPrice)) {
    console.log("🔍 Could not parse final StockX price yet, retrying...");
    setTimeout(() => {
      handleVerifyOrderDetailPage(attempt + 1);
    }, 1000);
    return;
  }

  console.log("✅ Verify: extracted final StockX price", {
    orderNumber: pendingMeta.orderNumber,
    finalStockXPrice
  });

  await clearPendingVerifyOrderMeta();

  reportTaskResult("ORDER_DETECTED_FROM_ACCEPTED_BID", {
    orderNumber: pendingMeta.orderNumber,
    finalStockXPrice
  });
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(",", ".");
}

function getExpectedEuSizeText(size) {
  const normalized = normalizeText(size);
  return `eu ${normalized}`;
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

function openSizeDropdownAndSelectForRemove(targetSize) {
  console.log("🧹 Trying to open size dropdown for REMOVE:", targetSize);

  const buttons = Array.from(document.querySelectorAll("button"));

  const dropdownButton = buttons.find((btn) => {
    const text = normalizeText(btn.innerText);
    return text.includes("eu ") || text === "size:" || text.includes("size");
  });

  if (!dropdownButton) {
    console.log("REMOVE: size dropdown not found yet, retrying...");
    setTimeout(() => openSizeDropdownAndSelectForRemove(targetSize), 1000);
    return;
  }

  console.log("REMOVE: clicking size dropdown:", dropdownButton.innerText);
  dropdownButton.click();

  setTimeout(() => {
    selectSizeFromDropdownForRemove(targetSize);
  }, 1000);
}

function selectSizeFromDropdownForRemove(targetSize) {
  const normalizedTarget = normalizeText(targetSize);
  console.log("🧹 Trying to select size from dropdown for REMOVE:", normalizedTarget);

  const candidates = Array.from(
    document.querySelectorAll("button, [role='option'], li, div, span")
  ).filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    // voorkom dat we de dropdown control zelf pakken
    if (text.includes("size:")) return false;

    return text === normalizedTarget || text === `eu ${normalizedTarget}`;
  });

  if (candidates.length === 0) {
    console.log("REMOVE: size option not found yet, retrying...");
    setTimeout(() => selectSizeFromDropdownForRemove(targetSize), 1000);
    return;
  }

  // pak de kortste match, meestal de echte optie
  const match = candidates.sort(
    (a, b) => normalizeText(a.innerText).length - normalizeText(b.innerText).length
  )[0];

  console.log("🧹 Clicking size option for REMOVE:", match.innerText);
  clickElement(match);

  setTimeout(() => {
    clickUpdateButtonForRemove();
  }, 2500);
}

function clickUpdateButtonForRemove(attempt = 0) {
  console.log("🧹 REMOVE flow reached clickUpdateButtonForRemove");

  if (attempt > 25) {
    reportTaskResult("BID_REMOVE_NOT_FOUND", {
      errorMessage: "Update button not found after selecting size"
    });
    return;
  }

  const candidates = Array.from(
    document.querySelectorAll("button, a, [role='button'], div, span")
  ).filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    return text === "update";
  });

  if (candidates.length === 0) {
    console.log("REMOVE: Update button not found yet, retrying...");
    setTimeout(() => clickUpdateButtonForRemove(attempt + 1), 1000);
    return;
  }

  // pak de kleinste 'update' match, niet een grote container
  const updateEl = candidates.sort(
    (a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height -
              b.getBoundingClientRect().width * b.getBoundingClientRect().height
  )[0];

  (async () => {
    if (await stopIfNeeded("before update click")) return;
  
    console.log("🧹 Clicking real Update control:", updateEl.innerText);
    clickElement(updateEl);
  
    setTimeout(() => {
      waitForRemoveEditPage();
    }, 2500);
  })();
}

function waitForRemoveEditPage(attempt = 0) {
  console.log("🧹 Waiting for remove edit page...");

  if (attempt > 15) {
    reportTaskResult("BID_REMOVE_FAILED", {
      errorMessage: "Update clicked but edit page did not load"
    });
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));
  const pageText = getPageText();

  const deleteBtn = buttons.find((btn) => {
    const text = normalizeText(btn.innerText);
    return text === "delete bid" || text.includes("delete bid");
  });

  if (deleteBtn) {
    console.log("🧹 Remove edit page detected via Delete Bid button");
    clickDeleteBidButtonForRemove();
    return;
  }

  const looksLikeEditPage =
    pageText.includes("delete bid") ||
    pageText.includes("review bid") ||
    pageText.includes("bid") && pageText.includes("sell faster");

  if (looksLikeEditPage) {
    console.log("🧹 Edit-like page detected, retrying for Delete Bid button...");
  } else {
    console.log("🧹 Edit page not ready yet, retrying...");
  }

  setTimeout(() => {
    waitForRemoveEditPage(attempt + 1);
  }, 1000);
}

function clickDeleteBidButtonForRemove(attempt = 0) {
  console.log("🧹 Trying to click Delete Bid...");

  if (attempt > 15) {
    reportTaskResult("BID_REMOVE_FAILED", {
      errorMessage: "Delete Bid button not found on edit page"
    });
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const deleteBtn = buttons.find((btn) => {
    const text = normalizeText(btn.innerText);
    return text === "delete bid" || text.includes("delete bid");
  });

  if (!deleteBtn) {
    console.log("🧹 Delete Bid button not found yet, retrying...");
    setTimeout(() => {
      clickDeleteBidButtonForRemove(attempt + 1);
    }, 1000);
    return;
  }

  const isDisabled =
    deleteBtn.disabled ||
    deleteBtn.getAttribute("aria-disabled") === "true";

  if (isDisabled) {
    console.log("🧹 Delete Bid button is disabled, waiting...");
    setTimeout(() => {
      clickDeleteBidButtonForRemove(attempt + 1);
    }, 1000);
    return;
  }

  (async () => {
    if (await stopIfNeeded("before delete bid click")) return;
  
    console.log("🧹 Clicking Delete Bid:", deleteBtn.innerText);
    clickElement(deleteBtn);
  
    setTimeout(() => {
      waitForReturnToProductPageAfterRemove();
    }, 2000);
  })();
}

function waitForReturnToProductPageAfterRemove(attempt = 0) {
  console.log("🧹 Waiting to return to product page after Delete Bid...");

  if (attempt > 20) {
    reportTaskResult("BID_REMOVE_FAILED", {
      errorMessage: "Delete Bid clicked but did not return to product page"
    });
    return;
  }

  const isBuyPage = window.location.pathname.includes("/buy/");
  const pageText = getPageText();

  const looksLikeProductPage =
    !isBuyPage &&
    (
      pageText.includes("buy or bid") ||
      pageText.includes("sell or ask") ||
      pageText.includes("your current bid") ||
      pageText.includes("size")
    );

  if (looksLikeProductPage) {
    console.log("🧹 Returned to product page after Delete Bid");
    verifyRemovedBidForTargetSize();
    return;
  }

  console.log("🧹 Not back on product page yet, retrying...");
  setTimeout(() => {
    waitForReturnToProductPageAfterRemove(attempt + 1);
  }, 1000);
}

async function verifyRemovedBidForTargetSize() {
  if (!currentTask) {
    reportTaskResult("BID_REMOVE_FAILED", {
      errorMessage: "No currentTask available during post-delete verification"
    });
    return;
  }

  if (await stopIfNeeded("before remove verification")) return;

  console.log("🧹 Verifying removed bid for target size:", currentTask.size);
  openSizeDropdownAndSelectForRemoveVerification(currentTask.size);
}

function openSizeDropdownAndSelectForRemoveVerification(targetSize) {
  console.log("🧹 Opening size dropdown for REMOVE verification:", targetSize);

  const buttons = Array.from(document.querySelectorAll("button"));

  const dropdownButton = buttons.find((btn) => {
    const text = normalizeText(btn.innerText);
    return text.includes("eu ") || text === "size:" || text.includes("size");
  });

  if (!dropdownButton) {
    console.log("REMOVE VERIFY: size dropdown not found yet, retrying...");
    setTimeout(() => openSizeDropdownAndSelectForRemoveVerification(targetSize), 1000);
    return;
  }

  console.log("REMOVE VERIFY: clicking size dropdown:", dropdownButton.innerText);
  dropdownButton.click();

  setTimeout(() => {
    selectSizeFromDropdownForRemoveVerification(targetSize);
  }, 1000);
}

function selectSizeFromDropdownForRemoveVerification(targetSize) {
  const normalizedTarget = normalizeText(targetSize);
  console.log("🧹 Selecting size for REMOVE verification:", normalizedTarget);

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
    console.log("REMOVE VERIFY: size option not found yet, retrying...");
    setTimeout(() => selectSizeFromDropdownForRemoveVerification(targetSize), 1000);
    return;
  }

  console.log("🧹 Clicking size option for REMOVE verification:", match.innerText);
  match.click();

  setTimeout(() => {
    checkIfBidRemovedForSelectedSize();
  }, 1500);
}

function checkIfBidRemovedForSelectedSize(attempt = 0) {
  console.log("🧹 Checking if bid is removed for selected size...");

  if (attempt > 12) {
    reportTaskResult("BID_REMOVE_FAILED", {
      errorMessage: "Could not verify bid removal after re-selecting target size"
    });
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));
  const pageText = getPageText();

  const updateBtn = buttons.find((btn) => {
    const text = normalizeText(btn.innerText);
    return text === "update" || text.includes("update");
  });

  const hasCurrentBidText = pageText.includes("your current bid");

  if (!updateBtn && !hasCurrentBidText) {
    console.log("✅ Bid removed successfully for target size");
    reportTaskResult("BID_REMOVED");
    return;
  }

  console.log("🧹 Bid state still visible for target size, retrying verification...");
  setTimeout(() => {
    checkIfBidRemovedForSelectedSize(attempt + 1);
  }, 1000);
}

function goToOfferPage() {
  const currentUrl = new URL(window.location.href);
  let slug = currentUrl.pathname.replace(/^\/+/, "");

  if (!slug) {
    console.log("Could not determine product slug from URL");
    return;
  }

  // als we al op /buy/slug zitten → strip "buy/"
  if (slug.startsWith("buy/")) {
    slug = slug.replace(/^buy\//, "");
  }

  const offerUrl = `https://stockx.com/buy/${slug}?defaultBid=true`;

  console.log("🔥 Navigating directly to buy page:", offerUrl);
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
  const hasReviewActionButton = Array.from(document.querySelectorAll("button")).some((btn) => {
    const text = (btn.innerText || "").trim().toLowerCase();
    return text.includes("review bid") || text.includes("review order");
  });
  
  if (priceInput && hasReviewActionButton) {
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

  setTimeout(async () => {
    const currentVal = normalizeNumericString(input.value);
    const expectedVal = normalizeNumericString(bidValue);

    console.log("Input value after fill attempt:", currentVal);
    console.log("Expected bid value:", expectedVal);

    if (currentVal !== expectedVal) {
      console.log("❌ Bid value mismatch, retrying fill...");
      setTimeout(() => fillBidPrice(attempt + 1), 1000);
      return;
    }

    if (await stopIfNeeded("after fillBidPrice")) return;

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

async function clickReviewBid(attempt = 0) {
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

  if (await stopIfNeeded("before Review click")) return;

  console.log("🔥 Clicking review button:", btn.innerText);
  clickElement(btn);

  setTimeout(() => {
    clickConfirmBid();
  }, 2500);
}

async function clickConfirmBid(attempt = 0) {
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

  if (await stopIfNeeded("before final submit")) return;

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

  console.log("✅ Reporting task result:", {
    recordId: payload.recordId,
    type: payload.type,
    action: payload.action,
    errorMessage: payload.errorMessage || ""
  });

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
