import type { IntakePayload } from '../../shared/intake'
import type { AssetRecord, AssetVariant } from '../../shared/types'
import type { BuildFacts, ContentPlan } from '../../shared/plan'
import { setConfigForTests, loadConfig, type AppConfig } from '../../server/config'
import { buildFacts } from '../../server/lib/facts'
import { offlineHtml, offlinePlan } from '../../server/lib/offline'

/**
 * One known-good site, built the way the offline pipeline builds one, used as the baseline for
 * every check test. Breaking it in a specific way and asserting the matching check trips is the
 * whole point: a check that never fails is not a check.
 */

/** Tests never read the real environment. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig()
  const cfg: AppConfig = {
    ...base,
    demoMode: true,
    storageDriver: 'local',
    databaseDriver: 'pglite',
    web3formsAccessKey: '11111111-2222-3333-4444-555555555555',
    publicAppUrl: 'https://build.itscold.com.au',
    appSecret: 'test-secret-not-a-real-one',
    ...overrides,
  }
  setConfigForTests(cfg)
  return cfg
}

// Applied on import so every test file gets the same deterministic configuration.
testConfig()

export function makeIntake(overrides: Partial<IntakePayload> = {}): IntakePayload {
  const base: IntakePayload = {
    businessName: 'Cold Front Plumbing',
    trade: 'plumber',
    tradingEntityName: 'Cold Front Plumbing Pty Ltd',
    abn: '51824753556',
    yearsInBusiness: 14,
    phone: '+61412345678',
    email: 'jobs@coldfrontplumbing.com.au',
    address: { line1: '', suburb: 'Chermside', state: 'QLD', postcode: '4032', verified: true },

    services: ['Blocked drains', 'Hot water systems', 'Burst pipes', 'Leak detection', 'Gas fitting'],
    primaryService: 'Blocked drains',
    freeQuotes: true,
    emergency: true,

    baseSuburb: { name: 'Chermside', state: 'QLD', postcode: '4032', lat: -27.385, lng: 153.033 },
    suburbsServiced: [
      { name: 'Chermside', state: 'QLD', postcode: '4032', lat: -27.385, lng: 153.033 },
      { name: 'Aspley', state: 'QLD', postcode: '4034', lat: -27.363, lng: 153.02 },
      { name: 'Nundah', state: 'QLD', postcode: '4012', lat: -27.403, lng: 153.06 },
    ],
    travelRadius: '20',

    about:
      'Dad started Cold Front out of a ute in 1998 and I took it over in 2011. We are a two van outfit working the Brisbane northside, mostly drains and hot water.',
    different: 'We do not subcontract. The bloke who quotes the job is the bloke who does it.',
    hours: {
      mon: { closed: false, open: '06:30', close: '17:00' },
      tue: { closed: false, open: '06:30', close: '17:00' },
      wed: { closed: false, open: '06:30', close: '17:00' },
      thu: { closed: false, open: '06:30', close: '17:00' },
      fri: { closed: false, open: '06:30', close: '17:00' },
      sat: { closed: false, open: '07:00', close: '12:00' },
      sun: { closed: true, open: '08:00', close: '12:00' },
      byAppointment: false,
      isDefault: false,
    },
    reviews: [
      {
        quote: 'Rang at 7am with a blocked main and they were here by 9. Price was what they said.',
        firstName: 'Marion',
        suburb: 'Aspley',
      },
    ],
    googleReviewLink: '',
    socials: { facebook: '', instagram: '', linkedin: '', tiktok: '', youtube: '' },

    logoAssetId: 'ast_logo',
    photoAssetIds: ['ast_p1', 'ast_p2', 'ast_p3'],
    palette: {
      primary: '#0d3b66',
      secondary: '#5a86ad',
      accent: '#f4a261',
      dark: '#14171a',
      light: '#f4f6f8',
      source: 'logo',
    },
    existingDomain: '',
  }
  return { ...base, ...overrides }
}

/** Byte sizes here are realistic outputs of the sharp pipeline, not round numbers. */
function photoVariants(assetId: string): AssetVariant[] {
  return [
    { role: 'web', format: 'webp', key: `jobs/job_test/photo/${assetId}-web.webp`, bytes: 214_800, width: 1920, height: 1440 },
    { role: 'web', format: 'jpeg', key: `jobs/job_test/photo/${assetId}-web.jpg`, bytes: 318_400, width: 1920, height: 1440 },
    { role: 'thumb', format: 'webp', key: `jobs/job_test/photo/${assetId}-thumb.webp`, bytes: 52_100, width: 800, height: 600 },
    { role: 'thumb', format: 'jpeg', key: `jobs/job_test/photo/${assetId}-thumb.jpg`, bytes: 74_900, width: 800, height: 600 },
  ]
}

export function makeAssets(): AssetRecord[] {
  const photo = (assetId: string, order: number): AssetRecord => ({
    id: assetId,
    jobId: 'job_test',
    kind: 'photo',
    filename: `${assetId}.jpg`,
    contentType: 'image/jpeg',
    originalKey: `jobs/job_test/original/${assetId}`,
    originalBytes: 8_400_000, // a phone photo, before processing
    width: 4032,
    height: 3024,
    sortOrder: order,
    stats: {
      width: 4032,
      height: 3024,
      aspect: 1.333,
      flatRatio: 0.12,
      distinctColours: 190,
      hasTransparency: false,
      photographicScore: 0.72,
      dominant: ['#336699'],
    },
    variants: photoVariants(assetId),
    createdAt: '2026-08-17T00:00:00.000Z',
  })

  return [
    {
      id: 'ast_logo',
      jobId: 'job_test',
      kind: 'logo',
      filename: 'logo.png',
      contentType: 'image/png',
      originalKey: 'jobs/job_test/original/ast_logo',
      originalBytes: 82_000,
      width: 512,
      height: 512,
      sortOrder: 0,
      stats: {
        width: 512,
        height: 512,
        aspect: 1,
        flatRatio: 0.94,
        distinctColours: 4,
        hasTransparency: true,
        photographicScore: 0.06,
        dominant: ['#0d3b66', '#f4a261'],
      },
      variants: [
        { role: 'web', format: 'webp', key: 'jobs/job_test/logo/ast_logo-web.webp', bytes: 9_100, width: 512, height: 512 },
        { role: 'web', format: 'png', key: 'jobs/job_test/logo/ast_logo-web.png', bytes: 14_600, width: 512, height: 512 },
      ],
      createdAt: '2026-08-17T00:00:00.000Z',
    },
    photo('ast_p1', 0),
    photo('ast_p2', 1),
    photo('ast_p3', 2),
  ]
}

export interface Fixture {
  intake: IntakePayload
  assets: AssetRecord[]
  facts: BuildFacts
  plan: ContentPlan
  html: string
}

export function makeFixture(overrides: Partial<IntakePayload> = {}): Fixture {
  const intake = makeIntake(overrides)
  const assets = makeAssets()
  const facts = buildFacts(intake, assets)
  const plan = offlinePlan(
    intake,
    facts,
    [],
    facts.photos.map((p) => ({ assetId: p.assetId, path: p.webWebp, note: 'client photo' })),
  )
  return { intake, assets, facts, plan, html: offlineHtml(plan, facts) }
}
