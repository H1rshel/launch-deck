/**
 * promote-catalog — Supabase Edge Function
 *
 * Aggregates anonymised EXE observations from:
 *   - `user_executable_feedback`  (explicit rejections / labels by users)
 *   - `user_game_executables`     (auto-scan confirmations)
 *
 * …and upserts derived knowledge into `global_game_executable_catalog`.
 *
 * Trigger: POST request.  Protect with a secret header in production
 *          (PROMOTE_CATALOG_SECRET env var checked below).
 *
 * Required secrets (set via `supabase secrets set`):
 *   SUPABASE_URL                — auto-available in edge runtime
 *   SUPABASE_SERVICE_ROLE_KEY   — auto-available in edge runtime
 *   PROMOTE_CATALOG_SECRET      — arbitrary shared secret for auth header
 *
 * Call example:
 *   curl -X POST \
 *     -H "Authorization: Bearer <PROMOTE_CATALOG_SECRET>" \
 *     https://<project-ref>.functions.supabase.co/promote-catalog
 *
 * Dry-run mode (logs without writing):
 *   curl -X POST ... \
 *     -H "Content-Type: application/json" \
 *     -d '{"dry_run": true}'
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CATALOG_SECRET   = Deno.env.get('PROMOTE_CATALOG_SECRET') ?? ''

/** Minimum total observations before a row graduates to the global catalog */
const MIN_OBSERVATIONS = 2

// ── Inline normalization (mirrors src/lib/executableNorm.js) ──────────────────

const EXE_SUFFIX_PATTERN =
  /_win64|_win32|_x64|_x86|_dx12|_dx11|_vulkan|_gl|_shipping|_final|_release|_debug|_development|_retail|_build|_gold|_eac_eac|_be_be|_anticheatsandbox/gi

function normalizeExeName(exeName: string): string {
  if (!exeName) return ''
  let n = exeName.trim().toLowerCase()
  n = n.replace(/\.exe$/i, '')
  n = n.replace(EXE_SUFFIX_PATTERN, '')
  n = n.replace(/[_\-\.\s]+/g, '')
  return n
}

function normalizeGameTitle(title: string): string {
  if (!title) return ''
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

// ── Classification logic (mirrors src/lib/catalogPromotion.js) ────────────────

const MIN_CONFIRMATIONS_FOR_GAME  = 3
const MIN_REJECTIONS_FOR_NON_GAME = 3
const GAME_CONFIDENCE_RATIO       = 0.7
const MAX_CATALOG_CONFIDENCE      = 0.95

type Classification = 'game' | 'launcher' | 'tool' | 'drm' | 'redistributable' | 'unknown'

function deriveClassification(
  confirmations: number,
  rejections: number,
  duplicates: number,
): { classification: Classification; confidence: number } {
  const totalVotes = confirmations + rejections + duplicates
  if (totalVotes === 0) return { classification: 'unknown', confidence: 0 }

  if (duplicates > 0 && duplicates >= confirmations) {
    return {
      classification: 'launcher',
      confidence: Math.min(MAX_CATALOG_CONFIDENCE, 0.4 + duplicates * 0.05),
    }
  }

  const confirmRatio = confirmations / totalVotes
  if (confirmRatio >= GAME_CONFIDENCE_RATIO && confirmations >= MIN_CONFIRMATIONS_FOR_GAME) {
    const confidence = Math.min(
      MAX_CATALOG_CONFIDENCE,
      0.6 + (confirmations / (totalVotes + 5)) * 0.35,
    )
    return { classification: 'game', confidence }
  }

  const rejectRatio = rejections / totalVotes
  if (rejectRatio >= GAME_CONFIDENCE_RATIO && rejections >= MIN_REJECTIONS_FOR_NON_GAME) {
    return {
      classification: 'tool',
      confidence: Math.min(MAX_CATALOG_CONFIDENCE, 0.5 + rejectRatio * 0.3),
    }
  }

  return {
    classification: 'unknown',
    confidence: Math.max(0, confirmRatio - 0.1),
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // Simple bearer-token guard — optional but recommended in production
  if (CATALOG_SECRET) {
    const auth = req.headers.get('Authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token !== CATALOG_SECRET) {
      return json({ error: 'Unauthorized' }, 401)
    }
  }

  let dryRun = false
  try {
    const body = await req.json().catch(() => ({}))
    dryRun = !!body.dry_run
  } catch { /* ignore parse errors */ }

  console.log(`[promote-catalog] Starting${dryRun ? ' (DRY RUN)' : ''}…`)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  // ── 1. Fetch feedback rows ─────────────────────────────────────────────────
  const { data: feedbackRows, error: fbErr } = await supabase
    .from('user_executable_feedback')
    .select('normalized_exe_name, exe_name, reason, created_at')
    .order('created_at', { ascending: false })
    .limit(10000)

  if (fbErr) {
    console.error('[promote-catalog] Feedback fetch error:', fbErr)
    return json({ error: fbErr.message }, 500)
  }

  // ── 2. Fetch confirmed executables ────────────────────────────────────────
  const { data: confirmedRows, error: confErr } = await supabase
    .from('user_game_executables')
    .select('normalized_exe_name, exe_name, game_title, last_seen_at')
    .eq('status', 'confirmed_game')
    .order('last_seen_at', { ascending: false })
    .limit(20000)

  if (confErr) {
    console.warn('[promote-catalog] Confirmed rows fetch error (non-fatal):', confErr)
  }

  // ── 3. Aggregate stats by normalized_exe_name ─────────────────────────────
  interface ExeStats {
    canonicalExeName:     string
    suggestedGameTitle:   string | null
    confirmations:        number
    rejections:           number
    duplicates:           number
    lastConfirmedAt:      string | null
    lastRejectedAt:       string | null
  }
  const statsMap = new Map<string, ExeStats>()

  const ensureStats = (key: string, exeName: string): ExeStats => {
    if (!statsMap.has(key)) {
      statsMap.set(key, {
        canonicalExeName:   exeName || key,
        suggestedGameTitle: null,
        confirmations:      0,
        rejections:         0,
        duplicates:         0,
        lastConfirmedAt:    null,
        lastRejectedAt:     null,
      })
    }
    return statsMap.get(key)!
  }

  const REJECTION_REASONS = new Set([
    'not_a_game', 'launcher_only', 'installer',
    'mod_tool', 'old_version', 'wrong_match',
  ])

  for (const row of feedbackRows ?? []) {
    const key = row.normalized_exe_name
    if (!key) continue
    const s = ensureStats(key, row.exe_name ?? '')
    if (row.reason === 'duplicate') {
      s.duplicates++
    } else if (REJECTION_REASONS.has(row.reason)) {
      s.rejections++
      if (!s.lastRejectedAt || row.created_at > s.lastRejectedAt) {
        s.lastRejectedAt = row.created_at
      }
    }
  }

  for (const row of confirmedRows ?? []) {
    const key = row.normalized_exe_name
    if (!key) continue
    const s = ensureStats(key, row.exe_name ?? '')
    s.confirmations++
    if (!s.lastConfirmedAt || row.last_seen_at > s.lastConfirmedAt) {
      s.lastConfirmedAt = row.last_seen_at
    }
    if (row.game_title && !s.suggestedGameTitle) {
      s.suggestedGameTitle = row.game_title
    }
  }

  // ── 4. Upsert into global catalog ─────────────────────────────────────────
  const now = new Date().toISOString()
  let promoted = 0
  let skipped  = 0
  let errors   = 0

  for (const [normalizedName, s] of statsMap) {
    const total = s.confirmations + s.rejections + s.duplicates
    if (total < MIN_OBSERVATIONS) { skipped++; continue }

    const { classification, confidence } = deriveClassification(
      s.confirmations, s.rejections, s.duplicates,
    )

    const row = {
      normalized_exe_name:    normalizedName,
      suggested_game_title:   s.suggestedGameTitle ?? null,
      normalized_game_title:  s.suggestedGameTitle ? normalizeGameTitle(s.suggestedGameTitle) : null,
      classification,
      confidence,
      seen_count:             total,
      confirmed_count:        s.confirmations,
      rejected_count:         s.rejections,
      last_updated_at:        now,
    }

    if (dryRun) {
      console.log('[promote-catalog][dry-run]', row)
      promoted++
      continue
    }

    try {
      const { error: upsertErr } = await supabase
        .from('global_game_executable_catalog')
        .upsert(row, { onConflict: 'normalized_exe_name', ignoreDuplicates: false })

      if (upsertErr) {
        console.error('[promote-catalog] Upsert error for', normalizedName, upsertErr)
        errors++
      } else {
        promoted++
      }
    } catch (err) {
      console.error('[promote-catalog] Exception for', normalizedName, err)
      errors++
    }
  }

  console.log(`[promote-catalog] Done — promoted: ${promoted}, skipped: ${skipped}, errors: ${errors}`)
  return json({ promoted, skipped, errors, dry_run: dryRun })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
