// Small helpers the booking rules depend on: dates, phones, references, signed links.
import { describe, it, expect } from 'vitest';
import { isIsoDate, addDays, addMonths, daysBetween, nightsOf, todayInNairobi } from '../src/lib/dates.js';
import { normalisePhone, isKenyanMobile } from '../src/lib/phone.js';
import { newRef, REF_PATTERN } from '../src/lib/ref.js';
import { bookingToken, bookingTokenValid } from '../src/lib/bookingLink.js';

describe('dates', () => {
  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2027-02-28')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);      // leap year
    for (const bad of ['2027-02-29', '2027-02-30', '2027-13-01', '27-01-01', '2027-1-1', '', null, 20270101]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });
  it('does day arithmetic across months and years', () => {
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2027-12-30', '2028-01-02')).toBe(3);
    expect(nightsOf('2027-12-30', '2028-01-02')).toEqual(['2027-12-30', '2027-12-31', '2028-01-01']);
  });
  it('adds months, clamping to the end of a shorter month', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2027-08-15', 18)).toBe('2029-02-15');
  });
  it("knows it's already tomorrow in Nairobi when it's 22:30 in London", () => {
    // 21:30 UTC is 00:30 the next day in Nairobi (UTC+3).
    expect(todayInNairobi(new Date('2027-06-30T21:30:00Z'))).toBe('2027-07-01');
    expect(todayInNairobi(new Date('2027-06-30T20:59:00Z'))).toBe('2027-06-30');
  });
});

describe('phones', () => {
  it('stores Kenyan mobiles in one form, whatever way they were typed', () => {
    for (const typed of ['0712 345 678', '712345678', '254712345678', '+254 712-345-678', '(0712) 345.678']) {
      expect(normalisePhone(typed)).toBe('+254712345678');
    }
    expect(normalisePhone('0110 123 456')).toBe('+254110123456');
  });
  it('accepts international numbers that start with +', () => {
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalisePhone('+1 (415) 555-0100')).toBe('+14155550100');
  });
  it('refuses anything else', () => {
    for (const bad of ['', '12345', '0812 345 678', '447700900123', '+0123456789', 'call me', '+2547123456789012']) {
      expect(normalisePhone(bad)).toBeNull();
    }
  });
  it('tells Kenyan mobiles (for M-Pesa) from the rest', () => {
    expect(isKenyanMobile('+254712345678')).toBe(true);
    expect(isKenyanMobile('+447700900123')).toBe(false);
  });
});

describe('booking references', () => {
  it('look like SE-XXXXXX with no confusable characters', () => {
    for (let i = 0; i < 500; i += 1) {
      const ref = newRef();
      expect(ref).toMatch(REF_PATTERN);
      expect(ref.slice(3)).not.toMatch(/[01IOL]/);
    }
  });
});

describe('signed booking links', () => {
  const secret = 'x'.repeat(40);
  it('open only the booking they were made for', () => {
    const t = bookingToken('SE-ABCDEF', { secret });
    expect(bookingTokenValid('SE-ABCDEF', t, { secret })).toBe(true);
    expect(bookingTokenValid('SE-ABCDEG', t, { secret })).toBe(false);
  });
  it('fail when tampered with, expired, or signed with another secret', () => {
    const t = bookingToken('SE-ABCDEF', { secret });
    const [exp, sig] = t.split('.');
    expect(bookingTokenValid('SE-ABCDEF', `${Number(exp) + 1}.${sig}`, { secret })).toBe(false);
    expect(bookingTokenValid('SE-ABCDEF', t, { secret: 'y'.repeat(40) })).toBe(false);
    expect(bookingTokenValid('SE-ABCDEF', t, { secret, now: (Number(exp) + 1) * 1000 })).toBe(false);
    for (const junk of [undefined, '', 'abc', `${exp}.`, `${exp}.${sig}x`]) {
      expect(bookingTokenValid('SE-ABCDEF', junk, { secret })).toBe(false);
    }
  });
});
