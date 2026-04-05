import { updateOrder } from "./airtable.js";

export async function submitTaskResult(recordId, payload) {
  if (!recordId) {
    throw new Error("recordId is required");
  }

  const now = new Date().toISOString();

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

  throw new Error("Unknown task result type/action");
}
