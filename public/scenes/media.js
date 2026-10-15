// An image or video file from the media library (uploaded from the control page, e.g. AtmosFX loops).
// Videos loop, muted.
export default {
  id: 'media',
  name: 'Image / video file',
  kind: 'canvas',
  params: [
    { key: 'src', label: 'File', type: 'media', default: '' },
    { key: 'fit', label: 'Fit', type: 'select', options: ['cover', 'contain', 'stretch'], default: 'cover' },
  ],
  create: () => ({ el: null, src: null }),
  draw(st, ctx, w, h, t, dt, p) {
    if (p.src !== st.src) {
      if (st.el && st.el.pause) { st.el.pause(); st.el.removeAttribute('src'); st.el.load(); }
      st.el = null;
      st.src = p.src;
      if (p.src) {
        const url = '/media/' + encodeURIComponent(p.src);
        if (/\.(mp4|m4v|webm|mov)$/i.test(p.src)) {
          const v = document.createElement('video');
          v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true; v.src = url;
          v.play().catch(() => {});
          st.el = v;
        } else {
          const img = new Image();
          img.src = url;
          st.el = img;
        }
      }
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const el = st.el;
    if (!el) return;
    const ew = el.videoWidth || el.naturalWidth, eh = el.videoHeight || el.naturalHeight;
    if (!ew || !eh) return;
    if (el.paused) el.play().catch(() => {});
    let dw = w, dh = h;
    if (p.fit !== 'stretch') {
      const k = p.fit === 'cover' ? Math.max(w / ew, h / eh) : Math.min(w / ew, h / eh);
      dw = ew * k; dh = eh * k;
    }
    ctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
  },
  dispose(st) {
    if (st.el && st.el.pause) { st.el.pause(); st.el.removeAttribute('src'); st.el.load(); }
  },
};
