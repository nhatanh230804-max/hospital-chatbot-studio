-- ============================================================
-- v2.5: Database thứ 2 để test multi-DB
-- File này chạy SAU 001_init.sql (alphabetic order)
-- Tạo DB `hospital_billing` cho data hóa đơn, viện phí
-- ============================================================
SET NAMES utf8mb4;
SET CHARACTER SET utf8mb4;

CREATE DATABASE IF NOT EXISTS hospital_billing
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Cho phép user hospital_user dùng cả 2 DB
GRANT ALL PRIVILEGES ON hospital_billing.* TO 'hospital_user'@'%';
FLUSH PRIVILEGES;

USE hospital_billing;

CREATE TABLE IF NOT EXISTS invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_code VARCHAR(50) NOT NULL,
  patient_name VARCHAR(150) NOT NULL,
  patient_id VARCHAR(50),
  department VARCHAR(100),
  service_type VARCHAR(100),
  amount DECIMAL(12, 2) NOT NULL,
  bhyt_covered DECIMAL(12, 2) DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  issued_date DATE NOT NULL,
  paid_date DATE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX idx_invoices_date ON invoices(issued_date);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_department ON invoices(department);

CREATE TABLE IF NOT EXISTS lab_results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  patient_name VARCHAR(150) NOT NULL,
  test_name VARCHAR(150) NOT NULL,
  result_value VARCHAR(100),
  unit VARCHAR(20),
  reference_range VARCHAR(100),
  test_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'completed'
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX idx_lab_date ON lab_results(test_date);

-- Seed data
INSERT INTO invoices (invoice_code, patient_name, patient_id, department, service_type, amount, bhyt_covered, status, issued_date, paid_date) VALUES
  ('HD2026-0001', 'Nguyễn Văn An', 'BN001', 'Khoa Nội', 'Khám chuyên khoa', 150000, 120000, 'paid', '2026-05-01', '2026-05-01'),
  ('HD2026-0002', 'Trần Thị Hoa', 'BN002', 'Khoa Nhi', 'Khám + Xét nghiệm', 350000, 280000, 'paid', '2026-05-02', '2026-05-02'),
  ('HD2026-0003', 'Lê Quang Bình', 'BN003', 'Khoa Ngoại', 'Phẫu thuật ruột thừa', 8500000, 7225000, 'paid', '2026-05-03', '2026-05-05'),
  ('HD2026-0004', 'Phạm Mai Linh', 'BN004', 'Khoa Cấp cứu', 'Cấp cứu ban đầu', 450000, 360000, 'paid', '2026-05-04', '2026-05-04'),
  ('HD2026-0005', 'Hoàng Văn Tú', 'BN005', 'Khoa Nội', 'Siêu âm ổ bụng', 180000, 144000, 'pending', '2026-05-05', NULL),
  ('HD2026-0006', 'Vũ Thị Lan', 'BN006', 'Khoa Nhi', 'Khám + Tiêm chủng', 280000, 224000, 'paid', '2026-05-06', '2026-05-06'),
  ('HD2026-0007', 'Đỗ Minh Quân', 'BN007', 'Khoa Ngoại', 'Thay băng', 80000, 64000, 'paid', '2026-05-07', '2026-05-07'),
  ('HD2026-0008', 'Bùi Thị Hương', 'BN008', 'Khoa Nội', 'Khám + Xét nghiệm máu', 270000, 216000, 'pending', '2026-05-07', NULL),
  ('HD2026-0009', 'Ngô Văn Khải', 'BN009', 'Khoa Cấp cứu', 'Cấp cứu + Cắt khâu', 950000, 760000, 'paid', '2026-05-07', '2026-05-07'),
  ('HD2026-0010', 'Trịnh Hồng Nhung', 'BN010', 'Khoa Nhi', 'Khám tổng quát', 200000, 160000, 'cancelled', '2026-05-07', NULL);

INSERT INTO lab_results (patient_name, test_name, result_value, unit, reference_range, test_date, status) VALUES
  ('Nguyễn Văn An', 'Đường huyết lúc đói', '5.4', 'mmol/L', '3.9 - 5.6', '2026-05-01', 'completed'),
  ('Trần Thị Hoa', 'Công thức máu', 'Bình thường', '', '', '2026-05-02', 'completed'),
  ('Hoàng Văn Tú', 'Cholesterol', '6.2', 'mmol/L', '< 5.2', '2026-05-05', 'completed'),
  ('Bùi Thị Hương', 'HbA1c', '7.1', '%', '< 6.5', '2026-05-07', 'completed');
