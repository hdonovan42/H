// AgentSimulator.js - AXIOM fork
// Core simulation engine for actuator research agent orchestration

export const UnitStatus = {
  IDLE: 'idle',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ESCALATING: 'escalating',
  AWAITING_INPUT: 'awaiting'
}

export const UnitRank = {
  CHIEF: 'chief',
  GENERAL: 'general',
  OFFICER: 'officer',
  SOLDIER: 'soldier',
  DOG: 'dog'
}

export const MessageType = {
  ORDER: 'order',
  REPORT: 'report',
  ALERT: 'alert',
  INFO: 'info',
  ESCALATE: 'escalate'
}

// Model configuration per rank tier
export const MODEL_CONFIG = {
  [UnitRank.CHIEF]: { model: 'user', displayName: 'User', cost: 0 },
  [UnitRank.GENERAL]: { model: 'opus', displayName: 'Opus', cost: 'high' },
  [UnitRank.OFFICER]: { model: 'sonnet', displayName: 'Sonnet', cost: 'medium' },
  [UnitRank.SOLDIER]: { model: 'haiku', displayName: 'Haiku', cost: 'low' },
  [UnitRank.DOG]: { model: 'haiku', displayName: 'Haiku', cost: 'low' }
}

// AXIOM routing keywords
const ROUTING_CONFIG = {
  'dir-research': {
    name: 'Research',
    keywords: ['search', 'literature', 'taxonomy', 'read', 'paper', 'analyse', 'analyze', 'find', 'gather', 'review', 'mine', 'explore', 'discover'],
    priority: 1
  },
  'dir-strategy': {
    name: 'Strategy',
    keywords: ['plan', 'prioritise', 'prioritize', 'assess', 'schedule', 'evaluate', 'strategy', 'rank', 'feasibility', 'design', 'organize'],
    priority: 2
  },
  'dir-experiment': {
    name: 'Experiment',
    keywords: ['test', 'hypothesis', 'acquire', 'execute', 'verify', 'implement', 'experiment', 'build', 'run', 'code', 'deploy'],
    priority: 3
  }
}

function routeTask(taskMessage) {
  const lowerMessage = taskMessage.toLowerCase()
  let bestMatch = { id: null, score: 0, name: null, matchedKeywords: [] }

  for (const [directorId, config] of Object.entries(ROUTING_CONFIG)) {
    const matchedKeywords = config.keywords.filter(kw => lowerMessage.includes(kw))
    const score = matchedKeywords.length
    if (score > bestMatch.score) {
      bestMatch = { id: directorId, score, name: config.name, matchedKeywords }
    }
  }

  if (!bestMatch.id) {
    bestMatch = { id: 'dir-research', score: 0, name: 'Research', matchedKeywords: ['(default)'] }
  }

  return bestMatch
}

export function createUnit(id, name, rank, parentId = null) {
  return {
    id,
    name,
    rank,
    parentId,
    status: UnitStatus.IDLE,
    currentTask: null,
    childrenIds: [],
    stats: {
      tasksCompleted: 0,
      tasksFailed: 0,
      tokensUsed: 0
    }
  }
}

export function createMessage(type, sourceId, targetId, content, details = null) {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: Date.now(),
    type,
    sourceId,
    targetId,
    content,
    details
  }
}

export class AgentSimulator {
  constructor(config = {}) {
    this.mode = config.mode || 'simulation'
    this.apiAdapter = config.apiAdapter || null
    this.speedMultiplier = config.speedMultiplier || 1

    this.units = new Map()
    this.messages = []
    this.listeners = new Set()
    this.isRunning = false
    this.isPaused = false
    this.currentScenario = null
    this.taskQueue = []
    this.completedTasks = 0
    this.totalTasks = 0
    this.pendingEscalation = null
    this.escalationResolvers = new Map()

    this.missionId = null
    this.missionContext = new Map()

    this.initializeHierarchy()
  }

  initializeHierarchy() {
    // AXIOM Core (user)
    const core = createUnit('chief', 'AXIOM Core', UnitRank.CHIEF)
    this.units.set('chief', core)

    // Directors (Opus tier)
    const directors = [
      createUnit('dir-research', 'Research Director', UnitRank.GENERAL, 'chief'),
      createUnit('dir-strategy', 'Strategy Director', UnitRank.GENERAL, 'chief'),
      createUnit('dir-experiment', 'Experiment Director', UnitRank.GENERAL, 'chief')
    ]

    directors.forEach(d => {
      this.units.set(d.id, d)
      core.childrenIds.push(d.id)
    })

    // Analysts (Sonnet tier) under each Director
    const analystConfigs = [
      { parentId: 'dir-research', analysts: [
        { name: 'Analyst Alpha', company: 'Research Team A', swarmSize: 120 },
        { name: 'Analyst Bravo', company: 'Research Team B', swarmSize: 95 }
      ]},
      { parentId: 'dir-strategy', analysts: [
        { name: 'Analyst Charlie', company: 'Strategy Team A', swarmSize: 110 },
        { name: 'Analyst Delta', company: 'Strategy Team B', swarmSize: 85 }
      ]},
      { parentId: 'dir-experiment', analysts: [
        { name: 'Analyst Echo', company: 'Experiment Team A', swarmSize: 150 },
        { name: 'Analyst Foxtrot', company: 'Experiment Team B', swarmSize: 130 }
      ]}
    ]

    let analystIndex = 0
    analystConfigs.forEach(config => {
      const parent = this.units.get(config.parentId)
      config.analysts.forEach(({ name, company, swarmSize }) => {
        const analyst = createUnit(`officer-${analystIndex}`, name, UnitRank.OFFICER, config.parentId)
        analyst.company = company
        analyst.swarmSize = swarmSize
        analyst.activeWorkers = 0
        this.units.set(analyst.id, analyst)
        parent.childrenIds.push(analyst.id)
        analystIndex++
      })
    })

    // Support agents (Haiku tier)
    const support = [
      createUnit('dog-logger', 'Support: Recon', UnitRank.DOG, 'chief'),
      createUnit('dog-cleanup', 'Support: Synthesis', UnitRank.DOG, 'chief'),
      createUnit('dog-monitor', 'Support: Monitor', UnitRank.DOG, 'chief')
    ]

    support.forEach(s => {
      this.units.set(s.id, s)
      core.childrenIds.push(s.id)
    })
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify() {
    this.listeners.forEach(listener => listener(this.getState()))
  }

  getState() {
    return {
      units: new Map(this.units),
      messages: [...this.messages],
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      completedTasks: this.completedTasks,
      totalTasks: this.totalTasks,
      currentScenario: this.currentScenario,
      pendingEscalation: this.pendingEscalation
    }
  }

  getUnit(id) {
    return this.units.get(id)
  }

  updateUnit(id, updates) {
    const unit = this.units.get(id)
    if (unit) {
      Object.assign(unit, updates)
      this.notify()
    }
  }

  addMessage(message) {
    this.messages.push(message)
    this.notify()
  }

  updateMessage(messageId, contentUpdate) {
    const msg = this.messages.find(m => m.id === messageId)
    if (msg) {
      Object.assign(msg, contentUpdate)
      this.notify()
    }
  }

  setMode(mode, adapter = null) {
    this.mode = mode
    this.apiAdapter = adapter
  }

  getMode() {
    return this.mode
  }

  setSpeed(multiplier) {
    this.speedMultiplier = multiplier
  }

  getDelay(baseDelay) {
    return baseDelay / this.speedMultiplier
  }

  _buildPreviousContext(unitId) {
    const unit = this.units.get(unitId)
    if (!unit) return ''

    const contextParts = []

    if (unit.rank === UnitRank.GENERAL) {
      for (const childId of unit.childrenIds) {
        const childResult = this.missionContext.get(childId)
        if (childResult) {
          const child = this.units.get(childId)
          contextParts.push(`[${child?.name || childId}]: ${childResult}`)
        }
      }
    }

    if (unit.rank === UnitRank.OFFICER && unit.parentId) {
      const parentResult = this.missionContext.get(unit.parentId)
      if (parentResult) {
        const parent = this.units.get(unit.parentId)
        contextParts.push(`[${parent?.name || unit.parentId}]: ${parentResult}`)
      }
    }

    return contextParts.join('\n\n')
  }

  async start(scenario) {
    if (this.isRunning) return

    this.reset()
    this.isRunning = true
    this.currentScenario = scenario

    this.missionId = `session-${Date.now()}`
    this.missionContext.clear()

    if (this.mode === 'real' && this.apiAdapter) {
      this.apiAdapter.startMission(this.missionId, scenario.objective || scenario.description)
    }

    this.notify()

    try {
      await this.runScenario(scenario)
    } catch (error) {
      console.error('Session error:', error)
      this.addMessage(createMessage(
        MessageType.ALERT,
        'chief',
        null,
        `Session failed: ${error.message}`
      ))
    }

    this.isRunning = false
    this.notify()
  }

  pause() {
    this.isPaused = true
    this.notify()
  }

  resume() {
    this.isPaused = false
    this.notify()
  }

  reset() {
    this.isRunning = false
    this.isPaused = false
    this.messages = []
    this.taskQueue = []
    this.completedTasks = 0
    this.totalTasks = 0
    this.currentScenario = null
    this.pendingEscalation = null
    this.escalationResolvers.clear()
    this.missionId = null
    this.missionContext.clear()

    this.units.forEach(unit => {
      unit.status = UnitStatus.IDLE
      unit.currentTask = null
      unit.stats = { tasksCompleted: 0, tasksFailed: 0, tokensUsed: 0 }
    })

    this.notify()
  }

  async wait(ms) {
    const adjustedMs = this.getDelay(ms)
    const startTime = Date.now()

    while (Date.now() - startTime < adjustedMs) {
      if (!this.isRunning) throw new Error('Session stopped')

      while (this.isPaused && this.isRunning) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      await new Promise(resolve => setTimeout(resolve, Math.min(50, adjustedMs - (Date.now() - startTime))))
    }
  }

  async executeTask(unit, task) {
    if (this.mode === 'real' && this.apiAdapter) {
      task.missionId = this.missionId
      task.previousContext = task.previousContext || this._buildPreviousContext(unit.id)

      this.updateUnit(unit.id, {
        status: UnitStatus.ACTIVE,
        currentTask: task.description
      })

      const streamMsgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const streamMsg = {
        id: streamMsgId,
        timestamp: Date.now(),
        type: MessageType.INFO,
        sourceId: unit.id,
        targetId: null,
        content: '',
        streaming: true
      }
      this.messages.push(streamMsg)
      this.notify()

      const result = await this.apiAdapter.executeStream(
        unit,
        task,
        (delta, fullText) => {
          this.updateMessage(streamMsgId, { content: fullText })
        },
        (toolName, input) => {
          this.addMessage(createMessage(
            MessageType.INFO,
            unit.id,
            null,
            `[Tool: ${toolName}] ${input?.query || JSON.stringify(input)}`
          ))
        }
      )

      this.updateMessage(streamMsgId, {
        content: result.result || result.error || 'No response',
        streaming: false
      })

      if (result.success) {
        this.updateUnit(unit.id, { status: UnitStatus.COMPLETED, currentTask: null })
        unit.stats.tasksCompleted++
        unit.stats.tokensUsed += result.tokens || 0
        this.missionContext.set(unit.id, result.result)
      } else {
        this.updateUnit(unit.id, { status: UnitStatus.FAILED, currentTask: null })
        unit.stats.tasksFailed++
      }

      return result
    }

    return this.simulateExecution(unit, task)
  }

  async simulateExecution(unit, task) {
    this.updateUnit(unit.id, {
      status: UnitStatus.ACTIVE,
      currentTask: task.description
    })

    const workTime = task.duration || (500 + Math.random() * 1500)
    await this.wait(workTime)

    const shouldFail = task.shouldFail || Math.random() < 0.05

    if (shouldFail) {
      this.updateUnit(unit.id, {
        status: UnitStatus.FAILED,
        currentTask: null
      })
      unit.stats.tasksFailed++
      return { success: false, error: 'Task failed' }
    }

    this.updateUnit(unit.id, {
      status: UnitStatus.COMPLETED,
      currentTask: null
    })
    unit.stats.tasksCompleted++
    unit.stats.tokensUsed += task.tokens || Math.floor(100 + Math.random() * 400)

    const resultText = task.result || `Completed: ${task.description}`
    this.missionContext.set(unit.id, resultText)

    return {
      success: true,
      result: resultText
    }
  }

  async runScenario(scenario) {
    this.totalTasks = scenario.tasks?.length || 0

    for (const step of scenario.steps) {
      if (!this.isRunning) break
      await this.executeStep(step)
    }

    this.updateUnit('chief', { status: UnitStatus.COMPLETED })
    this.addMessage(createMessage(
      MessageType.REPORT,
      'chief',
      null,
      `Session "${scenario.name}" completed.`
    ))
  }

  async executeStep(step) {
    switch (step.type) {
      case 'order':
        await this.handleOrder(step)
        break
      case 'delegate':
        await this.handleDelegation(step)
        break
      case 'execute':
        await this.handleExecution(step)
        break
      case 'report':
        await this.handleReport(step)
        break
      case 'parallel':
        await this.handleParallel(step)
        break
      case 'dogTask':
        await this.handleDogTask(step)
        break
      case 'swarm':
        await this.handleSwarm(step)
        break
      case 'escalate':
        await this.handleEscalation(step)
        break
      default:
        console.warn('Unknown step type:', step.type)
    }
  }

  async handleOrder(step) {
    let targetId = step.to
    let routingInfo = null

    if (step.to === 'auto') {
      if (this.mode === 'real' && this.apiAdapter) {
        const llmRoute = await this.apiAdapter.route(step.message)
        if (llmRoute) {
          routingInfo = {
            id: llmRoute.generalId,
            name: this.units.get(llmRoute.generalId)?.name || llmRoute.generalId,
            matchedKeywords: [llmRoute.reasoning],
            llmRouted: llmRoute.llmRouted,
            confidence: llmRoute.confidence
          }
          targetId = llmRoute.generalId
        } else {
          routingInfo = routeTask(step.message)
          targetId = routingInfo.id
        }
      } else {
        routingInfo = routeTask(step.message)
        targetId = routingInfo.id
      }
    }

    this.updateUnit(step.from, { status: UnitStatus.ACTIVE })

    if (routingInfo) {
      const routeMethod = routingInfo.llmRouted ? 'LLM' : 'Keywords'
      const detail = routingInfo.llmRouted
        ? routingInfo.matchedKeywords[0]
        : `matched: ${routingInfo.matchedKeywords.join(', ')}`
      const confidence = routingInfo.confidence
        ? ` (${Math.round(routingInfo.confidence * 100)}%)`
        : ''

      this.addMessage(createMessage(
        MessageType.INFO,
        step.from,
        null,
        `[Routing: ${routeMethod}] Task assigned to ${routingInfo.name}${confidence} — ${detail}`
      ))
      await this.wait(300)
    }

    this.addMessage(createMessage(
      MessageType.ORDER,
      step.from,
      targetId,
      step.message
    ))

    await this.wait(step.delay || 500)

    this.updateUnit(step.from, { status: UnitStatus.IDLE })
    this.updateUnit(targetId, { status: UnitStatus.ACTIVE, currentTask: step.message })
  }

  async handleDelegation(step) {
    this.addMessage(createMessage(
      MessageType.ORDER,
      step.from,
      null,
      `Delegating tasks to analysts: ${step.tasks.join(', ')}`
    ))

    await this.wait(step.delay || 300)

    step.targets.forEach(targetId => {
      this.updateUnit(targetId, { status: UnitStatus.ACTIVE })
    })
  }

  async handleExecution(step) {
    const unit = this.units.get(step.unitId)

    const result = await this.executeTask(unit, {
      description: step.task,
      duration: step.duration,
      tokens: step.tokens,
      shouldFail: step.shouldFail,
      result: step.result,
      tools: step.tools,
      context: step.context
    })

    if (result.success) {
      this.completedTasks++
    }

    if (this.mode !== 'real' || !this.apiAdapter) {
      this.addMessage(createMessage(
        result.success ? MessageType.INFO : MessageType.ALERT,
        step.unitId,
        null,
        result.success ? result.result : `Failed: ${step.task}`
      ))
    }

    this.notify()
  }

  async handleReport(step) {
    this.updateUnit(step.from, { status: UnitStatus.COMPLETED })

    this.addMessage(createMessage(
      MessageType.REPORT,
      step.from,
      step.to,
      step.message
    ))

    await this.wait(step.delay || 400)
  }

  async handleParallel(step) {
    await Promise.all(step.steps.map(s => this.executeStep(s)))
  }

  async handleDogTask(step) {
    this.updateUnit(step.dogId, { status: UnitStatus.ACTIVE, currentTask: step.task })

    this.addMessage(createMessage(
      MessageType.INFO,
      step.dogId,
      null,
      `[Support] ${step.task}`
    ))

    await this.wait(step.duration || 800)

    this.updateUnit(step.dogId, { status: UnitStatus.COMPLETED })
  }

  async handleSwarm(step) {
    const officer = this.units.get(step.officerId)
    if (!officer) return

    const workersDeployed = step.workersDeployed || officer.swarmSize || 100

    this.updateUnit(step.officerId, {
      status: UnitStatus.ACTIVE,
      currentTask: step.task,
      activeWorkers: workersDeployed
    })

    this.addMessage(createMessage(
      MessageType.ORDER,
      step.officerId,
      null,
      `Deploying ${workersDeployed} workers: ${step.task}`
    ))

    let resultText = step.result || 'Task complete'
    let tokensUsed = step.tokens || Math.floor(200 + Math.random() * 500)

    if (this.mode === 'real' && this.apiAdapter) {
      const streamMsgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      const streamMsg = {
        id: streamMsgId,
        timestamp: Date.now(),
        type: MessageType.INFO,
        sourceId: step.officerId,
        targetId: null,
        content: '',
        streaming: true
      }
      this.messages.push(streamMsg)
      this.notify()

      const result = await this.apiAdapter.executeStream(
        officer,
        {
          description: step.task,
          context: step.context || '',
          tools: step.tools,
          missionId: this.missionId,
          previousContext: this._buildPreviousContext(officer.id)
        },
        (delta, fullText) => {
          this.updateMessage(streamMsgId, { content: fullText })
        },
        (toolName, input) => {
          this.addMessage(createMessage(
            MessageType.INFO,
            step.officerId,
            null,
            `[Tool: ${toolName}] ${input?.query || JSON.stringify(input)}`
          ))
        }
      )

      if (result.success) {
        resultText = result.result
        tokensUsed = result.tokens || 0
        this.missionContext.set(officer.id, resultText)
      } else {
        resultText = `[API Error] ${result.error}`
      }

      this.updateMessage(streamMsgId, {
        content: resultText,
        streaming: false
      })
    } else {
      await this.wait(step.duration || 1500)
      this.missionContext.set(officer.id, resultText)
    }

    officer.stats.tasksCompleted++
    officer.stats.tokensUsed += tokensUsed

    this.updateUnit(step.officerId, {
      status: UnitStatus.COMPLETED,
      currentTask: null,
      activeWorkers: 0
    })

    if (this.mode !== 'real' || !this.apiAdapter) {
      this.addMessage(createMessage(
        MessageType.INFO,
        step.officerId,
        null,
        `${workersDeployed} workers returned: ${resultText}`
      ))
    }

    this.completedTasks++
    this.notify()
  }

  async handleEscalation(step) {
    const unit = this.units.get(step.unitId)
    if (!unit) return

    const unitConfig = MODEL_CONFIG[unit.rank]

    this.updateUnit(step.unitId, {
      status: UnitStatus.ESCALATING,
      currentTask: step.problem
    })

    this.addMessage(createMessage(
      MessageType.ESCALATE,
      step.unitId,
      unit.parentId,
      `[${unitConfig.displayName}] Cannot resolve: ${step.problem}`,
      { model: unitConfig.model, cost: unitConfig.cost }
    ))

    await this.wait(step.delay || 600)

    const parentId = step.escalateTo || unit.parentId
    const parent = this.units.get(parentId)

    if (!parent) {
      this.updateUnit(step.unitId, { status: UnitStatus.FAILED })
      return
    }

    const parentConfig = MODEL_CONFIG[parent.rank]

    if (parent.rank === UnitRank.CHIEF) {
      await this.escalateToCore(step, unit, parent)
      return
    }

    this.updateUnit(parentId, {
      status: UnitStatus.ACTIVE,
      currentTask: `Analyzing escalation: ${step.problem}`
    })

    this.addMessage(createMessage(
      MessageType.INFO,
      parentId,
      null,
      `[${parentConfig.displayName}] Received escalation, analyzing...`,
      { model: parentConfig.model, cost: parentConfig.cost }
    ))

    await this.wait(step.analysisDelay || 1000)

    if (step.parentCanSolve) {
      this.addMessage(createMessage(
        MessageType.REPORT,
        parentId,
        step.unitId,
        `[${parentConfig.displayName}] Resolved: ${step.resolution || 'Issue addressed with enhanced reasoning'}`,
        { model: parentConfig.model, cost: parentConfig.cost }
      ))

      this.updateUnit(parentId, {
        status: UnitStatus.COMPLETED,
        currentTask: null
      })
      parent.stats.tasksCompleted++
      parent.stats.tokensUsed += step.tokens || 300

      this.updateUnit(step.unitId, {
        status: UnitStatus.COMPLETED,
        currentTask: null
      })
      unit.stats.tasksCompleted++

      this.completedTasks++
    } else {
      this.addMessage(createMessage(
        MessageType.ESCALATE,
        parentId,
        parent.parentId,
        `[${parentConfig.displayName}] Cannot resolve, escalating further: ${step.problem}`,
        { model: parentConfig.model, cost: parentConfig.cost }
      ))

      this.updateUnit(parentId, { status: UnitStatus.ESCALATING })

      if (step.continueEscalation) {
        await this.handleEscalation({
          ...step,
          unitId: parentId,
          escalateTo: parent.parentId,
          continueEscalation: step.continueEscalation - 1
        })
      }
    }

    this.notify()
  }

  async escalateToCore(step, originUnit, core) {
    const escalationId = `esc-${Date.now()}`

    this.updateUnit('chief', {
      status: UnitStatus.AWAITING_INPUT,
      currentTask: 'Awaiting decision on blocker'
    })

    this.addMessage(createMessage(
      MessageType.ESCALATE,
      originUnit.id,
      'chief',
      `[AXIOM: APPROVAL REQUIRED] ${step.problem}`,
      {
        escalationId,
        options: step.options || ['approve', 'deny', 'defer'],
        context: step.context || null
      }
    ))

    this.pendingEscalation = {
      id: escalationId,
      problem: step.problem,
      fromUnit: originUnit.id,
      fromUnitName: originUnit.name,
      options: step.options || ['approve', 'deny', 'defer'],
      context: step.context || `${originUnit.name} requires your decision`,
      timestamp: Date.now()
    }

    this.notify()

    const decision = await new Promise(resolve => {
      this.escalationResolvers.set(escalationId, resolve)
    })

    this.pendingEscalation = null
    this.escalationResolvers.delete(escalationId)

    this.addMessage(createMessage(
      MessageType.ORDER,
      'chief',
      originUnit.id,
      `[DIRECTIVE] AXIOM Core decision: ${decision.action.toUpperCase()}${decision.message ? ' - ' + decision.message : ''}`,
      { decision: decision.action }
    ))

    this.updateUnit('chief', {
      status: UnitStatus.COMPLETED,
      currentTask: null
    })

    if (decision.action === 'approve') {
      this.updateUnit(step.unitId, {
        status: UnitStatus.ACTIVE,
        currentTask: 'Proceeding with approval'
      })
      await this.wait(500)
      this.updateUnit(step.unitId, {
        status: UnitStatus.COMPLETED,
        currentTask: null
      })
      this.completedTasks++
    } else if (decision.action === 'deny') {
      this.updateUnit(step.unitId, {
        status: UnitStatus.FAILED,
        currentTask: null
      })
    } else {
      this.updateUnit(step.unitId, {
        status: UnitStatus.IDLE,
        currentTask: 'Deferred - awaiting further instructions'
      })
    }

    this.notify()
  }

  resolveChiefEscalation(escalationId, decision) {
    const resolver = this.escalationResolvers.get(escalationId)
    if (resolver) {
      resolver(decision)
    }
  }
}

// Singleton
let simulatorInstance = null

export function getSimulator(config) {
  if (!simulatorInstance) {
    simulatorInstance = new AgentSimulator(config)
  }
  return simulatorInstance
}

export function resetSimulator() {
  if (simulatorInstance) {
    simulatorInstance.reset()
  }
  simulatorInstance = null
}
