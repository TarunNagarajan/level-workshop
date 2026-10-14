const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.status === 429 && String(args[0]).startsWith('https://api.groq.com/')) {
    const headers = response.headers;
    process.stderr.write(`${JSON.stringify({
      providerStatus: 429,
      retryAfter: headers.get('retry-after'),
      remainingRequests: headers.get('x-ratelimit-remaining-requests'),
      resetRequests: headers.get('x-ratelimit-reset-requests'),
      remainingTokens: headers.get('x-ratelimit-remaining-tokens'),
      resetTokens: headers.get('x-ratelimit-reset-tokens'),
    })}\n`);
  }
  return response;
};
