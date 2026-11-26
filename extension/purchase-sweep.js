/*
 * Runs inside the StockX buying page (MAIN world, via chrome.scripting), so
 * it must be self-contained: no imports, nothing from the extension.
 *
 * The buying page asks gateway.stockx.com for its table with the persisted
 * GraphQL query GetBuyingTableData. This lets the page make that request
 * itself (by switching tabs), takes the headers, hash and variables it used,
 * and asks the same question for every page of open orders and for history
 * back to `historySince` (the oldest order still open at the last sweep,
 * from the backend). The session token never leaves the page: it is read
 * from the page's own request and sent straight back to StockX.
 *
 * Orders the seller has not shipped yet also get StockX's ship-by deadline
 * for the seller, from the order detail query (getBuyOrder) - a handful per
 * sweep at most.
 *
 * Returns { ok, orders: [{ open, orderNumber, statusKey, statusTitle,
 * purchaseDate, etaFrom, etaUntil, sellerShipBy, amount, size }], pages } or
 * { ok: false, error }.
 */
export async function stockxPurchaseSweepInPage(options) {
  const since = new Date(options?.historySince || Date.now() - 30 * 24 * 60 * 60 * 1000).getTime();
  const maxPages = Number(options?.maxPages) || 12;
  const KNOWN_HASH = "1c6bd81d62599316be18d6a2b2e9ae1c92967bc6fcbe69f8e5cc2935dc75a167";
  const KNOWN_ORDER_HASH = "4d74ad3a6113338a65031d44ee5d93718408e59250c73ed74f80deaebb59d1a2";
  const NOT_SHIPPED = new Set(["ORDER_CREATED", "SELLER_GENERATED_LABEL"]);
  const GATEWAY = "https://gateway.stockx.com/api/graphql";

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

        if (!headers && (sent.authorization || sent.Authorization)) headers = sent;

        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (body?.operationName === "GetBuyingTableData") tableRequest = body;
      }
    } catch {
      // Watching must never break the page's own request.
    }

    return originalFetch.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const clickTab = (pattern) => {
    const tab = Array.from(document.querySelectorAll("a, button, [role='tab']"))
      .find((el) => pattern.test(String(el.innerText || "").trim()));
    if (tab) tab.click();
    return !!tab;
  };

  try {
    // Switching tabs makes the page fetch its table again.
    for (const pattern of [/^History/, /^Orders/, /^History/]) {
      clickTab(pattern);
      for (let i = 0; i < 24 && !(headers && tableRequest); i++) await sleep(250);
      if (headers && tableRequest) break;
    }

    if (!headers) {
      return { ok: false, error: "The buying page made no request to StockX to learn the session from" };
    }

    const hash = tableRequest?.extensions?.persistedQuery?.sha256Hash || KNOWN_HASH;
    const baseVariables = {
      sort: "MATCHED_AT",
      order: "DESC",
      currencyCode: "EUR",
      market: "NL.vat-registered",
      country: "NL",
      ...(tableRequest?.variables || {})
    };

    async function fetchPage(state, after) {
      const variables = { ...baseVariables, first: 50, state, sort: "MATCHED_AT", order: "DESC" };
      if (after) variables.after = after;
      else delete variables.after;

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

      const json = await res.json();

      if (json.errors?.length) {
        throw new Error(`StockX ${state}: ${json.errors.map((e) => e.message).join("; ")}`);
      }

      return json.data?.viewer?.buying;
    }

    const cutoff = Number.isFinite(since) ? since : Date.now() - 30 * 24 * 60 * 60 * 1000;
    const orders = [];
    const pages = {};

    for (const state of ["PENDING", "HISTORICAL"]) {
      let after = null;
      let count = 0;

      while (count < maxPages) {
        const buying = await fetchPage(state, after);
        if (!buying) throw new Error(`StockX ${state}: no buying data in the answer`);
        count++;

        let reachedCutoff = false;

        for (const edge of buying.edges || []) {
          const node = edge.node || {};
          const purchased = node.purchaseDate ? new Date(node.purchaseDate).getTime() : null;

          if (state === "HISTORICAL" && purchased && purchased < cutoff) {
            reachedCutoff = true;
            continue;
          }

          orders.push({
            chainId: node.chainId || null,
            open: state === "PENDING",
            orderNumber: node.orderNumber || node.orderId || null,
            statusKey: node.state?.statusKey || null,
            statusTitle: node.state?.statusTitle || node.status || null,
            purchaseDate: node.purchaseDate || null,
            etaFrom: node.estimatedDeliveryDateRange?.estimatedDeliveryDate || null,
            etaUntil: node.estimatedDeliveryDateRange?.latestEstimatedDeliveryDate || null,
            amount: node.amount ?? null,
            size: node.localizedSizeTitle || null
          });
        }

        after = buying.pageInfo?.endCursor || null;
        if (!buying.pageInfo?.hasNextPage || !after || reachedCutoff) break;
        await sleep(400);
      }

      pages[state] = count;
    }

    // The seller's ship-by deadline is only on the order detail. A failure here
    // costs that one date, never the sweep.
    let shipByFailures = 0;
    for (const order of orders) {
      if (!order.open || !NOT_SHIPPED.has(order.statusKey) || !order.chainId) continue;

      try {
        const res = await originalFetch(GATEWAY, {
          method: "POST",
          credentials: "include",
          headers: { ...headers, "x-operation-name": "getBuyOrder" },
          body: JSON.stringify({
            operationName: "getBuyOrder",
            variables: {
              chainId: order.chainId,
              country: baseVariables.country,
              market: baseVariables.market,
              isShipByDateEnabled: true,
              isDFSUpdatesEnabled: true,
              isMysteryBoxEnabled: false
            },
            extensions: { persistedQuery: { version: 1, sha256Hash: KNOWN_ORDER_HASH } }
          })
        });
        const json = await res.json();
        order.sellerShipBy = json.data?.viewer?.order?.sellerShipByDateRange?.actual || null;
        if (json.errors?.length) shipByFailures++;
      } catch {
        shipByFailures++;
      }

      await sleep(300);
    }

    // An order StockX moved to History without delivering or cancelling it
    // (ORD-028860: verified on 17-10, then quietly refunded) is not coming.
    // Its detail says whether the money was given back.
    let closedFailures = 0;
    for (const order of orders) {
      if (order.open || ["BUYER_RECEIVED", "CANCELLED"].includes(order.statusKey) || !order.chainId) continue;

      try {
        const res = await originalFetch(GATEWAY, {
          method: "POST",
          credentials: "include",
          headers: { ...headers, "x-operation-name": "getBuyOrder" },
          body: JSON.stringify({
            operationName: "getBuyOrder",
            variables: {
              chainId: order.chainId,
              country: baseVariables.country,
              market: baseVariables.market,
              isShipByDateEnabled: true,
              isDFSUpdatesEnabled: true,
              isMysteryBoxEnabled: false
            },
            extensions: { persistedQuery: { version: 1, sha256Hash: KNOWN_ORDER_HASH } }
          })
        });
        const json = await res.json();
        const detail = json.data?.viewer?.order;
        if (!detail) throw new Error("no order detail");
        order.closedAction = detail.action || null;
        order.refunded = (detail.refunds || []).reduce((sum, r) => sum + (Number(r?.refundedAmount?.value) || 0), 0);
      } catch {
        closedFailures++;
      }

      await sleep(300);
    }

    for (const order of orders) delete order.chainId;

    return { ok: true, orders, pages, usedKnownHash: !tableRequest, shipByFailures, closedFailures };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    window.fetch = originalFetch;
  }
}
