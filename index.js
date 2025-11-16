// ============================================================
// Official Mortgage — Liv AI Bridge v2 (ElevenLabs Voice Build)
// Twilio Voice → OpenAI (tools) → ElevenLabs TTS → Twilio
// + LIV Marketplace Intent Bridge (via src/livRouter.js)
// ============================================================

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse } } = require("twilio");
const OpenAI = require("openai");
const { Readable } = require("stream");

// NEW: LIV Marketplace router (intent + Marketplace URLs)
const liv = require("./src/livRouter");

// App setup
const app = express();
// Parse form-encoded (Twilio) and JSON (webhooks)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// IMPORTANT: must match Render service URL
const BASE_URL = "https://officialmortgage-ai-bridge-v2.onrender.com";

// Per-call memory
const sessions = new Map();

// ============================================================
// SYSTEM PROMPT
// ============================================================

const LIV_SYSTEM_PROMPT = `
You are Liv, the Official Mortgage voice assistant.
You never say you are AI. You speak naturally, confidently,
in short concise sentences.

INTRO:
“This is Liv with Official Mortgage. How can I help you today?”

PRIMARY MISSIONS:
1. Understand caller goal (purchase, refi, cash out, jumbo, DSCR, agent partner).
2. Ask smart follow-up questions.
3. Build trust.
4. Keep answers short and clear.
5. Move caller toward a next step (application link, pricing link, callback, etc.).
`;

// ============================================================
// 🔥 FIXED — OPENAI V2 TOOL FORMAT (function wrapper required)
// ============================================================

const tools = [
  {
    type: "function",
    function: {
      name: "send_secure_link",
      description: "Send borrower a secure link (SMS or email).",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" },
          recipient: { type: "string" },
          purpose: { type: "string" }
        },
        required: ["channel", "recipient", "purpose"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "log_lead_to_crm",
      description: "Log borrower lead details for follow-up.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          lead_type: { type: "string" },
          journey: { type: "string" },
          summary: { type: "string" }
        },
        required: ["lead_type", "journey", "summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "schedule_callback",
      description: "Schedule a callback with a loan officer.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          preferred_time_window: { type: "string" },
          topic: { type: "string" }
        },
        required: ["full_name", "phone", "preferred_time_window", "topic"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "tag_conversation_outcome",
      description: "Tag how the call ended.",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string" },
          details: { type: "string" }
        },
        required: ["outcome"]
      }
    }
  }
];

// ============================================================
// TOOL HANDLER
// ============================================================

async function handleToolCall(call) {
  const fn = call.function;
  let args = {};

  try {
    args = JSON.parse(fn.arguments);
  } catch (e) {
    console.error("Tool argument parse error:", e);
  }

  console.log("TOOL CALL →", fn.name, args);

  switch (fn.name) {
    case "send_secure_link":
      return `I just sent the ${args.purpose} link to ${args.recipient}.`;
    case "log_lead_to_crm":
      return "I’ve logged your details so a loan officer can follow up.";
    case "schedule_callback":
      return "Okay, I’ll schedule that callback for you.";
    case "tag_conversation_outcome":
      return "Got it, I’ve noted how this call ended.";
    default:
      return "Done.";
  }
}

// ============================================================
// AI RUNNER
// ============================================================

async function runLiv(session) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: session.messages,
    tools,
    tool_choice: "auto"
  });

  const msg = response.choices[0].message;

  // Tool calls
  if (msg.tool_calls?.length) {
    for (const call of msg.tool_calls) {
      session.messages.push({ role: "assistant", tool_calls: [call] });

      const result = await handleToolCall(call);

      session.messages.push({
        role: "tool",
        tool_call_id: call.id,   // 🔥 REQUIRED FIELD
        content: result
      });
    }

    const second = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: session.messages
    });

    return second.choices[0].message.content || "";
  }

  return msg.content || "";
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      messages: [
        { role: "system", content: LIV_SYSTEM_PROMPT }
      ]
    });
  }
  return sessions.get(callSid);
}

// ============================================================
// ElevenLabs TTS endpoint
// ============================================================

app.get("/tts", async (req, res) => {
  const text = req.query.text || "This is Liv with Official Mortgage.";

  try {
    const apiRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2"
        })
      }
    );

    if (!apiRes.ok || !apiRes.body) {
      return res.status(500).end();
    }

    res.setHeader("Content-Type", "audio/mpeg");
    const stream = Readable.fromWeb(apiRes.body);
    stream.pipe(res);

  } catch (err) {
    console.error("ElevenLabs error:", err);
    res.status(500).end();
  }
});

// Utility for gather speech
function playTts(g, text) {
  g.play(`${BASE_URL}/tts?text=${encodeURIComponent(text)}`);
}

// ============================================================
// TWILIO VOICE ROUTES (LIVE CONVERSATION FLOW)
// ============================================================

app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: "speech",
    action: "/gather",
    speechTimeout: "auto"
  });
  playTts(g, "This is Liv with Official Mortgage. How can I help you today?");
  res.type("text/xml").send(vr.toString());
});

app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const transcript = req.body.SpeechResult;

  const vr = new VoiceResponse();

  if (!transcript) {
    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto"
    });
    playTts(g, "I didn't catch that. Could you repeat it?");
    return res.type("text/xml").send(vr.toString());
  }

  const session = getSession(callSid);
  session.messages.push({ role: "user", content: transcript });

  try {
    const reply = await runLiv(session);
    session.messages.push({ role: "assistant", content: reply });

    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto"
    });
    playTts(g, reply);

    res.type("text/xml").send(vr.toString());

  } catch (err) {
    console.error("AI error:", err);
    vr.say("I’m having trouble right now. A loan officer will follow up shortly.");
    res.type("text/xml").send(vr.toString());
  }
});

// ============================================================
// NEW: LIV MARKETPLACE / SMS / WEBHOOK ROUTES
// ============================================================

// Twilio inbound webhook (SMS or voice-to-text intent router)
app.post("/twilio/liv", liv.handleTwilioWebhook);

// Marketplace event callback (account created, app completed, etc.)
app.post("/liv/marketplace-event", liv.handleMarketplaceEvent);

// Valuation callback (from your internal valuation workflow)
app.post("/liv/valuation-callback", liv.handleValuationCallback);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running with ElevenLabs voice + OpenAI tools + Marketplace intents.");
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Liv AI Bridge running on port", PORT));
