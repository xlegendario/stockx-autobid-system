import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "stockx-bid-backend"
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
