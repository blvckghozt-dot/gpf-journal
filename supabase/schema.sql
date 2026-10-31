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

-- ============================================================
-- โหมดอนุมัติสลิปเอง (ค่าเริ่มต้น): ผู้ใช้ส่งสลิป → ได้สิทธิ์ชั่วคราว 3 วัน → เจ้าของตรวจแล้วกดอนุมัติ/ปฏิเสธในแอป
-- ราคาแพ็กเกจอยู่ในฟังก์ชัน plan_info ด้านล่าง ถ้าเปลี่ยนราคา แก้ที่นี่และใน member.js ให้ตรงกัน
-- ============================================================
alter table public.members add column if not exists is_admin boolean not null default false;

create table if not exists public.slip_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  email text,
  plan text not null,
  amount numeric(10,2) not null,      -- ยอดที่ต้องโอน (รวมเศษสตางค์เฉพาะตัว)
  days int not null,
  image text,                          -- รูปสลิป (base64) ลบทิ้งเมื่ออนุมัติเพื่อประหยัดพื้นที่
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  prev_expires_at timestamptz,
  provisional_until timestamptz,
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table public.slip_requests enable row level security;
drop policy if exists "slips read own" on public.slip_requests;
create policy "slips read own" on public.slip_requests for select using (auth.uid() = user_id);

create or replace function public.plan_info(p_plan text, out amount numeric, out days int)
language sql immutable as $$
  select v.amount, v.days from (values ('month', 49::numeric, 30), ('year', 490::numeric, 365)) as v(plan, amount, days) where v.plan = p_plan
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.members where id = auth.uid()), false)
$$;

-- ยอดที่ต้องโอน = ราคาแพ็กเกจ + เศษ 1–99 สตางค์แบบสุ่ม (เลี่ยงเศษที่คนอื่นกำลังใช้อยู่)
-- เก็บไว้ 7 วัน เปิดหน้าต่ออายุซ้ำจะได้ยอดเดิม ล้างทิ้งเมื่อผู้ดูแลอนุมัติ/ปฏิเสธ เพื่อสุ่มใหม่รอบหน้า
alter table public.members add column if not exists quote_plan text;
alter table public.members add column if not exists quote_amount numeric(10,2);
alter table public.members add column if not exists quote_at timestamptz;

drop function if exists public.payment_quote(text);
create or replace function public.payment_quote(p_plan text) returns numeric
language plpgsql volatile security definer set search_path = public as $$
declare uid uuid := auth.uid(); base numeric; m public.members; c int; used int[];
begin
  if uid is null then raise exception 'not_logged_in'; end if;
  select amount into base from public.plan_info(p_plan);
  if base is null then raise exception 'bad_plan'; end if;
  select * into m from public.members where id = uid for update;
  if not found then raise exception 'no_member'; end if;
  if m.quote_plan = p_plan and m.quote_amount is not null and m.quote_at > now() - interval '7 days' then return m.quote_amount; end if;
  select array_agg(round((x.amount - base) * 100)::int) into used from (
    select quote_amount as amount from public.members where id <> uid and quote_plan = p_plan and quote_at > now() - interval '7 days'
    union all select amount from public.slip_requests where status = 'pending' and plan = p_plan) x;
  select n into c from generate_series(1, 99) n where not (n = any(coalesce(used, '{}'))) order by random() limit 1;
  if c is null then c := 1 + floor(random() * 99)::int; end if; -- ถ้าเศษถูกใช้หมดทุกค่า ยอมให้ซ้ำได้
  update public.members set quote_plan = p_plan, quote_amount = base + c / 100.0, quote_at = now() where id = uid;
  return round(base + c / 100.0, 2);
end $$;

create or replace function public.submit_slip(p_plan text, p_image text) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m public.members; pi record; amt numeric; prov timestamptz; rid bigint;
begin
  if uid is null then raise exception 'not_logged_in'; end if;
  if p_image is null or length(p_image) < 1000 then raise exception 'no_image'; end if;
  if length(p_image) > 1500000 then raise exception 'image_too_large'; end if;
  select * into pi from public.plan_info(p_plan); if pi.days is null then raise exception 'bad_plan'; end if;
  amt := public.payment_quote(p_plan);
  if exists (select 1 from public.slip_requests where user_id = uid and status = 'pending') then raise exception 'already_pending'; end if;
  select * into m from public.members where id = uid for update;
  if not found then raise exception 'no_member'; end if;
  -- สิทธิ์ชั่วคราว 3 วันระหว่างรอตรวจ (ไม่ให้ถ้าเคยถูกปฏิเสธในช่วง 60 วัน)
  if m.expires_at < now() + interval '3 days'
     and not exists (select 1 from public.slip_requests where user_id = uid and status = 'rejected' and decided_at > now() - interval '60 days') then
    prov := now() + interval '3 days';
    update public.members set expires_at = prov where id = uid;
  end if;
  insert into public.slip_requests (user_id, email, plan, amount, days, image, prev_expires_at, provisional_until)
    values (uid, m.email, p_plan, amt, pi.days, p_image, m.expires_at, prov) returning id into rid;
  return json_build_object('id', rid, 'amount', amt, 'provisional_until', prov);
end $$;

create or replace function public.admin_requests(p_status text default 'pending', p_limit int default 50)
returns table (id bigint, email text, plan text, amount numeric, status text, image text, note text,
               created_at timestamptz, decided_at timestamptz, provisional_until timestamptz, prev_expires_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  return query
    select r.id, r.email, r.plan, r.amount, r.status, case when r.status = 'pending' then r.image end, r.note,
           r.created_at, r.decided_at, r.provisional_until, r.prev_expires_at
    from public.slip_requests r
    where (p_status = 'all' or r.status = p_status)
    order by case when r.status = 'pending' then r.created_at end asc, r.created_at desc
    limit p_limit;
end $$;

create or replace function public.admin_pending_count() returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then return 0; end if;
  return (select count(*) from public.slip_requests where status = 'pending');
end $$;

create or replace function public.admin_decide(p_id bigint, p_approve boolean, p_note text default null) returns json
language plpgsql security definer set search_path = public as $$
declare r public.slip_requests; cur timestamptz; newexp timestamptz; untouched boolean;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into r from public.slip_requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception 'not_pending'; end if;
  select expires_at into cur from public.members where id = r.user_id for update;
  untouched := r.provisional_until is not null and cur = r.provisional_until; -- ยังเป็นสิทธิ์ชั่วคราวจากคำขอนี้
  if p_approve then
    newexp := (case when untouched then greatest(r.prev_expires_at, r.created_at) else greatest(cur, r.created_at) end) + make_interval(days => r.days);
    update public.members set expires_at = newexp, plan = r.plan where id = r.user_id;
    update public.slip_requests set status = 'approved', decided_at = now(), note = p_note, image = null where id = p_id;
    update public.members set quote_plan = null, quote_amount = null, quote_at = null where id = r.user_id;
  else
    if untouched then update public.members set expires_at = r.prev_expires_at where id = r.user_id; end if;
    update public.slip_requests set status = 'rejected', decided_at = now(), note = p_note where id = p_id;
    update public.members set quote_plan = null, quote_amount = null, quote_at = null where id = r.user_id;
    select expires_at into newexp from public.members where id = r.user_id;
  end if;
  return json_build_object('id', p_id, 'approved', p_approve, 'expires_at', newexp);
end $$;

create or replace function public.admin_extend(p_email text, p_days int) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare e timestamptz;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  if p_days is null or p_days = 0 or abs(p_days) > 3660 then raise exception 'bad_days'; end if;
  update public.members set expires_at = greatest(expires_at, now()) + make_interval(days => p_days)
    where lower(email) = lower(trim(p_email)) returning expires_at into e;
  if e is null then raise exception 'not_found'; end if;
  return e;
end $$;

revoke execute on function public.admin_requests(text, int), public.admin_decide(bigint, boolean, text), public.admin_extend(text, int), public.admin_pending_count() from anon;

-- ตั้งตัวเองเป็นเจ้าของและผู้ดูแล (แก้อีเมลแล้วรัน หลังล็อกอินในแอปครั้งแรก):
--   update public.members set plan = 'owner', is_admin = true, expires_at = '2099-12-31' where email = 'you@example.com';
