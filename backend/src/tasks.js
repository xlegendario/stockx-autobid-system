import { resolveStockxUrlBySku } from "./retailed.js";

function isVerifyCandidate(fields) {
  return (
    hasBidPlaced(fields) &&
    !needsBid(fields) &&
    !needsRemoval(fields)
  );
}

function isReadyForVerify(fields, cooldownMinutes = 10) {
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

function hasBidPlaced(fields) {
  const raw = fields["BidPlaced"];

  if (raw === true) return true;
  if (raw === 1) return true;
  if (raw === "1") return true;

  return false;
}

function getRunner(fields) {
  return normalizeRunner(fields["Merchant StockX Runner Name"]);
}

function needsBid(fields) {
  return Number(fields["Needs StockX Bid"]) === 1;
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

  const target = getCurrentStockXBid(fields);
  const current = getCurrentBid(fields);

  if (target === null) return false;
  if (current === null) return true;

  return target > current;
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

function getBlockingKey(fields) {
  const accountGroup = getAccountGroupKey(fields);
  const sku = getSku(fields);
  const size = fields["Size"];

  return `${accountGroup}|${sku}|${size}`;
}

export async function buildTask(records, runnerName, activeBidRecords = [], requestedAccountGroupKey = null) {
  const normalizedRequestedRunner = normalizeRunner(runnerName);
  const activeBidKeys = new Set(
    activeBidRecords
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
  
    if (!shouldPlaceOrUpdate(f) && !needsRemoval(f)) return false;
  
    // Block alleen echte nieuwe placements
    if (shouldPlaceOrUpdate(f) && !hasBidPlaced(f)) {
      const key = getBlockingKey(f);
      if (activeBidKeys.has(key)) return false;
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

  const placeCandidates = [];
  const removeCandidates = [];
  const verifyCandidates = [];

  for (const key of Object.keys(groups)) {
    const group = groups[key];

    const firstRemove = group.find((record) => needsRemoval(record.fields));
    if (firstRemove) {
      removeCandidates.push(firstRemove);
      continue;
    }
    
    const firstPlace = group.find((record) => shouldPlaceOrUpdate(record.fields));
    if (firstPlace) {
      placeCandidates.push(firstPlace);
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

  const chosenRemove =
    removeCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];
  
  if (chosenRemove) {
    const fields = chosenRemove.fields;
    const sku = getSku(fields);
    const size = fields["Size"];
  
    let stockxUrl = fields["StockX URL"] || null;
  
    if (!stockxUrl) {
      try {
        const resolved = await resolveStockxUrlBySku(sku);
        stockxUrl = resolved.stockxUrl;
      } catch {
        stockxUrl = null;
      }
    }
  
    return {
      type: "REMOVE",
      recordId: chosenRemove.id,
      sku,
      size,
      stockxUrl
    };
  }
  
  const chosenPlace =
    placeCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];
  
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
  
    return {
      type: "PLACE_OR_UPDATE",
      recordId: chosenPlace.id,
      sku,
      size,
      maxBid,
      currentBid: getCurrentBid(fields),
      stockxUrl
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
  
  return null;
}
