import express from "express";
import { fetchOrders } from "./airtable.js";
import { buildTask, debugRecords } from "./tasks.js";

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

    if (!runnerNameRaw) {
      return res.status(400).json({
        ok: false,
        error: "runnerName is required"
      });
    }

    const runnerName = String(runnerNameRaw).trim().toLowerCase();

    const records = await fetchOrders();
    const task = buildTask(records, runnerName);

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

export default router;
