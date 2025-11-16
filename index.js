// ============================================================
// Official Mortgage — Liv AI Bridge v2 (Stable Fixed Build)
// Twilio Voice → OpenAI STT/LLM (with tools) → TTS → Twilio
// ============================================================

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse } } = require("twilio");
const OpenAI = require("openai");

// App setup
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Session store
const sessions = new Map();

// SYSTEM PROMPT
const LIV_SYSTEM_PROMPT = `
You are Liv, the Official Mortgage voice assistant.
You never say you are AI. You speak naturally, confidently,
in short concise sentences.

INTRO:
“This is Liv with Official Mortgage. How can I help you today?”

PRIMARY MISSIONS:
1. Understand caller goal.
2. Ask smart follow-up questions.
3. Build trust.
4. Short answers.
5. Move caller forward (app link, pricing link, callback, etc.)
`;

// ============================================================
// TOOLS — NOW WITH type:"function" (required by OpenAI v2)
// ============================================================

const tools = [
  {
    type: "function",
    name: "send_secure_link",
    description: "Send borrower a secure link",
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
    description: "Log borrower lead",
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
    description: "Schedule a callback",
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
    description: "Tag call outcome",
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
// TOOL HANDLER
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
      return "Lead has been logged.";
    case "schedule_callback":
      return `Okay, I’ll schedule that.`;
    case "tag_conversation_outcome":
      return "Got it.";
    default:
      return "Done.";
  }
}

// ============================================================
// AI RUNNER — updated to use gpt-4o-mini (stable)
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
    session.messages.push({ role: "assistant", tool_calls: msg.tool_calls });

    for (const call of msg.tool_calls) {
      const result = await handleToolCall(call);
      session.messages.push({
        role: "tool",
        name: call.function.name,
        content: result
      });
    }

    // Re-run after tools
    const second = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: session.messages
    });

    return second.choices[0].message.content || "";
  }

  return msg.content || "";
}

// ============================================================
// SESSION
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
// TWILIO: /voice
// ============================================================

app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    action: "/gather",
    speechTimeout: "auto"
  });

  gather.say(
    { voice: "Polly.Joanna" },
    "This is Liv with Official Mortgage. How can I help you today?"
  );

  res.type("text/xml").send(vr.toString());
});

// ============================================================
// TWILIO: /gather
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
    g.say({ voice: "Polly.Joanna" }, "I didn't catch that. Could you repeat it?");
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

    g.say({ voice: "Polly.Joanna" }, reply);

    res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error("AI error:", err);

    vr.say(
      { voice: "Polly.Joanna" },
      "I'm having trouble right now. A loan officer will follow up shortly."
    );
    res.type("text/xml").send(vr.toString());
  }
});

// Root
app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running.");
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Liv AI Bridge listening on port ${PORT}`);
});
