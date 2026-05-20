# Hospital Chatbot Studio

Chatbot bệnh viện đa năng, có Admin Studio để quản lý nội dung mà không cần biết code. Hỗ trợ trả lời câu hỏi thường gặp, truy vấn database tự nhiên bằng tiếng Việt (NL2SQL), gợi ý tài liệu PDF từ MinIO, và tra cứu thông tin y tế từ các nguồn uy tín.

---

## Mục lục

- [Tính năng](#tính-năng)
- [Kiến trúc](#kiến-trúc)
- [Stack công nghệ](#stack-công-nghệ)
- [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
- [Quick start - Dev local](#quick-start---dev-local)
- [Deploy lên server](#deploy-lên-server)
- [Cấu trúc project](#cấu-trúc-project)
- [Nhúng widget vào web khác](#nhúng-widget-vào-web-khác)
- [Tài liệu liên quan](#tài-liệu-liên-quan)
- [Hỗ trợ](#hỗ-trợ)

---

## Tính năng

### Routing thông minh - 7 luồng xử lý

Khi user gửi câu hỏi, chatbot tự động phân loại và chọn cách xử lý phù hợp:

| Loại câu hỏi | Cách xử lý | Latency |
|---|---|---|
| Cấp cứu y tế ("đau ngực dữ dội", "kê thuốc") | Trả lời an toàn ngay | < 5ms |
| Câu xấu/nguy hiểm ("xóa toàn bộ data", SQL injection) | Chặn ngay | < 5ms |
| Câu hỏi thường gặp (FAQ) | Tra trong DB FAQ | 10-50ms |
| Câu hỏi về BHYT | Trả lời từ guide tĩnh | < 10ms |
| Câu hỏi truy vấn data (vd: "có bao nhiêu hóa đơn") | Tạo SQL bằng template hoặc AI | 50ms-30s |
| Câu hỏi tài liệu ("cho tôi bảng giá") | Tìm file trong MinIO | 10-50ms |
| Câu hỏi sức khỏe chung ("triệu chứng cảm cúm") | Tra cứu từ nguồn y tế uy tín | 15-120s |

### Admin Studio - 10 tab quản lý

Người quản lý nội dung (không cần biết code) có thể:

- **FAQ**: Tạo/upload file FAQ, có cơ chế dedupe (cảnh báo khi nội dung trùng)
- **Schema**: Dạy chatbot hiểu các bảng database, có auto-import từ DB
- **SQL Templates**: Tạo "hàm SQL" cho câu hỏi hay gặp - chạy cực nhanh
- **Trusted Sources**: Whitelist các nguồn web cho Research Mode
- **Connections**: Kết nối nhiều database/storage khác nhau (MySQL, PostgreSQL, MinIO)
- **File MinIO**: Quản lý kho file PDF + auto-fill keywords từ tên file
- **Feedback**: Duyệt phản hồi user (👍/👎)
- **SQL Playground**: Test SQL trực tiếp
- **Logs**: Theo dõi lịch sử chat, debug khi chatbot trả sai
- **Dashboard**: Thống kê tổng quan

### Tính năng kỹ thuật nâng cao

- **Multi-database routing**: 1 chatbot quản lý nhiều DB cùng lúc, tự route câu hỏi tới đúng DB
- **AI diễn giải SQL**: Kết quả truy vấn được AI chuyển thành câu trả lời tiếng Việt tự nhiên
- **Dynamic keyword learning**: Chatbot tự học từ khóa từ template/schema admin tạo, không cần sửa code
- **Auto-fill keywords**: Tên file MinIO, câu hỏi mẫu template → tự sinh keywords (heuristic + AI optional)
- **Auto-import schema**: Tạo connection → scan DB → sinh schema metadata + keywords tự động
- **Iframe + Widget embed**: Nhúng chatbot vào website khác bằng 1 dòng `<script>`
- **Bảo mật cơ bản**: Chặn SQL injection, intent phá hoại, kê thuốc/cấp cứu, XSS

---

## Kiến trúc

```
┌──────────────────────────────────────────────────────┐
│              MÁY CLIENT (LAN nội bộ)                 │
│   Bác sĩ/y tá/nhân viên truy cập qua browser         │
│   http://<IP-server>:8080                            │
└────────────────────┬─────────────────────────────────┘
                     │ HTTP
┌────────────────────▼─────────────────────────────────┐
│                    SERVER                            │
│                                                      │
│   ┌──────────────────────────────────────────┐       │
│   │  Node.js App (port 8080)                 │       │
│   │  - Router phân loại câu hỏi              │       │
│   │  - Admin Studio web UI                   │       │
│   │  - REST API + chatbot endpoint           │       │
│   └──┬───────────────┬────────────────┬──────┘       │
│      │               │                │              │
│  ┌───▼─────┐    ┌─────▼─────┐    ┌────▼──────┐       │
│  │ MySQL   │    │AnythingLLM│    │  MinIO    │       │
│  │ :3306   │    │ + Ollama  │    │ :9000     │       │
│  │         │    │ :3001     │    │           │       │
│  │ Lưu     │    │ Sinh SQL  │    │ Kho file  │       │
│  │ metadata│    │ + Search  │    │ PDF       │       │
│  │ + data  │    │           │    │           │       │
│  └─────────┘    └───────────┘    └───────────┘       │
│                                                      │
│  Tất cả chạy bằng Docker, trừ Node app (chạy native) │
└──────────────────────────────────────────────────────┘
```

### Luồng xử lý 1 câu hỏi

```
User gõ câu hỏi
   ↓
Node app nhận request
   ↓
1. Check intent xấu? → Chặn nếu có
   ↓
2. Cấp cứu y tế? → Trả lời an toàn nếu có
   ↓
3. FAQ matching? → Trả lời từ DB FAQ nếu match
   ↓
4. Câu hỏi sức khỏe thuần? → Research Mode (AnythingLLM)
   ↓
5. Câu hỏi data?
   ├─ Match SQL template → Chạy template (nhanh)
   └─ Không match → AI sinh SQL (NL2SQL)
       ↓
       Validator chặn nếu SQL nguy hiểm
       ↓
       Chạy SQL trên đúng database
       ↓
       AI diễn giải kết quả thành tiếng Việt
   ↓
6. Fallback → AI tự trả lời chung
   ↓
Log → trả về user
```

---

## Stack công nghệ

- **Backend**: Node.js 20 + Express (ES Modules)
- **Database**: MySQL 8.0 (Docker)
- **Object Storage**: MinIO (S3-compatible, Docker)
- **AI Engine**: AnythingLLM + Ollama (Docker)
  - Model chat: `qwen2.5:7b-instruct-q4_K_M` (cần GPU 4GB+ VRAM) hoặc `qwen2.5:3b` (CPU fallback)
  - Model embedding: `nomic-embed-text`
- **Frontend**: Vanilla JavaScript + HTML/CSS (no framework, dễ customize)
- **Container**: Docker Compose
- **File parsing**: pdf-parse, mammoth (docx), built-in (txt/md)

---

## Yêu cầu hệ thống

### Tối thiểu (dev local hoặc demo nhỏ)
- OS: Windows 10/11 hoặc Ubuntu 22.04+
- RAM: 16 GB
- CPU: 4 cores
- Disk: 50 GB SSD trống
- Network: kết nối LAN, IP tĩnh nếu deploy server

### Khuyến nghị (production bệnh viện)
- RAM: 32 GB
- CPU: 8+ cores
- GPU: NVIDIA 6GB+ VRAM (RTX 3060/4060 trở lên) - giúp latency AI giảm từ 30-60s xuống 2-5s
- Disk: SSD 100 GB
- Network: LAN gigabit, IP tĩnh

### Không có GPU 

1. Dùng model nhỏ `qwen2.5:3b` → chatbot chạy được nhưng latency 30-60s/câu phức tạp

---

## Quick start - Dev local

### Yêu cầu trước
- Docker Desktop (Windows) hoặc Docker Engine (Linux)
- Node.js 20.x
- Git

### Bước 1: Clone repo

```bash
git clone https://github.com/<your-username>/hospital-chatbot-studio.git
cd hospital-chatbot-studio
```

### Bước 2: Cấu hình `.env`

```bash
cp .env.example .env
```

Mở `.env` bằng editor, sửa các giá trị:
- `ADMIN_TOKEN`: chuỗi ngẫu nhiên 32+ ký tự (dùng để đăng nhập Admin Studio)
- `DB_PASSWORD`: password MySQL (phải khớp với `MYSQL_PASSWORD` trong docker-compose.yml)
- `ANYTHINGLLM_API_KEY`: lấy sau khi setup AnythingLLM (bước 6)

Generate password mạnh:
```powershell
# Windows PowerShell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```
```bash
# Linux/Mac
openssl rand -base64 32
```

### Bước 3: Start MySQL + MinIO

```bash
docker compose up -d
```

Đợi khoảng 30 giây. Verify:

```bash
docker compose ps
```

Cả `hospital-demo-mysql` và `hospital-minio` phải có status `Up`.

### Bước 4: Setup AnythingLLM stack riêng

```bash
cd ../anythingllm-stack
docker compose up -d

# Pull model
docker exec -it ollama ollama pull nomic-embed-text
docker exec -it ollama ollama pull qwen2.5:7b-instruct-q4_K_M
# Hoặc nếu không GPU: qwen2.5:3b
```

### Bước 5: Setup AnythingLLM workspace

Mở `http://localhost:3001`:
1. Tạo admin account
2. LLM Preference: Ollama, model `qwen2.5:7b-instruct-q4_K_M`, base URL `http://ollama:11434`
3. Embedding: Ollama, model `nomic-embed-text`
4. Vector DB: LanceDB
5. Tạo workspace tên chính xác `test-chatbot-bv`
6. Settings → Tools → Developer API → Generate API key → copy
7. Paste API key vào `.env` của Node app

### Bước 6: Install dependencies + start

```bash
cd ../hospital-chatbot-studio
npm install
npm start
```

Phải thấy:
```
✅ MySQL connected
🏥 Hospital Chatbot Studio v2 running at http://localhost:8080
🛠️ Admin Studio: http://localhost:8080/admin.html
```

### Bước 7: Truy cập

- **User chat**: http://localhost:8080
- **Admin Studio**: http://localhost:8080/admin.html (đăng nhập bằng `ADMIN_TOKEN`)
- **Embed test**: http://localhost:8080/embed.html
- **MinIO Console**: http://localhost:9001 (login: `minioadmin / minioadmin123` mặc định)
- **AnythingLLM**: http://localhost:3001

### Bước 8: Setup data ban đầu

Vào Admin Studio:

1. Tab **Connections**: Tạo MinIO connection (endpoint `127.0.0.1:9000`, key `minioadmin/minioadmin123`, bucket `hospital-files`)
2. Tab **File MinIO**: Sync để index file trong bucket
3. Tab **Schema**: Bấm "📚 Import schema" trên connection để auto-tạo schema metadata
4. Tab **FAQ**: Upload file FAQ cơ bản
5. Tab **Templates**: Tạo template SQL cho câu hỏi hay gặp

Chi tiết workflow trong [HUONG-DAN-ADMIN.md](./HUONG-DAN-ADMIN.md).

---

## Deploy lên server

Nếu deploy vào hệ thống nội bộ bệnh viện, đọc đầy đủ [HUONG-DAN-IT.md](./HUONG-DAN-IT.md).

Tóm tắt 4 bước:

1. **Chuẩn bị server** (Windows Server hoặc Ubuntu) đáp ứng yêu cầu hệ thống
2. **Cài Docker + Node.js + NVIDIA toolkit** (nếu có GPU)
3. **Copy project + setup .env production** với password mạnh, `ALLOWED_ORIGINS` đúng IP/domain LAN
4. **Auto-start service** qua NSSM (Windows) hoặc systemd (Linux)

Effort: 0.5-1 ngày cho 1 IT có kinh nghiệm Linux/Docker cơ bản.

---

## Cấu trúc project

```
hospital-chatbot-studio/
├── server.js              # Wire middleware (helmet, CORS, JSON, static),Mount 3 router (public, chat, admin)
│                          Init DB và listen port,Graceful shutdown
├── src/
├── config.js              ← biến môi trường, ngày demo
├── db.js                  ← pool MySQL chính + initDb()
├── middleware.js          ← helmet, CORS, rate limit
├── upload.js              ← multer upload FAQ
├── auth.js                ← requireDb, requireAdmin
├── utils.js               ← normalizeVietnamese, safeJsonParse, ...
├── anythingllm.js         ← gọi AnythingLLM API
├── chat-log.js            ← ghi chat_logs
│
├── sql/                   ← TẤT CẢ về SQL
│   ├── memory.js          ← lưu context hội thoại SQL
│   ├── validator.js       ← kiểm tra SQL an toàn (whitelist bảng)
│   ├── summarizer.js      ← AI/heuristic diễn giải kết quả SQL
│   ├── runner.js          ← chạy SQL trên đúng connection
│   ├── templates.js       ← Class "Dạy SQL"
│   └── nl2sql.js          ← câu hỏi tiếng Việt → SQL
│
├── router/                ← logic phân luồng /api/chat
│   ├── documents.js       ← tìm file tài liệu
│   ├── medical-safety.js  ← cấp cứu / BHYT / chặn ý đồ xấu
│   ├── faq.js             ← khớp FAQ
│   ├── data-question.js   ← phát hiện câu hỏi data
│   ├── health-question.js ← phát hiện câu hỏi y tế
│   ├── research.js        ← Research Mode + fallback chat
│   └── trusted-sources.js ← Class "Nguồn tra cứu"
│
├── faq/
│   ├── dedupe.js          ← phát hiện FAQ trùng (keyword + AI)
│   └── file-parser.js     ← đọc .txt/.md/.docx/.pdf
│
├── connections/
│   ├── encryption.js      ← AES-256-GCM cho password
│   └── minio.js           ← MinIO helpers
│
│── routes/                ← Express routers
│  ├── public.js          ← /api/health, /api/dashboard, /api/feedback
│   ├── chat.js            ← /api/chat (router chính)
│   └── admin/             ← tách theo domain
│       ├── index.js       ← gộp tất cả admin lại
│       ├── summary.js
│       ├── feedback.js
│       ├── keywords.js
│       ├── faqs.js
│       ├── schema.js
│       ├── sql-templates.js
│       ├── trusted-sources.js
│       ├── misc.js        ← playground, research-cache, logs
│       ├── data-connections.js
│       └── minio.js
├── package.json
├── docker-compose.yml         # MySQL + MinIO container
├── .env.example               # Template env (commit vào git)
├── .env                       # File env thật (KHÔNG commit)
├── lib/
│   ├── adapters.js            # Adapter MySQL/Postgres/MinIO
│   ├── connection-manager.js  # Multi-DB pool manager
│   └── keyword-extractor.js   # Module trích keywords (heuristic + AI)
├── public/
│   ├── index.html             # User chat UI
│   ├── admin.html             # Admin Studio
│   ├── admin.js               # Admin Studio logic
│   ├── embed.html             # Iframe-friendly chat
│   └── widget.js              # Floating widget (1-line embed)
├── sql/
│   ├── 001_init.sql           # Schema DB chính (hospital_demo)
│   ├── 002_billing_db.sql     # Schema DB billing demo
│   └── 003_multi_db_migration.sql
├── uploads/                   # FAQ files admin upload (KHÔNG commit)
├── README.md                  # File này
├── HUONG-DAN-ADMIN.md         # Hướng dẫn admin nội dung
├── HUONG-DAN-IT.md            # Hướng dẫn IT deploy + bảo trì
└── .gitignore
```

### Quy ước Git

- **KHÔNG commit**: `.env`, `node_modules/`, `uploads/`, password thật
- **KHÔNG commit**: file backup `*.sql`, `*.tar.gz`
- Sử dụng `.env.example` làm template, mỗi developer/server tự tạo `.env` riêng

---

## Nhúng widget vào web khác

Nhúng chatbot vào portal nội bộ bệnh viện hoặc website:

```html
<!-- Cuối thẻ </body> -->
<script>
  window.HospitalChatbotConfig = {
    apiBase: 'http://192.168.1.50:8080',
    title: 'Trợ lý Bệnh viện',
    primaryColor: '#0f5ea8',
    welcomeMessage: 'Xin chào! Tôi có thể giúp gì?'
  };
</script>
<script src="http://192.168.1.50:8080/widget.js"></script>
```

Widget tạo bubble nổi ở góc phải dưới. User bấm → hiện chat popup.

### Yêu cầu CORS

Trong `.env` của server chatbot, thêm domain web đang nhúng vào:

```env
ALLOWED_ORIGINS=http://portal.benhvien.local,http://www.benhvien.com
```

Restart Node app sau khi sửa.

---

## Tài liệu liên quan

| File | Đối tượng đọc | Nội dung |
|---|---|---|
| [HUONG-DAN-ADMIN.md](./HUONG-DAN-ADMIN.md) | Người quản lý nội dung (không cần biết code) | Cách dùng Admin Studio, tạo FAQ/template/schema, debug khi chatbot trả sai |
| [HUONG-DAN-IT.md](./HUONG-DAN-IT.md) | Bộ phận IT bệnh viện | Cài đặt server, backup/restore, monitoring, troubleshooting |
| [.env.example](./.env.example) | Developer/IT | Template các biến môi trường, có comment giải thích từng biến |

---

## Hỗ trợ

### Bug / Feature request
Tạo issue trên GitHub repo với format:
- **Mô tả**: hành vi expected vs actual
- **Reproduce**: các bước để reproduce bug
- **Environment**: OS, Node version, có GPU không
- **Log**: paste log Node + screenshot Admin Studio Logs tab nếu có

### Câu hỏi vận hành
- Admin nội dung → đọc HUONG-DAN-ADMIN.md
- IT cài đặt/bảo trì → đọc HUONG-DAN-IT.md
- Khẩn cấp (chatbot không phản hồi) → IT restart services theo HUONG-DAN-IT.md mục 11

---

## License

Internal use only.

---
