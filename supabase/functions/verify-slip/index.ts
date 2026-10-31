// Supabase Edge Function: ตรวจสลิปพร้อมเพย์แล้วต่ออายุสมาชิก
// ตั้งค่า secrets: EASYSLIP_KEY, RECEIVER_NAMES, RECEIVER_ACCOUNTS (ไม่บังคับ), PRICE_MONTH, PRICE_YEAR, MAX_SLIP_AGE_DAYS
import { createClient } from 'npm:@supabase/supabase-js@2';
import { normalize, validate, newExpiry, type Plan } from './check.ts';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const list = (k: string) => env(k).split(',').map(s => s.trim()).filter(Boolean);
const PLANS: Record<string, Plan> = {
  month: { amount: Number(env('PRICE_MONTH', '49')), days: 30 },
  year: { amount: Number(env('PRICE_YEAR', '490')), days: 365 },
};
const CORS = { 'Access-Control-Allow-Origin': env('APP_ORIGIN', '*'), 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await admin.auth.getUser(jwt);
  if (ue || !u?.user) return reply(401, { error: 'กรุณาเข้าสู่ระบบใหม่' });
  const user = u.user;

  let body: any; try { body = await req.json(); } catch { return reply(400, { error: 'ข้อมูลไม่ถูกต้อง' }); }
  const plan = PLANS[body?.plan]; if (!plan) return reply(400, { error: 'ไม่พบแพ็กเกจ' });
  if (!body.image && !body.payload) return reply(400, { error: 'ไม่พบรูปสลิป' });

  // ส่งสลิปให้ EasySlip ตรวจกับธนาคาร
  const key = env('EASYSLIP_KEY'); if (!key) return reply(500, { error: 'ระบบตรวจสลิปยังไม่ได้ตั้งค่า' });
  const base = 'https://developer.easyslip.com/api/v1/verify';
  let es: any;
  try {
    const r = body.payload
      ? await fetch(`${base}?payload=${encodeURIComponent(body.payload)}`, { headers: { Authorization: `Bearer ${key}` } })
      : await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ image: body.image }) });
    es = await r.json().catch(() => ({}));
    if (!r.ok && !es?.data) {
      const m = String(es?.message || '');
      return reply(400, { error: m === 'invalid_image' || m === 'qrcode_not_found' ? 'อ่าน QR ในสลิปไม่ได้ ลองใช้รูปสลิปตัวเต็มที่ชัดขึ้น' : m === 'slip_not_found' ? 'ไม่พบรายการนี้ในระบบธนาคาร' : m === 'quota_exceeded' ? 'ระบบตรวจสลิปเต็มโควตา กรุณาแจ้งผู้ดูแล' : `ตรวจสลิปไม่สำเร็จ (${m || r.status})` });
    }
  } catch (e) { return reply(502, { error: 'ติดต่อระบบตรวจสลิปไม่ได้ ลองใหม่อีกครั้ง' }); }

  const slip = normalize(es);
  const why = validate(slip, plan, { names: list('RECEIVER_NAMES'), accounts: list('RECEIVER_ACCOUNTS'), maxAgeDays: Number(env('MAX_SLIP_AGE_DAYS', '3')) });
  if (why) return reply(400, { error: why });

  // บันทึกสลิปก่อน (trans_ref unique กันใช้ซ้ำ) แล้วค่อยต่ออายุ
  const { data: pay, error: pe } = await admin.from('payments').insert({ user_id: user.id, trans_ref: slip!.ref, amount: slip!.amount, plan: body.plan, days: plan.days, slip_date: slip!.date?.toISOString() ?? null, receiver: slip!.receiverName }).select('id').single();
  if (pe) return reply(400, { error: pe.code === '23505' ? 'สลิปนี้ถูกใช้ต่ออายุไปแล้ว' : 'บันทึกการชำระเงินไม่สำเร็จ' });

  const { data: mem } = await admin.from('members').select('expires_at').eq('id', user.id).maybeSingle();
  const exp = newExpiry(mem?.expires_at ? new Date(mem.expires_at) : null, plan.days);
  const { error: me } = mem
    ? await admin.from('members').update({ plan: body.plan, expires_at: exp.toISOString() }).eq('id', user.id)
    : await admin.from('members').insert({ id: user.id, email: user.email, plan: body.plan, expires_at: exp.toISOString() });
  if (me) return reply(500, { error: 'ต่ออายุไม่สำเร็จ กรุณาแจ้งผู้ดูแล (ชำระเงินแล้ว)' });
  await admin.from('payments').update({ new_expires_at: exp.toISOString() }).eq('id', pay.id);
  return reply(200, { ok: true, plan: body.plan, expires_at: exp.toISOString(), amount: slip!.amount });
});
