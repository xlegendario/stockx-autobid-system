const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_TOKEN;
const VIEW_NAME = process.env.AIRTABLE_VIEW_NAME;

const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  };
}

export async function fetchOrders() {
  let allRecords = [];
  let offset = null;

  do {
    const url = new URL(BASE_URL);

    if (VIEW_NAME) {
      url.searchParams.set("view", VIEW_NAME);
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
