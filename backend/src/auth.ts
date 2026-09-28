import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

/**
 * One shared password, set in .env, exchanged for a signed session token. Without
 * APP_PASSWORD the API stays open, and /status says so, because a demo on a laptop should
 * not need a login and a hosted instance should never run without one.
 *
 * Tokens are HMAC-signed JSON with an expiry: nothing to store server-side, nothing a client
 * can forge without the secret, nothing that survives a password change (the secret derives
 * from the password unless APP_SECRET is set).
 */

export const authEnabled = () => Boolean(config.auth.password);
const secret = () => config.auth.secret || crypto.createHash("sha256").update("sentinel:" + config.auth.password).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

/** Paths that need no session: sign-in itself, liveness, and the public chain check. */
export const OPEN = new Set(["/auth/login", "/health", "/integrity/verify"]);

export function login(password: string): string | null {
  const a = Buffer.from(password), b = Buffer.from(config.auth.password);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return issue();
}

export function issue(ttlSec = 12 * 3600) {
  const payload = b64(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${payload}.${sign(payload)}`;
}

export function verify(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled() || OPEN.has(req.path)) return next();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : String(req.query.token ?? "");
  if (verify(token)) return next();
  res.status(401).json({ error: "sign in required" });
}
