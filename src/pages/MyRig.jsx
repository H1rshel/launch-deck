import { useState } from "react"
import TopBar from "../components/layout/TopBar"
import PageHeader from "../components/layout/PageHeader"
import { useMyRig } from "../hooks/useMyRig"
import { getHardwareDbVersion } from "../lib/hardwareDb"
import {
  Cpu,
  MonitorSmartphone,
  MemoryStick,
  HardDrive,
  Monitor,
  Laptop,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  Zap,
  TrendingUp,
  AlertTriangle,
  Loader,
  Info,
  ChevronsUp,
  Eye,
  CheckCircle2,
  AlertCircle,
} from "lucide-react"
import GPUIconOutline from "../components/icons/GPUIconOutline"
import CPUIconOutline from "../components/icons/CPUIconOutline"

// ─── Grade badge colors ───
const GRADE_COLORS = {
  S: "#00d4ff",
  A: "#00ff88",
  B: "#f5a623",
  C: "#ff8844",
  D: "#ef4444",
}

// Grade-based hero glow colors (slightly different palette for glow feel)
const GLOW_COLORS = {
  S: "rgba(0, 212, 255, 0.18)",
  A: "rgba(0, 255, 136, 0.15)",
  B: "rgba(123, 47, 247, 0.14)",
  C: "rgba(255, 136, 68, 0.12)",
  D: "rgba(239, 68, 68, 0.10)",
}

function gradeColor(grade) {
  return GRADE_COLORS[grade] || "#8b99b2"
}

function glowColor(grade) {
  return GLOW_COLORS[grade] || GLOW_COLORS.B
}

// ─── Score ring (SVG donut) ───
function ScoreRing({ score, grade, size = 130, stroke = 7 }) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const progress = (score / 100) * circumference
  const color = gradeColor(grade)

  return (
    <div className="rig-score-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{
            transition: "stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1), stroke 0.3s ease",
            filter: `drop-shadow(0 0 8px ${color}50)`,
          }}
        />
      </svg>
      <div className="rig-score-ring__inner">
        <span className="rig-score-ring__grade" style={{ color }}>{grade}</span>
        <span className="rig-score-ring__score">{score}</span>
      </div>
    </div>
  )
}

// ─── Score bar ───
function ScoreBar({ score, grade, label, icon: Icon, statusLines }) {
  const color = gradeColor(grade)
  return (
    <div className="rig-score-bar">
      <div className="rig-score-bar__header">
        {Icon && <Icon size={16} style={{ color, flexShrink: 0 }} />}
        <span className="rig-score-bar__label">{label}</span>
        <span className="rig-score-bar__grade" style={{ color }}>{grade}</span>
        <span className="rig-score-bar__value">{score}</span>
      </div>
      <div className="rig-score-bar__track">
        <div
          className="rig-score-bar__fill"
          style={{ width: `${score}%`, background: `linear-gradient(90deg, ${color}40, ${color})` }}
        />
      </div>
      {statusLines?.length > 0 && (
        <div className="rig-storage-status">
          {statusLines.map((line, i) => (
            <div key={i} className={`rig-storage-status__line ${i === 0 ? 'rig-storage-status__line--good' : 'rig-storage-status__line--note'}`}>
              {i === 0 ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
              <span>{line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Gaming readiness card ───
const OVERKILL_COLOR = '#a855f7'

function ReadinessCard({ name, data, isPrimary }) {
  const score = data?.score ?? 0
  const label = data?.label || 'Unknown'
  const isOverkill = data?.isOverkill ?? false

  const color = isOverkill
    ? OVERKILL_COLOR
    : gradeColor(score >= 90 ? 'S' : score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D')

  return (
    <div
      className={`rig-readiness-card ${isPrimary ? 'rig-readiness-card--primary' : ''} ${isOverkill ? 'rig-readiness-card--overkill' : ''}`}
      style={isPrimary ? { '--rc-accent': color } : isOverkill ? { '--rc-accent': OVERKILL_COLOR } : {}}
    >
      <div className="rig-readiness-card__top">
        <span className="rig-readiness-card__name">{name}</span>
        {isPrimary && <span className="rig-readiness-card__primary-badge">Best For</span>}
        {isOverkill && !isPrimary && <span className="rig-readiness-card__overkill-badge">Overkill</span>}
      </div>
      <div className="rig-readiness-card__bar-track">
        <div
          className="rig-readiness-card__bar-fill"
          style={{ width: `${score}%`, background: `linear-gradient(90deg, ${color}50, ${color})` }}
        />
      </div>
      <div className="rig-readiness-card__status" style={{ color }}>{label}</div>
    </div>
  )
}

// ─── Spec row ───
function SpecRow({ icon: Icon, label, value, sub }) {
  if (!value) return null
  return (
    <div className="rig-spec-row">
      <div className="rig-spec-row__icon"><Icon size={15} /></div>
      <div className="rig-spec-row__content">
        {label && <span className="rig-spec-row__label">{label}</span>}
        <span className="rig-spec-row__value">{value}</span>
        {sub && <span className="rig-spec-row__sub">{sub}</span>}
      </div>
    </div>
  )
}

// ─── Skeleton state ───
function RigSkeleton() {
  return (
    <div className="page">
      <TopBar />
      <div className="page__content">
        <h1 className="page__title">My Rig</h1>
        <div className="rig-hero-skeleton">
          <div className="rig-skeleton-ring" />
          <div className="rig-skeleton-lines">
            <div className="rig-skeleton-block" style={{ width: "55%", height: 22 }} />
            <div className="rig-skeleton-block" style={{ width: "75%", height: 14 }} />
            <div className="rig-skeleton-block" style={{ width: "40%", height: 14 }} />
          </div>
        </div>
        <div className="rig-skeleton-grid">
          {[1, 2, 3, 4].map((i) => <div key={i} className="rig-skeleton-card" />)}
        </div>
      </div>
    </div>
  )
}

// ─── Main page ───
export default function MyRig() {
  const { snapshot, score, loading, scanning, error, rescan } = useMyRig()
  const [showAllStorage, setShowAllStorage] = useState(false)

  const primaryResolution = score?.readiness?.primaryResolution ?? null

  if (loading && !snapshot) return <RigSkeleton />

  const hasData = !!snapshot && !!score
  const grade = score?.overall?.grade || 'D'

  return (
    <div className="page">
      <TopBar />
      <PageHeader
        variant="compact"
        eyebrow="Hardware"
        eyebrowIcon={MonitorSmartphone}
        title="My Rig"
        subtitle="Your system specs, performance scores, and gaming readiness."
        image="/my-rig.png"
        actions={
          <>
            <button
              className="rig-hero__rescan"
              onClick={rescan}
              disabled={scanning}
              title="Re-scan hardware"
            >
              {scanning ? <Loader size={14} className="settings__spinner" /> : <RefreshCw size={14} />}
              <span>{scanning ? "Scanning..." : "Re-scan"}</span>
            </button>
            <span className="rig-db-version">DB {getHardwareDbVersion()}</span>
          </>
        }
      />
      <div className="page__content">

        {/* Hero / Summary */}
        <div className="rig-hero" style={{ '--hero-glow': glowColor(grade) }}>
          <div className="rig-hero__glow" />

          <div className="rig-hero__main">
            {hasData ? (
              <ScoreRing score={score.overall.score} grade={grade} />
            ) : (
              <div className="rig-hero__no-data"><AlertTriangle size={36} /></div>
            )}

            <div className="rig-hero__info">
              {hasData && score.overall.performanceIdentity && (
                <div className="rig-hero__identity" style={{ color: gradeColor(grade) }}>
                  {score.overall.performanceIdentity}
                </div>
              )}

              <h2 className="rig-hero__title">
                {hasData ? score.overall.description : "Hardware not detected"}
              </h2>

              <div className="rig-hero__subtitle">
                {hasData ? (
                  <>
                    <span>{snapshot.cpu?.normalizedName || "Unknown CPU"}</span>
                    <span className="rig-hero__sep">/</span>
                    <span>{snapshot.gpu?.normalizedName || "Unknown GPU"}</span>
                    <span className="rig-hero__sep">/</span>
                    <span>{snapshot.ram ? `${Math.round(snapshot.ram.totalGb)} GB RAM` : "? GB RAM"}</span>
                  </>
                ) : (
                  <span className="rig-hero__error">{error || "Click Re-scan to detect hardware"}</span>
                )}
              </div>

              {hasData && (
                <div className="rig-hero__badges">
                  <span className="rig-hero__badge" style={{ "--badge-color": gradeColor(grade) }}>
                    {score.overall.label}
                  </span>
                  {snapshot.platformType !== "unknown" && (
                    <span className="rig-hero__badge rig-hero__badge--muted">
                      {snapshot.platformType === "laptop" ? <Laptop size={12} /> : <MonitorSmartphone size={12} />}
                      {snapshot.platformType}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Error / no data */}
        {!hasData && (
          <div className="rig-empty-state">
            <AlertTriangle size={22} />
            <p>{error || "Could not detect hardware. Try re-scanning."}</p>
            <button className="rig-empty-state__btn" onClick={rescan} disabled={scanning}>
              {scanning ? "Scanning..." : "Detect Hardware"}
            </button>
          </div>
        )}

        {hasData && (
          <div className="rig-body">
            {/* Component Scores + Gaming Readiness — side by side */}
            <div className="rig-columns">
              <div className="rig-section">
                <h3 className="rig-section__title">Component Scores</h3>
                <div className="rig-breakdown-grid">
                  <ScoreBar score={score.gpu.score} grade={score.gpu.grade} label="GPU" icon={GPUIconOutline} />
                  <ScoreBar score={score.cpu.score} grade={score.cpu.grade} label="CPU" icon={Cpu} />
                  <ScoreBar score={score.ram.score} grade={score.ram.grade} label="RAM" icon={MemoryStick} />
                  <ScoreBar
                    score={score.storage.score}
                    grade={score.storage.grade}
                    label="Storage"
                    icon={HardDrive}
                    statusLines={score.storage.statusLines}
                  />
                </div>
                {(score.cpu.familyMatch || score.gpu.familyMatch) && (
                  <div className="rig-section__note">
                    <Info size={12} />
                    <span>
                      {score.cpu.familyMatch && !score.cpu.recognized && "CPU score is estimated from family. "}
                      {score.gpu.familyMatch && !score.gpu.recognized && "GPU score is estimated from family. "}
                      A hardware DB update may improve accuracy.
                    </span>
                  </div>
                )}
              </div>

              <div className="rig-section">
                <h3 className="rig-section__title">Gaming Readiness</h3>
                <div className="rig-readiness-grid">
                  <ReadinessCard name="1080p"   data={score.readiness["1080p"]}  isPrimary={primaryResolution === "1080p"} />
                  <ReadinessCard name="1440p"   data={score.readiness["1440p"]}  isPrimary={primaryResolution === "1440p"} />
                  <ReadinessCard name="4K"      data={score.readiness["4k"]}     isPrimary={primaryResolution === "4k"} />
                  <ReadinessCard name="Esports" data={score.readiness.esports}   isPrimary={primaryResolution === "esports"} />
                  <ReadinessCard
                    name="Ray Tracing"
                    data={{
                      ...score.readiness.rayTracing,
                      label: score.readiness.rayTracing?.capability === "none"
                        ? "Not Supported"
                        : score.readiness.rayTracing?.label,
                    }}
                    isPrimary={false}
                  />
                </div>
              </div>
            </div>

            {/* Specs + Insights */}
            <div className="rig-columns">
              <div className="rig-section">
                <h3 className="rig-section__title">Key Specs</h3>
                <div className="rig-spec-list">
                  <SpecRow
                    icon={Cpu}
                    label="Processor"
                    value={snapshot.cpu?.normalizedName}
                    sub={snapshot.cpu ? `${snapshot.cpu.cores}C / ${snapshot.cpu.threads}T` : null}
                  />
                  <SpecRow
                    icon={GPUIconOutline}
                    label="Graphics"
                    value={snapshot.gpu?.normalizedName}
                    sub={snapshot.gpu?.vramGb ? `${snapshot.gpu.vramGb} GB VRAM` : null}
                  />
                  <SpecRow
                    icon={MemoryStick}
                    label="Memory"
                    value={snapshot.ram ? `${Math.round(snapshot.ram.totalGb)} GB` : null}
                    sub={snapshot.ram?.speedMhz ? `${snapshot.ram.speedMhz} MHz` : null}
                  />
                  {(showAllStorage ? snapshot.storage : snapshot.storage?.slice(0, 2))?.map((d, i) => (
                    <SpecRow
                      key={i}
                      icon={HardDrive}
                      label={i === 0 ? "Storage" : ""}
                      value={d.model || `${d.sizeGb} GB`}
                      sub={`${d.sizeGb} GB · ${d.type.toUpperCase()}${d.isSystemDrive ? " · System" : ""}`}
                    />
                  ))}
                  {(snapshot.storage?.length ?? 0) > 2 && (
                    <button
                      className="rig-spec-toggle"
                      onClick={() => setShowAllStorage(!showAllStorage)}
                    >
                      {showAllStorage ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      {showAllStorage ? "Show less" : `+${snapshot.storage.length - 2} more drives`}
                    </button>
                  )}
                  <SpecRow
                    icon={Monitor}
                    label="Display"
                    value={snapshot.display?.resolution}
                    sub={snapshot.display?.refreshRate ? `${snapshot.display.refreshRate} Hz` : null}
                  />
                  {snapshot.os && (
                    <SpecRow
                      icon={Laptop}
                      label="OS"
                      value={snapshot.os.name?.replace("Microsoft ", "")}
                      sub={snapshot.os.build ? `Build ${snapshot.os.build}` : null}
                    />
                  )}
                  {snapshot.motherboard && (
                    <SpecRow icon={CPUIconOutline} label="Motherboard" value={snapshot.motherboard} />
                  )}
                </div>
              </div>

              <div className="rig-section">
                <h3 className="rig-section__title">Insights</h3>

                {score.strengths.length > 0 && (
                  <div className="rig-insight-group">
                    <div className="rig-insight-group__header">
                      <Zap size={13} />
                      <span>Strengths</span>
                    </div>
                    {score.strengths.map((s, i) => (
                      <div key={i} className="rig-insight rig-insight--strength">{s}</div>
                    ))}
                  </div>
                )}

                {score.weaknesses.length > 0 && (
                  <div className="rig-insight-group">
                    <div className="rig-insight-group__header">
                      <Eye size={13} />
                      <span>Areas to Watch</span>
                    </div>
                    {score.weaknesses.map((w, i) => (
                      <div key={i} className="rig-insight rig-insight--weakness">{w}</div>
                    ))}
                  </div>
                )}

                {score.upgradeHints.length > 0 && (
                  <div className="rig-insight-group">
                    <div className="rig-insight-group__header">
                      <ChevronsUp size={13} />
                      <span>Upgrade Tips</span>
                    </div>
                    {score.upgradeHints.map((h, i) => (
                      <div key={i} className="rig-insight rig-insight--hint">{h}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
