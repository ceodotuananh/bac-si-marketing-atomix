// MONEVO: nhận webhook giao dịch ngân hàng từ SePay hoặc Casso.
// Tìm mã chuyển khoản (MV + 6 ký tự) trong nội dung, nếu khớp một khoản của người dùng
// thì ghi một dòng vào bảng bank_events. Ứng dụng sẽ đọc dòng đó và ghi nhận khoản.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CODE_RE = /MV[A-HJKMNP-Z2-9]{6}/g;

type Item = {
  provider: string;
  id: string;
  direction: "in" | "out";
  amount: number;
  date: string;
  content: string;
};

const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Ngày hiện tại theo giờ Việt Nam, dùng khi dịch vụ không gửi kèm ngày
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const dateOf = (v: unknown) => {
  const m = String(v ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : today();
};

function normalize(b: any): Item[] {
  // SePay: một giao dịch mỗi lần gọi, có trường transferType là "in" hoặc "out"
  if (b && b.transferType) {
    return [{
      provider: "sepay",
      id: String(b.id ?? b.referenceCode ?? ""),
      direction: b.transferType === "in" ? "in" : "out",
      amount: Math.abs(Number(b.transferAmount) || 0),
      date: dateOf(b.transactionDate),
      content: [b.content, b.code, b.description].filter(Boolean).join(" "),
    }];
  }
  // Casso: data là một mảng hoặc một đối tượng, số tiền âm là tiền ra
  const rows = Array.isArray(b?.data) ? b.data : b?.data ? [b.data] : [];
  return rows.map((d: any) => {
    const amt = Number(d.amount) || 0;
    return {
      provider: "casso",
      id: String(d.id ?? d.tid ?? d.reference ?? ""),
      direction: amt >= 0 ? "in" : "out",
      amount: Math.abs(amt),
      date: dateOf(d.when ?? d.transactionDateTime ?? d.transactionDate),
      content: String(d.description ?? d.content ?? ""),
    } as Item;
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ success: false, error: 1, message: "Chỉ nhận POST" }, 405);

  // Khóa riêng của người dùng nằm trong địa chỉ: .../bank-webhook?k=<khóa>
  const key = new URL(req.url).searchParams.get("k") ?? "";
  if (!/^[0-9a-f]{32}$/.test(key)) return reply({ success: false, error: 1, message: "Thiếu khóa" }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: owner } = await db.from("bank_keys").select("user_id").eq("key", key).maybeSingle();
  if (!owner) return reply({ success: false, error: 1, message: "Khóa không hợp lệ" }, 401);

  const { data: prof } = await db.from("profiles").select("status").eq("id", owner.user_id).maybeSingle();
  if (prof?.status !== "active") return reply({ success: false, error: 1, message: "Tài khoản chưa được duyệt" }, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return reply({ success: false, error: 1, message: "Nội dung không phải JSON" }, 400);
  }

  let matched = 0;
  for (const it of normalize(body)) {
    if (!it.id || !it.amount) continue;
    const codes = [...new Set(it.content.toUpperCase().match(CODE_RE) ?? [])];
    for (const code of codes) {
      const { data: rows } = await db.from("transactions").select("id")
        .eq("user_id", owner.user_id).eq("data->>code", code).limit(1);
      if (!rows?.length) continue;
      const { error } = await db.from("bank_events").upsert({
        user_id: owner.user_id,
        provider: it.provider,
        bank_txn_id: it.id,
        code,
        direction: it.direction,
        amount: it.amount,
        occurred_date: it.date,
        content: it.content.slice(0, 500),
      }, { onConflict: "user_id,provider,bank_txn_id,code", ignoreDuplicates: true });
      // Trả lỗi 500 để dịch vụ ngân hàng tự gửi lại sau
      if (error) return reply({ success: false, error: 1, message: error.message }, 500);
      matched++;
    }
  }
  // SePay cần success:true, Casso cần error:0
  return reply({ success: true, error: 0, matched });
});
