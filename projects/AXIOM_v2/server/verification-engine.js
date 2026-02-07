// Verification engine — runs real tests and records evidence
import { addVerificationEntry, setCapabilityStage, recalcValueScore, saveState } from './state.js'
import { executeAnyToolCall, getAllModules } from './capabilities/registry.js'

export async function verifyCapability(state, statePath, capabilityId, valueId, verificationSpec) {
  console.log(`[Verify] Starting verification for ${capabilityId}`)

  setCapabilityStage(state, valueId, capabilityId, 'verifying')
  saveState(statePath, state)

  const startTime = Date.now()
  let success = false
  let evidence = ''

  try {
    // First, try the capability module's own verify() method
    const capModule = getAllModules().find(m => m.id === capabilityId)
    if (capModule && typeof capModule.verify === 'function') {
      console.log(`[Verify] Using ${capabilityId} module's own verify() method`)
      const result = await capModule.verify()
      success = result.operational
      evidence = result.evidence || ''
    }

    // If no module verify or it failed, try verificationSpec approaches
    if (!success) {
      // If verification spec has a test command (must look like a real command, not a description)
      if (verificationSpec.test && verificationSpec.test.length < 500 && !verificationSpec.test.includes('\n\n')) {
        const testResult = await executeAnyToolCall('exec_command', {
          command: verificationSpec.test
        })

        const testEvidence = typeof testResult === 'string' ? testResult : JSON.stringify(testResult)
        evidence += (evidence ? '\n' : '') + testEvidence
        success = !testEvidence.toLowerCase().includes('error') && !testEvidence.toLowerCase().includes('failed')
      }

      // If verification spec has an HTTP check
      if (verificationSpec.httpCheck) {
        const httpResult = await executeAnyToolCall('http_request', {
          url: verificationSpec.httpCheck.url,
          method: verificationSpec.httpCheck.method || 'GET'
        })

        const parsed = typeof httpResult === 'string' ? JSON.parse(httpResult) : httpResult
        evidence += `\nHTTP ${verificationSpec.httpCheck.url}: status ${parsed.status}`
        success = success || (parsed.status >= 200 && parsed.status < 400)
      }

      // If verification spec has a code check
      if (verificationSpec.codeCheck) {
        const codeResult = await executeAnyToolCall('run_code', {
          code: verificationSpec.codeCheck
        })
        evidence += `\nCode check: ${typeof codeResult === 'string' ? codeResult : JSON.stringify(codeResult)}`
        const parsed = typeof codeResult === 'string' ? JSON.parse(codeResult) : codeResult
        success = success || (!parsed.error)
      }
    }

    if (!evidence) {
      evidence = 'No automated verification defined — manual review required'
    }

  } catch (err) {
    evidence = `Verification error: ${err.message}`
    success = false
  }

  const duration = Date.now() - startTime
  const stage = success ? 'verified' : 'implemented'

  setCapabilityStage(state, valueId, capabilityId, stage, {
    evidence: evidence.slice(0, 2000),
    verifiedAt: success ? new Date().toISOString() : null
  })

  addVerificationEntry(state, {
    capabilityId,
    valueId,
    success,
    evidence: evidence.slice(0, 2000),
    durationMs: duration
  })

  recalcValueScore(state, valueId)
  saveState(statePath, state)

  console.log(`[Verify] ${capabilityId}: ${success ? 'VERIFIED' : 'FAILED'} (${duration}ms)`)

  return { success, evidence: evidence.slice(0, 2000), durationMs: duration }
}
