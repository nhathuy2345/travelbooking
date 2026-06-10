export async function onRequest(context) {
  const { request, env } = context;
  
  // Import và gọi Worker để xử lý logic tạo profile
  const workerModule = await import('../worker.js');
  return workerModule.default.fetch(request, env, context);
}
