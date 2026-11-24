import express from "express";
import {
  fetchOrders,
  fetchActiveBids,
  fetchOrdersPlaced,
  fetchSecondActiveBids,
  fetchSecondOrdersPlaced
} from "./airtable.js";
import { buildTask, debugRecords } from "./tasks.js";
import { submitTaskResult } from "./results.js";
import { recordHeartbeat, getRunnerHealth } from "./runnerHealth.js";
import { takeSweepIfDue, applyPurchaseSweep, getPurchaseSweepStatus } from "./purchaseSweep.js";
import { runPurchaseAlerts, getPurchaseAlertsStatus } from "./purchaseAlerts.js";

const router = express.Router();

function parseMinOrderDate(raw) {
  if (!raw) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

router.get("/orders", async (req, res) => {
  try {
    const records = await fetchOrders();

    res.json({
      ok: true,
      count: records.length,
      records
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

router.post("/tasks/next", async (req, res) => {
  try {
    const runnerNameRaw = req.body.runnerName;
    const accountGroupKeyRaw = req.body.accountGroupKey || null;

    if (!runnerNameRaw) {
      return res.status(400).json({
        ok: false,
        error: "runnerName is required"
      });
    }

    const runnerName = String(runnerNameRaw).trim().toLowerCase();
    const accountGroupKey = accountGroupKeyRaw
      ? String(accountGroupKeyRaw).trim().toLowerCase()
      : null;
    
    const minOrderDate = parseMinOrderDate(req.body.minOrderDate);

    // Only runners that say they can run the sweep get it; older extensions
    // keep receiving bid tasks exactly as before.
    const capabilities = Array.isArray(req.body.capabilities) ? req.body.capabilities : [];

    if (capabilities.includes("purchase-sweep")) {
      const sweep = takeSweepIfDue(runnerName, accountGroupKey);
      if (sweep) return res.json({ ok: true, task: sweep });
    }

    const records = await fetchOrders();
    const activeBidRecords = await fetchActiveBids();
    const orderSyncRecords = await fetchOrdersPlaced();
    const secondActiveBidRecords = await fetchSecondActiveBids();
    const secondOrderSyncRecords = await fetchSecondOrdersPlaced();

    const task = await buildTask(
      records,
      runnerName,
      activeBidRecords,
      accountGroupKey,
      orderSyncRecords,
      secondActiveBidRecords,
      secondOrderSyncRecords,
      minOrderDate
    );

    res.json({
      ok: true,
      task
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

router.post("/tasks/debug", async (req, res) => {
  try {
    const runnerNameRaw = req.body.runnerName;

    if (!runnerNameRaw) {
      return res.status(400).json({
        ok: false,
        error: "runnerName is required"
      });
    }

    const runnerName = String(runnerNameRaw).trim().toLowerCase();

    const records = await fetchOrders();
    const debug = debugRecords(records, runnerName);

    res.json({
      ok: true,
      count: debug.length,
      debug
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

router.post("/tasks/:recordId/result", async (req, res) => {
  try {
    const result = await submitTaskResult(req.params.recordId, req.body);

    res.json({
      ok: true,
      result
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

router.post("/runner/heartbeat", (req, res) => {
  try {
    recordHeartbeat(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post("/purchase-sweep", async (req, res) => {
  try {
    const result = await applyPurchaseSweep({
      runnerName: String(req.body.runnerName || "").trim().toLowerCase(),
      accountGroupKey: String(req.body.accountGroupKey || "").trim().toLowerCase() || null,
      orders: req.body.orders
    });

    res.json({ ok: true, result });

    // The fields are fresh now; check for delays without holding the runner.
    runPurchaseAlerts().catch((err) => console.error("Purchase alerts failed:", err));
  } catch (err) {
    console.error("Purchase sweep failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get("/purchase-sweep/status", (req, res) => {
  res.json({ ok: true, ...getPurchaseSweepStatus(), alerts: getPurchaseAlertsStatus() });
});

router.get("/runner/health", (req, res) => {
  res.json({ ok: true, runners: getRunnerHealth() });
});

export default router;
