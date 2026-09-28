import { all, run, tx } from "../db.js";
import { chatJSON, clip, LlmPausedError } from "../llm/groq.js";
import { EMOTIONS, pick, SENTIMENTS, STANCES } from "./labels.js";
import { listTopics } from "./topics.js";

const BATCH = 20;

/** Compact rows keep output tokens (the scarce free-tier resource) low: [i, sentiment, score, emotion, sarcasm, stance, topic] */
type Row = [number, string, number, string, number | boolean, string, number];
interface Labelled {
  r: Row[];
}

/**
 * Multi-dimensional sentiment: polarity + score, emotion, sarcasm, stance, and topic,
 * labelled in batches (one LLM call per 20 messages). Replies include the parent
 * message so sarcasm and stance are judged in context.
 */
export async function analyzeMessages(limit: number, onProgress?: (done: number, total: number) => void) {
  const pending = all(
    `SELECT m.id, m.text, p.text AS parent_text
       FROM messages m
       LEFT JOIN messages p ON p.source_id = m.source_id AND p.ext_id = m.reply_to_ext_id
      WHERE m.analyzed = 0
      ORDER BY m.ts DESC
      LIMIT ?`,
    limit,
  );
  if (!pending.length) return 0;

  const topics = listTopics();
  const topicIds = new Set(topics.map((t) => t.id as number));
  const topicList = topics.length
    ? topics.map((t) => `${t.id} = ${t.label}`).join("\n")
    : "(no topics yet — always use 0)";

  /** Labels a batch; on a malformed/truncated reply, splits it in half and retries (a lone failure is skipped). */
  const label = async (batch: typeof pending): Promise<void> => {
    try {
      await labelBatch(batch);
    } catch (e) {
      if (e instanceof LlmPausedError) throw e;
      if (batch.length === 1) {
        run("UPDATE messages SET analyzed = 2 WHERE id = ?", batch[0].id);
        return;
      }
      const half = Math.ceil(batch.length / 2);
      await label(batch.slice(0, half));
      await label(batch.slice(half));
    }
  };

  const labelBatch = async (batch: typeof pending) => {
    const items = batch.map((m, i) => ({
      i,
      text: clip(m.text, 300),
      ...(m.parent_text ? { in_reply_to: clip(m.parent_text, 120) } : {}),
    }));
    const byIndex = await labelTexts(items, topicList);
    tx(() => {
      batch.forEach((m, i) => {
        const r = byIndex.get(i);
        if (!r) return run("UPDATE messages SET analyzed = 2 WHERE id = ?", m.id);
        run(
          `UPDATE messages SET analyzed = 1, sentiment = ?, sentiment_score = ?, emotion = ?, sarcasm = ?, stance = ?, topic_id = ?
            WHERE id = ?`,
          r.sentiment, r.score, r.emotion, r.sarcasm, r.stance, topicIds.has(r.topic) ? r.topic : null, m.id,
        );
      });
    });
  };

  let done = 0;
  for (let start = 0; start < pending.length; start += BATCH) {
    const batch = pending.slice(start, start + BATCH);
    await label(batch);
    done += batch.length;
    onProgress?.(done, pending.length);
  }
  return done;
}

export interface LabelItem {
  i: number;
  text: string;
  in_reply_to?: string;
}
export interface Label {
  sentiment: (typeof SENTIMENTS)[number];
  score: number;
  emotion: (typeof EMOTIONS)[number];
  sarcasm: 0 | 1;
  stance: (typeof STANCES)[number];
  topic: number;
}

/**
 * The labelling call itself, shared by the pipeline and the evaluation harness so the
 * number the harness reports is the number the product runs on. Values are snapped onto
 * the fixed vocabularies; an item the model skipped is absent from the map.
 */
export async function labelTexts(items: LabelItem[], topicList = "(no topics yet — always use 0)"): Promise<Map<number, Label>> {
  const res = await chatJSON<Labelled>(
    "You are an expert social media analyst who labels messages precisely, including sarcasm and irony. Messages may be in any language. Reply with JSON only.",
    `Label every message below.

Fields per message:
- sentiment: one of ${SENTIMENTS.join(", ")}  (sarcastic praise counts as negative)
  Plain news, announcements, questions and technical help without an opinion are neutral (emotion neutral, stance neutral).
- score: number from -1 (very negative) to 1 (very positive)
- emotion: the dominant one of ${EMOTIONS.join(", ")}
- sarcasm: true if the message is sarcastic or ironic
- stance: toward the main subject being discussed (or the message it replies to): one of ${STANCES.join(", ")}
- topic: id of the best matching topic, or 0 if none fits

Topics:
${topicList}

Messages (JSON):
${JSON.stringify(items)}

Return one compact row per message, in this exact order: [i, sentiment, score, emotion, sarcasm (1 or 0), stance, topic]
Example: {"r":[[0,"negative",-0.6,"anger",1,"against",3],[1,"positive",0.8,"joy",0,"supportive",0]]}`,
    { maxTokens: 2000 },
  );

  const out = new Map<number, Label>();
  for (const r of (Array.isArray(res.r) ? res.r : []).filter(Array.isArray)) {
    const [i, sentiment, rawScore, emotion, sarcasm, stance, topic] = r;
    out.set(Number(i), {
      sentiment: pick(SENTIMENTS, sentiment, "neutral"),
      score: Math.max(-1, Math.min(1, Number(rawScore) || 0)),
      emotion: pick(EMOTIONS, emotion, "neutral"),
      sarcasm: sarcasm === true || Number(sarcasm) === 1 ? 1 : 0,
      stance: pick(STANCES, stance, "neutral"),
      topic: Number(topic) || 0,
    });
  }
  return out;
}
