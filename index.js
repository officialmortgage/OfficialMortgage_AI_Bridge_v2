/**
 * Official Mortgage — Liv Voice Bridge (Phase 1)
 * - Express server for Twilio voice calls
 * - ElevenLabs streaming TTS proxy
 * - Health endpoint for Render
 *
 * ENV expected:
 *  PORT (optional, defaults 10000)
 *  BASE_URL=https://officialmortgage-ai-bridge-v2.onrender.com
 *  ELEVENLABS_API_KEY=...
 *  ELEVENLABS_VOICE_ID=...
 *  TWILIO_ACCOUNT_SID=...
 *  TWILIO_AUTH_TOKEN=...
 *  TWILIO_FROM=+1XXXXXXXXXX
 *  ZAPIER_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/xxxxx/xxxxx/
 *  PRICING_PORTAL_URL=https://bit.ly/OfficialMortgageMarketplace
 */

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- Config ----------
const PORT = Number(process.env.PORT) || 10000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || '';
const PRICING_PORTAL_URL =
  process.env.PRICING_PORTAL_URL || 'https://bit.ly/OfficialMortgageMarketplace';

const twilioClient =
  TWILIO_SID && TWILIO_TOKEN ? twilio(TWILIO_SID, TWILIO_TOKEN) : null;

if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
  console.warn(
    '[!] Missing ELEVENLABS vars: ELEVENLABS_API_KEY and/or ELEVENLABS_VOICE_ID'
  );
}
if (!BASE_URL) {
  console.warn('[!] BASE_URL not set; using localhost fallback.');
}

// ---------- Tiny “state” for the call ----------
const STEPS = {
  INTRO: 'INTRO',
  ZIP_VALUE: 'ZIP_VALUE',
  BALANCE: 'BALANCE',
  RATE: 'RATE',
  PURPOSE: 'PURPOSE',
  CREDIT: 'CREDIT',
  OCC: 'OCC',
  CTA: 'CTA',
  CONTACT: 'CONTACT',
  DONE: 'DONE'
};
const sessions = new Map(); // callSid -> { step, transcript:[], data:{} }

function initSession() {
  return {
    step: STEPS.INTRO,
    transcript: [],
    data: {
      intent_raw: null,
      zip_value_raw: null,
      balance: null,
      rate: null,
      purpose: null,
      credit: null,
      occ: null,
      contact_raw: null,
      contact_e164: null
    }
  };
}

function logTurn(state, from, step, text) {
  state.transcript.push({
    ts: new Date().toISOString(),
    from,
    step,
    text
  });
}

function e164(raw) {
  if (!raw) return null;
  const digits = (raw.match(/\d+/g) || []).join('');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function ttsUrl(text) {
  return `${BASE_URL}/audio-live?q=${encodeURIComponent(
    (text || '').replace(/\s+/g, ' ').trim()
  )}`;
}

// ---------- Pages ----------
app.get('/', (_req, res) => {
  res
    .status(200)
    .send('✅ Liv Refi Bridge is live. Try /health or /audio-live?q=Hello');
});

// Health for Render
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ---------- ElevenLabs streaming proxy ----------
app.get('/audio-live', async (req, res) => {
  try {
    const text = String(req.query.q || 'Hello from Liv');
    if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
      return res.status(500).send('Missing ElevenLabs credentials.');
    }

    const upstream = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`,
      responseType: 'stream',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json'
      },
      data: {
        text,
        model_id: 'eleven_monolingual_v1',
        optimize_streaming_latency: 2,
        voice_settings: {
          stability: 0.38,
          similarity_boost: 0.82,
          style: 0.15,
          use_speaker_boost: true
        }
      }
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    upstream.data.on('error', () => res.end());
    upstream.data.pipe(res);
  } catch (err) {
    console.error('[/audio-live] error:', err?.response?.status, err?.message);
    res.status(502).send('Streaming error.');
  }
});

// ---------- Twilio Voice Flow (replies use /audio-live) ----------
const { VoiceResponse } = twilio.twiml;

app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid || uuidv4();
  if (!sessions.has(callSid)) sessions.set(callSid, initSession());
  const state = sessions.get(callSid);

  // Liv greeting
  const line =
    "Hi—this is Liv with Official Mortgage. Are you trying to lower your payment, pull cash out, or just see where rates are right now?";
  logTurn(state, 'liv', state.step, line);
  state.step = STEPS.ZIP_VALUE;

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: `/gather?step=${state.step}&sid=${encodeURIComponent(callSid)}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US'
  });
  gather.play(ttsUrl(line));

  res.type('text/xml').send(twiml.toString());
});

app.post('/gather', async (req, res) => {
  const callSid = req.query.sid || req.body.CallSid || uuidv4();
  const step = req.query.step || STEPS.INTRO;
  const user = (req.body.SpeechResult || '').trim();

  if (!sessions.has(callSid)) sessions.set(callSid, initSession());
  const state = sessions.get(callSid);

  const reply = (text, nextStep) => {
    logTurn(state, 'liv', nextStep, text);
    state.step = nextStep;
    sessions.set(callSid, state);

    const r = new VoiceResponse();
    if (nextStep === STEPS.DONE) {
      r.play(ttsUrl(text));
      r.hangup();
      return res.type('text/xml').send(r.toString());
    } else {
      const g = r.gather({
        input: 'speech',
        action: `/gather?step=${state.step}&sid=${encodeURIComponent(callSid)}`,
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US'
      });
      g.play(ttsUrl(text));
      return res.type('text/xml').send(r.toString());
    }
  };

  // record what user said
  if (user) logTurn(state, 'user', step, user);

  try {
    switch (step) {
      case STEPS.ZIP_VALUE:
        state.data.intent_raw = user || null;
        return reply(
          "Great. What's the property zip code and your rough estimate of the home's value?",
          STEPS.BALANCE
        );

      case STEPS.BALANCE:
        state.data.zip_value_raw = user || null;
        return reply(
          "About how much do you still owe on the current mortgage?",
          STEPS.RATE
        );

      case STEPS.RATE:
        state.data.balance = user || null;
        return reply(
          "What interest rate are you sitting at right now? A guess is fine.",
          STEPS.PURPOSE
        );

      case STEPS.PURPOSE:
        state.data.rate = user || null;
        return reply(
          "Perfect. Are you hoping to lower payment, pull some cash out, or shorten the term?",
          STEPS.CREDIT
        );

      case STEPS.CREDIT:
        state.data.purpose = user || null;
        return reply(
          "Credit-wise, would you say excellent, good, or fair?",
          STEPS.OCC
        );

      case STEPS.OCC:
        state.data.credit = user || null;
        return reply(
          "Got it. Is this a primary home, second home, or an investment property?",
          STEPS.CTA
        );

      case STEPS.CTA:
        state.data.occ = user || null;
        return reply(
          "I can text you a secure link to our pricing portal—no credit hit—and we’ll review options. What’s the best number to text?",
          STEPS.CONTACT
        );

      case STEPS.CONTACT: {
        state.data.contact_raw = user || null;
        state.data.contact_e164 = e164(user);

        // send SMS (best effort)
        if (twilioClient && state.data.contact_e164) {
          try {
            await twilioClient.messages.create({
              to: state.data.contact_e164,
              from: TWILIO_FROM,
              body:
                `Official Mortgage — Pricing Portal\n` +
                `${PRICING_PORTAL_URL}\n` +
                `Reply if you'd like us to review options with you.`
            });
          } catch (err) {
            console.error('[sms] failed:', err?.message);
          }
        }

        // push to Zapier (best effort)
        if (ZAPIER_WEBHOOK_URL) {
          try {
            await axios.post(
              ZAPIER_WEBHOOK_URL,
              {
                call_sid: callSid,
                when: new Date().toISOString(),
                source: 'Liv-Refi-Voice',
                data: state.data,
                transcript: state.transcript
              },
              { timeout: 8000 }
            );
          } catch (err) {
            console.error('[zapier] failed:', err?.message);
          }
        }

        return reply(
          "Perfect—check your text in a few seconds. Thanks for chatting with me today.",
          STEPS.DONE
        );
      }

      default:
        return reply("Thanks for speaking with me today.", STEPS.DONE);
    }
  } catch (err) {
    console.error('[/gather] error:', err);
    const r = new VoiceResponse();
    r.say(
      { voice: 'Polly.Joanna' },
      "Sorry—something glitched on my end. Let's try that again later."
    );
    r.hangup();
    return res.type('text/xml').send(r.toString());
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Liv server on ${PORT}`);
  console.log(`Public base: ${BASE_URL}`);
});
