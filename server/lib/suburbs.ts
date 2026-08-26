import type { AuState, Suburb, SuburbProvider } from '../../shared/suburbs.js'
import { suburbKey } from '../../shared/suburbs.js'
import { localities } from '../data/localities.js'

/**
 * Suburb lookup over the full Australian locality list.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERED. The old provider searched a 161 row development seed
 * that shared/suburbs.ts openly described as "not the authoritative dataset". The service-area
 * step is autocomplete-only on purpose, so for anyone living outside those 161 localities there
 * was no way to enter their own suburb and no way to finish the step. It was reported as
 * "a lot of suburbs don't show up", which is exactly what it was.
 *
 * RANKED, NOT JUST FILTERED. With 161 rows any match was the match. With eighteen thousand,
 * "sunshine" hits Sunshine, Sunshine Beach, Sunshine Coast, Sunshine North, Sunshine West and
 * more, and the one somebody means is almost always the one whose name begins with what they
 * typed. So: exact name, then starts-with, then postcode, then contains, and alphabetical inside
 * each band so the order never jumps about as they type another letter.
 *
 * The old implementation stopped scanning as soon as it had enough prefix matches, which was
 * harmless over a short seed and wrong over a long one: it would return whatever it stumbled on
 * first rather than the best matches available.
 */
export class AuSuburbProvider implements SuburbProvider {
  private readonly data: Suburb[]

  constructor(data?: Suburb[]) {
    this.data =
      data ??
      localities().map((l) => ({
        name: l.name,
        state: l.state as AuState,
        postcode: l.postcode,
        lat: l.lat,
        lng: l.lng,
      }))
  }

  async search(query: string, limit = 8): Promise<Suburb[]> {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []

    const exact: Suburb[] = []
    const starts: Suburb[] = []
    const postcode: Suburb[] = []
    const contains: Suburb[] = []

    for (const s of this.data) {
      const n = s.name.toLowerCase()
      if (n === q) exact.push(s)
      else if (n.startsWith(q)) starts.push(s)
      else if (s.postcode.startsWith(q)) postcode.push(s)
      else if (n.includes(q)) contains.push(s)
    }

    return [...exact, ...starts, ...postcode, ...contains].slice(0, limit)
  }

  async exact(name: string, state: AuState, postcode: string): Promise<Suburb | null> {
    const key = suburbKey({ name, state, postcode })
    return this.data.find((s) => suburbKey(s) === key) ?? null
  }
}
