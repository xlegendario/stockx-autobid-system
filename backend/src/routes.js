import express from "express";
import { fetchOrders } from "./airtable.js";
import { buildTask } from "./tasks.js";

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
    const { runnerName } = req.body;

    if (!runnerName) {
      return res.status(400).json({
        ok: false,
        error: "runnerName is required"
      });
    }

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

export default router;
