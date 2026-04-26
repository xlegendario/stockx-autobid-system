import { resolveStockxUrlBySku } from "./retailed.js";

function normalizeLookup(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseMoney(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return raw;

  const cleaned = String(raw).replace(/[^\d.,-]/g, "").replace(",", ".");
  const parsed = Number(cleaned);

  return Number.isFinite(parsed) ? parsed : null;
}

function isTruthy(value) {
  const raw = normalizeLookup(value);
  return raw === true || raw === 1 || raw === "1" || raw === "true";
}

function getSku(fields) {
  return fields["SKU (Soft)"] || fields["SKU"];
}

function hasBidPlaced(fields) {
  return fields["BidPlaced"] === true || fields["BidPlaced"] === 1 || fields["BidPlaced"] === "1";
}

function hasSecondBidPlaced(fields) {
  return fields["SecondBidPlaced"] === true || fields["SecondBidPlaced"] === 1 || fields["SecondBidPlaced"] === "1";
}

function getSecondStatus(fields) {
  return String(fields["Second Bid Flow Status"] || "").trim();
}

function isSecondBidFlowEnabled(fields) {
  return isTruthy(fields["Merchant Second Bid Flow Enabled"]);
}

function getStartBid(fields) {
  return parseMoney(fields["Start StockX Bid"]);
}

function getMaxBid(fields) {
  return parseMoney(fields["Max StockX Bid"]);
}

function getSecondCurrentStockXBid(fields) {
  return parseMoney(fields["Second Current StockX Bid"]);
}

function getSecondCurrentBid(fields) {
  return parseMoney(fields["SecondCurrentBid"]);
}

function getSecondBidMaxPrice(fields) {
  return parseMoney(fields["Second Bid Max Price"]);
}

function needsSecondBidUpdate(fields) {
  const target = getSecondCurrentStockXBid(fields);
  const current = getSecondCurrentBid(fields);

  if (!hasSecondBidPlaced(fields)) return false;
  if (target === null) return false;
  if (current === null) return true;

  return target > current;
}

function secondBidNeedsRemoval(fields) {
  if (!hasSecondBidPlaced(fields)) return false;
  if (getSecondStatus(fields) === "SECOND_ORDER_PLACED") return false;

  const rawExpiry = fields["Second Bid Expires At"];
  if (!rawExpiry) return false;

  const expiry = new Date(rawExpiry);
  if (Number.isNaN(expiry.getTime())) return false;

  return Date.now() >= expiry.getTime();
}

function needsSecondOrderSync(fields) {
  return Number(fields["Needs Second StockX Order Sync"]) === 1;
}

function getSecondStockxOrderNumber(fields) {
  const raw = fields["Second StockX Order Number"];
  if (!raw) return null;

  const value = String(normalizeLookup(raw)).trim();
  return value || null;
}

async function resolveUrl(fields) {
  const sku = getSku(fields);
  let stockxUrl = fields["StockX URL"] || null;

  if (!stockxUrl && sku) {
    try {
      const resolved = await resolveStockxUrlBySku(sku);
      stockxUrl = resolved.stockxUrl;
    } catch {
      stockxUrl = null;
    }
  }

  return stockxUrl;
}

export function isInitialSecondBidFlowCandidate(fields) {
  if (!isSecondBidFlowEnabled(fields)) return false;

  // Alleen nieuwe/onbegonnen records
  if (hasBidPlaced(fields)) return false;
  if (fields["StockX Order Number"]) return false;
  if (getSecondStatus(fields)) return false;

  const startBid = getStartBid(fields);
  const maxBid = getMaxBid(fields);

  if (!Number.isFinite(startBid)) return false;
  if (!Number.isFinite(maxBid)) return false;

  return Number(fields["Needs StockX Bid"]) === 1;
}

export async function buildInitialSecondBidFlowTask(record) {
  const fields = record.fields;
  const sku = getSku(fields);

  return {
    type: "PLACE_OR_BUY_WITH_SECOND_BID_CHECK",
    recordId: record.id,
    sku,
    size: fields["Size"],
    startBid: getStartBid(fields),
    maxBid: getMaxBid(fields),
    currentBid: null,
    stockxUrl: await resolveUrl(fields)
  };
}

export function isSecondBidPlaceOrUpdateCandidate(fields) {
  const status = getSecondStatus(fields);

  if (!isSecondBidFlowEnabled(fields)) return false;
  if (status !== "SECOND_BID_NEEDED" && status !== "SECOND_BID_PLACED") return false;
  if (status === "SECOND_ORDER_PLACED") return false;
  if (secondBidNeedsRemoval(fields)) return false;

  const target = getSecondCurrentStockXBid(fields);
  const max = getSecondBidMaxPrice(fields);

  if (!Number.isFinite(target)) return false;
  if (!Number.isFinite(max)) return false;

  if (!hasSecondBidPlaced(fields)) {
    return status === "SECOND_BID_NEEDED";
  }
  
  return needsSecondBidUpdate(fields);
}

export async function buildSecondBidTask(record) {
  const fields = record.fields;
  const sku = getSku(fields);

  return {
    type: "PLACE_SECOND_BID",
    recordId: record.id,
    sku,
    size: fields["Size"],
    maxBid: getSecondCurrentStockXBid(fields),
    currentBid: getSecondCurrentBid(fields),
    stockxUrl: await resolveUrl(fields)
  };
}

export function isSecondBidRemoveCandidate(fields) {
  return secondBidNeedsRemoval(fields);
}

export async function buildSecondBidRemoveTask(record) {
  const fields = record.fields;
  const sku = getSku(fields);

  return {
    type: "REMOVE_SECOND_BID",
    recordId: record.id,
    sku,
    size: fields["Size"],
    stockxUrl: await resolveUrl(fields)
  };
}

export function isSecondBidVerifyCandidate(fields) {
  if (!isSecondBidFlowEnabled(fields)) return false;
  if (!hasSecondBidPlaced(fields)) return false;
  if (getSecondStatus(fields) !== "SECOND_BID_PLACED") return false;
  if (secondBidNeedsRemoval(fields)) return false;

  return true;
}

export async function buildSecondBidVerifyTask(record) {
  const fields = record.fields;
  const sku = getSku(fields);

  return {
    type: "VERIFY_SECOND_BID_STATUS",
    recordId: record.id,
    sku,
    size: fields["Size"],
    stockxUrl: await resolveUrl(fields)
  };
}

export function isSecondOrderSyncCandidate(fields) {
  if (!isSecondBidFlowEnabled(fields)) return false;
  if (getSecondStatus(fields) !== "SECOND_ORDER_PLACED") return false;
  if (!needsSecondOrderSync(fields)) return false;
  if (!getSecondStockxOrderNumber(fields)) return false;

  return true;
}

export function buildSecondOrderSyncTask(record) {
  const fields = record.fields;

  return {
    type: "SYNC_SECOND_ORDER_STATUS",
    recordId: record.id,
    orderNumber: getSecondStockxOrderNumber(fields),
    stockxUrl: fields["StockX URL"] || null
  };
}
