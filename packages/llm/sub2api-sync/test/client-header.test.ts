import { describe, expect, it } from 'vitest'
import { accountLabelOf, formatBalance, maskEmail } from '../src/client/section/header.ts'

describe('maskEmail', () => {
  it('keeps the first local character and the domain', () => {
    expect(maskEmail('user@example.com')).toBe('u***@example.com')
    expect(maskEmail('  a.b@sub.example.com ')).toBe('a***@sub.example.com')
  })

  it('masks a separator-less value wholesale and answers a dash for empty', () => {
    expect(maskEmail('local-only')).toBe('l***')
    expect(maskEmail('@example.com')).toBe('@***')
    expect(maskEmail('   ')).toBe('—')
  })
})

describe('formatBalance', () => {
  it('formats USD with two decimals and widens sub-cent amounts', () => {
    expect(formatBalance(12.5)).toBe('$12.50')
    expect(formatBalance(0)).toBe('$0.00')
    expect(formatBalance(0.0042)).toBe('$0.004200')
    expect(formatBalance(-1.5)).toBe('-$1.50')
  })
})

describe('accountLabelOf', () => {
  it('prefers the username and masks the email otherwise', () => {
    expect(accountLabelOf({ username: ' zs ', email: 'user@example.com' })).toBe('zs')
    expect(accountLabelOf({ email: 'user@example.com' })).toBe('u***@example.com')
  })

  it('answers undefined without identity data', () => {
    expect(accountLabelOf(undefined)).toBeUndefined()
    expect(accountLabelOf({})).toBeUndefined()
    expect(accountLabelOf({ username: '   ' })).toBeUndefined()
  })
})
