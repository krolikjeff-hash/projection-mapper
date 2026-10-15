// Sunset time (adapted from the SunCalc algorithm) and the show schedule.
const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, J0 = 0.0009, E = rad * 23.4397;
const toDays = (d) => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
const meanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M) =>
  M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
const transitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

export function sunset(date, lat, lon) {
  const base = new Date(date); base.setHours(12, 0, 0, 0);
  const lw = rad * -lon, phi = rad * lat, d = toDays(base);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = meanAnomaly(ds), L = eclipticLongitude(M);
  const dec = Math.asin(Math.sin(E) * Math.sin(L));
  const w = Math.acos((Math.sin(rad * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  return fromJulian(transitJ(J0 + (w + lw) / (2 * Math.PI) + n, M, L));
}

function atTime(day, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  const t = new Date(day); t.setHours(h || 0, m || 0, 0, 0);
  return t;
}

// Show window that starts on the given day: { start, end } (end may be after midnight).
export function showWindow(sched, day) {
  const start = sched.start.type === 'sunset'
    ? new Date(sunset(day, sched.lat, sched.lon).getTime() + (+sched.start.offset || 0) * 60000)
    : atTime(day, sched.start.time);
  let end = atTime(day, sched.end);
  if (end <= start) end = new Date(end.getTime() + dayMs);
  return { start, end };
}

export function isShowTime(sched, now = new Date()) {
  if (!sched || !sched.enabled) return true;
  for (const back of [0, 1]) {
    const day = new Date(now); day.setDate(day.getDate() - back);
    const w = showWindow(sched, day);
    if (now >= w.start && now < w.end) return true;
  }
  return false;
}
