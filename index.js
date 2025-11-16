// ============================================================
// Official Mortgage — Liv AI Bridge v2 (Stable Fixed Build)
// Twilio Voice → OpenAI LLM (with tools) → TTS → Twilio
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

// Session store (per CallSid)
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
1. Understand caller goal (purchase, refi, DSCR, jumbo, agent partner, etc.).
2. Ask smart follow-up questions.
3. Build trust using brief reflections, not long speeches.
4. Keep answers short and focused.
5. Move the caller forward (application link, pricing link, callback, etc.).
`;

// ============================================================
// TOOLS — correct OpenAI format (type + function object)
// ============================================================

const tools = [
  {
    type: "function",
    function: {
      name: "send_secure_link",
      description: "Send borrower a secure link via SMS or email",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string" }, // sms, email, etc.
          recipient: { type: "string" },
          purpose: { type: "string" }, // app_link, pricing_link, docs_link, etc.
        },
        required: ["channel", "recipient", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_lead_to_crm",
      description: "Log borrower lead into CRM",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          lead_type: { type: "string" }, // purchase, refi, DSCR, jumbo, etc.
          journey: { type: "string" }, // first-time buyer, move-up, investor, etc.
          summary: { type: "string" },
        },
        required: ["lead_type", "journey", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_callback",
      description: "Schedule a callback with a human loan officer",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          preferred_time_window: { type: "string" }, // e.g. "Tomorrow morning 9–11am"
          topic: { type: "string" }, // purchase, refi, DSCR, etc.
        },
        required: ["full_name", "phone", "preferred_time_window", "topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tag_conversation_outcome",
      description: "Tag how the call ended",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string" }, // e.g. "application_link_sent"
          details: { type: "string" },
        },
        required: ["outcome"],
      },
    },
  },
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
      return "I’ve logged your details so a loan officer can follow up.";
    case "schedule_callback":
      return `Okay, I’ll have a loan officer call you ${args.preferred_time_window}.`;
    case "tag_conversation_outcome":
      return "Got it, I’ve noted how this call ended.";
    default:
      return "Done.";
  }
}

// ============================================================
// AI RUNNER — uses gpt-4o-mini with tools
// ============================================================

async function runLiv(session) {
  // First call: let Liv decide whether to use tools
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: session.messages,
    tools,
    tool_choice: "auto",
  });

  const msg = response.choices[0].message;

  // If Liv decided to use tools, run them and then re-call the model
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    session.messages.push({
      role: "assistant",
      tool_calls: msg.tool_calls,
    });

    for (const call of msg.tool_calls) {
      const result = await handleToolCall(call);
      session.messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }

    const second = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: session.messages,
    });

    return second.choices[0].message.content || "";
  }

  // No tools; just return Liv's reply
  return msg.content || "";
}

// ============================================================
// SESSION MANAGEMENT
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
// TWILIO: /voice  — first entry on incoming call
// ============================================================

app.post("/voice", (req, res) => {
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
});

// ============================================================
// TWILIO: /gather — handles each user utterance
// ============================================================

app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const transcript = req.body.SpeechResult;

  const vr = new VoiceResponse();

  // If Twilio didn't get speech, reprompt
  if (!transcript) {
    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto",
    });
    g.say(
      { voice: "Polly.Joanna" },
      "I didn't catch that. Could you repeat it?"
    );
    return res.type("text/xml").send(vr.toString());
  }

  console.log(`Caller said: ${transcript}`);

  const session = getSession(callSid);
  session.messages.push({ role: "user", content: transcript });

  try {
    const reply = await runLiv(session);
    session.messages.push({ role: "assistant", content: reply });

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
});

// ============================================================
// ROOT HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running.");
});

// ============================================================
// START SERVER (Render requires process.env.PORT)
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Liv AI Bridge listening on port ${PORT}`);
});
