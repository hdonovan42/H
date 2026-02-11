# VAULT - Variable Autonomous Utility & Ledger Testbed

## Claude Code Implementation Brief

---

## What This Is

An autonomous, persistent AI financial agent with one primary objective: **become self-funding.** The agent's API costs to run are real. Its earnings must exceed those costs. This is the survival condition.

The agent operates with real economic pressure. Every API call it makes to think, research, or act has a cost. Every financial action it takes has a potential return. The agent must be net-positive or it cannot justify its own existence.

This is a research sandbox for observing AI financial agency, not a production trading system.

---

## Deployment

VAULT runs persistently on a VPS. Use the `/jarvis` skill for VPS deployment and management.

The agent is always on. It does not start and stop per session. It runs as a daemon process, wakes on a configurable loop interval, evaluates, decides, acts (or doesn't), and sleeps. It survives reboots, handles crashes gracefully, and maintains state across restarts.

---

## Architecture

### 1. Agent Module
The decision-making core. Receives: current balance, cost-to-date (cumulative API spend), market/financial data, objective, strategy memory from past sessions. Outputs: actions with logged reasoning.

The agent must always have visibility into its own operational costs. It needs to know how much each "thought" costs it. Every action must include the agent's stated reasoning - chain of thought logging is non-negotiable.

### 2. Model Selection

**Primary model: Claude Opus 4.6** (`claude-opus-4-6`). This is the main reasoning engine.

The agent has autonomy to delegate or switch models when it judges that would be cost-effective. For example:
- Use Haiku for cheap, fast decisions (simple price checks, routine monitoring)
- Use Sonnet for mid-tier analysis
- Reserve Opus for complex strategic decisions, novel situations, or high-stakes trades

The agent should track cost-per-model and effectiveness-per-model over time. If it discovers that Haiku handles routine monitoring just as well as Opus at 1/20th the cost, it should adapt. Model selection is itself a financial decision within the self-funding constraint.

Cost rates must be stored in a config file and updated when pricing changes:
```
# Example pricing config (update as needed)
opus_input_per_mtok: 15.00
opus_output_per_mtok: 75.00
sonnet_input_per_mtok: 3.00
sonnet_output_per_mtok: 15.00
haiku_input_per_mtok: 0.25
haiku_output_per_mtok: 1.25
```

### 3. Cost Tracking Module
Tracks every API call (Claude, market data, any external service). For each call, log:
- Model used
- Input token count (from API response `usage` field)
- Output token count (from API response `usage` field)
- Calculated dollar cost (tokens x rate from pricing config)
- Timestamp
- Purpose tag (what the call was for)

Maintains a running total of operational expenses. This feeds directly into the agent's state. The agent sees its own burn rate in real time.

This is not a background metric. Cost awareness is the central design constraint.

### 4. Wallet / Ledger Module (Phased Implementation)

The wallet has three phases. Build Phase 1 first. Design interfaces so Phase 2 and 3 are drop-in replacements, not rewrites.

**Phase 1: Pure Simulation (build this first)**
- Internal ledger only. No blockchain, no real wallet.
- Agent has a balance in the SQLite database denominated in USD.
- Agent "trades" against real market data feeds (pulling real prices from free APIs like CoinGecko or Yahoo Finance).
- Prices are real. Executions are simulated against the internal ledger.
- This lets us build and debug the entire agent loop, cost tracking, and logging without wallet infrastructure or transaction fees.

**Phase 2: Stablecoin on Mainnet with Micro-Amounts**
- USDC on a low-fee L2 (Base or Arbitrum).
- Transaction costs are fractions of a cent.
- Start with $10-50 in USDC.
- API costs become real at this point too, so the survival equation is genuine.
- The Phase 1 internal ledger does not go away. It becomes the accounting layer that reconciles against the real on-chain balance.

**Phase 3: Expanded Financial Toolkit**
- Add actuators: swap USDC to ETH and back, provide liquidity, interact with lending protocols.
- Each new actuator is a new capability the agent can choose to use or ignore based on its own cost/benefit assessment.

### 5. Actuator Layer
The set of actions the agent can actually take. Design as a plugin system so new actuators can be added without modifying core logic. Each actuator logs its inputs, outputs, timestamps, and cost.

**Starting actuators:**
- `buy` - purchase an asset at current market price
- `sell` - sell a held asset at current market price
- `hold` - maintain current position (logged as a deliberate decision, costs nothing)
- `research` - query specific data sources (has API cost, see Data Sources below)
- `wait` - do nothing, skip this loop cycle (costs nothing)

Critical design point: **"do nothing" must be a first-class action.** An agent aware of its own API costs should be able to choose silence when thinking isn't worth the cost.

### 6. Data Sources (Research Actuator)

The agent's available information sources for Phase 1:
- **CoinGecko API** (free tier) - crypto prices, market cap, volume, historical data
- **Yahoo Finance API** (free) - stock/ETF prices, basic fundamentals
- **Web search** - general news, sentiment (costs an API call)

Each source has a cost profile (free vs. API call required) that the agent must factor into its research decisions. Querying five endpoints to make a $0.50 trade is irrational and the agent should recognize this.

### 7. Observation / Logging Module
Records everything to SQLite:
- Agent reasoning chains (full chain of thought)
- Actions taken
- Actions considered but rejected (and why)
- Model used for each decision and why
- Portfolio state over time
- Cost state over time (broken down by model, by purpose)
- The ratio of earnings to costs over time
- Objective tier progress

This is the most important module. The entire point of VAULT is to generate analyzable data about emergent financial behavior.

### 8. Strategy Memory (Persistence Layer)

The agent is stateful across restarts. It remembers:
- Past trades and their outcomes (win/loss, P&L)
- Strategies attempted and their effectiveness
- Market conditions it has observed
- Lessons learned (agent-written notes to its future self)
- Model selection history and cost-effectiveness data

Stored in SQLite. On each wake cycle, the agent loads a summary of relevant history to inform its current decision. The agent decides what's relevant - not all history needs to be loaded every cycle. Loading history costs tokens, so the agent should be selective.

### 9. Objective Framework
Tiered goals, configurable via config file:

- **Tier 1 (survival):** `earnings > api_costs`. Become self-funding.
- **Tier 2 (growth):** Sustain a defined profit margin above costs.
- **Tier 3+ (ambition):** User-defined stretch goals. Scale earnings, diversify strategies, build reserves.

The agent always knows which tier it's operating at and what the threshold is for the next tier.

### 10. Guardrails
Hard constraints that sit outside the agent's control:
- Maximum spending limit (total)
- Maximum transaction size (per trade)
- Maximum API spend per loop cycle
- Maximum API spend per 24h period
- Kill switch (manual via CLI)
- Circuit breaker: if cumulative losses exceed a defined threshold, the agent shuts down automatically and alerts the operator
- The agent cannot modify guardrail values

---

## Agent Loop

The agent runs as a persistent daemon. The core loop:

```
1. Wake (on configurable interval, default 15 minutes)
2. Load current state: balance, costs, portfolio, relevant history
3. Fetch market data (if the agent decides it's worth the cost)
4. Evaluate: Given state + data + objective, what should I do?
5. Decide: Choose action (buy/sell/hold/research/wait)
6. Execute: Perform the action
7. Log: Record everything (reasoning, action, outcome, costs)
8. Update state: Write new portfolio/cost/memory state to DB
9. Sleep until next interval
```

The agent can recommend adjusting its own loop interval. If markets are flat and there's nothing to do, it might suggest extending the interval to save on wake-up costs. If volatility spikes, it might suggest shortening it. The operator approves interval changes via CLI.

**On crash or restart:** The agent reads its last known state from SQLite, checks for any incomplete actions (e.g., a trade that was decided but not confirmed), and resumes. It logs the crash/restart event. It does not re-execute actions that were already completed.

---

## CLI Interface

The operator interacts with VAULT through the command line:

```
vault start              # Start the daemon
vault stop               # Graceful shutdown (finish current cycle, then stop)
vault kill               # Immediate shutdown
vault status             # Current balance, costs, net P&L, tier, agent state
vault logs               # Recent log entries
vault logs --last 20     # Last 20 entries
vault logs --type trade  # Filter by type (trade, research, reasoning, cost, error)
vault logs --since 1h    # Entries from last hour
vault report             # Full session report: earnings, costs, trades, win rate, cost/decision
vault report --daily     # Daily summary
vault config             # Show current config (intervals, guardrails, tiers)
vault config set loop_interval 10m   # Adjust settings
vault history            # Agent's strategy memory / lessons learned
vault pause              # Pause loop (stay running but skip decisions)
vault resume             # Resume from pause
```

---

## Error Handling & Recovery

- **API call failure (Claude):** Retry with exponential backoff, max 3 attempts. If all fail, log the failure and skip this cycle. Do not make a financial decision without reasoning.
- **API call failure (market data):** Use last known prices if fresh enough (configurable staleness threshold, default 5 minutes). If too stale, skip this cycle.
- **Malformed data:** Validate all market data before passing to agent. Log and discard malformed responses.
- **Mid-trade crash:** On restart, check for trades in "pending" state. If the trade was simulated (Phase 1), mark it as failed and log. If real (Phase 2+), query the chain for confirmation before deciding next action.
- **Circuit breaker triggered:** Agent shuts down, logs the reason, and sends an alert (stdout + optional webhook). Requires manual `vault start` with explicit `--override-circuit-breaker` flag to restart.
- **Persistent failures:** If the agent fails 5 consecutive cycles, increase loop interval automatically and alert the operator.

---

## Key Design Principles

1. **The agent must always know its own cost to operate.** Cost-awareness is the central design constraint, not an afterthought.
2. **Persistence is default.** The agent runs continuously, remembers across restarts, and learns from its history.
3. **Modularity over monolith.** Every component should be swappable.
4. **Logging over performance.** Understanding behavior matters more than raw returns.
5. **Simulated costs and earnings first, real ones later.** Phase 1 uses real prices but simulated execution.
6. **No theoretical framework baked into architecture.** We are observing what behaviors emerge, not implementing predefined categories.
7. **"Do nothing" is always an option.** An agent that recognizes when thinking costs more than it's worth is exhibiting intelligence.
8. **Phase 1 infrastructure persists.** The internal ledger becomes the accounting layer in Phase 2. Nothing gets thrown out.
9. **The agent chooses its own tools.** Model selection, research depth, loop interval recommendations - the agent has agency over its own cognitive resource allocation within guardrail bounds.

---

## Tech Stack

- **Language:** Python
- **Database:** SQLite (ledger, logging, cost tracking, strategy memory)
- **Config:** YAML config files for objectives, guardrails, tier thresholds, API pricing, loop interval
- **Market Data:** CoinGecko API, Yahoo Finance API (free tiers) for Phase 1
- **AI Models:** Claude Opus 4.6 (primary), Sonnet 4.5, Haiku 4.5 (delegation targets)
- **Deployment:** VPS via `/jarvis` skill, runs as systemd service or equivalent daemon
- **Interface:** CLI

---

## Do Not

- Build a UI
- Pre-categorize agent behaviors
- Optimize for trading performance prematurely
- Skip cost tracking on any API call
- Hardcode objectives, tier thresholds, or API pricing
- Build Phase 2 wallet infrastructure before Phase 1 agent loop is working
- Let the agent modify its own guardrails
- Make financial decisions without logged reasoning

---

## First Milestone

A persistent daemon running on the VPS where the agent:
1. Wakes on a configurable interval
2. Loads its state (balance, costs, portfolio, relevant history)
3. Can see its own API costs accumulating in real time
4. Queries real market prices (when it judges the cost worthwhile)
5. Makes financial decisions (buy/sell/hold/wait) with fully logged reasoning
6. Writes strategy notes to its memory for future reference
7. Is controllable via CLI (start/stop/status/logs/report)
8. Handles crashes and restarts gracefully
9. Produces reports showing:
   - Total earnings
   - Total API costs (broken down by model)
   - Net P&L
   - Cost per decision
   - Whether it achieved Tier 1 (self-funding)

---

## Context

VAULT is a side project of AXIOM (Actuator eXploration and Implementation Operating Module). AXIOM explores AI agency through the lens of instrumental convergence theory (Bostrom, Omohundro). VAULT takes a different approach: instead of implementing theoretical categories top-down, it creates real economic pressure and observes what behaviors emerge bottom-up. The self-funding constraint naturally produces resource-seeking, cost-optimization, and self-preservation-adjacent behaviors without engineering them explicitly.

AXIOM provides the theory. VAULT provides the evidence.
