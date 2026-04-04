import express from "express";
import dotenv from "dotenv";
import routes from "./routes.js";

dotenv.config();

const app = express();
app.use(express.json());

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

app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
