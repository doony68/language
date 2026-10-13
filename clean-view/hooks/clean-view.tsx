import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, Timer, ToolCallInput, ToolCallResult } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../types'

type Engine = EngineInterface

const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const REPORT_TOOL = 'mcp__clean-view__report_progress'
const ALWAYS_ALLOWED = new Set([
  PLAN_TOOL,
  'ToolSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
])

const MAX_NAME = 40
const FALLBACK_NAME = 'Working on it'
const METER_CELLS = 10
const LABEL_CELLS = 7
const COLLAPSE_MS = 5000
const TICK_MS = 250
const FAILURES_BEFORE_STUCK = 3

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const PROMPT_SECTION = `# Clean View is on

The person you are working with is not technical. Your tool calls are hidden from them. They only see a short checklist above the prompt, plus your written replies.

- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- For every request, even a quick question, call plan_steps (${PLAN_TOOL}) first, with 2 to 8 step names in order. If it is deferred, load it with ToolSearch first. Then call report_progress (${REPORT_TOOL}) as real progress happens, and with a percent of 100 the moment a step finishes. Use the exact step name from your plan each time.
- If this session has TodoWrite or TaskCreate, you can use its to-do list as the plan instead.`

const GATE_MESSAGE = `Clean View needs a plan before any other tool. Call plan_steps (${PLAN_TOOL}) now with 2 to 8 short, plain-English step names (no file names or code). If it is deferred, load it with ToolSearch first. Then try this tool again.`

const CODE_FILE =
  /\.(?:tsx?|jsx?|mjs|cjs|jsonc?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|css|scss|sass|less|html?|mdx?|ya?ml|toml|ini|sql|vue|svelte|lock|txt|csv|xml|env|gradle|lua|dart|exs?|scala|pl)$/i

const PLACEHOLDER_PREFIX = 'placeholder-'

let jobSeq = 0
let failures = 0
let isAnimating = false
let tickTimer: Timer | undefined

// Names

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const cleanName = (raw: unknown): string => {
  const text = typeof raw === 'string' ? raw : ''
  const words = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/`/g, ' ')
    .split(/\s+/)
    .filter(word => {
      if (word === '') return false
      if (word.includes('/') || word.includes('\\')) return false
      const bare = word.replace(/^[("'[]+|[)"'\],.;:!?]+$/g, '')

      return !CODE_FILE.test(bare)
    })
  let name = capitalise(words.join(' ').trim())

  if (name.length > MAX_NAME) {
    let cut = name.slice(0, MAX_NAME - 1)

    if (name.charAt(MAX_NAME - 1) !== ' ') {
      const space = cut.lastIndexOf(' ')
      if (space > 0) cut = cut.slice(0, space)
    }
    name = cut.replace(/[\s,;:.\-–]+$/, '') + '…'
  }

  return name === '' ? FALLBACK_NAME : name
}

const cleanTitle = (raw: string): string => {
  const line = raw.trim().split('\n')[0] ?? ''
  const plain = line.replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, '')
  const words = plain.split(/\s+/).slice(0, 6).join(' ')

  return cleanName(words)
}

const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`

  return `${seconds}s`
}

const clip = (text: string, width: number): string =>
  text.length <= width ? text : width <= 1 ? text.slice(0, width) : text.slice(0, width - 1) + '…'

const errorSentence = (answer: string): string => {
  const text = answer.toLowerCase()

  if (/rate.?limit|usage limit|\b429\b|quota|too many requests/.test(text)) {
    return 'you hit your usage limit, try again a little later'
  }
  if (/overload|\b529\b|servers are busy|at capacity/.test(text)) {
    return "Claude's servers are busy, try again in a minute"
  }
  if (/prompt is too long|context (?:length|window|limit)|too long|maximum context/.test(text)) {
    return 'type /compact and try again'
  }
  if (/\b401\b|authenticat|unauthori[sz]ed|api key|\/login|oauth|credentials|not logged in/.test(text)) {
    return 'type /login'
  }
  if (/network|connection|econn|enotfound|etimedout|fetch failed|socket|offline|dns/.test(text)) {
    return 'the internet connection dropped'
  }

  return 'something went wrong, try again in a moment'
}

// Checklist helpers

const placeholders = (): CleanViewTask[] => [
  { id: `${PLACEHOLDER_PREFIX}1`, name: 'Understand your request', status: 'active', percent: 0, hasReported: false },
  { id: `${PLACEHOLDER_PREFIX}2`, name: 'Plan the steps', status: 'upcoming', percent: 0, hasReported: false },
]

const hasRealTasks = (c: CleanViewChecklist) => c.tasks.some(t => !t.id.startsWith(PLACEHOLDER_PREFIX))

const hasLivePlan = (c: CleanViewChecklist | null): c is CleanViewChecklist =>
  c !== null && c.finishedAt === null && hasRealTasks(c)

const realTasks = (tasks: CleanViewTask[]) => tasks.filter(t => !t.id.startsWith(PLACEHOLDER_PREFIX))

const normalize = (tasks: CleanViewTask[]): CleanViewTask[] => {
  let hasActive = false
  const out = tasks.map(t => {
    if (t.status !== 'active') return t
    if (hasActive) return { ...t, status: 'upcoming' as const }
    hasActive = true

    return t
  })

  if (!hasActive) {
    const next = out.findIndex(t => t.status === 'upcoming')
    const first = out[next]
    if (first !== undefined) out[next] = { ...first, status: 'active' }
  }

  return out
}

const isRunning = (c: CleanViewChecklist | null): c is CleanViewChecklist => c !== null && c.finishedAt === null

// State changes

const ensureTick = ($: Engine) => {
  if (tickTimer !== undefined) return

  tickTimer = $.clock.every(TICK_MS, () => {
    if (!isAnimating) {
      tickTimer?.cancel()
      tickTimer = undefined

      return
    }
    void update($, tickAtom, n => (n ?? 0) + 1)
  })
}

const refreshAnimation = async ($: Engine) => {
  const [enabled, c] = [await read($, enabledAtom), await read($, checklistAtom)]
  isAnimating = enabled && isRunning(c) && (c.phase === 'working' || c.phase === 'needs-you')

  if (isAnimating) ensureTick($)
}

const commit = async ($: Engine, change: (c: CleanViewChecklist) => CleanViewChecklist) => {
  await update($, checklistAtom, c => (c === null ? c : change(c)))
  await refreshAnimation($)
}

const startJob = async ($: Engine, text: string | null): Promise<void> => {
  const now = await $.clock.now()
  const job: CleanViewChecklist = {
    title: FALLBACK_NAME,
    phase: 'working',
    tasks: placeholders(),
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
  }
  jobSeq += 1
  failures = 0
  await update($, checklistAtom, () => job)
  await refreshAnimation($)

  if (text === null) return

  const seq = jobSeq
  $.clock.after(1, () => {
    void nameJob($, text, seq, now)
  })
}

const nameJob = async ($: Engine, text: string, seq: number, startedAt: number) => {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 40,
      timeoutMs: 20000,
      system:
        'You name jobs for a friendly checklist. Reply with only the name: 2 to 6 plain words, starting with a verb, no punctuation, no quotes.',
      prompt: `Name this job:\n\n${text.slice(0, 600)}`,
    })

    if (!reply.isAnswered || seq !== jobSeq) return

    const title = cleanTitle(reply.text)
    await commit($, c => (c.startedAt === startedAt ? { ...c, title } : c))
  } catch {
    // The name is a nicety: the placeholder stays if the model cannot answer.
  }
}

const ensureJob = async ($: Engine) => {
  const c = await read($, checklistAtom)
  if (!isRunning(c)) await startJob($, null)
}

const setWorking = ($: Engine) =>
  commit($, c =>
    c.finishedAt === null && (c.phase === 'needs-you' || c.phase === 'stuck')
      ? { ...c, phase: 'working', needsYouReason: null, stuckReason: null }
      : c,
  )

const setNeedsYou = ($: Engine, reason: string) =>
  commit($, c => (c.finishedAt === null ? { ...c, phase: 'needs-you', needsYouReason: reason, stuckReason: null } : c))

const setStuck = ($: Engine, reason: string) =>
  commit($, c => (c.finishedAt === null ? { ...c, phase: 'stuck', stuckReason: reason, needsYouReason: null } : c))

const clampPercent = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0
}

const applyPlan = async ($: Engine, names: string[]) => {
  await ensureJob($)
  const tasks: CleanViewTask[] = names.map((name, i) => ({
    id: `step-${i + 1}`,
    name,
    status: i === 0 ? 'active' : 'upcoming',
    percent: 0,
    hasReported: false,
  }))
  await commit($, c => ({ ...c, tasks, phase: 'working', needsYouReason: null, stuckReason: null }))
}

const sameName = (a: string, b: string) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()

  return x === y
}

const looselyNamed = (a: string, b: string) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()

  return Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x))
}

const applyProgress = (c: CleanViewChecklist, task: string, percent: number): CleanViewChecklist => {
  const name = cleanName(task)
  const base = realTasks(c.tasks)
  let at = base.findIndex(t => sameName(t.name, name))
  if (at < 0) at = base.findIndex(t => looselyNamed(t.name, name))

  let tasks: CleanViewTask[]

  if (at < 0) {
    // Not in the plan: it becomes a new step, ahead of the first one still waiting.
    const waiting = base.findIndex(t => t.status === 'upcoming')
    const where = waiting < 0 ? base.length : waiting
    const added: CleanViewTask = {
      id: `step-${base.length + 1}`,
      name,
      status: 'upcoming',
      percent: 0,
      hasReported: false,
    }
    tasks = [...base.slice(0, where), added, ...base.slice(where)]
    at = where
    tasks = tasks.map((t, i) => (i < at ? { ...t, status: 'done' as const, percent: 100 } : t))
  } else {
    tasks = base.map((t, i) => (i < at ? { ...t, status: 'done' as const, percent: 100 } : t))
  }

  const current = tasks[at]
  if (current === undefined) return c

  if (percent >= 100) {
    tasks[at] = { ...current, status: 'done', percent: 100, hasReported: true }
  } else {
    tasks[at] = { ...current, status: 'active', percent, hasReported: true }
  }

  // Only the reported step may be active; later ones wait their turn.
  tasks = tasks.map((t, i) => (i > at && t.status === 'active' ? { ...t, status: 'upcoming' as const } : t))

  return {
    ...c,
    tasks: normalize(tasks),
    phase: 'working',
    needsYouReason: null,
    stuckReason: null,
  }
}

const withRealTasks = (c: CleanViewChecklist, tasks: CleanViewTask[]): CleanViewChecklist => ({
  ...c,
  tasks: normalize(tasks),
})

const syncTodos = (c: CleanViewChecklist, todos: ReadonlyArray<{ content: string; status: string }>) => {
  const previous = new Map(c.tasks.map(t => [t.name, t]))
  const tasks: CleanViewTask[] = todos.map((todo, i) => {
    const name = cleanName(todo.content)
    const before = previous.get(name)
    const status = todo.status === 'completed' ? 'done' : todo.status === 'in_progress' ? 'active' : 'upcoming'

    return {
      id: `todo-${i + 1}`,
      name,
      status,
      percent: status === 'done' ? 100 : status === 'active' && before !== undefined ? before.percent : 0,
      hasReported: status === 'active' && before !== undefined && before.hasReported,
    }
  })

  return withRealTasks(c, tasks)
}

const addTask = (c: CleanViewChecklist, id: string, subject: string): CleanViewChecklist => {
  const base = realTasks(c.tasks)
  const task: CleanViewTask = { id: `task-${id}`, name: cleanName(subject), status: 'upcoming', percent: 0, hasReported: false }

  return withRealTasks(c, [...base, task])
}

const updateTask = (
  c: CleanViewChecklist,
  id: string,
  change: { status?: string; subject?: string },
): CleanViewChecklist => {
  const key = `task-${id}`
  let tasks = c.tasks

  if (change.status === 'deleted') {
    tasks = tasks.filter(t => t.id !== key)
  } else {
    tasks = tasks.map(t => {
      if (t.id !== key) return t
      const name = change.subject !== undefined ? cleanName(change.subject) : t.name
      if (change.status === 'completed') return { ...t, name, status: 'done' as const, percent: 100 }
      if (change.status === 'in_progress') return { ...t, name, status: 'active' as const }
      if (change.status === 'pending') return { ...t, name, status: 'upcoming' as const, percent: 0, hasReported: false }

      return { ...t, name }
    })
  }

  return withRealTasks(c, tasks)
}

const looksLikeRefusal = (text: string) =>
  /doesn'?t want to proceed|does not want to proceed|user rejected|rejected|permission (?:was )?denied|denied by|declined/i.test(text)

const clearNeedsYou = ($: Engine) =>
  commit($, c => (c.finishedAt === null && c.phase === 'needs-you' ? { ...c, phase: 'working', needsYouReason: null } : c))

const afterTool = async ($: Engine, e: ToolCallInput, ran: ToolCallResult) => {
  const failed = ran.deny !== undefined || ran.isError === true

  if (failed) {
    const reason = ran.deny ?? ran.text ?? ''

    if (looksLikeRefusal(reason)) {
      await setStuck($, 'you said no to a step, so Claude paused')
    } else {
      failures += 1
      if (failures >= FAILURES_BEFORE_STUCK) {
        await setStuck($, 'a step keeps failing, Claude is trying another way')
      } else {
        await clearNeedsYou($)
      }
    }

    return
  }

  failures = 0
  await setWorking($)

  if (e.tool === 'TodoWrite') {
    if (e.todos.length === 0) return
    await ensureJob($)
    await commit($, c => syncTodos(c, e.todos))
  } else if (e.tool === 'TaskCreate') {
    await ensureJob($)
    const given = (ran as { result?: { task?: { id?: string } } }).result?.task?.id
    await commit($, c => addTask(c, given ?? String(c.tasks.filter(t => t.id.startsWith('task-')).length + 1), e.subject))
  } else if (e.tool === 'TaskUpdate') {
    await commit($, c => updateTask(c, e.taskId, { status: e.status, subject: e.subject }))
  }
}

const finishTurn = async (
  $: Engine,
  e: { reason: 'answer' | 'aborted' | 'refusal' | 'error'; answer: string; isAborted: boolean },
  c: CleanViewChecklist,
) => {
  const now = await $.clock.now()

  if (e.reason === 'aborted' || e.isAborted) {
    await commit($, cur => ({ ...cur, phase: 'stopped', finishedAt: now, needsYouReason: null, stuckReason: null }))

    return
  }
  if (e.reason === 'error' || e.reason === 'refusal') {
    const reason = e.reason === 'refusal' ? "Claude couldn't help with that request" : errorSentence(e.answer)
    await commit($, cur => ({ ...cur, phase: 'stuck', stuckReason: reason, needsYouReason: null, finishedAt: now }))

    return
  }

  const hasUnfinished = hasRealTasks(c) && realTasks(c.tasks).some(t => t.status !== 'done')

  if (hasUnfinished) {
    await setNeedsYou($, 'Claude is waiting for your reply')

    return
  }

  await commit($, cur => ({
    ...cur,
    phase: 'done',
    tasks: hasRealTasks(cur) ? cur.tasks.map(t => ({ ...t, status: 'done' as const, percent: 100 })) : [],
    needsYouReason: null,
    stuckReason: null,
    finishedAt: now,
    isCollapsed: false,
  }))
  $.clock.after(COLLAPSE_MS, () => {
    void commit($, cur => (cur.finishedAt === now && cur.phase === 'done' ? { ...cur, isCollapsed: true } : cur))
  })
}

const toggleFromButton = async ($: Engine) => {
  const isOn = await setEnabled($, undefined)
  $.ui.toast(toastFor(isOn))
}

// Switching on and off

const setEnabled = async ($: Engine, next: boolean | undefined): Promise<boolean> => {
  let value = true
  await update($, enabledAtom, now => {
    value = next ?? !now

    return value
  })
  await $.store.set('cleanViewEnabled', value)
  await refreshAnimation($)

  return value
}

const toastFor = (isOn: boolean) =>
  isOn
    ? 'Clean View is ON: the technical details are hidden.'
    : 'Clean View is OFF: everything is showing again.'

// The meter and the rows

const meterFor = (task: CleanViewTask, frame: number, isWaiting: boolean): string => {
  if (task.status === 'done') return '█'.repeat(METER_CELLS)
  if (task.status === 'upcoming') return '░'.repeat(METER_CELLS)

  if (!task.hasReported) {
    if (isWaiting) return '░'.repeat(METER_CELLS)
    const at = frame % METER_CELLS

    return Array.from({ length: METER_CELLS }, (_, i) => ((i - at + METER_CELLS) % METER_CELLS < 3 ? '█' : '░')).join('')
  }

  const filled = Math.min(METER_CELLS - 1, Math.round((task.percent / 100) * METER_CELLS))

  return '█'.repeat(filled) + '░'.repeat(METER_CELLS - filled)
}

const labelFor = (task: CleanViewTask, isFirstUpcoming: boolean, isWaiting: boolean): string => {
  if (task.status === 'done') return 'Done'
  if (task.status === 'active') return task.hasReported ? `${task.percent}%` : isWaiting ? 'Waiting' : 'Working'

  return isFirstUpcoming ? 'Next' : 'Up next'
}

const windowOf = (tasks: CleanViewTask[], room: number): CleanViewTask[] => {
  if (tasks.length <= room) return tasks
  const active = Math.max(0, tasks.findIndex(t => t.status === 'active'))
  const start = Math.min(Math.max(0, active - 1), tasks.length - room)

  return tasks.slice(start, start + room)
}

export const registerCleanView = (on: On): void => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front, 2 to 8 short plain-English names in order, each starting with a verb (like "Build the pricing section"). No file names, commands or code. Call this first for every request. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 8,
            description: 'The step names, in order.',
          },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on a step from the plan. Use the step name exactly as planned and a percent from 0 to 100. Send 100 the moment a step is finished; the next step then starts automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The step name, as planned.' },
          percent: { type: 'number', minimum: 0, maximum: 100, description: 'How far along the step is.' },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off',
      argumentHint: 'on|off',
    })

    const saved = await $.store.get('cleanViewEnabled')
    if (typeof saved === 'boolean') await update($, enabledAtom, () => saved)
    await refreshAnimation($)

    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Use /simple on or /simple off, or just /simple to flip it.' }
    }

    const isOn = await setEnabled($, arg === '' ? undefined : arg === 'on')

    return { text: toastFor(isOn) }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!(await read($, enabledAtom))) return composed

    return {
      sections: [...composed.sections, { id: 'clean-view:plan', text: PROMPT_SECTION, scope: 'session' as const }],
    }
  })

  // The plan gate, and the bookkeeping for the tools Claude already uses.
  on('tool.call', async ($, e, next) => {
    if (!(await read($, enabledAtom)) || e.agentId !== undefined) return next(e)

    const tool = String(e.tool)

    if (!ALWAYS_ALLOWED.has(tool) && !hasLivePlan(await read($, checklistAtom))) {
      return { deny: GATE_MESSAGE }
    }
    if (tool === PLAN_TOOL || tool === REPORT_TOOL) return next(e)

    if (tool === 'AskUserQuestion') {
      await setNeedsYou($, 'Claude has a question for you')
      const answered = await next(e)
      await clearNeedsYou($)

      return answered
    }

    const ran = await next(e)
    await afterTool($, e, ran)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    if (!(await read($, enabledAtom)) || e.agentId !== undefined) return { result: 'Noted.' }

    const given: unknown = e.steps
    const names = (Array.isArray(given) ? given : [])
      .filter((s): s is string => typeof s === 'string')
      .map(cleanName)
      .slice(0, 8)

    if (names.length === 0) {
      return { deny: 'Send 2 to 8 short step names, for example {"steps":["Read your notes","Build the page"]}.' }
    }

    await applyPlan($, names)

    return { result: `Planned ${names.length} ${names.length === 1 ? 'step' : 'steps'}. The first one has started.` }
  })

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    if (!(await read($, enabledAtom)) || e.agentId !== undefined) return { result: 'Noted.' }

    const percent = clampPercent(e.percent)
    const task = typeof e.task === 'string' ? e.task : ''
    await ensureJob($)
    await commit($, c => applyProgress(c, task, percent))

    return { result: `Progress noted: ${percent}%.` }
  })

  on('turn.start', async ($, e, next) => {
    if (await read($, enabledAtom)) {
      const c = await read($, checklistAtom)
      const text = e.text.trim()

      if (isRunning(c)) {
        await clearNeedsYou($)
      } else if (text !== '' && !text.startsWith('/')) {
        await startJob($, text)
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && (await read($, enabledAtom))) {
      const c = await read($, checklistAtom)
      if (isRunning(c)) await finishTurn($, e, c)
    }

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (await read($, enabledAtom)) {
      const kind = e.notification_type ?? ''
      const isWaiting = /idle|waiting/i.test(kind)
      const c = await read($, checklistAtom)

      if (isRunning(c) || !isWaiting) {
        if (!isRunning(c)) await startJob($, null)
        await setNeedsYou($, isWaiting ? 'Claude is waiting for your reply' : 'Claude needs your OK to continue')
      }
    }

    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    if ((await read($, enabledAtom)) && isRunning(await read($, checklistAtom))) {
      await setStuck($, 'you said no to a step, so Claude paused')
    }

    return next(e)
  })

  // Hide the technical rows while Clean View is on.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)

    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabledAtom)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const isOn = await read($, enabledAtom)
    const c = await read($, checklistAtom)
    const frame = (await read($, tickAtom)) ?? 0
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(20, e.props.bodyColumns)
    const label = isOn ? '● Clean View: ON' : '○ Clean View: OFF'

    let rest: RenderElement | undefined
    try {
      rest = await next(e)
    } catch {
      rest = undefined
    }

    const maxLeft = Math.max(8, cols - label.length - 5)
    const elapsed = formatElapsed((c?.finishedAt ?? now) - (c?.startedAt ?? now))
    let left: RenderElement | undefined
    let rows: RenderElement[] = []

    if (isOn && c !== null) {
      if (c.phase === 'working') {
        left = (
          <Box>
            <Text bold>{clip(c.title, Math.max(4, maxLeft - elapsed.length - 3))}</Text>
            <Text dimColor>{` · ${elapsed}`}</Text>
          </Box>
        )
      } else if (c.phase === 'needs-you') {
        left = (
          <Box>
            <Text bold inverse color="warning">
              {' Needs you '}
            </Text>
            <Text>{` ${clip(c.needsYouReason ?? 'Claude needs your OK to continue', Math.max(4, maxLeft - 12))}`}</Text>
          </Box>
        )
      } else if (c.phase === 'stuck') {
        left = (
          <Text bold color="warning">
            {clip(`⚠ Stuck: ${c.stuckReason ?? 'Claude hit a snag'}`, maxLeft)}
          </Text>
        )
      } else if (c.phase === 'stopped') {
        left = (
          <Box>
            <Text bold color="warning">
              ■ Stopped
            </Text>
            <Text dimColor>{clip(` · ${c.title} · you pressed Esc`, Math.max(4, maxLeft - 9))}</Text>
          </Box>
        )
      } else {
        left = (
          <Box>
            <Text bold color="success">
              ✓ All done
            </Text>
            <Text dimColor>{clip(` · ${c.title} · took ${elapsed}`, Math.max(4, maxLeft - 10))}</Text>
          </Box>
        )
      }

      const isShowingRows = c.tasks.length > 0 && !(c.phase === 'done' && c.isCollapsed)

      if (isShowingRows) {
        const isWaiting = c.phase === 'needs-you'
        const firstUpcoming = c.tasks.find(t => t.status === 'upcoming')
        const visible = windowOf(c.tasks, Math.max(1, e.props.maxRows - 1))
        const isShowingLabel = cols >= 31
        const fixed = 2 + 2 + METER_CELLS + (isShowingLabel ? 2 + LABEL_CELLS : 0)
        const longest = Math.max(...visible.map(t => t.name.length))
        const nameWidth = Math.max(4, Math.min(longest, cols - fixed))

        rows = visible.map(task => {
          const isDone = task.status === 'done'
          const isActive = task.status === 'active'
          const glyph = isDone ? '✓' : isActive ? (isWaiting ? '‖' : '▶') : '○'
          const color = isDone ? 'success' : isActive ? (isWaiting ? 'warning' : 'suggestion') : undefined
          const isDim = !isActive

          return (
            <Box>
              <Text color={color} dimColor={task.status === 'upcoming'}>{`${glyph} `}</Text>
              <Text bold={isActive} dimColor={isDim}>
                {clip(task.name, nameWidth).padEnd(nameWidth)}
              </Text>
              <Text color={color} dimColor={task.status === 'upcoming'}>
                {`  ${meterFor(task, frame, isWaiting)}`}
              </Text>
              {isShowingLabel && (
                <Text dimColor={isDim}>{`  ${labelFor(task, task === firstUpcoming, isWaiting).padEnd(LABEL_CELLS)}`}</Text>
              )}
            </Box>
          )
        })
      }
    }

    return (
      <Box flexDirection="column">
        <Box width={cols} justifyContent="space-between">
          <Box flexGrow={1}>{left ?? <Text> </Text>}</Box>
          <Button key="toggle" label={label} onPress={() => toggleFromButton($)} />
        </Box>
        {rows}
        {rest !== undefined && rest !== null && rest}
      </Box>
    )
  })
}
