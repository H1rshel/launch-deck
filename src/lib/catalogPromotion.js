/**
 * @fileoverview
 * Server-side promotion logic for `global_game_executable_catalog`.
 *
 * IMPORTANT: This module must ONLY be called from trusted server-side code:
 *   - Supabase Edge Functions
 *   - Admin / cron scripts using a service-role client
 *   - Future backend services
 *
 * The client-side app MUST NEVER call promoteToGlobalCatalog directly.
 * RLS on the global_game_executable_catalog table prevents client writes anyway,
 * but this module is the canonical gate for all catalog mutations.
 *
 * Usage (Edge Function example):
 *   import { createClient } from '@supabase/supabase-js'
 *   import { promoteAggregatedFeedback } from './catalogPromotion.js'
 *
 *   const serviceClient = createClient(url, SERVICE_ROLE_KEY)
 *   await promoteAggregatedFeedback(serviceClient)
 *
 * @module catalogPromotion
 */

import { normalizeExeName, normalizeGameTitle } from './executableNorm'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum confirmations before we trust a "game" classification. */
const MIN_CONFIRMATIONS_FOR_GAME = 3

/** Minimum rejections before we trust a "not a game" classification. */
const MIN_REJECTIONS_FOR_NON_GAME = 3

/**
 * Confirmation ratio required to flip classification to 'game'.
 * (confirmations / total_votes >= this value)
 */
const GAME_CONFIDENCE_RATIO = 0.7

/**
 * Maximum catalog confidence — we never set confidence to 1.0 to avoid overfit.
 */
const MAX_CATALOG_CONFIDENCE = 0.95

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AggregatedExeStats
 * @property {string}  normalizedExeName
 * @property {string}  canonicalExeName         - Most common raw name observed
 * @property {string|null} suggestedGameTitle   - Most common confirmed title
 * @property {number}  confirmationsCount
 * @property {number}  rejectionsCount
 * @property {number}  duplicateReportsCount
 * @property {string|null} lastConfirmedAt
 * @property {string|null} lastRejectedAt
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Derive a classification and confidence from aggregated vote counts.
 *
 * @param {number} confirmations
 * @param {number} rejections
 * @param {number} duplicates
 * @returns {{ classification: import('./executableTypes.js').ExeClassification, confidence: number }}
 */
function deriveClassification(confirmations, rejections, duplicates) {
  const totalVotes = confirmations + rejections + duplicates
  if (totalVotes === 0) {
    return { classification: 'unknown', confidence: 0 }
  }

  // Duplicate-dominant: likely a launcher/tool that different users see as redundant
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
    // Use feedback reasons to infer sub-classification (handled in caller)
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Aggregate user observations from `user_executable_feedback` and
 * `user_game_executables`, then upsert the derived knowledge into
 * `global_game_executable_catalog`.
 *
 * Strategy:
 *  1. Aggregate feedback rows grouped by normalized_exe_name
 *  2. Compute classification + confidence conservatively
 *  3. Upsert into global catalog — increment existing counts, don't reset them
 *
 * This is safe to run repeatedly (idempotent given stable input).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} serviceClient
 *   Must be initialized with the service-role key.
 * @param {{ dryRun?: boolean, minObservations?: number }} [opts]
 * @returns {Promise<{ promoted: number, skipped: number, errors: number }>}
 */
export async function promoteAggregatedFeedback(serviceClient, opts = {}) {
  const { dryRun = false, minObservations = 2 } = opts
  let promoted = 0
  let skipped  = 0
  let errors   = 0

  try {
    // ── 1. Fetch recent feedback aggregated by normalized_exe_name ────────
    const { data: feedbackRows, error: fetchError } = await serviceClient
      .from('user_executable_feedback')
      .select('normalized_exe_name, exe_name, reason, details, created_at')
      .order('created_at', { ascending: false })
      .limit(5000)

    if (fetchError) {
      console.error('[catalogPromotion] Failed to fetch feedback:', fetchError)
      return { promoted: 0, skipped: 0, errors: 1 }
    }

    // ── 2. Aggregate by normalized_exe_name ───────────────────────────────
    /** @type {Map<string, AggregatedExeStats>} */
    const statsMap = new Map()

    for (const row of feedbackRows ?? []) {
      const key = row.normalized_exe_name
      if (!key) continue

      let stats = statsMap.get(key)
      if (!stats) {
        stats = {
          normalizedExeName:    key,
          canonicalExeName:     row.exe_name || '',
          suggestedGameTitle:   null,
          confirmationsCount:   0,
          rejectionsCount:      0,
          duplicateReportsCount:0,
          lastConfirmedAt:      null,
          lastRejectedAt:       null,
        }
        statsMap.set(key, stats)
      }

      if (row.reason === 'duplicate') {
        stats.duplicateReportsCount++
      } else if (
        row.reason === 'not_a_game' ||
        row.reason === 'launcher_only' ||
        row.reason === 'installer' ||
        row.reason === 'mod_tool' ||
        row.reason === 'old_version' ||
        row.reason === 'wrong_match'
      ) {
        stats.rejectionsCount++
        if (!stats.lastRejectedAt || row.created_at > stats.lastRejectedAt) {
          stats.lastRejectedAt = row.created_at
        }
      }
    }

    // ── 3. Fetch confirmed games to count confirmations ───────────────────
    const { data: confirmedRows, error: confirmedError } = await serviceClient
      .from('user_game_executables')
      .select('normalized_exe_name, exe_name, game_title, last_seen_at')
      .eq('status', 'confirmed_game')
      .order('last_seen_at', { ascending: false })
      .limit(10000)

    if (confirmedError) {
      console.warn('[catalogPromotion] Could not fetch confirmed executables:', confirmedError)
    }

    for (const row of confirmedRows ?? []) {
      const key = row.normalized_exe_name
      if (!key) continue

      let stats = statsMap.get(key)
      if (!stats) {
        stats = {
          normalizedExeName:    key,
          canonicalExeName:     row.exe_name || '',
          suggestedGameTitle:   row.game_title || null,
          confirmationsCount:   0,
          rejectionsCount:      0,
          duplicateReportsCount:0,
          lastConfirmedAt:      null,
          lastRejectedAt:       null,
        }
        statsMap.set(key, stats)
      }

      stats.confirmationsCount++
      if (!stats.lastConfirmedAt || row.last_seen_at > stats.lastConfirmedAt) {
        stats.lastConfirmedAt = row.last_seen_at
      }
      // Most common game title from confirmed rows
      if (row.game_title && !stats.suggestedGameTitle) {
        stats.suggestedGameTitle = row.game_title
      }
    }

    // ── 4. For each aggregated entry, compute + upsert ────────────────────
    const now = new Date().toISOString()

    for (const [normalizedName, stats] of statsMap) {
      const totalObservations =
        stats.confirmationsCount + stats.rejectionsCount + stats.duplicateReportsCount

      if (totalObservations < minObservations) {
        skipped++
        continue
      }

      const { classification, confidence } = deriveClassification(
        stats.confirmationsCount,
        stats.rejectionsCount,
        stats.duplicateReportsCount,
      )

      const catalogRow = {
        normalized_exe_name:    normalizedName,
        canonical_exe_name:     stats.canonicalExeName || normalizedName + '.exe',
        suggested_game_title:   stats.suggestedGameTitle || null,
        normalized_game_title:  stats.suggestedGameTitle ? normalizeGameTitle(stats.suggestedGameTitle) : null,
        classification,
        confidence,
        confirmations_count:    stats.confirmationsCount,
        rejections_count:       stats.rejectionsCount,
        duplicate_reports_count:stats.duplicateReportsCount,
        last_confirmed_at:      stats.lastConfirmedAt,
        last_rejected_at:       stats.lastRejectedAt,
        updated_at:             now,
      }

      if (dryRun) {
        console.log('[catalogPromotion][dry-run]', catalogRow)
        promoted++
        continue
      }

      try {
        const { error: upsertError } = await serviceClient
          .from('global_game_executable_catalog')
          .upsert(catalogRow, {
            onConflict:      'normalized_exe_name',
            ignoreDuplicates: false,
          })

        if (upsertError) {
          console.error('[catalogPromotion] Upsert failed for', normalizedName, upsertError)
          errors++
        } else {
          promoted++
        }
      } catch (err) {
        console.error('[catalogPromotion] Exception for', normalizedName, err)
        errors++
      }
    }
  } catch (outerErr) {
    console.error('[catalogPromotion] Outer error:', outerErr)
    errors++
  }

  return { promoted, skipped, errors }
}

/**
 * Promote a single confirmed EXE directly into the global catalog.
 * Used for manual curation or admin review tools.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} serviceClient
 * @param {{
 *   normalizedExeName:  string,
 *   canonicalExeName:   string,
 *   suggestedGameTitle: string|null,
 *   classification:     import('./executableTypes.js').ExeClassification,
 *   confidence:         number,
 *   notes?:             string,
 * }} entry
 * @returns {Promise<boolean>}  true on success
 */
export async function promoteSingleEntry(serviceClient, entry) {
  const now = new Date().toISOString()
  const { error } = await serviceClient
    .from('global_game_executable_catalog')
    .upsert(
      {
        normalized_exe_name:   entry.normalizedExeName,
        canonical_exe_name:    entry.canonicalExeName,
        suggested_game_title:  entry.suggestedGameTitle,
        normalized_game_title: entry.suggestedGameTitle ? normalizeGameTitle(entry.suggestedGameTitle) : null,
        classification:        entry.classification,
        confidence:            Math.min(MAX_CATALOG_CONFIDENCE, entry.confidence),
        notes:                 entry.notes ?? null,
        updated_at:            now,
      },
      { onConflict: 'normalized_exe_name', ignoreDuplicates: false },
    )

  if (error) {
    console.error('[catalogPromotion] promoteSingleEntry error:', error)
    return false
  }
  return true
}
