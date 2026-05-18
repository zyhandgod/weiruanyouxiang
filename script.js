// 全局变量
let currentPage = 1;
let itemsPerPage = 10;
let mailData = [];
let currentMailPage = 1;
const mailItemsPerPage = 10;
let currentEmailInfo = null; // { email, mailbox, mailboxCode, refreshToken, clientId }
let isSearching = false;
let searchResults = [];
let selectedItems = [];

// Loading 控制
function showLoading() { document.getElementById('loading-overlay').style.display = 'flex'; }
function hideLoading() { document.getElementById('loading-overlay').style.display = 'none'; }

// Toast 提示
function showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const iconMap = {
        success: 'fas fa-check-circle',
        error: 'fas fa-bug',
        warning: 'fas fa-exclamation-triangle',
        info: 'fas fa-info-circle'
    };
    toast.innerHTML = `
        <div style="font-size: 1.2rem;"><i class="${iconMap[type]}"></i></div>
        <div class="toast-content"><h4>${title}</h4><p>${message}</p></div>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, 3000);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    // 导航切换
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const targetId = tab.getAttribute('data-target');
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');
        });
    });

    // 文件上传
    const fileInput = document.getElementById('file-input');
    fileInput.addEventListener('change', function() {
        if (!this.files || this.files.length === 0) return;
        const delimiter = document.getElementById('delimiter').value.trim() || '----';
        const reader = new FileReader();
        reader.onload = e => {
            processImportContent(e.target.result, delimiter);
            fileInput.value = '';
        };
        reader.readAsText(this.files[0]);
    });

    // 粘贴后提示
    const manualInput = document.getElementById('manual-input');
    const pasteHint = document.getElementById('paste-hint');
    let hintTimer = null;

    function showPasteHint() {
        if (manualInput.value.trim().length > 0) {
            pasteHint.classList.add('show');
            hideEmptyGuide(); // 输入内容时自动关闭引导
            clearTimeout(hintTimer);
            hintTimer = setTimeout(() => pasteHint.classList.remove('show'), 5000);
        } else {
            pasteHint.classList.remove('show');
        }
    }

    manualInput.addEventListener('paste', () => setTimeout(showPasteHint, 50));
    manualInput.addEventListener('input', showPasteHint);

    // 搜索
    document.getElementById('search-input').addEventListener('input', function() {
        const query = this.value.trim().toLowerCase();
        if (query) performSearch(query);
        else clearSearch();
    });

    // 全选
    document.getElementById('select-all').addEventListener('change', function() {
        document.querySelectorAll('#email-table tbody input[type="checkbox"]').forEach(cb => cb.checked = this.checked);
        updateSelectedItems();
    });

    document.addEventListener('change', function(e) {
        if (e.target.matches('#email-table tbody input[type="checkbox"]')) {
            updateSelectedItems();
        }
    });

    // 刷新后空状态引导
    if ((JSON.parse(localStorage.getItem('emailData')) || []).length === 0) {
        showEmptyGuide();
    }

    // 初始加载数据渲染表格
    loadData();
});

// 空状态引导
function showEmptyGuide() {
    const overlay = document.getElementById('empty-guide');
    const wrapper = document.getElementById('paste-wrapper');
    if (!overlay || !wrapper) return;

    overlay.classList.add('show');
    wrapper.classList.add('guide-active');
    document.getElementById('manual-input').focus();

    function close() {
        hideEmptyGuide();
        document.removeEventListener('click', handler, true);
    }
    function handler(e) {
        close();
    }
    setTimeout(() => {
        document.addEventListener('click', handler, true);
    }, 100);
}

function hideEmptyGuide() {
    document.getElementById('empty-guide')?.classList.remove('show');
    document.getElementById('paste-wrapper')?.classList.remove('guide-active');
}

function performSearch(query) {
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    searchResults = data.filter(item => item.email.toLowerCase().includes(query));
    isSearching = true;
    currentPage = 1;
    renderTable(data);
}

function clearSearch() {
    isSearching = false;
    searchResults = [];
    currentPage = 1;
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    renderTable(data);
}

function updateSelectedItems() {
    selectedItems = Array.from(document.querySelectorAll('#email-table tbody input[type="checkbox"]:checked'))
        .map(cb => parseInt(cb.dataset.index));
}

function loadData() {
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    renderTable(data);
    const accountCount = document.getElementById('account-count');
    if (accountCount) accountCount.textContent = data.length;
}

function renderTable(data) {
    const tbody = document.querySelector('#email-table tbody');
    const noDataDiv = document.getElementById('no-data');
    const displayData = isSearching ? searchResults : data;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const pageData = displayData.slice(startIndex, startIndex + itemsPerPage);

    if (displayData.length === 0) {
        tbody.innerHTML = '';
        noDataDiv.style.display = 'block';
        document.querySelector('#emails .pagination-container').style.display = 'none';
    } else {
        noDataDiv.style.display = 'none';
        document.querySelector('#emails .pagination-container').style.display = 'flex';
        tbody.innerHTML = pageData.map((item, index) => {
            const originalIndex = isSearching ?
                data.findIndex(d => d.email === item.email && d.refreshToken === item.refreshToken) :
                startIndex + index;
            return `
                <tr>
                    <td><input type="checkbox" class="row-checkbox" data-index="${originalIndex}" style="accent-color: var(--primary);"></td>
                    <td style="color: var(--text-muted); font-size: 0.8rem;">${startIndex + index + 1}</td>
                    <td>
                        <div class="copy-group">
                            <span class="text-truncate" style="color: var(--secondary); font-weight:600;">${item.email}</span>
                            <button class="copy-btn" onclick="copyToClipboard('${item.email}', this)"><i class="fas fa-copy"></i></button>
                        </div>
                    </td>
                    <td>
                        <div class="copy-group">
                            <span class="text-truncate">••••••</span>
                            <button class="copy-btn" onclick="copyToClipboard('${item.password}', this)"><i class="fas fa-copy"></i></button>
                        </div>
                    </td>
                    <td>
                        <div class="copy-group">
                            <span class="text-truncate" title="${item.clientId}">${item.clientId}</span>
                            <button class="copy-btn" onclick="copyToClipboard('${item.clientId}', this)"><i class="fas fa-copy"></i></button>
                        </div>
                    </td>
                    <td>
                        <div class="copy-group">
                            <span class="text-truncate" title="${item.refreshToken}">${item.refreshToken}</span>
                            <button class="copy-btn" onclick="copyToClipboard('${item.refreshToken}', this)"><i class="fas fa-copy"></i></button>
                        </div>
                    </td>
                    <td>
                        <div style="display:flex; gap:6px;">
                            <button class="btn btn-primary btn-xs" onclick="viewInbox(${originalIndex})"><i class="fas fa-inbox"></i> 收件</button>
                            <button class="btn btn-warning btn-xs" onclick="viewJunk(${originalIndex})"><i class="fas fa-trash-restore"></i> 垃圾</button>
                            <button class="btn btn-danger btn-xs" onclick="deleteEmail(${originalIndex})"><i class="fas fa-times"></i> 删除</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }
    renderPagination(displayData.length);
    updateSelectedItems();
}

// 导入功能
function importEmails() {
    const delimiter = document.getElementById('delimiter').value.trim();
    const fileInput = document.getElementById('file-input');

    if (!delimiter) return showToast('错误', '请输入分隔符！', 'error');

    // 直接触发文件选择
    fileInput.value = '';
    fileInput.click();
}

function importEmailsManually() {
    const delimiter = document.getElementById('delimiter').value.trim();
    const manualInput = document.getElementById('manual-input');
    const input = manualInput.value.trim();

    if (!delimiter) return showToast('错误', '请输入分隔符！', 'error');
    if (!input) return showToast('错误', '请输入邮箱数据！', 'error');

    processImportContent(input, delimiter);

    // 无论成功失败都清空输入框
    manualInput.value = '';
    document.getElementById('paste-hint').classList.remove('show');
}

function processImportContent(content, delimiter) {
    const lines = content.split('\n');
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    const existingEmails = new Set(data.map(d => d.email.toLowerCase()));
    let count = 0;
    let duplicateCount = 0;
    let invalidCount = 0;

    lines.forEach(line => {
        if (!line.trim()) return;
        const fields = line.split(delimiter);
        if (fields.length >= 4) {
            const email = fields[0].trim();
            const password = fields[1].trim();
            const clientId = fields[2].trim();
            const refreshToken = fields[3].trim();
            if (email && clientId && refreshToken) {
                const emailLower = email.toLowerCase();
                if (existingEmails.has(emailLower)) {
                    duplicateCount++;
                } else {
                    data.push({ email, password, clientId, refreshToken });
                    existingEmails.add(emailLower);
                    count++;
                }
            } else {
                invalidCount++;
            }
        } else {
            invalidCount++;
        }
    });

    if (count > 0) {
        localStorage.setItem('emailData', JSON.stringify(data));
        loadData();
    }

    const msgs = [];
    if (count > 0) msgs.push(`新增 ${count} 条`);
    if (duplicateCount > 0) msgs.push(`跳过重复 ${duplicateCount} 条`);
    if (invalidCount > 0) msgs.push(`格式错误 ${invalidCount} 条`);

    if (count > 0) {
        showToast('导入完成', msgs.join('，'), 'success');
    } else if (duplicateCount > 0) {
        showToast('导入完成', msgs.join('，'), 'warning');
    } else {
        showToast('导入失败', '未识别到有效数据', 'error');
    }
}

// 删除功能
async function deleteEmail(index) {
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    const item = data[index];
    if (!item) return;
    const ok = await customConfirm(`确定要删除邮箱 ${item.email} 吗？`, '删除确认', true);
    if (!ok) return;
    data.splice(index, 1);
    localStorage.setItem('emailData', JSON.stringify(data));
    if (isSearching) clearSearch();
    loadData();
    showToast('删除成功', '邮箱已删除', 'success');
}

async function batchDelete() {
    if (selectedItems.length === 0) return showToast('提示', '请选择要删除的项', 'warning');
    const count = selectedItems.length;
    const ok = await customConfirm(`确定要删除选中的 ${count} 个邮箱吗？`, '批量删除', true);
    if (!ok) return;
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    const filtered = data.filter((_, index) => !selectedItems.includes(index));
    localStorage.setItem('emailData', JSON.stringify(filtered));
    if (isSearching) clearSearch();
    loadData();
    showToast('删除成功', `成功删除 ${count} 项`, 'success');
    selectedItems = [];
    document.getElementById('select-all').checked = false;
}

async function deleteAllEmails() {
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    if (data.length === 0) return showToast('提示', '没有数据', 'warning');
    const ok = await customConfirm(`确定要清空全部 ${data.length} 个邮箱吗？此操作不可恢复。`, '清空账号', true);
    if (!ok) return;
    localStorage.removeItem('emailData');
    loadData();
    showToast('删除成功', '所有邮箱已清空', 'success');
}

function exportAllEmails() {
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    if (data.length === 0) return showToast('提示', '没有数据可导出', 'warning');
    const delimiter = document.getElementById('delimiter').value.trim() || '----';
    const content = data.map(item => `${item.email}${delimiter}${item.password}${delimiter}${item.clientId}${delimiter}${item.refreshToken}`).join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '邮箱数据导出.txt';
    a.click();
    URL.revokeObjectURL(url);
    showToast('导出成功', `导出 ${data.length} 个邮箱`, 'success');
}

// 查看收件箱/垃圾箱
function viewInbox(index) {
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    const item = data[index];
    if (!item) return;
    currentEmailInfo = { email: item.email, mailbox: '收件箱', mailboxCode: 'INBOX', refreshToken: item.refreshToken, clientId: item.clientId };
    currentMailPage = 1;
    loadMailList(item.refreshToken, item.clientId, item.email, 'INBOX');
}

function viewJunk(index) {
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    const item = data[index];
    if (!item) return;
    currentEmailInfo = { email: item.email, mailbox: '垃圾箱', mailboxCode: 'Junk', refreshToken: item.refreshToken, clientId: item.clientId };
    currentMailPage = 1;
    loadMailList(item.refreshToken, item.clientId, item.email, 'Junk');
}

function loadMailList(refreshToken, clientId, email, mailbox) {
    if (currentEmailInfo) {
        currentEmailInfo.refreshToken = refreshToken;
        currentEmailInfo.clientId = clientId;
        currentEmailInfo.email = email;
        currentEmailInfo.mailboxCode = mailbox;
    }
    showLoading();
    // 改为本地 /api/mail-all（Microsoft 官方 IMAP/Graph）
    // 列表接口直接返回正文，保证点击“查看”马上能看到内容
    const apiUrl = `/api/mail-all?refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(clientId)}&email=${encodeURIComponent(email)}&mailbox=${encodeURIComponent(mailbox)}`;

    fetch(apiUrl)
        .then(res => {
            if (!res.ok && res.status !== 304) throw new Error(`请求失败: ${res.status}`);
            return res.json();
        })
        .then(data => {
            if (Array.isArray(data)) mailData = data;
            else if (data && Array.isArray(data.data)) mailData = data.data;
            else mailData = [];

            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            document.getElementById('mail-list').classList.add('active');
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));

            renderMailTable(mailData);
            const display = document.getElementById('current-email-display');
            if (display && currentEmailInfo) {
                display.innerHTML = `<span style="color:var(--secondary)">${currentEmailInfo.email}</span> / ${currentEmailInfo.mailbox}`;
            }
        })
        .catch(err => {
            console.error('加载邮件失败:', err);
            showToast('错误', '加载邮件失败: ' + err.message, 'error');
        })
        .finally(hideLoading);
}

function refreshCurrentMailbox() {
    if (!currentEmailInfo) return showToast('提示', '当前没有可刷新的邮箱', 'warning');
    currentMailPage = 1;
    loadMailList(currentEmailInfo.refreshToken, currentEmailInfo.clientId, currentEmailInfo.email, currentEmailInfo.mailboxCode || 'INBOX');
}

function backToEmailManagement() {
    document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
    document.getElementById('emails').classList.add('active');
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.nav-tab[data-target="emails"]')?.classList.add('active');
}

function renderMailTable(data) {
    const tbody = document.querySelector('#mail-table tbody');
    const noData = document.getElementById('no-mail-data');

    if (data.length === 0) {
        tbody.innerHTML = '';
        noData.style.display = 'block';
        document.querySelector('#mail-list .pagination-container').style.display = 'none';
        return;
    }

    noData.style.display = 'none';
    document.querySelector('#mail-list .pagination-container').style.display = 'flex';

    const start = (currentMailPage - 1) * mailItemsPerPage;
    const pageData = data.slice(start, start + mailItemsPerPage);

    tbody.innerHTML = pageData.map((item, index) => `
        <tr>
            <td><div class="text-truncate" style="background:none; max-width:150px;">${item.send || ''}</div></td>
            <td><div style="font-weight:500; color:var(--primary); cursor:pointer;" onclick="viewMail(${start + index})">${item.subject || '(无主题)'}</div></td>
            <td style="color: var(--text-muted); font-size: 0.8rem;">${item.date || ''}</td>
            <td><button class="btn btn-primary btn-xs" onclick="viewMail(${start + index})">查看</button></td>
        </tr>
    `).join('');

    renderMailPagination(data.length);
}

function renderMailPagination(total) {
    const pagination = document.getElementById('pagination-mail');
    pagination.innerHTML = '';
    const totalPages = Math.ceil(total / mailItemsPerPage);
    for (let i = 1; i <= totalPages; i++) {
        const btn = document.createElement('button');
        btn.textContent = i;
        btn.className = 'page-btn';
        if (i === currentMailPage) btn.classList.add('active');
        btn.onclick = () => { currentMailPage = i; renderMailTable(mailData); };
        pagination.appendChild(btn);
    }
}

async function viewMail(index) {
    const item = mailData[index];
    if (!item) return;
    document.getElementById('mail-modal-title').textContent = item.subject || '无主题';
    document.getElementById('mail-modal-sender').textContent = item.send || '未知';
    document.getElementById('mail-modal-subject').textContent = item.subject || '';
    document.getElementById('mail-modal-date').textContent = item.date || '';
    document.getElementById('mail-modal-content').innerHTML = item.html || item.text || '<span style="color:var(--text-muted)">正文加载中...</span>';
    document.getElementById('mail-modal').style.display = 'flex';

    // IMAP 列表为提速只返回头部；点击详情时再拉正文，并写回缓存，第二次打开无需重复请求。
    if ((!item.html && !item.text) && item.uid && currentEmailInfo) {
        try {
            const bodyUrl = `/api/mail-body?refresh_token=${encodeURIComponent(currentEmailInfo.refreshToken)}&client_id=${encodeURIComponent(currentEmailInfo.clientId)}&email=${encodeURIComponent(currentEmailInfo.email)}&mailbox=${encodeURIComponent(currentEmailInfo.mailboxCode || 'INBOX')}&uid=${encodeURIComponent(item.uid)}`;
            const res = await fetch(bodyUrl);
            if (!res.ok) throw new Error(`请求失败: ${res.status}`);
            const detail = await res.json();
            Object.assign(item, detail);
            document.getElementById('mail-modal-title').textContent = item.subject || '无主题';
            document.getElementById('mail-modal-sender').textContent = item.send || '未知';
            document.getElementById('mail-modal-subject').textContent = item.subject || '';
            document.getElementById('mail-modal-date').textContent = item.date || '';
        } catch (err) {
            console.error('加载邮件正文失败:', err);
            document.getElementById('mail-modal-content').innerHTML = `<span style="color:var(--danger)">正文加载失败: ${err.message}</span>`;
            return;
        }
    }

    document.getElementById('mail-modal-content').innerHTML = item.html || item.text || '<span style="color:var(--text-muted)">无内容</span>';
}

function closeMailModal() {
    document.getElementById('mail-modal').style.display = 'none';
}

// 邮件详情弹窗：支持 ESC 和点击空白遮罩关闭
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const mailModal = document.getElementById('mail-modal');
        if (mailModal && mailModal.style.display === 'flex') closeMailModal();
    }
});

document.getElementById('mail-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMailModal();
});

// 自定义确认对话框
let _confirmResolve = null;
function customConfirm(message, title = '确认', danger = false) {
    return new Promise(resolve => {
        _confirmResolve = resolve;
        document.getElementById('confirm-modal-title').textContent = title;
        document.getElementById('confirm-modal-message').textContent = message;
        const okBtn = document.getElementById('confirm-ok-btn');
        okBtn.classList.toggle('btn-danger-confirm', danger);
        document.getElementById('confirm-modal').style.display = 'flex';
    });
}

function closeConfirm(result) {
    document.getElementById('confirm-modal').style.display = 'none';
    if (_confirmResolve) {
        _confirmResolve(result);
        _confirmResolve = null;
    }
}

// 分页
function renderPagination(total) {
    const pagination = document.getElementById('pagination');
    pagination.innerHTML = '';
    const totalPages = Math.ceil(total / itemsPerPage);
    const maxBtns = 5;
    let start = Math.max(1, currentPage - Math.floor(maxBtns / 2));
    let end = Math.min(totalPages, start + maxBtns - 1);
    if (end - start + 1 < maxBtns) start = Math.max(1, end - maxBtns + 1);

    if (currentPage > 1) {
        const prev = document.createElement('button');
        prev.innerHTML = '<i class="fas fa-chevron-left"></i>';
        prev.className = 'page-btn';
        prev.onclick = () => changePage(currentPage - 1);
        pagination.appendChild(prev);
    }

    for (let i = start; i <= end; i++) {
        const btn = document.createElement('button');
        btn.textContent = i;
        btn.className = 'page-btn';
        if (i === currentPage) btn.classList.add('active');
        btn.onclick = () => changePage(i);
        pagination.appendChild(btn);
    }

    if (currentPage < totalPages) {
        const next = document.createElement('button');
        next.innerHTML = '<i class="fas fa-chevron-right"></i>';
        next.className = 'page-btn';
        next.onclick = () => changePage(currentPage + 1);
        pagination.appendChild(next);
    }
}

function changePage(page) {
    currentPage = page;
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    renderTable(data);
}

function changeItemsPerPage(value) {
    itemsPerPage = parseInt(value, 10);
    currentPage = 1;
    const data = JSON.parse(localStorage.getItem('emailData')) || [];
    renderTable(data);
}

// 复制
function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        const icon = btn.querySelector('i');
        icon.className = 'fas fa-check';
        btn.style.color = '#10b981';
        setTimeout(() => {
            icon.className = 'fas fa-copy';
            btn.style.color = '';
        }, 1000);
    });
}
