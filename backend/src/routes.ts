import { Router, type Request, type Response } from "express";
import { config } from "./config.js";
import { all, get, run } from "./db.js";
import { coordination, origin } from "./analysis/coordination.js";
import { demographics } from "./analysis/demographics.js";
import { insights } from "./analysis/insights.js";
import { network, spread } from "./analysis/network.js";
import { thread, threads } from "./analysis/threads.js";
import { overview, sentimentTimeline } from "./analysis/timeline.js";
import { listTopics } from "./analysis/topics.js";
import { trends } from "./analysis/trends.js";
import { llmConfigured, llmModelName, llmState } from "./llm/groq.js";
import { pipeline, triggerNow } from "./pipeline.js";
import { getTelegram, tgState } from "./telegram/client.js";
import { addSource } from "./telegram/collector.js";
import { accountLimits, apifyConfigured, spendThisMonth } from "./x/apify.js";
import { addSource as addXSource, parseXInput } from "./x/collector.js";
import { addSource as addRedditSource, parseRedditInput, redditConfigured } from "./reddit/collector.js";
import { addSource as addYouTubeSource, parseYouTubeInput, youtubeConfigured } from "./youtube/collector.js";
import { resolveRange } from "./util/range.js";

export const api = Router();

const handle =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  };

api.get(
  "/status",
  handle(async () => {
    await getTelegram();
    const counts = get(`SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM messages WHERE analyzed = 0) AS pendingAnalysis,
        (SELECT COUNT(*) FROM users WHERE kind = 'user') AS users,
        (SELECT COUNT(*) FROM profiles) AS profiled,
        (SELECT COUNT(*) FROM topics) AS topics`);
    return {
      telegram: tgState,
      llm: {
        configured: llmConfigured(),
        model: llmModelName(),
        pausedUntil: llmState.pausedUntil,
        error: llmState.lastError,
      },
      x: {
        configured: apifyConfigured(),
        actor: config.x.actor,
        spendMonthUsd: Number(spendThisMonth().toFixed(4)),
        budgetUsd: config.x.monthlyBudgetUsd,
        account: await accountLimits(),
      },
      reddit: { configured: redditConfigured(), mode: redditConfigured() ? "api" : "feed" },
      youtube: { configured: youtubeConfigured() },
      pipeline,
      counts,
    };
  }),
);

api.get("/threads", handle((req) => threads(resolveRange(req.query))));
api.get("/threads/:id", handle((req) => thread(Number(req.params.id))));
api.get("/coordination", handle((req) => coordination(resolveRange(req.query))));
api.get(
  "/origin",
  handle((req) => {
    const topic = Number(req.query.topic) || undefined;
    const term = String(req.query.term ?? "").trim() || undefined;
    if (!topic && !term) throw new Error("pass ?topic=<id> or ?term=<text>");
    return origin(resolveRange(req.query), { topic, term });
  }),
);

api.get(
  "/sources",
  handle(() =>
    all(`SELECT s.id, s.platform, s.handle, s.title, s.kind, s.linked_source_id, s.last_synced_at, s.added_at,
                COUNT(m.id) AS messages, MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
           FROM sources s LEFT JOIN messages m ON m.source_id = s.id
          GROUP BY s.id ORDER BY s.id`),
  ),
);

api.post(
  "/sources",
  handle(async (req) => {
    const input = String(req.body?.handle ?? "");
    // The input's shape picks the platform; anything unrecognised is a Telegram handle, as before.
    const added = parseXInput(input) ? await addXSource(input)
      : parseRedditInput(input) ? await addRedditSource(input)
      : parseYouTubeInput(input) ? await addYouTubeSource(input)
      : await addSource(input);
    triggerNow();
    return added;
  }),
);

api.delete(
  "/sources/:id",
  handle((req) => {
    run("DELETE FROM sources WHERE id = ?", Number(req.params.id));
    return { ok: true };
  }),
);

api.post(
  "/pipeline/run",
  handle(() => {
    triggerNow();
    return { ok: true };
  }),
);

api.get("/topics", handle(() => listTopics()));
api.get("/overview", handle((req) => overview(resolveRange(req.query))));
api.get("/sentiment", handle((req) => sentimentTimeline(resolveRange(req.query))));
api.get("/demographics", handle((req) => demographics(resolveRange(req.query))));
api.get("/trends", handle((req) => trends(resolveRange(req.query))));
api.get("/network", handle((req) => network(resolveRange(req.query))));
api.get("/network/spread", handle((req) => spread(resolveRange(req.query), Number(req.query.topic) || undefined)));
api.post("/insights", handle((req) => insights(resolveRange(req.query))));
