import React from 'react'

function resetStartupState() {
  try {
    sessionStorage.clear()
    localStorage.removeItem('ld_setting_startupMode')
  } catch {}
  window.location.href = '/login'
}

function reloadApp() {
  window.location.reload()
}

export function StartupRecoveryScreen({ title = 'Launch Deck could not finish loading', message, details }) {
  return (
    <div className="startup-recovery">
      <div className="startup-recovery__panel">
        <img src="/launch-deck-logo-alt.png" alt="" className="startup-recovery__logo" />
        <h1>{title}</h1>
        <p>{message || 'The app opened, but the interface did not render correctly.'}</p>
        {details && <pre>{details}</pre>}
        <div className="startup-recovery__actions">
          <button onClick={reloadApp}>Reload</button>
          <button onClick={resetStartupState}>Reset startup</button>
        </div>
      </div>
    </div>
  )
}

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[startup] React render failed:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <StartupRecoveryScreen
          title="Launch Deck hit a startup error"
          message="Reload the app, or reset startup state if it keeps opening to a blank screen."
          details={this.state.error?.message || String(this.state.error)}
        />
      )
    }

    return this.props.children
  }
}
