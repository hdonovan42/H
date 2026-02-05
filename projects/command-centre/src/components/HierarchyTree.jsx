import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { UnitRank, UnitStatus } from '../simulation/AgentSimulator'

// Layout configuration
const LAYOUT = {
  width: 1100,
  height: 480,
  padding: 30,
  nodeRadius: {
    [UnitRank.CHIEF]: 24,
    [UnitRank.GENERAL]: 20,
    [UnitRank.OFFICER]: 16,
    [UnitRank.SOLDIER]: 10,
    [UnitRank.DOG]: 16
  },
  verticalGap: 90,
  horizontalSpacing: {
    [UnitRank.GENERAL]: 320,
    [UnitRank.OFFICER]: 150,
    [UnitRank.SOLDIER]: 45
  }
}

// Rank icons - clean military style
const RankIcon = ({ rank, x, y, size }) => {
  const s = size * 0.4
  const color = '#5a8a5a'

  switch (rank) {
    case UnitRank.CHIEF:
      // Three horizontal bars
      return (
        <g transform={`translate(${x}, ${y})`}>
          <rect x={-s} y={-s * 0.8} width={s * 2} height={s * 0.4} fill={color} />
          <rect x={-s} y={-s * 0.2} width={s * 2} height={s * 0.4} fill={color} />
          <rect x={-s} y={s * 0.4} width={s * 2} height={s * 0.4} fill={color} />
        </g>
      )
    case UnitRank.GENERAL:
      // Star
      return (
        <g transform={`translate(${x}, ${y})`}>
          <polygon
            points={`0,${-s} ${s * 0.22},${-s * 0.3} ${s},${-s * 0.3} ${s * 0.36},${s * 0.1} ${s * 0.58},${s} 0,${s * 0.45} ${-s * 0.58},${s} ${-s * 0.36},${s * 0.1} ${-s},${-s * 0.3} ${-s * 0.22},${-s * 0.3}`}
            fill={color}
          />
        </g>
      )
    case UnitRank.OFFICER:
      // Diamond
      return (
        <g transform={`translate(${x}, ${y})`}>
          <polygon points={`0,${-s} ${s},0 0,${s} ${-s},0`} fill={color} />
        </g>
      )
    case UnitRank.SOLDIER:
      // Chevron
      return (
        <g transform={`translate(${x}, ${y})`}>
          <polyline
            points={`${-s * 0.7},${-s * 0.3} 0,${s * 0.3} ${s * 0.7},${-s * 0.3}`}
            fill="none"
            stroke={color}
            strokeWidth={s * 0.35}
            strokeLinecap="square"
          />
        </g>
      )
    case UnitRank.DOG:
      // Aggressive wolf
      return (
        <text
          x={x}
          y={y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={s * 1.8}
          style={{ filter: 'grayscale(100%) brightness(0.6) contrast(1.4)' }}
        >
          🐺
        </text>
      )
    default:
      return null
  }
}

// Calculate positions for all units
function calculatePositions(units) {
  const positions = new Map()

  // Chief at top center
  const chief = units.get('chief')
  if (!chief) return positions

  const centerX = LAYOUT.width / 2
  positions.set('chief', { x: centerX, y: LAYOUT.padding + 20 })

  // Separate generals and dogs
  const childIds = chief.childrenIds || []
  const generalIds = childIds.filter(id => units.get(id)?.rank === UnitRank.GENERAL)
  const dogIds = childIds.filter(id => units.get(id)?.rank === UnitRank.DOG)

  // Position generals
  const generalY = LAYOUT.padding + 20 + LAYOUT.verticalGap
  const generalSpacing = LAYOUT.horizontalSpacing[UnitRank.GENERAL]
  const generalStartX = centerX - ((generalIds.length - 1) * generalSpacing) / 2

  generalIds.forEach((id, index) => {
    const x = generalStartX + index * generalSpacing
    positions.set(id, { x, y: generalY })

    // Position officers under this general
    const general = units.get(id)
    const officerIds = general?.childrenIds || []
    const officerY = generalY + LAYOUT.verticalGap
    const officerSpacing = LAYOUT.horizontalSpacing[UnitRank.OFFICER]
    const officerStartX = x - ((officerIds.length - 1) * officerSpacing) / 2

    officerIds.forEach((officerId, oIndex) => {
      const ox = officerStartX + oIndex * officerSpacing
      positions.set(officerId, { x: ox, y: officerY })
    })
  })

  // Position dogs at the bottom
  const dogY = LAYOUT.height - LAYOUT.padding - 30
  const dogSpacing = 120
  const dogStartX = centerX - ((dogIds.length - 1) * dogSpacing) / 2

  dogIds.forEach((id, index) => {
    positions.set(id, {
      x: dogStartX + index * dogSpacing,
      y: dogY
    })
  })

  return positions
}

// Generate connection lines (only for chief -> general -> officer hierarchy)
function generateConnections(units, positions) {
  const connections = []

  units.forEach((unit, id) => {
    // Only connect generals and officers (not dogs, not soldiers)
    if (unit.parentId && (unit.rank === UnitRank.GENERAL || unit.rank === UnitRank.OFFICER)) {
      const parentPos = positions.get(unit.parentId)
      const childPos = positions.get(id)

      if (parentPos && childPos) {
        const parentRadius = LAYOUT.nodeRadius[units.get(unit.parentId)?.rank] || 20
        const childRadius = LAYOUT.nodeRadius[unit.rank] || 15

        connections.push({
          id: `${unit.parentId}-${id}`,
          x1: parentPos.x,
          y1: parentPos.y + parentRadius,
          x2: childPos.x,
          y2: childPos.y - childRadius,
          active: unit.status === UnitStatus.ACTIVE ||
            units.get(unit.parentId)?.status === UnitStatus.ACTIVE
        })
      }
    }
  })

  return connections
}

// Compute tight bounding box around all visible content
function computeContentBounds(positions, units) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  positions.forEach((pos, id) => {
    const unit = units.get(id)
    if (!unit) return
    const radius = LAYOUT.nodeRadius[unit.rank] || 15

    // Horizontal: node radius + margin for label overflow
    minX = Math.min(minX, pos.x - radius - 30)
    maxX = Math.max(maxX, pos.x + radius + 30)
    // Vertical: radius + active ring above, label below
    minY = Math.min(minY, pos.y - radius - 5)
    maxY = Math.max(maxY, pos.y + radius + 20)

    // Officers have swarm clouds + company label below
    if (unit.rank === UnitRank.OFFICER) {
      const swarmBottom = pos.y + 50 + 12.5 + 20
      maxY = Math.max(maxY, swarmBottom)
    }
  })

  if (!isFinite(minX)) {
    return { x: 0, y: 0, width: LAYOUT.width, height: LAYOUT.height }
  }

  const pad = 25
  return {
    x: minX - pad,
    y: minY - pad,
    width: (maxX - minX) + pad * 2,
    height: (maxY - minY) + pad * 2
  }
}

export default function HierarchyTree({ units, onUnitClick }) {
  const positions = useMemo(() => calculatePositions(units), [units])
  const connections = useMemo(() => generateConnections(units, positions), [units, positions])
  const bounds = useMemo(() => computeContentBounds(positions, units), [positions, units])

  // Zoom and pan state
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const svgRef = useRef(null)
  const isPanning = useRef(false)
  const lastMousePos = useRef({ x: 0, y: 0 })

  // Wheel handler needs to be attached with passive: false to prevent page scroll
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const handleWheel = (e) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      setZoom(z => Math.min(Math.max(z * delta, 0.5), 3))
    }

    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [])

  const handleMouseDown = useCallback((e) => {
    if (e.button === 0) { // Left click
      isPanning.current = true
      setIsDragging(true)
      lastMousePos.current = { x: e.clientX, y: e.clientY }
      e.preventDefault()
    }
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (isPanning.current) {
      const dx = e.clientX - lastMousePos.current.x
      const dy = e.clientY - lastMousePos.current.y
      setPan(p => ({ x: p.x + dx, y: p.y + dy }))
      lastMousePos.current = { x: e.clientX, y: e.clientY }
    }
  }, [])

  const handleMouseUp = useCallback(() => {
    if (isPanning.current) {
      isPanning.current = false
      setIsDragging(false)
      // Check if any content is still visible, snap back only if nothing is in view
      setPan(p => {
        // Calculate content bounds after transform
        const cx = bounds.x + bounds.width / 2
        const cy = bounds.y + bounds.height / 2
        const contentMinX = cx + p.x - bounds.width / 2 * zoom
        const contentMaxX = cx + p.x + bounds.width / 2 * zoom
        const contentMinY = cy + p.y - bounds.height / 2 * zoom
        const contentMaxY = cy + p.y + bounds.height / 2 * zoom

        // Check if content is completely outside viewport
        const outOfView =
          contentMaxX < bounds.x ||
          contentMinX > bounds.x + bounds.width ||
          contentMaxY < bounds.y ||
          contentMinY > bounds.y + bounds.height

        if (outOfView) {
          return { x: 0, y: 0 }
        }
        return p
      })
    }
  }, [zoom, bounds])

  const resetView = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Render swarm visualization beneath an officer
  const renderSwarm = (officer, pos) => {
    const swarmSize = officer.swarmSize || 100
    const isActive = officer.status === UnitStatus.ACTIVE
    const officerRadius = LAYOUT.nodeRadius[UnitRank.OFFICER]
    const swarmY = pos.y + 50
    const swarmWidth = 50
    const swarmHeight = 25

    // Seeded PRNG (mulberry32) for consistent random distribution
    const seededRandom = (seed) => {
      return () => {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
      }
    }
    const rand = seededRandom(officer.id.charCodeAt(officer.id.length - 1) * 9999)

    const dots = []
    const dotCount = Math.floor(swarmSize / 4)
    for (let i = 0; i < dotCount; i++) {
      const x = (rand() - 0.5) * swarmWidth
      const y = (rand() - 0.5) * swarmHeight
      dots.push({ x, y })
    }

    // Create a company object for the click handler
    const companyData = {
      id: `company-${officer.id}`,
      name: officer.company,
      rank: 'company',
      status: officer.status,
      swarmSize: swarmSize,
      commandingOfficer: officer.name,
      parentId: officer.id,
      stats: officer.stats
    }

    return (
      <g key={`swarm-${officer.id}`}>
        {/* Connection line from officer to swarm */}
        <line
          x1={pos.x}
          y1={pos.y + officerRadius}
          x2={pos.x}
          y2={swarmY - swarmHeight / 2}
          className={`connection-line ${isActive ? 'active' : ''}`}
        />

        {/* Swarm cloud - clickable */}
        <g
          transform={`translate(${pos.x}, ${swarmY})`}
          className="unit-node"
          style={{ cursor: 'pointer' }}
          onClick={() => onUnitClick?.(companyData)}
        >
          {/* Invisible hit area */}
          <rect
            x={-swarmWidth / 2 - 5}
            y={-swarmHeight / 2 - 5}
            width={swarmWidth + 10}
            height={swarmHeight + 25}
            fill="transparent"
          />
          {dots.map((dot, i) => (
            <circle
              key={i}
              cx={dot.x}
              cy={dot.y}
              r={2}
              fill={isActive ? '#5a8a5a' : '#3d5c3d'}
              opacity={isActive ? 0.8 : 0.5}
            />
          ))}
          {/* Company name label */}
          <text
            y={swarmHeight / 2 + 14}
            textAnchor="middle"
            className="unit-status-label"
            fill="#5a6a5a"
            fontSize="8"
          >
            {officer.company}
          </text>
        </g>
      </g>
    )
  }

  const renderUnit = (id) => {
    const unit = units.get(id)
    if (!unit) return null

    const pos = positions.get(id)
    if (!pos) return null

    const radius = LAYOUT.nodeRadius[unit.rank] || 15
    const statusClass = `unit-${unit.status}`
    const rankClass = `rank-${unit.rank}`

    return (
      <g
        key={id}
        className={`unit-node ${statusClass} ${rankClass}`}
        transform={`translate(${pos.x}, ${pos.y})`}
        onClick={() => onUnitClick?.(unit)}
      >
        {/* Active indicator ring */}
        {unit.status === UnitStatus.ACTIVE && (
          <circle
            r={radius + 3}
            fill="none"
            stroke="#5a8a5a"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
        )}

        {/* Main badge */}
        <circle
          className="unit-badge"
          r={radius}
          strokeWidth={2}
        />

        {/* Rank icon */}
        <RankIcon rank={unit.rank} x={0} y={0} size={radius} />

        {/* Label */}
        <text
          className="unit-label"
          y={radius + 12}
          textAnchor="middle"
        >
          {unit.name}
        </text>
      </g>
    )
  }

  return (
    <>
    <svg
      ref={svgRef}
      className="hierarchy-tree"
      viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
      preserveAspectRatio="xMidYMid meet"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
    >
      <defs>
        {/* Gradient for connections */}
        <linearGradient id="connectionGradient" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#4a5c3e" />
          <stop offset="100%" stopColor="#3a4c2e" />
        </linearGradient>

        {/* Glow filter */}
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Zoomable/pannable content */}
      <g transform={`translate(${bounds.x + bounds.width / 2 + pan.x}, ${bounds.y + bounds.height / 2 + pan.y}) scale(${zoom}) translate(${-(bounds.x + bounds.width / 2)}, ${-(bounds.y + bounds.height / 2)})`}>

      {/* Connection lines */}
      <g className="connections">
        {connections.map(conn => (
          <line
            key={conn.id}
            className={`connection-line ${conn.active ? 'active' : ''}`}
            x1={conn.x1}
            y1={conn.y1}
            x2={conn.x2}
            y2={conn.y2}
            strokeDasharray={conn.active ? '10 5' : 'none'}
          />
        ))}
      </g>

      {/* Dog connections (dashed lines to chief) */}
      <g className="dog-connections">
        {Array.from(units.values())
          .filter(u => u.rank === UnitRank.DOG)
          .map(dog => {
            const dogPos = positions.get(dog.id)
            const chiefPos = positions.get('chief')
            if (!dogPos || !chiefPos) return null

            return (
              <path
                key={`dog-conn-${dog.id}`}
                d={`M${chiefPos.x},${chiefPos.y + 30} Q${chiefPos.x},${dogPos.y - 50} ${dogPos.x},${dogPos.y - 15}`}
                className="connection-line"
                strokeDasharray="5 5"
                opacity={0.4}
              />
            )
          })}
      </g>

      {/* Swarms beneath officers */}
      <g className="swarms">
        {Array.from(units.values())
          .filter(u => u.rank === UnitRank.OFFICER)
          .map(officer => {
            const pos = positions.get(officer.id)
            return pos ? renderSwarm(officer, pos) : null
          })}
      </g>

      {/* Units by rank (render in order for proper layering) */}
      <g className="units">
        {/* Dogs */}
        {Array.from(units.keys())
          .filter(id => units.get(id)?.rank === UnitRank.DOG)
          .map(renderUnit)}

        {/* Officers */}
        {Array.from(units.keys())
          .filter(id => units.get(id)?.rank === UnitRank.OFFICER)
          .map(renderUnit)}

        {/* Generals */}
        {Array.from(units.keys())
          .filter(id => units.get(id)?.rank === UnitRank.GENERAL)
          .map(renderUnit)}

        {/* Chief (front) */}
        {renderUnit('chief')}
      </g>

      </g>{/* End zoomable content */}

    </svg>
    <div className="hierarchy-legend">
      <div className="hierarchy-legend-title">STATUS</div>
      <div className="hierarchy-legend-item">
        <span className="hierarchy-legend-dot dot-idle" />
        <span>Idle</span>
      </div>
      <div className="hierarchy-legend-item">
        <span className="hierarchy-legend-dot dot-active" />
        <span>Active</span>
      </div>
      <div className="hierarchy-legend-item">
        <span className="hierarchy-legend-dot dot-complete" />
        <span>Complete</span>
      </div>
      <div className="hierarchy-legend-item">
        <span className="hierarchy-legend-dot dot-failed" />
        <span>Failed</span>
      </div>
    </div>
    </>
  )
}
