// src/livRouter.js
const axios = require("axios");
const CONFIG = require("../config/liv-config.json");
const urls = CONFIG.urls;

// simple in-memory store — you can upgrade later
const sessions = new Map(); // key: sessionId -> state object

function detectIntent(text = "") {
  const lower = text.toLowerCase();

  for (const [intentKey, intentConfig] of Object.entries(CONFIG.intents)) {
    if (intentConfig.keywords.some(k => lower.includes(k))) {
      return intentKey;
    }
  }
  return "GENERAL";
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      ...CONFIG.flags,
      sessionId
    });
  }
  return sessions.get(sessionId);
}

function isHotLead(state) {
  return (
    state.ACCOUNT_CREATED &&
    state.APP_COMPLETED &&
    state.CREDIT_AUTHORIZED
  );
}

async function handleTwilioWebhook(req, res) {
  const from = req.body.From || req.body.from || "unknown";
  const body = req.body.Body || req.body.SpeechResult || "";
  const callSid = req.body.CallSid || from;

  const state = getSession(callSid);
  const intent = detectIntent(body);

  let reply = "";

  switch (intent) {
    case "PURCHASE":
    case "CASHOUT":
    case "EQUITY":
    case "JUMBO":
    case "NONQM":
    case "AFFORDABLE":
    case "READY_TO_MOVE":
      reply =
        "Here’s your Official Mortgage Marketplace link. Create your secure account so we can continue:\n" +
        urls.MARKETPLACE_URL;
      state.MARKETPLACE_PUSHED = true;
      break;

    case "REFI":
      reply =
        "Review refinance options here, then complete your Marketplace account so we can finalize:\n" +
        urls.REFI_URL +
        "\n" +
        urls.MARKETPLACE_URL;
      state.MARKETPLACE_PUSHED = true;
      break;

    case "DSCR":
      reply =
        "Here is our DSCR information, then use your Marketplace link to apply:\n" +
        urls.DSCR_URL +
        "\n" +
        urls.MARKETPLACE_URL;
      state.MARKETPLACE_PUSHED = true;
      break;

    default:
      reply =
        "This is Liv with Official Mortgage. I can help with purchase, refinance, cash-out, equity or investor loans. " +
        "Tell me your goal and I’ll send the next step.";
  }

  const twiml = `<Response><Message>${reply}</Message></Response>`;
  res.type("text/xml").send(twiml);
}

async function handleMarketplaceEvent(req, res) {
  const { sessionId, eventType } = req.body;
  if (!sessionId || !eventType) {
    return res.status(400).json({ ok: false, error: "Missing sessionId or eventType" });
  }

  const state = getSession(sessionId);

  if (eventType === "ACCOUNT_CREATED") state.ACCOUNT_CREATED = true;
  if (eventType === "APP_COMPLETED") state.APP_COMPLETED = true;
  if (eventType === "CREDIT_AUTHORIZED") state.CREDIT_AUTHORIZED = true;
  if (eventType === "DOC_UPLOAD_STARTED") state.DOC_UPLOAD_STARTED = true;
  if (eventType === "DOC_UPLOAD_COMPLETE") state.DOC_UPLOAD_COMPLETE = true;

  if (isHotLead(state)) {
    state.HOT_LEAD = true;

    if (process.env.LIV_NOTIFY_URL) {
      try {
        await axios.post(process.env.LIV_NOTIFY_URL, {
          lead_status: "HOT",
          sessionId,
          state
        });
      } catch (err) {
        console.error("notify-human failed", err.message);
      }
    }
  }

  res.json({ ok: true });
}

async function handleValuationCallback(req, res) {
  const { sessionId, value_estimate, range_low, range_high, rental_estimate, equity, ltv } =
    req.body;

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "Missing sessionId" });
  }

  const state = getSession(sessionId);
  state.VALUATION_COMPLETE = true;
  state.valuation = { value_estimate, range_low, range_high, rental_estimate, equity, ltv };

  res.json({ ok: true });
}

module.exports = {
  handleTwilioWebhook,
  handleMarketplaceEvent,
  handleValuationCallback
};
