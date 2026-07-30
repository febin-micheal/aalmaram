import { useCallback, useEffect, useRef, useState } from 'react'

const MIN_SCALE = 0.08
const MAX_SCALE = 2.5

/**
 * Pan and zoom over a single SVG transform group.
 *
 * Everything the canvas draws lives inside one `<g transform="translate(x,y) scale(k)">`,
 * so panning and zooming never touch the nodes themselves — the browser composites one
 * transform, and a few hundred cards stay smooth. That is also why this is ~80 lines of
 * pointer handling rather than a graph library's viewport.
 */
export function usePanZoom(svgRef) {
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 })
  // Tracked in state (not read during render) because viewport culling needs it and
  // calling getBoundingClientRect while rendering thrashes layout.
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const dragging = useRef(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setViewport((current) =>
        current.width === width && current.height === height ? current : { width, height },
      )
    })
    observer.observe(svg)
    return () => observer.disconnect()
  }, [svgRef])

  const fit = useCallback(
    (bounds, { padding = 80 } = {}) => {
      const svg = svgRef.current
      if (!svg || !bounds) return
      const { width, height } = svg.getBoundingClientRect()
      if (!width || !height) return

      const boxW = Math.max(bounds.maxX - bounds.minX, 1)
      const boxH = Math.max(bounds.maxY - bounds.minY, 1)
      const k = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Math.min((width - padding * 2) / boxW, (height - padding * 2) / boxH)),
      )
      setTransform({
        k,
        x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
        y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
      })
    },
    [svgRef],
  )

  const centerOn = useCallback(
    (point, scale) => {
      const svg = svgRef.current
      if (!svg || !point) return
      const { width, height } = svg.getBoundingClientRect()
      setTransform((current) => {
        const k = scale ?? current.k
        return { k, x: width / 2 - point.x * k, y: height / 2 - point.y * k }
      })
    },
    [svgRef],
  )

  const zoomBy = useCallback(
    (factor) => {
      const svg = svgRef.current
      if (!svg) return
      const { width, height } = svg.getBoundingClientRect()
      setTransform((t) => {
        const k = clamp(t.k * factor)
        // Keep the middle of the viewport fixed while the scale changes.
        return {
          k,
          x: width / 2 - ((width / 2 - t.x) / t.k) * k,
          y: height / 2 - ((height / 2 - t.y) / t.k) * k,
        }
      })
    },
    [svgRef],
  )

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return undefined

    // Registered manually because React's onWheel is passive and cannot preventDefault,
    // which would let the page scroll while zooming the canvas.
    const onWheel = (event) => {
      event.preventDefault()
      const rect = svg.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      setTransform((t) => {
        const k = clamp(t.k * Math.pow(0.999, event.deltaY))
        // Anchor the zoom on the pointer: the graph point under the cursor stays put.
        return { k, x: px - ((px - t.x) / t.k) * k, y: py - ((py - t.y) / t.k) * k }
      })
    }

    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [svgRef])

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    dragging.current = { startX: event.clientX, startY: event.clientY, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event) => {
    const drag = dragging.current
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
    drag.startX = event.clientX
    drag.startY = event.clientY
    setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
  }

  const onPointerUp = (event) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    dragging.current = null
  }

  /** True while a drag is in progress, so a pan is never mistaken for a node click. */
  const isDragging = () => Boolean(dragging.current?.moved)

  return {
    transform,
    viewport,
    fit,
    centerOn,
    zoomBy,
    isDragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp },
  }
}

function clamp(k) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k))
}
