import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, SessionMessage, UiPane } from 'claude-code'

import {
  clip,
  countsLine,
  feedFrom,
  formatElapsed,
  isRtl,
  ordered,
  parseTaskNotification,
  prettyModel,
  summarizeTool,
  toolLabel,
} from '../hooks/model.ts'
import type { AgentRec } from '../types'

const PRESENTATION = { isFullscreen: false, columns: 120 }

const PANE = {
  plugin: 'agent-panes',
  component: 'Pane',
  requestId: 'subagents',
  props: {
    title: 'Subagents',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const INFO: AgentInfo = {
  id: 'a1',
  description: 'ساخت بازی FPS',
  type: 'general-purpose',
  status: 'running',
}

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'Build the FPS level loader.', toolUses: [] },
  {
    role: 'assistant',
    text: 'I will read the loader first.',
    toolUses: [
      {
        tool_use_id: 't1',
        tool: 'Read',
        input: { file_path: 'C:/game/src/level/loader.ts' },
        text: 'export function load() {}',
      },
      { tool_use_id: 't2', tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
    ],
  },
]

test('the feed reads an agent conversation oldest first', () => {
  const items = feedFrom(MESSAGES)
  expect(items.map(item => item.kind)).toEqual(['prompt', 'text', 'tool', 'tool'])
  expect(items[2]).toMatchObject({ label: 'Read', text: '…/level/loader.ts', state: 'ok' })
  expect(items[3]).toMatchObject({ label: 'Bash', text: 'Run the tests', state: 'run' })
})

test('the small helpers', () => {
  expect(prettyModel('claude-fable-5-2')).toBe('Fable 5.2')
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(prettyModel('gpt-x')).toBe('gpt-x')
  expect(formatElapsed(45_000)).toBe('45s')
  expect(formatElapsed(134_000)).toBe('2m 14s')
  expect(formatElapsed(3_900_000)).toBe('1h 05m')
  expect(isRtl('ساخت بازی FPS')).toBe(true)
  expect(isRtl('Build the FPS game')).toBe(false)
  expect(toolLabel('mcp__tg__send_message')).toBe('send_message')
  expect(summarizeTool('Grep', { pattern: 'load', path: 'C:/game/src' })).toBe('load in …/game/src')
  expect(clip('a\nb\nc\nd', 2, 100)).toEqual({ text: 'a\nb…', isCut: true })
  expect(parseTaskNotification('<task-id>b7</task-id><status>completed</status><summary>ok</summary>')).toEqual({
    taskId: 'b7',
    status: 'completed',
    summary: 'ok',
  })
  const recs: AgentRec[] = [
    { id: 'x', kind: 'agent', description: 'old', status: 'done', tools: 0 },
    { id: 'y', kind: 'agent', description: 'live', status: 'running', tools: 0 },
    { id: 'z', kind: 'agent', description: 'bad', status: 'failed', tools: 0 },
  ]
  expect(ordered(recs).map(one => one.id)).toEqual(['y', 'z', 'x'])
  expect(countsLine(recs)).toBe('1 running · 1 done · 1 failed')
})

test('a subagent opens the pane, its panel follows it live, and it ends with its result', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.scroll', () => ({}))
  // The list names the agent once it has started, as in a session.
  let agents: AgentInfo[] = []
  on('agent.list', () => ({ value: agents }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'Now running the tests ' }
    yield { kind: 'text', index: 0, text: 'for the level loader.' }

    return {
      turnId: e.turnId,
      index: e.index,
      text: 'Now running the tests for the level loader.',
      answer: 'Now running the tests for the level loader.',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  agents = [INFO]
  await $.turn.start({ text: 'Build the FPS level loader.', turnId: 'r1', agentId: 'a1' })
  await clock.advance(10)
  expect(opened).toEqual(['subagents'])

  await clock.advance(30_000)
  for await (const _ of $.turn.step({
    turnId: 'r1',
    index: 0,
    model: 'claude-fable-5-2',
    effort: 'high',
    messageCount: 2,
    agentId: 'a1',
  })) {
    // The chunks pass through the mod unchanged.
  }
  await clock.advance(10)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /ساخت بازی FPS/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Fable 5\.2 · high/ }))?.text).toContain('general-purpose')
    expect((await ui.find({ type: 'Text', text: /30s/ }))).toBeDefined()

    await ui.press({ key: 'open:a1' })
    expect((await ui.find({ type: 'Text', text: /^Task$/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /loader\.ts/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Run the tests/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /writing/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /for the level loader\./ }))).toBeDefined()

    await ui.press({ key: 'back' })
    expect((await ui.find({ type: 'Text', text: /1 running/ }))).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({
    answer: 'The loader is done and the tests pass.',
    durationMs: 31_000,
    isAborted: false,
    turnId: 'r1',
    agentId: 'a1',
    reason: 'answer',
  })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:a1' })
  expect((await ui.find({ type: 'Text', text: /^Result$/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /tests pass/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /writing/ }))).toBeUndefined()
  await ui.press({ key: 'back' })
  expect((await ui.find({ type: 'Text', text: /1 done/ }))).toBeDefined()
  await ui.unmount()
})

test('/subagents opens and closes the pane, and sets whether it opens by itself', async ($, on) => {
  let panes: UiPane[] = []
  const closed: string[] = []
  const set: unknown[] = []
  on('agent.list', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: panes }))
  on('ui.close', (_, e) => {
    closed.push(e.id)
    panes = []

    return { value: undefined }
  })
  on('config.set', (_, e) => {
    set.push([e.key, e.value])

    return { value: e.value }
  })

  const run = (args: string) =>
    $.command.run({ command: 'subagents', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

  expect((await run('')).text).toBe('Subagents pane opened.')
  expect((await run('')).text).toBe('Subagents pane closed.')
  expect(closed).toEqual(['subagents'])
  expect((await run('auto off')).text).toBe('The subagents pane no longer opens by itself.')
  expect(set).toEqual([['agent-panes.autoOpen', false]])
  expect((await run('purple')).text).toContain('/subagents auto on|off')
})

test('with no subagents the pane says so', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No subagents yet')
  await ui.unmount()
})

test('a background shell task and an agent tool call are read from the conversation rows', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [INFO] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tb',
          name: 'Bash',
          input: { command: 'npm run dev', description: 'Start the dev server', run_in_background: true },
        },
      ],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'r1',
  })
  await clock.advance(10)
  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tb', content: 'Command running in background with ID: b42' }],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: 'r2',
  })
  await clock.advance(10)

  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await clock.advance(10)
  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'spawnEnemy' } }],
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-fable-5-2' },
    uuid: 'r3',
    agentId: 'a1',
  })
  await clock.advance(10)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Start the dev server/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /shell · npm run dev/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Grep  spawnEnemy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 running/ })).toBeDefined()
  await ui.unmount()

  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      isMeta: true,
      content: [
        {
          type: 'text',
          text: '<task-notification><task-id>b42</task-id><status>completed</status><summary>Dev server exited</summary></task-notification>',
        },
      ],
    },
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: 'r4',
  })
  await clock.advance(10)

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /1 running · 1 done/ })).toBeDefined()
  await after.press({ key: 'open:sh:tb' })
  expect(await after.find({ type: 'Text', text: /Dev server exited/ })).toBeDefined()
  await after.unmount()
})

test('a /clear empties the list of finished agents', async ($, on) => {
  const clock = mock.clock(on, { now: 3_000_000 })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [INFO] }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  await clock.advance(10)
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  await clock.advance(10)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No subagents yet')
  await ui.unmount()
})
