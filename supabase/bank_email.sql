-- MONEVO: bổ sung cho kết nối ngân hàng qua email
-- Chạy sau khi đã chạy bank.sql. Chạy một lần trong Supabase: SQL Editor -> New query -> dán -> Run
-- An toàn khi chạy lại nhiều lần.

-- Số dư sau giao dịch mà email ngân hàng báo
alter table public.bank_events add column if not exists balance bigint;
