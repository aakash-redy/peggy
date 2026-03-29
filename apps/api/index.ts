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
const PORT = process.env.PORT || 8000;
const IS_PROD = process.env.NODE_ENV === 'production';

const VALID_DOMAINS = [
  "Formula Bharat 2027 Full", "Braking", "Chassis",
  "Tractive System (EV)", "Suspension", "Aerodynamics", "Business"
] as const;

type Domain = typeof VALID_DOMAINS[number];

const CONFIG = {
  MATCH_THRESHOLD: 0.5,
  MATCH_COUNT: 5,
  QUIZ_MATCH_COUNT: 8,
  MAX_MESSAGE_LENGTH: 1000,
  MIN_MESSAGE_LENGTH: 3,
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX: IS_PROD ? 10 : 20,
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

// ── Model Fallback Chain ────────────────────────────────────────────────────
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
      const is429 = error?.message?.includes('429') ||
                    error?.message?.includes('quota') ||
                    error?.message?.includes('Too Many Requests');
      if (is429) {
        logger.info(`Model ${modelName} quota exceeded — shifting to next model...`);
        continue;
      }
      throw error;
    }
  }
  throw new Error("All models quota exceeded. Please try again later.");
}

// ============================================================================
// ── 3. SECURITY & MIDDLEWARE ─────────────────────────────────────────────────
// ============================================================================

// ── Rate Limiter ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." }
});

// ── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Unauthorized: No token provided." });
    return;
  }

  const validToken = process.env.API_AUTH_TOKEN!;
  const isValid = crypto.timingSafeEqual(
    Buffer.from(token.padEnd(64)),
    Buffer.from(validToken.padEnd(64))
  );

  if (!isValid) {
    res.status(403).json({ error: "Forbidden: Invalid token." });
    return;
  }

  (req as any).requestId = crypto.randomUUID();
  next();
}

const allowedOrigins = IS_PROD
  ? (process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || [])
  : [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://localhost:5174'
    ];

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
// ── 4. ROUTES ───────────────────────────────────────────────────────────────
// ============================================================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: "ok", service: "Sora Backend", version: "3.0.0 (Fallback Enabled)",
    environment: IS_PROD ? 'production' : 'development'
  });
});

// --- CORE RAG ENGINE: ASK SORA ---
app.post('/ask_sora', requireAuth, limiter, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const { message, domain } = req.body;

  if (!message || typeof message !== 'string') return res.status(400).json({ error: "Invalid question." });
  const sanitizedDomain = domain || "Formula Bharat 2027 Full";

  logger.info("Incoming rule query", { requestId, domain: sanitizedDomain });

  try {
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
    const embedResult = await embeddingModel.embedContent({
      content: { parts: [{ text: message.trim() }], role: "user" },
      taskType: "RETRIEVAL_QUERY" as any,
      outputDimensionality: 768
    } as any);

    const { data: matchedRules, error: supabaseError } = await supabase.rpc('match_rulebook_chunks', {
      query_embedding: embedResult.embedding.values,
      match_threshold: CONFIG.MATCH_THRESHOLD,
      match_count: CONFIG.MATCH_COUNT,
      filter_domain: sanitizedDomain
    });

    if (supabaseError) throw new Error("Database search failed");

    if (!matchedRules || matchedRules.length === 0) {
      return res.json({
        answer: "I couldn't find any rules matching your question. Please verify in the official PDF.",
        citations: [], domain: sanitizedDomain
      });
    }

    const contextText = matchedRules.map((r: any) => `[Rule ID: ${r.rule_id}]\n${r.content}`).join("\n\n---\n\n");

    const systemPrompt = `
You are Sora, the expert AI Technical Inspector for Hexawatts Racing (Formula Bharat).
Answer ONLY using the rulebook context provided below. Always cite the exact Rule ID.
If the answer is not in the context, say so. Keep a professional engineering tone.

CONTEXT:
${contextText}

QUESTION:
${message.trim()}
    `;

    logger.info("Generating answer with Fallback Chain", { requestId });
    const answer = await generateWithFallback(systemPrompt, false, 0.4);

    return res.json({
      answer,
      citations: matchedRules.map((r: any) => ({ rule_id: r.rule_id, content: r.content })),
    });

  } catch (error) {
    logger.error("Error in /ask_sora", error, { requestId });
    return res.status(500).json({ error: "Sora encountered a glitch. Please try again." });
  }
});

// --- DYNAMIC QUIZ ENGINE ---
app.post('/generate_quiz', requireAuth, limiter, async (req: Request, res: Response) => {
  const requestId = (req as any).requestId;
  const topic = req.body.topic || "General mechanical and safety requirements";
  const domain = req.body.domain || "Formula Bharat 2027 Full";

  logger.info("Generating Quiz", { requestId, topic, domain });

  try {
    const embeddingModel = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
    const embedResult = await embeddingModel.embedContent({
      content: { parts: [{ text: topic }], role: "user" },
      taskType: "RETRIEVAL_QUERY" as any,
      outputDimensionality: 768
    } as any);

    const { data: matchedRules, error: supabaseError } = await supabase.rpc('match_rulebook_chunks', {
      query_embedding: embedResult.embedding.values,
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
Vary the question types — mix conceptual understanding, numerical/specification recall, and rule application scenarios.

RULES CONTEXT:
${contextText}

REQUIREMENTS:
- The questions must be highly technical and specific to the rules provided.
- Make the wrong options plausible but clearly incorrect according to the rule.
- Do NOT repeat the same question style for all 3 questions.
- Output the result strictly as a JSON array.

JSON SCHEMA EXPECTED:
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 1,
    "explanation": "Rule ID: Explanation of why this is correct."
  }
]
    `;

    logger.info("Generating JSON Quiz with Fallback Chain", { requestId });
    const answer = await generateWithFallback(prompt, true, 1.2);

    const quizData = JSON.parse(answer);

    logger.info("Quiz generated successfully", { requestId });
    return res.json({ questions: quizData });

  } catch (error) {
    logger.error("Error in /generate_quiz", error, { requestId });
    return res.status(500).json({ error: "Failed to generate quiz. Try again." });
  }
});

// ============================================================================
// ── 5. ERROR HANDLING & STARTUP ─────────────────────────────────────────────
// ============================================================================
app.use((_req: Request, res: Response) => res.status(404).json({ error: "Route not found." }));

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("Unhandled error", error);
  res.status(500).json({ error: "An unexpected error occurred." });
});

app.listen(PORT, () => {
  console.log(`\n🏁 Sora Backend live at http://localhost:${PORT}`);
  console.log(`🌍 Environment : ${IS_PROD ? 'production' : 'development'}`);
  console.log(`🔒 Security    : Helmet & Timing-Safe Auth Active`);
  console.log(`🛡️ Fallback    : Waterfall generation enabled`);
  console.log(`🎯 DB Connect  : Supabase pgvector Connected\n`);
});