// Pricing rules (docs/BLUEPRINT.md, "Prices" and "Deposit"). Pure functions: no database.
import { describe, it, expect } from 'vitest';
import { priceNights, depositFor, quote } from '../src/services/pricing.js';

const room = { baseRateKes: 28_000 };

describe('nightly prices', () => {
  it('charges the base rate for every night, at any time of year', () => {
    expect(priceNights(room, '2027-03-10', '2027-03-12')).toEqual([
      { night: '2027-03-10', rateKes: 28_000 },
      { night: '2027-03-11', rateKes: 28_000 },
    ]);
    // Across the old peak dates and the new year: still one rate
    expect(priceNights(room, '2027-12-31', '2028-01-02').map((n) => n.rateKes)).toEqual([28_000, 28_000]);
  });

  it('never charges for the check-out night', () => {
    expect(priceNights(room, '2027-03-10', '2027-03-11').map((n) => n.night)).toEqual(['2027-03-10']);
  });
});

describe('deposit', () => {
  it('is the percentage, rounded UP to the next shilling', () => {
    expect(depositFor(100_000, 30)).toBe(30_000);
    expect(depositFor(28_001, 30)).toBe(8_401);   // 8,400.3 → 8,401: never under-collect
    expect(depositFor(10, 33)).toBe(4);           // 3.3 → 4
  });
  it('is never more than the total, nor less than 1', () => {
    expect(depositFor(500, 100)).toBe(500);
    expect(depositFor(1, 30)).toBe(1);
  });
});

describe('quote', () => {
  it('adds the nights and splits deposit and balance, all in whole shillings', () => {
    const q = quote(room, '2027-06-30', '2027-07-02', 30);
    expect(q.totalKes).toBe(56_000);
    expect(q.depositKes).toBe(16_800);
    expect(q.balanceKes).toBe(39_200);
    expect(Number.isInteger(q.depositKes) && Number.isInteger(q.balanceKes)).toBe(true);
  });
});
