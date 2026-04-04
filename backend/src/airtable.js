const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
const TOKEN = process.env.AIRTABLE_TOKEN;

const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_NAME)}`;

function headers() {
  return {
    "Authorization": `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  };
}

export async function fetchOrders() {
  const res = await fetch(BASE_URL, {
    method: "GET",
    headers: headers()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtable fetch failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.records || [];
}
