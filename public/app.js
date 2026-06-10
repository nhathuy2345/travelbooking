// Đường dẫn gốc của API Backend
const API_BASE = ''; // Dùng relative URL vì Cloudflare Pages Functions tự động xử lý API trên cùng domain

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
const state = {
  activeTab: 'welcome',
  selectedPackage: 3, // Default Basic Pack
  sellingPrices: { 1: 180000, 2: 120000, 3: 70000 },
  supportUrl: 'https://t.me/ipamaster',
  user: null, // { username, token, balance }
  depositCode: null,
  depositPollInterval: null
};

// DOM Elements
let elements = {};

const tabDetails = {
  welcome: {
    title: 'Travel Booking',
    desc: 'Đặt tour du lịch trực tuyến'
  },
  auth: {
    title: 'Tài khoản',
    desc: 'Đăng nhập hoặc đăng ký'
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

async function initApp() {
  console.log("Initializing user portal...");

  // Mapping DOM Elements
  elements = {
    navItems: document.querySelectorAll('.bottom-nav .nav-item'),
    tabViews: document.querySelectorAll('.tab-view'),
    viewTitle: document.getElementById('view-title'),
    viewDesc: document.getElementById('view-desc'),

    // Auth
    authTitle: document.getElementById('auth-title'),
    authForm: document.getElementById('auth-form'),
    authUsername: document.getElementById('auth-username'),
    authPassword: document.getElementById('auth-password'),
    authConfirmPassword: document.getElementById('auth-confirm-password'),
    authConfirmPasswordGroup: document.getElementById('auth-confirm-password-group'),
    authSubmitBtn: document.getElementById('auth-submit-btn'),
    authToggleText: document.getElementById('auth-toggle-text'),
    authToggleLink: document.getElementById('auth-toggle-link'),
    authMessage: document.getElementById('auth-message'),

    // Header & Sidebar UI
    sidebarUserInfo: document.getElementById('sidebar-user-info'),
    sidebarAvatar: document.getElementById('sidebar-avatar'),
    sidebarUsername: document.getElementById('sidebar-username'),
    sidebarBalance: document.getElementById('sidebar-balance'),
    sidebarAuthLinks: document.getElementById('sidebar-auth-links'),
    sidebarLogout: document.getElementById('sidebar-logout'),
    headerBalance: document.getElementById('header-balance'),
    headerLoginBtn: document.getElementById('header-login-btn'),
    headerLogoutBtn: document.getElementById('header-logout-btn'),

    // Nav tabs to hide/show
    navDeposit: document.getElementById('nav-deposit'),
    navPurchase: document.getElementById('nav-purchase'),
    navDevices: document.getElementById('nav-devices'),
    navHistory: document.getElementById('nav-history'),
    navSignApp: document.getElementById('nav-sign-app'),

    // Deposit
    depositBalance: document.getElementById('deposit-balance'),
    depositForm: document.getElementById('deposit-form'),
    depositAmount: document.getElementById('deposit-amount'),

    // Purchase
    purchaseBalance: document.getElementById('purchase-balance'),
    purchaseForm: document.getElementById('purchase-form'),
    purchaseUdid: document.getElementById('purchase-udid'),
    purchaseName: document.getElementById('purchase-name'),
    purchaseTotal: document.getElementById('purchase-total'),
    purchaseMessage: document.getElementById('purchase-message'),
    purchasePackagesGrid: document.getElementById('purchase-packages-grid'),

    // Lists
    devicesList: document.getElementById('devices-list'),
    deletedDevicesList: document.getElementById('deleted-devices-list'),
    searchUdidInput: document.getElementById('search-udid-input'),
    historyList: document.getElementById('history-list')
  };

  // Restore session
  const token = localStorage.getItem('user_token');
  const username = localStorage.getItem('username');
  if (token && username) {
    state.user = { token, username, balance: 0 };
    await fetchUserProfile();
  }

  setupNavigation();
  setupEventListeners();
  //await fetchPrices();
  updateUI();

  // Parse UDID from URL (OTA profile callback)
  const urlParams = new URLSearchParams(window.location.search);
  const udid = urlParams.get('udid');
  const devName = urlParams.get('name');

  // Cập nhật link lấy UDID tự động nếu có cấu hình từ admin
  try {
    const res = await fetch(API_BASE + '/api/prices');
    const d = await res.json();
  } catch (e) {
    console.error('Failed to load prices:', e);
  }

  // Kiểm tra kết quả nạp tiền từ Pay2S Redirect
  const depositStatus = urlParams.get('depositStatus');
  if (depositStatus) {
    if (depositStatus === 'success') {
      if (state.user) {
        await fetchUserProfile(); // Cập nhật lại số dư
        alert(`🎉 Thành công! Ví của bạn đã được cộng tiền.\nSố dư mới: ${state.user.balance.toLocaleString()}đ.`);
        switchTab('history');
      } else {
        // Nếu chưa đăng nhập (do mất session hoặc khác domain), chuyển sang tab đăng nhập
        switchTab('auth');
      }
    } else {
      const message = urlParams.get('message') || 'Giao dịch thất bại';
      alert(`Nạp tiền thất bại: ${message}`);
      if (state.user) {
        switchTab('deposit');
      } else {
        switchTab('auth');
      }
    }
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (udid) {
    if (state.user) {
      if (elements.purchaseUdid) elements.purchaseUdid.value = udid;
      if (elements.purchaseName) elements.purchaseName.value = devName || 'iOS Device';
      switchTab('purchase');
    } else {
      // Store in session to fill after login
      sessionStorage.setItem('pending_udid', udid);
      sessionStorage.setItem('pending_name', devName || 'iOS Device');
      alert('Vui lòng đăng nhập hoặc tạo tài khoản để hoàn tất đăng ký Cert!');
      switchTab('auth');
    }
    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ==========================================
// 1. ROUTING & UI UPDATE
// ==========================================
function setupNavigation() {
  elements.navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      if (tabId) switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  // If trying to access protected tabs without login
  const protectedTabs = ['deposit', 'purchase', 'my-devices', 'history'];
  if (protectedTabs.includes(tabId) && !state.user) {
    alert('Vui lòng đăng nhập để sử dụng tính năng này!');
    switchTab('auth');
    return;
  }

  state.activeTab = tabId;

  if (tabId === 'sign-app') {
    const signAppTab = document.getElementById('tab-sign-app');
    if (!signAppTab.innerHTML.includes('iframe')) {
      signAppTab.innerHTML = `<iframe src="https://signapps.pages.dev/" style="width: 100%; height: calc(100vh - 60px); border: none; border-radius: 12px;"></iframe>`;
    }
  }

  elements.navItems.forEach(nav => {
    if (nav.getAttribute('data-tab') === tabId) nav.classList.add('active');
    else nav.classList.remove('active');
  });

  elements.tabViews.forEach(view => {
    if (view.id === `tab-${tabId}`) view.classList.add('active');
    else view.classList.remove('active');
  });

  const details = tabDetails[tabId] || { title: 'Portal', desc: '' };
  if (elements.viewTitle) elements.viewTitle.innerText = details.title;
  if (elements.viewDesc) elements.viewDesc.innerText = details.desc;

  // Tab change handlers (Tạm tắt chức năng Cert)
/*
if (tabId === 'deposit') {
  refreshBalance();
  if (elements.depositBalance)
    elements.depositBalance.innerText =
      state.user.balance.toLocaleString() + 'đ';
}
else if (tabId === 'purchase') {
  refreshBalance();
  if (elements.purchaseBalance)
    elements.purchaseBalance.innerText =
      state.user.balance.toLocaleString() + 'đ';

  updatePurchaseTotal();
  updateSelectedPackageDetails();
}
else if (tabId === 'my-devices') {
  refreshBalance();
  fetchMyDevices();
}
else if (tabId === 'history') {
  refreshBalance();
  fetchHistory();
}
*/
  // Clear polling if leaving deposit tab
  if (tabId !== 'deposit' && state.depositPollInterval) {
    clearInterval(state.depositPollInterval);
    state.depositPollInterval = null;
  }
}

function updateUI() {
  const loggedIn = !!state.user;

  // Header & Sidebar panels
  if (loggedIn) {
    if (elements.sidebarUserInfo) elements.sidebarUserInfo.style.display = 'none';
    if (elements.sidebarAuthLinks) elements.sidebarAuthLinks.style.display = 'none';
    if (elements.sidebarLogout) elements.sidebarLogout.style.display = 'block';

    if (elements.headerBalance) {
      elements.headerBalance.style.display = 'inline-block';
      elements.headerBalance.innerText = 'Xin chào ' + state.user.username + ' | Số dư: ' + state.user.balance.toLocaleString() + 'đ';
    }
    if (elements.headerLoginBtn) elements.headerLoginBtn.style.display = 'none';
    if (elements.headerLogoutBtn) elements.headerLogoutBtn.style.display = 'inline-block';

    // Show nav tabs
    if (elements.navDeposit) elements.navDeposit.style.display = 'none';
    if (elements.navPurchase) elements.navPurchase.style.display = 'none';
    if (elements.navDevices) elements.navDevices.style.display = 'none';
    if (elements.navHistory) elements.navHistory.style.display = 'none';
    if (elements.navSignApp) elements.navSignApp.style.display = 'none';

    // Fill pending UDID from OTA redirect
    const pendingUdid = sessionStorage.getItem('pending_udid');
    const pendingName = sessionStorage.getItem('pending_name');
    if (pendingUdid) {
      sessionStorage.removeItem('pending_udid');
      sessionStorage.removeItem('pending_name');
      if (elements.purchaseUdid) elements.purchaseUdid.value = pendingUdid;
      if (elements.purchaseName) elements.purchaseName.value = pendingName;
      switchTab('purchase');
    }
  } else {
    if (elements.sidebarUserInfo) elements.sidebarUserInfo.style.display = 'none';
    if (elements.sidebarAuthLinks) elements.sidebarAuthLinks.style.display = 'block';
    if (elements.sidebarLogout) elements.sidebarLogout.style.display = 'none';

    if (elements.headerBalance) elements.headerBalance.style.display = 'none';
    if (elements.headerLoginBtn) elements.headerLoginBtn.style.display = 'inline-block';
    if (elements.headerLogoutBtn) elements.headerLogoutBtn.style.display = 'none';

    // Hide nav tabs
    if (elements.navDeposit) elements.navDeposit.style.display = 'none';
    if (elements.navPurchase) elements.navPurchase.style.display = 'none';
    if (elements.navDevices) elements.navDevices.style.display = 'none';
    if (elements.navHistory) elements.navHistory.style.display = 'none';
    if (elements.navSignApp) elements.navSignApp.style.display = 'flex'; // Luôn hiện Ký App
  }
}

function handleGetStarted() {
  window.location.href = 'tours.html';
}

function openSupportUrl() {
  if (state.supportUrl) {
    window.open(state.supportUrl, '_blank');
  } else {
    alert('Chưa cấu hình link hỗ trợ!');
  }
}
window.openSupportUrl = openSupportUrl;

// ==========================================
// 2. DYNAMIC PRICES
// ==========================================
async function fetchPrices() {
  try {
    const res = await fetch(API_BASE + '/api/prices');
    const d = await res.json();
    if (d.success && d.sellingPrices) {
      state.sellingPrices = d.sellingPrices;
      if (d.packages) state.packages = d.packages;
      if (d.supportUrl) state.supportUrl = d.supportUrl;

      // Update footer links
      if (d.termsUrl && document.getElementById('footer-terms')) document.getElementById('footer-terms').href = d.termsUrl;
      if (d.privacyUrl && document.getElementById('footer-privacy')) document.getElementById('footer-privacy').href = d.privacyUrl;
      if (d.refundUrl && document.getElementById('footer-refund')) document.getElementById('footer-refund').href = d.refundUrl;

      // Update welcome UI prices
      if (document.getElementById('display-price-pack1')) document.getElementById('display-price-pack1').innerText = d.sellingPrices[1].toLocaleString() + 'đ';
      if (document.getElementById('display-price-pack2')) document.getElementById('display-price-pack2').innerText = d.sellingPrices[2].toLocaleString() + 'đ';
      if (document.getElementById('display-price-pack3')) document.getElementById('display-price-pack3').innerText = d.sellingPrices[3].toLocaleString() + 'đ';

      // Update purchase tab UI prices
      if (document.getElementById('form-price-pack1')) document.getElementById('form-price-pack1').innerText = d.sellingPrices[1].toLocaleString() + 'đ';
      if (document.getElementById('form-price-pack2')) document.getElementById('form-price-pack2').innerText = d.sellingPrices[2].toLocaleString() + 'đ';
      if (document.getElementById('form-price-pack3')) document.getElementById('form-price-pack3').innerText = d.sellingPrices[3].toLocaleString() + 'đ';

      // Update dynamic package names & warranty from config
      if (d.packages) {
        for (const [id, pkg] of Object.entries(d.packages)) {
          const nameEl = document.getElementById(`form-name-pack${id}`);
          const warrantyEl = document.getElementById(`form-warranty-pack${id}`);
          if (nameEl && pkg.name) nameEl.innerText = pkg.name;
          if (warrantyEl && pkg.warranty) warrantyEl.innerText = pkg.warranty;

          // Update welcome tab package details
          const welcomeNameEl = document.getElementById(`welcome-name-pack${id}`);
          const welcomeWarrantyEl = document.getElementById(`welcome-warranty-pack${id}`);
          if (welcomeNameEl && pkg.name) welcomeNameEl.innerText = pkg.name;
          if (welcomeWarrantyEl && pkg.warranty) welcomeWarrantyEl.innerText = pkg.warranty;

          // Update welcome tab features list
          const welcomeFeaturesEl = document.getElementById(`welcome-features-pack${id}`);
          if (welcomeFeaturesEl && pkg.features && Array.isArray(pkg.features)) {
            welcomeFeaturesEl.innerHTML = pkg.features.map(f => `<li>${escapeHtml(f)}</li>`).join('');
          }
        }
      }

      // Update selected package details if already on purchase tab
      updateSelectedPackageDetails();
    }
  } catch (e) {
    console.error('Failed to load prices:', e);
  }
}

// ==========================================
// 3. AUTHENTICATION (LOGIN / REGISTER)
// ==========================================
let authMode = 'login'; // 'login' or 'register'

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  if (elements.authTitle) elements.authTitle.innerText = authMode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản mới';
  if (elements.authConfirmPasswordGroup) elements.authConfirmPasswordGroup.style.display = authMode === 'login' ? 'none' : 'block';
  if (elements.authSubmitBtn) elements.authSubmitBtn.innerText = authMode === 'login' ? 'Đăng nhập' : 'Đăng ký ngay';
  if (elements.authToggleText) elements.authToggleText.innerText = authMode === 'login' ? 'Chưa có tài khoản?' : 'Đã có tài khoản?';
  if (elements.authToggleLink) elements.authToggleLink.innerText = authMode === 'login' ? 'Đăng ký ngay' : 'Đăng nhập';
  if (elements.authMessage) elements.authMessage.innerHTML = '';
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const username = elements.authUsername.value.trim();
  const password = elements.authPassword.value;
  
  if (authMode === 'register') {
    const confirmPassword = elements.authConfirmPassword.value;
    if (password !== confirmPassword) {
      if (elements.authMessage) elements.authMessage.innerHTML = '<span style="color:var(--error);">❌ Mật khẩu nhập lại không khớp!</span>';
      return;
    }
  }

  if (elements.authMessage) elements.authMessage.innerHTML = '⚡ Đang kết nối...';

  const url = authMode === 'login' ? '/api/user/login' : '/api/user/register';
  const body = { username, password };

  try {
    const res = await fetch(API_BASE + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await res.json();

    if (d.success) {
      if (authMode === 'login') {
        localStorage.setItem('user_token', d.token);
        localStorage.setItem('username', d.username);
        state.user = { username: d.username, token: d.token, balance: d.balance || 0 };

        elements.authUsername.value = '';
        elements.authPassword.value = '';

        await fetchUserProfile();
        updateUI();
        switchTab('purchase');
      } else {
        alert('Tạo tài khoản thành công! Bây giờ hãy đăng nhập.');
        toggleAuthMode();
        elements.authUsername.value = username;
        elements.authPassword.focus();
      }
    } else {
      if (elements.authMessage) elements.authMessage.innerHTML = `<span style="color:var(--error);">❌ ${escapeHtml(d.message)}</span>`;
    }
  } catch (error) {
    if (elements.authMessage) elements.authMessage.innerHTML = `<span style="color:var(--error);">❌ Lỗi kết nối: ${escapeHtml(error.message)}</span>`;
  }
}

async function fetchUserProfile() {
  if (!state.user) return;
  try {
    const res = await fetch(API_BASE + '/api/user/profile', {
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    if (res.status === 401) {
      logout();
      return;
    }
    const d = await res.json();
    if (d.success) {
      state.user.balance = d.balance;
      updateUI();
    }
  } catch (e) {
    console.error('Fetch user profile error:', e);
  }
}

// Helper: refresh balance without full UI update (for tab switches)
async function refreshBalance() {
  if (!state.user) return;
  try {
    const res = await fetch(API_BASE + '/api/user/profile', {
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    if (res.status === 401) { logout(); return; }
    const d = await res.json();
    if (d.success) {
      state.user.balance = d.balance;
      updateUI();
    }
  } catch (e) { /* silent */ }
}

function logout() {
  localStorage.removeItem('user_token');
  localStorage.removeItem('username');
  state.user = null;
  if (state.depositPollInterval) {
    clearInterval(state.depositPollInterval);
    state.depositPollInterval = null;
  }
  updateUI();
  switchTab('welcome');
}
window.logout = logout;

// ==========================================
// 4. DEPOSIT FLOW (NẠP TIỀN)
// ==========================================
async function handleDepositSubmit(e) {
  e.preventDefault();
  if (!state.user) {
    alert('Vui lòng đăng nhập để nạp tiền!');
    switchTab('auth');
    return;
  }

  const amount = parseInt(elements.depositAmount.value);
  if (!amount || amount < 10000) {
    alert('Số tiền nạp tối thiểu là 10.000 VNĐ');
    return;
  }

  // Disable nút submit để tránh bấm nhiều lần
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'Đang tạo mã...'; }

  try {
    const res = await fetch(API_BASE + '/api/user/deposit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.user.token}`
      },
      body: JSON.stringify({ amount })
    });
    const d = await res.json();

    if (d.success) {
      state.depositCode = d.depositCode;

      // Chuyển hướng trực tiếp sang cổng thanh toán Pay2S
      if (d.gatewayUrl) {
        window.location.href = d.gatewayUrl;
      } else {
        // Start polling for balance update
        startDepositPolling();
      }
    } else {
      alert('Không thể tạo mã nạp tiền: ' + (d.message || 'Lỗi không xác định'));
    }
  } catch (error) {
    console.error('Deposit error:', error);
    alert('Lỗi kết nối: ' + error.message + '\n\nVui lòng kiểm tra kết nối mạng và thử lại.');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Tạo mã nạp tiền'; }
  }
}

function startDepositPolling() {
  if (state.depositPollInterval) clearInterval(state.depositPollInterval);

  const initialBalance = state.user.balance;
  let attempts = 0;
  const maxAttempts = 30; // 5 phút (10s/lần)

  state.depositPollInterval = setInterval(async () => {
    attempts++;
    await fetchUserProfile();
    if (state.user.balance > initialBalance) {
      clearInterval(state.depositPollInterval);
      state.depositPollInterval = null;
      alert(`🎉 Thành công! Ví của bạn đã được cộng thêm tiền.\nSố dư mới: ${state.user.balance.toLocaleString()}đ.`);
      if (elements.depositBalance) elements.depositBalance.innerText = state.user.balance.toLocaleString() + 'đ';
      elements.depositAmount.value = '';
      // Refresh history if on that tab
      if (state.activeTab === 'history') fetchHistory();
    }
    if (attempts >= maxAttempts) {
      clearInterval(state.depositPollInterval);
      state.depositPollInterval = null;
    }
  }, 10000); // Tăng từ 3s lên 10s để giảm 70% request
}

// ==========================================
// 5. PURCHASE FLOW (MUA CERT)
// ==========================================
function selectPackage(e) {
  const card = e.currentTarget;
  const packId = parseInt(card.getAttribute('data-pack-id'));
  if (!packId) return;

  state.selectedPackage = packId;

  document.querySelectorAll('#purchase-packages-grid .package-card').forEach(c => {
    if (parseInt(c.getAttribute('data-pack-id')) === packId) c.classList.add('selected');
    else c.classList.remove('selected');
  });

  updatePurchaseTotal();
  updateSelectedPackageDetails();
}

function updateSelectedPackageDetails() {
  const titleEl = document.getElementById('selected-pack-title');
  const warrantyEl = document.getElementById('selected-pack-warranty');
  const featuresEl = document.getElementById('selected-pack-features-list');
  if (!titleEl || !warrantyEl || !featuresEl) return;

  const packId = state.selectedPackage;
  
  // Fallback data in case packages not loaded yet
  const fallbackData = {
    3: { name: 'Gói Cơ Bản (Basic)', warranty: 'Bảo hành 1 tháng', features: [] },
    2: { name: 'Gói Tiêu Chuẩn', warranty: 'Bảo hành 6 tháng', features: [] },
    1: { name: 'Gói Cao Cấp (Super)', warranty: 'Bảo hành trọn đời', features: [] }
  };

  const pkg = (state.packages && state.packages[packId]) || fallbackData[packId];
  if (pkg) {
    titleEl.innerText = pkg.name || fallbackData[packId]?.name || '';
    warrantyEl.innerText = pkg.warranty || fallbackData[packId]?.warranty || '';
    const features = pkg.features || [];
    featuresEl.innerHTML = features.map(f => `<li>${escapeHtml(f)}</li>`).join('');
  }
}

function updatePurchaseTotal() {
  const price = state.sellingPrices[state.selectedPackage] || 0;
  if (elements.purchaseTotal) elements.purchaseTotal.innerText = price.toLocaleString() + 'đ';
}

async function handlePurchaseSubmit(e) {
  e.preventDefault();
  if (!state.user) return;

  const udid = elements.purchaseUdid.value.trim();
  const name = elements.purchaseName.value.trim();

  if (!udid) {
    alert('Vui lòng nhập mã UDID!');
    return;
  }

  const price = state.sellingPrices[state.selectedPackage];
  if (state.user.balance < price) {
    alert(`Số dư tài khoản không đủ!\nCần ${price.toLocaleString()}đ nhưng bạn chỉ có ${state.user.balance.toLocaleString()}đ.\nHãy nạp thêm tiền vào ví.`);
    switchTab('deposit');
    elements.depositAmount.value = price - state.user.balance;
    return;
  }

  if (elements.purchaseMessage) elements.purchaseMessage.innerHTML = '⚡ Đang thực hiện đăng ký & trừ tiền ví...';

  try {
    const res = await fetch(API_BASE + '/api/user/purchase', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.user.token}`
      },
      body: JSON.stringify({
        udid,
        name: name || 'iOS Device',
        model: 'iPhone',
        packageId: state.selectedPackage
      })
    });
    const d = await res.json();

    if (d.success) {
      state.user.balance = d.balance;
      updateUI();
      
      // Cập nhật số dư trên giao diện ngay lập tức
      if (elements.purchaseBalance) elements.purchaseBalance.innerText = state.user.balance.toLocaleString() + 'đ';

      elements.purchaseUdid.value = '';
      elements.purchaseName.value = '';

      if (elements.purchaseMessage) {
        elements.purchaseMessage.innerHTML = `
          <div style="background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.3); padding:1rem; border-radius:8px; color:var(--success);">
            🎉 Đăng ký Cert thành công!<br>Đã trừ ví ${price.toLocaleString()}đ.<br>
            Bạn có thể kiểm tra tệp Cert tải về ở mục <b>"Thiết bị của tôi"</b>.
          </div>
        `;
      }
      
      // Gọi fetchDevices để cập nhật danh sách thiết bị ngay lập tức
      await fetchDevices();
      
      setTimeout(() => {
        if (elements.purchaseMessage) elements.purchaseMessage.innerHTML = '';
        switchTab('my-devices');
      }, 2500);
    } else {
      if (elements.purchaseMessage) {
        elements.purchaseMessage.innerHTML = `<span style="color:var(--error);">❌ Lỗi: ${escapeHtml(d.message)}</span>`;
      }
    }
  } catch (error) {
    if (elements.purchaseMessage) {
      elements.purchaseMessage.innerHTML = `<span style="color:var(--error);">❌ Lỗi kết nối: ${escapeHtml(error.message)}</span>`;
    }
  }
}

// ==========================================
// 6. FETCH LISTS (DEVICES & HISTORY)
// ==========================================
async function fetchMyDevices() {
  if (!state.user) return;
  if (elements.devicesList) elements.devicesList.innerHTML = '<p style="text-align:center;">⌛ Đang tải thiết bị...</p>';

  try {
    const res = await fetch(API_BASE + '/api/user/devices', {
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    const d = await res.json();

    if (d.success && d.devices) {
      state.devices = d.devices;
      renderDevices(state.devices);
    }
  } catch (e) {
    elements.devicesList.innerHTML = '<p style="color:var(--error); text-align:center;">❌ Không thể tải thiết bị.</p>';
  }
  
  fetchDeletedDevices();
}

function renderDevices(devices) {
  if (!elements.devicesList) return;
  if (!devices || devices.length === 0) {
    elements.devicesList.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:2rem 0;">Không tìm thấy thiết bị nào.</p>';
    return;
  }

  elements.devicesList.innerHTML = '';
  devices.forEach(dev => {
    const item = document.createElement('div');
    item.className = 'device-item';

    const date = new Date(dev.registeredAt).toLocaleString('vi-VN');
    const packNames = { 1: 'Super VIP', 2: 'Tiêu Chuẩn', 3: 'Cơ Bản' };
    // Sử dụng route có verify ownership, truyền token qua query param
    // certZipUrl removed for security

    const safeName = escapeHtml(dev.name);
    const safeUdid = escapeHtml(dev.udid);
    const packLabel = packNames[dev.packageId] || dev.packageId;

    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:8px; align-items:center;">
        <strong style="color:white;">📱 ${safeName} (Gói ${packLabel})</strong>
        <button class="btn-delete-device" style="background:rgba(239,68,68,0.15); color:#EF4444; border:1px solid rgba(239,68,68,0.35); padding:4px 10px; border-radius:6px; font-size:0.75rem; cursor:pointer; transition:0.2s;">🗑 Xóa</button>
      </div>
      <div class="device-udid">UDID: ${safeUdid}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:0.8rem;">
        <span style="color:var(--text-muted);">Ngày mua: ${date}</span>
        <button class="btn-download-cert" data-device-id="${dev.deviceId}" data-udid="${dev.udid}" data-name="${dev.name}" style="font-size:0.75rem; padding:5px 12px; border-radius:6px; text-decoration:none; background:rgba(16,185,129,0.2); color:#10B981; border:1px solid rgba(16,185,129,0.4); font-weight:600; transition:0.2s;; border:none; cursor:pointer;">📥 Tải Cert (.zip)</button>
      </div>
    `;
    
    item.querySelector('.btn-delete-device').addEventListener('click', () => {
      deleteUserDevice(dev.deviceId, dev.name);
    });
    
    item.querySelector('.btn-download-cert').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      downloadCert(btn.getAttribute('data-device-id'), btn.getAttribute('data-udid'), btn.getAttribute('data-name'));
    });
    
    elements.devicesList.appendChild(item);
  });
}

async function fetchDeletedDevices() {
  if (!state.user) return;
  if (elements.deletedDevicesList) elements.deletedDevicesList.innerHTML = '<p style="text-align:center;">⌛ Đang tải...</p>';

  try {
    const res = await fetch(API_BASE + '/api/user/deleted-devices', {
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    const d = await res.json();

    if (d.success) {
      renderDeletedDevices(d.deletedDevices || []);
    }
  } catch (e) {
    if (elements.deletedDevicesList) elements.deletedDevicesList.innerHTML = '<p style="color:var(--error); text-align:center;">❌ Lỗi tải dữ liệu.</p>';
  }
}

function renderDeletedDevices(devices) {
  if (!elements.deletedDevicesList) return;
  if (!devices || devices.length === 0) {
    elements.deletedDevicesList.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:1rem 0;">Không có thiết bị nào đã xóa.</p>';
    return;
  }

  elements.deletedDevicesList.innerHTML = '';
  devices.forEach(dev => {
    const item = document.createElement('div');
    item.className = 'device-item';
    item.style.opacity = '0.7';

    const date = dev.deletedAt ? new Date(dev.deletedAt).toLocaleString('vi-VN') : 'Không rõ';
    const packNames = { 1: 'Super VIP', 2: 'Tiêu Chuẩn', 3: 'Cơ Bản' };

    const safeName = escapeHtml(dev.name);
    const safeUdid = escapeHtml(dev.udid);
    const safePackName = packNames[dev.packageId] || dev.packageId;

    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; margin-bottom:8px; align-items:center;">
        <strong style="color:white;">📱 ${safeName} (Gói ${safePackName})</strong>
        <button class="btn-restore-device" style="background:rgba(16,185,129,0.15); color:#10B981; border:1px solid rgba(16,185,129,0.35); padding:4px 10px; border-radius:6px; font-size:0.75rem; cursor:pointer; transition:0.2s;">🔄 Khôi phục</button>
      </div>
      <div class="device-udid">UDID: ${safeUdid}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:0.8rem;">
        <span style="color:var(--warning);">Đã xóa lúc: ${date}</span>
      </div>
    `;

    item.querySelector('.btn-restore-device').addEventListener('click', () => {
      restoreUserDevice(dev.deviceId, dev.name);
    });

    elements.deletedDevicesList.appendChild(item);
  });
}

async function deleteUserDevice(deviceId, name) {
  if (!confirm(`Bạn có chắc chắn muốn xóa thiết bị "${name}" khỏi danh sách hoạt động không?\n\nThiết bị sẽ được chuyển vào mục "Đã xóa gần đây".`)) return;
  try {
    const res = await fetch(API_BASE + `/api/user/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    const d = await res.json();
    if (d.success) {
      fetchMyDevices(); // Tải lại cả 2 danh sách
    } else {
      alert('Xóa thất bại: ' + d.message);
    }
  } catch (e) {
    alert('Lỗi mạng: ' + e.message);
  }
}

async function restoreUserDevice(deviceId, name) {
  if (!confirm(`Bạn muốn khôi phục thiết bị "${name}"?`)) return;
  try {
    const res = await fetch(API_BASE + `/api/user/devices/${deviceId}/restore`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    const d = await res.json();
    if (d.success) {
      fetchMyDevices(); // Tải lại cả 2 danh sách
    } else {
      alert('Khôi phục thất bại: ' + d.message);
    }
  } catch (e) {
    alert('Lỗi mạng: ' + e.message);
  }
}

async function fetchHistory() {
  if (!state.user) return;
  if (elements.historyList) elements.historyList.innerHTML = '<p style="text-align:center;">⌛ Đang tải lịch sử...</p>';

  try {
    const res = await fetch(API_BASE + '/api/user/history', {
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    const d = await res.json();

    if (d.success && d.transactions) {
      if (d.transactions.length === 0) {
        elements.historyList.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:2rem 0;">Chưa có giao dịch nào.</p>';
        return;
      }

      elements.historyList.innerHTML = '';
      d.transactions.forEach(tx => {
        const item = document.createElement('div');
        item.className = 'history-item';

        const date = new Date(tx.date).toLocaleString('vi-VN');
        let amountText = '';
        let typeText = '';

        if (tx.type === 'deposit') {
          typeText = `Nạp tiền (Mã: ${tx.code})`;
          if (tx.status === 'PENDING') {
            amountText = `<span class="history-amount" style="color:var(--warning); font-style:italic;">Chưa thanh toán</span>`;
          } else {
            amountText = `<span class="history-amount positive">+${tx.amount.toLocaleString()}đ</span>`;
          }
        } else if (tx.type === 'purchase') {
          typeText = `Mua Cert (Gói: ${tx.packageId})<br><span style="font-size:0.75rem; color:var(--text-muted); font-family:monospace;">${(tx.udid || '').substring(0, 12)}...</span>`;
          amountText = `<span class="history-amount negative">${tx.amount.toLocaleString()}đ</span>`;
        } else if (tx.type === 'admin_credit') {
          typeText = `Cộng số dư: ${tx.note || ''}`;
          amountText = `<span class="history-amount positive">+${tx.amount.toLocaleString()}đ</span>`;
        } else if (tx.type === 'admin_debit') {
          typeText = `Trừ số dư: ${tx.note || ''}`;
          amountText = `<span class="history-amount negative">${tx.amount.toLocaleString()}đ</span>`;
        }

        item.innerHTML = `
          <div>
            <strong>${typeText}</strong>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${date}</div>
          </div>
          <div>${amountText}</div>
        `;
        elements.historyList.appendChild(item);
      });
    }
  } catch (e) {
    elements.historyList.innerHTML = '<p style="color:var(--error); text-align:center;">❌ Không thể tải lịch sử ví.</p>';
  }
}

// ==========================================
// EVENT LISTENERS
// ==========================================
function setupEventListeners() {
  if (elements.authForm) elements.authForm.addEventListener('submit', handleAuthSubmit);
  if (elements.depositForm) elements.depositForm.addEventListener('submit', handleDepositSubmit);
  if (elements.purchaseForm) elements.purchaseForm.addEventListener('submit', handlePurchaseSubmit);

  // Setup click for package cards in purchase tab
  document.querySelectorAll('#purchase-packages-grid .package-card').forEach(card => {
    card.addEventListener('click', selectPackage);
  });

  // Search UDID
  if (elements.searchUdidInput) {
    elements.searchUdidInput.addEventListener('input', (e) => {
      const query = e.target.value.trim().toLowerCase();
      if (!state.devices) return;
      const filtered = state.devices.filter(dev =>
        dev.udid.toLowerCase().includes(query) ||
        dev.name.toLowerCase().includes(query)
      );
      renderDevices(filtered);
    });
  }
}

// Hàm tải chứng chỉ an toàn (không lộ token trên URL)
async function downloadCert(deviceId, udid, name) {
  try {
    const res = await fetch(API_BASE + `/api/user/devices/${deviceId}/provision?udid=${encodeURIComponent(udid)}`, {
      headers: { 'Authorization': `Bearer ${state.user.token}` }
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error('Lỗi tải cert:', res.status, errorText);
      alert('Không thể tải chứng chỉ. Vui lòng thử lại sau.');
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cert_${udid}.zip`; // Đổi tên file tải về cho ngắn gọn
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Lỗi tải cert:', error);
    alert('Lỗi kết nối: ' + error.message);
  }
}
