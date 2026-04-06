import { resolveStockxUrlBySku } from "./retailed.js";

function isVerifyCandidate(fields) {
  return (
    hasBidPlaced(fields) &&
    !needsBid(fields) &&
    !needsRemoval(fields)
  );
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

function getMaxBid(fields) {
  const raw =
    fields["Maximum Buying Price"] ??
    fields["Max Bid"] ??
    fields["Maximum Buying price"] ??
    null;

  if (raw === null || raw === undefined || raw === "") return null;

  if (typeof raw === "number") return raw;

  const cleaned = String(raw).replace(/[^\d.,-]/g, "").replace(",", ".");
  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
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
      maxBidParsed: getMaxBid(f),
      included:
        isAutobidEnabled(f) &&
        getRunner(f) === normalizedRequestedRunner &&
        (needsBid(f) || needsRemoval(f))
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
  
    if (!needsBid(f) && !needsRemoval(f)) return false;
  
    // Block new bid placement if same account-group + sku + size already has active bid
    if (needsBid(f)) {
      const key = getBlockingKey(f);
      if (activeBidKeys.has(key)) return false;
    }
  
    return true;
  });

  if (filtered.length === 0) return null;

  const groups = {};

  for (const record of filtered) {
    const key = getGroupKey(record.fields);
    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }

  // Sorteer oudste eerst binnen iedere group
  Object.values(groups).forEach((group) => {
    group.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
  });

  // Eerst alle PLACE/UPDATE candidates verzamelen
  const placeCandidates = [];
  const removeCandidates = [];
  const verifyCandidates = [];

  for (const key of Object.keys(groups)) {
    const group = groups[key];

    const firstPlace = group.find((record) => needsBid(record.fields));
    if (firstPlace) {
      placeCandidates.push(firstPlace);
      continue;
    }

    const firstRemove = group.find((record) => needsRemoval(record.fields));
    if (firstRemove) {
      removeCandidates.push(firstRemove);
    }
  }

  // VERIFY candidates uit active bids
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
  
    if (!isVerifyCandidate(f)) continue;
  
    verifyCandidates.push(record);
  }

  // Prioriteit: PLACE_OR_UPDATE boven REMOVE
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
    const maxBid = getMaxBid(fields);
  
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
      stockxUrl
    };
  }
  
  const chosenVerify =
    verifyCandidates.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime))[0];
  
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

  if (!chosen) return null;

  const fields = chosen.fields;
  const sku = getSku(fields);
  const size = fields["Size"];
  const maxBid = getMaxBid(fields);

  let stockxUrl = fields["StockX URL"] || null;

  if (!stockxUrl) {
    try {
      const resolved = await resolveStockxUrlBySku(sku);
      stockxUrl = resolved.stockxUrl;
    } catch {
      stockxUrl = null;
    }
  }

  if (needsBid(fields)) {
    return {
      type: "PLACE_OR_UPDATE",
      recordId: chosen.id,
      sku,
      size,
      maxBid,
      stockxUrl
    };
  }

  if (needsRemoval(fields)) {
    return {
      type: "REMOVE",
      recordId: chosen.id,
      sku,
      size,
      stockxUrl
    };
  }

  return null;
}
