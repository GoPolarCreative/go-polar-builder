/**
 * Never paint text the colour of what it sits on.
 *
 * WHY THIS IS THE RENDERER'S JOB AND NOT A CHECK'S. A check finds it after the fact and refuses
 * the build, which is right for a bug in the template and wrong for a customer's colour choice.
 * "Make the small labels white" is a reasonable thing to ask, it is correct on the dark bands, and
 * it is invisible on the white sections between them. Refusing the whole site over that leaves the
 * customer stuck; painting white on white ships a page with holes in it. Neither is the answer.
 *
 * So the colour a customer asks for is used wherever it can be read, and where it cannot, the page
 * falls back to something that can. The substitution is not hidden: the resolved colours are the
 * tokens in :root, and check 26 reads those same tokens back and reports on the pairs, so the
 * outcome is stated in the build report rather than taken on trust.
 *
 * THE THRESHOLD IS 1.5, AND IT IS DELIBERATELY LOW. The first version used 3.0, the WCAG large
 * text minimum, and it repainted every site: the accent eyebrow on a pale section is 1.90:1 across
 * all four styles, so a rule aimed at readability replaced a colour four designs had chosen on
 * purpose with near black. That is not this function's call to make.
 *
 * Its job is narrower and worth stating plainly: never paint text the colour of what it sits on.
 * Below 1.5 the text has effectively vanished, which is nobody's design decision. Above it, the
 * palette is left alone, and check 26 reports the pairs so a low-contrast choice is visible to an
 * operator without being overridden.
 */

/** Relative luminance, or null for anything that is not a plain hex. */
export function luminance(colour: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim())
  if (!m) return null
  let hex = m[1]!
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const channels = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

/** WCAG contrast ratio, or null when either colour cannot be read as a hex. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Below this, text has vanished rather than merely being low contrast. See the note above. */
export const READABLE = 1.5

export interface Resolved {
  colour: string
  /** Set when the wanted colour was not usable, for the style note in the document. */
  note?: string
}

/**
 * The wanted colour if it can be read on this ground, otherwise the first fallback that can.
 *
 * Fallbacks are tried in order and the last one is used even if it fails, because returning
 * something is better than returning nothing: a wrong colour is visible and fixable, an empty
 * custom property inherits whatever it likes and is neither.
 */
export function readableOn(
  wanted: string,
  ground: string,
  fallbacks: string[],
  where: string,
): Resolved {
  const ratio = contrastRatio(wanted, ground)
  // Not a hex we can judge: a gradient or a colour function. Leave the choice alone.
  if (ratio === null) return { colour: wanted }
  if (ratio >= READABLE) return { colour: wanted }

  /*
   * The BEST of the fallbacks, not the first one that clears the bar. Once a substitution is
   * being made the original choice is already lost, so there is nothing to preserve by picking a
   * near miss over the clearest option available.
   */
  let best: { colour: string; ratio: number } | null = null
  for (const candidate of fallbacks) {
    const r = contrastRatio(candidate, ground)
    if (r !== null && (best === null || r > best.ratio)) best = { colour: candidate, ratio: r }
  }
  if (best !== null && best.ratio >= READABLE) {
    const candidate = best.colour
    {
      return {
        colour: candidate,
        note:
          where + ': ' + wanted + ' is ' + ratio.toFixed(2) + ':1 against ' + ground +
          ', which is not readable, so ' + candidate + ' is used there instead.',
      }
    }
  }

  const last = fallbacks[fallbacks.length - 1] ?? wanted
  return {
    colour: last,
    note:
      where + ': nothing in the palette reads well on ' + ground + '. ' + last +
      ' is used as the closest available.',
  }
}
