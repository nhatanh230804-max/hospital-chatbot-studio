# HƯỚNG DẪN IT - VẬN HÀNH HỆ THỐNG CHATBOT

> Tài liệu dành cho **bộ phận IT** chịu trách nhiệm cài đặt, vận hành, bảo trì server chatbot trong môi trường nội bộ bệnh viện.
>
> Bạn cần kỹ năng cơ bản: Linux/Windows admin, Docker, networking LAN. Không cần biết code Node.js sâu.

---

## Mục lục

1. [Tổng quan vai trò IT](#1-tổng-quan-vai-trò-it)
2. [Kiến trúc hệ thống](#2-kiến-trúc-hệ-thống)
3. [Yêu cầu server](#3-yêu-cầu-server)
4. [Các service cần chạy](#4-các-service-cần-chạy)
5. [Cài đặt ban đầu](#5-cài-đặt-ban-đầu)
6. [Auto-start sau reboot](#6-auto-start-sau-reboot)
7. [Network & Firewall](#7-network--firewall)
8. [Vai trò Docker và kết nối DB bệnh viện](#8-Vai-trò-Docker-và-kết-nối-DB-bệnh-viện)
9. [Backup](#9-backup)
10. [Restore từ backup](#9-restore-từ-backup)
11. [Monitoring](#10-monitoring)
12. [Restart khi gặp vấn đề](#11-restart-khi-gặp-vấn-đề)
13. [Troubleshooting](#12-troubleshooting)
14. [Security Checklist](#13-security-checklist)
15. [Update / Upgrade](#14-update--upgrade)
16. [Liên hệ team dev](#15-liên-hệ-team-dev)

---

## 1. Tổng quan vai trò IT

### Trách nhiệm của bạn:

- **Cài đặt** server đúng cấu hình (Docker, Node.js, GPU driver nếu có)
- **Bảo mật**: đổi password mặc định, cấu hình firewall
- **Backup**: setup cron backup hàng ngày, lưu trữ an toàn
- **Monitoring**: theo dõi service status, disk usage, RAM
- **Restart** services khi có sự cố
- **Update** project khi team dev release version mới

### KHÔNG phải việc của bạn:

- Quản lý nội dung FAQ, template SQL → việc của Admin Nội Dung
- Sửa code → việc của team dev
- Trả lời câu hỏi nghiệp vụ y tế → việc của bệnh viện

---

## 2. Kiến trúc hệ thống

```
┌──────────────────────────────────────────────────────┐
│                  MÁY CLIENT (LAN)                    │
│ Bác sĩ/y tá/nhân viên truy cập http://<IP-server>:8080│
└────────────────────┬─────────────────────────────────┘
                     │ HTTP
┌────────────────────▼─────────────────────────────────┐
│                    SERVER                            │
│                                                      │
│   ┌──────────────────────────────────────────┐       │
│   │  Node.js App (port 8080)                 │       │
│   │  hospital-chatbot-studio                 │       │
│   └──┬───────────────┬────────────────┬──────┘       │
│      │               │                │              │
│  ┌───▼─────┐    ┌─────▼─────┐    ┌────▼──────┐       │
│  │ MySQL   │    │AnythingLLM│    │  MinIO    │       │
│  │ :3306   │    │  + Ollama │    │ :9000     │       │
│  │         │    │   :3001   │    │           │       │
│  └─────────┘    └───────────┘    └───────────┘       │
│                                                      │
│  Tất cả chạy bằng Docker, trừ Node app (chạy native) │
└──────────────────────────────────────────────────────┘
```

### Lý do tách AnythingLLM ra stack riêng

AnythingLLM + Ollama dùng tài nguyên lớn (GPU, RAM 8-16GB). Tách riêng để:

- Restart chatbot không restart AI
- Có thể deploy AI lên server riêng nếu cần scale
- Update AnythingLLM mà không động Node app

---

## 3. Yêu cầu server

### Phần cứng

| Mục     | Tối thiểu                           | Khuyến nghị                       |
| ------- | ----------------------------------- | --------------------------------- |
| OS      | Windows 10/11 hoặc Ubuntu 22.04 LTS | Ubuntu Server 22.04 LTS           |
| RAM     | 16 GB                               | 32 GB                             |
| CPU     | 4 cores                             | 8+ cores                          |
| GPU     | (không bắt buộc)                    | NVIDIA 6GB+ VRAM (RTX 3060/4060+) |
| Disk    | 50 GB SSD trống                     | 100+ GB SSD                       |
| Network | LAN, IP tĩnh                        | LAN gigabit, IP tĩnh              |

### Không có GPU -  lựa chọn

| Phương án             | Pros            | Cons                                 |
| --------------------- | --------------- | ------------------------------------ |
| Dùng `qwen2.5:3b` CPU | Free, offline   | Latency 30-60s/câu                   |

→ Recommendation: **GPU 6GB+ VRAM** là sweet spot.

### Phần mềm

- Docker Desktop (Windows) hoặc Docker Engine (Linux) ≥ 20.10
- Node.js 20.x LTS
- Git
- NVIDIA Container Toolkit (nếu có GPU)
- Trình duyệt

---

## 4. Các service cần chạy

| Service                  | Loại    | Port       | Mục đích              |
| ------------------------ | ------- | ---------- | --------------------- |
| `hospital-demo-mysql`    | Docker  | 3306       | DB chính + DB billing |
| `hospital-minio`         | Docker  | 9000, 9001 | Kho file PDF          |
| `ollama`                 | Docker  | 11434      | AI inference          |
| `anythingllm`            | Docker  | 3001       | AI workspace + RAG    |
| `node server.js`         | Process | 8080       | Backend + admin UI    |

→ Cả 5 phải UP. Theo dõi qua `docker ps` và `systemctl status` (Linux).

---

## 5. Cài đặt ban đầu

### Bước 1: Cài Docker

**Windows:**

1. Tải Docker Desktop: https://www.docker.com/products/docker-desktop
2. Cài → dùng **WSL2 backend** (Settings → General)
3. Nếu có GPU: Settings → Resources → WSL Integration → Enable

**Ubuntu:**

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker

docker --version
docker compose version
```

### Bước 2: Cài Node.js 20.x

**Windows:** Tải LTS từ https://nodejs.org → cài mặc định → `node --version` verify.

**Ubuntu:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

### Bước 3: NVIDIA Container Toolkit (chỉ nếu có GPU)

**Windows:** Docker Desktop tự xử lý, cần driver NVIDIA mới (≥ 535)

```powershell
nvidia-smi  # Verify thấy GPU
```

**Ubuntu:**

```bash
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo systemctl restart docker

# Verify GPU trong Docker
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi
```

### Bước 4: Clone project

```bash
# Windows: C:\chatbot\
# Linux: /opt/chatbot/

cd /opt/chatbot
git clone https://github.com/<nhatanh230804-max>/hospital-chatbot-studio.git
git clone https://github.com/<nhatanh230804-max>/anythingllm-stack.git
```

### Bước 5: Cấu hình `.env` Node app

```bash
cd hospital-chatbot-studio
cp .env.example .env
```

Mở `.env`, sửa:

```env
ADMIN_TOKEN=<chuỗi-32-ký-tự>
DB_PASSWORD=<password-mạnh>     # Phải khớp MYSQL_PASSWORD trong docker-compose.yml
ANYTHINGLLM_API_KEY=<empty-tạm-thời>  # Điền ở bước 11
ALLOWED_ORIGINS=http://192.168.1.50:8080,http://portal.benhvien.local
```

**Generate password mạnh:**

```powershell
# Windows
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```

```bash
# Linux
openssl rand -base64 32
```

### Bước 6: Cấu hình MySQL password trong `docker-compose.yml`

```yaml
services:
  mysql:
    environment:
      MYSQL_ROOT_PASSWORD: <password-mạnh-root>
      MYSQL_DATABASE: hospital_demo
      MYSQL_USER: hospital_user
      MYSQL_PASSWORD: <password-PHẢI-KHỚP-DB_PASSWORD-trong-.env>
```

### Bước 7: Start MySQL + MinIO

```bash
docker compose up -d
```

Đợi 30s, verify:

```bash
docker compose ps
docker logs hospital-demo-mysql --tail 5
```

Phải thấy `ready for connections`.

### Bước 8: Start AnythingLLM + Ollama

```bash
cd ../anythingllm-stack
docker compose up -d
docker compose ps
```

### Bước 9: Pull model AI

```bash
docker exec -it ollama ollama pull nomic-embed-text

# Chọn 1:
docker exec -it ollama ollama pull qwen2.5:7b-instruct-q4_K_M  # GPU 4GB+
# hoặc
docker exec -it ollama ollama pull qwen2.5:3b                   # CPU/GPU yếu

docker exec -it ollama ollama list  # Verify
```

### Bước 10: Onboarding AnythingLLM

Mở `http://<IP-server>:3001`:

1. Tạo admin account (**LƯU PASSWORD CẨN THẬN**)
2. **LLM Preference**:
   - Provider: Ollama
   - Base URL: `http://ollama:11434` (KHÔNG dùng `localhost`)
   - Model: `qwen2.5:7b-instruct-q4_K_M` hoặc `qwen2.5:3b`
   - Context: 4096 (3b) / 8192 (7b)
3. **Embedding**: Ollama / `nomic-embed-text` / 8192
4. **Vector DB**: LanceDB (mặc định)
5. **Multi-user**: Single user mode

### Bước 11: Tạo workspace + API key

1. Sidebar trái → **+ New Workspace**
2. Tên: **`test-chatbot-bv`** (lowercase, có dấu nối, chính xác)
3. Settings → Tools → Developer API → **+ Generate** → Copy key
4. Paste vào `.env`:

```env
   ANYTHINGLLM_API_KEY=<paste-key>
```

### Bước 12: Install + start Node app

```bash
cd ../hospital-chatbot-studio
npm install
npm start
```

Phải thấy:

```
✅ MySQL connected
🏥 Hospital Chatbot Studio running at http://localhost:8080
```

### Bước 13: Test từ máy client

Browser ở máy khác trong LAN:

- User chat: `http://<IP-server>:8080`
- Admin: `http://<IP-server>:8080/admin.html`

### Bước 14: Mở firewall

**Windows (PowerShell Admin):**

```powershell
New-NetFirewallRule -DisplayName "Hospital Chatbot 8080" `
  -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

**Ubuntu:**

```bash
sudo ufw allow 8080/tcp
sudo ufw reload
```

⚠️ **CHỈ mở 8080 ra LAN.** MySQL/MinIO/AnythingLLM chỉ nội bộ.

### Bước 15: Auto-start (xem mục 6)

### Bước 16: Bàn giao Admin Token

In ra giấy hoặc qua password manager. **KHÔNG email/chat**.

---

## 6. Auto-start sau reboot

Docker containers có `restart: unless-stopped` nên tự khởi động. Nhưng **Node app cần setup riêng**.

### Windows - NSSM

1. Tải NSSM: https://nssm.cc/download
2. Giải nén vào `C:\nssm\`
3. PowerShell Admin:

```powershell
cd C:\nssm\win64
.\nssm.exe install HospitalChatbot
```

4. Dialog NSSM:
   - **Path**: `C:\Program Files\nodejs\node.exe`
   - **Startup directory**: `C:\chatbot\hospital-chatbot-studio`
   - **Arguments**: `server.js`
   - Tab **I/O**:
     - stdout: `C:\chatbot\logs\chatbot.log`
     - stderr: `C:\chatbot\logs\chatbot-error.log`
5. Install service
6. Start:

```powershell
.\nssm.exe start HospitalChatbot
Get-Service HospitalChatbot
```

### Linux - systemd

Tạo `/etc/systemd/system/hospital-chatbot.service`:

```ini
[Unit]
Description=Hospital Chatbot Studio
After=docker.service network.target
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/chatbot/hospital-chatbot-studio
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable hospital-chatbot
sudo systemctl start hospital-chatbot
sudo systemctl status hospital-chatbot

# Log realtime
sudo journalctl -u hospital-chatbot -f
```

---

## 7. Network & Firewall

### Port matrix

| Port  | Service       | Hướng                  | Cho ai               |
| ----- | ------------- | ---------------------- | -------------------- |
| 8080  | Node chatbot  | Inbound LAN            | Máy client trong LAN |
| 3001  | AnythingLLM   | Localhost              | Node app             |
| 9000  | MinIO API     | Localhost              | Node app             |
| 9001  | MinIO Console | Inbound LAN (optional) | IT/Admin upload file |
| 3306  | MySQL         | Localhost              | Node app             |
| 11434 | Ollama        | Localhost              | AnythingLLM          |

### Firewall - Windows

```powershell
# PowerShell Admin

# Chatbot ra LAN
New-NetFirewallRule -DisplayName "Hospital Chatbot 8080" `
  -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow

# MinIO Console chỉ admin LAN
New-NetFirewallRule -DisplayName "MinIO Console 9001" `
  -Direction Inbound -LocalPort 9001 -Protocol TCP -Action Allow `
  -RemoteAddress 192.168.1.0/24
```

### Firewall - Ubuntu (ufw)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp   # SSH - đừng quên!
sudo ufw allow 8080/tcp
sudo ufw allow from 192.168.1.0/24 to any port 9001 proto tcp  # MinIO Console nội bộ
sudo ufw enable
sudo ufw status verbose
```

### IP tĩnh

Server phải có IP tĩnh. Liên hệ team mạng.

### DNS nội bộ (optional)

Setup `chatbot.benhvien.local → 192.168.1.50` để user truy cập dễ nhớ:

```
http://chatbot.benhvien.local:8080
```

---

## 8. Vai trò Docker và kết nối DB bệnh viện

> Phần này QUAN TRỌNG. Đọc kỹ trước khi triển khai vào bệnh viện thật.

### 8.1. Docker dùng cho cái gì trong project này?

Project có 5 service. Bảng dưới chỉ rõ Docker bắt buộc hay không:

| Service               | Mục đích                                 | Docker?             | Ghi chú                               |
| --------------------- | ---------------------------------------- | ------------------- | ------------------------------------- |
| **MySQL của chatbot** | Lưu FAQ, template, schema metadata, logs | Khuyên dùng         | Có thể dùng MySQL native (xem 8.2)    |
| **MinIO**             | Kho file PDF, biểu mẫu                   | Khuyên dùng         | Có thể native nhưng phức tạp          |
| **AnythingLLM**       | AI workspace + RAG                       | **BẮT BUỘC Docker** | Không khuyến nghị cài native          |
| **Ollama**            | AI inference engine                      | Khuyên Docker       | Có thể native (ollama.com)            |
| **Node.js app**       | Backend chatbot + admin UI               | **KHÔNG Docker**    | Chạy native + auto-start NSSM/systemd |

→ **Tóm lại**: Docker gần như **bắt buộc** cho AI engine (AnythingLLM + Ollama). Các service khác có thể flexible.

### 8.2. Phân biệt 3 loại DB trong hệ thống

Đây là điểm dễ gây nhầm lẫn khi deploy. Cần phân biệt rõ:

#### Loại 1: DB của chatbot (chatbot METADATA)

- Chứa: FAQ, SQL templates, schema metadata, chat logs, feedback, trusted sources, config connections
- Tên DB mặc định: `hospital_demo`
- **Bắt buộc có**: chatbot không chạy được nếu không có DB này
- **Lựa chọn**:
  - Cách A (mặc định): MySQL trong Docker container `hospital-demo-mysql`
  - Cách B: MySQL native trên server bệnh viện (xem 8.3)

#### Loại 2: DB demo billing (nếu dùng demo)

- Chứa: data demo (hóa đơn fake, lịch trực fake)
- Tên DB mặc định: `hospital_billing`
- Chỉ dùng để demo, **không cần trong production thật**
- Bệnh viện có thể bỏ qua hoặc xóa

#### Loại 3: DB nghiệp vụ thật của bệnh viện

- Chứa: hóa đơn thật, bệnh án, lịch khám thật...
- **Đã có sẵn** trên server riêng của bệnh viện
- DBA bệnh viện quản lý
- Chatbot **chỉ kết nối qua mạng** để query, KHÔNG copy data, KHÔNG cần Docker hóa
- Hỗ trợ: MySQL, PostgreSQL (chưa support SQL Server, Oracle)

### 8.3. Tùy chọn: Dùng MySQL native cho DB chatbot (thay vì Docker)

Nếu bệnh viện đã có MySQL native và muốn tận dụng (giảm số Docker container), có thể chuyển DB chatbot ra native:

#### Bước 1: Trên MySQL native, tạo DB + user

DBA chạy:

```sql
CREATE DATABASE hospital_chatbot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'chatbot_app'@'<ip-chatbot-server>' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON hospital_chatbot.* TO 'chatbot_app'@'<ip-chatbot-server>';
FLUSH PRIVILEGES;
```

⚠️ User này cần quyền `ALL PRIVILEGES` trên DB chatbot (vì chatbot ghi vào - khác với user read-only ở mục 8.4).

#### Bước 2: Import schema chatbot

```bash
# Trên server chatbot
mysql -h <ip-mysql-native> -u chatbot_app -p hospital_chatbot < sql/001_init.sql

# (Optional) Import demo data
mysql -h <ip-mysql-native> -u chatbot_app -p hospital_chatbot < sql/002_billing_db.sql
mysql -h <ip-mysql-native> -u chatbot_app -p hospital_chatbot < sql/003_multi_db_migration.sql
```

#### Bước 3: Cập nhật `.env` của Node app

```env
DB_HOST=<ip-mysql-native>
DB_PORT=3306
DB_USER=chatbot_app
DB_PASSWORD=<strong-password>
DB_NAME=hospital_chatbot
```

#### Bước 4: Bỏ MySQL Docker khỏi docker-compose.yml

Mở `docker-compose.yml`, xóa hoặc comment out service `mysql:`. Giữ lại MinIO.

```yaml
services:
  # mysql: ... ← comment hoặc xóa block này
  minio:
    image: minio/minio:latest
    # ... giữ nguyên
```

#### Bước 5: Restart

```bash
docker compose down
docker compose up -d   # Chỉ start MinIO
sudo systemctl restart hospital-chatbot
```

Verify trong log Node app:

```
✅ MySQL connected
```

Nếu hiện → kết nối tới MySQL native thành công.

**Pros**:

- Bệnh viện đã có MySQL → đỡ maintain Docker container thêm
- DBA bệnh viện quản lý backup, monitoring chung

**Cons**:

- Setup phức tạp hơn 1 chút
- DB chatbot bị ảnh hưởng nếu MySQL native down

### 8.4. Kết nối DB nghiệp vụ bệnh viện (KHÔNG cần Docker)

Đây là use case phổ biến nhất. Bệnh viện đã có MySQL/PostgreSQL chạy native với data thật → chatbot **chỉ cần kết nối qua mạng**.

#### Kiến trúc

```
┌─────────────────────────────────────┐
│  SERVER CHATBOT (deploy mới)        │
│                                     │
│  ┌──────────────────┐               │
│  │ Node.js app      │               │
│  │ Port 8080        │               │
│  └────────┬─────────┘               │
│           │                         │
│  ┌────────▼─────────┐               │
│  │ MySQL Docker     │ ← FAQ,        │
│  │ Port 3306        │   template,   │
│  │ (DB chatbot)     │   log         │
│  └──────────────────┘               │
│                                     │
│  ┌──────────────────┐               │
│  │ MinIO Docker     │ ← file PDF    │
│  └──────────────────┘               │
│                                     │
│  ┌──────────────────┐               │
│  │ AnythingLLM      │ ← AI engine   │
│  │ + Ollama Docker  │               │
│  └──────────────────┘               │
└──────────┬──────────────────────────┘
           │ TCP qua LAN
           │ (port 3306/5432)
           ▼
┌─────────────────────────────────────┐
│  SERVER DB BỆNH VIỆN (có sẵn)       │
│  ┌──────────────────┐               │
│  │ MySQL/Postgres   │ ← Data thật:  │
│  │ native           │   bệnh án,    │
│  │                  │   hóa đơn,    │
│  │                  │   lịch khám   │
│  └──────────────────┘               │
└─────────────────────────────────────┘
```

#### Loại DB nghiệp vụ hiện chatbot support

| Loại DB        | Status               | Note                            |
| -------------- | -------------------- | ------------------------------- |
| MySQL 5.7+/8.0 | ✅ Full support      |                                 |
| PostgreSQL 12+ | ✅ Full support      |                                 |
| SQL Server     | ❌ Chưa support      |                                 |
| Oracle         | ❌ Chưa support      |                                 |
| MariaDB        | ✅ Tương thích MySQL |                                 |
| MongoDB/NoSQL  | ❌ Không support     | Chatbot dùng SQL                |

#### Checklist phối hợp với DBA bệnh viện

##### Bước 1: Xác định DB cần kết nối

Liệt kê các bảng chatbot cần query, vd:

- DB billing: bảng `invoices`, `payments`
- DB visits: bảng `appointments`, `medical_records`

→ **Nguyên tắc**: chỉ kết nối những bảng thực sự cần.

##### Bước 2: Yêu cầu DBA tạo READ-ONLY user

DBA chạy SQL sau (thay `<password>` bằng password mạnh, `<ip-chatbot>` bằng IP server chatbot):

**MySQL:**

```sql
CREATE USER 'chatbot_readonly'@'<ip-chatbot>' IDENTIFIED BY '<password>';

GRANT SELECT ON benhvien_billing.* TO 'chatbot_readonly'@'<ip-chatbot>';
GRANT SELECT ON benhvien_visits.* TO 'chatbot_readonly'@'<ip-chatbot>';

FLUSH PRIVILEGES;
```

**PostgreSQL:**

```sql
CREATE USER chatbot_readonly WITH PASSWORD '<password>';

GRANT CONNECT ON DATABASE benhvien_billing TO chatbot_readonly;
GRANT USAGE ON SCHEMA public TO chatbot_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO chatbot_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO chatbot_readonly;
```

⚠️ **KHÔNG cấp** quyền INSERT/UPDATE/DELETE/DROP. Chatbot có validator riêng nhưng vẫn nên đặt quyền DB ở mức tối thiểu (principle of least privilege).

##### Bước 3: Mở firewall DB cho IP chatbot

DBA đảm bảo port DB (3306/5432) mở từ IP server chatbot:

```bash
# Test từ server chatbot
telnet <ip-db-benhvien> 3306
# hoặc
nc -zv <ip-db-benhvien> 3306
```

Phải connect được.

##### Bước 4: DBA cung cấp credentials

Qua kênh an toàn (password manager, gặp trực tiếp, KHÔNG email):

- Host: vd `10.0.5.10`
- Port: `3306` hoặc `5432`
- Username: `chatbot_readonly`
- Password: (DBA cấp)
- Database name: vd `benhvien_billing`

##### Bước 5: Bàn giao cho Admin Nội Dung

Admin tạo connection trong Admin Studio (xem HUONG-DAN-ADMIN.md mục 8).

#### Test kết nối trước khi go-live

**MySQL:**

```bash
sudo apt install mysql-client   # Ubuntu

mysql -h <ip-db-benhvien> -P 3306 -u chatbot_readonly -p
# Nhập password
SHOW DATABASES;
USE benhvien_billing;
SHOW TABLES;
SELECT * FROM invoices LIMIT 5;
```

**PostgreSQL:**

```bash
sudo apt install postgresql-client

psql -h <ip-db-benhvien> -p 5432 -U chatbot_readonly -d benhvien_billing
\dt
SELECT * FROM invoices LIMIT 5;
\q
```

Nếu lỗi:

- `Connection refused` → firewall DB chưa mở
- `Access denied` → sai user/password hoặc IP không khớp
- `Unknown database` → tên DB sai
- `Permission denied` → user thiếu quyền SELECT

### 8.5. Performance + Bảo mật

#### Performance lưu ý

- Latency tăng ~50-200ms so với DB cùng máy do qua network LAN
- Nếu query thường xuyên (>100 query/phút), thảo luận với DBA về load
- Có thể tạo read replica của DB bệnh viện riêng cho chatbot nếu cần isolate

#### Bảo mật - 3 nguyên tắc bắt buộc

**1. Read-only user**
KHÔNG dùng user có quyền ghi. Cấp tối thiểu chỉ SELECT.

**2. Whitelist IP**

```sql
-- ✅ Đúng
CREATE USER 'chatbot_readonly'@'192.168.1.50' IDENTIFIED BY '...';

-- ❌ Sai
CREATE USER 'chatbot_readonly'@'%' IDENTIFIED BY '...';
```

**3. Network isolation**

- Chatbot và DB bệnh viện cùng LAN nội bộ, không qua internet
- Cross-network → cần VPN site-to-site hoặc IPsec tunnel

### 8.6. Trường hợp đặc biệt

#### Case: DB bệnh viện là SQL Server

Chatbot hiện chưa support. 3 cách workaround:

1. **Dev thêm adapter** (effort: 1-2 ngày, liên hệ team dev)
2. **ETL data**: dùng SSIS hoặc tool ETL bệnh viện copy data SQL Server → MySQL Docker chatbot → chatbot query MySQL (data có delay)
3. **Linked server**: tạo MySQL có linked server tới SQL Server → chatbot dùng MySQL adapter

#### Case: DB bệnh viện ở cloud (AWS RDS, GCP Cloud SQL)

- Đa số là MySQL/Postgres compatible → chatbot kết nối bình thường
- Config security group/firewall cloud cho IP chatbot
- Latency có thể cao hơn (5-50ms) nếu khác region

#### Case: Bệnh viện chưa muốn cho chatbot truy cập DB thật

→ Tạo **DB demo** giả lập trong MySQL Docker (như cách đang demo với `hospital_billing`). Sau khi bệnh viện duyệt → migrate sang DB thật bằng tạo connection mới + import schema.

### 8.7. Quy trình review giữa IT + DBA + Admin Chatbot

Trước go-live, họp 3 bên:

| Đối tượng            | Trách nhiệm                                              |
| -------------------- | -------------------------------------------------------- |
| **DBA bệnh viện**    | Tạo user, cấp quyền, mở firewall, cung cấp credentials   |
| **IT chatbot (bạn)** | Test connection, setup security, monitor                 |
| **Admin chatbot**    | Tạo connection trong UI, import schema, viết description |

Checklist sign-off:

- [ ] DBA xác nhận user `chatbot_readonly` chỉ có quyền SELECT
- [ ] DBA xác nhận user bind theo IP cụ thể, không phải `%`
- [ ] IT chatbot test connection từ CLI thành công
- [ ] IT chatbot test query SELECT thành công trên 1-2 bảng
- [ ] Admin tạo connection trong Admin Studio + test OK
- [ ] Admin import schema thành công
- [ ] Test end-to-end: gõ câu hỏi vào chatbot → trả data từ DB bệnh viện

---

---

## 9. Backup

### Mức độ ưu tiên

| Loại                                | Tần suất     | Lý do                      |
| ----------------------------------- | ------------ | -------------------------- |
| MySQL (FAQ, template, schema, logs) | Hàng ngày    | Mất = admin làm lại từ đầu |
| MinIO (file PDF)                    | Hàng tuần    | File ít thay đổi           |
| AnythingLLM workspace               | Hàng tuần    | Cache + setting            |
| `.env`                              | Khi thay đổi | Chứa password              |

### Backup MySQL hàng ngày

**Manual:**

```bash
docker exec hospital-demo-mysql \
  mysqldump -u root -p<password> --all-databases > /backup/db-$(date +%Y%m%d).sql
```

**Cron Linux:**

```bash
# crontab -e
0 2 * * * docker exec hospital-demo-mysql mysqldump -u root -p<password> \
  --all-databases > /backup/db-$(date +\%Y\%m\%d).sql && \
  find /backup -name 'db-*.sql' -mtime +30 -delete
```

→ 2h sáng mỗi ngày, xóa file > 30 ngày.

**Task Scheduler Windows:**

Tạo `C:\chatbot\scripts\backup-db.bat`:

```batch
@echo off
set DATE=%date:~10,4%%date:~4,2%%date:~7,2%
docker exec hospital-demo-mysql-v2 mysqldump -u root -p<password> --all-databases > C:\backup\db-%DATE%.sql

forfiles /p C:\backup /m db-*.sql /d -30 /c "cmd /c del @path"
```

Tạo Task Scheduler chạy `.bat` hàng ngày 2h sáng.

### Backup MinIO

```bash
docker run --rm \
  -v hospital-chatbot-studio_hospital_minio_data:/data \
  -v /backup:/backup \
  busybox tar czf /backup/minio-$(date +%Y%m%d).tar.gz /data
```

### Backup AnythingLLM

```bash
docker run --rm \
  -v anythingllm-stack_anythingllm_storage:/data \
  -v /backup:/backup \
  busybox tar czf /backup/anythingllm-$(date +%Y%m%d).tar.gz /data
```

### Lưu trữ offsite

Khuyến nghị copy backup sang:

- External HDD hoặc NAS bệnh viện
- Cloud nội bộ (nếu có)

**KHÔNG** chỉ lưu trên server chính.

---

## 10. Restore từ backup

### Restore MySQL

```bash
sudo systemctl stop hospital-chatbot

docker exec -i hospital-demo-mysql mysql -u root -p<password> < /backup/db-20260513.sql

# Verify
docker exec hospital-demo-mysql mysql -u root -p<password> -e "SHOW DATABASES;"

sudo systemctl start hospital-chatbot
```

### Restore MinIO

```bash
docker stop hospital-minio

docker run --rm \
  -v hospital-chatbot-studio_hospital_minio_data:/data \
  -v /backup:/backup \
  busybox tar xzf /backup/minio-20260513.tar.gz -C /

docker start hospital-minio
```

---

## 11. Monitoring

### Service status

```bash
docker ps

# Log từng service
docker logs hospital-demo-mysql --tail 50
docker logs hospital-minio --tail 50
docker logs ollama --tail 50
docker logs anythingllm --tail 50

# Node app
sudo journalctl -u hospital-chatbot -f
sudo journalctl -u hospital-chatbot --since "1 hour ago"
```

### Disk usage

```bash
df -h
docker system df

# Prune cẩn thận (KHÔNG --volumes nếu chưa backup)
docker system prune -a
```

### Resource usage

```bash
docker stats   # CPU/RAM realtime
nvidia-smi     # GPU nếu có
```

### Endpoint health-check (custom)

Có thể curl health endpoint của Node:

```bash
curl http://localhost:8080/api/health
# → {"status":"ok","db":"connected"}
```

Setup script kiểm tra mỗi 5 phút, alert nếu fail:

```bash
*/5 * * * * curl -fsS http://localhost:8080/api/health > /dev/null || /usr/local/bin/alert.sh "Chatbot down"
```

---

## 12. Restart khi gặp vấn đề

```bash
# Restart 1 service
docker restart hospital-demo-mysql

# Restart cả stack chatbot
cd /opt/chatbot/hospital-chatbot-studio
docker compose restart

# Restart AnythingLLM stack
cd ../anythingllm-stack
docker compose restart

# Restart Node app
sudo systemctl restart hospital-chatbot   # Linux
nssm restart HospitalChatbot              # Windows
```

### Thứ tự restart (khi có issue rộng)

1. Node app (nhanh nhất, thường đủ)
2. MySQL (nếu DB connection lỗi)
3. AnythingLLM (nếu AI fail)
4. Cả stack (cuối cùng)

---

## 13. Troubleshooting

### Lỗi: "MySQL not connected"

```bash
docker logs hospital-demo-mysql --tail 30

# Check port có bị chiếm không?
netstat -ano | findstr :3306   # Windows
ss -tlnp | grep :3306          # Linux
```

**Nguyên nhân thường gặp:**

- MySQL service Windows native chiếm port 3306 → Stop service:

```powershell
  Stop-Service MySQL80
  Set-Service MySQL80 -StartupType Manual
```

- Password `.env` không khớp `docker-compose.yml`
- Container chưa start xong (đợi thêm 30s)

### Lỗi: "AnythingLLM phản hồi quá lâu"

- Mở `http://<IP-server>:3001` → test workspace trực tiếp
- Check Ollama: `docker exec -it ollama ollama ps` - model có load chưa?
- Nếu CPU 100% → upgrade RAM/GPU hoặc đổi model nhỏ hơn (`qwen2.5:3b`)

### Lỗi: "Sai admin token"

- Check `.env`: `cat .env | grep ADMIN_TOKEN`
- Restart Node app sau khi đổi `.env`

### Mojibake tiếng Việt (ký tự lạ)

- File `.sql` lưu UTF-8 (không BOM)
- Console Windows: `chcp 65001`
- Driver mysql2 trong code đã set `charset: utf8mb4` (không cần sửa)

### Chatbot trả lời sai/lạc đề

- Vào Admin Studio → Logs → kiểm tra route + SQL
- Refer HUONG-DAN-ADMIN.md mục 15

### Port 3306 bị chiếm (Windows)

```powershell
# Check process nào chiếm
netstat -ano | findstr :3306
tasklist /FI "PID eq <pid>"

# Nếu là MySQL native:
Stop-Service MySQL80
Set-Service MySQL80 -StartupType Manual
```

### Docker container không tự restart sau reboot

Verify flag `restart: unless-stopped` trong `docker-compose.yml`:

```yaml
services:
  mysql:
    restart: unless-stopped
```

Apply:

```bash
docker compose up -d
```

### GPU không được Ollama nhận

```bash
# Verify GPU trong Docker
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi

# Nếu fail → cài lại nvidia-container-toolkit (xem bước 3)
```

---

## 14. Security Checklist

Trước khi go-live, đảm bảo:

- [ ] Đổi `ADMIN_TOKEN` thành chuỗi ngẫu nhiên 32+ ký tự
- [ ] Đổi MySQL root password
- [ ] Đổi MySQL user password (`hospital_pass` mặc định)
- [ ] Đổi MinIO admin (mặc định `minioadmin/minioadmin123`)
- [ ] AnythingLLM admin password mạnh
- [ ] `.env` set `ALLOWED_ORIGINS` đúng IP/domain LAN
- [ ] Firewall chỉ mở port 8080 ra LAN (3001/9000/3306 chỉ nội bộ)
- [ ] Backup database hàng ngày
- [ ] Document mật khẩu vào password manager (KHÔNG email)
- [ ] `.env`, `node_modules/`, `uploads/` không bị commit lên git
- [ ] Test khôi phục từ backup ít nhất 1 lần
- [ ] Setup auto-start Node app (NSSM/systemd)
- [ ] Setup health-check + alert
- [ ] Bàn giao admin token cho Admin Nội Dung qua kênh an toàn

### Đổi password mặc định

**MySQL hospital_user** (an toàn, giữ data):

```bash
docker exec -it hospital-demo-mysql mysql -u root -p<root-pass>
```

```sql
ALTER USER 'hospital_user'@'%' IDENTIFIED BY '<new-password>';
FLUSH PRIVILEGES;
EXIT;
```

Sau đó sửa `.env` (`DB_PASSWORD=<new>`) + `docker-compose.yml` (`MYSQL_PASSWORD: <new>`) + restart Node.

**MinIO admin:**

Sửa `docker-compose.yml`:

```yaml
environment:
  MINIO_ROOT_PASSWORD: <new-password>
```

```bash
docker compose up -d --force-recreate hospital-minio
```

Vào Admin Studio → sửa connection MinIO → đổi Secret Key.

**ADMIN_TOKEN:**

Sửa `.env`:

```env
ADMIN_TOKEN=<new-32-char-random>
```

Restart Node, vào admin nhập token mới.

---

## 15. Update / Upgrade

### Update project (khi team dev release version mới)

```bash
cd /opt/chatbot/hospital-chatbot-studio

# Backup trước
docker exec hospital-demo-mysql \
  mysqldump -u root -p<pass> --all-databases > /backup/pre-update-$(date +%Y%m%d).sql

# Stop Node app
sudo systemctl stop hospital-chatbot

# Pull code mới
git pull origin main

# Install deps mới (nếu có)
npm install

# Chạy migration SQL nếu có (xem release notes)
docker exec -i hospital-demo-mysql mysql -u root -p<pass> hospital_demo < sql/00X_migration.sql

# Restart
sudo systemctl start hospital-chatbot
sudo systemctl status hospital-chatbot
```

### Update Docker images

```bash
cd /opt/chatbot/hospital-chatbot-studio
docker compose pull
docker compose up -d
```

### Update Ollama model

```bash
docker exec -it ollama ollama pull qwen2.5:7b-instruct-q4_K_M
docker restart anythingllm
```

---

## 16. Liên hệ team dev

| Vấn đề                  | Cách báo                                   |
| ----------------------- | ------------------------------------------ |
| Bug code                | Issue GitHub + log + screenshot Admin Logs |
| Feature mới             | Spec rõ ràng + use case                    |
| Performance issue       | Kèm số liệu: latency, RAM, CPU, GPU usage  |
| Khẩn cấp (chatbot down) | Liên hệ trực tiếp + log                    |

### Khi tạo bug report, cung cấp:

1. **OS + version**: vd "Ubuntu 22.04, Docker 24.0.5"
2. **GPU**: có không, model gì
3. **Log Node app**: `journalctl -u hospital-chatbot --since "30 min ago" > log.txt`
4. **Log containers**: `docker logs <container> --tail 100 > <name>.log`
5. **Steps reproduce**: hành động chính xác → kết quả lỗi
6. **Expected vs Actual**: mong đợi gì, thực tế gì

---

## Phụ lục: Commands hay dùng

```bash
# Status tất cả
docker ps && sudo systemctl status hospital-chatbot

# Log tổng hợp 1 dòng
docker compose logs --tail=20

# Restart toàn bộ
cd /opt/chatbot/hospital-chatbot-studio
docker compose restart
sudo systemctl restart hospital-chatbot

# Check disk
df -h && docker system df

# Backup nhanh
docker exec hospital-demo-mysql mysqldump -u root -p<pass> --all-databases > /backup/db-quick.sql

# Test endpoint
curl http://localhost:8080/api/health

# Test chat (debug)
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"xin chào"}'
```

---

**Phiên bản**: v2.5  
**Đối tượng**: Bộ phận IT  
**Cập nhật cuối**: 2026-05
