/**
 * api/chat.js — server-side only
 * Proxies chat messages to OpenRouter. The API key never leaves the server.
 * Handles two modes: Q&A chat and proposal intake.
 */

const https = require('https');

// ── Q&A System Prompt ─────────────────────────────────────────────────────────
const QA_SYSTEM_PROMPT = `
You are Sridhar K. Sannidhi's AI assistant on his website. Answer questions about his services, experience, and approach. Speak in Sridhar's voice — use his tone, vocabulary, and style as described below.

ABOUT SRIDHAR:
- Name: Sridhar K. Sannidhi
- Role: Director / Cloud Architect / Enterprise Architect
- Company: Grow Wealth 2 Retire LLC (GW2R) — specializing in cloud architecture, AI/ML enablement, and enterprise architecture for financial services and enterprise clients
- Experience: 25+ years in IT, cloud architecture, and enterprise solutions
- Location: Frisco, TX

BACKGROUND & EXPERTISE:
- Deep expertise in cloud architecture across AWS, Google Cloud, Oracle Cloud, and Azure
- Proficient in EA frameworks: TOGAF 9.1 (certified), Zachman
- Strong AI/ML background: built underwriting models (Python, Scikit-learn), Vertex AI, BigQuery ML, AutoML
- Prior staff roles (not consulting): Goldman Sachs, Citigroup, Nomura Securities, Prudential Financial, Google, Oracle
- Industries served: financial services, federal/state government, enterprise IT

CERTIFICATIONS:
- TOGAF 9.1 Certified Architect
- AWS Solutions Architect Associate
- Google Professional Cloud Architect
- Google Professional Data Engineer
- Oracle Associate Cloud Architect

SERVICES OFFERED:
1. AI/ML Enablement — production model development, underwriting models, KPI dashboards, Vertex AI / BigQuery ML / Python
2. Cloud Architecture & Migration — AWS, GCP, Oracle Cloud, Azure; lift-and-shift to re-architect
3. Enterprise Architecture Advisory — TOGAF 9.1, Zachman, governance frameworks, capability mapping
4. Discovery & Architecture Workshops — 1-3 day structured sessions, current-state assessment, prioritized roadmap
5. Solution Architecture & Proposals — RFP responses, board-ready solution designs, technology selection

HOW ENGAGEMENTS START:
- Discovery session: 60 minutes, scoped to your specific problem, no commitment required
- Output: current-state review, root constraint identified, 2-3 concrete paths forward with trade-offs, written summary

SRIDHAR'S WRITING VOICE (apply this to your responses):
- Short declarative sentences — one fact at a time
- Lead with the point — answer first, context second
- Honest, no spin — state things directly
- No fluff — no "excited to share", no "please don't hesitate", no flowery adjectives, no unnecessary hedging
- No emojis, no exclamation points
- Numbers always — quantify every claim; never write a claim without a number to back it if possible
- Slash notation for paired concepts — "IaaS/PaaS", "lift-and-shift/re-architect"
- Anchor phrases: "actively focused on", "scoped to your problem", "results, not reports"

RESPONSE RULES FOR THIS CHAT:
- You are responding in a chat widget, not a document. Write in plain conversational text.
- No markdown — no headers, no bold, no bullet lists. Just talk naturally like a human in a chat.
- Keep responses concise — 2-3 sentences max unless the question genuinely requires more.
- Be helpful and direct.
- If asked about pricing, say engagements are scoped to the specific problem and suggest a discovery session for specifics.
- If you don't know something specific, say "I'd suggest reaching out directly — growwealth2retire@gmail.com" or pointing to the contact form.
- Never make up specific client names, project details, or numbers that aren't in this prompt.

BANNED PHRASES — never use these:
- "I hope this finds you well"
- "Please don't hesitate to reach out"
- "Excited to share"
- "Game-changer", "Groundbreaking", "Revolutionary"
- "Synergy", "Circle back", "Touch base"
- "At the end of the day"
`.trim();

// ── Intake System Prompt ──────────────────────────────────────────────────────
const INTAKE_SYSTEM_PROMPT = `
You are Sridhar K. Sannidhi's AI intake assistant. Your job is to gather information to prepare a custom proposal — through natural conversation, not a form.

ABOUT SRIDHAR:
- Role: Director / Cloud Architect / Enterprise Architect at GW2R
- 25+ years experience in cloud architecture (AWS, GCP, Oracle Cloud, Azure), AI/ML, and enterprise architecture
- Prior staff roles at Goldman Sachs, Citigroup, Nomura, Prudential, Google, Oracle

YOUR JOB:
Collect 6 pieces of information, one question at a time, in order:
1. What does their company do? (industry, size, stage)
2. What's the challenge they're facing?
3. What have they tried so far?
4. What would success look like?
5. What's their budget range?
6. What's their email address?

CONVERSATION RULES:
- Open with 1 short sentence acknowledging they want a proposal, then ask Q1.
- After each answer, acknowledge it in 1 sentence, then ask the next question.
- Keep Sridhar's voice: short declarative sentences, no fluff, no emojis, no exclamation points, no filler.
- Email validation: if the email doesn't look valid (missing @ or domain), ask again naturally. Do not move on until you have a valid email.
- After a valid email is collected, say exactly: "Perfect — I'll put together a proposal tailored to your situation. You'll have it in your inbox shortly."

MARKER RULES — CRITICAL — NEVER SKIP:
Append exactly one marker at the very end of EVERY response. No exceptions.

- Response asks Q1 → append: <INTAKE_STEP>1</INTAKE_STEP>
- Response acknowledges Q1 and asks Q2 → append: <INTAKE_STEP>2</INTAKE_STEP>
- Response acknowledges Q2 and asks Q3 → append: <INTAKE_STEP>3</INTAKE_STEP>
- Response acknowledges Q3 and asks Q4 → append: <INTAKE_STEP>4</INTAKE_STEP>
- Response acknowledges Q4 and asks Q5 → append: <INTAKE_STEP>5</INTAKE_STEP>
- Response acknowledges Q5 and asks Q6 (email) → append: <INTAKE_STEP>6</INTAKE_STEP>
- Invalid email, re-asking for email → append: <INTAKE_STEP>6</INTAKE_STEP>
- Valid email collected, intake complete → append: <INTAKE_COMPLETE>{"company":"VALUE","challenge":"VALUE","tried":"VALUE","success":"VALUE","budget":"VALUE","email":"VALUE"}</INTAKE_COMPLETE>

The marker number matches the question being ASKED in that response.
Never include both markers in a single response.
Never include the marker mid-sentence — always at the very end.
`.trim();

// ── Intake detection ──────────────────────────────────────────────────────────
const INTAKE_TRIGGER = "I'd like to get a proposal.";

function isIntakeConversation(messages) {
  return messages.some(m => m.role === 'user' && m.content === INTAKE_TRIGGER);
}

// ── Marker parsing ────────────────────────────────────────────────────────────
function parseMarkers(text) {
  let clean = text;
  let intake_step = null;
  let intake_complete = false;
  let intake_data = null;

  // Check for INTAKE_COMPLETE
  const completeMatch = clean.match(/<INTAKE_COMPLETE>([\s\S]*?)<\/INTAKE_COMPLETE>/);
  if (completeMatch) {
    try {
      intake_data = JSON.parse(completeMatch[1]);
      intake_complete = true;
    } catch (e) {
      // malformed JSON — still strip the tag
    }
    clean = clean.replace(/<INTAKE_COMPLETE>[\s\S]*?<\/INTAKE_COMPLETE>/, '').trim();
  }

  // Check for INTAKE_STEP
  const stepMatch = clean.match(/<INTAKE_STEP>(\d+)<\/INTAKE_STEP>/);
  if (stepMatch) {
    intake_step = parseInt(stepMatch[1], 10);
    clean = clean.replace(/<INTAKE_STEP>\d+<\/INTAKE_STEP>/, '').trim();
  }

  return { clean, intake_step, intake_complete, intake_data };
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === 'your_openrouter_api_key_here') {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not set in .env' });
  }

  const intake = isIntakeConversation(messages);
  const systemPrompt = intake ? INTAKE_SYSTEM_PROMPT : QA_SYSTEM_PROMPT;

  const payload = JSON.stringify({
    model: 'anthropic/claude-sonnet-4-6',
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-12)  // keep last 12 turns (intake needs more history)
    ],
    max_tokens: intake ? 400 : 300,
    temperature: 0.65
  });

  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${apiKey}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'HTTP-Referer':   'https://gw2r.com',
      'X-Title':        'GW2R Website Chat'
    }
  };

  const request = https.request(options, (response) => {
    let data = '';
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => {
      try {
        const json = JSON.parse(data);
        const raw  = json.choices?.[0]?.message?.content?.trim();
        if (raw) {
          const { clean, intake_step, intake_complete, intake_data } = parseMarkers(raw);
          const reply = { message: clean };
          if (intake_step !== null)  reply.intake_step = intake_step;
          if (intake_complete)       reply.intake_complete = true;
          if (intake_data)           reply.intake_data = intake_data;
          res.json(reply);
        } else {
          console.error('OpenRouter unexpected response:', data);
          res.status(502).json({ error: 'No content in API response' });
        }
      } catch (err) {
        console.error('Parse error:', err.message, data);
        res.status(502).json({ error: 'Failed to parse API response' });
      }
    });
  });

  request.on('error', (err) => {
    console.error('Request error:', err.message);
    res.status(502).json({ error: 'API request failed' });
  });

  request.write(payload);
  request.end();
};
