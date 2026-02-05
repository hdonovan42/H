// AgentSimulator.js - Core simulation engine for agent orchestration
// Designed for future swap-out with real API integration

export const UnitStatus = {
  IDLE: 'idle',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed'
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
  INFO: 'info'
}

// Unit factory
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

// Message factory
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

// Main simulator class
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

    this.initializeHierarchy()
  }

  initializeHierarchy() {
    // Chief of Staff
    const chief = createUnit('chief', 'Chief of Staff', UnitRank.CHIEF)
    this.units.set('chief', chief)

    // Generals
    const generals = [
      createUnit('gen-research', 'Gen. Research', UnitRank.GENERAL, 'chief'),
      createUnit('gen-planning', 'Gen. Planning', UnitRank.GENERAL, 'chief'),
      createUnit('gen-execution', 'Gen. Execution', UnitRank.GENERAL, 'chief')
    ]

    generals.forEach(g => {
      this.units.set(g.id, g)
      chief.childrenIds.push(g.id)
    })

    // Officers under each General - each commands a company (swarm of soldiers)
    const officerConfigs = [
      { parentId: 'gen-research', officers: [
        { name: 'Lt. Ashworth', company: 'Alpha Company', swarmSize: 120 },
        { name: 'Lt. Pemberton', company: 'Bravo Company', swarmSize: 95 }
      ]},
      { parentId: 'gen-planning', officers: [
        { name: 'Lt. Whitmore', company: 'Charlie Company', swarmSize: 110 },
        { name: 'Lt. Harrington', company: 'Delta Company', swarmSize: 85 }
      ]},
      { parentId: 'gen-execution', officers: [
        { name: 'Lt. Caldwell', company: 'Echo Company', swarmSize: 150 },
        { name: 'Lt. Thornton', company: 'Foxtrot Company', swarmSize: 130 }
      ]}
    ]

    let officerIndex = 0
    officerConfigs.forEach(config => {
      const parent = this.units.get(config.parentId)
      config.officers.forEach(({ name, company, swarmSize }) => {
        const officer = createUnit(`officer-${officerIndex}`, name, UnitRank.OFFICER, config.parentId)
        officer.company = company
        officer.swarmSize = swarmSize
        officer.activeWorkers = 0
        this.units.set(officer.id, officer)
        parent.childrenIds.push(officer.id)
        officerIndex++
      })
    })

    // Dog packs (utility agents)
    const dogs = [
      createUnit('dog-logger', 'K9 Recon', UnitRank.DOG, 'chief'),
      createUnit('dog-cleanup', 'K9 Support', UnitRank.DOG, 'chief'),
      createUnit('dog-monitor', 'K9 Overwatch', UnitRank.DOG, 'chief')
    ]

    dogs.forEach(d => {
      this.units.set(d.id, d)
      chief.childrenIds.push(d.id)
    })
  }

  // Subscription system for React components
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
      currentScenario: this.currentScenario
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

  // Speed control
  setSpeed(multiplier) {
    this.speedMultiplier = multiplier
  }

  getDelay(baseDelay) {
    return baseDelay / this.speedMultiplier
  }

  // Simulation control
  async start(scenario) {
    if (this.isRunning) return

    this.reset()
    this.isRunning = true
    this.currentScenario = scenario
    this.notify()

    try {
      await this.runScenario(scenario)
    } catch (error) {
      console.error('Scenario error:', error)
      this.addMessage(createMessage(
        MessageType.ALERT,
        'chief',
        null,
        `Mission failed: ${error.message}`
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

    // Reset all units
    this.units.forEach(unit => {
      unit.status = UnitStatus.IDLE
      unit.currentTask = null
      unit.stats = { tasksCompleted: 0, tasksFailed: 0, tokensUsed: 0 }
    })

    this.notify()
  }

  // Wait helper that respects pause
  async wait(ms) {
    const adjustedMs = this.getDelay(ms)
    const startTime = Date.now()

    while (Date.now() - startTime < adjustedMs) {
      if (!this.isRunning) throw new Error('Simulation stopped')

      while (this.isPaused && this.isRunning) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      await new Promise(resolve => setTimeout(resolve, Math.min(50, adjustedMs - (Date.now() - startTime))))
    }
  }

  // Execute a task (simulation or real API)
  async executeTask(unit, task) {
    if (this.mode === 'simulation') {
      return this.simulateExecution(unit, task)
    }

    if (this.apiAdapter) {
      return this.apiAdapter.execute(unit, task)
    }

    throw new Error('No execution mode configured')
  }

  async simulateExecution(unit, task) {
    this.updateUnit(unit.id, {
      status: UnitStatus.ACTIVE,
      currentTask: task.description
    })

    // Simulate work time based on complexity
    const workTime = task.duration || (500 + Math.random() * 1500)
    await this.wait(workTime)

    // Simulate occasional failures
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

    return {
      success: true,
      result: task.result || `Completed: ${task.description}`
    }
  }

  // Scenario runner
  async runScenario(scenario) {
    this.totalTasks = scenario.tasks?.length || 0

    for (const step of scenario.steps) {
      if (!this.isRunning) break
      await this.executeStep(step)
    }

    // Final message
    this.updateUnit('chief', { status: UnitStatus.COMPLETED })
    this.addMessage(createMessage(
      MessageType.REPORT,
      'chief',
      null,
      `Mission "${scenario.name}" completed.`
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
      default:
        console.warn('Unknown step type:', step.type)
    }
  }

  async handleOrder(step) {
    this.updateUnit(step.from, { status: UnitStatus.ACTIVE })

    this.addMessage(createMessage(
      MessageType.ORDER,
      step.from,
      step.to,
      step.message
    ))

    await this.wait(step.delay || 500)

    this.updateUnit(step.from, { status: UnitStatus.IDLE })
    this.updateUnit(step.to, { status: UnitStatus.ACTIVE, currentTask: step.message })
  }

  async handleDelegation(step) {
    const unit = this.units.get(step.from)

    this.addMessage(createMessage(
      MessageType.ORDER,
      step.from,
      null,
      `Delegating tasks to subordinates: ${step.tasks.join(', ')}`
    ))

    await this.wait(step.delay || 300)

    // Update targets to active
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
      result: step.result
    })

    if (result.success) {
      this.completedTasks++
    }

    this.addMessage(createMessage(
      result.success ? MessageType.INFO : MessageType.ALERT,
      step.unitId,
      null,
      result.success ? result.result : `Failed: ${step.task}`
    ))

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
    // Execute multiple steps in parallel
    await Promise.all(step.steps.map(s => this.executeStep(s)))
  }

  async handleDogTask(step) {
    const dog = this.units.get(step.dogId)

    this.updateUnit(step.dogId, { status: UnitStatus.ACTIVE, currentTask: step.task })

    this.addMessage(createMessage(
      MessageType.INFO,
      step.dogId,
      null,
      `[K9] ${step.task}`
    ))

    await this.wait(step.duration || 800)

    this.updateUnit(step.dogId, { status: UnitStatus.COMPLETED })
  }

  async handleSwarm(step) {
    const officer = this.units.get(step.officerId)
    if (!officer) return

    const workersDeployed = step.workersDeployed || officer.swarmSize || 100

    // Update officer to active with swarm info
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

    // Simulate swarm execution
    await this.wait(step.duration || 1500)

    // Update stats
    officer.stats.tasksCompleted++
    officer.stats.tokensUsed += step.tokens || Math.floor(200 + Math.random() * 500)

    this.updateUnit(step.officerId, {
      status: UnitStatus.COMPLETED,
      currentTask: null,
      activeWorkers: 0
    })

    this.addMessage(createMessage(
      MessageType.INFO,
      step.officerId,
      null,
      `${workersDeployed} workers returned: ${step.result || 'Task complete'}`
    ))

    this.completedTasks++
    this.notify()
  }
}

// Singleton instance for the app
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
