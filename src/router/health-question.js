// =============================================================================
// src/router/health-question.js — Health/wellness intent detection
// =============================================================================
import { normalizeVietnamese } from "../utils.js";
import {
  isHospitalDataQuestion,
  hasStrongDataSignal,
} from "./data-question.js";

// Pattern y tế/sức khỏe. Khớp theo RANH GIỚI TỪ (word boundary) — KHÔNG khớp
// chuỗi con — để tránh false-positive kiểu "ho" dính vào "hom"/"cho"/"khoa".
// Riêng "ho" (cough) dễ đụng "họ" nên thay bằng các cụm cụ thể.
const HEALTH_PATTERNS = [
  "trieu chung",
  "dau hieu",
  "sot",
  "bi ho",
  "ho khan",
  "ho co dom",
  "ho keo dai",
  "ho nhieu",
  "ho ra mau",
  "kho tho",
  "dau bung",
  "dau dau",
  "tieu duong",
  "dai thao duong",
  "tay chan mieng",
  "sot xuat huyet",
  "cum",
  "covid",
  "hiv",
  "aids",
  "hen suyen",
  "huyet ap",
  "tim mach",
  "viem hong",
  "viem phoi",
  "tieu chay",
  "thoat vi",
  "dau than kinh toa",
  "dau lung",
  "dau co",
  "dau vai",
  "te bi",
  "giac ngu",
  "ngu ngon",
  "ngu khong ngon",
  "ngu khong sau",
  "thieu ngu",
  "mat ngu",
  "kho ngu",
  "stress",
  "cang thang",
  "lo au",
  "tang can",
  "giam can",
  "an uong",
  "dinh duong",
  "thuc don",
  "calo",
  "protein",
  "bmi",
  "tap luyen",
  "tap the duc",
  "gian co",
  "keo gian",
  "stretching",
  "yoga",
];

// Precompile regex \bpattern\b — chạy 1 lần khi load module.
const HEALTH_REGEXES = HEALTH_PATTERNS.map((p) => new RegExp(`\\b${p}\\b`));

export function isHealthOrWellnessQuestion(message) {
  const text = normalizeVietnamese(message);
  if (
    (text.includes("giam") && text.includes("can")) ||
    (text.includes("tang") && text.includes("can"))
  ) {
    return true;
  }
  return HEALTH_REGEXES.some((re) => re.test(text));
}

export async function shouldUseResearchAgent(message) {
  const isHealth = isHealthOrWellnessQuestion(message);
  const isData = await isHospitalDataQuestion(message);
  const strongDataSignal = hasStrongDataSignal(message);

  // Chỉ health, không phải data → Research
  if (isHealth && !isData) return true;
  // Cả health + data nhưng không có signal data rõ → ưu tiên Research
  if (isHealth && isData && !strongDataSignal) return true;
  // Có signal data rõ, hoặc chỉ data → Data
  return false;
}
// =============================================================================
// (hết file — phần đệm chống lỗi cắt file của môi trường)
// =============================================================================
