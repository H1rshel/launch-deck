import { X } from 'lucide-react'
import GameLoadingScreen from './GameLoadingScreen'

const PHASE_TEXT = {
  provisioning: (host, percent) => ({
    statusText:
      percent != null ? `Setting up streaming — ${percent}%` : 'Setting up streaming',
    subtitle: 'Downloading the streaming client. This only happens once per PC.',
  }),
  pairing: (host) => ({
    statusText: `Pairing with ${host}`,
    subtitle: `Securely linking this PC with ${host}. No PINs needed — Launch Deck handles it.`,
  }),
  preparing: (host) => ({
    statusText: `Contacting ${host}`,
    subtitle: `Getting the game ready on ${host}.`,
  }),
  streaming: (host) => ({
    statusText: `Streaming from ${host}`,
    subtitle: `Your game is running on ${host}. Closing the stream window ends the session.`,
  }),
}

/**
 * Full-screen overlay while a stream is being set up / running.
 * Reuses the launch loading screen visuals and adds a cancel action.
 */
export default function StreamingOverlay({ session, onCancel }) {
  if (!session) return null
  const { game, host, phase, percent } = session
  const hostname = host?.hostname || 'your other PC'
  const text = (PHASE_TEXT[phase] || PHASE_TEXT.preparing)(hostname, percent)

  return (
    <div className="streaming-overlay">
      <GameLoadingScreen
        game={game}
        mode="stream"
        statusText={text.statusText}
        subtitle={text.subtitle}
      />
      <button className="streaming-overlay__cancel" onClick={onCancel}>
        <X size={16} />
        Cancel Stream
      </button>
    </div>
  )
}
