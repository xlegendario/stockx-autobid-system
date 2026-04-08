const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_TOKEN;
const QUEUE_VIEW_NAME = process.env.AIRTABLE_VIEW_NAME;
const ACTIVE_BIDS_VIEW_NAME = process.env.AIRTABLE_ACTIVE_BIDS_VIEW_NAME;
const ORDERS_PLACED_VIEW_NAME = process.env.AIRTABLE_ORDERS_PLACED_VIEW_NAME;

const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  };
}

async function fetchViewRecords(viewName) {
  let allRecords = [];
  let offset = null;

  do {
    const url = new URL(BASE_URL);

    if (viewName) {
      url.searchParams.set("view", viewName);
    }

    if (offset) {
      url.searchParams.set("offset", offset);
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: headers()
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Airtable fetch failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  return allRecords;
}

export async function fetchOrders() {
  return await fetchViewRecords(QUEUE_VIEW_NAME);
}

export async function fetchActiveBids() {
  return await fetchViewRecords(ACTIVE_BIDS_VIEW_NAME);
}

export async function fetchOrdersPlaced() {
  return await fetchViewRecords(ORDERS_PLACED_VIEW_NAME);
}

function escapeAirtableFormulaValue(value) {
  return String(value || "").replace(/'/g, "\\'");
}

export async function findOrdersPlacedByStockxOrderNumber(orderNumber) {
  if (!orderNumber) return [];

  let allRecords = [];
  let offset = null;

  do {
    const url = new URL(BASE_URL);

    if (ORDERS_PLACED_VIEW_NAME) {
      url.searchParams.set("view", ORDERS_PLACED_VIEW_NAME);
    }

    url.searchParams.set(
      "filterByFormula",
      `{StockX Order Number}='${escapeAirtableFormulaValue(orderNumber)}'`
    );

    if (offset) {
      url.searchParams.set("offset", offset);
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: headers()
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Airtable order-number lookup failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  return allRecords;
}

export async function updateOrder(recordId, fields) {
  const res = await fetch(`${BASE_URL}/${recordId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ fields })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable update failed: ${res.status} ${text}`);
  }

  return await res.json();
}
