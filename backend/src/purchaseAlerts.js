/*
 * Purchase delay messages - step 2 of the after-order service.
 *
 * Runs after every purchase sweep, on MAIN-account StockX purchases that
 * have not reached us yet. Purchase to delivered at our warehouse took, for
 * 106 MAIN orders since 15-09-2026: median 5.8 days, 75% within 7.9, 90%
 * within 9.7, 95% within 11.6. A warning on a fixed day 6 would hit almost
 * half of all orders, so the store hears from us only when an order is
 * really behind:
 *
 *   first message  - the seller missed StockX's ship-by deadline, or the
 *                    pair is still not on its way to us after FIRST_DAYS (8)
 *   second message - still not delivered after SECOND_DAYS (11)
 *
 * StockX's own delivery estimate is far too wide and is never shown to the
 * store. Messages go to the store's shipment-delays channel (Merchants
 * "Delay Warning Channel ID") and are in English.
 *
 * Internally (not to the store) we hear about a pair StockX says it delivered
 * that is not booked in two days later.
 *
 * PURCHASE_ALERTS_MODE: "off", "preview" (default: store messages go to the
 * internal channel instead, so the wording can be checked first) or "live".
 */
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_TOKEN;

const FIRST_DAYS = Number(process.env.PURCHASE_FIRST_WARNING_DAYS) || 8;
const SECOND_DAYS = Number(process.env.PURCHASE_SECOND_WARNING_DAYS) || 11;
const SHIP_BY_GRACE_HOURS = Number(process.env.PURCHASE_SHIP_BY_GRACE_HOURS) || 12;
const ARRIVAL_CHECK_DAYS = Number(process.env.PURCHASE_ARRIVAL_CHECK_DAYS) || 2;

const DAY = 24 * 60 * 60 * 1000;

const NOT_SHIPPED = new Set(["ORDER_CREATED", "SELLER_GENERATED_LABEL"]);
const ON_ITS_WAY_TO_US = new Set(["AC_SHIPPED"]);
const FINISHED = new Set(["BUYER_RECEIVED", "CANCELLED"]);

// What the store reads. The marketplace is not named: to the store this is
// our sourcing, not a StockX order.
const STORE_STATUS = {
  ORDER_CREATED: "Waiting for the seller to ship",
  SELLER_GENERATED_LABEL: "The seller is preparing the shipment",
  SELLER_SHIPPED: "On its way to authentication",
  AC_RECEIVED: "Being authenticated",
  AC_AUTHENTICATION_SUCCESS: "Authenticated, being packed",
  AC_STAGED_TO_SHIP: "Packed, waiting for the carrier",
  AC_SHIPPED: "On its way to our warehouse"
};

const WAITING_STATUSES = ["Allocated", "StockX Processing"];

function mode() {
  const value = String(process.env.PURCHASE_ALERTS_MODE || "preview").trim().toLowerCase();
  return ["off", "preview", "live"].includes(value) ? value : "preview";
}

function headers() {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

function tableUrl() {
  return `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function airtable(url, options = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { ...options, headers: headers() });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`Airtable ${options.method || "GET"} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error("Airtable kept refusing the request");
}

const first = (value) => (Array.isArray(value) ? value[0] : value);
const text = (value) => String(first(value) ?? "").trim();
const time = (value) => {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

async function fetchWaitingPurchases() {
  const statusOr = WAITING_STATUSES.map((s) => `{Fulfillment Status}='${s}'`).join(",");
  const formula =
    `AND({Purchase Marketplace}='StockX',{Purchase Status}!='',` +
    `OR(${statusOr}),` +
    `FIND('MAIN_ACCOUNT',ARRAYJOIN({Merchant StockX Account Mode}))>0)`;

  const fields = [
    "Order ID", "Shopify Order Number", "Product Name", "Size", "SKU", "Store Name",
    "Purchase Status", "Purchase Status Since", "Purchase Seller Ship By",
    "First StockX Order Placed At", "Order Date", "StockX Order Number",
    "Purchase Delay Warning Sent At", "Purchase Delay Second Warning Sent At",
    "Purchase Arrival Check Sent At", "Client Delay Warning Channel ID"
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

function shortDate(ms) {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/Amsterdam" });
}

function orderLabel(f) {
  const shopify = text(f["Shopify Order Number"]);
  return shopify ? `Order ${shopify.startsWith("#") ? shopify : `#${shopify}`}` : `Order ${text(f["Order ID"])}`;
}

/*
 * Decide, per order, which message is due now. Pure, so it can be tested.
 * Returns null or { kind: "first" | "second" | "arrival", reason }.
 */
export function dueMessage(f, now = Date.now()) {
  const status = text(f["Purchase Status"]);
  const purchased = time(f["First StockX Order Placed At"]) ?? time(f["Order Date"]);
  if (!status || !purchased) return null;

  const days = (now - purchased) / DAY;

  if (status === "BUYER_RECEIVED") {
    const since = time(f["Purchase Status Since"]);
    if (!f["Purchase Arrival Check Sent At"] && since && now - since >= ARRIVAL_CHECK_DAYS * DAY) {
      return { kind: "arrival", reason: "delivered by the marketplace but not booked in" };
    }
    return null;
  }

  if (FINISHED.has(status)) return null;

  if (!f["Purchase Delay Warning Sent At"]) {
    const shipBy = time(f["Purchase Seller Ship By"]);
    if (NOT_SHIPPED.has(status) && shipBy && now > shipBy + SHIP_BY_GRACE_HOURS * 60 * 60 * 1000) {
      return { kind: "first", reason: "seller_late", shipBy };
    }
    if (days >= FIRST_DAYS && !ON_ITS_WAY_TO_US.has(status)) {
      return { kind: "first", reason: "slow" };
    }
    return null;
  }

  if (!f["Purchase Delay Second Warning Sent At"] && days >= SECOND_DAYS) {
    return { kind: "second", reason: "still_not_delivered" };
  }

  return null;
}

export function storeMessage(f, due) {
  const status = text(f["Purchase Status"]);
  const product = [text(f["Product Name"]), text(f["Size"]) ? `EU ${text(f["Size"])}` : ""].filter(Boolean).join(" - ");
  const where = STORE_STATUS[status] || "In transit";

  let title;
  let body;

  if (due.kind === "first" && due.reason === "seller_late") {
    title = `⏳ Shipping delay - ${orderLabel(f)}`;
    body =
      `The seller of this pair has not shipped it yet (it was due on ${shortDate(due.shipBy)}). ` +
      "We are following it closely and will let you know as soon as it moves - or if we need to source it elsewhere.";
  } else if (due.kind === "first") {
    title = `⏳ Taking longer than usual - ${orderLabel(f)}`;
    body =
      "This order is taking longer than our usual delivery time. " +
      "We are following it closely and will let you know if anything changes.";
  } else {
    title = `⏳ Still on its way - ${orderLabel(f)}`;
    body =
      "This order has still not reached our warehouse and is now well past our usual delivery time. " +
      "We are on it and will update you as soon as it arrives or if anything changes.";
  }

  return {
    embeds: [
      {
        title,
        description: `**${product}**\n\n${body}`,
        color: due.kind === "second" ? 0xe67e22 : 0xf1c40f,
        fields: [{ name: "Current status", value: where, inline: true }],
        footer: { text: `${text(f["Store Name"])} · ${text(f["Order ID"])}` }
      }
    ]
  };
}

async function postToStoreChannel(channelId, message) {
  const url = `${process.env.DISCORD_UPDATES_URL || "https://airtable-discord-updates.onrender.com"}/post-member-wtb-store-message`;
  const secret = process.env.DISCORD_UPDATES_SECRET;
  if (!secret) throw new Error("DISCORD_UPDATES_SECRET is not set");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-kc-secret": secret },
    body: JSON.stringify({ channel_id: channelId, ...message })
  });
  if (!res.ok) throw new Error(`Store message failed: ${res.status} ${await res.text()}`);
}

async function postInternal(content, embeds = []) {
  const webhook = process.env.DISCORD_AFTER_ORDER_WEBHOOK || process.env.DISCORD_RUNNER_ALERTS_WEBHOOK;
  if (!webhook) throw new Error("No internal webhook set (DISCORD_AFTER_ORDER_WEBHOOK)");

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, embeds, allowed_mentions: { parse: [] } })
  });
  if (!res.ok) throw new Error(`Internal message failed: ${res.status} ${await res.text()}`);
}

const SENT_FIELD = {
  first: "Purchase Delay Warning Sent At",
  second: "Purchase Delay Second Warning Sent At",
  arrival: "Purchase Arrival Check Sent At"
};

let lastRun = null;

// Previews are not written to the order: going live must still send the
// real message. They are remembered here so a preview is shown once.
const previewed = new Set();

export async function runPurchaseAlerts(now = Date.now()) {
  const current = mode();
  const summary = { at: new Date(now).toISOString(), mode: current, checked: 0, sent: [], errors: [] };

  if (current === "off") {
    lastRun = summary;
    return summary;
  }

  const records = await fetchWaitingPurchases();
  summary.checked = records.length;

  for (const record of records) {
    const f = record.fields;
    const due = dueMessage(f, now);
    if (!due) continue;

    const previewKey = `${record.id}:${due.kind}`;
    const isPreview = due.kind !== "arrival" && current !== "live";
    if (isPreview && previewed.has(previewKey)) continue;

    try {
      if (due.kind === "arrival") {
        await postInternal(
          `📦 **${text(f["Order ID"])}** (${text(f["Store Name"])}, ${text(f["Product Name"])} EU ${text(f["Size"])}): ` +
          `StockX says delivered since ${shortDate(time(f["Purchase Status Since"]))} (order ${text(f["StockX Order Number"])}), ` +
          "but it is still not booked in at the warehouse."
        );
      } else {
        const message = storeMessage(f, due);
        const channelId = text(f["Client Delay Warning Channel ID"]);

        if (!isPreview && channelId) {
          await postToStoreChannel(channelId, message);
        } else {
          await postInternal(
            `🔍 Preview of a store message for **${text(f["Store Name"])}**` +
            (channelId ? "" : " (no shipment-delays channel on Merchants!)") +
            ` - ${text(f["Order ID"])} / ${text(f["StockX Order Number"])}`,
            message.embeds
          );
        }
      }

      if (isPreview) {
        previewed.add(previewKey);
      } else {
        await airtable(`${tableUrl()}/${record.id}`, {
          method: "PATCH",
          body: JSON.stringify({ fields: { [SENT_FIELD[due.kind]]: new Date(now).toISOString() } })
        });
      }

      summary.sent.push({ order: text(f["Order ID"]), kind: due.kind, reason: due.reason, preview: isPreview });
      await sleep(300);
    } catch (err) {
      summary.errors.push({ order: text(f["Order ID"]), error: err.message });
    }
  }

  lastRun = summary;
  return summary;
}

export function getPurchaseAlertsStatus() {
  return {
    mode: mode(),
    firstWarningDays: FIRST_DAYS,
    secondWarningDays: SECOND_DAYS,
    shipByGraceHours: SHIP_BY_GRACE_HOURS,
    lastRun
  };
}
