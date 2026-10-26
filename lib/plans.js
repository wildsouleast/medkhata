// Plans (v2, Oct 26 2026): Free forever + one paid plan (monthly or yearly) + 14-day full trial.
// Prices are in rupees; Razorpay works in paise.
const PAID_FEATURES = [
  'Unlimited medicines and bills',
  'Purchase entry (stock auto-update)',
  'Udhaar khata with WhatsApp reminder',
  'Expiry and low-stock alerts',
  'Bills: print + WhatsApp',
  'Unlimited refill reminders',
  'Download stock as CSV (Excel)',
];
const PLANS = {
  monthly: { id: 'monthly', name: 'Pro (monthly)', price: 149, days: 30, period: 'month', features: PAID_FEATURES },
  yearly: { id: 'yearly', name: 'Pro (yearly)', price: 1499, days: 365, period: 'year', features: PAID_FEATURES },
};
// Old paid plan ids (before Oct 26 2026). Nobody can buy them any more; a store that had one keeps full access until it ends.
const LEGACY_NAMES = { basic: 'Basic', pro: 'Pro', clinic: 'Clinic+' };

const PAID = { id: 'paid', name: 'Pro', price: 0, maxMedicines: null, maxBillsPerMonth: null, maxReminders: null, csvExport: true };
const FREE = {
  id: 'free', name: 'Free', price: 0, maxMedicines: 100, maxBillsPerMonth: 50, maxReminders: 20, csvExport: false,
  features: ['Up to 100 medicines', 'Up to 50 bills a month', 'Purchase entry + udhaar khata', 'Expiry and low-stock alerts', 'Up to 20 refill reminders'],
};
// During the free trial the store gets every feature.
const TRIAL = { id: 'trial', name: 'Free trial', price: 0, maxMedicines: null, maxBillsPerMonth: null, maxReminders: null, csvExport: true };
const TRIAL_DAYS = 14;
const TRIAL_HOURS = TRIAL_DAYS * 24;
const PERIOD_DAYS = 30;

function planName(id) { return (PLANS[id] && PLANS[id].name) || LEGACY_NAMES[id] || id; }
function planDays(id) { return (PLANS[id] && PLANS[id].days) || PERIOD_DAYS; }

// state: 'trial' | 'active' | 'free'
function limitsFor(state) {
  if (state === 'trial') return TRIAL;
  if (state === 'active') return PAID;
  return FREE;
}

module.exports = { PLANS, FREE, TRIAL, PAID, TRIAL_DAYS, TRIAL_HOURS, PERIOD_DAYS, LEGACY_NAMES, planName, planDays, limitsFor };
