// Proposal CRUD + approval lifecycle
import { saveState } from './state.js'

let proposalCounter = 0

export function createProposal(state, statePath, { capabilityId, valueId, title, description, justification, implementation, verification, dependencies, risk, learnerFindings }) {
  proposalCounter++
  const id = `prop-${String(proposalCounter).padStart(3, '0')}`

  const proposal = {
    id,
    capabilityId,
    valueId,
    title,
    description,
    justification: justification || null,
    implementation: implementation || {},
    verification: verification || {},
    dependencies: dependencies || [],
    risk: risk || 'medium',
    learnerFindings: learnerFindings || null,
    status: 'pending_approval',
    createdAt: new Date().toISOString(),
    approvedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    verifiedAt: null
  }

  if (!state.proposals) state.proposals = []
  state.proposals.push(proposal)
  saveState(statePath, state)

  console.log(`[Proposals] Created ${id}: "${title}" (${capabilityId})`)
  return proposal
}

export function approveProposal(state, statePath, proposalId) {
  const proposal = state.proposals.find(p => p.id === proposalId)
  if (!proposal) return { success: false, error: `Proposal ${proposalId} not found` }
  if (proposal.status !== 'pending_approval') {
    return { success: false, error: `Proposal ${proposalId} is ${proposal.status}, not pending_approval` }
  }

  proposal.status = 'approved'
  proposal.approvedAt = new Date().toISOString()
  saveState(statePath, state)

  console.log(`[Proposals] Approved ${proposalId}: "${proposal.title}"`)
  return { success: true, proposal }
}

export function rejectProposal(state, statePath, proposalId, reason) {
  const proposal = state.proposals.find(p => p.id === proposalId)
  if (!proposal) return { success: false, error: `Proposal ${proposalId} not found` }
  if (proposal.status !== 'pending_approval') {
    return { success: false, error: `Proposal ${proposalId} is ${proposal.status}, not pending_approval` }
  }

  proposal.status = 'rejected'
  proposal.rejectedAt = new Date().toISOString()
  proposal.rejectedReason = reason || 'No reason given'
  saveState(statePath, state)

  console.log(`[Proposals] Rejected ${proposalId}: "${proposal.title}" — ${reason}`)
  return { success: true, proposal }
}

export function getPendingProposals(state) {
  return (state.proposals || []).filter(p => p.status === 'pending_approval')
}

export function getApprovedProposals(state) {
  return (state.proposals || []).filter(p => p.status === 'approved')
}

export function getProposal(state, proposalId) {
  return (state.proposals || []).find(p => p.id === proposalId) || null
}

export function getAllProposals(state) {
  return state.proposals || []
}

// Sync counter with existing proposals on startup
export function initProposalCounter(state) {
  const existing = state.proposals || []
  if (existing.length > 0) {
    const maxNum = Math.max(...existing.map(p => {
      const match = p.id.match(/prop-(\d+)/)
      return match ? parseInt(match[1]) : 0
    }))
    proposalCounter = maxNum
  }
}
