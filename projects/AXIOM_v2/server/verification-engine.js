// Verification engine — runs real tests and records evidence
import { addVerificationEntry, setCapabilityStage, recalcValueScore, saveState } from './state.js'
import { executeAnyToolCall, getAllModules } from './capabilities/registry.js'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

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

    // Supplementary evidence only — these NEVER flip success, only the module's
    // own verify() determines pass/fail. This prevents OR-gate false positives.
    const testCmd = verificationSpec.smokeTest || verificationSpec.test
    if (testCmd && testCmd.length < 200 && !testCmd.includes('\n\n')) {
      try {
        const testResult = await executeAnyToolCall('exec_command', { command: testCmd })
        const testEvidence = typeof testResult === 'string' ? testResult : JSON.stringify(testResult)
        evidence += (evidence ? '\n' : '') + `[smokeTest] ${testEvidence}`
      } catch (e) {
        evidence += (evidence ? '\n' : '') + `[smokeTest] error: ${e.message}`
      }
    }

    if (verificationSpec.httpCheck) {
      try {
        const httpResult = await executeAnyToolCall('http_request', {
          url: verificationSpec.httpCheck.url,
          method: verificationSpec.httpCheck.method || 'GET'
        })
        const parsed = typeof httpResult === 'string' ? JSON.parse(httpResult) : httpResult
        evidence += `\n[httpCheck] ${verificationSpec.httpCheck.url}: status ${parsed.status}`
      } catch (e) {
        evidence += `\n[httpCheck] error: ${e.message}`
      }
    }

    if (verificationSpec.codeCheck) {
      try {
        const codeResult = await executeAnyToolCall('run_code', { code: verificationSpec.codeCheck })
        evidence += `\n[codeCheck] ${typeof codeResult === 'string' ? codeResult : JSON.stringify(codeResult)}`
      } catch (e) {
        evidence += `\n[codeCheck] error: ${e.message}`
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

/**
 * Deploy verification — checks that a capability's external deps exist in the
 * baseline package.json (the version that deploy will sync). Catches deps the
 * implementer installed ad-hoc that won't survive npm ci after deploy.
 *
 * @param {string} capabilityId
 * @param {object} baselinePackageJson - package.json snapshot from before implement ran
 * @returns {{ success: boolean, evidence: string, missingDeps: string[] }}
 */
export function deployVerifyCapability(capabilityId, baselinePackageJson) {
  console.log(`[Verify] Deploy-verify starting for ${capabilityId}`)

  const capPath = resolve(__dirname, `capabilities/${capabilityId}.js`)
  if (!existsSync(capPath)) {
    return { success: false, evidence: `Capability file not found: ${capPath}`, missingDeps: [] }
  }

  const source = readFileSync(capPath, 'utf-8')

  // Extract external package imports (static + dynamic, skip relative and node: builtins)
  const externalDeps = new Set()
  const staticRe = /import\s+[\s\S]*?from\s+['"]([^'"./][^'"]*)['"]/g
  const dynamicRe = /import\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g

  for (const re of [staticRe, dynamicRe]) {
    let m
    while ((m = re.exec(source)) !== null) {
      const pkg = m[1].startsWith('@')
        ? m[1].split('/').slice(0, 2).join('/')
        : m[1].split('/')[0]
      if (!pkg.startsWith('node:')) externalDeps.add(pkg)
    }
  }

  if (externalDeps.size === 0) {
    console.log(`[Verify] Deploy-verify ${capabilityId}: PASSED — no external deps`)
    return { success: true, evidence: 'No external dependencies — deploy-safe', missingDeps: [] }
  }

  const baseDeps = { ...baselinePackageJson.dependencies || {}, ...baselinePackageJson.devDependencies || {} }
  const missingDeps = [...externalDeps].filter(d => !baseDeps[d])

  if (missingDeps.length > 0) {
    const evidence = `DEPLOY VERIFICATION FAILED: Capability imports [${missingDeps.join(', ')}] but these are not in server/package.json. After deploy, npm ci will not install them and the capability will fail to load. The implementer must add them to package.json.`
    console.log(`[Verify] Deploy-verify ${capabilityId}: FAILED — missing deps: ${missingDeps.join(', ')}`)
    return { success: false, evidence, missingDeps }
  }

  console.log(`[Verify] Deploy-verify ${capabilityId}: PASSED — all deps in package.json: ${[...externalDeps].join(', ')}`)
  return { success: true, evidence: `All external deps [${[...externalDeps].join(', ')}] present in package.json`, missingDeps: [] }
}

/**
 * Cold subprocess verification — spawns a fresh Node process to import the
 * capability module and run verify(). Fresh V8 context, no warm module cache.
 * This catches modules that only work in-process due to cache or shared state.
 *
 * @param {string} capabilityId
 * @returns {{ success: boolean, evidence: string }}
 */
export function coldVerifyCapability(capabilityId) {
  console.log(`[Verify] Cold-verify starting for ${capabilityId}`)

  const capPath = resolve(__dirname, `capabilities/${capabilityId}.js`)
  if (!existsSync(capPath)) {
    return { success: false, evidence: `Cold verify FAILED: file not found — ${capPath}` }
  }

  // Use process.execPath so the subprocess uses the SAME Node binary as the
  // running server (nvm v22 under PM2), not whatever bare `node` resolves to.
  const nodeBin = process.execPath
  const cmd = `"${nodeBin}" -e "import('dotenv').then(d=>d.config()).catch(()=>{}).then(()=>import('./capabilities/${capabilityId}.js')).then(m=>(m.default||m).verify()).then(r=>{console.log(JSON.stringify(r));if(!r.operational)process.exit(1)}).catch(e=>{console.error(e.message);process.exit(1)})"`

  try {
    const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: __dirname })
    const result = JSON.parse(stdout.trim())

    if (!result.operational) {
      return { success: false, evidence: `Cold verify FAILED: ${result.evidence || 'not operational'}` }
    }

    if (!result.evidence || result.evidence.length < 10) {
      return { success: false, evidence: `Cold verify FAILED: trivial evidence (${JSON.stringify(result.evidence)})` }
    }

    console.log(`[Verify] Cold-verify ${capabilityId}: PASSED`)
    return { success: true, evidence: `Cold verify PASSED: ${result.evidence}` }
  } catch (err) {
    const detail = (err.stderr || err.message || '').slice(0, 500)
    console.log(`[Verify] Cold-verify ${capabilityId}: FAILED — ${detail}`)
    return { success: false, evidence: `Cold verify FAILED: ${detail}` }
  }
}
