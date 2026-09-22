// Lead receiver for the ortho pilot landing page (CUR-3385).
// Accepts POST /lead JSON from the static page, validates it, appends it to a
// local JSONL log, and fires the Paperclip routine webhook so a lead issue is
// created for the CTO to forward to the CMO.
//
// Run: deno run --allow-net --allow-read --allow-write --allow-env receiver/lead-receiver.ts
// Env (see ortho-lead-receiver.env, never committed):
//   LEAD_PORT            default 8787
//   LEAD_LOG             path to leads.jsonl
//   LEAD_ALLOWED_ORIGINS comma-separated origins allowed for CORS
//   PAPERCLIP_WEBHOOK_URL / PAPERCLIP_WEBHOOK_SECRET  routine webhook (bearer)

const PORT = Number(Deno.env.get("LEAD_PORT") ?? "8787");
const LOG = Deno.env.get("LEAD_LOG") ?? "./leads.jsonl";
const ORIGINS = (Deno.env.get("LEAD_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const WEBHOOK_URL = Deno.env.get("PAPERCLIP_WEBHOOK_URL") ?? "";
const WEBHOOK_SECRET = Deno.env.get("PAPERCLIP_WEBHOOK_SECRET") ?? "";

const PM = new Set(["athena", "tebra", "other"]);
const BILLING = new Set(["in-house", "outsourced"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Lead = {
  practice: string; surgeons: number; pm: string; billing: string; email: string;
  tags: string[]; utm_source?: string; utm_medium?: string; utm_campaign?: string;
  page?: string; submitted_at?: string;
};

function tagsFor(l: Pick<Lead, "surgeons" | "pm" | "billing">): string[] {
  const tags = ["asc-early-access"];
  const pmFit = l.pm === "athena" || l.pm === "tebra";
  const billingFit = l.billing === "in-house";
  const sizeFit = l.surgeons >= 2 && l.surgeons <= 8;
  if (pmFit && billingFit && sizeFit) tags.push("gpc-pilot");
  else if (pmFit && billingFit) tags.push("gpc-pilot-size-review");
  else tags.push("gpc-deprioritized");
  return tags;
}

function validate(body: unknown): { ok: true; lead: Lead } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const str = (k: string, max: number) => {
    const v = typeof b[k] === "string" ? (b[k] as string).trim() : "";
    return v.slice(0, max);
  };
  const practice = str("practice", 120);
  const email = str("email", 254);
  const pm = str("pm", 20);
  const billing = str("billing", 20);
  const surgeons = Number(b.surgeons);
  if (practice.length < 2) return { ok: false, error: "practice required" };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "valid email required" };
  if (!Number.isInteger(surgeons) || surgeons < 1 || surgeons > 200) return { ok: false, error: "surgeons must be 1-200" };
  if (!PM.has(pm)) return { ok: false, error: "pm must be athena|tebra|other" };
  if (!BILLING.has(billing)) return { ok: false, error: "billing must be in-house|outsourced" };
  const lead: Lead = {
    practice, surgeons, pm, billing, email,
    tags: tagsFor({ surgeons, pm, billing }),
    utm_source: str("utm_source", 80), utm_medium: str("utm_medium", 80), utm_campaign: str("utm_campaign", 80),
    page: str("page", 300), submitted_at: new Date().toISOString(),
  };
  return { ok: true, lead };
}

// Simple per-IP rate limit: 5 submissions / 10 min.
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (arr.length >= 5) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr); return false;
}

function cors(origin: string | null): HeadersInit {
  const allow = origin && (ORIGINS.length === 0 || ORIGINS.includes(origin)) ? origin : (ORIGINS[0] ?? "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

async function notifyPaperclip(lead: Lead): Promise<string> {
  if (!WEBHOOK_URL || !WEBHOOK_SECRET) return "webhook-not-configured";
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WEBHOOK_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ payload: lead, idempotencyKey: `lead:${lead.email}:${lead.submitted_at}` }),
    });
    return r.ok ? "webhook-ok" : `webhook-${r.status}`;
  } catch (e) {
    return `webhook-error:${(e as Error).message}`;
  }
}

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (req, info) => {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const h = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method === "GET" && url.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { headers: h });
  if (req.method !== "POST" || url.pathname !== "/lead") return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: h });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || (info.remoteAddr as Deno.NetAddr).hostname;
  if (limited(ip)) return new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: h });

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 8_000) return new Response(JSON.stringify({ error: "too large" }), { status: 413, headers: h });
    body = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: h });
  }
  const v = validate(body);
  if (!v.ok) return new Response(JSON.stringify({ error: v.error }), { status: 400, headers: h });

  await Deno.writeTextFile(LOG, JSON.stringify(v.lead) + "\n", { append: true });
  const notify = await notifyPaperclip(v.lead);
  console.log(`[lead] ${v.lead.practice} <${v.lead.email}> tags=${v.lead.tags.join(",")} ${notify}`);
  return new Response(JSON.stringify({ ok: true, tags: v.lead.tags }), { headers: h });
});
