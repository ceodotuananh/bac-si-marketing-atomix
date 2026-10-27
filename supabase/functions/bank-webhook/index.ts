// MONEVO: nhận giao dịch ngân hàng từ SePay, Casso hoặc từ email thông báo biến động số dư.
// Tìm mã chuyển khoản (MV + 6 ký tự) trong nội dung. Nếu khớp một khoản của người dùng thì ghi một dòng
// vào bảng bank_events. Riêng email không có mã vẫn được ghi (code rỗng) để ứng dụng tạo khoản mới.
// Ứng dụng đọc bảng bank_events rồi tự cập nhật.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CODE_RE = /MV[A-HJKMNP-Z2-9]{6}/g;

type Item = {
  provider: string;
  id: string;
  direction: "in" | "out";
  amount: number;
  date: string;
  content: string; // nội dung để hiển thị
  search?: string; // văn bản để dò mã chuyển khoản (mặc định là content)
  balance?: number | null; // số dư sau giao dịch, nếu ngân hàng báo
};

const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Ngày hiện tại theo giờ Việt Nam, dùng khi dịch vụ không gửi kèm ngày
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const dateOf = (v: unknown) => {
  const m = String(v ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : today();
};

// <parse-email>
// Đọc email thông báo biến động số dư. Mỗi ngân hàng viết một kiểu nên đây là bộ đọc chung:
// dựa vào dấu +/-, các từ như "giảm", "tăng", "ghi nợ", "ghi có", và chữ "Số dư".
const UNIT = "(?:VND|VNĐ|VNd|đ|₫)";
const num = (s: string) => Number(s.replace(/[.,]\d{1,2}$/, "").replace(/\D/g, "")) || 0;

function parseEmail(b: any): { item?: Item; reason?: string } {
  const text = `${b.subject ?? ""}\n${b.body ?? ""}`.replace(/ /g, " ").replace(/[ \t]+/g, " ");
  const id = String(b.id ?? "");
  if (!id) return { reason: "Thiếu mã email" };

  // Số dư: tách ra trước để không nhầm với số tiền giao dịch
  // Sau chữ "số dư" phải có dấu ":" hoặc đơn vị tiền, để không nhầm số tài khoản với số dư
  const balM = text.match(new RegExp(`(?:số dư(?: khả dụng| cuối| hiện tại)?|\\bSD\\b|so du)\\s*(?:[:=]\\s*(\\d[\\d.,]*)|(\\d[\\d.,]*)\\s*${UNIT})`, "i"));
  const balance = balM ? num(balM[1] ?? balM[2]) : null;
  const rest = balM ? text.replace(balM[0], " ") : text;

  let direction: "in" | "out" | null = null;
  let amount = 0;
  const sm = rest.match(new RegExp(`([+\\-−–])\\s*(\\d[\\d.,]*)\\s*${UNIT}`, "i"));
  if (sm) {
    direction = sm[1] === "+" ? "in" : "out";
    amount = num(sm[2]);
  } else {
    const mm = rest.match(new RegExp(`(\\d[\\d.,]*)\\s*${UNIT}`, "i"));
    if (mm) amount = num(mm[1]);
    const o = rest.search(/giảm|trừ|ghi nợ|ghi no|debit|chuyển đi|thanh toán|rút/i);
    const i = rest.search(/tăng|cộng|ghi có|ghi co|credit|nhận được|chuyển đến|tiền vào/i);
    // Có cả hai loại từ thì lấy từ xuất hiện trước
    if (o >= 0 && (i < 0 || o < i)) direction = "out";
    else if (i >= 0) direction = "in";
  }
  if (!amount || !direction) return { reason: "Không nhận ra số tiền hoặc chiều thu chi" };

  // Ngày giao dịch trong nội dung email, nếu không có thì dùng ngày nhận email
  let date = dateOf(b.date);
  const dm = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})/);
  if (dm) {
    const dd = +dm[1], mo = +dm[2];
    const yy = dm[3].length === 2 ? 2000 + +dm[3] : +dm[3];
    if (dd >= 1 && dd <= 31 && mo >= 1 && mo <= 12) {
      date = `${yy}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  const cm = text.match(/(?:nội dung|noi dung|\bND\b|diễn giải|mô tả)\s*[:：]\s*([^\n|]+)/i);
  // Cắt bỏ phần "Số dư ..." nếu nó nằm cùng dòng với nội dung
  const content = (cm ? cm[1].replace(/\s*(?:số dư|\bSD\b|so du).*$/i, "") : String(b.subject ?? "")).trim().slice(0, 500);
  return { item: { provider: "email", id, direction, amount, date, content, search: text, balance } };
}
// </parse-email>

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

  let body: any;
  try {
    body = await req.json();
  } catch {
    return reply({ success: false, error: 1, message: "Nội dung không phải JSON" }, 400);
  }

  // Email do script Gmail gửi lên: có from, subject, body
  let items: Item[];
  if (body && typeof body.body === "string" && body.subject !== undefined) {
    const p = parseEmail(body);
    if (!p.item) return reply({ success: true, error: 0, parsed: false, reason: p.reason });
    items = [p.item];
  } else {
    items = normalize(body);
  }

  let matched = 0;
  for (const it of items) {
    if (!it.id || !it.amount) continue;
    const row = {
      user_id: owner.user_id,
      provider: it.provider,
      bank_txn_id: it.id,
      direction: it.direction,
      amount: it.amount,
      occurred_date: it.date,
      content: it.content.slice(0, 500),
      balance: it.balance ?? null,
    };
    const opts = { onConflict: "user_id,provider,bank_txn_id,code", ignoreDuplicates: true };
    const codes = [...new Set((it.search ?? it.content).toUpperCase().match(CODE_RE) ?? [])];
    let hit = false;
    for (const code of codes) {
      const { data: rows } = await db.from("transactions").select("id")
        .eq("user_id", owner.user_id).eq("data->>code", code).limit(1);
      if (!rows?.length) continue;
      const { error } = await db.from("bank_events").upsert({ ...row, code }, opts);
      // Trả lỗi 500 để nơi gửi tự gửi lại sau
      if (error) return reply({ success: false, error: 1, message: error.message }, 500);
      hit = true;
      matched++;
    }
    // Email không có mã nào khớp: vẫn ghi lại (code rỗng) để ứng dụng tạo khoản mới
    if (!hit && it.provider === "email") {
      const { error } = await db.from("bank_events").upsert({ ...row, code: "" }, opts);
      if (error) return reply({ success: false, error: 1, message: error.message }, 500);
    }
  }
  // SePay cần success:true, Casso cần error:0
  return reply({ success: true, error: 0, parsed: true, matched });
});
