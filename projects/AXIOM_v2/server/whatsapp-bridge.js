// WhatsApp bridge via moltbot gateway on same VPS
import { writeFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'

const MOLTBOT_PHONE = '+447702188120'

export async function sendProposalToUser(proposal) {
  const message = formatProposalMessage(proposal)
  return sendToUser(message)
}

export async function sendToUser(message) {
  const tmpFile = `/tmp/axiom2-msg-${Date.now()}.txt`

  try {
    writeFileSync(tmpFile, message)
    execSync(
      `ssh root@localhost "su - moltbot -c 'cd ~/moltbot && cat ${tmpFile} | node scripts/run-node.mjs agent --agent haiku --to ${MOLTBOT_PHONE} --channel whatsapp --deliver'"`,
      { timeout: 30000, encoding: 'utf-8' }
    )
    console.log(`[WhatsApp] Sent message (${message.length} chars)`)
    return { success: true }
  } catch (err) {
    console.error(`[WhatsApp] Failed to send: ${err.message}`)
    return { success: false, error: err.message }
  } finally {
    try { unlinkSync(tmpFile) } catch {}
  }
}

function formatProposalMessage(proposal) {
  return `AXIOM v2 PROPOSAL: ${proposal.title}

Capability: ${proposal.capabilityId}
Value: ${proposal.valueId}
Risk: ${proposal.risk}

${proposal.description}

Verification: ${proposal.verification?.test || 'N/A'}
Est. tokens: ${proposal.implementation?.estimatedTokens || 'unknown'}

Reply YES to approve or NO to reject.
Proposal ID: ${proposal.id}

Dashboard: https://axiom.hjd.ai`
}

export function parseWhatsAppReply(text) {
  const upper = (text || '').trim().toUpperCase()

  if (upper.startsWith('YES')) {
    return { action: 'approve' }
  }
  if (upper.startsWith('NO')) {
    const reason = text.trim().slice(2).trim() || 'Rejected via WhatsApp'
    return { action: 'reject', reason }
  }

  return { action: 'unknown' }
}
