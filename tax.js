/* คำนวณภาษีเงินได้บุคคลธรรมดา 40(1) แบบประมาณการ — ฟังก์ชันล้วน ไม่แตะหน้าจอ (ทดสอบด้วย scripts/test-tax.js)
   p = {inc, wage, wht, gpf, v: {key: จำนวนเงินหรือจำนวนคน}} */
(function (root) {
  function bracketTax(net, br) { let t = 0, lo = 0; for (const [hi, r] of br) { if (net > lo) t += (Math.min(net, hi) - lo) * r; lo = hi; } return Math.round(t * 100) / 100; }
  function marginal(net, br) { for (const [hi, r] of br) if (net <= hi) return r; return br[br.length - 1][1]; }

  function taxCalc(p, R) {
    const inc = Math.max(0, +p.inc || 0), wage = Math.max(0, +(p.wage ?? inc) || 0), ctx = {inc, wage};
    const lines = []; const add = (k, label, asked, used, why, g) => { lines.push({k, label, asked, used, why, g}); return used; };
    const exp = add('expense', 'หักค่าใช้จ่าย 50% (ไม่เกิน 100,000)', inc * R.expense.rate, Math.min(inc * R.expense.rate, R.expense.max), inc * R.expense.rate > R.expense.max ? 'ชนเพดาน 100,000' : '50% ของเงินได้', 'base');
    let ded = add('personal', 'ส่วนตัว', 60000, 60000, '', 'family');
    const v = p.v || {}; const val = k => Math.max(0, +v[k] || 0);
    const retire = [];
    for (const it of R.items) {
      if (it.donate) continue;
      if (it.type === 'gpf') { const a = Math.max(0, +p.gpf || 0), c = it.cap(ctx); retire.push({it, asked: a, capped: Math.min(a, c), why: a > c ? `ไม่เกิน 30% ของเงินเดือน (${Math.round(c).toLocaleString()})` : ''}); continue; }
      const raw = val(it.k); if (!raw) continue;
      if (it.type === 'yesno') { ded += add(it.k, it.label, it.amount, it.amount, '', it.g); continue; }
      if (it.type === 'count') { const n = Math.min(raw, it.max || 99); ded += add(it.k, it.label, raw * it.per, n * it.per, `${n} × ${it.per.toLocaleString()}${raw > n ? ` (สูงสุด ${it.max} คน)` : ''}`, it.g); continue; }
      let c = it.cap(ctx);
      if (it.sharesWith) { const prev = lines.find(l => l.k === it.sharesWith); if (prev) c = Math.max(0, c - prev.used); } // Thai ESGX ใช้วงเงินร่วมกับ Thai ESG
      if (it.g === 'retire') { retire.push({it, asked: raw, capped: Math.min(raw, c), why: raw > c ? `เพดาน ${Math.round(c).toLocaleString()}` : ''}); continue; }
      if (it.k === 'life' || it.k === 'health') continue; // คิดรวมด้านล่าง
      ded += add(it.k, it.label, raw, Math.min(raw, c), raw > c ? (it.sharesWith ? `รวมกับ Thai ESG ไม่เกิน ${Math.round(it.cap(ctx)).toLocaleString()}` : `เพดาน ${Math.round(c).toLocaleString()}`) : '', it.g);
    }
    // ประกันชีวิต + สุขภาพตนเอง รวมไม่เกิน 100,000
    { const life = Math.min(val('life'), 100000), hl = Math.min(val('health'), 25000);
      if (life) ded += add('life', 'เบี้ยประกันชีวิต (ตัวเอง)', val('life'), life, val('life') > 100000 ? 'เพดาน 100,000' : '', 'ins');
      if (hl) { const room = Math.max(0, 100000 - life), u = Math.min(hl, room); ded += add('health', 'เบี้ยประกันสุขภาพ (ตัวเอง)', val('health'), u, val('health') > 25000 ? 'เพดาน 25,000' + (u < hl ? ' และรวมประกันชีวิตไม่เกิน 100,000' : '') : (u < hl ? 'รวมกับประกันชีวิตไม่เกิน 100,000' : ''), 'ins'); } }
    // กลุ่มเกษียณ: เพดานรายตัวก่อน แล้วตัดยอดรวม 500,000 (เรียงตามลำดับที่กรอก)
    let room = R.retireCap; let retUsed = 0;
    for (const r of retire) { const u = Math.min(r.capped, room); room -= u; retUsed += u; if (r.asked > 0) ded += add(r.it.k, r.it.label, r.asked, u, [r.why, u < r.capped ? 'ชนเพดานรวมกลุ่มเกษียณ 500,000' : ''].filter(Boolean).join(' · '), 'retire'); }
    const afterDed = Math.max(0, inc - exp - ded);
    // บริจาค
    const eduAsk = val('donEdu'), genAsk = val('donGen');
    const eduU = Math.min(eduAsk * 2, afterDed * 0.10); if (eduAsk) add('donEdu', 'บริจาคเพื่อการศึกษา/กีฬา/สังคม/รพ.รัฐ (2 เท่า)', eduAsk * 2, eduU, eduAsk * 2 > afterDed * 0.10 ? 'ไม่เกิน 10% ของเงินได้หลังหักค่าลดหย่อน' : `2 × ${eduAsk.toLocaleString()}`, 'donate');
    const after2 = afterDed - eduU; const genU = Math.min(genAsk, after2 * 0.10); if (genAsk) add('donGen', 'บริจาคทั่วไป', genAsk, genU, genAsk > after2 * 0.10 ? 'ไม่เกิน 10% ของเงินได้ที่เหลือ' : '', 'donate');
    const net = Math.max(0, after2 - genU);
    const tax = bracketTax(net, R.brackets); const wht = Math.max(0, +p.wht || 0);
    const espAsk = val('esg') + val('esgx'); const esgCap = Math.min(inc * 0.30, 300000);
    return {inc, exp, ded, afterDed, net, tax, wht, diff: wht - tax, rate: net > 150000 ? marginal(net, R.brackets) : 0, lines,
      retUsed, retRoom: Math.max(0, R.retireCap - retUsed), esgRoom: Math.max(0, esgCap - Math.min(espAsk, esgCap)),
      saveIf: x => Math.round(tax - bracketTax(Math.max(0, net - x), R.brackets))};
  }
  root.taxCalc = taxCalc; root.bracketTax = bracketTax;
  if (typeof module !== 'undefined') module.exports = {taxCalc, bracketTax};
})(typeof window !== 'undefined' ? window : globalThis);
