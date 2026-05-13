/**
 * GamePerformanceCard — shown on each Game Detail page.
 * Analyzes how the game should run on the user's rig and displays
 * a performance tier, per-resolution readiness, bottleneck insight,
 * resolution toggle, estimated FPS, and recommended settings.
 */

import { useMemo, useState } from 'react'
import { useMyRig } from '../../hooks/useMyRig'
import { analyzeGamePerformance } from '../../lib/analyzeGamePerformance'
import {
  Cpu,
  Monitor,
  MemoryStick,
  HardDrive,
  Loader,
  AlertTriangle,
  ChevronRight,
  Zap,
  Settings2,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'

const TIER_COLORS = {
  purple: '#a855f7',
  green:  '#00ff88',
  cyan:   '#00d4ff',
  amber:  '#f5a623',
  orange: '#ff8844',
  red:    '#ef4444',
  gray:   '#8b99b2',
}

const LIMITER_ICONS = {
  gpu:     Monitor,
  cpu:     Cpu,
  ram:     MemoryStick,
  storage: HardDrive,
}

const RES_KEYS = ['1080p', '1440p', '4k']

function estimateFps(score) {
  if (score >= 93) return { min: 120, max: 144, label: '120–144+' }
  if (score >= 78) return { min: 90, max: 120, label: '90–120' }
  if (score >= 62) return { min: 60, max: 90, label: '60–90' }
  if (score >= 46) return { min: 40, max: 60, label: '40–60' }
  if (score >= 30) return { min: 25, max: 40, label: '25–40' }
  return { min: 15, max: 30, label: '15–30' }
}

function getStability(score) {
  if (score >= 78) return { key: 'stable', label: 'Stable' }
  if (score >= 46) return { key: 'drops', label: 'Minor Drops' }
  return { key: 'limited', label: 'CPU Limited' }
}

function getRecommendedPreset(overallFit) {
  if (overallFit >= 93) return 'Ultra'
  if (overallFit >= 78) return 'Ultra / High'
  if (overallFit >= 62) return 'High'
  if (overallFit >= 46) return 'Medium / High'
  if (overallFit >= 30) return 'Medium'
  return 'Low'
}

export default function GamePerformanceCard({ game }) {
  const { score, loading } = useMyRig()
  const navigate = useNavigate()
  const [activeRes, setActiveRes] = useState(null)

  const analysis = useMemo(() => {
    if (!score || !game) return null
    return analyzeGamePerformance(score, game)
  }, [score, game])

  if (!loading && !score) return null

  if (loading && !score) {
    return (
      <div className="gpc">
        <div className="gpc__header">
          <Monitor size={15} className="gpc__header-icon" />
          <span className="gpc__title">Performance on Your Rig</span>
          <Loader size={13} className="settings__spinner" />
        </div>
        <div className="gpc__loading">
          <div className="gpc__skeleton" style={{ width: '70%' }} />
          <div className="gpc__skeleton" style={{ width: '50%' }} />
        </div>
      </div>
    )
  }

  if (!analysis?.available) {
    return (
      <div className="gpc">
        <div className="gpc__header">
          <Monitor size={15} className="gpc__header-icon" />
          <span className="gpc__title">Performance on Your Rig</span>
        </div>
        <div className="gpc__empty">
          <AlertTriangle size={13} />
          <span>{analysis?.reason || 'Hardware not detected'}</span>
        </div>
      </div>
    )
  }

  const tierColor = TIER_COLORS[analysis.tierColor] || '#8b99b2'
  const LimiterIcon = LIMITER_ICONS[analysis.limitingFactor?.component] || Monitor
  const isOverkill = analysis.tier === 'Overkill'
  const recommendedPreset = getRecommendedPreset(analysis.overallFit)

  // Get focused resolution data
  const focusedResData = activeRes ? analysis.resolutions[activeRes] : null
  const focusedScore = focusedResData?.score ?? analysis.overallFit
  const fps = estimateFps(focusedScore)
  const stability = getStability(focusedScore)

  return (
    <div className="gpc">
      <div className="gpc__header">
        <Monitor size={15} className="gpc__header-icon" />
        <span className="gpc__title">Performance on Your Rig</span>
        <button
          className="gpc__my-rig-link"
          onClick={() => navigate('/my-rig')}
          title="View My Rig"
        >
          My Rig <ChevronRight size={13} />
        </button>
      </div>

      {/* Tier badge + best target */}
      <div className="gpc__status-row">
        <span className="gpc__badge" style={{ '--gpc-color': tierColor }}>
          {isOverkill && <Zap size={11} />}
          {analysis.tier}
        </span>
        {analysis.bestTarget && (
          <span className="gpc__best-target">{analysis.bestTarget}</span>
        )}
        {analysis.confidence && (
          <span className="gpc__confidence">{analysis.confidence.label}</span>
        )}
      </div>

      {/* Resolution toggle */}
      <div className="gpc__res-toggle">
        {RES_KEYS.map((key) => (
          <button
            key={key}
            className={`gpc__res-toggle-btn${activeRes === key ? ' gpc__res-toggle-btn--active' : ''}`}
            onClick={() => setActiveRes(activeRes === key ? null : key)}
          >
            {key}
          </button>
        ))}
      </div>

      {/* FPS estimate + stability (shown when resolution selected) */}
      {activeRes && focusedResData && (
        <>
          <div className="gpc__detail-row">
            <span className="gpc__detail-label">Est. FPS</span>
            <span
              className="gpc__detail-value gpc__detail-value--fps"
              style={{ '--gpc-color': TIER_COLORS[focusedResData.color] || '#8b99b2' }}
            >
              {fps.label} FPS
            </span>
          </div>
          <div className="gpc__detail-row">
            <span className="gpc__detail-label">Stability</span>
            <span className={`gpc__stability gpc__stability--${stability.key}`}>
              <span className="gpc__stability-dot" />
              {stability.label}
            </span>
          </div>
        </>
      )}

      {/* Per-resolution bars */}
      <div className="gpc__resolutions">
        {Object.entries(analysis.resolutions).map(([key, data]) => {
          const color = TIER_COLORS[data.color] || '#8b99b2'
          const isActive = activeRes === key
          const isDimmed = activeRes && !isActive
          const isTarget = !activeRes && key === analysis.targetKey
          return (
            <div
              key={key}
              className={`gpc__res-row${isDimmed ? ' gpc__res-row--dimmed' : ''}${isActive ? ' gpc__res-row--active' : ''}${isTarget ? ' gpc__res-row--target' : ''}`}
            >
              <span className="gpc__res-label">{key}</span>
              <div className="gpc__res-bar-track">
                <div
                  className="gpc__res-bar-fill"
                  style={{ width: `${data.score}%`, background: color }}
                />
              </div>
              <span className="gpc__res-status" style={{ color }}>{data.label}</span>
            </div>
          )
        })}
      </div>

      {/* Play advice */}
      <div className="gpc__recommended">
        <Settings2 size={12} />
        <span className="gpc__recommended-label">Play at</span>
        <span className="gpc__recommended-value">{analysis.bestTarget} · {recommendedPreset}</span>
      </div>

      {/* Bottleneck */}
      {analysis.limitingFactor?.component !== 'balanced' && (
        <div className="gpc__bottleneck">
          <LimiterIcon size={13} />
          <span>{analysis.limitingFactor.label}</span>
        </div>
      )}

      {/* Context-aware description */}
      <div className="gpc__explanation">{analysis.description}</div>
    </div>
  )
}
