/**
 * Luhn checksum — used to filter out 13-19 digit sequences that look like
 * credit cards but aren't (timestamps, IDs, phone-number runs in logs, etc.).
 *
 * Operates on the digit-only string. Caller strips spaces/dashes first.
 */

export function isLuhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alternate = false
  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.charCodeAt(i)
    if (code < 48 || code > 57) return false
    let n = code - 48
    if (alternate) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alternate = !alternate
  }
  return sum % 10 === 0
}
