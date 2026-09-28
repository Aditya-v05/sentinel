import { all } from "../db.js";

/** Display labels for user keys, in chunks the SQLite parameter limit allows. */
export function userLabels(keys: Iterable<string>) {
  const list = [...new Set(keys)];
  const out = new Map<string, { label: string; kind: string; platform: string }>();
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const u of all(
      `SELECT key, platform, username, display_name, kind FROM users WHERE key IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
    )) {
      const label = u.username ? "@" + u.username : u.display_name || (String(u.key).startsWith("tg:@") ? String(u.key).slice(3) : "user " + String(u.key).slice(-4));
      out.set(u.key, { label, kind: u.kind ?? "user", platform: u.platform });
    }
  }
  for (const k of list) if (!out.has(k)) out.set(k, { label: k.startsWith("tg:@") ? k.slice(3) : "user " + k.slice(-4), kind: "user", platform: k.split(":")[0] });
  return out;
}
