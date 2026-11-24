/* GPF Journal — cloud save through the Math a Day account (account.mathaday.app)
 * Opt-in: nothing leaves this device until the person signs in with Google AND turns cloud save on.
 * The whole backup (same shape as the JSON backup file) is saved as one copy per account.
 * Each save carries the revision this device last saw; if another device saved in between,
 * the server answers 409 and the person chooses which copy to keep.
 * The app calls: Cloud.init(hooks) once, Cloud.touch() after every local save,
 * Cloud.settingsHtml() / Cloud.bind(sheet) in the settings sheet.                              */
(function () {
  'use strict';
  const ACC = 'https://account.mathaday.app', APP = 'gpf-journal';
  const here = /(^|\.)mathaday\.app$/.test(location.hostname);
  const K = (k) => 'gpfj:cloud:' + k;
  const get = (k, d) => { try { const v = localStorage.getItem(K(k)); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(K(k)) : localStorage.setItem(K(k), JSON.stringify(v)); } catch {} };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (t) => new Date(t).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

  let H = null, me, timer = null, busy = false, applying = false, note = '';

  async function req(path, opt = {}) {
    const r = await fetch(ACC + path, { credentials: 'include', method: opt.method || 'GET', headers: opt.body ? { 'Content-Type': 'application/json' } : {}, body: opt.body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  async function whoami() { try { me = await req('/api/me'); } catch { me = null; } return me; }
  const signIn = () => { location.href = ACC + '/?return=' + encodeURIComponent(location.origin + location.pathname + '?cloud=1' + location.hash); };

  /* ---------- sync ---------- */
  function touch() {
    if (applying || !get('on', false)) return;
    set('dirty', true);
    clearTimeout(timer); timer = setTimeout(() => push(false), 2500);
  }
  async function push(force) {
    if (busy) { clearTimeout(timer); timer = setTimeout(() => push(force), 2000); return; }
    busy = true;
    try {
      const r = await req('/api/data/' + APP, { method: 'PUT', body: JSON.stringify({ base: force ? null : get('rev', 0), data: H.get() }) });
      set('rev', r.rev); set('dirty', false); set('at', r.updated); note = '';
    } catch (e) {
      if (e.status === 409) { busy = false; return conflict(); }
      note = e.status === 401 ? 'หลุดจากบัญชี เข้าสู่ระบบใหม่เพื่อสำรองต่อ' : e.status === 413 ? 'ข้อมูลใหญ่เกินพื้นที่คลาวด์ ใช้ไฟล์สำรองแทน' : 'สำรองไม่สำเร็จ จะลองใหม่เมื่อบันทึกครั้งถัดไป';
      if (e.status === 401) me = null;
    } finally { busy = false; paint(); }
  }
  function apply(r) {
    applying = true;
    try { H.apply(r.data); } finally { applying = false; }
    set('rev', r.rev); set('dirty', false); set('at', r.updated); note = '';
  }
  async function sync() {
    if (!here || !get('on', false) || !(await whoami())) return paint();
    let r; try { r = await req('/api/data/' + APP); } catch { return paint(); }
    const rev = get('rev', 0), dirty = get('dirty', false);
    if (!r.rev) await push(true);                                       // nothing in the cloud yet
    else if (r.rev === rev) { if (dirty) await push(false); }           // cloud unchanged: send my changes, if any
    else if (!H.has()) { apply(r); H.toast('ดึงข้อมูลจากคลาวด์แล้ว'); }  // this device is empty
    else if (rev && !dirty) { apply(r); H.toast('อัปเดตข้อมูลล่าสุดจากเครื่องอื่นแล้ว'); }
    else choose(r);                                                     // both sides have different data
    paint();
  }
  async function conflict() { try { choose(await req('/api/data/' + APP)); } catch { note = 'สำรองไม่สำเร็จ'; paint(); } }
  function choose(r) {
    H.openSheet('ข้อมูลไม่ตรงกัน', `<div class="stack">
      <p style="margin:0">ข้อมูลบนคลาวด์ต่างจากในเครื่องนี้ เลือกว่าจะเก็บชุดไหน อีกชุดจะถูกแทนที่</p>
      <button class="btn block" id="cdUse">ใช้ข้อมูลบนคลาวด์<br><small>บันทึกเมื่อ ${esc(when(r.updated))}</small></button>
      <button class="btn sec block" id="cdKeep">ใช้ข้อมูลในเครื่องนี้<br><small>แล้วสำรองทับบนคลาวด์</small></button>
      <p class="note" style="margin:0">ไม่แน่ใจ? กด “สำรองข้อมูล (JSON)” ในตั้งค่าเก็บไฟล์ไว้ก่อนได้</p></div>`, (b) => {
      b.querySelector('#cdUse').onclick = () => { apply(r); H.closeSheet(); H.toast('ใช้ข้อมูลบนคลาวด์แล้ว'); paint(); };
      b.querySelector('#cdKeep').onclick = async () => { H.closeSheet(); await push(true); H.toast('สำรองข้อมูลในเครื่องนี้ขึ้นคลาวด์แล้ว'); };
    });
  }

  /* ---------- settings card ---------- */
  let box = null;
  function settingsHtml() { return here ? '<div class="card stack" id="cloudBox"><b>สำรองบนคลาวด์ (บัญชี Math a Day)</b><p class="note" style="margin:0">กำลังโหลด…</p></div>' : ''; }
  async function bind(sheet) {
    box = sheet.querySelector('#cloudBox'); if (!box) return;
    if (me === undefined) await whoami();
    paint();
  }
  function paint() {
    if (!box || !box.isConnected) return;
    const on = get('on', false), at = get('at', 0);
    let h = '<b>สำรองบนคลาวด์ (บัญชี Math a Day)</b>';
    if (!me) {
      h += `<p class="note" style="margin:0">เข้าด้วย Google แล้วเปิดสำรอง ข้อมูลพอร์ตจะไม่หายเมื่อเปลี่ยนมือถือ และเปิดดูได้หลายเครื่อง</p>
        <button class="btn sec" data-c="in">เข้าด้วย Google</button>`;
    } else if (!on) {
      h += `<p class="note" style="margin:0">เข้าในชื่อ <b>${esc(me.name)}</b> · ตอนนี้ข้อมูลยังอยู่ในเครื่องนี้เท่านั้น</p>
        <p class="note" style="margin:0">เมื่อเปิด ข้อมูลพอร์ต (รายการจากใบแจ้งยอด รายการที่บันทึกเอง และ NAV) จะถูกส่งผ่าน HTTPS ไปเก็บบนเซิร์ฟเวอร์ Math a Day (Cloudflare) ผูกกับบัญชีของคุณ ปิดหรือลบได้ทุกเมื่อ</p>
        <button class="btn" data-c="on">เปิดสำรองบนคลาวด์</button>`;
    } else {
      h += `<p class="note" style="margin:0">เข้าในชื่อ <b>${esc(me.name)}</b> · <span class="pill ok">เปิดอยู่</span> สำรองอัตโนมัติทุกครั้งที่บันทึก${at ? `<br>สำรองล่าสุด ${esc(when(at))}` : ''}${note ? `<br><span style="color:var(--bad,#d33)">${esc(note)}</span>` : ''}</p>
        <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn sec" data-c="now">สำรองตอนนี้</button><button class="btn ghost" data-c="off">ปิดสำรอง</button><button class="btn danger" data-c="del">ลบข้อมูลบนคลาวด์</button></div>`;
    }
    if (me) h += `<a class="note" href="${ACC}/" target="_blank" rel="noopener">จัดการบัญชี Math a Day</a>`;
    box.innerHTML = h;
    box.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => act(b.dataset.c, b)));
  }
  async function act(c, b) {
    if (c === 'in') return signIn();
    if (c === 'on') { set('on', true); set('rev', 0); set('dirty', false); b.disabled = true; await sync(); H.toast('เปิดสำรองบนคลาวด์แล้ว'); return; }
    if (c === 'now') { b.disabled = true; await push(false); if (!note) H.toast('สำรองขึ้นคลาวด์แล้ว'); return; }
    if (c === 'off') { set('on', false); set('dirty', false); clearTimeout(timer); paint(); H.toast('ปิดสำรองแล้ว ข้อมูลบนคลาวด์ยังอยู่'); return; }
    if (c === 'del') {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'แตะอีกครั้งเพื่อลบ'; return; }
      try { await req('/api/data/' + APP, { method: 'DELETE' }); } catch (e) { return H.toast('ลบไม่สำเร็จ: ' + e.message); }
      set('on', false); set('rev', 0); set('dirty', false); set('at', null); clearTimeout(timer); paint();
      H.toast('ลบข้อมูลบนคลาวด์แล้ว ข้อมูลในเครื่องนี้ยังอยู่');
    }
  }

  function init(hooks) {
    H = hooks;
    if (!here) return;
    const q = new URLSearchParams(location.search);
    if (q.has('cloud')) {                           // back from the account centre: show the cloud card
      q.delete('cloud');
      try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch {}
      whoami().then(() => H.settings());
    }
    sync();
    addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); else if (get('dirty', false) && get('on', false)) push(false); });
  }

  window.Cloud = { init, touch, settingsHtml, bind, get enabled() { return here && get('on', false); } };
})();
