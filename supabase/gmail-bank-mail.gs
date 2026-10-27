// MONEVO: đọc email thông báo biến động số dư trong Gmail và gửi cho MONEVO.
// Dán vào Google Apps Script (script.google.com), sửa dòng WEBHOOK, rồi đặt chạy mỗi 5 phút.

// Dán địa chỉ webhook lấy ở MONEVO: Cài đặt -> Kết nối ngân hàng tự động. Giữ nguyên dấu nháy.
const WEBHOOK = "DÁN_ĐỊA_CHỈ_WEBHOOK_VÀO_ĐÂY";

// Tên nhãn Gmail dùng để đánh dấu email ngân hàng (tạo bằng bộ lọc, xem hướng dẫn)
const LABEL = "MONEVO";
// Email đọc xong nhưng MONEVO không hiểu được sẽ được gắn nhãn này để bạn xem lại
const LABEL_ERR = "MONEVO_LOI";

function checkBankMail() {
  const label = GmailApp.getUserLabelByName(LABEL);
  if (!label) return;
  const errLabel = GmailApp.getUserLabelByName(LABEL_ERR) || GmailApp.createLabel(LABEL_ERR);

  label.getThreads(0, 30).forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      if (!m.isUnread()) return;
      const res = UrlFetchApp.fetch(WEBHOOK, {
        method: "post",
        contentType: "application/json",
        muteHttpExceptions: true,
        payload: JSON.stringify({
          id: m.getId(),
          from: m.getFrom(),
          subject: m.getSubject(),
          date: Utilities.formatDate(m.getDate(), "GMT+7", "yyyy-MM-dd HH:mm:ss"),
          body: m.getPlainBody().slice(0, 5000),
        }),
      });
      if (res.getResponseCode() !== 200) return; // lỗi mạng hoặc máy chủ: để chưa đọc, lần sau gửi lại
      let out = {};
      try { out = JSON.parse(res.getContentText()); } catch (e) {}
      if (out.parsed === false) thread.addLabel(errLabel);
      m.markRead();
    });
  });
}
