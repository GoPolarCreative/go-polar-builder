import type { IntakePayload } from '../shared/intake'

/**
 * The business the committed sample site is built from. Invented for demonstration, not a real
 * Go Polar customer. Shared by the sample builder and by the seed script so both show the same
 * business.
 */
export const SAMPLE_INTAKE: IntakePayload = {
  businessName: 'Cold Front Plumbing',
  trade: 'plumber',
  tradingEntityName: 'Cold Front Plumbing Pty Ltd',
  abn: '51824753556',
  yearsInBusiness: 14,
  phone: '+61412345678',
  email: 'jobs@coldfrontplumbing.com.au',
  address: { line1: '', suburb: 'Chermside', state: 'QLD', postcode: '4032', verified: true },

  services: [
    'Blocked drains',
    'Hot water systems',
    'Burst pipes',
    'Leak detection',
    'Tap and toilet repairs',
    'Gas fitting',
  ],
  primaryService: 'Blocked drains',
  // Two additional pages bought, so the committed sample is a real page set rather than a
  // one-page build with the feature switched off.
  ownPageServices: ['Blocked drains', 'Hot water systems'],
  freeQuotes: true,
  emergency: true,

  baseSuburb: { name: 'Chermside', state: 'QLD', postcode: '4032', lat: -27.385, lng: 153.033 },
  suburbsServiced: [
    { name: 'Chermside', state: 'QLD', postcode: '4032', lat: -27.385, lng: 153.033 },
    { name: 'Aspley', state: 'QLD', postcode: '4034', lat: -27.363, lng: 153.02 },
    { name: 'Nundah', state: 'QLD', postcode: '4012', lat: -27.403, lng: 153.06 },
    { name: 'Clayfield', state: 'QLD', postcode: '4011', lat: -27.418, lng: 153.057 },
    { name: 'Stafford', state: 'QLD', postcode: '4053', lat: -27.409, lng: 153.01 },
    { name: 'Everton Park', state: 'QLD', postcode: '4053', lat: -27.402, lng: 152.993 },
    { name: 'Albany Creek', state: 'QLD', postcode: '4035', lat: -27.348, lng: 152.967 },
    { name: 'Strathpine', state: 'QLD', postcode: '4500', lat: -27.302, lng: 152.986 },
  ],
  travelRadius: '20',

  about:
    'Dad started Cold Front out of a ute in 1998 and I took it over in 2011. We are a two van outfit working the Brisbane northside, mostly drains and hot water. We answer the phone ourselves, we turn up when we say we will, and if we cannot get to you the same day we will tell you straight rather than leave you waiting.',
  different:
    'We do not subcontract. The bloke who quotes the job is the bloke who does the job, so nothing gets lost between the two.',
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
      quote:
        'Rang at 7am with a blocked main and they were here by 9. Cleared it, showed me the camera footage, and the price was what they said on the phone.',
      firstName: 'Marion',
      suburb: 'Aspley',
    },
    {
      quote:
        'Hot water went on a Sunday night. Got a new one in Monday morning and they took the old unit away. No mess, no fuss.',
      firstName: 'Dave',
      suburb: 'Nundah',
    },
    {
      quote: 'Second time we have used them. Straight answer on the phone and a fair price. Hard to find.',
      firstName: 'Priya',
      suburb: 'Clayfield',
    },
  ],
  googleReviewLink: '',
  socials: {
    facebook: 'https://www.facebook.com/coldfrontplumbing',
    instagram: '',
    linkedin: '',
    tiktok: '',
    youtube: '',
  },

  designStyle: 'auto',
  logoAssetId: 'ast_logo',
  photoAssetIds: ['ast_p1', 'ast_p2', 'ast_p3', 'ast_p4'],
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
