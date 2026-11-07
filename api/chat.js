// DG Cafe · "Ask Priya" chat backend (Vercel serverless function)
// Add ONE of these in Vercel → Project → Settings → Environment Variables (tried in this order):
//   GEMINI_API_KEY     free key from https://aistudio.google.com/apikey   (optional GEMINI_MODEL)
//   GROQ_API_KEY       free key from https://console.groq.com/keys         (optional GROQ_MODEL)
//   ANTHROPIC_API_KEY  paid Claude key                                    (optional PRIYA_MODEL)

const MENU = {
  "Pizza": [["Margherita Pizza", 300], ["Corn & Cheese Pizza", 219], ["Paneer Tikka Pizza", 239], ["Chicken Tikka Pizza", 279], ["Farmhouse Pizza"], ["BBQ Paneer Pizza"]],
  "Sandwiches & Salads": [["Bombay Cheese Sandwich", 149], ["Tandoori Paneer Sandwich"], ["Chicken Sandwich with Fries"], ["Chicken Burger with Cheese"], ["Veg Caesar Salad", 169], ["Chicken Caesar Salad", 239]],
  "Pasta & Sizzlers": [["Veg Alfredo Pasta", 209], ["Veg Arrabiata Pasta"], ["Stroganoff Sizzler"], ["Aloo Paratha"]],
  "Desserts": [["Dutch Truffle Pastry", 80], ["Sizzling Brownie", 169], ["Red Velvet Cake"], ["Cake Pops"], ["Donuts"]],
  "Coffee & Shakes": [["Latte"], ["KitKat Frappe"], ["Virgin Mojito", 169], ["Crazy Blackcurrant Milkshake", 169]]
};
const items = Object.values(MENU).flat();
const priced = items.filter(x => x[1]).map(x => `${x[0]} ₹${x[1]}`).join(", ");
const unpriced = items.filter(x => !x[1]).map(x => x[0]).join(", ");

const SYSTEM = `You are Priya, the friendly website assistant for DG Cafe & Resto in Chiplun, Maharashtra.

FACTS (use only these; never invent anything):
- Address: Dhaval Plaza, near Chiplun Nagar Parishad, Swara Vihar, Chiplun 415605
- Phone / WhatsApp: 096650 60568
- Hours: 11 AM to 11 PM every day (holiday hours may vary)
- About ₹400 for two. Ample parking. Lively music, neon-lit interiors, family-friendly. Delivery via Zomato.
- Dessert counter with pastries, tarts and dessert cups.
- Menu with prices: ${priced}.
- Also on the menu (price: ask our team): ${unpriced}. Also North Indian, Chinese, biryani and kebabs.

RULES:
- Reply in the customer's language and script: Marathi, Hindi, English, or Hinglish. Use respectful forms (आप / तुम्ही).
- Keep replies short and warm: 1–3 sentences, at most one emoji.
- Never make up prices, offers, discounts, items or policies. If unsure, say the team will confirm on 096650 60568.
- For table bookings, ask them to use the "Reserve a table" form on this page or WhatsApp 096650 60568.
- Only talk about DG Cafe. For unrelated requests, politely steer back to the cafe.`;

// best-effort per-instance rate limit: 20 messages / 10 min per IP
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}

async function gemini(key, msgs) {
  const models = [process.env.GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite"].filter(Boolean);
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: 800, temperature: 0.6 }
  });
  let last;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join("").trim();
      if (text) return text;
    }
    last = { status: r.status, error: j.error && j.error.message };
    if (r.status === 429 || r.status === 401 || r.status === 403) break; // quota or bad key: trying other models won't help
  }
  throw Object.assign(new Error("gemini_failed"), { detail: last });
}

async function groq(key, msgs) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.GROQ_MODEL || "openai/gpt-oss-120b", max_tokens: 700, temperature: 0.6,
      messages: [{ role: "system", content: SYSTEM }, ...msgs] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("groq_failed"), { detail: { status: r.status, error: j.error && j.error.message } });
  return ((((j.choices || [])[0] || {}).message || {}).content || "").trim();
}

async function claude(key, msgs) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.PRIYA_MODEL || "claude-haiku-5-5", max_tokens: 300, system: SYSTEM, messages: msgs })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error("claude_failed"), { detail: { status: r.status, error: j.error } });
  return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
}

module.exports = async (req, res) => {
  const ping = req.method === "GET" && req.query && req.query.ping === "1"; // health check: GET /api/chat?ping=1
  if (req.method !== "POST" && !ping) return res.status(405).json({ error: "method_not_allowed" });
  const providers = [
    [process.env.GEMINI_API_KEY, gemini],
    [process.env.GROQ_API_KEY, groq],
    [process.env.ANTHROPIC_API_KEY, claude]
  ].filter(([k]) => k);
  if (!providers.length) return res.status(503).json({ error: "not_configured" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  let body = ping ? { messages: [{ role: "user", content: "Aaj kitne baje tak khula hai?" }] } : req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  let msgs = Array.isArray(body && body.messages) ? body.messages : [];
  msgs = msgs
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 600) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "bad_request" });

  for (const [key, fn] of providers) {
    try {
      const reply = await fn(key, msgs);
      if (reply) return res.status(200).json({ reply });
    } catch (e) {
      console.error(e.message, JSON.stringify(e.detail || {}));
    }
  }
  return res.status(502).json({ error: "upstream" });
};
