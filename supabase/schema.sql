-- GPF Journal: ระบบสมาชิก (รันครั้งเดียวใน Supabase → SQL Editor)
-- สมาชิกใหม่ได้ทดลองใช้ฟรี 14 วันอัตโนมัติ ต่ออายุด้วยสลิปพร้อมเพย์ผ่านฟังก์ชัน verify-slip

create table if not exists public.members (
  id uuid primary key references auth.users on delete cascade,
  email text,
  plan text not null default 'trial',
  expires_at timestamptz not null default now() + interval '14 days',
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users on delete set null,
  trans_ref text not null unique,          -- เลขอ้างอิงธุรกรรมจากสลิป กันใช้สลิปซ้ำ
  amount numeric(10,2) not null,
  plan text not null,
  days int not null,
  slip_date timestamptz,
  receiver text,
  new_expires_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.members enable row level security;
alter table public.payments enable row level security;

-- ผู้ใช้อ่านได้เฉพาะข้อมูลของตัวเอง แก้ไขไม่ได้ (การต่ออายุทำผ่านฟังก์ชันฝั่งเซิร์ฟเวอร์เท่านั้น)
drop policy if exists "members read own" on public.members;
create policy "members read own" on public.members for select using (auth.uid() = id);
drop policy if exists "payments read own" on public.payments;
create policy "payments read own" on public.payments for select using (auth.uid() = user_id);

-- สร้างแถวสมาชิกให้อัตโนมัติเมื่อมีคนสมัคร (ทดลองใช้ 14 วัน)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ตัวอย่างคำสั่งที่เจ้าของใช้บ่อย (ลบ -- ข้างหน้าแล้วแก้อีเมลก่อนรัน)
-- ให้ตัวเองใช้ได้ตลอด:
--   update public.members set plan = 'owner', expires_at = '2099-12-31' where email = 'you@example.com';
-- ต่ออายุให้คนที่โอนแล้วแต่สลิปตรวจไม่ผ่าน (เพิ่ม 30 วัน):
--   update public.members set plan = 'month', expires_at = greatest(expires_at, now()) + interval '30 days' where email = 'friend@example.com';
-- ดูสมาชิกที่ใกล้หมดอายุ:
--   select email, plan, expires_at from public.members order by expires_at;
