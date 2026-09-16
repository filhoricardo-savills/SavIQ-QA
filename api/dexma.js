/**
 * DEXMA relay.
 *
 * The DEXMA API sends no CORS headers, so the browser cannot call it directly.
 * This function forwards one request at a time on the page's behalf, using
 * the DEXMA token the user typed. The token is read from a header, used for
 * exactly one upstream call, and never logged, stored or returned.
 *
 * Two gates, both required:
 *   1. A valid Meter QA Review session — the caller must be a signed-in team
 *      member, verified against Supabase. Without this the relay would be an
 *      open DEXMA proxy on our Vercel bill.
 *   2. A DEXMA token of their own. The relay adds nothing the caller could not
 *      do with that token directly; it only gets around the missing CORS.
 *
 * Only four read-only DEXMA paths are allowed. Nothing is ever written.
 */

const DEXMA_HOST = process.env.SAVIQ_API_HOST || "https://api.dexma.com/v3";
const ALLOWED_PATHS = new Set(["/devices", "/locations", "/parameters", "/readings"]);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://bqlvtzjksuvgtlvrstmc.supabase.co";
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_1-R8Ox8fElKf7MgHZj8Jcw_bD5JcBP_";
const TEAM_DOMAIN = /@savills\.ie$/i;

/* Verified sessions are remembered briefly so a run of a few hundred relay
   calls does not make a few hundred auth calls. Instances are recycled by
   Vercel, so this is a courtesy cache, not a security boundary. */
const sessionCache = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;

async function verifySession(jwt) {
  if (!jwt) return null;
  const hit = sessionCache.get(jwt);
  if (hit && hit.until > Date.now()) return hit.email;

  const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON, Authorization: "Bearer " + jwt },
  });
  if (!r.ok) return null;
  const user = await r.json();
  const email = user && user.email;
  if (!email || !TEAM_DOMAIN.test(email)) return null;

  sessionCache.set(jwt, { email, until: Date.now() + SESSION_TTL_MS });
  if (sessionCache.size > 200) sessionCache.delete(sessionCache.keys().next().value);
  return email;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.status(405).json({ error: "GET only" });
    return;
  }

  const path = String(req.query.path || "");
  if (!ALLOWED_PATHS.has(path)) {
    res.status(400).json({ error: "That DEXMA path is not permitted." });
    return;
  }

  const session = String(req.headers["x-qa-session"] || "");
  const email = await verifySession(session);
  if (!email) {
    res.status(401).json({ error: "Sign in to Meter QA Review first." });
    return;
  }

  const token = String(req.headers["x-dexcell-token"] || "").trim();
  if (!token) {
    res.status(400).json({ error: "No DEXMA token supplied." });
    return;
  }

  /* Rebuild the upstream query from everything except our own routing key. */
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "path") continue;
    params.set(k, Array.isArray(v) ? v[0] : String(v));
  }
  const url = DEXMA_HOST + path + (params.toString() ? "?" + params.toString() : "");

  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { "x-dexcell-token": token, Accept: "application/json" },
      redirect: "manual",
    });
  } catch (e) {
    res.status(502).json({ error: "The data service could not be reached." });
    return;
  }

  /* Pass status and the rate-limit headers straight through; the page's
     client understands them exactly as the Python client did. */
  for (const h of ["retry-after", "x-ratelimit-hour-remaining", "x-ratelimit-day-remaining",
                   "x-ratelimit-hour-reset", "x-ratelimit-day-reset"]) {
    const v = upstream.headers.get(h);
    if (v !== null) res.setHeader(h, v);
  }

  if (upstream.status === 204) {
    res.status(204).end();
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status);
  res.setHeader("Content-Type", "application/json");
  res.send(text);
};
