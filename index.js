// index.js
import express from "express";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { TwimlResponse } from "twilio/lib/twiml/VoiceResponse.js"; // Works with twilio ^4
import twilio from "twilio";

// NOTE: Node 20+ has global fetch. If you're on older Node, add `node-fetch`.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- Env ----------
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID; // e.g. "pNInz6obpgDQGcFmaJgB"
const BASE_URL =
  process.env.BASE_URL ||
  // Render sets this for you in the dashboard; if not set, you can paste your onrender.com base:
  `https://officialmortgage-ai-bridge-v2.onrender.com`;

if (!OPENAI_API_KEY) console.warn("WARNING: OPENAI_API_KEY is not set.");
if (!ELEVENLABS_API_KEY) console.warn("WARNING: ELEVENLABS_API_KEY is not set.");
if (!ELEVENLABS_VOICE_ID) console.warn("WARNING: ELEVENLABS_VOICE_ID is not set.");

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: true })); // Twilio sends application/x-www-form-urlencoded
app.use(express.json());

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, status: "AI Bridge is online" });
});

// ---------- Helpers ----------
function sanitize(text) {
  return (text || "").toString().trim().slice(0, 2000);
}

/**
 * Generate a short, helpful reply for a caller using OpenAI.
 * Keep it voice-friendly (no emojis, no URLs, short sentences).
 */
async function generateReply({ callerText, fromNumber }) {
  const system = `You are the phone assistant for Official Mortgage (California).
Speak clearly, short sentences, friendly and confident.
If asked about products, you can mention: Jumbo loans, Investor Access (DSCR), Soft Start pre-approval, FastTrack Approval.
Never give legal/tax advice. Avoid rates/quotes—offer to connect them with a loan advisor.
If asked to schedule, say you can text them a link to book, or collect name + email.`;

  const user = `Caller: ${fromNumber || "unknown"}
Said: "${callerText || "no transcript"}"
Goal: Reply in 2–3 sentences, plain English. End with a simple question to keep the call moving.`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_tokens: 220,
    }),
  });

  if (!r.ok) {
    const msg = await r.text();
    throw new Error(`OpenAI error: ${r.status} ${msg}`);
  }

  const data = await r.json();
  const text =
    data.choices?.[0]?.message?.content?.trim() ||
    "Thanks for calling Official Mortgage. How can I help you today?";
  return sanitize(text);
}

/**
 * Convert text -> MP3 using ElevenLabs, return a unique URL path we can <Play> from Twilio.
 */
async function ttsElevenLabs(text) {
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.45, similarity_boost: 0.8 },
    }),
  });

  if (!r.ok) {
    const msg = await r.text();
    throw new Error(`ElevenLabs error: ${r.status} ${msg}`);
  }

  const buffer = Buffer.from(await r.arrayBuffer());
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`;
  const filePath = path.join("/tmp", id);
  await fs.writeFile(filePath, buffer);

  // Twilio must reach this publicly:
  const publicUrl = `${BASE_URL}/media/${id}`;
  return { id, filePath, publicUrl };
}

// Serve generated audio files from /tmp
app.get("/media/:id", async (req, res) => {
  try {
    const fname = req.params.id;
    const filePath = path.join("/tmp", path.basename(fname));
    // Set content type so Twilio knows it's audio
    res.setHeader("Content-Type", "audio/mpeg");
    res.sendFile(filePath);
  } catch {
    res.status(404).send("Not found");
  }
});

// ---------- Twilio Voice Webhook ----------
/**
 * Twilio will POST here with form-encoded fields:
 * - From, To, SpeechResult (if using STT), Digits, etc.
 * We generate a reply, synthesize audio, and return TwiML <Play> for Twilio to stream.
 */
app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  try {
    const from = req.body.From || "";
    // If you’re using Twilio’s <Gather input="speech">, Twilio puts transcript in `SpeechResult`.
    // If not, default to a greeting.
    const callerText = req.body.SpeechResult || req.body.Body || "Hello.";

    const reply = await generateReply({ callerText, fromNumber: from });
    const { publicUrl } = await ttsElevenLabs(reply);

    // Build TwiML
    // Tip: add a short pause to avoid clipping the first syllable on some carriers.
    twiml.pause({ length: 1 });
    twiml.play(publicUrl);

    // Optional: follow-up prompt (text-to-speech fallback)
    // twiml.say({ voice: "Polly.Joanna" }, "Did you need help with pre-approval, or refinancing?");

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("VOICE ERROR:", err);
    // Fallback: speak with Twilio TTS if anything fails
    twiml.say(
      { voice: "Polly.Joanna" },
      "Thanks for calling Official Mortgage. Our assistant hit a snag. Please try again in a moment, or leave your name and number."
    );
    res.type("text/xml").send(twiml.toString());
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`AI Bridge running on http://localhost:${PORT}`);
});
