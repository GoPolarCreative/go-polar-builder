// Australian phone handling. Brief s4 step 1: AU mobile or landline, normalised to +61.
//
// Everything stored and put into schema.org is E.164 (+61...). Display on the generated site
// uses the local format tradies expect (0412 345 678), because +61 412 in a header looks wrong
// to an Australian customer. tel: links always use E.164 so they work from overseas roaming.

export type PhoneKind = 'mobile' | 'landline' | 'invalid'

function digitsOnly(input: string): string {
  return input.replace(/[^\d+]/g, '')
}

/**
 * Returns E.164 (+61412345678) or null if it is not a valid AU number.
 *
 * Note on 13/1300/1800: these carry no trunk zero, so the E.164 form keeps every digit after the
 * country code (+611300123456). Stripping a leading digit off them the way you strip the 0 from
 * an 04 mobile produces a number that does not connect.
 */
export function normaliseAuPhone(input: string): string | null {
  let s = digitsOnly(input)

  if (s.startsWith('+61')) s = s.slice(3)
  else if (s.startsWith('0061')) s = s.slice(4)
  else if (s.startsWith('61') && (s.length === 11 || s.length === 12)) s = s.slice(2)
  else if (s.startsWith('0')) s = s.slice(1)

  s = s.replace(/\+/g, '')

  // Inbound service numbers: 1300/1800 are ten digits, 13 is six. No trunk zero on any of them.
  if (/^(1300|1800)\d{6}$/.test(s) || /^13\d{4}$/.test(s)) return '+61' + s

  // Everything else is nine digits after the trunk zero: 4xxxxxxxx mobile, 2/3/7/8 landline.
  if (s.length !== 9) return null
  const prefix = s[0]!
  if (!['2', '3', '4', '7', '8'].includes(prefix)) return null

  return '+61' + s
}

export function phoneKind(input: string): PhoneKind {
  const e164 = normaliseAuPhone(input)
  if (!e164) return 'invalid'
  const national = e164.slice(3)
  if (national.startsWith('4')) return 'mobile'
  return 'landline'
}

/** Display format for the generated site: 0412 345 678 / (07) 3123 4567 / 1300 123 456 */
export function formatAuPhone(e164OrLocal: string): string {
  const e164 = normaliseAuPhone(e164OrLocal)
  if (!e164) return e164OrLocal
  const national = e164.slice(3)

  if (/^(1300|1800)/.test(national)) {
    return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`
  }
  if (/^13\d{4}$/.test(national)) {
    return `${national.slice(0, 2)} ${national.slice(2, 4)} ${national.slice(4)}`
  }

  const local = '0' + national
  if (local.startsWith('04')) {
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
  }
  return `(${local.slice(0, 2)}) ${local.slice(2, 6)} ${local.slice(6)}`
}
