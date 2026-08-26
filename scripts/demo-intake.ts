import type { IntakePayload } from '../shared/intake'

/**
 * The business the four style demos are built from.
 *
 * INVENTED, AND SAID SO ON THE PAGE. Kirra Coast Electrical does not exist, the reviews were
 * written here, and the phone number is the reserved 04XX prefix Australian broadcasters use for
 * drama so nobody's real phone rings. A demo that looks real enough to ring is a demo that gets
 * somebody's mobile called at 6am.
 *
 * DIFFERENT TRADE TO THE SAMPLE ON PURPOSE. sample/ is a plumber; these are an electrician. A
 * customer flicking between the four styles should not be looking at the same business twice, and
 * it proves the styles are not tuned to one trade.
 *
 * GO POLAR'S OWN PALETTE. Black and the accent cyan, so the four demos read as a set from the
 * people building the site rather than four unrelated websites. The picker already tells the
 * customer that colours come from their own logo, so holding colour constant across the four is
 * what makes the shape the only thing that changes.
 */
export const DEMO_INTAKE: IntakePayload = {
  businessName: 'Kirra Coast Electrical',
  trade: 'electrician',
  tradingEntityName: 'Kirra Coast Electrical Pty Ltd',
  abn: '51824753556',
  yearsInBusiness: 12,
  // 0491 570 006 is one of ACMA's reserved drama numbers. It cannot connect to anybody.
  phone: '+61491570006',
  email: 'jobs@example.com.au',
  address: { line1: '', suburb: 'Palm Beach', state: 'QLD', postcode: '4221', verified: true },

  services: [
    'Switchboard upgrades',
    'Safety switch testing',
    'LED lighting',
    'Ceiling fans',
    'Power points and rewiring',
    'EV charger installation',
  ],
  primaryService: 'Switchboard upgrades',
  ownPageServices: ['Switchboard upgrades', 'EV charger installation'],
  freeQuotes: true,
  emergency: true,

  baseSuburb: { name: 'Palm Beach', state: 'QLD', postcode: '4221', lat: -28.117, lng: 153.463 },
  suburbsServiced: [
    { name: 'Palm Beach', state: 'QLD', postcode: '4221', lat: -28.117, lng: 153.463 },
    { name: 'Burleigh Heads', state: 'QLD', postcode: '4220', lat: -28.093, lng: 153.449 },
    { name: 'Currumbin', state: 'QLD', postcode: '4223', lat: -28.13, lng: 153.474 },
    { name: 'Miami', state: 'QLD', postcode: '4220', lat: -28.06, lng: 153.437 },
    { name: 'Tugun', state: 'QLD', postcode: '4224', lat: -28.148, lng: 153.49 },
    { name: 'Elanora', state: 'QLD', postcode: '4221', lat: -28.128, lng: 153.44 },
    { name: 'Varsity Lakes', state: 'QLD', postcode: '4227', lat: -28.084, lng: 153.412 },
  ],
  travelRadius: '20',

  about:
    'Kirra Coast has been on the southern Gold Coast since 2014. There are three of us and two vans, and between us we have done most of what a house can throw at an electrician. We answer our own phones, we give you the price before we start, and we clean up after ourselves. If it is going to cost more than we quoted you hear about it before the work happens, not on the invoice.',
  different:
    'We do not use subbies. The sparky who quotes your job is the one who turns up to do it, so nothing gets lost in the handover.',
  hours: {
    mon: { closed: false, open: '06:30', close: '16:30' },
    tue: { closed: false, open: '06:30', close: '16:30' },
    wed: { closed: false, open: '06:30', close: '16:30' },
    thu: { closed: false, open: '06:30', close: '16:30' },
    fri: { closed: false, open: '06:30', close: '16:30' },
    sat: { closed: false, open: '07:00', close: '12:00' },
    sun: { closed: true, open: '08:00', close: '12:00' },
    byAppointment: false,
    isDefault: false,
  },
  reviews: [
    {
      quote:
        'Old switchboard finally gave up on a Friday arvo. Beau had power back on that evening and the new board is a lot tidier than what was there before.',
      firstName: 'Janelle',
      suburb: 'Burleigh Heads',
    },
    {
      quote:
        'Quoted the EV charger on the Tuesday, installed the Thursday, and the price was the price. Explained the whole thing without making me feel thick.',
      firstName: 'Rob',
      suburb: 'Currumbin',
    },
    {
      quote:
        'Had them back for a third job now. They turn up when they say they will, which sounds like a low bar until you have tried a few others.',
      firstName: 'Steph',
      suburb: 'Palm Beach',
    },
    {
      quote:
        'Safety switch kept tripping and two other blokes could not find it. These fellas traced it to a dead oven element in about forty minutes.',
      firstName: 'Marcus',
      suburb: 'Miami',
    },
  ],
  googleReviewLink: '',
  socials: {
    facebook: '',
    instagram: '',
    linkedin: '',
    tiktok: '',
    youtube: '',
  },

  designStyle: 'auto',
  logoAssetId: 'ast_logo',
  photoAssetIds: ['ast_p1', 'ast_p2', 'ast_p3', 'ast_p4'],
  // Go Polar's own black and accent cyan, held constant across all four demos.
  palette: {
    primary: '#0a0a0a',
    secondary: '#1da7f5',
    accent: '#38b6ff',
    dark: '#070b12',
    light: '#f4f6f8',
    source: 'manual',
  },
  existingDomain: '',
}
