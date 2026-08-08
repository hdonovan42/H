// Earnings-night arming check (P0.2 regression). Replicates isEarningsNight()'s
// date handling frozen at 17:00 ET on EARNINGS_DATE (aftermarket window) and
// verifies the viewer's timezone cannot shift the calendar day. Run it from a
// UK/EU/Asia TZ — the old parse (dayjs(d).tz(EST)) failed for anyone at/east of
// UTC; the fixed parse (dayjs.tz(d, EST)) must arm everywhere:
//   TZ=Europe/London node scripts/test-earnings-night-tz.mjs
// Rerun after updating EARNINGS_DATE each quarter to confirm live mode will arm.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { EST, EARNINGS_DATE, EARNINGS_TIME } from '../src/utils/config.js';

dayjs.extend(utc);
dayjs.extend(timezone);

if (EARNINGS_TIME !== 'aftermarket') {
  console.log(`EARNINGS_TIME is '${EARNINGS_TIME}' — this check freezes at 17:00 ET and only covers aftermarket.`);
}

const RealDate = Date;
const frozen = new RealDate(`${EARNINGS_DATE}T17:00:00-04:00`).getTime();
global.Date = class extends RealDate {
  constructor(...a) { if (a.length) { super(...a); } else { super(frozen); } }
  static now() { return frozen; }
};

const now = dayjs().tz(EST);
const oldParse = dayjs(EARNINGS_DATE).tz(EST);
const newParse = dayjs.tz(EARNINGS_DATE, EST);

const armed = (day) => now.isSame(day, 'day') && now.hour() >= 16 && now.hour() < 23;

console.log(`viewer TZ=${process.env.TZ || '(system)'}, now=${now.format('YYYY-MM-DD HH:mm')} ET`);
console.log(`old parse → earningsDay=${oldParse.format('YYYY-MM-DD')} ET, armed=${armed(oldParse)}`);
console.log(`new parse → earningsDay=${newParse.format('YYYY-MM-DD')} ET, armed=${armed(newParse)}`);

global.Date = RealDate;
if (armed(newParse)) {
  console.log('PASS  earnings night arms with the EST-parsed date');
} else {
  console.log('FAIL  earnings night did not arm');
  process.exit(1);
}
