const SEARCH_URL = process.env.RETAILED_STOCKX_SEARCH_URL;
const API_KEY = process.env.RETAILED_API_KEY;

export async function resolveStockxUrlBySku(sku) {
  if (!sku) {
    throw new Error("SKU is required for StockX URL resolution");
  }

  const url = new URL(SEARCH_URL);

  // Based on your endpoint behavior, we use query as the search term.
  url.searchParams.set("query", sku);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-api-key": API_KEY
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Retailed request failed: ${res.status} ${text}`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No StockX result found for SKU ${sku}`);
  }

  // Best match = exact SKU match first
  const exactMatch = data.find(
    (item) =>
      String(item.sku || "").trim().toLowerCase() ===
      String(sku).trim().toLowerCase()
  );

  const match = exactMatch || data[0];

  if (!match.slug) {
    throw new Error(`No slug found in scraper response for SKU ${sku}`);
  }

  const stockxUrl = `https://stockx.com/${match.slug}`;

  return {
    stockxUrl,
    slug: match.slug,
    matchedSku: match.sku || null,
    raw: match
  };
}
