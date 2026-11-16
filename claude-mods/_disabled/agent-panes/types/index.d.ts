// The values the agent-panes mod keeps in $.state.

/** Where one agent or background task stands, as the pane draws it. */
export type RunState = 'running' | 'idle' | 'done' | 'failed' | 'stopped'

/** One row of the list: a subagent (`agent`) or a background shell task (`shell`). */
export type AgentRec = {
  /** The agent's id ($.agent.list), or `sh:<tool_use_id>` / `bg:<task id>` for a shell task. */
  id: string
  kind: 'agent' | 'shell'
  description: string
  /** Subagent type (general-purpose, Explore, ...). */
  type?: string
  name?: string
  parentId?: string
  /** The model id of its latest request, once a request was seen. */
  model?: string
  effort?: string
  status: RunState
  /** $.clock.now() when the mod first saw it run; absent for one already running at load. */
  startedAt?: number
  endedAt?: number
  /** Tool calls seen so far. */
  tools: number
  /** Its latest tool call, summarised. */
  last?: string
  /** Its final answer (agents) or the notification's summary (shell tasks). */
  result?: string
  /** Shell tasks: the command line, and the background task id the tool result named. */
  command?: string
  taskId?: string
}

/** One line of an agent's live feed. */
export type FeedItem = {
  key: string
  kind: 'prompt' | 'text' | 'tool' | 'note'
  /** The tool's short name for `tool`. */
  label?: string
  text: string
  state?: 'run' | 'ok' | 'err'
  /** The first line of a tool's result. */
  detail?: string
}

/** The feed of the agent the pane shows. */
export type Feed = { agentId: string; items: FeedItem[]; denied?: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-panes': {
      agents: Shaped<AgentRec[]>
      /** The id of the agent the pane shows; '' for the list. */
      selected: string
      feed: Shaped<Feed>
      /** Text a running agent is streaming now, by agent id. */
      live: Shaped<Record<string, string>>
      /** Feed items opened in full, as `<agentId>:<itemKey>`. */
      expanded: Shaped<string[]>
    }
  }
}
