

// index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

// --- Twilio + OpenAI clients
const twilio = require('twilio');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, status: 'AI Bridge is online' }));

// In-memory call transcripts
const memory = new Map();
function pushTurn(callSid, role, content, limit = 8) {
  const turns = memory.get(callSid) || [];
  turns.push({ role, content });
  while (turns.length > limit) turns.shift();
  memory.set(callSid, turns);
  return turns;
}

async function aiReply(callSid, userText) {
  const system = `
You are Official Mortgage's AI assistant.
Tone: calm, confident, concise. Never quote exact rates or promises.
Goal: collect essentials (zip, current rate, balance, est value, FICO band, occupancy, purchase price/down if purchase),
and push the caller to complete the online application before human handoff.
Always end with a short next step.
`.trim();

  const history = memory.get(callSid) || [];
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userText }];

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.4,
    max_tokens: 160
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || "Sorry, could you repeat that?";
  pushTurn(callSid, 'assistant', text);
  return text;
}

// Edit this to your real application URL
function appLinkFor(callSid) {
  return 'https://officialmtg.com/apply';
}

// Entry: answer + start recording + gather speech
app.post('/voice', (req, res) => {
  const twiml = `
<Response>
  <Say>This call may be recorded for quality and compliance.</Say>
  <Start>
    <Record recordingStatusCallback="/recording-status"/>
  </Start>

  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto" language="en-US">
    <Say>Thanks for calling Official Mortgage. I can get you approved online. Tell me your goal — refinance, purchase, or investment — and we’ll move fast.</Say>
  </Gather>

  <Say>Sorry, I didn't hear anything.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

// Handle recognized speech → AI → reply → loop
app.post('/gather', async (req, res) => {
  const callSid = req.body?.CallSid || 'anon';
  const said = (req.body?.SpeechResult || '').trim();

  if (!said) {
    const twiml = `
<Response>
  <Say>Sorry, I didn’t catch that.</Say>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  const enders = ['done', 'that is all', 'goodbye', 'bye', 'no thanks', 'end call'];
  pushTurn(callSid, 'user', said);

  if (enders.some(e => said.toLowerCase().includes(e))) {
    const toNumber = req.body?.From;
    if (toNumber) {
      try {
        await twilioClient.messages.create({
          to: toNumber,
          from: process.env.TWILIO_NUMBER,
          body: `Start your application here (fast, secure): ${appLinkFor(callSid)}`
        });
      } catch (e) {
        console.error('SMS send error:', e.message);
      }
    }
    const twiml = `
<Response>
  <Say>I’ve just texted you our secure application link so you can finish online. Thanks for calling Official Mortgage.</Say>
  <Hangup/>
</Response>`;
    return res.type('text/xml').send(twiml);
  }

  const reply = await aiReply(callSid, said);
  const twiml = `
<Response>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="auto" language="en-US">
    <Say>${reply}</Say>
  </Gather>
  <Redirect method="POST">/voice</Redirect>
</Response>`;
  res.type('text/xml').send(twiml);
});

// optional: recording callback
app.post('/recording-status', (req, res) => {
  console.log('Recording status:', req.body?.RecordingStatus, req.body?.RecordingUrl);
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('AI Bridge running on http://localhost:' + PORT));
