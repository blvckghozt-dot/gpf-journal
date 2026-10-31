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
    verify: 'manual',       // 'manual' = เจ้าของตรวจสลิปและกดอนุมัติเอง (ฟรี) · 'auto' = ตรวจผ่าน EasySlip อัตโนมัติ
    provisionalDays: 3,     // สิทธิ์ชั่วคราวระหว่างรออนุมัติ (ต้องตรงกับใน schema.sql)
    warnDays: 7,            // เตือนก่อนหมดอายุกี่วัน
    plans: {
      month: { amount: 49, days: 30, label: 'รายเดือน', sub: '30 วัน' },   // ราคาต้องตรงกับ plan_info ใน schema.sql
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
  const rpc = async (fn, args = {}) => { const s = await session(); if (!s) throw Object.assign(new Error('not_logged_in'), { status: 401 }); return api('/rest/v1/rpc/' + fn, { method: 'POST', token: s.access_token, body: args }); };
  let REQ = null, PENDING = 0; // คำขอต่ออายุล่าสุดของผู้ใช้ · จำนวนสลิปรอตรวจ (แอดมิน)
  async function loadMember(s) {
    for (let i = 0; i < 3; i++) {
      const rows = await api(`/rest/v1/members?select=plan,expires_at,email,is_admin&id=eq.${s.user.id}`, { token: s.access_token });
      if (rows[0]) {
        ls.set(MKEY, { ...rows[0], uid: s.user.id, at: Date.now() });
        if (CFG.verify === 'manual') {
          try { REQ = (await api(`/rest/v1/slip_requests?select=id,plan,amount,status,note,created_at,decided_at,provisional_until&user_id=eq.${s.user.id}&order=created_at.desc&limit=1`, { token: s.access_token }))[0] || null; } catch { REQ = null; }
          if (rows[0].is_admin) { try { PENDING = +(await api('/rest/v1/rpc/admin_pending_count', { method: 'POST', token: s.access_token, body: {} })) || 0; } catch { PENDING = 0; } }
        }
        return rows[0];
      }
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
  const ERR = { already_pending: 'มีสลิปรอผู้ดูแลตรวจอยู่แล้ว', image_too_large: 'รูปใหญ่เกินไป ลองแคปหน้าจอสลิปใหม่', no_image: 'ไม่พบรูปสลิป', not_logged_in: 'กรุณาเข้าสู่ระบบใหม่', bad_plan: 'ไม่พบแพ็กเกจ', not_admin: 'ไม่มีสิทธิ์ผู้ดูแล', not_pending: 'รายการนี้ตรวจไปแล้ว', not_found: 'ไม่พบอีเมลนี้', bad_days: 'จำนวนวันไม่ถูกต้อง' };
  const errText = (e) => ERR[e?.body?.message] || ERR[e?.message] || e?.body?.error || e?.message || 'เกิดข้อผิดพลาด';
  const quotes = {};
  async function screenRenew(opts = {}) {
    ensureRoot(); const m = M; const left = daysLeft(m); const expired = left <= 0;
    const p = CFG.plans[planSel]; const manual = CFG.verify === 'manual';
    const pending = manual && REQ?.status === 'pending' ? REQ : null;
    const rejected = manual && REQ?.status === 'rejected' && Date.now() - Date.parse(REQ.decided_at) < 30 * 864e5 ? REQ : null;
    let amount = p.amount;
    if (manual && !pending) { try { amount = quotes[planSel] ??= +(await rpc('payment_quote', { p_plan: planSel })); } catch (e) { amount = null; } }
    const cents = amount != null ? Math.round((amount - p.amount) * 100) : 0;
    root.innerHTML = `<div class="gin">${head(m?.email || '')}
      <div class="card stack"><h3 style="margin:0">${pending ? 'รอผู้ดูแลตรวจสลิป' : expired ? (m?.plan === 'trial' ? 'หมดช่วงทดลองใช้แล้ว' : 'สมาชิกหมดอายุแล้ว') : 'ต่ออายุสมาชิก'}</h3>
        <p class="note" style="margin:0">${pending ? `ส่งสลิป${h(CFG.plans[pending.plan]?.label || '')} ยอด ${baht(+pending.amount)} บาท เมื่อ ${fmtDate(pending.created_at)} ผู้ดูแลจะตรวจและอนุมัติโดยเร็ว ${expired ? 'ระหว่างนี้ยังเข้าใช้แอปไม่ได้' : `ระหว่างนี้ใช้แอปได้ถึง ${fmtDate(m.expires_at)}`}` : m ? (expired ? `หมดอายุเมื่อ ${fmtDate(m.expires_at)} ต่ออายุเพื่อใช้งานต่อ ข้อมูลพอร์ตในเครื่องยังอยู่ครบ` : `ใช้ได้ถึง ${fmtDate(m.expires_at)} (อีก ${Math.ceil(left)} วัน) ต่ออายุตอนนี้ วันจะบวกต่อจากวันหมดอายุเดิม`) : ''}</p>
        ${rejected && !pending ? `<div class="banner" style="background:var(--down-soft)">สลิปที่ส่งเมื่อ ${fmtDate(rejected.created_at)} ไม่ผ่านการตรวจ${rejected.note ? `: ${h(rejected.note)}` : ''}</div>` : ''}
        ${pending ? '' : `<div class="plans">${Object.entries(CFG.plans).map(([k, v]) => `<button class="plan" data-plan="${k}" aria-pressed="${k === planSel}"><span class="note">${h(v.label)}</span><b>${baht(v.amount)} บาท</b><span class="note">${h(v.sub)}</span></button>`).join('')}</div>`}</div>
      ${pending ? '' : `${manual && amount != null ? `<div class="card stack" style="border:1.5px solid var(--warn)"><b style="font-size:17px">⚠️ ยอดที่ต้องโอน ${amount.toFixed(2)} บาท</b><p class="note" style="margin:0">ยอดโอน<b>ต้องมีเศษ ${cents} สตางค์</b>ตามนี้ทุกสตางค์ ระบบสุ่มเศษให้แต่ละรายการ เพื่อให้ตรวจสอบสลิปได้ง่ายและต่ออายุให้คุณได้เร็ว ถ้าสแกน QR ด้านล่าง ยอดนี้จะขึ้นให้อัตโนมัติ ไม่ต้องพิมพ์เอง</p></div>` : ''}
      <div class="card stack"><b>1. สแกนจ่ายด้วยแอปธนาคาร</b>${CFG.promptpay && amount != null ? `<div class="qr" id="gQr"></div><div style="text-align:center"><b style="font-size:20px">${amount.toFixed(2)} บาท</b><div class="note">พร้อมเพย์ ${h(CFG.payeeName || '')}</div></div>` : `<p class="err" style="margin:0">${CFG.promptpay ? 'โหลดยอดที่ต้องโอนไม่สำเร็จ ลองเปิดหน้านี้ใหม่' : 'ผู้ดูแลยังไม่ได้ตั้งค่าเลขพร้อมเพย์'}</p>`}
        <p class="note" style="margin:0">จ่ายจากมือถือเครื่องนี้: กดค้างที่ QR เพื่อบันทึกรูป แล้วเปิดแอปธนาคาร เลือกสแกนจากรูปในเครื่อง</p></div>
      <div class="card stack"><b>2. ส่งสลิป</b><p class="note" style="margin:0">${manual ? `เลือกรูปสลิปที่ได้หลังโอน ผู้ดูแลจะตรวจและอนุมัติ${rejected ? '' : ` ระหว่างรอ${expired || left < CFG.provisionalDays ? `ใช้แอปได้ทันที ${CFG.provisionalDays} วัน` : 'ใช้แอปได้ตามปกติ'}`}` : 'เลือกรูปสลิปที่ได้หลังโอน ระบบจะตรวจกับธนาคารและต่ออายุให้ทันที'}</p>
        <label class="btn block" for="gSlip" id="gSlipBtn">เลือกรูปสลิป</label><input type="file" id="gSlip" accept="image/*" hidden>
        <div id="gMsg" class="err"></div></div>`}
      <div class="row" style="gap:8px;justify-content:center;flex-wrap:wrap">${!expired ? '<button class="btn ghost" id="gClose">กลับไปใช้แอป</button>' : ''}${pending ? '<button class="btn ghost" id="gRefresh">ตรวจสถานะอีกครั้ง</button>' : ''}<button class="btn ghost" id="gOut">ออกจากระบบ</button></div>
      ${CFG.contact ? `<p class="note" style="text-align:center;margin:0">มีปัญหาเรื่องการชำระเงิน ติดต่อ ${h(CFG.contact)} พร้อมแนบสลิป</p>` : ''}</div>`;
    if (!pending && CFG.promptpay && amount != null) { try { root.querySelector('#gQr').innerHTML = await qrSvg(promptpayPayload(CFG.promptpay, amount)); } catch (e) { root.querySelector('#gQr').textContent = 'สร้าง QR ไม่สำเร็จ'; } }
    root.querySelectorAll('[data-plan]').forEach((b) => (b.onclick = () => { planSel = b.dataset.plan; screenRenew(opts); }));
    root.querySelector('#gOut').onclick = logout;
    const c = root.querySelector('#gClose'); if (c) c.onclick = closeGate;
    const rf = root.querySelector('#gRefresh'); if (rf) rf.onclick = () => start();
    const sl = root.querySelector('#gSlip'); if (sl) sl.onchange = (e) => e.target.files[0] && sendSlip(e.target.files[0]);
  }
  async function shrink(file) { // ย่อรูปให้เล็กลงก่อนส่ง
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return (await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); })).split(',')[1];
    const k = Math.min(1, 1100 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.82).split(',')[1];
  }
  async function sendSlip(file) {
    if (busy) return; busy = true; const msg = root.querySelector('#gMsg'), btn = root.querySelector('#gSlipBtn');
    msg.className = 'note'; msg.textContent = 'กำลังตรวจสลิป…'; btn.style.pointerEvents = 'none'; btn.style.opacity = '.6';
    try {
      const s = await session(); if (!s) { busy = false; return screenLogin('กรุณาเข้าสู่ระบบอีกครั้ง'); }
      if (CFG.verify === 'manual') {
        const r = await rpc('submit_slip', { p_plan: planSel, p_image: await shrink(file) });
        for (const k in quotes) delete quotes[k];
        M = await loadMember(s); const ok = daysLeft(M) > 0;
        root.innerHTML = `<div class="gin">${head(M.email || '')}<div class="card stack" style="text-align:center"><div style="font-size:40px">✓</div><h3 style="margin:0">ส่งสลิปแล้ว</h3><p class="note" style="margin:0">ยอด ${(+r.amount).toFixed(2)} บาท · ผู้ดูแลจะตรวจและอนุมัติโดยเร็ว${r.provisional_until ? ` ระหว่างนี้ใช้แอปได้ถึง ${fmtDate(r.provisional_until)}` : ok ? '' : ' ระหว่างนี้ยังเข้าใช้แอปไม่ได้ จะใช้ได้ทันทีเมื่ออนุมัติ'}</p>${ok ? '<button class="btn block" id="gDone">เข้าใช้แอป</button>' : '<button class="btn ghost" id="gOut2">ออกจากระบบ</button>'}</div></div>`;
        const d = root.querySelector('#gDone'); if (d) d.onclick = () => { closeGate(); bar(); if (resolveGate) { resolveGate(true); resolveGate = null; } };
        const o = root.querySelector('#gOut2'); if (o) o.onclick = logout;
        busy = false; return;
      }
      const r = await api('/functions/v1/verify-slip', { method: 'POST', token: s.access_token, body: { plan: planSel, image: await shrink(file) } });
      M = await loadMember(s);
      root.innerHTML = `<div class="gin">${head(M.email || '')}<div class="card stack" style="text-align:center"><div style="font-size:40px">✓</div><h3 style="margin:0">ต่ออายุเรียบร้อย</h3><p class="note" style="margin:0">รับชำระ ${baht(r.amount)} บาท · ใช้ได้ถึง ${fmtDate(M.expires_at)}</p><button class="btn block" id="gDone">เข้าใช้แอป</button></div></div>`;
      root.querySelector('#gDone').onclick = () => { closeGate(); bar(); if (resolveGate) { resolveGate(true); resolveGate = null; } };
    } catch (e) { msg.className = 'err'; msg.textContent = errText(e); btn.style.pointerEvents = ''; btn.style.opacity = ''; root.querySelector('#gSlip').value = ''; }
    busy = false;
  }
  /* ---------- หน้าผู้ดูแล: ตรวจและอนุมัติสลิป ---------- */
  let adminTab = 'pending';
  async function screenAdmin() {
    ensureRoot();
    root.innerHTML = `<div class="gin">${head('ผู้ดูแล · ตรวจสลิป')}<div class="card"><p class="note" style="margin:0">กำลังโหลด…</p></div></div>`;
    let rows = []; let err = '';
    try { rows = await rpc('admin_requests', { p_status: adminTab === 'pending' ? 'pending' : 'all', p_limit: adminTab === 'pending' ? 50 : 60 }); } catch (e) { err = errText(e); }
    if (adminTab === 'pending') PENDING = rows.length;
    const fmtT = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
    const ST = { pending: ['รอตรวจ', 'warn'], approved: ['อนุมัติ', 'ok'], rejected: ['ปฏิเสธ', 'bad'] };
    root.innerHTML = `<div class="gin">${head('ผู้ดูแล · ตรวจสลิป')}
      <div class="seg"><button data-at="pending" aria-pressed="${adminTab === 'pending'}">รอตรวจ${adminTab === 'pending' ? ` (${rows.length})` : PENDING ? ` (${PENDING})` : ''}</button><button data-at="all" aria-pressed="${adminTab === 'all'}">ประวัติ</button><button data-at="extend" aria-pressed="${adminTab === 'extend'}">ต่ออายุเอง</button></div>
      ${err ? `<div class="banner" style="background:var(--down-soft)">${h(err)}</div>` : ''}
      ${adminTab === 'extend' ? `<div class="card stack"><b>ต่ออายุให้สมาชิกเอง</b><p class="note" style="margin:0">ใช้เมื่อได้รับเงินทางอื่น หรือให้ใช้ฟรี ใส่จำนวนวันติดลบเพื่อลดวันได้</p>
          <input class="inp" id="axEmail" type="email" placeholder="อีเมลสมาชิก"><input class="inp num" id="axDays" type="number" value="30"><button class="btn block" id="axGo">ต่ออายุ</button><div id="axMsg" class="note"></div></div>`
        : adminTab === 'pending' ? (rows.length ? rows.map((r) => `<div class="card stack" data-rid="${r.id}">
          <div class="row" style="justify-content:space-between;gap:8px;align-items:flex-start"><div><b>${h(r.email || '')}</b><div class="note">${h(CFG.plans[r.plan]?.label || r.plan)} · ส่งเมื่อ ${fmtT(r.created_at)}${r.provisional_until ? ' · ได้สิทธิ์ชั่วคราวแล้ว' : ''}</div></div><b style="font-size:20px;white-space:nowrap">${(+r.amount).toFixed(2)}</b></div>
          <p class="note" style="margin:0">เปิดแอปธนาคารของคุณ หาเงินเข้า <b>${(+r.amount).toFixed(2)} บาท</b> ถ้ามีจริง กดอนุมัติ</p>
          ${r.image ? `<img src="data:image/jpeg;base64,${r.image}" alt="สลิป" style="width:100%;max-height:60vh;object-fit:contain;background:#fff;border-radius:10px;border:1px solid var(--line);cursor:zoom-in" onclick="this.style.maxHeight=this.style.maxHeight==='none'?'60vh':'none'">` : '<p class="note">ไม่มีรูป</p>'}
          <input class="inp" data-note placeholder="หมายเหตุถ้าปฏิเสธ เช่น ยอดไม่ตรง (ผู้ใช้จะเห็น)">
          <div class="row" style="gap:8px"><button class="btn" style="flex:1" data-dec="1">อนุมัติ</button><button class="btn danger" style="flex:1" data-dec="0">ปฏิเสธ</button></div><div class="note" data-msg></div></div>`).join('')
          : '<div class="card"><p class="note" style="margin:0;text-align:center">ไม่มีสลิปรอตรวจ</p></div>')
        : `<div class="card">${rows.map((r) => `<div class="li"><div class="body"><div class="t" style="font-size:14px">${h(r.email || '')} <span class="pill ${ST[r.status][1]}">${ST[r.status][0]}</span></div><div class="s">${h(CFG.plans[r.plan]?.label || r.plan)} · ${(+r.amount).toFixed(2)} บาท · ส่ง ${fmtT(r.created_at)}${r.decided_at ? ` · ตรวจ ${fmtT(r.decided_at)}` : ''}${r.note ? ` · ${h(r.note)}` : ''}</div></div></div>`).join('') || '<p class="note" style="margin:0">ยังไม่มีรายการ</p>'}</div>`}
      <button class="btn ghost" id="aBack">กลับไปใช้แอป</button></div>`;
    root.querySelectorAll('[data-at]').forEach((b) => (b.onclick = () => { adminTab = b.dataset.at; screenAdmin(); }));
    root.querySelector('#aBack').onclick = () => { closeGate(); bar(); };
    root.querySelectorAll('[data-rid]').forEach((card) => card.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = async () => {
      const ap = b.dataset.dec === '1'; const note = card.querySelector('[data-note]').value.trim() || null; const msg = card.querySelector('[data-msg]');
      if (!ap && b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'แตะอีกครั้งเพื่อปฏิเสธ'; return; }
      card.querySelectorAll('button').forEach((x) => (x.disabled = true)); msg.textContent = 'กำลังบันทึก…';
      try { const r = await rpc('admin_decide', { p_id: +card.dataset.rid, p_approve: ap, p_note: note }); PENDING = Math.max(0, PENDING - 1);
        card.innerHTML = `<div class="row" style="justify-content:space-between"><b>${h(card.querySelector('b').textContent)}</b><span class="pill ${ap ? 'ok' : 'bad'}">${ap ? 'อนุมัติแล้ว' : 'ปฏิเสธแล้ว'}</span></div>${ap && r.expires_at ? `<p class="note" style="margin:0">ใช้ได้ถึง ${fmtDate(r.expires_at)}</p>` : ''}`;
      } catch (e) { msg.textContent = errText(e); card.querySelectorAll('button').forEach((x) => (x.disabled = false)); }
    })));
    const ax = root.querySelector('#axGo'); if (ax) ax.onclick = async () => {
      const em = root.querySelector('#axEmail').value, d = +root.querySelector('#axDays').value, out = root.querySelector('#axMsg');
      try { const e = await rpc('admin_extend', { p_email: em, p_days: d }); out.textContent = `เรียบร้อย ใช้ได้ถึง ${fmtDate(e)}`; } catch (e) { out.textContent = errText(e); }
    };
  }
  async function logout() { const s = ls.get(KEY); ls.set(KEY, null); ls.set(MKEY, null); M = null; REQ = null; PENDING = 0; for (const k in quotes) delete quotes[k]; try { if (s?.access_token) await api('/auth/v1/logout', { method: 'POST', token: s.access_token }); } catch {} screenLogin(); }

  function bar() { // แถบด้านบนเนื้อหา: แอดมินเห็นสลิปรอตรวจ · ผู้ใช้เห็นวันที่เหลือ/สถานะรออนุมัติ
    let el = document.getElementById('memberBar'); const left = daysLeft(M);
    const admin = M?.is_admin && PENDING > 0; const pend = REQ?.status === 'pending';
    if (!M || (!admin && (M.plan === 'owner' || ((left > CFG.warnDays || left <= 0) && !pend)))) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'memberBar'; document.getElementById('main')?.prepend(el); }
    const [txt, btn, bg] = admin ? [`มีสลิปรอตรวจ ${PENDING} รายการ`, 'ตรวจสลิป', 'var(--accent-soft)'] : pend ? [`ส่งสลิปแล้ว รอผู้ดูแลอนุมัติ · ใช้ได้ถึง ${fmtDate(M.expires_at)}`, 'ดูสถานะ', 'var(--accent-soft)'] : [`${M.plan === 'trial' ? 'ทดลองใช้' : 'สมาชิก'}เหลืออีก ${Math.ceil(left)} วัน`, 'ต่ออายุ', 'var(--warn-soft)'];
    el.innerHTML = `<div class="banner" style="background:${bg};display:flex;gap:8px;align-items:center;justify-content:space-between"><span>${txt}</span><button class="btn" style="padding:6px 12px;white-space:nowrap" id="memberRenew">${btn}</button></div>`;
    el.querySelector('#memberRenew').onclick = () => (admin ? screenAdmin() : screenRenew());
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
    admin: () => screenAdmin(),
    logout,
    settingsHtml() {
      if (!enabled) return '';
      const left = daysLeft(M);
      return `<div class="card stack"><b>สมาชิก</b><p class="note" style="margin:0">${M ? `${h(M.email || '')} · ${M.plan === 'owner' ? 'เจ้าของแอป' : M.plan === 'trial' ? 'ทดลองใช้' : CFG.plans[M.plan]?.label || h(M.plan)} · ใช้ได้ถึง ${fmtDate(M.expires_at)}${left > 0 && M.plan !== 'owner' ? ` (อีก ${Math.ceil(left)} วัน)` : ''}` : 'ยังไม่ได้เข้าสู่ระบบ'}</p>
        <div class="row" style="gap:8px;flex-wrap:wrap">${M?.is_admin && CFG.verify === 'manual' ? `<button class="btn" id="mAdmin">ตรวจสลิป${PENDING ? ` (${PENDING})` : ''}</button>` : ''}${M?.plan !== 'owner' ? '<button class="btn sec" id="mRenew">ต่ออายุ</button>' : ''}<button class="btn ghost" id="mOut">ออกจากระบบ</button></div></div>`;
    },
    bindSettings(close) { const a = document.getElementById('mAdmin'); if (a) a.onclick = () => { close?.(); adminTab = 'pending'; screenAdmin(); }; const r = document.getElementById('mRenew'); if (r) r.onclick = () => { close?.(); screenRenew(); }; const o = document.getElementById('mOut'); if (o) o.onclick = () => { close?.(); logout(); }; },
  };
  // เช็คซ้ำเมื่อกลับมาเปิดแอป (เช่นเปิดค้างไว้ข้ามวันหมดอายุ)
  if (enabled) document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && M && daysLeft(M) <= 0 && (!root || root.hidden)) screenRenew(); });
})();
