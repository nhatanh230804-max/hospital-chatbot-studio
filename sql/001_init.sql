SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS departments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  visit_date DATE NOT NULL,
  visits INT NOT NULL DEFAULT 0
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Đổi từ `procedures` (reserved word MySQL) sang `hospital_procedures`
CREATE TABLE IF NOT EXISTS hospital_procedures (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  department VARCHAR(100),
  steps TEXT,
  updated_at DATE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_schedules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  staff_name VARCHAR(150) NOT NULL,
  role_name VARCHAR(100) NOT NULL,
  department VARCHAR(100) NOT NULL,
  shift_date DATE NOT NULL,
  shift_time VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_feedback (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_question TEXT NOT NULL,
  bot_answer TEXT NOT NULL,
  user_correction TEXT,
  feedback_type VARCHAR(50) DEFAULT 'correction',
  status VARCHAR(50) DEFAULT 'pending',
  reviewed_by VARCHAR(100),
  reviewed_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approved_medical_faq (
  id INT AUTO_INCREMENT PRIMARY KEY,
  topic VARCHAR(255) NOT NULL,
  keywords TEXT NOT NULL,
  answer LONGTEXT NOT NULL,
  source_file VARCHAR(500),
  source_file_name VARCHAR(255),
  approved_by VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS research_answer_cache (
  id INT AUTO_INCREMENT PRIMARY KEY,
  normalized_question VARCHAR(255) NOT NULL UNIQUE,
  original_question TEXT NOT NULL,
  answer LONGTEXT NOT NULL,
  source VARCHAR(100),
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS schema_metadata (
  id INT AUTO_INCREMENT PRIMARY KEY,
  table_name VARCHAR(100) NOT NULL,
  connection_id INT DEFAULT NULL,
  connection_database VARCHAR(100) DEFAULT NULL,
  domain VARCHAR(100),
  description TEXT,
  columns_json JSON NOT NULL,
  examples_json JSON,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chatbot_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  keywords TEXT NOT NULL,
  file_url TEXT NOT NULL,
  category VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_message TEXT NOT NULL,
  route_name VARCHAR(100),
  ai_sql TEXT,
  final_sql TEXT,
  bot_reply LONGTEXT,
  source VARCHAR(100),
  latency_ms INT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ============================================================
-- BẢNG MỚI: SQL Templates ("Hàm SQL" trong class Dạy SQL)
-- Mỗi template = 1 cặp (câu hỏi mẫu tiếng Việt, SQL SELECT mẫu)
-- Backend dùng để:
--   1. Match trực tiếp câu hỏi user qua keywords → trả SQL ngay (không gọi AI)
--   2. Đưa vào prompt AnythingLLM như few-shot examples
-- ============================================================
CREATE TABLE IF NOT EXISTS sql_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  connection_id INT DEFAULT NULL,
  connection_database VARCHAR(100) DEFAULT NULL,
  description TEXT,
  question_pattern TEXT NOT NULL,
  keywords TEXT NOT NULL,
  sql_template LONGTEXT NOT NULL,
  category VARCHAR(100),
  created_by VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  usage_count INT DEFAULT 0,
  last_used_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ============================================================
-- BẢNG MỚI: Trusted Sources (Nguồn tra cứu cho phép)
-- Admin paste URL/domain, chatbot CHỈ được lấy thông tin từ các nguồn này
-- ============================================================
CREATE TABLE IF NOT EXISTS trusted_sources (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  url TEXT NOT NULL,
  domain VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  language VARCHAR(50) DEFAULT 'vi',
  trust_level VARCHAR(50) DEFAULT 'high',
  added_by VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX idx_trusted_domain ON trusted_sources(domain);
CREATE INDEX idx_trusted_active ON trusted_sources(is_active);

CREATE INDEX idx_staff_shift_date ON staff_schedules(shift_date);
CREATE INDEX idx_staff_status ON staff_schedules(status);
CREATE INDEX idx_staff_date_status ON staff_schedules(shift_date, status);
CREATE INDEX idx_staff_department ON staff_schedules(department);
CREATE INDEX idx_departments_visit_date ON departments(visit_date);
CREATE INDEX idx_departments_name ON departments(name);
CREATE INDEX idx_sql_templates_active ON sql_templates(is_active);
CREATE INDEX idx_faq_active ON approved_medical_faq(is_active);
CREATE INDEX idx_schema_connection ON schema_metadata(connection_id);
CREATE INDEX idx_template_connection ON sql_templates(connection_id);

-- Seed data
INSERT INTO departments (id, name, visit_date, visits) VALUES
  (1, 'Khoa Nội', '2026-05-05', 120),
  (2, 'Khoa Ngoại', '2026-05-05', 80),
  (3, 'Khoa Nhi', '2026-05-05', 95),
  (4, 'Khoa Cấp cứu', '2026-05-05', 150)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), visit_date = VALUES(visit_date), visits = VALUES(visits);

INSERT INTO hospital_procedures (id, code, title, department, steps, updated_at) VALUES
  (1, 'QT-001', 'Tiếp nhận bệnh nhân ngoại trú', 'Quầy tiếp nhận', '1. Kiểm tra CCCD/BHYT.\n2. Tạo hồ sơ bệnh nhân.\n3. Phân khoa khám.\n4. In phiếu khám và hướng dẫn bệnh nhân.', '2026-05-01'),
  (2, 'QT-002', 'Quy trình cấp cứu ban đầu', 'Khoa Cấp cứu', '1. Phân loại mức độ khẩn cấp.\n2. Đo dấu hiệu sinh tồn.\n3. Báo bác sĩ trực.\n4. Ghi nhận xử trí ban đầu.', '2026-05-01'),
  (3, 'QT-003', 'Chỉ định xét nghiệm', 'Cận lâm sàng', '1. Bác sĩ tạo chỉ định.\n2. Điều dưỡng in mã xét nghiệm.\n3. Lấy mẫu.\n4. Trả kết quả lên hệ thống.', '2026-05-01'),
  (4, 'QT-004', 'Xuất viện', 'Khoa điều trị', '1. Bác sĩ xác nhận đủ điều kiện xuất viện.\n2. Điều dưỡng hoàn tất hồ sơ.\n3. Thanh toán viện phí.\n4. Cấp đơn thuốc và lịch tái khám.', '2026-05-01')
ON DUPLICATE KEY UPDATE
  code = VALUES(code), title = VALUES(title), department = VALUES(department), steps = VALUES(steps), updated_at = VALUES(updated_at);

INSERT INTO staff_schedules (id, staff_name, role_name, department, shift_date, shift_time, status) VALUES
  (1, 'Nguyễn Minh Anh', 'Bác sĩ', 'Khoa Nhi', '2026-05-07', '07:00 - 15:00', 'Đang trực'),
  (2, 'Trần Quốc Huy', 'Điều dưỡng', 'Khoa Cấp cứu', '2026-05-07', '07:00 - 19:00', 'Đang trực'),
  (3, 'Lê Thu Hà', 'Bác sĩ', 'Khoa Nhi', '2026-05-07', '15:00 - 23:00', 'Sắp trực'),
  (4, 'Phạm Gia Bảo', 'Kỹ thuật viên', 'Cận lâm sàng', '2026-05-07', '08:00 - 16:00', 'Đang trực'),
  (5, 'Nguyễn Hoàng Nam', 'Bác sĩ', 'Khoa Nội', '2026-05-08', '07:00 - 15:00', 'Đang trực'),
  (6, 'Trần Mỹ Linh', 'Điều dưỡng', 'Khoa Cấp cứu', '2026-05-08', '07:00 - 19:00', 'Đang trực'),
  (7, 'Phạm Ngọc Anh', 'Kỹ thuật viên', 'Cận lâm sàng', '2026-05-08', '08:00 - 16:00', 'Đang trực'),
  (8, 'Lê Quang Huy', 'Bác sĩ', 'Khoa Ngoại', '2026-05-08', '15:00 - 23:00', 'Sắp trực'),
  (9, 'Mai Khánh', 'Điều dưỡng', 'Khoa Nhi', '2026-05-08', '15:00 - 23:00', 'Sắp trực')
ON DUPLICATE KEY UPDATE
  staff_name = VALUES(staff_name), role_name = VALUES(role_name), department = VALUES(department), shift_date = VALUES(shift_date), shift_time = VALUES(shift_time), status = VALUES(status);

INSERT INTO chatbot_documents (id, title, keywords, file_url, category, is_active) VALUES
  (1, 'Bảng giá dịch vụ', 'bang gia|bang gia dich vu|gia dich vu|vien phi|file bang gia|bảng giá|bảng giá dịch vụ', '/documents/bang-gia-dich-vu.txt', 'pricing', TRUE)
ON DUPLICATE KEY UPDATE title = VALUES(title), keywords = VALUES(keywords), file_url = VALUES(file_url), category = VALUES(category), is_active = VALUES(is_active);

INSERT INTO schema_metadata (id, table_name, domain, description, columns_json, examples_json, is_active) VALUES
  (1, 'departments', 'visits', 'Bảng thống kê lượt khám theo khoa/phòng trong bệnh viện.',
   JSON_ARRAY(
    JSON_OBJECT('name','id','type','INT','description','ID khoa'),
    JSON_OBJECT('name','name','type','VARCHAR','description','Tên khoa'),
    JSON_OBJECT('name','visit_date','type','DATE','description','Ngày thống kê lượt khám'),
    JSON_OBJECT('name','visits','type','INT','description','Số lượt khám')
   ),
   JSON_ARRAY(
    JSON_OBJECT('question','Khoa nào có lượt khám cao nhất?','sql','SELECT name, visits FROM departments ORDER BY visits DESC LIMIT 1'),
    JSON_OBJECT('question','Mỗi khoa có bao nhiêu lượt khám?','sql','SELECT name, visits FROM departments ORDER BY visits DESC LIMIT 20')
   ), TRUE),
  (2, 'staff_schedules', 'staff', 'Bảng lịch trực/lịch làm việc của nhân sự bệnh viện.',
   JSON_ARRAY(
    JSON_OBJECT('name','staff_name','type','VARCHAR','description','Tên nhân sự'),
    JSON_OBJECT('name','role_name','type','VARCHAR','description','Vai trò'),
    JSON_OBJECT('name','department','type','VARCHAR','description','Khoa/phòng'),
    JSON_OBJECT('name','shift_date','type','DATE','description','Ngày trực'),
    JSON_OBJECT('name','shift_time','type','VARCHAR','description','Ca trực'),
    JSON_OBJECT('name','status','type','VARCHAR','description','Trạng thái lịch trực','enum', JSON_ARRAY('Đang trực','Sắp trực','Dự kiến'))
   ),
   JSON_ARRAY(
    JSON_OBJECT('question','Hôm nay có bao nhiêu nhân sự đang trực?','sql','SELECT COUNT(*) AS total FROM staff_schedules WHERE shift_date = ''{DEMO_TODAY}'' AND status = ''Đang trực'''),
    JSON_OBJECT('question','Hôm nay có ai trực?','sql','SELECT staff_name, role_name, department, shift_date, shift_time, status FROM staff_schedules WHERE shift_date = ''{DEMO_TODAY}'' AND status = ''Đang trực'' LIMIT 20')
   ), TRUE)
ON DUPLICATE KEY UPDATE table_name = VALUES(table_name), domain = VALUES(domain), description = VALUES(description), columns_json = VALUES(columns_json), examples_json = VALUES(examples_json), is_active = VALUES(is_active);

-- Seed SQL Templates (hàm SQL mẫu)
INSERT INTO sql_templates (id, name, description, question_pattern, keywords, sql_template, category, created_by, is_active) VALUES
  (1, 'Lượt khám của một khoa cụ thể',
   'Trả về số lượt khám của khoa được hỏi đến tên.',
   'Khoa {tên_khoa} có bao nhiêu lượt khám?',
   'luot kham|so luot kham|khoa noi|khoa ngoai|khoa nhi|khoa cap cuu',
   'SELECT name, visits FROM departments WHERE name LIKE ''%{department}%'' LIMIT 5',
   'visits', 'seed', TRUE),
  (2, 'Khoa có lượt khám cao nhất',
   'Sắp xếp khoa theo lượt khám giảm dần và lấy 1 kết quả.',
   'Khoa nào có lượt khám cao nhất / nhiều nhất / đông nhất?',
   'cao nhat|nhieu nhat|dong nhat|top 1|khoa nao co luot kham cao',
   'SELECT name, visits FROM departments ORDER BY visits DESC LIMIT 1',
   'visits', 'seed', TRUE),
  (3, 'Lượt khám tất cả khoa',
   'Trả về danh sách tất cả khoa kèm số lượt khám.',
   'Lượt khám của mỗi khoa / từng khoa / các khoa?',
   'moi khoa|tung khoa|cac khoa|theo khoa|tat ca khoa',
   'SELECT name, visits FROM departments ORDER BY visits DESC LIMIT 20',
   'visits', 'seed', TRUE),
  (4, 'Đếm nhân sự đang trực hôm nay',
   'Đếm số bản ghi nhân sự có status Đang trực vào ngày demo.',
   'Hôm nay có bao nhiêu nhân sự đang trực?',
   'bao nhieu nhan su|so luong nhan su|dem nhan su dang truc|hom nay dang truc',
   'SELECT COUNT(*) AS total FROM staff_schedules WHERE shift_date = ''{DEMO_TODAY}'' AND status = ''Đang trực''',
   'staff', 'seed', TRUE),
  (5, 'Danh sách nhân sự đang trực hôm nay',
   'Trả về danh sách chi tiết nhân sự đang trực hôm nay.',
   'Hôm nay có ai trực / Ai đang trực hôm nay?',
   'hom nay co ai truc|ai dang truc|danh sach nhan su truc|ai truc hom nay',
   'SELECT staff_name, role_name, department, shift_time, status FROM staff_schedules WHERE shift_date = ''{DEMO_TODAY}'' AND status = ''Đang trực'' LIMIT 20',
   'staff', 'seed', TRUE)
ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), question_pattern = VALUES(question_pattern), keywords = VALUES(keywords), sql_template = VALUES(sql_template), is_active = VALUES(is_active);

-- Seed Trusted Sources (nguồn tra cứu y tế uy tín)
INSERT INTO trusted_sources (id, name, url, domain, description, category, language, trust_level, added_by, is_active) VALUES
  (1, 'Mayo Clinic', 'https://www.mayoclinic.org', 'mayoclinic.org', 'Bệnh viện và tổ chức nghiên cứu y khoa của Mỹ, nguồn thông tin y tế uy tín hàng đầu.', 'medical', 'en', 'high', 'seed', TRUE),
  (2, 'Cleveland Clinic', 'https://my.clevelandclinic.org', 'clevelandclinic.org', 'Bệnh viện và tổ chức nghiên cứu y khoa hàng đầu của Mỹ.', 'medical', 'en', 'high', 'seed', TRUE),
  (3, 'MedlinePlus', 'https://medlineplus.gov', 'medlineplus.gov', 'Dịch vụ thông tin sức khỏe của Thư viện Y khoa Quốc gia Hoa Kỳ (NIH).', 'medical', 'en', 'high', 'seed', TRUE),
  (4, 'NHS UK', 'https://www.nhs.uk', 'nhs.uk', 'Dịch vụ Y tế Quốc gia Vương quốc Anh.', 'medical', 'en', 'high', 'seed', TRUE),
  (5, 'CDC', 'https://www.cdc.gov', 'cdc.gov', 'Trung tâm Kiểm soát và Phòng ngừa Dịch bệnh Hoa Kỳ.', 'medical', 'en', 'high', 'seed', TRUE),
  (6, 'WHO', 'https://www.who.int', 'who.int', 'Tổ chức Y tế Thế giới.', 'medical', 'en', 'high', 'seed', TRUE),
  (7, 'Bộ Y tế Việt Nam', 'https://moh.gov.vn', 'moh.gov.vn', 'Cổng thông tin chính thức Bộ Y tế Việt Nam.', 'medical', 'vi', 'high', 'seed', TRUE),
  (8, 'Vinmec', 'https://www.vinmec.com', 'vinmec.com', 'Hệ thống Y tế Vinmec, tài liệu sức khỏe tiếng Việt.', 'medical', 'vi', 'medium', 'seed', TRUE)
ON DUPLICATE KEY UPDATE name = VALUES(name), url = VALUES(url), domain = VALUES(domain), description = VALUES(description), is_active = VALUES(is_active);

-- Seed FAQ mẫu
INSERT INTO approved_medical_faq (id, topic, keywords, answer, approved_by, is_active) VALUES
  (1, 'Triệu chứng tiểu đường', 'tiểu đường|tieu duong|đái tháo đường|dai thao duong|diabetes|triệu chứng tiểu đường|dấu hiệu tiểu đường', 'Một số triệu chứng thường gặp của tiểu đường có thể gồm:\n\n- Đi tiểu nhiều, đặc biệt là ban đêm.\n- Khát nước nhiều hơn bình thường.\n- Đói nhiều hoặc nhanh đói.\n- Mệt mỏi, uể oải.\n- Sụt cân không rõ lý do.\n- Nhìn mờ.\n- Vết thương lâu lành.\n- Tê hoặc châm chích ở tay/chân.\n\nCác triệu chứng này không đủ để tự kết luận là tiểu đường. Nếu nghi ngờ, bạn nên đi khám hoặc xét nghiệm đường huyết.', 'seed', TRUE),
  (2, 'Triệu chứng hen suyễn', 'hen suyễn|hen xuyễn|hen suyen|hen xuyen|asthma|triệu chứng hen', 'Một số triệu chứng thường gặp của hen suyễn có thể gồm:\n\n- Khò khè khi thở.\n- Khó thở.\n- Tức ngực hoặc nặng ngực.\n- Ho kéo dài, thường nặng hơn về đêm hoặc sáng sớm.\n\nNếu khó thở nhiều, tím tái, nói không thành câu hoặc triệu chứng không giảm, hãy liên hệ cấp cứu ngay.', 'seed', TRUE)
ON DUPLICATE KEY UPDATE topic = VALUES(topic), keywords = VALUES(keywords), answer = VALUES(answer), is_active = VALUES(is_active);

-- ============================================================
-- BẢNG MỚI v2.1: Data Connections (kết nối DB/storage bên ngoài)
-- Pluggable adapter pattern: MySQL, PostgreSQL, MinIO, ... mỗi loại 1 adapter
-- config_json: lưu config tuỳ theo type
--   - mysql/postgres: {host, port, user, password, database}
--   - minio: {endpoint, port, useSSL, accessKey, secretKey, bucket, region}
-- ============================================================
CREATE TABLE IF NOT EXISTS data_connections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL,
  description TEXT,
  config_json JSON NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  last_test_at DATETIME,
  last_test_status VARCHAR(50),
  last_test_message TEXT,
  created_by VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX idx_data_conn_type ON data_connections(type);
CREATE INDEX idx_data_conn_active ON data_connections(is_active);

-- ============================================================
-- BẢNG MỚI v2.1: MinIO indexed files
-- Cache metadata các object trong bucket để search nhanh
-- ============================================================
CREATE TABLE IF NOT EXISTS minio_indexed_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  connection_id INT NOT NULL,
  bucket VARCHAR(100) NOT NULL,
  object_key VARCHAR(500) NOT NULL,
  object_name VARCHAR(255),
  size_bytes BIGINT,
  content_type VARCHAR(100),
  etag VARCHAR(100),
  last_modified DATETIME,
  keywords TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  indexed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (connection_id) REFERENCES data_connections(id) ON DELETE CASCADE,
  UNIQUE KEY uq_minio_object (connection_id, bucket, object_key(255))
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX idx_minio_bucket ON minio_indexed_files(bucket);
CREATE INDEX idx_minio_active ON minio_indexed_files(is_active);
CREATE INDEX idx_minio_name ON minio_indexed_files(object_name);
