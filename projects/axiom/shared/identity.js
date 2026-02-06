// AXIOM Shared Identity Config — Single Source of Truth
// Imported by both server/ and src/ (ESM throughout)

export const DIRECTORS = {
  'dir-research': {
    name: 'Acquisitions Director',
    shortName: 'Acquisitions',
    specialty: 'Literature mining, taxonomy building, knowledge synthesis, paper analysis, data exploration',
    keywords: ['search', 'literature', 'taxonomy', 'read', 'paper', 'analyse', 'analyze', 'find', 'gather', 'review', 'mine', 'explore', 'discover']
  },
  'dir-strategy': {
    name: 'Strategy Director',
    shortName: 'Strategy',
    specialty: 'Session planning, priority assessment, risk evaluation, hypothesis ranking, feasibility analysis',
    keywords: ['plan', 'prioritise', 'prioritize', 'assess', 'schedule', 'evaluate', 'strategy', 'rank', 'feasibility', 'design', 'organize']
  },
  'dir-experiment': {
    name: 'Experiment Director',
    shortName: 'Experiment',
    specialty: 'Hypothesis testing, actuator acquisition, capability verification, experiment execution',
    keywords: ['test', 'hypothesis', 'acquire', 'execute', 'verify', 'implement', 'experiment', 'build', 'run', 'code', 'deploy']
  }
}

export const DEFAULT_DIRECTOR = 'dir-research'

export const RANKS = {
  chief:   { model: 'user',   displayName: 'User',   cost: 0 },
  general: { model: 'opus',   displayName: 'Opus',   cost: 'high' },
  officer: { model: 'sonnet', displayName: 'Sonnet', cost: 'medium' },
  soldier: { model: 'haiku',  displayName: 'Haiku',  cost: 'low' },
  dog:     { model: 'haiku',  displayName: 'Haiku',  cost: 'low' }
}

export const ANALYSTS = {
  'dir-research': [
    { name: 'Analyst Alpha',   team: 'Acquisitions Team A', swarmSize: 120 },
    { name: 'Analyst Bravo',   team: 'Acquisitions Team B', swarmSize: 95 }
  ],
  'dir-strategy': [
    { name: 'Analyst Charlie', team: 'Strategy Team A', swarmSize: 110 },
    { name: 'Analyst Delta',   team: 'Strategy Team B', swarmSize: 85 }
  ],
  'dir-experiment': [
    { name: 'Analyst Echo',    team: 'Experiment Team A', swarmSize: 150 },
    { name: 'Analyst Foxtrot', team: 'Experiment Team B', swarmSize: 130 }
  ]
}

export const SUPPORT_AGENTS = [
  { id: 'dog-logger',  name: 'Support: Recon' },
  { id: 'dog-cleanup', name: 'Support: Synthesis' },
  { id: 'dog-monitor', name: 'Support: Monitor' }
]
