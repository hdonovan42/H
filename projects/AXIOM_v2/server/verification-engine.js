// Verification engine — runs real tests and records evidence
import { addVerificationEntry, setCapabilityStage, recalcValueScore, saveState } from './state.js'
import { executeAnyToolCall, getAllModules } from './capabilities/registry.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function verifyCapability(state, statePath, capabilityId, valueId, verificationSpec) {
  console.log(`[Verify] Starting verification for ${capabilityId}`)

  setCapabilityStage(state, valueId, capabilityId, 'verifying')
  saveState(statePath, state)

  const startTime = Date.now()
  let success = false
  let evidence = ''

  try {
    // First, try the capability module's own verify() method
    let capModule = getAllModules().find(m => m.id === capabilityId)

    // If not found in registry, try dynamic import as fallback
    if (!capModule || typeof capModule.verify !== 'function') {
      const capPath = resolve(__dirname, `capabilities/${capabilityId}.js`)
      if (existsSync(capPath)) {
        try {
          console.log(`[Verify] Registry miss — attempting dynamic import of ${capabilityId}.js`)
          const dynamicMod = await import(capPath)
          capModule = dynamicMod.default || dynamicMod
        } catch (importErr) {
          console.log(`[Verify] Dynamic import failed for ${capabilityId}: ${importErr.message}`)
        }
      }
    }

    if (capModule && typeof capModule.verify === 'function') {
      console.log(`[Verify] Using ${capabilityId} module's own verify() method`)
      const result = await capModule.verify()
      success = result.operational
      evidence = result.evidence || ''
    }

    // If no module verify or it failed, try verificationSpec approaches
    if (!success) {
      // Accept both smokeTest and test fields
      const testCmd = verificationSpec.smokeTest || verificationSpec.test

      if (testCmd && testCmd.length < 200 && !testCmd.includes('\n\n')) {
        // Looks like an executable command
        const testResult = await executeAnyToolCall('exec_command', {
          command: testCmd
        })

        const testEvidence = typeof testResult === 'string' ? testResult : JSON.stringify(testResult)
        evidence += (evidence ? '\n' : '') + testEvidence
        success = !testEvidence.toLowerCase().includes('error') && !testEvidence.toLowerCase().includes('failed')
      } else if (testCmd) {
        // Too long or prose — log warning and skip
        const reason = testCmd.length >= 200 ? 'too long' : 'looks like prose'
        console.log(`[Verify] Skipping test spec for ${capabilityId}: ${reason} (${testCmd.length} chars)`)
        evidence += (evidence ? '\n' : '') + `Smoke test skipped (${reason})`
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
      evidence = 'No automated verification ran — no verify() method found and no executable smokeTest provided'
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
