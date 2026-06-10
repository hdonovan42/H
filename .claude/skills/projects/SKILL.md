---
name: projects
description: Router for all projects. Use `/projects <name>` to load project context and start working.
argument-hint: <project-name> [task description]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, WebFetch, WebSearch, Agent, Skill
---

# Projects Router

Route to the correct project context based on the first argument.

## How to Route

Parse `$ARGUMENTS` — the first word is the **project name**, everything after is the **task** (may be empty).

### Step 1: Normalise the project name

Map common aliases to canonical directory names (case-insensitive):

| Input | Directory | Has skill? |
|-------|-----------|------------|
| `vault` | `VAULT` | Yes → `/vault` |
| `waymowatch`, `waymo`, `waymonet` | `waymowatch` | Yes → `/waymowatch` |
| `all-in`, `allin` | `all-in` | Yes → `/all-in` |
| `autosnipe`, `snipe` | `autosnipe` | Yes → `/autosnipe` |
| `axiom`, `axiom2`, `axiom-v2` | `AXIOM_v2` | No |
| `axiom1`, `axiom-v1` | `axiom` | No |
| `command-centre`, `cc` | `command-centre` | No |
| `costco`, `costco-tyres`, `tyres` | `costco-tyres` | No |
| `chess` | `chess` | No |
| `globe` | `globe` | No |
| `roadtrip` | `roadtrip` | No |
| `carcompare`, `car-compare` | `carCompare` | No |

If the input doesn't match any alias, check if `projects/<input>/` exists as a directory. If not, list available projects and ask the user which one they meant.

### Step 2: Delegate

**If the project has a dedicated skill** (marked "Yes" above):
→ Use the **Skill tool** to invoke that skill, passing the remaining task arguments.
Example: `/projects vault check status` → invoke Skill `vault` with args `check status`.

**If the project does NOT have a dedicated skill**:
→ Explore the project directory yourself and build working context:

1. Read `projects/<dir>/CLAUDE.md` if it exists (project-specific instructions)
2. Read `projects/<dir>/package.json` or `projects/<dir>/pyproject.toml` for tech stack
3. Glob key files: `projects/<dir>/src/**/*.{jsx,tsx,js,ts,py}`, `projects/<dir>/*.config.*`
4. Understand the project structure, entry points, and architecture
5. Report a brief summary of what you found to the user
6. If a task was provided, carry it out. Otherwise, ask what to work on.

### Step 3: If no argument provided

If `$ARGUMENTS` is empty, list all available projects with their descriptions:

```
Available projects:
  vault        — Autonomous Polymarket trading agent (dedicated skill)
  all-in       — Real-time stock tracker dashboard (dedicated skill)
  autosnipe    — Used car search alerting system (dedicated skill)
  axiom        — AXIOM v2 self-recursive capability system
  axiom1       — AXIOM v1 actuator research dashboard (archived)
  cc           — Command Centre agent orchestration dashboard
  costco       — Costco UK Michelin tyre stock checker
  chess        — Chess project
  globe        — Globe project
  roadtrip     — Road trip project
  carcompare   — Car comparison project
```

Then ask which project to work on.

## Rules

- **Never overwrite or duplicate** a dedicated project skill — always delegate to it
- When exploring a project without a skill, keep the summary concise
- Pass through ALL task arguments to the delegated skill unchanged

## Arguments

$ARGUMENTS
