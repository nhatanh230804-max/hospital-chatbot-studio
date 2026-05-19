-- ============================================================
-- v2.5 Migration: thêm connection_id vào schema_metadata và sql_templates
-- connection_id = NULL nghĩa là dùng DB chính (.env)
-- connection_id = <id> trong data_connections (type=mysql/postgres) → query DB đó
-- ============================================================

ALTER TABLE schema_metadata
  ADD COLUMN connection_id INT DEFAULT NULL AFTER table_name,
  ADD COLUMN connection_database VARCHAR(100) DEFAULT NULL AFTER connection_id;
-- connection_database: tên DB (vì 1 MySQL có thể chứa nhiều DB, ta cần biết
-- query trên schema nào). Với MinIO/Mongo thì cột này không dùng.

CREATE INDEX idx_schema_connection ON schema_metadata(connection_id);

ALTER TABLE sql_templates
  ADD COLUMN connection_id INT DEFAULT NULL AFTER name,
  ADD COLUMN connection_database VARCHAR(100) DEFAULT NULL AFTER connection_id;

CREATE INDEX idx_template_connection ON sql_templates(connection_id);

-- KHÔNG add foreign key vì data_connections có thể chưa tồn tại
-- (nhất là với DB cũ migrate dần). Validate ở application layer.
