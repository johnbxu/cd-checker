const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const WCL_API_URL   = "https://www.warcraftlogs.com/api/v2/client";

// In-memory token cache (reused across warm Lambda invocations)
let cachedToken = null;
let tokenExpiry  = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) {
    return cachedToken;
  }

  const credentials = btoa(`${process.env.WCL_CLIENT_ID}:${process.env.WCL_CLIENT_SECRET}`);
  const resp = await fetch(WCL_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
      "User-Agent":    "WCL-Cooldown-Checker/1.0",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WCL auth failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  cachedToken  = data.access_token;
  tokenExpiry  = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  }

  try {
    const { query, variables } = JSON.parse(event.body || "{}");

    if (!query) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing query" }) };
    }

    const token = await getToken();

    const wclFetch = () => fetch(WCL_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
        "User-Agent":    "WCL-Cooldown-Checker/1.0",
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
    return { statusCode: wclResp.status, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
