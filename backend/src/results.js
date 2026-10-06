import { updateOrder, findOrdersPlacedByStockxOrderNumber } from "./airtable.js";

// LastAction values that mean our bid is out on StockX.
const LIVE_BID_ACTIONS = new Set(["BID_CREATED", "BID_UPDATED", "BID_VERIFIED_STILL_LIVE"]);

function moneyOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.floor(num) : null;
}

function decimalMoneyOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : null;
}

export async function submitTaskResult(recordId, payload) {
  if (!recordId) {
    throw new Error("recordId is required");
  }

  const now = new Date().toISOString();

  /*
   * The runner gave up on a task without the page reporting anything. That
   * says nothing about the pair, so no failure state is written: a
   * *_FAILED LastAction drops the record out of every Airtable formula that
   * picks up bidding, raising and verifying, and one slow night left 64
   * orders stranded that way. Only the message and a sync time are written,
   * and BID_IN_PROGRESS is turned back into what it was, so the record comes
   * round again. A second bid left SECOND_BID_IN_PROGRESS is retried after
   * ten minutes already.
   */
  if (payload.action === "TASK_TIMEOUT") {
    const fields = {
      ErrorMessage: payload.errorMessage || "Runner timeout"
    };

    if (payload.type === "SYNC_ORDER_STATUS") {
      fields.LastOrderSyncAt = now;
    } else if (payload.type === "SYNC_SECOND_ORDER_STATUS") {
      fields.LastSecondOrderSyncAt = now;
    } else {
      fields.LastSyncAt = now;
    }

    if (typeof payload.restoreLastAction === "string") {
      fields.LastAction = payload.restoreLastAction;
    }

    return await updateOrder(recordId, fields);
  }

  if (payload.action === "STOCKX_LIMITS_CALCULATED") {
    const startBid = moneyOrNull(payload.startBid);
    const maxBid = moneyOrNull(payload.maxBid);

    if (startBid === null || maxBid === null) {
      return await updateOrder(recordId, {
        LastAction: "STOCKX_LIMITS_CALCULATION_FAILED",
        LastSyncAt: now,
        ErrorMessage: "StockX limits calculated but startBid or maxBid was invalid"
      });
    }

    return await updateOrder(recordId, {
      "Start StockX Bid": startBid,
      "Max StockX Bid": maxBid,
      LastAction: "STOCKX_LIMITS_CALCULATED",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.action === "STOCKX_LIMITS_CALCULATION_FAILED") {
    return await updateOrder(recordId, {
      LastAction: "STOCKX_LIMITS_CALCULATION_FAILED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "StockX limits calculation failed"
    });
  }

  if (payload.action === "BID_CREATED" || payload.action === "BID_CREATED_FALLBACK") {
    return await updateOrder(recordId, {
      BidPlaced: true,
      CurrentBid: Number.isFinite(Number(payload.maxBid))
        ? Math.floor(Number(payload.maxBid))
        : null,
      LastAction: "BID_CREATED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "BID_UPDATED") {
    return await updateOrder(recordId, {
      BidPlaced: true,
      CurrentBid: Number.isFinite(Number(payload.maxBid))
        ? Math.floor(Number(payload.maxBid))
        : null,
      LastAction: "BID_UPDATED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "BID_UPDATE_FAILED") {
    /*
     * Raising a bid that is already live and failing leaves that bid live.
     * BID_UPDATE_FAILED would take the record out of the verify and raise
     * formulas, so an accepted bid went unnoticed (ORD-027465). BID_UPDATED
     * keeps it in: the next round verifies first, then tries the raise again.
     * A first placement that fails has no bid out, so it stays a failure.
     */
    const hadLiveBid = LIVE_BID_ACTIONS.has(String(payload.previousLastAction || ""));

    return await updateOrder(recordId, {
      LastAction: hadLiveBid ? "BID_UPDATED" : "BID_UPDATE_FAILED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "Bid update failed"
    });
  }

  if (payload.action === "ORDER_PLACED" || payload.action === "ORDER_PLACED_FALLBACK") {
    return await updateOrder(recordId, {
      "Fulfillment Status": "StockX Processing",
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "ORDER_PLACED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "NO_FUNDS") {
    return await updateOrder(recordId, {
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "NO_FUNDS",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "Payment method declined or insufficient balance"
    });
  }

  if (payload.action === "BID_REMOVED") {
    return await updateOrder(recordId, {
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "BID_REMOVED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "BID_REMOVE_NOT_FOUND") {
    return await updateOrder(recordId, {
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "BID_REMOVE_NOT_FOUND",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "BID_REMOVE_FAILED") {
    return await updateOrder(recordId, {
      LastAction: "BID_REMOVE_FAILED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "Remove flow failed"
    });
  }

  if (payload.action === "BID_VERIFIED_STILL_LIVE") {
    return await updateOrder(recordId, {
      LastAction: "BID_VERIFIED_STILL_LIVE",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.action === "BID_MISSING_NO_ORDER_FOUND") {
    return await updateOrder(recordId, {
      LastAction: "BID_MISSING_NO_ORDER_FOUND",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "BID_MISSING_ORDER_ALREADY_LINKED") {
    return await updateOrder(recordId, {
      LastAction: "BID_MISSING_ORDER_ALREADY_LINKED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "FIRST_ORDER_PLACED") {
    const orderNumber = String(payload.orderNumber || "").trim();

    if (!orderNumber) {
      return await updateOrder(recordId, {
        LastAction: "VERIFY_FAILED",
        LastSyncAt: now,
        ErrorMessage: "First order placed but no StockX order number was provided"
      });
    }

    const existingRecords = await findOrdersPlacedByStockxOrderNumber(orderNumber);
    const linkedToOtherRecord = existingRecords.some((record) => record.id !== recordId);

    if (linkedToOtherRecord) {
      return await updateOrder(recordId, {
        LastAction: "BID_MISSING_ORDER_ALREADY_LINKED",
        LastSyncAt: now,
        ErrorMessage: `StockX order number ${orderNumber} is already linked to another record`
      });
    }

    return await updateOrder(recordId, {
      "Fulfillment Status": "StockX Processing",
      BidPlaced: false,
      CurrentBid: null,

      LastAction: "FIRST_ORDER_PLACED",
      SecondLastAction: "FIRST_ORDER_PLACED",
      LastSyncAt: now,

      "StockX Order Number": orderNumber,
      "Final StockX Price": decimalMoneyOrNull(payload.finalStockXPrice),
      
      "First StockX Buy Now Price": moneyOrNull(payload.firstBuyNowPrice),
      "First StockX Order Placed At": now,

      "Second Bid Flow Status": "SECOND_BID_NEEDED",

      ErrorMessage: ""
    });
  }

  if (payload.action === "SECOND_BID_CREATED") {
    return await updateOrder(recordId, {
      SecondBidPlaced: true,
      SecondCurrentBid: moneyOrNull(
        payload.maxBid ??
        payload.bidAmount ??
        payload.currentBid ??
        payload.currentStockXBid
      ),
      "Second Bid Placed At": now,
      "Second Bid Flow Status": "SECOND_BID_PLACED",
      SecondLastAction: "SECOND_BID_CREATED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "SECOND_BID_UPDATED") {
    return await updateOrder(recordId, {
      SecondBidPlaced: true,
      SecondCurrentBid: moneyOrNull(
        payload.maxBid ??
        payload.bidAmount ??
        payload.currentBid ??
        payload.currentStockXBid
      ),
      "Second Bid Placed At": payload.secondBidPlacedAt || now,
      "Second Bid Flow Status": "SECOND_BID_PLACED",
      SecondLastAction: "SECOND_BID_UPDATED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "SECOND_BID_FAILED") {
    return await updateOrder(recordId, {
      "Second Bid Flow Status": "SECOND_BID_FAILED",
      SecondLastAction: "SECOND_BID_FAILED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "Second bid failed"
    });
  }

  if (payload.action === "SECOND_BID_VERIFIED_STILL_LIVE") {
    return await updateOrder(recordId, {
      SecondLastAction: "SECOND_BID_VERIFIED_STILL_LIVE",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.action === "SECOND_BID_MISSING_NO_ORDER_FOUND") {
    return await updateOrder(recordId, {
      SecondBidPlaced: false,
      SecondCurrentBid: null,
      "Second Bid Flow Status": "SECOND_BID_REMOVED",
      SecondLastAction: "SECOND_BID_REMOVED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "Second bid missing on StockX and no second order found"
    });
  }

  if (payload.action === "SECOND_ORDER_PLACED") {
    const orderNumber = String(payload.orderNumber || "").trim();

    if (!orderNumber) {
      return await updateOrder(recordId, {
        SecondLastAction: "SECOND_BID_FAILED",
        LastSyncAt: now,
        ErrorMessage: "Second order detected but no StockX order number was provided"
      });
    }

    const existingRecords = await findOrdersPlacedByStockxOrderNumber(orderNumber);
    const linkedToOtherRecord = existingRecords.some((record) => record.id !== recordId);

    if (linkedToOtherRecord) {
      return await updateOrder(recordId, {
        SecondLastAction: "SECOND_BID_MISSING_NO_ORDER_FOUND",
        LastSyncAt: now,
        ErrorMessage: `Second order number ${orderNumber} is already linked to another record`
      });
    }

    return await updateOrder(recordId, {
      SecondBidPlaced: false,
      SecondCurrentBid: null,

      "Second Bid Flow Status": "SECOND_ORDER_PLACED",
      "Second StockX Order Status": "Order Confirmed",
      SecondLastAction: "SECOND_ORDER_PLACED",
      LastSyncAt: now,

      "Second StockX Order Number": orderNumber,
      "Second Final StockX Price": decimalMoneyOrNull(payload.finalStockXPrice),
      "Second Order Placed At": now,

      ErrorMessage: ""
    });
  }

  if (payload.action === "SECOND_BID_REMOVED") {
    return await updateOrder(recordId, {
      SecondBidPlaced: false,
      SecondCurrentBid: null,
      "Second Bid Flow Status": "SECOND_BID_REMOVED",
      SecondLastAction: "SECOND_BID_REMOVED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || ""
    });
  }

  if (payload.action === "SECOND_BID_REMOVE_FAILED") {
    return await updateOrder(recordId, {
      SecondLastAction: "SECOND_BID_REMOVE_FAILED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "Second bid remove flow failed"
    });
  }

  if (payload.action === "ORDER_PLACED_WITH_DETAILS") {
    const orderNumber = String(payload.orderNumber || "").trim();

    if (!orderNumber) {
      return await updateOrder(recordId, {
        LastAction: "VERIFY_FAILED",
        LastSyncAt: now,
        ErrorMessage: "Instant order placed but no StockX order number was provided"
      });
    }

    const existingRecords = await findOrdersPlacedByStockxOrderNumber(orderNumber);

    const linkedToOtherRecord = existingRecords.some((record) => record.id !== recordId);

    if (linkedToOtherRecord) {
      return await updateOrder(recordId, {
        LastAction: "BID_MISSING_ORDER_ALREADY_LINKED",
        LastSyncAt: now,
        ErrorMessage: `StockX order number ${orderNumber} is already linked to another record`
      });
    }

    return await updateOrder(recordId, {
      "Fulfillment Status": "StockX Processing",
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "ORDER_PLACED",
      LastSyncAt: now,
      "StockX Order Number": orderNumber,
      "Final StockX Price": Number.isFinite(Number(payload.finalStockXPrice))
        ? Number(payload.finalStockXPrice)
        : null,
      ErrorMessage: ""
    });
  }

  if (payload.action === "ORDER_DETECTED_FROM_ACCEPTED_BID") {
    const orderNumber = String(payload.orderNumber || "").trim();

    if (!orderNumber) {
      return await updateOrder(recordId, {
        LastAction: "VERIFY_FAILED",
        LastSyncAt: now,
        ErrorMessage: "Order detected but no StockX order number was provided"
      });
    }

    const existingRecords = await findOrdersPlacedByStockxOrderNumber(orderNumber);

    const linkedToOtherRecord = existingRecords.some((record) => record.id !== recordId);

    if (linkedToOtherRecord) {
      return await updateOrder(recordId, {
        LastAction: "BID_MISSING_ORDER_ALREADY_LINKED",
        LastSyncAt: now,
        ErrorMessage: `StockX order number ${orderNumber} is already linked to another record`
      });
    }

    return await updateOrder(recordId, {
      "Fulfillment Status": "StockX Processing",
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "ORDER_PLACED",
      LastSyncAt: now,
      "StockX Order Number": orderNumber,
      "Final StockX Price": Number.isFinite(Number(payload.finalStockXPrice))
        ? Number(payload.finalStockXPrice)
        : null,
      "First StockX Order Placed At": now,
      ErrorMessage: ""
    });
  }

  if (payload.action === "VERIFY_FAILED") {
    // A verify that could not read the page knows nothing new about the bid.
    // Leaving LastAction alone keeps it in the verify rotation; the newer
    // LastSyncAt moves it to the back of the queue.
    if (payload.type === "VERIFY_BID_STATUS") {
      return await updateOrder(recordId, {
        LastSyncAt: now,
        ErrorMessage: payload.errorMessage || "Verify flow failed"
      });
    }

    return await updateOrder(recordId, {
      LastAction: "VERIFY_FAILED",
      LastSyncAt: now,
      ErrorMessage: payload.errorMessage || "Verify flow failed"
    });
  }

  if (payload.action === "ORDER_STATUS_SYNCED") {
    return await updateOrder(recordId, {
      "StockX Order Status": payload.stockxOrderStatus || "",
      "StockX Tracking URL": payload.stockxTrackingUrl || "",
      "StockX Tracking Number": payload.stockxTrackingNumber || "",
      LastOrderSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.action === "ORDER_STATUS_SYNC_FAILED") {
    return await updateOrder(recordId, {
      LastOrderSyncAt: now,
      ErrorMessage: payload.errorMessage || "Order status sync failed"
    });
  }

  if (payload.action === "SECOND_ORDER_STATUS_SYNCED") {
    return await updateOrder(recordId, {
      "Second StockX Order Status": payload.stockxOrderStatus || "",
      "Second StockX Tracking URL": payload.stockxTrackingUrl || "",
      "Second StockX Tracking Number": payload.stockxTrackingNumber || "",
      LastSecondOrderSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.action === "SECOND_ORDER_STATUS_SYNC_FAILED") {
    return await updateOrder(recordId, {
      LastSecondOrderSyncAt: now,
      ErrorMessage: payload.errorMessage || "Second order status sync failed"
    });
  }

  throw new Error("Unknown task result type/action");
}
