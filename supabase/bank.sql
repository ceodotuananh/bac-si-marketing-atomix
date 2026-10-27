-- MONEVO: kết nối ngân hàng tự động bằng mã chuyển khoản
-- Chạy một lần trong Supabase: SQL Editor -> New query -> dán toàn bộ -> Run

-- Mỗi người dùng một khóa bí mật riêng, nằm trong địa chỉ webhook của người đó.
-- Tách riêng khỏi bảng profiles để quản trị viên không đọc được khóa của người khác.
create table if not exists public.bank_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  key text not null unique default replace(gen_random_uuid()::text, '-', '')
);
alter table public.bank_keys enable row level security;
create policy "xem khoa cua minh" on public.bank_keys
  for select using (user_id = auth.uid());
create policy "tao khoa cua minh" on public.bank_keys
  for insert with check (user_id = auth.uid());

-- Giao dịch ngân hàng đã khớp mã. Hàm webhook ghi vào đây, ứng dụng đọc rồi áp vào khoản thu chi.
create table if not exists public.bank_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  bank_txn_id text not null,
  code text not null,
  direction text not null check (direction in ('in', 'out')),
  amount bigint not null,
  occurred_date date not null,
  content text,
  status text not null default 'new' check (status in ('new', 'applied', 'ignored')),
  created_at timestamptz not null default now(),
  unique (user_id, provider, bank_txn_id, code)
);
alter table public.bank_events enable row level security;
create policy "xem su kien cua minh" on public.bank_events
  for select using (user_id = auth.uid());
create policy "cap nhat su kien cua minh" on public.bank_events
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Tìm khoản theo mã nhanh
create index if not exists transactions_code_idx
  on public.transactions (user_id, (data->>'code'));

-- Cho phép ứng dụng nhận giao dịch mới ngay khi có (realtime)
alter publication supabase_realtime add table public.bank_events;
