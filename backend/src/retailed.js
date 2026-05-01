const SEARCH_URL = process.env.RETAILED_STOCKX_SEARCH_URL;
const API_KEY = process.env.RETAILED_API_KEY;

const RETAILED_TIMEOUT_MS = 10000;

function normalizeSku(sku) {
  if (Array.isArray(sku)) return String(sku[0] || "").trim();
  return String(sku || "").trim();
}

export async function resolveStockxUrlBySku(rawSku) {
  const sku = normalizeSku(rawSku);

  if (!sku) {
    throw new Error("SKU is required for StockX URL resolution");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RETAILED_TIMEOUT_MS);

  try {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", sku);

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": API_KEY
      },
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Retailed request failed: ${res.status} ${text}`);
    }

    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`No StockX result found for SKU ${sku}`);
    }

    const exactMatch = data.find(
      (item) =>
        String(item.sku || "").trim().toLowerCase() ===
        sku.toLowerCase()
    );

    const match = exactMatch || data[0];

    if (!match.slug) {
      throw new Error(`No slug found in scraper response for SKU ${sku}`);
    }

    return {
      stockxUrl: `https://stockx.com/${match.slug}`,
      slug: match.slug,
      matchedSku: match.sku || null,
      raw: match
    };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Retailed request timed out after ${RETAILED_TIMEOUT_MS}ms for SKU ${sku}`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
