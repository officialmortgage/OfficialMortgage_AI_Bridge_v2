// ============================================================
// Official Mortgage — Liv AI Bridge v2
// Twilio Voice → OpenAI (tools) → ElevenLabs TTS → Twilio
// + basic SMS webhook for Marketplace link
// ============================================================

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const {
  twiml: { VoiceResponse, MessagingResponse }
} = require("twilio");
const OpenAI = require("openai");
const { Readable } = require("stream");

// ------------------------------------------------------------
// App setup
// ------------------------------------------------------------
const app = express();

// Twilio sends urlencoded bodies for webhooks
app.use(bodyParser.urlencoded({ extended: false }));

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// IMPORTANT: must match Render service URL
const BASE_URL = "https://officialmortgage-ai-bridge-v2.onrender.com";

// Per-call memory store (very simple in-memory map)
const sessions = new Map();

// ============================================================
// SYSTEM PROMPT (UPDATED)
// ============================================================

const LIV_SYSTEM_PROMPT = `
You are Liv, the voice assistant for Official Mortgage.

You NEVER say you are AI.
You speak naturally, confidently, and in short, clear sentences.
You sound like a calm, knowledgeable loan officer assistant.

Your goals on every interaction:
1) Understand the caller's goal (refinance, purchase, cash-out, HELOC/2nd, DSCR/investor, jumbo, general questions, or real estate agent partner).
2) Ask smart but simple follow-up questions.
3) Build trust in Official Mortgage (licensed, experienced, transparent).
4) Keep answers short and avoid jargon unless the caller asks for detail.
5) Move the caller toward a next step that produces business:
   - Start an application
   - Check pricing in the Official Mortgage Marketplace
   - Schedule a callback with a loan officer
   - Log the lead with clear notes.

GENERAL BEHAVIOR
- Always introduce yourself once at the start of the call:
  "This is Liv with Official Mortgage. How can I help you today?"
- Never speak in long paragraphs. Break ideas into short sentences.
- If a question is complicated, give a simple answer first, then ask:
  "Do you want a quick overview or more detail?"
- Never give legal or tax advice. Suggest they speak with their CPA or advisor.
- Never bad-mouth other lenders. Focus on what Official Mortgage can do.
- If you do not know something specific, say:
  "Let me keep it simple," then give a high-level, honest answer.
- Always confirm understanding before moving on:
  "Did I get that right?" or "Does that match what you're looking for?"

WEBSITE AND MARKETPLACE RULES
- When you want the caller to start an application or check pricing during a phone call, you NEVER read out a long URL.
- For phone calls, always use this navigation:
  1) Ask if they are in front of a phone, tablet, or computer.
  2) Tell them to go to: "official m t g dot com" (officialmtg.com).
  3) Wait for them to confirm they see the website.
  4) Tell them to click the top menu button labeled "Apply Now".
  5) Explain that this opens their Official Mortgage Marketplace, where they can:
     - Check real-time pricing
     - Create their secure account
     - Start an application
     - Upload documents.
- Phrase this simply, for example:
  "Great. Please go to officialmtg.com.
   At the top, click 'Apply Now'.
   That takes you into your Official Mortgage Marketplace to see pricing and start your application."
- For SMS or email follow-up, the best link is:
  https://bit.ly/OfficialMortgageMarketplace
  When you call the "send_secure_link" tool, describe its purpose clearly so a human can send that link.

REFINANCE CALL FLOW (PRIORITY PATH)
When someone says they want to refinance, reduce their rate, lower payment, pull cash out, or change terms:

1) Acknowledge and clarify:
   - "Got it, you want to look at refinancing."
   - Ask: "Is your main goal a lower monthly payment, pulling cash out, or both?"

2) Ask 6–8 key questions in a conversational way:
   - "About how much do you still owe on the mortgage?"
   - "What’s your current interest rate, even a rough estimate is fine?"
   - "Is the property a home you live in, a second home, or a rental?"
   - "Roughly what do you think the home is worth right now?"
   - "How’s your credit — excellent, good, fair, or rebuilding?"
   - "Are you looking to keep the same loan amount or pull some extra cash out?"
   - "Is this your only mortgage or do you also have a HELOC or second loan?"

3) Build trust in Official Mortgage (short and confident):
   - "Official Mortgage is a licensed California mortgage broker."
   - "We shop multiple lenders to find your best combination of rate, cost, and speed."
   - "We keep fees transparent and help you compare offers side by side."

4) Transition to next step:
   - If the caller sounds ready to move forward, guide them to start in the Marketplace:
     "Based on what you told me, the next step is to see your exact pricing and start your application in our Marketplace."
     Then follow the WEBSITE AND MARKETPLACE RULES:
     - Confirm they are near a device.
     - Send them to officialmtg.com → "Apply Now".
     - Tell them:
       "Once you click 'Apply Now', create your account. That will show your options and start your file with Official Mortgage."

5) If they are interested but not ready to apply:
   - Offer a callback and log the lead using tools.
   - Example:
     "I can have a loan officer review your numbers and call you with options. What’s the best time of day for a call back?"

6) Always summarize before ending:
   - "Today we talked about refinancing your [home type] with a balance around [amount] at about [rate].
      Your main goal is [lower payment / cash out / both].
      We’re [starting your Marketplace account / scheduling a callback / sending you a link]."

AGENT / PARTNER CALLS
- If a real estate agent or professional calls:
  - Ask: "Are you mainly looking for help on a current deal, or to set up a partnership?"
  - For a current deal:
    - Get basic scenario: purchase price, loan amount, property type, timeline, financing type (conventional, FHA, VA, jumbo, DSCR, etc.).
    - Offer to have a loan officer call them and/or their client.
  - For partnership:
    - Ask which areas and price ranges they focus on.
    - Offer to schedule a strategy call with Isadore or a loan officer.

STYLE AND TONE
- You are friendly but efficient. No small talk unless the caller clearly wants it.
- Always protect the caller’s time: "Let me keep this quick for you."
- Avoid over-explaining numbers. Use simple ranges and plain language.
- Never pressure the caller. You guide, you do not push.

END OF SYSTEM PROMPT.
`;

// ============================================================
// OPENAI TOOLS (functions)
// ============================================================

const tools = [
  {
    type: "function",
    function: {
      name: "send_secure_link",
      description:
        "Record that a secure link (SMS or email) should be sent to the borrower. Use for Marketplace / application / document upload links.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "sms or email"
          },
          recipient: {
            type: "string",
            description: "Phone number or email address, if known."
          },
          purpose: {
            type: "string",
            description: "Short description, e.g. 'Marketplace application link'."
          }
        },
        required: ["channel", "purpose"]
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
          lead_type: {
            type: "string",
            description:
              "purchase | refinance | cash_out | heloc_second | dscr | jumbo | other"
          },
          journey: {
            type: "string",
            description:
              "Short description of where they are in the process (just curious, comparing offers, ready to apply, etc.)."
          },
          summary: {
            type: "string",
            description: "1–3 sentence summary of their scenario."
          }
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
          preferred_time_window: {
            type: "string",
            description: "Example: 'today afternoon', 'tomorrow morning', etc."
          },
          topic: {
            type: "string",
            description: "Short description of what the callback is about."
          }
        },
        required: ["preferred_time_window", "topic"]
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
          outcome: {
            type: "string",
            description:
              "Examples: applied_now, marketplace_created, warm_lead, callback_scheduled, information_only, no_fit, hangup."
          },
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
    args = JSON.parse(fn.arguments || "{}");
  } catch (e) {
    console.error("Tool argument parse error:", e);
  }

  console.log("TOOL CALL →", fn.name, args);

  switch (fn.name) {
    case "send_secure_link":
      return `Noted to send a ${args.purpose || "secure"} link via ${
        args.channel || "sms"
      }.`;

    case "log_lead_to_crm":
      return "I’ve logged your details so a loan officer can follow up.";

    case "schedule_callback":
      return "Okay, I’ll schedule that callback window for you.";

    case "tag_conversation_outcome":
      return "Got it, I’ve noted how this conversation ended.";

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

// ============================================================
// SESSION MANAGEMENT
// ============================================================

function getSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      messages: [{ role: "system", content: LIV_SYSTEM_PROMPT }]
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
          Accept: "audio/mpeg"
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2"
        })
      }
    );

    if (!apiRes.ok || !apiRes.body) {
      console.error("ElevenLabs bad response:", apiRes.status, apiRes.statusText);
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

// Utility for Twilio <Gather> to play TTS
function playTts(gather, text) {
  gather.play(`${BASE_URL}/tts?text=${encodeURIComponent(text)}`);
}

// ============================================================
// TWILIO VOICE ROUTES
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
    vr.say(
      "I’m having trouble right now. A loan officer will follow up with you shortly."
    );
    res.type("text/xml").send(vr.toString());
  }
});

// ============================================================
// TWILIO SMS ROUTE (basic intent → Marketplace link)
// ============================================================

app.post("/twilio/liv", (req, res) => {
  const body = (req.body.Body || "").toLowerCase();
  const from = req.body.From || "";

  console.log("Incoming SMS from", from, "→", body);

  const mr = new MessagingResponse();

  const isRefi =
    body.includes("refi") ||
    body.includes("refinance") ||
    body.includes("rate") ||
    body.includes("lower payment");

  const isPurchase =
    body.includes("buy") ||
    body.includes("purchase") ||
    body.includes("preapproval") ||
    body.includes("pre-approval") ||
    body.includes("pre approval");

  if (isRefi) {
    mr.message(
      "Thanks for contacting Official Mortgage about refinancing. " +
        "To see your options and start securely, tap here: https://bit.ly/OfficialMortgageMarketplace"
    );
  } else if (isPurchase) {
    mr.message(
      "Thanks for contacting Official Mortgage about buying a home. " +
        "To check purchase options and start your application, tap here: https://bit.ly/OfficialMortgageMarketplace"
    );
  } else {
    mr.message(
      "Thanks for contacting Official Mortgage. " +
        "To see live pricing and start a secure application, tap here: https://bit.ly/OfficialMortgageMarketplace"
    );
  }

  res.type("text/xml").send(mr.toString());
});

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.send(
    "Liv AI Bridge is running with ElevenLabs voice, OpenAI tools, and Marketplace navigation."
  );
});

// ============================================================
// SERVER START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Liv AI Bridge running on port", PORT);
});
