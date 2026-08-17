// Australian phone handling. Brief s4 step 1: AU mobile or landline, normalised to +61.
//
// Everything stored and put into schema.org is E.164 (+61...). Display on the generated site
// uses the local format tradies expect (0412 345 678), because +61 412 in a header looks wrong
// to an Australian customer. tel: links always use E.164 so they work from overseas roaming.

export type PhoneKind = 'mobile' | 'landline' | 'invalid'

function digitsOnly(input: string): string {
  return input.replace(/[^\d+]/g, '')
}

/** Returns E.164 (+61412345678) or null if it is not a valid AU number. */
export function normaliseAuPhone(input: string): string | null {
  let s = digitsOnly(input)

  if (s.startsWith('+61')) s = '0' + s.slice(3)
  else if (s.startsWith('0061')) s = '0' + s.slice(4)
  else if (s.startsWith('61') && s.length === 11) s = '0' + s.slice(2)

  s = s.replace(/\+/g, '')

  // 8-digit number with no area code cannot be placed. Reject rather than guess a state.
  if (s.length === 8) return null

  if (s.length !== 10 || !s.startsWith('0')) return null

  const area = s.slice(0, 2)
  const isMobile = area === '04'
  const isLandline = ['02', '03', '07', '08'].includes(area)
  // 1300/1800 arrive as 10 digits starting 13/18, handled below.
  const isNational = /^(1300|1800)\d{6}$/.test(s)

  if (!isMobile && !isLandline && !isNational) return null
  if (isNational) return '+61' + s.slice(1)

  return '+61' + s.slice(1)
}

export function phoneKind(input: string): PhoneKind {
  const e164 = normaliseAuPhone(input)
  if (!e164) return 'invalid'
  const local = '0' + e164.slice(3)
  if (local.startsWith('04')) return 'mobile'
  return 'landline'
}

/** Display format for the generated site: 0412 345 678 / (07) 3123 4567 / 1300 123 456 */
export function formatAuPhone(e164OrLocal: string): string {
  const e164 = normaliseAuPhone(e164OrLocal)
  if (!e164) return e164OrLocal
  const local = '0' + e164.slice(3)

  if (/^(1300|1800)/.test(local)) {
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
  }
  if (local.startsWith('04')) {
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
  }
  return `(${local.slice(0, 2)}) ${local.slice(2, 6)} ${local.slice(6)}`
}
