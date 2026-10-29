import type { GeoNames } from '../../../shared/geographyNames'
import { useQuery } from './server/useQuery'

const NONE: GeoNames = {}

/**
 * The workspace's names for location codes, read from the user's own ecoinvent release by the backend
 * (shared/geographyNames.ts says what happens without one). Empty until the answer is in — codes show
 * as codes meanwhile.
 *
 * Through the shared query cache: one request serves every picker (a result list mounts one per row),
 * and mounted pickers refetch when the workspace changes (`invalidate('/api/v1/')`) or a background
 * database arrives or goes (`freshDatabases`).
 */
export function useGeographyNames(): GeoNames {
  return useQuery('/api/v1/search/geography-names').data?.names ?? NONE
}
