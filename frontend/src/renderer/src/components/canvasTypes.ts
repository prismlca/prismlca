import PrismEdge from './PrismEdge'
import PrismNode from './PrismNode'

/** The components the model canvas draws its boxes and arrows with, under the type names the nodes and edges
 *  carry. Module-level constants, so React Flow sees the same objects on every render — a fresh object per
 *  render makes it warn and re-create every node. */
export const NODE_TYPES = { prism: PrismNode }
export const EDGE_TYPES = { prism: PrismEdge }
