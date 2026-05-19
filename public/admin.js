// =============================================================================
// Hospital Chatbot Studio v2 - admin.js
// =============================================================================

// ----------- Core utils -----------
function $(id) { return document.getElementById(id); }
function $$(sel) { return document.querySelectorAll(sel); }

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(str) { return escapeHtml(str); }

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
  el.textContent = message;
  $('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function openModal(html) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal">${html}</div>`;
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) { backdrop.remove(); resolve(null); }
    });
    $('modalContainer').appendChild(backdrop);
    window._currentModal = { backdrop, resolve };
  });
}

function closeModal(result) {
  if (!window._currentModal) return;
  const { backdrop, resolve } = window._currentModal;
  backdrop.remove();
  window._currentModal = null;
  resolve(result);
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    openModal(`
      <h2>Xác nhận</h2>
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
        <button class="btn danger" onclick="closeModal(true)">Xoá</button>
      </div>
    `).then(resolve);
  });
}

// ----------- Token -----------
function getToken() { return localStorage.getItem('adminToken') || ''; }
function saveToken() {
  const v = $('adminToken').value.trim();
  if (v) {
    localStorage.setItem('adminToken', v);
    toast('Đã lưu admin token.', 'success');
  } else {
    localStorage.removeItem('adminToken');
    toast('Đã xoá admin token.', 'info');
  }
}

// ----------- Fetch wrapper -----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (path.startsWith('/api/admin')) headers['x-admin-token'] = getToken();
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function apiUpload(path, formData) {
  const headers = { 'x-admin-token': getToken() };
  const res = await fetch(path, { method: 'POST', headers, body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    Object.assign(err, data);
    throw err;
  }
  return data;
}

// Cache list connections (mysql/postgres) cho dropdown
let _connectionsCache = null;
let _connectionsCacheAt = 0;
async function loadConnectionsForDropdown() {
  // Cache 30s
  if (_connectionsCache && Date.now() - _connectionsCacheAt < 30000) return _connectionsCache;
  try {
    const list = await api('/api/admin/data-connections');
    // Lọc chỉ MySQL/Postgres (MinIO không support query trực tiếp)
    _connectionsCache = list.filter((c) => c.is_active && ['mysql', 'postgres'].includes(c.type));
    _connectionsCacheAt = Date.now();
    return _connectionsCache;
  } catch {
    return [];
  }
}

function renderConnectionDropdown(idSelect, idDatabase, currentConnectionId = null, currentDatabase = null) {
  return `
    <div class="field-row">
      <div class="field">
        <label>Database / Connection</label>
        <select id="${idSelect}" onchange="onConnectionDropdownChange('${idSelect}', '${idDatabase}')">
          <option value="">— DB CHÍNH (mặc định) —</option>
        </select>
        <div class="help">Để DB chính nếu bảng nằm trong <code>hospital_demo</code>. Chọn connection khác nếu bảng nằm ngoài.</div>
      </div>
      <div class="field">
        <label>Tên database (nếu khác mặc định của connection)</label>
        <input id="${idDatabase}" value="${currentDatabase ? escapeAttr(currentDatabase) : ''}" placeholder="vd: hospital_billing — để trống nếu dùng database mặc định" />
        <div class="help">Vd cùng 1 MySQL server có 2 DB <code>hospital_demo</code> và <code>hospital_billing</code> → ghi tên DB ở đây.</div>
      </div>
    </div>
  `;
}

async function populateConnectionDropdown(idSelect, currentConnectionId = null) {
  const connections = await loadConnectionsForDropdown();
  const select = $(idSelect);
  if (!select) return;
  // Giữ option DB chính, thêm các connection
  select.innerHTML = `<option value="">— DB CHÍNH (mặc định) —</option>` +
    connections.map((c) => {
      const selected = String(c.id) === String(currentConnectionId) ? 'selected' : '';
      return `<option value="${c.id}" ${selected}>${escapeHtml(c.name)} (${escapeHtml(c.type)})</option>`;
    }).join('');
}

function onConnectionDropdownChange(idSelect, idDatabase) {
  // Khi đổi sang DB chính thì clear database field
  if (!$(idSelect).value) $(idDatabase).value = '';
}

// ----------------------------------------------------------------------------
// AI-powered keyword suggestion helper
// ----------------------------------------------------------------------------
async function suggestKeywords(idText, idKeywords, source, idContextFields = [], opts = {}) {
  const textEl = $(idText);
  const kwEl = $(idKeywords);
  if (!textEl || !kwEl) return;

  const text = textEl.value.trim();
  if (!text) {
    toast('Cần điền câu hỏi/tên trước khi sinh keywords.', 'error');
    return;
  }

  const additionalContext = idContextFields
    .map((id) => $(id) ? $(id).value.trim() : '')
    .filter(Boolean)
    .join(' ');

  const existingKeywords = kwEl.value
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  const useAI = opts.useAI !== false;

  // Show loading
  const originalValue = kwEl.value;
  kwEl.value = useAI ? '🤖 Đang sinh keywords bằng AI...' : '⏳ Đang sinh keywords...';
  kwEl.disabled = true;

  try {
    const data = await api('/api/admin/suggest-keywords', {
      method: 'POST',
      body: JSON.stringify({ text, source, additionalContext, existingKeywords, useAI })
    });
    if (!data.ok || !data.keywords?.length) {
      kwEl.value = originalValue;
      toast('Không sinh được keywords. Thử lại sau.', 'error');
      return;
    }
    // Merge: nếu có existing thì append (không trùng), không thì replace
    const merged = existingKeywords.length
      ? Array.from(new Set([...existingKeywords, ...data.keywords]))
      : data.keywords;
    kwEl.value = merged.join('|');
    toast(`Đã sinh ${data.keywords.length} keywords (${data.method || 'heuristic'})`, 'success');
  } catch (err) {
    kwEl.value = originalValue;
    toast('Lỗi: ' + err.message, 'error');
  } finally {
    kwEl.disabled = false;
  }
}

// ----------- Tabs -----------
const tabs = {
  dashboard: { title: 'Bảng điều khiển', subtitle: 'Tổng quan trạng thái hệ thống chatbot bệnh viện', loader: loadDashboard },
  faq: { title: 'FAQ đã duyệt', subtitle: 'Quản lý câu hỏi - câu trả lời tham khảo (upload file hoặc nhập tay)', loader: loadFaq },
  schema: { title: 'Schema (Dạy bảng)', subtitle: 'Mô tả bảng/cột để chatbot hiểu khi tạo SQL', loader: loadSchema },
  templates: { title: 'Dạy SQL · Templates', subtitle: 'Hàm SQL mẫu — chatbot ưu tiên match template trước khi gọi AI', loader: loadTemplates },
  sources: { title: 'Nguồn tra cứu', subtitle: 'Whitelist URL mà chatbot được phép tham khảo (Research Mode + Fallback)', loader: loadSources },
  connections: { title: 'Kết nối DB / Storage', subtitle: 'Quản lý kết nối tới MySQL, PostgreSQL, MinIO và các nguồn dữ liệu ngoài', loader: loadConnections },
  miniofiles: { title: 'File trên MinIO', subtitle: 'Danh sách object đã index từ MinIO bucket — gán keywords để chatbot tìm được', loader: loadMinioFiles },
  feedback: { title: 'Feedback', subtitle: 'Góp ý từ người dùng — duyệt để bổ sung vào FAQ', loader: loadFeedback },
  playground: { title: 'SQL Playground', subtitle: 'Thử câu hỏi → AI sinh SQL → chạy thật trên DB', loader: loadPlayground },
  cache: { title: 'Research Cache', subtitle: 'Cache câu trả lời từ Research Mode (TTL 7 ngày)', loader: loadCache },
  logs: { title: 'Logs', subtitle: 'Nhật ký chat gần đây — 200 dòng mới nhất', loader: loadLogs }
};

function switchTab(name) {
  if (!tabs[name]) return;
  // Hide all
  Object.keys(tabs).forEach((t) => {
    const sec = $('tab-' + t);
    if (sec) sec.classList.add('hidden');
  });
  $('tab-' + name).classList.remove('hidden');

  // Update nav active state
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));

  // Update title
  $('pageTitle').textContent = tabs[name].title;
  $('pageSubtitle').textContent = tabs[name].subtitle;

  // Load data
  tabs[name].loader();
}

// ----------- Init -----------
document.addEventListener('DOMContentLoaded', () => {
  $('adminToken').value = getToken();
  $$('.nav button').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  loadDashboard();
});

// =============================================================================
// TAB: DASHBOARD
// =============================================================================
async function loadDashboard() {
  try {
    const data = await api('/api/admin/studio/summary');

    function setTile(id, value, sub, status) {
      const el = $(id);
      if (!el) return;
      el.querySelector('.tile-value').textContent = value;
      if (sub) el.querySelector('.tile-sub').textContent = sub;
      el.classList.remove('ok', 'warn', 'bad');
      if (status) el.classList.add(status);
    }

    setTile('tileDb', data.dbReady ? 'Online' : 'Offline', data.dbReady ? 'Kết nối tốt' : 'Mất kết nối', data.dbReady ? 'ok' : 'bad');
    setTile('tileLlm', data.anythingLLMConfigured ? 'Online' : 'Chưa cấu hình', data.anythingLLMConfigured ? 'Đã set API key' : 'Cần cấu hình .env', data.anythingLLMConfigured ? 'ok' : 'warn');
    setTile('tileFeedback', data.feedbackPending, 'Đang chờ duyệt', data.feedbackPending > 0 ? 'warn' : 'ok');
    setTile('tileFaq', data.faqTotal, 'Đã kiểm duyệt');
    setTile('tileTemplates', data.templateTotal, 'Đang active', data.templateTotal > 0 ? 'ok' : 'warn');
    setTile('tileSources', data.sourceTotal, 'Đang active', data.sourceTotal > 0 ? 'ok' : 'bad');
    setTile('tileSchema', data.schemaTotal, 'Bảng được dạy');
    setTile('tileCache', data.cacheTotal, 'Còn hiệu lực');
    setTile('tileConnections', data.connectionTotal ?? 0, 'DB/Storage active', (data.connectionTotal ?? 0) > 0 ? 'ok' : 'warn');
    setTile('tileMinio', data.minioFileTotal ?? 0, 'File đã index');

    $('dashUpdated').textContent = 'Cập nhật: ' + new Date().toLocaleTimeString('vi-VN');
  } catch (err) {
    toast('Không tải được dashboard: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: FAQ
// =============================================================================
async function loadFaq() {
  $('tab-faq').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Upload file FAQ mới</h2>
        <span class="hint">Hỗ trợ .txt · .md · .docx · .pdf (tối đa 10MB)</span>
      </div>
      <div class="field">
        <label>Tiêu đề / Chủ đề (topic)</label>
        <input id="faqUploadTopic" placeholder="Vd: Triệu chứng tăng huyết áp" />
      </div>
      <div class="field">
        <label>Keywords (cách nhau bằng dấu |)</label>
        <input id="faqUploadKeywords" placeholder="tăng huyết áp|huyết áp cao|cao huyết áp" />
        <div class="help">Khi câu hỏi user chứa 1 trong các keyword này, chatbot sẽ trả FAQ này.</div>
      </div>
      <div class="field">
        <label>File FAQ</label>
        <label class="file-drop" for="faqUploadFile">
          <div class="emoji">📄</div>
          <div><b>Bấm để chọn file</b> hoặc kéo thả vào đây</div>
          <div class="help">.txt · .md · .docx · .pdf</div>
          <input id="faqUploadFile" type="file" accept=".txt,.md,.docx,.pdf" />
        </label>
        <div id="faqFileSelected"></div>
      </div>
      <button class="btn" onclick="faqUpload()">↑ Upload &amp; Tạo FAQ</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>FAQ hiện tại</h2>
        <button class="btn ghost sm" onclick="loadFaqList()">↻ Reload</button>
      </div>
      <div id="faqListContainer"></div>
    </div>
  `;

  // File chooser feedback
  $('faqUploadFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) { $('faqFileSelected').innerHTML = ''; return; }
    $('faqFileSelected').innerHTML = `<div class="file-selected"><span>📎 ${escapeHtml(f.name)} (${Math.round(f.size / 1024)} KB)</span><button class="btn ghost sm" type="button" onclick="document.getElementById('faqUploadFile').value=''; document.getElementById('faqFileSelected').innerHTML='';">Bỏ chọn</button></div>`;
  });

  loadFaqList();
}

async function faqUpload(opts = {}) {
  const topic = $('faqUploadTopic')?.value.trim() || opts.topic;
  const keywords = $('faqUploadKeywords')?.value.trim() || opts.keywords || '';
  const file = $('faqUploadFile')?.files[0];

  if (!topic) return toast('Thiếu topic.', 'error');
  if (!file && !opts.fileRef) return toast('Chưa chọn file.', 'error');

  const fd = new FormData();
  fd.append('topic', topic);
  fd.append('keywords', keywords);
  if (file) fd.append('file', file);
  if (opts.skipDedupeCheck) fd.append('skipDedupeCheck', 'true');
  if (opts.replaceFaqId) fd.append('replaceFaqId', String(opts.replaceFaqId));

  try {
    const res = await apiUpload('/api/admin/faqs/upload', fd);

    if ($('faqUploadTopic')) $('faqUploadTopic').value = '';
    if ($('faqUploadKeywords')) $('faqUploadKeywords').value = '';
    if ($('faqUploadFile')) $('faqUploadFile').value = '';
    if ($('faqFileSelected')) $('faqFileSelected').innerHTML = '';

    const msg = opts.replaceFaqId
      ? `Đã thay thế FAQ #${opts.replaceFaqId} bằng FAQ mới #${res.id}.`
      : `Đã tạo FAQ #${res.id}. Đã đọc ${res.fullLength} ký tự text.`;
    toast(msg, 'success');
    loadFaqList();
  } catch (err) {
    if (err.duplicates) {
      openFaqDuplicateModal(err, { topic, keywords, file });
      return;
    }
    toast('Upload fail: ' + err.message, 'error');
  }
}

function openFaqDuplicateModal(dupData, formData) {
  const dups = dupData.duplicates || [];
  const rowsHtml = dups.map((d, i) => `
    <div class="card" style="padding:12px;margin-bottom:8px;border:1px solid #e2e8f0;border-radius:8px">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div style="flex:1">
          <div><b>FAQ #${d.id}</b> — <span class="badge gray">${Math.round(d.score * 100)}% giống (${d.reason})</span></div>
          <div style="margin-top:6px"><b>Chủ đề:</b> ${escapeHtml(d.topic)}</div>
          <div style="margin-top:4px;color:#475569"><b>Nội dung:</b> ${escapeHtml(d.answer)}${d.answer.length >= 300 ? '...' : ''}</div>
        </div>
        <button class="btn warning sm" style="margin-left:12px" onclick="faqReplaceWithUpload(${d.id})">Thay thế cái này</button>
      </div>
    </div>
  `).join('');

  openModal(`
    <h2>⚠️ Phát hiện FAQ tương tự</h2>
    <div class="help" style="margin-bottom:12px">
      Hệ thống tìm thấy <b>${dups.length}</b> FAQ có nội dung gần giống với FAQ bạn đang upload.
      Vui lòng xem qua và quyết định:
      <ul style="margin-top:8px">
        <li><b>Thay thế</b>: xóa FAQ cũ + tạo mới từ file vừa upload</li>
        <li><b>Vẫn tạo mới</b>: bỏ qua cảnh báo, giữ cả 2 (có thể trùng)</li>
        <li><b>Hủy</b>: không tạo FAQ mới</li>
      </ul>
    </div>

    <h3 style="margin-top:16px">FAQ tương tự:</h3>
    ${rowsHtml}

    <h3 style="margin-top:16px">FAQ mới (đang chờ):</h3>
    <div class="card" style="padding:12px;margin-bottom:12px;background:#f0f9ff;border:1px solid #0F5EA8;border-radius:8px">
      <div><b>Chủ đề:</b> ${escapeHtml(dupData.pendingFaq.topic)}</div>
      <div style="margin-top:4px"><b>Nội dung:</b> ${escapeHtml(String(dupData.pendingFaq.answer || ''))}</div>
    </div>

    <div class="modal-actions" style="margin-top:16px">
      <button class="btn ghost" onclick="closeModal(false)">Hủy</button>
      <button class="btn warning" onclick="faqForceCreate()">Vẫn tạo mới (giữ cả 2)</button>
    </div>
  `);

  window._pendingFaqUpload = formData;
}

async function faqReplaceWithUpload(replaceFaqId) {
  const data = window._pendingFaqUpload;
  if (!data) return toast('Mất dữ liệu form, vui lòng thử lại.', 'error');
  closeModal(true);

  if ($('faqUploadFile') && data.file) {
    const dt = new DataTransfer();
    dt.items.add(data.file);
    $('faqUploadFile').files = dt.files;
    if ($('faqUploadTopic')) $('faqUploadTopic').value = data.topic;
    if ($('faqUploadKeywords')) $('faqUploadKeywords').value = data.keywords;
  }
  await faqUpload({ replaceFaqId });
  window._pendingFaqUpload = null;
}

async function faqForceCreate() {
  const data = window._pendingFaqUpload;
  if (!data) return toast('Mất dữ liệu form.', 'error');
  closeModal(true);

  if ($('faqUploadFile') && data.file) {
    const dt = new DataTransfer();
    dt.items.add(data.file);
    $('faqUploadFile').files = dt.files;
    if ($('faqUploadTopic')) $('faqUploadTopic').value = data.topic;
    if ($('faqUploadKeywords')) $('faqUploadKeywords').value = data.keywords;
  }
  await faqUpload({ skipDedupeCheck: true });
  window._pendingFaqUpload = null;
}

async function loadFaqList() {
  try {
    const list = await api('/api/admin/faqs');
    if (!list.length) {
      $('faqListContainer').innerHTML = '<div class="empty"><div class="emoji">📋</div>Chưa có FAQ nào.</div>';
      return;
    }
    $('faqListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr><th style="width:50px">ID</th><th>Topic</th><th>Keywords</th><th style="width:120px">Nguồn</th><th style="width:90px">Trạng thái</th><th style="width:140px"></th></tr></thead>
        <tbody>${list.map(faqRow).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Không tải được FAQ: ' + err.message, 'error');
  }
}

function faqRow(f) {
  const sourceLabel = f.source_file_name ? `<span class="badge teal">📄 file</span><div class="help" style="margin-top:3px">${escapeHtml(f.source_file_name)}</div>` : '<span class="badge gray">tay</span>';
  const statusBadge = f.is_active ? '<span class="badge green">active</span>' : '<span class="badge gray">disabled</span>';
  return `
    <tr>
      <td><b>${f.id}</b></td>
      <td><b>${escapeHtml(f.topic)}</b><div class="help">${escapeHtml((f.answer || '').slice(0, 90))}…</div></td>
      <td class="mono" style="max-width:240px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.keywords)}</td>
      <td>${sourceLabel}</td>
      <td>${statusBadge}</td>
      <td class="actions">
        <button class="btn ghost sm" onclick="faqEdit(${f.id})">Sửa</button>
        <button class="btn danger sm" onclick="faqDelete(${f.id})">Xoá</button>
      </td>
    </tr>
  `;
}

async function faqEdit(id) {
  try {
    const list = await api('/api/admin/faqs');
    const faq = list.find((f) => f.id === id);
    if (!faq) return toast('Không tìm thấy FAQ.', 'error');

    openModal(`
      <h2>Sửa FAQ #${faq.id}</h2>
      <div class="field">
        <label>Topic</label>
        <input id="m_faq_topic" value="${escapeAttr(faq.topic)}" />
      </div>
      <div class="field">
        <label>Keywords</label>
        <input id="m_faq_keywords" value="${escapeAttr(faq.keywords)}" />
      </div>
      <div class="field">
        <label>Nội dung</label>
        <textarea id="m_faq_answer" style="min-height: 220px">${escapeHtml(faq.answer)}</textarea>
      </div>
      <div class="field">
        <label><input type="checkbox" id="m_faq_active" ${faq.is_active ? 'checked' : ''}> Active</label>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
        <button class="btn" onclick="faqSubmitEdit(${faq.id})">Lưu</button>
      </div>
    `);
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function faqSubmitEdit(id) {
  try {
    await api(`/api/admin/faqs/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        topic: $('m_faq_topic').value.trim(),
        keywords: $('m_faq_keywords').value.trim(),
        answer: $('m_faq_answer').value.trim(),
        is_active: $('m_faq_active').checked
      })
    });
    closeModal(true);
    toast('Đã lưu FAQ.', 'success');
    loadFaqList();
  } catch (err) {
    toast('Lỗi lưu: ' + err.message, 'error');
  }
}

async function faqDelete(id) {
  const ok = await confirmDialog('Xoá FAQ này? File upload (nếu có) cũng sẽ bị xoá.');
  if (!ok) return;
  try {
    await api(`/api/admin/faqs/${id}`, { method: 'DELETE' });
    toast('Đã xoá FAQ.', 'success');
    loadFaqList();
  } catch (err) {
    toast('Lỗi xoá: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: SCHEMA
// =============================================================================
async function loadSchema() {
  $('tab-schema').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Thêm bảng mới</h2>
        <span class="hint">Mô tả bảng để AI biết khi nào dùng nó để sinh SQL</span>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Tên bảng (table_name)</label>
          <input id="sch_table" placeholder="departments" />
        </div>
        <div class="field">
          <label>Domain</label>
          <input id="sch_domain" placeholder="visits / staff / pricing..." />
        </div>
      </div>
      ${renderConnectionDropdown('sch_connection', 'sch_database')}
      <div class="field">
        <label>Mô tả</label>
        <input id="sch_desc" placeholder="Bảng thống kê lượt khám theo khoa/phòng..." />
      </div>
      <div class="field">
        <label>Columns JSON</label>
        <textarea id="sch_columns" placeholder='[{"name":"id","type":"INT","description":"ID"},{"name":"name","type":"VARCHAR","description":"Tên"}]'></textarea>
      </div>
      <div class="field">
        <label>Examples JSON (optional)</label>
        <textarea id="sch_examples" placeholder='[{"question":"...","sql":"SELECT ..."}]'></textarea>
      </div>
      <button class="btn" onclick="schemaCreate()">+ Tạo schema</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Danh sách bảng đã dạy</h2>
        <button class="btn ghost sm" onclick="loadSchemaList()">↻ Reload</button>
      </div>
      <div id="schemaListContainer"></div>
    </div>
  `;
  populateConnectionDropdown('sch_connection');
  loadSchemaList();
}

async function schemaCreate() {
  try {
    const columns = $('sch_columns').value.trim();
    const examples = $('sch_examples').value.trim() || '[]';
    JSON.parse(columns); JSON.parse(examples);
    await api('/api/admin/schema', {
      method: 'POST',
      body: JSON.stringify({
        table_name: $('sch_table').value.trim(),
        connection_id: $('sch_connection').value || null,
        connection_database: $('sch_database').value.trim() || null,
        domain: $('sch_domain').value.trim(),
        description: $('sch_desc').value.trim(),
        columns_json: columns,
        examples_json: examples
      })
    });
    toast('Đã tạo schema.', 'success');
    $('sch_table').value = '';
    $('sch_domain').value = '';
    $('sch_desc').value = '';
    $('sch_columns').value = '';
    $('sch_examples').value = '';
    $('sch_database').value = '';
    $('sch_connection').value = '';
    loadSchemaList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function loadSchemaList() {
  try {
    const list = await api('/api/admin/schema');
    if (!list.length) {
      $('schemaListContainer').innerHTML = '<div class="empty"><div class="emoji">🗂️</div>Chưa có bảng nào được dạy.</div>';
      return;
    }
    $('schemaListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr><th style="width:50px">ID</th><th>Bảng</th><th style="width:140px">Database</th><th>Domain</th><th>Mô tả</th><th style="width:90px">Trạng thái</th><th style="width:160px"></th></tr></thead>
        <tbody>${list.map(schemaRow).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi tải schema: ' + err.message, 'error');
  }
}

function schemaRow(s) {
  const status = s.is_active ? '<span class="badge green">active</span>' : '<span class="badge gray">disabled</span>';
  const scope = s.connection_id
    ? `<span class="badge teal">${escapeHtml(s.connection_name || '?')}</span><div class="help mono" style="font-size:11px">${escapeHtml(s.connection_database || 'default')}</div>`
    : '<span class="badge gray">DB chính</span>';
  return `
    <tr>
      <td>${s.id}</td>
      <td class="mono"><b>${escapeHtml(s.table_name)}</b></td>
      <td>${scope}</td>
      <td>${escapeHtml(s.domain || '')}</td>
      <td><div class="help">${escapeHtml((s.description || '').slice(0, 60))}…</div></td>
      <td>${status}</td>
      <td class="actions">
        <button class="btn ghost sm" onclick="schemaEdit(${s.id})">Sửa</button>
        <button class="btn danger sm" onclick="schemaDelete(${s.id})">Xoá</button>
      </td>
    </tr>
  `;
}

async function schemaEdit(id) {
  const list = await api('/api/admin/schema');
  const s = list.find((x) => x.id === id);
  if (!s) return toast('Không tìm thấy.', 'error');

  openModal(`
    <h2>Sửa schema #${s.id}</h2>
    <div class="field-row">
      <div class="field"><label>Bảng</label><input id="m_sch_table" value="${escapeAttr(s.table_name)}" /></div>
      <div class="field"><label>Domain</label><input id="m_sch_domain" value="${escapeAttr(s.domain || '')}" /></div>
    </div>
    ${renderConnectionDropdown('m_sch_connection', 'm_sch_database', s.connection_id, s.connection_database)}
    <div class="field"><label>Mô tả</label><input id="m_sch_desc" value="${escapeAttr(s.description || '')}" /></div>
    <div class="field"><label>Columns JSON</label><textarea id="m_sch_columns">${escapeHtml(JSON.stringify(s.columns_json, null, 2))}</textarea></div>
    <div class="field"><label>Examples JSON</label><textarea id="m_sch_examples">${escapeHtml(JSON.stringify(s.examples_json || [], null, 2))}</textarea></div>
    <div class="field"><label><input type="checkbox" id="m_sch_active" ${s.is_active ? 'checked' : ''}> Active</label></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
      <button class="btn" onclick="schemaSubmitEdit(${s.id})">Lưu</button>
    </div>
  `);
  populateConnectionDropdown('m_sch_connection', s.connection_id);
}

async function schemaSubmitEdit(id) {
  try {
    const cols = $('m_sch_columns').value.trim();
    const ex = $('m_sch_examples').value.trim() || '[]';
    JSON.parse(cols); JSON.parse(ex);
    await api(`/api/admin/schema/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        table_name: $('m_sch_table').value.trim(),
        connection_id: $('m_sch_connection').value || null,
        connection_database: $('m_sch_database').value.trim() || null,
        domain: $('m_sch_domain').value.trim(),
        description: $('m_sch_desc').value.trim(),
        columns_json: cols,
        examples_json: ex,
        is_active: $('m_sch_active').checked
      })
    });
    closeModal(true);
    toast('Đã lưu.', 'success');
    loadSchemaList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function schemaDelete(id) {
  const ok = await confirmDialog('Xoá schema này khỏi hệ thống? Hành động này không thể hoàn tác. Nếu cần khôi phục, hãy bấm "📚 Import bảng" trên connection để re-import.');
  if (!ok) return;
  try {
    await api(`/api/admin/schema/${id}`, { method: 'DELETE' });
    toast('Đã xoá schema.', 'success');
    loadSchemaList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: SQL TEMPLATES (Class "Dạy SQL")
// =============================================================================
async function loadTemplates() {
  $('tab-templates').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Tạo hàm SQL mới</h2>
        <span class="hint">Template = cặp (câu hỏi mẫu, SQL SELECT mẫu). Chatbot match keyword rồi chạy SQL.</span>
      </div>

      <div class="field-row">
        <div class="field">
          <label>Tên hàm</label>
          <input id="tpl_name" placeholder="Vd: Lượt khám của một khoa cụ thể" />
        </div>
        <div class="field">
          <label>Category</label>
          <input id="tpl_category" placeholder="visits / staff / pricing..." />
        </div>
      </div>

      <div class="field">
        <label>Mô tả</label>
        <input id="tpl_desc" placeholder="Trả về số lượt khám của khoa được hỏi." />
      </div>

      <div class="field">
        <label>Câu hỏi mẫu (tiếng Việt)</label>
        <input id="tpl_question" placeholder="Khoa {tên_khoa} có bao nhiêu lượt khám?" />
      </div>

      <div class="field">
        <label>Keywords (cách nhau bằng dấu |, viết không dấu)
          <button type="button" class="btn ghost sm" style="margin-left:8px;padding:2px 8px;font-size:11px"
            onclick="suggestKeywords('tpl_question', 'tpl_keywords', 'question', ['tpl_name', 'tpl_desc'])"
            title="AI sinh keywords từ câu hỏi mẫu">🤖 AI suggest</button>
          <button type="button" class="btn ghost sm" style="margin-left:4px;padding:2px 8px;font-size:11px"
            onclick="suggestKeywords('tpl_question', 'tpl_keywords', 'question', ['tpl_name', 'tpl_desc'], {useAI: false})"
            title="Sinh keywords nhanh không cần AI">⚡ Quick</button>
        </label>
        <input id="tpl_keywords" placeholder="luot kham|khoa noi|khoa ngoai|khoa nhi (hoặc để trống cho hệ thống tự sinh)" />
        <div class="help">
          Chatbot match câu hỏi user với keywords này (đã chuẩn hoá không dấu, lowercase).
          Bấm <b>⚡ Quick</b> để sinh nhanh, hoặc <b>🤖 AI suggest</b> để AI gợi ý kỹ hơn.
          Nếu để trống, hệ thống tự sinh khi save.
        </div>
      </div>

      ${renderConnectionDropdown('tpl_connection', 'tpl_database')}

      <div class="field">
        <label>SQL template</label>
        <textarea id="tpl_sql" style="min-height:120px" placeholder="SELECT name, visits FROM departments WHERE name LIKE '%{department}%' LIMIT 5"></textarea>
        <div class="help">
          Placeholder hỗ trợ:
          <code>{DEMO_TODAY}</code>
          <code>{DEMO_TOMORROW}</code>
          <code>{DEMO_YESTERDAY}</code>
          <code>{department}</code> (tự lấy từ câu hỏi user).
        </div>
      </div>

      <button class="btn" onclick="templateCreate()">+ Tạo hàm SQL</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Danh sách hàm SQL</h2>
        <button class="btn ghost sm" onclick="loadTemplateList()">↻ Reload</button>
      </div>
      <div id="templateListContainer"></div>
    </div>
  `;
  populateConnectionDropdown('tpl_connection');
  loadTemplateList();
}

async function templateCreate() {
  try {
    await api('/api/admin/sql-templates', {
      method: 'POST',
      body: JSON.stringify({
        name: $('tpl_name').value.trim(),
        connection_id: $('tpl_connection').value || null,
        connection_database: $('tpl_database').value.trim() || null,
        description: $('tpl_desc').value.trim(),
        question_pattern: $('tpl_question').value.trim(),
        keywords: $('tpl_keywords').value.trim(),
        sql_template: $('tpl_sql').value.trim(),
        category: $('tpl_category').value.trim()
      })
    });
    toast('Đã tạo SQL template.', 'success');
    ['tpl_name', 'tpl_desc', 'tpl_question', 'tpl_keywords', 'tpl_sql', 'tpl_category', 'tpl_database', 'tpl_connection'].forEach((id) => { if ($(id)) $(id).value = ''; });
    loadTemplateList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function loadTemplateList() {
  try {
    const list = await api('/api/admin/sql-templates');
    if (!list.length) {
      $('templateListContainer').innerHTML = '<div class="empty"><div class="emoji">⚙️</div>Chưa có template nào.</div>';
      return;
    }
    $('templateListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr>
          <th style="width:50px">ID</th>
          <th>Tên</th>
          <th style="width:140px">Database</th>
          <th>Câu hỏi mẫu</th>
          <th style="width:90px">Category</th>
          <th style="width:80px">Lượt dùng</th>
          <th style="width:90px">Trạng thái</th>
          <th style="width:200px"></th>
        </tr></thead>
        <tbody>${list.map(templateRow).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi tải templates: ' + err.message, 'error');
  }
}

function templateRow(t) {
  const status = t.is_active ? '<span class="badge green">active</span>' : '<span class="badge gray">disabled</span>';
  const cat = t.category ? `<span class="badge teal">${escapeHtml(t.category)}</span>` : '';
  const lastUsed = t.last_used_at ? `<div class="help">${new Date(t.last_used_at).toLocaleString('vi-VN')}</div>` : '';
  const scope = t.connection_id
    ? `<span class="badge teal">${escapeHtml(t.connection_name || '?')}</span><div class="help mono" style="font-size:11px">${escapeHtml(t.connection_database || 'default')}</div>`
    : '<span class="badge gray">DB chính</span>';
  return `
    <tr>
      <td>${t.id}</td>
      <td><b>${escapeHtml(t.name)}</b><div class="help">${escapeHtml((t.description || '').slice(0, 60))}</div></td>
      <td>${scope}</td>
      <td>${escapeHtml((t.question_pattern || '').slice(0, 60))}</td>
      <td>${cat}</td>
      <td><b>${t.usage_count || 0}</b>${lastUsed}</td>
      <td>${status}</td>
      <td class="actions">
        <button class="btn ghost sm" onclick="templateTest(${t.id})">Test</button>
        <button class="btn ghost sm" onclick="templateEdit(${t.id})">Sửa</button>
        <button class="btn danger sm" onclick="templateDelete(${t.id})">Xoá</button>
      </td>
    </tr>
  `;
}

async function templateEdit(id) {
  const list = await api('/api/admin/sql-templates');
  const t = list.find((x) => x.id === id);
  if (!t) return toast('Không tìm thấy.', 'error');

  openModal(`
    <h2>Sửa hàm SQL #${t.id}</h2>
    <div class="field-row">
      <div class="field"><label>Tên</label><input id="m_tpl_name" value="${escapeAttr(t.name)}" /></div>
      <div class="field"><label>Category</label><input id="m_tpl_category" value="${escapeAttr(t.category || '')}" /></div>
    </div>
    <div class="field"><label>Mô tả</label><input id="m_tpl_desc" value="${escapeAttr(t.description || '')}" /></div>
    <div class="field"><label>Câu hỏi mẫu</label><input id="m_tpl_question" value="${escapeAttr(t.question_pattern)}" /></div>
    <div class="field">
      <label>Keywords
        <button type="button" class="btn ghost sm" style="margin-left:8px;padding:2px 8px;font-size:11px"
          onclick="suggestKeywords('m_tpl_question', 'm_tpl_keywords', 'question', ['m_tpl_name', 'm_tpl_desc'])"
          title="AI sinh keywords từ câu hỏi mẫu">🤖 AI suggest</button>
        <button type="button" class="btn ghost sm" style="margin-left:4px;padding:2px 8px;font-size:11px"
          onclick="suggestKeywords('m_tpl_question', 'm_tpl_keywords', 'question', ['m_tpl_name', 'm_tpl_desc'], {useAI: false})"
          title="Sinh keywords nhanh không cần AI">⚡ Quick</button>
      </label>
      <input id="m_tpl_keywords" value="${escapeAttr(t.keywords)}" />
    </div>
    ${renderConnectionDropdown('m_tpl_connection', 'm_tpl_database', t.connection_id, t.connection_database)}
    <div class="field"><label>SQL template</label><textarea id="m_tpl_sql" style="min-height:140px">${escapeHtml(t.sql_template)}</textarea></div>
    <div class="field"><label><input type="checkbox" id="m_tpl_active" ${t.is_active ? 'checked' : ''}> Active</label></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
      <button class="btn" onclick="templateSubmitEdit(${t.id})">Lưu</button>
    </div>
  `);
  populateConnectionDropdown('m_tpl_connection', t.connection_id);
}

async function templateSubmitEdit(id) {
  try {
    await api(`/api/admin/sql-templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: $('m_tpl_name').value.trim(),
        connection_id: $('m_tpl_connection').value || null,
        connection_database: $('m_tpl_database').value.trim() || null,
        description: $('m_tpl_desc').value.trim(),
        question_pattern: $('m_tpl_question').value.trim(),
        keywords: $('m_tpl_keywords').value.trim(),
        sql_template: $('m_tpl_sql').value.trim(),
        category: $('m_tpl_category').value.trim(),
        is_active: $('m_tpl_active').checked
      })
    });
    closeModal(true);
    toast('Đã lưu template.', 'success');
    loadTemplateList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function templateDelete(id) {
  const ok = await confirmDialog('Xoá template này?');
  if (!ok) return;
  try {
    await api(`/api/admin/sql-templates/${id}`, { method: 'DELETE' });
    toast('Đã xoá.', 'success');
    loadTemplateList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function templateTest(id) {
  openModal(`
    <h2>Test template #${id}</h2>
    <div class="field">
      <label>Câu hỏi để test (tuỳ chọn, mặc định dùng question_pattern)</label>
      <input id="m_tpl_test_q" placeholder="Vd: khoa nhi có bao nhiêu lượt khám" />
    </div>
    <button class="btn" onclick="templateRunTest(${id})">▶ Chạy thử</button>
    <div id="m_tpl_test_result" style="margin-top:14px"></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal(false)">Đóng</button>
    </div>
  `);
}

async function templateRunTest(id) {
  const q = $('m_tpl_test_q').value.trim();
  const out = $('m_tpl_test_result');
  out.innerHTML = '<span class="muted">Đang chạy...</span>';
  try {
    const res = await api(`/api/admin/sql-templates/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ question: q })
    });
    if (!res.ok) {
      out.innerHTML = `<div class="badge red">Lỗi</div><pre>${escapeHtml(res.error || 'Unknown')}</pre><div class="muted">SQL resolved:</div><pre>${escapeHtml(res.sql || '')}</pre>`;
      return;
    }
    out.innerHTML = `
      <div class="badge green">OK · ${res.rows.length} dòng</div>
      <div class="muted" style="margin-top:8px">SQL:</div>
      <pre>${escapeHtml(res.sql)}</pre>
      <div class="muted">Trả về user:</div>
      <pre>${escapeHtml(res.reply)}</pre>
      <div class="muted">Raw rows:</div>
      <pre>${escapeHtml(JSON.stringify(res.rows, null, 2))}</pre>
    `;
  } catch (err) {
    out.innerHTML = `<div class="badge red">Lỗi: ${escapeHtml(err.message)}</div>`;
  }
}

// =============================================================================
// TAB: TRUSTED SOURCES (Class "Nguồn tra cứu")
// =============================================================================
async function loadSources() {
  $('tab-sources').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Thêm nguồn mới</h2>
        <span class="hint">Chatbot chỉ tra cứu từ các nguồn trong whitelist này (cho Research Mode + Fallback chat)</span>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Tên nguồn</label>
          <input id="src_name" placeholder="Vd: Mayo Clinic" />
        </div>
        <div class="field">
          <label>URL</label>
          <input id="src_url" placeholder="https://www.mayoclinic.org" />
        </div>
      </div>
      <div class="field">
        <label>Mô tả</label>
        <input id="src_desc" placeholder="Bệnh viện và tổ chức nghiên cứu y khoa..." />
      </div>
      <div class="field-row-3">
        <div class="field">
          <label>Category</label>
          <input id="src_category" placeholder="medical / health / nutrition..." value="medical" />
        </div>
        <div class="field">
          <label>Language</label>
          <select id="src_language">
            <option value="vi">Tiếng Việt</option>
            <option value="en">English</option>
            <option value="other">Khác</option>
          </select>
        </div>
        <div class="field">
          <label>Trust level</label>
          <select id="src_trust">
            <option value="high">High (rất uy tín)</option>
            <option value="medium" selected>Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      <button class="btn" onclick="sourceCreate()">+ Thêm nguồn</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Danh sách nguồn</h2>
        <button class="btn ghost sm" onclick="loadSourceList()">↻ Reload</button>
      </div>
      <div id="sourceListContainer"></div>
    </div>
  `;
  loadSourceList();
}

async function sourceCreate() {
  try {
    await api('/api/admin/trusted-sources', {
      method: 'POST',
      body: JSON.stringify({
        name: $('src_name').value.trim(),
        url: $('src_url').value.trim(),
        description: $('src_desc').value.trim(),
        category: $('src_category').value.trim() || 'medical',
        language: $('src_language').value,
        trust_level: $('src_trust').value
      })
    });
    toast('Đã thêm nguồn.', 'success');
    ['src_name', 'src_url', 'src_desc'].forEach((id) => { $(id).value = ''; });
    $('src_trust').value = 'medium';
    loadSourceList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function loadSourceList() {
  try {
    const list = await api('/api/admin/trusted-sources');
    if (!list.length) {
      $('sourceListContainer').innerHTML = '<div class="empty"><div class="emoji">🔗</div>Chưa có nguồn nào. Hãy thêm ít nhất 1 nguồn để Research Mode hoạt động.</div>';
      return;
    }
    $('sourceListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr>
          <th style="width:50px">ID</th>
          <th>Tên</th>
          <th>Domain</th>
          <th style="width:80px">Lang</th>
          <th style="width:90px">Trust</th>
          <th style="width:90px">Trạng thái</th>
          <th style="width:140px"></th>
        </tr></thead>
        <tbody>${list.map(sourceRow).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi tải sources: ' + err.message, 'error');
  }
}

function sourceRow(s) {
  const status = s.is_active ? '<span class="badge green">active</span>' : '<span class="badge gray">disabled</span>';
  const trustClass = s.trust_level === 'high' ? 'green' : s.trust_level === 'medium' ? 'amber' : 'gray';
  const trust = `<span class="badge ${trustClass}">${escapeHtml(s.trust_level)}</span>`;
  const safeUrl = /^https?:\/\//i.test(s.url) ? s.url : '#';
  return `
    <tr>
      <td>${s.id}</td>
      <td>
        <b>${escapeHtml(s.name)}</b>
        <div class="help">${escapeHtml((s.description || '').slice(0, 80))}</div>
        <div class="help"><a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener" class="mono">${escapeHtml(s.url)}</a></div>
      </td>
      <td class="mono">${escapeHtml(s.domain)}</td>
      <td>${escapeHtml(s.language || 'vi')}</td>
      <td>${trust}</td>
      <td>${status}</td>
      <td class="actions">
        <button class="btn ghost sm" onclick="sourceEdit(${s.id})">Sửa</button>
        <button class="btn danger sm" onclick="sourceDelete(${s.id})">Xoá</button>
      </td>
    </tr>
  `;
}

async function sourceEdit(id) {
  const list = await api('/api/admin/trusted-sources');
  const s = list.find((x) => x.id === id);
  if (!s) return toast('Không tìm thấy.', 'error');

  openModal(`
    <h2>Sửa nguồn #${s.id}</h2>
    <div class="field-row">
      <div class="field"><label>Tên</label><input id="m_src_name" value="${escapeAttr(s.name)}" /></div>
      <div class="field"><label>URL</label><input id="m_src_url" value="${escapeAttr(s.url)}" /></div>
    </div>
    <div class="field"><label>Mô tả</label><input id="m_src_desc" value="${escapeAttr(s.description || '')}" /></div>
    <div class="field-row-3">
      <div class="field"><label>Category</label><input id="m_src_category" value="${escapeAttr(s.category || '')}" /></div>
      <div class="field"><label>Language</label>
        <select id="m_src_language">
          <option value="vi" ${s.language === 'vi' ? 'selected' : ''}>vi</option>
          <option value="en" ${s.language === 'en' ? 'selected' : ''}>en</option>
          <option value="other" ${s.language === 'other' ? 'selected' : ''}>other</option>
        </select>
      </div>
      <div class="field"><label>Trust</label>
        <select id="m_src_trust">
          <option value="high" ${s.trust_level === 'high' ? 'selected' : ''}>high</option>
          <option value="medium" ${s.trust_level === 'medium' ? 'selected' : ''}>medium</option>
          <option value="low" ${s.trust_level === 'low' ? 'selected' : ''}>low</option>
        </select>
      </div>
    </div>
    <div class="field"><label><input type="checkbox" id="m_src_active" ${s.is_active ? 'checked' : ''}> Active</label></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
      <button class="btn" onclick="sourceSubmitEdit(${s.id})">Lưu</button>
    </div>
  `);
}

async function sourceSubmitEdit(id) {
  try {
    await api(`/api/admin/trusted-sources/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: $('m_src_name').value.trim(),
        url: $('m_src_url').value.trim(),
        description: $('m_src_desc').value.trim(),
        category: $('m_src_category').value.trim(),
        language: $('m_src_language').value,
        trust_level: $('m_src_trust').value,
        is_active: $('m_src_active').checked
      })
    });
    closeModal(true);
    toast('Đã lưu.', 'success');
    loadSourceList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function sourceDelete(id) {
  const ok = await confirmDialog('Xoá nguồn này?');
  if (!ok) return;
  try {
    await api(`/api/admin/trusted-sources/${id}`, { method: 'DELETE' });
    toast('Đã xoá.', 'success');
    loadSourceList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: FEEDBACK
// =============================================================================
async function loadFeedback() {
  $('tab-feedback').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Feedback chờ duyệt</h2>
        <span class="hint">Duyệt để bổ sung vào FAQ. Reject nếu không phù hợp.</span>
      </div>
      <div id="feedbackListContainer"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Feedback đã xử lý</h2>
        <button class="btn ghost sm" onclick="loadFeedbackHistory()">↻ Load</button>
      </div>
      <div id="feedbackHistoryContainer"><div class="muted">Bấm Load để xem.</div></div>
    </div>
  `;
  try {
    const list = await api('/api/admin/feedback?status=pending');
    if (!list.length) {
      $('feedbackListContainer').innerHTML = '<div class="empty"><div class="emoji">✓</div>Không có feedback nào đang chờ duyệt.</div>';
      return;
    }
    $('feedbackListContainer').innerHTML = list.map(feedbackCard).join('');
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

function feedbackCard(f) {
  return `
    <div style="border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:12px;background:var(--clinical)">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <span class="badge ${f.feedback_type === 'positive' ? 'green' : 'amber'}">${escapeHtml(f.feedback_type)}</span>
        <span class="muted">#${f.id} · ${new Date(f.created_at).toLocaleString('vi-VN')}</span>
      </div>
      <div style="margin-bottom:8px"><b>Câu hỏi:</b> ${escapeHtml(f.user_question)}</div>
      <div style="margin-bottom:8px"><b>Bot trả:</b> <pre style="margin-top:4px">${escapeHtml(f.bot_answer)}</pre></div>
      ${f.user_correction ? `<div style="margin-bottom:8px"><b>Góp ý:</b> <pre style="margin-top:4px">${escapeHtml(f.user_correction)}</pre></div>` : ''}
      <div class="actions">
        <button class="btn success sm" onclick="feedbackApprove(${f.id})">✓ Duyệt vào FAQ</button>
        <button class="btn danger sm" onclick="feedbackReject(${f.id})">✕ Từ chối</button>
      </div>
    </div>
  `;
}

async function feedbackApprove(id) {
  const list = await api('/api/admin/feedback?status=pending');
  const f = list.find((x) => x.id === id);
  if (!f) return toast('Không tìm thấy.', 'error');

  openModal(`
    <h2>Duyệt feedback #${id} thành FAQ</h2>
    <div class="field"><label>Topic</label><input id="m_fb_topic" value="${escapeAttr(f.user_question.slice(0, 80))}" /></div>
    <div class="field"><label>Keywords</label><input id="m_fb_keywords" placeholder="từ khoá|cách nhau bằng dấu |" /></div>
    <div class="field"><label>Câu trả lời (sẽ thành FAQ)</label><textarea id="m_fb_answer" style="min-height:160px">${escapeHtml(f.user_correction || f.bot_answer)}</textarea></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
      <button class="btn success" onclick="feedbackSubmitApprove(${id})">Duyệt</button>
    </div>
  `);
}

async function feedbackSubmitApprove(id) {
  try {
    await api(`/api/admin/feedback/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        topic: $('m_fb_topic').value.trim(),
        keywords: $('m_fb_keywords').value.trim(),
        answer: $('m_fb_answer').value.trim(),
        approvedBy: 'admin'
      })
    });
    closeModal(true);
    toast('Đã duyệt và thêm vào FAQ.', 'success');
    loadFeedback();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function feedbackReject(id) {
  const ok = await confirmDialog('Từ chối feedback này?');
  if (!ok) return;
  try {
    await api(`/api/admin/feedback/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reviewedBy: 'admin' })
    });
    toast('Đã từ chối.', 'success');
    loadFeedback();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function loadFeedbackHistory() {
  try {
    const approved = await api('/api/admin/feedback?status=approved');
    const rejected = await api('/api/admin/feedback?status=rejected');
    const all = [...approved, ...rejected].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (!all.length) {
      $('feedbackHistoryContainer').innerHTML = '<div class="empty">Chưa có feedback đã xử lý.</div>';
      return;
    }
    $('feedbackHistoryContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr><th style="width:50px">ID</th><th>Câu hỏi</th><th style="width:90px">Trạng thái</th><th style="width:140px">Người duyệt</th></tr></thead>
        <tbody>${all.map((f) => `
          <tr>
            <td>${f.id}</td>
            <td>${escapeHtml(f.user_question.slice(0, 80))}</td>
            <td><span class="badge ${f.status === 'approved' ? 'green' : 'gray'}">${escapeHtml(f.status)}</span></td>
            <td>${escapeHtml(f.reviewed_by || '')}<div class="help">${f.reviewed_at ? new Date(f.reviewed_at).toLocaleString('vi-VN') : ''}</div></td>
          </tr>
        `).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: PLAYGROUND
// =============================================================================
async function loadPlayground() {
  $('tab-playground').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>SQL Playground</h2>
        <span class="hint">Nhập câu hỏi → backend thử match template trước, không có thì gọi AnythingLLM tạo SQL → chạy thật trên DB</span>
      </div>
      <div class="field">
        <label>Câu hỏi</label>
        <input id="play_question" placeholder="Vd: khoa nào có lượt khám cao nhất?" onkeydown="if(event.key==='Enter') playgroundRun()" />
      </div>
      <button class="btn" onclick="playgroundRun()">▶ Chạy</button>
      <div id="play_result" style="margin-top:16px"></div>
    </div>
  `;
}

async function playgroundRun() {
  const q = $('play_question').value.trim();
  if (!q) return toast('Nhập câu hỏi đã.', 'error');
  $('play_result').innerHTML = '<span class="muted">Đang chạy...</span>';
  try {
    const res = await api('/api/admin/sql-playground', {
      method: 'POST',
      body: JSON.stringify({ question: q })
    });
    const tag = res.viaTemplate
      ? '<span class="badge teal">via template</span>'
      : '<span class="badge gray">via AI</span>';
    $('play_result').innerHTML = `
      ${tag} <span class="badge ${res.ok ? 'green' : 'red'}">${res.ok ? 'OK' : 'FAIL'}</span>
      <div class="muted" style="margin-top:8px">SQL chạy:</div>
      <pre>${escapeHtml(res.sql || '(không có)')}</pre>
      ${res.originalSql ? `<div class="muted">Original SQL từ AI:</div><pre>${escapeHtml(res.originalSql)}</pre>` : ''}
      <div class="muted">Reply hiển thị cho user:</div>
      <pre>${escapeHtml(res.reply || '')}</pre>
      <div class="muted">Raw rows (${(res.rows || []).length}):</div>
      <pre>${escapeHtml(JSON.stringify(res.rows || [], null, 2))}</pre>
    `;
  } catch (err) {
    $('play_result').innerHTML = `<span class="badge red">Lỗi</span><pre>${escapeHtml(err.message)}</pre>`;
  }
}

// =============================================================================
// TAB: CACHE
// =============================================================================
async function loadCache() {
  $('tab-cache').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Research Cache (TTL 7 ngày)</h2>
        <button class="btn ghost sm" onclick="loadCache()">↻ Reload</button>
      </div>
      <div id="cacheListContainer"></div>
    </div>
  `;
  try {
    const list = await api('/api/admin/research-cache');
    if (!list.length) {
      $('cacheListContainer').innerHTML = '<div class="empty"><div class="emoji">💾</div>Cache trống.</div>';
      return;
    }
    $('cacheListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr><th style="width:50px">ID</th><th>Normalized key</th><th>Original question</th><th style="width:160px">Hết hạn</th><th style="width:100px"></th></tr></thead>
        <tbody>${list.map((c) => `
          <tr>
            <td>${c.id}</td>
            <td class="mono">${escapeHtml(c.normalized_question)}</td>
            <td>${escapeHtml(c.original_question)}</td>
            <td><div class="help">${new Date(c.expires_at).toLocaleString('vi-VN')}</div></td>
            <td class="actions"><button class="btn danger sm" onclick="cacheDelete(${c.id})">Xoá</button></td>
          </tr>
        `).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function cacheDelete(id) {
  const ok = await confirmDialog('Xoá cache này?');
  if (!ok) return;
  try {
    await api(`/api/admin/research-cache/${id}`, { method: 'DELETE' });
    toast('Đã xoá.', 'success');
    loadCache();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: LOGS
// =============================================================================
async function loadLogs() {
  $('tab-logs').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Chat logs (200 dòng mới nhất)</h2>
        <button class="btn ghost sm" onclick="loadLogs()">↻ Reload</button>
      </div>
      <div id="logsListContainer"></div>
    </div>
  `;
  try {
    const list = await api('/api/admin/logs');
    if (!list.length) {
      $('logsListContainer').innerHTML = '<div class="empty"><div class="emoji">📜</div>Chưa có log nào.</div>';
      return;
    }
    $('logsListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr>
          <th style="width:50px">ID</th>
          <th>Câu hỏi</th>
          <th style="width:110px">Route</th>
          <th style="width:120px">Source</th>
          <th style="width:80px">Latency</th>
          <th style="width:60px"></th>
        </tr></thead>
        <tbody>${list.map((l) => `
          <tr>
            <td>${l.id}</td>
            <td>
              <div>${escapeHtml((l.user_message || '').slice(0, 80))}</div>
              ${l.error_message ? `<div class="badge red" style="margin-top:3px">${escapeHtml((l.error_message || '').slice(0, 100))}</div>` : ''}
              <div class="help">${new Date(l.created_at).toLocaleString('vi-VN')}</div>
            </td>
            <td><span class="badge ${routeColor(l.route_name)}">${escapeHtml(l.route_name || '')}</span></td>
            <td class="mono" style="font-size:11px">${escapeHtml(l.source || '')}</td>
            <td class="mono">${l.latency_ms || 0}ms</td>
            <td>${l.final_sql ? `<button class="btn ghost sm" onclick="logShowSql(${l.id}, ${JSON.stringify(escapeAttr(l.final_sql))})">SQL</button>` : ''}</td>
          </tr>
        `).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

function routeColor(route) {
  if (!route) return 'gray';
  if (route.includes('error')) return 'red';
  if (route === 'sql-template' || route === 'faq' || route === 'document') return 'green';
  if (route === 'nl2sql' || route === 'research') return 'teal';
  if (route === 'medical-safety') return 'amber';
  return 'gray';
}

async function logShowSql(id) {
  try {
    const list = await api('/api/admin/logs');
    const l = list.find((x) => x.id === id);
    if (!l) return;
    openModal(`
      <h2>Log #${id} - SQL</h2>
      <div class="muted">Câu hỏi:</div>
      <pre>${escapeHtml(l.user_message)}</pre>
      ${l.ai_sql ? `<div class="muted">AI/original SQL:</div><pre>${escapeHtml(l.ai_sql)}</pre>` : ''}
      ${l.final_sql ? `<div class="muted">Final SQL chạy:</div><pre>${escapeHtml(l.final_sql)}</pre>` : ''}
      <div class="modal-actions"><button class="btn ghost" onclick="closeModal(false)">Đóng</button></div>
    `);
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: DATA CONNECTIONS
// =============================================================================
let _adapterCache = null;
async function getAdapters() {
  if (_adapterCache) return _adapterCache;
  _adapterCache = await api('/api/admin/data-connections/adapters');
  return _adapterCache;
}

async function loadConnections() {
  const adapters = await getAdapters();
  $('tab-connections').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Tạo kết nối mới</h2>
        <span class="hint">Mỗi connection = 1 nguồn data ngoài (MySQL/Postgres khác, MinIO bucket...)</span>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Tên (unique)</label>
          <input id="conn_name" placeholder="Vd: HIS-MySQL hoặc Storage-Files" />
        </div>
        <div class="field">
          <label>Loại</label>
          <select id="conn_type" onchange="renderConnConfigForm()">
            ${adapters.map((a) => `<option value="${escapeAttr(a.type)}">${escapeHtml(a.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field">
        <label>Mô tả</label>
        <input id="conn_desc" placeholder="Mô tả ngắn về kết nối này" />
      </div>
      <div id="conn_config_fields"></div>
      <button class="btn" onclick="connectionCreate()">+ Tạo kết nối</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Danh sách kết nối</h2>
        <button class="btn ghost sm" onclick="loadConnectionList()">↻ Reload</button>
      </div>
      <div id="connectionListContainer"></div>
    </div>
  `;
  renderConnConfigForm();
  loadConnectionList();
}

async function renderConnConfigForm() {
  const adapters = await getAdapters();
  const type = $('conn_type').value;
  const adapter = adapters.find((a) => a.type === type);
  if (!adapter) return;
  $('conn_config_fields').innerHTML = `
    <div class="card-head" style="margin-top:8px"><h3>Config cho ${escapeHtml(adapter.label)}</h3></div>
    ${adapter.configSchema.map((f) => connFieldHtml(f, '')).join('')}
  `;
}

function connFieldHtml(f, currentValue, idPrefix = 'conn_cfg_') {
  const id = idPrefix + f.key;
  const val = currentValue !== undefined && currentValue !== null && currentValue !== '' ? currentValue : (f.default ?? '');
  if (f.type === 'boolean') {
    const checked = val === true || val === 'true' ? 'checked' : '';
    return `<div class="field"><label><input type="checkbox" id="${id}" ${checked}> ${escapeHtml(f.label)}</label></div>`;
  }
  const inputType = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
  return `
    <div class="field">
      <label>${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>
      <input id="${id}" type="${inputType}" value="${escapeAttr(val)}" />
      ${f.help ? `<div class="help">${escapeHtml(f.help)}</div>` : ''}
    </div>
  `;
}

async function collectConnConfig(type, idPrefix = 'conn_cfg_') {
  const adapters = await getAdapters();
  const adapter = adapters.find((a) => a.type === type);
  if (!adapter) return {};
  const cfg = {};
  for (const f of adapter.configSchema) {
    const el = $(idPrefix + f.key);
    if (!el) continue;
    if (f.type === 'boolean') cfg[f.key] = el.checked;
    else if (f.type === 'number') cfg[f.key] = Number(el.value) || (f.default ?? 0);
    else cfg[f.key] = el.value.trim();
  }
  return cfg;
}

async function connectionCreate() {
  try {
    const type = $('conn_type').value;
    const config = await collectConnConfig(type);
    const result = await api('/api/admin/data-connections', {
      method: 'POST',
      body: JSON.stringify({
        name: $('conn_name').value.trim(),
        type,
        description: $('conn_desc').value.trim(),
        config_json: config
      })
    });
    toast('Đã tạo kết nối.', 'success');
    $('conn_name').value = '';
    $('conn_desc').value = '';
    renderConnConfigForm();
    loadConnectionList();

    // Auto-trigger import schema cho MySQL/Postgres (sau khi tạo thành công)
    if ((type === 'mysql' || type === 'postgres') && result.id) {
      setTimeout(() => {
        if (confirm('✨ Connection đã tạo!\n\nBạn có muốn tự động dạy chatbot các bảng trong database này không?\n\n(Sẽ scan database và sinh schema metadata + keywords tự động.)')) {
          connectionImportSchema(result.id, config.database || '');
        }
      }, 500);
    }
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function loadConnectionList() {
  try {
    const list = await api('/api/admin/data-connections');
    if (!list.length) {
      $('connectionListContainer').innerHTML = '<div class="empty"><div class="emoji">🔌</div>Chưa có kết nối nào.</div>';
      return;
    }
    $('connectionListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr>
          <th style="width:50px">ID</th>
          <th>Tên</th>
          <th style="width:120px">Loại</th>
          <th>Mô tả</th>
          <th style="width:130px">Test gần nhất</th>
          <th style="width:90px">Trạng thái</th>
          <th style="width:240px"></th>
        </tr></thead>
        <tbody>${list.map(connectionRow).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

function connectionRow(c) {
  const status = c.is_active ? '<span class="badge green">active</span>' : '<span class="badge gray">disabled</span>';
  const testBadge = c.last_test_status === 'ok'
    ? '<span class="badge green">OK</span>'
    : c.last_test_status === 'fail'
    ? '<span class="badge red">FAIL</span>'
    : '<span class="badge gray">chưa test</span>';
  return `
    <tr>
      <td>${c.id}</td>
      <td><b>${escapeHtml(c.name)}</b></td>
      <td><span class="badge teal">${escapeHtml(c.type)}</span></td>
      <td><div class="help">${escapeHtml((c.description || '').slice(0, 70))}</div></td>
      <td>${testBadge}<div class="help">${c.last_test_at ? new Date(c.last_test_at).toLocaleString('vi-VN') : ''}</div></td>
      <td>${status}</td>
      <td class="actions">
        <button class="btn ghost sm" onclick="connectionTest(${c.id})">Test</button>
        <button class="btn ghost sm" onclick="connectionResources(${c.id})">Resources</button>
        ${c.type === 'minio' ? `<button class="btn success sm" onclick="connectionSyncMinio(${c.id})">Sync</button>` : ''}
        ${(c.type === 'mysql' || c.type === 'postgres') ? `<button class="btn success sm" onclick="connectionImportSchema(${c.id})" title="Tự động dạy chatbot các bảng">📚 Import bảng</button>` : ''}
        <button class="btn ghost sm" onclick="connectionEdit(${c.id})">Sửa</button>
        <button class="btn danger sm" onclick="connectionDelete(${c.id})">Xoá</button>
      </td>
    </tr>
  `;
}

async function connectionTest(id) {
  toast('Đang test...', 'info');
  try {
    const res = await api(`/api/admin/data-connections/${id}/test`, { method: 'POST' });
    toast((res.ok ? '✓ ' : '✕ ') + res.message, res.ok ? 'success' : 'error');
    loadConnectionList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function connectionResources(id) {
  openModal(`<h2>Resources</h2><div id="m_conn_resources"><span class="muted">Đang load...</span></div><div class="modal-actions"><button class="btn ghost" onclick="closeModal(false)">Đóng</button></div>`);
  try {
    const res = await api(`/api/admin/data-connections/${id}/resources`);
    const out = $('m_conn_resources');
    if (!res.ok) {
      out.innerHTML = `<div class="badge red">Lỗi</div><pre>${escapeHtml(res.error || '')}</pre>`;
      return;
    }
    out.innerHTML = `
      <div class="muted">Loại: <b>${escapeHtml(res.type)}</b> · ${res.count} mục</div>
      <table class="data-grid" style="margin-top:8px">
        <thead><tr><th>Tên</th><th style="width:120px">Type</th><th style="width:140px">Size / Rows</th></tr></thead>
        <tbody>${res.items.slice(0, 100).map((i) => `
          <tr>
            <td class="mono" style="font-size:11.5px">${escapeHtml(i.name)}</td>
            <td>${escapeHtml(i.type)}</td>
            <td>${i.size ? formatBytes(i.size) : i.rowCount != null ? i.rowCount + ' rows' : ''}</td>
          </tr>
        `).join('')}</tbody>
      </table>
      ${res.items.length > 100 ? `<div class="muted">Hiển thị 100/${res.items.length}</div>` : ''}
    `;
  } catch (err) {
    $('m_conn_resources').innerHTML = `<div class="badge red">${escapeHtml(err.message)}</div>`;
  }
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function connectionSyncMinio(id) {
  toast('Đang sync MinIO bucket...', 'info');
  try {
    const res = await api(`/api/admin/minio/${id}/sync`, { method: 'POST' });
    if (!res.ok) return toast('Sync fail: ' + res.error, 'error');

    const baseMsg = `Sync xong: ${res.total} file (mới ${res.inserted}, cập nhật ${res.updated})`;

    if (res.missingFiles && res.missingFiles.length > 0) {
      toast(baseMsg, 'success');
      openMissingFilesModal(id, res.missingFiles);
    } else {
      toast(baseMsg, 'success');
      if (document.getElementById('tab-minio-files')?.classList?.contains('active')) {
        loadMinioFiles();
      }
    }
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

function openMissingFilesModal(connectionId, missingFiles) {
  const rowsHtml = missingFiles.map((f, i) => `
    <tr>
      <td><input type="checkbox" id="miss_${i}" data-id="${f.id}" checked /></td>
      <td class="mono">${escapeHtml(f.object_name)}</td>
      <td class="mono small">${escapeHtml(f.object_key)}</td>
    </tr>
  `).join('');

  openModal(`
    <h2>⚠️ Phát hiện ${missingFiles.length} file không còn trong bucket</h2>
    <div class="help" style="margin-bottom:12px">
      Các file dưới đây <b>không còn tồn tại trong MinIO bucket</b> nhưng vẫn có trong danh sách của chatbot.
      Chọn file muốn <b>xóa khỏi index</b> (chatbot sẽ không còn biết đến các file này nữa).
      Lưu ý: hành động này không thể hoàn tác. Nếu file thật được upload lại vào bucket sau đó, lần sync tiếp theo sẽ insert file mới.
    </div>

    <div class="field-row" style="margin-bottom:8px">
      <button type="button" class="btn ghost sm" onclick="missingFilesSelectAll(true)">Chọn tất cả</button>
      <button type="button" class="btn ghost sm" onclick="missingFilesSelectAll(false)">Bỏ chọn tất cả</button>
    </div>

    <div style="max-height:400px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px">
      <table class="data-grid">
        <thead><tr>
          <th style="width:50px"></th>
          <th>Tên file</th>
          <th>Object key</th>
        </tr></thead>
        <tbody id="missingFilesList">${rowsHtml}</tbody>
      </table>
    </div>

    <div class="modal-actions" style="margin-top:16px">
      <button class="btn ghost" onclick="closeModal(false)">Bỏ qua (giữ tất cả)</button>
      <button class="btn danger" onclick="missingFilesSubmit(${connectionId})">🗑 Xóa các file đã chọn</button>
    </div>
  `);
}

function missingFilesSelectAll(checked) {
  document.querySelectorAll('#missingFilesList input[type=checkbox]').forEach((c) => {
    c.checked = checked;
  });
}

async function missingFilesSubmit(connectionId) {
  const checked = Array.from(document.querySelectorAll('#missingFilesList input[type=checkbox]:checked'));
  if (checked.length === 0) return toast('Chưa chọn file nào.', 'error');
  const ids = checked.map((c) => Number(c.dataset.id));

  toast(`Đang xóa ${ids.length} file...`, 'info');
  try {
    const res = await api(`/api/admin/minio/${connectionId}/sync`, {
      method: 'POST',
      body: JSON.stringify({ confirmDeleteIds: ids })
    });
    if (!res.ok) return toast('Lỗi: ' + (res.error || 'unknown'), 'error');
    closeModal(true);
    toast(`Đã xóa ${res.deleted} file khỏi index.`, 'success');
    if (document.getElementById('tab-minio-files')?.classList?.contains('active')) {
      loadMinioFiles();
    }
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

// ============================================================================
// Auto-import schema: scan connection → hiện modal checkbox list → import
// ============================================================================
async function connectionImportSchema(id, defaultDatabase = '') {
  toast('Đang quét danh sách bảng...', 'info');
  try {
    const data = await api('/api/admin/list-tables', {
      method: 'POST',
      body: JSON.stringify({ connection_id: id, connection_database: defaultDatabase || null })
    });
    if (!data.ok) return toast('Quét fail: ' + (data.error || 'unknown'), 'error');
    if (!data.tables.length) return toast('Không tìm thấy bảng nào trong connection này.', 'error');

    openImportSchemaModal(id, defaultDatabase, data.tables);
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

function openImportSchemaModal(connectionId, database, tables) {
  const newCount = tables.filter((t) => !t.alreadyHasSchema).length;
  const existingCount = tables.length - newCount;

  const rowsHtml = tables.map((t, i) => `
    <tr>
      <td><input type="checkbox" id="imp_tbl_${i}" data-name="${escapeAttr(t.name)}" ${t.alreadyHasSchema ? '' : 'checked'} /></td>
      <td class="mono"><b>${escapeHtml(t.name)}</b></td>
      <td>${t.alreadyHasSchema
        ? '<span class="badge teal">đã có schema</span>'
        : '<span class="badge gray">chưa có</span>'}</td>
    </tr>
  `).join('');

  openModal(`
    <h2>📚 Import bảng từ database</h2>
    <div class="help" style="margin-bottom:12px">
      Tìm thấy <b>${tables.length}</b> bảng trong connection.
      Bảng chưa có schema: <b style="color:#059669">${newCount}</b>,
      bảng đã có: <b style="color:#0F5EA8">${existingCount}</b>.
      Chatbot sẽ tự sinh: tên cột, kiểu dữ liệu, description tạm, keywords.
      Admin có thể edit sau qua tab Schema.
    </div>

    <div class="field-row" style="margin-bottom:8px">
      <button type="button" class="btn ghost sm" onclick="importSchemaSelectAll(true)">Chọn tất cả</button>
      <button type="button" class="btn ghost sm" onclick="importSchemaSelectAll(false)">Bỏ chọn tất cả</button>
      <button type="button" class="btn ghost sm" onclick="importSchemaSelectNew()">Chỉ chọn bảng mới</button>
    </div>

    <div style="max-height:400px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px">
      <table class="data-grid">
        <thead><tr>
          <th style="width:50px"></th>
          <th>Tên bảng</th>
          <th style="width:140px">Trạng thái</th>
        </tr></thead>
        <tbody id="importSchemaTableList">${rowsHtml}</tbody>
      </table>
    </div>

    <div class="modal-actions" style="margin-top:16px">
      <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
      <button class="btn success" onclick="importSchemaSubmit(${connectionId}, '${escapeAttr(database || '')}')">📚 Import</button>
    </div>
  `);
}

function importSchemaSelectAll(checked) {
  document.querySelectorAll('#importSchemaTableList input[type=checkbox]').forEach((c) => {
    c.checked = checked;
  });
}

function importSchemaSelectNew() {
  document.querySelectorAll('#importSchemaTableList tr').forEach((row) => {
    const cb = row.querySelector('input[type=checkbox]');
    const hasSchema = row.querySelector('.badge.teal');
    if (cb) cb.checked = !hasSchema;
  });
}

async function importSchemaSubmit(connectionId, database) {
  const checked = Array.from(document.querySelectorAll('#importSchemaTableList input[type=checkbox]:checked'));
  if (checked.length === 0) return toast('Chưa chọn bảng nào.', 'error');
  const tables = checked.map((c) => c.dataset.name);

  toast(`Đang import ${tables.length} bảng...`, 'info');
  try {
    const res = await api('/api/admin/auto-import-schema', {
      method: 'POST',
      body: JSON.stringify({
        connection_id: connectionId,
        connection_database: database || null,
        tables
      })
    });
    if (!res.ok) return toast('Import fail: ' + (res.error || 'unknown'), 'error');

    closeModal(true);
    toast(
      `Đã import ${res.imported} bảng mới, cập nhật ${res.updated}, skip ${res.skipped}`,
      'success'
    );
    // Reload tab Schema nếu đang mở
    if (document.getElementById('tab-schema') && document.getElementById('tab-schema').innerHTML) {
      loadSchema();
    }
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function connectionEdit(id) {
  const adapters = await getAdapters();
  const list = await api('/api/admin/data-connections');
  const c = list.find((x) => x.id === id);
  if (!c) return toast('Không tìm thấy.', 'error');
  const adapter = adapters.find((a) => a.type === c.type);
  if (!adapter) return toast('Adapter không hỗ trợ.', 'error');

  openModal(`
    <h2>Sửa kết nối #${c.id}</h2>
    <div class="field-row">
      <div class="field"><label>Tên</label><input id="m_conn_name" value="${escapeAttr(c.name)}" /></div>
      <div class="field"><label>Loại</label><input value="${escapeAttr(c.type)}" disabled style="background:#f1f5f9" /></div>
    </div>
    <div class="field"><label>Mô tả</label><input id="m_conn_desc" value="${escapeAttr(c.description || '')}" /></div>
    ${adapter.configSchema.map((f) => connFieldHtml(f, c.config_json[f.key], 'm_conn_cfg_')).join('')}
    <div class="field"><label><input type="checkbox" id="m_conn_active" ${c.is_active ? 'checked' : ''}> Active</label></div>
    <div class="muted" style="margin-top:8px">Password đang hiển thị là ••••••••. Giữ nguyên nếu không đổi.</div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
      <button class="btn" onclick="connectionSubmitEdit(${c.id}, '${escapeAttr(c.type)}')">Lưu</button>
    </div>
  `);
}

async function connectionSubmitEdit(id, type) {
  try {
    const config = await collectConnConfig(type, 'm_conn_cfg_');
    await api(`/api/admin/data-connections/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: $('m_conn_name').value.trim(),
        type,
        description: $('m_conn_desc').value.trim(),
        config_json: config,
        is_active: $('m_conn_active').checked
      })
    });
    closeModal(true);
    toast('Đã lưu.', 'success');
    loadConnectionList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function connectionDelete(id) {
  const ok = await confirmDialog('Xoá kết nối này? Các file MinIO đã index sẽ bị xoá theo.');
  if (!ok) return;
  try {
    await api(`/api/admin/data-connections/${id}`, { method: 'DELETE' });
    toast('Đã xoá.', 'success');
    loadConnectionList();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

// =============================================================================
// TAB: MINIO FILES
// =============================================================================
async function loadMinioFiles() {
  $('tab-miniofiles').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>File MinIO đã index</h2>
        <span class="hint">Gán keywords để chatbot match được khi user hỏi "cho tôi file..."</span>
      </div>
      <div class="muted" style="margin-bottom:14px">
        Mỗi file cần có <b>keywords</b> (cách nhau bằng |) để chatbot tìm được.
        Vd file <code>ket-qua-xet-nghiem-2024-05.pdf</code> → keywords:
        <code>ket qua xet nghiem|xet nghiem thang 5|ket qua thang 5</code>.
      </div>
      <div id="minioFileListContainer"></div>
    </div>
  `;
  try {
    const list = await api('/api/admin/minio-files');
    if (!list.length) {
      $('minioFileListContainer').innerHTML = `
        <div class="empty">
          <div class="emoji">📦</div>
          Chưa có file nào được index. Vào tab <b>Kết nối DB / Storage</b> → bấm <b>Sync</b> trên 1 kết nối MinIO.
        </div>
      `;
      return;
    }
    $('minioFileListContainer').innerHTML = `
      <table class="data-grid">
        <thead><tr>
          <th style="width:50px">ID</th>
          <th>File</th>
          <th>Keywords</th>
          <th style="width:90px">Size</th>
          <th style="width:90px">Trạng thái</th>
          <th style="width:200px"></th>
        </tr></thead>
        <tbody>${list.map(minioFileRow).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

function minioFileRow(f) {
  const status = f.is_active ? '<span class="badge green">active</span>' : '<span class="badge gray">disabled</span>';
  return `
    <tr>
      <td>${f.id}</td>
      <td>
        <b>${escapeHtml(f.object_name)}</b>
        <div class="help mono" style="font-size:11px">${escapeHtml(f.connection_name)} · ${escapeHtml(f.bucket)}/${escapeHtml(f.object_key)}</div>
        ${f.description ? `<div class="help">${escapeHtml(f.description.slice(0, 60))}</div>` : ''}
      </td>
      <td class="mono" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;font-size:11.5px">${escapeHtml(f.keywords || '(chưa có)')}</td>
      <td>${f.size_bytes ? formatBytes(f.size_bytes) : ''}</td>
      <td>${status}</td>
      <td class="actions">
        <button class="btn ghost sm" onclick="minioFileLink(${f.id})">Link</button>
        <button class="btn ghost sm" onclick="minioFileEdit(${f.id})">Sửa</button>
        <button class="btn danger sm" onclick="minioFileDelete(${f.id})">Xoá</button>
      </td>
    </tr>
  `;
}

async function minioFileLink(id) {
  try {
    const res = await api(`/api/admin/minio-files/${id}/url`, { method: 'POST' });
    if (!res.ok) return toast('Lỗi: ' + res.error, 'error');
    window.open(res.url, '_blank');
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function minioFileEdit(id) {
  const list = await api('/api/admin/minio-files');
  const f = list.find((x) => x.id === id);
  if (!f) return toast('Không tìm thấy.', 'error');

  openModal(`
    <h2>Sửa metadata #${f.id}</h2>
    <div class="muted" style="margin-bottom:14px">
      File: <b>${escapeHtml(f.object_name)}</b><br>
      Path: <code>${escapeHtml(f.bucket)}/${escapeHtml(f.object_key)}</code>
    </div>
    <div class="field">
      <label>Keywords (cách nhau bằng |)</label>
      <input id="m_mfile_kw" value="${escapeAttr(f.keywords || '')}" placeholder="bang gia|gia dich vu|file gia" />
      <div class="help">Khi user hỏi chứa 1 trong các keyword này, chatbot sẽ trả về link file này.</div>
    </div>
    <div class="field">
      <label>Mô tả</label>
      <textarea id="m_mfile_desc" style="min-height:80px">${escapeHtml(f.description || '')}</textarea>
    </div>
    <div class="field"><label><input type="checkbox" id="m_mfile_active" ${f.is_active ? 'checked' : ''}> Active</label></div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal(false)">Huỷ</button>
      <button class="btn" onclick="minioFileSubmit(${id})">Lưu</button>
    </div>
  `);
}

async function minioFileSubmit(id) {
  try {
    await api(`/api/admin/minio-files/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        keywords: $('m_mfile_kw').value.trim(),
        description: $('m_mfile_desc').value.trim(),
        is_active: $('m_mfile_active').checked
      })
    });
    closeModal(true);
    toast('Đã lưu.', 'success');
    loadMinioFiles();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}

async function minioFileDelete(id) {
  const ok = await confirmDialog('Xoá metadata file này khỏi index? (File thật trên MinIO không bị xoá)');
  if (!ok) return;
  try {
    await api(`/api/admin/minio-files/${id}`, { method: 'DELETE' });
    toast('Đã xoá khỏi index.', 'success');
    loadMinioFiles();
  } catch (err) {
    toast('Lỗi: ' + err.message, 'error');
  }
}
