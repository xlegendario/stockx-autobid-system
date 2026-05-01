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

  if (
    currentTask &&
    needsProductPageTask(currentTask.type) &&
    window.location.pathname.includes("/search")
  ) {
    setTimeout(async () => {
      if (await stopIfNeeded("search fallback page")) return;
      handleSearchFallbackPage();
    }, 1500);
    return;
  }

  const pendingInstant = await getPendingInstantOrderMeta();

  if (pendingInstant?.orderNumber) {
    if (window.location.pathname.includes("/buying/orders")) {
      setTimeout(async () => {
        if (await stopIfNeeded("instant order orders page")) return;
        handleInstantOrderOrdersPage();
      }, 1500);
      return;
    }

    if (/^\/buying\/\d+/.test(window.location.pathname)) {
      setTimeout(async () => {
        if (await stopIfNeeded("instant order detail page")) return;
        handleInstantOrderDetailPage();
      }, 1500);
      return;
    }
  }

  if (!currentTask) {
    console.log("No currentTask in storage");
    return;
  }

  if (isVerifyTaskType(currentTask?.type)) {
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

  if (isOrderSyncTaskType(currentTask?.type)) {
    if (window.location.pathname.includes("/buying/orders")) {
      setTimeout(async () => {
        if (await stopIfNeeded("page load order sync orders page")) return;
        handleOrderSyncOrdersPage();
      }, 1500);
      return;
    }

    if (/^\/buying\/\d+/.test(window.location.pathname)) {
      setTimeout(async () => {
        if (await stopIfNeeded("page load order sync detail page")) return;
        handleOrderSyncDetailPage();
      }, 1500);
      return;
    }
  }

  if (window.location.pathname.includes("/buy/")) {
    setTimeout(async () => {
      if (await stopIfNeeded("page load buy page")) return;
  
      if (currentTask?.type === "PLACE_OR_BUY_WITH_SECOND_BID_CHECK") {
        handleInitialSecondBidBuyCheckPage();
        return;
      }
  
      handleBuyPage();
    }, 1500);
    return;
  }

  if (
    currentTask &&
    needsProductPageTask(currentTask.type) &&
    !window.location.pathname.includes("/buy/") &&
    !window.location.pathname.includes("/search")
  ) {
    const ok = await verifyProductPageSkuOrFail();
  
    if (!ok) return;
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

function findFirstSearchResultLink() {
  const links = Array.from(document.querySelectorAll("a[href]"));

  const productLinks = links.filter((a) => {
    const href = a.getAttribute("href") || "";
    const text = normalizeText(a.innerText || "");
    const rect = a.getBoundingClientRect();
    const style = window.getComputedStyle(a);

    if (!href) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    // ❌ exclude logo/home/nav/filter links
    if (href === "/" || href === "https://stockx.com/") return false;
    if (href.includes("/search")) return false;
    if (href.includes("/buying")) return false;
    if (href.includes("/sell")) return false;
    if (href.includes("/news")) return false;
    if (href.includes("/about")) return false;
    if (href.includes("/help")) return false;
    if (href.includes("/login")) return false;
    if (href.includes("/signup")) return false;
    if (href.includes("/category")) return false;
    if (href.includes("/brands")) return false;

    // Alleen links in het product-grid gebied, niet header/sidebar
    if (rect.top < 250) return false;
    if (rect.left < 250) return false;

    const url = new URL(href, window.location.origin);
    const path = url.pathname;

    // Product slug is meestal precies 1 path segment: /asics-gel-kayano-...
    const segments = path.split("/").filter(Boolean);
    if (segments.length !== 1) return false;

    // Product cards bevatten meestal title/lowest ask/price
    const parentText = normalizeText(a.closest("div")?.innerText || "");
    const combinedText = `${text} ${parentText}`;

    return (
      combinedText.includes("lowest ask") ||
      combinedText.includes("€") ||
      combinedText.includes("$")
    );
  });

  if (productLinks.length === 0) return null;

  productLinks.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();

    if (Math.abs(ar.top - br.top) > 20) return ar.top - br.top;
    return ar.left - br.left;
  });

  return productLinks[0];
}

function handleSearchFallbackPage(attempt = 0) {
  if (!currentTask) return;

  if (attempt > 15) {
    reportTaskResult(getSearchFallbackFailureAction(), {
      errorMessage: `Search fallback failed: no product result found for SKU ${getSkuTextFromTask()}`
    });
    return;
  }

  const firstLink = findFirstSearchResultLink();

  if (!firstLink) {
    console.log("Search fallback: first product link not found yet, retrying...");
    setTimeout(() => handleSearchFallbackPage(attempt + 1), 1000);
    return;
  }

  const href = firstLink.getAttribute("href");
  const targetUrl = href.startsWith("http")
    ? href
    : `https://stockx.com${href}`;

  console.log("Search fallback: opening first product result:", targetUrl);

  window.location.href = targetUrl;
}

async function verifyProductPageSkuOrFail(attempt = 0) {
  const expectedSku = getSkuTextFromTask();

  if (!expectedSku) return true;

  const bodyText = String(document.body?.innerText || "").toUpperCase();

  if (bodyText.includes(expectedSku)) {
    console.log("✅ Search fallback SKU verified:", expectedSku);
    return true;
  }

  if (attempt < 12) {
    window.scrollTo(0, document.body.scrollHeight);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    return verifyProductPageSkuOrFail(attempt + 1);
  }

  reportTaskResult(getSearchFallbackFailureAction(), {
    errorMessage: `Search fallback SKU mismatch. Expected SKU ${expectedSku} was not found on product page ${window.location.href}`
  });

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

  if (currentTask.type === "PLACE_OR_BUY_WITH_SECOND_BID_CHECK") {
    if (window.location.pathname.includes("/buy/")) {
      handleInitialSecondBidBuyCheckPage();
      return;
    }

    goToOfferPage();
    return;
  }

  if (currentTask.type === "PLACE_SECOND_BID") {
    if (window.location.pathname.includes("/buy/")) {
      handleBuyPage();
      return;
    }

    goToOfferPage();
    return;
  }

  if (isRemoveTaskType(currentTask.type)) {
    handleRemoveFlow();
    return;
  }

  if (isVerifyTaskType(currentTask.type)) {
    handleVerifyFlow();
    return;
  }

  if (isOrderSyncTaskType(currentTask.type)) {
    handleOrderStatusSyncFlow();
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

async function handleOrderStatusSyncFlow() {
  console.log("📦 Starting ORDER STATUS SYNC flow:", {
    recordId: currentTask?.recordId,
    orderNumber: currentTask?.orderNumber
  });

  if (await stopIfNeeded("start order status sync flow")) return;

  goToVerifyOrdersPage();
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

async function getPendingInstantOrderMeta() {
  const data = await chrome.storage.local.get(["pendingInstantOrderMeta"]);
  return data.pendingInstantOrderMeta || null;
}

async function clearPendingInstantOrderMeta() {
  await chrome.storage.local.remove(["pendingInstantOrderMeta"]);
}

function isPlaceBidTaskType(type) {
  return type === "PLACE_OR_UPDATE" || type === "PLACE_SECOND_BID";
}

function isVerifyTaskType(type) {
  return type === "VERIFY_BID_STATUS" || type === "VERIFY_SECOND_BID_STATUS";
}

function isOrderSyncTaskType(type) {
  return type === "SYNC_ORDER_STATUS" || type === "SYNC_SECOND_ORDER_STATUS";
}

function isRemoveTaskType(type) {
  return type === "REMOVE" || type === "REMOVE_SECOND_BID";
}

function needsProductPageTask(type) {
  return (
    type === "PLACE_OR_UPDATE" ||
    type === "PLACE_OR_BUY_WITH_SECOND_BID_CHECK" ||
    type === "PLACE_SECOND_BID" ||
    type === "REMOVE" ||
    type === "REMOVE_SECOND_BID"
  );
}

function getSkuTextFromTask() {
  const raw = currentTask?.sku;

  if (Array.isArray(raw)) {
    return String(raw[0] || "").trim().toUpperCase();
  }

  return String(raw || "").trim().toUpperCase();
}

function getSearchFallbackFailureAction() {
  if (currentTask?.type === "REMOVE_SECOND_BID") return "SECOND_BID_REMOVE_FAILED";
  if (currentTask?.type === "PLACE_SECOND_BID") return "SECOND_BID_FAILED";
  if (currentTask?.type === "REMOVE") return "BID_REMOVE_FAILED";
  return "BID_UPDATE_FAILED";
}

function getBidFailureAction() {
  return currentTask?.type === "PLACE_SECOND_BID"
    ? "SECOND_BID_FAILED"
    : "BID_UPDATE_FAILED";
}

function getBidSuccessAction() {
  if (currentTask?.type === "PLACE_SECOND_BID") {
    const currentBid = Number(currentTask?.currentBid);
    return Number.isFinite(currentBid) ? "SECOND_BID_UPDATED" : "SECOND_BID_CREATED";
  }

  return getPlaceOrUpdateSuccessAction();
}

function getVerifyStillLiveAction() {
  return currentTask?.type === "VERIFY_SECOND_BID_STATUS"
    ? "SECOND_BID_VERIFIED_STILL_LIVE"
    : "BID_VERIFIED_STILL_LIVE";
}

function getVerifyMissingNoOrderAction() {
  return currentTask?.type === "VERIFY_SECOND_BID_STATUS"
    ? "SECOND_BID_MISSING_NO_ORDER_FOUND"
    : "BID_MISSING_NO_ORDER_FOUND";
}

function getVerifyOrderPlacedAction() {
  return currentTask?.type === "VERIFY_SECOND_BID_STATUS"
    ? "SECOND_ORDER_PLACED"
    : "ORDER_DETECTED_FROM_ACCEPTED_BID";
}

function getOrderSyncSuccessAction() {
  return currentTask?.type === "SYNC_SECOND_ORDER_STATUS"
    ? "SECOND_ORDER_STATUS_SYNCED"
    : "ORDER_STATUS_SYNCED";
}

function getOrderSyncFailedAction() {
  return currentTask?.type === "SYNC_SECOND_ORDER_STATUS"
    ? "SECOND_ORDER_STATUS_SYNC_FAILED"
    : "ORDER_STATUS_SYNC_FAILED";
}

function getRemoveSuccessAction() {
  return currentTask?.type === "REMOVE_SECOND_BID"
    ? "SECOND_BID_REMOVED"
    : "BID_REMOVED";
}

function getRemoveFailedAction() {
  return currentTask?.type === "REMOVE_SECOND_BID"
    ? "SECOND_BID_REMOVE_FAILED"
    : "BID_REMOVE_FAILED";
}

function getRemoveNotFoundAction() {
  return currentTask?.type === "REMOVE_SECOND_BID"
    ? "SECOND_BID_REMOVE_FAILED"
    : "BID_REMOVE_NOT_FOUND";
}

function getInstantOrderAction() {
  if (currentTask?.type === "PLACE_OR_BUY_WITH_SECOND_BID_CHECK") {
    return "FIRST_ORDER_PLACED";
  }

  if (currentTask?.type === "PLACE_SECOND_BID") {
    return "SECOND_ORDER_PLACED";
  }

  return "ORDER_PLACED_WITH_DETAILS";
}

function parseMoneyValue(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const cleaned = text.replace(/[^\d.,-]/g, "");
  if (!cleaned) return null;

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");

  let normalized = cleaned;

  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");

    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    normalized = cleaned.replace(",", ".");
  } else {
    normalized = cleaned;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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
        const parsed = parseMoneyValue(match[1]);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }

  const fallbackMatch = raw.match(/Total[\s\S]{0,60}?€\s*([\d.,]+)/i);
  if (fallbackMatch?.[1]) {
    const parsed = parseMoneyValue(fallbackMatch[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function findMatchingOrderRow(expectedSizeText) {
  const rowCandidates = Array.from(
    document.querySelectorAll("tr, [role='row']")
  ).filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    if (
      text.includes("item") &&
      text.includes("order number") &&
      text.includes("purchase date") &&
      text.includes("status")
    ) {
      return false;
    }

    return (
      text.includes(expectedSizeText) ||
      text.includes(`size: ${expectedSizeText}`)
    );
  });

  if (rowCandidates.length === 0) return null;

  return rowCandidates.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return bRect.width * bRect.height - aRect.width * aRect.height;
  })[0];
}

function findMatchingOrderRowByOrderNumber(orderNumber) {
  const normalizedOrderNumber = normalizeText(orderNumber);

  const rowCandidates = Array.from(
    document.querySelectorAll("tr, [role='row']")
  ).filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    if (
      text.includes("item") &&
      text.includes("order number") &&
      text.includes("purchase date") &&
      text.includes("status")
    ) {
      return false;
    }

    return text.includes(normalizedOrderNumber);
  });

  if (rowCandidates.length === 0) return null;

  return rowCandidates.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return bRect.width * bRect.height - aRect.width * aRect.height;
  })[0];
}

function clickOrderRowForDetail(row) {
  if (!row) return false;

  console.log("🔍 Clicking full matching order row");

  row.scrollIntoView({ block: "center", inline: "center" });

  try {
    row.click();
    return true;
  } catch (err) {
    console.log("🔍 Native row click failed, falling back to synthetic click");
    return clickElement(row);
  }
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

  if (
    pageText.includes("you don't have active bids") ||
    pageText.includes("items that you are bidding on will show up here")
  ) {
    console.log("🔍 Verify: no active bids found, checking orders...");
    goToVerifyOrdersPage();
    return;
  }

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
    reportTaskResult(getVerifyStillLiveAction());
    return;
  }

  console.log("🔍 Verify: bid not found on bids page, checking orders...");
  goToVerifyOrdersPage();
}

function extractOrderNumberFromText(text) {
  const raw = String(text || "");

  const explicitStockxMatch = raw.match(/\b\d{2}-[A-Z0-9-]{6,}\b/i);
  if (explicitStockxMatch?.[0]) {
    return explicitStockxMatch[0].trim();
  }

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

function extractOrderStatusFromDetailPageText(text) {
  const raw = String(text || "");

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const statusKeywords = [
    "order confirmed",
    "order received",
    "awaiting stockx verification",
    "order on its way to stockx",
    "verified",
    "shipped",
    "delivered"
  ];

  const match = lines.find((line) => {
    const normalized = normalizeText(line);
    return statusKeywords.some((keyword) => normalized.includes(keyword));
  });

  if (match) return match;

  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeText(lines[i]);

    if (normalized === "status" || normalized.includes("order status")) {
      const next = lines[i + 1];
      if (next) return next;
    }
  }

  const ignored = [
    "skip to main content",
    "back",
    "track order",
    "summary",
    "shipping",
    "total"
  ];

  const fallback = lines.find((line) => {
    const normalized = normalizeText(line);
    if (!normalized) return false;
    return !ignored.includes(normalized);
  });

  return fallback || null;
}

function findTrackOrderHref() {
  const candidates = Array.from(
    document.querySelectorAll("a, button, [role='button']")
  );

  const trackEl = candidates.find((el) => {
    const text = normalizeText(el.innerText || "");
    return text.includes("track order");
  });

  if (!trackEl) return null;

  const anchor =
    trackEl.closest("a") ||
    trackEl.querySelector?.("a") ||
    null;

  const href =
    anchor?.href ||
    trackEl.getAttribute?.("href") ||
    null;

  return href || null;
}

function extractTrackingNumberFromUrl(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url, window.location.origin);

    const directParams = [
      "parcelNumber",
      "trackingNumber",
      "tracking_number",
      "tracking",
      "awb",
      "AWB"
    ];

    for (const key of directParams) {
      const value = parsed.searchParams.get(key);
      if (value) return value.trim();
    }

    const fullUrl = parsed.toString();

    const queryMatch = fullUrl.match(
      /[?&](?:parcelNumber|trackingNumber|tracking_number|tracking)=([^&]+)/i
    );
    if (queryMatch?.[1]) {
      return decodeURIComponent(queryMatch[1]).trim();
    }

    const dhlAwbMatch = fullUrl.match(/[?&]AWB=([A-Z0-9]+)/i);
    if (dhlAwbMatch?.[1]) {
      return decodeURIComponent(dhlAwbMatch[1]).trim();
    }

    const genericQueryMatch = fullUrl.match(
      /[?&](?:parcelNumber|trackingNumber|tracking_number|tracking)=([^&]+)/i
    );
    if (genericQueryMatch?.[1]) {
      return decodeURIComponent(genericQueryMatch[1]).trim();
    }

    const upsMatch = fullUrl.match(/\b1Z[0-9A-Z]{16}\b/i);
    if (upsMatch?.[0]) {
      return upsMatch[0].trim();
    }

    return null;
  } catch {
    return null;
  }
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
    reportTaskResult(getVerifyMissingNoOrderAction());
    return;
  }

  const matchingRow = findMatchingOrderRow(expectedSizeText);

  if (!matchingRow) {
    if (attempt < 12) {
      console.log("🔍 Matching order row not found yet, retrying...");
      setTimeout(() => {
        handleVerifyOrdersPage(attempt + 1);
      }, 1000);
      return;
    }

    console.log("❌ Verify: no matching order found");
    reportTaskResult(getVerifyMissingNoOrderAction());
    return;
  }

  console.log("🔍 Matching order row text:", matchingRow.innerText);

  const orderNumber = extractOrderNumberFromText(matchingRow.innerText || rawPageText);

  if (!orderNumber) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Matching order found but could not extract order number"
    });
    return;
  }

  if (currentTask.type === "VERIFY_SECOND_BID_STATUS") {
    const foundOrderNumber = String(orderNumber || "").trim();
    const firstOrderNumber = String(currentTask.firstStockxOrderNumber || "").trim();
    const knownSecondOrderNumber = String(currentTask.secondStockxOrderNumber || "").trim();
  
    if (firstOrderNumber && foundOrderNumber === firstOrderNumber) {
      console.log("⚠️ Second verify found FIRST order, ignoring:", {
        foundOrderNumber,
        firstOrderNumber
      });
  
      reportTaskResult("SECOND_BID_MISSING_NO_ORDER_FOUND", {
        errorMessage: `Second bid missing; only first StockX order was found: ${foundOrderNumber}`
      });
  
      return;
    }
  
    if (knownSecondOrderNumber && foundOrderNumber === knownSecondOrderNumber) {
      console.log("✅ Second verify found already-known second order:", foundOrderNumber);
    }
  }

  console.log("✅ Verify: matching order found, clicking order row for detail page", {
    orderNumber
  });

  await storePendingVerifyOrderMeta({
    orderNumber,
    recordId: currentTask.recordId
  });

  clickOrderRowForDetail(matchingRow);

  setTimeout(async () => {
    if (/^\/buying\/\d+/.test(window.location.pathname)) {
      console.log("✅ Verify navigated to order detail page");

      if (await stopIfNeeded("after order detail navigation")) return;

      handleVerifyOrderDetailPage();
      return;
    }

    console.log("🔍 Verify detail navigation not visible yet, waiting...");
  }, 1500);
}

async function handleOrderSyncOrdersPage(attempt = 0) {
  console.log("📦 Checking orders page for order sync...");

  if (!currentTask?.orderNumber) {
    reportTaskResult(getOrderSyncFailedAction(), {
      errorMessage: "No orderNumber available for order sync"
    });
    return;
  }

  if (attempt > 12) {
    reportTaskResult(getOrderSyncFailedAction(), {
      errorMessage: "Could not search orders page for order sync"
    });
    return;
  }

  const searchInput = findVerifySearchInput();

  if (!searchInput) {
    console.log("📦 Orders search input not found yet, retrying...");
    setTimeout(() => handleOrderSyncOrdersPage(attempt + 1), 1000);
    return;
  }

  const currentValue = normalizeText(searchInput.value || "");
  const targetOrderNumber = normalizeText(currentTask.orderNumber);

  if (currentValue !== targetOrderNumber) {
    setInputValue(searchInput, currentTask.orderNumber);

    setTimeout(() => {
      handleOrderSyncOrdersPage(attempt + 1);
    }, 2000);
    return;
  }

  const matchingRow = findMatchingOrderRowByOrderNumber(currentTask.orderNumber);

  if (!matchingRow) {
    if (attempt < 12) {
      console.log("📦 Matching order row not found yet, retrying...");
      setTimeout(() => {
        handleOrderSyncOrdersPage(attempt + 1);
      }, 1000);
      return;
    }

    reportTaskResult(getOrderSyncFailedAction(), {
      errorMessage: `Could not find order row for ${currentTask.orderNumber}`
    });
    return;
  }

  console.log("📦 Matching order row found, opening detail page");
  clickOrderRowForDetail(matchingRow);

  setTimeout(async () => {
    if (/^\/buying\/\d+/.test(window.location.pathname)) {
      console.log("✅ Order sync navigated to detail page");

      if (await stopIfNeeded("after order sync detail navigation")) return;

      handleOrderSyncDetailPage();
      return;
    }

    console.log("📦 Order sync detail navigation not visible yet, waiting...");
  }, 1500);
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

  reportTaskResult(getVerifyOrderPlacedAction(), {
    orderNumber: pendingMeta.orderNumber,
    finalStockXPrice
  });
}

async function handleOrderSyncDetailPage(attempt = 0) {
  console.log("📦 Checking order detail page for status sync...");

  if (!currentTask?.orderNumber) {
    reportTaskResult(getOrderSyncFailedAction(), {
      errorMessage: "No orderNumber available on order detail page"
    });
    return;
  }

  if (attempt > 12) {
    reportTaskResult(getOrderSyncFailedAction(), {
      errorMessage: "Could not extract order status from detail page"
    });
    return;
  }

  const rawPageText = document.body?.innerText || "";
  const pageText = normalizeText(rawPageText);

  if (!pageText.includes("summary")) {
    console.log("📦 Order detail page not ready yet, retrying...");
    setTimeout(() => {
      handleOrderSyncDetailPage(attempt + 1);
    }, 1000);
    return;
  }

  const stockxOrderStatus = extractOrderStatusFromDetailPageText(rawPageText);
  const stockxTrackingUrl = findTrackOrderHref();
  const stockxTrackingNumber = extractTrackingNumberFromUrl(stockxTrackingUrl);

  if (!stockxOrderStatus) {
    console.log("📦 Could not parse order status yet, retrying...");
    setTimeout(() => {
      handleOrderSyncDetailPage(attempt + 1);
    }, 1000);
    return;
  }

  console.log("✅ Order status synced", {
    orderNumber: currentTask.orderNumber,
    stockxOrderStatus,
    stockxTrackingUrl,
    stockxTrackingNumber
  });

  reportTaskResult(getOrderSyncSuccessAction(), {
    orderNumber: currentTask.orderNumber,
    stockxOrderStatus,
    stockxTrackingUrl,
    stockxTrackingNumber
  });
}

async function handleInstantOrderOrdersPage(attempt = 0) {
  console.log("🔥 Handling instant order - orders page");

  const meta = await getPendingInstantOrderMeta();

  if (!meta?.orderNumber) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Missing instant order meta"
    });
    return;
  }

  if (attempt > 12) {
    await clearPendingInstantOrderMeta();
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Could not find instant order in orders page"
    });
    return;
  }

  const searchInput = findVerifySearchInput();

  if (!searchInput) {
    setTimeout(() => handleInstantOrderOrdersPage(attempt + 1), 1000);
    return;
  }

  const currentValue = normalizeText(searchInput.value || "");
  const target = normalizeText(meta.orderNumber);

  if (currentValue !== target) {
    setInputValue(searchInput, meta.orderNumber);

    setTimeout(() => {
      handleInstantOrderOrdersPage(attempt + 1);
    }, 2000);
    return;
  }

  const row = findMatchingOrderRowByOrderNumber(meta.orderNumber);

  if (!row) {
    setTimeout(() => {
      handleInstantOrderOrdersPage(attempt + 1);
    }, 1000);
    return;
  }

  console.log("🔥 Instant order row found, opening detail page");
  clickOrderRowForDetail(row);

  setTimeout(async () => {
    if (/^\/buying\/\d+/.test(window.location.pathname)) {
      console.log("✅ Instant order navigated to detail page");

      if (await stopIfNeeded("after instant order detail navigation")) return;

      handleInstantOrderDetailPage();
      return;
    }

    console.log("🔥 Instant order detail navigation not visible yet, waiting...");
  }, 1200);

  return;
}

async function handleInstantOrderDetailPage(attempt = 0) {
  console.log("🔥 Handling instant order - detail page");

  const meta = await getPendingInstantOrderMeta();

  if (!meta?.orderNumber) {
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Missing instant order meta on detail page"
    });
    return;
  }

  if (attempt > 12) {
    await clearPendingInstantOrderMeta();
    reportTaskResult("VERIFY_FAILED", {
      errorMessage: "Could not extract price for instant order"
    });
    return;
  }

  const rawText = document.body?.innerText || "";
  const pageText = normalizeText(rawText);

  if (!pageText.includes("summary") || !pageText.includes("total")) {
    setTimeout(() => {
      handleInstantOrderDetailPage(attempt + 1);
    }, 1000);
    return;
  }

  const finalStockXPrice = extractFinalStockXPriceFromText(rawText);

  if (!Number.isFinite(finalStockXPrice)) {
    setTimeout(() => {
      handleInstantOrderDetailPage(attempt + 1);
    }, 1000);
    return;
  }

  console.log("✅ Instant order complete:", {
    orderNumber: meta.orderNumber,
    finalStockXPrice
  });

  currentTask = {
    recordId: meta.recordId,
    type: meta.resultAction === "FIRST_ORDER_PLACED"
      ? "PLACE_OR_BUY_WITH_SECOND_BID_CHECK"
      : "PLACE_OR_UPDATE",
    maxBid: null
  };

  await chrome.storage.local.set({ currentTask });

  await clearPendingInstantOrderMeta();

  reportTaskResult(meta.resultAction || "ORDER_PLACED_WITH_DETAILS", {
    orderNumber: meta.orderNumber,
    finalStockXPrice,
    firstBuyNowPrice: meta.firstBuyNowPrice || null
  });

  return;
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

    if (text.includes("size:")) return false;

    return text === normalizedTarget || text === `eu ${normalizedTarget}`;
  });

  if (candidates.length === 0) {
    console.log("REMOVE: size option not found yet, retrying...");
    setTimeout(() => selectSizeFromDropdownForRemove(targetSize), 1000);
    return;
  }

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
    reportTaskResult(getRemoveNotFoundAction(), {
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

  const updateEl = candidates.sort(
    (a, b) =>
      a.getBoundingClientRect().width * a.getBoundingClientRect().height -
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
    reportTaskResult(getRemoveFailedAction(), {
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
    (pageText.includes("bid") && pageText.includes("sell faster"));

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
    reportTaskResult(getRemoveFailedAction(), {
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
    reportTaskResult(getRemoveFailedAction(), {
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
    reportTaskResult(getRemoveFailedAction(), {
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
    reportTaskResult(getRemoveFailedAction(), {
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
    reportTaskResult(getRemoveSuccessAction());
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

  if (slug.startsWith("buy/")) {
    slug = slug.replace(/^buy\//, "");
  }

  const offerUrl = `https://stockx.com/buy/${slug}?defaultBid=true`;

  console.log("🔥 Navigating directly to buy page:", offerUrl);
  window.location.href = offerUrl;
}

function findBuyNowSizeTile(targetSize) {
  const normalizedTarget = normalizeText(targetSize);

  const candidates = Array.from(
    document.querySelectorAll("button, [role='button'], li, div")
  ).filter((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    const hasSize =
      text.includes(`eu ${normalizedTarget}`) ||
      text === normalizedTarget ||
      text.includes(` ${normalizedTarget} `);

    const hasPrice = /€\s*\d+/.test(el.innerText || "");

    return hasSize && hasPrice;
  });

  if (candidates.length === 0) return null;

  return candidates.sort((a, b) => {
    const aText = normalizeText(a.innerText);
    const bText = normalizeText(b.innerText);
    return aText.length - bText.length;
  })[0];
}

function extractBuyNowFromSizeTile(tile) {
  if (!tile) return null;

  const text = tile.innerText || "";
  const match = text.match(/€\s*([\d.,]+)/);

  if (!match?.[1]) return null;

  return parseMoneyValue(match[1]);
}

function handleInitialSecondBidBuyCheckPage(attempt = 0) {
  if (!currentTask) return;

  if (attempt > 20) {
    reportTaskResult("BID_UPDATE_FAILED", {
      errorMessage: "Could not find Buy Now price for second bid flow check"
    });
    return;
  }

  const startBid = Number(currentTask.startBid);
  const maxBid = Number(currentTask.maxBid);

  if (!Number.isFinite(startBid) || !Number.isFinite(maxBid)) {
    reportTaskResult("BID_UPDATE_FAILED", {
      errorMessage: "Missing valid startBid or maxBid for second bid flow check"
    });
    return;
  }

  const tile = findBuyNowSizeTile(currentTask.size);

  if (!tile) {
    console.log("Second flow: size tile with Buy Now price not found yet, retrying...");
    setTimeout(() => handleInitialSecondBidBuyCheckPage(attempt + 1), 800);
    return;
  }

  const buyNowPrice = extractBuyNowFromSizeTile(tile);

  if (!Number.isFinite(buyNowPrice)) {
    console.log("Second flow: Buy Now price not parsed yet, retrying...");
    setTimeout(() => handleInitialSecondBidBuyCheckPage(attempt + 1), 800);
    return;
  }

  console.log("Second flow Buy Now check:", {
    size: currentTask.size,
    buyNowPrice,
    startBid,
    maxBid
  });

  if (buyNowPrice <= maxBid) {
    console.log("✅ Buy Now is within range, buying instantly");

    currentTask.firstBuyNowPrice = buyNowPrice;
    chrome.storage.local.set({ currentTask });

    clickElement(tile);

    setTimeout(() => {
      waitForReviewOrderEnabledForInstantBuy();
    }, 1800);

    return;
  }

  console.log("Buy Now not within range, falling back to normal bid flow");

  currentTask = {
    ...currentTask,
    type: "PLACE_OR_UPDATE",
    maxBid: startBid,
    currentBid: null
  };

  chrome.storage.local.set({ currentTask });

  const url = new URL(window.location.href);
  if (!url.searchParams.get("defaultBid")) {
    url.searchParams.set("defaultBid", "true");
    window.location.href = url.toString();
    return;
  }

  handleBuyPage();
}

function waitForReviewOrderEnabledForInstantBuy(attempt = 0) {
  if (attempt > 25) {
    reportTaskResult("BID_UPDATE_FAILED", {
      errorMessage: "Buy Now option / Review Order button not found for instant Buy Now"
    });
    return;
  }

  const expectedBuyNow = Number(currentTask?.firstBuyNowPrice);

  const buyNowOption = Array.from(
    document.querySelectorAll("button, [role='button'], div")
  ).find((el) => {
    const text = normalizeText(el.innerText);
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    if (!text) return false;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (rect.width <= 0 || rect.height <= 0) return false;

    const price = parseMoneyValue(el.innerText || "");

    return (
      text.includes("buy now") &&
      Number.isFinite(price) &&
      Number.isFinite(expectedBuyNow) &&
      Math.floor(price) === Math.floor(expectedBuyNow)
    );
  });

  if (buyNowOption) {
    console.log("🔥 Clicking Buy Now pricing option:", buyNowOption.innerText);
    clickElement(buyNowOption);

    setTimeout(() => {
      waitForReviewOrderEnabledAfterBuyNowOption(attempt + 1);
    }, 1500);

    return;
  }

  console.log("Buy Now pricing option not found yet, retrying...");
  setTimeout(() => waitForReviewOrderEnabledForInstantBuy(attempt + 1), 1000);
}

function waitForReviewOrderEnabledAfterBuyNowOption(attempt = 0) {
  if (attempt > 20) {
    reportTaskResult("BID_UPDATE_FAILED", {
      errorMessage: "Review Order button not found after selecting Buy Now option"
    });
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  const btn = buttons.find((b) => {
    const text = normalizeText(b.innerText);
    return text.includes("review order") || text.includes("review purchase");
  });

  if (!btn) {
    console.log("Review Order button not found yet after Buy Now option, retrying...");
    setTimeout(() => waitForReviewOrderEnabledAfterBuyNowOption(attempt + 1), 1000);
    return;
  }

  const isDisabled =
    btn.disabled ||
    btn.getAttribute("aria-disabled") === "true";

  if (isDisabled) {
    console.log("Review Order button still disabled, waiting...");
    setTimeout(() => waitForReviewOrderEnabledAfterBuyNowOption(attempt + 1), 1000);
    return;
  }

  console.log("✅ Review Order button enabled:", btn.innerText);
  clickElement(btn);

  setTimeout(() => {
    clickConfirmBid();
  }, 2500);
}

function handleBuyPage(attempt = 0) {
  if (!currentTask) {
    console.log("No currentTask available on buy page");
    return;
  }

  if (!isPlaceBidTaskType(currentTask.type)) {
    console.log("Buy page skipped: not a place bid task");
    return;
  }

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
    reportTaskResult(getBidFailureAction(), {
      errorMessage: "BUY page size not found after multiple attempts"
    });
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

  return String(Math.floor(num));
}

function getPlaceOrUpdateSuccessAction() {
  const raw = currentTask?.currentBid;

  if (raw === null || raw === undefined || raw === "") {
    return "BID_CREATED";
  }

  const currentBid = Number(raw);
  return Number.isFinite(currentBid) ? "BID_UPDATED" : "BID_CREATED";
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
    reportTaskResult(getBidFailureAction(), {
      errorMessage: "Could not find bid input after multiple attempts"
    });
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
    reportTaskResult(getBidFailureAction(), {
      errorMessage: "No valid bid value available on task"
    });
    return;
  }

  console.log("🔥 Filling bid price:", bidValue);

  input.focus();

  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, "");
  } else {
    input.value = "";
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("blur", { bubbles: true }));

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
    reportTaskResult(getBidFailureAction(), {
      errorMessage: "Review button never became enabled"
    });
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
    reportTaskResult(getBidFailureAction(), {
      errorMessage: "Review button not found after multiple attempts"
    });
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
    reportTaskResult(getBidFailureAction(), {
      errorMessage: "Confirm/Place button not found after multiple attempts"
    });
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

  const submittedBid =
    currentTask?.maxBid !== undefined && currentTask?.maxBid !== null
      ? Number(formatBidValue(currentTask.maxBid))
      : null;

  const payload = {
    recordId: currentTask.recordId,
    type: currentTask.type,
    maxBid: submittedBid,
    intendedSecondBid: currentTask?.intendedSecondBid ?? null,
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
      if (chrome.runtime.lastError) {
        console.warn("TASK_COMPLETED message failed:", chrome.runtime.lastError.message);

        setTimeout(() => {
          chrome.runtime.sendMessage({
            type: "WAKE_RUNNER"
          });
        }, 1000);

        return;
      }

      console.log("Backend result response:", response);

      setTimeout(() => {
        chrome.runtime.sendMessage({
          type: "WAKE_RUNNER"
        });
      }, 1000);
    }
  );
}

async function waitForFinalOutcome(finalButtonText = "", attempt = 0) {
  if (attempt > 20) {
    console.log("Final outcome not detected after multiple attempts");

    const normalized = String(finalButtonText || "").trim().toLowerCase();

    if (normalized.includes("place order")) {
      const instantAction = getInstantOrderAction();
    
      if (instantAction === "ORDER_PLACED_WITH_DETAILS") {
        reportTaskResult("ORDER_PLACED_FALLBACK", {
          errorMessage: "No success/failure screen detected after Place Order"
        });
      } else {
        reportTaskResult(getBidFailureAction(), {
          errorMessage: "No success/failure screen detected after Place Order"
        });
      }
    
      return;
    }

    if (normalized.includes("confirm bid")) {
      reportTaskResult(getBidFailureAction(), {
        errorMessage: "No success/failure screen detected after Confirm Bid"
      });
      return;
    }

    return;
  }

  const pageText = getPageText();

  if (
    pageText.includes("your order has been placed successfully") ||
    pageText.includes("congratulations! your order has been placed successfully") ||
    pageText.includes("order confirmed") ||
    (pageText.includes("your order total is") && pageText.includes("order #"))
  ) {
    console.log("✅ Order success page detected");

    const rawText = document.body?.innerText || "";
    const orderNumber = extractOrderNumberFromText(rawText);

    if (!orderNumber) {
      console.log("❌ Could not extract order number from success page");

      const instantAction = getInstantOrderAction();

      if (instantAction === "ORDER_PLACED_WITH_DETAILS") {
        reportTaskResult("ORDER_PLACED_FALLBACK", {
          errorMessage: "Success page but no order number found"
        });
      } else {
        reportTaskResult(getBidFailureAction(), {
          errorMessage: "Success page but no order number found"
        });
      }
      return;
    }

    console.log("📦 Extracted order number from success page:", orderNumber);

    await chrome.storage.local.set({
      pendingInstantOrderMeta: {
        orderNumber,
        recordId: currentTask.recordId,
        resultAction: getInstantOrderAction(),
        firstBuyNowPrice: currentTask.firstBuyNowPrice || null
      }
    });

    currentTask = null;
    await chrome.storage.local.remove("currentTask");

    window.location.href = "https://stockx.com/buying/orders";
    return;
  }

  if (
    pageText.includes("your bid is live") ||
    (pageText.includes("success") && pageText.includes("your bid"))
  ) {
    console.log("✅ Bid success page detected");
    reportTaskResult(getBidSuccessAction());
    return;
  }

  if (
    pageText.includes("there was an error with your payment method") ||
    pageText.includes("please enter a new payment method and try again") ||
    pageText.includes("payment method")
  ) {
    console.log("❌ Payment failure / no funds detected");
    reportTaskResult(
      currentTask?.type === "PLACE_SECOND_BID" ? "SECOND_BID_FAILED" : "NO_FUNDS",
      {
        errorMessage: "Payment method declined or insufficient balance"
      }
    );
    return;
  }

  console.log("Waiting for final outcome...");
  setTimeout(() => {
    waitForFinalOutcome(finalButtonText, attempt + 1);
  }, 1500);
}
