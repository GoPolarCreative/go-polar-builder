import { describe, expect, it } from 'vitest'
import { AuSuburbProvider } from '../server/lib/suburbs'
import { localities } from '../server/data/localities'

/**
 * The service-area step is autocomplete-only, so the dataset behind it is not a nicety: a suburb
 * that is not in here is a customer who cannot finish the step at all. It shipped with a 161 row
 * development seed covering the metro areas Go Polar happened to sell into, and the report was
 * the obvious one, that a lot of suburbs did not show up.
 */
describe('the locality dataset', () => {
  it('covers the country rather than a sample of it', () => {
    // The old seed was 161. Australia has roughly eighteen thousand localities with postcodes.
    expect(localities().length).toBeGreaterThan(15000)
  })

  it('has every state and territory', () => {
    const states = new Set(localities().map((l) => l.state))
    expect([...states].sort()).toEqual(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'])
  })

  it('has usable coordinates everywhere, because they become geo.position', () => {
    const bad = localities().filter(
      (l) => !l.lat || !l.lng || l.lat > -9 || l.lat < -44 || l.lng < 112 || l.lng > 154,
    )
    expect(bad).toEqual([])
  })

  it('leaves out post office boxes and mail centres, which are not places', () => {
    const facilities = localities().filter((l) => / (Bc|Dc|Mc|Msc)$/i.test(l.name))
    expect(facilities).toEqual([])
  })

  it('is in title case, not the shouted case the source file uses', () => {
    expect(localities().filter((l) => l.name === l.name.toUpperCase() && l.name.length > 3)).toEqual([])
  })
})

describe('searching it', () => {
  const p = new AuSuburbProvider()

  // Every one of these is outside the old seed, so every one of these used to be unfindable.
  it.each(['Wandi', 'Baldivis', 'Truganina', 'Kellyville Ridge', 'Coomera', 'Ocean Grove'])(
    'finds %s',
    async (name) => {
      const hits = await p.search(name.toLowerCase(), 8)
      expect(hits.some((h) => h.name === name)).toBe(true)
    },
  )

  it('puts the exact name first when several share a prefix', async () => {
    const hits = await p.search('kellyville', 5)
    expect(hits[0]?.name).toBe('Kellyville')
  })

  it('searches by postcode too', async () => {
    const hits = await p.search('4558', 8)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.postcode === '4558')).toBe(true)
    expect(hits.some((h) => h.name === 'Maroochydore')).toBe(true)
  })

  it('says nothing for one character, so the list does not thrash while typing', async () => {
    expect(await p.search('m')).toEqual([])
  })

  it('resolves an exact suburb with its coordinates', async () => {
    const one = await p.exact('Buderim', 'QLD', '4556')
    expect(one).not.toBeNull()
    expect(one?.lat).toBeLessThan(0)
    expect(one?.lng).toBeGreaterThan(112)
  })

  it('answers fast enough to sit behind a keystroke', async () => {
    await p.search('bris', 8)
    const t0 = performance.now()
    for (let i = 0; i < 20; i++) await p.search('sunshine', 8)
    expect((performance.now() - t0) / 20).toBeLessThan(25)
  })
})
