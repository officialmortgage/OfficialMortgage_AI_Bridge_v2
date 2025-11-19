// ============================================================
// Official Mortgage — Liv AI Bridge v5.1
// Twilio Voice + SMS → OpenAI (GPT-5.1) → ElevenLabs (voice) / SMS text
// ============================================================

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse, MessagingResponse } } = require("twilio");
const OpenAI = require("openai");

// Brain loader (your patched v4 brain + CTA/Closer rules)
const { livSystemPrompt } = require("./livBrain");

// ------------------------------------------------------------
// App setup
// ------------------------------------------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Serve generated ElevenLabs audio files
const audioDir = path.join(__dirname, "audio");
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir);
}
app.use("/audio", express.static(audioDir));

// ------------------------------------------------------------
// OpenAI client (GPT-5.1)
// ------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ------------------------------------------------------------
// ElevenLabs config
// ------------------------------------------------------------
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// IMPORTANT: must match your Render service URL
// Example: https://officialmortgage-ai-bridge-v2.onrender.com
const BASE_URL = process.env.BASE_URL || "https://officialmortgage-ai-bridge-v2.onrender.com";

// ------------------------------------------------------------
// Helper: call Liv brain via GPT-5.1
// ------------------------------------------------------------
async function getLivReply(userText, channel) {
  const messages = [
    {
      role: "system",
      content: livSystemPrompt
    },
    {
      role: "user",
      content: `Channel: ${channel}\nCaller says: ${userText}`
    }
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages
  });

  const choice = completion.choices[0];
  const text = (choice.message && choice.message.content)
    ? choice.message.content.trim()
    : "";

  return text || "I’m here and listening. How can I help you with your mortgage today?";
}

// ------------------------------------------------------------
// Helper: synthesize speech with ElevenLabs and return public URL
// ------------------------------------------------------------
async function synthesizeSpeechToUrl(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    // Fallback: let Twilio <Say> handle it if ElevenLabs isn’t configured
    return null;
  }

  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8
      }
    })
  });

  if (!response.ok) {
    console.error("ElevenLabs TTS error:", response.status, await response.text());
    return null;
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const id = crypto.randomUUID();
  const filename = `${id}.mp3`;
  const filepath = path.join(audioDir, filename);

  await fs.promises.writeFile(filepath, buffer);

  // URL Twilio can reach
  return `${BASE_URL}/audio/${filename}`;
}

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.status(200).send("OK - Liv AI Bridge running");
});

// ------------------------------------------------------------
// SMS webhook
// ------------------------------------------------------------
app.post("/sms", async (req, res) => {
  const incomingBody = (req.body.Body || "").trim();
  const from = req.body.From || "Unknown";

  console.log("SMS from", from, ":", incomingBody);

  const twiml = new MessagingResponse();

  try {
    const livReply = await getLivReply(incomingBody, "SMS");
    twiml.message(livReply);
  } catch (err) {
    console.error("Error handling SMS:", err);
    twiml.message("I’m having trouble responding right now, but I’ll be back shortly.");
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------------------------------------------------------
// Voice: initial entry point
// Twilio webhook URL: POST /voice
// Uses ElevenLabs for the greeting so you only hear one voice.
// ------------------------------------------------------------
app.post("/voice", async (req, res) => {
  const from = req.body.From || "Unknown";
  console.log("Incoming voice call from", from);

  const twiml = new VoiceResponse();

  const greetingText =
    "Hi, this is Liv with Official Mortgage. How can I help you today — buy a home, refinance, or pull cash out of your equity?";

  const gather = twiml.gather({
    input: "speech",
    action: "/voice/handle",
    method: "POST",
    speechTimeout: "auto"
  });

  try {
    const audioUrl = await synthesizeSpeechToUrl(greetingText);

    if (audioUrl) {
      gather.play(audioUrl);
    } else {
      // Fallback: Twilio TTS only if ElevenLabs is unavailable
      gather.say(
        {
          voice: "Polly.Joanna"
        },
        greetingText
      );
    }
  } catch (err) {
    console.error("Error getting ElevenLabs greeting:", err);
    gather.say(
      {
        voice: "Polly.Joanna"
      },
      greetingText
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------------------------------------------------------
// Voice: fallback if no speech detected
// ------------------------------------------------------------
app.post("/voice/fallback", (_req, res) => {
  const twiml = new VoiceResponse();
  twiml.say("I didn’t catch anything. Please call back if you still need help. Goodbye.");
  twiml.hangup();
  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------------------------------------------------------
// Voice: handle caller's speech, call GPT-5.1, play ElevenLabs audio
// Only ElevenLabs is used for the reply when possible.
// ------------------------------------------------------------
app.post("/voice/handle", async (req, res) => {
  const speechResult = (req.body.SpeechResult || "").trim();
  const from = req.body.From || "Unknown";

  console.log("Speech from", from, ":", speechResult);

  const twiml = new VoiceResponse();

  if (!speechResult) {
    // No speech heard, send them back through the greeting flow once
    twiml.redirect("/voice");
    res.type("text/xml");
    return res.send(twiml.toString());
  }

  try {
    const livReply = await getLivReply(speechResult, "VOICE");
    console.log("Liv reply:", livReply);

    // Gather for the next turn and play ElevenLabs inside the gather,
    // so there is only one voice.
    const gather = twiml.gather({
      input: "speech",
      action: "/voice/handle",
      method: "POST",
      speechTimeout: "auto"
    });

    const audioUrl = await synthesizeSpeechToUrl(livReply);

    if (audioUrl) {
      gather.play(audioUrl);
    } else {
      // Fallback to Twilio TTS if ElevenLabs unavailable
      gather.say(livReply);
    }

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("Error handling voice:", err);

    twiml.say("I’m having trouble thinking right now. Please try again in a few minutes.");
    twiml.hangup();
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Liv AI Bridge v5.1 listening on port ${PORT}`);
});
