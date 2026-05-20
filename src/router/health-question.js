// =============================================================================
// src/router/health-question.js — Health/wellness intent detection
// =============================================================================
import { normalizeVietnamese } from "../utils.js";
import { isHospitalDataQuestion, hasStrongDataSignal } from "./data-question.js";

export function isHealthOrWellnessQuestion(message) {
  const text = normalizeVietnamese(message);
  const patterns = [
    "trieu chung", "dau hieu", "benh", "sot", "ho", "kho tho", "dau bung", "dau dau",
    "tieu duong", "dai thao duong", "tay chan mieng", "sot xuat huyet", "cum", "covid",
    "hen suyen", "huyet ap", "tim mach", "viem hong", "viem phoi", "tieu chay",
    "thoat vi", "dau than kinh toa", "dau lung", "dau co", "dau vai", "te bi",
    "giac ngu", "ngu ngon", "mat ngu", "kho ngu", "stress", "cang thang", "lo au",
    "tang can", "giam can", "an uong", "dinh duong", "thuc don", "calo", "protein", "bmi",
    "tap luyen", "tap the duc", "gian co", "keo gian", "stretching", "yoga"
  ];
  if ((text.includes("giam") && text.includes("can")) || (text.includes("tang") && text.includes("can"))) return true;
  return patterns.some((p) => text.includes(p));
}

export async function shouldUseResearchAgent(message) {
  // Logic mới:
  // - Nếu là câu hỏi y tế (health/wellness) VÀ KHÔNG có signal data mạnh → Research
  // - Nếu vừa có y tế vừa có signal data mạnh (vd "có bao nhiêu bệnh nhân tiểu đường") → Data
  // - Nếu chỉ là data → Data (không vào Research)
  const isHealth = isHealthOrWellnessQuestion(message);
  const isData = await isHospitalDataQuestion(message);
  const strongDataSignal = hasStrongDataSignal(message);

  // Case 1: Chỉ health, không phải data → Research
  if (isHealth && !isData) return true;

  // Case 2: Cả health và data, nhưng KHÔNG có signal data rõ → ưu tiên Research
  // (vì khả năng cao admin trích description chứa "benh" làm cache lệch)
  if (isHealth && isData && !strongDataSignal) return true;

  // Case 3: Cả health và data, có signal data rõ → Data (vd "có bao nhiêu bệnh nhân tiểu đường")
  // Case 4: Chỉ data → Data
  return false;
}
