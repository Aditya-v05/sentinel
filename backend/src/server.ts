import cors from "cors";
import express from "express";
import { authEnabled, requireAuth } from "./auth.js";
import { config } from "./config.js";
import { startScheduler } from "./pipeline.js";
import { api } from "./routes.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", requireAuth, api);

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  if (!authEnabled()) console.warn("APP_PASSWORD is not set: the API is open. Fine on a laptop, not on a host.");
  startScheduler();
});
