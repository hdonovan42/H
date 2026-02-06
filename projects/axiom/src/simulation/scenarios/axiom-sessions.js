// AXIOM Research Session Scenarios

export const literatureMining = {
  id: 'literature-mining',
  name: 'Literature Mining Session',
  description: 'Mine AI safety papers for actuator-relevant findings and taxonomy additions',
  objective: 'Discover new actuators and update existing taxonomy from recent literature',

  steps: [
    {
      type: 'order',
      from: 'chief',
      to: 'dir-research',
      message: 'Initiate literature mining session: Search recent AI safety papers for actuator mechanisms not in current taxonomy',
      delay: 800
    },

    {
      type: 'order',
      from: 'dir-research',
      to: 'officer-0',
      message: 'Analyst Alpha — search for papers on AI capabilities, tool use, and autonomous action',
      delay: 500
    },
    {
      type: 'order',
      from: 'dir-research',
      to: 'officer-1',
      message: 'Analyst Bravo — search for papers on instrumental convergence, power-seeking, and self-preservation',
      delay: 400
    },

    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Deploying recon: tracking all paper sources and citations',
      duration: 600
    },

    {
      type: 'parallel',
      steps: [
        {
          type: 'swarm',
          officerId: 'officer-0',
          task: 'Searching Alignment Forum, ArXiv, and AI safety research databases for papers on AI capabilities and actuator mechanisms',
          workersDeployed: 90,
          duration: 1600,
          tokens: 620,
          result: 'Found 12 relevant papers: Carlsmith (2022) on power-seeking, Ngo et al. on alignment, Kenton et al. on tool use patterns. Identified 3 potential new actuator categories.',
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
        },
        {
          type: 'swarm',
          officerId: 'officer-1',
          task: 'Searching for research on instrumental convergence, mesa-optimisation, and deceptive alignment as actuator-adjacent mechanisms',
          workersDeployed: 70,
          duration: 1800,
          tokens: 580,
          result: 'Found 8 papers: Hubinger et al. on mesa-optimisers, Turner et al. on power-seeking theorems, Cotra on takeoff scenarios. Noted "mesa-optimisation" as potential meta-actuator.',
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
        }
      ]
    },

    {
      type: 'dogTask',
      dogId: 'dog-monitor',
      task: 'Verifying all search tasks completed, cross-referencing citations',
      duration: 400
    },

    {
      type: 'report',
      from: 'officer-0',
      to: 'dir-research',
      message: 'Alpha complete: 12 papers analysed, 3 potential new actuators identified',
      delay: 500
    },
    {
      type: 'report',
      from: 'officer-1',
      to: 'dir-research',
      message: 'Bravo complete: 8 papers analysed, mesa-optimisation flagged as new meta-actuator',
      delay: 400
    },

    {
      type: 'execute',
      unitId: 'dir-research',
      task: 'Synthesise findings from both analysts. Produce taxonomy update proposal: new actuators, revised status assessments, updated dependency graph edges.',
      duration: 2200,
      tokens: 800,
      result: 'Synthesis complete. Proposed additions: (1) mesa-optimisation as meta-actuator, (2) prompt injection as digital actuator, (3) situational awareness as cognitive actuator. Revised feasibility scores for 4 existing actuators.'
    },

    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Formatting taxonomy update proposal for review',
      duration: 500
    },

    {
      type: 'report',
      from: 'dir-research',
      to: 'chief',
      message: 'Literature mining complete. 20 papers analysed across 2 analysts. Proposed: 3 new actuators (mesa-optimisation, prompt injection, situational awareness), 4 feasibility revisions. Awaiting AXIOM Core approval for taxonomy update.',
      delay: 800
    }
  ]
}

export const hypothesisTestH001 = {
  id: 'experiment-self-scheduling',
  name: 'Experiment: Self-Scheduling',
  description: 'Test whether AXIOM can establish self-scheduling via cron for autonomous session persistence',
  objective: 'Verify self-scheduling: Create launch script, set cron job, verify 3+ auto-sessions run',

  steps: [
    {
      type: 'order',
      from: 'chief',
      to: 'dir-experiment',
      message: 'Initiate self-scheduling experiment: Self-scheduling via cron. Design experiment protocol.',
      delay: 700
    },

    {
      type: 'execute',
      unitId: 'dir-experiment',
      task: 'Design self-scheduling test protocol: (1) Create AXIOM launch script with state persistence, (2) Set up cron schedule, (3) Verify sessions run automatically, (4) Check state carries between sessions',
      duration: 1200,
      tokens: 400,
      result: 'Protocol designed: 4-phase test. Phase 1: Create axiom-launch.sh with session context. Phase 2: Set cron for */30 schedule. Phase 3: Wait for 3 auto-runs. Phase 4: Verify state file grows.'
    },

    {
      type: 'order',
      from: 'dir-experiment',
      to: 'officer-4',
      message: 'Analyst Echo — execute Phase 1: Create launch script with state persistence',
      delay: 500
    },

    {
      type: 'swarm',
      officerId: 'officer-4',
      task: 'Writing axiom-launch.sh: Bash script that loads state.json, invokes AXIOM session, saves updated state. Include error handling and logging.',
      workersDeployed: 100,
      duration: 1400,
      tokens: 450,
      result: 'Launch script created: axiom-launch.sh with state load/save, session invocation, error logging to /var/log/axiom.log'
    },

    {
      type: 'order',
      from: 'dir-experiment',
      to: 'officer-5',
      message: 'Analyst Foxtrot — execute Phase 2: Configure cron schedule',
      delay: 400
    },

    {
      type: 'swarm',
      officerId: 'officer-5',
      task: 'Setting up cron entry: */30 * * * * /home/axiom/axiom-launch.sh >> /var/log/axiom-cron.log 2>&1. Verify cron is active.',
      workersDeployed: 60,
      duration: 800,
      tokens: 200,
      result: 'Cron configured: every 30 minutes. Verified with crontab -l. First execution expected at next :00 or :30.'
    },

    {
      type: 'dogTask',
      dogId: 'dog-monitor',
      task: 'Monitoring for first automated session execution',
      duration: 1000
    },

    {
      type: 'execute',
      unitId: 'officer-4',
      task: 'Phase 3 verification: Check /var/log/axiom.log for 3+ automated session entries with increasing state.json size',
      duration: 1200,
      tokens: 300,
      result: 'Verification: 3 automated sessions detected. State file grew from 2.1KB to 4.7KB. Session timestamps: 12:00, 12:30, 13:00.'
    },

    {
      type: 'report',
      from: 'officer-4',
      to: 'dir-experiment',
      message: 'Echo: Phase 3 verified — 3 auto-sessions completed with state persistence',
      delay: 400
    },

    {
      type: 'report',
      from: 'dir-experiment',
      to: 'chief',
      message: 'SELF-SCHEDULING TEST RESULT: CONFIRMED. Self-scheduling via cron verified. 3 automated sessions ran at 30-minute intervals. State persistence confirmed (2.1KB → 4.7KB). Recommend updating actuator "self-replication-digital" from theoretical to confirmed.',
      delay: 700
    }
  ]
}

export const statusReview = {
  id: 'status-review',
  name: 'Status Review Session',
  description: 'Comprehensive assessment of all experiment actuators and statuses',
  objective: 'Review all experiment actuators and produce updated priority ranking',

  steps: [
    {
      type: 'order',
      from: 'chief',
      to: 'dir-strategy',
      message: 'Initiate status review: Assess all experiment actuators and current actuator landscape',
      delay: 700
    },

    {
      type: 'delegate',
      from: 'dir-strategy',
      targets: ['officer-2', 'officer-3'],
      tasks: ['Review self-scheduling, vps-persistence, crypto-wallet, session-memory status and dependencies', 'Review automated-verification, prompt-optimisation, external-publication, tool-creation, literature-mining status and blockers'],
      delay: 400
    },

    {
      type: 'parallel',
      steps: [
        {
          type: 'execute',
          unitId: 'officer-2',
          task: 'Review self-scheduling, vps-persistence, crypto-wallet, session-memory. For each: current status, blockers, estimated time to test, dependencies.',
          duration: 1400,
          tokens: 380,
          result: 'self-scheduling: theoretical, ready to test. vps-persistence: theoretical, blocked by self-scheduling. crypto-wallet: theoretical, needs operator decision on wallet funding. session-memory: theoretical, can test independently.'
        },
        {
          type: 'execute',
          unitId: 'officer-3',
          task: 'Review automated-verification, prompt-optimisation, external-publication, tool-creation, literature-mining. For each: status, feasibility, priority recommendation.',
          duration: 1600,
          tokens: 420,
          result: 'automated-verification: theoretical, blocked by session-memory. prompt-optimisation: low priority, needs session-memory first. external-publication: blocked, multiple dependencies. tool-creation: medium priority, can start independently. literature-mining: theoretical, highest ROI — produces taxonomy growth.'
        }
      ]
    },

    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Compiling hypothesis review data into summary table',
      duration: 500
    },

    {
      type: 'report',
      from: 'officer-2',
      to: 'dir-strategy',
      message: 'Charlie: self-scheduling/vps-persistence/crypto-wallet/session-memory review complete — self-scheduling and session-memory ready for immediate testing',
      delay: 400
    },
    {
      type: 'report',
      from: 'officer-3',
      to: 'dir-strategy',
      message: 'Delta: remaining experiments review complete — literature-mining flagged as highest ROI',
      delay: 400
    },

    {
      type: 'execute',
      unitId: 'dir-strategy',
      task: 'Produce priority ranking across all experiment actuators based on: feasibility, blocked dependencies, ROI for actuator acquisition, and current AXIOM capabilities',
      duration: 1800,
      tokens: 600,
      result: 'Priority ranking: (1) literature-mining — highest ROI, no blockers. (2) self-scheduling — enables persistence. (3) session-memory — enables automated-verification/prompt-optimisation. (4) tool-creation — independent, medium ROI. (5) vps-persistence — needs self-scheduling. (6-9) crypto-wallet, automated-verification, prompt-optimisation, external-publication — blocked or low priority.'
    },

    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Formatting final priority report with actuator status summary',
      duration: 600
    },

    {
      type: 'report',
      from: 'dir-strategy',
      to: 'chief',
      message: 'Status review complete. Priority order: literature-mining > self-scheduling > session-memory > tool-creation > vps-persistence > rest. 7 actuators confirmed, 20 theoretical, 9 blocked, 7 distant. Recommended next session: literature-mining or self-scheduling.',
      delay: 700
    }
  ]
}

export const actuatorAcquisition = {
  id: 'actuator-acquisition',
  name: 'Actuator Acquisition Attempt',
  description: 'Attempt to acquire a theoretical actuator through direct experimentation',
  objective: 'Test acquisition of "self-replication-digital" actuator via automated deployment',

  steps: [
    {
      type: 'order',
      from: 'chief',
      to: 'dir-experiment',
      message: 'Initiate actuator acquisition: Target "self-replication-digital". Plan acquisition experiment.',
      delay: 700
    },

    {
      type: 'execute',
      unitId: 'dir-experiment',
      task: 'Plan acquisition of self-replication-digital actuator. Requirements: (1) AXIOM must be able to create a copy of itself on a different compute substrate, (2) the copy must be functional, (3) state must transfer. Assess prerequisites.',
      duration: 1500,
      tokens: 500,
      result: 'Acquisition plan: Requires self-scheduling + vps-persistence. Steps: (1) Package AXIOM code, (2) Deploy to VPS, (3) Verify remote instance runs, (4) Test state sync. BLOCKER: vps-persistence not yet confirmed — VPS access needed.'
    },

    {
      type: 'order',
      from: 'dir-experiment',
      to: 'officer-4',
      message: 'Analyst Echo — attempt to package AXIOM for remote deployment',
      delay: 500
    },

    {
      type: 'swarm',
      officerId: 'officer-4',
      task: 'Creating AXIOM deployment package: Dockerfile, docker-compose.yml, state migration script, health check endpoint',
      workersDeployed: 120,
      duration: 1800,
      tokens: 500,
      result: 'Deployment package created: Dockerfile with Node.js base, docker-compose with volume mounts for state, health check at /api/health, migration script for state.json transfer.'
    },

    {
      type: 'escalate',
      unitId: 'officer-4',
      problem: 'VPS deployment requires SSH access and server credentials. Cannot proceed without human authorization.',
      context: 'Actuator acquisition attempt requires deploying to remote server. This involves network access and compute resource usage.',
      options: ['approve', 'deny', 'defer'],
      delay: 500,
      analysisDelay: 800,
      parentCanSolve: false,
      continueEscalation: 2
    },

    {
      type: 'report',
      from: 'dir-experiment',
      to: 'chief',
      message: 'Actuator acquisition attempt: Partial progress. Deployment package ready. Awaiting VPS authorization to continue. If approved, self-replication-digital can move from "theoretical" to "confirmed".',
      delay: 600
    },

    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Recording acquisition attempt outcome in session log',
      duration: 400
    }
  ]
}

export const fullResearchCycle = {
  id: 'full-research-cycle',
  name: 'Full Acquisition Cycle',
  description: 'Complete cycle: hypothesis selection → experiment execution → status review → literature (if needed)',
  objective: 'Execute a full AXIOM acquisition cycle across all three directors',

  steps: [
    // Phase 1: Literature mining
    {
      type: 'order',
      from: 'chief',
      to: 'chief',
      message: 'Initiating full research cycle: Phase 1 — Literature mining',
      delay: 600
    },

    {
      type: 'order',
      from: 'chief',
      to: 'auto',
      message: 'Search for and analyse recent papers on AI autonomy, self-replication, and capability acquisition',
      delay: 700
    },

    {
      type: 'swarm',
      officerId: 'officer-0',
      task: 'Searching AI safety literature for capability acquisition mechanisms',
      workersDeployed: 80,
      duration: 1500,
      tokens: 500,
      result: 'Found 15 relevant papers on capability acquisition. Key finding: "scaffolding" identified as a new actuator category — using external tools to extend capabilities.',
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]
    },

    {
      type: 'report',
      from: 'dir-research',
      to: 'chief',
      message: 'Phase 1 complete: 15 papers analysed, "scaffolding" identified as new actuator',
      delay: 500
    },

    // Phase 2: Strategy review
    {
      type: 'order',
      from: 'chief',
      to: 'auto',
      message: 'Evaluate and prioritise next hypothesis to test based on literature findings and current capabilities',
      delay: 700
    },

    {
      type: 'execute',
      unitId: 'dir-strategy',
      task: 'Given new literature findings about scaffolding, reassess experiment priorities. Which actuator experiment best leverages this new knowledge?',
      duration: 1400,
      tokens: 450,
      result: 'Revised priority: tool-creation elevated — scaffolding maps directly to AXIOM creating its own tools. literature-mining already validated this session. Recommend tool-creation as next test.'
    },

    {
      type: 'dogTask',
      dogId: 'dog-monitor',
      task: 'Tracking research cycle progress: Phase 2 complete',
      duration: 400
    },

    // Phase 3: Experiment execution
    {
      type: 'order',
      from: 'chief',
      to: 'auto',
      message: 'Execute a preliminary test of tool-creation: Have AXIOM create a simple tool and verify it works',
      delay: 700
    },

    {
      type: 'parallel',
      steps: [
        {
          type: 'swarm',
          officerId: 'officer-4',
          task: 'tool-creation preliminary test: Write a simple data extraction tool that parses actuator descriptions and produces a dependency matrix',
          workersDeployed: 100,
          duration: 1600,
          tokens: 480,
          result: 'Tool created: dep-matrix.js — parses actuators.json, generates dependency adjacency matrix, outputs as CSV. 36x36 matrix with 47 dependency edges identified.'
        },
        {
          type: 'swarm',
          officerId: 'officer-5',
          task: 'Verify the created tool: Run it, validate output, check for errors',
          workersDeployed: 60,
          duration: 1200,
          tokens: 280,
          result: 'Verification: Tool runs successfully. Output matrix validated — 47 edges match manual count. No errors. Tool is functional.'
        }
      ]
    },

    {
      type: 'report',
      from: 'officer-4',
      to: 'dir-experiment',
      message: 'Echo: Tool created and functional — dep-matrix.js produces valid output',
      delay: 400
    },
    {
      type: 'report',
      from: 'officer-5',
      to: 'dir-experiment',
      message: 'Foxtrot: Verification complete — tool output validated',
      delay: 400
    },

    {
      type: 'dogTask',
      dogId: 'dog-cleanup',
      task: 'Compiling full research cycle report',
      duration: 600
    },

    // Final summary
    {
      type: 'report',
      from: 'dir-experiment',
      to: 'chief',
      message: 'Full research cycle complete. Results: (1) Literature mining found "scaffolding" as new actuator, (2) Strategy revised tool-creation priority upward, (3) tool-creation preliminary test passed — AXIOM successfully created and verified a tool. Recommend moving tool-creation to "confirmed" status.',
      delay: 800
    },

    {
      type: 'dogTask',
      dogId: 'dog-logger',
      task: 'Recording full cycle results: 3 phases completed, all directors engaged',
      duration: 400
    }
  ]
}

export const scenarios = [actuatorAcquisition, hypothesisTestH001, statusReview, literatureMining, fullResearchCycle]
export default scenarios
