# Hospital Chatbot Studio v2.5

Chatbot bệnh viện đa năng với admin studio quản lý nội dung không cần code.

## Tính năng chính

- **FAQ + Upload tài liệu**: Quản lý câu hỏi thường gặp, upload file (.txt/.md/.docx/.pdf)
- **NL2SQL multi-DB**: User hỏi câu thường, chatbot tự sinh SQL truy vấn DB
- **SQL Templates**: Tạo "hàm SQL" cho câu hỏi hay gặp - chạy nhanh không cần AI
- **MinIO Files**: Quản lý kho file PDF, gửi link presigned URL cho user
- **Trusted Sources**: Whitelist nguồn web cho Research Mode
- **Multi-DB**: Hỗ trợ chatbot query nhiều database khác nhau qua 1 chatbot duy nhất
- **AI-powered reply**: Kết quả SQL được AI diễn giải thành câu trả lời tự nhiên
- **Iframe + Widget embed**: Nhúng chatbot vào web khác bằng iframe hoặc 1 dòng script

## Stack

- **Backend**: Node.js 20 + Express ESM
- **Database**: MySQL 8 (Docker)
- **Storage**: MinIO (Docker)
- **AI**: AnythingLLM + Ollama qwen2.5:7b/3b (Docker, GPU optional)
- **Frontend**: Vanilla JS (admin), HTML/JS (user chat)

## Tài liệu

- **HUONG-DAN-ADMIN.md**: Hướng dẫn người quản lý nội dung
- **HUONG-DAN-IT.md**: Hướng dẫn IT vận hành server
- **.env.production**: Template cấu hình deploy

## Quick start (dev local)

```bash
docker compose up -d
cp .env.example .env
# Sửa .env với password
npm install
npm start
```

Mở:
- User chat: http://localhost:8080
- Admin Studio: http://localhost:8080/admin.html
- Embed test: http://localhost:8080/embed.html

## Deploy nội bộ

Xem `HUONG-DAN-IT.md` mục 4.

## Nhúng widget vào web khác

```html
<script>
  window.HospitalChatbotConfig = {
    apiBase: 'http://192.168.1.50:8080',
    title: 'Trợ lý BV',
    primaryColor: '#0f5ea8'
  };
</script>
<script src="http://192.168.1.50:8080/widget.js"></script>
```