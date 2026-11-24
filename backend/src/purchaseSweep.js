/*
 * Purchase status sweep.
 *
 * After a purchase nothing used to follow the order to the end: the old order
 * sync opened one StockX page per order, only looked in the open orders tab
 * and stopped at the first tracking link. Cancelled orders sit in History, so
 * they came back as "Could not find order row" and were given up on, while
 * the order stayed Allocated with a unit, a booked purchase and a store
 * waiting for a pair that was never coming.
 *
 * The runner now asks StockX for all open orders and the recent history in
 * one go (the same GraphQL request the buying page makes) and posts the list
 * here. This writes, per order, the marketplace's own status code and title,
 * since when that status holds, and StockX's estimated delivery window -
 * only when something changed. Step 1 of the after-order service: it only
 * records. Delay warnings and cancellations act on these fields later.
 */
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_TOKEN;

const SWEEP_EVERY_MINUTES = Number(process.env.PURCHASE_SWEEP_EVERY_MINUTES) || 30;

// Status codes StockX was seen using on 24-11-2026. Anything else is
// recorded as it comes and listed in the sweep status, so it can be mapped
// before step 2 acts on it.
const KNOWN_STOCKX_STATUSES = new Set([
  "ORDER_CREATED",
  "SELLER_GENERATED_LABEL",
  "SELLER_SHIPPED",
  "AC_RECEIVED",
  "AC_AUTHENTICATION_SUCCESS",
  "AC_SHIPPED",
  "BUYER_RECEIVED",
  "CANCELLED"
]);

// Nothing follows these; an order in one of them is done.
const FINAL_STOCKX_STATUSES = new Set(["BUYER_RECEIVED", "CANCELLED"]);

const FIELD = {
  orderNumber: "StockX Order Number",
  marketplace: "Purchase Marketplace",
  status: "Purchase Status",
  title: "Purchase Status Title",
  since: "Purchase Status Since",
  etaFrom: "Purchase ETA From",
  etaUntil: "Purchase ETA Until"
};

const lastHandedOut = new Map();
const lastResults = new Map();

// Per runner: purchase date of the oldest order that was still open at the
// last sweep. History is only needed for orders that leave the open list
// (delivered or cancelled), and an order can only have left it if it was
// open last time - so history is read back to there and no further.
const oldestOpenPurchase = new Map();
const HISTORY_MARGIN_MS = 24 * 60 * 60 * 1000;
const FIRST_SWEEP_HISTORY_DAYS = Number(process.env.PURCHASE_SWEEP_FIRST_HISTORY_DAYS) || 30;

function runnerKey(runnerName, accountGroupKey) {
  return `${String(runnerName || "").toLowerCase()}|${String(accountGroupKey || "-").toLowerCase()}`;
}

/*
 * Handed out once per interval per runner, and marked when handed out rather
 * than when done: a sweep that fails is simply tried again next interval
 * instead of being handed out on every poll.
 */
export function takeSweepIfDue(runnerName, accountGroupKey) {
  const key = runnerKey(runnerName, accountGroupKey);
  const last = lastHandedOut.get(key) || 0;

  if (Date.now() - last < SWEEP_EVERY_MINUTES * 60 * 1000) return null;

  lastHandedOut.set(key, Date.now());

  const oldest = oldestOpenPurchase.get(key);
  const historySince = new Date(
    oldest ? oldest - HISTORY_MARGIN_MS : Date.now() - FIRST_SWEEP_HISTORY_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  return {
    type: "PURCHASE_STATUS_SWEEP",
    recordId: null,
    marketplace: "StockX",
    historySince
  };
}

function headers() {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

function tableUrl() {
  return `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Airtable allows 5 requests per second per base, shared with every other
// service on it; this stays well under.
async function airtable(url, options = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { ...options, headers: headers() });

    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Airtable ${options.method || "GET"} failed: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  throw new Error("Airtable kept refusing the request");
}

function escapeFormulaValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrdersByNumber(orderNumbers) {
  const found = [];

  for (let i = 0; i < orderNumbers.length; i += 30) {
    const chunk = orderNumbers.slice(i, i + 30);
    const formula = `OR(${chunk.map((n) => `{${FIELD.orderNumber}}='${escapeFormulaValue(n)}'`).join(",")})`;
    let offset = null;

    do {
      const url = new URL(tableUrl());
      url.searchParams.set("filterByFormula", formula);
      for (const name of Object.values(FIELD)) url.searchParams.append("fields[]", name);
      if (offset) url.searchParams.set("offset", offset);

      const data = await airtable(url.toString());
      found.push(...(data.records || []));
      offset = data.offset || null;
      await sleep(250);
    } while (offset);
  }

  return found;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Airtable returns dateTimes as "2026-11-25T11:16:40.000Z"; compare to the minute.
function sameMoment(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60 * 1000;
}

function changesFor(fields, order, now) {
  const status = String(order.statusKey || "").trim();
  if (!status) return null;

  const update = {};

  if (fields[FIELD.marketplace] !== "StockX") update[FIELD.marketplace] = "StockX";

  if (fields[FIELD.status] !== status) {
    update[FIELD.status] = status;
    // A status seen for the first time on an order just bought dates from
    // the purchase; any later change dates from when the sweep saw it.
    update[FIELD.since] =
      !fields[FIELD.status] && status === "ORDER_CREATED"
        ? isoOrNull(order.purchaseDate) || now
        : now;
  }

  const title = String(order.statusTitle || "").trim();
  if (title && fields[FIELD.title] !== title) update[FIELD.title] = title;

  const etaFrom = isoOrNull(order.etaFrom);
  const etaUntil = isoOrNull(order.etaUntil);
  if (etaFrom && !sameMoment(fields[FIELD.etaFrom], etaFrom)) update[FIELD.etaFrom] = etaFrom;
  if (etaUntil && !sameMoment(fields[FIELD.etaUntil], etaUntil)) update[FIELD.etaUntil] = etaUntil;

  return Object.keys(update).length ? update : null;
}

export async function applyPurchaseSweep({ runnerName, accountGroupKey, orders }) {
  if (!Array.isArray(orders)) throw new Error("orders must be a list");

  // StockX can leave a finished order in the open list (a cancelled one from
  // 2025 sits there); it would drag history back by a year.
  const openPurchaseTimes = orders
    .filter((order) => order?.open && !FINAL_STOCKX_STATUSES.has(order.statusKey))
    .map((order) => new Date(order.purchaseDate).getTime())
    .filter(Number.isFinite);

  oldestOpenPurchase.set(
    runnerKey(runnerName, accountGroupKey),
    openPurchaseTimes.length ? Math.min(...openPurchaseTimes) : Date.now()
  );

  const startedAt = Date.now();
  const now = new Date().toISOString();

  const byNumber = new Map();
  for (const order of orders) {
    const number = String(order?.orderNumber || "").trim();
    if (number) byNumber.set(number, order);
  }

  const records = await findOrdersByNumber([...byNumber.keys()]);
  const updates = [];

  for (const record of records) {
    const order = byNumber.get(String(record.fields[FIELD.orderNumber] || "").trim());
    if (!order) continue;

    const fields = changesFor(record.fields, order, now);
    if (fields) updates.push({ id: record.id, fields });
  }

  for (let i = 0; i < updates.length; i += 10) {
    await airtable(tableUrl(), {
      method: "PATCH",
      body: JSON.stringify({ records: updates.slice(i, i + 10), typecast: true })
    });
    await sleep(250);
  }

  const statusCounts = {};
  const unknownStatuses = new Set();
  for (const order of byNumber.values()) {
    const status = String(order.statusKey || "?");
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (!KNOWN_STOCKX_STATUSES.has(status)) unknownStatuses.add(`${status} (${order.statusTitle || ""})`);
  }

  const result = {
    at: now,
    runnerName,
    accountGroupKey,
    ordersReported: byNumber.size,
    matchedInAirtable: records.length,
    updated: updates.length,
    statusCounts,
    unknownStatuses: [...unknownStatuses],
    durationMs: Date.now() - startedAt
  };

  lastResults.set(runnerKey(runnerName, accountGroupKey), result);
  return result;
}

export function getPurchaseSweepStatus() {
  return {
    everyMinutes: SWEEP_EVERY_MINUTES,
    runners: [...lastResults.values()]
  };
}
