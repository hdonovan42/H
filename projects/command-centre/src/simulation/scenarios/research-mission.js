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

export const scenarios = [researchMission, codeReviewMission, bugFixMission]
export default scenarios
