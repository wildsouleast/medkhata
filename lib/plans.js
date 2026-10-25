// Monthly plans. Prices are in rupees; Razorpay works in paise.
const PLANS = {
  basic: {
    id: 'basic', name: 'Basic', price: 299,
    maxMedicines: 500, maxReminders: 50, csvExport: false,
    features: ['Up to 500 medicines', 'Expiry alerts at 30, 60 and 90 days', 'Low-stock alerts', 'Up to 50 refill reminders', 'Works on any phone'],
  },
  pro: {
    id: 'pro', name: 'Pro', price: 599,
    maxMedicines: null, maxReminders: 300, csvExport: true,
    features: ['Unlimited medicines', 'Everything in Basic', 'Up to 300 refill reminders', 'Download stock as CSV (Excel)', 'Supplier tracking'],
  },
  clinic: {
    id: 'clinic', name: 'Clinic+', price: 999,
    maxMedicines: null, maxReminders: null, csvExport: true,
    features: ['Everything in Pro', 'Unlimited refill reminders', 'Download reminders as CSV', 'Priority support'],
  },
};
// During the free trial the store gets every feature.
const TRIAL = { id: 'trial', name: 'Free trial', price: 0, maxMedicines: null, maxReminders: null, csvExport: true };
const TRIAL_HOURS = 48;
const PERIOD_DAYS = 30;

function limitsFor(plan) {
  return PLANS[plan] || TRIAL;
}

module.exports = { PLANS, TRIAL, TRIAL_HOURS, PERIOD_DAYS, limitsFor };
