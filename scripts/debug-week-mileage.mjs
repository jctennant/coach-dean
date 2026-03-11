const activities = [
  {id:0, distance_meters:11265.4, start_date:'2026-03-11 13:17:02+00', activity_type:'Run'},
  {id:1, distance_meters:8055, start_date:'2026-03-10 22:35:20+00', activity_type:'Run'},
  {id:2, distance_meters:4880, start_date:'2026-03-09 22:57:17+00', activity_type:'Run'},
  {id:3, distance_meters:17081, start_date:'2026-03-08 19:44:56+00', activity_type:'Run'},
  {id:4, distance_meters:6147, start_date:'2026-03-06 23:27:31+00', activity_type:'Run'},
  {id:5, distance_meters:9656.1, start_date:'2026-03-06 15:48:57+00', activity_type:'Run'},
];

const RUN_TYPES = new Set(['Run','TrailRun','VirtualRun']);

function localWeekMonday(date, timezone) {
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date);
  const [yr, mo, dy] = localDate.split('-').map(Number);
  const d = new Date(Date.UTC(yr, mo - 1, dy));
  const dow = d.getUTCDay();
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(Date.UTC(yr, mo - 1, dy - daysFromMon));
  return monday.toISOString().slice(0, 10);
}

// Also test: does new Date() parse Postgres timestamp format correctly?
const testDate = new Date('2026-03-09 22:57:17+00');
console.log('Postgres timestamp parse test:', testDate.toISOString(), '(should be 2026-03-09T22:57:17.000Z)\n');

for (const tz of ['America/Denver', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC']) {
  const now = new Date('2026-03-11T14:20:00Z');
  const thisMonday = localWeekMonday(now, tz);
  const thisWeek = activities.filter(a => {
    if (!RUN_TYPES.has(a.activity_type)) return false;
    const activityDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(a.start_date));
    return activityDate >= thisMonday;
  });
  const miles = thisWeek.reduce((s, a) => s + a.distance_meters / 1609.34, 0);
  const ids = thisWeek.map(a => {
    const d = new Intl.DateTimeFormat('en-CA', {timeZone: tz}).format(new Date(a.start_date));
    return `idx${a.id}(${d})`;
  }).join(', ');
  console.log(`${tz}: Monday=${thisMonday}, sessions=${thisWeek.length}, miles=${miles.toFixed(2)}`);
  console.log(`  -> ${ids}`);
}
