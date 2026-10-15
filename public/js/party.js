// Guest page: live view of the projection, a prompt box, and where each guest's request is in the queue.
import { Engine } from './engine.js';
import { surfaceOutline } from './geometry.js';

const $ = (s) => document.querySelector(s);
const view = $('#view'), canvas = $('#gl');
let state = null, queue = { items: [], avgSeconds: 60 };
let mine = [];
try { mine = JSON.parse(localStorage.getItem('pm_mine') || '[]'); } catch { mine = []; }
try { $('#by').value = localStorage.getItem('pm_by') || ''; } catch { /* private mode */ }
const saveMine = () => { try { localStorage.setItem('pm_mine', JSON.stringify(mine.slice(-20))); } catch { /* ignore */ } };

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
  const now = $('#now');
  now.textContent = '';
  const pn = state && state.partyNow;
  if (state && !state.party.enabled) now.textContent = 'Requests are closed right now. Check back soon!';
  else if (pn && Date.now() < pn.until) {
    const b = document.createElement('b'); b.textContent = pn.title;
    now.append('Now showing: ', b, ` · by ${pn.by}`);
  } else now.textContent = 'Send an idea and it will appear here!';
  $('#send').disabled = !!state && !state.party.enabled;

  const byId = new Map(queue.items.map((i) => [i.id, i]));
  const ml = $('#mine');
  ml.textContent = '';
  const myItems = mine.map((m) => ({ ...m, ...(byId.get(m.id) || {}) })).reverse();
  $('#mine-card').hidden = !myItems.length;
  for (const m of myItems) {
    let status = STATUS[m.status] || 'Sent';
    if (m.status === 'ready' || m.status === 'queued' || m.status === 'generating' || m.status === 'testing') {
      if (m.position) status += ` · #${m.position}`;
    }
    ml.append(li(m.title || `“${m.prompt}”`, status, m.status === 'playing' ? 'on' : m.status === 'failed' ? 'err' : ''));
  }

  const ql = $('#queue');
  ql.textContent = '';
  const upcoming = queue.items.filter((i) => ['ready', 'testing', 'generating', 'queued'].includes(i.status)).sort((a, b) => a.position - b.position);
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
    const r = await fetch('/api/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, by }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    mine.push({ id: j.id, prompt });
    saveMine();
    $('#prompt').value = '';
    msg.textContent = `Got it! Claude is brewing your animation (about ${Math.max(30, queue.avgSeconds)} s), then it joins the line.`;
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    $('#send').disabled = false;
    render();
  }
});

const es = new EventSource('/api/events');
es.addEventListener('state', (e) => {
  state = JSON.parse(e.data).state;
  if (engine) engine.setState(state);
  layoutView();
  render();
});
es.addEventListener('queue', (e) => { queue = JSON.parse(e.data); render(); });
setInterval(render, 5000);
