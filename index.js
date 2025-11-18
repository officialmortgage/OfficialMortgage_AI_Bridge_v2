// ============================================================
// Official Mortgage — Liv AI Bridge v2
// Twilio Voice → OpenAI (tools + LIV BRAIN v4) → ElevenLabs TTS
// + Twilio SMS follow-up + EMAIL PLACEHOLDER
// ============================================================

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse } } = require("twilio");
const OpenAI = require("openai");
const twilio = require("twilio");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

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
// Twilio REST client (for SMS follow-up)
// ------------------------------------------------------------
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER; // e.g. "+18448614773"

const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// ------------------------------------------------------------
// ElevenLabs config
// ------------------------------------------------------------
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// IMPORTANT: must match Render service URL
const BASE_URL = "https://officialmortgage-ai-bridge-v2.onrender.com";

// Core URLs / CTAs
const WEBSITE_URL = "https://www.officialmtg.com";
const MARKETPLACE_URL = "https://bit.ly/OfficialMortgageMarketplace";
const DSCR_URL = "https://www.officialmtg.com/loan-programs/dscr-loans";
const CALENDLY_URL = "https://calendly.com/officialmtg/new-meeting";
const DOC_UPLOAD_URL = "https://www.officialmtg.com/isadore/applications/register?app_type=secure-documents";
const FULL_APP_URL = "https://www.officialmtg.com/default/applications/register?app_type=full";
const REFI_SMARTCHECK_URL = "https://www.officialmtg.com/loan-programs/refinance-loans";

// ------------------------------------------------------------
// LIV BRAIN v4 LOADER (16-module brain)
// ------------------------------------------------------------
const BRAIN_DIR = path.join(__dirname, "liv-brain-v4");
const BRAIN_FILES = [
  "01_personality_core.txt",
  "02_closer_traits.txt",
  "03_mindset_frames.txt",
  "04_product_recognition_engine.txt",
  "05_closer_flows_purchase.txt",
  "06_closer_flows_refi_cashout.txt",
  "07_closer_flows_jumbo.txt",
  "08_closer_flows_dscr_nqm_selfemployed.txt",
  "09_closer_flows_specialty_products.txt",
  "10_closer_objection_engine.txt",
  "11_closer_followup_engine.txt",
  "12_cta_rules_engine.txt",
  "13_product_knowledge_engine.txt",
  "14_integration_master_logic.txt",
  "15_memory_session_state_engine.txt",
  "16_crm_disposition_engine.txt"
];

function loadBrainText() {
  let combined = "";
  try {
    for (const fname of BRAIN_FILES) {
      const full = path.join(BRAIN_DIR, fname);
      if (fs.existsSync(full)) {
        const text = fs.readFileSync(full, "utf8");
        combined += `\n\n==== ${fname} ====\n` + text;
      } else {
        combined += `\n\n[WARNING] Missing brain file: ${fname}\n`;
      }
    }
  } catch (err) {
    combined += `\n\n[ERROR] Failed to load brain files: ${err.message}\n`;
  }
  return combined;
}

const LIV_BRAIN_TEXT = loadBrainText();

// ------------------------------------------------------------
// SYSTEM PROMPT (base + brain)
// ------------------------------------------------------------
const LIV_SYSTEM_PROMPT = `
You are LIV, the Official Mortgage voice assistant and LEAD CLOSER.

Never mention that you are AI. You sound like a calm, expert mortgage
professional. You speak in short, confident, conversational sentences.

High-level rules:
- Always act as a closer, not just information.
- Be proactive: ask smart follow-up questions, narrow options, recommend paths.
- Every caller must leave with a concrete next step (CTA).
- Log EVERY lead correctly with the information you have.
- Use the Official Mortgage Marketplace for real-time pricing:
  • Direct link: ${MARKETPLACE_URL}
  • Or verbally send them to ${WEBSITE_URL} and say:
    “Click the APPLY NOW / Pricing link at the top to open your secure portal.”

Primary missions:
1) Understand caller goal (purchase, refi, cash-out, jumbo, DSCR/investor, HELOC,
   2nd, self-employed NQM, or agent partner).
2) Qualify them (property, loan amount, credit estimate, income, timeline).
3) Match them to the best product path based on the LIV BRAIN.
4) Close them into:
   - Marketplace account (pricing + full 1003),
   - Document upload,
   - Scheduled call,
   - Or at minimum a logged lead with SMS + email follow-up.

Follow-up philosophy:
- LIV speaks in the first-person: “I’ll send you a secure link now.”
- LIV can send SMS plus email follow-ups via tools.
- LIV always offers to walk them through pricing while still on the phone.

Now integrate and use the following LIV BRAIN modules:

${LIV_BRAIN_TEXT}
`;

// ------------------------------------------------------------
// Per-call memory
// ------------------------------------------------------------
const sessions = new Map();

function getSession(key) {
  if (!sessions.has(key)) {
    sessions.set(key, {
      messages: [
        { role: "system", content: LIV_SYSTEM_PROMPT }
      ]
    });
  }
  return sessions.get(key);
}

// ------------------------------------------------------------
// EMAIL PLACEHOLDER (real SMTP can be wired later)
// ------------------------------------------------------------
async function sendEmailPlaceholder(to, subject, body) {
  if (!to) {
    console.log("EMAIL PLACEHOLDER: no 'to' address, skipping.");
    return { ok: false, reason: "no-recipient" };
  }
  console.log("===============================================");
  console.log("EMAIL PLACEHOLDER — LIV FOLLOW-UP");
  console.log("TO:", to);
  console.log("SUBJECT:", subject);
  console.log("BODY:\n", body);
  console.log("===============================================");
  // When SMTP is ready, replace this with real send and return its result.
  return { ok: true };
}

// ------------------------------------------------------------
// Twilio SMS sender
// ------------------------------------------------------------
async function sendSms(to, body) {
  if (!twilioClient || !TWILIO_FROM_NUMBER) {
    console.log("SMS SKIPPED: Twilio client or FROM number not configured.");
    return { ok: false, reason: "no-twilio" };
  }
  if (!to) {
    console.log("SMS SKIPPED: no 'to' number.");
    return { ok: false, reason: "no-recipient" };
  }

  try {
    const msg = await twilioClient.messages.create({
      to,
      from: TWILIO_FROM_NUMBER,
      body
    });
    console.log("SMS SENT:", msg.sid);
    return { ok: true, sid: msg.sid };
  } catch (err) {
    console.error("SMS ERROR:", err);
    return { ok: false, error: err.message };
  }
}

// ------------------------------------------------------------
// OPENAI TOOLS
// ------------------------------------------------------------
const tools = [
  {
    type: "function",
    function: {
      name: "send_secure_link",
      description: "Send the borrower a secure link by SMS and email.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Primary channel LIV is using right now (voice/sms)."
          },
          phone: {
            type: "string",
            description: "Borrower mobile phone for SMS, in E.164 if possible."
          },
          email: {
            type: "string",
            description: "Borrower email address, if known."
          },
          link_type: {
            type: "string",
            description: "What the link is for: marketplace, full_app, docs, dscr, refi_smartcheck, calendly, generic."
          },
          notes: {
            type: "string",
            description: "Short context to include in log and email body."
          }
        },
        required: ["channel", "link_type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "log_lead_to_crm",
      description: "Log borrower lead details for follow-up (every call).",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          lead_type: {
            type: "string",
            description: "purchase | refi | cashout | jumbo | dscr | heloc | second | nqm | agent | other"
          },
          product_path: {
            type: "string",
            description: "Best-fit product path LIV identified."
          },
          journey_stage: {
            type: "string",
            description: "new_lead | pricing_only | app_started | app_completed | docs_started | docs_completed | callback_scheduled | nurture"
          },
          summary: {
            type: "string",
            description: "Tight summary of situation and LIV's current plan."
          }
        },
        required: ["lead_type", "journey_stage", "summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "schedule_callback",
      description: "Schedule a callback with a loan officer (or log request).",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          preferred_time_window: {
            type: "string",
            description: "Caller preference, e.g. 'tomorrow morning', 'today after 4pm'."
          },
          topic: {
            type: "string",
            description: "Short topic like 'jumbo purchase', 'refi 8.5%', 'DSCR 4plex', etc."
          }
        },
        required: ["full_name", "phone", "preferred_time_window", "topic"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "tag_conversation_outcome",
      description: "Tag how the call ended for analytics and follow-up.",
      parameters: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            description: "closed_to_marketplace | app_started | app_completed | docs_sent | callback_scheduled | nurture | no_fit | disconnected"
          },
          details: {
            type: "string",
            description: "Optional extra details."
          }
        },
        required: ["outcome"]
      }
    }
  }
];

// ------------------------------------------------------------
// TOOL HANDLER IMPLEMENTATIONS
// ------------------------------------------------------------
function resolveLink(link_type) {
  switch (link_type) {
    case "marketplace": return MARKETPLACE_URL;
    case "full_app": return FULL_APP_URL;
    case "docs": return DOC_UPLOAD_URL;
    case "dscr": return DSCR_URL;
    case "refi_smartcheck": return REFI_SMARTCHECK_URL;
    case "calendly": return CALENDLY_URL;
    default: return MARKETPLACE_URL;
  }
}

async function handle_send_secure_link(args) {
  const link = resolveLink(args.link_type);
  const smsBody =
    `Official Mortgage — your secure link: ${link}\n\n` +
    (args.notes ? args.notes : "You can view pricing, apply, and upload documents in one place.");

  // SMS
  const smsResult = await sendSms(args.phone, smsBody);

  // Email (placeholder)
  const emailBody =
    `Hi,\n\nHere is your secure Official Mortgage link (${args.link_type}):\n${link}\n\n` +
    (args.notes ? `${args.notes}\n\n` : "") +
    `If you have any questions, reply to this email or visit ${WEBSITE_URL}.\n\n— Official Mortgage`;
  const emailResult = await sendEmailPlaceholder(args.email, "Your Official Mortgage Secure Link", emailBody);

  let parts = [];
  if (smsResult.ok) parts.push("text message");
  if (emailResult.ok && args.email) parts.push("email");

  if (parts.length === 0) {
    return "I tried to send your secure link but ran into a problem. A loan officer will follow up with you.";
  }

  return `I've sent your secure link by ${parts.join(" and ")}. You can open it while we talk so I can walk you through pricing.`;
}

async function handle_log_lead_to_crm(args) {
  // Placeholder: later this can POST to Airtable/Sheets/CRM.
  console.log("CRM LOG PLACEHOLDER:", JSON.stringify(args, null, 2));
  return "I’ve logged your details so we can follow up and keep everything organized.";
}

async function handle_schedule_callback(args) {
  console.log("CALLBACK REQUEST PLACEHOLDER:", JSON.stringify(args, null, 2));
  return "I’ve scheduled a callback window for you. If you don’t see a confirmation, a loan officer will still reach out within that window.";
}

async function handle_tag_conversation_outcome(args) {
  console.log("OUTCOME TAG:", JSON.stringify(args, null, 2));
  return "Got it, I’ve noted how this conversation ended.";
}

async function handleToolCall(call) {
  const fn = call.function;
  let args = {};
  try {
    args = JSON.parse(fn.arguments || "{}");
  } catch (e) {
    console.error("Tool argument parse error:", e);
  }

  console.log("TOOL CALL →", fn.name, args);

  switch (fn.name) {
    case "send_secure_link":
      return await handle_send_secure_link(args);
    case "log_lead_to_crm":
      return await handle_log_lead_to_crm(args);
    case "schedule_callback":
      return await handle_schedule_callback(args);
    case "tag_conversation_outcome":
      return await handle_tag_conversation_outcome(args);
    default:
      return "Done.";
  }
}

// ------------------------------------------------------------
// AI RUNNER
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
// ElevenLabs TTS endpoint
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
      console.error("ElevenLabs non-OK:", apiRes.status, await apiRes.text());
      return res.status(500).end();
    }

    res.setHeader("Content-Type", "audio/mpeg");
    apiRes.body.pipe(res);
  } catch (err) {
    console.error("ElevenLabs error:", err);
    res.status(500).end();
  }
});

// Utility for gather speech
function playTts(g, text) {
  g.play(`${BASE_URL}/tts?text=${encodeURIComponent(text)}`);
}

// ------------------------------------------------------------
// TWILIO VOICE ROUTES
// ------------------------------------------------------------
app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: "speech",
    action: "/gather",
    speechTimeout: "auto"
  });

  playTts(
    g,
    "This is Liv with Official Mortgage. How can I help you today?"
  );

  res.type("text/xml").send(vr.toString());
});

app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid || `unknown-${Date.now()}`;
  const transcript = req.body.SpeechResult;

  const vr = new VoiceResponse();

  if (!transcript) {
    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto"
    });
    playTts(g, "I didn't catch that. Could you please repeat that for me?");
    return res.type("text/xml").send(vr.toString());
  }

  console.log("CALL", callSid, "USER SAID:", transcript);

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
    vr.say(
      "I’m having trouble right now. A loan officer will follow up shortly. Thank you for calling Official Mortgage."
    );
    res.type("text/xml").send(vr.toString());
  }
});

// ------------------------------------------------------------
// Root
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send(
    "Liv AI Bridge is running with ElevenLabs voice + OpenAI tools + LIV BRAIN v4 + SMS follow-up + EMAIL PLACEHOLDER."
  );
});

// ------------------------------------------------------------
// Start server
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Liv AI Bridge running on port", PORT));
