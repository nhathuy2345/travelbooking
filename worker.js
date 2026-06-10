/**
 * Cloudflare Worker Backend - Hệ thống Reseller Muacert (Bản D1 Database)
 * Phiên bản 2.0: Tài khoản người dùng + Ví nạp tiền
 * 
 * D1 Database "DB" cần được bind vào Worker
 */

// ===== BỘ NHỚ ĐỆM (Toàn cục cho Worker) =====
let globalMemoryCachedConfig = null;
let globalLastMemoryConfigFetch = 0;

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    // Ghi log vào DB (chạy ngầm không block request)
    const saveLogToDb = (source, type, message) => {
      console.log(`[${source}] [${type}] ${message}`);
      if (env.DB && ctx && ctx.waitUntil) {
        ctx.waitUntil(
          env.DB.prepare('INSERT INTO logs (timestamp, source, type, message) VALUES (?, ?, ?, ?)')
            .bind(new Date().toISOString(), source, type, message)
            .run()
            .catch(e => console.error('Failed to save log to DB:', e))
        );
      }
    };

    // ===== CRYPTO HELPERS =====
    const hashPassword = async (pw, saltHex = null) => {
      // Nếu không có salt, tạo salt mới (16 bytes)
      let salt;
      if (saltHex) {
        salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      } else {
        salt = crypto.getRandomValues(new Uint8Array(16));
      }

      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(pw),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
      );

      const derivedBits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: salt,
          iterations: 10000,
          hash: 'SHA-256'
        },
        keyMaterial,
        256
      );

      const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
      const currentSaltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');

      return `${currentSaltHex}:${hashHex}`;
    };

    const verifyPassword = async (pw, storedHash) => {
      // Hỗ trợ tương thích ngược với mật khẩu cũ (chỉ có SHA-256, không có dấu ':')
      if (!storedHash.includes(':')) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
        const oldHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        return oldHash === storedHash;
      }

      const [saltHex, hashHex] = storedHash.split(':');
      const newHash = await hashPassword(pw, saltHex);
      return newHash === storedHash;
    };

    const signToken = async (payload, secret) => {
      const data = btoa(JSON.stringify(payload));
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
      return `${data}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
    };

    const verifyToken = async (token, secret) => {
      try {
        const dotIdx = token.lastIndexOf('.');
        if (dotIdx === -1) return null;
        const data = token.substring(0, dotIdx);
        const sig = token.substring(dotIdx + 1);
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const sigBytes = new Uint8Array(atob(sig).split('').map(c => c.charCodeAt(0)));
        const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
        if (!valid) return null;
        const payload = JSON.parse(atob(data));
        if (payload.exp && Date.now() > payload.exp) return null;
        return payload;
      } catch { return null; }
    };

    // ===== TURNSTILE HELPER =====
    const verifyTurnstile = async (token, secretKey) => {
      if (!secretKey) return true; // Bộ qua nếu chưa cấu hình secret key
      try {
        const formData = new FormData();
        formData.append('secret', secretKey);
        formData.append('response', token);
        formData.append('remoteip', request.headers.get('CF-Connecting-IP'));

        const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        return data.success;
      } catch (e) {
        return false;
      }
    };

    // ===== CONFIG HELPERS =====
    const getConfig = async () => {
      const now = Date.now();
      // 1. Đọc từ Memory Cache (nhanh nhất, sống trong vòng đời của Worker instance)
      if (globalMemoryCachedConfig && (now - globalLastMemoryConfigFetch < 60000)) {
        return globalMemoryCachedConfig;
      }

      let c = {
        muacertToken: '',
        pay2sPartnerCode: '',
        pay2sAccessKey: '',
        pay2sSecretKey: '',
        pay2sBankAccount: '',
        pay2sBankCode: 'MB',
        pay2sAccountName: '',
        isSandbox: true,
        adminUsername: 'admin',
        adminPassword: 'admin123',
        jwtSecret: 'muacert_super_secret_key_2026',
        turnstileSecret: '', // Tắt xác minh robot
        supportUrl: 'https://t.me/ipamaster',
        udidUrl: '/udid',
        termsUrl: '/terms.html',
        privacyUrl: '/privacy.html',
        refundUrl: '/refund.html',
        sellingPrices: { 1: 180000, 2: 120000, 3: 70000 }
      };

      let configString = null;

      // 2. Đọc từ KV (nhanh thứ hai, đồng bộ toàn cầu)
      if (env.KV) {
        try {
          configString = await env.KV.get('system_config');
        } catch (e) {
          console.error('KV read error:', e);
        }
      }

      // 3. Fallback đọc từ D1 nếu KV trống (chậm nhất)
      if (!configString && env.DB) {
        const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('config').first();
        if (row && row.value) {
          configString = row.value;
          // Lưu ngược lại vào KV để lần sau đọc nhanh hơn
          if (env.KV) {
            ctx.waitUntil(env.KV.put('system_config', configString));
          }
        }
      }

      if (configString) {
        try { c = { ...c, ...JSON.parse(configString) }; } catch { }
      }
      
      let configChanged = false;

      if (c.jwtSecret === 'muacert_super_secret_key_2026') {
        c.jwtSecret = crypto.randomUUID();
        configChanged = true;
      }

      if (!c.webhookToken) {
        c.webhookToken = crypto.randomUUID();
        configChanged = true;
      }

      if (!c.frontendUrl && request) {
        const reqUrl = new URL(request.url);
        c.frontendUrl = `${reqUrl.protocol}//${reqUrl.host}`;
        configChanged = true;
      }

      if (configChanged && env.DB) {
        env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('config', JSON.stringify(c)).run().catch(() => {});
      }

      if (env.MUACERT_TOKEN) c.muacertToken = env.MUACERT_TOKEN;
      if (env.PAY2S_SECRET_KEY) c.pay2sSecretKey = env.PAY2S_SECRET_KEY;
      if (env.PAY2S_BANK_ACCOUNT) c.pay2sBankAccount = env.PAY2S_BANK_ACCOUNT;
      if (env.PAY2S_BANK_CODE) c.pay2sBankCode = env.PAY2S_BANK_CODE;
      if (env.PAY2S_ACCOUNT_NAME) c.pay2sAccountName = env.PAY2S_ACCOUNT_NAME;
      if (env.ADMIN_PASSWORD) c.adminPassword = env.ADMIN_PASSWORD;
      if (env.TURNSTILE_SECRET) c.turnstileSecret = env.TURNSTILE_SECRET;
      if (env.FRONTEND_URL) c.frontendUrl = env.FRONTEND_URL;
      if (env.JWT_SECRET) c.jwtSecret = env.JWT_SECRET;
      if (env.WEBHOOK_TOKEN) c.webhookToken = env.WEBHOOK_TOKEN;

      globalMemoryCachedConfig = c;
      globalLastMemoryConfigFetch = now;
      return c;
    };

    const saveConfig = async (cfg) => {
      const configString = JSON.stringify(cfg);

      // Lưu vào D1 (nguồn dữ liệu chính)
      if (env.DB) {
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .bind('config', configString)
          .run();
      }

      // Lưu vào KV (cache)
      if (env.KV) {
        await env.KV.put('system_config', configString);
      }

      // Cập nhật Memory Cache
      globalMemoryCachedConfig = cfg;
      globalLastMemoryConfigFetch = Date.now();
    };

    // ===== USER HELPERS =====
    const getUser = async (username) => {
      if (!env.DB) return null;
      const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username.toLowerCase()).first();
      if (!u) return null;
      return {
        username: u.username,
        passwordHash: u.password_hash,
        email: u.email,
        balance: u.balance,
        totalDeposited: u.total_deposited,
        totalSpent: u.total_spent,
        isLocked: u.is_locked === 1,
        createdAt: u.created_at
      };
    };

    // ===== AUTH HELPERS =====
    const getAuthToken = (request) => {
      const h = request.headers.get('Authorization');
      return h?.split(' ')[1] || url.searchParams.get('token') || null;
    };

    const getAdminAuth = async (request) => {
      const token = getAuthToken(request);
      if (!token) return false;
      const config = await getConfig();
      const p = await verifyToken(token, config.jwtSecret);
      return p && p.role === 'admin';
    };

    const getUserAuth = async (request) => {
      const token = getAuthToken(request);
      if (!token) return null;
      const config = await getConfig();
      const p = await verifyToken(token, 'user_secret_' + config.jwtSecret);
      if (!p || p.role !== 'user') return null;
      const user = await getUser(p.username);
      if (!user || user.isLocked) return null;
      return p;
    };

    // ===== AUTO-CLEANUP INACTIVE USERS (XÓA TK KHÔNG HOẠT ĐỘNG SAU 3 NGÀY) =====
    // Đã chuyển sang chạy qua Cron Triggers (scheduled event)

    // ==========================================
    // RATE LIMITING (KV-based) đ NGĂN CHẶN BRUTE-FORCE
    // ==========================================
    const checkRateLimit = async (maxRequests = 20, windowSeconds = 60) => {
      if (!env.KV) return true; // Không có KV thì bỏ qua rate limit
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const key = `ratelimit:${ip}`;

      try {
        const now = Math.floor(Date.now() / 1000);
        let data = await env.KV.get(key, 'json');

        if (!data || (now - data.windowStart) > windowSeconds) {
          // Reset window
          data = { windowStart: now, count: 1 };
          await env.KV.put(key, JSON.stringify(data), { expirationTtl: windowSeconds + 10 });
          return true;
        }

        if (data.count >= maxRequests) return false;

        data.count++;
        await env.KV.put(key, JSON.stringify(data), { expirationTtl: windowSeconds + 10 });
        return true;
      } catch (e) {
        return true; // Lỗi KV thì vẫn cho qua
      }
    };

    try {
      // áp dụng rate limit cho các route nhạy cảm
      const sensitivePaths = ['/api/user/login', '/api/user/register', '/api/admin/login', '/api/user/purchase', '/api/user/deposit'];
      if (sensitivePaths.includes(path) && method === 'POST') {
        const allowed = await checkRateLimit(10, 60); // Max 10 requests/phút
        if (!allowed) return json({ success: false, message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau 1 phút.' }, 429);
      }

      // ==========================================
      // OTA PROFILE ROUTE
      // ==========================================
      if (path === '/udid' || path === '/api/ota.mobileconfig') {
        const config = await getConfig();
        const frontendUrl = config.frontendUrl || `https://${url.host}`;
        
        const mobileconfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <dict>
        <key>URL</key>
        <string>${frontendUrl}/api/ota/enroll</string>
        <key>DeviceAttributes</key>
        <array>
            <string>UDID</string>
            <string>IMEI</string>
            <string>ICCID</string>
            <string>VERSION</string>
            <string>PRODUCT</string>
            <string>DEVICE_NAME</string>
        </array>
    </dict>
    <key>PayloadOrganization</key>
    <string>Muacert Reseller</string>
    <key>PayloadDisplayName</key>
    <string>Lấy UDID Thiết Bị</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadUUID</key>
    <string>9CF421B3-9853-4454-BC8A-982CBD3C907C</string>
    <key>PayloadIdentifier</key>
    <string>com.muacert.udid</string>
    <key>PayloadDescription</key>
    <string>Cài đặt cấu hình này để lấy UDID thiết bị của bạn.</string>
    <key>PayloadType</key>
    <string>Profile Service</string>
</dict>
</plist>`;

        return new Response(mobileconfig, {
          headers: {
            'Content-Type': 'application/x-apple-aspen-config',
            'Content-Disposition': 'attachment; filename="ota.mobileconfig"'
          }
        });
      }

      // ==========================================
      // PUBLIC ROUTES
      // ==========================================

      // Kiểm tra trạng thái máy chủ và app (Render)
      if (path === '/api/check-sign-server' && method === 'GET') {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const res = await fetch('https://signapps.pages.dev/', {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          const text = await res.text();
          const lowerText = text.toLowerCase();
          if (lowerText.includes('waking up') || lowerText.includes('render') || lowerText.includes('incoming http request detected')) {
            return json({ ready: false });
          }
          return json({ ready: true });
        } catch (e) {
          return json({ ready: false });
        }
      }

      // Lấy giá gói
      if (path === '/api/prices' && method === 'GET') {
        const config = await getConfig();
        return json({
          success: true,
          sellingPrices: config.sellingPrices,
          packages: config.packages,
          supportUrl: config.supportUrl,
          termsUrl: config.termsUrl,
          privacyUrl: config.privacyUrl,
          refundUrl: config.refundUrl
        });
      }

      // Xử lý OTA UDID (iOS Profile Service)
      if (path === '/api/ota/enroll' && method === 'POST') {
        try {
          const bodyText = await request.text();

          // Trích xuất UDID bằng Regex
          const udidMatch = bodyText.match(/<key>UDID<\/key>\s*<string>([^<]+)<\/string>/i);
          const udid = udidMatch ? udidMatch[1].trim() : '';

          if (!udid) {
            return json({ success: false, message: 'Không tìm thấy UDID trong profile' }, 400);
          }

          // Lấy tên miền gốc của trang web để redirect về
          const origin = url.origin;

          // Redirect người dùng về trang chủ kèm theo UDID trên URL
          // iOS yêu cầu một redirect 301 để mở Safari
          return new Response('', {
            status: 301,
            headers: {
              'Location': `${origin}/?udid=${encodeURIComponent(udid)}`,
              'Content-Type': 'text/html'
            }
          });
        } catch (e) {
          return json({ success: false, message: 'Lỗi xử lý OTA' }, 500);
        }
      }
      // ==========================================
// TOURS API
// ==========================================

// Lấy danh sách tour
if (path === '/api/tours' && method === 'GET') {

  const rows = await env.DB
    .prepare('SELECT * FROM tours ORDER BY id DESC')
    .all();

  return json({
    success: true,
    tours: rows.results || []
  });
}

// Lấy chi tiết 1 tour
if (path.startsWith('/api/tours/') && method === 'GET') {

  const tourId = path.split('/').pop();

  const tour = await env.DB
    .prepare('SELECT * FROM tours WHERE id = ?')
    .bind(tourId)
    .first();

  if (!tour) {
    return json({
      success:false,
      message:'Không tìm thấy tour'
    },404);
  }

  return json({
    success:true,
    tour
  });
}
// Tạo booking
if (path === '/api/bookings' && method === 'POST') {

  const auth = await getUserAuth(request);

  if (!auth) {
    return json({
      success:false,
      message:'Vui lòng đăng nhập'
    },401);
  }

  const body = await request.json();

  const {
    tourId,
    fullName,
    email,
    phone,
    people,
    departureDate,
    note
  } = body;

  const tour = await env.DB
    .prepare('SELECT * FROM tours WHERE id = ?')
    .bind(tourId)
    .first();

  if (!tour) {
    return json({
      success:false,
      message:'Tour không tồn tại'
    },404);
  }

  const totalPrice =
    tour.price * parseInt(people || 1);

  await env.DB.prepare(`
    INSERT INTO bookings (
      tour_id,
      username,
      customer_name,
      email,
      phone,
      people_count,
      departure_date,
      note,
      total_price,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  .bind(
    tourId,
    auth.username,
    fullName,
    email,
    phone,
    people,
    departureDate,
    note,
    totalPrice,
    new Date().toISOString()
  )
  .run();

  return json({
    success:true,
    message:'Đặt tour thành công'
  });
}

      // ==========================================
      // USER REGISTRATION & LOGIN
      // ==========================================

      // ĐĐăng ký
      if (path === '/api/user/register' && method === 'POST') {
        const { username, password, email, turnstileResponse } = await request.json();
        if (!username || !password) return json({ success: false, message: 'Thiếu tên đăng nhập hoặc mật khẩu' }, 400);

        const config = await getConfig();
        // Turnstile check disabled


        if (username.length < 3 || username.length > 20) return json({ success: false, message: 'Tên đăng nhập 3-20 ký tự' }, 400);
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return json({ success: false, message: 'Tên đăng nhập chỉ cho phép chữ, số, dấu gạch dưới' }, 400);
        if (password.length < 6) return json({ success: false, message: 'Mặ­t khẩu ít nhất 6 ký tự' }, 400);

        const existing = await getUser(username);
        if (existing) return json({ success: false, message: 'Tên đăng nhập đã tồn tại' }, 400);

        const registerConfig = await getConfig();
        if (username.toLowerCase() === registerConfig.adminUsername.toLowerCase()) {
          return json({ success: false, message: 'Tên đăng nhập không hợp lệ' }, 400);
        }

        const passwordHash = await hashPassword(password);
        const createdAt = new Date().toISOString();

        if (env.DB) {
          try {
            await env.DB.prepare('INSERT INTO users (username, password_hash, email, balance, total_deposited, total_spent, is_locked, created_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?)')
              .bind(username.toLowerCase(), passwordHash, email || '', createdAt)
              .run();
          } catch (e) {
            if (e.message.includes('UNIQUE constraint failed')) {
              return json({ success: false, message: 'Tên ng nháp đã tồn tại' }, 400);
            }
            throw e;
          }
        }

        saveLogToDb('USER', 'SUCCESS', `New user registered: ${username}`);
        return json({ success: true, message: 'Đăng ký thành công! Hãy đăng nhập.' });
      }

      // Đăng nhập
      if (path === '/api/user/login' && method === 'POST') {
        const { username, password, turnstileResponse } = await request.json();
        if (!username || !password) return json({ success: false, message: 'Thiếu thông tin' }, 400);

        const config = await getConfig();
        // Turnstile disabled

        const user = await getUser(username);
        if (!user) return json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' }, 401);
        if (user.isLocked) return json({ success: false, message: 'Tài khoản của bạn đã bị khóa' }, 403);

        const isValid = await verifyPassword(password, user.passwordHash);
        if (!isValid) return json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' }, 401);

        // Nâng cấp mật khẩu cũ lýn đã9nh dạng mới (PBKDF2) nếu cần
        if (!user.passwordHash.includes(':') && env.DB) {
          const newHash = await hashPassword(password);
          await env.DB.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
            .bind(newHash, user.username)
            .run();
        }

        const loginConfig = await getConfig();
        const token = await signToken(
          { username: user.username, role: 'user', exp: Date.now() + 7 * 24 * 3600 * 1000 },
          'user_secret_' + loginConfig.jwtSecret
        );

        saveLogToDb('USER', 'SUCCESS', `User login: ${username}`);
        return json({ success: true, token, username: user.username, balance: user.balance });
      }

      // Lấy thông tin user + số dư
      if (path === '/api/user/profile' && method === 'GET') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chưa đăng nhập' }, 401);

        const user = await getUser(auth.username);
        if (!user) return json({ success: false, message: 'User not found' }, 404);

        let devicesCount = 0;
        if (env.DB) {
          const res = await env.DB.prepare('SELECT COUNT(*) as count FROM devices WHERE username = ? AND deleted_at IS NULL')
            .bind(auth.username)
            .first();
          devicesCount = res ? res.count : 0;
        }

        return json({
          success: true,
          username: user.username,
          email: user.email,
          balance: user.balance,
          totalDeposited: user.totalDeposited,
          totalSpent: user.totalSpent,
          createdAt: user.createdAt,
          devicesCount
        });
      }

      // Lịch sử giao dịch (Có phân trang)
      if (path === '/api/user/history' && method === 'GET') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chưa đăng nhập' }, 401);

        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 10;
        const skip = (page - 1) * limit;

        let transactions = [];
        let totalTransactions = 0;

        if (env.DB) {
          const countRes = await env.DB.prepare('SELECT COUNT(*) as count FROM transactions WHERE username = ?')
            .bind(auth.username)
            .first();
          totalTransactions = countRes ? countRes.count : 0;

          const rows = await env.DB.prepare('SELECT * FROM transactions WHERE username = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
            .bind(auth.username, limit, skip)
            .all();

          transactions = rows.results.map(r => ({
            type: r.type,
            amount: r.amount,
            code: r.id,
            packageId: r.package_id,
            udid: r.udid,
            deviceId: r.device_id,
            status: r.status,
            date: r.created_at
          }));
        }

        return json({
          success: true,
          transactions,
          pagination: {
            page,
            limit,
            totalTransactions,
            totalPages: Math.ceil(totalTransactions / limit)
          }
        });
      }

      // ==========================================
      // USER DEPOSIT (NẠP TIỀN)
      // ==========================================

      // Tạo mã nạp tiền
      if (path === '/api/user/deposit' && method === 'POST') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chưa đăng nhập' }, 401);

        const { amount } = await request.json();
        const depositAmount = parseInt(amount);
        if (!depositAmount || depositAmount < 10000) {
          return json({ success: false, message: 'Số tiền nạp tối thiểu 10,000đ' }, 400);
        }

        const config = await getConfig();
        const bankAccount = config.pay2sBankAccount;
        const bankCode = config.pay2sBankCode;
        const accountName = config.pay2sAccountName;

        // Tạo mã nạp tiền unique (random 6 ký tự)
        let depositCode = '';
        let isUnique = false;
        let attempts = 0;
        while (!isUnique && attempts < 5) {
          const randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
          depositCode = 'NAP' + randomCode;
          if (env.DB) {
            const existing = await env.DB.prepare('SELECT id FROM transactions WHERE id = ?').bind(depositCode).first();
            if (!existing) {
              isUnique = true;
            }
          } else {
            isUnique = true;
          }
          attempts++;
        }
        if (!isUnique) {
          return json({ success: false, message: 'Không thể tạo mã nạp tiền, vui lòng thử lại' }, 500);
        }

        if (env.DB) {
          await env.DB.prepare('INSERT OR REPLACE INTO transactions (id, username, type, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(depositCode, auth.username, 'deposit', depositAmount, 'PENDING', new Date().toISOString())
            .run();
        }

        const transferContent = depositCode;

        // Tạo Pay2S Gateway URL qua API chính thử©c
        let gatewayUrl = '';

        try {
          const requestId = Date.now().toString();
          const redirectUrl = `${url.origin}/api/pay2s/redirect`;
          const ipnUrl = `${url.origin}/api/pay2s/ipn`;
          const requestType = 'pay2s';
          const bankList = [{ account_number: bankAccount, bank_id: bankCode.toLowerCase() }];

          // Tạo chữ kýHMAC SHA256
          const rawHash = `accessKey=${config.pay2sAccessKey}&amount=${depositAmount}&bankAccounts=Array&ipnUrl=${ipnUrl}&orderId=${depositCode}&orderInfo=${transferContent}&partnerCode=${config.pay2sPartnerCode}&redirectUrl=${redirectUrl}&requestId=${requestId}&requestType=${requestType}`;

          const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.pay2sSecretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawHash));
          const signature = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

          const apiPayload = {
            accessKey: config.pay2sAccessKey,
            partnerCode: config.pay2sPartnerCode,
            partnerName: 'Reseller System',
            requestId,
            amount: depositAmount,
            orderId: depositCode,
            orderInfo: transferContent,
            orderType: requestType,
            bankAccounts: bankList,
            redirectUrl,
            ipnUrl,
            requestType,
            signature
          };

          const apiRes = await fetch('https://payment.pay2s.vn/v1/gateway/api/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(apiPayload)
          });

          const apiData = await apiRes.json();
          if (apiData && apiData.resultCode === 0 && apiData.payUrl) {
            gatewayUrl = apiData.payUrl;
            saveLogToDb('DEPOSIT', 'INFO', `Created Pay2S Collection Link: ${gatewayUrl}`);
          } else {
            saveLogToDb('DEPOSIT', 'WARNING', `Pay2S API error: ${JSON.stringify(apiData)}`);
          }
        } catch (err) {
          saveLogToDb('DEPOSIT', 'ERROR', `Failed to call Pay2S API: ${err.message}`);
        }

        // Fallback sang v2 link nếu API lỗi
        if (!gatewayUrl) {
          const timestamp = Math.floor(Date.now() / 1000);
          const bankList = [{ account_number: config.pay2sBankAccount || '', bank_id: (config.pay2sBankCode || '').toLowerCase() }];
          const frontendBase = url.origin;
          const gatewayPayload = `${config.pay2sSecretKey}|${timestamp}|${JSON.stringify({
            bankList,
            amount: depositAmount,
            content: transferContent,
            orderId: depositCode,
            returnUrl: frontendBase + '/'
          })}`;
          const base64Token = btoa(unescape(encodeURIComponent(gatewayPayload)));
          gatewayUrl = `https://payment.pay2s.vn/v2/gateway/pay?t=${encodeURIComponent(base64Token)}`;
        }

        saveLogToDb('DEPOSIT', 'INFO', `Deposit request: ${auth.username} - ${depositAmount.toLocaleString()}đ - Code: ${depositCode}`);

        return json({
          success: true,
          depositCode,
          amount: depositAmount,
          gatewayUrl,
          bankCode,
          bankAccount,
          accountName,
          transferContent
        });
      }

      // ==========================================
      // PAY2S IPN WEBHOOK (XỬ LÝ NẠP TIỀN TỰ ĐỘNG)
      // ==========================================

      if (path === '/api/pay2s/ipn' && method === 'POST') {
        try {
          const data = await request.json();
          const config = await getConfig();

          const {
            amount, extraData = '', message, orderId, orderInfo, orderType,
            partnerCode, payType, requestId, responseTime, resultCode, transId, signature
          } = data;

          const rawHash = `accessKey=${config.pay2sAccessKey}&amount=${amount}&extraData=${extraData}&message=${message}&orderId=${orderId}&orderInfo=${orderInfo}&orderType=${orderType}&partnerCode=${partnerCode}&payType=${payType}&requestId=${requestId}&responseTime=${responseTime}&resultCode=${resultCode}&transId=${transId}`;

          const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.pay2sSecretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawHash));
          const partnerSignature = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

          if (signature !== partnerSignature) {
            saveLogToDb('PAY2S', 'ERROR', `IPN Signature mismatch for Order: ${orderId}`);
            return json({ success: false, message: 'Sai chữ kýxác thực' }, 400);
          }

          if (resultCode == 0 && env.DB) {
            // Sộ­a lỗi Race Condition: Cập nhật trạng thái vàkiộm tra sử dụng bị ảnh hưởng
            const updateRes = await env.DB.prepare('UPDATE transactions SET status = ?, completed_at = ? WHERE id = ? AND status = ?')
              .bind('SUCCESS', new Date().toISOString(), orderId, 'PENDING')
              .run();

            if (updateRes.meta.changes > 0) {
              // Lấy thông tin giao dịch để biặ¿t username
              const tx = await env.DB.prepare('SELECT username FROM transactions WHERE id = ?').bind(orderId).first();
              if (tx) {
                // Cộng tiền cho user
                await env.DB.prepare('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE username = ?')
                  .bind(parseInt(amount), parseInt(amount), tx.username)
                  .run();

                saveLogToDb('PAY2S', 'SUCCESS', `Nạp tiền tự động thành công: ${tx.username} +${amount}đ (Order: ${orderId})`);
              }
            }
          }

          return json({ success: true });
        } catch (error) {
          saveLogToDb('PAY2S', 'ERROR', `IPN Error: ${error.message}`);
          return json({ success: false, message: error.message }, 500);
        }
      }

      // ==========================================
      // PAY2S REDIRECT HANDLER (SAU KHI THANH TOđN)
      // ==========================================

      if (path === '/api/pay2s/redirect' && method === 'GET') {
        try {
          const config = await getConfig();
          const params = url.searchParams;

          const partnerCode = params.get('partnerCode') || '';
          const orderId = params.get('orderId') || '';
          const requestId = params.get('requestId') || '';
          const amount = params.get('amount') || '';
          const orderInfo = params.get('orderInfo') || '';
          const orderType = params.get('orderType') || '';
          const transId = params.get('transId') || '';
          const resultCode = params.get('resultCode') || '';
          const message = params.get('message') || '';
          const payType = params.get('payType') || '';
          const responseTime = params.get('responseTime') || '';
          const m2signature = params.get('m2signature') || '';

          const rawHash = `accessKey=${config.pay2sAccessKey}&amount=${amount}&message=${message}&orderId=${orderId}&orderInfo=${orderInfo}&orderType=${orderType}&partnerCode=${partnerCode}&payType=${payType}&requestId=${requestId}&responseTime=${responseTime}&resultCode=${resultCode}`;

          const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.pay2sSecretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawHash));
          const partnerSignature = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

          let redirectUrl = '/';

          if (m2signature === partnerSignature) {
            if (resultCode == 0 && env.DB) {
              const updateRes = await env.DB.prepare('UPDATE transactions SET status = ?, completed_at = ? WHERE id = ? AND status = ?')
                .bind('SUCCESS', new Date().toISOString(), orderId, 'PENDING')
                .run();

              if (updateRes.meta.changes > 0) {
                const tx = await env.DB.prepare('SELECT username FROM transactions WHERE id = ?').bind(orderId).first();
                if (tx) {
                  await env.DB.prepare('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE username = ?')
                    .bind(parseInt(amount), parseInt(amount), tx.username)
                    .run();

                  saveLogToDb('PAY2S', 'SUCCESS', `Nạp tiền tự động thành công (Redirect): ${tx.username} +${amount}đ (Order: ${orderId})`);
                }
              }
              redirectUrl = `/?depositStatus=success&amount=${amount}&orderId=${orderId}`;
            } else {
              redirectUrl = `/?depositStatus=failed&message=${encodeURIComponent(message)}`;
            }
          } else {
            saveLogToDb('PAY2S', 'ERROR', `Redirect Signature mismatch for Order: ${orderId}`);
            redirectUrl = `/?depositStatus=failed&message=${encodeURIComponent('Sai chữ kýxác thực')}`;
          }

          const frontendBase = url.origin;
          return Response.redirect(frontendBase + redirectUrl, 302);
        } catch (error) {
          saveLogToDb('PAY2S', 'ERROR', `Redirect Error: ${error.message}`);
          const frontendBase2 = url.origin;
          return Response.redirect(frontendBase2 + '/?depositStatus=failed&message=' + encodeURIComponent('Lỗi hệ thống'), 302);
        }
      }

      // ==========================================
      // USER PURCHASE (MUA GđI)
      // ==========================================

      if (path === '/api/user/purchase' && method === 'POST') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chưa đăng nhập' }, 401);

        const { udid, name, model, packageId } = await request.json();
        if (!udid || !packageId) return json({ success: false, message: 'Thiếu UDID hoặc gđi' }, 400);

        if (![1, 2, 3].includes(parseInt(packageId))) {
          return json({ success: false, message: 'Gđi không háp lý(chỉchỉp nhđã 1, 2, 3)' }, 400);
        }

        const config = await getConfig();
        const price = config.sellingPrices[packageId];
        if (typeof price !== 'number' || price <= 0) {
          return json({ success: false, message: 'Gđi không hợp lệ hoặc đã bị vàhiHệu hđã' }, 400);
        }

        const user = await getUser(auth.username);
        if (!user) return json({ success: false, message: 'User not found' }, 404);

        // Kiểm tra số dư
        if (user.balance < price) {
          return json({
            success: false,
            message: `Số dư không đủ! Cần ${price.toLocaleString()}đ, hiện có ${user.balance.toLocaleString()}đ. Vui lòng nạp thêm tiền.`,
            needDeposit: true,
            required: price,
            current: user.balance
          }, 400);
        }

        // Kiểm tra UDID đã đăng ký chưa TRƯỚC KHI trừ tiền
        if (env.DB) {
          const existing = await env.DB.prepare('SELECT * FROM devices WHERE LOWER(udid) = ? AND deleted_at IS NULL')
            .bind(udid.toLowerCase())
            .first();
          if (existing) {
            return json({ success: false, message: 'UDID này đã được đăng ký trên hệ thống trước đó' }, 400);
          }
        }

        // Trừ tiền trước để tránh race condition (spam request)
        if (env.DB) {
          const updateRes = await env.DB.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE username = ? AND balance >= ?')
            .bind(price, price, auth.username, price)
            .run();
            
          if (updateRes.meta.changes === 0) {
            return json({ success: false, message: 'Số dư không đủ hoặc giao dịch đang được xử lý' }, 400);
          }
        }

        // ĐĐăng kýtrên Muacert
        let deviceId = null;
        let regStatus = 'FAILED';

        if (config.isSandbox || !config.muacertToken) {
          deviceId = 'device_' + Math.random().toString(36).substring(2, 10);
          regStatus = 'REGISTERED';
          saveLogToDb('PURCHASE', 'SUCCESS', `[SANDBOX] Registered ${udid} for ${auth.username}, Pack ${packageId}`);
        } else {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // Timeout 15s

            const res = await fetch('https://muacert.com/openapi/v1/devices', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.muacertToken}`
              },
              body: JSON.stringify({
                udid,
                name: name || 'iOS Device',
                model: model || 'iPhone',
                package: parseInt(packageId)
              }),
              signal: controller.signal
            });
            clearTimeout(timeoutId);

            const data = await res.json();
            if (data.code === 0) {
              deviceId = data.data?.device?.id;
              regStatus = 'REGISTERED';
              saveLogToDb('PURCHASE', 'SUCCESS', `[LIVE] Registered ${udid} for ${auth.username}, Pack ${packageId}, DeviceID: ${deviceId}`);
            } else {
              let errorMsg = data.message || 'Muacert API error';
              
              // Nếu lỗi là do UDID đã tồn tại trên Muacert, ta vẫn coi như thành công và trừ tiền
              if (errorMsg.toLowerCase().includes('already exists') || errorMsg.toLowerCase().includes('đã tồn tại') || errorMsg.toLowerCase().includes('exist') || data.code === 1003) {
                // Lấy danh sách thiết bị từ Muacert để tìm ID của thiết bị này
                try {
                  const searchRes = await fetch(`https://muacert.com/openapi/v1/devices?udid=${udid}`, {
                    headers: { 'Authorization': `Bearer ${config.muacertToken}` }
                  });
                  const searchData = await searchRes.json();
                  if (searchData.code === 0 && searchData.data?.devicesList?.length > 0) {
                    const foundDevice = searchData.data.devicesList.find(d => d.attributes?.udid?.toLowerCase() === udid.toLowerCase());
                    if (foundDevice) {
                      deviceId = foundDevice.id;
                      regStatus = 'REGISTERED';
                      saveLogToDb('PURCHASE', 'SUCCESS', `[LIVE] Re-linked existing ${udid} for ${auth.username}, Pack ${packageId}, DeviceID: ${deviceId}`);
                    }
                  }
                } catch (searchErr) {
                  console.error('Failed to search existing device:', searchErr);
                }
                
                // Nếu không tìm được ID từ Muacert, tạo ID ảo để vẫn lưu vào DB
                if (!deviceId) {
                  deviceId = 'relinked_' + Math.random().toString(36).substring(2, 10);
                  regStatus = 'REGISTERED';
                }
              } else {
                // Các lỗi khác (như hết tiền) thì hoàn tiền lại
                if (env.DB) {
                  await env.DB.prepare('UPDATE users SET balance = balance + ?, total_spent = total_spent - ? WHERE username = ?')
                    .bind(price, price, auth.username)
                    .run();
                }
                saveLogToDb('PURCHASE', 'ERROR', `Muacert error: code ${data.code} - ${data.message}`);
                if (errorMsg.toLowerCase().includes('insufficient balance')) {
                  errorMsg = 'Gói này đã hết hạn, liên hệ admin để được hỗ trợ';
                }
                return json({ success: false, message: `Lỗi đăng ký: ${errorMsg}` }, 400);
              }
            }
          } catch (e) {
            // Hoàn tiền lại vì lỗi kết nối
            if (env.DB) {
              await env.DB.prepare('UPDATE users SET balance = balance + ?, total_spent = total_spent - ? WHERE username = ?')
                .bind(price, price, auth.username)
                .run();
            }
            saveLogToDb('PURCHASE', 'ERROR', `Muacert API call failed: ${e.message}`);
            return json({ success: false, message: 'Lỗi kết nối Muacert. Tiền đã được hoàn lại, vui lòng thử lại.' }, 500);
          }
        }

        // Lưu vào DB
        if (env.DB) {
          // 1. Lưu thiết bị
          // Để cho phép nhiều user cùng thấy 1 thiết bị, ta cần lưu mỗi giao dịch mua thành 1 bản ghi riêng.
          // Vì id từ Muacert là duy nhất cho 1 thiết bị, nếu ta dùng id này làm PRIMARY KEY, bản ghi của user cũ sẽ bị ghi đè.
          // Do đó, ta tạo một ID nội bộ (localDeviceId) bằng cách ghép deviceId và username.
          
          const localDeviceId = deviceId + '_' + auth.username;
          
          // Kiểm tra xem user này đã mua thiết bị này chưa
          const existingDeviceForUser = await env.DB.prepare('SELECT * FROM devices WHERE udid = ? AND username = ? AND deleted_at IS NULL').bind(udid, auth.username).first();
          
          if (existingDeviceForUser) {
             // Nếu user này đã mua rồi, cập nhật lại
             await env.DB.prepare('UPDATE devices SET id = ?, name = ?, model = ?, package_id = ?, status = ?, registered_at = ? WHERE udid = ? AND username = ?')
               .bind(localDeviceId, name || 'iOS Device', model || 'iPhone', parseInt(packageId), regStatus, new Date().toISOString(), udid, auth.username)
               .run();
          } else {
             // Nếu user này chưa mua, chèn bản ghi mới với localDeviceId
             await env.DB.prepare('INSERT INTO devices (id, username, udid, name, model, package_id, status, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
               .bind(localDeviceId, auth.username, udid, name || 'iOS Device', model || 'iPhone', parseInt(packageId), regStatus, new Date().toISOString())
               .run();
          }

          // 2. Lưu giao dịch
          const txId = 'BUY' + Math.random().toString(36).substring(2, 8).toUpperCase();
          await env.DB.prepare('INSERT OR REPLACE INTO transactions (id, username, type, amount, package_id, udid, device_id, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(txId, auth.username, 'purchase', -price, parseInt(packageId), udid, deviceId, regStatus, new Date().toISOString(), new Date().toISOString())
            .run();
        }

        // Lấy lại balance mới nhất
        let currentBalance = user.balance - price;
        if (env.DB) {
          const updatedUser = await env.DB.prepare('SELECT balance FROM users WHERE username = ?').bind(auth.username).first();
          if (updatedUser) currentBalance = updatedUser.balance;
        }

        saveLogToDb('PURCHASE', 'SUCCESS', `${auth.username} bought Pack ${packageId} for ${price.toLocaleString()}đ.`);

        return json({
          success: true,
          message: `Đăng ký thành công! Đã trừ ${price.toLocaleString()}đ`,
          balance: currentBalance,
          deviceId,
          udid
        });
      }

      // ==========================================
      // USER DEVICES (THIẾT BỊ ĐÃ ĐĂNG KÝ)
      // ==========================================

      if (path === '/api/user/devices' && method === 'GET') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chưa đăng nhập' }, 401);

        let devices = [];
        if (env.DB) {
          const rows = await env.DB.prepare('SELECT * FROM devices WHERE username = ? AND deleted_at IS NULL ORDER BY registered_at DESC')
            .bind(auth.username)
            .all();
          devices = rows.results.map(r => ({
            udid: r.udid,
            name: r.name,
            model: r.model,
            packageId: r.package_id,
            deviceId: r.id,
            status: r.status,
            registeredAt: r.registered_at
          }));
        }

        return json({ success: true, devices });
      }

      // User: Lấy danh sốch thiết bị đãxđã gần đây
      if (path === '/api/user/deleted-devices' && method === 'GET') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chưa đăng nhập' }, 401);

        let deletedDevices = [];
        if (env.DB) {
          const rows = await env.DB.prepare('SELECT * FROM devices WHERE username = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
            .bind(auth.username)
            .all();
          deletedDevices = rows.results.map(r => ({
            udid: r.udid,
            name: r.name,
            model: r.model,
            packageId: r.package_id,
            deviceId: r.id,
            status: r.status,
            registeredAt: r.registered_at,
            deletedAt: r.deleted_at
          }));
        }

        return json({ success: true, deletedDevices });
      }

      // User: Khôi phục thiết bị từ Đã xóa gần đây
      
      // User: Tđi cert zip cóa thiít bị(Cđãerify ownership)
      if (path.startsWith('/api/user/devices/') && path.endsWith('/provision') && method === 'GET') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chđã ng nháp' }, 401);

        const parts = path.split('/');
        const deviceId = parts[4];

        if (env.DB) {
          const dev = await env.DB.prepare('SELECT * FROM devices WHERE id = ? AND username = ? AND deleted_at IS NULL')
            .bind(deviceId, auth.username)
            .first();
          if (!dev) {
            return json({ success: false, message: 'Thiít bịkhông tên tđi hođọc không thuđọc quyđã sốhđã cóa bịn' }, 403);
          }
        }

        const config = await getConfig();
        if (!config.muacertToken) {
          return json({ code: -1, message: 'Chđã cóu hđãh Token Muacert' }, 400);
        }

        // Vì id trong DB bây giờ có thể là localDeviceId (ví dụ: 7a4f780dfaac944d_username),
        // ta cần tách lấy phần ID thực sự của Muacert (phần trước dấu _)
        const realMuacertDeviceId = deviceId.split('_')[0];

        const targetUrl = 'https://muacert.com/openapi/v1/devices/' + realMuacertDeviceId + '/provision';
        const urlParams = url.search;

        try {
          const proxyReq = new Request(targetUrl + urlParams, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + config.muacertToken }
          });

          const proxyRes = await fetch(proxyReq);
          
          // Nếu Muacert trả về lỗi (không phải 200 OK), trả về nguyên lỗi đó
          if (!proxyRes.ok) {
             const errorText = await proxyRes.text();
             console.log("Muacert API Error:", proxyRes.status, errorText);
             return new Response(errorText, {
               status: proxyRes.status,
               headers: {
                 'Content-Type': 'application/json',
                 'Access-Control-Allow-Origin': '*'
               }
             });
          }

          const newHeaders = new Headers(proxyRes.headers);
          newHeaders.set('Access-Control-Allow-Origin', '*');
          
          // Đảm bảo trả về đúng Content-Type cho file zip
          const contentType = proxyRes.headers.get('Content-Type') || '';
          if (contentType.includes('application/zip') || contentType.includes('application/octet-stream') || contentType.includes('application/x-zip-compressed')) {
            newHeaders.set('Content-Type', 'application/zip');
            newHeaders.set('Content-Disposition', `attachment; filename="cert.zip"`);
          }

          return new Response(proxyRes.body, {
            status: proxyRes.status,
            headers: newHeaders
          });
        } catch (e) {
          return json({ code: -1, message: 'Proxy error: ' + e.message }, 500);
        }
      }

      if (path.startsWith('/api/user/devices/') && path.endsWith('/restore') && method === 'POST') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chđã ng nháp' }, 401);

        const parts = path.split('/');
        const deviceId = parts[4];

        try {
          if (env.DB) {
            const res = await env.DB.prepare('UPDATE devices SET deleted_at = NULL WHERE id = ? AND username = ? AND deleted_at IS NOT NULL')
              .bind(deviceId, auth.username)
              .run();
            if (res.meta.changes === 0) {
              return json({ success: false, message: 'Thiít bịkhông tên tđi hođọc không nđã trong mởc đãđã' }, 404);
            }
          }

          saveLogToDb('USER', 'SUCCESS', `User ${auth.username} restored device ${deviceId}`);
          return json({ success: true, message: 'đăng kýhđi phđọc thiít bịthành công' });
        } catch (e) {
          return json({ success: false, message: 'Lỗi khđi phđọc: ' + e.message }, 500);
        }
      }

      // User: Xóa thiết bị của chính mình (Chuyển vào Đã xóa gần đây)
      if (path.startsWith('/api/user/devices/') && method === 'DELETE') {
        const auth = await getUserAuth(request);
        if (!auth) return json({ success: false, message: 'Chưa đăng nhập' }, 401);

        const parts = path.split('/');
        const deviceId = parts[4];

        if (env.DB) {
          const res = await env.DB.prepare('UPDATE devices SET deleted_at = ? WHERE id = ? AND username = ? AND deleted_at IS NULL')
            .bind(new Date().toISOString(), deviceId, auth.username)
            .run();
          if (res.meta.changes === 0) {
            return json({ success: false, message: 'Thiết bị không tồn tại hoặc không thuộc về bạn' }, 404);
          }
        }

        saveLogToDb('USER', 'SUCCESS', `User ${auth.username} moved device ${deviceId} to deletedDevices`);
        return json({ success: true, message: 'Đã chuyển thiết bị vào mục Đã xóa gần đây' });
      }

      // ==========================================
      // PAY2S WEBHOOK (NẠP TIỀN TỰ ĐỘNG)
      // ==========================================

      if (path === '/api/pay2s/webhook' && method === 'POST') {
        const config = await getConfig();
        const authHeader = request.headers.get('Authorization');
        
        // Xác thực API Key bảo mật cho Webhook chuyộn khoản trực tiếp
        // Độc từ cấu hình webhookToken (nếu không cóthì fallback dùng pay2sSecretKey để tương thích ngược)
        const expectedToken = config.webhookToken || config.pay2sSecretKey;
        
        if (expectedToken) {
          // Hđ trộ£ cặ£ đã9nh dạng "Bearer <token>" và"Apikey <token>" (chuặ©n SePay)
          const tokenValid = authHeader === `Bearer ${expectedToken}` || authHeader === `Apikey ${expectedToken}`;
          if (!tokenValid) {
            saveLogToDb('WEBHOOK', 'ERROR', 'Tộ« chỉi truy cặ­p: Sai Token xác thực Webhook');
            return json({ success: false, message: 'Unauthorized webhook access' }, 401);
          }
        } else {
          saveLogToDb('WEBHOOK', 'ERROR', 'Tộ« chỉi truy cóp: Webhook chưa được cấu hình Token');
          return json({ success: false, message: 'Webhook not configured' }, 403);
        }

        saveLogToDb('WEBHOOK', 'REQUEST', 'Incoming webhook');
        const payload = await request.json();
        saveLogToDb('WEBHOOK', 'INFO', `Payload: ${JSON.stringify(payload)}`);

        const { amount, transactionId } = payload;
        const content = payload.content || payload.description || payload.memo || payload.transferContent || '';

        if (!content) {
          saveLogToDb('WEBHOOK', 'WARNING', 'No content field in payload');
          return json({ success: false, message: 'Missing content' }, 400);
        }

        // Webhook dedup bằng transactionId
        if (transactionId && env.DB) {
          const checkTxId = await env.DB.prepare("SELECT COUNT(*) as count FROM transactions WHERE note LIKE ?").bind(`%Bank TX: ${transactionId}%`).first();
          if (checkTxId && checkTxId.count > 0) {
            saveLogToDb('WEBHOOK', 'INFO', `Duplicate webhook skipped for transactionId ${transactionId}`);
            return json({ success: true, message: 'Transaction already processed by transactionId' });
          }
        }

        // Tìm mã nạp tiền dạng NAPxxxxxx (NAP + 6 ký tự) trong nội dung chuyển khoản
        const napMatch = content.toUpperCase().match(/NAP[A-Z0-9]{6}/);

        let parsedUsername = '';
        let parsedCode = '';

        if (napMatch && env.DB) {
          parsedCode = napMatch[0];
          const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(parsedCode).first();
          if (tx) {
            parsedUsername = tx.username;
          }
        }

        // Fallback: Nặ¿u không tđã thặ¥y mởrandom, thử­ parse theo đã9nh dạng cũ "NAP <USERNAME> <4-CHAR-CODE>"
        if (!parsedUsername) {
          const legacyMatch = content.toUpperCase().match(/NAP\s+([A-Z0-9_]+)\s+([A-Z0-9]{4})/);
          if (legacyMatch) {
            parsedUsername = legacyMatch[1].toLowerCase();
            parsedCode = legacyMatch[2];
          }
        }

        if (!parsedUsername) {
          saveLogToDb('WEBHOOK', 'WARNING', `No valid deposit code or username found in content: "${content}"`);
          return json({ success: true, message: 'No matching deposit' });
        }

        saveLogToDb('WEBHOOK', 'INFO', `Parsed Deposit: Username = "${parsedUsername}", Code = ${parsedCode}, Amount = ${amount}`);

        const user = await getUser(parsedUsername);
        if (!user) {
          saveLogToDb('WEBHOOK', 'ERROR', `User "${parsedUsername}" not found`);
          return json({ success: false, message: 'User not found' }, 404);
        }

        const creditAmount = parseInt(amount) || 0;
        if (creditAmount <= 0) {
          return json({ success: false, message: 'Invalid amount' }, 400);
        }

        if (env.DB) {
          // Cập nhật trạng thái giao dịch nếu cótrong DB
          const updateRes = await env.DB.prepare('UPDATE transactions SET status = ?, completed_at = ?, note = ? WHERE id = ? AND status = ?')
            .bind('SUCCESS', new Date().toISOString(), transactionId ? `Bank TX: ${transactionId}` : null, parsedCode, 'PENDING')
            .run();

          if (updateRes.meta.changes > 0) {
            // Cộng tiộn cho user
            await env.DB.prepare('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE username = ?')
              .bind(creditAmount, creditAmount, parsedUsername)
              .run();
          } else {
            // Nặ¿u không cógiao dịch PENDING trước đó(nạp trực tiếp không qua web), tặ¡o mới giao dịch thành công
            // Dùng transactionId từ webhook để dedup
            const txIdToUse = transactionId || parsedCode;
            const checkTx = await env.DB.prepare('SELECT COUNT(*) as count FROM transactions WHERE id = ?').bind(txIdToUse).first();
            if (checkTx && checkTx.count === 0) {
              await env.DB.prepare('INSERT OR REPLACE INTO transactions (id, username, type, amount, status, note, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(txIdToUse, parsedUsername, 'deposit', creditAmount, 'SUCCESS', transactionId ? `Bank TX: ${transactionId}` : null, new Date().toISOString(), new Date().toISOString())
                .run();
                
              await env.DB.prepare('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE username = ?')
                .bind(creditAmount, creditAmount, parsedUsername)
                .run();
            } else {
              return json({ success: true, message: 'Transaction already processed' });
            }
          }
        }

        saveLogToDb('WEBHOOK', 'SUCCESS', `Credited ${creditAmount.toLocaleString()}đ to ${parsedUsername}.`);
        return json({ success: true, message: 'Wallet deposit credited', username: parsedUsername });
      }

      // ==========================================
      // ADMIN ROUTES
      // ==========================================

      // Admin login
      if (path === '/api/admin/login' && method === 'POST') {
        const config = await getConfig();
        const { username, password, turnstileResponse } = await request.json();

        // Turnstile check disabled

        if (username === config.adminUsername) {
          // Hđ trộ£ cặ£ hash vàplaintext cho admin password
          let isValid = false;
          if (config.adminPassword.includes(':')) {
            isValid = await verifyPassword(password, config.adminPassword);
          } else {
            isValid = password === config.adminPassword;
            // Tộ± đểng nđểng cặ¥p lýn hash nếu đãng dđểng plaintext
            if (isValid) {
              const newHash = await hashPassword(password);
              const updatedConfig = { ...config, adminPassword: newHash };
              await saveConfig(updatedConfig);
            }
          }

          if (isValid) {
            const token = await signToken({ username, role: 'admin', exp: Date.now() + 7 * 24 * 3600 * 1000 }, config.jwtSecret);
            saveLogToDb('AUTH', 'SUCCESS', `Admin login: ${username}`);
            return json({ success: true, token });
          }
        }
        return json({ success: false, message: 'Sai tài khoản hoặc mật khẩu' }, 401);
      }

      if (path === '/api/admin/check' && method === 'GET') {
        const auth = await getAdminAuth(request);
        if (!auth) return json({ success: false }, 401);
        return json({ success: true });
      }

      // Admin logout
      if (path === '/api/admin/logout' && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        return json({ success: true, message: 'Logged out' });
      }

      // Admin: Lđây danh sốch thiít bị
      if (path === '/api/admin/devices' && method === 'GET') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);

        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const skip = (page - 1) * limit;

        if (env.DB) {
          const countRes = await env.DB.prepare('SELECT COUNT(*) as count FROM devices').first();
          const totalDevices = countRes ? countRes.count : 0;

          const rows = await env.DB.prepare('SELECT * FROM devices ORDER BY registered_at DESC LIMIT ? OFFSET ?')
            .bind(limit, skip)
            .all();
          return json({ code: 0, data: { 
            devicesList: rows.results.map(row => ({
              id: row.id, package: row.package_id,
              attributes: { name: row.name, model: row.model, udid: row.udid, addedAt: row.registered_at }
            })),
            pagination: { page, limit, totalDevices, totalPages: Math.ceil(totalDevices / limit) }
          } });
        }
        return json({ code: 0, data: { devicesList: [] } });
      }

      // Admin: Tìm kiđã thiít bịtheo UDID
      if (path === '/api/admin/devices/search' && method === 'GET') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const udid = url.searchParams.get('udid');
        if (!udid) return json({ code: 0, data: { devicesList: [] } });

        // Escape special characters for LIKE query
        const safeUdid = udid.toLowerCase().replace(/[%_]/g, '\\$&');

        if (env.DB) {
          const rows = await env.DB.prepare(
            "SELECT * FROM devices WHERE LOWER(udid) LIKE ? ESCAPE '\\' ORDER BY registered_at DESC LIMIT 100"
          ).bind(`%${safeUdid}%`).all();

          return json({ code: 0, data: {
            devicesList: rows.results.map(row => ({
              id: row.id, package: row.package_id,
              attributes: { name: row.name, model: row.model, udid: row.udid, addedAt: row.registered_at }
            }))
          } });
        }
        return json({ code: 0, data: { devicesList: [] } });
      }

      // Admin: Xem config
      if (path === '/api/config') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const config = await getConfig();

        if (method === 'GET') {
          return json({ success: true, config });
        }

        if (method === 'POST') {
          const newConfig = await request.json();
          const allowedKeys = ['muacertToken', 'pay2sPartnerCode', 'pay2sAccessKey', 'pay2sSecretKey', 'pay2sBankAccount', 'pay2sBankCode', 'pay2sAccountName', 'adminUsername', 'adminPassword', 'supportUrl', 'isSandbox', 'frontendUrl', 'webhookToken', 'sellingPrices', 'packages'];
          const safeConfig = {};
          for (const key of allowedKeys) {
            if (newConfig[key] !== undefined) safeConfig[key] = newConfig[key];
          }


          const updated = { ...config, ...safeConfig };
          await saveConfig(updated);
          saveLogToDb('ADMIN', 'SUCCESS', 'Updated system configuration');
          return json({ success: true, message: 'Đã lưu cấu hình thành công!' });
        }
      }

      // Admin: Logs (Có phân trang)
      if (path === '/api/logs') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);

        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 50;
        const skip = (page - 1) * limit;

        let logs = [];
        let totalLogs = 0;

        if (env.DB) {
          const countRes = await env.DB.prepare('SELECT COUNT(*) as count FROM logs').first();
          totalLogs = countRes ? countRes.count : 0;

          const rows = await env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ? OFFSET ?')
            .bind(limit, skip)
            .all();
          logs = rows.results;
        }

        const totalPages = Math.ceil(totalLogs / limit);
        return json({ success: true, logs, pagination: { page, limit, totalLogs, totalPages } });
      }

      if (path === '/api/logs/clear' && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        if (env.DB) {
          await env.DB.prepare('DELETE FROM logs').run();
        }
        saveLogToDb('ADMIN', 'SUCCESS', 'Cleared system logs');
        return json({ success: true });
      }





      // Admin: Danh sốch users (Có phân trang)
      if (path === '/api/admin/users' && method === 'GET') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);

        const page = parseInt(url.searchParams.get('page')) || 1;
        const limit = parseInt(url.searchParams.get('limit')) || 20;
        const skip = (page - 1) * limit;

        let users = [];
        let totalUsers = 0;

        if (env.DB) {
          const countRes = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
          totalUsers = countRes ? countRes.count : 0;

          const rows = await env.DB.prepare(`
            SELECT u.*, COUNT(d.id) as devicesCount 
            FROM users u 
            LEFT JOIN devices d ON u.username = d.username AND d.deleted_at IS NULL 
            GROUP BY u.username 
            ORDER BY u.created_at DESC 
            LIMIT ? OFFSET ?
          `)
            .bind(limit, skip)
            .all();

          users = rows.results.map(u => ({
            username: u.username,
            email: u.email,
            balance: u.balance,
            totalDeposited: u.total_deposited,
            totalSpent: u.total_spent,
            devicesCount: u.devicesCount || 0,
            createdAt: u.created_at,
            isLocked: u.is_locked === 1
          }));
        }

        return json({
          success: true,
          users,
          pagination: {
            page,
            limit,
            totalUsers,
            totalPages: Math.ceil(totalUsers / limit)
          }
        });
      }

      // Admin: Tìm kiđã user theo UDID
      if (path === '/api/admin/users/search-by-udid' && method === 'GET') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const udid = url.searchParams.get('udid');
        if (!udid) return json({ success: false, message: 'Thiếu UDID' }, 400);

        let results = [];
        if (env.DB) {
          const rows = await env.DB.prepare('SELECT d.*, u.email, u.balance, u.is_locked, u.created_at as u_created_at FROM devices d JOIN users u ON d.username = u.username WHERE LOWER(d.udid) = ?')
            .bind(udid.toLowerCase())
            .all();

          results = rows.results.map(r => ({
            username: r.username,
            email: r.email,
            balance: r.balance,
            isLocked: r.is_locked === 1,
            createdAt: r.u_created_at,
            matchedDevice: {
              udid: r.udid,
              name: r.name,
              model: r.model,
              packageId: r.package_id,
              deviceId: r.id,
              status: r.status,
              registeredAt: r.registered_at,
              deletedAt: r.deleted_at
            }
          }));
        }

        return json({ success: true, results });
      }

      // Admin: Tìm kiđã user theo tên ng nháp
      if (path === '/api/admin/users/search-by-username' && method === 'GET') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const searchUsername = url.searchParams.get('username');
        if (!searchUsername) return json({ success: false, message: 'Thiđã username' }, 400);

        let users = [];
        if (env.DB) {
          const safeUsername = searchUsername.toLowerCase().replace(/[%_]/g, '\\$&');
          const rows = await env.DB.prepare(`
            SELECT u.username, u.balance, u.total_deposited, u.is_locked,
              (SELECT COUNT(*) FROM devices d WHERE d.username = u.username) as devices_count
            FROM users u
            WHERE LOWER(u.username) LIKE ? ESCAPE '\\'
            ORDER BY u.created_at DESC
            LIMIT 50
          `).bind(`%${safeUsername}%`).all();

          users = rows.results.map(r => ({
            username: r.username,
            balance: r.balance,
            totalDeposited: r.total_deposited,
            devicesCount: r.devices_count,
            isLocked: r.is_locked === 1
          }));
        }

        return json({ success: true, users });
      }

      // Admin: Chi tiít 1 user
      if (path.startsWith('/api/admin/users/') && method === 'GET' && !path.includes('/change-password') && !path.includes('/toggle-lock')) {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const targetUsername = path.replace('/api/admin/users/', '').split('/')[0];

        const user = await getUser(targetUsername);
        if (!user) return json({ success: false, message: 'User không tồn tại' }, 404);

        let devices = [];
        let transactions = [];

        if (env.DB) {
          const devRows2 = await env.DB.prepare('SELECT * FROM devices WHERE username = ? ORDER BY registered_at DESC').bind(targetUsername).all();
          devices = devRows2.results.map(r => ({
            udid: r.udid,
            name: r.name,
            model: r.model,
            packageId: r.package_id,
            deviceId: r.id,
            status: r.status,
            registeredAt: r.registered_at,
            deletedAt: r.deleted_at
          }));

          const txRows = await env.DB.prepare('SELECT * FROM transactions WHERE username = ? ORDER BY created_at DESC LIMIT 50').bind(targetUsername).all();
          transactions = txRows.results.map(r => ({
            type: r.type,
            amount: r.amount,
            code: r.id,
            packageId: r.package_id,
            udid: r.udid,
            deviceId: r.device_id,
            status: r.status,
            note: r.note,
            date: r.created_at
          }));
        }

        return json({
          success: true,
          user: {
            username: user.username,
            email: user.email,
            balance: user.balance,
            totalDeposited: user.totalDeposited,
            totalSpent: user.totalSpent,
            isLocked: user.isLocked,
            createdAt: user.createdAt,
            devices,
            transactions
          }
        });
      }

      // Admin: Đổi mật khẩu user
      if (path.startsWith('/api/admin/users/') && path.endsWith('/change-password') && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const targetUsername = path.replace('/api/admin/users/', '').replace('/change-password', '');
        const { newPassword } = await request.json();

        if (!newPassword || newPassword.length < 6) {
          return json({ success: false, message: 'Mặ­t khẩu mới phặ£i từ 6 ký tự' }, 400);
        }

        const user = await getUser(targetUsername);
        if (!user) return json({ success: false, message: 'User không tồn tại' }, 404);

        const passwordHash = await hashPassword(newPassword);
        if (env.DB) {
          await env.DB.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
            .bind(passwordHash, targetUsername.toLowerCase())
            .run();
        }

        saveLogToDb('ADMIN', 'SUCCESS', `Admin changed password for user: ${targetUsername}`);
        return json({ success: true, message: 'Đã đổi mật khẩu thành công!' });
      }

      // Admin: Khđã/Mđã khóa user
      if (path.startsWith('/api/admin/users/') && path.endsWith('/toggle-lock') && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const targetUsername = path.replace('/api/admin/users/', '').replace('/toggle-lock', '');

        const user = await getUser(targetUsername);
        if (!user) return json({ success: false, message: 'User không tồn tại' }, 404);

        const newLockStatus = user.isLocked ? 0 : 1;
        if (env.DB) {
          await env.DB.prepare('UPDATE users SET is_locked = ? WHERE username = ?')
            .bind(newLockStatus, targetUsername.toLowerCase())
            .run();
        }

        saveLogToDb('ADMIN', 'SUCCESS', `Admin ${newLockStatus ? 'locked' : 'unlocked'} user: ${targetUsername}`);
        return json({ success: true, message: newLockStatus ? 'Đđăng kýhóa tài khoản!' : 'Đđãở khóa tài khoản!' });
      }

      // Admin: Xóa tđi khođã rđọc (inactive users)
      if (path === '/api/admin/users/cleanup-inactive' && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);

        let deletedCount = 0;
        if (env.DB) {
          const inactiveUsers = await env.DB.prepare(`
            SELECT username FROM users 
            WHERE balance = 0 
              AND total_deposited = 0 
              AND total_spent = 0 
              AND username NOT IN (SELECT DISTINCT username FROM devices)
              AND created_at < datetime('now', '-3 days')
          `).all();

          if (inactiveUsers.results && inactiveUsers.results.length > 0) {
            const usernames = inactiveUsers.results.map(u => u.username);
            deletedCount = usernames.length;

            const chunkSize = 50;
            for (let i = 0; i < usernames.length; i += chunkSize) {
              const chunk = usernames.slice(i, i + chunkSize);
              const placeholders = chunk.map(() => '?').join(',');
              await env.DB.prepare(`DELETE FROM transactions WHERE username IN (${placeholders})`).bind(...chunk).run();
              await env.DB.prepare(`DELETE FROM users WHERE username IN (${placeholders})`).bind(...chunk).run();
            }
          }
        }

        saveLogToDb('ADMIN', 'SUCCESS', `Admin cleaned up ${deletedCount} inactive users`);
        return json({ success: true, message: `Đã xóa ${deletedCount} tài khoản rác thành công!` });
      }

      // Admin: Xóa user
      if (path.startsWith('/api/admin/users/') && method === 'DELETE') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const targetUsername = path.replace('/api/admin/users/', '').split('/')[0];

        if (env.DB) {
          // Thay vàxđã cộ©ng, ta khóa tài khoản (Soft Delete)
          const res = await env.DB.prepare('UPDATE users SET is_locked = 1 WHERE username = ?').bind(targetUsername.toLowerCase()).run();
          if (res.meta.changes === 0) {
            return json({ success: false, message: 'User không tồn tại' }, 404);
          }
        }

        saveLogToDb('ADMIN', 'SUCCESS', `Admin soft-deleted (locked) user: ${targetUsername}`);
        return json({ success: true, message: 'Đđăng kýhóa tài khoản thành công (Soft Delete)!' });
      }

      // Admin: Cộng/Trừ tiộn user
      if (path.startsWith('/api/admin/users/') && path.endsWith('/adjust-balance') && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const targetUsername = path.replace('/api/admin/users/', '').replace('/adjust-balance', '');
        const { amount, reason } = await request.json();

        const adjustAmount = parseInt(amount);
        if (!adjustAmount) return json({ success: false, message: 'Số tiộn không hợp lệ' }, 400);

        const user = await getUser(targetUsername);
        if (!user) return json({ success: false, message: 'User không tồn tại' }, 404);

        if (user.balance + adjustAmount < 0) {
          return json({ success: false, message: 'Sđãđăng kýhông  đãtrHệ' }, 400);
        }

        if (env.DB) {
          if (adjustAmount < 0) {
            await env.DB.prepare('UPDATE users SET balance = balance + ?, total_spent = total_spent + ? WHERE username = ?')
              .bind(adjustAmount, Math.abs(adjustAmount), targetUsername.toLowerCase())
              .run();
          } else {
            await env.DB.prepare('UPDATE users SET balance = balance + ? WHERE username = ?')
              .bind(adjustAmount, targetUsername.toLowerCase())
              .run();
          }

          const txId = 'ADJ' + Math.random().toString(36).substring(2, 8).toUpperCase();
          await env.DB.prepare('INSERT OR REPLACE INTO transactions (id, username, type, amount, status, note, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(txId, targetUsername.toLowerCase(), adjustAmount > 0 ? 'admin_credit' : 'admin_debit', adjustAmount, 'SUCCESS', reason || 'Admin điều chỉnh', new Date().toISOString(), new Date().toISOString())
            .run();
        }

        saveLogToDb('ADMIN', 'SUCCESS', `Admin adjusted balance for ${targetUsername}: ${adjustAmount > 0 ? '+' : ''}${adjustAmount}đ. Reason: ${reason || 'Khđểng có'}`);
        return json({ success: true, message: `Đíthay đổi số dư thành công!` });
      }

      // Admin: Thđã thiết bị hđ" khđọch hđểng
      if (path === '/api/admin/devices/add' && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        const { username, udid, name, model, packageId } = await request.json();

        if (!username || !udid || !packageId) {
          return json({ success: false, message: 'Thiđã thông tin bịt buđọc' }, 400);
        }

        if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
          return json({ success: false, message: 'Username chỉããc chỉa chỉcói, sốvàdđã gốch dđãi, tđ3-30 kítđ' }, 400);
        }

        if (![1, 2, 3].includes(parseInt(packageId))) {
          return json({ success: false, message: 'Gđi không háp lý(chỉchỉp nhđã 1, 2, 3)' }, 400);

        }

        let user = await getUser(username);
        if (!user) {
          // Tộ± đểng tặ¡o user nếu chưa tồn tại
          const defaultPassword = 'user123456';
          const passwordHash = await hashPassword(defaultPassword);
          const createdAt = new Date().toISOString();
          
          if (env.DB) {
            await env.DB.prepare('INSERT OR REPLACE INTO users (username, password_hash, email, balance, total_deposited, total_spent, is_locked, created_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?)')
              .bind(username.toLowerCase(), passwordHash, '', createdAt)
              .run();
          }
          user = await getUser(username);
          saveLogToDb('ADMIN', 'INFO', `Auto-created user ${username} with default password`);
        }

        const config = await getConfig();

        // ĐĐăng kýtrên Muacert
        let deviceId = null;
        let regStatus = 'FAILED';

        if (config.isSandbox || !config.muacertToken) {
          deviceId = 'device_' + Math.random().toString(36).substring(2, 10);
          regStatus = 'REGISTERED';
        } else {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const res = await fetch('https://muacert.com/openapi/v1/devices', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.muacertToken}`
              },
              body: JSON.stringify({
                udid,
                name: name || 'iOS Device',
                model: model || 'iPhone',
                package: parseInt(packageId)
              }),
              signal: controller.signal
            });
            clearTimeout(timeoutId);

            const data = await res.json();
            if (data.code === 0) {
              deviceId = data.data?.device?.id;
              regStatus = 'REGISTERED';
            } else {
              let errorMsg = data.message || 'Muacert API error';
              if (errorMsg.toLowerCase().includes('insufficient balance')) {
                errorMsg = 'Gói này đã hết hạn, liên hệ admin để được hỗ trợ';
              }
              return json({ success: false, message: `Lỗi Muacert: ${errorMsg}` }, 400);
            }
          } catch (e) {
            return json({ success: false, message: `Lỗi kết nối Muacert: ${e.message}` }, 500);
          }
        }

        if (env.DB) {
          const localDeviceId = deviceId + '_' + username.toLowerCase();
          await env.DB.prepare('INSERT OR REPLACE INTO devices (id, username, udid, name, model, package_id, status, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(localDeviceId, username.toLowerCase(), udid, name || 'iOS Device', model || 'iPhone', parseInt(packageId), regStatus, new Date().toISOString())
            .run();
        }

        saveLogToDb('ADMIN', 'SUCCESS', `Admin added device ${udid} for user ${username}`);
        return json({ success: true, message: 'íthêm thiít bịthành công!' });
      }

      // Admin: đểng bịthiít bịtđMuacert vàDB
      if (path === '/api/admin/devices/sync' && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        
        const config = await getConfig();
        if (!config.muacertToken) {
          return json({ success: false, message: 'Chđã cóu hđãh Token Muacert' }, 400);
        }

        try {
          const res = await fetch('https://muacert.com/openapi/v1/devices?limit=1000', {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${config.muacertToken}`
            }
          });
          
          const data = await res.json();
          if (data.code !== 0) {
            return json({ success: false, message: `Lỗi Muacert: ${data.message}` }, 400);
          }

          const devices = data.data?.devicesList || [];
          let syncedCount = 0;

          if (env.DB && devices.length > 0) {
            const defaultUser = 'admin';
            
            let adminUser = await getUser(defaultUser);
            if (!adminUser) {
              const passwordHash = await hashPassword('admin123');
              await env.DB.prepare('INSERT OR IGNORE INTO users (username, password_hash, email, balance, total_deposited, total_spent, is_locked, created_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?)')
                .bind(defaultUser, passwordHash, '', new Date().toISOString())
                .run();
            }

            const stmts = [];
            for (const dev of devices) {
              const udid = dev.attributes?.udid || '';
              if (!udid) continue;

              // Tìm xem UDID này đã có trong database chưa (của bất kỳ user nào)
              const existingDevices = await env.DB.prepare('SELECT * FROM devices WHERE udid = ?').bind(udid).all();
              
              if (existingDevices.results && existingDevices.results.length > 0) {
                // Nếu đã có trong DB, ta cập nhật lại ID chuẩn từ Muacert cho TẤT CẢ các user đang sở hữu UDID này
                for (const existingDev of existingDevices.results) {
                  const correctLocalDeviceId = dev.id + '_' + existingDev.username;
                  
                  // Nếu ID hiện tại khác với ID chuẩn, ta cập nhật lại
                  if (existingDev.id !== correctLocalDeviceId) {
                    stmts.push(
                      env.DB.prepare('UPDATE devices SET id = ?, status = ? WHERE id = ?')
                        .bind(correctLocalDeviceId, 'REGISTERED', existingDev.id)
                    );
                    syncedCount++;
                  }
                }
              } else {
                // Nếu chưa có ai sở hữu UDID này trong DB, ta gán nó cho admin
                const localDeviceId = dev.id + '_' + defaultUser;
                stmts.push(
                  env.DB.prepare('INSERT INTO devices (id, username, udid, name, model, package_id, status, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                    .bind(
                      localDeviceId, 
                      defaultUser, 
                      udid, 
                      dev.attributes?.name || 'Synced Device', 
                      dev.attributes?.model || 'Unknown', 
                      dev.package || 3, 
                      'REGISTERED', 
                      dev.attributes?.addedAt || new Date().toISOString()
                    )
                );
                syncedCount++;
              }
            }

            if (stmts.length > 0) {
              const chunkSize = 100;
              for (let i = 0; i < stmts.length; i += chunkSize) {
                const chunk = stmts.slice(i, i + chunkSize);
                await env.DB.batch(chunk);
              }
            }
          }

          saveLogToDb('ADMIN', 'SUCCESS', `Admin synced ${syncedCount} devices from Muacert`);
          return json({ success: true, message: `đãểng bịthành công ${syncedCount} thiít bịmỗi tđMuacert!` });
        } catch (e) {
          return json({ success: false, message: `Lỗi đểng bị: ${e.message}` }, 500);
        }
      }

      // Admin: Backup Export
      // Admin: Backup Export
      if (path === '/api/admin/backup/export' && method === 'GET') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        
        if (!env.DB) return json({ success: false, message: 'Database not available' }, 500);

        try {
          const settings = await env.DB.prepare('SELECT * FROM settings').all().catch(() => ({ results: [] }));
          const users = await env.DB.prepare('SELECT * FROM users').all().catch(() => ({ results: [] }));
          const devices = await env.DB.prepare('SELECT * FROM devices').all().catch(() => ({ results: [] }));
          const transactions = await env.DB.prepare('SELECT * FROM transactions').all().catch(() => ({ results: [] }));

          const backup = {
            settings: settings.results || [],
            users: users.results || [],
            userList: users.results || [], // For compatibility with admin.js check
            devices: devices.results || [],
            transactions: transactions.results || [],
            exportedAt: new Date().toISOString()
          };

          saveLogToDb('ADMIN', 'SUCCESS', 'Exported database backup');
          return json({ success: true, backup });
        } catch (e) {
          return json({ success: false, message: `Export failed: ${e.message}` }, 500);
        }
      }

      // Admin: Backup Import
      if (path === '/api/admin/backup/import' && method === 'POST') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        
        if (!env.DB) return json({ success: false, message: 'Database not available' }, 500);

        try {
          const { backup } = await request.json();
          if (!backup || !backup.settings || !backup.users) {
            return json({ success: false, message: 'Invalid backup format' }, 400);
          }

          // Sộ­ dộ¥ng D1 batch để đảm bảo tính toàn vẹn dữ liệu (Atomic) và chống timeout
          const stmts = [];
          stmts.push(env.DB.prepare('DELETE FROM transactions'));
          stmts.push(env.DB.prepare('DELETE FROM devices'));
          stmts.push(env.DB.prepare('DELETE FROM users'));
          stmts.push(env.DB.prepare('DELETE FROM settings'));

          for (const s of backup.settings) {
            stmts.push(env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(s.key, s.value));
          }

          for (const u of backup.users) {
            stmts.push(env.DB.prepare('INSERT OR REPLACE INTO users (username, password_hash, email, balance, total_deposited, total_spent, is_locked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .bind(u.username, u.password_hash, u.email, u.balance, u.total_deposited, u.total_spent, u.is_locked, u.created_at));
          }

          if (backup.devices) {
            for (const d of backup.devices) {
              stmts.push(env.DB.prepare('INSERT INTO devices (id, username, udid, name, model, package_id, status, registered_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(d.id, d.username, d.udid, d.name, d.model, d.package_id, d.status, d.registered_at, d.deleted_at));
            }
          }

          if (backup.transactions) {
            for (const t of backup.transactions) {
              stmts.push(env.DB.prepare('INSERT OR REPLACE INTO transactions (id, username, type, amount, package_id, udid, device_id, status, note, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .bind(t.id, t.username, t.type, t.amount, t.package_id, t.udid, t.device_id, t.status, t.note, t.created_at, t.completed_at));
            }
          }

          // Cloudflare D1 có giới hạn số lượng lệnh trong 1 batch (thông lý100 lệnh)
          // Nđã ta phặ£i chia nhộ mảng stmts ra thành các chunk (mỗi chunk 100 lệnh) để tránh lỗi D1_ERROR

          const chunkSize = 100;
          for (let i = 0; i < stmts.length; i += chunkSize) {
            const chunk = stmts.slice(i, i + chunkSize);
            await env.DB.batch(chunk);
          }

          saveLogToDb('ADMIN', 'SUCCESS', 'Imported database backup');
          return json({ success: true, message: 'Khôi phục dữ liệu thành công' });
        } catch (e) {
          return json({ success: false, message: `Import failed: ${e.message}` }, 500);
        }
      }

      // ==========================================
      // ADMIN STATS ROUTE (Thống kê doanh thu)
      // ==========================================
      if (path === '/api/admin/stats' && method === 'GET') {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);
        
        if (!env.DB) return json({ success: false, message: 'Database not configured' }, 500);

        try {
          // Lấy thống kê 30 ngày gần nhất
          const query = `
            SELECT 
              date(created_at) as date,
              SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END) as total_deposit,
              SUM(CASE WHEN type = 'purchase' THEN ABS(amount) ELSE 0 END) as total_purchase
            FROM transactions
            WHERE created_at >= date('now', '-30 days')
            GROUP BY date(created_at)
            ORDER BY date(created_at) ASC
          `;
          
          const { results } = await env.DB.prepare(query).all();
          
          // Lấy tổng quan
          const overviewQuery = `
            SELECT 
              (SELECT COUNT(*) FROM users) as total_users,
              (SELECT COUNT(*) FROM devices WHERE deleted_at IS NULL) as total_devices,
              (SELECT SUM(amount) FROM transactions WHERE type = 'deposit') as total_revenue
          `;
          const overview = await env.DB.prepare(overviewQuery).first();

          return json({ 
            success: true, 
            data: {
              chart: results,
              overview: {
                users: overview.total_users || 0,
                devices: overview.total_devices || 0,
                revenue: overview.total_revenue || 0
              }
            } 
          });
        } catch (e) {
          return json({ success: false, message: e.message }, 500);
        }
      }

      // ==========================================
      // MUACERT PROXY ROUTES (Admin only)
      // ==========================================
      if (path.startsWith('/api/devices')) {
        if (!await getAdminAuth(request)) return json({ success: false, message: 'Unauthorized' }, 401);

        const config = await getConfig();
        if (!config.muacertToken) {
          return json({ code: -1, message: 'Chưa cấu hình Token Muacert' }, 400);
        }

        // Xử lý path để lấy đúng ID của Muacert (bỏ phần _username nếu có)
        let targetPath = path.replace('/api/devices', '/devices');
        const pathParts = targetPath.split('/');
        // pathParts sẽ có dạng: ["", "devices", "deviceId", "provision"]
        if (pathParts.length > 2) {
           pathParts[2] = pathParts[2].split('_')[0];
           targetPath = pathParts.join('/');
        }

        const targetUrl = 'https://muacert.com/openapi/v1' + targetPath;
        const urlParams = url.search; // Lấy query string (như ?udid=...)

        try {
          const proxyReq = new Request(targetUrl + urlParams, {
            method: request.method,
            headers: {
              'Authorization': `Bearer ${config.muacertToken}`
            },
            body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.text() : null
          });

          const proxyRes = await fetch(proxyReq);
          
          // Nếu Muacert trả về lỗi (không phải 200 OK), trả về nguyên lỗi đó
          if (!proxyRes.ok) {
             const errorText = await proxyRes.text();
             console.log("Muacert API Error (Admin):", proxyRes.status, errorText);
             return new Response(errorText, {
               status: proxyRes.status,
               headers: {
                 'Content-Type': 'application/json',
                 'Access-Control-Allow-Origin': '*'
               }
             });
          }

          const newHeaders = new Headers(proxyRes.headers);
          newHeaders.set('Access-Control-Allow-Origin', '*');
          
          // Đảm bảo trả về đúng Content-Type cho file zip
          const contentType = proxyRes.headers.get('Content-Type') || '';
          if (contentType.includes('application/zip') || contentType.includes('application/octet-stream') || contentType.includes('application/x-zip-compressed')) {
            newHeaders.set('Content-Type', 'application/zip');
            newHeaders.set('Content-Disposition', `attachment; filename="cert.zip"`);
          }

          return new Response(proxyRes.body, {
            status: proxyRes.status,
            headers: newHeaders
          });
        } catch (e) {
          return json({ code: -1, message: `Proxy error: ${e.message}` }, 500);
        }
      }

      return json({ success: false, message: 'API Route Not Found' }, 404);
    } catch (error) {
      saveLogToDb('SYSTEM', 'ERROR', `Fatal error: ${error.message}`);
      return json({ success: false, message: error.message }, 500);
    }
  },

  // Xộ­ lýCron Triggers
  async scheduled(event, env, ctx) {
    if (!env.DB) return;

    console.log('[CRON] Starting scheduled cleanup and reconciliation...');

    // Hàm helper lấy config trong môi trườngng scheduled (không córequest)
    // Dùng global cache để giảm read D1
    const getCronConfig = async () => {
      const now = Date.now();
      if (globalMemoryCachedConfig && (now - globalLastMemoryConfigFetch < 60000)) {
        return globalMemoryCachedConfig;
      }
      let c = {
        muacertToken: '',
        pay2sPartnerCode: '',
        pay2sAccessKey: '',
        pay2sSecretKey: '',
        pay2sBankAccount: '',
        pay2sBankCode: 'MB',
        pay2sAccountName: '',
        isSandbox: true,
        adminUsername: 'admin',
        adminPassword: 'admin123',
        jwtSecret: 'muacert_super_secret_key_2026',
        turnstileSecret: '',
        supportUrl: 'https://t.me/ipamaster',
        termsUrl: '/terms.html',
        privacyUrl: '/privacy.html',
        refundUrl: '/refund.html',
        sellingPrices: { 1: 180000, 2: 120000, 3: 70000 }
      };
      const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('config').first();
      if (row && row.value) {
        try { c = { ...c, ...JSON.parse(row.value) }; } catch { }
      }

      let configChanged = false;
      if (c.jwtSecret === 'muacert_super_secret_key_2026') {
        c.jwtSecret = crypto.randomUUID();
        configChanged = true;
      }
      if (!c.webhookToken) {
        c.webhookToken = crypto.randomUUID();
        configChanged = true;
      }
      if (configChanged) {
        env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('config', JSON.stringify(c)).run().catch(() => {});
      }

      if (env.MUACERT_TOKEN) c.muacertToken = env.MUACERT_TOKEN;
      if (env.PAY2S_SECRET_KEY) c.pay2sSecretKey = env.PAY2S_SECRET_KEY;
      if (env.PAY2S_BANK_ACCOUNT) c.pay2sBankAccount = env.PAY2S_BANK_ACCOUNT;
      if (env.PAY2S_BANK_CODE) c.pay2sBankCode = env.PAY2S_BANK_CODE;
      if (env.PAY2S_ACCOUNT_NAME) c.pay2sAccountName = env.PAY2S_ACCOUNT_NAME;
      if (env.ADMIN_PASSWORD) c.adminPassword = env.ADMIN_PASSWORD;
      if (env.TURNSTILE_SECRET) c.turnstileSecret = env.TURNSTILE_SECRET;
      if (env.FRONTEND_URL) c.frontendUrl = env.FRONTEND_URL;
      if (env.JWT_SECRET) c.jwtSecret = env.JWT_SECRET;
      if (env.WEBHOOK_TOKEN) c.webhookToken = env.WEBHOOK_TOKEN;
      
      globalMemoryCachedConfig = c;
      globalLastMemoryConfigFetch = now;
      return c;
    };

    // 1. Đđi soít giao dịch Pay2S (Reconciliation)
    try {
      const config = await getCronConfig();
      if (config.pay2sPartnerCode && config.pay2sAccessKey && config.pay2sSecretKey) {
        // Lấy các giao dịch nạp tiộn PENDING trong vòng 2 giộ qua
        const pendingTx = await env.DB.prepare(`
          SELECT * FROM transactions 
          WHERE type = 'deposit' 
            AND status = 'PENDING' 
            AND created_at > datetime('now', '-2 hours')
        `).all();

        if (pendingTx.results && pendingTx.results.length > 0) {
          console.log(`[CRON] Found ${pendingTx.results.length} pending transactions to reconcile.`);

          for (const tx of pendingTx.results) {
            try {
              const requestId = Date.now().toString() + Math.random().toString(36).substring(2, 5);
              const rawHash = `accessKey=${config.pay2sAccessKey}&orderId=${tx.id}&partnerCode=${config.pay2sPartnerCode}&requestId=${requestId}`;

              const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(config.pay2sSecretKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
              const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawHash));
              const signature = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

              const apiPayload = {
                partnerCode: config.pay2sPartnerCode,
                requestId,
                orderId: tx.id,
                signature
              };

              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 10000); // Timeout 10s

              const apiRes = await fetch('https://payment.pay2s.vn/v1/gateway/api/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                body: JSON.stringify(apiPayload),
                signal: controller.signal
              });
              clearTimeout(timeoutId);

              const apiData = await apiRes.json();

              // Nặ¿u giao dịch đãthành công trên Pay2S (resultCode === 0)
              if (apiData && apiData.resultCode === 0 && apiData.amount) {
                const amount = parseInt(apiData.amount);

                // Cập nhật trạng thái giao dịch vàcó"ng tiộn cho user (Atomic UPDATE)
                const updateRes = await env.DB.prepare('UPDATE transactions SET status = ?, completed_at = ? WHERE id = ? AND status = ?')
                  .bind('SUCCESS', new Date().toISOString(), tx.id, 'PENDING')
                  .run();

                if (updateRes.meta.changes > 0) {
                  await env.DB.prepare('UPDATE users SET balance = balance + ?, total_deposited = total_deposited + ? WHERE username = ?')
                    .bind(amount, amount, tx.username)
                    .run();

                  // Ghi log vào DB
                  await env.DB.prepare('INSERT INTO logs (timestamp, source, type, message) VALUES (?, ?, ?, ?)')
                    .bind(
                      new Date().toISOString(),
                      'PAY2S_CRON',
                      'SUCCESS',
                      `Reconciliation: Auto-credited ${amount.toLocaleString()}đ to ${tx.username} for Order ${tx.id} (Pay2S confirmed)`
                    )
                    .run();

                  console.log(`[CRON] Reconciled and credited ${amount}đ to ${tx.username} for Order ${tx.id}`);
                }
              }
            } catch (err) {
              console.error(`[CRON] Failed to reconcile transaction ${tx.id}:`, err.message);
            }
          }
        }
      }
    } catch (e) {
      console.error('[CRON] Error in Pay2S reconciliation:', e);
    }

    // 2. Dọn dẹp tài khoản không hoạt đểng (>3 ngày)
    try {
      const inactiveUsers = await env.DB.prepare(`
        SELECT username, created_at FROM users 
        WHERE balance = 0 
          AND total_deposited = 0 
          AND total_spent = 0 
          AND username NOT IN (SELECT DISTINCT username FROM devices)
          AND created_at < datetime('now', '-3 days')
      `).all();

      if (inactiveUsers.results && inactiveUsers.results.length > 0) {
        const usernames = inactiveUsers.results.map(u => u.username);
        
        const chunkSize = 50;
        for (let i = 0; i < usernames.length; i += chunkSize) {
          const chunk = usernames.slice(i, i + chunkSize);
          const placeholders = chunk.map(() => '?').join(',');

          await env.DB.prepare(`DELETE FROM transactions WHERE username IN (${placeholders})`)
            .bind(...chunk)
            .run();

          await env.DB.prepare(`DELETE FROM users WHERE username IN (${placeholders})`)
            .bind(...chunk)
            .run();
        }

        for (const u of inactiveUsers.results) {
          console.log(`[CRON] Deleted inactive user: ${u.username}`);
        }
      }
    } catch (e) {
      console.error('[CRON] Error cleaning inactive users:', e);
    }

    // 3. Tđãểng đểng bịthiít bịmỗi tđMuacert
    try {
      const config = await getCronConfig();
      if (config.muacertToken) {
        const res = await fetch('https://muacert.com/openapi/v1/devices?limit=1000', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${config.muacertToken}` }
        });
        const data = await res.json();
        if (data.code === 0) {
          const devices = data.data?.devicesList || [];
          let syncedCount = 0;
          const defaultUser = 'admin';

          let adminUser = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(defaultUser).first();
          if (!adminUser) {
            // Tđã hash đã giđã cho admin user trong cron context
            // Generate PBKDF2 hash for admin123
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode('admin123'), { name: 'PBKDF2' }, false, ['deriveBits']);
            const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 10000, hash: 'SHA-256' }, keyMaterial, 256);
            const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
            const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
            const passwordHash = saltHex + ':' + hashHex;
            await env.DB.prepare('INSERT OR IGNORE INTO users (username, password_hash, email, balance, total_deposited, total_spent, is_locked, created_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?)')
              .bind(defaultUser, passwordHash, '', new Date().toISOString()).run();
          }

          const stmts = [];
          for (const dev of devices) {
            const existing = await env.DB.prepare('SELECT id FROM devices WHERE id = ? OR udid = ?').bind(dev.id, dev.attributes?.udid || '').first();
            if (!existing) {
              stmts.push(
                env.DB.prepare('INSERT INTO devices (id, username, udid, name, model, package_id, status, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                  .bind(dev.id, defaultUser, dev.attributes?.udid || '', dev.attributes?.name || 'Synced Device', dev.attributes?.model || 'Unknown', dev.package || 3, 'REGISTERED', dev.attributes?.addedAt || new Date().toISOString())
              );
              syncedCount++;
            }
          }
          if (stmts.length > 0) {
            const chunkSize = 100;
            for (let i = 0; i < stmts.length; i += chunkSize) {
              const chunk = stmts.slice(i, i + chunkSize);
              await env.DB.batch(chunk);
            }
          }
          if (syncedCount > 0) {
            console.log(`[CRON] Auto-synced ${syncedCount} new devices from Muacert`);
          }
        }
      }
    } catch (e) {
      console.error('[CRON] Error auto-syncing devices from Muacert:', e);
    }

    // 4. Dọn dẹp log cũ (>30 ngày) để giới hạn kích thước D1
    try {
      const result = await env.DB.prepare(
        "DELETE FROM logs WHERE timestamp < datetime('now', '-30 days')"
      ).run();
      if (result.meta.changes > 0) {
        console.log(`[CRON] Deleted ${result.meta.changes} old log entries`);
      }
    } catch (e) {
      console.error('[CRON] Error cleaning old logs:', e);
    }

    // 4. Dọn dẹp giao dịch PENDING quá hạn (>1 ngày chưa xộ­ lý)
    try {
      const result = await env.DB.prepare(
        "UPDATE transactions SET status = 'EXPIRED' WHERE status = 'PENDING' AND created_at < datetime('now', '-1 day')"
      ).run();
      if (result.meta.changes > 0) {
        console.log(`[CRON] Expired ${result.meta.changes} pending transactions`);
      }
    } catch (e) {
      console.error('[CRON] Error expiring old transactions:', e);
    }

    console.log('[CRON] Scheduled cleanup completed.');
  }
};

