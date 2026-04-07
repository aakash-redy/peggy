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
  MODEL_COOLDOWN_MS: 60 * 1000,
} as const;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

// ============================================================================
// ── 2. MODEL ROSTER & PER-MODEL CIRCUIT BREAKER
// ============================================================================

interface ModelSlot {
  label: string;
  modelName: string;
  client: GoogleGenerativeAI;
  coolUntil: number;
  quotaHits: number;
  successCount: number;
}

function buildModelRoster(apiKey: string, keyLabel: string): ModelSlot[] {
  const client = new GoogleGenerativeAI(apiKey);
  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
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

const primaryRoster: ModelSlot[] = buildModelRoster(process.env.GEMINI_API_KEY!, 'PRIMARY');
const rerankRoster: ModelSlot[]  = buildModelRoster(process.env.GEMINI_RERANK_API_KEY!, 'RERANK');

function activeSlots(roster: ModelSlot[]): ModelSlot[] {
  const now = Date.now();
  const active = roster.filter(s => s.coolUntil <= now);
  return active.length > 0 ? active : roster;
}

function coolSlot(slot: ModelSlot): void {
  slot.quotaHits++;
  slot.coolUntil = Date.now() + CONFIG.MODEL_COOLDOWN_MS;
  logger.warn(`[ROSTER] ${slot.label} quota hit #${slot.quotaHits}. Cooling ${CONFIG.MODEL_COOLDOWN_MS / 1000}s.`);
}

function isSkippableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    msg.includes('429')                                  ||
    lower.includes('quota')                              ||
    lower.includes('resource_exhausted')                 ||
    lower.includes('rate_limit')                         ||
    msg.includes('404')                                  ||
    lower.includes('not found')                          ||
    lower.includes('is not supported')                   ||
    lower.includes('not supported for generatecontent')
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

interface CadNodeMatch {
  rule_id: string;
  cad_node_name: string;
  relevance_score?: number;
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
        coolSlot(slot);
        continue;
      }
      throw error;
    }
  }
  throw new Error('QUOTA_EXHAUSTED: All models on this roster are at quota limit. Try again shortly.');
}

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

// ============================================================================
// ── 7. EMBEDDINGS
// ============================================================================

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

async function expandAndAverageEmbedding(query: string): Promise<number[]> {
  return embedQuery(query);
}

function rerankChunks(_query: string, chunks: RuleChunk[]): RuleChunk[] {
  return [...chunks]
    .sort((a, b) => b.similarity - a.similarity)
    .map(c => ({ ...c, rerank_score: c.similarity }));
}

function classifyIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  if (/\b(how (wide|tall|long|thick|deep)|dimension|size|length|width|height|weight|distance|radius|diameter|mm|cm|kg|newton|force|thickness|volume|area)\b/.test(q)) return 'dimension';
  if (/\b(legal|illegal|allowed|permitted|prohibited|pass|fail|comply|compliant|violation|violate|can i|is it ok|is .+ allowed)\b/.test(q)) return 'compliance';
  if (/\b(what is|define|definition|what does .+ mean|explain|describe)\b/.test(q)) return 'definition';
  if (/\b(how to|steps|procedure|process|install|mount|attach|assemble|test|inspect|check)\b/.test(q)) return 'procedure';
  return 'general';
}

function buildSystemPrompt(intent: QueryIntent, ruleContext: string, query: string, domain: string): string {
  const base = `You are an expert AI Technical Regulations Assistant. Answer based ONLY on the provided regulation context. Always cite exact Rule IDs inline, e.g. [T3.14]. Do not speculate beyond the provided context.`;

  const intentInstructions: Record<QueryIntent, string> = {
    dimension: `${base}\nThe user asks about a MEASUREMENT. Your response MUST:\n1. State the exact value with units first.\n2. List all related dimensional constraints as bullet points.\n3. Note any conditional rules or exceptions.`,
    compliance: `${base}\nThe user asks a COMPLIANCE question. Your response MUST:\n1. Start with a clear verdict: ✅ COMPLIANT / ❌ NON-COMPLIANT / ⚠️ CONDITIONAL.\n2. Cite the determining rule(s).\n3. List any specific conditions or exceptions.`,
    definition: `${base}\nThe user wants a DEFINITION. Your response MUST:\n1. Give a concise 1–2 sentence definition.\n2. Explain its purpose or function.\n3. Cite the defining rule.`,
    procedure: `${base}\nThe user asks about a PROCEDURE. Your response MUST:\n1. List steps in numbered order.\n2. Highlight mandatory inspection or verification points.\n3. Cite the relevant rule for each key step.`,
    general: `${base}\nProvide a clear, structured answer. Use bullet points for multiple points. Cite rule IDs inline.`,
  };

  return `${intentInstructions[intent]}\n\nDOMAIN: ${domain}\n\nREGULATION CONTEXT:\n${ruleContext}\n\nQUESTION: ${query}`;
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

function buildModelMetadata(
  model: ModelRecord,
  cadNodes: CadNodeMatch[],
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
    cad_nodes: cadNodes.map(n => ({
      rule_id: n.rule_id,
      cad_node_name: n.cad_node_name,
      relevance_score: n.relevance_score ?? null,
    })),
  };
}

async function fetchCadNodesForRules(
  ruleIds: string[],
  requestId: string,
): Promise<CadNodeMatch[]> {
  if (ruleIds.length === 0) return [];

  try {
    const { data, error } = await supabase.rpc('match_cad_nodes_by_prefix', {
      rule_ids: ruleIds,
    });

    if (error) {
      logger.error('match_cad_nodes_by_prefix RPC error', error, { requestId });
      return [];
    }

    return (data ?? []) as CadNodeMatch[];
  } catch (err) {
    logger.error('fetchCadNodesForRules threw', err, { requestId });
    return [];
  }
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

  const validToken = process.env.API_AUTH_TOKEN!;
  const tokenBuf  = Buffer.from(token);
  const validBuf  = Buffer.from(validToken);
  if (tokenBuf.length === validBuf.length && crypto.timingSafeEqual(tokenBuf, validBuf)) {
    (req as AuthenticatedRequest).requestId = crypto.randomUUID();
    (req as AuthenticatedRequest).user = { role: 'admin' };
    return next();
  }

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
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ============================================================================
// ── 10. ROUTES
// ============================================================================

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
    service: 'RAG Backend',
    version: '11.1.0',
    uptime_seconds: Math.floor(process.uptime()),
    cache_size: semanticCache.size,
    primary_roster: rosterStatus(primaryRoster),
    rerank_roster: rosterStatus(rerankRoster),
  });
});

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
    : 'General';

  try {
    const intent = classifyIntent(trimmed);
    const expandedEmbedding = await expandAndAverageEmbedding(trimmed);
    logger.info('Query processed', { requestId, intent, domain: sanitizedDomain });

    const cacheHit = findCacheHit(expandedEmbedding, sanitizedDomain);
    if (cacheHit) {
      logger.info('Cache hit', { requestId });
      res.json({ ...cacheHit, _cache: 'hit' });
      return;
    }

    const embedding = expandedEmbedding;
    const queryToUse = trimmed;

    const { data: matchedRules, error: rpcError } = await supabase.rpc('match_rulebook_chunks', {
      query_embedding: embedding,
      match_threshold: CONFIG.MATCH_THRESHOLD,
      match_count: CONFIG.MATCH_COUNT,
      filter_domain: sanitizedDomain,
    });

    if (rpcError) logger.error('match_rulebook_chunks RPC error', rpcError, { requestId });

    // Step: Learned pairs + reranking in parallel
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

    // ─────────────────────────────────────────────────────────────────────
    // 3D model + CAD node lookup.
    // ─────────────────────────────────────────────────────────────────────
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

    // Prefix-match CAD node names for the 3D viewer
    const cadNodes = await fetchCadNodesForRules(ruleIds, requestId);

    // ─────────────────────────────────────────────────────────────────────
    // 🌟 ENHANCED: Generic LLM Fallback (No Rules Found)
    // ─────────────────────────────────────────────────────────────────────
    if (!hasRuleMatches && !hasLearnedMatches) {
      logger.info('No specific rules found, engaging Generic Engineering Response.', { requestId });

      const genericPrompt = `You are an expert AI Technical Assistant. The user asked a question that is NOT explicitly covered in the "${sanitizedDomain}" regulations we have on file. 
      
      Provide a helpful, standard engineering or technical response to their query. 
      CRITICAL: You MUST explicitly state at the beginning or end of your response that this is "General Advice" and NOT an official rulebook citation.

      QUESTION: ${queryToUse}`;

      // slightly higher temp (0.6) for standard problem solving
      const genericAnswer = await generate(genericPrompt, false, 0.6); 

      await saveLog({
        request_id: requestId, query: trimmed,
        result: 'no_match_fallback', domain: sanitizedDomain, intent: 'general_engineering',
        created_at: new Date().toISOString(),
      });

      const fallbackPayload: Record<string, unknown> = {
        answer: genericAnswer,
        citations: [],
        intent: 'general_engineering',
      };

      if (topModel?.file_url) {
        fallbackPayload.model_url      = topModel.file_url;
        fallbackPayload.model_metadata = buildModelMetadata(topModel, cadNodes, false);
        fallbackPayload.cad_nodes      = cadNodes;
      }

      res.json(fallbackPayload);
      return;
    }

    // Build context and generate final answer (Strict Rule-Based)
    const ruleContext = [
      ...rerankedRules.map(r =>
        `[Rule ${r.rule_id}${r.rerank_score !== undefined ? ` | Relevance: ${r.rerank_score.toFixed(2)}` : ''}]\n${r.content}`
      ),
      ...(hasLearnedMatches
        ? ['\n--- PREVIOUSLY VERIFIED ANSWERS (high confidence) ---',
           ...learnedMatches.map(l => `Q: ${l.question}\nA: ${l.answer}`)]
        : []),
    ].join('\n\n---\n\n');

    const systemPrompt = buildSystemPrompt(intent, ruleContext, queryToUse, sanitizedDomain);
    const answer = await generate(systemPrompt, false, 0.35);

    // Assemble response
    const responsePayload: Record<string, unknown> = {
      answer,
      intent,
      citations: rerankedRules.map(r => ({
        rule_id:      r.rule_id,
        content:      r.content,
        similarity:   r.similarity,
        rerank_score: r.rerank_score ?? null,
      })),
    };

    if (hasLearnedMatches) {
      responsePayload.learned_citations = learnedMatches.map(l => ({
        question: l.question,
        answer:   l.answer,
        source:   l.source,
      }));
    }

    if (topModel?.file_url) {
      responsePayload.model_url      = topModel.file_url;
      responsePayload.model_metadata = buildModelMetadata(topModel, cadNodes);
    }

    responsePayload.cad_nodes = cadNodes;

    writeCache(expandedEmbedding, sanitizedDomain, responsePayload);

    await saveLog({
      request_id:              requestId,
      query:                   trimmed,
      corrected_query:         queryToUse !== trimmed ? queryToUse : null,
      result:                  'success',
      domain:                  sanitizedDomain,
      intent,
      model_found:             !!topModel,
      model_name:              topModel?.name ?? null,
      citations_count:         rerankedRules.length,
      learned_citations_count: learnedMatches.length,
      cad_nodes_count:         cadNodes.length,
      cache_written:           true,
      created_at:              new Date().toISOString(),
    });

    res.json(responsePayload);

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const isQuotaExhausted = msg.toLowerCase().includes('quota_exhausted');

    logger.error('Error in /ask_indra', error, { requestId });

    if (isQuotaExhausted) {
      res.status(503).json({
        error: 'All AI capacity is temporarily at quota limit. Please try again in a minute.',
        code:  'QUOTA_EXHAUSTED',
      });
    } else {
      res.status(500).json({ error: 'The server encountered an error. Please try again.' });
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
    !answer   || typeof answer   !== 'string' || answer.trim().length < 2   ||
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
        : 'Feedback noted. We will work to improve.',
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
    res.json({ models: data, total: count, has_more: count ? count > parsedOffset + parsedLimit : false });
  } catch (err) {
    logger.error('Error fetching models', err);
    res.status(500).json({ error: 'Failed to fetch model library.' });
  }
});

app.get('/models/:id', generalLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
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

// ── Quiz generation ──────────────────────────────────────────────────────────
app.get('/quiz', generalLimiter, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { domain = 'General', count = '3' } = req.query;
  const questionCount = Math.min(Math.max(Number(count) || 3, 1), 10);

  try {
    const { data: chunks } = await supabase
      .from('rulebook_chunks')
      .select('rule_id, content')
      .eq('domain', domain as string)
      .limit(questionCount * 3);

    if (!chunks || chunks.length === 0) {
      res.status(404).json({ error: 'No rulebook content found for this domain.' });
      return;
    }

    const context = chunks.map(c => `[${c.rule_id}] ${c.content}`).join('\n\n');
    const prompt = `You are a technical regulations examiner. Based on the regulation excerpts below, generate exactly ${questionCount} multiple-choice quiz questions. Each question must test specific technical knowledge from the rules.

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

    const raw      = await generate(prompt, true, 0.4);
    const cleaned  = raw.replace(/```json|```/g, '').trim();
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: Error, _req: Request, res: Response, _next: NextFunction): void => {
  logger.error('Unhandled error', error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`\n🚀  RAG Backend v11.1.0`);
  console.log(`🌐  http://localhost:${PORT}`);
  console.log(`🌍  Environment  : ${IS_PROD ? 'PRODUCTION' : 'development'}`);
  console.log(`🛡️   Security     : Helmet + Rate Limiting + Timing-Safe Auth`);
  console.log(`🔑  Primary key  : ${primaryRoster.length} models (${primaryRoster.map(s => s.modelName).join(' → ')})`);
  console.log(`🔑  Rerank key   : ${rerankRoster.length} models (dedicated, fallback to primary)`);
  console.log(`🧠  RAG Engine   : Vector search → Cosine Rerank → Prefix CAD Match → Generic Fallback`);
  console.log(`⚡  Cache        : Semantic in-memory (TTL: ${CONFIG.CACHE_TTL_MS / 60000}min)`);
  console.log(`🔩  CAD Nodes    : Prefix-match rule linking enabled\n`);
});