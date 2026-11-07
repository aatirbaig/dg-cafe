// DG Cafe · Priya's voice
// Provider order:
//   1. GOOGLE_TTS_KEY  -> Google Cloud Text-to-Speech, WaveNet Indian female voices (hi-IN / mr-IN / en-IN).
//                        Fast (~0.5s), 4M free characters/month; needs a billing account on the Google Cloud project.
//   2. GEMINI_API_KEY  -> Gemini TTS (free tier is only ~10 voice replies per day).
// If neither works the website falls back to the visitor's built-in browser voice.
// POST {text} -> audio      GET ?ping=1 -> JSON health check

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

let geminiBlockedUntil = 0;   // remembered quota exhaustion so we fail fast instead of making visitors wait

function lang(text) {
  if (/[\u0900-\u097F]/.test(text)) return /[ळ]|आहे|तुम्ही|आम्ही|नाही|का\?/.test(text) ? "mr-IN" : "hi-IN";
  return "en-IN";
}
async function cloudTts(key, text) {
  const lc = lang(text);
  const name = { "hi-IN": process.env.TTS_VOICE_HI || "hi-IN-Wavenet-A", "mr-IN": process.env.TTS_VOICE_MR || "mr-IN-Wavenet-A", "en-IN": process.env.TTS_VOICE_EN || "en-IN-Wavenet-A" }[lc];
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { text }, voice: { languageCode: lc, name }, audioConfig: { audioEncoding: "MP3", speakingRate: 1.02, pitch: 0.5 } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.audioContent) throw Object.assign(new Error("cloud_tts_failed"), { detail: { status: r.status, error: j.error && j.error.message } });
  return { model: name, type: "audio/mpeg", audio: Buffer.from(j.audioContent, "base64") };
}

async function synth(key, text) {
  if (Date.now() < geminiBlockedUntil) throw Object.assign(new Error("tts_quota"), { detail: { status: 429, error: "quota exhausted (cached)" }, status: 429 });
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
        return { model, type: "audio/wav", audio: wav(Buffer.from(part.inlineData.data, "base64"), m ? +m[1] : 24000) };
      }
    }
    last = { model, status: r.status, error: j.error && j.error.message };
    if (r.status === 429) {
      const m = /retry in (?:(\d+)h)?(?:(\d+)m)?/.exec(last.error || "");
      geminiBlockedUntil = Date.now() + (m && (m[1] || m[2]) ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60) * 1000 : 3600 * 1000);
      throw Object.assign(new Error("tts_quota"), { detail: last, status: 429 });
    }
    if (r.status === 401 || r.status === 403) break;
  }
  throw Object.assign(new Error("tts_failed"), { detail: last });
}

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY, cloudKey = process.env.GOOGLE_TTS_KEY;
  const ping = req.method === "GET" && req.query && req.query.ping === "1";
  if (req.method !== "POST" && !ping) return res.status(405).json({ error: "method_not_allowed" });
  // Gemini TTS takes ~4s per reply and allows only ~10 per day, so it is opt-in (USE_GEMINI_TTS=1).
  // Without a Google Cloud key the site uses the visitor's instant built-in voice instead.
  const useGemini = key && process.env.USE_GEMINI_TTS === "1";
  if (!cloudKey && !useGemini) return res.status(503).json({ error: "not_configured" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  let text = ping ? "Namaste! DG Cafe mein aapka swagat hai." : String((body && body.text) || "");
  text = text.replace(/[\u{1F300}-\u{1FAFF}☀-➿]/gu, "").replace(/\s+/g, " ").trim().slice(0, 450);
  if (!text) return res.status(400).json({ error: "bad_request" });

  try {
    const t0 = Date.now();
    let hit = (ping && req.query.nocache) ? null : cache.get(text);
    if (!hit) {
      let err;
      if (cloudKey) { try { hit = await cloudTts(cloudKey, text); } catch (e) { err = e; console.error(e.message, JSON.stringify(e.detail || {})); } }
      if (!hit && useGemini) hit = await synth(key, text);
      if (!hit) throw err || new Error("tts_failed");
      if (cache.size > 200) cache.clear(); cache.set(text, hit);
    }
    if (ping) return res.status(200).json({ ok: true, model: hit.model, bytes: hit.audio.length, ms: Date.now() - t0 });
    res.setHeader("content-type", hit.type);
    res.setHeader("cache-control", "public, max-age=86400");
    return res.status(200).send(hit.audio);
  } catch (e) {
    if (e.status !== 429) console.error(e.message, JSON.stringify(e.detail || {}));
    return res.status(e.status === 429 ? 429 : 502).json({ error: e.status === 429 ? "quota" : "upstream", detail: ping ? e.detail : undefined });
  }
};
