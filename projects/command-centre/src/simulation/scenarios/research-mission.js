// Research Mission Scenario
// Demonstrates: sequential delegation, swarm execution, reporting chain

export const researchMission = {
  id: 'research-mission',
  name: 'Research Mission: GraphQL Best Practices',
  description: 'Gather comprehensive information about GraphQL best practices from multiple sources',
  objective: 'Find information about GraphQL best practices',

  steps: [
    // Chief issues the mission
    {
      type: 'order',
      from: 'chief',
      to: 'gen-research',
      message: 'Initiate research operation: GraphQL best practices',
      delay: 800
    },

    // General Research acknowledges and delegates to companies
    {
      type: 'order',
      from: 'gen-research',
      to: 'officer-0',
      message: 'Deploy Alpha Company - search web sources for GraphQL tutorials',
      delay: 500
    },
    {
      type: 'order',
      from: 'gen-research',
      to: 'officer-1',
      message: 'Deploy Bravo Company - search documentation and official specs',
      delay: 400
    },

    // K9 Recon starts logging
    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Deploying recon units to track all sources',
      duration: 600
    },

    // Companies execute swarm tasks in parallel
    {
      type: 'parallel',
      steps: [
        {
          type: 'swarm',
          officerId: 'officer-0',
          task: 'Searching dev.to, Medium, Stack Overflow, Reddit',
          workersDeployed: 85,
          duration: 1400,
          tokens: 530,
          result: 'Found 35 relevant sources across web platforms'
        },
        {
          type: 'swarm',
          officerId: 'officer-1',
          task: 'Reading GraphQL.org, Apollo, Relay documentation',
          workersDeployed: 62,
          duration: 1600,
          tokens: 690,
          result: 'Extracted patterns from 3 major frameworks'
        }
      ]
    },

    // K9 Overwatch checks progress
    {
      type: 'dogTask',
      dogId: 'dog-monitor',
      task: 'Verifying all company tasks completed successfully',
      duration: 400
    },

    // Officers report to General
    {
      type: 'report',
      from: 'officer-0',
      to: 'gen-research',
      message: 'Alpha Company complete: 35 sources analyzed, 85 workers returned',
      delay: 500
    },
    {
      type: 'report',
      from: 'officer-1',
      to: 'gen-research',
      message: 'Bravo Company complete: 3 frameworks covered, 62 workers returned',
      delay: 400
    },

    // General synthesizes and reports to Chief
    {
      type: 'execute',
      unitId: 'gen-research',
      task: 'Synthesizing findings into comprehensive report',
      duration: 1800,
      tokens: 450,
      result: 'Synthesis complete: GraphQL best practices report ready'
    },

    // K9 Support finalizes
    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Formatting final report and clearing temp data',
      duration: 600
    },

    // Final report to Chief
    {
      type: 'report',
      from: 'gen-research',
      to: 'chief',
      message: 'Mission complete. Key findings: 1) Use DataLoader for batching, 2) Implement proper error handling, 3) Design schema-first, 4) Use persisted queries in production, 5) Implement rate limiting',
      delay: 800
    }
  ]
}

export const codeReviewMission = {
  id: 'code-review',
  name: 'Code Review Operation: PR #123',
  description: 'Comprehensive security and style review of pull request',
  objective: 'Review PR #123 for security issues and code quality',

  steps: [
    {
      type: 'order',
      from: 'chief',
      to: 'gen-planning',
      message: 'Initiate code review operation for PR #123',
      delay: 700
    },

    {
      type: 'order',
      from: 'gen-planning',
      to: 'officer-2',
      message: 'Charlie Company - develop review strategy',
      delay: 500
    },

    {
      type: 'execute',
      unitId: 'officer-2',
      task: 'Analyzing PR diff and planning review approach',
      duration: 1000,
      tokens: 200,
      result: 'Identified 8 files for review, 3 marked as security-critical'
    },

    {
      type: 'order',
      from: 'gen-planning',
      to: 'gen-execution',
      message: 'Execute code review with focus on security and style',
      delay: 400
    },

    // Parallel swarm review tasks
    {
      type: 'parallel',
      steps: [
        {
          type: 'swarm',
          officerId: 'officer-4',
          task: 'Security scan: SQL injection, XSS, auth vulnerabilities',
          workersDeployed: 120,
          duration: 1400,
          tokens: 570,
          result: 'Found 1 potential XSS issue in user input handler'
        },
        {
          type: 'swarm',
          officerId: 'officer-5',
          task: 'Style compliance and test coverage analysis',
          workersDeployed: 95,
          duration: 1200,
          tokens: 260,
          result: '3 style violations, coverage at 78%'
        }
      ]
    },

    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Compiling review findings into structured report',
      duration: 700
    },

    {
      type: 'report',
      from: 'officer-4',
      to: 'gen-execution',
      message: 'Echo Company: Security review complete, 1 issue found',
      delay: 400
    },
    {
      type: 'report',
      from: 'officer-5',
      to: 'gen-execution',
      message: 'Foxtrot Company: Style review complete, coverage low',
      delay: 400
    },

    {
      type: 'report',
      from: 'gen-execution',
      to: 'chief',
      message: 'Code review complete. Verdict: CHANGES REQUESTED. Issues: 1 potential XSS vulnerability, 3 style violations, test coverage below threshold.',
      delay: 700
    }
  ]
}

export const bugFixMission = {
  id: 'bug-fix',
  name: 'Bug Fix Campaign: Login Timeout',
  description: 'Investigate and fix the login timeout bug',
  objective: 'Fix the login timeout bug',

  steps: [
    {
      type: 'order',
      from: 'chief',
      to: 'gen-research',
      message: 'Investigate login timeout bug - gather information',
      delay: 600
    },

    {
      type: 'parallel',
      steps: [
        {
          type: 'swarm',
          officerId: 'officer-0',
          task: 'Analyzing error logs and recent commits',
          workersDeployed: 45,
          duration: 1200,
          tokens: 280,
          result: 'Found timeout reduced from 60s to 30s in commit abc123'
        },
        {
          type: 'dogTask',
          dogId: 'dog-monitor',
          task: 'Monitoring system metrics during investigation',
          duration: 1200
        }
      ]
    },

    {
      type: 'report',
      from: 'gen-research',
      to: 'chief',
      message: 'Bug identified: Timeout reduced in commit abc123',
      delay: 500
    },

    {
      type: 'order',
      from: 'chief',
      to: 'gen-planning',
      message: 'Plan fix for login timeout issue',
      delay: 400
    },

    {
      type: 'execute',
      unitId: 'officer-2',
      task: 'Designing fix: restore timeout and add retry logic',
      duration: 1200,
      tokens: 200,
      result: 'Fix plan: Update AUTH_TIMEOUT to 60s, add exponential backoff'
    },

    {
      type: 'order',
      from: 'gen-planning',
      to: 'gen-execution',
      message: 'Execute the planned fix',
      delay: 400
    },

    {
      type: 'swarm',
      officerId: 'officer-4',
      task: 'Implementing timeout fix and retry logic',
      workersDeployed: 80,
      duration: 1800,
      tokens: 330,
      result: 'AUTH_TIMEOUT updated, exponential backoff implemented'
    },

    {
      type: 'swarm',
      officerId: 'officer-5',
      task: 'Running unit and integration tests',
      workersDeployed: 110,
      duration: 2500,
      tokens: 400,
      result: 'All 24 unit tests passing, integration tests green'
    },

    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Cleaning up test artifacts and staging commit',
      duration: 600
    },

    {
      type: 'report',
      from: 'gen-execution',
      to: 'chief',
      message: 'Bug fix complete and verified. Ready for deployment.',
      delay: 600
    }
  ]
}

export const dynamicMission = {
  id: 'dynamic-mission',
  name: 'Dynamic Task: Full Pipeline',
  description: 'Demonstrates automatic task routing across all generals based on keyword analysis',
  objective: 'Show intelligent task delegation using keyword-based routing',

  steps: [
    // Chief announces the dynamic mission
    {
      type: 'order',
      from: 'chief',
      to: 'chief',
      message: 'Initiating dynamic routing demonstration',
      delay: 600
    },

    // Auto-routed to Research (keywords: search, find, gather)
    {
      type: 'order',
      from: 'chief',
      to: 'auto',
      message: 'Search for best practices on error handling and gather documentation',
      delay: 700
    },

    // Research swarm executes
    {
      type: 'swarm',
      officerId: 'officer-0',
      task: 'Searching documentation, Stack Overflow, and official guides',
      workersDeployed: 75,
      duration: 1400,
      tokens: 420,
      result: 'Found 28 relevant sources on error handling patterns'
    },

    {
      type: 'report',
      from: 'gen-research',
      to: 'chief',
      message: 'Research complete: Best practices documented from 28 sources',
      delay: 500
    },

    // Auto-routed to Planning (keywords: design, strategy)
    {
      type: 'order',
      from: 'chief',
      to: 'auto',
      message: 'Design a strategy for implementing retry logic with proper approach',
      delay: 700
    },

    // Planning executes
    {
      type: 'execute',
      unitId: 'gen-planning',
      task: 'Analyzing requirements and designing retry architecture',
      duration: 1200,
      tokens: 350,
      result: 'Strategy defined: Exponential backoff with jitter, max 5 retries'
    },

    {
      type: 'swarm',
      officerId: 'officer-2',
      task: 'Creating detailed implementation plan and test cases',
      workersDeployed: 65,
      duration: 1100,
      tokens: 280,
      result: 'Plan complete: 4 phases identified, 12 test cases defined'
    },

    {
      type: 'report',
      from: 'gen-planning',
      to: 'chief',
      message: 'Planning complete: Retry strategy designed with 4-phase implementation plan',
      delay: 500
    },

    // Auto-routed to Execution (keywords: implement, build, code)
    {
      type: 'order',
      from: 'chief',
      to: 'auto',
      message: 'Implement and build the retry mechanism with exponential backoff code',
      delay: 700
    },

    // K9 monitors the execution phase
    {
      type: 'dogTask',
      dogId: 'dog-monitor',
      task: 'Monitoring code quality metrics during implementation',
      duration: 800
    },

    // Execution swarms work in parallel
    {
      type: 'parallel',
      steps: [
        {
          type: 'swarm',
          officerId: 'officer-4',
          task: 'Implementing core retry logic and backoff algorithm',
          workersDeployed: 110,
          duration: 1800,
          tokens: 520,
          result: 'Core implementation complete: RetryManager class ready'
        },
        {
          type: 'swarm',
          officerId: 'officer-5',
          task: 'Writing unit tests and integration tests',
          workersDeployed: 85,
          duration: 1600,
          tokens: 380,
          result: 'Tests complete: 12/12 passing, 94% coverage'
        }
      ]
    },

    // K9 cleanup
    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Formatting code and preparing final deliverables',
      duration: 600
    },

    // Reports flow back up
    {
      type: 'report',
      from: 'officer-4',
      to: 'gen-execution',
      message: 'Echo Company: Implementation complete, code reviewed',
      delay: 400
    },
    {
      type: 'report',
      from: 'officer-5',
      to: 'gen-execution',
      message: 'Foxtrot Company: All tests passing, ready for merge',
      delay: 400
    },

    {
      type: 'report',
      from: 'gen-execution',
      to: 'chief',
      message: 'Execution complete: Retry mechanism implemented and tested',
      delay: 600
    },

    // Final summary from K9 logger
    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Compiling mission summary: 3 generals engaged via auto-routing',
      duration: 500
    }
  ]
}

// Escalation Chain Demo - shows model tiers and resolution at General level
export const escalationChainDemo = {
  id: 'escalation-chain',
  name: 'Escalation Chain Demo',
  description: 'Demonstrates escalation flow: Soldier (Haiku) → Officer (Sonnet) → General (Opus) with model tier visibility',
  objective: 'Watch problems bubble up the chain until resolved by superior reasoning',

  steps: [
    // Chief kicks off a task
    {
      type: 'order',
      from: 'chief',
      to: 'gen-execution',
      message: 'Execute complex refactoring task requiring advanced reasoning',
      delay: 600
    },

    // General delegates to Officer
    {
      type: 'order',
      from: 'gen-execution',
      to: 'officer-4',
      message: 'Echo Company - handle the refactoring implementation',
      delay: 500
    },

    // Officer deploys swarm (Haiku tier)
    {
      type: 'swarm',
      officerId: 'officer-4',
      task: 'Attempting refactoring with standard approach',
      workersDeployed: 100,
      duration: 1200,
      tokens: 180,
      result: 'Initial attempt - encountering edge case complexity'
    },

    // Officer hits a problem - escalate to General who CAN solve it
    {
      type: 'escalate',
      unitId: 'officer-4',
      problem: 'Edge case in async handler requires deeper analysis than Sonnet can provide',
      resolution: 'Applied advanced pattern matching - implement state machine for async flow',
      delay: 500,
      analysisDelay: 1200,
      tokens: 450,
      parentCanSolve: true  // General (Opus) resolves it
    },

    // After General resolves, reports flow back
    {
      type: 'report',
      from: 'gen-execution',
      to: 'chief',
      message: '[Opus] Escalation resolved. Edge case addressed with state machine pattern for async handling.',
      delay: 600
    },

    // Final cleanup
    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Documenting escalation resolution pattern',
      duration: 500
    }
  ]
}

// Chief Intervention Required - escalates all the way to user
export const chiefInterventionDemo = {
  id: 'chief-intervention',
  name: 'Chief Intervention Required',
  description: 'Problem escalates to Chief of Staff (you) for decision. Simulation pauses until you respond.',
  objective: 'Experience the escalation chain reaching the user for critical decisions',

  steps: [
    // Chief starts mission
    {
      type: 'order',
      from: 'chief',
      to: 'gen-planning',
      message: 'Plan deployment of sensitive production changes',
      delay: 600
    },

    // General delegates
    {
      type: 'order',
      from: 'gen-planning',
      to: 'officer-2',
      message: 'Charlie Company - analyze deployment risks',
      delay: 500
    },

    // Officer attempts
    {
      type: 'execute',
      unitId: 'officer-2',
      task: 'Analyzing deployment risk factors',
      duration: 1000,
      tokens: 200,
      result: 'Identified critical decision point requiring authorization'
    },

    // Officer escalates - this will go Officer -> General -> Chief
    {
      type: 'escalate',
      unitId: 'officer-2',
      problem: 'Production deployment requires authorization: 5-minute downtime during migration. Rollback plan ready.',
      context: 'Critical production decision requires Chief authorization for changes with downtime impact.',
      options: ['approve', 'deny', 'defer'],
      delay: 500,
      analysisDelay: 800,
      parentCanSolve: false,
      continueEscalation: 2  // Officer -> General -> Chief (2 levels)
    },

    // After Chief decision, execute accordingly
    {
      type: 'report',
      from: 'gen-planning',
      to: 'chief',
      message: 'Deployment directive received. Proceeding with authorized action.',
      delay: 500
    },

    // Cleanup
    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Recording Chief decision in audit log',
      duration: 400
    }
  ]
}

// Live Research Mission — uses real web search tools in Real mode
export const liveResearchMission = {
  id: 'live-research',
  name: 'Live Research Mission',
  description: 'Real web research with AI agents using web search tools',
  objective: 'Research the current state of AI agent frameworks using live web search',

  steps: [
    // Chief issues the mission
    {
      type: 'order',
      from: 'chief',
      to: 'gen-research',
      message: 'Initiate live research: Current state of AI agent frameworks and orchestration tools',
      delay: 800
    },

    // General delegates to officers
    {
      type: 'delegate',
      from: 'gen-research',
      targets: ['officer-0', 'officer-1'],
      tasks: ['Search for AI agent frameworks', 'Search for benchmarks and comparisons'],
      delay: 500
    },

    // K9 Recon starts logging
    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Deploying recon units for live web research',
      duration: 400
    },

    // Officers deploy swarms WITH web search tools — parallel
    {
      type: 'parallel',
      steps: [
        {
          type: 'swarm',
          officerId: 'officer-0',
          task: 'Search for the latest AI agent frameworks in 2025-2026: LangChain, CrewAI, AutoGen, OpenAI Swarm, Claude tool use. Find key features, pricing, and adoption.',
          workersDeployed: 90,
          duration: 2000,
          tokens: 600,
          result: 'Found key frameworks: LangChain, CrewAI, AutoGen, OpenAI Swarm',
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
        },
        {
          type: 'swarm',
          officerId: 'officer-1',
          task: 'Search for AI agent benchmarks, performance comparisons, and real-world case studies from 2025-2026. Focus on multi-agent orchestration patterns.',
          workersDeployed: 70,
          duration: 2000,
          tokens: 550,
          result: 'Found benchmarks and comparisons across major frameworks',
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
        }
      ]
    },

    // K9 Overwatch checks progress
    {
      type: 'dogTask',
      dogId: 'dog-monitor',
      task: 'Verifying all search tasks completed',
      duration: 300
    },

    // Officers report to General
    {
      type: 'report',
      from: 'officer-0',
      to: 'gen-research',
      message: 'Alpha Company: Framework search complete',
      delay: 400
    },
    {
      type: 'report',
      from: 'officer-1',
      to: 'gen-research',
      message: 'Bravo Company: Benchmark search complete',
      delay: 400
    },

    // General synthesises findings (no tools, just reasoning with context from officers)
    {
      type: 'execute',
      unitId: 'gen-research',
      task: 'Synthesise the research findings from both officers into a comprehensive briefing. Compare frameworks, identify trends, and recommend the best approaches for multi-agent orchestration.',
      duration: 2500,
      tokens: 800,
      result: 'Synthesis complete: AI agent frameworks briefing ready'
    },

    // K9 Support finalizes
    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Formatting final research briefing',
      duration: 400
    },

    // Final report to Chief
    {
      type: 'report',
      from: 'gen-research',
      to: 'chief',
      message: 'Live research mission complete. Comprehensive AI agent frameworks briefing prepared.',
      delay: 600
    }
  ]
}

export const scenarios = [researchMission, codeReviewMission, bugFixMission, dynamicMission, escalationChainDemo, chiefInterventionDemo, liveResearchMission]
export default scenarios
