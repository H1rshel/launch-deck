import { useState, useRef, useEffect, useCallback } from 'react'
import { ZoomIn, ZoomOut, Check, X, RotateCw } from 'lucide-react'

export default function ImageCropper({ imageSrc, onCancel, onApply }) {
  const containerRef = useRef(null)
  const imgRef = useRef(null)

  const [imageSize, setImageSize] = useState({ width: 1, height: 1 })
  const [containerSize, setContainerSize] = useState(300) // square
  const [crop, setCrop] = useState({ x: 0, y: 0, scale: 1 })
  const [minScale, setMinScale] = useState(1)
  const [isDragging, setIsDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, cropX: 0, cropY: 0 })

  // Initialize constraints once image loads
  const handleImageLoad = (e) => {
    const { naturalWidth, naturalHeight } = e.target
    setImageSize({ width: naturalWidth, height: naturalHeight })
    
    // Calculate minimum scale to ensure the image always covers the container
    const scale = Math.max(containerSize / naturalWidth, containerSize / naturalHeight)
    setMinScale(scale)
    
    // Center it initially
    setCrop({
      x: (containerSize - naturalWidth * scale) / 2,
      y: (containerSize - naturalHeight * scale) / 2,
      scale: scale * 1.5 // starts slightly zoomed in
    })
  }

  // Handle pointer events for dragging
  const handlePointerDown = (e) => {
    setIsDragging(true)
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      cropX: crop.x,
      cropY: crop.y
    }
    e.target.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e) => {
    if (!isDragging) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    const newX = dragStart.current.cropX + dx
    const newY = dragStart.current.cropY + dy

    // Boundaries
    const minX = containerSize - imageSize.width * crop.scale
    const minY = containerSize - imageSize.height * crop.scale

    setCrop(prev => ({
      ...prev,
      x: Math.min(0, Math.max(minX, newX)),
      y: Math.min(0, Math.max(minY, newY))
    }))
  }

  const handlePointerUp = () => {
    setIsDragging(false)
  }

  // Handle wheel for zooming
  const handleWheel = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const zoomSensitivity = 0.002
    const zoomDelta = e.deltaY * -zoomSensitivity
    const newScale = Math.max(minScale, Math.min(crop.scale + zoomDelta, minScale * 4))
    
    // adjust x/y to zoom around center (simple approximation)
    const ratio = newScale / crop.scale
    const cx = containerSize / 2
    const cy = containerSize / 2
    const newX = cx - (cx - crop.x) * ratio
    const newY = cy - (cy - crop.y) * ratio

    const minX = containerSize - imageSize.width * newScale
    const minY = containerSize - imageSize.height * newScale

    setCrop({
      scale: newScale,
      x: Math.min(0, Math.max(minX, newX)),
      y: Math.min(0, Math.max(minY, newY))
    })
  }

  // Mount wheel listener manually to prevent default scroll
  useEffect(() => {
    const el = containerRef.current
    if (el) {
      el.addEventListener('wheel', handleWheel, { passive: false })
      return () => {
        el.removeEventListener('wheel', handleWheel)
      }
    }
  }, [crop, imageSize, minScale])

  const handleConfirm = useCallback(() => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const OUTPUT_SIZE = 512
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE

    // Draw background (optional, in case transparent)
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)

    // Calculate source and target rectangles
    const scaleRatio = OUTPUT_SIZE / containerSize
    const sourceX = Math.abs(crop.x) / crop.scale
    const sourceY = Math.abs(crop.y) / crop.scale
    const sourceWidth = containerSize / crop.scale
    const sourceHeight = containerSize / crop.scale

    ctx.drawImage(
      imgRef.current,
      sourceX, sourceY, sourceWidth, sourceHeight,
      0, 0, OUTPUT_SIZE, OUTPUT_SIZE
    )

    canvas.toBlob((blob) => {
      onApply(blob)
    }, 'image/jpeg', 0.95) // high quality jpeg
  }, [crop, containerSize, onApply])

  return (
    <div className="image-cropper">
      <div className="image-cropper__preview-box">
        <div 
          className={`image-cropper__canvas-container ${isDragging ? 'dragging' : ''}`}
          ref={containerRef}
          style={{ width: containerSize, height: containerSize }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Draggable image */}
          <img 
            ref={imgRef}
            src={imageSrc} 
            alt="Source" 
            onLoad={handleImageLoad}
            className="image-cropper__img"
            style={{ 
              transform: `translate3d(${crop.x}px, ${crop.y}px, 0) scale(${crop.scale})`,
              transformOrigin: '0 0'
            }}
            draggable={false}
          />

          {/* Mask Overlay (Dims the outside, keeps center circle clear) */}
          <div className="image-cropper__overlay">
            <div className="image-cropper__cutout"></div>
          </div>
        </div>
        
        <div className="image-cropper__instructions">
          Drag to reposition · Scroll to zoom
        </div>
      </div>

      <div className="image-cropper__sliders">
        <ZoomOut size={16} />
        <input 
          type="range" 
          min={minScale} 
          max={minScale * 4} 
          step="0.01"
          value={crop.scale}
          onChange={(e) => {
            const newScale = parseFloat(e.target.value)
            const ratio = newScale / crop.scale
            const cx = containerSize / 2
            const cy = containerSize / 2
            const newX = cx - (cx - crop.x) * ratio
            const newY = cy - (cy - crop.y) * ratio

            const minX = containerSize - imageSize.width * newScale
            const minY = containerSize - imageSize.height * newScale

            setCrop({
              scale: newScale,
              x: Math.min(0, Math.max(minX, newX)),
              y: Math.min(0, Math.max(minY, newY))
            })
          }}
          className="image-cropper__range"
        />
        <ZoomIn size={16} />
      </div>

      <div className="image-cropper__actions">
        <button className="avatar-manager__btn avatar-manager__btn--outline" onClick={onCancel}>
          <X size={16} /> Cancel
        </button>
        <button className="avatar-manager__btn avatar-manager__btn--primary" onClick={handleConfirm}>
          <Check size={16} /> Apply
        </button>
      </div>
    </div>
  )
}
