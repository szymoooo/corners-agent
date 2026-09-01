/**
 * CLOUDFLARE WORKER — proxy + magazyn danych dla agenta "Team Corners 1H".
 *
 * DEPLOY:
 * 1. `npm create cloudflare@latest corners-worker` -> "Hello World Worker".
 * 2. Podmień src/index.js na ten plik.
 * 3. `wrangler secret put ANTHROPIC_API_KEY` -> wklej klucz (nigdy w kodzie!).
 * 4. Utwórz namespace KV: `wrangler kv namespace create CORNERS_KV`
 *    i dodaj zwrócony wpis do wrangler.toml, np.:
 *
 *      [[kv_namespaces]]
 *      binding = "CORNERS_KV"
 *      id = "xxxxxxxxxxxxxxxx"
 *
 *    (Jeśli pominiesz ten krok, endpointy /storage/* zwrócą 500,
 *     a frontend (app.js) automatycznie przełączy się na localStorage.)
 * 5. `wrangler deploy` -> URL typu https://corners-agent.<subdomain>.workers.dev
 * 6. Ustaw ten URL jako WORKER_URL w app.js.
 * 7. W polu ALLOWED_ORIGIN niżej wpisz domenę swojej strony.
 */

const MASTER_PROMPT = `__WKLEJ_TU_PELNY_MASTER_PROMPT_V1.2_ORAZ_DODATEK_JSON__`;
const ALLOWED_ORIGIN = "https://twoja-strona.pl";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }
    if (url.pathname === "/storage/predictions") {
      return handleStorage(request, env, "predictions");
    }
    if (url.pathname === "/storage/results") {
      return handleStorage(request, env, "results");
    }

    return json({ error: "Not found" }, 404);
  },
};

// ---------- /generate ----------
async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { league, kickoff, date, teamA, teamB, side } = body;
  if (!league || !teamA || !teamB) {
    return json({ error: "Brakuje pól: league, teamA, teamB" }, 400);
  }

  const userMessage = `
ANALIZOWANY MECZ (tryb API — zwróć wyłącznie JSON wg podanego schematu):

Liga: ${league}
Data: ${date || "dziś"}
Godzina: ${kickoff || "n/a"}
Drużyna A (${side === "AWAY" ? "AWAY" : "HOME"}): ${teamA}
Drużyna B (${side === "AWAY" ? "HOME" : "AWAY"}): ${teamB}

Wykonaj pełną analizę zgodnie z Master Prompt v1.2 i zwróć TYLKO finalny obiekt JSON
zgodny ze schematem z dodatku do promptu.
`.trim();

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: MASTER_PROMPT,
        messages: [{ role: "user", content: userMessage }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return json({ error: "Anthropic API error", detail: errText }, 502);
    }

    const data = await anthropicRes.json();
    const textBlocks = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const cleaned = textBlocks.replace(/```json|```/g, "").trim();

    let prediction;
    try {
      prediction = JSON.parse(cleaned);
      prediction.generated_at = prediction.generated_at || new Date().toISOString();
    } catch {
      return json({ error: "Model nie zwrócił poprawnego JSON", raw: cleaned }, 502);
    }

    return json({ prediction }, 200);
  } catch (err) {
    return json({ error: "Worker exception", detail: String(err) }, 500);
  }
}

// ---------- /storage/predictions, /storage/results (Cloudflare KV) ----------
async function handleStorage(request, env, key) {
  if (!env.CORNERS_KV) {
    return json({ error: "KV not configured" }, 500);
  }

  if (request.method === "GET") {
    const raw = await env.CORNERS_KV.get(key);
    const fallback = key === "predictions" ? "[]" : "{}";
    return json(JSON.parse(raw || fallback), 200);
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    await env.CORNERS_KV.put(key, JSON.stringify(body));
    return json({ ok: true }, 200);
  }

  return json({ error: "Method not allowed" }, 405);
}

// ---------- helpers ----------
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
