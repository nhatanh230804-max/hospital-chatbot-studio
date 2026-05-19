# HƯỚNG DẪN VẬN HÀNH CHATBOT

Tài liệu cho người quản lý nội dung chatbot (không cần biết code).

---

## 1. ĐĂNG NHẬP ADMIN STUDIO

**URL:** `http://<IP-server>:8080/admin.html`

Khi mở lần đầu, hệ thống hỏi **Admin Token**. Nhập mật khẩu admin do bộ phận IT cung cấp, bấm **Lưu**.

Sau khi đăng nhập, trang Admin Studio có sidebar với 10 tab. Tab quan trọng nhất giải thích bên dưới.

---

## 2. TAB DASHBOARD

Hiển thị thống kê tổng quan: số FAQ, số template SQL, số nguồn tin cậy, số file MinIO, số kết nối DB, số chat hôm nay, v.v.

Đây là trang xem nhanh sức khỏe hệ thống. Không cần làm gì ở tab này.

---

## 3. TAB FAQ (CÂU HỎI THƯỜNG GẶP)

**Dùng khi nào:** Khi muốn chatbot trả lời sẵn 1 câu hỏi mà không cần qua AI. Vd "Bệnh viện làm việc mấy giờ?", "Bao nhiêu khoa?", "Triệu chứng tiểu đường".

### Thêm FAQ mới (gõ tay):

1. Bấm **+ Tạo FAQ** ở đầu trang
2. Điền:
   - **Câu hỏi mẫu:** câu hỏi gốc (vd: "Triệu chứng tiểu đường là gì?")
   - **Câu trả lời:** trả lời đầy đủ
   - **Từ khóa:** các từ chính cách nhau bằng dấu `|`, viết KHÔNG dấu, không hoa. Vd: `tieu duong|trieu chung tieu duong|duong huyet cao`
   - **Danh mục:** nhóm chủ đề (vd: "Nội tiết", "Tim mạch")
3. Bấm **Lưu**

### Upload file FAQ (hàng loạt):

1. Bấm **Upload file** ở đầu trang
2. Chọn file (.txt, .md, .docx, hoặc .pdf)
3. Format file đơn giản: mỗi cặp Q-A cách nhau bằng dòng trống
   ```
   Q: Câu hỏi 1
   A: Câu trả lời 1
   
   Q: Câu hỏi 2
   A: Câu trả lời 2
   ```
4. Bấm **Upload và phân tích**
5. Hệ thống tự trích cặp Q-A và tạo từ khóa. Sau đó duyệt từng cái:
   - Bấm **Duyệt** để thêm vào danh sách FAQ active
   - Bấm **Sửa** nếu cần chỉnh trước khi duyệt
   - Bấm **Bỏ** nếu không dùng

### Sửa/Xóa FAQ:

Trong danh sách FAQ, mỗi dòng có nút **Sửa** và **Xóa**.

---

## 4. TAB SCHEMA (DẠY BẢNG)

**Dùng khi nào:** Khi muốn chatbot có thể tạo SQL query trả lời câu hỏi từ database.

Ví dụ: nếu bạn muốn chatbot trả lời "Có bao nhiêu hóa đơn chưa thanh toán?" → cần dạy chatbot biết bảng `invoices` có cột nào, ý nghĩa là gì.

### Thêm schema mới:

1. Bấm **+ Tạo schema**
2. Điền:
   - **Tên bảng:** vd `invoices`
   - **Domain:** chủ đề bảng (vd: "billing", "visits", "staff")
   - **Database / Connection:** chọn từ dropdown
     - "DB CHÍNH" nếu bảng thuộc database mặc định
     - Hoặc chọn connection khác (vd "Local-Billing") nếu bảng thuộc DB phụ
   - **Mô tả:** mô tả nội dung bảng + những từ user hay dùng để hỏi về nó (vd: "Hóa đơn viện phí, doanh thu, tổng tiền thu được từ bệnh nhân")
   - **Columns JSON:** mô tả các cột, format JSON:
     ```json
     [
       {"name": "id", "type": "INT", "description": "ID hóa đơn"},
       {"name": "patient_name", "type": "VARCHAR", "description": "Tên bệnh nhân"},
       {"name": "amount", "type": "DECIMAL", "description": "Tổng tiền VND"},
       {"name": "status", "type": "VARCHAR", "description": "Trạng thái", "enum": ["paid", "pending", "cancelled"]}
     ]
     ```
   - **Examples JSON:** vài câu hỏi mẫu + SQL tương ứng (optional)
3. Bấm **Lưu**

**Lưu ý:** Mô tả phải có nhiều từ đồng nghĩa user hay dùng để hỏi. Vd bảng hóa đơn → ghi cả "doanh thu", "tổng tiền", "thanh toán" trong description.

---

## 5. TAB DẠY SQL · TEMPLATES

**Dùng khi nào:** Tạo "hàm SQL có sẵn" cho câu hỏi hay gặp. Chạy nhanh (vài chục ms), không cần AI.

**Quy tắc:** Câu hỏi nào lặp lại nhiều → tạo template. Chỉ những câu hỏi adhoc/hiếm mới để AI tự sinh SQL (chậm hơn).

### Thêm template:

1. Bấm **+ Tạo hàm SQL**
2. Điền:
   - **Tên:** vd "Đếm hóa đơn chưa thanh toán"
   - **Category:** nhóm (vd "billing")
   - **Mô tả:** mục đích template
   - **Câu hỏi mẫu:** vd "Có bao nhiêu hóa đơn chưa thanh toán?"
   - **Keywords:** từ khóa user hay dùng, cách nhau bằng `|`, không dấu:
     ```
     bao nhieu hoa don|hoa don chua thanh toan|hoa don pending
     ```
   - **Database / Connection:** chọn DB nào template chạy
   - **SQL template:**
     ```sql
     SELECT COUNT(*) AS total FROM invoices WHERE status = 'pending'
     ```
3. Bấm **+ Tạo**

### Mẹo tạo SQL đẹp:

Cách 1 — Để AI tự diễn giải kết quả (mặc định):
```sql
SELECT COUNT(*) AS total FROM invoices WHERE status = 'pending'
```
AI sẽ trả lời tự nhiên kiểu: "Hiện có 2 hóa đơn chưa thanh toán."

Cách 2 — Tự viết câu trả lời trong SQL (nhanh hơn AI):
```sql
SELECT CONCAT('Hiện có ', COUNT(*), ' hóa đơn chưa thanh toán.') AS reply
FROM invoices WHERE status = 'pending'
```
Bí quyết: nếu SQL trả về cột tên `reply` → chatbot in thẳng giá trị đó.

### Placeholder hỗ trợ:

Trong SQL template có thể dùng:
- `{DEMO_TODAY}` - hôm nay
- `{DEMO_TOMORROW}` - ngày mai
- `{DEMO_YESTERDAY}` - hôm qua
- `{department}` - tự lấy tên khoa từ câu hỏi user

Vd:
```sql
SELECT * FROM staff_schedules WHERE shift_date = '{DEMO_TODAY}'
```

### Test template:

Sau khi tạo, bấm nút **Test** trên template để xem nó chạy thử ra kết quả gì.

---

## 6. TAB NGUỒN TIN CẬY (TRUSTED SOURCES)

**Dùng khi nào:** Cho phép chatbot tham khảo URL/domain nào khi user hỏi câu sức khỏe chung (vd "triệu chứng cảm cúm").

Mặc định đã có 8 nguồn lớn: Mayo Clinic, Cleveland, MedlinePlus, NHS, CDC, WHO, MOH Việt Nam, Vinmec.

### Thêm nguồn mới:

1. Bấm **+ Thêm nguồn**
2. Điền:
   - **Tên:** vd "Bộ Y tế VN"
   - **Domain:** vd `moh.gov.vn` (chỉ domain, không có https://)
   - **Mô tả:** ngắn gọn
3. Bấm **Lưu**

### Bật/Tắt nguồn:

Toggle nút **Active** trong danh sách.

---

## 7. TAB KẾT NỐI DB / STORAGE

**Dùng khi nào:** Kết nối chatbot tới database hoặc kho file ngoài.

### Tạo kết nối MySQL/PostgreSQL:

1. Bấm **+ Tạo kết nối**
2. Điền:
   - **Tên:** vd "DB Billing"
   - **Loại:** MySQL hoặc PostgreSQL
   - **Mô tả:** mục đích
   - **Host:** vd `192.168.1.55` hoặc `127.0.0.1`
   - **Port:** 3306 (MySQL) hoặc 5432 (Postgres)
   - **User / Password / Database:** thông tin kết nối DB đó
3. Bấm **Tạo**

### Tạo kết nối MinIO:

1. Bấm **+ Tạo kết nối**
2. Loại: **MinIO**
3. Điền endpoint, port, access key, secret key, bucket name
4. Bấm **Tạo**

### Test kết nối:

Sau khi tạo, bấm nút **Test** → toast hiện "✓ Kết nối OK" nếu thành công.

### Xem resources:

Bấm **Resources** → hiện list bảng (MySQL) hoặc file (MinIO).

### Sửa/Xóa:

Mỗi connection có nút **Sửa** và **Xóa**.

---

## 8. TAB FILE MINIO

**Dùng khi nào:** Quản lý file đã đồng bộ từ MinIO bucket.

### Sync file:

Bấm **+ Đồng bộ** → chọn connection MinIO → bấm **Sync**. Hệ thống quét bucket và thêm file mới vào danh sách.

### Gắn keyword cho file:

Mỗi file trong danh sách bấm **Sửa** → thêm keywords (cách nhau bằng `|`, không dấu) để chatbot biết user hỏi câu nào thì gợi file đó.

Vd file `bang-gia-dich-vu.pdf` → keywords: `bang gia|gia kham|gia dich vu|chi phi kham`

User hỏi "cho tôi bảng giá khám" → chatbot tự tìm file này và gửi link tải.

---

## 9. TAB SQL PLAYGROUND

**Dùng khi nào:** Test query SQL trực tiếp (chỉ SELECT, không INSERT/UPDATE/DELETE).

1. Chọn **Database / Connection** từ dropdown
2. Gõ SQL: vd `SELECT * FROM invoices LIMIT 5`
3. Bấm **Chạy**

Kết quả hiện ra dưới dạng bảng.

---

## 10. TAB FEEDBACK

**Dùng khi nào:** Xem user đã đánh giá câu trả lời nào tốt/không tốt (👍/👎).

Click **Duyệt** để chấp nhận feedback hữu ích, **Bỏ qua** để loại.

Feedback tốt có thể dùng làm tài liệu training sau này.

---

## 11. TAB LOGS

**Dùng khi nào:** Xem lịch sử chat của user, route nào được dùng, latency bao nhiêu.

Hữu ích để:
- Biết user hỏi gì nhiều → tạo thêm template/FAQ
- Phát hiện câu nào fallback nhiều → cần dạy thêm
- Debug khi user phản ánh chatbot trả lời sai

Bấm **SQL** trên mỗi dòng để xem SQL chatbot đã tạo (nếu có).

---

## 12. QUẢN LÝ RESEARCH CACHE

Mục **Cache nghiên cứu** trong tab Logs hiển thị các câu trả lời chatbot đã tra cứu từ web. Có thể xóa cache nếu chatbot trả lời sai → buộc tra cứu lại lần sau.

---

## 13. WORKFLOW HÀNG NGÀY

### Tuần 1-2: Khởi tạo
- Vào tab **FAQ** → upload file FAQ cơ bản (giờ làm việc, danh sách khoa, BHYT...)
- Vào tab **Schema** → dạy chatbot các bảng dữ liệu chính
- Vào tab **Templates** → tạo 10-20 template cho câu hỏi hay gặp
- Vào tab **File MinIO** → upload + sync bảng giá, hợp đồng, biểu mẫu

### Hàng tuần:
- Vào tab **Logs** → review câu hỏi user → câu nào hay rơi vào "fallback" → tạo thêm template/FAQ
- Vào tab **Feedback** → review user đánh giá → duyệt cái hữu ích
- Vào tab **Cache nghiên cứu** → kiểm tra chatbot có tra cứu nguồn sai không

### Hàng tháng:
- Backup database (yêu cầu IT)
- Cập nhật trusted sources nếu cần
- Audit lại các template ít dùng → có thể xóa

---

## 14. KHI CHATBOT TRẢ LỜI SAI

Mở **tab Logs** → tìm câu hỏi bị sai → bấm **SQL** xem chatbot đã làm gì:

### Case 1: Route = "fallback" (đáng lẽ phải có data)
- Nghĩa là chatbot không nhận ra câu hỏi liên quan database
- Fix: vào tab **Schema** → tìm bảng tương ứng → bổ sung từ khóa vào **Mô tả**
- Hoặc tạo template trong tab **Templates** với keywords sát câu user hỏi

### Case 2: Route = "nl2sql" (AI sinh SQL nhưng kết quả sai)
- Mở SQL chatbot đã tạo → xem có hợp lý không
- Nếu SQL không đúng ý → tạo template SQL chuẩn cho câu này

### Case 3: Route = "anythingllm-research" (sai nguồn)
- AI search web bị lạc nguồn
- Vào tab **Cache nghiên cứu** → xóa entry sai → buộc tra lại
- Hoặc add domain đúng vào **Trusted Sources**

### Case 4: Route = "approved-medical-faq" (FAQ sai)
- Sửa FAQ trong tab **FAQ**

---

## 15. LIÊN HỆ HỖ TRỢ

Nếu gặp lỗi không xử lý được:
- Lỗi đăng nhập, lỗi connection DB → liên hệ IT
- Cần thêm tính năng → liên hệ team dev
- Khẩn cấp (chatbot xuống) → IT khởi động lại services theo HUONG-DAN-IT.md
