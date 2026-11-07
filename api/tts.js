// DG Cafe · Priya's voice (Gemini text-to-speech, free tier)
// Uses the same GEMINI_API_KEY as the chat. Optional env: GEMINI_TTS_MODEL, PRIYA_VOICE (default "Sulafat", a warm female voice)
// POST {text} -> audio/wav     GET ?ping=1 -> JSON health check

const cache = new Map();          // text -> wav buffer (per instance)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 30;
}

function wav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function synth(key, text) {
  const models = [process.env.GEMINI_TTS_MODEL, "gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-tts"].filter(Boolean);
  const voice = process.env.PRIYA_VOICE || "Sulafat";
  const body = JSON.stringify({
    contents: [{ parts: [{ text: `Say this warmly and naturally, like a friendly young Indian woman who hosts a cozy cafe in Maharashtra, at a relaxed pace: ${text}` }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
  });
  let last;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const part = ((((j.candidates || [])[0] || {}).content || {}).parts || []).find(p => p.inlineData && p.inlineData.data);
      if (part) {
        const m = /rate=(\d+)/.exec(part.inlineData.mimeType || "");
        return { model, audio: wav(Buffer.from(part.inlineData.data, "base64"), m ? +m[1] : 24000) };
      }
    }
    last = { model, status: r.status, error: j.error && j.error.message };
    if (r.status === 429 || r.status === 401 || r.status === 403) break;
  }
  throw Object.assign(new Error("tts_failed"), { detail: last });
}

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  const ping = req.method === "GET" && req.query && req.query.ping === "1";
  if (req.method !== "POST" && !ping) return res.status(405).json({ error: "method_not_allowed" });
  if (!key) return res.status(503).json({ error: "not_configured" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  let text = ping ? "Namaste! DG Cafe mein aapka swagat hai." : String((body && body.text) || "");
  text = text.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, "").replace(/\s+/g, " ").trim().slice(0, 450);
  if (!text) return res.status(400).json({ error: "bad_request" });

  try {
    let hit = cache.get(text);
    if (!hit) { hit = await synth(key, text); if (cache.size > 200) cache.clear(); cache.set(text, hit); }
    if (ping) return res.status(200).json({ ok: true, model: hit.model, bytes: hit.audio.length });
    res.setHeader("content-type", "audio/wav");
    res.setHeader("cache-control", "public, max-age=86400");
    return res.status(200).send(hit.audio);
  } catch (e) {
    console.error(e.message, JSON.stringify(e.detail || {}));
    return res.status(502).json({ error: "upstream", detail: ping ? e.detail : undefined });
  }
};
