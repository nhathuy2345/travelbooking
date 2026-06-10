// Cloudflare Pages Functions - Chuyển tiếp request đến Worker
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // Nếu là API request, xử lý bằng logic Worker
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin') || url.pathname === '/login.html') {
    // Import và gọi Worker
    const workerModule = await import('../../worker.js');
    return workerModule.default.fetch(request, env, context);
  }
  
  // Còn lại serve file tĩnh từ public/
  return context.next();
}