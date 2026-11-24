import express from "express";
import dotenv from "dotenv";
import routes from "./routes.js";
import { startRunnerHealthChecks } from "./runnerHealth.js";

dotenv.config();

const app = express();
// A purchase sweep posts a few hundred orders at once.
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "stockx-bid-backend"
  });
});

// Routes
app.use("/", routes);

const port = process.env.PORT || 3000;

startRunnerHealthChecks();

app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
