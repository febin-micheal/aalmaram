import { useCallback, useEffect, useRef, useState } from 'react'

import { MAX_SCALE, MIN_SCALE, fitTransform, zoomAbout } from './layoutOverview.js'

/** Two fingers closer than this are treated as one — a stray thumb should not zoom. */
const MIN_PINCH_DISTANCE = 24

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
  // Live pointers, so two fingers can be told from one.
  const pointers = useRef(new Map())
  const pinch = useRef(null)
  const lastTap = useRef(0)

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
      // The maths lives in layoutOverview.js so it can be checked at phone widths.
      const next = fitTransform(bounds, { width, height }, padding)
      if (next) setTransform(next)
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

  /** Shift the view by a screen delta — used to hold an anchor still after a re-layout. */
  const panBy = useCallback((dx, dy) => {
    setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
  }, [])

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
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      // A trackpad pinch arrives as a wheel event with ctrlKey set, and needs a much
      // stronger response than a scroll wheel or it feels stuck.
      const factor = event.ctrlKey ? Math.pow(0.99, event.deltaY) : Math.pow(0.999, event.deltaY)
      setTransform((t) => zoomAbout(t, at, t.k * factor))
    }

    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [svgRef])

  const localPoint = (event) => {
    const rect = svgRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture?.(event.pointerId)

    if (pointers.current.size === 2) {
      // Second finger down: stop panning, start pinching.
      dragging.current = null
      const [a, b] = [...pointers.current.values()]
      pinch.current = { distance: distanceBetween(a, b), scale: transform.k }
      return
    }

    dragging.current = { startX: event.clientX, startY: event.clientY, moved: false }

    if (event.pointerType === 'touch') {
      const now = Date.now()
      if (now - lastTap.current < 300) {
        // Double-tap zooms one step, about the tapped point.
        const at = localPoint(event)
        setTransform((t) => zoomAbout(t, at, t.k * 1.8))
        lastTap.current = 0
      } else {
        lastTap.current = now
      }
    }
  }

  const onPointerMove = (event) => {
    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    }

    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const distance = distanceBetween(a, b)
      if (distance < MIN_PINCH_DISTANCE) return
      const rect = svgRef.current?.getBoundingClientRect()
      // Anchor on the midpoint between the fingers, so the graph stays under them.
      const centre = {
        x: (a.x + b.x) / 2 - (rect?.left ?? 0),
        y: (a.y + b.y) / 2 - (rect?.top ?? 0),
      }
      const ratio = distance / pinch.current.distance
      setTransform((t) => zoomAbout(t, centre, pinch.current.scale * ratio))
      return
    }

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
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) dragging.current = null
  }

  /** True while a drag is in progress, so a pan is never mistaken for a node click. */
  const isDragging = () => Boolean(dragging.current?.moved)

  return {
    transform,
    viewport,
    fit,
    centerOn,
    zoomBy,
    panBy,
    isDragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerLeave: onPointerUp },
  }
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function clamp(k) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k))
}
