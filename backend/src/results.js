import { updateOrder } from "./airtable.js";

export async function submitTaskResult(recordId, payload) {
  if (!recordId) {
    throw new Error("recordId is required");
  }

  const now = new Date().toISOString();

  if (payload.action === "BID_CREATED") {
    return await updateOrder(recordId, {
      "Needs StockX Bid": 0,
      BidPlaced: true,
      CurrentBid: Number.isFinite(Number(payload.maxBid))
        ? Math.floor(Number(payload.maxBid))
        : null,
      LastAction: "BID_CREATED",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.action === "ORDER_PLACED") {
    return await updateOrder(recordId, {
      "Needs StockX Bid": 0,
      "Needs StockX Removal": 0,
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "ORDER_PLACED",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.type === "REMOVE") {
    return await updateOrder(recordId, {
      "Needs StockX Removal": 0,
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "BID_REMOVED",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  throw new Error("Unknown task result type/action");
}
