/**
 * The backend reads that address one process, for the renderer and the assistant's tools alike.
 *
 * A process travels as `?database=…&code=…`, never as path segments: a code is whatever a spreadsheet or a
 * bundle brought in, slashes included ("P1/2"), and the backend routes on the decoded path — a code sent
 * as `P1%2F2` in a path still splits it and answers "Not Found". Further parameters follow with `&`.
 */
const processQuery = (database: string, code: string): string =>
  `database=${encodeURIComponent(database)}&code=${encodeURIComponent(code)}`

/** One process with its exchanges. */
export const activityRoute = (database: string, code: string): string =>
  `/api/v1/model/activity?${processQuery(database, code)}`

/** A process's comments and documentation fields. */
export const activityMetadataRoute = (database: string, code: string): string =>
  `/api/v1/model/activity/metadata?${processQuery(database, code)}`

/** The flow properties of a process's reference product (or, with `&input=`, of one of its inputs). */
export const activityPropertiesRoute = (database: string, code: string): string =>
  `/api/v1/model/activity/properties?${processQuery(database, code)}`

/** The tags of one process. */
export const activityTagsRoute = (database: string, code: string): string =>
  `/api/v1/model/tags?${processQuery(database, code)}`
