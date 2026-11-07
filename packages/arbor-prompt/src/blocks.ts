/**
 * The `<dsh>` block kind: one data field, no tag of its own, so arbor's
 * renderer wraps the third-party content in `<data>` and marks it as data
 * rather than instructions.
 */

import type { BlockKindSpec } from '@4fu/arbor-interfaces'

/** The `<dsh>` block kind the section renders: one data field, no tag of its own. */
export const DSH_DATA_BLOCK: BlockKindSpec = {
  kind: 'data',
  fields: [{ name: 'content', type: 'string', required: true }],
}
