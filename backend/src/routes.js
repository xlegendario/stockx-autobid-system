import express from "express";
import { fetchOrders } from "./airtable.js";

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

export default router;
