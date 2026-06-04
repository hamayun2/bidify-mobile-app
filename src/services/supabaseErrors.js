export function logSupabaseError(scope, error) {
  if (!error) return;
  console.error(`[Bidify/services] ${scope}`, {
    message: error.message,
    code: error.code,
    status: error.status,
    details: error.details,
    hint: error.hint,
  });
}

export function logPostgrestError(scope, error, context) {
  if (!error) return;
  console.error(`[Bidify/services] ${scope}`, context || {}, {
    message: error.message,
    code: error.code,
  });
}

export function toUserMessage(error, fallback = 'Something went wrong.') {
  const msg = String(error?.message || error || '').trim();
  return msg || fallback;
}
