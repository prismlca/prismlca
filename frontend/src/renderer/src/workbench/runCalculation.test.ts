import { describe, expect, it } from 'vitest'

import { mayHaveCalculated, runCalculation, type CallTrace } from './runCalculation'

const IPCC = ['IPCC 2021', 'climate change', 'GWP100']
const EF = ['EF v3.1', 'climate change', 'global warming potential (GWP100)']
const CML = ['CML v4.8 2016', 'climate change', 'GWP 100a']
const METHODS = [{ method: CML }, { method: EF }, { method: IPCC }]

const call = (name: string, args: unknown, status: CallTrace['status'] = 'ok'): CallTrace => ({
  name,
  args: JSON.stringify(args),
  status
})

const pick = (traces: CallTrace[], processIds = ['m/fu', 'm/part', 'ei/market']) =>
  runCalculation({ traces, activeDb: 'm', processIds: new Set(processIds), methods: METHODS })

describe('what a run calculated, for the toolbar', () => {
  it('nothing when the run calculated nothing', () => {
    expect(pick([])).toEqual({})
    expect(
      pick([call('get_process_details', { code: 'fu' }), call('edit_exchange', { code: 'fu' })])
    ).toEqual({})
  })

  it('nothing when the last calculating step was the canvas calculation, which set both itself', () => {
    const traces = [
      call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'part' }], methods: [EF] }),
      call('calculate', { code: 'part', method: EF }),
      call('calculate_in_canvas', { code: 'fu', method: IPCC })
    ]
    expect(pick(traces)).toEqual({})
  })

  it('reads only what came after the canvas calculation', () => {
    const traces = [
      call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'part' }], methods: [EF] }),
      call('calculate_in_canvas', { code: 'fu', method: IPCC }),
      call('calculate', { code: 'part', method: CML })
    ]
    // The set-up before it is superseded; the calculation after it is the run's last word.
    expect(pick(traces)).toEqual({ processId: 'm/part', methodIndex: 0 })
  })

  it('a refused canvas calculation set nothing, so it supersedes nothing', () => {
    const traces = [
      call('calculate', { code: 'fu', method: IPCC }),
      call('calculate_in_canvas', { code: 'fu', method: EF }, 'rejected')
    ]
    expect(pick(traces)).toEqual({ processId: 'm/fu', methodIndex: 2 })
  })

  it('the set-up of the Results page wins over a calculation, even a later one', () => {
    const traces = [
      call('setup_results', {
        tab: 'overview',
        subjects: [{ database: 'm', code: 'fu' }],
        methods: [IPCC, EF]
      }),
      call('calculate', { code: 'part', method: CML })
    ]
    expect(pick(traces)).toEqual({ processId: 'm/fu', methodIndex: 2 })
  })

  it('of several set-ups, the last that named subjects or methods', () => {
    const traces = [
      call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'part' }], methods: [EF] }),
      call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'fu' }], methods: [IPCC] }),
      // Only switches the tab and stacking: names nothing, so it is not a calculation.
      call('setup_results', { tab: 'detailed', stacked: true })
    ]
    expect(pick(traces)).toEqual({ processId: 'm/fu', methodIndex: 2 })
  })

  it('a set-up: its first subject that is a box of this model, its first method the app lists', () => {
    const traces = [
      call('setup_results', {
        tab: 'overview',
        subjects: [
          { database: 'ei', code: 'market' }, // background, not a process of the model
          { database: 'other', code: 'fu' }, // another model
          { database: 'm', code: 'gone' }, // not on the canvas
          { database: 'm', code: 'part', scenario: 'S1' },
          { database: 'm', code: 'fu' }
        ],
        methods: [['No such family', 'x', 'y'], 'IPCC 2021 · climate change · GWP100', EF, IPCC]
      })
    ]
    // The name as one string sets no indicator on the Results page, so it is not its first method either.
    expect(pick(traces)).toEqual({ processId: 'm/part', methodIndex: 1 })
  })

  it('a set-up with methods only, or subjects only, gives that half', () => {
    expect(pick([call('setup_results', { tab: 'overview', methods: [EF] })])).toEqual({ methodIndex: 1 })
    expect(
      pick([call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'fu' }] })])
    ).toEqual({ processId: 'm/fu' })
  })

  it('each half from the latest set-up that names it, as the Results view merges them', () => {
    const subjects = call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'part' }] })
    const methods = call('setup_results', { tab: 'overview', methods: [EF] })
    // Subjects first, the indicators in a later call — and the other way round.
    expect(pick([subjects, methods])).toEqual({ processId: 'm/part', methodIndex: 1 })
    expect(pick([methods, subjects])).toEqual({ processId: 'm/part', methodIndex: 1 })
    // A later call naming only indicators replaces the indicator, not the subject.
    const both = call('setup_results', {
      tab: 'overview',
      subjects: [{ database: 'm', code: 'fu' }],
      methods: [IPCC]
    })
    expect(pick([both, methods])).toEqual({ processId: 'm/fu', methodIndex: 1 })
  })

  it('a set-up whose subjects are no box of this model does not hide an earlier one that is', () => {
    const traces = [
      call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'part' }], methods: [EF] }),
      call('setup_results', {
        tab: 'overview',
        subjects: [
          { database: 'ei', code: 'market' },
          { database: 'm', code: 'gone' }
        ]
      })
    ]
    expect(pick(traces)).toEqual({ processId: 'm/part', methodIndex: 1 })
  })

  it('a half no set-up supplies comes from the last calculation', () => {
    // The method from the set-up, the process from the calculation.
    expect(
      pick([
        call('calculate', { code: 'part', method: CML }),
        call('setup_results', { tab: 'overview', methods: [IPCC] })
      ])
    ).toEqual({ processId: 'm/part', methodIndex: 2 })
    // The process from the set-up, the method from the calculation.
    expect(
      pick([
        call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'fu' }] }),
        call('calculate', { code: 'part', method: CML })
      ])
    ).toEqual({ processId: 'm/fu', methodIndex: 0 })
  })

  it('names the process it waits for when the run named one of this model that is not a box yet', () => {
    // From the latest set-up naming a subject of this model; its method still holds.
    expect(
      pick([
        call('calculate', { code: 'new2', method: CML }),
        call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'new' }], methods: [EF] })
      ])
    ).toEqual({ awaitedProcessId: 'm/new', methodIndex: 1 })
    // Else from the calculation.
    expect(pick([call('calculate', { code: 'new', method: IPCC })])).toEqual({
      awaitedProcessId: 'm/new',
      methodIndex: 2
    })
    // Not when a box was found.
    expect(
      pick([
        call('calculate', { code: 'fu', method: IPCC }),
        call('setup_results', { tab: 'overview', subjects: [{ database: 'm', code: 'new' }] })
      ])
    ).toEqual({ processId: 'm/fu', methodIndex: 2 })
    // Not when no process of this model was named.
    expect(
      pick([
        call('setup_results', {
          tab: 'overview',
          subjects: [
            { database: 'ei', code: 'market' },
            { database: 'other', code: 'new' }
          ],
          methods: [EF]
        }),
        call('calculate', { database: 'ei', code: 'market', method: CML })
      ])
    ).toEqual({ methodIndex: 1 })
  })

  it('a calculation of one process of this model: that process and its method', () => {
    expect(pick([call('calculate', { code: 'fu', method: IPCC })])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
    // `database` named explicitly as the model on screen is the same thing.
    expect(pick([call('calculate', { database: 'm', code: 'fu', method: EF })])).toEqual({
      processId: 'm/fu',
      methodIndex: 1
    })
    // The whole name in one string, as the backend accepts it.
    expect(pick([call('calculate', { code: 'fu', method: 'IPCC 2021 · climate change · GWP100' })])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
    // Several methods: the first the app lists.
    expect(pick([call('calculate', { code: 'fu', methods: [['gone'], EF, IPCC], method: CML })])).toEqual({
      processId: 'm/fu',
      methodIndex: 1
    })
    // A one-code batch is one process.
    expect(pick([call('calculate', { codes: ['part', 'part'], method: IPCC })])).toEqual({
      processId: 'm/part',
      methodIndex: 2
    })
  })

  it('a calculation without a method the arguments name leaves the method alone', () => {
    // A whole family: which of its indicators the chat reported, the arguments do not say.
    expect(pick([call('calculate', { code: 'fu', method_family: 'IPCC 2021', method: CML })])).toEqual({
      processId: 'm/fu'
    })
    // None at all: the backend took its default.
    expect(pick([call('calculate', { code: 'fu' })])).toEqual({ processId: 'm/fu' })
  })

  it('passes over calculations that are not of exactly one process of this model', () => {
    const first = call('calculate', { code: 'fu', method: IPCC })
    // Several processes in one call.
    expect(pick([first, call('calculate', { codes: ['fu', 'part'], method: EF })])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
    // A background dataset, or another model.
    expect(pick([first, call('calculate', { database: 'ei', code: 'market', method: EF })])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
    expect(pick([first, call('calculate', { database: 'other', code: 'fu', method: EF })])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
    // A job's status, result or cancel names a job, not a process.
    expect(pick([first, call('calculate', { job: 'result', job_id: 'j1' })])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
  })

  it('a started job is the calculation of its one process', () => {
    const traces = [
      call('calculate', { job: 'start', code: 'part', codes: ['fu', 'part'], methods: [EF, IPCC] }),
      call('calculate', { job: 'status', job_id: 'j1' })
    ]
    expect(pick(traces)).toEqual({ processId: 'm/part', methodIndex: 1 })
  })

  it('failed and refused calls count for nothing', () => {
    const first = call('calculate', { code: 'fu', method: IPCC })
    // No status: a row of a call still running when a failed run ended.
    for (const status of ['error', 'rejected', undefined] as const)
      expect(pick([first, { ...call('calculate', { code: 'part', method: EF }), status }])).toEqual({
        processId: 'm/fu',
        methodIndex: 2
      })
    expect(pick([first, call('setup_results', { tab: 'overview', methods: [EF] }, 'rejected')])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
    // The one item of a batch failed: that calculation did not happen.
    expect(pick([first, { ...call('calculate', { codes: ['part'], method: EF }), itemsFailed: 1 }])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
  })

  it('each half on its own: a process off the canvas or a method the app does not list is left out', () => {
    // A process not on the canvas is no selection — only the one waited for.
    expect(pick([call('calculate', { code: 'gone', method: IPCC })])).toEqual({
      awaitedProcessId: 'm/gone',
      methodIndex: 2
    })
    expect(pick([call('calculate', { code: 'fu', method: ['No such family', 'x', 'y'] })])).toEqual({
      processId: 'm/fu'
    })
    expect(pick([call('calculate', { code: 'gone', method: ['No such family'] })])).toEqual({
      awaitedProcessId: 'm/gone'
    })
  })

  it('arguments that cannot be read are no calculation', () => {
    const cut: CallTrace = { name: 'calculate', args: '{"code":"part","method":["IPCC', status: 'ok' }
    expect(pick([call('calculate', { code: 'fu', method: IPCC }), cut])).toEqual({
      processId: 'm/fu',
      methodIndex: 2
    })
  })

  it('tells cheaply whether a run may have calculated at all', () => {
    expect(mayHaveCalculated([call('calculate', { code: 'fu' })])).toBe(true)
    expect(mayHaveCalculated([call('setup_results', { tab: 'overview' })])).toBe(true)
    expect(mayHaveCalculated([call('calculate', { code: 'fu' }, 'error')])).toBe(false)
    expect(mayHaveCalculated([call('calculate_in_canvas', { code: 'fu', method: IPCC })])).toBe(false)
  })
})
