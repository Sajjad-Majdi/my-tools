// Pure logic of the agent-panes mod: no `$`, so the tests call it directly.

import type { AgentInfo, AgentStatus, SessionMessage } from 'claude-code'

import type { AgentRec, FeedItem, RunState } from '../types'

/** The most feed lines kept for one agent; the oldest leave first. */
export const FEED_MAX = 120

/** The most rows the list keeps; finished ones leave first. */
export const LIST_MAX = 40

/** Where an agent of $.agent.list() stands, in the pane's words. */
export function runStateOf(status: AgentStatus): RunState {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    case 'idle':
      return 'idle'
    default:
      return 'running'
  }
}

export function isLive(state: RunState): boolean {
  return state === 'running'
}

/** A record for an agent the list names, before any event of its own was seen. */
export function recFromInfo(info: AgentInfo, now: number | undefined): AgentRec {
  const state = runStateOf(info.status)

  return {
    id: info.id,
    kind: 'agent',
    description: info.description || info.name || info.type || 'Agent',
    type: info.type,
    ...(info.name === undefined ? {} : { name: info.name }),
    ...(info.parentId === undefined ? {} : { parentId: info.parentId }),
    status: state,
    ...(now === undefined ? {} : { startedAt: now }),
    tools: 0,
  }
}

/** Puts `rec` in the list (replacing one of its id), keeping the list bounded. */
export function upsert(list: readonly AgentRec[], rec: AgentRec): AgentRec[] {
  const at = list.findIndex(one => one.id === rec.id)
  const next = at === -1 ? [...list, rec] : list.map((one, i) => (i === at ? rec : one))
  if (next.length <= LIST_MAX) return next
  const drop = next.findIndex(one => !isLive(one.status))

  return drop === -1 ? next.slice(-LIST_MAX) : next.filter((_, i) => i !== drop)
}

/** Changes the record of `id` with `fn`; the list is unchanged when it has none. */
export function patch(
  list: readonly AgentRec[],
  id: string,
  fn: (rec: AgentRec) => AgentRec,
): AgentRec[] {
  return list.map(one => (one.id === id ? fn(one) : one))
}

/** `2m 14s`, `45s`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)

  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/** How long it ran, or has run so far; undefined when its start was not seen. */
export function elapsedOf(rec: AgentRec, now: number): string | undefined {
  if (rec.startedAt === undefined) return undefined

  return formatElapsed((rec.endedAt ?? now) - rec.startedAt)
}

/** `claude-opus-5-5` reads `Opus 5.5`; an id it cannot read stays as it is. */
export function prettyModel(model: string | undefined): string | undefined {
  if (model === undefined || model === '') return undefined
  const base = model.replace(/\[.*?\]$/, '').replace(/-\d{8}$/, '')
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(base)
  if (m === null || m[1] === undefined || m[2] === undefined) return model
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1)

  return m[3] === undefined ? `${family} ${m[2]}` : `${family} ${m[2]}.${m[3]}`
}

const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/g
const LTR_LETTER = /[A-Za-zÀ-ɏ]/g

/** True when right-to-left letters (Persian, Arabic, Hebrew) outnumber Latin ones. */
export function isRtl(text: string): boolean {
  const head = text.slice(0, 400)
  const rtl = head.match(RTL_LETTER)?.length ?? 0
  const ltr = head.match(LTR_LETTER)?.length ?? 0

  return rtl > 0 && rtl >= ltr
}

/** The text cut to `maxLines` lines and `maxChars` characters; `isCut` says if it was. */
export function clip(
  text: string,
  maxLines: number,
  maxChars: number,
): { text: string; isCut: boolean } {
  const lines = text.split('\n')
  let out = lines.slice(0, maxLines).join('\n')
  let isCut = lines.length > maxLines
  if (out.length > maxChars) {
    out = out.slice(0, maxChars).trimEnd()
    isCut = true
  }

  return { text: isCut ? `${out.trimEnd()}…` : out, isCut }
}

/** One line: whitespace folded, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** Drops the engine's reminder blocks from a user row's text. */
export function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/** `mcp__server__tool` reads `tool`; a built-in keeps its name. */
export function toolLabel(tool: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(tool)

  return m?.[1] ?? tool
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key]

  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)

  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`
}

/** What a tool call does, in a few words: a path, a command, a query. */
export function summarizeTool(tool: string, input: Record<string, unknown>): string {
  const path = str(input, 'file_path') ?? str(input, 'notebook_path') ?? str(input, 'path')
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return oneLine(str(input, 'description') ?? str(input, 'command') ?? '', 120)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return path === undefined ? '' : shortPath(path)
    case 'Grep': {
      const pattern = str(input, 'pattern') ?? ''

      return oneLine(path === undefined ? pattern : `${pattern}  in ${shortPath(path)}`, 120)
    }
    case 'Glob':
      return oneLine(str(input, 'pattern') ?? '', 120)
    case 'WebFetch': {
      const url = str(input, 'url') ?? ''

      return oneLine(url.replace(/^https?:\/\//, ''), 120)
    }
    case 'WebSearch':
      return oneLine(str(input, 'query') ?? '', 120)
    case 'Agent':
    case 'Task':
      return oneLine(str(input, 'description') ?? '', 120)
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} items` : ''
    default: {
      const first =
        str(input, 'description') ??
        str(input, 'subject') ??
        str(input, 'query') ??
        str(input, 'command') ??
        path ??
        Object.values(input).find((v): v is string => typeof v === 'string' && v.trim() !== '')

      return first === undefined ? '' : oneLine(first, 120)
    }
  }
}

/** The first non-empty line of a result. */
export function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const line = text.split('\n').find(one => one.trim() !== '')

  return line === undefined ? undefined : oneLine(line, 140)
}

/**
 * An agent's feed from its conversation (`$.session.messages({ agentId })`):
 * its task, each text it wrote, each tool call with its outcome, and later
 * messages it was sent, oldest first and newest last.
 */
export function feedFrom(messages: readonly SessionMessage[]): FeedItem[] {
  const items: FeedItem[] = []
  messages.forEach((message, i) => {
    if (message.role === 'user') {
      if ((message.toolResults?.length ?? 0) > 0) return
      const text = stripReminders(message.text)
      if (text === '') return
      items.push({ key: `u${i}`, kind: items.length === 0 ? 'prompt' : 'note', text })

      return
    }
    const text = message.text.trim()
    if (text !== '') items.push({ key: `a${i}`, kind: 'text', text })
    for (const use of message.toolUses) {
      const state = use.text === undefined ? 'run' : use.isError === true ? 'err' : 'ok'
      const detail = firstLine(use.text)
      items.push({
        key: use.tool_use_id,
        kind: 'tool',
        label: toolLabel(use.tool),
        text: summarizeTool(use.tool, use.input),
        state,
        ...(detail === undefined ? {} : { detail }),
      })
    }
  })

  return items.slice(-FEED_MAX)
}

/** A background task notification's id, status and summary, when the text holds one. */
export function parseTaskNotification(
  text: string,
): { taskId: string; status: string; summary?: string } | undefined {
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]?.trim()
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1]?.trim()
  if (id === undefined || status === undefined) return undefined
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()

  return { taskId: id, status, ...(summary === undefined ? {} : { summary }) }
}

/** The pane's state for a notification's `<status>`. */
export function runStateOfTask(status: string): RunState {
  const s = status.toLowerCase()
  if (s === 'completed' || s === 'done' || s === 'success') return 'done'
  if (s === 'killed' || s === 'stopped' || s === 'cancelled') return 'stopped'
  if (s === 'running' || s === 'pending') return 'running'

  return 'failed'
}

/** The background task id a Bash result names ("... with ID: b1x2"), when it names one. */
export function backgroundIdOf(text: string): string | undefined {
  return /\bID:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1]
}

/** `2 running · 3 done · 1 failed`, the list's head. */
export function countsLine(list: readonly AgentRec[]): string {
  const running = list.filter(one => one.status === 'running').length
  const done = list.filter(one => one.status === 'done' || one.status === 'idle').length
  const failed = list.filter(one => one.status === 'failed' || one.status === 'stopped').length
  const parts = [
    running > 0 ? `${running} running` : '',
    done > 0 ? `${done} done` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter(Boolean)

  return parts.join(' · ')
}

/** `general-purpose · Fable 5.2 · high`, or the shell command for a shell task. */
export function metaLine(rec: AgentRec): string {
  if (rec.kind === 'shell') return rec.command === undefined ? 'shell' : `shell · ${oneLine(rec.command, 80)}`

  return [rec.type, prettyModel(rec.model), rec.effort].filter(Boolean).join(' · ')
}

/** The list in the order drawn: running first, then the rest newest first. */
export function ordered(list: readonly AgentRec[]): AgentRec[] {
  const rank = (one: AgentRec) => (one.status === 'running' ? 0 : 1)

  return list
    .map((one, i) => ({ one, i }))
    .sort((a, b) => rank(a.one) - rank(b.one) || b.i - a.i)
    .map(({ one }) => one)
}
