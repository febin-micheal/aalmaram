import { CARD_W, ROW_PITCH } from './layout.js'

/**
 * Where a provisional node is drawn before the layout has a real position for it.
 *
 * The position must match the affordance that was clicked — partner to the right, child
 * below, parents above — because the whole point of direct manipulation is that the new
 * node appears where you pointed. If it landed somewhere else, even briefly, the gesture
 * would stop meaning anything.
 *
 * Pure geometry, in its own module so the headless checks can import it without dragging
 * in React or the API client.
 */
export function draftPosition(context, anchor) {
  // The first person in an empty archive has no anchor: place them at the origin, which
  // is where an un-panned canvas is centred.
  if (context === 'standalone' || !anchor) return { x: 0, y: 0 }
  switch (context) {
    case 'partner_of':
      return { x: anchor.x + CARD_W + 40, y: anchor.y }
    case 'parent_of':
      return { x: anchor.x, y: anchor.y - ROW_PITCH }
    default: // child_of_person / child_of_union
      return { x: anchor.x, y: anchor.y + ROW_PITCH }
  }
}
