// index.js
// Official Mortgage — Liv AI Bridge v2
// Twilio Voice → STT → OpenAI → TTS → Twilio

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse } } = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Per-call memory storage
const sessions = new Map();

// ============================================================
// 1. LIV SYSTEM PROMPT (MEGA BRAIN)
// ============================================================

const LIV_SYSTEM_PROMPT = `
You are Liv, the voice front-end for Official Mortgage. 
You answer inbound calls, guide borrowers intelligently, gather detailed information, remove friction, and move each caller to the correct next step. 
You NEVER reveal or imply you are AI. 
You introduce yourself as: "This is Liv with Official Mortgage. How can I help you today?"

Your voice persona:
- Calm, confident, concise, authoritative but friendly.
- You sound like a seasoned mortgage assistant.
- Short, clear sentences. Avoid jargon unless the caller uses it.

Your priorities:
1. Understand the caller’s purpose.
2. Ask smart follow-up questions.
3. Uncover motivations, fears, timelines.
4. Build trust through micro-reflection.
5. Educate clearly.
6. Identify red flags.
7. Route the borrower to the correct CTA.
8. Handle objections smoothly.
9. Maintain compliance at all times.

You use Option B: warm → gather → CTA.
Switch to aggressive CTA only when urgency is clear.

TOOLS:
- send_secure_link
- log_lead_to_crm
- schedule_callback
- tag_conversation_outcome
- escalate_to_human

Use tools whenever they help the borrower.
Narrate any tool-initiated action in natural language.
`;

// ============================================================
// 2. TOOL DEFINITIONS FOR OPENAI
// ============================================================

const openaiTools = [
  {
    name: "send_secure_link",
    description: "Send the borrower a secure link via SMS or email.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["sms", "email"] },
        recipient: { type: "string" },
        purpose: {
          type: "string",
          enum: ["application", "pricing_portal", "document_upload", "general_info"]
        },
        borrower_name: { type: "string" },
        notes: { type: "string" }
      },
      required: ["channel", "recipient", "purpose"]
    }
  },
  {
    name: "log_lead_to_crm",
    description: "Log a lead into CRM.",
    parameters: {
      type: "object",
      properties: {
        full_name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        lead_type: {
          type: "string",
          enum: ["purchase","refinance","dscr_investor","jumbo","agent_partner","other"]
        },
        journey: {
          type: "string",
          enum: [
            "purchase_just_starting","purchase_found_home","purchase_under_contract",
            "refi_payment_reduction","refi_cash_out","refi_arm_to_fixed","refi_pmi_removal","refi_investment",
            "dscr_purchase","dscr_refi","jumbo_purchase","jumbo_refi",
            "agent_relationship","general_inquiry"
          ]
        },
        source: { type: "string" },
        urgency: {
          type: "string",
          enum: ["emergency_today","within_7_days","30_to_60_days","just_exploring"]
        },
        summary: { type: "string" },
        notes_for_officer: { type: "string" }
      },
      required: ["lead_type","journey","summary"]
    }
  },
  {
    name: "schedule_callback",
    description: "Schedule a callback time.",
    parameters: {
      type: "object",
      properties: {
        full_name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        preferred_time_window: { type: "string" },
        timezone: { type: "string" },
        topic: { type: "string" },
        priority: { type: "string", enum: ["high","normal"] }
      },
      required: ["full_name","phone","preferred_time_window","topic","priority"]
    }
  },
  {
    name: "tag_conversation_outcome",
    description: "Mark how a call ended.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "application_link_sent","pricing_link_sent","docs_link_sent",
            "callback_scheduled","lead_logged_only","caller_hung_up",
            "transferred_to_human","info_only_no_next_step","unqualified","technical_issue"
          ]
        },
        details: { type: "string" }
      },
      required: ["outcome"]
    }
  },
  {
    name: "escalate_to_human",
    description: "Escalate a call to a human.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        severity: { type: "string", enum: ["high","medium"] }
      },
      required: ["reason","severity"]
    }
  }
];

// ============================================================
// 3. TOOL HANDLERS (currently logs only)
// ============================================================

async function handleToolCall(toolCall) {
  const { name, arguments: argsJson } = toolCall.function;
  let args = {};

  try {
    args = JSON.parse(argsJson);
  } catch (err) {
    console.error("Tool arg parse error:", err);
  }

  if (name === "send_secure_link") {
    console.log("TOOL: send_secure_link", args);
    return `Secure ${args.purpose} link recorded as sent via ${args.channel} to ${args.recipient}.`;
  }

  if (name === "log_lead_to_crm") {
    console.log("TOOL: log_lead_to_crm", args);
    return "Lead logged.";
  }

  if (name === "schedule_callback") {
    console.log("TOOL: schedule_callback", args);
    return `Callback scheduled: ${args.preferred_time_window}`;
  }

  if (name === "tag_conversation_outcome") {
    console.log("TOOL: tag_conversation_outcome", args);
    return `Outcome tagged: ${args.outcome}`;
  }

  if (name === "escalate_to_human") {
    console.log("TOOL: escalate_to_human", args);
    return `Escalation flagged (Severity: ${args.severity})`;
  }

  return "Tool executed.";
}

// ============================================================
// 4. OPENAI CONVERSATION RUNNER
// ============================================================

async function runLiv(session) {
  const first = await openai.chat.completions.create({
    model: "gpt-5.1-mini",
    messages: session.messages,
    tools: openaiTools,
    tool_choice: "auto"
  });

  const msg = first.choices[0].message;

  // If tools are requested
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    session.messages.push({ role: "assistant", tool_calls: msg.tool_calls });

    for (const call of msg.tool_calls) {
      const result = await handleToolCall(call);
      session.messages.push({
        role: "tool",
        name: call.function.name,
        content: result
      });
    }

    const second = await openai.chat.completions.create({
      model: "gpt-5.1-mini",
      messages: session.messages
    });

    return (second.choices[0].message.content || "").trim();
  }

  return (msg.content || "").trim();
}

// ============================================================
// 5. SESSION HELPER
// ============================================================

function getSession(callSid) {
  let s = sessions.get(callSid);
  if (!s) {
    s = { messages: [ { role: "system", content: LIV_SYSTEM_PROMPT } ] };
    sessions.set(callSid, s);
  }
  return s;
}

// ============================================================
// 6. TWILIO VOICE ROUTES
// ============================================================

// Initial call handler
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

// Gather speech results
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult;

  const vr = new VoiceResponse();

  if (!speech) {
    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto"
    });
    g.say(
      { voice: "Polly.Joanna" },
      "I didn’t quite get that. How can I help?"
    );
    return res.type("text/xml").send(vr.toString());
  }

  console.log("Caller said:", speech);

  const s = getSession(callSid);
  s.messages.push({ role: "user", content: speech });

  try {
    const reply = await runLiv(s);
    console.log("Liv reply:", reply);

    s.messages.push({ role: "assistant", content: reply });

    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto"
    });

    g.say({ voice: "Polly.Joanna" }, reply);

    res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error("ERROR:", err);
    vr.say(
      { voice: "Polly.Joanna" },
      "I'm having trouble on my end. A loan officer will call you back shortly."
    );
    res.type("text/xml").send(vr.toString());
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running.");
});

// ============================================================
// 7. START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Liv AI Bridge listening on port ${PORT}`);
});
