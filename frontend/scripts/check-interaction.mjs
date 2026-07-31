/**
 * Headless interaction checks — do the buttons on the canvas actually do anything?
 *
 * `check-layout.mjs` proves the graph is drawn in the right places. It cannot catch an
 * affordance that renders perfectly and is wired to nothing, which is exactly what
 * happened: the add-buttons appeared on every card in the overview, and clicking them
 * produced no input, no request and no error. Two independent causes, neither visible to a
 * pure-data check — the canvas wrapped an absent handler in an always-truthy arrow, so the
 * buttons drew; and the click, once routed, hit an early return.
 *
 * So this file renders the real components into a DOM and dispatches real events. It is
 * slower and heavier than the layout checks, and deliberately narrow: it asks only "does a
 * click reach the thing it is supposed to reach", which is the class of bug that got
 * through.
 *
 * Run with: npm run check:interaction  (npm run check runs both)
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'
import { JSDOM } from 'jsdom'

let passed = 0
const queue = []

/**
 * Queued and run one at a time, unlike the layout checks.
 *
 * These share a single DOM and React's `act()` refuses to overlap, so running them
 * concurrently produces warnings and a result that depends on scheduling. Sequential is
 * both correct and, as it turns out, far quicker.
 */
function check(name, fn) {
  queue.push({ name, fn })
}

async function runQueue() {
  for (const { name, fn } of queue) {
    try {
      await fn()
      passed += 1
      console.log(`  ✓ ${name}`)
    } catch (error) {
      console.error(`  ✗ ${name}\n    ${error.message}`)
      process.exitCode = 1
    }
  }
}

// --- The DOM the components render into ---------------------------------------------------

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
})

/**
 * jsdom has no PointerEvent, and the canvas is driven entirely by pointer events. A
 * MouseEvent carrying the pointer fields is enough: React dispatches by event *type*, and
 * usePanZoom reads only pointerId/pointerType/button/clientX/clientY.
 */
class PointerEvent extends dom.window.MouseEvent {
  constructor(type, init = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 1
    this.pointerType = init.pointerType ?? 'mouse'
    this.isPrimary = init.isPrimary ?? true
  }
}
dom.window.PointerEvent = PointerEvent

// Pointer capture is how a real browser keeps a drag glued to one element. jsdom has no
// implementation and the source calls it optionally, but define no-ops so the code under
// test takes the same branch it takes in a browser rather than skipping it.
dom.window.Element.prototype.setPointerCapture = function setPointerCapture() {}
dom.window.Element.prototype.releasePointerCapture = function releasePointerCapture() {}
dom.window.Element.prototype.hasPointerCapture = function hasPointerCapture() {
  return false
}
// SVG geometry that jsdom does not compute; the layout is supplied directly, so zero is safe.
dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return { x: 0, y: 0, top: 0, left: 0, right: 1600, bottom: 900, width: 1600, height: 900 }
}
if (!dom.window.ResizeObserver) {
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
dom.window.requestAnimationFrame = (fn) => dom.window.setTimeout(() => fn(Date.now()), 0)
dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id)

for (const key of [
  'window',
  'document',
  'navigator',
  'Element',
  'SVGElement',
  'HTMLElement',
  'Node',
  'MouseEvent',
  'KeyboardEvent',
  'Event',
  'PointerEvent',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
  'getComputedStyle',
]) {
  // Node 22 defines `navigator` as a getter-only global, so plain assignment throws.
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// --- Build the components so Node can import JSX ------------------------------------------

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.resolve(here, '..')
const outDir = mkdtempSync(path.join(tmpdir(), 'aalmaram-check-'))

const entry = `
  export { default as React } from 'react'
  export * as ReactDOMClient from 'react-dom/client'
  export { act } from 'react'
  export { default as GraphCanvas } from '${path.join(root, 'src/components/GraphCanvas.jsx')}'
  export { default as App } from '${path.join(root, 'src/App.jsx')}'
  export { layoutGraph, CARD_W, CARD_H } from '${path.join(root, 'src/graph/layout.js')}'
  export { translatorFor } from '${path.join(root, 'src/i18n/index.js')}'
`

await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: 'js' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: path.join(outDir, 'bundle.mjs'),
  // Vite injects import.meta.env; the components read it only for the API base URL, and
  // api.js already optional-chains it. esbuild needs a bare identifier here, not an
  // expression, so point it at a global that is simply undefined.
  define: { 'import.meta.env': 'undefined' },
  loader: { '.css': 'empty' },
  logLevel: 'silent',
})

const { React, ReactDOMClient, act, GraphCanvas, App, layoutGraph, CARD_W, CARD_H, translatorFor } =
  await import(
    pathToFileURL(path.join(outDir, 'bundle.mjs')).href,
  )

// --- Fixture ------------------------------------------------------------------------------

/** Three generations, the shape the live archive had when the buttons went dead. */
function household() {
  const person = (id, name, generation, extra = {}) => ({
    id,
    name_en: name,
    name_ml: '',
    display_name: name,
    house_name: 'Manayil',
    gender: 'male',
    is_living: true,
    birth_display: '',
    death_display: '',
    lifespan_compact: '',
    place_origin: '',
    generation,
    hidden_up: 0,
    hidden_down: 0,
    ...extra,
  })
  return {
    persons: [
      person('clement', 'Clement', 0),
      person('leelamma', 'Leelamma', 0, { gender: 'female' }),
      person('child', 'Child', 1),
    ],
    unions: [
      {
        id: 'u',
        union_type: 'marriage',
        status: 'active',
        year_display: '',
        place: '',
        generation: 0,
      },
    ],
    memberships: [
      { union: 'u', person: 'clement', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u', person: 'leelamma', role: 'partner', relation_type: 'biological', sibling_order: null },
      { union: 'u', person: 'child', role: 'child', relation_type: 'biological', sibling_order: 1 },
    ],
  }
}

const t = translatorFor('en')

/** Render GraphCanvas into a fresh container and hand back DOM helpers. */
async function mount(props = {}) {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const root_ = ReactDOMClient.createRoot(container)

  const calls = []
  const layout = layoutGraph(household(), 'clement')

  await act(async () => {
    root_.render(
      React.createElement(GraphCanvas, {
        layout,
        centerId: 'clement',
        locale: 'en',
        renderMode: 'cards',
        onSelect: () => {},
        onExpand: () => {},
        onAddRelative: (context, person) => calls.push({ context, person: person.id }),
        t,
        ...props,
      }),
    )
  })

  return {
    calls,
    container,
    layout,
    all: (selector) => [...container.querySelectorAll(selector)],
    cleanup: () => {
      act(() => root_.unmount())
      container.remove()
    },
  }
}

/** A real press-and-release on an element, in the order a browser produces it. */
async function clickElement(element, { drag = 0 } = {}) {
  const fire = (type, init) =>
    element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }))

  await act(async () => {
    fire('pointerdown', { clientX: 100, clientY: 100, button: 0 })
    if (drag) {
      // Moves go to the element that captured the pointer, i.e. wherever pointerdown landed.
      fire('pointermove', { clientX: 100 + drag, clientY: 100 + drag, button: 0 })
    }
    fire('pointerup', { clientX: 100 + drag, clientY: 100 + drag, button: 0 })
    fire('click', { clientX: 100 + drag, clientY: 100 + drag, button: 0, detail: 1 })
  })
}

console.log('affordance wiring')

check('all three affordances are in the DOM and findable by context', async () => {
  const view = await mount()
  const contexts = view.all('[data-affordance]').map((el) => el.dataset.affordance)
  // Clement and Leelamma have no recorded parents, the child does — so + parents appears
  // twice, not three times.
  assert.deepEqual(contexts.filter((c) => c === 'partner_of').length, 3)
  assert.deepEqual(contexts.filter((c) => c === 'child_of_person').length, 3)
  assert.deepEqual(
    contexts.filter((c) => c === 'parent_of').length,
    2,
    'a person who already hangs from a union must not be offered parents',
  )
  view.cleanup()
})

for (const context of ['partner_of', 'child_of_person', 'parent_of']) {
  check(`clicking + ${context} reaches the handler`, async () => {
    const view = await mount()
    const button = view.all(`[data-affordance="${context}"]`)[0]
    assert.ok(button, `no ${context} affordance rendered`)

    await clickElement(button)

    assert.equal(
      view.calls.length,
      1,
      `the click produced nothing — the affordance renders but is dead`,
    )
    assert.equal(view.calls[0].context, context)
    view.cleanup()
  })
}

check('the pan handler does not swallow an affordance click', async () => {
  // The suspicion that started this: pointerdown on the svg starts a drag, and a drag in
  // progress suppresses clicks. The affordance stops propagation for exactly this reason.
  const view = await mount()
  const button = view.all('[data-affordance="partner_of"]')[0]

  await clickElement(button, { drag: 30 })

  assert.equal(view.calls.length, 1, 'a click that moved a little must still register')
  view.cleanup()
})

check('no handler means no buttons — never a button that does nothing', async () => {
  // The actual defect. The canvas used to wrap the missing handler in an arrow function,
  // which is truthy, so every card drew three buttons that silently went nowhere.
  const view = await mount({ onAddRelative: undefined })
  // Count, not the nodes themselves: a deepEqual over SVG elements produces an
  // unreadable diff on failure, and the number is the whole claim.
  assert.equal(
    view.all('[data-affordance]').length,
    0,
    'affordances rendered with no handler to call — this is the "renders but dead" bug',
  )
  view.cleanup()
})

check('a card click still selects when the affordances are live', async () => {
  // Making the buttons work must not make the card underneath unclickable.
  const selected = []
  const view = await mount({ onSelect: (person) => selected.push(person.id) })
  const card = view.container.querySelector('[data-person-id="clement"]')
  assert.ok(card, 'the card needs a stable hook of its own')

  await clickElement(card)

  assert.deepEqual(selected, ['clement'])
  view.cleanup()
})

// --- The whole app, in the state the bug was reported from ---------------------------------

/** The overview payload for a small real archive: two parents and a child. */
function overviewPayload() {
  return {
    persons: [
      { id: 'clement', name_en: 'Clement', name_ml: '', display_name: 'Clement', house_name: 'Manayil', gender: 'male', is_living: true, lifespan_compact: '', band: 0 },
      { id: 'leelamma', name_en: 'Leelamma', name_ml: '', display_name: 'Leelamma', house_name: 'Manayil', gender: 'female', is_living: true, lifespan_compact: '', band: 0 },
      { id: 'child', name_en: 'Child', name_ml: '', display_name: 'Child', house_name: 'Manayil', gender: 'male', is_living: true, lifespan_compact: '', band: 1 },
    ],
    unions: [{ id: 'u', band: 0 }],
    memberships: [
      { union: 'u', person: 'clement', role: 'partner', sibling_order: null },
      { union: 'u', person: 'leelamma', role: 'partner', sibling_order: null },
      { union: 'u', person: 'child', role: 'child', sibling_order: 1 },
    ],
    stats: { persons: 3, unions: 1, components: 1 },
  }
}

/** Serve the endpoints App opens with; record anything else so gaps are visible. */
function stubApi() {
  const seen = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input)
    const method = init.method ?? 'GET'
    seen.push({ url, method, body: init.body ? JSON.parse(init.body) : null })
    const body = url.includes('/overview/')
      ? overviewPayload()
      : url.includes('/me/')
        ? { anchor_person: null }
        : url.includes('/relate-bulk/')
          ? { from: null, results: {} }
          : url.includes('/persons/') && method === 'POST'
            ? {
                person: { id: 'made-up', display_name: 'New', name_en: 'New', generation: 0 },
                union: 'u',
                memberships: [],
                created_unions: [],
                created_person: true,
              }
            : url.includes('/persons/') && method === 'DELETE'
              ? { person: 'made-up', unions: [] }
              : url.includes('/persons/') && method === 'PATCH'
                ? { id: 'clement', name_en: 'Renamed', display_name: 'Renamed', generation: 0 }
                : {}
    return { ok: true, status: 200, statusText: 'OK', json: async () => body }
  }
  return seen
}

/** Mount the whole app on the three-person overview and settle its effects. */
async function mountApp() {
  const requests = stubApi()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const appRoot = ReactDOMClient.createRoot(container)
  await act(async () => {
    appRoot.render(React.createElement(App))
  })
  await act(async () => {})
  return {
    container,
    requests,
    q: (selector) => container.querySelector(selector),
    cleanup: () => {
      act(() => appRoot.unmount())
      container.remove()
    },
  }
}

async function pressKey(key, init = {}) {
  await act(async () => {
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
  })
  await act(async () => {})
}

check('the reported state: overview of a real archive, + parents opens an input', async () => {
  // Three people, landing view, never entering the detail view — which is where a small
  // archive actually lives, and where every add-button was dead.
  const requests = stubApi()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const appRoot = ReactDOMClient.createRoot(container)

  await act(async () => {
    appRoot.render(React.createElement(App))
  })
  await act(async () => {})

  assert.ok(
    requests.some((r) => r.url.includes('/overview/')),
    'the app should have loaded the overview',
  )
  assert.equal(
    container.querySelector('[data-inline-input]'),
    null,
    'no name input should be open before anything is clicked',
  )

  const button = container.querySelector('[data-affordance="parent_of"]')
  assert.ok(button, 'no + parents button rendered in the overview')

  await clickElement(button)
  await act(async () => {})

  // The whole point: a real input, focusable and typeable, not just a handler that ran.
  const input = container.querySelector('[data-inline-input]')
  assert.ok(input, 'clicking + parents in the overview opened nothing — the button is dead')

  act(() => appRoot.unmount())
  container.remove()
})

// --- Where the buttons sit -----------------------------------------------------------------

check('a rendered affordance never lands on a union dot', () => {
  // From the screenshot: a "+" appeared to float over the union dot between two partners.
  // The + child buttons genuinely sit on the same horizontal line as the dot, so this
  // pins the one thing that would actually be ambiguous — a button close enough to the
  // dot that a tap could plausibly mean either.
  const layout = layoutGraph(household(), 'clement')
  const hit = 44
  const tooClose = []

  for (const person of layout.persons.values()) {
    const hasParents = [...layout.unions.values()].some((u) => u.childIds.includes(person.id))
    const buttons = [
      { context: 'partner_of', cx: person.x + CARD_W + 6 + hit / 2, cy: person.y + CARD_H / 2 },
      { context: 'child_of_person', cx: person.x + CARD_W / 2, cy: person.y + CARD_H + 6 + hit / 2 },
    ]
    // + parents is not drawn for someone who already hangs from a union, which is exactly
    // what keeps it off the dot directly above them.
    if (!hasParents) {
      buttons.push({ context: 'parent_of', cx: person.x + CARD_W / 2, cy: person.y - 6 - hit / 2 })
    }
    for (const button of buttons) {
      for (const union of layout.unions.values()) {
        const distance = Math.hypot(button.cx - union.x, button.cy - union.y)
        // 22 is the union dot's own hit radius when it is a choose-this-union candidate.
        if (distance < 22 + hit / 2) {
          tooClose.push(`${person.id} ${button.context} is ${distance.toFixed(0)}px from a union dot`)
        }
      }
    }
  }

  assert.deepEqual(tooClose, [], tooClose.join('; '))
})

check('a child who already has parents is never offered more', () => {
  // The geometric near-miss above is prevented by this rule, not by the coordinates —
  // so if the rule ever goes, the previous check is what starts failing.
  const layout = layoutGraph(household(), 'clement')
  const child = layout.persons.get('child')
  const parentUnion = [...layout.unions.values()].find((u) => u.childIds.includes('child'))
  assert.ok(parentUnion, 'the fixture child must hang from a union')
  // The + parents button would sit here, which is right on top of that union dot.
  const wouldBe = { cx: child.x + CARD_W / 2, cy: child.y - 6 - 22 }
  const distance = Math.hypot(wouldBe.cx - parentUnion.x, wouldBe.cy - parentUnion.y)
  assert.ok(distance < 66, `expected the suppressed button to be near the dot, was ${distance.toFixed(0)}px`)
})

console.log('\nediting, escape and history')

check('clicking a name opens a rename box already holding that name', () => {
  // The reported gap: a person added to the graph could not be corrected on the canvas.
  return (async () => {
    const app = await mountApp()
    assert.equal(app.q('[data-inline-input]'), null)

    const nameHit = app.q('[data-edit-name="clement"]')
    assert.ok(nameHit, 'the name on a card must be a target you can click')
    await clickElement(nameHit)

    const input = app.q('[data-inline-input]')
    assert.ok(input, 'clicking the name opened nothing')
    assert.equal(input.value, 'Clement', 'the box should start from the current name')
    app.cleanup()
  })()
})

check('Escape closes the rename box from anywhere, not only inside it', () => {
  // Escape used to be handled only by the input's own keydown, so it worked while the
  // caret was in the box and nowhere else.
  return (async () => {
    const app = await mountApp()
    await clickElement(app.q('[data-edit-name="clement"]'))
    assert.ok(app.q('[data-inline-input]'))

    // Dispatched on window, as if focus had moved away from the input.
    await pressKey('Escape')

    assert.equal(app.q('[data-inline-input]'), null, 'Escape did not close the box')
    app.cleanup()
  })()
})

check('Escape cancels a half-finished add', () => {
  return (async () => {
    const app = await mountApp()
    await clickElement(app.q('[data-affordance="parent_of"]'))
    assert.ok(app.q('[data-inline-input]'), 'the add flow should be open')

    await pressKey('Escape')
    assert.equal(app.q('[data-inline-input]'), null, 'Escape must cancel a draft too')
    app.cleanup()
  })()
})

check('undo and redo are real buttons, disabled until there is something to do', () => {
  return (async () => {
    const app = await mountApp()
    const undo = app.q('button[data-action="undo"]')
    const redo = app.q('button[data-action="redo"]')
    assert.ok(undo && redo, 'both buttons must exist in the toolbar')
    assert.equal(undo.disabled, true, 'nothing has happened yet — undo must be inert')
    assert.equal(redo.disabled, true)
    app.cleanup()
  })()
})

check('after adding someone, undo enables and calls the server', () => {
  return (async () => {
    const app = await mountApp()
    await clickElement(app.q('[data-affordance="child_of_person"]'))
    const input = app.q('[data-inline-input]')

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'Newborn')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {})

    const posted = app.requests.filter((r) => r.method === 'POST' && r.url.includes('/persons/'))
    assert.equal(posted.length, 1, 'the name should have been sent once')

    const undo = app.q('button[data-action="undo"]')
    assert.equal(undo.disabled, false, 'undo must become available after a creation')

    // Undo is an API call, not a local rewind — the database is the record.
    await clickElement(undo)
    const deleted = app.requests.filter((r) => r.method === 'DELETE')
    assert.equal(deleted.length, 1, 'undo must ask the server to remove the node')

    // And redo replays it forward.
    const redo = app.q('button[data-action="redo"]')
    assert.equal(redo.disabled, false, 'redo must be available straight after an undo')
    await clickElement(redo)
    const reposted = app.requests.filter((r) => r.method === 'POST' && r.url.includes('/persons/'))
    assert.equal(reposted.length, 2, 'redo must re-create through the same endpoint')
    assert.deepEqual(reposted[1].body, reposted[0].body, 'redo must replay the same request')
    app.cleanup()
  })()
})

check('Ctrl+Z and Ctrl+Y drive the same history as the buttons', () => {
  return (async () => {
    const app = await mountApp()
    await clickElement(app.q('[data-affordance="child_of_person"]'))
    const input = app.q('[data-inline-input]')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'Newborn')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {})

    await pressKey('z', { ctrlKey: true })
    assert.equal(app.requests.filter((r) => r.method === 'DELETE').length, 1, 'Ctrl+Z must undo')

    await pressKey('y', { ctrlKey: true })
    assert.equal(
      app.requests.filter((r) => r.method === 'POST' && r.url.includes('/persons/')).length,
      2,
      'Ctrl+Y must redo',
    )
    app.cleanup()
  })()
})

await runQueue()
rmSync(outDir, { recursive: true, force: true })
console.log(`\n${passed} interaction check(s) passed`)
// jsdom's timers and esbuild's service keep the loop alive; the work is done.
process.exit(process.exitCode ?? 0)
