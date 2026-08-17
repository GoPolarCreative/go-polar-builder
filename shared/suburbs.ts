// AU suburb dataset + lookup, used by the service-area step.
//
// ------------------------------------------------------------------------------------------
// IMPORTANT, READ BEFORE LAUNCH
// This is a DEVELOPMENT SEED, not the authoritative dataset. It covers the metro areas and
// regional centres Go Polar actually sells into, roughly 150 localities. Coordinates are
// suburb-centroid approximations and are good enough for geo.position meta tags, not for
// anything that needs survey accuracy.
//
// Before launch, replace the SEED array with a full locality dataset (Australia Post
// postcode file, or G-NAF localities via data.gov.au) loaded from blob storage or a database
// table. Nothing else has to change: everything goes through the SuburbProvider interface below.
//
// The rule from the brief is what matters and it holds either way - the service-area field is
// AUTOCOMPLETE ONLY. Free text there is how service names ended up in the service-area field
// on the Google Form.
// ------------------------------------------------------------------------------------------

export interface Suburb {
  name: string
  state: AuState
  postcode: string
  lat: number
  lng: number
}

export type AuState = 'QLD' | 'NSW' | 'VIC' | 'SA' | 'WA' | 'TAS' | 'NT' | 'ACT'

export interface SuburbProvider {
  search(query: string, limit?: number): Promise<Suburb[]>
  exact(name: string, state: AuState, postcode: string): Promise<Suburb | null>
}

/* eslint-disable prettier/prettier */
const SEED: Suburb[] = [
  // --- Greater Brisbane -------------------------------------------------------------------
  { name: 'Brisbane City',    state: 'QLD', postcode: '4000', lat: -27.4698, lng: 153.0251 },
  { name: 'Fortitude Valley', state: 'QLD', postcode: '4006', lat: -27.4570, lng: 153.0340 },
  { name: 'New Farm',         state: 'QLD', postcode: '4005', lat: -27.4670, lng: 153.0480 },
  { name: 'Newstead',         state: 'QLD', postcode: '4006', lat: -27.4450, lng: 153.0430 },
  { name: 'Hamilton',         state: 'QLD', postcode: '4007', lat: -27.4400, lng: 153.0670 },
  { name: 'Ascot',            state: 'QLD', postcode: '4007', lat: -27.4300, lng: 153.0600 },
  { name: 'Clayfield',        state: 'QLD', postcode: '4011', lat: -27.4180, lng: 153.0570 },
  { name: 'Nundah',           state: 'QLD', postcode: '4012', lat: -27.4030, lng: 153.0600 },
  { name: 'Chermside',        state: 'QLD', postcode: '4032', lat: -27.3850, lng: 153.0330 },
  { name: 'Aspley',           state: 'QLD', postcode: '4034', lat: -27.3630, lng: 153.0200 },
  { name: 'Bridgeman Downs',  state: 'QLD', postcode: '4035', lat: -27.3540, lng: 153.0020 },
  { name: 'Albany Creek',     state: 'QLD', postcode: '4035', lat: -27.3480, lng: 152.9670 },
  { name: 'Everton Park',     state: 'QLD', postcode: '4053', lat: -27.4020, lng: 152.9930 },
  { name: 'Stafford',         state: 'QLD', postcode: '4053', lat: -27.4090, lng: 153.0100 },
  { name: 'Ashgrove',         state: 'QLD', postcode: '4060', lat: -27.4440, lng: 152.9930 },
  { name: 'The Gap',          state: 'QLD', postcode: '4061', lat: -27.4430, lng: 152.9440 },
  { name: 'Toowong',          state: 'QLD', postcode: '4066', lat: -27.4850, lng: 152.9930 },
  { name: 'Indooroopilly',    state: 'QLD', postcode: '4068', lat: -27.4990, lng: 152.9730 },
  { name: 'Kenmore',          state: 'QLD', postcode: '4069', lat: -27.5060, lng: 152.9400 },
  { name: 'West End',         state: 'QLD', postcode: '4101', lat: -27.4830, lng: 153.0100 },
  { name: 'Woolloongabba',    state: 'QLD', postcode: '4102', lat: -27.4900, lng: 153.0350 },
  { name: 'Coorparoo',        state: 'QLD', postcode: '4151', lat: -27.4950, lng: 153.0570 },
  { name: 'Camp Hill',        state: 'QLD', postcode: '4152', lat: -27.4930, lng: 153.0730 },
  { name: 'Carindale',        state: 'QLD', postcode: '4152', lat: -27.5030, lng: 153.1000 },
  { name: 'Mount Gravatt',    state: 'QLD', postcode: '4122', lat: -27.5380, lng: 153.0800 },
  { name: 'Sunnybank',        state: 'QLD', postcode: '4109', lat: -27.5720, lng: 153.0540 },
  { name: 'Springwood',       state: 'QLD', postcode: '4127', lat: -27.6120, lng: 153.1330 },
  { name: 'Wynnum',           state: 'QLD', postcode: '4178', lat: -27.4430, lng: 153.1720 },
  { name: 'Cleveland',        state: 'QLD', postcode: '4163', lat: -27.5270, lng: 153.2650 },
  { name: 'Victoria Point',   state: 'QLD', postcode: '4165', lat: -27.5850, lng: 153.3020 },
  { name: 'Redland Bay',      state: 'QLD', postcode: '4165', lat: -27.6120, lng: 153.2960 },
  { name: 'Capalaba',         state: 'QLD', postcode: '4157', lat: -27.5270, lng: 153.1930 },
  { name: 'Logan Central',    state: 'QLD', postcode: '4114', lat: -27.6390, lng: 153.1090 },
  { name: 'Beenleigh',        state: 'QLD', postcode: '4207', lat: -27.7130, lng: 153.2010 },
  { name: 'Ipswich',          state: 'QLD', postcode: '4305', lat: -27.6140, lng: 152.7600 },
  { name: 'Springfield Lakes',state: 'QLD', postcode: '4300', lat: -27.6650, lng: 152.9160 },
  { name: 'Redbank Plains',   state: 'QLD', postcode: '4301', lat: -27.6500, lng: 152.8600 },
  { name: 'Strathpine',       state: 'QLD', postcode: '4500', lat: -27.3020, lng: 152.9860 },
  { name: 'North Lakes',      state: 'QLD', postcode: '4509', lat: -27.2280, lng: 153.0080 },
  { name: 'Redcliffe',        state: 'QLD', postcode: '4020', lat: -27.2300, lng: 153.1100 },
  { name: 'Caboolture',       state: 'QLD', postcode: '4510', lat: -27.0850, lng: 152.9510 },
  { name: 'Narangba',         state: 'QLD', postcode: '4504', lat: -27.2000, lng: 152.9600 },
  { name: 'Samford Village',  state: 'QLD', postcode: '4520', lat: -27.3690, lng: 152.8880 },

  // --- Gold Coast -------------------------------------------------------------------------
  { name: 'Southport',        state: 'QLD', postcode: '4215', lat: -27.9670, lng: 153.4000 },
  { name: 'Surfers Paradise', state: 'QLD', postcode: '4217', lat: -28.0020, lng: 153.4300 },
  { name: 'Broadbeach',       state: 'QLD', postcode: '4218', lat: -28.0280, lng: 153.4300 },
  { name: 'Burleigh Heads',   state: 'QLD', postcode: '4220', lat: -28.0900, lng: 153.4500 },
  { name: 'Palm Beach',       state: 'QLD', postcode: '4221', lat: -28.1170, lng: 153.4650 },
  { name: 'Currumbin',        state: 'QLD', postcode: '4223', lat: -28.1330, lng: 153.4830 },
  { name: 'Coolangatta',      state: 'QLD', postcode: '4225', lat: -28.1670, lng: 153.5350 },
  { name: 'Robina',           state: 'QLD', postcode: '4226', lat: -28.0700, lng: 153.3900 },
  { name: 'Mudgeeraba',       state: 'QLD', postcode: '4213', lat: -28.0800, lng: 153.3670 },
  { name: 'Nerang',           state: 'QLD', postcode: '4211', lat: -27.9930, lng: 153.3350 },
  { name: 'Helensvale',       state: 'QLD', postcode: '4212', lat: -27.9080, lng: 153.3320 },
  { name: 'Coomera',          state: 'QLD', postcode: '4209', lat: -27.8560, lng: 153.3300 },
  { name: 'Ormeau',           state: 'QLD', postcode: '4208', lat: -27.7600, lng: 153.2600 },

  // --- Sunshine Coast and Wide Bay ---------------------------------------------------------
  { name: 'Maroochydore',     state: 'QLD', postcode: '4558', lat: -26.6570, lng: 153.0930 },
  { name: 'Mooloolaba',       state: 'QLD', postcode: '4557', lat: -26.6820, lng: 153.1190 },
  { name: 'Caloundra',        state: 'QLD', postcode: '4551', lat: -26.8000, lng: 153.1330 },
  { name: 'Buderim',          state: 'QLD', postcode: '4556', lat: -26.6840, lng: 153.0560 },
  { name: 'Noosa Heads',      state: 'QLD', postcode: '4567', lat: -26.3980, lng: 153.0900 },
  { name: 'Nambour',          state: 'QLD', postcode: '4560', lat: -26.6260, lng: 152.9590 },
  { name: 'Gympie',           state: 'QLD', postcode: '4570', lat: -26.1900, lng: 152.6650 },
  { name: 'Hervey Bay',       state: 'QLD', postcode: '4655', lat: -25.2900, lng: 152.8400 },
  { name: 'Bundaberg',        state: 'QLD', postcode: '4670', lat: -24.8660, lng: 152.3490 },

  // --- Regional QLD -------------------------------------------------------------------------
  { name: 'Toowoomba',        state: 'QLD', postcode: '4350', lat: -27.5600, lng: 151.9500 },
  { name: 'Rockhampton',      state: 'QLD', postcode: '4700', lat: -23.3780, lng: 150.5100 },
  { name: 'Gladstone',        state: 'QLD', postcode: '4680', lat: -23.8430, lng: 151.2560 },
  { name: 'Mackay',           state: 'QLD', postcode: '4740', lat: -21.1440, lng: 149.1860 },
  { name: 'Townsville',       state: 'QLD', postcode: '4810', lat: -19.2590, lng: 146.8170 },
  { name: 'Cairns',           state: 'QLD', postcode: '4870', lat: -16.9190, lng: 145.7780 },

  // --- Sydney ------------------------------------------------------------------------------
  { name: 'Sydney',           state: 'NSW', postcode: '2000', lat: -33.8688, lng: 151.2093 },
  { name: 'Surry Hills',      state: 'NSW', postcode: '2010', lat: -33.8860, lng: 151.2110 },
  { name: 'Newtown',          state: 'NSW', postcode: '2042', lat: -33.8980, lng: 151.1790 },
  { name: 'Marrickville',     state: 'NSW', postcode: '2204', lat: -33.9110, lng: 151.1550 },
  { name: 'Bondi Junction',   state: 'NSW', postcode: '2022', lat: -33.8920, lng: 151.2500 },
  { name: 'Randwick',         state: 'NSW', postcode: '2031', lat: -33.9140, lng: 151.2410 },
  { name: 'Manly',            state: 'NSW', postcode: '2095', lat: -33.7970, lng: 151.2870 },
  { name: 'Dee Why',          state: 'NSW', postcode: '2099', lat: -33.7530, lng: 151.2870 },
  { name: 'Chatswood',        state: 'NSW', postcode: '2067', lat: -33.7960, lng: 151.1830 },
  { name: 'Hornsby',          state: 'NSW', postcode: '2077', lat: -33.7030, lng: 151.0990 },
  { name: 'Parramatta',       state: 'NSW', postcode: '2150', lat: -33.8150, lng: 151.0000 },
  { name: 'Blacktown',        state: 'NSW', postcode: '2148', lat: -33.7710, lng: 150.9060 },
  { name: 'Penrith',          state: 'NSW', postcode: '2750', lat: -33.7510, lng: 150.6940 },
  { name: 'Liverpool',        state: 'NSW', postcode: '2170', lat: -33.9200, lng: 150.9230 },
  { name: 'Campbelltown',     state: 'NSW', postcode: '2560', lat: -34.0650, lng: 150.8140 },
  { name: 'Sutherland',       state: 'NSW', postcode: '2232', lat: -34.0320, lng: 151.0570 },
  { name: 'Cronulla',         state: 'NSW', postcode: '2230', lat: -34.0560, lng: 151.1520 },
  { name: 'Castle Hill',      state: 'NSW', postcode: '2154', lat: -33.7320, lng: 151.0050 },
  { name: 'Newcastle',        state: 'NSW', postcode: '2300', lat: -32.9270, lng: 151.7760 },
  { name: 'Maitland',         state: 'NSW', postcode: '2320', lat: -32.7330, lng: 151.5570 },
  { name: 'Wollongong',       state: 'NSW', postcode: '2500', lat: -34.4250, lng: 150.8930 },
  { name: 'Coffs Harbour',    state: 'NSW', postcode: '2450', lat: -30.2960, lng: 153.1140 },
  { name: 'Port Macquarie',   state: 'NSW', postcode: '2444', lat: -31.4310, lng: 152.9080 },
  { name: 'Byron Bay',        state: 'NSW', postcode: '2481', lat: -28.6430, lng: 153.6120 },
  { name: 'Tweed Heads',      state: 'NSW', postcode: '2485', lat: -28.1770, lng: 153.5390 },
  { name: 'Wagga Wagga',      state: 'NSW', postcode: '2650', lat: -35.1150, lng: 147.3690 },
  { name: 'Albury',           state: 'NSW', postcode: '2640', lat: -36.0740, lng: 146.9240 },
  { name: 'Dubbo',            state: 'NSW', postcode: '2830', lat: -32.2560, lng: 148.6010 },
  { name: 'Orange',           state: 'NSW', postcode: '2800', lat: -33.2830, lng: 149.1010 },

  // --- Melbourne ---------------------------------------------------------------------------
  { name: 'Melbourne',        state: 'VIC', postcode: '3000', lat: -37.8136, lng: 144.9631 },
  { name: 'Richmond',         state: 'VIC', postcode: '3121', lat: -37.8180, lng: 145.0000 },
  { name: 'Fitzroy',          state: 'VIC', postcode: '3065', lat: -37.7980, lng: 144.9780 },
  { name: 'Brunswick',        state: 'VIC', postcode: '3056', lat: -37.7670, lng: 144.9600 },
  { name: 'Preston',          state: 'VIC', postcode: '3072', lat: -37.7410, lng: 145.0100 },
  { name: 'Coburg',           state: 'VIC', postcode: '3058', lat: -37.7440, lng: 144.9670 },
  { name: 'Essendon',         state: 'VIC', postcode: '3040', lat: -37.7530, lng: 144.9160 },
  { name: 'Footscray',        state: 'VIC', postcode: '3011', lat: -37.8000, lng: 144.9000 },
  { name: 'Werribee',         state: 'VIC', postcode: '3030', lat: -37.9000, lng: 144.6600 },
  { name: 'Point Cook',       state: 'VIC', postcode: '3030', lat: -37.9140, lng: 144.7500 },
  { name: 'St Kilda',         state: 'VIC', postcode: '3182', lat: -37.8680, lng: 144.9810 },
  { name: 'Brighton',         state: 'VIC', postcode: '3186', lat: -37.9060, lng: 144.9980 },
  { name: 'Cheltenham',       state: 'VIC', postcode: '3192', lat: -37.9640, lng: 145.0560 },
  { name: 'Frankston',        state: 'VIC', postcode: '3199', lat: -38.1440, lng: 145.1230 },
  { name: 'Dandenong',        state: 'VIC', postcode: '3175', lat: -37.9870, lng: 145.2140 },
  { name: 'Berwick',          state: 'VIC', postcode: '3806', lat: -38.0350, lng: 145.3440 },
  { name: 'Ringwood',         state: 'VIC', postcode: '3134', lat: -37.8140, lng: 145.2290 },
  { name: 'Box Hill',         state: 'VIC', postcode: '3128', lat: -37.8190, lng: 145.1230 },
  { name: 'Glen Waverley',    state: 'VIC', postcode: '3150', lat: -37.8780, lng: 145.1650 },
  { name: 'Geelong',          state: 'VIC', postcode: '3220', lat: -38.1490, lng: 144.3600 },
  { name: 'Ballarat Central', state: 'VIC', postcode: '3350', lat: -37.5620, lng: 143.8500 },
  { name: 'Bendigo',          state: 'VIC', postcode: '3550', lat: -36.7570, lng: 144.2780 },
  { name: 'Shepparton',       state: 'VIC', postcode: '3630', lat: -36.3800, lng: 145.4000 },
  { name: 'Traralgon',        state: 'VIC', postcode: '3844', lat: -38.1950, lng: 146.5400 },

  // --- Perth -------------------------------------------------------------------------------
  { name: 'Perth',            state: 'WA', postcode: '6000', lat: -31.9523, lng: 115.8613 },
  { name: 'Fremantle',        state: 'WA', postcode: '6160', lat: -32.0560, lng: 115.7440 },
  { name: 'Joondalup',        state: 'WA', postcode: '6027', lat: -31.7450, lng: 115.7660 },
  { name: 'Scarborough',      state: 'WA', postcode: '6019', lat: -31.8940, lng: 115.7600 },
  { name: 'Morley',           state: 'WA', postcode: '6062', lat: -31.8880, lng: 115.9070 },
  { name: 'Midland',          state: 'WA', postcode: '6056', lat: -31.8890, lng: 116.0100 },
  { name: 'Armadale',         state: 'WA', postcode: '6112', lat: -32.1490, lng: 116.0150 },
  { name: 'Rockingham',       state: 'WA', postcode: '6168', lat: -32.2770, lng: 115.7290 },
  { name: 'Mandurah',         state: 'WA', postcode: '6210', lat: -32.5290, lng: 115.7230 },
  { name: 'Bunbury',          state: 'WA', postcode: '6230', lat: -33.3270, lng: 115.6410 },
  { name: 'Geraldton',        state: 'WA', postcode: '6530', lat: -28.7780, lng: 114.6150 },
  { name: 'Kalgoorlie',       state: 'WA', postcode: '6430', lat: -30.7490, lng: 121.4660 },

  // --- Adelaide ----------------------------------------------------------------------------
  { name: 'Adelaide',         state: 'SA', postcode: '5000', lat: -34.9285, lng: 138.6007 },
  { name: 'Norwood',          state: 'SA', postcode: '5067', lat: -34.9200, lng: 138.6300 },
  { name: 'Glenelg',          state: 'SA', postcode: '5045', lat: -34.9800, lng: 138.5140 },
  { name: 'Prospect',         state: 'SA', postcode: '5082', lat: -34.8850, lng: 138.5940 },
  { name: 'Salisbury',        state: 'SA', postcode: '5108', lat: -34.7580, lng: 138.6400 },
  { name: 'Elizabeth',        state: 'SA', postcode: '5112', lat: -34.7180, lng: 138.6700 },
  { name: 'Modbury',          state: 'SA', postcode: '5092', lat: -34.8320, lng: 138.6870 },
  { name: 'Noarlunga Centre', state: 'SA', postcode: '5168', lat: -35.1400, lng: 138.4900 },
  { name: 'Mount Barker',     state: 'SA', postcode: '5251', lat: -35.0670, lng: 138.8580 },
  { name: 'Mount Gambier',    state: 'SA', postcode: '5290', lat: -37.8290, lng: 140.7820 },

  // --- Tasmania, NT, ACT --------------------------------------------------------------------
  { name: 'Hobart',           state: 'TAS', postcode: '7000', lat: -42.8821, lng: 147.3272 },
  { name: 'Glenorchy',        state: 'TAS', postcode: '7010', lat: -42.8350, lng: 147.2750 },
  { name: 'Kingston',         state: 'TAS', postcode: '7050', lat: -42.9770, lng: 147.3080 },
  { name: 'Launceston',       state: 'TAS', postcode: '7250', lat: -41.4390, lng: 147.1350 },
  { name: 'Devonport',        state: 'TAS', postcode: '7310', lat: -41.1770, lng: 146.3510 },
  { name: 'Darwin',           state: 'NT',  postcode: '0800', lat: -12.4634, lng: 130.8456 },
  { name: 'Palmerston',       state: 'NT',  postcode: '0830', lat: -12.4860, lng: 130.9830 },
  { name: 'Alice Springs',    state: 'NT',  postcode: '0870', lat: -23.6980, lng: 133.8807 },
  { name: 'Canberra',         state: 'ACT', postcode: '2601', lat: -35.2809, lng: 149.1300 },
  { name: 'Belconnen',        state: 'ACT', postcode: '2617', lat: -35.2380, lng: 149.0680 },
  { name: 'Tuggeranong',      state: 'ACT', postcode: '2900', lat: -35.4200, lng: 149.0900 },
  { name: 'Gungahlin',        state: 'ACT', postcode: '2912', lat: -35.1850, lng: 149.1330 },
]
/* eslint-enable prettier/prettier */

export const SUBURB_SEED: readonly Suburb[] = SEED

export function suburbKey(s: Pick<Suburb, 'name' | 'state' | 'postcode'>): string {
  return `${s.name.toLowerCase()}|${s.state}|${s.postcode}`
}

export function suburbLabel(s: Suburb): string {
  return `${s.name}, ${s.state} ${s.postcode}`
}

/** In-memory provider over the seed. Swap for a database backed one without touching callers. */
export class SeedSuburbProvider implements SuburbProvider {
  constructor(private readonly data: readonly Suburb[] = SEED) {}

  async search(query: string, limit = 8): Promise<Suburb[]> {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []

    const starts: Suburb[] = []
    const contains: Suburb[] = []
    for (const s of this.data) {
      const n = s.name.toLowerCase()
      if (n.startsWith(q) || s.postcode.startsWith(q)) starts.push(s)
      else if (n.includes(q)) contains.push(s)
      if (starts.length >= limit) break
    }
    return [...starts, ...contains].slice(0, limit)
  }

  async exact(name: string, state: AuState, postcode: string): Promise<Suburb | null> {
    const key = suburbKey({ name, state, postcode })
    return this.data.find((s) => suburbKey(s) === key) ?? null
  }
}

/**
 * Rough centroid of a set of suburbs. Used for the GeoCircle centre when a travel radius is
 * given, and for geo.position when no street address was supplied.
 * Fine at suburb scale in Australia. Not a geodesic centroid, and not meant to be.
 */
export function centroid(suburbs: Suburb[]): { lat: number; lng: number } | null {
  if (suburbs.length === 0) return null
  const lat = suburbs.reduce((a, s) => a + s.lat, 0) / suburbs.length
  const lng = suburbs.reduce((a, s) => a + s.lng, 0) / suburbs.length
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) }
}
