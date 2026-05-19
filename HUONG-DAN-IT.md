# HƯỚNG DẪN IT - VẬN HÀNH HỆ THỐNG CHATBOT

Tài liệu cho bộ phận IT quản lý server.

---

## 1. KIẾN TRÚC HỆ THỐNG

```
┌──────────────────────────────────────────────────────┐
│                  MÁY CLIENT (LAN)                    │
│ Bác sĩ/y tá/nhân viên truy cập http://<IP-server>:808│
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
│  │ My SQL  │    │AnythingLLM│    │  MinIO    │       │
│  │ :33 06  │    │  + Ollama │    │ :9000     │       │
│  │         │    │   :3001   │    │           │       │
│  └─────────┘    └───────────┘    └───────────┘       │
│                                                      │
│  Tất cả chạy bằng Docker, trừ Node app (chạy native) │
└──────────────────────────────────────────────────────┘
```

---

## 2. YÊU CẦU SERVER

### Tối thiểu:
- OS: Windows 10/11 hoặc Ubuntu 22.04 LTS
- RAM: 16GB
- CPU: 4 cores
- Disk: 50GB free
- Network: kết nối LAN cố định, IP tĩnh

### Khuyến nghị:
- RAM: 32GB
- CPU: 8+ cores
- GPU: NVIDIA với 6GB+ VRAM (RTX 3060/4060 trở lên)
- Disk: SSD 100GB

### Không GPU:
- Phải dùng model nhỏ (qwen2.5:3b) → chậm 30-60s/câu
- Hoặc chuyển AnythingLLM sang OpenAI API (cần internet + thẻ visa)

---

## 3. CÁC SERVICE CẦN CHẠY

| Service | Loại | Port | Mục đích |
|---------|------|------|----------|
| `hospital-demo-mysql-v2` | Docker container | 3306 | Database chính + DB billing |
| `hospital-minio-v2` | Docker container | 9000, 9001 | Kho file PDF, biểu mẫu |
| `ollama` | Docker container | 11434 | AI inference engine |
| `anythingllm` | Docker container | 3001 | AI workspace + RAG |
| `node server.js` | Process Node | 8080 | Chatbot backend + admin web |

---

## 4. CÀI ĐẶT BAN ĐẦU

### Bước 1: Cài Docker

**Windows:**
- Tải Docker Desktop: https://www.docker.com/products/docker-desktop
- Cài, đăng nhập, đảm bảo dùng WSL2 backend
- Nếu có GPU: Settings → Resources → WSL Integration → enable

**Ubuntu:**
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

### Bước 2: Cài Node.js

**Windows:**
- Tải Node.js LTS từ https://nodejs.org (chọn version 20.x)
- Cài

**Ubuntu:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### Bước 3: Cài NVIDIA Container Toolkit (nếu có GPU)

**Windows:** Docker Desktop tự handle, chỉ cần đảm bảo driver NVIDIA mới nhất

**Ubuntu:**
```bash
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo systemctl restart docker
```

### Bước 4: Copy project lên server

Copy 2 folder qua server:
- `hospital-chatbot-studio-v2` → `C:\chatbot\hospital-chatbot-studio-v2` (Windows) hoặc `/opt/chatbot/hospital-chatbot-studio-v2` (Linux)
- `anythingllm-stack` → tương tự

### Bước 5: Cấu hình `.env` cho Node app

Trong `hospital-chatbot-studio-v2`:
```bash
cp .env.production .env
# Mở .env, đổi mọi placeholder <...> sang giá trị thật
```

Generate password mạnh:
```powershell
# Windows
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | % {[char]$_})
```
```bash
# Linux
openssl rand -base64 32
```

### Bước 6: Cấu hình MySQL password trong docker-compose

Mở `docker-compose.yml`, đổi `MYSQL_ROOT_PASSWORD` và `MYSQL_PASSWORD`:
```yaml
environment:
  MYSQL_ROOT_PASSWORD: <password mạnh>
  MYSQL_PASSWORD: <password mạnh - phải khớp với DB_PASSWORD trong .env>
```

### Bước 7: Start MySQL + MinIO

```bash
cd hospital-chatbot-studio-v2
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
```

Đợi 1-2 phút. Verify:
```bash
docker compose ps
```

### Bước 9: Pull model cho Ollama

```bash
# Embedding model (~280MB)
docker exec -it ollama ollama pull nomic-embed-text

# Chat model - chọn 1 trong 2:
# Nếu có GPU 4GB+ VRAM:
docker exec -it ollama ollama pull qwen2.5:7b-instruct-q4_K_M

# Nếu không GPU hoặc GPU yếu:
docker exec -it ollama ollama pull qwen2.5:3b
```

### Bước 10: Onboarding AnythingLLM

Mở `http://<IP-server>:3001`:

1. Tạo admin account (lưu mật khẩu cẩn thận!)
2. LLM Preference:
   - Provider: Ollama
   - Base URL: `http://ollama:11434`
   - Model: `qwen2.5:7b-instruct-q4_K_M` hoặc `qwen2.5:3b`
   - Context window: 4096 (cho 3b), 8192 (cho 7b)
3. Embedding: Ollama / `nomic-embed-text` / 8192
4. Vector DB: LanceDB (mặc định)
5. Multi-user: Single user

### Bước 11: Tạo workspace `test-chatbot-bv`

Sidebar trái → **+ New Workspace** → tên: `test-chatbot-bv` → Save.

⚠️ Tên workspace PHẢI chính xác là `test-chatbot-bv` (lowercase, dấu nối). Verify URL workspace là `http://<IP-server>:3001/workspace/test-chatbot-bv`.

### Bước 12: Generate API key

Settings → Tools → Developer API → **+ Generate New API Key** → đặt tên → Copy key.

Paste key vào `.env` của Node app:
```env
ANYTHINGLLM_API_KEY=<key vừa copy>
```

### Bước 13: Install + start Node app

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

### Bước 14: Test từ máy client

Mở browser ở máy khác trong LAN: `http://<IP-server>:8080`

Phải load được chatbot.

### Bước 15: Mở port firewall (Windows)

```powershell
# PowerShell Admin
New-NetFirewallRule -DisplayName "Hospital Chatbot 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

(MySQL 3306, MinIO 9000, AnythingLLM 3001 KHÔNG cần mở ra ngoài, chỉ truy cập nội bộ trong server)

---

## 5. KHỞI ĐỘNG LẠI SAU REBOOT SERVER

Docker container có flag `restart: unless-stopped` nên tự khởi động khi server boot. Nhưng Node app cần chạy thủ công.

### Cách auto-run Node app khi server boot:

**Windows - dùng NSSM (Non-Sucking Service Manager):**

1. Tải NSSM từ https://nssm.cc/download
2. Giải nén
3. PowerShell admin:
```powershell
nssm install HospitalChatbot
```
4. Trong dialog NSSM:
   - **Path:** `C:\Program Files\nodejs\node.exe`
   - **Startup directory:** `C:\chatbot\hospital-chatbot-studio-v2`
   - **Arguments:** `server.js`
5. Install service
6. Start:
```powershell
nssm start HospitalChatbot
```

**Linux - dùng systemd:**

Tạo `/etc/systemd/system/hospital-chatbot.service`:
```ini
[Unit]
Description=Hospital Chatbot
After=docker.service network.target
Requires=docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/chatbot/hospital-chatbot-studio-v2
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable hospital-chatbot
sudo systemctl start hospital-chatbot
sudo systemctl status hospital-chatbot
```

---

## 6. BACKUP

### Database MySQL (chứa FAQ, templates, schema, logs, feedback):

```bash
docker exec hospital-demo-mysql-v2 \
  mysqldump -u root -p<root-password> --all-databases > backup-$(date +%Y%m%d).sql
```

Setup cron để backup hàng ngày:

**Linux:**
```bash
# crontab -e
0 2 * * * docker exec hospital-demo-mysql-v2 mysqldump -u root -p<password> --all-databases > /backup/db-$(date +\%Y\%m\%d).sql
```

**Windows Task Scheduler:**
Tạo task chạy script `.bat` hàng ngày 2h sáng.

### MinIO files:

```bash
# Backup volume Docker
docker run --rm -v hospital-chatbot-studio-v2_hospital_minio_data_v2:/data -v /backup:/backup busybox tar czf /backup/minio-$(date +%Y%m%d).tar.gz /data
```

### AnythingLLM workspace:

```bash
docker run --rm -v anythingllm-stack_anythingllm_storage:/data -v /backup:/backup busybox tar czf /backup/anythingllm-$(date +%Y%m%d).tar.gz /data
```

---

## 7. RESTORE TỪ BACKUP

### MySQL:
```bash
docker exec -i hospital-demo-mysql-v2 mysql -u root -p<password> < backup-20260513.sql
```

### MinIO:
```bash
docker run --rm -v hospital-chatbot-studio-v2_hospital_minio_data_v2:/data -v /backup:/backup busybox tar xzf /backup/minio-20260513.tar.gz -C /
```

---

## 8. MONITORING

### Check service status:

```bash
# Tất cả containers
docker ps

# Log từng service
docker logs hospital-demo-mysql-v2 --tail 50
docker logs ollama --tail 50
docker logs anythingllm --tail 50

# Node app (nếu chạy systemd)
sudo journalctl -u hospital-chatbot -f
```

### Check disk usage:

```bash
docker system df
# Nếu volumes quá lớn, prune cẩn thận (KHÔNG prune volumes nếu chưa backup)
docker system prune -a  # KHÔNG dùng --volumes
```

### Check resource usage:

```bash
docker stats
```

---

## 9. RESTART KHI SERVICE GẶP VẤN ĐỀ

```bash
# Restart 1 service
docker restart hospital-demo-mysql-v2

# Restart cả stack
cd /opt/chatbot/hospital-chatbot-studio-v2
docker compose restart

# Restart Node app
sudo systemctl restart hospital-chatbot   # Linux
nssm restart HospitalChatbot              # Windows
```

---

## 10. TROUBLESHOOTING

### Lỗi: "MySQL not connected"
```bash
docker logs hospital-demo-mysql-v2 --tail 30
# Check: port 3306 có bị chiếm bởi service khác không?
netstat -ano | findstr :3306   # Windows
ss -tlnp | grep :3306          # Linux
```

### Lỗi: "AnythingLLM phản hồi quá lâu"
- Vào `http://<IP-server>:3001` test workspace trực tiếp
- Check Ollama: `docker exec -it ollama ollama ps` — model có load chưa?
- Nếu CPU 100% → upgrade RAM hoặc đổi sang model nhỏ hơn

### Lỗi: "Sai admin token"
- Check `.env` có dòng `ADMIN_TOKEN=...`
- Restart Node app sau khi đổi `.env`

### Mojibake tiếng Việt
- Đảm bảo file `.sql` lưu UTF-8 (không BOM)
- Đảm bảo client `chcp 65001` khi query trực tiếp
- Driver mysql2 trong code đã set `charset: utf8mb4`

### Chatbot trả lời sai/lạc đề
- Vào Admin Studio → Logs → kiểm tra route + SQL
- Refer HUONG-DAN-ADMIN.md mục 14

---

## 11. SECURITY CHECKLIST KHI DEPLOY

- [ ] Đổi `ADMIN_TOKEN` thành chuỗi ngẫu nhiên 32+ ký tự
- [ ] Đổi MySQL root password
- [ ] Đổi MySQL user password (`hospital_pass` mặc định)
- [ ] Đổi MinIO admin (mặc định `minioadmin/minioadmin123`)
- [ ] AnythingLLM admin password mạnh
- [ ] `.env` set `ALLOWED_ORIGINS` đúng các IP/domain LAN
- [ ] Firewall chỉ mở port 8080 ra LAN (3001/9000/3306 chỉ nội bộ)
- [ ] Backup database hàng ngày
- [ ] Document mật khẩu vào password manager (KHÔNG email)

---

## 12. LIÊN HỆ TEAM DEV

- Bug code → contact dev với log + screenshot
- Cần feature mới → spec rõ ràng, kèm use case
- Performance issue → kèm số liệu (latency, RAM, CPU)
