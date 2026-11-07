// DG Cafe · "Ask Priya" chat backend (Vercel serverless function)
// Needs one environment variable in Vercel → Project → Settings → Environment Variables:
//   ANTHROPIC_API_KEY = your Claude API key
// Optional: PRIYA_MODEL (defaults to claude-haiku-5-5)

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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: "not_configured" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  let msgs = Array.isArray(body && body.messages) ? body.messages : [];
  msgs = msgs
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content.slice(0, 600) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "bad_request" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.PRIYA_MODEL || "claude-haiku-5-5", max_tokens: 300, system: SYSTEM, messages: msgs })
    });
    const j = await r.json();
    if (!r.ok) { console.error("anthropic_error", r.status, j && j.error); return res.status(502).json({ error: "upstream" }); }
    const reply = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
    return res.status(200).json({ reply });
  } catch (e) {
    console.error("chat_failed", e);
    return res.status(502).json({ error: "upstream" });
  }
};
