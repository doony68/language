import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PLAN = 'mcp__clean-view__plan_steps'
const REPORT = 'mcp__clean-view__report_progress'

const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
} as never

const SURFACES = ['terminal', 'desktop'] as const

const simple = ($: Engine, args: string) =>
  $.command.run({
    command: 'simple',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

const band = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'clean-view', surface, component: 'AbovePrompt', props: BAND })

const glyphs = async (ui: Awaited<ReturnType<typeof band>>) =>
  (await ui.findAll({ type: 'Text', text: /^[✓▶○‖] $/ })).map(found => found.text.trim())

// What sits beneath the plugin: the engine's own answers.
const engine = (on: On) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('tool.call', (_$, e) =>
    (e as { command?: string }).command === 'fail'
      ? ({ result: {}, text: 'It broke', isError: true } as never)
      : (e as { command?: string }).command === 'no'
        ? ({ result: {}, text: "The user doesn't want to proceed with this tool use.", isError: true } as never)
        : ({ result: {}, text: 'ok' } as never),
  )
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '"Build my landing page."', usage: {} } }) as never)
  on('classic.Notification', () => ({}) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine row</Text>
  })

  return clock
}

const plan = ($: Engine, steps: string[]) => $.tool.call({ tool: PLAN, steps } as never)

test('names lose code, paths and file names, and stay short', async ($, on) => {
  engine(on)
  await plan($, [
    'Build the pricing section in `src/Pricing.tsx`',
    'Update src/app/page.tsx to add a header',
    `Make ${'word '.repeat(16)}`,
    '`only code`',
  ])

  const ui = await band($)
  const names = (await ui.findAll({ type: 'Text', text: /\S/ })).map(found => found.text.trim())

  expect(names).toContain('Build the pricing section in')
  expect(names).toContain('Update to add a header')
  expect(names).toContain('Working on it')
  const long = names.find(name => name.startsWith('Make word'))
  expect(long !== undefined && long.length <= 40 && long.endsWith('…')).toBe(true)
  await ui.unmount()
})

test('a to-do list and a 60% report draw the rows on every surface', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'Build my landing page', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  } as never)
  await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 60 } as never)

  for (const surface of SURFACES) {
    const ui = await band($, surface)

    expect(await glyphs(ui)).toEqual(['✓', '▶', '○', '○'])
    expect(await ui.find({ type: 'Text', text: /60%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Next/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Up next/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Add the contact form/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'toggle' })).toBeDefined()
    await ui.unmount()
  }
})

test('a permission prompt turns the header into Needs you', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'Fix my page', turnId: 't1' })
  await plan($, ['Look at the page', 'Fix the page'])
  await $.classic.Notification({
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  })

  for (const surface of SURFACES) {
    const ui = await band($, surface)

    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude needs your OK to continue/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /‖/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/simple off hides the band and brings every row back', async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'Fix my page', turnId: 't1' })
  await plan($, ['Look at the page', 'Fix the page'])

  const before = await band($)
  expect(await before.find({ type: 'Text', text: /Look at the page/ })).toBeDefined()
  await before.unmount()

  const toolRow = {
    tool_use_id: 'u1',
    tool: 'Bash',
    input: { command: 'ls' },
    isRunning: false,
    isErrored: false,
  } as never
  const hidden = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolUse', props: toolRow })
  expect(await hidden.find({ type: 'Text', text: 'engine row' })).toBeUndefined()
  await hidden.unmount()

  const off = await simple($, 'off')
  expect(off.text).toMatch(/OFF/)

  const after = await band($)
  expect(await after.find({ type: 'Text', text: /Look at the page/ })).toBeUndefined()
  expect(await after.find({ type: 'Button', key: 'toggle' })).toBeDefined()
  await after.unmount()

  const shown = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolUse', props: toolRow })
  expect(await shown.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await shown.unmount()

  const flipped = await simple($, '')
  expect(flipped.text).toMatch(/ON/)
  const back = await band($)
  expect(await back.find({ type: 'Button', text: /ON/ })).toBeDefined()
  await back.unmount()
})

test('report_progress at 100 checks off a step and starts the next', async ($, on) => {
  engine(on)
  const planned = await plan($, ['Read your notes', 'Build the page', 'Polish the footer'])
  expect((planned as { result?: unknown }).result).toBe('Planned 3 steps. The first one has started.')

  const first = await band($)
  expect(await glyphs(first)).toEqual(['▶', '○', '○'])
  await first.unmount()

  const reported = await $.tool.call({ tool: REPORT, task: 'Read your notes', percent: 100 } as never)
  expect((reported as { result?: unknown }).result).toBe('Progress noted: 100%.')

  const ui = await band($)
  expect(await glyphs(ui)).toEqual(['✓', '▶', '○'])
  await ui.unmount()
})

test('every tool is denied before a plan and allowed after', async ($, on) => {
  engine(on)
  const denied = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(denied.deny).toMatch(/plan_steps/)

  const allowed = await $.tool.call({ tool: 'ToolSearch', query: 'x', max_results: 1 } as never)
  expect(allowed.deny).toBeUndefined()

  await plan($, ['Look around', 'Report back'])
  const after = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(after.deny).toBeUndefined()
})

test('the job finishes with All done and then shrinks to one line', async ($, on) => {
  const clock = engine(on)
  await $.turn.start({ text: 'Say hello', turnId: 't1' })
  await plan($, ['Say hello', 'Wave goodbye'])
  await $.tool.call({ tool: REPORT, task: 'Say hello', percent: 100 } as never)
  await $.tool.call({ tool: REPORT, task: 'Wave goodbye', percent: 100 } as never)
  await $.turn.complete({ answer: 'Hello!', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /All done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Wave goodbye/ })).toBeDefined()

  await clock.advance(5001)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /All done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Wave goodbye/ })).toBeUndefined()
  await ui.unmount()
})

test('Haiku names the job and the name replaces the placeholder', async ($, on) => {
  const clock = engine(on)
  await $.turn.start({ text: 'please build my landing page', turnId: 't1' })

  const before = await band($)
  expect(await before.find({ type: 'Text', text: /Working on it/ })).toBeDefined()
  expect(await glyphs(before)).toEqual(['▶', '○'])
  await before.unmount()

  await clock.advance(50)
  const after = await band($)
  expect(await after.find({ type: 'Text', text: /Build my landing page/ })).toBeDefined()
  await after.unmount()
})

test('saying no or failing three times shows Stuck, and a success clears it', async ($, on) => {
  engine(on)
  await plan($, ['Look around', 'Report back'])

  await $.tool.call({ tool: 'Bash', command: 'no' } as never)
  const said = await band($)
  expect(await said.find({ type: 'Text', text: /Stuck: you said no to a step, so Claude paused/ })).toBeDefined()
  await said.unmount()

  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  const cleared = await band($)
  expect(await cleared.find({ type: 'Text', text: /Stuck/ })).toBeUndefined()
  await cleared.unmount()

  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'fail' } as never)
  const failing = await band($)
  expect(await failing.find({ type: 'Text', text: /Stuck: a step keeps failing, Claude is trying another way/ })).toBeDefined()
  await failing.unmount()
})

test('turn endings become calm sentences', async ($, on) => {
  engine(on)
  const ends = [
    ['error', 'Error: 429 rate limit exceeded', /Stuck: you hit your usage limit, try again a little later/],
    ['error', 'API Error: 529 overloaded_error', /Stuck: Claude's servers are busy, try again in a minute/],
    ['error', 'Prompt is too long', /Stuck: type \/compact and try again/],
    ['error', 'fetch failed: ECONNRESET', /Stuck: the internet connection dropped/],
    ['error', '401 authentication_error', /Stuck: type \/login/],
    ['refusal', '', /Stuck: Claude couldn't help with that request/],
    ['aborted', '', /Stopped/],
    ['answer', 'half done', /Needs you/],
  ] as const

  for (const [reason, answer, expected] of ends) {
    await $.turn.start({ text: 'Do a thing', turnId: 't1' })
    await plan($, ['Do the first part', 'Do the second part'])
    await $.turn.complete({
      answer,
      durationMs: 10,
      isAborted: reason === 'aborted',
      turnId: 't1',
      reason,
      ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}),
    } as never)

    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
    await ui.unmount()

    // Start the next case from a finished job, unless the reply is still awaited.
    if (reason === 'answer') await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  }
})
