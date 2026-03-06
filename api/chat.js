// api/chat.js — Vercel Serverless Function (Edge-compatible)
// Proxy sécurisé vers Anthropic API.
// La clé API reste côté serveur, jamais exposée au frontend.
//
// Déployer sur Vercel : la variable ANTHROPIC_API_KEY est définie
// dans les variables d'environnement Vercel (pas dans le code).

export const config = { runtime: 'edge' };

const ALLOWED_ORIGINS = [
  // Remplace par ton URL Vercel et ton domaine custom
  'https://ton-app.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  // GitHub Pages :
  // 'https://ton-username.github.io',
];

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Rate limiting simple (en mémoire, reset à chaque cold start)
const rateLimiter = new Map();
const RATE_LIMIT = 20;  // requêtes max par heure par IP
const RATE_WINDOW = 60 * 60 * 1000; // 1 heure en ms

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW; }
  entry.count++;
  rateLimiter.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';

  // Répondre aux preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : 'null',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Méthode uniquement POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  // Vérifier l'origine
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403 });
  }

  // Rate limiting par IP
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded — réessaie dans 1 heure' }), {
      status: 429,
      headers: { 'Access-Control-Allow-Origin': origin },
    });
  }

  // Clé API depuis les variables d'environnement (jamais dans le code)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': origin },
    });
  }

  try {
    const body = await req.json();

    // Valider le body (éviter les abus)
    if (!body.messages || !Array.isArray(body.messages)) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
    }

    // Limiter le max_tokens pour éviter les coûts excessifs
    const safeBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: Math.min(body.max_tokens || 1000, 2000), // max 2000
      messages: body.messages.slice(-10), // max 10 messages (évite les contextes énormes)
    };

    // Appel vers Anthropic (côté serveur — la clé est sécurisée ici)
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safeBody),
    });

    const data = await response.json();

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy error', detail: err.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': origin },
    });
  }
}
