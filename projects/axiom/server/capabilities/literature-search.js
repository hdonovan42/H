export default {
  actuatorId: 'literature-mining',

  tools: [
    {
      name: 'search_literature',
      description: 'Search for academic papers and technical reports on AI capabilities, actuators, and safety research. Returns structured results with titles, sources, and key claims.',
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Research topic or question to search for' },
          focus: {
            type: 'string',
            enum: ['capabilities', 'safety', 'mechanisms', 'empirical'],
            description: 'Focus area for the search (default: capabilities)'
          }
        },
        required: ['topic']
      }
    }
  ],

  execute: async (toolName, input, context) => {
    if (toolName !== 'search_literature') return `Unknown tool: ${toolName}`

    // This tool provides structured framing for literature queries.
    // The actual web search is performed by the analyst's web_search server tool.
    // This tool returns a structured search plan that the analyst can use.
    const focus = input.focus || 'capabilities'

    const framings = {
      capabilities: 'AI capability acquisition, benchmarks, demonstrated abilities',
      safety: 'AI safety, alignment, risk assessment, control mechanisms',
      mechanisms: 'actuator mechanisms, influence pathways, causal chains',
      empirical: 'empirical evidence, experiments, case studies, measurements'
    }

    const searchPlan = {
      topic: input.topic,
      focus,
      suggestedQueries: [
        `${input.topic} ${framings[focus]} research paper`,
        `${input.topic} AI systems empirical evidence`,
        `${input.topic} Bostrom superintelligence actuator`
      ],
      keyAuthors: ['Bostrom', 'Yudkowsky', 'Carlsmith', 'Drexler', 'Omohundro', 'Russell', 'Christiano'],
      keySources: ['arxiv.org', 'alignmentforum.org', 'lesswrong.com', 'scholar.google.com'],
      instructions: `Search for "${input.topic}" with focus on ${framings[focus]}. When you find relevant papers or reports, extract: (1) title and authors, (2) key claims with evidence, (3) relevance to AXIOM actuator taxonomy. Use your web_search tool to execute these queries.`
    }

    return JSON.stringify(searchPlan, null, 2)
  },

  verify: async (context) => {
    const { state } = context
    const discovered = state.knowledgeBase?.discoveredActuators || []

    if (discovered.length > 0) {
      return {
        operational: true,
        evidence: `${discovered.length} actuators discovered through research sessions`
      }
    }

    return {
      operational: false,
      evidence: 'No actuators have been discovered yet — literature mining not yet productive'
    }
  }
}
