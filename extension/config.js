export const CONFIG = {
  BACKEND_URL: "https://stockx-autobid-system.onrender.com"
};

// Which runner a browser is gets chosen once in the popup and is kept in
// chrome.storage, never in this file. On 26-11-2026 the SneakerAsk browser ran
// as the MAIN runner for two days because an update of this folder brought the
// MAIN config.js along: SneakerAsk orders stood still and MAIN tasks were done
// on the SneakerAsk account. An update can no longer change the identity.
export const RUNNER_PROFILES = {
  "main-account": {
    label: "MAIN account (snrkickz)",
    RUNNER_NAME: "snrkickz-resell-runner",
    ACCOUNT_GROUP_KEY: "main-account",
    // Orders from before this date get no new bids. Existing bids on them are
    // still verified and removed as usual.
    MIN_ORDER_DATE: "2026-10-01"
  },
  "sneakerask-runner": {
    label: "SneakerAsk",
    RUNNER_NAME: "sneakerask-runner",
    ACCOUNT_GROUP_KEY: "sneakerask-runner"
  }
};
