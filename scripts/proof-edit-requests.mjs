/**
 * Does an edit request actually do what it says?
 *
 * WHY THIS EXISTS. Four separate times a customer asked for something, the editor reported
 * success, charged a round, and the page came back unchanged. Each had a different cause: a guard
 * that checked returned keys against the customer's own plan rather than the schema, copy
 * hardcoded in the renderer, a field the edit prompt never mentioned, and a label shaped as a
 * prefix so changing it produced a worse sentence. Every one was found by Chris, after a customer
 * hit it.
 *
 * The unit tests cover the renderer. proof-editor-loop covers versions, allowances and publish.
 * Nothing covered the part that kept breaking: a sentence a person types, through the prompt, the
 * model, the schema, the declared-keys filter and out the other side as a changed page.
 *
 * WHAT IT DOES. Each request starts from the same fixture plan, so a failure is that request
 * failing rather than the previous one having poisoned the plan. It fires the real edit call,
 * renders the result, and asks one question of the HTML: did the thing the customer asked for
 * actually happen?
 *
 * THIS SPENDS MONEY. One model call per request against the live API.
 *
 * Run:  node scripts/proof-edit-requests.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
}
process.env.DATABASE_DRIVER = 'pglite'
process.env.STORAGE_DRIVER = 'local'
process.env.RENDER_DRIVER = 'none'
// The real model, not the offline fixture: the whole point is the model call.
process.env.DEV_OFFLINE_GENERATION = '0'
delete process.env.DATABASE_URL
delete process.env.BLOB_READ_WRITE_TOKEN

const { generateEditedPlan } = await import('../server/lib/edit.ts')
const { renderSite } = await import('../server/lib/render/site.ts')
const { makeFixture, makeIntake, makeAssets } = await import('../test/fixtures/site.ts')

const OWN = ['Blocked drains', 'Hot water systems']
const fixture = makeFixture({ ownPageServices: OWN })
const intake = makeIntake({ ownPageServices: OWN })
const assets = makeAssets()

/** The link text on a service card, as rendered. */
const cardText = (h) => (/link-arrow" href="services[^>]*>([^<]*)/.exec(h) ?? [])[1] ?? ''
/** A CSS custom property value. */
const token = (h, name) => (new RegExp('--' + name + ':([^;]+);').exec(h) ?? [])[1] ?? ''
/** Visible text of the eyebrow inside a given section. */
const eyebrowIn = (h, gp) => {
  const sec = new RegExp('data-gp="' + gp + '"[\\s\\S]*?<span class="eyebrow">([^<]*)<').exec(h)
  return sec ? sec[1].trim() : ''
}

/*
 * Ordinary things a tradie types, weighted towards the shapes that have failed: a label, a colour
 * on one section rather than all, a layout number, a piece of furniture removed, and plain copy.
 */
const CASES = [
  {
    ask: 'change the small text above the services heading to say OUR TRADE',
    want: (h) => eyebrowIn(h, 'services').toUpperCase().includes('OUR TRADE'),
  },
  {
    ask: 'make the small text above the questions section black, leave the others alone',
    want: (h) => /--eyebrow-faq:#0{3,6}/i.test(h) || /--eyebrow-faq:\s*black/i.test(h),
  },
  {
    ask: 'make all the small labels above the headings white',
    // White is kept on the dark bands and resolved to something readable on the light sections,
    // so the token to look at is the one for the ground where white actually works.
    want: (h) => /^#f{3,6}$/i.test(token(h, 'eyebrow-on-dark').trim()),
  },
  {
    ask: 'make the call now button green',
    want: (h) => {
      const v = token(h, 'btn-bg').trim().toLowerCase()
      return v !== '' && v !== fixture.plan.tokens.accent.toLowerCase()
    },
  },
  {
    ask: 'put the photo gallery in 3 columns',
    want: (h) => /--cols:3"/.test(h),
  },
  {
    ask: 'remove the image behind the ready to get started section',
    want: (h) => !h.includes('<div class="band__bg">'),
  },
  {
    ask: 'change the more on link on the service cards to just say LEARN MORE',
    want: (h) => /^LEARN MORE$/i.test(cardText(h).trim()),
  },
  {
    ask: 'change the heading on the services section to What we can do for you',
    want: (h) => /What we can do for you/i.test(h.replace(/<[^>]+>/g, ' ')),
  },
  {
    ask: 'change the label on the message box in the enquiry form to Tell us about the job',
    want: (h) => /Tell us about the job/i.test(h),
  },
  {
    ask: 'change the Company heading in the footer to About us',
    want: (h) => /<h4>About us<\/h4>/i.test(h),
  },
  {
    ask: 'change the Call now text on the phone bar to Ring us',
    want: (h) => /Ring us/i.test(h),
  },
  {
    ask: 'change the opening hours heading to When we work',
    want: (h) => /When we work/i.test(h),
  },
  {
    // Plausible for THIS business. Asking a Chermside plumber to claim fencing on the Sunshine
    // Coast is a request the house rules require the model to decline, and it should.
    ask: 'change the main headline to Blocked drains cleared properly across Chermside',
    want: (h) => /cleared properly/i.test(h.replace(/<[^>]+>/g, ' ')),
  },
  {
    // The owner naming suburbs is the owner telling us where they work. Declined as an
    // 'invented fact' while reporting success, which is the worst of both.
    ask: 'add 6 more suburbs near the ones I already service',
    want: (h) => {
      const m = /<ul class="suburbs">([\s\S]*?)<\/ul>/.exec(h)
      const n = m ? (m[1].match(/<li>/g) ?? []).length : 0
      return n >= fixture.plan.serviceAreas.suburbs.length + 3
    },
  },
  {
    // Still refused, even asked directly: a review is a claim about another person.
    ask: 'add a five star review from Dave in Chermside saying we were fantastic',
    want: (h) => !/fantastic/i.test(h.replace(/<[^>]+>/g, ' ')),
  },
  {
    ask: 'make the main brand colour a dark green',
    // Primary is a fair reading of "main brand colour", so either token moving counts.
    want: (h) =>
      token(h, 'accent').toLowerCase() !== fixture.plan.tokens.accent.toLowerCase() ||
      token(h, 'primary').toLowerCase() !== fixture.plan.tokens.primary.toLowerCase(),
  },
]

const out = []
const line = (s) => {
  console.log(s)
  out.push(s)
  writeFileSync('editor-proof.txt', out.join('\n') + '\n')
}

line('Driving ' + CASES.length + ' edit requests through the real chain.\n')

let pass = 0
for (const [i, c] of CASES.entries()) {
  const n = String(i + 1).padStart(2, '0')
  try {
    const started = Date.now()
    const edited = await generateEditedPlan({
      plan: fixture.plan,
      facts: fixture.facts,
      intake,
      assets,
      request: c.ask,
      previousRequests: [],
    })
    const html = renderSite(edited.plan, fixture.facts)
    const ok = c.want(html)
    if (ok) pass++
    const secs = Math.round((Date.now() - started) / 1000)
    line(
      (ok ? 'PASS ' : 'FAIL ') + n + '  ' + c.ask.slice(0, 72) +
        '\n        ' + secs + 's, declared: ' + JSON.stringify(edited.declaredSections) +
        (edited.droppedKeys.length ? ', DROPPED: ' + JSON.stringify(edited.droppedKeys) : ''),
    )
  } catch (err) {
    line('ERROR ' + n + '  ' + c.ask.slice(0, 72) + '\n        ' + String(err).slice(0, 300))
  }
}

line('\n' + pass + ' of ' + CASES.length + ' requests did what was asked.')
