// agent-panes: a side pane listing this session's subagents and background
// shell tasks. Click one to follow it: status, time, model and effort, its
// task, every tool call with its outcome, the text it streams and its result.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionAppendInput, Timer, TurnCompleteInput } from 'claude-code'

import type { AgentRec, Feed, FeedItem, RunState } from '../types'
import {
  backgroundIdOf,
  clip,
  countsLine,
  elapsedOf,
  feedFrom,
  isRtl,
  metaLine,
  oneLine,
  ordered,
  parseTaskNotification,
  patch,
  recFromInfo,
  runStateOf,
  runStateOfTask,
  summarizeTool,
  toolLabel,
  upsert,
} from './model.ts'

const PANE = 'subagents'
const TITLE = 'Subagents'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const agentsAtom = atom({ plugin: 'agent-panes', key: 'agents' } as const, [], { shape: 'agents-1' })
const selectedAtom = atom({ plugin: 'agent-panes', key: 'selected' } as const, '')
const feedAtom = atom({ plugin: 'agent-panes', key: 'feed' } as const, { agentId: '', items: [] }, {
  shape: 'feed-1',
})
const liveAtom = atom({ plugin: 'agent-panes', key: 'live' } as const, {}, { shape: 'live-1' })
const expandedAtom = atom({ plugin: 'agent-panes', key: 'expanded' } as const, [], { shape: 'expanded-1' })

type Dollar = EngineInterface

// Module values that need not outlive a reload (no drawing reads them).
let ticker: Timer | undefined
let refreshTimer: Timer | undefined
let ticks = 0
let followEnd = true
const pendingShell = new Set<string>()
// Agents whose streamed text a stored response row has taken over: the live
// text clears once the feed that holds the row is drawn.
const settledLive = new Set<string>()
const notAgents = new Set<string>()

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

type Block = { type: string; [field: string]: unknown }

function isBackgroundShell(block: Block): boolean {
  if (block.type !== 'tool_use' || !SHELL_TOOLS.has(String(block.name))) return false
  const input = block.input as Record<string, unknown> | undefined

  return input?.run_in_background === true
}

function blockText(block: Block): string {
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
  if (block.type !== 'tool_result') return ''
  const content = block.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part => (typeof part === 'object' && part !== null && typeof (part as Block).text === 'string' ? (part as Block).text : ''))
    .join('\n')
}

function stateColor(state: RunState): string {
  switch (state) {
    case 'running':
      return 'suggestion'
    case 'done':
      return 'success'
    case 'failed':
      return 'error'
    case 'stopped':
      return 'warning'
    default:
      return 'inactive'
  }
}

// ---- writes ---------------------------------------------------------------

async function openPane($: Dollar): Promise<void> {
  try {
    await $.ui.open({ id: PANE, title: TITLE })
  } catch {
    // Another plugin's hook refused it; the command still opens it.
  }
}

/** Adds the agents $.agent.list() names that the list lacks (already running at load). */
async function seed($: Dollar): Promise<void> {
  const infos = await $.agent.list()
  if (infos.length === 0) return
  await update($, agentsAtom, list => {
    let next = list
    for (const info of infos) {
      const rec = next.find(one => one.id === info.id)
      if (rec === undefined) next = upsert(next, recFromInfo(info, undefined))
      else if (rec.status === 'running' && runStateOf(info.status) !== 'running') {
        next = patch(next, info.id, one => ({ ...one, status: runStateOf(info.status) }))
      }
    }

    return next
  })
}

/**
 * Makes sure the list holds agent `id`, from $.agent.list() when it is new.
 * False for a loop no list names (the engine's own forks, a workflow's agents).
 */
async function ensureAgent($: Dollar, id: string, isStart: boolean, autoOpen: boolean): Promise<boolean> {
  if (notAgents.has(id)) return false
  const list = await read($, agentsAtom)
  const rec = list.find(one => one.id === id)
  if (rec !== undefined) {
    if (isStart && (rec.status !== 'running' || rec.startedAt === undefined)) {
      const now = await $.clock.now()
      await update($, agentsAtom, l =>
        patch(l, id, one => {
          const { endedAt: _gone, ...rest } = one

          return { ...rest, status: 'running', startedAt: one.status === 'running' ? (one.startedAt ?? now) : now }
        }),
      )
    }

    return true
  }
  const info = (await $.agent.list()).find(one => one.id === id)
  if (info === undefined) {
    if (!isStart) notAgents.add(id)

    return false
  }
  const now = await $.clock.now()
  let isNew = false
  await update($, agentsAtom, l => {
    if (l.some(one => one.id === id)) return l
    isNew = true

    return upsert(l, { ...recFromInfo(info, now), status: 'running' })
  })
  if (isNew && autoOpen) await openPane($)

  return true
}

async function setLive($: Dollar, id: string, text: string): Promise<void> {
  const tail = text.length > 1500 ? `…${text.slice(-1500)}` : text
  await update($, liveAtom, map => ({ ...map, [id]: tail }))
}

async function clearLive($: Dollar, id: string): Promise<void> {
  const map = await read($, liveAtom)
  if (map[id] === undefined) return
  await update($, liveAtom, m => {
    const { [id]: _gone, ...rest } = m

    return rest
  })
}

async function noteStep($: Dollar, id: string, model: string, effort: string | number | undefined): Promise<void> {
  const rec = (await read($, agentsAtom)).find(one => one.id === id)
  if (rec === undefined) return
  const level = effort === undefined ? undefined : String(effort)
  if (rec.model === model && rec.effort === level) return
  await update($, agentsAtom, l =>
    patch(l, id, one => ({ ...one, model, ...(level === undefined ? {} : { effort: level }) })),
  )
}

async function agentEnded($: Dollar, e: TurnCompleteInput, autoOpen: boolean): Promise<void> {
  const id = e.agentId
  if (id === undefined || !(await ensureAgent($, id, false, autoOpen))) return
  const now = await $.clock.now()
  await update($, agentsAtom, l =>
    patch(l, id, one => {
      const state: RunState =
        e.reason === 'answer'
          ? one.type === 'teammate'
            ? 'idle'
            : 'done'
          : e.reason === 'aborted'
            ? 'stopped'
            : 'failed'

      return {
        ...one,
        status: state,
        endedAt: now,
        ...(e.answer.trim() === '' ? {} : { result: e.answer }),
        ...(one.startedAt === undefined ? { startedAt: now - e.durationMs } : {}),
      }
    }),
  )
  if ((await read($, selectedAtom)) === id) await refreshFeed($)
  await clearLive($, id)
}

// ---- the feed of the agent on show ----------------------------------------

async function refreshFeed($: Dollar): Promise<void> {
  const id = await read($, selectedAtom)
  if (id === '') return
  const rec = (await read($, agentsAtom)).find(one => one.id === id)
  let feed: Feed = { agentId: id, items: [] }
  if (rec?.kind === 'agent') {
    const found = await $.session.messages({ agentId: id })
    feed = Array.isArray(found)
      ? { agentId: id, items: feedFrom(found) }
      : { agentId: id, items: [], denied: found.deny }
  }
  const before = await read($, feedAtom)
  const grew = before.agentId !== id || before.items.length !== feed.items.length
  await update($, feedAtom, () => feed)
  if (settledLive.delete(id)) await clearLive($, id)
  if (grew) await scrollToEnd($)
}

function scheduleRefresh($: Dollar): void {
  if (refreshTimer !== undefined) return
  refreshTimer = $.clock.after(250, () => {
    refreshTimer = undefined
    void refreshFeed($).catch(() => undefined)
  })
}

async function scrollToEnd($: Dollar): Promise<void> {
  if (!followEnd) return
  try {
    await $.ui.scroll({ in: PANE, to: 'end' })
  } catch {
    // The pane is not open.
  }
}

async function select($: Dollar, id: string): Promise<void> {
  await update($, selectedAtom, () => id)
  followEnd = true
  if (id !== '') {
    await refreshFeed($)
    await scrollToEnd($)
  } else {
    try {
      await $.ui.scroll({ in: PANE, to: 'start' })
    } catch {
      // The pane is not open.
    }
  }
}

async function toggleExpanded($: Dollar, key: string): Promise<void> {
  await update($, expandedAtom, list =>
    list.includes(key) ? list.filter(one => one !== key) : [...list, key].slice(-200),
  )
}

// ---- rows of the conversations ---------------------------------------------

async function onRow($: Dollar, e: SessionAppendInput, autoOpen: boolean): Promise<void> {
  const blocks = e.message.content as readonly Block[]
  const id = e.agentId
  const now = await $.clock.now()

  if (e.message.type === 'assistant') {
    const uses = blocks.filter(block => block.type === 'tool_use')
    for (const block of uses.filter(isBackgroundShell)) {
      const input = (block.input ?? {}) as Record<string, unknown>
      const command = typeof input.command === 'string' ? input.command : ''
      const description = typeof input.description === 'string' && input.description.trim() !== '' ? input.description : command
      pendingShell.add(String(block.id))
      await update($, agentsAtom, l =>
        upsert(l, {
          id: `sh:${String(block.id)}`,
          kind: 'shell',
          description: oneLine(description, 200),
          command,
          status: 'running',
          startedAt: now,
          tools: 0,
          ...(id === undefined ? {} : { parentId: id }),
        }),
      )
      if (autoOpen) await openPane($)
    }
    if (id !== undefined && (await ensureAgent($, id, false, autoOpen))) {
      const last = uses.at(-1)
      if (last !== undefined) {
        const input = (last.input ?? {}) as Record<string, unknown>
        const name = String(last.name)
        const summary = summarizeTool(name, input)
        const line = summary === '' ? toolLabel(name) : `${toolLabel(name)}  ${summary}`
        await update($, agentsAtom, l => patch(l, id, one => ({ ...one, tools: one.tools + uses.length, last: line })))
      }
      if ((await read($, selectedAtom)) === id) {
        settledLive.add(id)
        scheduleRefresh($)
      } else await clearLive($, id)
    }

    return
  }

  if (e.message.type !== 'user') return
  for (const block of blocks) {
    if (block.type === 'tool_result' && pendingShell.has(String(block.tool_use_id))) {
      const useId = String(block.tool_use_id)
      pendingShell.delete(useId)
      const taskId = backgroundIdOf(blockText(block))
      const isError = block.is_error === true
      await update($, agentsAtom, l =>
        patch(l, `sh:${useId}`, one => ({
          ...one,
          ...(taskId === undefined ? {} : { taskId }),
          ...(isError ? { status: 'failed' as const, endedAt: now, result: oneLine(blockText(block), 400) } : {}),
        })),
      )
    }
    const text = blockText(block)
    const note = text.includes('<task-id>') ? parseTaskNotification(text) : undefined
    if (note !== undefined) {
      const state = runStateOfTask(note.status)
      await update($, agentsAtom, l => {
        const rec = l.find(one => one.taskId === note.taskId || one.id === note.taskId)
        if (rec === undefined || rec.status !== 'running') return l

        return patch(l, rec.id, one => ({
          ...one,
          status: state,
          ...(state === 'running' ? {} : { endedAt: now }),
          ...(note.summary === undefined ? {} : { result: note.summary }),
        }))
      })
    }
  }
  if (id !== undefined && (await read($, selectedAtom)) === id && (await ensureAgent($, id, false, autoOpen))) {
    scheduleRefresh($)
  }
}

/** Is the row worth a look? Decided without a call on `$`, so most rows cost nothing. */
function isWatched(e: SessionAppendInput): boolean {
  if (e.agentId !== undefined) return e.message.type === 'assistant' || e.message.type === 'user'
  const blocks = e.message.content as readonly Block[]
  if (e.message.type === 'assistant') return blocks.some(isBackgroundShell)
  if (e.message.type !== 'user') return false

  return blocks.some(
    block =>
      (block.type === 'tool_result' && pendingShell.has(String(block.tool_use_id))) ||
      blockText(block).includes('<task-id>'),
  )
}

// ---- the clock ---------------------------------------------------------------

async function tick($: Dollar): Promise<void> {
  ticks += 1
  const list = await read($, agentsAtom)
  if (!list.some(one => one.status === 'running')) return
  $.ui.invalidate('ui.render')
  if (ticks % 5 !== 0) return
  // Catch what no event told (an agent killed from the tasks list).
  const infos = await $.agent.list()
  const now = await $.clock.now()
  const ended = list.filter(one => {
    if (one.kind !== 'agent' || one.status !== 'running') return false
    const info = infos.find(i => i.id === one.id)

    return info !== undefined && runStateOf(info.status) !== 'running'
  })
  if (ended.length === 0) return
  await update($, agentsAtom, l =>
    l.map(one => {
      const info = ended.find(x => x.id === one.id) && infos.find(i => i.id === one.id)
      if (!info || one.status !== 'running') return one

      return { ...one, status: runStateOf(info.status), endedAt: now }
    }),
  )
}

// ---- the hooks ---------------------------------------------------------------

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpen !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Show or hide the subagents pane (/subagents auto on|off: open it when one starts)',
      argumentHint: '[auto on|off]',
      immediate: true,
    })
    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void tick($).catch(() => undefined)
    })
    void seed($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (args === 'auto on' || args === 'auto off') {
      const isOn = args === 'auto on'
      const set = await $.config.set({ key: 'agent-panes.autoOpen', value: isOn })
      if ('deny' in set && set.deny !== undefined) return { text: `Not changed: ${set.deny}` }

      return {
        text: isOn
          ? 'The subagents pane now opens by itself when a subagent starts.'
          : 'The subagents pane no longer opens by itself.',
      }
    }
    if (args !== '') return { text: 'Use /subagents to show or hide the pane, or /subagents auto on|off.' }
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })

      return { text: 'Subagents pane closed.' }
    }
    await seed($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Subagents pane opened.' : `Subagents pane waits: ${opened.reason}` }
  })

  on('turn.start', ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      void ensureAgent($, id, true, autoOpen)
        .then(isAgent => {
          // A loop the list does not name yet may still be registering.
          if (!isAgent) {
            $.clock.after(1000, () => {
              void ensureAgent($, id, false, autoOpen).catch(() => undefined)
            })
          }
        })
        .catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    void noteStep($, id, e.model, e.effort).catch(() => undefined)
    let text = ''
    let written = 0
    for await (const chunk of next(e)) {
      yield chunk
      if (chunk.kind !== 'text') continue
      text += chunk.text
      if (text.length - written >= 60 || written === 0) {
        written = text.length
        void setLive($, id, text).catch(() => undefined)
      }
    }
    // The whole text, before the engine stores the response row.
    if (text.length > written) await setLive($, id, text).catch(() => undefined)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined) void agentEnded($, e, autoOpen).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', ($, e, next) => {
    if (isWatched(e)) void onRow($, e, autoOpen).catch(() => undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', ($, e, next) => {
    const tasks = e.background_tasks
    if (Array.isArray(tasks)) {
      void (async () => {
        const now = await $.clock.now()
        await update($, agentsAtom, list => {
          let out = list
          for (const task of tasks) {
            if (task.type !== 'shell') continue
            if (out.some(one => one.taskId === task.id)) continue
            out = upsert(out, {
              id: `bg:${task.id}`,
              kind: 'shell',
              description: oneLine(task.description || task.command || 'shell', 200),
              ...(task.command === undefined ? {} : { command: task.command }),
              taskId: task.id,
              status: 'running',
              tools: 0,
            })
          }

          return out.map(one =>
            one.kind === 'shell' &&
            one.status === 'running' &&
            one.taskId !== undefined &&
            !tasks.some(task => task.id === one.taskId)
              ? { ...one, status: 'done' as const, endedAt: now }
              : one,
          )
        })
      })().catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // A /clear starts a new conversation: the old one's agents leave the list.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, agentsAtom, list => list.filter(one => one.status === 'running'))
      await update($, selectedAtom, () => '')
      await update($, feedAtom, () => ({ agentId: '', items: [] }))
      await update($, expandedAtom, () => [])
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    if (e.origin.kind === 'person') followEnd = e.offset + e.bodyRows >= e.contentRows - 1

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [list, selectedId, feed, live, expanded, now] = await Promise.all([
      read($, agentsAtom),
      read($, selectedAtom),
      read($, feedAtom),
      read($, liveAtom),
      read($, expandedAtom),
      $.clock.now(),
    ])
    const width = Math.max(20, e.props.bodyColumns)
    const pulse = Math.floor(now / 700) % 2 === 0
    const rows = ordered(list)

    const dot = (rec: AgentRec) => (
      <Text color={stateColor(rec.status)} dimColor={rec.status === 'running' && !pulse}>
        ●
      </Text>
    )

    // The small form on the desktop app: a glance, clicks may not reach it.
    if (e.props.placement === 'widget') {
      const first = rows.find(one => one.status === 'running')

      return (
        <Box flexDirection="column">
          <Text color="text" weight="medium">
            {countsLine(list) || 'No subagents'}
          </Text>
          {first !== undefined && (
            <Text color="inactive" wrap="truncate-end">
              {first.description}
            </Text>
          )}
        </Box>
      )
    }

    const rec = selectedId === '' ? undefined : list.find(one => one.id === selectedId)

    if (rec === undefined) {
      if (rows.length === 0) return <Text color="inactive">No subagents yet</Text>

      return (
        <Box flexDirection="column" gap={1}>
          <Text color="inactive">{countsLine(list)}</Text>
          {rows.map(one => {
            const elapsed = elapsedOf(one, now)
            const meta = metaLine(one)
            const doing = one.status === 'running' ? one.last : undefined

            return (
              <Box flexDirection="column">
                <Button key={`open:${one.id}`} plain onPress={() => void select($, one.id)}>
                  {dot(one)}
                  <Text color="text" weight="medium">
                    {' '}
                    {oneLine(one.description, Math.max(12, width - 12))}
                  </Text>
                  {elapsed !== undefined && (
                    <Text color="inactive" tabular>
                      {'  '}
                      {elapsed}
                    </Text>
                  )}
                </Button>
                {meta !== '' && (
                  <Text color="inactive" wrap="truncate-end">
                    {'  '}
                    {meta}
                  </Text>
                )}
                {doing !== undefined && (
                  <Text color="subtle" wrap="truncate-end">
                    {'  '}
                    {doing}
                  </Text>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    // ---- one agent's panel ----
    const others = rows.filter(one => one.id !== rec.id)
    const elapsed = elapsedOf(rec, now)
    const meta = metaLine(rec)
    const isRunning = rec.status === 'running'
    const items: readonly FeedItem[] = feed.agentId === rec.id ? feed.items : []
    const liveText = isRunning ? live[rec.id] : undefined
    const longChars = width * 6
    const isOpen = (key: string) => expanded.includes(`${rec.id}:${key}`)

    const more = (key: string, cut: boolean) =>
      cut || isOpen(key) ? (
        <Button key={`x:${key}`} plain dimColor onPress={() => void toggleExpanded($, `${rec.id}:${key}`)}>
          {isOpen(key) ? 'less' : 'more'}
        </Button>
      ) : null

    const textBlock = (key: string, text: string, maxLines: number, color: string) => {
      const shown = isOpen(key) ? { text, isCut: false } : clip(text, maxLines, longChars)

      return (
        <Box flexDirection="column">
          <Text color={color} dir={isRtl(text) ? 'rtl' : undefined}>
            {shown.text}
          </Text>
          {more(key, shown.isCut)}
        </Box>
      )
    }

    // Consecutive tool calls sit together; texts stand apart.
    const groups: FeedItem[][] = []
    for (const item of items) {
      const last = groups.at(-1)
      if (item.kind === 'tool' && last?.[0]?.kind === 'tool') last.push(item)
      else groups.push([item])
    }

    const toolLine = (item: FeedItem) => {
      const glyph = item.state === 'run' ? '◌' : item.state === 'err' ? '✗' : '✓'
      const color = item.state === 'run' ? 'suggestion' : item.state === 'err' ? 'error' : 'success'

      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={color}>{glyph} </Text>
            <Text color="text" weight="medium">
              {item.label}
            </Text>
            {item.text !== '' && <Text color="inactive">{`  ${item.text}`}</Text>}
          </Text>
          {item.state === 'err' && item.detail !== undefined && (
            <Text color="error" wrap="truncate-end">
              {'  '}
              {item.detail}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key="back" plain onPress={() => void select($, '')}>
            ‹ All
          </Button>
          <Text color="inactive">{countsLine(list)}</Text>
        </Box>

        {others.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {others.map(one => (
              <Button key={`go:${one.id}`} plain dimColor onPress={() => void select($, one.id)}>
                {dot(one)}
                <Text color="inactive"> {oneLine(one.description, 22)}</Text>
              </Button>
            ))}
          </Box>
        )}

        <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1}>
          <Text color="text" weight="semibold" dir={isRtl(rec.description) ? 'rtl' : undefined}>
            {rec.description}
          </Text>
          <Text>
            {dot(rec)}
            <Text color={stateColor(rec.status)}> {rec.status}</Text>
            {elapsed !== undefined && <Text color="inactive" tabular>{` · ${elapsed}`}</Text>}
            {rec.tools > 0 && <Text color="inactive">{` · ${rec.tools} tool calls`}</Text>}
          </Text>
          {meta !== '' && (
            <Text color="inactive" wrap="truncate-end">
              {meta}
            </Text>
          )}
        </Box>

        {rec.kind === 'agent' && feed.agentId === rec.id && feed.denied !== undefined && (
          <Text color="warning">{feed.denied}</Text>
        )}
        {rec.kind === 'agent' && feed.agentId !== rec.id && <Text color="inactive">Loading…</Text>}

        {groups.map(group => {
          const head = group[0]
          if (head === undefined) return null
          if (head.kind === 'tool') return <Box flexDirection="column">{group.map(toolLine)}</Box>
          if (head.kind === 'text') return textBlock(head.key, head.text, 6, 'text')

          return (
            <Box flexDirection="column">
              <Text color="inactive" weight="medium">
                {head.kind === 'prompt' ? 'Task' : 'Message'}
              </Text>
              {textBlock(head.key, head.text, head.kind === 'prompt' ? 3 : 4, 'inactive')}
            </Box>
          )
        })}

        {isRunning && rec.kind === 'agent' && (
          <Box flexDirection="column">
            <Text color="suggestion" dimColor={!pulse}>
              {liveText === undefined ? '● working' : '● writing'}
            </Text>
            {liveText !== undefined && (
              <Text color="text" dir={isRtl(liveText) ? 'rtl' : undefined}>
                {clip(liveText.split('\n').slice(-8).join('\n'), 8, longChars).text}
              </Text>
            )}
          </Box>
        )}

        {!isRunning && rec.result !== undefined && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={rec.status === 'failed' ? 'error' : rec.status === 'stopped' ? 'warning' : 'success'}
            paddingX={1}
          >
            <Text color={stateColor(rec.status)} weight="semibold">
              Result
            </Text>
            {textBlock('result', rec.result, 10, 'text')}
          </Box>
        )}
      </Box>
    )
  })
}
