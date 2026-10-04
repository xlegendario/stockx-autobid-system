export const CONFIG = {
  BACKEND_URL: "https://stockx-autobid-system.onrender.com",
  RUNNER_NAME: "snrkickz-resell-runner",
  ACCOUNT_GROUP_KEY: "main-account",
  // Orders from before this date get no new bids. Existing bids on them are
  // still verified and removed as usual. Leave out to take every order.
  MIN_ORDER_DATE: "2026-10-01"
};
