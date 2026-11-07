import { expect, test } from 'claude-code/testing'

const MODE = { plugin: 'context-meter', component: 'SessionMode', props: { modes: [] } } as const

test('ring and subagent counter draw on desktop with seeded state', async ($, on) => {
  on('state.get', (_, e: any) =>
    e.key === 'ctx'
      ? { value: { value: { tokens: 330000, limit: 500000, compactAt: 465000 }, version: 1 } }
      : e.key === 'bgs'
      ? { value: { value: [{ id: 't1', type: 'shell', description: 'wait' }, { id: 't2', type: 'monitor', description: 'm' }], version: 1 } }
      : { value: { value: [
          { id: 'a', parentId: null, type: 'clean-haiku', description: 'x', model: 'claude-haiku-5-5', effort: 'low', status: 'running' },
          { id: 'b', parentId: 'a', type: 'clean-sonnet', description: 'y', model: 'claude-sonnet-5-5', effort: 'high', status: 'completed' },
        ], version: 1 } },
  )
  const ui = await $.ui.mount({ ...MODE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /66%/ }))?.text).toBe('◕ 66%')
  expect((await ui.find({ type: "Text", text: /⑂ 1$/ }))?.text?.replace(/^⠀\s*/, "")).toBe("⑂ 1")
  expect((await ui.find({ type: 'Text', text: /^⚙/ }))?.text).toBe('⚙︎ 2')
  await ui.unmount()
})

test('band draws the ring and the subagent tree on desktop', async ($, on) => {
  on('state.get', (_, e: any) =>
    e.key === 'ctx'
      ? { value: { value: { tokens: 330000, limit: 500000, compactAt: 465000 }, version: 1 } }
      : { value: { value: [
          { id: 'a', parentId: null, type: 'clean-haiku', description: 'x', model: 'claude-haiku-5-5', effort: 'low', status: 'running' },
          { id: 'b', parentId: 'a', type: 'clean-sonnet', description: 'y', model: 'claude-sonnet-5-5', effort: 'high', status: 'completed' },
        ], version: 1 } },
  )
  const ui = await $.ui.mount({ plugin: 'context-meter', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false } } as any)
  expect((await ui.find({ type: 'Text', text: /^Context/ }))?.text).toBe('Context 66%')
  expect((await ui.find({ type: 'Text', text: /^Subagents/ }))?.text).toBe('Subagents 1')
  expect((await ui.find({ type: 'Text', text: /Haiku 5\.5/ }))?.text).toContain('Haiku 5.5')
  await ui.unmount()
})

test('Compact now sends /compact', async ($, on) => {
  let sent = ''
  on('state.get', (_, e: any) =>
    e.key === 'ctx' ? { value: { value: { tokens: 330000, limit: 500000, compactAt: 465000 }, version: 1 } } : { value: { value: [], version: 1 } },
  )
  on('command.run', (_, e: any) => {
    sent = '/' + e.command
    return { text: '' } as any
  })
  const ui = await $.ui.mount({ plugin: 'context-meter', component: 'AbovePrompt', surface: 'desktop', props: { hasSurvey: false } } as any)
  await ui.press({ key: 'compact' })
  expect(sent).toBe('/compact')
  await ui.unmount()
})
