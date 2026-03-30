import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import helmet from 'helmet';
import crypto from 'crypto';

dotenv.config();

// ============================================================================
// ── 1. CONFIGURATION & STARTUP CHECKS ───────────────────────────────────────
// ============================================================================
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'GEMINI_API_KEY', 'API_AUTH_TOKEN'];
requiredEnvVars.forEach(v => {
  if (!process.env[v]) throw new Error(`🚨 CRITICAL: Missing ${v} in .env — server cannot start.`);
});

const app = express();

// 🚨 CRITICAL FIX FOR RENDER: Tells Express to look at the real user's IP, 
// not the Render Load Balancer IP. Prevents the whole team from getting rate-limited.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 8000;
const IS_PROD = process.env.NODE_ENV === 'production';

const CONFIG = {
  MATCH_THRESHOLD: 0.5,
  LEARNED_MATCH_THRESHOLD: 0.75,
  MATCH_COUNT: 5,
  LEARNED_MATCH_COUNT: 3,
  QUIZ_MATCH_COUNT: 8,
  TYPO_SCORE_THRESHOLD: 0.45,
  MAX_MESSAGE_LENGTH: 1000,
  MIN_MESSAGE_LENGTH: 2,
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX: IS_PROD ? 15 : 50,
  BODY_SIZE_LIMIT: '10kb'
} as const;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ============================================================================
// ── 2. LOGGING & UTILS ──────────────────────────────────────────────────────
// ============================================================================
const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[INFO] ${new Date().toISOString()} — ${msg}`, meta || ''),
  error: (msg: string, error: unknown, meta?: Record<string, unknown>) => {
    console.error(`[ERROR] ${new Date().toISOString()} — ${msg}`, {
      message: error instanceof Error ? error.message : String(error), ...meta
    });
  }
};

async function saveLog(data: {
  question: string;
  cleaned_question?: string;
  answer: string;
  domain?: string;
  matched_rule_ids?: string[];
  was_greeted?: boolean;
}) {
  try {
    const { error } = await supabase.from('sora_logs').insert([data]);
    if (error) logger.error("saveLog insert failed", error);
  } catch (err) {
    logger.error("saveLog threw", err);
  }
}

async function saveLearnedPair(
  question: string,
  answer: string,
  domain: string,
  source: string = 'user_feedback'
) {
  try {
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
    const embedResult = await embeddingModel.embedContent({
      content: { parts: [{ text: question }], role: "user" },
      taskType: "RETRIEVAL_DOCUMENT" as any,
      outputDimensionality: 768
    } as any);

    const { error } = await supabase.from('sora_learned').insert([{
      question,
      answer,
      domain,
      embedding: embedResult.embedding.values,
      source
    }]);

    if (error) logger.error("saveLearnedPair insert failed", error);
    else logger.info(`Learned pair saved `);
  } catch (err) {
    logger.error("saveLearnedPair threw", err);
  }
}

// ============================================================================
// ── 3. AI HELPERS ───────────────────────────────────────────────────────────
// ============================================================================

const GENERATIVE_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-pro",
];

async function generateWithFallback(
  prompt: string,
  requireJson: boolean = false,
  temperature: number = 0.7
): Promise<string> {
  for (const modelName of GENERATIVE_MODELS) {
    try {
      logger.info(`Trying model: ${modelName}`);
      const modelOptions: any = {
        model: modelName,
        generationConfig: {
          temperature,
          ...(requireJson && { responseMimeType: "application/json" })
        }
      };
      const model = genAI.getGenerativeModel(modelOptions);
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (error: any) {
      const is429 =
        error?.message?.includes('429') ||
        error?.message?.includes('quota') ||
        error?.message?.includes('Too Many Requests');
      if (is429) {
        logger.info(`Model ${modelName} quota exceeded — trying next...`);
        continue;
      }
      throw error;
    }
  }
  throw new Error("All models quota exceeded. Please try again later.");
}

async function embedQuery(text: string): Promise<number[]> {
  const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
  const result = await embeddingModel.embedContent({
    content: { parts: [{ text }], role: "user" },
    taskType: "RETRIEVAL_QUERY" as any,
    outputDimensionality: 768
  } as any);
  return result.embedding.values;
}

async function correctSpelling(rawQuery: string): Promise<string> {
  try {
    const prompt = `You are a spell-checker for Formula Bharat / motorsport engineering queries.
Fix ONLY spelling mistakes and typos. Do NOT rephrase, restructure, or change meaning.
Do NOT change: rule numbers, abbreviations (EV, IC, FSAE, FB, etc.), technical terms.
Return ONLY the corrected query as plain text. No explanation. No quotes.

Query: ${rawQuery}`;
    const corrected = await generateWithFallback(prompt, false, 0.05);
    return corrected.trim().replace(/^["'`]|["'`]$/g, '');
  } catch {
    return rawQuery;
  }
}

const GREETING_PATTERNS = [
  /^(hi+|hello+|hey+|hiya|howdy|sup|yo+)[\s!?.]*$/i,
  /^what'?s\s+up[\s!?.]*$/i,
  /^good\s+(morning|evening|afternoon|night)[\s!?.]*$/i,
  /^(namaste|namaskar|vanakkam)[\s!?.]*$/i,
  /^how are you[\s!?.]*$/i,
  /^who are you[\s!?.]*$/i,
  /^what can you do[\s!?.]*$/i,
  /^(help|start|begin)[\s!?.]*$/i,
];

function isGreeting(message: string): boolean {
  return GREETING_PATTERNS.some(p => p.test(message.trim()));
}

const GREETING_RESPONSES = [
  "Hey! 👋 I'm Sora, your Formula Bharat 2027 technical assistant. Ask me anything about the rulebook — braking, chassis, tractive systems, aerodynamics, you name it!",
  "Hi there! 🏁 Sora here — your go-to for FB rulebook queries. What rule do you want to dig into?",
  "Hello! 👋 I'm Sora. Got a technical question about Formula Bharat 2027? Fire away — I'll pull the exact clause for you.",
  "Hey! Sora at your service 🔧 Ask me about any rule — chassis dimensions, EV safety, braking specs, anything!",
];

function randomGreeting(): string {
  return GREETING_RESPONSES[Math.floor(Math.random() * GREETING_RESPONSES.length)];
}

// ============================================================================
// ── 4. SECURITY & TEAM AUTHENTICATION ────────────────────────────────────────
// ============================================================================

const limiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." }
});

// 🚀 UPGRADED AUTH: Supports both Master Token (Local testing) AND Team Member Approval
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Unauthorized: No token provided." });
    return;
  }

  // 1. Check if it's the Master API Token (Keeps your current React UI working)
  try {
    const validToken = process.env.API_AUTH_TOKEN!;
    const tokenBuf = Buffer.alloc(128);
    const validBuf = Buffer.alloc(128);
    tokenBuf.write(token.substring(0, 128));
    validBuf.write(validToken.substring(0, 128));

    if (crypto.timingSafeEqual(tokenBuf, validBuf)) {
      (req as any).requestId = crypto.randomUUID();
      (req as any).user = { role: 'admin' };
      return next(); // Master Token verified, bypass team check!
    }
  } catch (err) {
    // Fails safely, moves to check if it's a Supabase Team JWT
  }

  // 2. If it's NOT the master token, verify it as a Supabase JWT (For team members)
  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({ error: "Unauthorized: Invalid or expired session." });
      return;
    }

    // 3. Check if Aakash approved them in the hexawatts_team table
    const { data: teamMember, error: dbError } = await supabase
      .from('hexawatts_team')
      .select('is_approved, email')
      .eq('id', user.id)
      .single();

    if (dbError || !teamMember || teamMember.is_approved === false) {
      res.status(403).json({ 
        error: "ACCOUNT_PENDING", 
        message: "Welcome to Hexawatts! Your account is pending. Tell Aakash to approve your access." 
      });
      return;
    }

    // 4. Team Member Verified!
    (req as any).requestId = crypto.randomUUID();
    (req as any).user = { id: user.id, email: teamMember.email };
    next();
  } catch (err) {
    logger.error("Auth Middleware Error", err);
    res.status(500).json({ error: "Authentication system offline." });
  }
}

const allowedOrigins = IS_PROD
  ? (process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || [])
  : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000', 'http://localhost:5174'];

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  for (const allowed of allowedOrigins) {
    if (allowed.startsWith('*.') && origin.endsWith(allowed.slice(1))) return true;
  }
  return false;
}

app.use(helmet());
app.use(express.json({ limit: CONFIG.BODY_SIZE_LIMIT }));
app.use(cors({
  origin: (origin, callback) => {
    const decision = isAllowedOrigin(origin) ? '✅ ALLOWED' : '❌ BLOCKED';
    logger.info(`CORS [${decision}] → Origin: ${origin || 'undefined'} | Env: ${IS_PROD ? 'prod' : 'dev'}`);
    if (isAllowedOrigin(origin)) return callback(null, true);
    logger.error(`CORS blocked origin: ${origin || 'undefined'}`,
      new Error(`CORS: Origin ${origin || 'undefined'} not permitted`));
    return callback(new Error(`CORS: Origin ${origin || 'undefined'} not permitted`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400,
  optionsSuccessStatus: 204
}));

// ============================================================================
// ── 5. ROUTES ───────────────────────────────────────────────────────────────
// ============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "Sora Backend",
    version: "7.0.0 (Team Auth Ready)",
    environment: IS_PROD ? 'production' : 'development'
  });
});

// ── ASK SORA ─────────────────────────────────────────────────────────────────
app.post('/ask_sora', requireAuth, limiter, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const { message, domain } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length < CONFIG.MIN_MESSAGE_LENGTH) {
    return res.status(400).json({ error: "Please enter a valid question." });
  }

  const sanitizedDomain = domain || "Formula Bharat 2027 Full";
  const trimmedMessage = message.trim();

  logger.info("Incoming query", { requestId, domain: sanitizedDomain });

  if (isGreeting(trimmedMessage)) {
    const reply = randomGreeting();
    await saveLog({ question: trimmedMessage, answer: reply, domain: sanitizedDomain, was_greeted: true });
    return res.json({ answer: reply, citations: [] });
  }

  try {
    let queryToUse = trimmedMessage;
    let wasSpellCorrected = false;
    let embedding = await embedQuery(queryToUse);

    let { data: matchedRules, error: supabaseError } = await supabase.rpc('match_rulebook_chunks', {
      query_embedding: embedding,
      match_threshold: CONFIG.MATCH_THRESHOLD,
      match_count: CONFIG.MATCH_COUNT,
      filter_domain: sanitizedDomain
    });

    if (supabaseError) throw new Error("Database search failed");

    const bestScore = matchedRules?.[0]?.similarity ?? 0;
    if (!matchedRules || matchedRules.length === 0 || bestScore < CONFIG.TYPO_SCORE_THRESHOLD) {
      logger.info(`Weak match (score: ${bestScore}) — attempting spell correction`, { requestId });

      const corrected = await correctSpelling(trimmedMessage);

      if (corrected.toLowerCase() !== trimmedMessage.toLowerCase()) {
        wasSpellCorrected = true;
        queryToUse = corrected;
        embedding = await embedQuery(corrected);

        const retryResult = await supabase.rpc('match_rulebook_chunks', {
          query_embedding: embedding,
          match_threshold: CONFIG.MATCH_THRESHOLD,
          match_count: CONFIG.MATCH_COUNT,
          filter_domain: sanitizedDomain
        });

        if (!retryResult.error && retryResult.data?.length > 0) {
          matchedRules = retryResult.data;
          logger.info(`Spell correction improved results: "${trimmedMessage}" → "${corrected}"`, { requestId });
        }
      }
    }

    const { data: learnedMatches } = await supabase.rpc('match_learned_chunks', {
      query_embedding: embedding,
      match_threshold: CONFIG.LEARNED_MATCH_THRESHOLD,
      match_count: CONFIG.LEARNED_MATCH_COUNT,
      filter_domain: sanitizedDomain
    });

    const hasRuleMatches = matchedRules && matchedRules.length > 0;
    const hasLearnedMatches = learnedMatches && learnedMatches.length > 0;

    if (!hasRuleMatches && !hasLearnedMatches) {
      const noMatchReply = wasSpellCorrected
        ? `I tried interpreting your question as *"${queryToUse}"* but still couldn't find a matching rule. Could you try rephrasing it?`
        : "I couldn't find a rule matching your question. Try rephrasing, or check the official rulebook PDF directly.";

      await saveLog({
        question: trimmedMessage,
        cleaned_question: wasSpellCorrected ? queryToUse : undefined,
        answer: noMatchReply,
        domain: sanitizedDomain,
        matched_rule_ids: []
      });

      return res.json({ answer: noMatchReply, citations: [] });
    }

    const ruleContext = hasRuleMatches
      ? matchedRules.map((r: any) => `[Rule ID: ${r.rule_id}]\n${r.content}`).join("\n\n---\n\n")
      : "No direct rulebook match found for this query.";

    const learnedContext = hasLearnedMatches
      ? "\n\n--- PREVIOUSLY LEARNED (from team interactions) ---\n\n" +
        learnedMatches.map((l: any) => `Q: ${l.question}\nA: ${l.answer}`).join("\n\n")
      : "";

    const systemPrompt = `
You are Sora, the expert AI Technical Inspector for Hexawatts Racing (Formula Bharat 2027).

Your personality:
- Friendly and approachable, like a knowledgeable teammate
- Clear and concise — no unnecessary jargon
- Always accurate — answer ONLY from the context provided below
- Always cite the exact Rule ID when referencing a rule
- If a rule has a specific number or measurement, state it precisely
- If the answer is not in the context, say so honestly and suggest checking the official PDF
- If the answer comes from learned team data, mention that clearly

RULEBOOK CONTEXT:
${ruleContext}
${learnedContext}

QUESTION: ${queryToUse}
${wasSpellCorrected ? `(Note: original query was "${trimmedMessage}", auto-corrected to "${queryToUse}")` : ''}
    `;

    logger.info("Generating answer", { requestId });
    const answer = await generateWithFallback(systemPrompt, false, 0.45);

    await saveLog({
      question: trimmedMessage,
      cleaned_question: wasSpellCorrected ? queryToUse : undefined,
      answer,
      domain: sanitizedDomain,
      matched_rule_ids: hasRuleMatches ? matchedRules.map((r: any) => r.rule_id) : []
    });

    if (bestScore >= 0.75) {
      saveLearnedPair(queryToUse, answer, sanitizedDomain, 'auto_high_confidence').catch(() => {});
    }

    return res.json({
      answer,
      citations: hasRuleMatches
        ? matchedRules.map((r: any) => ({ rule_id: r.rule_id, content: r.content }))
        : [],
      ...(wasSpellCorrected && { corrected_query: queryToUse }),
      ...(hasLearnedMatches && !hasRuleMatches && { source: 'learned' })
    });

  } catch (error) {
    logger.error("Error in /ask_sora", error, { requestId });
    return res.status(500).json({ error: "Sora hit a snag. Please try again in a moment." });
  }
});

// ── GENERATE QUIZ ─────────────────────────────────────────────────────────────
app.post('/generate_quiz', requireAuth, limiter, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const topic = req.body.topic || "General mechanical and safety requirements";
  const domain = req.body.domain || "Formula Bharat 2027 Full";

  logger.info("Generating Quiz", { requestId, topic, domain });

  try {
    const embedding = await embedQuery(topic);

    const { data: matchedRules, error: supabaseError } = await supabase.rpc('match_rulebook_chunks', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: CONFIG.QUIZ_MATCH_COUNT,
      filter_domain: domain
    });

    if (supabaseError || !matchedRules || matchedRules.length === 0) {
      return res.status(500).json({ error: "Failed to pull rulebook data for quiz." });
    }

    const contextText = matchedRules.map((r: any) => `[RULE ${r.rule_id}]: ${r.content}`).join("\n\n");

    const prompt = `
You are the Chief Scrutineer for Formula Bharat 2027.
Generate exactly 3 multiple-choice questions based ONLY on the provided rules.
Vary the question types — mix conceptual understanding, numerical/specification recall, and real-world rule application scenarios.

RULES CONTEXT:
${contextText}

REQUIREMENTS:
- Questions must be highly technical and specific to the rules provided
- Wrong options must be plausible but clearly incorrect per the rule
- Do NOT repeat the same question style for all 3
- Output strictly as a JSON array, nothing else

JSON SCHEMA:
[
  {
    "question": "Question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0,
    "explanation": "Rule X.Y.Z: Why this answer is correct."
  }
]
    `;

    const answer = await generateWithFallback(prompt, true, 1.2);
    const quizData = JSON.parse(answer);

    logger.info("Quiz generated", { requestId });
    return res.json({ questions: quizData });

  } catch (error) {
    logger.error("Error in /generate_quiz", error, { requestId });
    return res.status(500).json({ error: "Failed to generate quiz. Try again." });
  }
});

// ── FEEDBACK ──────────────────────────────────────────────────────────────────
app.post('/feedback', requireAuth, limiter, async (req: Request, res: Response) => {
  const { question, correct_answer, domain, comment } = req.body;

  if (!question || typeof question !== 'string' || !correct_answer || typeof correct_answer !== 'string') {
    return res.status(400).json({ error: "Both 'question' and 'correct_answer' are required." });
  }

  const resolvedDomain = domain || "Formula Bharat 2027 Full";

  try {
    await saveLog({
      question,
      cleaned_question: comment ? `User comment: ${comment}` : undefined,
      answer: `[USER CORRECTION] ${correct_answer}`,
      domain: resolvedDomain,
      matched_rule_ids: []
    });

    await saveLearnedPair(question, correct_answer, resolvedDomain, 'user_correction');

    return res.json({ message: "Got it! Thanks for the correction — Sora will remember this. 🙏" });
  } catch (error) {
    logger.error("Error in /feedback", error);
    return res.status(500).json({ error: "Failed to save feedback." });
  }
});

// ============================================================================
// ── 6. ERROR HANDLING & STARTUP ─────────────────────────────────────────────
// ============================================================================
app.use((_req: Request, res: Response) => res.status(404).json({ error: "Route not found." }));

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled error", error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => {
  console.log(`\n🏁 Sora Backend live at http://localhost:${PORT}`);
  console.log(`🌍 Environment : ${IS_PROD ? 'production' : 'development'}`);
  console.log(`🔒 Security    : Helmet & Dual-Auth Active (Team + Master)`);
  console.log(`🛡️  Fallback    : Waterfall generation enabled`);
  console.log(`📝 Logging     : Supabase sora_logs active`);
  console.log(`🧠 Learning    : sora_learned table active`);
  console.log(`🎯 DB Connect  : Supabase pgvector Connected\n`);
});