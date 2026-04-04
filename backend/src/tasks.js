import { resolveStockxUrlBySku } from "./retailed.js";

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

function getRunner(fields) {
  return normalizeRunner(fields["Merchant StockX Runner Name"]);
}

function needsBid(fields) {
  return Number(fields["Needs StockX Bid"]) === 1;
}

function needsRemoval(fields) {
  return Number(fields["Needs StockX Removal"]) === 1;
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

function getGroupKey(fields) {
  const runner = getRunner(fields);
  const sku = getSku(fields);
  const size = fields["Size"];

  return `${runner}|${sku}|${size}`;
}

export function debugRecords(records, runnerName) {
  const normalizedRequestedRunner = normalizeRunner(runnerName);

  return records.slice(0, 25).map((record) => {
    const f = record.fields;

    return {
      recordId: record.id,
      orderId: f["Order ID"] || null,
      sku: getSku(f),
      size: f["Size"] || null,
      fulfillmentStatus: f["Fulfillment Status"] || null,
      runnerParsed: getRunner(f),
      requestedRunner: normalizedRequestedRunner,
      runnerMatches: getRunner(f) === normalizedRequestedRunner,
      autobidParsed: isAutobidEnabled(f),
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

export async function buildTask(records, runnerName) {
  const normalizedRequestedRunner = normalizeRunner(runnerName);

  const filtered = records.filter((r) => {
    const f = r.fields;

    if (!isAutobidEnabled(f)) return false;

    const runner = getRunner(f);
    if (runner !== normalizedRequestedRunner) return false;

    if (!needsBid(f) && !needsRemoval(f)) return false;

    return true;
  });

  if (filtered.length === 0) return null;

  const groups = {};

  for (const record of filtered) {
    const key = getGroupKey(record.fields);

    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }

  // sort each group oldest first
  Object.values(groups).forEach((group) => {
    group.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
  });

  // 🔥 PRIORITY 1: PLACE_OR_UPDATE first
  const placeGroupKey = Object.keys(groups).find((key) => {
    const first = groups[key][0];
    return needsBid(first.fields);
  });

  // 🔥 PRIORITY 2: REMOVE only if no place/update exists
  const removeGroupKey =
    !placeGroupKey &&
    Object.keys(groups).find((key) => {
      const first = groups[key][0];
      return needsRemoval(first.fields);
    });

  const chosenGroupKey = placeGroupKey || removeGroupKey;

  if (!chosenGroupKey) return null;

  const first = groups[chosenGroupKey][0];
  const fields = first.fields;

  const sku = getSku(fields);
  const size = fields["Size"];
  const maxBid = getMaxBid(fields);

  let stockxUrl = fields["StockX URL"] || null;

  if (!stockxUrl) {
    try {
      const resolved = await resolveStockxUrlBySku(sku);
      stockxUrl = resolved.stockxUrl;
    } catch (err) {
      stockxUrl = null;
    }
  }

  if (needsBid(fields)) {
    return {
      type: "PLACE_OR_UPDATE",
      recordId: first.id,
      sku,
      size,
      maxBid,
      stockxUrl
    };
  }

  if (needsRemoval(fields)) {
    return {
      type: "REMOVE",
      recordId: first.id,
      sku,
      size,
      stockxUrl
    };
  }

  return null;
}
