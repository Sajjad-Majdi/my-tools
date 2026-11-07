export type Ctx = { tokens: number | null; limit: number; compactAt: number | null }
export type Sub = {
  id: string
  parentId: string | null
  type: string
  description: string
  model: string
  effort: string
  status: string
}

export type Bg = { id: string; type: string; description: string }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { ctx: Ctx; subs: Sub[]; open: string; bgs: Bg[] }
  }
}
