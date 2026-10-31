// ตรรกะตรวจสลิป แยกไว้เพื่อทดสอบได้ (ไม่มีการเรียกเครือข่าย)

export type Plan = { amount: number; days: number };
export type Config = { names: string[]; accounts: string[]; maxAgeDays: number };
export type Slip = { ref: string; amount: number; date: Date | null; receiverName: string; receiverAccount: string };

// แปลงผลจาก EasySlip ให้อยู่ในรูปเดียว (เอกสารแต่ละที่ใช้ชื่อฟิลด์ต่างกัน)
export function normalize(res: any): Slip | null {
  const d = res?.data;
  if (!d) return null;
  const amt = typeof d.amount === 'object' && d.amount !== null ? d.amount.amount : d.amount;
  const rec = d.receiver || {};
  const acc = rec.account || {};
  const name = [acc.name?.th, acc.name?.en, rec.displayName, rec.name].filter(Boolean).join(' / ');
  const account = [acc.bank?.account, acc.proxy?.account, rec.bank?.account, rec.proxy?.account].filter(Boolean).join(' / ');
  const ds = d.date || d.transactionDate || d.transDate;
  const date = ds ? new Date(ds) : null;
  const ref = String(d.transRef || d.reference || d.ref || '').trim();
  return { ref, amount: Number(amt), date: date && !isNaN(+date) ? date : null, receiverName: name, receiverAccount: account };
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const digits = (s: string) => s.replace(/\D/g, '');

// คืนข้อความภาษาไทยถ้าไม่ผ่าน, null ถ้าผ่าน
export function validate(slip: Slip | null, plan: Plan, cfg: Config, now = new Date()): string | null {
  if (!slip) return 'อ่านข้อมูลสลิปไม่ได้';
  if (!cfg.names.length && !cfg.accounts.length) return 'ระบบยังไม่ได้ตั้งค่าบัญชีผู้รับเงิน กรุณาติดต่อผู้ดูแล';
  if (!slip.ref) return 'สลิปไม่มีเลขอ้างอิงธุรกรรม';
  if (!(slip.amount >= plan.amount - 0.001)) return `ยอดในสลิป ${slip.amount} บาท น้อยกว่าราคาแพ็กเกจ ${plan.amount} บาท`;
  const nameOk = cfg.names.some(n => n && fold(slip.receiverName).includes(fold(n)));
  const accOk = cfg.accounts.some(a => digits(a) && digits(slip.receiverAccount).includes(digits(a)));
  if (!nameOk && !accOk) return 'สลิปนี้ไม่ได้โอนเข้าบัญชีของแอป';
  if (slip.date) {
    const ageDays = (now.getTime() - slip.date.getTime()) / 864e5;
    if (ageDays > cfg.maxAgeDays) return `สลิปเก่าเกิน ${cfg.maxAgeDays} วัน`;
    if (ageDays < -1) return 'วันที่ในสลิปไม่ถูกต้อง';
  }
  return null;
}

export function newExpiry(current: Date | null, days: number, now = new Date()): Date {
  const base = current && current > now ? current : now;
  return new Date(base.getTime() + days * 864e5);
}
