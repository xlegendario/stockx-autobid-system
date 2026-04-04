import { updateOrder } from "./airtable.js";

export async function submitTaskResult(recordId, payload) {
  if (!recordId) {
    throw new Error("recordId is required");
  }

  const now = new Date().toISOString();

  if (payload.type === "PLACE_OR_UPDATE") {
    return await updateOrder(recordId, {
      BidPlaced: true,
      CurrentBid: payload.maxBid,
      LastAction: payload.action || "BID_CREATED",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  if (payload.type === "REMOVE") {
    return await updateOrder(recordId, {
      BidPlaced: false,
      CurrentBid: null,
      LastAction: "BID_REMOVED",
      LastSyncAt: now,
      ErrorMessage: ""
    });
  }

  throw new Error("Unknown task result type");
}
