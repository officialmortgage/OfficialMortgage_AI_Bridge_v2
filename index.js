// index.js
// OfficialMortgage AI Bridge v2
// Backend for Liv (Twilio ↔ WebSocket ↔ ElevenLabs/OpenAI-ready)

// Load environment variables (Render ignores .env, but this is useful locally)
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const WebSocket = require('ws');
const { VoiceResponse } = require('twilio').twiml;

// ---------- CONFIG ----------

const PORT = process.env.PORT || 10000;

const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';

// ---------- EXPRESS APP SETUP ----------

const app = express();

// Twilio sends application/x-www-form-urlencoded for webhooks
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Simple root message
app.get('/', (req, res) => {
  res.type('text/plain').send(
    '✅ OfficialMortgage AI Bridge is live. Try /health or /tts?text=Hello'
  );
});

// Health check (used by you and Render)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OfficialMortgage_AI_Bridge_v2',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// ---------- TTS ENDPOINT (ElevenLabs) ----------
// GET /tts?text=Hello
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || '').toString().trim();

    if (!text) {
      return res.status(400).json({ error: 'Missing ?text query parameter' });
    }

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      return res
        .status(500)
        .json({ error: 'ElevenLabs API key or voice ID not configured' });
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`;

    const elevenRes = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.9,
        },
      }),
    });

    if (!elevenRes.ok) {
      const errText = await elevenRes.text();
      console.error('ElevenLabs error:', elevenRes.status, errText);
      return res
        .status(502)
        .json({ error: 'ElevenLabs TTS request failed', status: elevenRes.status });
    }

    const audioBuffer = Buffer.from(await elevenRes.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (err) {
    console.error('Error in /tts:', err);
    res.status(500).json({ error: 'Internal server error in /tts' });
  }
});

// ---------- TWILIO VOICE WEBHOOK ----------
// This is the URL you configured in Twilio:
// https://officialmortgage-ai-bridge-v2.onrender.com/twilio/voice
app.post('/twilio/voice', (req, res) => {
  try {
    console.log('Incoming Twilio voice call:', {
      from: req.body.From,
      to: req.body.To,
      callSid: req.body.CallSid,
    });

    const twiml = new VoiceResponse();

    // Short greeting so caller knows Liv is there
    twiml.say(
      {
        voice: 'Polly.Joanna',
        language: 'en-US',
      },
      "Hi, this is Liv with Official Mortgage. I'm online and ready to help. One moment while I connect you."
    );

    // Connect call audio to WebSocket media stream
    const connect = twiml.connect();
    const stream = connect.stream({
      // Twilio connects to this WebSocket URL
      url: 'wss://officialmortgage-ai-bridge-v2.onrender.com/audio-live',
    });

    // Optional metadata for debugging/future logic
    if (req.body.From) {
      stream.parameter({
        name: 'callerNumber',
        value: req.body.From,
      });
    }

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('Error in /twilio/voice handler:', err);
    // If something goes wrong, fail gracefully so Twilio doesn’t error-loop
    const fallback = new VoiceResponse();
    fallback.say(
      {
        voice: 'Polly.Joanna',
        language: 'en-US',
      },
      "Sorry, I'm having trouble connecting right now. Please try again in a few minutes."
    );
    res.type('text/xml');
    res.send(fallback.toString());
  }
});

// ---------- WEBSOCKET: /audio-live (Twilio Media Stream) ----------
// This keeps the media stream alive and logs events.
// We’ll layer the AI + ElevenLabs logic on top of this later.
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/audio-live' });

wss.on('connection', (ws, req) => {
  console.log('🔊 Twilio media stream connected to /audio-live');

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'start') {
        console.log('Media stream start:', msg.start);
      } else if (msg.event === 'media') {
        // Raw audio frames arrive here (base64 PCM)
        // For now we just log occasionally to avoid noise.
        // console.log('Media frame:', msg.media.timestamp);
      } else if (msg.event === 'stop') {
        console.log('Media stream stop:', msg.stop);
      } else {
        console.log('Other media event:', msg.event);
      }
    } catch (err) {
      console.error('Error parsing media message:', err);
    }
  });

  ws.on('close', () => {
    console.log('🔇 Twilio media stream disconnected from /audio-live');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error on /audio-live:', err);
  });
});

// ---------- START SERVER ----------

server.listen(PORT, () => {
  console.log('========================================');
  console.log('✅ Liv server is running');
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log(`📞 Twilio Voice Webhook: ${BASE_URL}/twilio/voice`);
  console.log(`🔊 Media WebSocket:     wss://${BASE_URL.replace(/^https?:\/\//, '')}/audio-live`);
  console.log(`🎧 TTS test endpoint:   ${BASE_URL}/tts?text=Hello`);
  console.log('========================================');
});
