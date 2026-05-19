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
8. [Backup](#8-backup)
9. [Restore từ backup](#9-restore-từ-backup)
10. [Monitoring](#10-monitoring)
11. [Restart khi gặp vấn đề](#11-restart-khi-gặp-vấn-đề)
12. [Troubleshooting](#12-troubleshooting)
13. [Security Checklist](#13-security-checklist)
14. [Update / Upgrade](#14-update--upgrade)
15. [Liên hệ team dev](#15-liên-hệ-team-dev)

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
│   │  hospital-chatbot-studio-v2              │       │
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

| Mục | Tối thiểu | Khuyến nghị |
|---|---|---|
| OS | Windows 10/11 hoặc Ubuntu 22.04 LTS | Ubuntu Server 22.04 LTS |
| RAM | 16 GB | 32 GB |
| CPU | 4 cores | 8+ cores |
| GPU | (không bắt buộc) | NVIDIA 6GB+ VRAM (RTX 3060/4060+) |
| Disk | 50 GB SSD trống | 100+ GB SSD |
| Network | LAN, IP tĩnh | LAN gigabit, IP tĩnh |

### Không có GPU - 2 lựa chọn

| Phương án | Pros | Cons |
|---|---|---|
| Dùng `qwen2.5:3b` CPU | Free, offline | Latency 30-60s/câu |
| Chuyển OpenAI API | Nhanh (~2s/câu) | Cần internet + thẻ (~5-10 USD/tháng) |

→ Recommendation: **GPU 6GB+ VRAM** là sweet spot.

### Phần mềm

- Docker Desktop (Windows) hoặc Docker Engine (Linux) ≥ 20.10
- Node.js 20.x LTS
- Git
- NVIDIA Container Toolkit (nếu có GPU)
- Trình duyệt

---

## 4. Các service cần chạy

| Service | Loại | Port | Mục đích |
|---|---|---|---|
| `hospital-demo-mysql-v2` | Docker | 3306 | DB chính + DB billing |
| `hospital-minio-v2` | Docker | 9000, 9001 | Kho file PDF |
| `ollama` | Docker | 11434 | AI inference |
| `anythingllm` | Docker | 3001 | AI workspace + RAG |
| `node server.js` | Process | 8080 | Backend + admin UI |

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
git clone https://github.com/<your-org>/hospital-chatbot-studio-v2.git
git clone https://github.com/<your-org>/anythingllm-stack.git
```

### Bước 5: Cấu hình `.env` Node app

```bash
cd hospital-chatbot-studio-v2
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
docker logs hospital-demo-mysql-v2 --tail 5
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
cd ../hospital-chatbot-studio-v2
npm install
npm start
```

Phải thấy:
```
✅ MySQL connected
🏥 Hospital Chatbot Studio v2 running at http://localhost:8080
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
   - **Startup directory**: `C:\chatbot\hospital-chatbot-studio-v2`
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
WorkingDirectory=/opt/chatbot/hospital-chatbot-studio-v2
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

| Port | Service | Hướng | Cho ai |
|---|---|---|---|
| 8080 | Node chatbot | Inbound LAN | Máy client trong LAN |
| 3001 | AnythingLLM | Localhost | Node app |
| 9000 | MinIO API | Localhost | Node app |
| 9001 | MinIO Console | Inbound LAN (optional) | IT/Admin upload file |
| 3306 | MySQL | Localhost | Node app |
| 11434 | Ollama | Localhost | AnythingLLM |

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

## 8. Backup

### Mức độ ưu tiên

| Loại | Tần suất | Lý do |
|---|---|---|
| MySQL (FAQ, template, schema, logs) | Hàng ngày | Mất = admin làm lại từ đầu |
| MinIO (file PDF) | Hàng tuần | File ít thay đổi |
| AnythingLLM workspace | Hàng tuần | Cache + setting |
| `.env` | Khi thay đổi | Chứa password |

### Backup MySQL hàng ngày

**Manual:**
```bash
docker exec hospital-demo-mysql-v2 \
  mysqldump -u root -p<password> --all-databases > /backup/db-$(date +%Y%m%d).sql
```

**Cron Linux:**
```bash
# crontab -e
0 2 * * * docker exec hospital-demo-mysql-v2 mysqldump -u root -p<password> \
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
  -v hospital-chatbot-studio-v2_hospital_minio_data_v2:/data \
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

## 9. Restore từ backup

### Restore MySQL

```bash
sudo systemctl stop hospital-chatbot

docker exec -i hospital-demo-mysql-v2 mysql -u root -p<password> < /backup/db-20260513.sql

# Verify
docker exec hospital-demo-mysql-v2 mysql -u root -p<password> -e "SHOW DATABASES;"

sudo systemctl start hospital-chatbot
```

### Restore MinIO

```bash
docker stop hospital-minio-v2

docker run --rm \
  -v hospital-chatbot-studio-v2_hospital_minio_data_v2:/data \
  -v /backup:/backup \
  busybox tar xzf /backup/minio-20260513.tar.gz -C /

docker start hospital-minio-v2
```

---

## 10. Monitoring

### Service status

```bash
docker ps

# Log từng service
docker logs hospital-demo-mysql-v2 --tail 50
docker logs hospital-minio-v2 --tail 50
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

## 11. Restart khi gặp vấn đề

```bash
# Restart 1 service
docker restart hospital-demo-mysql-v2

# Restart cả stack chatbot
cd /opt/chatbot/hospital-chatbot-studio-v2
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

## 12. Troubleshooting

### Lỗi: "MySQL not connected"

```bash
docker logs hospital-demo-mysql-v2 --tail 30

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

## 13. Security Checklist

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
docker exec -it hospital-demo-mysql-v2 mysql -u root -p<root-pass>
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
docker compose up -d --force-recreate hospital-minio-v2
```
Vào Admin Studio → sửa connection MinIO → đổi Secret Key.

**ADMIN_TOKEN:**

Sửa `.env`:
```env
ADMIN_TOKEN=<new-32-char-random>
```
Restart Node, vào admin nhập token mới.

---

## 14. Update / Upgrade

### Update project (khi team dev release version mới)

```bash
cd /opt/chatbot/hospital-chatbot-studio-v2

# Backup trước
docker exec hospital-demo-mysql-v2 \
  mysqldump -u root -p<pass> --all-databases > /backup/pre-update-$(date +%Y%m%d).sql

# Stop Node app
sudo systemctl stop hospital-chatbot

# Pull code mới
git pull origin main

# Install deps mới (nếu có)
npm install

# Chạy migration SQL nếu có (xem release notes)
docker exec -i hospital-demo-mysql-v2 mysql -u root -p<pass> hospital_demo < sql/00X_migration.sql

# Restart
sudo systemctl start hospital-chatbot
sudo systemctl status hospital-chatbot
```

### Update Docker images

```bash
cd /opt/chatbot/hospital-chatbot-studio-v2
docker compose pull
docker compose up -d
```

### Update Ollama model

```bash
docker exec -it ollama ollama pull qwen2.5:7b-instruct-q4_K_M
docker restart anythingllm
```

---

## 15. Liên hệ team dev

| Vấn đề | Cách báo |
|---|---|
| Bug code | Issue GitHub + log + screenshot Admin Logs |
| Feature mới | Spec rõ ràng + use case |
| Performance issue | Kèm số liệu: latency, RAM, CPU, GPU usage |
| Khẩn cấp (chatbot down) | Liên hệ trực tiếp + log |

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
cd /opt/chatbot/hospital-chatbot-studio-v2
docker compose restart
sudo systemctl restart hospital-chatbot

# Check disk
df -h && docker system df

# Backup nhanh
docker exec hospital-demo-mysql-v2 mysqldump -u root -p<pass> --all-databases > /backup/db-quick.sql

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