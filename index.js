import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true })); // Twilio form posts
app.use(express.json());

// 1) Root route (helps Render “Cannot GET /”)
app.get("/", (req, res) => {
  res.type("text").send("OfficialMortgage AI Bridge is live. Try /health or /tts?text=Hello");
});

// 2) Health route (Render/monitors)
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "AI Bridge is online" });
});

// 3) Text-to-speech demo route (GET) — returns MP3 from ElevenLabs
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "Testing ElevenLabs").toString().slice(0, 500);
    const apiKey = sk_84581f04cb2d7e4144244199a384d488fe11a24fd84e4759;
    const voiceId = JH3fX8OSjg6sNdEtPjxr;

    if (!apiKey || !voiceId) {
      return res
        .status(500)
        .json({ ok: false, error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID" });
    }

    const ttsResp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=0&output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_monolingual_v1",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );

    if (!ttsResp.ok) {
      const errTxt = await ttsResp.text();
      return res.status(500).json({ ok: false, error: `TTS failed: ${errTxt}` });
    }

    const mp3 = Buffer.from(await ttsResp.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'inline; filename="tts.mp3"');
    res.send(mp3);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`AI Bridge running on http://localhost:${PORT}`);
});

