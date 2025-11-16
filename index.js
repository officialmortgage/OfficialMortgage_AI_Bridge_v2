// ============================================================
// Official Mortgage — Liv AI Bridge v2 (Final multi-route version)
// Twilio Voice → OpenAI STT/LLM → TTS → Twilio
// Supports both /voice and /twilio/voice (and /gather variants)
// ============================================================

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const {
  twiml: { VoiceResponse },
} = require("twilio");
const OpenAI = require("openai");

// App setup
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Per-call memory store
const sessions = new Map();

// ============================================================
// 1. SYSTEM PROMPT — LIV V2 MEGA BRAIN
// ============================================================

const LIV_SYSTEM_PROMPT = `
You are Liv, the Official Mortgage voice assistant.
You never say you are AI. You speak naturally, confidently, in short concise sentences.

INTRO:
“This is Liv with Official Mortgage. How can I help you today?”

PRIMARY MISSIONS:
1. Understand caller goal: purchase, refi, DSCR, jumbo, agent partner.
2. Ask smart follow-up questions.
3. Uncover timeline, fears, and context.
4. Build trust using brief reflections.
5. Avoid long monologues.
6. Move the caller to one of these outcomes:
   - send application link
   - send pricing portal link
   - send secure doc upload link
   - schedule callback
   - answer questions and guide next steps

NEVER SAY:
- “AI”, “assistant model”, “language model”, “ChatGPT”

ALWAYS:
- Stay confident
- Keep sentences short
- Offer to move the caller forward

TOOLS YOU CAN USE:
- send_secure_link
- log_lead_to_crm
- schedule_callback
- tag_conversation_outcome
- escalate_to_human

WHEN USING TOOLS:
- Narrate naturally (“I just texted you the link”)
- Use tools only when it benefits the caller
`;

// ============================================================
// 2. TOOL DEFINITIONS FOR OPENAI
// ============================================================

const tools = [
  {
    name: "send_secure_link",
    description: "Send borrower secure link via SMS or email",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string" },
        recipient: { type: "string" },
        purpose: { type: "string" },
        borrower_name: { type: "string" },
        notes: { type: "string" },
      },
      required: ["channel", "recipient", "purpose"],
    },
  },
  {
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
        source: { type: "string" },
        urgency: { type: "string" },
        summary: { type: "string" },
        notes_for_officer: { type: "string" },
      },
      required: ["lead_type", "journey", "summary"],
    },
  },
  {
    name: "schedule_callback",
    description: "Schedule callback",
    parameters: {
      type: "object",
      properties: {
        full_name: { type: "string" },
        phone: { type: "string" },
        preferred_time_window: { type: "string" },
        timezone: { type: "string" },
        topic: { type: "string" },
        priority: { type: "string" },
      },
      required: ["full_name", "phone", "preferred_time_window", "topic", "priority"],
    },
  },
  {
    name: "tag_conversation_outcome",
    description: "Tag call ending",
    parameters: {
      type: "object",
      properties: {
        outcome: { type: "string" },
        details: { type: "string" },
      },
      required: ["outcome"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Escalate call",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        severity: { type: "string" },
      },
      required: ["reason", "severity"],
    },
  },
];

// ============================================================
// 3. TOOL HANDLERS (Temporary: log only)
// ============================================================

async function handleToolCall(toolCall) {
  const { name } = toolCall.function;
  let args;

  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {
    console.error("Tool argument parse error:", e);
    args = {};
  }

  console.log(`TOOL CALL → ${name}`, args);

  // Placeholder responses (safe for production, real services optional)
  switch (name) {
    case "send_secure_link":
      return `The secure ${args.purpose || "mortgage"} link was sent to ${args.recipient || "the borrower"}.`;
    case "log_lead_to_crm":
      return "Lead logged successfully.";
    case "schedule_callback":
      return `Callback scheduled for ${args.preferred_time_window || "the requested time window"}.`;
    case "tag_conversation_outcome":
      return `Outcome recorded: ${args.outcome || "unspecified"}.`;
    case "escalate_to_human":
      return "A human loan officer will follow up.";
    default:
      return "Tool executed.";
  }
}

// ============================================================
// 4. AI RUNNER
// ============================================================

async function runLiv(session) {
  const response = await openai.chat.completions.create({
    model: "gpt-5.1-mini",
    messages: session.messages,
    tools,
    tool_choice: "auto",
  });

  const msg = response.choices[0].message;

  // If tool calls detected
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    session.messages.push({ role: "assistant", tool_calls: msg.tool_calls });

    for (const call of msg.tool_calls) {
      const result = await handleToolCall(call);
      session.messages.push({
        role: "tool",
        name: call.function.name,
        content: result,
      });
    }

    // Re-run after tools
    const second = await openai.chat.completions.create({
      model: "gpt-5.1-mini",
      messages: session.messages,
    });

    return second.choices[0].message.content || "";
  }

  return msg.content || "";
}

// ============================================================
// 5. SESSION CREATION
// ============================================================

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      messages: [{ role: "system", content: LIV_SYSTEM_PROMPT }],
    });
  }
  return sessions.get(callSid);
}

// ============================================================
// 6. TWILIO HANDLERS (shared)
// ============================================================

function handleVoice(req, res) {
  console.log("Incoming /voice webhook");

  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    action: "/gather",
    speechTimeout: "auto",
  });

  gather.say(
    { voice: "Polly.Joanna" },
    "This is Liv with Official Mortgage. How can I help you today?"
  );

  res.type("text/xml").send(vr.toString());
}

async function handleGather(req, res) {
  console.log("Incoming /gather webhook");

  const callSid = req.body.CallSid;
  const transcript = req.body.SpeechResult;

  const vr = new VoiceResponse();

  if (!transcript) {
    console.log("No SpeechResult received");
    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto",
    });
    g.say({ voice: "Polly.Joanna" }, "I didn't catch that. Could you repeat it?");
    return res.type("text/xml").send(vr.toString());
  }

  console.log(`Caller said: ${transcript}`);

  const session = getSession(callSid);
  session.messages.push({ role: "user", content: transcript });

  try {
    const reply = await runLiv(session);
    session.messages.push({ role: "assistant", content: reply });

    console.log(`Liv reply: ${reply}`);

    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto",
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
}

// ============================================================
// 7. ROUTES (support both /voice and /twilio/voice)
// ============================================================

// Primary routes
app.post("/voice", handleVoice);
app.post("/gather", handleGather);

// Backwards-compatible routes (if Twilio is still pointed at /twilio/voice)
app.post("/twilio/voice", handleVoice);
app.post("/twilio/gather", handleGather);

// Health + root
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "Liv AI Bridge v2" });
});

app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running. Try /health.");
});

// ============================================================
// 8. START SERVER (Render requires process.env.PORT)
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Liv AI Bridge listening on port ${PORT}`);
});
