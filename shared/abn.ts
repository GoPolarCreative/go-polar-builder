// ABN validation. Brief s4 step 1: 11 digits, checksum validated, required for a .au domain.
//
// Algorithm published by the ATO:
//   1. subtract 1 from the first digit
//   2. multiply each digit by its positional weight
//   3. the sum must be divisible by 89
// This catches transposed and mistyped ABNs, which is the whole point. It does NOT prove the
// ABN is registered or active. A live ABR lookup happens at domain purchase time (Phase 5),
// because auDA eligibility needs the registered entity name to match, not just a valid number.

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const

export function normaliseAbn(input: string): string {
  return input.replace(/[^0-9]/g, '')
}

export function isValidAbn(input: string): boolean {
  const digits = normaliseAbn(input)
  if (digits.length !== 11) return false

  let sum = 0
  for (let i = 0; i < 11; i++) {
    const raw = Number(digits[i])
    if (Number.isNaN(raw)) return false
    const value = i === 0 ? raw - 1 : raw
    sum += value * ABN_WEIGHTS[i]!
  }
  return sum % 89 === 0
}

// Display format: 12 345 678 901
export function formatAbn(input: string): string {
  const d = normaliseAbn(input)
  if (d.length !== 11) return input
  return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8, 11)}`
}
