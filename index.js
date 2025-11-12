// index.js
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { randomUUID } = require('crypto'); // replaces uuid
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ----- env -----
const {
  PORT,
  BASE_URL,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM,
  DEFAULT_FOLLOWUP_TO,
  NODE_ENV
} = process.env;

const port = Number(process.env.PORT || 10000);

// Root page (Render splash)
app.get('/', (_req, res) => {
  res
    .status(200)
    .send('✅ OfficialMortgage AI Bridge is live. Try /health or /tts?text=Hello');
});

// Health check for Render
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'OfficialMortgage_AI_Bridge_v2',
    time: new Date().toISOString(),
  });
});

// Simple text-to-speech (non-streaming) to validate ElevenLabs creds.
// Returns raw audio (MP3). Example: /tts?text=Hello
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello from Liv').toString().slice(0, 500);
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      return res.status(500).json({ error: 'Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID' });
    }

    // ElevenLabs text-to-speech (legacy v1 endpoint that returns audio/mpeg)
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;
    const r = await axios.post(
      url,
      {
        text,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      },
      {
        responseType: 'arraybuffer',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', r.data.length);
    return res.status(200).send(Buffer.from(r.data));
  } catch (err) {
    console.error('TTS error:', err?.response?.status, err?.response?.data || err.message);
    return res.status(500).json({ error: 'TTS failed', detail: err.message });
  }
});

/**
 * Placeholder for a websocket audio stream endpoint.
 * Twilio Media Streams expects a wss:// endpoint that speaks their JSON frame protocol.
 * We’ll keep an HTTP stub now so your server has the route while we wire the full stream next.
 */
app.get('/audio-live', (_req, res) => {
  res
    .status(200)
    .send('📡 /audio-live placeholder is up. Twilio media stream wiring comes next.');
});

// Twilio Voice webhook — keeps your number functional while we iterate.
// It greets the caller, then pauses to simulate “Liv is thinking”, then hangs up.
app.post('/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // If you want to connect a media stream later, we’ll swap this block
  // for <Connect><Stream url="wss://YOUR_HOST/audio-live"/></Connect>
  twiml.say(
    {
      voice: 'Polly.Joanna',
      language: 'en-US'
    },
    "Hi, this is Liv with Official Mortgage. I'm online and ready to help. We'll be enabling live voice in a moment."
  );
  twiml.pause({ length: 1 });
  twiml.say("Thanks for calling. Goodbye.");
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// Small helper endpoint to check env on Render without leaking secrets.
app.get('/debug/env', (_req, res) => {
  res.json({
    node: process.version,
    port,
    baseUrl: BASE_URL || null,
    env: NODE_ENV || null,
    hasOpenAI: !!OPENAI_API_KEY,
    has11Labs: !!ELEVENLABS_API_KEY,
    voiceId: ELEVENLABS_VOICE_ID ? `${ELEVENLABS_VOICE_ID.slice(0, 4)}…` : null,
    hasTwilioSid: !!TWILIO_ACCOUNT_SID,
    hasTwilioToken: !!TWILIO_AUTH_TOKEN,
    from: TWILIO_FROM || null
  });
});

app.listen(port, () => {
  console.log(`AI Bridge running on http://localhost:${port}`);
});
