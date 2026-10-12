// Pricing rules (docs/BLUEPRINT.md, "Prices" and "Deposit"). Pure functions: no database.
import { describe, it, expect } from 'vitest';
import { priceNights, depositFor, quote } from '../src/services/pricing.js';

const room = { baseRateKes: 28_000 };
const migration = { id: 1, label: 'Migration season', startsOn: '2027-07-01', endsOn: '2027-11-01', nightlyRateKes: 35_000 };
const christmas = { id: 2, label: 'Christmas week', startsOn: '2027-12-22', endsOn: '2027-12-29', nightlyRateKes: 40_000 };
const festive = { id: 3, label: 'Festive season', startsOn: '2027-12-20', endsOn: '2028-01-04', nightlyRateKes: 38_000 };

describe('nightly prices', () => {
  it('uses the base rate when no season applies', () => {
    expect(priceNights(room, '2027-03-10', '2027-03-12', [migration])).toEqual([
      { night: '2027-03-10', rateKes: 28_000, season: null },
      { night: '2027-03-11', rateKes: 28_000, season: null },
    ]);
  });

  it('never charges for the check-out night', () => {
    expect(priceNights(room, '2027-03-10', '2027-03-11', []).map((n) => n.night)).toEqual(['2027-03-10']);
  });

  it('prices a stay that crosses into a season night by night', () => {
    const nights = priceNights(room, '2027-06-29', '2027-07-02', [migration]);
    expect(nights.map((n) => n.rateKes)).toEqual([28_000, 28_000, 35_000]);
  });

  it("treats a season's end date as not included, like a check-out", () => {
    const nights = priceNights(room, '2027-10-31', '2027-11-02', [migration]);
    expect(nights.map((n) => n.rateKes)).toEqual([35_000, 28_000]);
  });

  it('lets the season that starts later win where two overlap', () => {
    const nights = priceNights(room, '2027-12-21', '2027-12-24', [festive, christmas]);
    expect(nights.map((n) => [n.night, n.season])).toEqual([
      ['2027-12-21', 'Festive season'], ['2027-12-22', 'Christmas week'], ['2027-12-23', 'Christmas week'],
    ]);
  });

  it('handles a season running into the new year', () => {
    const nights = priceNights(room, '2027-12-31', '2028-01-05', [festive]);
    expect(nights.map((n) => n.rateKes)).toEqual([38_000, 38_000, 38_000, 38_000, 28_000]);
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
    const q = quote(room, '2027-06-30', '2027-07-02', [migration], 30);
    expect(q.totalKes).toBe(63_000);
    expect(q.depositKes).toBe(18_900);
    expect(q.balanceKes).toBe(44_100);
    expect(Number.isInteger(q.depositKes) && Number.isInteger(q.balanceKes)).toBe(true);
  });
});
