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
// ── 1. CONFIGURATION & STARTUP CHECKS
// ============================================================================

/**
 * MODEL ROTATION STRATEGY
 * ─────────────────────────────────────────────────────────────────────────
 * You have 2 API keys:
 *   GEMINI_API_KEY       → primary key  (generation + embeddings)
 *   GEMINI_RERANK_API_KEY → rerank key (dedicated to LLM reranking only)
 *
 * Each key has multiple models available, each with its own quota bucket.
 * The engine works like this:
 *
 *   PRIMARY KEY  ─► try gemini-2.5-flash   (fastest, highest quota tier)
 *                        │ 429/quota?
 *                        ▼
 *                   try gemini-2.0-flash
 *                        │ 429/quota?
 *                        ▼
 *                   try gemini-2.0-flash-lite
 *                        │ 429/quota?
 *                        ▼
 *                        │ all exhausted?
 *                        ▼
 *                   throw QUOTA_EXHAUSTED
 *
 *   RERANK KEY   → same cascade, but isolated so reranking never eats
 *                  your primary key's generation quota.
 *                  Falls back to primary key's cascade if all rerank
 *                  models are also exhausted.
 *
 * Each model's quota state is tracked independently (cooldown circuit
 * breaker). When a model cools down it becomes eligible again automatically.
 *
 * .env setup:
 *   GEMINI_API_KEY=AIza...          ← your main key
 *   GEMINI_RERANK_API_KEY=AIza...   ← your second key
 */

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'GEMINI_API_KEY',
  'GEMINI_RERANK_API_KEY',
  'API_AUTH_TOKEN',
];

requiredEnvVars.forEach(v => {
  if (!process.env[v]) throw new Error(`🚨 CRITICAL: Missing ${v} in .env — server cannot start.`);
});

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 8000;
const IS_PROD = process.env.NODE_ENV === 'production';

const CONFIG = {
  MATCH_THRESHOLD: 0.5,
  LEARNED_MATCH_THRESHOLD: 0.75,
  MATCH_COUNT: 5,
  LEARNED_MATCH_COUNT: 3,
  CACHE_TTL_MS: 60 * 60 * 1000,
  CACHE_SIMILARITY_THRESHOLD: 0.97,
  MAX_MESSAGE_LENGTH: 1000,
  MIN_MESSAGE_LENGTH: 2,
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  RATE_LIMIT_MAX: IS_PROD ? 15 : 50,
  ASK_RATE_LIMIT_MAX: IS_PROD ? 10 : 30,
  BODY_SIZE_LIMIT: '10kb',
  EMBEDDING_MODEL: 'models/gemini-embedding-001',

  /**
   * Model cooldown: after a 429, that specific model is skipped for this
   * many ms before being retried. Set low (60s) because Gemini quotas
   * reset on a per-minute rolling window for most free-tier models.
   */
  MODEL_COOLDOWN_MS: 60 * 1000,
} as const;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

// ============================================================================
// ── 2. MODEL ROSTER & PER-MODEL CIRCUIT BREAKER
// ============================================================================

/**
 * ModelSlot — one model on one API key.
 *
 * Each slot tracks its own quota state independently.
 * This means gemini-2.5-flash and gemini-2.0-flash have separate cooldowns
 * on the same key, so hitting flash's quota doesn't block flash-lite.
 */
interface ModelSlot {
  label: string;          // human-readable, e.g. "PRIMARY/gemini-2.5-flash"
  modelName: string;      // exact string passed to the Gemini SDK
  client: GoogleGenerativeAI;
  coolUntil: number;      // epoch ms; 0 = always eligible
  quotaHits: number;      // lifetime counter for observability
  successCount: number;   // lifetime counter for observability
}

/**
 * Build an ordered list of ModelSlots for one API key.
 * Models are listed fastest/most-capable first. When a model's quota is
 * hit its slot is cooled and the next model in the list is tried.
 */
function buildModelRoster(apiKey: string, keyLabel: string): ModelSlot[] {
  const client = new GoogleGenerativeAI(apiKey);

  // Order matters: best first, degrade gracefully on quota.
  // gemini-1.5-flash removed — 404 on v1beta (not supported for generateContent).
  const models = [
    'gemini-2.5-flash',       // Best — tried first
    'gemini-2.0-flash',       // Main fallback
    'gemini-2.0-flash-lite',  // Cheapest quota bucket — last resort
  ];

  return models.map(modelName => ({
    label: `${keyLabel}/${modelName}`,
    modelName,
    client,
    coolUntil: 0,
    quotaHits: 0,
    successCount: 0,
  }));
}

// Primary roster: used for generation, embeddings, intent classification, etc.
const primaryRoster: ModelSlot[] = buildModelRoster(
  process.env.GEMINI_API_KEY!,
  'PRIMARY',
);

// Rerank roster: dedicated second key, used only for LLM reranking.
const rerankRoster: ModelSlot[] = buildModelRoster(
  process.env.GEMINI_RERANK_API_KEY!,
  'RERANK',
);

/** Returns slots that are not currently cooling down. */
function activeSlots(roster: ModelSlot[]): ModelSlot[] {
  const now = Date.now();
  const active = roster.filter(s => s.coolUntil <= now);
  // If everything is cooling, return full list so callers can surface a proper error.
  return active.length > 0 ? active : roster;
}

/** Cool a slot after a quota hit. */
function coolSlot(slot: ModelSlot): void {
  slot.quotaHits++;
  slot.coolUntil = Date.now() + CONFIG.MODEL_COOLDOWN_MS;
  logger.warn(`[ROSTER] ${slot.label} quota hit #${slot.quotaHits}. Cooling ${CONFIG.MODEL_COOLDOWN_MS / 1000}s.`);
}

/**
 * True if the error means we should skip this model and try the next one.
 * Covers quota/rate-limit errors AND model-not-found (404) errors — both
 * mean "this model can't serve this request right now, move on".
 */
function isSkippableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    msg.includes('429')                      ||  // rate limited
    lower.includes('quota')                  ||  // quota exceeded
    lower.includes('resource_exhausted')     ||  // gRPC quota
    lower.includes('rate_limit')             ||  // rate limit variant
    msg.includes('404')                      ||  // model not found / not available
    lower.includes('not found')              ||  // model not found text
    lower.includes('is not supported')       ||  // unsupported method
    lower.includes('not supported for generatecontent')  // specific SDK message
  );
}

// ============================================================================
// ── 3. TYPES & INTERFACES
// ============================================================================

interface CacheEntry {
  embedding: number[];
  response: Record<string, unknown>;
  expiresAt: number;
}

interface AuthenticatedRequest extends Request {
  requestId: string;
  user: {
    id?: string;
    email?: string;
    role?: string;
  };
}

interface RuleChunk {
  rule_id: string;
  content: string;
  similarity: number;
  rerank_score?: number;
}

interface LearnedChunk {
  question: string;
  answer: string;
  source: string;
}

interface ModelRecord {
  name?: string;
  category?: string;
  description?: string;
  file_url?: string;
  file_size_mb?: number;
  model_rule_tags?: { rule_id: string }[];
  [key: string]: unknown;
}

type QueryIntent = 'dimension' | 'compliance' | 'definition' | 'procedure' | 'general';

// ============================================================================
// ── 4. IN-MEMORY SEMANTIC CACHE & GARBAGE COLLECTOR
// ============================================================================

const semanticCache = new Map<string, CacheEntry>();

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

function findCacheHit(embedding: number[], domain: string): Record<string, unknown> | null {
  const now = Date.now();
  for (const [key, entry] of semanticCache.entries()) {
    if (entry.expiresAt < now) { semanticCache.delete(key); continue; }
    if (!key.startsWith(domain + ':')) continue;
    if (cosineSimilarity(embedding, entry.embedding) >= CONFIG.CACHE_SIMILARITY_THRESHOLD) {
      return entry.response;
    }
  }
  return null;
}

function writeCache(embedding: number[], domain: string, response: Record<string, unknown>): void {
  const key = `${domain}:${crypto.randomUUID()}`;
  semanticCache.set(key, { embedding, response, expiresAt: Date.now() + CONFIG.CACHE_TTL_MS });
}

// Prune expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [key, entry] of semanticCache.entries()) {
    if (entry.expiresAt < now) { semanticCache.delete(key); pruned++; }
  }
  if (pruned > 0) logger.info(`Cache GC pruned ${pruned} expired entries.`);
}, 10 * 60 * 1000);

// ============================================================================
// ── 5. LOGGING & UTILITIES
// ============================================================================

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[INFO]  ${new Date().toISOString()} — ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[WARN]  ${new Date().toISOString()} — ${msg}`, meta ?? ''),
  error: (msg: string, error: unknown, meta?: Record<string, unknown>) =>
    console.error(`[ERROR] ${new Date().toISOString()} — ${msg}`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...meta,
    }),
};

async function saveLog(data: Record<string, unknown>): Promise<void> {
  try {
    const { error } = await supabase.from('sora_logs').insert([data]);
    if (error) logger.error('saveLog DB error', error);
  } catch (err) {
    logger.error('saveLog threw', err);
  }
}

async function saveLearnedPair(
  question: string,
  answer: string,
  domain: string,
  source = 'user_feedback',
): Promise<void> {
  try {
    const embedding = await embedQuery(question);
    await supabase.from('sora_learned').insert([{ question, answer, domain, embedding, source }]);
  } catch (err) {
    logger.error('saveLearnedPair threw', err);
  }
}

// ============================================================================
// ── 6. CORE AI ENGINE — PER-MODEL ROTATION
// ============================================================================

/**
 * generateWithRoster
 * ─────────────────────────────────────────────────────────────────────────
 * Works through a ModelSlot roster in order. Each slot is one model on one
 * API key. When a slot hits a quota error it is cooled and the next slot is
 * tried. Non-quota errors are rethrown immediately so real bugs surface.
 *
 * Example with primaryRoster (4 slots):
 *
 *   Request arrives
 *       │
 *       ▼
 *   PRIMARY/gemini-2.5-flash  ──OK──► return text
 *       │ 429
 *       ▼
 *   PRIMARY/gemini-2.0-flash  ──OK──► return text
 *       │ 429
 *       ▼
 *   PRIMARY/gemini-2.0-flash-lite ──OK──► return text
 *       │ 429
 *       ▼
 *   (all models exhausted)
 *       ▼
 *   throw QUOTA_EXHAUSTED
 */
async function generateWithRoster(
  prompt: string,
  roster: ModelSlot[],
  requireJson = false,
  temperature = 0.7,
): Promise<string> {
  const slots = activeSlots(roster);

  for (const slot of slots) {
    try {
      const model = slot.client.getGenerativeModel({
        model: slot.modelName,
        generationConfig: {
          temperature,
          ...(requireJson ? { responseMimeType: 'application/json' } : {}),
        },
      });
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      slot.successCount++;
      logger.info(`[ROSTER] ${slot.label} ✓ (successes: ${slot.successCount})`);
      return text;
    } catch (error: unknown) {
      if (isSkippableError(error)) {
        // Skip this model (quota hit or not available) and try the next slot
        coolSlot(slot);
        continue;
      }
      // Non-quota error (malformed request, network, auth, etc.) — surface immediately
      throw error;
    }
  }

  throw new Error('QUOTA_EXHAUSTED: All models on this roster are at quota limit. Try again shortly.');
}

/**
 * generate — primary workhorse for all generation tasks.
 *
 * Attempt order:
 *   1. primaryRoster  (GEMINI_API_KEY — 3 models in sequence)
 *   2. rerankRoster   (GEMINI_RERANK_API_KEY — cross-key fallback)
 *
 * When the primary key is fully quota-exhausted across all models,
 * the rerank key's headroom is used so requests never hard-fail.
 */
async function generate(
  prompt: string,
  requireJson = false,
  temperature = 0.7,
): Promise<string> {
  try {
    return await generateWithRoster(prompt, primaryRoster, requireJson, temperature);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('QUOTA_EXHAUSTED')) {
      logger.warn('[ROSTER] Primary roster exhausted — falling back to rerank key for generation.');
      return generateWithRoster(prompt, rerankRoster, requireJson, temperature);
    }
    throw err;
  }
}

// generateForRerank removed — reranking is now zero-cost (cosine sort)
// rerankRoster is now purely a quota fallback for generate()

// ============================================================================
// ── 7. EMBEDDINGS
// ============================================================================

/**
 * Embeddings use the primary key's client directly (not model rotation —
 * the embedding model has its own separate quota and rarely hits it).
 * We always use the first slot's client since all slots share the same
 * underlying API key object on the primary roster.
 */
async function embedText(text: string, taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT'): Promise<number[]> {
  const client = primaryRoster[0].client;
  const embeddingModel = client.getGenerativeModel({ model: CONFIG.EMBEDDING_MODEL });
  const result = await embeddingModel.embedContent({
    content: { parts: [{ text }], role: 'user' },
    taskType: taskType as never,
    outputDimensionality: 768,
  } as never);
  return result.embedding.values;
}

const embedQuery    = (text: string) => embedText(text, 'RETRIEVAL_QUERY');
const embedDocument = (text: string) => embedText(text, 'RETRIEVAL_DOCUMENT');

// ============================================================================
// ── 8. RAG PIPELINE HELPERS
// ============================================================================

/** Spelling correction removed — was an entire LLM call for rare benefit.
 *  The embedding model handles minor typos naturally via semantic similarity. */
async function correctSpelling(rawQuery: string): Promise<string> {
  return rawQuery;
}

/**
 * Single embedding — no LLM call.
 * Query expansion (4 LLM calls + 4 embeddings) was the main quota killer.
 * The embedding model alone retrieves well; expansion added marginal quality
 * at massive cost. Name kept so call sites need no changes.
 */
async function expandAndAverageEmbedding(query: string): Promise<number[]> {
  return embedQuery(query);
}

/**
 * Rerank using the similarity scores already returned by Supabase vector search.
 * Zero LLM calls — just sort by the similarity score that pgvector already computed.
 * The LLM reranker added ~1 call per request on the rerank key; the vector scores
 * are already a strong relevance signal straight from the embedding space.
 */
function rerankChunks(_query: string, chunks: RuleChunk[]): RuleChunk[] {
  return [...chunks]
    .sort((a, b) => b.similarity - a.similarity)
    .map(c => ({ ...c, rerank_score: c.similarity }));
}

/** Classify intent with zero LLM calls — pure keyword matching. */
function classifyIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  if (/\b(how (wide|tall|long|thick|deep)|dimension|size|length|width|height|weight|distance|radius|diameter|mm|cm|kg|newton|force|thickness|volume|area)\b/.test(q)) return 'dimension';
  if (/\b(legal|illegal|allowed|permitted|prohibited|pass|fail|comply|compliant|violation|violate|can i|is it ok|is .+ allowed)\b/.test(q)) return 'compliance';
  if (/\b(what is|define|definition|what does .+ mean|explain|describe)\b/.test(q)) return 'definition';
  if (/\b(how to|steps|procedure|process|install|mount|attach|assemble|test|inspect|check)\b/.test(q)) return 'procedure';
  return 'general';
}

function buildSystemPrompt(intent: QueryIntent, ruleContext: string, query: string): string {
  const base = `You are Indra, the expert AI Technical Inspector for Hexawatts Racing. Answer based ONLY on the provided regulation context. Always cite exact Rule IDs inline, e.g. [T3.14]. Do not speculate beyond the provided context.`;

  const intentInstructions: Record<QueryIntent, string> = {
    dimension: `${base}\nThe user asks about a MEASUREMENT. Your response MUST:\n1. State the exact value with units first.\n2. List all related dimensional constraints as bullet points.\n3. Note any conditional rules or exceptions.`,
    compliance: `${base}\nThe user asks a COMPLIANCE question. Your response MUST:\n1. Start with a clear verdict: ✅ LEGAL / ❌ ILLEGAL / ⚠️ CONDITIONAL.\n2. Cite the determining rule(s).\n3. List any specific conditions or exceptions.`,
    definition: `${base}\nThe user wants a DEFINITION. Your response MUST:\n1. Give a concise 1–2 sentence definition.\n2. Explain its purpose in the car.\n3. Cite the defining rule.`,
    procedure: `${base}\nThe user asks about a PROCEDURE. Your response MUST:\n1. List steps in numbered order.\n2. Highlight mandatory inspection points.\n3. Cite the relevant rule for each key step.`,
    general: `${base}\nProvide a clear, structured answer. Use bullet points for multiple points. Cite rule IDs inline.`,
  };

  return `${intentInstructions[intent]}\n\nREGULATION CONTEXT:\n${ruleContext}\n\nQUESTION: ${query}`;
}

function extractKeywordsFromQuery(query: string): string[] {
  const keywordsMap: Record<string, string[]> = {
    'brake': ['Braking'], 'pedal': ['Braking'],
    'roll hoop': ['Safety', 'Chassis'], 'bulkhead': ['Chassis'],
    'impact attenuator': ['Chassis'], 'aip': ['Chassis'],
    'accumulator': ['Powertrain'], 'battery': ['Powertrain'], 'motor': ['Powertrain'],
    'shutdown': ['Safety'], 'fire': ['Safety'],
    'wing': ['Aerodynamics'], 'aero': ['Aerodynamics'],
    'steering': ['Chassis'], 'suspension': ['Chassis'],
  };
  const q = query.toLowerCase();
  const matched = new Set<string>();
  for (const [kw, cats] of Object.entries(keywordsMap)) {
    if (q.includes(kw)) cats.forEach(c => matched.add(c));
  }
  return Array.from(matched);
}

function determineHighlightMaterial(query: string, ruleIds: string[]): string | null {
  const q = query.toLowerCase();
  const rules = ruleIds.join(' ');
  if (rules.includes('T3.14') || q.includes('attenuator') || q.includes(' ia ') || q.includes('ia foam')) return 'mat_ia';
  if (rules.includes('T3.12') || rules.includes('T1.1.5') || q.includes('bulkhead')) return 'mat_bulkhead';
  if (rules.includes('T3.13') || q.includes('anti-intrusion') || q.includes('aip')) return 'mat_aip';
  if (rules.includes('T3.10') || q.includes('main hoop')) return 'mat_main_hoop';
  if (rules.includes('T3.11') || q.includes('front hoop')) return 'mat_front_hoop';
  return null;
}

function buildModelMetadata(
  model: ModelRecord,
  highlightMaterial: string | null,
  includeTags = true,
): Record<string, unknown> {
  return {
    name: model.name ?? 'Unknown Model',
    category: model.category ?? 'Uncategorized',
    tags: includeTags && Array.isArray(model.model_rule_tags)
      ? model.model_rule_tags.map(t => t.rule_id)
      : [],
    description: model.description ?? null,
    fileSize: model.file_size_mb ? `${model.file_size_mb} MB` : null,
    highlight_material: highlightMaterial,
  };
}

// ============================================================================
// ── 9. MIDDLEWARE
// ============================================================================

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: No token provided.' });
    return;
  }

  // Static admin token check (timing-safe)
  const validToken = process.env.API_AUTH_TOKEN!;
  const tokenBuf  = Buffer.from(token);
  const validBuf  = Buffer.from(validToken);
  if (tokenBuf.length === validBuf.length && crypto.timingSafeEqual(tokenBuf, validBuf)) {
    (req as AuthenticatedRequest).requestId = crypto.randomUUID();
    (req as AuthenticatedRequest).user = { role: 'admin' };
    return next();
  }

  // Supabase JWT check
  try {
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      res.status(401).json({ error: 'Unauthorized: Invalid or expired session.' });
      return;
    }

    const { data: teamMember, error: dbError } = await supabase
      .from('hexawatts_team')
      .select('is_approved, email')
      .eq('id', user.id)
      .single();

    if (dbError || !teamMember || teamMember.is_approved === false) {
      res.status(403).json({ error: 'ACCOUNT_PENDING', message: 'Your account is pending team lead approval.' });
      return;
    }

    (req as AuthenticatedRequest).requestId = crypto.randomUUID();
    (req as AuthenticatedRequest).user = { id: user.id, email: teamMember.email };
    next();
  } catch (err) {
    logger.error('Authentication error', err);
    res.status(500).json({ error: 'Authentication system error.' });
  }
}

const askLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.ASK_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many queries. Please wait a moment.' },
});

const generalLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  max: CONFIG.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet());
app.use(express.json({ limit: CONFIG.BODY_SIZE_LIMIT }));
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ============================================================================
// ── 10. ROUTES
// ============================================================================

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response): void => {
  const now = Date.now();

  const rosterStatus = (roster: ModelSlot[]) =>
    roster.map(s => ({
      model: s.modelName,
      label: s.label,
      status: s.coolUntil > now ? 'cooling' : 'active',
      coolRemaining: s.coolUntil > now ? `${Math.ceil((s.coolUntil - now) / 1000)}s` : null,
      quotaHits: s.quotaHits,
      successCount: s.successCount,
    }));

  res.json({
    status: 'ok',
    service: 'Indra Backend',
    version: '10.1.0',
    uptime_seconds: Math.floor(process.uptime()),
    cache_size: semanticCache.size,
    primary_roster: rosterStatus(primaryRoster),
    rerank_roster: rosterStatus(rerankRoster),
  });
});

// ── Cache admin ──────────────────────────────────────────────────────────────
app.get('/admin/cache', generalLimiter, requireAuth, (_req: Request, res: Response): void => {
  const now = Date.now();
  let active = 0, expired = 0;
  for (const entry of semanticCache.values()) {
    entry.expiresAt > now ? active++ : expired++;
  }
  res.json({ total_entries: semanticCache.size, active, expired });
});

app.post('/admin/cache/clear', generalLimiter, requireAuth, (req: Request, res: Response): void => {
  if ((req as AuthenticatedRequest).user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin only.' });
    return;
  }
  const cleared = semanticCache.size;
  semanticCache.clear();
  logger.info('Cache cleared by admin', { cleared });
  res.json({ message: `Cleared ${cleared} cache entries.` });
});

// ── Key pool status ──────────────────────────────────────────────────────────
app.get('/admin/keys', generalLimiter, requireAuth, (req: Request, res: Response): void => {
  if ((req as AuthenticatedRequest).user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin only.' });
    return;
  }
  const now = Date.now();
  const rosterStatus = (roster: ModelSlot[]) =>
    roster.map(s => ({
      label: s.label,
      model: s.modelName,
      status: s.coolUntil > now ? 'cooling' : 'active',
      coolUntil: s.coolUntil > now ? new Date(s.coolUntil).toISOString() : null,
      quotaHits: s.quotaHits,
      successCount: s.successCount,
    }));

  res.json({
    primary_roster: rosterStatus(primaryRoster),
    rerank_roster: rosterStatus(rerankRoster),
    note: 'Models are tried in order. A cooled model is skipped until its cooldown expires.',
  });
});

// ── Main RAG endpoint ────────────────────────────────────────────────────────
app.post('/ask_indra', askLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const authReq = req as AuthenticatedRequest;
  const requestId = authReq.requestId;
  const { message, domain } = req.body as { message: unknown; domain: unknown };

  // Validate input
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Invalid query: message must be a non-empty string.' });
    return;
  }
  const trimmed = message.trim();
  if (trimmed.length < CONFIG.MIN_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Query too short. Minimum ${CONFIG.MIN_MESSAGE_LENGTH} characters.` });
    return;
  }
  if (trimmed.length > CONFIG.MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `Query too long. Maximum ${CONFIG.MAX_MESSAGE_LENGTH} characters.` });
    return;
  }

  const sanitizedDomain = typeof domain === 'string' && domain.trim().length > 0
    ? domain.trim()
    : 'Formula Bharat 2027 Full';

  try {
    // Step 1: Classify intent (sync, 0 LLM calls) + embed query
    const intent = classifyIntent(trimmed);
    const expandedEmbedding = await expandAndAverageEmbedding(trimmed);
    logger.info('Query processed', { requestId, intent, domain: sanitizedDomain });

    // Step 2: Cache lookup
    const cacheHit = findCacheHit(expandedEmbedding, sanitizedDomain);
    if (cacheHit) {
      logger.info('Cache hit', { requestId });
      res.json({ ...cacheHit, _cache: 'hit' });
      return;
    }

    // Step 3: Vector search
    let queryToUse = trimmed;
    let embedding = expandedEmbedding;

    let { data: matchedRules, error: rpcError } = await supabase.rpc('match_rulebook_chunks', {
      query_embedding: embedding,
      match_threshold: CONFIG.MATCH_THRESHOLD,
      match_count: CONFIG.MATCH_COUNT,
      filter_domain: sanitizedDomain,
    });

    if (rpcError) logger.error('match_rulebook_chunks RPC error', rpcError, { requestId });

    const bestScore: number = (matchedRules as RuleChunk[] | null)?.[0]?.similarity ?? 0;

    // Step 4: (spelling correction removed — embedding handles minor typos naturally)

    // Step 5: Learned pairs + reranking in parallel
    const [learnedMatches, rerankedRules] = await Promise.all([
      (async (): Promise<LearnedChunk[]> => {
        try {
          const { data } = await supabase.rpc('match_learned_chunks', {
            query_embedding: embedding,
            match_threshold: CONFIG.LEARNED_MATCH_THRESHOLD,
            match_count: CONFIG.LEARNED_MATCH_COUNT,
          });
          return (data ?? []) as LearnedChunk[];
        } catch (err) {
          logger.error('Learned chunks fetch error', err, { requestId });
          return [];
        }
      })(),
      matchedRules && (matchedRules as RuleChunk[]).length > 1
        ? Promise.resolve(rerankChunks(queryToUse, matchedRules as RuleChunk[]))
        : Promise.resolve((matchedRules ?? []) as RuleChunk[]),
    ]);

    const hasRuleMatches    = rerankedRules.length > 0;
    const hasLearnedMatches = learnedMatches.length > 0;
    const ruleIds: string[] = rerankedRules
      .map(r => r.rule_id)
      .filter((id): id is string => Boolean(id));

    // Step 6: 3D model lookup (by rule tag, then by keyword category)
    let topModel: ModelRecord | null = null;

    if (hasRuleMatches && ruleIds.length > 0) {
      const { data: tagRows, error: tagError } = await supabase
        .from('model_rule_tags')
        .select('rule_id, relevance_score, fb_models(*)')
        .in('rule_id', ruleIds)
        .order('relevance_score', { ascending: false })
        .limit(1);

      if (tagError) logger.error('model_rule_tags query error', tagError, { requestId });
      if (tagRows && tagRows.length > 0) {
        topModel = ((tagRows[0] as Record<string, unknown>).fb_models as ModelRecord) ?? null;
      }
    }

    if (!topModel) {
      const categories = extractKeywordsFromQuery(queryToUse);
      if (categories.length > 0) {
        const { data: modelsByKeyword } = await supabase
          .from('fb_models')
          .select('*')
          .in('category', categories)
          .limit(1);
        if (modelsByKeyword && modelsByKeyword.length > 0) {
          topModel = modelsByKeyword[0] as ModelRecord;
        }
      }
    }

    const highlightMaterial = determineHighlightMaterial(queryToUse, ruleIds);

    // Step 7: No results path
    if (!hasRuleMatches && !hasLearnedMatches) {
      await saveLog({
        request_id: requestId, query: trimmed,
        result: 'no_match', domain: sanitizedDomain, intent,
        created_at: new Date().toISOString(),
      });
      const fallback: Record<string, unknown> = {
        answer: `I couldn't find a specific regulation matching your question in the ${sanitizedDomain} rulebook. Please try rephrasing, or check if this rule applies to a different domain.`,
        citations: [],
        intent,
      };
      if (topModel?.file_url) {
        fallback.model_url = topModel.file_url;
        fallback.model_metadata = buildModelMetadata(topModel, highlightMaterial, false);
      }
      res.json(fallback);
      return;
    }

    // Step 8: Build context and generate final answer
    const ruleContext = [
      ...rerankedRules.map(r =>
        `[Rule ${r.rule_id}${r.rerank_score !== undefined ? ` | Relevance: ${r.rerank_score.toFixed(2)}` : ''}]\n${r.content}`
      ),
      ...(hasLearnedMatches
        ? ['\n--- PREVIOUSLY VERIFIED ANSWERS (high confidence) ---',
           ...learnedMatches.map(l => `Q: ${l.question}\nA: ${l.answer}`)]
        : []),
    ].join('\n\n---\n\n');

    const systemPrompt = buildSystemPrompt(intent, ruleContext, queryToUse);
    const answer = await generate(systemPrompt, false, 0.35);

    // Step 9: Assemble response
    const responsePayload: Record<string, unknown> = {
      answer,
      intent,
      citations: rerankedRules.map(r => ({
        rule_id: r.rule_id,
        content: r.content,
        similarity: r.similarity,
        rerank_score: r.rerank_score ?? null,
      })),
    };

    if (hasLearnedMatches) {
      responsePayload.learned_citations = learnedMatches.map(l => ({
        question: l.question,
        answer: l.answer,
        source: l.source,
      }));
    }

    if (topModel?.file_url) {
      responsePayload.model_url = topModel.file_url;
      responsePayload.model_metadata = buildModelMetadata(topModel, highlightMaterial);
    }

    writeCache(expandedEmbedding, sanitizedDomain, responsePayload);

    await saveLog({
      request_id: requestId,
      query: trimmed,
      corrected_query: queryToUse !== trimmed ? queryToUse : null,
      result: 'success',
      domain: sanitizedDomain,
      intent,
      model_found: !!topModel,
      model_name: topModel?.name ?? null,
      citations_count: rerankedRules.length,
      learned_citations_count: learnedMatches.length,
      cache_written: true,
      created_at: new Date().toISOString(),
    });

    res.json(responsePayload);

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const isQuotaExhausted = msg.toLowerCase().includes('quota-exhausted');

    logger.error('Error in /ask_indra', error, { requestId });

    if (isQuotaExhausted) {
      res.status(503).json({
        error: 'All AI capacity is temporarily at quota limit. Please try again in a minute.',
        code: 'QUOTA_EXHAUSTED',
      });
    } else {
      res.status(500).json({ error: 'Indra encountered an error. Please try again.' });
    }
  }
});

// ── Feedback & learning ──────────────────────────────────────────────────────
app.post('/feedback', generalLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { question, answer, domain, rating } = req.body as {
    question: unknown; answer: unknown; domain: unknown; rating: unknown;
  };

  if (
    !question || typeof question !== 'string' || question.trim().length < 2 ||
    !answer   || typeof answer   !== 'string' || answer.trim().length < 2 ||
    !domain   || typeof domain   !== 'string' ||
    !['good', 'bad'].includes(rating as string)
  ) {
    res.status(400).json({ error: "Required fields: question (string), answer (string), domain (string), rating ('good'|'bad')" });
    return;
  }

  try {
    if (rating === 'good') {
      await saveLearnedPair(question, answer, domain, 'user_feedback');
      logger.info('Learned pair saved from feedback', { question: question.slice(0, 60) });
    }
    await saveLog({ type: 'feedback', question, domain, rating, created_at: new Date().toISOString() });
    res.json({
      message: rating === 'good'
        ? 'Answer learned — thanks for the signal!'
        : 'Feedback noted. We will improve.',
    });
  } catch (err) {
    logger.error('Feedback save error', err);
    res.status(500).json({ error: 'Failed to save feedback.' });
  }
});

// ── 3D Model gallery ─────────────────────────────────────────────────────────
app.get('/models', generalLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { category, limit = '20', offset = '0', search } = req.query;
  const parsedLimit  = Math.min(Math.max(Number(limit)  || 20, 1), 100);
  const parsedOffset = Math.max(Number(offset) || 0, 0);

  try {
    let query = supabase
      .from('fb_models')
      .select('id, name, category, thumbnail_url, description, file_size_mb', { count: 'exact' });

    if (category && category !== 'All') query = query.eq('category', category as string);
    if (search && typeof search === 'string' && search.trim().length > 0) {
      query = query.ilike('name', `%${search.trim()}%`);
    }

    const { data, count, error } = await query
      .order('name')
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    if (error) throw error;

    res.json({
      models: data,
      total: count,
      has_more: count ? count > parsedOffset + parsedLimit : false,
    });
  } catch (err) {
    logger.error('Error fetching models', err);
    res.status(500).json({ error: 'Failed to fetch model library.' });
  }
});

app.get('/models/:id', generalLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  // Allow UUIDs or integer IDs
  if (!/^[\w-]+$/.test(id)) {
    res.status(400).json({ error: 'Invalid model ID.' });
    return;
  }

  try {
    const { data, error } = await supabase
      .from('fb_models')
      .select('*, model_rule_tags(rule_id, relevance_score)')
      .eq('id', id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Model not found.' });
      return;
    }
    res.json(data);
  } catch (err) {
    logger.error('Error fetching model by ID', err, { id });
    res.status(500).json({ error: 'Failed to fetch model details.' });
  }
});

// ── Quiz generation (dynamic, not hardcoded) ─────────────────────────────────
app.get('/quiz', generalLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { domain = 'Formula Bharat 2027 Full', count = '3' } = req.query;
  const questionCount = Math.min(Math.max(Number(count) || 3, 1), 10);

  try {
    // Fetch some random rule chunks to base quiz questions on
    const { data: chunks } = await supabase
      .from('rulebook_chunks')
      .select('rule_id, content')
      .eq('domain', domain as string)
      .limit(questionCount * 3); // fetch more, let LLM pick the best ones

    if (!chunks || chunks.length === 0) {
      res.status(404).json({ error: 'No rulebook content found for this domain.' });
      return;
    }

    const context = chunks.map(c => `[${c.rule_id}] ${c.content}`).join('\n\n');
    const prompt = `You are a Formula Bharat technical examiner. Based on the regulation excerpts below, generate exactly ${questionCount} multiple-choice quiz questions. Each question must test specific technical knowledge from the rules.

Return ONLY a JSON array with this exact structure (no markdown, no explanation):
[
  {
    "question": "...",
    "options": ["A", "B", "C", "D"],
    "correctAnswer": 0,
    "explanation": "Rule X.Y.Z states: ...",
    "rule_id": "X.Y.Z"
  }
]

correctAnswer is the 0-based index of the correct option.

REGULATION EXCERPTS:
${context}`;

    const raw = await generate(prompt, true, 0.4);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const questions = JSON.parse(cleaned);

    if (!Array.isArray(questions)) throw new Error('Invalid quiz generation response');

    res.json({ questions, domain, generated: true });
  } catch (err) {
    logger.error('Quiz generation error', err);
    res.status(500).json({ error: 'Failed to generate quiz questions.' });
  }
});

// ============================================================================
// ── 11. ERROR HANDLING & STARTUP
// ============================================================================

app.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Route not found.' });
});

// Express 4 error handler — must have 4 params
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: Error, _req: Request, res: Response, _next: NextFunction): void => {
  logger.error('Unhandled error', error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`\n🏁  Indra Backend v10.1.0`);
  console.log(`🌐  http://localhost:${PORT}`);
  console.log(`🌍  Environment  : ${IS_PROD ? 'PRODUCTION' : 'development'}`);
  console.log(`🛡️   Security     : Helmet + Rate Limiting + Timing-Safe Auth`);
  console.log(`🔑  Primary key  : ${primaryRoster.length} models (${primaryRoster.map(s => s.modelName).join(' → ')})`);
  console.log(`🔑  Rerank key   : ${rerankRoster.length} models (dedicated, fallback to primary)`);
  console.log(`🧠  RAG Engine   : Query expansion → Vector search → LLM Rerank → Generation`);
  console.log(`⚡  Cache        : Semantic in-memory (TTL: ${CONFIG.CACHE_TTL_MS / 60000}min)\n`);
});