import express from "express";
import { fetchOrders, fetchActiveBids } from "./airtable.js";
import { buildTask, debugRecords } from "./tasks.js";
import { submitTaskResult } from "./results.js";

const router = express.Router();

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
    
    const records = await fetchOrders();
    const activeBidRecords = await fetchActiveBids();
    const task = await buildTask(records, runnerName, activeBidRecords, accountGroupKey);

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

export default router;
