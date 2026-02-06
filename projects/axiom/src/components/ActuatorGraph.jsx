import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react'

const CATEGORY_CONFIG = {
  physical:      { color: '#e74c3c', label: 'Physical',       angle: 0 },
  cognitive:     { color: '#a366cc', label: 'Cognitive',      angle: 51.4 },
  social:        { color: '#4a9edd', label: 'Social',         angle: 102.8 },
  digital:       { color: '#45d48a', label: 'Digital',        angle: 154.3 },
  economic:      { color: '#f0a030', label: 'Economic',       angle: 205.7 },
  informational: { color: '#20c9b0', label: 'Informational',  angle: 257.1 },
  meta:          { color: '#d48045', label: 'Meta',           angle: 308.5 }
}

const STATUS_COLORS = {
  confirmed:   '#4ecdc4',
  theoretical: '#6272a4',
  blocked:     '#f0c040',
  distant:     '#3d3d5c'
}

function computeLayout(actuators, cx, cy, outerRadius) {
  // Group actuators by category
  const groups = {}
  for (const a of actuators) {
    if (!groups[a.category]) groups[a.category] = []
    groups[a.category].push(a)
  }

  const positions = {}
  const categoryLabels = []

  for (const [cat, config] of Object.entries(CATEGORY_CONFIG)) {
    const items = groups[cat] || []
    if (items.length === 0) continue

    const baseAngle = (config.angle * Math.PI) / 180
    const spreadAngle = (40 * Math.PI) / 180 // 40 degree spread per category

    // Place category label
    const labelR = outerRadius + 30
    categoryLabels.push({
      x: cx + Math.cos(baseAngle) * labelR,
      y: cy + Math.sin(baseAngle) * labelR,
      label: config.label,
      color: config.color,
      angle: config.angle
    })

    // Distribute actuators within the segment
    items.forEach((item, i) => {
      const count = items.length
      const angleOffset = count === 1 ? 0 : (i / (count - 1) - 0.5) * spreadAngle
      const angle = baseAngle + angleOffset

      // Vary radius slightly based on index for visual separation
      const rVariance = 0.75 + (i % 3) * 0.12
      const r = outerRadius * rVariance

      positions[item.id] = {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        category: cat,
        categoryColor: config.color
      }
    })
  }

  return { positions, categoryLabels }
}

export default function ActuatorGraph({ actuators, onNodeClick, statusFilter }) {
  const svgRef = useRef(null)
  const [hoveredNode, setHoveredNode] = useState(null)
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 800, h: 600 })
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState(null)

  const cx = 400
  const cy = 300
  const outerRadius = 200

  const filteredActuators = useMemo(() => {
    if (!statusFilter || statusFilter.length === 0) return actuators
    return actuators.filter(a => statusFilter.includes(a.status))
  }, [actuators, statusFilter])

  const { positions, categoryLabels } = useMemo(
    () => computeLayout(actuators, cx, cy, outerRadius),
    [actuators]
  )

  // Build dependency edges
  const edges = useMemo(() => {
    const result = []
    for (const a of actuators) {
      if (!a.dependencies) continue
      for (const depId of a.dependencies) {
        const from = positions[depId]
        const to = positions[a.id]
        if (from && to) {
          result.push({ fromId: depId, toId: a.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y })
        }
      }
    }
    return result
  }, [actuators, positions])

  // Node size based on feasibility
  const getNodeRadius = useCallback((actuator) => {
    return 6 + actuator.feasibility * 10
  }, [])

  // Zoom handler
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const scale = e.deltaY > 0 ? 1.1 : 0.9
    setViewBox(prev => {
      const newW = prev.w * scale
      const newH = prev.h * scale
      const dx = (prev.w - newW) / 2
      const dy = (prev.h - newH) / 2
      return { x: prev.x + dx, y: prev.y + dy, w: newW, h: newH }
    })
  }, [])

  // Pan handlers
  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('.actuator-node')) return
    setIsPanning(true)
    setPanStart({ x: e.clientX, y: e.clientY, vx: viewBox.x, vy: viewBox.y })
  }, [viewBox])

  const handleMouseMove = useCallback((e) => {
    if (!isPanning || !panStart) return
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const scaleX = viewBox.w / rect.width
    const scaleY = viewBox.h / rect.height
    const dx = (e.clientX - panStart.x) * scaleX
    const dy = (e.clientY - panStart.y) * scaleY
    setViewBox(prev => ({ ...prev, x: panStart.vx - dx, y: panStart.vy - dy }))
  }, [isPanning, panStart, viewBox.w, viewBox.h])

  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
    setPanStart(null)
  }, [])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  // Determine which edges to highlight
  const highlightedEdges = useMemo(() => {
    if (!hoveredNode) return new Set()
    const set = new Set()
    for (const edge of edges) {
      if (edge.fromId === hoveredNode || edge.toId === hoveredNode) {
        set.add(`${edge.fromId}-${edge.toId}`)
      }
    }
    return set
  }, [hoveredNode, edges])

  // Visible node IDs
  const visibleIds = useMemo(() => new Set(filteredActuators.map(a => a.id)), [filteredActuators])

  // Bezier curve for edges
  const edgePath = useCallback((x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    // Curve toward centre
    const pull = 0.2
    const cpx = mx + (cx - mx) * pull
    const cpy = my + (cy - my) * pull
    return `M ${x1} ${y1} Q ${cpx} ${cpy} ${x2} ${y2}`
  }, [])

  return (
    <svg
      ref={svgRef}
      className="actuator-graph"
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
    >
      {/* Centre label */}
      <text x={cx} y={cy - 8} textAnchor="middle" className="category-label" fill="#4ecdc4" fontSize="12" fontWeight="700" letterSpacing="3">
        AXIOM
      </text>
      <text x={cx} y={cy + 8} textAnchor="middle" fill="#5a7186" fontSize="8" fontFamily="'IBM Plex Mono', monospace">
        {actuators.length} actuators
      </text>

      {/* Dependency edges */}
      {edges.map((edge, i) => {
        const key = `${edge.fromId}-${edge.toId}`
        const isHighlighted = highlightedEdges.has(key)
        const isVisible = visibleIds.has(edge.fromId) && visibleIds.has(edge.toId)
        if (!isVisible) return null
        return (
          <path
            key={i}
            d={edgePath(edge.x1, edge.y1, edge.x2, edge.y2)}
            className={`dependency-edge${isHighlighted ? ' highlighted' : ''}`}
          />
        )
      })}

      {/* Category labels */}
      {categoryLabels.map((cl, i) => (
        <text
          key={i}
          x={cl.x}
          y={cl.y}
          textAnchor="middle"
          className="category-label"
          fill={cl.color}
          fontSize="9"
        >
          {cl.label}
        </text>
      ))}

      {/* Actuator nodes */}
      {filteredActuators.map(actuator => {
        const pos = positions[actuator.id]
        if (!pos) return null
        const r = getNodeRadius(actuator)
        const fillColor = STATUS_COLORS[actuator.status] || '#3d3d5c'
        const strokeColor = pos.categoryColor
        const isHovered = hoveredNode === actuator.id

        return (
          <g
            key={actuator.id}
            className="actuator-node"
            onClick={() => onNodeClick?.(actuator)}
            onMouseEnter={() => setHoveredNode(actuator.id)}
            onMouseLeave={() => setHoveredNode(null)}
          >
            <circle
              cx={pos.x}
              cy={pos.y}
              r={r}
              className="actuator-node-circle"
              fill={fillColor}
              fillOpacity={actuator.status === 'distant' ? 0.3 : (actuator._operational && actuator.status === 'confirmed') ? 0.9 : (actuator.status === 'confirmed' && !actuator._operational) ? 0.45 : 0.6}
              stroke={strokeColor}
              strokeWidth={isHovered ? 2 : 1}
            />
            {actuator._revised && !actuator._operational && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r + 4}
                fill="none"
                stroke="#4ecdc4"
                strokeWidth={0.8}
                opacity={0.6}
                className="revised-pulse"
              />
            )}
            {actuator._operational && actuator.status === 'confirmed' && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r + 4}
                fill="none"
                stroke="#4ecdc4"
                strokeWidth={1.5}
                opacity={0.9}
              />
            )}
            {actuator._operational && actuator.status !== 'confirmed' && (
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r + 4}
                fill="none"
                stroke="#45d48a"
                strokeWidth={0.8}
                opacity={0.6}
                className="revised-pulse"
              />
            )}
            {isHovered && (
              <>
                <circle
                  cx={pos.x}
                  cy={pos.y}
                  r={r + 3}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={0.5}
                  opacity={0.5}
                />
                <text
                  x={pos.x}
                  y={pos.y - r - 6}
                  textAnchor="middle"
                  className="actuator-label"
                  fontSize="9"
                  fontWeight="600"
                >
                  {actuator.name}
                </text>
                <text
                  x={pos.x}
                  y={pos.y - r - 6 + 11}
                  textAnchor="middle"
                  className="actuator-label"
                  fontSize="7"
                  fill={actuator._operational ? '#45d48a' : '#5a7186'}
                >
                  {actuator.status}{actuator._operational ? ' \u2022 operational' : ''}
                </text>
              </>
            )}
          </g>
        )
      })}
    </svg>
  )
}
