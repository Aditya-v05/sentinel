import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { startScheduler } from "./pipeline.js";
import { api } from "./routes.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", api);

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
  startScheduler();
});
