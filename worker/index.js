/**
 * WCL Cooldown Checker — Cloudflare Worker
 *
 * Proxies WarcraftLogs OAuth token exchange and GraphQL queries.
 * Credentials never touch the browser.
 *
 * Environment variables (set in wrangler.toml or Cloudflare dashboard):
 *   WCL_CLIENT_ID     — your WarcraftLogs API client ID
 *   WCL_CLIENT_SECRET — your WarcraftLogs API client secret
 *   ALLOWED_ORIGIN    — your frontend URL, e.g. https://your-name.pages.dev
 *                       set to * to allow any origin (not recommended for production)
 */

const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_API_URL = "https://www.warcraftlogs.com/api/v2/client";

// Simple in-memory token cache (persists for the lifetime of the Worker instance)
let cachedToken = null;
let tokenExpiry = 0;

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) {
    return cachedToken;
  }

  const resp = await fetch(WCL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.WCL_CLIENT_ID,
      client_secret: env.WCL_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WCL auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const isAllowed =
    allowed === "*" ||
    origin === allowed ||
    (Array.isArray(allowed.split(",")) && allowed.split(",").map(s => s.trim()).includes(origin));

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : allowed.split(",")[0].trim(),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    // Handle preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Only accept POST to /api/wcl
    if (url.pathname !== "/api/wcl" || request.method !== "POST") {
      // Serve static frontend assets for all non-API routes
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    try {
      const body = await request.json();
      const { query, variables } = body;

      if (!query) {
        return new Response(JSON.stringify({ error: "Missing query" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const token = await getToken(env);

      const wclFetch = () => fetch(WCL_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      let wclResp = await wclFetch();

      // Retry once after a short delay if rate limited
      if (wclResp.status === 429) {
        await new Promise(r => setTimeout(r, 3000));
        wclResp = await wclFetch();
      }

      const data = await wclResp.json();

      return new Response(JSON.stringify(data), {
        status: wclResp.status,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};
