/**
 * @fileoverview
 * Shared JSDoc type definitions for the EXE learning system.
 *
 * Three Supabase tables:
 *  - user_game_executables      (per-user, RLS protected, client writable)
 *  - user_executable_feedback   (per-user, RLS protected, client writable)
 *  - global_game_executable_catalog (shared, read-only from client)
 *
 * Server-side promotion writes to the catalog via service-role Supabase client.
 */

// ─── Enum-like string literals ───────────────────────────────────────────────

/**
 * How the EXE entry was originally discovered.
 * @typedef {'auto_scan' | 'folder_scan' | 'single_scan' | 'manual_add' | 'cloud_sync'} ExeSource
 */

/**
 * Lifecycle state of an EXE in the user's history.
 * @typedef {'candidate' | 'confirmed_game' | 'rejected' | 'suppressed' | 'duplicate'} ExeStatus
 */

/**
 * What the EXE most likely is, as determined by catalog / heuristics.
 * @typedef {'game' | 'launcher' | 'tool' | 'installer' | 'unknown'} ExeClassification
 */

/**
 * Reason codes for user feedback when removing or rejecting an EXE.
 * @typedef {'not_a_game' | 'duplicate' | 'launcher_only' | 'installer' | 'mod_tool' | 'wrong_match' | 'old_version' | 'other'} FeedbackReason
 */

// ─── Table row shapes ─────────────────────────────────────────────────────────

/**
 * Row in `user_game_executables`.
 * One row per EXE per user. Upserted on every scan; never duplicated by path.
 *
 * @typedef {Object} UserGameExecutable
 * @property {string}                       id
 * @property {string}                       user_id
 * @property {string}                       exe_name            - Filename, e.g. "eldenring.exe"
 * @property {string}                       normalized_exe_name - Stripped, lowercase slug
 * @property {string}                       exe_path            - Full path, forward-slash normalized
 * @property {string}                       folder_path         - Parent directory
 * @property {string|null}                  file_hash           - SHA-256 if available
 * @property {number|null}                  file_size_bytes
 * @property {ExeSource}                    source
 * @property {ExeStatus}                    status
 * @property {string|null}                  game_title          - Human-readable title if known
 * @property {string|null}                  normalized_game_title
 * @property {string|null}                  launcher            - e.g. "steam", "epic", "gog"
 * @property {string|null}                  platform            - e.g. "Steam", "PC"
 * @property {number}                       confidence          - [0, 1]
 * @property {number}                       times_seen          - Incremented on each scan
 * @property {string}                       first_seen_at       - ISO timestamp
 * @property {string}                       last_seen_at        - ISO timestamp
 * @property {Record<string, unknown>|null} metadata            - Arbitrary JSON blob
 * @property {string}                       created_at
 * @property {string}                       updated_at
 */

/**
 * Row in `user_executable_feedback`.
 * Immutable audit record of every user rejection / deletion event.
 *
 * @typedef {Object} UserExecutableFeedback
 * @property {string}           id
 * @property {string}           user_id
 * @property {string}           user_game_executable_id - FK to user_game_executables.id (if known)
 * @property {string}           exe_name
 * @property {string}           normalized_exe_name
 * @property {string}           exe_path
 * @property {FeedbackReason}   reason
 * @property {string|null}      details                 - Free-text for "Other"
 * @property {string}           created_at
 */

/**
 * Row in `global_game_executable_catalog`.
 * Shared knowledge base — read-only from the client.
 * Only the trusted server-side promotion path may write here.
 *
 * @typedef {Object} GlobalGameExecutableCatalog
 * @property {string}             id
 * @property {string}             normalized_exe_name
 * @property {string}             canonical_exe_name       - Preferred display name, e.g. "eldenring.exe"
 * @property {string|null}        suggested_game_title
 * @property {string|null}        normalized_game_title
 * @property {ExeClassification}  classification
 * @property {number}             confidence               - [0, 1] aggregate confidence
 * @property {number}             confirmations_count
 * @property {number}             rejections_count
 * @property {number}             duplicate_reports_count
 * @property {string|null}        last_confirmed_at
 * @property {string|null}        last_rejected_at
 * @property {string|null}        notes
 * @property {string}             created_at
 * @property {string}             updated_at
 */

// ─── DTO shapes used across scan flows ───────────────────────────────────────

/**
 * A candidate EXE returned from a scan, enriched with optional catalog data.
 *
 * @typedef {Object} ScanCandidate
 * @property {string}                       title
 * @property {string}                       install_path
 * @property {string}                       raw_file_name
 * @property {string}                       raw_folder_name
 * @property {string}                       platform
 * @property {number}                       confidence
 * @property {string}                       source
 * @property {Record<string, unknown>|null} metadata
 * @property {Record<string, unknown>|null} gameData
 * @property {ExeClassification|null}       catalogClassification  - null if not found in catalog
 * @property {string|null}                  catalogGameTitle       - suggested title from catalog
 * @property {number|null}                  catalogConfidence      - catalog's own confidence value
 */

/**
 * Input for computing executable confidence.
 *
 * @typedef {Object} ConfidenceInput
 * @property {number}             rustConfidence       - [0, 1] from Rust backend
 * @property {ExeClassification|null} catalogClassification
 * @property {number|null}        catalogConfidence    - [0, 1] from global catalog
 * @property {boolean}            userConfirmedBefore
 * @property {boolean}            userRejectedBefore
 * @property {number}             timesSeen
 */

/**
 * Payload for submitting user feedback.
 *
 * @typedef {Object} FeedbackPayload
 * @property {string}           exe_name
 * @property {string}           normalized_exe_name
 * @property {string}           exe_path
 * @property {FeedbackReason}   reason
 * @property {string|null}      details
 * @property {string|null}      user_game_executable_id
 */

/**
 * Input for upserting a row into user_game_executables.
 *
 * @typedef {Object} UpsertExecutableInput
 * @property {string}                       exe_name
 * @property {string}                       normalized_exe_name
 * @property {string}                       exe_path
 * @property {string}                       folder_path
 * @property {string|null}                  [file_hash]
 * @property {number|null}                  [file_size_bytes]
 * @property {ExeSource}                    source
 * @property {ExeStatus}                    status
 * @property {string|null}                  [game_title]
 * @property {string|null}                  [normalized_game_title]
 * @property {string|null}                  [launcher]
 * @property {string|null}                  [platform]
 * @property {number}                       confidence
 * @property {Record<string, unknown>|null} [metadata]
 */

// Re-export as a namespace object for convenience in plain JS files
// (No runtime value — this file is types-only)
export {}
