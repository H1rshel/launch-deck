import { supabase } from '../supabase'

// Durable command bus between the user's PCs, built on the device_commands
// table. The sender inserts a row targeted at a device and watches it for a
// status transition; the target subscribes to INSERTs (Realtime) with a poll
// fallback so a host that missed the notification still picks work up.

// Realtime delivers in ~1s; the polls are the safety net and must still be
// tight enough that pairing/stream-prep feels responsive without it.
const POLL_INTERVAL_MS = 1500
const LISTENER_POLL_MS = 5000
const COMMAND_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Send a command to another device and wait for its result.
 * Resolves with the `result` jsonb on status='done', rejects on 'error' or
 * timeout.
 */
export async function sendCommand(
  userId,
  fromDeviceId,
  targetDeviceId,
  type,
  payload = {},
  { timeoutMs = 45000 } = {},
) {
  const { data: row, error } = await supabase
    .from('device_commands')
    .insert({
      user_id: userId,
      target_device_id: targetDeviceId,
      from_device_id: fromDeviceId,
      type,
      payload,
    })
    .select('id')
    .single()

  if (error) throw new Error(`Could not reach the host: ${error.message}`)
  const commandId = row.id

  return new Promise((resolve, reject) => {
    let finished = false
    let pollTimer = null
    let timeoutTimer = null
    let channel = null

    const cleanup = () => {
      finished = true
      if (pollTimer) clearInterval(pollTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (channel) supabase.removeChannel(channel)
    }

    const settle = (record) => {
      if (finished || !record) return
      if (record.status === 'done') {
        cleanup()
        resolve(record.result || {})
      } else if (record.status === 'error') {
        cleanup()
        const message = record.result?.message || 'The host reported an error'
        const err = new Error(message)
        err.code = record.result?.code
        reject(err)
      }
    }

    channel = supabase
      .channel(`cmd-${commandId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'device_commands',
          filter: `id=eq.${commandId}`,
        },
        (change) => settle(change.new),
      )
      .subscribe()

    // Poll fallback — Realtime can be unavailable (publication not added,
    // connection issues) and the flow must still complete.
    pollTimer = setInterval(async () => {
      if (finished) return
      const { data } = await supabase
        .from('device_commands')
        .select('status, result')
        .eq('id', commandId)
        .maybeSingle()
      settle(data)
    }, POLL_INTERVAL_MS)

    timeoutTimer = setTimeout(() => {
      cleanup()
      // Best-effort: mark it failed so the host doesn't act on it later
      supabase
        .from('device_commands')
        .update({ status: 'error', result: { code: 'timeout', message: 'timed out' }, updated_at: new Date().toISOString() })
        .eq('id', commandId)
        .eq('status', 'pending')
        .then(() => {})
      const err = new Error("The host PC didn't respond in time")
      err.code = 'timeout'
      reject(err)
    }, timeoutMs)
  })
}

/**
 * Listen for commands targeted at this device. `handlers` maps command type →
 * async (payload, command) => result object. Returns a stop() function.
 */
export function startCommandListener(userId, deviceId, handlers) {
  const processed = new Set()
  let stopped = false

  const processCommand = async (command) => {
    if (stopped || !command || processed.has(command.id)) return
    if (command.status !== 'pending') return
    if (Date.now() - new Date(command.created_at).getTime() > COMMAND_MAX_AGE_MS) return
    processed.add(command.id)

    // Claim the row — if another racer (or a timeout) got there first, skip.
    const { data: claimed } = await supabase
      .from('device_commands')
      .update({ status: 'acked', updated_at: new Date().toISOString() })
      .eq('id', command.id)
      .eq('status', 'pending')
      .select('id')
    if (!claimed?.length) return

    const handler = handlers[command.type]
    let status = 'error'
    let result = { code: 'unknown_command', message: `Unknown command: ${command.type}` }

    if (handler) {
      try {
        result = (await handler(command.payload || {}, command)) || {}
        status = 'done'
      } catch (err) {
        status = 'error'
        result = {
          code: err?.code || 'handler_failed',
          message: err?.message || String(err),
        }
      }
    }

    await supabase
      .from('device_commands')
      .update({ status, result, updated_at: new Date().toISOString() })
      .eq('id', command.id)
  }

  const sweep = async () => {
    if (stopped) return
    try {
      const since = new Date(Date.now() - COMMAND_MAX_AGE_MS).toISOString()
      const { data } = await supabase
        .from('device_commands')
        .select('*')
        .eq('user_id', userId)
        .eq('target_device_id', deviceId)
        .eq('status', 'pending')
        .gte('created_at', since)
        .order('created_at', { ascending: true })
      for (const command of data || []) {
        await processCommand(command)
      }
    } catch (err) {
      console.debug('Command sweep failed:', err?.message)
    }
  }

  const channel = supabase
    .channel(`device-commands-${deviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'device_commands',
        filter: `target_device_id=eq.${deviceId}`,
      },
      (change) => {
        if (change.new?.user_id === userId) processCommand(change.new)
      },
    )
    .subscribe()

  // Startup sweep (commands that arrived while offline) + slow poll fallback.
  sweep()
  const pollTimer = setInterval(sweep, LISTENER_POLL_MS)

  // Opportunistic cleanup of stale finished rows (once per session).
  supabase
    .from('device_commands')
    .delete()
    .eq('user_id', userId)
    .lt('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .then(() => {})

  return () => {
    stopped = true
    clearInterval(pollTimer)
    supabase.removeChannel(channel)
  }
}
