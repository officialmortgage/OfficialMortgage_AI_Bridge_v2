// ============================================================
// Official Mortgage — Liv AI Bridge v2 (ElevenLabs Voice Build)
// Twilio Voice → OpenAI (tools) → ElevenLabs TTS → Twilio
// ============================================================

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse } } = require("twilio");
const OpenAI = require("openai");
const { Readable } = require("stream");

// App setup
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// IMPORTANT: this must match your Render service URL
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
// TOOLS (OpenAI v2 format: type: "function")
// ============================================================

const tools = [
  {
    type: "function",
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
  },
  {
    type: "function",
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
  },
  {
    type: "function",
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
  },
  {
    type: "function",
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
];

// ============================================================
// TOOL HANDLER (returns natural-language summaries)
// ============================================================

async function handleToolCall(toolCall) {
  const { name, arguments: argString } = toolCall.function;
  let args = {};

  try {
    args = JSON.parse(argString);
  } catch (e) {
    console.error("Tool argument parse error:", e);
  }

  console.log("TOOL CALL →", name, args);

  switch (name) {
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
// AI RUNNER — gpt-4o-mini + tools (with tool_call_id fixed)
// ============================================================

async function runLiv(session) {
  // First call: allow tools
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: session.messages,
    tools,
    tool_choice: "auto"
  });

  const msg = response.choices[0].message;

  // If tools were called
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    // Record assistant tool_calls message
    session.messages.push({
      role: "assistant",
      tool_calls: msg.tool_calls
    });

    // Execute each tool and push a corresponding tool-message
    for (const call of msg.tool_calls) {
      const result = await handleToolCall(call);
      session.messages.push({
        role: "tool",
        tool_call_id: call.id,         // <- REQUIRED FIELD
        content: result
      });
    }

    // Second call: now with tool results in history
    const second = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: session.messages
    });

    return second.choices[0].message.content || "";
  }

  // No tools, just return the assistant message
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
// ElevenLabs TTS endpoint  →  Twilio <Play> uses this URL
// ============================================================

app.get("/tts", async (req, res) => {
  const text = req.query.text || "This is Liv with Official Mortgage.";

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.error("Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID");
    return res.status(500).end();
  }

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
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8
          }
        })
      }
    );

    if (!apiRes.ok || !apiRes.body) {
      console.error("ElevenLabs TTS HTTP error:", apiRes.status, await apiRes.text());
      return res.status(500).end();
    }

    res.setHeader("Content-Type", "audio/mpeg");

    const nodeStream = Readable.fromWeb(apiRes.body);
    nodeStream.pipe(res);
  } catch (err) {
    console.error("ElevenLabs TTS exception:", err);
    res.status(500).end();
  }
});

// Helper to add TTS prompt to a <Gather>
function playTtsInGather(gather, text) {
  const url = `${BASE_URL}/tts?text=${encodeURIComponent(text)}`;
  gather.play(url);
}

// ============================================================
// TWILIO: /voice  (initial greeting)
// ============================================================

app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();

  const greeting = "This is Liv with Official Mortgage. How can I help you today?";

  const gather = vr.gather({
    input: "speech",
    action: "/gather",
    speechTimeout: "auto"
  });

  playTtsInGather(gather, greeting);

  res.type("text/xml").send(vr.toString());
});

// ============================================================
// TWILIO: /gather  (conversation loop)
// ============================================================

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
    playTtsInGather(g, "I didn't catch that. Could you repeat it?");
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

    playTtsInGather(g, reply);

    res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error("AI error:", err);

    // Simple fallback if OpenAI or ElevenLabs fail
    vr.say(
      "I'm having trouble right now. A loan officer will follow up shortly."
    );
    res.type("text/xml").send(vr.toString());
  }
});

// Root
app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running with ElevenLabs voice.");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Liv AI Bridge listening on port ${PORT}`);
});
