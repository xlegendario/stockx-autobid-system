/*
 * Runs inside the StockX bids page (MAIN world, via chrome.scripting), so it
 * must be self-contained: no imports, nothing from the extension.
 *
 * Verifying a bid used to mean typing the SKU into the page's search box and
 * reading what showed up. A page that was still loading showed "you don't
 * have active bids", the runner believed it, found no order either and
 * reported the bid missing - while it was live. 48 live bids were written
 * off that way in November 2026.
 *
 * This asks StockX for the whole list instead: every live bid (CURRENT) and
 * every open order (PENDING), with the same persisted GraphQL query the page
 * uses. Only rows for the task's SKU come back. `complete` is false when a
 * list did not come in whole; a bid may only be called missing when both did.
 *
 * Returns { ok, complete, bids: [{ style, size, amount }],
 * orders: [{ orderNumber, style, size, statusKey, purchaseDate }] } or
 * { ok: false, error }.
 */
export async function stockxBidLookupInPage(options) {
  const KNOWN_HASH = "1c6bd81d62599316be18d6a2b2e9ae1c92967bc6fcbe69f8e5cc2935dc75a167";
  const GATEWAY = "https://gateway.stockx.com/api/graphql";
  const MAX_PAGES = 20;

  const skuParts = (value) =>
    String(value || "")
      .split("/")
      .map((part) => part.toUpperCase().replace(/[\s-]/g, ""))
      .filter(Boolean);

  const wanted = skuParts(options?.sku);
  if (!wanted.length) return { ok: false, error: "No SKU to look up" };

  const originalFetch = window.fetch;
  let headers = null;
  let tableRequest = null;

  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url || "";

      if (url.startsWith(GATEWAY)) {
        const sent = init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : { ...(init?.headers || {}) };

        // Only the table's own request: headers of other queries on the page
        // (FetchBuyQty, ...) made StockX refuse the orders list.
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (body?.operationName === "GetBuyingTableData" && (sent.authorization || sent.Authorization)) {
          headers = sent;
          tableRequest = body;
        }
      }
    } catch {
      // Watching must never break the page's own request.
    }

    return originalFetch.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Searching in the table's own box ("Search name, order #") makes the page
  // ask for its table again, which shows the session headers to reuse. Never
  // the product search at the top of the page: Enter there leaves for
  // stockx.com/search.
  const triggerSearch = (text) => {
    const input = Array.from(document.querySelectorAll("input"))
      .find((el) => /order/i.test(el.getAttribute("placeholder") || ""));
    if (!input) return false;

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    return true;
  };

  const clickTab = (pattern) => {
    const tab = Array.from(document.querySelectorAll("a, button, [role='tab']"))
      .find((el) => pattern.test(String(el.innerText || "").trim()));
    if (tab) tab.click();
    return !!tab;
  };

  const waitForHeaders = async () => {
    for (let i = 0; i < 24 && !headers; i++) await sleep(250);
    return !!headers;
  };

  try {
    // An empty search on an empty box changes nothing and asks nothing, so
    // the SKU is typed (in the table's own box, which only filters the table).
    triggerSearch(String(options?.sku || "").split("/")[0].trim());
    if (!(await waitForHeaders())) {
      triggerSearch("");
      if (!(await waitForHeaders())) {
        for (const pattern of [/^History/, /^Orders/, /^Bids/]) {
          clickTab(pattern);
          if (await waitForHeaders()) break;
        }
      }
    }

    if (!headers) {
      return { ok: false, error: "The bids page made no request to StockX to learn the session from" };
    }

    const hash = tableRequest?.extensions?.persistedQuery?.sha256Hash || KNOWN_HASH;
    // Only the page's market settings are taken over: its request may carry
    // the search box text or a tab filter, which would hide rows here.
    const pageVariables = tableRequest?.variables || {};
    const baseVariables = {
      currencyCode: pageVariables.currencyCode || "EUR",
      market: pageVariables.market || "NL.vat-registered",
      country: pageVariables.country || "NL"
    };

    const matches = (node) => {
      const style = skuParts(node.productVariant?.product?.styleId);
      return style.some((part) => wanted.includes(part));
    };

    let complete = true;

    async function readAll(state) {
      const rows = [];
      let after = null;

      for (let page = 0; page < MAX_PAGES; page++) {
        const variables = { ...baseVariables, first: 50, state, sort: "MATCHED_AT", order: "DESC" };
        if (after) variables.after = after;

        // StockX now and then answers "Failed to fetch from Subgraph"; asking
        // again a moment later normally works.
        let json = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await sleep(1500 * attempt);

          const res = await originalFetch(GATEWAY, {
            method: "POST",
            credentials: "include",
            headers: { ...headers, "x-operation-name": "GetBuyingTableData" },
            body: JSON.stringify({
              operationName: "GetBuyingTableData",
              variables,
              extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
            })
          });

          json = await res.json().catch(() => null);
          if (json && !json.errors?.length && json.data?.viewer?.buying) break;
        }

        if (json?.errors?.length) {
          throw new Error(`StockX ${state}: ${json.errors.map((e) => e.message).join("; ")}`);
        }

        const buying = json?.data?.viewer?.buying;
        if (!buying) throw new Error(`StockX ${state}: no buying data in the answer`);

        for (const edge of buying.edges || []) {
          const node = edge.node || {};
          if (matches(node)) rows.push(node);
        }

        after = buying.pageInfo?.endCursor || null;
        if (!buying.pageInfo?.hasNextPage || !after) return rows;
        await sleep(300);
      }

      complete = false;
      return rows;
    }

    const bids = (await readAll("CURRENT")).map((node) => ({
      style: node.productVariant?.product?.styleId || null,
      size: node.localizedSizeTitle || null,
      amount: node.amount ?? null
    }));

    // A failing orders list does not undo a live bid that was found; it only
    // leaves the answer incomplete, so nothing can be called missing.
    let orders = [];
    let ordersError = null;
    try {
      orders = (await readAll("PENDING")).map((node) => ({
        orderNumber: node.orderNumber || null,
        style: node.productVariant?.product?.styleId || null,
        size: node.localizedSizeTitle || null,
        statusKey: node.state?.statusKey || null,
        purchaseDate: node.purchaseDate || null
      }));
    } catch (err) {
      ordersError = String(err?.message || err);
      complete = false;
    }

    return { ok: true, complete, bids, orders, ordersError };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    window.fetch = originalFetch;
    // Leave the search box as the runner expects to find it.
    triggerSearch("");
  }
}
