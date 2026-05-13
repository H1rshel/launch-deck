import { Clock, AlertCircle, Loader } from 'lucide-react'

function formatHours(hours) {
  if (!hours || hours <= 0) return null
  return Number.isInteger(hours) ? `${hours}h` : `${hours}h`
}

function SkeletonRow() {
  return (
    <div className="hltb-panel__row hltb-panel__row--skeleton">
      <span className="hltb-panel__skeleton hltb-panel__skeleton--label" />
      <span className="hltb-panel__skeleton hltb-panel__skeleton--value" />
    </div>
  )
}

export default function HowLongToBeatPanel({
  data,
  loading,
  refreshing = false,
  error = null,
}) {
  if (!loading && !data && !error && !refreshing) return null

  const showBlockingLoader = loading && !data
  const showBlockingError = !showBlockingLoader && !data && !!error
  const hasData = !!data?.available

  return (
    <div className={`hltb-panel${hasData ? ' hltb-panel--loaded' : ''}`}>
      <div className="hltb-panel__header">
        <Clock size={15} className="hltb-panel__icon" />
        <span className="hltb-panel__title">How Long To Beat</span>
        {refreshing && (
          <Loader
            size={13}
            className="hltb-panel__refresh-spinner settings__spinner"
          />
        )}
      </div>

      {showBlockingLoader && (
        <div className="hltb-panel__rows">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      )}

      {showBlockingError && (
        <div className="hltb-panel__empty">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}

      {!showBlockingLoader && !showBlockingError && data && !data.available && (
        <div className="hltb-panel__empty">
          <AlertCircle size={13} />
          <span>{data.reason || 'Completion time unavailable'}</span>
        </div>
      )}

      {hasData && (
        <div className="hltb-panel__rows">
          {[
            { label: 'Main Story', value: formatHours(data.main) },
            { label: 'Main + Extra', value: formatHours(data.mainExtra) },
            { label: 'Completionist', value: formatHours(data.completionist) },
          ].map(({ label, value }) => (
            <div key={label} className="hltb-panel__row">
              <span className="hltb-panel__row-label">{label}</span>
              <span
                className={`hltb-panel__row-value${!value ? ' hltb-panel__row-value--na' : ''}`}
              >
                {value || '-'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
