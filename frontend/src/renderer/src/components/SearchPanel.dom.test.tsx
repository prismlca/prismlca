// @vitest-environment jsdom
/**
 * What the search panel says about the index. An empty "My processes" was reported as "not indexed" — a
 * fault where there is nothing at all — and the biosphere's build counted its elementary flows as
 * "datasets", so the second progress bar after an import looked like the first one again. And a
 * database imported while another was being indexed showed a bare Index button, as if nothing would
 * ever index it, while its build was already lined up.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const info: Record<string, { activities: number; indexed: boolean }> = {
  'My processes': { activities: 0, indexed: false },
  'ecoinvent-3.12-cutoff': { activities: 26533, indexed: true },
  'bafu-2026-v1': { activities: 11730, indexed: false }
}

vi.mock('../lib/api', async (actual) => ({
  ...(await actual<typeof import('../lib/api')>()),
  api: vi.fn(async (_method: string, path: string) => {
    if (!path.startsWith('/api/v1/search/index-info')) return [] // region lists and the like: none
    const db = decodeURIComponent(path.split('database=')[1] ?? '')
    const i = info[db]
    return {
      database: db,
      indexed_count: i.indexed ? i.activities : null,
      stale: false,
      building: false,
      ...i
    }
  })
}))

import SearchPanel from './SearchPanel'
import type { DatabaseInfo } from '../lib/api'
import type { IndexBuildStatus } from '../workbench/useSearchIndexStatus'

const databases = [
  { name: 'ecoinvent-3.12-cutoff', kind: 'background', read_only: true, node_count: 26533 },
  { name: 'My processes', kind: 'library', read_only: false, node_count: 0 },
  { name: 'biosphere3', kind: 'biosphere', read_only: true, node_count: 9850 }
] as unknown as DatabaseInfo[]

function panel(buildStatus: IndexBuildStatus | null = null, dbs: DatabaseInfo[] = databases): void {
  render(
    <SearchPanel
      databases={dbs}
      searchDbs={['ecoinvent-3.12-cutoff', 'My processes']}
      onSearchDbs={() => {}}
      onAddReference={() => {}}
      onShowDetails={() => {}}
      onEditDataset={() => {}}
      onError={() => {}}
      confirm={() => {}}
      buildStatus={buildStatus}
    />
  )
}

describe('SearchPanel index messages', () => {
  it('calls an empty database empty, not unindexed, and offers no Index button for it', async () => {
    panel()
    await waitFor(() => expect(screen.getByText(/“My processes” is empty/)).toBeTruthy())
    expect(screen.queryByText(/is not indexed/)).toBeNull()
    expect(screen.queryByRole('button', { name: /index/i })).toBeNull()
  })

  it('counts flows as flows while the biosphere is indexed', () => {
    panel({ state: 'running', database: 'biosphere3', detail: '', count: 2000, total: 9850 })
    expect(screen.getByText(/2,000\s*\/\s*9,850 flows/)).toBeTruthy()
    expect(screen.getByText('biosphere3')).toBeTruthy()
    expect(screen.getByText('estimating…')).toBeTruthy()
    expect(screen.getByText(/saved and reused on later starts/)).toBeTruthy()
  })

  it('counts datasets for a background', () => {
    panel({ state: 'running', database: 'ecoinvent-3.12-cutoff', detail: '', count: 120, total: 26533 })
    expect(screen.getByText(/120\s*\/\s*26,533 datasets/)).toBeTruthy()
  })

  it('says a database waiting behind the running build is queued instead of offering Index', async () => {
    const bafu = { name: 'bafu-2026-v1', kind: 'background', read_only: true, node_count: 11730 }
    const status = {
      state: 'running',
      database: 'ecoinvent-3.12-cutoff',
      detail: '',
      count: 120,
      total: 26533
    }
    panel({ ...status, queued: ['bafu-2026-v1'] } as IndexBuildStatus, [
      ...databases,
      bafu as unknown as DatabaseInfo
    ])
    await waitFor(() => expect(screen.getByText('queued')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /index/i })).toBeNull()
  })
})
