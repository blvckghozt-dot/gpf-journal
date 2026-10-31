/* GPF Journal: ระบบสมาชิก (ล็อกอิน + ต่ออายุด้วยสลิปพร้อมเพย์)
 * ปิดอยู่จนกว่าจะใส่ supabaseUrl และ supabaseAnonKey ด้านล่าง ดูวิธีตั้งค่าใน SETUP-MEMBERSHIP.md
 * เป็นการล็อกแบบเบา: เช็คสิทธิ์ในเบราว์เซอร์ ข้อมูลพอร์ตยังอยู่ในเครื่องผู้ใช้เหมือนเดิม
 */
(function () {
  const CFG = {
    supabaseUrl: '',        // เช่น 'https://abcdefgh.supabase.co'
    supabaseAnonKey: '',    // Project Settings → API → anon public key
    promptpay: '',          // เบอร์มือถือหรือเลขบัตรประชาชนที่ผูกพร้อมเพย์ เช่น '0812345678'
    payeeName: '',          // ชื่อบัญชีที่ผู้ใช้จะเห็นตอนโอน เช่น 'นาย สมชาย ใจดี'
    google: true,           // แสดงปุ่มเข้าสู่ระบบด้วย Google (ต้องเปิด Google provider ใน Supabase)
    contact: '',            // ช่องทางติดต่อเมื่อมีปัญหา เช่น 'LINE: @gpfjournal'
    warnDays: 7,            // เตือนก่อนหมดอายุกี่วัน
    plans: {
      month: { amount: 49, days: 30, label: 'รายเดือน', sub: '30 วัน' },
      year: { amount: 490, days: 365, label: 'รายปี', sub: '365 วัน · ประหยัด 98 บาท' },
    },
  };
  const enabled = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const KEY = 'gpfj:auth', MKEY = 'gpfj:member';
  const ls = { get: (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' });
  const baht = (n) => n.toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  /* ---------- PromptPay QR payload (EMVCo) ---------- */
  function crc16(s) { let c = 0xffff; for (let i = 0; i < s.length; i++) { c ^= s.charCodeAt(i) << 8; for (let j = 0; j < 8; j++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); }
  function promptpayPayload(target, amount) {
    const f = (id, v) => id + String(v.length).padStart(2, '0') + v;
    const t = String(target).replace(/\D/g, '');
    const type = t.length >= 15 ? '03' : t.length >= 13 ? '02' : '01';
    const acc = t.length >= 13 ? t : ('0000000000000' + t.replace(/^0/, '66')).slice(-13);
    const data = f('00', '01') + f('01', amount ? '12' : '11') + f('29', f('00', 'A000000677010111') + f(type, acc)) + f('58', 'TH') + f('53', '764') + (amount ? f('54', amount.toFixed(2)) : '') + '6304';
    return data + crc16(data);
  }

  /* ---------- Supabase (เรียก API ตรง ไม่ต้องใช้ไลบรารี) ---------- */
  const api = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const r = await fetch(CFG.supabaseUrl.replace(/\/$/, '') + path, { method, headers: { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || j.msg || j.error_description || j.message || 'HTTP ' + r.status); e.status = r.status; e.body = j; throw e; }
    return j;
  };
  const saveSession = (j) => { const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (+j.expires_in || 3600), user: j.user ? { id: j.user.id, email: j.user.email } : null }; ls.set(KEY, s); return s; };
  async function session() {
    let s = ls.get(KEY); if (!s?.refresh_token) return null;
    if (s.expires_at - 60 < Date.now() / 1000) {
      try { s = saveSession(await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } })); }
      catch (e) { if (e.status === 400 || e.status === 401) { ls.set(KEY, null); return null; } throw e; }
    }
    if (!s.user) { const u = await api('/auth/v1/user', { token: s.access_token }); s.user = { id: u.id, email: u.email }; ls.set(KEY, s); }
    return s;
  }
  async function fromRedirect() { // กลับมาจาก Google: #access_token=...
    const hs = new URLSearchParams(location.hash.slice(1));
    const err = hs.get('error_description'); const at = hs.get('access_token');
    if (!at && !err) return null;
    history.replaceState(null, '', location.pathname + location.search);
    if (err) throw new Error(err);
    const u = await api('/auth/v1/user', { token: at });
    return saveSession({ access_token: at, refresh_token: hs.get('refresh_token'), expires_in: hs.get('expires_in'), expires_at: +hs.get('expires_at') || undefined, user: u });
  }
  async function loadMember(s) {
    for (let i = 0; i < 3; i++) {
      const rows = await api(`/rest/v1/members?select=plan,expires_at,email&id=eq.${s.user.id}`, { token: s.access_token });
      if (rows[0]) { ls.set(MKEY, { ...rows[0], uid: s.user.id, at: Date.now() }); return rows[0]; }
      await new Promise((r) => setTimeout(r, 800)); // แถวสมาชิกถูกสร้างโดย trigger หลังสมัคร อาจช้าเล็กน้อย
    }
    throw new Error('ไม่พบข้อมูลสมาชิก');
  }
  const daysLeft = (m) => (m ? (Date.parse(m.expires_at) - Date.now()) / 864e5 : -1);

  /* ---------- UI ---------- */
  const CSS = `#gate{position:fixed;inset:0;z-index:60;background:var(--bg);overflow-y:auto;padding:max(24px,env(safe-area-inset-top)) 16px 32px}
  #gate .gin{max-width:440px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
  #gate .logo{display:flex;align-items:center;gap:10px;margin:8px 0 4px}#gate .logo .mark{width:40px;height:40px;border-radius:11px;background:var(--accent);display:grid;place-items:center;color:var(--accent-ink);font-weight:700}
  #gate .qr{background:#fff;border-radius:14px;padding:10px;width:min(260px,70vw);margin:0 auto}#gate .qr svg{display:block;width:100%;height:auto}
  #gate .plans{display:grid;grid-template-columns:1fr 1fr;gap:8px}#gate .plan{border:1.5px solid var(--line);border-radius:12px;padding:10px;background:var(--surface);text-align:left;color:inherit}#gate .plan[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  #gate .plan b{display:block;font-size:20px}#gate .err{color:var(--down);font-size:14px}#gate .okmsg{color:var(--up);font-size:14px}
  #memberBar{margin:10px 0 0}`;
  let root, M = null, S0 = null, resolveGate = null, planSel = 'year', busy = false;
  const ensureRoot = () => { if (!document.getElementById('memberCss')) { const st = document.createElement('style'); st.id = 'memberCss'; st.textContent = CSS; document.head.appendChild(st); } root = document.getElementById('gate') || Object.assign(document.createElement('div'), { id: 'gate' }); if (!root.isConnected) document.body.appendChild(root); root.hidden = false; document.documentElement.style.overflow = 'hidden'; };
  const closeGate = () => { if (root) root.hidden = true; document.documentElement.style.overflow = ''; };
  const head = (sub) => `<div class="logo"><div class="mark">G</div><div><b style="font-size:18px">GPF Journal</b><div class="note">${h(sub)}</div></div></div>`;

  function screenLogin(msg = '', email = ls.get('gpfj:lastEmail') || '') {
    ensureRoot();
    root.innerHTML = `<div class="gin">${head('สมุดบัญชี กบข. ส่วนตัว')}
      <div class="card stack"><h3 style="margin:0">เข้าสู่ระบบ</h3><p class="note" style="margin:0">ผู้ใช้ใหม่ทดลองใช้ฟรี 14 วัน หลังจากนั้น ${baht(CFG.plans.month.amount)} บาท/เดือน หรือ ${baht(CFG.plans.year.amount)} บาท/ปี ข้อมูลพอร์ตยังอยู่ในเครื่องของคุณเท่านั้น</p>
        <div class="field"><label for="gEmail">อีเมล</label><input class="inp" id="gEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${h(email)}"></div>
        <button class="btn block" id="gSend">ส่งรหัสเข้าอีเมล</button>
        ${CFG.google ? '<button class="btn sec block" id="gGoogle">เข้าสู่ระบบด้วย Google</button>' : ''}
        <div class="err" id="gMsg">${h(msg)}</div></div>
      ${CFG.contact ? `<p class="note" style="text-align:center">มีปัญหาติดต่อ ${h(CFG.contact)}</p>` : ''}</div>`;
    root.querySelector('#gSend').onclick = async () => {
      const em = root.querySelector('#gEmail').value.trim(); if (!/^\S+@\S+\.\S+$/.test(em)) return (root.querySelector('#gMsg').textContent = 'กรอกอีเมลให้ถูกต้อง');
      const b = root.querySelector('#gSend'); b.disabled = true; b.textContent = 'กำลังส่ง…';
      try { await api('/auth/v1/otp', { method: 'POST', body: { email: em, create_user: true } }); ls.set('gpfj:lastEmail', em); screenCode(em); }
      catch (e) { b.disabled = false; b.textContent = 'ส่งรหัสเข้าอีเมล'; root.querySelector('#gMsg').textContent = e.status === 429 ? 'ขอรหัสถี่เกินไป รอสักครู่แล้วลองใหม่' : 'ส่งรหัสไม่สำเร็จ: ' + e.message; }
    };
    const g = root.querySelector('#gGoogle'); if (g) g.onclick = () => { location.href = `${CFG.supabaseUrl.replace(/\/$/, '')}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(location.origin + location.pathname)}`; };
  }
  function screenCode(email) {
    root.innerHTML = `<div class="gin">${head('สมุดบัญชี กบข. ส่วนตัว')}
      <div class="card stack"><h3 style="margin:0">กรอกรหัสจากอีเมล</h3><p class="note" style="margin:0">ส่งรหัสไปที่ <b>${h(email)}</b> แล้ว (ถ้าไม่เห็น ดูในโฟลเดอร์สแปม)</p>
        <input class="inp mono" id="gCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="รหัส 6 หลัก" style="font-size:22px;letter-spacing:4px;text-align:center">
        <button class="btn block" id="gVerify">ยืนยัน</button><button class="btn ghost" id="gBack">เปลี่ยนอีเมล / ส่งใหม่</button><div class="err" id="gMsg"></div></div></div>`;
    const go = async () => {
      const code = root.querySelector('#gCode').value.replace(/\D/g, ''); if (code.length < 6) return (root.querySelector('#gMsg').textContent = 'กรอกรหัสให้ครบ');
      const b = root.querySelector('#gVerify'); b.disabled = true; b.textContent = 'กำลังตรวจ…';
      try { S0 = saveSession(await api('/auth/v1/verify', { method: 'POST', body: { type: 'email', email, token: code } })); await afterLogin(); }
      catch (e) { b.disabled = false; b.textContent = 'ยืนยัน'; root.querySelector('#gMsg').textContent = e.status === 403 || e.status === 400 ? 'รหัสไม่ถูกต้องหรือหมดอายุ' : 'ยืนยันไม่สำเร็จ: ' + e.message; }
    };
    root.querySelector('#gVerify').onclick = go; root.querySelector('#gCode').onkeydown = (e) => e.key === 'Enter' && go();
    root.querySelector('#gBack').onclick = () => screenLogin('', email); root.querySelector('#gCode').focus();
  }
  function screenError(msg) {
    ensureRoot();
    root.innerHTML = `<div class="gin">${head('สมุดบัญชี กบข. ส่วนตัว')}<div class="card stack"><h3 style="margin:0">เชื่อมต่อไม่ได้</h3><p class="note" style="margin:0">${h(msg)}</p><button class="btn block" id="gRetry">ลองใหม่</button><button class="btn ghost" id="gOut">ออกจากระบบ</button></div></div>`;
    root.querySelector('#gRetry').onclick = () => start(); root.querySelector('#gOut').onclick = logout;
  }
  async function qrSvg(payload) { if (!window.qrcode) await loadScript('vendor/qrcode.js'); const q = window.qrcode(0, 'M'); q.addData(payload); q.make(); return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }
  async function screenRenew(opts = {}) {
    ensureRoot(); const m = M; const left = daysLeft(m); const expired = left <= 0;
    const p = CFG.plans[planSel];
    root.innerHTML = `<div class="gin">${head(m?.email || '')}
      <div class="card stack"><h3 style="margin:0">${expired ? (m?.plan === 'trial' ? 'หมดช่วงทดลองใช้แล้ว' : 'สมาชิกหมดอายุแล้ว') : 'ต่ออายุสมาชิก'}</h3>
        <p class="note" style="margin:0">${m ? (expired ? `หมดอายุเมื่อ ${fmtDate(m.expires_at)} ต่ออายุเพื่อใช้งานต่อ ข้อมูลพอร์ตในเครื่องยังอยู่ครบ` : `ใช้ได้ถึง ${fmtDate(m.expires_at)} (อีก ${Math.ceil(left)} วัน) ต่ออายุตอนนี้ วันจะบวกต่อจากวันหมดอายุเดิม`) : ''}</p>
        <div class="plans">${Object.entries(CFG.plans).map(([k, v]) => `<button class="plan" data-plan="${k}" aria-pressed="${k === planSel}"><span class="note">${h(v.label)}</span><b>${baht(v.amount)} บาท</b><span class="note">${h(v.sub)}</span></button>`).join('')}</div></div>
      <div class="card stack"><b>1. สแกนจ่ายด้วยแอปธนาคาร</b>${CFG.promptpay ? `<div class="qr" id="gQr"></div><div style="text-align:center"><b style="font-size:20px">${baht(p.amount)} บาท</b><div class="note">พร้อมเพย์ ${h(CFG.payeeName || '')}</div></div>` : '<p class="err" style="margin:0">ผู้ดูแลยังไม่ได้ตั้งค่าเลขพร้อมเพย์</p>'}
        <p class="note" style="margin:0">จ่ายจากมือถือเครื่องนี้: กดค้างที่ QR เพื่อบันทึกรูป แล้วเปิดแอปธนาคาร เลือกสแกนจากรูปในเครื่อง</p></div>
      <div class="card stack"><b>2. ส่งสลิป</b><p class="note" style="margin:0">เลือกรูปสลิปที่ได้หลังโอน ระบบจะตรวจกับธนาคารและต่ออายุให้ทันที</p>
        <label class="btn block" for="gSlip" id="gSlipBtn">เลือกรูปสลิป</label><input type="file" id="gSlip" accept="image/*" hidden>
        <div id="gMsg" class="err"></div></div>
      <div class="row" style="gap:8px;justify-content:center;flex-wrap:wrap">${!expired ? '<button class="btn ghost" id="gClose">กลับไปใช้แอป</button>' : ''}<button class="btn ghost" id="gOut">ออกจากระบบ</button></div>
      ${CFG.contact ? `<p class="note" style="text-align:center;margin:0">โอนแล้วแต่ต่ออายุไม่ได้ ติดต่อ ${h(CFG.contact)} พร้อมแนบสลิป</p>` : ''}</div>`;
    if (CFG.promptpay) { try { root.querySelector('#gQr').innerHTML = await qrSvg(promptpayPayload(CFG.promptpay, p.amount)); } catch (e) { root.querySelector('#gQr').textContent = 'สร้าง QR ไม่สำเร็จ'; } }
    root.querySelectorAll('[data-plan]').forEach((b) => (b.onclick = () => { planSel = b.dataset.plan; screenRenew(opts); }));
    root.querySelector('#gOut').onclick = logout;
    const c = root.querySelector('#gClose'); if (c) c.onclick = closeGate;
    root.querySelector('#gSlip').onchange = (e) => e.target.files[0] && sendSlip(e.target.files[0]);
  }
  async function shrink(file) { // ย่อรูปให้เล็กลงก่อนส่ง
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return (await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); })).split(',')[1];
    const k = Math.min(1, 1400 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }
  async function sendSlip(file) {
    if (busy) return; busy = true; const msg = root.querySelector('#gMsg'), btn = root.querySelector('#gSlipBtn');
    msg.className = 'note'; msg.textContent = 'กำลังตรวจสลิป…'; btn.style.pointerEvents = 'none'; btn.style.opacity = '.6';
    try {
      const s = await session(); if (!s) { busy = false; return screenLogin('กรุณาเข้าสู่ระบบอีกครั้ง'); }
      const r = await api('/functions/v1/verify-slip', { method: 'POST', token: s.access_token, body: { plan: planSel, image: await shrink(file) } });
      M = await loadMember(s);
      root.innerHTML = `<div class="gin">${head(M.email || '')}<div class="card stack" style="text-align:center"><div style="font-size:40px">✓</div><h3 style="margin:0">ต่ออายุเรียบร้อย</h3><p class="note" style="margin:0">รับชำระ ${baht(r.amount)} บาท · ใช้ได้ถึง ${fmtDate(M.expires_at)}</p><button class="btn block" id="gDone">เข้าใช้แอป</button></div></div>`;
      root.querySelector('#gDone').onclick = () => { closeGate(); bar(); if (resolveGate) { resolveGate(true); resolveGate = null; } };
    } catch (e) { msg.className = 'err'; msg.textContent = e.body?.error || e.message || 'ตรวจสลิปไม่สำเร็จ'; btn.style.pointerEvents = ''; btn.style.opacity = ''; root.querySelector('#gSlip').value = ''; }
    busy = false;
  }
  async function logout() { const s = ls.get(KEY); ls.set(KEY, null); ls.set(MKEY, null); M = null; try { if (s?.access_token) await api('/auth/v1/logout', { method: 'POST', token: s.access_token }); } catch {} screenLogin(); }

  function bar() { // แถบเตือนใกล้หมดอายุ ด้านบนเนื้อหา
    let el = document.getElementById('memberBar'); const left = daysLeft(M);
    if (!M || left > CFG.warnDays || left <= 0 || M.plan === 'owner') { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'memberBar'; document.getElementById('main')?.prepend(el); }
    el.innerHTML = `<div class="banner" style="background:var(--warn-soft);display:flex;gap:8px;align-items:center;justify-content:space-between"><span>${M.plan === 'trial' ? 'ทดลองใช้' : 'สมาชิก'}เหลืออีก ${Math.ceil(left)} วัน</span><button class="btn" style="padding:6px 12px" id="memberRenew">ต่ออายุ</button></div>`;
    el.querySelector('#memberRenew').onclick = () => screenRenew();
  }
  async function afterLogin() {
    try { M = await loadMember(S0); } catch (e) { return screenError('โหลดข้อมูลสมาชิกไม่สำเร็จ: ' + e.message); }
    if (daysLeft(M) <= 0) return screenRenew();
    closeGate(); bar(); if (resolveGate) { resolveGate(true); resolveGate = null; }
  }
  async function start() {
    try { S0 = (await fromRedirect()) || (await session()); }
    catch (e) { if (!navigator.onLine && ls.get(MKEY)) S0 = ls.get(KEY); else return screenLogin(String(e.message || e)); }
    if (!S0) return screenLogin();
    try { M = await loadMember(S0); }
    catch (e) { const c = ls.get(MKEY); if (c && c.uid === S0.user?.id && daysLeft(c) > 0) { M = c; } else return screenError(navigator.onLine ? e.message : 'ไม่ได้ต่ออินเทอร์เน็ต ต่อเน็ตแล้วลองใหม่'); }
    if (daysLeft(M) <= 0) return screenRenew();
    closeGate(); bar(); if (resolveGate) { resolveGate(true); resolveGate = null; }
  }

  window.Member = {
    enabled, cfg: CFG, promptpayPayload,
    gate() { if (!enabled) return Promise.resolve(true); return new Promise((res) => { resolveGate = res; start(); }); },
    info: () => M,
    renew: () => screenRenew(),
    logout,
    settingsHtml() {
      if (!enabled) return '';
      const left = daysLeft(M);
      return `<div class="card stack"><b>สมาชิก</b><p class="note" style="margin:0">${M ? `${h(M.email || '')} · ${M.plan === 'owner' ? 'เจ้าของแอป' : M.plan === 'trial' ? 'ทดลองใช้' : CFG.plans[M.plan]?.label || h(M.plan)} · ใช้ได้ถึง ${fmtDate(M.expires_at)}${left > 0 && M.plan !== 'owner' ? ` (อีก ${Math.ceil(left)} วัน)` : ''}` : 'ยังไม่ได้เข้าสู่ระบบ'}</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">${M?.plan !== 'owner' ? '<button class="btn sec" id="mRenew">ต่ออายุ</button>' : ''}<button class="btn ghost" id="mOut">ออกจากระบบ</button></div></div>`;
    },
    bindSettings(close) { const r = document.getElementById('mRenew'); if (r) r.onclick = () => { close?.(); screenRenew(); }; const o = document.getElementById('mOut'); if (o) o.onclick = () => { close?.(); logout(); }; },
  };
  // เช็คซ้ำเมื่อกลับมาเปิดแอป (เช่นเปิดค้างไว้ข้ามวันหมดอายุ)
  if (enabled) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && M && daysLeft(M) <= 0 && (!root || root.hidden)) screenRenew(); });
})();
