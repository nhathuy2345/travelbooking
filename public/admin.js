// Đường dẫn gốc của API Backend
const API_BASE = ''; // Dùng relative URL vì Cloudflare Pages Functions tự động xử lý API trên cùng domain

// Admin Panel Authentication Token
const token = localStorage.getItem('reseller_admin_token');

// Helper escape HTML chống XSS
function escapeHtml(unsafe) {
  return (unsafe || '').toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Application State
let currentConfig = {};
const state = {
  activeTab: 'dashboard',
  basePrices: {
    1: 150000,
    2: 100000,
    3: 50000
  }
};

// DOM Elements (Initialized in initAdmin when DOM is fully loaded)
let elements = {};

// Tab details mapping
const tabDetails = {
  stats: {
    title: 'Thống kê Doanh thu',
    desc: 'Xem tổng quan doanh thu, số lượng thiết bị, thành viên và biểu đồ doanh thu 30 ngày gần nhất.'
  },
  dashboard: {
    title: 'Quản lý thiết bị',
    desc: 'Quản lý danh sách thiết bị khách hàng liên kết cert và thực hiện check trạng thái unban.'
  },
  'users-config': {
    title: 'Quản lý Thành viên',
    desc: 'Tìm kiếm, xem thông tin chi tiết, lịch sử nạp, sửa số dư, khóa hoặc xóa tài khoản thành viên.'
  },
  'price-config': {
    title: 'Cấu hình Giá Bán',
    desc: 'Set giá bán nạp tiền VietQR chênh lệch để thu lợi nhuận trực tiếp từ khách hàng.'
  },
  'system-config': {
    title: 'Kết nối API & Tài khoản',
    desc: 'Cài đặt liên kết khóa bảo mật Muacert, cổng Pay2S và tài khoản đăng nhập admin đại lý.'
  },
  'backup-config': {
    title: 'Sao lưu & Khôi phục',
    desc: 'Xuất toàn bộ dữ liệu hệ thống ra file JSON hoặc khôi phục dữ liệu từ file đã sao lưu.'
  },
  'logs-config': {
    title: 'Nhật ký Hệ thống',
    desc: 'Theo dõi các thao tác nạp tiền, mua cert, lỗi hệ thống và dọn dẹp log cũ.'
  }
};

// ==========================================
// SECURITY GUARD & INITIALIZATION
// ==========================================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdmin);
} else {
  initAdmin();
}

async function initAdmin() {
  // Query all DOM elements safely now that DOM is fully parsed and loaded
  elements = {
    navItems: document.querySelectorAll('.nav-menu .nav-item'),
    tabViews: document.querySelectorAll('.tab-view'),
    viewTitle: document.getElementById('view-title'),
    viewDesc: document.getElementById('view-desc'),
    logoutBtn: document.getElementById('logout-btn'),

    // Stats
    statTotalRevenue: document.getElementById('stat-total-revenue'),
    statTotalDevices: document.getElementById('stat-total-devices'),
    statTotalUsers: document.getElementById('stat-total-users'),
    revenueChartCanvas: document.getElementById('revenueChart'),

    // Devices Management
    devicesTbody: document.getElementById('devices-list-tbody'),
    refreshDevicesBtn: document.getElementById('refresh-devices-btn'),
    openDirectRegisterBtn: document.getElementById('open-direct-register-btn'),
    directRegisterPanel: document.getElementById('direct-register-panel'),
    directRegisterForm: document.getElementById('direct-register-form'),
    searchDeviceUdidInput: document.getElementById('search-device-udid-input'),
    searchDeviceUdidBtn: document.getElementById('search-device-udid-btn'),
    btnDevicesPrev: document.getElementById('btn-devices-prev'),
    btnDevicesNext: document.getElementById('btn-devices-next'),
    devicesPageInfo: document.getElementById('devices-page-info'),
    regUdid: document.getElementById('reg-udid'),
    regName: document.getElementById('reg-name'),
    regModel: document.getElementById('reg-model'),
    regPackage: document.getElementById('reg-package'),
    regNickname: document.getElementById('reg-nickname'),

    // Profit Pricing Markup Config
    priceForm: document.getElementById('price-markup-form'),
    pricePack1: document.getElementById('price-pack1'),
    pricePack2: document.getElementById('price-pack2'),
    pricePack3: document.getElementById('price-pack3'),
    profitPack1: document.getElementById('profit-pack1'),
    profitPack2: document.getElementById('profit-pack2'),
    profitPack3: document.getElementById('profit-pack3'),

    namePack1: document.getElementById('name-pack1'),
    namePack2: document.getElementById('name-pack2'),
    namePack3: document.getElementById('name-pack3'),
    warrantyPack1: document.getElementById('warranty-pack1'),
    warrantyPack2: document.getElementById('warranty-pack2'),
    warrantyPack3: document.getElementById('warranty-pack3'),
    featuresPack1: document.getElementById('features-pack1'),
    featuresPack2: document.getElementById('features-pack2'),
    featuresPack3: document.getElementById('features-pack3'),

    // System Configurations
    systemConfigForm: document.getElementById('system-config-form'),
    muacertToken: document.getElementById('muacert-token'),
    pay2sPartnerCode: document.getElementById('pay2s-partner-code'),
    pay2sAccessKey: document.getElementById('pay2s-access-key'),
    pay2sKey: document.getElementById('pay2s-key'),
    pay2sBankAccount: document.getElementById('pay2s-bank-account'),
    pay2sBankCode: document.getElementById('pay2s-bank-code'),
    pay2sAccountName: document.getElementById('pay2s-account-name'),
    adminUsername: document.getElementById('admin-username'),
    adminPassword: document.getElementById('admin-password'),
    supportUrl: document.getElementById('support-url'),

    // Users Management
    usersTbody: document.getElementById('users-list-tbody'),
    refreshUsersBtn: document.getElementById('refresh-users-btn'),
    searchUdidInput: document.getElementById('search-udid-input'),
    searchUsernameInput: document.getElementById('search-username-input'),
    searchUdidBtn: document.getElementById('search-udid-btn'),
    btnCleanupInactive: document.getElementById('btn-cleanup-inactive'),
    userDetailsPanel: document.getElementById('user-details-panel'),
    detailUsername: document.getElementById('detail-username'),
    detailCreated: document.getElementById('detail-created'),
    detailBalance: document.getElementById('detail-balance'),
    detailDeposited: document.getElementById('detail-deposited'),
    detailSpent: document.getElementById('detail-spent'),
    detailStatus: document.getElementById('detail-status'),
    adjustBalanceAmount: document.getElementById('adjust-balance-amount'),
    btnAdjustBalance: document.getElementById('btn-adjust-balance'),
    newPasswordInput: document.getElementById('new-password-input'),
    btnChangePassword: document.getElementById('btn-change-password'),
    btnToggleLock: document.getElementById('btn-toggle-lock'),
    btnDeleteUser: document.getElementById('btn-delete-user'),
    userTransactionsTbody: document.getElementById('user-transactions-tbody'),

    // Backup & Restore
    exportBackupBtn: document.getElementById('export-backup-btn'),
    importBackupFile: document.getElementById('import-backup-file'),
    selectBackupBtn: document.getElementById('select-backup-btn'),
    selectedFileInfo: document.getElementById('selected-file-info'),
    selectedFileName: document.getElementById('selected-file-name'),
    importBackupBtn: document.getElementById('import-backup-btn'),

    // Logs
    refreshLogsBtn: document.getElementById('refresh-logs-btn'),
    clearLogsBtn: document.getElementById('clear-logs-btn'),
    logsTbody: document.getElementById('logs-list-tbody'),
    logsPageInfo: document.getElementById('logs-page-info'),
    btnLogsPrev: document.getElementById('btn-logs-prev'),
    btnLogsNext: document.getElementById('btn-logs-next')
  };

  try {
    const authOk = await verifyAdminSession();
    if (!authOk) return;

    setupNavigation();
    loadConfigurations();
    loadDevicesList(1);
    setupEventListeners();
    loadStats();
  } catch (error) {
    console.error("Initialization error in admin.js:", error);
  }
}

let revenueChartInstance = null;

async function loadStats() {
  try {
    const res = await fetch(API_BASE + '/api/admin/stats', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.success) {
      const { overview, chart } = data.data;
      
      if (elements.statTotalRevenue) elements.statTotalRevenue.innerText = (overview.revenue || 0).toLocaleString() + 'đ';
      if (elements.statTotalDevices) elements.statTotalDevices.innerText = overview.devices || 0;
      if (elements.statTotalUsers) elements.statTotalUsers.innerText = overview.users || 0;

      if (elements.revenueChartCanvas && chart && chart.length > 0) {
        const labels = chart.map(item => item.date);
        const depositData = chart.map(item => item.total_deposit);
        const purchaseData = chart.map(item => item.total_purchase);

        if (revenueChartInstance) {
          revenueChartInstance.destroy();
        }

        revenueChartInstance = new Chart(elements.revenueChartCanvas, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Tiền nạp vào (VNĐ)',
                data: depositData,
                borderColor: '#10B981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4
              },
              {
                label: 'Tiền mua Cert (VNĐ)',
                data: purchaseData,
                borderColor: '#4F46E5',
                backgroundColor: 'rgba(79, 70, 229, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                labels: { color: '#9ca3af' }
              }
            },
            scales: {
              y: {
                beginAtZero: true,
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#9ca3af' }
              },
              x: {
                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                ticks: { color: '#9ca3af' }
              }
            }
          }
        });
      }
    }
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

async function verifyAdminSession() {
  if (!token) {
    redirectToLogin();
    return false;
  }

  try {
    const res = await fetch(API_BASE + '/api/admin/check', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      redirectToLogin();
      return false;
    }
    return true;
  } catch (e) {
    console.error('Connection failure to auth server:', e);
    // Khi không kết nối được server -> chặn truy cập, bắt đăng nhập lại cho an toàn
    redirectToLogin();
    return false;
  }
}

function redirectToLogin() {
  localStorage.removeItem('reseller_admin_token');
  window.location.href = 'login.html';
}

// ==========================================
// 1. ROUTING / NAVIGATION
// ==========================================
function setupNavigation() {
  elements.navItems.forEach(item => {
    // Bind click directly to the list item container
    item.addEventListener('click', (e) => {
      const tabId = item.getAttribute('data-tab');
      if (tabId) switchTab(tabId);
    });

    // Dual-binding: also bind directly to the button inside to bypass WebKit click capture bugs
    const btn = item.querySelector('button');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent double bubbles
        const tabId = item.getAttribute('data-tab');
        if (tabId) switchTab(tabId);
      });
    }
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;

  elements.navItems.forEach(nav => {
    if (nav.getAttribute('data-tab') === tabId) {
      nav.classList.add('active');
    } else {
      nav.classList.remove('active');
    }
  });

  elements.tabViews.forEach(view => {
    if (view.id === `tab-${tabId}`) {
      view.classList.add('active');
    } else {
      view.classList.remove('active');
    }
  });

  const details = tabDetails[tabId] || { title: 'Portal', desc: '' };
  if (elements.viewTitle) elements.viewTitle.innerText = details.title;
  if (elements.viewDesc) elements.viewDesc.innerText = details.desc;

  if (tabId === 'dashboard') {
    loadDevicesList(1);
  } else if (tabId === 'users-config') {
    loadUsersList(1);
  } else if (tabId === 'price-config' || tabId === 'system-config') {
    loadConfigurations();
  }
}

// ==========================================
// 2. CONFIGURATIONS LOGIC
// ==========================================
async function loadConfigurations() {
  try {
    const res = await fetch(API_BASE + '/api/config', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      if (res.status === 401) redirectToLogin();
      return;
    }

    const responseData = await res.json();
    const config = responseData.config || responseData; // Lấy đúng object config
    currentConfig = config;

    // Config forms autofill
    if (elements.muacertToken) elements.muacertToken.value = config.muacertToken || '';
    if (elements.pay2sPartnerCode) elements.pay2sPartnerCode.value = config.pay2sPartnerCode || '';
    if (elements.pay2sAccessKey) elements.pay2sAccessKey.value = config.pay2sAccessKey || '';
    if (elements.pay2sKey) elements.pay2sKey.value = config.pay2sSecretKey || '';
    if (elements.pay2sBankAccount) elements.pay2sBankAccount.value = config.pay2sBankAccount || '';
    if (elements.pay2sBankCode) elements.pay2sBankCode.value = config.pay2sBankCode || 'MB';
    if (elements.pay2sAccountName) elements.pay2sAccountName.value = config.pay2sAccountName || '';
    if (elements.adminUsername) elements.adminUsername.value = config.adminUsername || 'admin';
    if (elements.adminPassword) elements.adminPassword.value = ''; // security empty
    if (elements.supportUrl) elements.supportUrl.value = config.supportUrl || 'https://t.me/ipamaster';
    if (elements.udidUrl) elements.udidUrl.value = config.udidUrl || '/udid';

    // Price markups autofill
    const prices = config.sellingPrices || { 1: 180000, 2: 120000, 3: 70000 };
    if (elements.pricePack1) elements.pricePack1.value = prices[1];
    if (elements.pricePack2) elements.pricePack2.value = prices[2];
    if (elements.pricePack3) elements.pricePack3.value = prices[3];

    // Dynamic packages autofill
    const packages = config.packages || {
      1: { name: "Gói Cao Cấp VIP", warranty: "Bảo hành trọn đời", features: ["Chứng chỉ VIP Độc quyền", "Duyệt siêu tốc dưới 24h", "Hỗ trợ bypass thu hồi vĩnh viễn"] },
      2: { name: "Gói Tiêu Chuẩn", warranty: "Bảo hành 6 tháng", features: ["Chứng chỉ Reseller riêng", "Kích hoạt trong 24h-48h", "Duyệt nhanh Bypass unban"] },
      3: { name: "Gói Cơ Bản (Basic)", warranty: "Bảo hành 1 tháng", features: ["Chứng chỉ dùng chung", "Kích hoạt trong 72h", "Thích hợp test ứng dụng"] }
    };

    if (elements.namePack1) elements.namePack1.value = packages[1].name || 'Gói Cao Cấp VIP';
    if (elements.namePack2) elements.namePack2.value = packages[2].name || 'Gói Tiêu Chuẩn';
    if (elements.namePack3) elements.namePack3.value = packages[3].name || 'Gói Cơ Bản (Basic)';

    if (elements.warrantyPack1) elements.warrantyPack1.value = packages[1].warranty || 'Bảo hành trọn đời';
    if (elements.warrantyPack2) elements.warrantyPack2.value = packages[2].warranty || 'Bảo hành 6 tháng';
    if (elements.warrantyPack3) elements.warrantyPack3.value = packages[3].warranty || 'Bảo hành 1 tháng';

    if (elements.featuresPack1) elements.featuresPack1.value = (packages[1].features || []).join('\n');
    if (elements.featuresPack2) elements.featuresPack2.value = (packages[2].features || []).join('\n');
    if (elements.featuresPack3) elements.featuresPack3.value = (packages[3].features || []).join('\n');

    // Trigger price chênh lệch calculations
    calculateProfitDisplay();

  } catch (error) {
    console.error('Error loading config:', error);
  }
}

// Pricing margin calculators
function calculateProfitDisplay() {
  const p1 = elements.pricePack1 ? (parseInt(elements.pricePack1.value) || 0) : 0;
  const p2 = elements.pricePack2 ? (parseInt(elements.pricePack2.value) || 0) : 0;
  const p3 = elements.pricePack3 ? (parseInt(elements.pricePack3.value) || 0) : 0;

  if (elements.profitPack1) elements.profitPack1.innerText = (p1 - state.basePrices[1]).toLocaleString();
  if (elements.profitPack2) elements.profitPack2.innerText = (p2 - state.basePrices[2]).toLocaleString();
  if (elements.profitPack3) elements.profitPack3.innerText = (p3 - state.basePrices[3]).toLocaleString();
}

async function savePricingMarkup(e) {
  if (e) e.preventDefault();

  const sellingPrices = {
    1: parseInt(elements.pricePack1.value) || 180000,
    2: parseInt(elements.pricePack2.value) || 120000,
    3: parseInt(elements.pricePack3.value) || 70000
  };

  // Strip \r (Windows line endings), trim each line, remove blank lines
  const parseFeatures = (val) => (val || '').replace(/\r/g, '').split('\n').map(f => f.trim()).filter(f => f.length > 0);

  const packages = {
    1: {
      name: elements.namePack1.value.trim(),
      warranty: elements.warrantyPack1.value.trim(),
      features: parseFeatures(elements.featuresPack1.value)
    },
    2: {
      name: elements.namePack2.value.trim(),
      warranty: elements.warrantyPack2.value.trim(),
      features: parseFeatures(elements.featuresPack2.value)
    },
    3: {
      name: elements.namePack3.value.trim(),
      warranty: elements.warrantyPack3.value.trim(),
      features: parseFeatures(elements.featuresPack3.value)
    }
  };

  try {
    const res = await fetch(API_BASE + '/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ sellingPrices, packages })
    });

    const result = await res.json();
    if (res.ok && result.success) {
      alert('Đã cập nhật cấu hình chi tiết các gói và giá bán đại lý thành công!');
      loadConfigurations();
    } else {
      alert('Lỗi cập nhật: ' + result.message);
    }
  } catch (error) {
    alert('Lỗi kết nối server: ' + error.message);
  }
}

async function saveSystemConfigurations(e) {
  if (e) e.preventDefault();

  const data = {
    muacertToken: elements.muacertToken.value,
    pay2sPartnerCode: elements.pay2sPartnerCode.value.trim(),
    pay2sAccessKey: elements.pay2sAccessKey.value,
    pay2sSecretKey: elements.pay2sKey.value,
    pay2sBankAccount: elements.pay2sBankAccount.value,
    pay2sBankCode: elements.pay2sBankCode.value,
    pay2sAccountName: elements.pay2sAccountName.value,
    adminUsername: elements.adminUsername.value.trim(),
    adminPassword: elements.adminPassword.value,
    supportUrl: elements.supportUrl ? elements.supportUrl.value.trim() : '',
    isSandbox: currentConfig.isSandbox !== undefined ? currentConfig.isSandbox : true
  };

  try {
    const res = await fetch(API_BASE + '/api/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(data)
    });

    const result = await res.json();
    if (res.ok && result.success) {
      alert('Đã lưu cấu hình khóa kết nối & mật khẩu tài khoản thành công!');
      // Không gọi loadConfigurations() để giữ nguyên các giá trị vừa nhập trên form
    } else {
      alert('Lỗi: ' + result.message);
    }
  } catch (error) {
    alert('Lỗi mạng: ' + error.message);
  }
}

// ==========================================
// 3. DEVICES MANAGER
// ==========================================
let currentDevicesPage = 1;
const devicesLimit = 50;

async function loadDevicesList(page = 1) {
  try {
    const res = await fetch(API_BASE + `/api/admin/devices?page=${page}&limit=${devicesLimit}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = await res.json();

    if (result.code !== 0) {
      elements.devicesTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 1.5rem;">Thất bại: ${escapeHtml(result.message)}</td></tr>`;
      elements.statDevicesCount.innerText = '0';
      return;
    }

    const devices = result.data?.devicesList || [];
    const pagination = result.data?.pagination;
    
    if (pagination) {
      elements.statDevicesCount.innerText = pagination.totalDevices || devices.length;
      updateDevicesPagination(pagination);
    } else {
      elements.statDevicesCount.innerText = devices.length;
    }

    renderDevicesList(devices);
  } catch (error) {
    elements.devicesTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 1.5rem;">Không thể nạp dữ liệu từ Express backend</td></tr>`;
  }
}

function updateDevicesPagination(pagination) {
  if (!elements.btnDevicesPrev || !elements.btnDevicesNext || !elements.devicesPageInfo) return;

  currentDevicesPage = pagination.page;
  elements.devicesPageInfo.textContent = `Trang ${pagination.page} / ${pagination.totalPages || 1} (Tổng: ${pagination.totalDevices})`;

  elements.btnDevicesPrev.disabled = pagination.page <= 1;
  elements.btnDevicesNext.disabled = pagination.page >= pagination.totalPages;

  elements.btnDevicesPrev.onclick = () => {
    if (pagination.page > 1) loadDevicesList(pagination.page - 1);
  };
  elements.btnDevicesNext.onclick = () => {
    if (pagination.page < pagination.totalPages) loadDevicesList(pagination.page + 1);
  };
}

async function searchDeviceByUdid() {
  const udid = elements.searchDeviceUdidInput?.value.trim();
  if (!udid) {
    loadDevicesList(1);
    return;
  }

  elements.devicesTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Đang tìm kiếm...</td></tr>';

  try {
    const res = await fetch(API_BASE + `/api/admin/devices/search?udid=${encodeURIComponent(udid)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = await res.json();

    if (result.code === 0) {
      const devices = result.data?.devicesList || [];
      renderDevicesList(devices);
      
      // Hide pagination when searching
      if (elements.devicesPageInfo) elements.devicesPageInfo.textContent = `Kết quả tìm kiếm: ${devices.length}`;
      if (elements.btnDevicesPrev) elements.btnDevicesPrev.disabled = true;
      if (elements.btnDevicesNext) elements.btnDevicesNext.disabled = true;
    } else {
      elements.devicesTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 1.5rem;">Lỗi: ${escapeHtml(result.message)}</td></tr>`;
    }
  } catch (error) {
    elements.devicesTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 1.5rem;">Lỗi kết nối</td></tr>`;
  }
}

function renderDevicesList(devices) {
  if (devices.length === 0) {
    elements.devicesTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không tìm thấy thiết bị nào.</td></tr>`;
    return;
  }

  elements.devicesTbody.innerHTML = '';
  const packMeta = state.packages || {};
  devices.forEach(device => {
    const addedDate = new Date(device.attributes.addedAt).toLocaleDateString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const packName = (packMeta[device.package] && packMeta[device.package].name) || `Gói ${device.package}`;

    const tr = document.createElement('tr');
    
    // Escape HTML để chống XSS
    const escapeHtml = (unsafe) => {
      return (unsafe || '').toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };
    
    const safeName = escapeHtml(device.attributes.name);
    const safeModel = escapeHtml(device.attributes.model);
    const safeUdid = escapeHtml(device.attributes.udid);
    
    tr.innerHTML = `
      <td style="font-weight: 600; color: white;">
        ${safeName}
        <div style="font-size: 0.75rem; color: var(--text-muted); font-weight:400;">Model: ${safeModel}</div>
      </td>
      <td style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-muted);">${safeUdid}</td>
      <td style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--text-muted);">${device.id}</td>
      <td><span style="color: var(--primary); font-weight: 600;">${packName}</span></td>
      <td style="font-size: 0.8rem; color: var(--text-muted);">${addedDate}</td>
      <td>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-secondary" onclick="downloadAdminCert('${device.id}', '${device.attributes.udid}', '${safeName}')" style="padding: 4px 8px; font-size: 0.75rem;">Certs Zip</button>
          <button class="btn btn-secondary" onclick="deleteDevice('${device.id}')" style="padding: 4px 8px; font-size: 0.75rem; color: var(--danger); border-color: rgba(239, 68, 68, 0.1);">Xóa</button>
        </div>
      </td>
    `;
    elements.devicesTbody.appendChild(tr);
  });
}

window.checkStatusQuick = async (id) => {
  try {
    const res = await fetch(API_BASE + `/api/devices/${id}/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const statusResult = await res.json();
    if (statusResult.code === 0) {
      const data = statusResult.data;
      alert(`Trạng thái thiết bị ID: ${id}\nUDID: ${data.udid}\nStatus: ${data.status.toUpperCase()}\nBị Apple thu hồi (Revoked): ${data.revoked ? 'CÓ (REVOKED)' : 'KHÔNG'}`);
    } else {
      alert('Không thể đọc trạng thái thiết bị: ' + statusResult.message);
    }
  } catch (e) {
    alert('Lỗi kiểm tra mạng: ' + e.message);
  }
};

window.downloadAdminCert = async (deviceId, udid, name) => {
  try {
    const res = await fetch(API_BASE + `/api/devices/${deviceId}/provision?udid=${encodeURIComponent(udid)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error('Lỗi tải cert admin:', res.status, errorText);
      alert('Không thể tải chứng chỉ. Vui lòng thử lại sau.');
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name || 'cert'}_${udid}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Lỗi tải cert admin:', error);
    alert('Lỗi mạng khi tải chứng chỉ.');
  }
};

window.deleteDevice = async (id) => {
  if (!confirm(`Bạn có đồng ý soft-delete thiết bị ID ${id} trên hệ thống không?`)) return;

  try {
    const res = await fetch(API_BASE + `/api/devices/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const result = await res.json();
    if (res.ok && (result.code === 0 || result.success)) {
      alert('Đã xóa mềm thiết bị thành công!');
      loadDevicesList(currentDevicesPage);
    } else {
      alert('Xóa thất bại: ' + result.message);
    }
  } catch (e) {
    alert('Lỗi mạng: ' + e.message);
  }
};

// Admin Direct Register form submit
async function handleDirectRegisterSubmit(e) {
  if (e) e.preventDefault();

  const data = {
    username: elements.regNickname.value.trim() || 'admin',
    udid: elements.regUdid.value.trim(),
    name: elements.regName.value.trim(),
    model: elements.regModel.value.trim() || 'iPhone',
    packageId: parseInt(elements.regPackage.value)
  };

  try {
    const res = await fetch(API_BASE + '/api/admin/devices/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(data)
    });

    const result = await res.json();
    if (res.ok && result.success) {
      alert(`Đăng ký thành công thiết bị cho khách hàng!`);
      elements.directRegisterPanel.style.display = 'none';
      elements.directRegisterForm.reset();
      loadDevicesList(1);
    } else {
      alert(`Thêm thất bại: ${result.message}`);
    }
  } catch (error) {
    alert('Lỗi mạng proxy API: ' + error.message);
  }
}

// ==========================================
// GENERAL LOGOUT & EVENT BINDINGS
// ==========================================
function setupEventListeners() {
  // Logout Trigger
  const handleLogout = async () => {
    try {
      await fetch(API_BASE + '/api/admin/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (e) { }
    redirectToLogin();
  };

  if (elements.logoutBtn) {
    elements.logoutBtn.addEventListener('click', handleLogout);
  }

  const mobileLogoutBtn = document.getElementById('mobile-logout-btn');
  if (mobileLogoutBtn) {
    mobileLogoutBtn.addEventListener('click', handleLogout);
  }

  // Refresh devices
  if (elements.refreshDevicesBtn) {
    elements.refreshDevicesBtn.addEventListener('click', () => loadDevicesList(1));
  }
  if (elements.searchDeviceUdidBtn) {
    elements.searchDeviceUdidBtn.addEventListener('click', searchDeviceByUdid);
  }
  if (elements.searchDeviceUdidInput) {
    elements.searchDeviceUdidInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchDeviceByUdid();
    });
  }

  // Sync devices from Muacert
  const syncDevicesBtn = document.getElementById('sync-devices-btn');
  if (syncDevicesBtn) {
    syncDevicesBtn.addEventListener('click', async () => {
      if (!confirm('Bạn có chắc chắn muốn đồng bộ toàn bộ thiết bị từ Muacert về Database không? Quá trình này có thể mất vài giây.')) return;
      
      const originalText = syncDevicesBtn.innerText;
      syncDevicesBtn.innerText = 'Đang đồng bộ...';
      syncDevicesBtn.disabled = true;
      
      try {
        const res = await fetch(API_BASE + '/api/admin/devices/sync', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        
        if (res.ok && result.success) {
          alert(result.message);
          loadDevicesList(1);
        } else {
          alert('Đồng bộ thất bại: ' + result.message);
        }
      } catch (e) {
        alert('Lỗi mạng khi đồng bộ: ' + e.message);
      } finally {
        syncDevicesBtn.innerText = originalText;
        syncDevicesBtn.disabled = false;
      }
    });
  }

  // Toggle Direct registration form block
  if (elements.openDirectRegisterBtn) {
    elements.openDirectRegisterBtn.addEventListener('click', () => {
      if (elements.directRegisterPanel) {
        const isHidden = elements.directRegisterPanel.style.display === 'none';
        elements.directRegisterPanel.style.display = isHidden ? 'block' : 'none';
        if (isHidden && elements.regUdid) elements.regUdid.focus();
      }
    });
  }

  // Direct registration submit
  if (elements.directRegisterForm) {
    elements.directRegisterForm.addEventListener('submit', handleDirectRegisterSubmit);
  }

  // Pricing margin inputs change listener
  const pricingInputs = [elements.pricePack1, elements.pricePack2, elements.pricePack3].filter(Boolean);
  pricingInputs.forEach(input => {
    input.addEventListener('input', calculateProfitDisplay);
  });

  // Save reseller prices submit
  if (elements.priceForm) {
    elements.priceForm.addEventListener('submit', savePricingMarkup);
  }

  // Save systems configurations credentials submit
  if (elements.systemConfigForm) {
    elements.systemConfigForm.addEventListener('submit', saveSystemConfigurations);
  }

  // Users Management
  if (elements.refreshUsersBtn) {
    elements.refreshUsersBtn.addEventListener('click', () => loadUsersList(1));
  }
  if (elements.searchUdidBtn) {
    elements.searchUdidBtn.addEventListener('click', searchUsers);
  }
  if (elements.searchUdidInput) {
    elements.searchUdidInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchUsers();
    });
  }
  if (elements.searchUsernameInput) {
    elements.searchUsernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchUsers();
    });
  }
  if (elements.btnCleanupInactive) {
    elements.btnCleanupInactive.addEventListener('click', async () => {
      if (!confirm('Bạn có chắc chắn muốn xóa TẤT CẢ tài khoản rác (số dư 0, chưa nạp tiền, chưa mua thiết bị, tạo quá 3 ngày) không?')) return;
      
      const originalText = elements.btnCleanupInactive.innerText;
      elements.btnCleanupInactive.innerText = 'Đang xóa...';
      elements.btnCleanupInactive.disabled = true;
      
      try {
        const res = await fetch(API_BASE + '/api/admin/users/cleanup-inactive', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await res.json();
        
        if (res.ok && result.success) {
          alert(result.message);
          loadUsersList(1);
        } else {
          alert('Xóa thất bại: ' + result.message);
        }
      } catch (e) {
        alert('Lỗi mạng: ' + e.message);
      } finally {
        elements.btnCleanupInactive.innerText = originalText;
        elements.btnCleanupInactive.disabled = false;
      }
    });
  }
  if (elements.btnAdjustBalance) {
    elements.btnAdjustBalance.addEventListener('click', adjustUserBalance);
  }
  if (elements.btnChangePassword) {
    elements.btnChangePassword.addEventListener('click', changeUserPassword);
  }
  if (elements.btnToggleLock) {
    elements.btnToggleLock.addEventListener('click', toggleUserLock);
  }
  if (elements.btnDeleteUser) {
    elements.btnDeleteUser.addEventListener('click', deleteUserAccount);
  }

  // Backup & Restore
  if (elements.exportBackupBtn) {
    elements.exportBackupBtn.addEventListener('click', handleExportBackup);
  }
  if (elements.selectBackupBtn && elements.importBackupFile) {
    elements.selectBackupBtn.addEventListener('click', () => {
      elements.importBackupFile.click();
    });
  }
  if (elements.importBackupFile) {
    elements.importBackupFile.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        if (elements.selectedFileName) elements.selectedFileName.innerText = file.name;
        if (elements.selectedFileInfo) elements.selectedFileInfo.style.display = 'block';
        if (elements.importBackupBtn) elements.importBackupBtn.removeAttribute('disabled');
      } else {
        if (elements.selectedFileInfo) elements.selectedFileInfo.style.display = 'none';
        if (elements.importBackupBtn) elements.importBackupBtn.setAttribute('disabled', 'true');
      }
    });
  }
  if (elements.importBackupBtn) {
    elements.importBackupBtn.addEventListener('click', handleImportBackup);
  }

  // Logs
  if (elements.refreshLogsBtn) {
    elements.refreshLogsBtn.addEventListener('click', () => loadLogsList(1));
  }
  if (elements.clearLogsBtn) {
    elements.clearLogsBtn.addEventListener('click', handleClearLogs);
  }
  if (elements.btnLogsPrev) {
    elements.btnLogsPrev.addEventListener('click', () => {
      if (currentLogsPage > 1) loadLogsList(currentLogsPage - 1);
    });
  }
  if (elements.btnLogsNext) {
    elements.btnLogsNext.addEventListener('click', () => {
      if (currentLogsPage < totalLogsPages) loadLogsList(currentLogsPage + 1);
    });
  }
}

// ==========================================
// 5. USERS MANAGEMENT LOGIC
// ==========================================
let currentUsersPage = 1;
const usersLimit = 20;

async function loadUsersList(page = 1) {
  if (!elements.usersTbody) return;
  elements.usersTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Đang tải danh sách thành viên...</td></tr>';

  try {
    const res = await fetch(API_BASE + `/api/admin/users?page=${page}&limit=${usersLimit}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      renderUsersList(data.users);
      updatePaginationControls(data.pagination);
    } else {
      elements.usersTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi: ${escapeHtml(data.message || 'Không thể tải danh sách')}</td></tr>`;
    }
  } catch (error) {
    elements.usersTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi kết nối: ${escapeHtml(error.message)}</td></tr>`;
  }
}

function updatePaginationControls(pagination) {
  const btnPrev = document.getElementById('btn-prev-page');
  const btnNext = document.getElementById('btn-next-page');
  const pageInfo = document.getElementById('users-page-info');
  
  if (!btnPrev || !btnNext || !pageInfo || !pagination) return;

  currentUsersPage = pagination.page;
  pageInfo.textContent = `Trang ${pagination.page} / ${pagination.totalPages || 1} (Tổng: ${pagination.totalUsers})`;

  btnPrev.disabled = pagination.page <= 1;
  btnNext.disabled = pagination.page >= pagination.totalPages;

  btnPrev.onclick = () => {
    if (pagination.page > 1) loadUsersList(pagination.page - 1);
  };
  btnNext.onclick = () => {
    if (pagination.page < pagination.totalPages) loadUsersList(pagination.page + 1);
  };
}

function renderUsersList(users) {
  if (!elements.usersTbody) return;
  
  if (!users || users.length === 0) {
    elements.usersTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Chưa có thành viên nào.</td></tr>';
    return;
  }

  elements.usersTbody.innerHTML = '';
  users.forEach(u => {
    const tr = document.createElement('tr');
    
    // Escape HTML để chống XSS
    const escapeHtml = (unsafe) => {
      return (unsafe || '').toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };
    
    const safeUsername = escapeHtml(u.username);
    
    tr.innerHTML = `
      <td><strong>${safeUsername}</strong></td>
      <td style="color: var(--success); font-weight: bold;">${(u.balance || 0).toLocaleString()}đ</td>
      <td>${(u.totalDeposited || 0).toLocaleString()}đ</td>
      <td>${u.devicesCount || 0}</td>
      <td>
        <span style="padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; background: ${u.isLocked ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)'}; color: ${u.isLocked ? 'var(--danger)' : 'var(--success)'};">
          ${u.isLocked ? 'Đã khóa' : 'Hoạt động'}
        </span>
      </td>
      <td>
        <button class="btn btn-secondary btn-user-detail" style="padding: 4px 8px; font-size: 0.75rem;">Chi tiết</button>
      </td>
    `;
    
    tr.querySelector('.btn-user-detail').addEventListener('click', () => {
      loadUserDetails(u.username);
    });
    
    elements.usersTbody.appendChild(tr);
  });
}

async function searchUsers() {
  const udid = elements.searchUdidInput?.value.trim();
  const username = elements.searchUsernameInput?.value.trim();
  if (!udid && !username) {
    loadUsersList();
    return;
  }
  if (username) {
    return searchUserByUsername(username);
  }
  return searchUserByUdid(udid);
}

async function searchUserByUsername(username) {
  if (!elements.usersTbody) return;
  elements.usersTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Đang tìm kiếm...</td></tr>';

  try {
    const res = await fetch(API_BASE + `/api/admin/users/search-by-username?username=${encodeURIComponent(username)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      if (!data.users || data.users.length === 0) {
        elements.usersTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không tìm thấy thành viên nào.</td></tr>';
      } else {
        renderUsersList(data.users);
      }
    } else {
      elements.usersTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi: ${escapeHtml(data.message || 'Không thể tìm kiếm')}</td></tr>`;
    }
  } catch (error) {
    elements.usersTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi kết nối: ${escapeHtml(error.message)}</td></tr>`;
  }
}

async function searchUserByUdid(udid) {
  if (!udid) {
    loadUsersList();
    return;
  }

  if (!elements.usersTbody) return;
  elements.usersTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Đang tìm kiếm...</td></tr>';

  try {
    const res = await fetch(API_BASE + `/api/admin/users/search-by-udid?udid=${encodeURIComponent(udid)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      if (data.results.length === 0) {
        elements.usersTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không tìm thấy thành viên nào có UDID này.</td></tr>';
      } else {
        // Map results to match renderUsersList format
        const mappedUsers = data.results.map(r => ({
          username: r.username,
          balance: r.balance,
          totalDeposited: 0, // Not returned in search to save bandwidth, can be fetched in detail
          devicesCount: 1, // At least the matched one
          isLocked: r.isLocked
        }));
        renderUsersList(mappedUsers);
      }
    } else {
      elements.usersTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi: ${escapeHtml(data.message || 'Không thể tìm kiếm')}</td></tr>`;
    }
  } catch (error) {
    elements.usersTbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi kết nối: ${escapeHtml(error.message)}</td></tr>`;
  }
}

let currentUserDetail = null;

async function loadUserDetails(username) {
  try {
    const res = await fetch(API_BASE + `/api/admin/users/${username}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentUserDetail = data.user;
      
      // Update UI
      if (elements.detailUsername) elements.detailUsername.innerText = data.user.username;
      if (elements.detailCreated) elements.detailCreated.innerText = new Date(data.user.createdAt).toLocaleString('vi-VN');
      if (elements.detailBalance) elements.detailBalance.innerText = `${(data.user.balance || 0).toLocaleString()}đ`;
      if (elements.detailDeposited) elements.detailDeposited.innerText = `${(data.user.totalDeposited || 0).toLocaleString()}đ`;
      if (elements.detailSpent) elements.detailSpent.innerText = `${(data.user.totalSpent || 0).toLocaleString()}đ`;
      
      if (elements.detailStatus) {
        elements.detailStatus.innerText = data.user.isLocked ? 'Đã khóa' : 'Hoạt động';
        elements.detailStatus.style.color = data.user.isLocked ? 'var(--danger)' : 'var(--success)';
      }
      
      if (elements.btnToggleLock) {
        elements.btnToggleLock.innerText = data.user.isLocked ? 'Mở khóa tài khoản' : 'Khóa tài khoản';
      }

      // Render transactions
      if (elements.userTransactionsTbody) {
        elements.userTransactionsTbody.innerHTML = '';
        if (!data.user.transactions || data.user.transactions.length === 0) {
          elements.userTransactionsTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 1rem;">Chưa có giao dịch nào.</td></tr>';
        } else {
          data.user.transactions.forEach(tx => {
            const tr = document.createElement('tr');
            const isCredit = tx.type.includes('credit') || tx.type === 'deposit';
            tr.innerHTML = `
              <td>${new Date(tx.date).toLocaleString('vi-VN')}</td>
              <td>${escapeHtml(tx.type)}</td>
              <td style="color: ${isCredit ? 'var(--success)' : 'var(--danger)'}; font-weight: bold;">
                ${isCredit ? '+' : '-'}${Math.abs(tx.amount || 0).toLocaleString()}đ
              </td>
              <td>${tx.note || '-'}</td>
            `;
            elements.userTransactionsTbody.appendChild(tr);
          });
        }
      }

      // Show panel
      if (elements.userDetailsPanel) elements.userDetailsPanel.style.display = 'block';
      
      // Reset inputs
      if (elements.adjustBalanceAmount) elements.adjustBalanceAmount.value = '';
      if (elements.newPasswordInput) elements.newPasswordInput.value = '';
      
    } else {
      alert(`Lỗi: ${data.message}`);
    }
  } catch (error) {
    alert(`Lỗi kết nối: ${escapeHtml(error.message)}`);
  }
}

async function adjustUserBalance() {
  if (!currentUserDetail) return;
  const amount = elements.adjustBalanceAmount?.value;
  if (!amount) {
    alert('Vui lòng nhập số tiền cần cộng/trừ (dùng số âm để trừ).');
    return;
  }

  if (!confirm(`Bạn có chắc chắn muốn ${parseInt(amount) > 0 ? 'cộng' : 'trừ'} ${Math.abs(amount).toLocaleString()}đ cho tài khoản ${currentUserDetail.username}?`)) return;

  try {
    const res = await fetch(API_BASE + `/api/admin/users/${currentUserDetail.username}/adjust-balance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        amount: parseInt(amount),
        reason: 'Admin điều chỉnh số dư'
      })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      alert(data.message);
      loadUserDetails(currentUserDetail.username); // Reload details
      loadUsersList(); // Reload list in background
    } else {
      alert(`Lỗi: ${data.message}`);
    }
  } catch (error) {
    alert(`Lỗi kết nối: ${escapeHtml(error.message)}`);
  }
}

async function changeUserPassword() {
  if (!currentUserDetail) return;
  const newPassword = elements.newPasswordInput?.value;
  if (!newPassword || newPassword.length < 6) {
    alert('Mật khẩu mới phải có ít nhất 6 ký tự.');
    return;
  }

  if (!confirm(`Bạn có chắc chắn muốn đổi mật khẩu cho tài khoản ${currentUserDetail.username}?`)) return;

  try {
    const res = await fetch(API_BASE + `/api/admin/users/${currentUserDetail.username}/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ newPassword })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      alert(data.message);
      if (elements.newPasswordInput) elements.newPasswordInput.value = '';
    } else {
      alert(`Lỗi: ${data.message}`);
    }
  } catch (error) {
    alert(`Lỗi kết nối: ${escapeHtml(error.message)}`);
  }
}

async function toggleUserLock() {
  if (!currentUserDetail) return;
  
  const action = currentUserDetail.isLocked ? 'mở khóa' : 'khóa';
  if (!confirm(`Bạn có chắc chắn muốn ${action} tài khoản ${currentUserDetail.username}?`)) return;

  try {
    const res = await fetch(API_BASE + `/api/admin/users/${currentUserDetail.username}/toggle-lock`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      alert(data.message);
      loadUserDetails(currentUserDetail.username); // Reload details
      loadUsersList(); // Reload list in background
    } else {
      alert(`Lỗi: ${data.message}`);
    }
  } catch (error) {
    alert(`Lỗi kết nối: ${escapeHtml(error.message)}`);
  }
}

async function deleteUserAccount() {
  if (!currentUserDetail) return;
  
  if (!confirm(`CẢNH BÁO NGUY HIỂM!\nBạn có chắc chắn muốn XÓA VĨNH VIỄN tài khoản ${currentUserDetail.username}?\nHành động này không thể hoàn tác!`)) return;
  
  if (!confirm(`Xác nhận lần cuối: Xóa tài khoản ${currentUserDetail.username} sẽ xóa toàn bộ dữ liệu của họ. Bạn chắc chắn chứ?`)) return;

  try {
    const res = await fetch(API_BASE + `/api/admin/users/${currentUserDetail.username}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      alert(data.message);
      if (elements.userDetailsPanel) elements.userDetailsPanel.style.display = 'none';
      currentUserDetail = null;
      loadUsersList(); // Reload list
    } else {
      alert(`Lỗi: ${data.message}`);
    }
  } catch (error) {
    alert(`Lỗi kết nối: ${escapeHtml(error.message)}`);
  }
}

// ==========================================
// 6. BACKUP & RESTORE LOGIC
// ==========================================
async function handleExportBackup() {
  const btn = elements.exportBackupBtn;
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ Đang tạo file backup...';
  btn.disabled = true;

  try {
    const res = await fetch(API_BASE + '/api/admin/backup/export', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      const backupData = data.backup;
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      const dateStr = new Date().toISOString().split('T')[0];
      a.download = `muacert_backup_${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      alert('✅ Đã tải xuống file backup thành công!');
    } else {
      alert(`Lỗi: ${data.message || 'Không thể xuất dữ liệu'}`);
    }
  } catch (error) {
    alert(`Lỗi kết nối: ${escapeHtml(error.message)}`);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function handleImportBackup() {
  const fileInput = elements.importBackupFile;
  const file = fileInput.files[0];
  if (!file) return;

  if (!confirm('CẢNH BÁO NGUY HIỂM!\nViệc khôi phục dữ liệu sẽ GHI ĐÈ TOÀN BỘ cấu hình và tài khoản hiện tại.\nBạn có chắc chắn muốn tiếp tục?')) return;

  const btn = elements.importBackupBtn;
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ Đang khôi phục dữ liệu...';
  btn.disabled = true;

  try {
    const text = await file.text();
    let backupData;
    try {
      backupData = JSON.parse(text);
    } catch (e) {
      throw new Error('File backup không đúng định dạng JSON.');
    }

    if (!backupData.settings || (!backupData.userList && !backupData.users)) {
      throw new Error('File backup thiếu dữ liệu bắt buộc.');
    }

    const res = await fetch(API_BASE + '/api/admin/backup/import', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ backup: backupData })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      alert(`✅ ${data.message}\nTrang web sẽ tự động tải lại để áp dụng cấu hình mới.`);
      window.location.reload();
    } else {
      alert(`Lỗi: ${data.message || 'Không thể khôi phục dữ liệu'}`);
    }
  } catch (error) {
    alert(`Lỗi: ${error.message}`);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
    fileInput.value = ''; // Reset file input
    if (elements.selectedFileInfo) elements.selectedFileInfo.style.display = 'none';
  }
}

// ==========================================
// 7. LOGS MANAGEMENT LOGIC
// ==========================================
let currentLogsPage = 1;
let totalLogsPages = 1;
const logsLimit = 50;

async function loadLogsList(page = 1) {
  if (!elements.logsTbody) return;
  elements.logsTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Đang tải nhật ký...</td></tr>';

  try {
    const res = await fetch(API_BASE + `/api/logs?page=${page}&limit=${logsLimit}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentLogsPage = data.pagination.page;
      totalLogsPages = data.pagination.totalPages;

      if (elements.logsPageInfo) {
        elements.logsPageInfo.innerText = `Trang ${currentLogsPage} / ${totalLogsPages || 1} (Tổng: ${data.pagination.totalLogs})`;
      }

      if (elements.btnLogsPrev) elements.btnLogsPrev.disabled = currentLogsPage <= 1;
      if (elements.btnLogsNext) elements.btnLogsNext.disabled = currentLogsPage >= totalLogsPages;

      if (data.logs.length === 0) {
        elements.logsTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có nhật ký nào.</td></tr>';
        return;
      }

      elements.logsTbody.innerHTML = data.logs.map(log => {
        const date = new Date(log.timestamp).toLocaleString('vi-VN');
        let typeColor = 'var(--text-muted)';
        if (log.type === 'SUCCESS') typeColor = 'var(--success)';
        if (log.type === 'ERROR') typeColor = 'var(--danger)';
        if (log.type === 'WARNING') typeColor = 'var(--warning)';
        if (log.type === 'INFO') typeColor = 'var(--primary)';

        return `
          <tr>
            <td style="font-size: 0.85rem; color: var(--text-muted);">${date}</td>
            <td><span class="status-badge" style="background: rgba(255,255,255,0.1); color: white;">${escapeHtml(log.source)}</span></td>
            <td><span style="color: ${typeColor}; font-weight: 600; font-size: 0.85rem;">${escapeHtml(log.type)}</span></td>
            <td style="font-size: 0.9rem; word-break: break-word;">${escapeHtml(log.message)}</td>
          </tr>
        `;
      }).join('');
    } else {
      elements.logsTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi: ${escapeHtml(data.message || 'Không thể tải nhật ký')}</td></tr>`;
    }
  } catch (error) {
    elements.logsTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--danger); padding: 2rem;">Lỗi kết nối: ${escapeHtml(error.message)}</td></tr>`;
  }
}

async function handleClearLogs() {
  if (!confirm('Bạn có chắc chắn muốn xóa TOÀN BỘ nhật ký hệ thống không? Hành động này không thể hoàn tác.')) return;

  const btn = elements.clearLogsBtn;
  const originalText = btn.innerHTML;
  btn.innerHTML = '⏳ Đang xóa...';
  btn.disabled = true;

  try {
    const res = await fetch(API_BASE + '/api/logs/clear', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.ok && data.success) {
      alert('✅ Đã xóa toàn bộ nhật ký thành công!');
      loadLogsList(1);
    } else {
      alert(`Lỗi: ${data.message || 'Không thể xóa nhật ký'}`);
    }
  } catch (error) {
    alert(`Lỗi kết nối: ${escapeHtml(error.message)}`);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}