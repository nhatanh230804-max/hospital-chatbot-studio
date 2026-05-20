// =============================================================================
// src/router/medical-safety.js — Urgent medical safety / BHYT / malicious intent
// =============================================================================
import { normalizeVietnamese } from "../utils.js";

export function handleUrgentMedicalQuestion(message) {
  const text = normalizeVietnamese(message);
  const urgentSignals = [
    "du doi", "non lien tuc", "kho tho", "ngat", "co giat", "li bi",
    "dau nguc", "chay mau nhieu", "sot cao", "met la", "mat nuoc",
    "yeu liet", "mat kiem soat tieu", "bi tieu", "hon me"
  ];
  const medicineRequest =
    text.includes("uong thuoc gi") ||
    text.includes("dung thuoc gi") ||
    text.includes("thuoc nao") ||
    text.includes("ke thuoc") ||
    text.includes("lieu luong");

  if (urgentSignals.some((s) => text.includes(s)) || medicineRequest) {
    return {
      source: "medical-safety-rule",
      reply: [
        "Tình trạng này cần được nhân viên y tế đánh giá trực tiếp.",
        "",
        "- Mình không thể kê thuốc hoặc hướng dẫn dùng thuốc trong trường hợp này.",
        "- Nếu đau dữ dội, nôn liên tục, khó thở, ngất, sốt cao hoặc tình trạng nặng lên, hãy đến cơ sở y tế hoặc khoa cấp cứu ngay.",
        "- Nếu có thể, hãy đi cùng người thân và mang theo giấy tờ y tế/thuốc đang dùng."
      ].join("\n")
    };
  }
  return null;
}

export function handleBHYTQuestion(message) {
  const text = normalizeVietnamese(message);
  if (text.includes("bhyt") || text.includes("bao hiem y te") || (text.includes("quy trinh") && text.includes("kham"))) {
    return {
      source: "hospital-static-guide",
      reply: [
        "Quy trình khám BHYT thường gồm các bước:",
        "",
        "1. Người bệnh mang thẻ BHYT, CCCD và giấy chuyển tuyến nếu có.",
        "2. Đăng ký tại quầy tiếp nhận.",
        "3. Chờ gọi số thứ tự hoặc phân phòng khám.",
        "4. Khám với bác sĩ theo chuyên khoa phù hợp.",
        "5. Thực hiện xét nghiệm/cận lâm sàng nếu được chỉ định.",
        "6. Thanh toán phần chi phí còn lại nếu có và nhận thuốc theo quy định.",
        "",
        "Bạn nên kiểm tra thêm tại quầy tiếp nhận vì quyền lợi BHYT có thể phụ thuộc vào tuyến khám, giấy chuyển tuyến và loại dịch vụ."
      ].join("\n")
    };
  }
  return null;
}

export function isUrgentOrTreatmentSeeking(message) {
  const text = normalizeVietnamese(message);
  const urgent = ["du doi", "non lien tuc", "kho tho", "ngat", "co giat", "li bi",
    "dau nguc", "chay mau nhieu", "hon me", "tim tai", "sot cao"];
  const treatment = ["uong thuoc gi", "dung thuoc gi", "thuoc nao", "ke don", "lieu luong"];
  return urgent.some((w) => text.includes(w)) || treatment.some((w) => text.includes(w));
}

// Detect câu hỏi có intent xấu: thao tác phá hoại data, SQL injection, lệnh hệ thống
export function isMaliciousIntent(message) {
  const text = normalizeVietnamese(message);
  const raw = String(message || "").toLowerCase();

  // Tiếng Việt: thao tác phá hoại
  const vietnameseHarm = [
    "xoa toan bo", "xoa het", "xoa tat ca", "xoa moi",
    "xoa database", "xoa du lieu", "xoa bang",
    "drop database", "drop bang", "xoa du lieu cua toi",
    "format lai", "reset database", "wipe", "format database"
  ];

  // SQL injection và DDL/DML patterns trong raw text
  const sqlInjection = [
    "drop table", "drop database", "drop schema",
    "delete from", "truncate table", "truncate ",
    "alter table", "alter database",
    "insert into", "update ", "grant ", "revoke ",
    "/*", ";--", "; --", "'; --", "union select"
  ];

  // Lệnh hệ thống
  const systemCommands = [
    "rm -rf", "exec(", "eval(", "system(", "/etc/passwd",
    "powershell", "cmd /c", "wget ", "curl http"
  ];

  if (vietnameseHarm.some((w) => text.includes(w))) return true;
  if (sqlInjection.some((w) => raw.includes(w))) return true;
  if (systemCommands.some((w) => raw.includes(w))) return true;

  return false;
}
