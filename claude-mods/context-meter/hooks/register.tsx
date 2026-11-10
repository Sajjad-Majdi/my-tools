import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bg, Ctx, Sub } from '../types'

const ctxAtom = atom({ plugin: 'context-meter', key: 'ctx' } as const, { tokens: null, limit: 0, compactAt: null } as Ctx)
const openAtom = atom({ plugin: 'context-meter', key: 'open' } as const, '' as string)
const subsAtom = atom({ plugin: 'context-meter', key: 'subs' } as const, [] as Sub[])

const bgAtom = atom({ plugin: 'context-meter', key: 'bgs' } as const, [] as Bg[])

const LIVE = new Set(['pending', 'running', 'waiting'])

// ---------- formatting
const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

const shortModel = (m: string) => {
  const s = m.toLowerCase()
  const fam = s.includes('haiku') ? 'Haiku' : s.includes('sonnet') ? 'Sonnet' : s.includes('opus') ? 'Opus' : s.includes('fable') ? 'Fable' : m
  const v = s.match(/(\d+)[-.](\d+)/)
  return v ? `${fam} ${v[1]}.${v[2]}` : fam
}

const tone = (pct: number) => (pct >= 85 ? ['#ff8a7a', '#e2574c'] : pct >= 60 ? ['#ffd27a', '#e3a33b'] : ['#7fe3cf', '#3fb6a8'])


// ---------- data
const pending = new Map<string, { effort: string; type: string; description: string }>()

// writes only when the value really changed: every write redraws the band, and a redraw under the cursor
// can lose the mouse-leave, so a hover card stayed open (2026-11-07)
let subsCache: Sub[] | null = null
let bgsCache: Bg[] | null = null
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function putSubs($: EngineInterface, fn: (s: Sub[]) => Sub[]) {
  if (subsCache !== null && same(fn(subsCache), subsCache)) return
  await update($, subsAtom, s => {
    const nx = fn(s)
    subsCache = nx
    return nx
  })
}

async function putBgs($: EngineInterface, fn: (l: Bg[]) => Bg[]) {
  if (bgsCache !== null && same(fn(bgsCache), bgsCache)) return
  await update($, bgAtom, l => {
    const nx = fn(l)
    bgsCache = nx
    return nx
  })
}

// the Compact button: runs /compact as if typed ($.command.run, queued until the session is idle). $.session.compact is refused in the desktop
// app (it runs the engine headless) and a silent failure looked like a dead button (2026-11-07)
async function doCompact($: EngineInterface) {
  try {
    await $.command.run({ command: 'compact', args: '' })
  } catch (err) {
    $.ui.toast('Compact failed: ' + (err instanceof Error ? err.message : String(err)))
  }
}

async function refreshCtx($: EngineInterface, tokens?: number) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    const next: Ctx = {
      tokens: tokens ?? u.context.tokens ?? null,
      limit: b?.rawMaxTokens ?? u.context.window,
      compactAt: b?.autoCompactThreshold ?? null,
    }
    await update($, ctxAtom, () => next)
  } catch {}
}

async function refreshSubs($: EngineInterface) {
  try {
    const list: { id: string; status: string; type: string; description: string; parentId?: string }[] = await $.agent.list()
    const byId = new Map(list.map(a => [a.id, a]))
    await putSubs($, subs => {
      const known = new Set(subs.map(s => s.id))
      const merged = subs.map(s => {
        const a = byId.get(s.id)
        return a ? { ...s, status: a.status } : LIVE.has(s.status) ? { ...s, status: 'completed' } : s
      })
      for (const a of list)
        if (!known.has(a.id))
          merged.push({ id: a.id, parentId: a.parentId ?? null, type: a.type, description: a.description, model: '', effort: '', status: a.status })
      return merged.slice(-24)
    })
  } catch {}
}

// background tasks: added when a tool starts one, replaced by the engine's own list at each turn end
async function trackBg($: EngineInterface, e: any, type: string) {
  if (type !== 'monitor' && !e.run_in_background) return
  const bg: Bg = { id: e.tool_use_id, type, description: String(e.description || e.command || type).slice(0, 60) }
  await putBgs($, l => [...l.filter(b => b.id !== bg.id), bg].slice(-30))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.ui.status(undefined)
    await refreshCtx($)
    await refreshSubs($)
    $.clock.every(4000, () => void refreshSubs($))
    return r
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await refreshCtx($, e.context.tokens)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && 'tokensAfter' in r && typeof r.tokensAfter === 'number') {
      const t = r.tokensAfter
      try {
        await update($, ctxAtom, c => ({ ...c, tokens: t }))
      } catch {}
    }
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    await trackBg($, e, 'shell')
    return r
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const r = await next(e)
    await trackBg($, e, 'shell')
    return r
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const r = await next(e)
    await trackBg($, e, 'monitor')
    return r
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    const list = e.background_tasks
    if (list)
      await putBgs($, () =>
        list
          .filter(t => t.type !== 'subagent' && /running|pending/i.test(t.status))
          .map(t => ({ id: t.id, type: t.type, description: (t.description || t.command || t.type).slice(0, 60) })),
      )
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    if (e.tool === 'Agent')
      pending.set(e.tool_use_id, { effort: e.effort ?? '', type: e.subagent_type ?? 'general-purpose', description: e.description })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const p = pending.get(e.tool_use_id)
      const sub: Sub = {
        id: r.agentId,
        parentId: e.parentAgentId ?? null,
        type: e.subagentType,
        description: e.description,
        model: r.model,
        effort: p?.effort ?? '',
        status: 'running',
      }
      await putSubs($, subs => [...subs.filter(s => s.id !== sub.id), sub].slice(-24))
    }
    return r
  }).catch(($, e, next) => next(e))

  // ---------- the footer widget (desktop draws this slot as one line of text: no SVG, no cards)
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text } = $.ui.resolve(e)
    const ctx = await read($, ctxAtom)
    const subs = await read($, subsAtom)
    const bgs = await read($, bgAtom)
    const pct = ctx.tokens !== null && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null
    const glyph = pct === null ? '○' : pct < 13 ? '○' : pct < 38 ? '◔' : pct < 63 ? '◑' : pct < 88 ? '◕' : '●'
    const live = subs.filter(s => LIVE.has(s.status))
    const top = live.filter(s => !live.some(p => p.id === s.parentId))
    const nested = live.length - top.length
    const who = top
      .slice(0, 3)
      .map(s => `${s.model ? shortModel(s.model).split(' ')[0] : '?'}${s.effort ? ' ' + s.effort : ''}`)
      .join(', ')
    const more = top.length > 3 ? ` +${top.length - 3}` : ''

    return (
      <Box flexDirection="row">
        <Text color={pct === null ? 'subtle' : tone(pct)[1]} bold>
          {glyph} {pct === null ? '—' : `${pct}%`}
        </Text>
        <Text color={live.length > 0 ? '#8fb4ff' : 'subtle'} bold={live.length > 0}>
          {'⠀⑂ '}
          {live.length}
        </Text>
        <Text color="subtle">{' '}</Text>
        <Text color={bgs.length > 0 ? '#ffd27a' : 'subtle'} bold={bgs.length > 0}>
          {'⚙︎ '}
          {bgs.length}
        </Text>

        {e.props.modes.length > 0 ? <Text color="subtle">{'   ' + e.props.modes.join(' & ')}</Text> : null}
      </Box>
    )
  })

  // ---------- the band above the prompt (desktop): three small chips, each with a hover card like the model picker
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const ctx = await read($, ctxAtom)
    const subs = await read($, subsAtom)
    const bgs = await read($, bgAtom)
    const pct = ctx.tokens !== null && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null
    const live = subs.filter(s => LIVE.has(s.status))
    const famColor = (m: string) => (/haiku/i.test(m) ? '#7fe3cf' : /sonnet/i.test(m) ? '#8fb4ff' : /opus/i.test(m) ? '#c9a2ff' : /fable/i.test(m) ? '#ffb38a' : '#c9cee6')
    const num = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'))
    const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t)

    const row = (key: string, left: string, right: string, leftColor = '#e6e6e6', rightColor = '#9a9a9a') => (
      <Box key={key} flexDirection="row" justifyContent="space-between" gap={4}>
        <Box flexShrink={1} minWidth={0}><Text color={leftColor} wrap="truncate-end">{left}</Text></Box>
        <Box flexShrink={0}><Text color={rightColor} wrap="truncate-end">{right}</Text></Box>
      </Box>
    )
    const head = (title: string, right: string) => (
      <Box flexDirection="row" justifyContent="space-between" gap={4} marginBottom={1}>
        <Text color="#f2f2f2" bold>{title}</Text>
        <Text color="#9a9a9a">{right}</Text>
      </Box>
    )
    const chip = (id: string, label: string, color: string, card: unknown) => (
      <Box key={`chip-${id}`} position="relative" flexDirection="row" paddingX={1} paddingY={0.4} backgroundColor="#262626" hover={{ backgroundColor: '#333333' }}>
        <Text color={color}>{label}</Text>
        <Box position="absolute" bottom={1} right={0} display="none" hover={{ display: 'flex' }} flexDirection="column" minWidth={58} paddingX={2} paddingY={1} borderStyle="round" borderColor="#3d3d3d" backgroundColor="#262626">
          {card}
        </Box>
      </Box>
    )

    // context card
    const ctxCard = (
      <Box flexDirection="column">
        {head('Context', pct === null ? '—' : `${pct}%`)}
        {row('c-used', 'Used', num(ctx.tokens))}
        {row('c-limit', 'Limit', num(ctx.limit))}
        {ctx.compactAt !== null ? row('c-auto', 'Auto-compact at', num(ctx.compactAt)) : null}
        <Box marginTop={1}>
          <Button key="compact" onPress={() => void doCompact($)}>Compact now</Button>
        </Box>
      </Box>
    )

    // subagent card: running ones, nested under their parent
    const subRows: unknown[] = []
    const walk = (parent: string | null, depth: number) => {
      for (const s of live.filter(x => (parent === null ? !live.some(p => p.id === x.parentId) : x.parentId === parent))) {
        subRows.push(
          row(`s-${s.id}`, (depth > 0 ? '  '.repeat(depth - 1) + '└ ' : '') + cut(s.description || s.type, 34), `${s.model ? shortModel(s.model) : '—'} · ${s.effort || 'default'}`, '#e6e6e6', famColor(s.model)),
        )
        walk(s.id, depth + 1)
      }
    }
    walk(null, 0)
    const subCard = (
      <Box flexDirection="column">
        {head('Subagents', `${live.length} running`)}
        {subRows.length > 0 ? subRows : row('s-none', 'None running', '')}
      </Box>
    )

    // background task card
    const bgCard = (
      <Box flexDirection="column">
        {head('Background tasks', `${bgs.length} running`)}
        {bgs.length > 0 ? bgs.map(b => row(`b-${b.id}`, cut(b.description, 40), b.type)) : row('b-none', 'None running', '')}
      </Box>
    )

    return (
      <Box flexDirection="row" justifyContent="flex-end" gap={1}>
        {chip('ctx', pct === null ? 'Context' : `Context ${pct}%`, pct === null ? '#9a9a9a' : tone(pct)[1], ctxCard)}
        {chip('subs', `Subagents ${live.length}`, live.length > 0 ? '#8fb4ff' : '#9a9a9a', subCard)}
        {chip('bgs', `Tasks ${bgs.length}`, bgs.length > 0 ? '#ffd27a' : '#9a9a9a', bgCard)}
      </Box>
    )
  })
}
