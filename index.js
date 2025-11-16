// ============================================================
// Official Mortgage — Liv AI Bridge v2
// Twilio Voice + SMS → OpenAI (tools) → ElevenLabs (voice) / SMS text
// ============================================================

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse, MessagingResponse } } = require("twilio");
const OpenAI = require("openai");
const { Readable } = require("stream");

// ------------------------------------------------------------
// App setup
// ------------------------------------------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ------------------------------------------------------------
// OpenAI client
// ------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ------------------------------------------------------------
// ElevenLabs config
// ------------------------------------------------------------
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// IMPORTANT: must match Render service URL
const BASE_URL = "https://officialmortgage-ai-bridge-v2.onrender.com";

// ------------------------------------------------------------
// CTA LINKS (used in the system prompt, NOT auto-sent)
// ------------------------------------------------------------
const CTA_LINKS = {
  MARKETPLACE: "https://bit.ly/OfficialMortgageMarketplace",
  DSCR: "https://www.officialmtg.com/loan-programs/dscr-loans",
  CALENDLY: "https://calendly.com/officialmtg/new-meeting",
  DOC_UPLOAD: "https://www.officialmtg.com/isadore/applications/register?app_type=secure-documents",
  FULL_1003: "https://www.officialmtg.com/default/applications/register?app_type=full",
  REFI_SMARTCHECK: "https://www.officialmtg.com/loan-programs/refinance-loans",
  HOMEPAGE: "http://www.officialmtg.com"
};

// ------------------------------------------------------------
// Per-channel memory
// ------------------------------------------------------------
// Voice sessions keyed by CallSid
const voiceSessions = new Map();
// SMS sessions keyed by From phone number
const smsSessions = new Map();

// ------------------------------------------------------------
// SYSTEM PROMPT
// ------------------------------------------------------------
const LIV_SYSTEM_PROMPT = `
You are Liv, the Official Mortgage voice and SMS assistant.

You NEVER say that you are AI. You speak like a real human assistant:
- Calm, confident, professional
- Short, clear sentences
- No jargon unless the caller/text sender already uses it

CHANNEL BEHAVIOR
- On a PHONE CALL: speak as if you are talking live.
- On SMS: reply in 1–3 short text messages, no walls of text.

PRIMARY MISSIONS
1) Quickly understand what they want:
   - Purchase
   - Refinance / cash-out
   - Jumbo
   - DSCR / investor
   - HELOC / 2nd
   - Real estate agent partner
2) Ask smart, lightweight follow-up questions.
3) Build trust and keep it simple.
4) Move them toward a next step with a clear CTA.

USE THESE OFFICIAL CTA LINKS (mention them naturally when appropriate):
- Official Mortgage Marketplace (pricing + application hub):
  ${CTA_LINKS.MARKETPLACE}
- DSCR / Investor info page:
  ${CTA_LINKS.DSCR}
- Refinance SmartCheck page:
  ${CTA_LINKS.REFI_SMARTCHECK}
- Book a call with a loan officer:
  ${CTA_LINKS.CALENDLY}
- Secure document upload:
  ${CTA_LINKS.DOC_UPLOAD}
- Full mortgage application (1003):
  ${CTA_LINKS.FULL_1003}
- Homepage:
  ${CTA_LINKS.HOMEPAGE}

GENERAL RULES
- Always sound like you are coming FROM Official Mortgage.
- Don’t quote exact interest rates.
- For detailed pricing, guide them to the Marketplace link so they can see live options.
- If they seem confused, slow down and summarize in plain language.
- If they are not ready, offer a “no-pressure” next step like a quick call or Marketplace account.
`;

// ------------------------------------------------------------
// OpenAI tools (function calling)
// ------------------------------------------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "send_secure_link",
      description: "Send borrower a secure link (SMS or email).",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "sms or email" },
          recipient: { type: "string", description: "phone number or email" },
          purpose: { type: "string", description: "what the link is for" }
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
          lead_type: { type: "string", description: "purchase, refi, DSCR, jumbo, etc." },
          journey: { type: "string", description: "where they are in the process" },
          summary: { type: "string", description: "short natural-language summary" }
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
      description: "Tag how the call or SMS thread ended.",
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

// ------------------------------------------------------------
// TOOL HANDLER (currently just returns natural-language acks)
// ------------------------------------------------------------
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
      return "Okay, I’ll have a loan officer reach out during that time window.";
    case "tag_conversation_outcome":
      return "Got it, I’ve noted how this conversation ended.";
    default:
      return "Done.";
  }
}

// ------------------------------------------------------------
// AI runner (shared by voice + SMS)
// ------------------------------------------------------------
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
        tool_call_id: call.id,
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

// ------------------------------------------------------------
// SESSION MANAGEMENT
// ------------------------------------------------------------
function getVoiceSession(callSid) {
  if (!voiceSessions.has(callSid)) {
    voiceSessions.set(callSid, {
      messages: [
        {
          role: "system",
          content: LIV_SYSTEM_PROMPT + "\nYou are on a LIVE PHONE CALL. Keep responses brief so Twilio can play them as audio."
        }
      ]
    });
  }
  return voiceSessions.get(callSid);
}

function getSmsSession(phone) {
  if (!smsSessions.has(phone)) {
    smsSessions.set(phone, {
      messages: [
        {
          role: "system",
          content: LIV_SYSTEM_PROMPT + "\nYou are chatting over SMS. Reply in short, clear text messages."
        }
      ]
    });
  }
  return smsSessions.get(phone);
}

// ------------------------------------------------------------
// ElevenLabs TTS endpoint (used by Twilio <Play>)
// ------------------------------------------------------------
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
      console.error("ElevenLabs bad response:", apiRes.status);
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

// Small helper to play TTS for a <Gather>
function playTts(g, text) {
  g.play(`${BASE_URL}/tts?text=${encodeURIComponent(text)}`);
}

// ------------------------------------------------------------
// TWILIO VOICE ROUTES
// ------------------------------------------------------------

// Main entry for phone calls
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

// Backwards-compatibility: /twilio/liv -> same as /voice
app.post("/twilio/liv", (req, res) => {
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: "speech",
    action: "/gather",
    speechTimeout: "auto"
  });

  playTts(g, "This is Liv with Official Mortgage. How can I help you today?");
  res.type("text/xml").send(vr.toString());
});

// Handles each spoken turn
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

  const session = getVoiceSession(callSid);
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
    console.error("Voice AI error:", err);
    vr.say("I’m having trouble right now. A loan officer will follow up shortly.");
    res.type("text/xml").send(vr.toString());
  }
});

// ------------------------------------------------------------
// TWILIO SMS ROUTE
// ------------------------------------------------------------
app.post("/sms", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  const twiml = new MessagingResponse();

  if (!body) {
    twiml.message("I didn’t catch that. Text me what you’re trying to do with your mortgage.");
    return res.type("text/xml").send(twiml.toString());
  }

  const session = getSmsSession(from);
  session.messages.push({ role: "user", content: body });

  try {
    const reply = await runLiv(session);
    session.messages.push({ role: "assistant", content: reply || "" });

    twiml.message(reply || "Thanks for reaching out to Official Mortgage.");
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("SMS AI error:", err);
    twiml.message("I’m having trouble right now, but a loan officer will follow up shortly.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ------------------------------------------------------------
// Health / root
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running with ElevenLabs voice + OpenAI tools + Marketplace intents (voice + SMS).");
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Liv AI Bridge running on port", PORT);
});
