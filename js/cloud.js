// Firebase backend shared by every page: sign-in, the show's state, its live "now playing", the guest queue,
// generated scenes, compile tests, layouts and media. Each projector is a "show" (?show=<id>, default "main").
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithPopup, GoogleAuthProvider, signOut,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, onSnapshot, query, where,
  runTransaction, serverTimestamp, getDocs,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { getStorage, ref, uploadBytesResumable, getDownloadURL, listAll } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js';
import { normalizeState, defaultState } from './model.js';
import { setSceneLoader } from './engine.js';

const app = initializeApp({
  apiKey: 'AIzaSyDeIgah4YY5mYGN2ATaIfiZ6Pb9f0Etf7E',
  authDomain: 'projection-mapper-jk.firebaseapp.com',
  projectId: 'projection-mapper-jk',
  storageBucket: 'projection-mapper-jk.firebasestorage.app',
  messagingSenderId: '229816179827',
  appId: '1:229816179827:web:739df5b12a8457af0ade06',
});
export const auth = getAuth(app);
export const db = getFirestore(app);
const storage = getStorage(app);

// Keep in step with HOSTS in firestore.rules / storage.rules.
export const HOSTS = ['krolikjeff@gmail.com'];

export const showId = (new URLSearchParams(location.search).get('show') || 'main').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'main';
const showRef = (id = showId) => doc(db, 'shows', id);
const nowRef = (id = showId) => doc(db, 'shows', id, 'live', 'now');
const queueCol = (id = showId) => collection(db, 'shows', id, 'queue');

// Link to another page of the app for this show (works under the GitHub Pages sub-path).
export const pageUrl = (page, id = showId) => new URL(`${page}${id === 'main' ? '' : `?show=${id}`}`, location.href.replace(/[^/]*$/, '')).href;

// Generated (guest) scenes live in Firestore, not in /scenes.
setSceneLoader(async (id) => {
  const snap = await getDoc(doc(db, 'scenes', id));
  if (!snap.exists()) throw new Error('No scene ' + id);
  const d = snap.data();
  return { id, name: d.name, kind: 'shader', params: d.params || [], fragment: d.fragment };
});

// ---------- auth ----------
export const isHostUser = (u) => !!(u && !u.isAnonymous && HOSTS.includes((u.email || '').toLowerCase()));

export function whenAuthed() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => { if (u) { off(); resolve(u); } });
  });
}

// Guests and players: an anonymous account unless someone is already signed in.
export async function ensureSignedIn() {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

export const signInHost = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOutUser = () => signOut(auth);
export const onUser = (cb) => onAuthStateChanged(auth, cb);

// ---------- show state ----------
export function watchShow(cb, id = showId) {
  return onSnapshot(showRef(id), (snap) => {
    let s;
    try { s = snap.exists() && snap.data().stateJson ? JSON.parse(snap.data().stateJson) : null; } catch { s = null; }
    cb(normalizeState(s || defaultState()), snap.exists() ? snap.data() : null);
  });
}

// Corners and meshes are nested arrays, which Firestore can't store, so the state is kept as JSON text.
let saveTimer = null, pending = null;
export function saveShow(state, id = showId) {
  pending = { state, id };
  if (saveTimer) return;
  const flush = async () => {
    const p = pending; pending = null;
    const s = { ...p.state, partyNow: undefined };
    await setDoc(showRef(p.id), {
      name: s.name || p.id, stateJson: JSON.stringify(s), partyOpen: !!s.party?.enabled,
      updatedAt: serverTimestamp(), updatedBy: auth.currentUser?.email || null,
    }, { merge: true });
  };
  flush().catch((e) => console.error('Save failed', e));
  saveTimer = setTimeout(function again() {
    if (pending) { flush().catch((e) => console.error('Save failed', e)); saveTimer = setTimeout(again, 120); }
    else saveTimer = null;
  }, 120);
}

export function watchShows(cb) {
  return onSnapshot(collection(db, 'shows'), (snap) => cb(snap.docs.map((d) => ({ id: d.id, name: d.data().name || d.id })).sort((a, b) => a.id.localeCompare(b.id))));
}

// ---------- now playing + queue ----------
export const watchNow = (cb, id = showId) => onSnapshot(nowRef(id), (snap) => cb(snap.exists() ? snap.data() : null));

export function watchQueue(cb, id = showId) {
  return onSnapshot(queueCol(id), (snap) => {
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: d.data().createdAt?.toMillis?.() || 0 }))
      .sort((a, b) => a.createdAt - b.createdAt);
    const waiting = items.filter((i) => ['queued', 'generating', 'testing', 'ready'].includes(i.status));
    for (const i of items) i.position = waiting.indexOf(i) >= 0 ? waiting.indexOf(i) + 1 : null;
    cb(items);
  });
}

export async function submitPrompt(prompt, by) {
  const u = await ensureSignedIn();
  return addDoc(queueCol(), { prompt: prompt.slice(0, 300), by: (by || 'A guest').slice(0, 24), uid: u.uid, status: 'queued', createdAt: serverTimestamp() });
}

export const queueAction = {
  remove: (itemId) => updateDoc(doc(queueCol(), itemId), { status: 'removed' }),
  retry: (itemId) => updateDoc(doc(queueCol(), itemId), { status: 'queued', error: null, retry: Date.now() }),
  play: (itemId) => playItem(itemId),
  skip: () => updateDoc(nowRef(), { until: Date.now() }),
};

// ---------- party rotation ("driver"), run by the host's setup page and a host-signed-in player ----------
async function playItem(itemId, state) {
  const seconds = (state?.party?.seconds) || 45;
  await runTransaction(db, async (tx) => {
    const itemRef = doc(queueCol(), itemId);
    const [item, now] = [await tx.get(itemRef), await tx.get(nowRef())];
    if (!item.exists() || !item.data().sceneId) return;
    const t = Date.now();
    if (now.exists() && now.data().itemId && now.data().itemId !== itemId) tx.update(doc(queueCol(), now.data().itemId), { status: 'played' });
    tx.update(itemRef, { status: 'playing', playedAt: t, plays: (item.data().plays || 0) + 1 });
    tx.set(nowRef(), { itemId, sceneId: item.data().sceneId, title: item.data().title || '', by: item.data().by || '', startedAt: t, until: t + seconds * 1000 });
  });
}

export function startDriver(getState) {
  let items = [], now = null, busy = false;
  const offQ = watchQueue((q) => { items = q; });
  const offN = watchNow((n) => { now = n; });
  const timer = setInterval(async () => {
    const s = getState();
    if (busy || !s || !isHostUser(auth.currentUser)) return;
    const t = Date.now();
    if (!s.party.enabled) { if (now && now.itemId) { busy = true; try { await setDoc(nowRef(), { itemId: null, until: 0 }); } finally { busy = false; } } return; }
    if (now && now.itemId && t < now.until) return;
    let next = items.find((i) => i.status === 'ready');
    if (!next && s.party.replay) next = items.filter((i) => i.status === 'played' && i.sceneId).sort((a, b) => (a.playedAt || 0) - (b.playedAt || 0))[0];
    busy = true;
    try {
      if (next) await playItem(next.id, s);
      else if (now && now.itemId) {
        await updateDoc(doc(queueCol(), now.itemId), { status: 'played' }).catch(() => {});
        await setDoc(nowRef(), { itemId: null, until: 0 });
      }
    } catch (e) { console.warn('Driver', e); }
    finally { busy = false; }
  }, 1500);
  return () => { clearInterval(timer); offQ(); offN(); };
}

// ---------- compile tests: the Cloud Function asks a real GPU whether a generated shader compiles ----------
export async function startCompileTester(engine) {
  await ensureSignedIn();
  return onSnapshot(query(collection(db, 'compileTests'), where('status', '==', 'pending')), (snap) => {
    for (const d of snap.docs) {
      const { fragment, params } = d.data();
      const r = engine.testCompile(fragment, params || []);
      updateDoc(d.ref, { status: 'done', ok: r.ok, log: r.log.slice(0, 2000), testedAt: Date.now() }).catch(() => { /* someone else answered */ });
    }
  });
}

// ---------- layouts ----------
export async function listLayouts() { return (await getDocs(collection(db, 'layouts'))).docs.map((d) => d.id).sort(); }
export const saveLayout = (name, data) => setDoc(doc(db, 'layouts', name), { json: JSON.stringify(data), savedAt: serverTimestamp() });
export async function loadLayout(name) { const s = await getDoc(doc(db, 'layouts', name)); return s.exists() ? JSON.parse(s.data().json) : null; }
export const deleteLayout = (name) => deleteDoc(doc(db, 'layouts', name));

// ---------- media (Firebase Storage) ----------
export async function listMedia() {
  const res = await listAll(ref(storage, 'media'));
  return Promise.all(res.items.map(async (r) => ({ name: r.name, url: await getDownloadURL(r) })));
}
export function uploadMedia(file, onProgress) {
  const r = ref(storage, 'media/' + file.name.replace(/[^A-Za-z0-9 _.()-]/g, '_'));
  const task = uploadBytesResumable(r, file, { contentType: file.type });
  return new Promise((resolve, reject) => {
    task.on('state_changed', (s) => onProgress && onProgress(s.bytesTransferred / s.totalBytes), reject, async () => resolve(await getDownloadURL(r)));
  });
}
