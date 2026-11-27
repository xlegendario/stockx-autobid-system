/*
 * Cancelled purchases - step 3 of the after-order service.
 *
 * When StockX cancels a pair we bought on the MAIN account (the seller never
 * shipped, or it failed authentication), the purchase sweep sees the order
 * as CANCELLED while the store order still waits for it. Nobody looked at
 * that before: ORD-028837, -030283 and -032891 sat on Allocated for weeks.
 *
 * Per cancelled purchase, in this order:
 *   1. the portal's Cancel with "Keep the order" and "Marketplace cancelled
 *      our purchase" (lojiq-client-portal /api/internal/marketplace-cancel):
 *      store invoice credited, unit voided, purchase credited in Rompslomp,
 *      order back to Outsource with Retry Invoice for the next pair;
 *   2. the autobid starts over: the old StockX order and the purchase
 *      fields come off the order and LastAction is RETRY_ALLOWED;
 *   3. the store hears it in fulfillment-updates ("Fulfillment Failed"),
 *      with CANCEL to stop the sourcing if it no longer needs the pair.
 * The new pair's "Allocated" message is the store's "new pair found".
 *
 * The same for an order StockX moved to History and refunded without
 * calling it cancelled (REFUNDED, set by the sweep; ORD-028860). An order it
 * closed without delivery and without a refund (CLOSED_NO_DELIVERY) is only
 * reported internally: the money has to be claimed from StockX, and whether
 * the order is sourced again is decided by hand (admin Cancel, Keep,
 * "Marketplace cancelled our purchase"). Such orders keep that status, so an
 * Airtable view on Purchase Status = CLOSED_NO_DELIVERY lists what is owed.
 *
 * PURCHASE_CANCEL_MODE: "off", "preview" (default: only an internal message
 * saying what would happen) or "live".
 */
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_TOKEN;

const WAITING_STATUSES = ["StockX Processing", "Allocated", "Found", "Found & Tracked"];

const first = (value) => (Array.isArray(value) ? value[0] : value);
const text = (value) => String(first(value) ?? "").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mode() {
  const value = String(process.env.PURCHASE_CANCEL_MODE || "preview").trim().toLowerCase();
  return ["off", "preview", "live"].includes(value) ? value : "preview";
}

function tableUrl() {
  return `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;
}

async function airtable(url, options = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Airtable ${options.method || "GET"} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error("Airtable kept refusing the request");
}

async function fetchCancelledPurchases() {
  const statusOr = WAITING_STATUSES.map((s) => `{Fulfillment Status}='${s}'`).join(",");
  const formula =
    `AND({Purchase Marketplace}='StockX',OR({Purchase Status}='CANCELLED',{Purchase Status}='REFUNDED',{Purchase Status}='CLOSED_NO_DELIVERY'),` +
    `OR(${statusOr}),` +
    `FIND('MAIN_ACCOUNT',ARRAYJOIN({Merchant StockX Account Mode}))>0)`;
  const fields = [
    "Order ID", "Shopify Order Number", "Product Name", "Size", "SKU", "Store Name",
    "Fulfillment Status", "StockX Order Number", "Purchase Status Since", "Purchase Status", "Purchase Status Title",
    "Order Date", "Created Time"
  ];

  const records = [];
  let offset = null;
  do {
    const url = new URL(tableUrl());
    url.searchParams.set("filterByFormula", formula);
    for (const f of fields) url.searchParams.append("fields[]", f);
    if (offset) url.searchParams.set("offset", offset);
    const data = await airtable(url.toString());
    records.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);
  return records;
}

// Same cut-off as the "Needs StockX Removal" formula (calendar days since Order Date):
// an order this old is too slow to source on StockX again, so no new bid is placed.
const MAX_STOCKX_ORDER_AGE_DAYS = Number(process.env.PURCHASE_CANCEL_MAX_REBID_DAYS || 6);

function tooOldForStockX(f) {
  const since = new Date(text(f["Order Date"]) || text(f["Created Time"]));
  if (Number.isNaN(since.getTime())) return false;
  return (Date.now() - since.getTime()) / 86400000 >= MAX_STOCKX_ORDER_AGE_DAYS;
}

function secret() {
  const value = process.env.PORTAL_INTERNAL_SECRET || process.env.DISCORD_UPDATES_SECRET;
  if (!value) throw new Error("PORTAL_INTERNAL_SECRET / DISCORD_UPDATES_SECRET is not set");
  return value;
}

function orderNumber(f) {
  return text(f["Shopify Order Number"]).replace(/^#/, "") || text(f["Order ID"]);
}

// The store's message, also shown in the preview. Wording Dario's (26-11-2026).
export function storeTrigger(record) {
  const f = record.fields;
  return {
    trigger_type: "fulfillment-failed",
    store_name: text(f["Store Name"]),
    shopify_order_number: orderNumber(f),
    product_name: text(f["Product Name"]),
    sku: text(f.SKU),
    size: text(f.Size),
    record_id: record.id
  };
}

function previewEmbed(trigger) {
  return {
    title: `⚠️ Order #${trigger.shopify_order_number} – Fulfillment Failed`,
    color: 0xe74c3c,
    description:
      `**Item Details:**\n${trigger.product_name}\nSKU: ${trigger.sku}\nSize: ${trigger.size}\n\n` +
      "The pair we had secured for this order fell through. Either through a flake from the seller or the pair had a flaw. " +
      "For more info regarding the reason please contact support.\n\n" +
      "We're sourcing a new one now; nothing needed from you. You'll receive a credit for the original invoice and a new invoice once the new pair is allocated.\n\n" +
      "No longer needed? Cancel it below and we stop sourcing.\n\n🔴 CANCEL (a working button in the store's channel; a preview cannot carry one)"
  };
}

// What comes off the order so the autobid treats it as a new one.
export const RESET_FIELDS = {
  LastAction: "RETRY_ALLOWED",
  BidPlaced: false,
  CurrentBid: null,
  "StockX Order Number": "",
  "StockX Order Status": "",
  "Final StockX Price": null,
  "First StockX Order Placed At": null,
  "Purchase Marketplace": null,
  "Purchase Status": "",
  "Purchase Status Title": "",
  "Purchase Status Since": null,
  "Purchase ETA From": null,
  "Purchase ETA Until": null,
  "Purchase Seller Ship By": null,
  "Purchase Delay Warning Sent At": null,
  "Purchase Delay Second Warning Sent At": null,
  "Purchase Arrival Check Sent At": null
};

async function cancelInPortal(record) {
  const base = process.env.PORTAL_URL || "https://lojiq-client-portal.onrender.com";
  const res = await fetch(`${base}/api/internal/marketplace-cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-kc-secret": secret() },
    body: JSON.stringify({
      record_id: record.id,
      reason: `${text(record.fields["Purchase Status"]) === "REFUNDED" ? "StockX refunded" : "StockX cancelled"} ${text(record.fields["StockX Order Number"])}`
    }),
    signal: AbortSignal.timeout(120000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Portal cancel refused (${res.status}): ${body.error || "no reason given"}`);
  return body;
}

async function postStoreMessage(trigger) {
  const base = process.env.DISCORD_UPDATES_URL || "https://airtable-discord-updates.onrender.com";
  const res = await fetch(`${base}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(trigger)
  });
  if (!res.ok) throw new Error(`Store message failed: ${res.status} ${await res.text()}`);
}

async function postInternal(content, embeds = []) {
  const webhook = process.env.DISCORD_AFTER_ORDER_WEBHOOK || process.env.DISCORD_RUNNER_ALERTS_WEBHOOK;
  if (!webhook) throw new Error("No internal webhook set (DISCORD_AFTER_ORDER_WEBHOOK)");
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1990), embeds, allowed_mentions: { parse: [] } })
  });
  if (!res.ok) throw new Error(`Internal message failed: ${res.status} ${await res.text()}`);
}

let lastRun = null;
// Previews and failures are said once per order (until a restart), not on
// every sweep.
const said = new Set();

export async function runPurchaseCancels(now = Date.now()) {
  const current = mode();
  const summary = { at: new Date(now).toISOString(), mode: current, found: 0, handled: [], errors: [] };
  if (current === "off") {
    lastRun = summary;
    return summary;
  }

  const records = await fetchCancelledPurchases();
  summary.found = records.length;

  for (const record of records) {
    const f = record.fields;
    const what = text(f["Purchase Status"]);
    const verb = what === "REFUNDED" ? "StockX refunded" : what === "CLOSED_NO_DELIVERY" ? "StockX closed" : "StockX cancelled";
    const label = `**${text(f["Order ID"])}** (${text(f["Store Name"])}, ${text(f["Product Name"])} EU ${text(f.Size)}, StockX ${text(f["StockX Order Number"])}, ${text(f["Fulfillment Status"])})`;
    const trigger = storeTrigger(record);

    // Not coming and not refunded: money to claim, the order is a choice.
    if (what === "CLOSED_NO_DELIVERY") {
      const key = `closed:${record.id}`;
      if (said.has(key)) continue;
      try {
        await postInternal(
          `💸 ${verb} ${label} without delivery and without a refund (${text(f["Purchase Status Title"])}). ` +
          "Claim the money from StockX. To source the pair again: admin Cancel order → Keep → \"Marketplace cancelled our purchase\"."
        );
        said.add(key);
        summary.handled.push({ order: text(f["Order ID"]), closedNoDelivery: true });
      } catch (err) {
        summary.errors.push({ order: text(f["Order ID"]), error: err.message });
      }
      continue;
    }

    if (current !== "live") {
      const key = `preview:${record.id}`;
      if (said.has(key)) continue;
      try {
        await postInternal(
          `🔍 Preview - ${verb} ${label}. Live this would: cancel it in the portal with Keep ` +
          "(store invoice credited, unit voided, purchase credited in Rompslomp, back to Outsource), " +
          "restart the autobid, and post this in the store's fulfillment-updates:",
          [previewEmbed(trigger)]
        );
        said.add(key);
        summary.handled.push({ order: text(f["Order ID"]), preview: true });
      } catch (err) {
        summary.errors.push({ order: text(f["Order ID"]), error: err.message });
      }
      await sleep(300);
      continue;
    }

    let portal;
    try {
      portal = await cancelInPortal(record);
    } catch (err) {
      summary.errors.push({ order: text(f["Order ID"]), error: err.message });
      const key = `failed:${record.id}:${err.message}`;
      if (!said.has(key)) {
        said.add(key);
        await postInternal(`❌ ${verb} ${label}, but the portal cancel failed: ${err.message}. Nothing was changed; it is tried again after the next sweep.`).catch(() => {});
      }
      continue;
    }

    const problems = [];
    const tooOld = tooOldForStockX(f);
    try {
      await airtable(`${tableUrl()}/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          fields: tooOld
            ? { ...RESET_FIELDS, LastAction: "BID_REMOVED", ErrorMessage: `${verb} ${text(f["StockX Order Number"])}; order older than ${MAX_STOCKX_ORDER_AGE_DAYS} days, no new StockX bid` }
            : { ...RESET_FIELDS, ErrorMessage: `${verb} ${text(f["StockX Order Number"])}; bidding again` },
          typecast: true
        })
      });
    } catch (err) {
      problems.push(`autobid not restarted (${err.message})`);
    }
    try {
      await postStoreMessage(trigger);
    } catch (err) {
      problems.push(`store not told (${err.message})`);
    }

    const todos = (portal.todos || []).map((t) => `• To do: ${t}`).join("\n");
    await postInternal(
      `${problems.length ? "⚠️" : "✅"} ${verb} ${label}: ${portal.return_number || "cancelled"}, back to Outsource and ${tooOld ? `no new StockX bid (older than ${MAX_STOCKX_ORDER_AGE_DAYS} days)` : "bidding again"}; store told.` +
      (problems.length ? `\nNot done: ${problems.join("; ")}` : "") +
      (todos ? `\n${todos}` : "")
    ).catch(() => {});

    summary.handled.push({ order: text(f["Order ID"]), return: portal.return_number || "", problems });
    await sleep(300);
  }

  lastRun = summary;
  return summary;
}

export function getPurchaseCancelsStatus() {
  return { mode: mode(), lastRun };
}
