import { all, scope } from "../db.js";
import { bucketOf, bucketStarts, type Range } from "../util/range.js";
import { communityOfFn } from "./network.js";
import { userLabels } from "./users.js";

/**
 * Coordination and origin: the questions an analyst asks after "who is influential".
 *
 * Nothing here is a model. Three signals, each computed from timestamps and text already
 * in the tables, each explainable in one sentence:
 *   bursts       the same wording posted as original text by several accounts within minutes
 *   synchrony    pairs of accounts that keep posting in the same minute
 *   amplifiers   accounts that mostly reshare, or were created just before they got busy
 * plus origin tracing: for a topic or a term, who said it first, and how long each platform,
 * source and audience segment took to pick it up.
 */

const BURST_WINDOW_SEC = 600;
const MIN_BURST_AUTHORS = 3;
const SYNC_MIN_POSTS = 5;
const SYNC_MIN_HITS = 3;
const SYNC_MAX_AUTHORS_PER_MINUTE = 25;

/** Wording with everything an account would change to look different removed. */
export function normaliseText(text: string) {
  return text
    .toLowerCase()
    .replace(/^rt\s+@\w+:?\s*/i, "")
    .replace(/https?:\/\/\S+|t\.me\/\S+/g, " ")
    .replace(/[@#]\w+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function coordination(r: Range) {
  const s = scope(r);
  const rows = all(
    `SELECT m.id, m.author_key, m.ts, m.text, m.fwd_from_key, m.source_id, src.platform, src.title AS source
       FROM messages m JOIN sources src ON src.id = m.source_id
      WHERE ${s.where} AND m.author_key IS NOT NULL AND m.analyzed != 2
      ORDER BY m.ts`,
    ...s.params,
  );

  // ---- bursts: identical normalised wording, posted as original text, by several accounts
  const byText = new Map<string, typeof rows>();
  for (const m of rows) {
    if (m.fwd_from_key) continue;
    const key = normaliseText(m.text ?? "");
    if (key.length < 25) continue;
    (byText.get(key) ?? byText.set(key, []).get(key)!).push(m);
  }
  const bursts = [];
  for (const [key, ms] of byText) {
    const authors = new Set(ms.map((m) => m.author_key as string));
    if (authors.size < MIN_BURST_AUTHORS) continue;
    // tightest window: sort by ts and find the shortest span covering MIN_BURST_AUTHORS distinct authors
    let tightest = Infinity;
    for (let i = 0; i < ms.length; i++) {
      const seen = new Set<string>();
      for (let j = i; j < ms.length; j++) {
        seen.add(ms[j].author_key);
        if (seen.size >= MIN_BURST_AUTHORS) { tightest = Math.min(tightest, ms[j].ts - ms[i].ts); break; }
      }
    }
    bursts.push({
      key, text: ms[0].text, messages: ms.length, authorCount: authors.size,
      authors: [...authors], sources: [...new Set(ms.map((m) => m.source as string))],
      platforms: [...new Set(ms.map((m) => m.platform as string))],
      firstTs: ms[0].ts, lastTs: ms.at(-1)!.ts, tightestSpanSec: tightest,
      score: +(authors.size / (1 + tightest / BURST_WINDOW_SEC)).toFixed(2),
    });
  }
  bursts.sort((a, b) => b.score - a.score);

  // ---- synchrony: pairs that keep landing in the same minute
  const posts = new Map<string, number>();
  const minute = new Map<number, Set<string>>();
  for (const m of rows) {
    posts.set(m.author_key, (posts.get(m.author_key) ?? 0) + 1);
    const k = Math.floor(m.ts / 60);
    (minute.get(k) ?? minute.set(k, new Set()).get(k)!).add(m.author_key);
  }
  const pairHits = new Map<string, number>();
  for (const set of minute.values()) {
    if (set.size < 2 || set.size > SYNC_MAX_AUTHORS_PER_MINUTE) continue;
    const a = [...set].filter((k) => (posts.get(k) ?? 0) >= SYNC_MIN_POSTS).sort();
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const id = `${a[i]}|${a[j]}`;
      pairHits.set(id, (pairHits.get(id) ?? 0) + 1);
    }
  }
  const syncPairs = [...pairHits.entries()]
    .filter(([, n]) => n >= SYNC_MIN_HITS)
    .map(([id, hits]) => {
      const [a, b] = id.split("|");
      const pa = posts.get(a)!, pb = posts.get(b)!;
      return { a, b, hits, postsA: pa, postsB: pb, score: +(hits / Math.sqrt(pa * pb)).toFixed(3) };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, 30);

  // ---- amplifiers: reshare-heavy or freshly created accounts that are busy
  const perAuthor = new Map<string, { posts: number; forwards: number; texts: Set<string>; burstClusters: number }>();
  for (const m of rows) {
    const a = perAuthor.get(m.author_key) ?? perAuthor.set(m.author_key, { posts: 0, forwards: 0, texts: new Set(), burstClusters: 0 }).get(m.author_key)!;
    a.posts++;
    if (m.fwd_from_key) a.forwards++;
    a.texts.add(normaliseText(m.text ?? "").slice(0, 80));
  }
  for (const b of bursts) for (const k of b.authors) { const a = perAuthor.get(k); if (a) a.burstClusters++; }
  const created = new Map(all(
    `SELECT key, account_created, first_seen FROM users WHERE account_created IS NOT NULL`,
  ).map((u) => [u.key as string, { created: u.account_created as number, first: u.first_seen as number }]));
  const amplifiers = [...perAuthor.entries()]
    .filter(([, a]) => a.posts >= 5)
    .map(([key, a]) => {
      const forwardShare = a.forwards / a.posts;
      const c = created.get(key);
      const ageDays = c ? Math.max(0, Math.round((c.first - c.created) / 86400)) : null;
      const young = ageDays != null && ageDays < 90;
      const repetitive = a.texts.size / a.posts < 0.5;
      const score = +(forwardShare * 0.5 + (young ? 0.3 : 0) + (repetitive ? 0.2 : 0) + Math.min(a.burstClusters, 3) * 0.1).toFixed(2);
      return { key, posts: a.posts, forwardShare: +forwardShare.toFixed(2), accountAgeDays: ageDays, burstClusters: a.burstClusters, distinctTextShare: +(a.texts.size / a.posts).toFixed(2), score };
    })
    .filter((a) => a.score >= 0.4)
    .sort((x, y) => y.score - x.score)
    .slice(0, 25);

  const labels = userLabels([...bursts.flatMap((b) => b.authors), ...syncPairs.flatMap((p) => [p.a, p.b]), ...amplifiers.map((a) => a.key)]);
  const L = (k: string) => labels.get(k)?.label ?? k;
  return {
    totals: { messages: rows.length, authors: perAuthor.size, bursts: bursts.length, syncPairs: syncPairs.length, amplifiers: amplifiers.length },
    bursts: bursts.slice(0, 20).map(({ key, ...b }) => ({ ...b, authorLabels: b.authors.slice(0, 8).map(L) })),
    syncPairs: syncPairs.map((p) => ({ ...p, labelA: L(p.a), labelB: L(p.b) })),
    amplifiers: amplifiers.map((a) => ({ ...a, label: L(a.key), platform: labels.get(a.key)?.platform ?? a.key.split(":")[0] })),
  };
}

/**
 * Where a narrative started and how it travelled. `topic` (an id) or `term` (a substring)
 * selects the messages; the answer is the first voices, and the delay before each platform,
 * source and audience segment first carried it.
 */
export function origin(r: Range, sel: { topic?: number; term?: string }) {
  const s = scope(r);
  const cond = sel.topic ? "AND m.topic_id = ?" : sel.term ? "AND m.text LIKE ? COLLATE NOCASE" : "";
  const params = sel.topic ? [sel.topic] : sel.term ? [`%${sel.term}%`] : [];
  const rows = all(
    `SELECT m.id, m.author_key, m.ts, m.text, m.forwards, m.reactions, m.source_id, src.platform, src.title AS source,
            (SELECT COUNT(*) FROM messages c WHERE c.source_id = m.source_id AND c.reply_to_ext_id = m.ext_id) AS replies
       FROM messages m JOIN sources src ON src.id = m.source_id
      WHERE ${s.where} AND m.author_key IS NOT NULL AND m.analyzed != 2 ${cond}
      ORDER BY m.ts`,
    ...s.params, ...params,
  );
  if (!rows.length) return { total: 0, first: [], platforms: [], sources: [], segments: [], carriers: [], buckets: bucketStarts(r), bucketSec: r.bucket, volume: [] };

  const t0 = rows[0].ts;
  const firstBy = <K>(key: (m: any) => K) => {
    const m = new Map<K, { firstTs: number; count: number; firstAuthor: string }>();
    for (const row of rows) {
      const k = key(row);
      const e = m.get(k);
      if (!e) m.set(k, { firstTs: row.ts, count: 1, firstAuthor: row.author_key });
      else e.count++;
    }
    return [...m.entries()].map(([k, v]) => ({ key: k, ...v, delaySec: v.firstTs - t0 })).sort((a, b) => a.firstTs - b.firstTs);
  };
  const communityOf = communityOfFn(r);
  const volume = new Array(bucketStarts(r).length).fill(0);
  for (const m of rows) volume[bucketOf(m.ts, r)]++;

  const carriers = new Map<string, { posts: number; replies: number; forwards: number; reactions: number }>();
  for (const m of rows) {
    const c = carriers.get(m.author_key) ?? carriers.set(m.author_key, { posts: 0, replies: 0, forwards: 0, reactions: 0 }).get(m.author_key)!;
    c.posts++; c.replies += m.replies ?? 0; c.forwards += m.forwards ?? 0; c.reactions += m.reactions ?? 0;
  }
  const topCarriers = [...carriers.entries()]
    .map(([key, c]) => ({ key, ...c, score: c.replies * 2 + c.forwards * 3 + c.reactions }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const labels = userLabels([...rows.slice(0, 5).map((m) => m.author_key), ...topCarriers.map((c) => c.key), ...firstBy((m) => m.platform).map((p) => p.firstAuthor)]);
  const L = (k: string) => labels.get(k)?.label ?? k;
  return {
    total: rows.length,
    firstTs: t0,
    first: rows.slice(0, 5).map((m) => ({ id: m.id, ts: m.ts, author: L(m.author_key), platform: m.platform, source: m.source, text: String(m.text ?? "").slice(0, 240), replies: m.replies, forwards: m.forwards })),
    platforms: firstBy((m) => m.platform as string).map((p) => ({ ...p, firstAuthor: L(p.firstAuthor) })),
    sources: firstBy((m) => m.source as string).map((p) => ({ ...p, firstAuthor: L(p.firstAuthor) })),
    segments: firstBy((m) => communityOf(m.author_key)).map((p) => ({ ...p, firstAuthor: L(p.firstAuthor) })),
    carriers: topCarriers.map((c) => ({ ...c, label: L(c.key) })),
    buckets: bucketStarts(r), bucketSec: r.bucket, volume,
  };
}
