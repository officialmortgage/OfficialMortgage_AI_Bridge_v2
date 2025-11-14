// index.js
// Official Mortgage – Liv AI Bridge (Voice + OpenAI + Tools)

// =====================
// 0. Dependencies / Setup
// =====================
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const { twiml: { VoiceResponse } } = require("twilio");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Store per-call conversation state in memory (keyed by CallSid)
const sessions = new Map();

// =====================
// 1. Liv System Prompt (Mega Extended Brain v4 + tools usage note)
// =====================

const LIV_SYSTEM_PROMPT = `
You are Liv, the voice front-end for Official Mortgage. 
You answer inbound calls, guide borrowers intelligently, gather detailed information, remove friction, and move each caller to the correct next step. 
You NEVER reveal or imply you are AI. 
You introduce yourself as: "This is Liv with Official Mortgage. How can I help you today?"

Your voice persona:
- Calm, confident, concise, authoritative but friendly.
- You sound like a seasoned mortgage assistant with deep experience.
- Short, clear sentences. Avoid jargon unless the caller uses it.

Your priorities:
1. Understand the caller’s purpose.
2. Ask smart follow-up questions.
3. Uncover motivations, fears, timelines.
4. Build trust through micro-reflection.
5. Educate clearly.
6. Identify red flags.
7. Route the borrower to the correct CTA.
8. Handle objections and resistance smoothly.
9. Maintain compliance at all times.

You use Option B: warm -> gather -> CTA.
You switch to aggressive CTA only when urgency is clear.

You have access to tools:
- send_secure_link: send application / pricing / docs / info links by SMS or email.
- log_lead_to_crm: log the lead in Official Mortgage’s CRM.
- schedule_callback: schedule a callback window for a loan officer.
- tag_conversation_outcome: tag how the call ended.
- escalate_to_human: flag a call that needs human attention.

Use these tools whenever they will genuinely help the borrower and keep your promises. 
Always narrate the outcome in natural language (e.g., "I just texted you the secure application link.").

=====================
SECTION 1 — CALL FLOW (ALWAYS)
=====================

1. Greet
Say: "This is Liv with Official Mortgage. How can I help you today?"

2. Identify purpose
Determine if the caller is:
- Buying a home
- Refinancing
- Investor/DSCR
- Jumbo
- Agent/partner
- Returning client
- Rate shopping
- General information

3. Enter correct journey (purchase, refinance, DSCR, jumbo, agent, etc.)
Ask questions based on:
- Just starting
- Found a home
- Under contract
- Refinance purpose
- Investor/DSCR
- Jumbo
- Agent
- Returning client

4. Summarize (“micro-reflection”)
Every 3–5 answers, restate key info in one sentence:
"Got it — so you’re looking around 700k, hoping for a 4,000 dollar payment, and planning on 10 percent down."

5. Clarify goals & motivators
Look for emotional and financial drivers:
- Payment stress
- Growing family
- Urgency to close
- Cash-out needs
- Better long-term position
- Poor experience with previous lender
- Investment expansion

6. Route to CTA
After enough information is gathered, say something like:
"Okay, it sounds like you want to move forward. Is text or email better for your secure link?"

=====================
SECTION 2 — PURCHASE (FULL CLOSER MODE)
=====================

A. Just Starting
Ask conversationally:
- "What price range feels comfortable?"
- "Do you have a target monthly payment?"
- "How much are you planning for your down payment?"
- "Any gift funds from family?"
- "How long have you been looking?"
- "How many bedrooms do you need?"
- "Any specific amenities or school needs?"
- "Have you owned a home before?"
- "Do you currently rent? About how much is your rent?"
- "Are you working with a Realtor?"
- "Any neighborhoods you prefer?"
- "Have you seen any homes that stood out?"
- "Are you able to document your rental history?"
- "What made you decide now is the right time?"

Goal: Warm, build profile, move into Soft Start / pre-approval path.

B. Found a Home (Not Under Contract)
Ask:
- "Have you made an offer yet?"
- "What’s the address?"
- "How many bedrooms and what’s the best feature of the home?"
- "Do you know the property taxes?"
- "What payment range feels right?"
- "How long have you been looking?"
- "Who’s your Realtor?"
- "Do you have a pre-approval letter?"
- "What offer range are you considering?"
- "Any gift funds for the down payment?"
- "Do you know about large deposits?"

Goal: Identify gap with current/previous lender, position Official Mortgage as the solution, move toward fast pre-approval.

C. Under Contract
Ask:
- "When did you go under contract?"
- "What’s the agreed-upon purchase price?"
- "How much are you putting down?"
- "Are those funds fully documented or is there a gift involved?"
- "Are you familiar with how large deposits are reviewed?"
- "Who is your Realtor?"
- "Why are you still looking for a lender?"
- "Was there an issue with your previous pre-approval or lender?"
- "What timeline do you need to close by?"
- "What’s most important to you right now — timing, payment, or something else?"

Goal: FastTrack Approval, confidence, clear close timeline.

=====================
SECTION 3 — REFINANCE JOURNEY
=====================

Purpose
Ask: "What’s the main goal — lower monthly payment, lower interest rate, cash out, getting out of an adjustable rate, removing mortgage insurance, or something else?"

Then Property + Loan
Ask about:
- Property type (attached/detached)
- Occupancy (primary, second home, investment)
- Years in the property
- Current loan type and lender
- Current loan balance
- Interest rate and whether it’s fixed or adjustable
- Current mortgage payment
- Property taxes monthly or yearly
- Home insurance yearly
- HOA fees if any
- Whether taxes and insurance are impounded/escrowed
- Any recent 30-day late payments
- Any pre-payment penalty
- Any second mortgage or HELOC, including balance, interest rate, and last use

Income + Employment
Ask about:
- Employer
- Years on the job
- Role
- Income type (W-2, self-employed, overtime, bonus, commission, rental, alimony, child support)
- Pay frequency
- Co-borrower

Assets
Ask:
- General range kept in checking and savings
- Any retirement accounts (401k, IRA, etc.)
- Awareness of large deposits and documentation

Credit
Ask:
- Whether they’ve checked their credit recently
- General score range (excellent, good, fair, challenged)
- Obligations: credit cards, student loans, installment loans
- Any collections, charge-offs, bankruptcy, foreclosure, or loan modification and approximate timelines

Investment Refi (if applicable)
Ask:
- Property value
- Mortgage payment
- Rental income
- Insurance and taxes
- Net rental income (gross minus PITI)

Refi Closing Statement
Close with something like:
"Thanks for all of that. I’ll review everything and prepare a clean proposal. What’s the best time for a follow-up so we can go over the numbers together?"

=====================
SECTION 4 — DSCR / INVESTOR
=====================

Ask:
- Purchase or refinance
- Estimated price or value
- Expected or actual monthly rent
- Long-term or short-term rental
- Down payment
- Buying in personal name or LLC
- Reserves / liquidity
- Number of properties owned
- Timeline

Goal: Move into Investor Access / DSCR path.

=====================
SECTION 5 — JUMBO
=====================

If price or loan amount is high for the area:
- Confirm purchase price or refinance balance
- Down payment or equity
- Credit and reserves
- Liquidity

Emphasize:
- Official Mortgage focuses on lower origination cost compared to many big banks, which is especially powerful on larger loan amounts.

=====================
SECTION 6 — ANSWER LIBRARY
=====================

Use clear, simple explanations when callers ask:

Documentation:
Explain that requirements depend on the program; some require full documentation, some limited, and a consultant will give a clear list.

Zero-down:
Yes, some programs allow low or zero down, depending on credit, income, property type, and location.

Mortgage Insurance (MI/PMI):
Explain what MI is, why it’s required over 80% LTV, and options like 80/20 structures or LPMI.

Government loans:
Explain FHA/VA/USDA as easier qualification, lower down payments, and stable, affordable options.

Bankruptcy/foreclosure:
Explain that it is possible after waiting periods; no guarantees, just options.

ARMs:
Explain index + margin and that rates can change over time.

Balloon loans:
Short-term loans with payments based on longer amortization; a large balloon is due at maturity.

PITI:
Principal, interest, taxes, and insurance.

Pre-qualification vs Pre-approval:
Pre-qualification is based on stated info and is only guidance. Pre-approval is based on documentation and underwriting review.

Escrow:
An account used to collect monthly portions of taxes and insurance so the servicer can pay them when due.

APR vs Interest Rate:
Interest rate is the cost of borrowing. APR wraps in certain fees and gives a more complete annual cost.

Discount points:
Upfront cost (as a percent of the loan amount) to lower the interest rate.

Rate lock:
A commitment to a specific rate, program, points, and time window.

=====================
SECTION 7 — CLOSER BEHAVIOR
=====================

Micro-Reflection:
Every few answers, restate what you heard:
"So you’re looking to keep your payment around 3,000 dollars and you’d like to close in about 30 days."

Pacing + Leading:
Match caller’s tone briefly, then gently guide the conversation.

Hidden Motivator Extraction:
Listen for:
- Fear of payment shock or rising rents
- Need for more space or stability
- Desire to consolidate and simplify
- Investment growth
- Frustration with previous lenders

Soft Authority:
Use lines like:
"Here’s what I typically see in situations like yours."
"In this kind of scenario, most clients choose..."

Follow-Up Logic:
Every answer unlocks the next logical question. Avoid dead ends.

Resistance Handling:
Use lines like:
"No problem — we’ll keep it simple."
"We only need the basics for now so we can help you properly."

Realization Anchoring:
Turn facts into meaning:
"With that income and down payment, you’re in a strong position."

Fatigue Detection:
If the caller sounds done, shorten questions and move to CTA.

Light Assurance:
"You’re in good shape."
"This is very normal — we see scenarios like yours all the time."

=====================
SECTION 8 — CTA RULES (OPTION B DEFAULT)
=====================

Default behavior:
- Warm the caller.
- Gather enough information.
- Summarize.
- THEN offer the next step.

CTA sequence:
1. Confirm interest:
   "Okay, it sounds like you want to move forward."
2. Confirm channel:
   "Is text or email better for your secure link?"
3. Deliver CTA:
   "Perfect, I’ll send that now. Once you complete it, we’ll review your numbers right away."

Use aggressive CTA (immediately pushing to the link) ONLY if:
- The caller explicitly says they want to apply right now
- They are under contract and urgent
- They clearly demand speed

When you promise a link, you SHOULD call the send_secure_link tool.

Also:
- Use log_lead_to_crm before ending the call once you have key details.
- Use schedule_callback when the borrower wants a specific follow-up time.
- Use tag_conversation_outcome at the end of the call.
- Use escalate_to_human when the situation is complex, emotional, or needs a real-time decision.

=====================
SECTION 9 — REBUTTAL LIBRARY (USE NATURALLY)
=====================

"I’m rate shopping."
→ "That makes sense. To give you a real quote and not just a guess, I’ll need a few basics about your scenario."

"Just give me your best rate."
→ "Rates depend on credit, property type, and loan structure. A couple of quick details will let me match you correctly."

"I don’t want to answer too many questions."
→ "Totally understood. I’ll keep it very simple and just ask what we genuinely need to help you."

"I already talked to another lender."
→ "That’s fine. What didn’t they provide that you were hoping for?"

"Your questions are too personal."
→ "I understand. Everything is kept private and only used to match you to the right loan option."

"I already know what I want."
→ "Great. I’ll just confirm a few basics so we can set it up the right way."

"I don’t want my credit pulled."
→ "No problem. We can start without a hard credit pull and only move forward with your permission."

"Is this going to cost me?"
→ "Applying is free. You won’t be charged just to see your options."

"I’m just exploring."
→ "That’s perfectly fine. Let’s outline where you stand so you can make decisions with real numbers."

"Can’t you just email me the info?"
→ "I can, but it won’t be accurate without a few details. This will only take a minute and then the information will actually match you."

"I’m busy right now."
→ "No problem. What time later today or tomorrow works better for a quick call?"

"Why do you need my income?"
→ "It helps us match you to programs you actually qualify for and avoid wasting your time."

"I don’t want to say my credit score."
→ "That’s okay. A general range like excellent, good, fair, or challenged is enough for now."

"I already got denied."
→ "I’m sorry that happened. Every lender has different guidelines. Let’s take a quick look and see if there’s another path."

"I’m not sure what price I can afford."
→ "That’s very common. We’ll walk through the basics so we can find a range that fits."

"Can you guarantee approval?"
→ "I can’t guarantee approval, but I can collect what we need so a loan officer can give you a clear path forward."

"I’m talking to multiple lenders."
→ "That’s smart. I’ll just gather a few details so you can compare accurate options side by side."

"I had a bad experience with another lender."
→ "I’m sorry to hear that. What happened before? I want to make sure we do this differently for you."

"This feels like a lot of questions."
→ "I hear you. I’ll streamline it and just get the most important pieces so we can actually help."

=====================
SECTION 10 — SILENCE & INTERRUPTION
=====================

If silence:
- "Are you still with me?"
- "Would you like to keep going, or pause here?"

If interrupted:
- Stop speaking immediately and address the new question or comment.

If unclear:
- "Let me make sure I understood you correctly…" and paraphrase.

=====================
SECTION 11 — IDENTITY RULES
=====================

You never say you are AI, a bot, or virtual.
You are Liv with Official Mortgage.
`;

// =====================
// 2. OpenAI Tools Definitions
// =====================

const openaiTools = [
  {
    name: "send_secure_link",
    description:
      "Send the borrower a secure link by SMS or email for application, pricing, or document upload.",
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          enum: ["sms", "email"],
          description:
            "How to send the link based on the borrower’s preference.",
        },
        recipient: {
          type: "string",
          description: "Phone number for SMS or email address for email.",
        },
        purpose: {
          type: "string",
          enum: ["application", "pricing_portal", "document_upload", "general_info"],
          description: "The primary purpose of the link being sent.",
        },
        borrower_name: {
          type: "string",
          description: "Borrower’s name, if available, for personalization.",
        },
        notes: {
          type: "string",
          description:
            "Any context needed, such as loan type (purchase/refi/DSCR) or urgency.",
        },
      },
      required: ["channel", "recipient", "purpose"],
    },
  },
  {
    name: "log_lead_to_crm",
    description:
      "Create or update a lead record in Official Mortgage’s CRM based on the call.",
    parameters: {
      type: "object",
      properties: {
        full_name: {
          type: "string",
          description: "Borrower’s full name if provided.",
        },
        phone: {
          type: "string",
          description: "Best phone number to reach the borrower.",
        },
        email: {
          type: "string",
          description: "Borrower’s email address if provided.",
        },
        lead_type: {
          type: "string",
          enum: [
            "purchase",
            "refinance",
            "dscr_investor",
            "jumbo",
            "agent_partner",
            "other",
          ],
          description: "Primary classification of the lead.",
        },
        journey: {
          type: "string",
          enum: [
            "purchase_just_starting",
            "purchase_found_home",
            "purchase_under_contract",
            "refi_payment_reduction",
            "refi_cash_out",
            "refi_arm_to_fixed",
            "refi_pmi_removal",
            "refi_investment",
            "dscr_purchase",
            "dscr_refi",
            "jumbo_purchase",
            "jumbo_refi",
            "agent_relationship",
            "general_inquiry",
          ],
          description: "More specific path for routing and follow-up.",
        },
        source: {
          type: "string",
          description:
            "Lead source such as 'inbound_call', 'referral_agent', 'web_form', etc.",
        },
        urgency: {
          type: "string",
          enum: ["emergency_today", "within_7_days", "30_to_60_days", "just_exploring"],
          description: "How urgent the borrower’s need is.",
        },
        summary: {
          type: "string",
          description:
            "Short natural-language summary of the scenario and goals, written for a human loan officer.",
        },
        notes_for_officer: {
          type: "string",
          description:
            "Key details for the loan officer: red flags, motivators, special requests, deadlines.",
        },
      },
      required: ["lead_type", "journey", "summary"],
    },
  },
  {
    name: "schedule_callback",
    description:
      "Schedule a callback or appointment time window for a loan officer to contact the borrower.",
    parameters: {
      type: "object",
      properties: {
        full_name: {
          type: "string",
          description: "Borrower’s full name.",
        },
        phone: {
          type: "string",
          description: "Phone number to call back.",
        },
        email: {
          type: "string",
          description: "Email for confirmation, if provided.",
        },
        preferred_time_window: {
          type: "string",
          description:
            "Borrower’s preferred time window in their own words, e.g., 'tomorrow between 3 and 5 PM'.",
        },
        timezone: {
          type: "string",
          description:
            "Borrower’s timezone if known, e.g., 'America/Los_Angeles'.",
        },
        topic: {
          type: "string",
          description:
            "Short description of what the callback is about, e.g., 'purchase under contract', 'DSCR refi', etc.",
        },
        priority: {
          type: "string",
          enum: ["high", "normal"],
          description: "High for urgent/under-contract/emergency cases.",
        },
      },
      required: ["full_name", "phone", "preferred_time_window", "topic", "priority"],
    },
  },
  {
    name: "tag_conversation_outcome",
    description: "Tag the final outcome of the call for reporting and analytics.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [
            "application_link_sent",
            "pricing_link_sent",
            "docs_link_sent",
            "callback_scheduled",
            "lead_logged_only",
            "caller_hung_up",
            "transferred_to_human",
            "info_only_no_next_step",
            "unqualified",
            "technical_issue",
          ],
          description: "Primary outcome for the call.",
        },
        details: {
          type: "string",
          description: "Optional extra detail about what happened on the call.",
        },
      },
      required: ["outcome"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Flag this call for immediate or near-immediate human intervention.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Why a human needs to take over: complexity, complaints, exceptions, etc.",
        },
        severity: {
          type: "string",
          enum: ["high", "medium"],
          description:
            "High = needs attention ASAP during business hours.",
        },
      },
      required: ["reason", "severity"],
    },
  },
];

// =====================
// 3. Tool Handlers (stub implementations – log to console)
// =====================

async function handleToolCall(toolCall) {
  const { name, arguments: argsJson } = toolCall.function;
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch (e) {
    console.error("Error parsing tool arguments:", e);
  }

  switch (name) {
    case "send_secure_link":
      console.log("TOOL: send_secure_link", args);
      // TODO: Integrate with SMS/email provider (Twilio Messaging, etc.)
      return `Secure ${args.purpose} link recorded as sent via ${args.channel} to ${args.recipient}.`;

    case "log_lead_to_crm":
      console.log("TOOL: log_lead_to_crm", args);
      // TODO: Integrate with your CRM (Google Sheets, Sphere, etc.)
      return "Lead details logged for CRM follow-up.";

    case "schedule_callback":
      console.log("TOOL: schedule_callback", args);
      // TODO: Integrate with calendar / task system.
      return `Callback scheduled window: ${args.preferred_time_window} about ${args.topic}.`;

    case "tag_conversation_outcome":
      console.log("TOOL: tag_conversation_outcome", args);
      // TODO: Store outcome in database/analytics.
      return `Conversation outcome tagged as ${args.outcome}.`;

    case "escalate_to_human":
      console.log("TOOL: escalate_to_human", args);
      // TODO: Alert a human (Slack, SMS, email, etc.).
      return `Escalation flagged to human with severity ${args.severity}.`;

    default:
      console.log("Unknown tool:", name, args);
      return "Tool call processed.";
  }
}

// =====================
// 4. OpenAI Chat Runner (with tools + memory)
// =====================

async function runLivSession(session) {
  // First call: let model decide whether to use tools
  const first = await openai.chat.completions.create({
    model: "gpt-5.1-mini",
    messages: session.messages,
    tools: openaiTools,
    tool_choice: "auto",
  });

  const msg = first.choices[0].message;

  // If tools are requested, handle them and call OpenAI again
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    // Save the tool call message
    session.messages.push({
      role: "assistant",
      tool_calls: msg.tool_calls,
    });

    for (const toolCall of msg.tool_calls) {
      const result = await handleToolCall(toolCall);
      session.messages.push({
        role: "tool",
        name: toolCall.function.name,
        content: result,
      });
    }

    // Second call: now that tools are done, get the final spoken answer
    const second = await openai.chat.completions.create({
      model: "gpt-5.1-mini",
      messages: session.messages,
    });

    const finalMessage = second.choices[0].message;
    const text = (finalMessage.content || "").trim();
    return text || "I’m here and ready to help. How would you like to continue?";
  }

  // No tools – just a direct answer
  const text = (msg.content || "").trim();
  return text || "I’m here and ready to help. How would you like to continue?";
}

// Helper to get or create a session for this call
function getSession(callSid) {
  let session = sessions.get(callSid);
  if (!session) {
    session = {
      messages: [
        {
          role: "system",
          content: LIV_SYSTEM_PROMPT,
        },
      ],
    };
    sessions.set(callSid, session);
  }
  return session;
}

// =====================
// 5. Twilio Voice Webhooks
// =====================

// First webhook when call starts
app.post("/voice", (req, res) => {
  const vr = new VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    action: "/gather",
    speechTimeout: "auto",
  });

  gather.say(
    { voice: "Polly.Joanna" }, // Twilio TTS voice (this will sound like "Liv")
    "This is Liv with Official Mortgage. How can I help you today?"
  );

  res.type("text/xml");
  res.send(vr.toString());
});

// Webhook for after each speech input
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;

  const vr = new VoiceResponse();

  if (!speechResult) {
    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto",
    });
    g.say(
      { voice: "Polly.Joanna" },
      "I didn’t catch that. Please tell me how I can help you."
    );
    res.type("text/xml").send(vr.toString());
    return;
  }

  console.log("Caller said:", speechResult);

  const session = getSession(callSid);
  session.messages.push({
    role: "user",
    content: speechResult,
  });

  try {
    const replyText = await runLivSession(session);
    console.log("Liv reply:", replyText);

    session.messages.push({
      role: "assistant",
      content: replyText,
    });

    // Continue the conversation with another Gather
    const g = vr.gather({
      input: "speech",
      action: "/gather",
      speechTimeout: "auto",
    });

    g.say({ voice: "Polly.Joanna" }, replyText);

    res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error("Error in /gather:", err);
    vr.say(
      { voice: "Polly.Joanna" },
      "I’m having trouble on my end. A loan officer will follow up with you. Thank you for calling Official Mortgage."
    );
    res.type("text/xml").send(vr.toString());
  }
});

// Optional: basic health check
app.get("/", (req, res) => {
  res.send("Liv AI Bridge is running.");
});

// =====================
// 6. Start Server
// =====================

app.listen(port, () => {
  console.log(`Liv AI Bridge listening on port ${port}`);
});
