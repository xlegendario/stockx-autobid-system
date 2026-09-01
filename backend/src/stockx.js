const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TOKEN = process.env.AIRTABLE_TOKEN;

const SKU_MASTER_TABLE = process.env.AIRTABLE_SKU_MASTER_TABLE || "SKU Master";
const STOCKX_ACCESS_TOKEN_TABLE =
  process.env.AIRTABLE_STOCKX_ACCESS_TOKEN_TABLE || "StockX Access Token";

const STOCKX_API_KEY = process.env.STOCKX_API_KEY;
const STOCKX_CLIENT_ID = process.env.STOCKX_CLIENT_ID;
const STOCKX_CLIENT_SECRET = process.env.STOCKX_CLIENT_SECRET;
const STOCKX_REFRESH_TOKEN = process.env.STOCKX_REFRESH_TOKEN;

function airtableUrl(table, suffix = "") {
  return `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}${suffix}`;
}

function airtableHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  };
}

function escapeAirtableFormulaValue(value) {
  return String(value || "").replace(/'/g, "\\'");
}

function normalizeSku(sku) {
  if (Array.isArray(sku)) return String(sku[0] || "").trim();
  return String(sku || "").trim();
}

/*
 * A style ID can name more than one SKU.
 *
 * StockX writes those as one string, in two spellings we have both seen live:
 * "L47305800/L41395000" and "CZ0175-800 / CZ0176-800". Our own SKU Master does
 * the same, up to three deep ("553560-130/553560-136/DV0990-111").
 *
 * So a plain === would miss a genuine hit: searching L47305800 returns a
 * product whose styleId is the combined form. Comparing the parts instead
 * means either side may carry the company.
 */
function skuVariants(value) {
  return String(value || "")
    .split("/")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function skusMatch(a, b) {
  const left = skuVariants(a);
  const right = new Set(skuVariants(b));

  return left.some((part) => right.has(part));
}

function slugToUrl(slug) {
  return `https://stockx.com/${slug}`;
}

/*
 * The stored SKU may name several shoes at once.
 *
 * A row can sit under "L47305800/L41395000", so an exact {SKU}= match misses
 * it when only one half is asked for - and then we pay for an API call for a
 * slug we already had. FIND widens the net; skusMatch narrows it again,
 * because FIND alone would also hit a longer SKU that merely contains this one.
 */
async function findSkuMasterRecord(sku) {
  const safe = escapeAirtableFormulaValue(sku);

  const url = new URL(airtableUrl(SKU_MASTER_TABLE));

  url.searchParams.set(
    "filterByFormula",
    `OR({SKU}='${safe}', FIND('${safe}', {SKU}&'') > 0)`
  );
  url.searchParams.set("maxRecords", "10");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: airtableHeaders()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SKU Master lookup failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const records = data.records || [];

  return (
    records.find((record) => skusMatch(sku, record.fields?.["SKU"])) || null
  );
}

async function storeSlugOnSkuMaster(recordId, slug) {
  const res = await fetch(airtableUrl(SKU_MASTER_TABLE, `/${recordId}`), {
    method: "PATCH",
    headers: airtableHeaders(),
    body: JSON.stringify({ fields: { "StockX URL Key": slug } })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SKU Master write-back failed: ${res.status} ${text}`);
  }

  return await res.json();
}

async function getStoredAccessToken() {
  const url = new URL(airtableUrl(STOCKX_ACCESS_TOKEN_TABLE));
  url.searchParams.set("maxRecords", "1");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: airtableHeaders()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`StockX token read failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  const record = (data.records || [])[0];

  if (!record) {
    throw new Error("No StockX Access Token record found in Airtable");
  }

  const accessToken = String(record.fields?.["Access Token"] || "").trim();

  if (!accessToken) {
    throw new Error("StockX Access Token field is empty in Airtable");
  }

  return accessToken;
}

/*
 * Mirrors refreshStockxAccessToken in kickz-caviar-portal-main.
 *
 * Both services share one token record, so whoever hits a 401 first refreshes
 * it for everyone. Writing the new token back is the whole point - a refresh
 * that only lived in memory would have every service refreshing on its own.
 */
async function refreshAccessToken() {
  if (!STOCKX_CLIENT_ID || !STOCKX_CLIENT_SECRET || !STOCKX_REFRESH_TOKEN) {
    throw new Error("Missing StockX refresh token config");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: STOCKX_CLIENT_ID,
    client_secret: STOCKX_CLIENT_SECRET,
    audience: "gateway.stockx.com",
    refresh_token: STOCKX_REFRESH_TOKEN
  });

  const res = await fetch("https://accounts.stockx.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    throw new Error(
      `StockX token refresh failed: ${res.status} ${JSON.stringify(data)}`
    );
  }

  const listUrl = new URL(airtableUrl(STOCKX_ACCESS_TOKEN_TABLE));
  listUrl.searchParams.set("maxRecords", "1");

  const listRes = await fetch(listUrl.toString(), {
    method: "GET",
    headers: airtableHeaders()
  });

  const listData = await listRes.json();
  const record = (listData.records || [])[0];

  if (!record) {
    throw new Error("No StockX Access Token record found to update");
  }

  await fetch(airtableUrl(STOCKX_ACCESS_TOKEN_TABLE, `/${record.id}`), {
    method: "PATCH",
    headers: airtableHeaders(),
    body: JSON.stringify({
      fields: {
        "Access Token": data.access_token,
        "Refreshed At": new Date().toISOString()
      }
    })
  });

  return data.access_token;
}

function normalizeCatalogResults(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.products)) return data.products;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

async function catalogSearchWithToken(sku, accessToken) {
  if (!STOCKX_API_KEY) {
    throw new Error("Missing STOCKX_API_KEY");
  }

  const url = new URL("https://api.stockx.com/v2/catalog/search");
  url.searchParams.set("query", sku);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-api-key": STOCKX_API_KEY,
      Accept: "application/json"
    }
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(
      `StockX catalog search failed: ${res.status} ${JSON.stringify(data)}`
    );

    err.status = res.status;
    throw err;
  }

  return data;
}

async function catalogSearch(sku) {
  let accessToken = await getStoredAccessToken();

  try {
    return await catalogSearchWithToken(sku, accessToken);
  } catch (err) {
    if (![401, 403].includes(Number(err.status))) {
      throw err;
    }

    accessToken = await refreshAccessToken();

    return await catalogSearchWithToken(sku, accessToken);
  }
}

/*
 * Exact matches only.
 *
 * The Retailed version this replaces fell back to data[0] when nothing matched,
 * and StockX search is fuzzy: querying a SKU that does not exist still returns
 * ten plausible neighbours. That first result then went straight to the
 * extension, which placed a bid on it. A wrong slug is a bid on the wrong shoe,
 * so no match means no URL - the callers already handle that.
 */
function findExactProduct(results, sku) {
  return (
    results.find((item) =>
      skusMatch(sku, item.styleId || item.style_id || item.sku)
    ) || null
  );
}

/*
 * SKU -> StockX slug, cheapest source first.
 *
 * 1. SKU Master, which already carries the slug for 99% of our catalogue
 * 2. the StockX catalog API, exact match only
 * 3. write what the API found back, so a SKU is looked up once and never again
 *
 * Same name, arguments and return shape as the Retailed resolver it replaces,
 * so the six call sites in tasks.js and secondTasks.js are untouched.
 */
export async function resolveStockxUrlBySku(rawSku) {
  const sku = normalizeSku(rawSku);

  if (!sku) {
    throw new Error("SKU is required for StockX URL resolution");
  }

  const masterRecord = await findSkuMasterRecord(sku).catch((err) => {
    console.error("⚠️ SKU Master lookup failed, falling back to StockX", {
      sku,
      error: err.message
    });

    return null;
  });

  const storedSlug = String(masterRecord?.fields?.["StockX URL Key"] || "").trim();

  if (storedSlug) {
    return {
      stockxUrl: slugToUrl(storedSlug),
      slug: storedSlug,
      matchedSku: String(masterRecord?.fields?.["SKU"] || sku),
      raw: masterRecord?.fields || null,
      source: "sku_master"
    };
  }

  const data = await catalogSearch(sku);
  const results = normalizeCatalogResults(data);

  if (results.length === 0) {
    throw new Error(`No StockX result found for SKU ${sku}`);
  }

  const match = findExactProduct(results, sku);

  if (!match) {
    throw new Error(`No exact StockX match for SKU ${sku}`);
  }

  const slug = String(match.urlKey || "").trim();

  if (!slug) {
    throw new Error(`No urlKey in the StockX response for SKU ${sku}`);
  }

  // Best effort: a deal must not fail because the cache could not be filled.
  if (masterRecord?.id) {
    await storeSlugOnSkuMaster(masterRecord.id, slug).catch((err) =>
      console.error("⚠️ Could not store the slug on SKU Master", {
        sku,
        error: err.message
      })
    );
  }

  return {
    stockxUrl: slugToUrl(slug),
    slug,
    matchedSku: match.styleId || match.style_id || match.sku || null,
    raw: match,
    source: "stockx_api"
  };
}
