// Plans (v3, Oct 26 2026): no free-forever plan. 7-day full trial, then Basic ₹49/month or Pro ₹149/month / ₹1,499/year.
// After the trial (or a paid period) ends with no payment, the store is READ-ONLY: everything can be viewed and
// downloaded, nothing new can be added. Data is never deleted.
// Prices are in rupees; Razorpay works in paise.
const BASIC_FEATURES = [
  'Up to 100 medicines',
  'Up to 50 bills a month',
  'Bills: print + WhatsApp',
  'Expiry and low-stock alerts',
  'Refill reminders (up to 20 patients)',
];
const PRO_FEATURES = [
  'Unlimited medicines and bills',
  'Purchase entry (stock auto-update)',
  'Udhaar khata with WhatsApp reminder',
  'Download stock as CSV (Excel)',
  'Unlimited refill reminders',
  'Expiry and low-stock alerts',
];
const PLANS = {
  basic_monthly: { id: 'basic_monthly', tier: 'basic', name: 'Basic', price: 49, days: 30, period: 'month', features: BASIC_FEATURES },
  monthly: { id: 'monthly', tier: 'pro', name: 'Pro (monthly)', price: 149, days: 30, period: 'month', features: PRO_FEATURES },
  yearly: { id: 'yearly', tier: 'pro', name: 'Pro (yearly)', price: 1499, days: 365, period: 'year', features: PRO_FEATURES },
};
// Old paid plan ids (before Oct 26 2026). Nobody can buy them any more; a store that had one keeps full access until it ends.
const LEGACY_NAMES = { basic: 'Basic (old)', pro: 'Pro', clinic: 'Clinic+' };

const PRO = { id: 'pro', name: 'Pro', maxMedicines: null, maxBillsPerMonth: null, maxReminders: null, csvExport: true, purchases: true, khata: true, readOnly: false };
const BASIC = { id: 'basic', name: 'Basic', maxMedicines: 100, maxBillsPerMonth: 50, maxReminders: 20, csvExport: false, purchases: false, khata: false, readOnly: false };
// During the free trial the store gets every Pro feature.
const TRIAL = Object.assign({}, PRO, { id: 'trial', name: 'Free trial' });
// Trial / plan over, no payment: view + download only.
const READ_ONLY = { id: 'expired', name: 'Read-only', maxMedicines: 0, maxBillsPerMonth: 0, maxReminders: 0, csvExport: true, purchases: false, khata: false, readOnly: true };
const TRIAL_DAYS = 7;
const TRIAL_HOURS = TRIAL_DAYS * 24;
const PERIOD_DAYS = 30;

function planName(id) { return (PLANS[id] && PLANS[id].name) || LEGACY_NAMES[id] || id; }
function planDays(id) { return (PLANS[id] && PLANS[id].days) || PERIOD_DAYS; }
function planTier(id) { return (PLANS[id] && PLANS[id].tier) || 'pro'; } // legacy paid ids keep full access

// state: 'trial' | 'active' | 'expired'
function limitsFor(state, planId) {
  if (state === 'trial') return TRIAL;
  if (state === 'active') return planTier(planId) === 'basic' ? BASIC : PRO;
  return READ_ONLY;
}

module.exports = { PLANS, PRO, BASIC, TRIAL, READ_ONLY, TRIAL_DAYS, TRIAL_HOURS, PERIOD_DAYS, LEGACY_NAMES, planName, planDays, planTier, limitsFor };
