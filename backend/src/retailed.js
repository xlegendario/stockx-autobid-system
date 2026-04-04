const SEARCH_URL = process.env.RETAILED_STOCKX_SEARCH_URL;
const API_KEY = process.env.RETAILED_API_KEY;

export async function resolveStockxUrlBySku(sku) {
  if (!sku) {
    throw new Error("SKU is required for StockX URL resolution");
  }

  const url = new URL(SEARCH_URL);

  // Tijdelijk uitgaande van een query param "query"
  // Dit passen we zo nodig aan op basis van jouw echte scraper response/docs.
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

  // Tijdelijke parsing
  // Dit moeten we mogelijk aanpassen aan de echte response
  const first =
    data?.results?.[0] ||
    data?.data?.[0] ||
    data?.products?.[0] ||
    null;

  if (!first) {
    throw new Error(`No StockX result found for SKU ${sku}`);
  }

  const stockxUrl =
    first.url ||
    first.stockxUrl ||
    first.productUrl ||
    first.link ||
    null;

  if (!stockxUrl) {
    throw new Error(`No StockX URL found in scraper response for SKU ${sku}`);
  }

  return {
    stockxUrl,
    raw: data
  };
}
