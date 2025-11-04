

// index.js
import express from "express";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- TWILIO VOICE ENDPOINT ----------
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Example: simple greeting to confirm it works
  twiml.say("Hello from Official Mortgage AI Bridge. Your connection is live.");

  res.type("text/xml");
  res.send(twiml.toString());
});

// ---------- HEALTH CHECK ENDPOINT ----------
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ---------- SERVER START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ AI Bridge running on http://localhost:${PORT}`);
});
