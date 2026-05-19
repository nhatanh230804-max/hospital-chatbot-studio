# HƯỚNG DẪN VẬN HÀNH CHATBOT (cho Admin Nội Dung)

> Tài liệu này dành cho **người quản lý nội dung** của chatbot, không cần biết code hay kỹ thuật.
>
> Vai trò của bạn: dạy chatbot trả lời đúng nội dung bệnh viện, theo dõi câu nào sai và sửa, quản lý FAQ/tài liệu/dữ liệu.

---

## Mục lục

1. [Tổng quan vai trò Admin](#1-tổng-quan-vai-trò-admin)
2. [Đăng nhập Admin Studio](#2-đăng-nhập-admin-studio)
3. [Tab Dashboard](#3-tab-dashboard)
4. [Tab FAQ - Câu hỏi thường gặp](#4-tab-faq---câu-hỏi-thường-gặp)
5. [Tab Schema - Dạy bảng database](#5-tab-schema---dạy-bảng-database)
6. [Tab Templates - Dạy SQL](#6-tab-templates---dạy-sql)
7. [Tab Trusted Sources](#7-tab-trusted-sources---nguồn-tin-cậy)
8. [Tab Connections](#8-tab-connections---kết-nối-db--storage)
9. [Tab File MinIO](#9-tab-file-minio)
10. [Tab SQL Playground](#10-tab-sql-playground)
11. [Tab Feedback](#11-tab-feedback)
12. [Tab Logs](#12-tab-logs)
13. [Cách hiểu các "route" của chatbot](#13-cách-hiểu-các-route-của-chatbot)
14. [Workflow hàng ngày/tuần/tháng](#14-workflow-hàng-ngàytuầntháng)
15. [Khi chatbot trả lời sai](#15-khi-chatbot-trả-lời-sai)
16. [FAQ Admin](#16-faq-admin)
17. [Liên hệ hỗ trợ](#17-liên-hệ-hỗ-trợ)

---

## 1. Tổng quan vai trò Admin

Chatbot bệnh viện sẽ trả lời câu hỏi của bệnh nhân, bác sĩ, y tá. Để chatbot trả lời đúng, **bạn (admin) cần dạy cho nó**.

### Bạn dạy chatbot 3 nhóm nội dung:

**Nhóm 1: FAQ (câu hỏi cố định)**
- Vd: "Bệnh viện làm việc mấy giờ?" → trả lời cố định
- Không cần AI tính toán, trả lời nhanh < 50ms

**Nhóm 2: Truy vấn data (câu hỏi từ database)**
- Vd: "Hôm nay có bao nhiêu hóa đơn chưa thanh toán?" → chatbot phải hỏi database
- Có 2 cách:
  - **Tạo template SQL** (cho câu hỏi hay gặp) → chạy nhanh
  - **Dạy schema** + để AI tự sinh SQL (cho câu hỏi linh hoạt) → chậm hơn

**Nhóm 3: Tài liệu (file PDF, biểu mẫu)**
- Vd: "Cho tôi xem bảng giá dịch vụ" → chatbot gửi link tải file PDF
- Upload file lên MinIO, gắn keywords để chatbot biết nhận diện

### Việc của bạn KHÔNG bao gồm:
- Cài đặt server, mở port (việc của IT)
- Sửa code (việc của developer)
- Backup database (yêu cầu IT, có lịch sẵn)

---

## 2. Đăng nhập Admin Studio

### URL

```
http://<IP-server>:8080/admin.html
```

IT sẽ cung cấp IP cụ thể, vd: `http://192.168.1.50:8080/admin.html`

### Đăng nhập

Lần đầu mở, hệ thống hỏi **Admin Token**. Nhập password admin do IT cung cấp, bấm **Lưu**.

Token được lưu trong trình duyệt - lần sau truy cập sẽ tự đăng nhập.

### Đăng xuất

Đóng tab hoặc clear cookies. Token phải nhập lại lần sau.

### Quên token?

Liên hệ IT để reset. KHÔNG email/chat token.

---

## 3. Tab Dashboard

Trang chủ Admin Studio - hiển thị nhanh sức khỏe hệ thống:

- Số FAQ active
- Số SQL template active
- Số nguồn tin cậy
- Số file MinIO
- Số kết nối DB
- Số câu chat hôm nay

**Cần làm gì ở tab này?** Không - chỉ xem. Số chat tăng = chatbot được dùng nhiều.

---

## 4. Tab FAQ - Câu hỏi thường gặp

**Khi nào dùng?** Câu hỏi có câu trả lời **cố định**, không cần AI tính toán.

### 4.1. Tạo FAQ thủ công

1. Bấm **+ Tạo FAQ**
2. Điền form:

| Field | Ý nghĩa | Ví dụ |
|---|---|---|
| **Câu hỏi mẫu** | Câu hỏi gốc, có dấu | "Triệu chứng tiểu đường là gì?" |
| **Câu trả lời** | Nội dung trả lời đầy đủ | "Tiểu đường có 3 triệu chứng chính..." |
| **Từ khóa** | Không dấu, không hoa, cách nhau bằng `\|` | `tieu duong\|trieu chung tieu duong\|duong huyet cao` |
| **Danh mục** | Nhóm chủ đề (optional) | "Nội tiết" |

3. Bấm **Lưu**

### 4.2. Upload file FAQ hàng loạt

1. Bấm **Upload file** ở đầu trang
2. Chọn file `.txt`, `.md`, `.docx`, `.pdf`
3. Format file: cặp Q-A cách nhau dòng trống:
```
   Q: Câu hỏi 1
   A: Câu trả lời 1

   Q: Câu hỏi 2
   A: Câu trả lời 2
```
4. Bấm **Upload và phân tích**
5. Hệ thống tự trích Q-A, **tự sinh keywords**
6. Duyệt từng cái: **Duyệt** / **Sửa** / **Bỏ**

### 4.3. Cảnh báo trùng nội dung

Khi upload FAQ mới, hệ thống tự check nội dung trùng (>70% giống). Nếu có:

- Popup hiện 3 lựa chọn:
  - **Thay thế cái này**: xóa FAQ cũ, dùng FAQ mới
  - **Vẫn tạo mới**: giữ cả 2
  - **Hủy**: không tạo

### 4.4. Sửa/Xóa FAQ

Mỗi dòng có nút **Sửa** và **Xóa**.

- **Xóa**: confirm popup → xóa hẳn khỏi DB (không khôi phục được)

### 4.5. Tips viết FAQ tốt

**Keywords cần đa dạng**:
- Từ chính: `tieu duong`
- Từ đồng nghĩa: `dai thao duong`
- Cụm câu hỏi: `trieu chung tieu duong`

**Tránh keyword quá chung**:
- ❌ `benh` (match mọi câu hỏi sức khỏe)
- ✅ `tieu duong`, `benh tieu duong`

---

## 5. Tab Schema - Dạy bảng database

**Khi nào dùng?** Muốn chatbot trả lời câu hỏi từ **dữ liệu thật trong database**.

### 5.1. Schema là gì?

Schema = "cẩm nang" cho chatbot biết database có bảng gì, cột nào, ý nghĩa ra sao.

Vd: bảng `invoices` có cột `patient_name`, `amount`, `status`. Khi user hỏi "Có bao nhiêu hóa đơn chưa thanh toán?", chatbot biết phải query `WHERE status = 'pending'`.

### 5.2. Cách nhanh nhất: Auto-import

1. Tab **Connections** → tìm connection MySQL/Postgres
2. Bấm **📚 Import schema**
3. Modal hiện list bảng → tick bảng cần import
4. Bấm **📚 Import**
5. Quay tab **Schema** → tìm bảng vừa import → **chỉnh description cho rõ ràng** (xem 5.4)

### 5.3. Tạo schema thủ công

1. Tab **Schema** → bấm **+ Tạo schema**
2. Điền form:

| Field | Ý nghĩa | Ví dụ |
|---|---|---|
| **Tên bảng** | Tên đúng trong DB | `invoices` |
| **Domain** | Chủ đề | `billing`, `staff` |
| **Database / Connection** | Chọn dropdown | "DB chính" hoặc "Local-Billing" |
| **Mô tả** | Mô tả + từ user hay dùng | "Hóa đơn viện phí, doanh thu, tổng tiền thu được..." |
| **Columns JSON** | Định nghĩa cột | Xem dưới |
| **Examples JSON** | Câu hỏi mẫu + SQL (optional) | Xem dưới |

**Columns JSON**:
```json
[
  {"name": "id", "type": "INT", "description": "ID hóa đơn"},
  {"name": "patient_name", "type": "VARCHAR", "description": "Tên bệnh nhân"},
  {"name": "amount", "type": "DECIMAL", "description": "Tổng tiền VND"},
  {"name": "status", "type": "VARCHAR", "description": "Trạng thái", "enum": ["paid", "pending", "cancelled"]}
]
```

**Examples JSON** (optional):
```json
[
  {"question": "Có bao nhiêu hóa đơn chưa thanh toán?", "sql": "SELECT COUNT(*) FROM invoices WHERE status = 'pending'"}
]
```

### 5.4. Tips viết description tốt

Description là nguồn keywords quan trọng - viết đầy đủ → chatbot nhận diện câu hỏi tốt hơn.

**Bad**: `Bảng invoices`

**Good**:
```
Hóa đơn viện phí, doanh thu, tổng tiền thu được từ bệnh nhân,
chi phí khám và dịch vụ y tế, BHYT chi trả, trạng thái thanh toán
```

### 5.5. Xóa schema

Bấm **Xóa** → confirm → xóa hẳn metadata của chatbot.

⚠️ **KHÔNG đụng dữ liệu thật trong DB nghiệp vụ** - chỉ xóa "cẩm nang" chatbot. Cần khôi phục? → bấm "📚 Import schema" trên connection.

---

## 6. Tab Templates - Dạy SQL

**Khi nào dùng?** Câu hỏi **lặp lại nhiều** → tạo template (chạy nhanh, ổn định).

**Quy tắc**: tạo template cho **80% câu hỏi top**, còn lại để AI tự sinh SQL.

### 6.1. Tạo template

1. Bấm **+ Tạo hàm SQL**
2. Điền form:

| Field | Ví dụ |
|---|---|
| **Tên** | "Đếm hóa đơn chưa thanh toán" |
| **Category** | "billing" |
| **Mô tả** | "Đếm số hóa đơn có status pending" |
| **Câu hỏi mẫu** | "Có bao nhiêu hóa đơn chưa thanh toán?" |
| **Keywords** | `bao nhieu hoa don\|hoa don chua thanh toan\|hoa don pending` |
| **Database / Connection** | "Local-Billing" |
| **SQL template** | (xem dưới) |

### 6.2. Tips viết SQL

**Cách 1**: Để AI diễn giải kết quả (mặc định)
```sql
SELECT COUNT(*) AS total FROM invoices WHERE status = 'pending'
```
→ AI trả lời tự nhiên: "Hiện có 2 hóa đơn chưa thanh toán."

**Cách 2**: Tự viết câu trả lời trong SQL (nhanh hơn ~5s)
```sql
SELECT CONCAT('Hiện có ', COUNT(*), ' hóa đơn chưa thanh toán.') AS reply
FROM invoices WHERE status = 'pending'
```
→ **Bí quyết**: cột tên `reply` → chatbot in thẳng, không gọi AI.

**Format VND**:
```sql
SELECT CONCAT('Tổng doanh thu: ', FORMAT(SUM(amount), 0), ' VND') AS reply
FROM invoices WHERE status = 'paid'
```

### 6.3. Placeholder thời gian

- `{DEMO_TODAY}` - hôm nay
- `{DEMO_TOMORROW}` - ngày mai
- `{DEMO_YESTERDAY}` - hôm qua

Vd:
```sql
SELECT * FROM staff_schedules WHERE shift_date = '{DEMO_TODAY}'
```

### 6.4. Auto-fill keywords

Field Keywords có 2 nút:
- **⚡ Quick**: heuristic nhanh (<10ms)
- **🤖 AI suggest**: AI sinh kỹ hơn (5-15s, có synonym)

Để trống → hệ thống tự fill khi save.

### 6.5. Test template

Sau khi tạo, bấm **Test** → verify SQL chạy đúng.

---

## 7. Tab Trusted Sources - Nguồn tin cậy

**Khi nào dùng?** Whitelist domain cho Research Mode (chatbot search web).

Mặc định có 8 nguồn: Mayo Clinic, Cleveland, MedlinePlus, NHS, CDC, WHO, MOH Việt Nam, Vinmec.

### Thêm nguồn

1. Bấm **+ Thêm nguồn**
2. Điền:
   - **Tên**: vd "Bệnh viện Bạch Mai"
   - **Domain**: vd `bachmai.gov.vn` (không có https://)
   - **Mô tả**: ngắn gọn
3. Bấm **Lưu**

### Bật/Tắt nguồn

Toggle nút **Active**. Tắt khi nguồn trả về sai (không xóa hẳn).

---

## 8. Tab Connections - Kết nối DB / Storage

**Khi nào dùng?** Kết nối chatbot tới database hoặc kho file.

### 8.1. Tạo connection MySQL/Postgres

1. Bấm **+ Tạo kết nối**
2. Điền:
   - **Tên**: "DB Billing"
   - **Loại**: MySQL / PostgreSQL
   - **Host**: IP DB server
   - **Port**: 3306 / 5432
   - **User / Password / Database**

3. Bấm **Tạo**
4. Popup: "Có muốn auto-import schema?" → **OK**

### 8.2. Tạo connection MinIO

1. Bấm **+ Tạo kết nối**
2. **Loại**: MinIO
3. Điền endpoint, port (9000), access key, secret key, bucket
4. Bấm **Tạo**

### 8.3. Test kết nối

Bấm **Test** → toast ✓ hoặc ✗ + error.

Lỗi thường gặp:
- "Connection refused" → sai IP/port hoặc DB chưa start
- "Access denied" → sai user/password
- "Unknown database" → tên database không tồn tại

### 8.4. Re-import schema

Bấm **📚 Import schema** → modal checkbox list bảng → tick → Import.

### 8.5. Sửa/Xóa connection

- **Sửa**: chỉnh thông tin login
- **Xóa**: xóa connection + schema/template liên quan (cẩn thận!)

---

## 9. Tab File MinIO

**Khi nào dùng?** Quản lý file PDF, biểu mẫu để chatbot gửi link cho user.

### 9.1. Upload file mới

**Bước 1**: Upload file lên MinIO Console (IT làm hoặc admin có quyền)
- URL: `http://<IP-server>:9001`
- Vào bucket `hospital-files` → Upload

**Bước 2**: Vào Admin Studio tab **Connections** → bấm **Sync** trên Local-MinIO
- Hệ thống quét bucket + auto-fill keywords từ tên file

**Bước 3**: Vào tab **File MinIO** → kiểm tra file đã có

### 9.2. Chỉnh keywords

Bấm **Sửa** trên file:
- Vd file `bang-gia-dich-vu-2026.pdf`:
```
  bang gia|gia dich vu|chi phi kham|gia kham|gia 2026
```

### 9.3. File bị xóa khỏi bucket

Nếu IT xóa file trên MinIO:
- Lần sau **Sync** → popup "Phát hiện N file không còn trong bucket"
- Tick các file → "🗑 Xóa các file đã chọn"

### 9.4. Tips keywords cho file

- Tên file gợi nhớ: `bang-gia-2026.pdf` tốt hơn `BG2026_v3.pdf`
- Keywords vừa từ admin gõ, vừa từ user hỏi
- Tránh keyword quá rộng: `file`, `tai lieu`

---

## 10. Tab SQL Playground

**Khi nào dùng?** Test SQL trực tiếp - hữu ích khi verify data, debug.

### Cách dùng

1. Chọn **Database / Connection**
2. Gõ SQL:
```sql
   SELECT * FROM invoices WHERE status = 'pending' LIMIT 10
```
3. Bấm **Chạy**

### Lưu ý an toàn

- Chỉ chạy SELECT, không INSERT/UPDATE/DELETE/DROP
- Tự timeout 30s
- Không hiển thị > 1000 rows

---

## 11. Tab Feedback

**Khi nào dùng?** User bấm 👍/👎. Tab này hiển thị feedback.

- **Duyệt**: ghi nhận
- **Bỏ qua**: spam/comment lung tung

### Tip

Feedback 👎 ưu tiên xem ngay → tìm câu trong Logs → fix nội dung.

---

## 12. Tab Logs

**Tab quan trọng nhất để debug.**

### 12.1. Lịch sử chat

Mỗi log: ID, câu hỏi, time, **route**, source, **latency**, SQL.

### 12.2. Lọc/Tìm kiếm

- Filter theo route (vd: `nl2sql-error`)
- Search keyword
- Pagination

### 12.3. Cache nghiên cứu

Mục riêng - hiển thị câu user đã hỏi và được Research. Nếu sai → xóa cache → buộc tra lại.

---

## 13. Cách hiểu các "route" của chatbot

| Route | Nghĩa | Latency | Khi nào |
|---|---|---|---|
| `medical-safety` | Cấp cứu/kê thuốc | < 5ms | Triệu chứng nguy hiểm |
| `intent-blocked` | Câu xấu bị chặn | < 5ms | SQL injection, xóa data |
| `faq` | Từ FAQ DB | 10-50ms | Match FAQ |
| `hospital-static-guide` | Guide BHYT tĩnh | < 10ms | Hỏi BHYT |
| `sql-template` | SQL template | 50ms-3s | Match keyword template |
| `nl2sql` | AI sinh SQL | 10-30s | Câu data nhưng không match template |
| `nl2sql-error` | SQL validator chặn | 5-15s | SQL nguy hiểm/lệch |
| `minio-file` / `document` | File MinIO | 10-50ms | Match keyword file |
| `research` | Search web | 15-120s | Câu sức khỏe chung |
| `research-cache` | Cache research | < 10ms | Đã hỏi trước đó |
| `research-error` | AI fail | 5-15s | Model lỗi |
| `fallback` | AI tự trả lời chung | 1-5s | Không match route nào |

### Tốt vs cần debug

- **Tốt**: `faq`, `sql-template`, `minio-file`, `medical-safety`
- **OK**: `nl2sql`, `research`, `fallback`
- **Debug**: `nl2sql-error`, `research-error`

---

## 14. Workflow hàng ngày/tuần/tháng

### Tuần 1-2: Khởi tạo

1. Tab **Connections**: Tạo MinIO + các DB
2. **Auto-import schema** trên từng connection
3. Tab **Schema**: chỉnh description cho rõ
4. Tab **FAQ**: upload file FAQ cơ bản
5. Tab **Templates**: tạo 10-20 template top
6. Tab **File MinIO**: upload tài liệu qua MinIO Console + sync

### Hàng tuần

1. Tab **Logs**: review câu hỏi
   - Câu `fallback` nhiều → tạo FAQ/template
   - Câu `nl2sql-error` → tạo template chuẩn
2. Tab **Feedback**: duyệt 👍, fix 👎
3. Tab **Cache nghiên cứu**: xóa cache lỗi

### Hàng tháng

1. Yêu cầu IT backup database
2. Tab **Trusted Sources**: review
3. Tab **Templates**: audit template ít dùng
4. Xuất thống kê top câu hỏi

---

## 15. Khi chatbot trả lời sai

### Bước 1: Tìm câu trong Logs

Vào **Logs** → tìm câu → xem cột **Route**.

### Bước 2: Phân tích route

#### `fallback` (đáng lẽ phải có data)
**Fix**: tab **Schema** → bổ sung từ vào **Mô tả**, hoặc tạo template với keywords sát câu

#### `nl2sql` kết quả sai
**Fix**: bấm **SQL** → xem SQL AI tạo → tạo **template chuẩn** cho câu này

#### `nl2sql-error`
**Fix**: câu khó cho AI → tạo template cụ thể

#### `research` sai nguồn
**Fix**: Cache nghiên cứu → xóa entry → tra lại; hoặc Trusted Sources → thêm/tắt nguồn

#### `research-error`
**Fix**: liên hệ IT - model có thể tải nặng

#### `faq` sai
**Fix**: tab **FAQ** → sửa nội dung

### Bước 3: Test lại

Gõ câu user vào chatbot → verify đúng.

---

## 16. FAQ Admin

**Q: Xóa schema có ảnh hưởng dữ liệu thật trong DB không?**  
A: KHÔNG. Chỉ xóa "cẩm nang" chatbot, không đụng dữ liệu nghiệp vụ.

**Q: Lỡ xóa FAQ. Khôi phục được không?**  
A: KHÔNG qua UI. Liên hệ IT để restore từ backup.

**Q: User gõ tiếng Anh, chatbot có hiểu không?**  
A: Hiểu hạn chế. Tối ưu cho tiếng Việt.

**Q: Tạo template nhưng chatbot không dùng. Sao?**  
A:
- Keywords không match → bấm Quick/AI suggest
- Database/Connection sai → kiểm tra dropdown
- Test trước bằng nút **Test**

**Q: Upload FAQ nhưng chatbot vẫn fallback. Sao?**  
A:
- Keywords chưa khớp với user gõ → bổ sung từ thực tế Logs
- FAQ chưa được duyệt → bấm Duyệt
- Status `inactive` → toggle Active

**Q: Bao lâu chatbot "nhớ" thay đổi của tôi?**  
A: Hầu hết hiệu lực ngay (<60s cache).

**Q: Test thử chatbot trước khi user dùng?**  
A: Mở `http://<IP-server>:8080` trong tab incognito - không cần login.

---

## 17. Liên hệ hỗ trợ

| Vấn đề | Liên hệ |
|---|---|
| Đăng nhập Admin Studio fail | IT |
| Connection DB không test được | IT |
| Chatbot không phản hồi | IT |
| Cần feature mới | Team dev (qua IT) |
| Câu hỏi vận hành nội dung | Đọc lại tài liệu |
| Reset admin token | IT |

**KHÔNG** chia sẻ admin token qua email/chat.

---

**Phiên bản**: v2.5  
**Đối tượng**: Admin Nội Dung  
**Cập nhật cuối**: 2026-05