// Guest page: live view of the projection, a prompt box, and where each guest's request is in the queue.
import { Engine } from './engine.js';
import { surfaceOutline } from './geometry.js';
import { watchShow, watchNow, watchQueue, submitPrompt, ensureSignedIn, auth } from './cloud.js';

const $ = (s) => document.querySelector(s);
const view = $('#view'), canvas = $('#gl');
let state = null, now = null, items = [];
try { $('#by').value = localStorage.getItem('pm_by') || ''; } catch { /* private mode */ }

let engine = null;
try { engine = new Engine(canvas, { preview: true, contentLong: 512 }); engine.start(); }
catch { view.textContent = 'Live view needs WebGL; you can still send ideas.'; }

const IDEAS = [
  'a swarm of bats bursting out of a glowing portal',
  'zombie hands reaching up through cracked ground',
  'a giant spider web with a spider spinning it',
  'jack-o-lanterns bouncing to a beat',
  'a witch\'s cauldron bubbling over with green slime',
  'ghosts playing tag',
  'a haunted hopscotch that lights up',
  'aurora of purple and orange flames',
];
for (const idea of IDEAS.sort(() => Math.random() - 0.5).slice(0, 4)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = idea;
  b.onclick = () => { $('#prompt').value = idea; $('#prompt').focus(); };
  $('#ideas').append(b);
}

// Show just the part of the projector image where the surfaces are, as big as the phone allows.
function layoutView() {
  if (!state) return;
  const out = state.output;
  const surfs = state.surfaces.filter((s) => s.enabled);
  const pts = (surfs.length ? surfs : state.surfaces).flatMap((s) => surfaceOutline(s, 8));
  let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
  if (pts.length) {
    x0 = Math.max(0, Math.min(...pts.map((p) => p[0])) - 0.02); x1 = Math.min(1, Math.max(...pts.map((p) => p[0])) + 0.02);
    y0 = Math.max(0, Math.min(...pts.map((p) => p[1])) - 0.02); y1 = Math.min(1, Math.max(...pts.map((p) => p[1])) + 0.02);
  }
  const W = view.clientWidth;
  const boxAspect = ((x1 - x0) * out.width) / ((y1 - y0) * out.height);
  const H = Math.min(W / boxAspect, window.innerHeight * 0.55);
  const scale = Math.min(W / ((x1 - x0) * out.width), H / ((y1 - y0) * out.height));
  view.style.height = Math.round(H) + 'px';
  const cw = out.width * scale, ch = out.height * scale;
  Object.assign(canvas.style, {
    width: cw + 'px', height: ch + 'px',
    left: (W - (x1 - x0) * cw) / 2 - x0 * cw + 'px',
    top: (H - (y1 - y0) * ch) / 2 - y0 * ch + 'px',
  });
}
addEventListener('resize', layoutView);

const STATUS = {
  queued: 'Waiting to brew…',
  generating: 'In the cauldron…',
  testing: 'Almost ready…',
  ready: 'Up next',
  playing: 'ON THE DRIVEWAY NOW!',
  played: 'Played ✓',
  failed: 'Fizzled',
  removed: 'Removed',
};

function li(title, status, cls) {
  const el = document.createElement('li');
  const t = document.createElement('span'); t.className = 't'; t.textContent = title;
  const s = document.createElement('span'); s.className = 's ' + (cls || ''); s.textContent = status;
  el.append(t, s);
  return el;
}

function render() {
  const nowEl = $('#now');
  nowEl.textContent = '';
  const open = state && state.party.enabled;
  if (state && !open) nowEl.textContent = 'Requests are closed right now. Check back soon!';
  else if (now && now.itemId && Date.now() < now.until) {
    const b = document.createElement('b'); b.textContent = now.title;
    nowEl.append('Now showing: ', b, ` · by ${now.by}`);
  } else nowEl.textContent = 'Send an idea and it will appear here!';
  $('#send').disabled = !!state && !open;

  const uid = auth.currentUser?.uid;
  const mine = items.filter((i) => i.uid === uid && i.status !== 'removed').reverse();
  const ml = $('#mine');
  ml.textContent = '';
  $('#mine-card').hidden = !mine.length;
  for (const m of mine) {
    let status = STATUS[m.status] || 'Sent';
    if (m.position) status += ` · #${m.position}`;
    ml.append(li(m.title || `“${m.prompt}”`, status, m.status === 'playing' ? 'on' : m.status === 'failed' ? 'err' : ''));
  }

  const ql = $('#queue');
  ql.textContent = '';
  const upcoming = items.filter((i) => i.position).sort((a, b) => a.position - b.position);
  if (!upcoming.length) ql.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Nothing waiting. Yours could be next!' }));
  for (const i of upcoming.slice(0, 8)) ql.append(li(`${i.title || 'A mystery spell'} · ${i.by}`, STATUS[i.status]));
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim(), by = $('#by').value.trim();
  const msg = $('#msg');
  if (prompt.length < 3) { msg.className = 'msg err'; msg.textContent = 'Describe your animation first.'; return; }
  try { localStorage.setItem('pm_by', by); } catch { /* ignore */ }
  $('#send').disabled = true;
  msg.className = 'msg'; msg.textContent = 'Sending…';
  try {
    await submitPrompt(prompt, by);
    $('#prompt').value = '';
    msg.textContent = 'Got it! Claude is brewing your animation (about a minute), then it joins the line.';
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = /permission/i.test(err.message) ? 'Requests are closed right now.' : 'Something went wrong. Try again?';
    console.error(err);
  } finally {
    $('#send').disabled = false;
    render();
  }
});

const apply = () => { if (state && engine) engine.setState({ ...state, partyNow: now && now.itemId ? now : null }); };
watchShow((s) => { state = s; apply(); layoutView(); render(); });
watchNow((n) => { now = n; apply(); render(); });
watchQueue((q) => { items = q; render(); });
ensureSignedIn().then(render);
setInterval(render, 5000);
