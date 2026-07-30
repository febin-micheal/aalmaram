/**
 * Sizes for the on-card add-buttons.
 *
 * In their own module so the headless checks can assert them without importing React —
 * a touch target that quietly shrinks below the guidance is exactly the kind of regression
 * that is invisible on a desktop and ruins the app on a phone.
 */

/** Invisible hit area. 44px is the Apple/Android minimum for a reliable thumb target. */
export const AFFORDANCE_HIT = 44
/** The circle actually drawn — smaller, so the card is not swamped by its buttons. */
export const AFFORDANCE_VISIBLE = 30
