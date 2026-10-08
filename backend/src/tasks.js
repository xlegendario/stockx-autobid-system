import { resolveStockxUrlBySku } from "./stockx.js";
import { updateOrder } from "./airtable.js";

import {
  isInitialSecondBidFlowCandidate,
  buildInitialSecondBidFlowTask,
  isSecondBidPlaceOrUpdateCandidate,
  buildSecondBidTask,
  isSecondBidRemoveCandidate,
  buildSecondBidRemoveTask,
  isSecondBidVerifyCandidate,
  buildSecondBidVerifyTask,
  isSecondOrderSyncCandidate,
  buildSecondOrderSyncTask
} from "./secondTasks.js";

function isVerifyCandidate(fields) {
  return (
    hasBidPlaced(fields) &&
    !needsBid(fields) &&
    !needsRemoval(fields)
  );
}

function isReadyForVerify(fields, cooldownMinutes = 60) {
  if (!isVerifyCandidate(fields)) return false;

  const raw = fields["LastSyncAt"];
  if (!raw) return true;

  const lastSync = new Date(raw);
  if (Number.isNaN(lastSync.getTime())) return true;

  const cooldownMs = cooldownMinutes * 60 * 1000;
  return Date.now() - lastSync.getTime() >= cooldownMs;
}

function getLastSyncTimestamp(fields) {
  const raw = fields["LastSyncAt"];
  if (!raw) return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.getTime();
}

function normalizeLookup(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeRunner(value) {
  const raw = normalizeLookup(value);

  if (raw === undefined || raw === null) return null;

  return String(raw).trim().toLowerCase();
}

function isAutobidEnabled(fields) {
  const val = fields["Merchant StockX Autobid Enabled"];

  if (val === undefined || val === null || val === "") return false;

  if (Array.isArray(val)) {
    if (val.length === 0) return false;
    const v = val[0];
    return v === true || v === 1 || v === "1" || v === "true";
  }

  return val === true || val === 1 || val === "1" || val === "true";
}

/*
 * "StockX Instant Buy" on the merchant: on a first placement, buy outright
 * when Buy Now is at or under Max StockX Bid instead of only under the start
 * bid. Not once a bid of ours is live - buying then would leave that bid on
 * StockX for a seller to accept, and the pair would be bought twice.
 */
function getInstantBuyCeiling(fields) {
  if (!isTruthyLookup(fields["Merchant StockX Instant Buy"])) return null;
  if (hasBidPlaced(fields)) return null;

  return parseMoney(fields["Max StockX Bid"]);
}

function isTruthyLookup(value) {
  const raw = normalizeLookup(value);
  return raw === true || raw === 1 || raw === "1" || String(raw).trim().toLowerCase() === "true";
}

function hasBidPlaced(fields) {
  const raw = fields["BidPlaced"];

  if (raw === true) return true;
  if (raw === 1) return true;
  if (raw === "1") return true;

  return false;
}

function hasSecondBidPlaced(fields) {
  const raw = fields["SecondBidPlaced"];

  if (raw === true) return true;
  if (raw === 1) return true;
  if (raw === "1") return true;

  return false;
}

function wasRecentlyVerifiedForBidUpdate(fields, minutes = 10) {
  const lastAction = String(fields["LastAction"] || "").trim();
  if (lastAction !== "BID_VERIFIED_STILL_LIVE") return false;

  const raw = fields["LastSyncAt"];
  if (!raw) return false;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return false;

  return Date.now() - parsed.getTime() < minutes * 60 * 1000;
}

function wasRecentlyVerifiedForSecondBidUpdate(fields, minutes = 10) {
  const secondLastAction = String(fields["SecondLastAction"] || "").trim();
  if (secondLastAction !== "SECOND_BID_VERIFIED_STILL_LIVE") return false;

  const raw = fields["LastSyncAt"];
  if (!raw) return false;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return false;

  return Date.now() - parsed.getTime() < minutes * 60 * 1000;
}

function isBidInProgress(fields) {
  const lastAction = String(fields["LastAction"] || "").trim();

  if (lastAction !== "BID_IN_PROGRESS") return false;

  const rawLastSync = fields["LastSyncAt"];
  const lastSync = rawLastSync ? new Date(rawLastSync) : null;

  if (!lastSync || Number.isNaN(lastSync.getTime())) return true;

  return Date.now() - lastSync.getTime() < 10 * 60 * 1000;
}

function getRunner(fields) {
  return normalizeRunner(fields["Merchant StockX Runner Name"]);
}

function needsBid(fields) {
  return Number(fields["Needs StockX Bid"]) === 1;
}

function needsBidCalculation(fields) {
  return Number(fields["Needs Bid Calculation"]) === 1;
}

function getTargetBuyingPrice(fields) {
  return parseMoney(fields["Target Buying Price"]);
}

function getMaximumBuyingPrice(fields) {
  return parseMoney(fields["Maximum Buying Price"]);
}

function getClientVatRate(fields) {
  const raw = fields["Client VAT Rate"];
  const parsed = Number(normalizeLookup(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function getMerchantVatFlow(fields) {
  const raw = normalizeLookup(fields["Merchant StockX VAT Flow"]);
  return String(raw || "").trim().toUpperCase();
}

function getLojiqMargin(fields) {
  const raw = normalizeLookup(
    fields["Lojiq StockX Margin?"] ??
    fields["Lojiq Stockx Margin?"]
  );

  return (
    raw === true ||
    raw === 1 ||
    raw === "1" ||
    String(raw || "").trim().toLowerCase() === "true" ||
    String(raw || "").trim() === "✓" ||
    String(raw || "").trim() === "✔"
  );
}

function hasRequiredCalculationInputs(fields) {
  return (
    Number.isFinite(getTargetBuyingPrice(fields)) &&
    Number.isFinite(getMaximumBuyingPrice(fields)) &&
    Number.isFinite(getClientVatRate(fields)) &&
    ["VAT", "MARGIN"].includes(getMerchantVatFlow(fields))
  );
}

function needsBidUpdate(fields) {
  return Number(fields["Needs StockX Bid Update"]) === 1;
}

function needsPlaceOrUpdate(fields) {
  return needsBid(fields) || needsBidUpdate(fields);
}

function needsRemoval(fields) {
  return Number(fields["Needs StockX Removal"]) === 1 && hasBidPlaced(fields);
}

function getSku(fields) {
  return fields["SKU (Soft)"] || fields["SKU"];
}

function parseMoney(raw) {
  if (raw === null || raw === undefined || raw === "") return null;

  if (typeof raw === "number") return raw;

  const cleaned = String(raw).replace(/[^\d.,-]/g, "").replace(",", ".");
  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
}

function getMaxBid(fields) {
  return parseMoney(
    fields["Current StockX Bid"] ??
    fields["Current stockx bid"] ??
    null
  );
}

function getCurrentStockXBid(fields) {
  return parseMoney(
    fields["Current StockX Bid"] ??
    fields["Current stockx bid"] ??
    null
  );
}

function getCurrentBid(fields) {
  return parseMoney(fields["CurrentBid"] ?? null);
}

function shouldPlaceOrUpdate(fields) {
  if (needsRemoval(fields)) return false;
  if (isBidInProgress(fields)) return false;

  const target = getCurrentStockXBid(fields);
  const current = getCurrentBid(fields);

  if (target === null) return false;
  if (current === null) return true;

  return target > current;
}

function needsOrderSync(fields) {
  return Number(fields["Needs StockX Order Sync"]) === 1;
}

function getStockxOrderNumber(fields) {
  const raw = fields["StockX Order Number"];
  if (raw === undefined || raw === null) return null;

  const value = String(normalizeLookup(raw) || "").trim();
  return value || null;
}

function getLastOrderSyncTimestamp(fields) {
  const raw = fields["LastOrderSyncAt"];
  if (!raw) return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed.getTime();
}

function getAccountGroupKey(fields) {
  const raw = normalizeLookup(fields["Merchant StockX Account Group Key"]);

  if (raw === undefined || raw === null || raw === "") {
    // fallback als lookup leeg is
    return getRunner(fields);
  }

  return String(raw).trim().toLowerCase();
}

function getGroupKey(fields) {
  const accountGroup = getAccountGroupKey(fields);
  const sku = getSku(fields);
  const size = fields["Size"];

  return `${accountGroup}|${sku}|${size}`;
}

export function debugRecords(records, runnerName) {
  const normalizedRequestedRunner = normalizeRunner(runnerName);

  return records.map((record) => {
    const f = record.fields;

    return {
      recordId: record.id,
      orderId: f["Order ID"] || null,
      sku: getSku(f),
      size: f["Size"] || null,
      fulfillmentStatus: f["Fulfillment Status"] || null,
      runnerParsed: getRunner(f),
      accountGroupParsed: getAccountGroupKey(f),
      blockingKey: getBlockingKey(f),
      requestedRunner: normalizedRequestedRunner,
      runnerMatches: getRunner(f) === normalizedRequestedRunner,
      autobidParsed: isAutobidEnabled(f),
      bidPlacedParsed: hasBidPlaced(f),
      needsBidParsed: needsBid(f),
      needsRemovalParsed: needsRemoval(f),
      currentBidParsed: getCurrentBid(f),
      currentStockXBidParsed: getCurrentStockXBid(f),
      shouldPlaceOrUpdateParsed: shouldPlaceOrUpdate(f),
      included:
        isAutobidEnabled(f) &&
        getRunner(f) === normalizedRequestedRunner &&
        (shouldPlaceOrUpdate(f) || needsRemoval(f))
    };
  });
}

/*
 * Orders from before the runner's MIN_ORDER_DATE get no new work: no limit
 * calculation, no first bid, no bid raise. StockX lead times make a pair for
 * an old order pointless. Removing, verifying and syncing still happen, so
 * bids already out there are cleaned up as before.
 */
function isBeforeMinOrderDate(record, minOrderDate) {
  if (!minOrderDate) return false;

  const raw = record.fields["Order Date"] || record.createdTime;
  const orderDate = new Date(raw);

  if (Number.isNaN(orderDate.getTime())) return false;

  return orderDate < minOrderDate;
}

function getBlockingKey(fields) {
  const accountGroup = getAccountGroupKey(fields);
  const sku = getSku(fields);
  const size = fields["Size"];

  return `${accountGroup}|${sku}|${size}`;
}

export async function buildTask(
  records,
  runnerName,
  activeBidRecords = [],
  requestedAccountGroupKey = null,
  orderSyncRecords = [],
  secondActiveBidRecords = [],
  secondOrderSyncRecords = [],
  minOrderDate = null
) {
  const normalizedRequestedRunner = normalizeRunner(runnerName);
  const activeBidKeys = new Set(
    activeBidRecords
      .map((record) => getBlockingKey(record.fields))
      .filter(Boolean)
  );

  const secondActiveBidKeys = new Set(
    secondActiveBidRecords
      .map((record) => getBlockingKey(record.fields))
      .filter(Boolean)
  );

  const inProgressBidKeys = new Set(
    records
      .filter((record) => isBidInProgress(record.fields))
      .map((record) => getBlockingKey(record.fields))
      .filter(Boolean)
  );

  const filtered = records.filter((r) => {
    const f = r.fields;

    if (!isAutobidEnabled(f)) return false;

    const runner = getRunner(f);
    const accountGroup = getAccountGroupKey(f);
    const accountMode = String(normalizeLookup(f["Merchant StockX Account Mode"]) || "").trim().toUpperCase();

    // MAIN_ACCOUNT records route by account group
    if (accountMode === "MAIN_ACCOUNT") {
      if (!requestedAccountGroupKey || accountGroup !== requestedAccountGroupKey) {
        return false;
      }
    } else {
      // DEDICATED_ACCOUNT route by runner
      if (runner !== normalizedRequestedRunner) {
        return false;
      }
    }

    const takesNewWork = !isBeforeMinOrderDate(r, minOrderDate);

    const canCalculateLimits = takesNewWork && needsBidCalculation(f);

    const canPlaceOrUpdate = takesNewWork && needsPlaceOrUpdate(f) && shouldPlaceOrUpdate(f);

    const canSecondFlow =
      (takesNewWork && isInitialSecondBidFlowCandidate(f)) ||
      isSecondBidPlaceOrUpdateCandidate(f) ||
      isSecondBidRemoveCandidate(f);
    
    if (canSecondFlow && isBidInProgress(f)) return false;

    if (!canCalculateLimits && !canPlaceOrUpdate && !needsRemoval(f) && !canSecondFlow) return false;

    // Block alleen echte nieuwe placements
    if (canPlaceOrUpdate && !hasBidPlaced(f)) {
      const key = getBlockingKey(f);
    
      if (activeBidKeys.has(key)) return false;
      if (secondActiveBidKeys.has(key)) return false;
      if (inProgressBidKeys.has(key)) return false;
    }

    return true;
  });

  const groups = {};

  for (const record of filtered) {
    const key = getGroupKey(record.fields);
    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }

  Object.values(groups).forEach((group) => {
    group.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
  });

  const calculationCandidates = [];
  const newPlaceCandidates = [];
  const updatePlaceCandidates = [];
  const removeCandidates = [];
  const verifyCandidates = [];
  const orderSyncCandidates = [];

  const initialSecondBidFlowCandidates = [];
  const secondBidPlaceCandidates = [];
  const secondBidRemoveCandidates = [];
  const secondBidVerifyCandidates = [];
  const secondOrderSyncCandidates = [];

  for (const key of Object.keys(groups)) {
    const group = groups[key];

    const firstRemove = group.find((record) => needsRemoval(record.fields));
    if (firstRemove) {
      removeCandidates.push(firstRemove);
      continue;
    }

    const firstSecondRemove = group.find((record) =>
      isSecondBidRemoveCandidate(record.fields)
    );
    if (firstSecondRemove) {
      secondBidRemoveCandidates.push(firstSecondRemove);
      continue;
    }

    const firstCalculation = group.find((record) =>
      !isBeforeMinOrderDate(record, minOrderDate) &&
      needsBidCalculation(record.fields)
    );
    if (firstCalculation) {
      calculationCandidates.push(firstCalculation);
      continue;
    }

    const firstSecondPlace = group.find((record) =>
      isSecondBidPlaceOrUpdateCandidate(record.fields)
    );
    
    if (firstSecondPlace) {
      const f = firstSecondPlace.fields;
    
      if (
        hasSecondBidPlaced(f) &&
        !wasRecentlyVerifiedForSecondBidUpdate(f)
      ) {
        secondBidVerifyCandidates.push(firstSecondPlace);
        continue;
      }
    
      secondBidPlaceCandidates.push(firstSecondPlace);
      continue;
    }

    const firstInitialSecondFlow = group.find((record) => {
      const f = record.fields;
    
      const stockxOrderNumber = String(normalizeLookup(f["StockX Order Number"]) || "").trim();
      const secondBidFlowStatus = String(normalizeLookup(f["Second Bid Flow Status"]) || "").trim();
      const lastAction = String(f["LastAction"] || "").trim();
    
      if (stockxOrderNumber) return false;
      if (secondBidFlowStatus) return false;
      if (lastAction === "FIRST_ORDER_PLACED") return false;
      if (isBeforeMinOrderDate(record, minOrderDate)) return false;

      return isInitialSecondBidFlowCandidate(f);
    });
    if (firstInitialSecondFlow) {
      initialSecondBidFlowCandidates.push(firstInitialSecondFlow);
      continue;
    }

    const firstNewPlace = group.find((record) => {
      const f = record.fields;
      if (isBeforeMinOrderDate(record, minOrderDate)) return false;
      return needsBid(f) && !hasBidPlaced(f) && shouldPlaceOrUpdate(f);
    });

    if (firstNewPlace) {
      newPlaceCandidates.push(firstNewPlace);
      continue;
    }

    const firstUpdatePlace = group.find((record) => {
      const f = record.fields;
      if (isBeforeMinOrderDate(record, minOrderDate)) return false;
      return needsBidUpdate(f) && shouldPlaceOrUpdate(f);
    });

    if (firstUpdatePlace) {
      const f = firstUpdatePlace.fields;
    
      if (
        hasBidPlaced(f) &&
        !wasRecentlyVerifiedForBidUpdate(f)
      ) {
        verifyCandidates.push(firstUpdatePlace);
        continue;
      }
    
      updatePlaceCandidates.push(firstUpdatePlace);
    }
  }

  for (const record of activeBidRecords) {
    const f = record.fields;

    if (!isAutobidEnabled(f)) continue;

    const runner = getRunner(f);
    const accountGroup = getAccountGroupKey(f);
    const accountMode = String(normalizeLookup(f["Merchant StockX Account Mode"]) || "").trim().toUpperCase();

    if (accountMode === "MAIN_ACCOUNT") {
      if (!requestedAccountGroupKey || accountGroup !== requestedAccountGroupKey) {
        continue;
      }
    } else {
      if (runner !== normalizedRequestedRunner) {
        continue;
      }
    }

    if (!isReadyForVerify(f)) continue;

    verifyCandidates.push(record);
  }

  for (const record of secondActiveBidRecords) {
    const f = record.fields;

    if (!isAutobidEnabled(f)) continue;

    const runner = getRunner(f);
    const accountGroup = getAccountGroupKey(f);
    const accountMode = String(normalizeLookup(f["Merchant StockX Account Mode"]) || "").trim().toUpperCase();

    if (accountMode === "MAIN_ACCOUNT") {
      if (!requestedAccountGroupKey || accountGroup !== requestedAccountGroupKey) {
        continue;
      }
    } else {
      if (runner !== normalizedRequestedRunner) {
        continue;
      }
    }

    if (!isSecondBidVerifyCandidate(f)) continue;

    secondBidVerifyCandidates.push(record);
  }

  for (const record of orderSyncRecords) {
    const f = record.fields;

    const runner = getRunner(f);
    const accountGroup = getAccountGroupKey(f);
    const accountMode = String(normalizeLookup(f["Merchant StockX Account Mode"]) || "").trim().toUpperCase();

    if (accountMode === "MAIN_ACCOUNT") {
      if (!requestedAccountGroupKey || accountGroup !== requestedAccountGroupKey) {
        continue;
      }
    } else {
      if (runner !== normalizedRequestedRunner) {
        continue;
      }
    }

    if (!needsOrderSync(f)) continue;

    const orderNumber = getStockxOrderNumber(f);
    if (!orderNumber) continue;

    orderSyncCandidates.push(record);
  }

  for (const record of secondOrderSyncRecords) {
    const f = record.fields;

    const runner = getRunner(f);
    const accountGroup = getAccountGroupKey(f);
    const accountMode = String(normalizeLookup(f["Merchant StockX Account Mode"]) || "").trim().toUpperCase();

    if (accountMode === "MAIN_ACCOUNT") {
      if (!requestedAccountGroupKey || accountGroup !== requestedAccountGroupKey) {
        continue;
      }
    } else {
      if (runner !== normalizedRequestedRunner) {
        continue;
      }
    }

    if (!isSecondOrderSyncCandidate(f)) continue;

    secondOrderSyncCandidates.push(record);
  }

  /*
   * Removals go by last attempt, not by order age. A removal that fails is
   * tried again (a bid that may still be live must not be written off), and
   * oldest-order-first handed that same failing removal out every round:
   * on 08-10-2026 ORD-027057 held the SneakerAsk runner for six hours while
   * 30 other bids on fulfilled orders stayed live. Its LastSyncAt moves on
   * each attempt, so now it goes to the back and the rest get their turn.
   */
  const byLastAttempt = (a, b) => {
    const aLast = getLastSyncTimestamp(a.fields);
    const bLast = getLastSyncTimestamp(b.fields);

    if (aLast !== bLast) {
      if (aLast === null) return -1;
      if (bLast === null) return 1;
      return aLast - bLast;
    }

    return new Date(a.createdTime) - new Date(b.createdTime);
  };

  const chosenRemove = removeCandidates.sort(byLastAttempt)[0];

  if (chosenRemove) {
    const fields = chosenRemove.fields;
    const sku = getSku(fields);
    const size = fields["Size"];

    let stockxUrl = fields["StockX URL"] || null;

    if (!stockxUrl) {
      try {
        const resolved = await resolveStockxUrlBySku(sku);
        stockxUrl = resolved.stockxUrl;
      } catch (err) {
        console.error("❌ Failed to resolve StockX URL", {
          sku,
          error: err.message
        });
        stockxUrl = null;
      }
    }

    return {
      type: "REMOVE",
      recordId: chosenRemove.id,
      sku,
      size,
      // Only used to tell two bids on one size apart on Offers & Bids.
      currentBid: getCurrentBid(fields),
      stockxUrl
    };
  }

  const chosenSecondRemove = secondBidRemoveCandidates.sort(byLastAttempt)[0];

  if (chosenSecondRemove) {
    return await buildSecondBidRemoveTask(chosenSecondRemove);
  }

  const chosenCalculation =
    calculationCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];

  if (chosenCalculation) {
    const fields = chosenCalculation.fields;
    const sku = getSku(fields);
    const size = fields["Size"];

    let stockxUrl = fields["StockX URL"] || null;

    if (!stockxUrl) {
      try {
        const resolved = await resolveStockxUrlBySku(sku);
        stockxUrl = resolved.stockxUrl;
      } catch (err) {
        console.error("❌ Failed to resolve StockX URL for limit calculation", {
          sku,
          error: err.message
        });
        stockxUrl = null;
      }
    }

    if (!hasRequiredCalculationInputs(fields)) {
      await updateOrder(chosenCalculation.id, {
        LastAction: "STOCKX_LIMITS_CALCULATION_FAILED",
        LastSyncAt: new Date().toISOString(),
        ErrorMessage: "Missing Target Buying Price / Maximum Buying Price / Client VAT Rate / Merchant StockX VAT Flow"
      });

      return null;
    }

    return {
      type: "CALCULATE_STOCKX_LIMITS",
      recordId: chosenCalculation.id,
      sku,
      size,
      stockxUrl,
      targetBuyingPrice: getTargetBuyingPrice(fields),
      maximumBuyingPrice: getMaximumBuyingPrice(fields),
      clientVatRate: getClientVatRate(fields),
      merchantVatFlow: getMerchantVatFlow(fields),
      vatType: String(normalizeLookup(fields["VAT Type"]) || "").trim().toUpperCase(),
      lojiqMargin: getLojiqMargin(fields),
      lojiqMarginRaw:
        fields["Lojiq StockX Margin?"] ??
        fields["Lojiq Stockx Margin?"],
      merchantVatFlowRaw: fields["Merchant StockX VAT Flow"]
    };
  }

  const chosenSecondPlace =
    secondBidPlaceCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];
  
  if (chosenSecondPlace) {
    return await buildSecondBidTask(chosenSecondPlace);
  }

  const chosenInitialSecondFlow =
    initialSecondBidFlowCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];
  
  if (chosenInitialSecondFlow) {
    const previousLastAction = String(chosenInitialSecondFlow.fields["LastAction"] || "");

    await updateOrder(chosenInitialSecondFlow.id, {
      LastAction: "BID_IN_PROGRESS",
      LastSyncAt: new Date().toISOString(),
      ErrorMessage: ""
    });

    return {
      ...(await buildInitialSecondBidFlowTask(chosenInitialSecondFlow)),
      previousLastAction
    };
  }
  
  const chosenNewPlace =
    newPlaceCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];

  const chosenUpdatePlace =
    updatePlaceCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];

  const chosenPlace = chosenNewPlace || chosenUpdatePlace;

  if (chosenPlace) {
    const fields = chosenPlace.fields;
    const sku = getSku(fields);
    const size = fields["Size"];
    const maxBid = getCurrentStockXBid(fields);

    if (!Number.isFinite(maxBid)) {
      console.log("❌ Skipping PLACE_OR_UPDATE: invalid Current StockX Bid", {
        recordId: chosenPlace.id,
        sku,
        size,
        maxBid
      });
      return null;
    }

    let stockxUrl = fields["StockX URL"] || null;

    if (!stockxUrl) {
      try {
        const resolved = await resolveStockxUrlBySku(sku);
        stockxUrl = resolved.stockxUrl;
      } catch {
        stockxUrl = null;
      }
    }

    // Handed back on a runner timeout, so the record returns to the state
    // the Airtable formulas pick up instead of staying BID_IN_PROGRESS.
    const previousLastAction = String(fields["LastAction"] || "");

    await updateOrder(chosenPlace.id, {
      LastAction: "BID_IN_PROGRESS",
      LastSyncAt: new Date().toISOString(),
      ErrorMessage: ""
    });

    return {
      type: "PLACE_OR_UPDATE",
      recordId: chosenPlace.id,
      sku,
      size,
      maxBid,
      currentBid: getCurrentBid(fields),
      stockxUrl,
      previousLastAction,
      instantBuyCeiling: getInstantBuyCeiling(fields)
    };
  }

  const chosenVerify =
    verifyCandidates.sort((a, b) => {
      const aLastSync = getLastSyncTimestamp(a.fields);
      const bLastSync = getLastSyncTimestamp(b.fields);

      // Records die nog nooit gesynct zijn eerst
      if (aLastSync === null && bLastSync === null) {
        return new Date(a.createdTime) - new Date(b.createdTime);
      }

      if (aLastSync === null) return -1;
      if (bLastSync === null) return 1;

      // Daarna: oudste LastSyncAt eerst
      if (aLastSync !== bLastSync) {
        return aLastSync - bLastSync;
      }

      // Tie-breaker: oudste record eerst
      return new Date(a.createdTime) - new Date(b.createdTime);
    })[0];

  const chosenOrderSync =
    orderSyncCandidates.sort((a, b) => {
      const aLastSync = getLastOrderSyncTimestamp(a.fields);
      const bLastSync = getLastOrderSyncTimestamp(b.fields);

      if (aLastSync === null && bLastSync === null) {
        return new Date(a.createdTime) - new Date(b.createdTime);
      }

      if (aLastSync === null) return -1;
      if (bLastSync === null) return 1;

      if (aLastSync !== bLastSync) {
        return aLastSync - bLastSync;
      }

      return new Date(a.createdTime) - new Date(b.createdTime);
    })[0];

    const chosenSecondOrderSync =
      secondOrderSyncCandidates.sort((a, b) => {
        const aLastSync = getLastOrderSyncTimestamp(a.fields);
        const bLastSync = getLastOrderSyncTimestamp(b.fields);
  
        if (aLastSync === null && bLastSync === null) {
          return new Date(a.createdTime) - new Date(b.createdTime);
        }
  
        if (aLastSync === null) return -1;
        if (bLastSync === null) return 1;
  
        if (aLastSync !== bLastSync) {
          return aLastSync - bLastSync;
        }
  
        return new Date(a.createdTime) - new Date(b.createdTime);
      })[0];
  
   const chosenSecondVerify =
    secondBidVerifyCandidates.sort((a, b) => {
      const aLastSync = getLastSyncTimestamp(a.fields);
      const bLastSync = getLastSyncTimestamp(b.fields);
  
      if (aLastSync === null && bLastSync === null) {
        return new Date(a.createdTime) - new Date(b.createdTime);
      }
  
      if (aLastSync === null) return -1;
      if (bLastSync === null) return 1;
  
      if (aLastSync !== bLastSync) {
        return aLastSync - bLastSync;
      }
  
      return new Date(a.createdTime) - new Date(b.createdTime);
    })[0];
  
  if (chosenVerify) {
    const fields = chosenVerify.fields;
    const sku = getSku(fields);
    const size = fields["Size"];
  
    return {
      type: "VERIFY_BID_STATUS",
      recordId: chosenVerify.id,
      sku,
      size,
      stockxUrl: fields["StockX URL"] || null
    };
  }
  
  if (chosenSecondVerify) {
    return await buildSecondBidVerifyTask(chosenSecondVerify);
  }
  
  if (chosenOrderSync) {
    const fields = chosenOrderSync.fields;
  
    return {
      type: "SYNC_ORDER_STATUS",
      recordId: chosenOrderSync.id,
      orderNumber: getStockxOrderNumber(fields),
      stockxUrl: fields["StockX URL"] || null
    };
  }
  
  if (chosenSecondOrderSync) {
    return buildSecondOrderSyncTask(chosenSecondOrderSync);
  }
  
  return null;
}
