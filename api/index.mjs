import { createDeploymentApp } from '../server/deployment-app.mjs';

const app = createDeploymentApp({ apiNotFound: true });

export default function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const requestPath = url.searchParams.get('__request_path');
  if (!requestPath || !requestPath.startsWith('/api/')) {
    return res.status(400).json({ error: 'Invalid API route.' });
  }
  url.searchParams.delete('__request_path');
  req.url = `${requestPath}${url.search}`;
  return app(req, res);
}
