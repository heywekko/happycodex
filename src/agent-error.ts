export function summarizeAgentError(error: string): string {
  const normalized = error.toLowerCase();
  if (
    normalized.includes('tls handshake') ||
    normalized.includes('stream disconnected') ||
    normalized.includes('error sending request') ||
    normalized.includes('connect timeout') ||
    normalized.includes('connection reset') ||
    normalized.includes('network')
  ) {
    return 'Codex 网络连接失败，将有限重试；持续失败后保留消息并停止自动重试。';
  }
  if (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid authentication') ||
    normalized.includes('status 401')
  ) {
    return 'Codex 登录状态失效，请管理员重新登录后再试。';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'Codex 处理超时，将有限重试；持续失败后保留消息并停止自动重试。';
  }

  const firstLine = error
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  const detail = firstLine || '未知错误';
  return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
}
