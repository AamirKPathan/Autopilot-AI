import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';
import Stripe from 'stripe';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const port = Number(process.env.PORT ?? process.env.AI_PORT ?? 8787);
const sunaBaseUrl = (process.env.SUNA_BASE_URL ?? process.env.AI_BASE_URL ?? '').replace(/\/$/, '');
const firstFilled = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
const sunaApiKey = firstFilled(process.env.SUNA_API_KEY, process.env.GROQ_API_KEY, process.env.AI_API_KEY);
const sunaModel = process.env.SUNA_MODEL ?? process.env.AI_MODEL ?? 'llama3.1';
const hermesBaseUrl = (process.env.HERMES_BASE_URL ?? process.env.AI_HERMES_BASE_URL ?? '').replace(/\/$/, '');
const hermesApiKey = firstFilled(process.env.HERMES_API_KEY, process.env.GROQ_API_KEY, process.env.AI_HERMES_API_KEY);
const hermesModel = process.env.HERMES_MODEL ?? process.env.AI_HERMES_MODEL ?? 'llama3.1';
const logsPath = join(__dirname, 'logs', 'reports.jsonl');
const artifactsPath = join(__dirname, 'artifacts');
const distPath = join(__dirname, 'dist');
const maxModelTokens = Number(process.env.AI_MAX_TOKENS ?? 220);
const worldCupResultsSourceUrl = 'https://www.fourfourtwo.com/competition/all-of-the-world-cup-scores-so-far-at-the-2026-tournament';
const t20WorldCupIndexRawUrl = 'https://en.wikipedia.org/w/index.php?title=Men%27s_T20_World_Cup&action=raw';
const appBaseUrl = (process.env.APP_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const mongoUri = process.env.MONGODB_URI ?? '';
const mongoDbName = process.env.MONGODB_DB ?? 'suna';
const sessionCookieName = 'suna_session';
const sessionDays = Number(process.env.SESSION_DAYS ?? 30);
const authRequired = process.env.AUTH_REQUIRED === 'true';
const microsoftClientId = process.env.MICROSOFT_CLIENT_ID ?? '';
const microsoftClientSecret = process.env.MICROSOFT_CLIENT_SECRET ?? '';
const microsoftTenant = process.env.MICROSOFT_TENANT_ID ?? 'common';
const microsoftRedirectUri = process.env.MICROSOFT_REDIRECT_URI ?? `${appBaseUrl}/api/auth/microsoft/callback`;
const adminEmails = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? '';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const stripePriceIds = {
  plus: process.env.STRIPE_PLUS_PRICE_ID ?? '',
  pro: process.env.STRIPE_PRO_PRICE_ID ?? '',
  team: process.env.STRIPE_TEAM_PRICE_ID ?? '',
  enterprise: process.env.STRIPE_ENTERPRISE_PRICE_ID ?? '',
};
const planConfigs = {
  free: { id: 'free', name: 'Free', dailyTokens: 10000, model: sunaModel, paid: false },
  plus: { id: 'plus', name: 'Plus', dailyTokens: 100000, model: sunaModel, paid: true },
  pro: { id: 'pro', name: 'Pro', dailyTokens: 500000, model: sunaModel, paid: true },
  team: { id: 'team', name: 'Team', dailyTokens: 1000000, model: sunaModel, paid: true },
  enterprise: { id: 'enterprise', name: 'Enterprise', dailyTokens: 2500000, model: sunaModel, paid: true },
  admin: { id: 'admin', name: 'Admin Unlimited', dailyTokens: Number.MAX_SAFE_INTEGER, model: hermesModel, paid: false },
};

function isLocalModelHost(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(baseUrl);
}

let mongoClientPromise = null;
const memoryDb = {
  users: new Map(),
  sessions: new Map(),
};

function usingMongo() {
  return Boolean(mongoUri);
}

async function getDb() {
  if (!mongoUri) {
    return null;
  }

  if (!mongoClientPromise) {
    mongoClientPromise = new MongoClient(mongoUri).connect();
  }

  const client = await mongoClientPromise;
  return client.db(mongoDbName);
}

async function ensureIndexes() {
  const db = await getDb();
  if (!db) {
    return;
  }

  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('users').createIndex({ microsoftId: 1 }, { sparse: true }),
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((cookie) => {
    const [name, ...parts] = cookie.trim().split('=');
    return [name, decodeURIComponent(parts.join('='))];
  }).filter(([name]) => name));
}

function cookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function sendRedirect(response, location, headers = {}) {
  response.writeHead(302, { Location: location, ...headers });
  response.end();
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  const effectivePlan = user.role === 'admin' ? planConfigs.admin : (planConfigs[user.plan] ?? planConfigs.free);
  const tokensUsedToday = user.tokenResetDate === todayKey() ? Number(user.tokensUsedToday ?? 0) : 0;
  const tokensRemainingToday = effectivePlan.dailyTokens === Number.MAX_SAFE_INTEGER
    ? null
    : Math.max(0, effectivePlan.dailyTokens - tokensUsedToday);

  return {
    id: String(user._id ?? user.id),
    email: user.email,
    name: user.name ?? user.email,
    role: user.role ?? 'user',
    plan: user.role === 'admin' ? 'admin' : (user.plan ?? 'free'),
    planName: effectivePlan.name,
    model: effectivePlan.model,
    dailyTokens: effectivePlan.dailyTokens === Number.MAX_SAFE_INTEGER ? null : effectivePlan.dailyTokens,
    tokensUsedToday,
    tokensRemainingToday,
    tokenResetDate: user.tokenResetDate ?? todayKey(),
    subscriptionStatus: user.subscriptionStatus ?? 'free',
    createdAt: user.createdAt,
  };
}

function estimateTokensFromPayload(payload) {
  const text = (payload.messages ?? []).map((message) => message.content ?? '').join('\n');
  return Math.max(250, Math.ceil(text.length / 4) + maxModelTokens);
}

async function findUserByEmail(email) {
  const normalizedEmail = email.toLowerCase();
  const db = await getDb();
  if (db) {
    return db.collection('users').findOne({ email: normalizedEmail });
  }
  return memoryDb.users.get(normalizedEmail) ?? null;
}

async function findUserById(userId) {
  const db = await getDb();
  if (db) {
    return db.collection('users').findOne({ _id: new ObjectId(userId) });
  }
  return [...memoryDb.users.values()].find((user) => String(user.id) === String(userId)) ?? null;
}

async function upsertUserFromMicrosoft(profile) {
  const email = profile.email.toLowerCase();
  const now = new Date().toISOString();
  const role = adminEmails.has(email) ? 'admin' : 'user';
  const update = {
    $set: {
      email,
      name: profile.name || email,
      microsoftId: profile.microsoftId,
      updatedAt: now,
      ...(role === 'admin' ? { role: 'admin', plan: 'admin', subscriptionStatus: 'admin' } : {}),
    },
    $setOnInsert: {
      role,
      plan: role === 'admin' ? 'admin' : 'free',
      subscriptionStatus: role === 'admin' ? 'admin' : 'free',
      tokensUsedToday: 0,
      tokenResetDate: todayKey(),
      createdAt: now,
    },
  };

  const db = await getDb();
  if (db) {
    await db.collection('users').updateOne({ email }, update, { upsert: true });
    return db.collection('users').findOne({ email });
  }

  const existing = memoryDb.users.get(email);
  const user = {
    ...(existing ?? { id: randomBytes(12).toString('hex'), tokensUsedToday: 0, tokenResetDate: todayKey(), createdAt: now }),
    email,
    name: profile.name || email,
    microsoftId: profile.microsoftId,
    role,
    plan: role === 'admin' ? 'admin' : existing?.plan ?? 'free',
    subscriptionStatus: role === 'admin' ? 'admin' : existing?.subscriptionStatus ?? 'free',
    updatedAt: now,
  };
  memoryDb.users.set(email, user);
  return user;
}

async function createSession(user) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  const userId = String(user._id ?? user.id);

  const db = await getDb();
  if (db) {
    await db.collection('sessions').insertOne({ tokenHash, userId, expiresAt, createdAt: new Date() });
  } else {
    memoryDb.sessions.set(tokenHash, { tokenHash, userId, expiresAt });
  }

  return token;
}

async function getCurrentUser(request) {
  const token = parseCookies(request)[sessionCookieName];
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const db = await getDb();
  let session = null;
  if (db) {
    session = await db.collection('sessions').findOne({ tokenHash, expiresAt: { $gt: new Date() } });
  } else {
    session = memoryDb.sessions.get(tokenHash);
    if (session?.expiresAt <= new Date()) {
      memoryDb.sessions.delete(tokenHash);
      session = null;
    }
  }

  return session ? findUserById(session.userId) : null;
}

async function destroySession(request) {
  const token = parseCookies(request)[sessionCookieName];
  if (!token) {
    return;
  }

  const tokenHash = hashToken(token);
  const db = await getDb();
  if (db) {
    await db.collection('sessions').deleteOne({ tokenHash });
  } else {
    memoryDb.sessions.delete(tokenHash);
  }
}

async function updateUser(email, updates) {
  const normalizedEmail = email.toLowerCase();
  const db = await getDb();
  if (db) {
    await db.collection('users').updateOne({ email: normalizedEmail }, { $set: { ...updates, updatedAt: new Date().toISOString() } });
    return db.collection('users').findOne({ email: normalizedEmail });
  }

  const user = memoryDb.users.get(normalizedEmail);
  if (!user) {
    return null;
  }
  const nextUser = { ...user, ...updates, updatedAt: new Date().toISOString() };
  memoryDb.users.set(normalizedEmail, nextUser);
  return nextUser;
}

async function ensureTokenAllowance(user, payload) {
  if (!user) {
    return { allowed: !authRequired, user: null, usage: null };
  }

  const dateKey = todayKey();
  let workingUser = user;
  if (user.tokenResetDate !== dateKey) {
    workingUser = await updateUser(user.email, { tokenResetDate: dateKey, tokensUsedToday: 0 }) ?? user;
  }

  const publicProfile = publicUser(workingUser);
  if (publicProfile.dailyTokens === null) {
    return { allowed: true, user: workingUser, usage: publicProfile };
  }

  const estimatedTokens = estimateTokensFromPayload(payload);
  const projected = publicProfile.tokensUsedToday + estimatedTokens;
  if (projected > publicProfile.dailyTokens) {
    return { allowed: false, user: workingUser, usage: publicProfile, estimatedTokens };
  }

  const updatedUser = await updateUser(workingUser.email, { tokensUsedToday: projected });
  return { allowed: true, user: updatedUser ?? workingUser, usage: publicUser(updatedUser ?? workingUser), estimatedTokens };
}

function isProviderReady(baseUrl, apiKey) {
  return Boolean(baseUrl) && (Boolean(apiKey) || isLocalModelHost(baseUrl));
}

function providerStatus(baseUrl, apiKey) {
  if (!baseUrl) {
    return 'local-fallback';
  }

  if (!apiKey && !isLocalModelHost(baseUrl)) {
    return 'missing-api-key';
  }

  return 'configured-model';
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, content, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, { 'Content-Type': contentType });
  response.end(content);
}

function sendJsonWithCookie(response, statusCode, body, cookies = []) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  response.end(JSON.stringify(body));
}

function contentTypeForFile(fileName) {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.html') {
    return 'text/html; charset=utf-8';
  }
  if (extension === '.md') {
    return 'text/markdown; charset=utf-8';
  }
  if (extension === '.csv') {
    return 'text/csv; charset=utf-8';
  }
  if (extension === '.js') {
    return 'text/javascript; charset=utf-8';
  }
  if (extension === '.css') {
    return 'text/css; charset=utf-8';
  }
  if (extension === '.json') {
    return 'application/json; charset=utf-8';
  }
  if (extension === '.svg') {
    return 'image/svg+xml';
  }
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.ico') {
    return 'image/x-icon';
  }
  return 'text/plain; charset=utf-8';
}

function slugifyName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'artifact';
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function detectArtifactRequest(message) {
  const lowerMessage = message.toLowerCase();

  if (!/\b(create|make|write|generate|build)\b/.test(lowerMessage)) {
    return null;
  }

  if (/\b(html|web page|webpage)\b/.test(lowerMessage)) {
    return { extension: 'html', kind: 'HTML page' };
  }

  if (/\b(markdown|md)\b/.test(lowerMessage)) {
    return { extension: 'md', kind: 'Markdown file' };
  }

  if (/\b(text file|txt)\b/.test(lowerMessage)) {
    return { extension: 'txt', kind: 'text file' };
  }

  return null;
}

function buildArtifactPrompt(kind, requestText) {
  return [
    `Create the complete contents for a ${kind}.`,
    'Return only the file contents.',
    'Do not wrap the answer in Markdown fences.',
    'Do not explain what you made.',
    `User request: ${requestText}`,
  ].join('\n');
}

function fallbackArtifactContent(extension, requestText) {
  if (extension === 'html') {
    const title = requestText.match(/about\s+(.+?)(?:\.|$)/i)?.[1]?.trim() || 'Generated Page';
    return [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      `  <title>${escapeHtml(title)}</title>`,
      '  <style>',
      '    body { font-family: Arial, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; line-height: 1.6; }',
      '  </style>',
      '</head>',
      '<body>',
      `  <h1>${escapeHtml(title)}</h1>`,
      `  <p>${escapeHtml(requestText)}</p>`,
      '</body>',
      '</html>',
    ].join('\n');
  }

  if (extension === 'md') {
    return `# Generated Note\n\n${requestText}\n`;
  }

  return `${requestText}\n`;
}

function stripMarkdownFence(value) {
  return value.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '').trim();
}

function decodeHtmlEntities(value) {
  const entities = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#x')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

function extractTextLinesFromHtml(html) {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function isWorldCupResultsRequest(message) {
  const lowerMessage = message.toLowerCase();
  return /\b(spreadsheet|csv|excel|table)\b/.test(lowerMessage)
    && /\b(world\s*cup|fifa)\b/.test(lowerMessage)
    && /\b2026\b/.test(lowerMessage)
    && /\b(result|results|outcome|outcomes|score|scores|match|matches)\b/.test(lowerMessage);
}

function isT20CricketWorldCupRequest(message) {
  const lowerMessage = message.toLowerCase();
  return /\b(spreadsheet|csv|excel|table)\b/.test(lowerMessage)
    && /\b(t20|twenty20)\b/.test(lowerMessage)
    && /\b(cricket|icc)\b/.test(lowerMessage)
    && /\b(world\s*cup)\b/.test(lowerMessage)
    && /\b(last|latest|previous|recent|2026|result|results|outcome|outcomes|score|scores|match|matches)\b/.test(lowerMessage);
}

function isMatchDateLine(line) {
  return /^(June|July) \d{1,2}$/i.test(line);
}

function isScoreLine(line) {
  return /^\d+\s*[-–]\s*\d+(?:\s*\([^)]+\))?$/i.test(line);
}

function isStageOrGroupLine(line) {
  return /^[A-L]$/.test(line) || /^Round of (32|16|8|4)$/i.test(line) || /^(Quarter-finals?|Semi-finals?|Final|Third place)$/i.test(line);
}

function normalizeFixture(parts) {
  return parts
    .join(' ')
    .replace(/\s+vs\s+/i, ' vs ')
    .replace(/\s+v\s+/i, ' vs ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseWorldCupRows(lines) {
  const firstHeader = lines.findIndex((line, index) => line === 'Date' && lines[index + 1] === 'Group');
  if (firstHeader === -1) {
    return [];
  }

  const rows = [];
  let index = firstHeader + 4;

  while (index < lines.length) {
    if (lines[index] === 'Swipe to scroll horizontally') {
      index += 1;
      continue;
    }
    if (lines[index] === 'Date' && (lines[index + 1] === 'Group' || lines[index + 1] === 'Round')) {
      index += 4;
      continue;
    }
    if (!isMatchDateLine(lines[index])) {
      if (rows.length > 0) {
        break;
      }
      index += 1;
      continue;
    }

    const date = lines[index];
    const stageOrGroup = lines[index + 1];
    if (!isStageOrGroupLine(stageOrGroup)) {
      index += 1;
      continue;
    }

    const fixtureParts = [];
    index += 2;
    while (index < lines.length && !isScoreLine(lines[index])) {
      if (isMatchDateLine(lines[index]) || lines[index] === 'Swipe to scroll horizontally') {
        break;
      }
      fixtureParts.push(lines[index]);
      index += 1;
    }

    if (!isScoreLine(lines[index])) {
      continue;
    }

    const fixture = normalizeFixture(fixtureParts);
    const score = lines[index].replace(/\s*[-–]\s*/g, '-');
    const stage = /^[A-L]$/.test(stageOrGroup) ? `Group ${stageOrGroup}` : stageOrGroup;

    if (fixture.includes(' vs ')) {
      const [homeTeam, awayTeam] = fixture.split(/\s+vs\s+/i);
      rows.push({
        date: `${date}, 2026`,
        stage,
        homeTeam,
        awayTeam,
        fixture,
        score,
      });
    }

    index += 1;
  }

  return rows;
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function rowsToCsv(rows, sourceUrl) {
  const header = ['Date', 'Stage', 'Home Team', 'Away Team', 'Fixture', 'Score', 'Source'];
  const csvRows = rows.map((row) => [
    row.date,
    row.stage,
    row.homeTeam,
    row.awayTeam,
    row.fixture,
    row.score,
    sourceUrl,
  ]);

  return [header, ...csvRows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SunaDataTool/0.1)',
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
    },
  });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}`);
  }
  return response.text();
}

function normalizeUrl(value) {
  try {
    const withProtocol = value.startsWith('//') ? `https:${value}` : value;
    const parsed = new URL(withProtocol);
    if (parsed.hostname.includes('duckduckgo.com') && parsed.searchParams.has('uddg')) {
      return parsed.searchParams.get('uddg');
    }
    return parsed.href;
  } catch {
    return '';
  }
}

async function searchWeb(query, maxResults = 5) {
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(searchUrl);
  const results = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(linkPattern)) {
    const url = normalizeUrl(decodeHtmlEntities(match[1]));
    const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (url && title && !results.some((result) => result.url === url)) {
      results.push({ title, url });
    }
    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

function sourceTextFromHtml(html, maxCharacters = 9000) {
  const text = extractTextLinesFromHtml(html)
    .filter((line) => !/^(advertisement|sign in|subscribe|cookie|privacy policy)$/i.test(line))
    .join('\n');
  return text.slice(0, maxCharacters);
}

function needsFreshData(message) {
  const lowerMessage = message.toLowerCase();
  return /\b(latest|current|today|yesterday|tomorrow|live|real[- ]?time|recent|last|previous|202[4-9]|results?|scores?|outcomes?|standings?|schedule|fixtures?|price|prices|news|weather|now)\b/.test(lowerMessage);
}

function wantsSpreadsheetArtifact(message) {
  return /\b(spreadsheet|csv|excel|table)\b/i.test(message)
    && /\b(make|create|generate|build|give|show|list|with|of|for)\b/i.test(message);
}

function buildSearchQueryFromRequest(message) {
  return message
    .replace(/\b(make|create|generate|build|give me|show me|spreadsheet|csv|excel|table|with|of|the|every|all)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || message.slice(0, 180);
}

function wikipediaRawUrlFromPageUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith('wikipedia.org') || !parsed.pathname.startsWith('/wiki/')) {
      return '';
    }
    const title = decodeURIComponent(parsed.pathname.replace('/wiki/', '')).replaceAll('_', ' ');
    const params = new URLSearchParams({ title, action: 'raw' });
    return `https://${parsed.hostname}/w/index.php?${params.toString()}`;
  } catch {
    return '';
  }
}

function wikipediaPageUrlFromTitle(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

async function resolveLatestT20WorldCupResult() {
  const indexRaw = await fetchText(t20WorldCupIndexRawUrl);
  const lastMatch = indexRaw.match(/\|\s*last\s*=\s*\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/i);
  const title = lastMatch?.[1]?.trim();
  if (!title) {
    return null;
  }
  const params = new URLSearchParams({ title, action: 'raw' });
  return {
    title,
    url: `https://en.wikipedia.org/w/index.php?${params.toString()}`,
    displayUrl: wikipediaPageUrlFromTitle(title),
  };
}

async function extraResolvedSearchResults(requestText) {
  const lowerMessage = requestText.toLowerCase();
  const results = [];

  if (/\b(t20|twenty20)\b/.test(lowerMessage) && /\b(cricket|icc)\b/.test(lowerMessage) && /\bworld\s*cup\b/.test(lowerMessage)) {
    const latestT20 = await resolveLatestT20WorldCupResult();
    if (latestT20) {
      results.push({
        title: latestT20.title,
        url: latestT20.url,
        displayUrl: latestT20.displayUrl,
      });
    }
  }

  return results;
}

async function fetchReadableSource(result) {
  const rawUrl = wikipediaRawUrlFromPageUrl(result.url);
  const fetchUrl = rawUrl || result.url;
  const content = await fetchText(fetchUrl);
  const isPlainText = fetchUrl.includes('action=raw') || !/<html[\s>]/i.test(content.slice(0, 1000));
  const plainText = content.replace(/\r/g, '');
  const text = isPlainText
    ? (plainText.includes('Single-innings cricket match') ? plainText : plainText.slice(0, 50000))
    : sourceTextFromHtml(content, 18000);
  return {
    ...result,
    url: result.displayUrl || result.url,
    fetchUrl,
    text,
  };
}

async function gatherWebContext(requestText, forcedQuery = '') {
  const query = forcedQuery || buildSearchQueryFromRequest(requestText);
  const resolvedResults = await extraResolvedSearchResults(requestText);
  const searchResults = await searchWeb(query, 5);
  const results = [...resolvedResults, ...searchResults].filter((result, index, allResults) => {
    const url = result.displayUrl || result.url;
    return allResults.findIndex((other) => (other.displayUrl || other.url) === url) === index;
  });
  const sources = [];

  for (const result of results.slice(0, 3)) {
    try {
      const source = await fetchReadableSource(result);
      const text = source.text;
      if (text.length > 400) {
        sources.push(source);
      }
    } catch {
      // Some sites block simple fetches. Keep moving through the result list.
    }
  }

  if (sources.length === 0) {
    throw new Error('Web search ran, but no readable sources could be fetched.');
  }

  return { query, sources };
}

function webContextForPrompt(webContext, maxCharacters = 18000) {
  let remaining = maxCharacters;
  const sections = [];

  for (const [index, source] of webContext.sources.entries()) {
    const heading = `SOURCE ${index + 1}: ${source.title}\nURL: ${source.url}\n`;
    const text = source.text.slice(0, Math.max(0, remaining - heading.length));
    if (!text) {
      break;
    }
    sections.push(`${heading}${text}`);
    remaining -= heading.length + text.length;
  }

  return sections.join('\n\n---\n\n');
}

function extractWikiTemplateField(template, fieldName) {
  const match = template.match(new RegExp(`^\\|\\s*${fieldName}\\s*=\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? '';
}

function cleanWikiText(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/\{\{anchor\|[^}]+\}\}/gi, '')
    .replace(/\{\{flagdeco\|[^}]+\}\}/gi, '')
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/'''/g, '')
    .replace(/''/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseWikiDate(value) {
  const match = value.match(/\{\{[Ss]tart date\|([^}]+)\}\}/);
  if (!match) {
    return cleanWikiText(value);
  }

  const numbers = match[1]
    .split('|')
    .map((part) => part.trim())
    .filter((part) => /^\d{1,4}$/.test(part));
  const [year, month, day] = numbers;
  if (!year || !month || !day) {
    return cleanWikiText(value);
  }

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function parseCricketTeam(value) {
  const codeMatch = value.match(/\{\{cr(?:-rt)?\|([^}|]+)(?:\|[^}]*)?\}\}/i);
  const teamCodes = {
    AFG: 'Afghanistan',
    AUS: 'Australia',
    BAN: 'Bangladesh',
    CAN: 'Canada',
    ENG: 'England',
    IND: 'India',
    IRE: 'Ireland',
    ITA: 'Italy',
    NAM: 'Namibia',
    NED: 'Netherlands',
    NEP: 'Nepal',
    NZ: 'New Zealand',
    OMA: 'Oman',
    PAK: 'Pakistan',
    SA: 'South Africa',
    SCO: 'Scotland',
    SL: 'Sri Lanka',
    UAE: 'United Arab Emirates',
    USA: 'United States',
    WIN: 'West Indies',
    ZIM: 'Zimbabwe',
  };

  if (codeMatch) {
    const code = codeMatch[1].trim().toUpperCase();
    return teamCodes[code] ?? code;
  }

  return cleanWikiText(value);
}

function parseCricketRound(value, fallbackIndex) {
  const cleanRound = cleanWikiText(value);
  const matchNumber = cleanRound.match(/Match\s+(\d+)/i)?.[1];
  if (/semi-final/i.test(cleanRound)) {
    const number = Number(matchNumber || (fallbackIndex === 54 ? 54 : 53));
    return { matchNumber: number, stage: cleanRound };
  }
  if (/final/i.test(cleanRound)) {
    return { matchNumber: 55, stage: 'Final' };
  }

  const number = Number(matchNumber || fallbackIndex);
  if (number <= 40) {
    return { matchNumber: number, stage: 'Group stage' };
  }
  if (number <= 52) {
    return { matchNumber: number, stage: 'Super 8s' };
  }
  if (number <= 54) {
    return { matchNumber: number, stage: `Semi-final ${number - 52}` };
  }
  return { matchNumber: number, stage: cleanRound || 'Knockout stage' };
}

function parseMediaWikiCricketMatches(wikiText) {
  const templates = [...wikiText.matchAll(/\{\{Single-innings cricket match[\s\S]*?\n\}\}/g)]
    .map((match) => match[0])
    .filter((template) => !/Warm-up match/i.test(template));

  return templates
    .map((template, index) => {
      const round = parseCricketRound(extractWikiTemplateField(template, 'round'), index + 1);
      return {
        matchNumber: round.matchNumber,
        date: parseWikiDate(extractWikiTemplateField(template, 'date')),
        stage: round.stage,
        team1: parseCricketTeam(extractWikiTemplateField(template, 'team1')),
        team1Score: cleanWikiText(extractWikiTemplateField(template, 'score1')),
        team2: parseCricketTeam(extractWikiTemplateField(template, 'team2')),
        team2Score: cleanWikiText(extractWikiTemplateField(template, 'score2')),
        result: cleanWikiText(extractWikiTemplateField(template, 'result')),
        venue: cleanWikiText(extractWikiTemplateField(template, 'venue')),
      };
    })
    .filter((row) => row.team1 && row.team2 && row.result)
    .sort((a, b) => a.matchNumber - b.matchNumber);
}

function cricketRowsToCsv(rows, sourceUrl) {
  const header = ['Match', 'Date', 'Stage', 'Team 1', 'Team 1 Score', 'Team 2', 'Team 2 Score', 'Declaration/Result', 'Venue', 'Source'];
  const csvRows = rows.map((row) => [
    row.matchNumber,
    row.date,
    row.stage,
    row.team1,
    row.team1Score,
    row.team2,
    row.team2Score,
    row.result,
    row.venue,
    sourceUrl,
  ]);

  return [header, ...csvRows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

async function createStructuredCsvFromFetchedSources(requestText, webContext) {
  for (const source of webContext.sources) {
    const cricketRows = parseMediaWikiCricketMatches(source.text);
    if (cricketRows.length > 10) {
      const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugifyName(requestText)}.csv`;
      const filePath = join(artifactsPath, fileName);

      await mkdir(artifactsPath, { recursive: true });
      await writeFile(filePath, cricketRowsToCsv(cricketRows, source.url), 'utf8');

      return {
        fileName,
        filePath,
        kind: 'CSV spreadsheet',
        relativePath: `artifacts/${fileName}`,
        sourceUrl: source.url,
        sources: webContext.sources.map(({ title, url }) => ({ title, url })),
        rowCount: cricketRows.length,
      };
    }
  }

  return null;
}

async function createCsvArtifactFromWebContext(requestText, webContext) {
  const structuredCsv = await createStructuredCsvFromFetchedSources(requestText, webContext);
  if (structuredCsv) {
    return structuredCsv;
  }

  const sourceBlock = webContextForPrompt(webContext, 18000);
  const messages = [
    {
      role: 'system',
      content: [
        'You turn fetched web source text into CSV files.',
        'Use only the provided source text. Do not use memory.',
        'Return only valid CSV. No Markdown fences. No explanation.',
        'Include a Source URL column.',
        'If exact requested rows are unavailable, include the most relevant rows found and add a Notes column that says what is missing.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `User request: ${requestText}`,
        '',
        'Fetched source text:',
        sourceBlock,
      ].join('\n'),
    },
  ];
  const generated = await callOpenAiCompatibleChat({
    baseUrl: sunaBaseUrl,
    apiKey: sunaApiKey,
    model: sunaModel,
    messages,
    maxTokens: 3200,
  });
  const content = stripMarkdownFence(generated);
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugifyName(requestText)}.csv`;
  const filePath = join(artifactsPath, fileName);

  await mkdir(artifactsPath, { recursive: true });
  await writeFile(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');

  return {
    fileName,
    filePath,
    kind: 'CSV spreadsheet',
    relativePath: `artifacts/${fileName}`,
    sourceUrl: webContext.sources[0].url,
    sources: webContext.sources.map(({ title, url }) => ({ title, url })),
    rowCount: Math.max(0, content.split(/\r?\n/).filter(Boolean).length - 1),
  };
}

async function createResearchCsvArtifact(payload) {
  const requestText = extractLatestUserMessage(payload).trim();
  if (!wantsSpreadsheetArtifact(requestText) || !needsFreshData(requestText)) {
    return null;
  }

  const webContext = await gatherWebContext(requestText);
  return createCsvArtifactFromWebContext(requestText, webContext);
}

async function answerWithWebResearch(payload) {
  const requestText = extractLatestUserMessage(payload).trim();
  if (!needsFreshData(requestText)) {
    return null;
  }

  const webContext = await gatherWebContext(requestText);
  const sourceBlock = webContextForPrompt(webContext, 12000);
  const messages = [
    {
      role: 'system',
      content: [
        'You are Suna with web_fetch results already gathered by the local server.',
        'Answer using only the fetched source text.',
        'Be concise and cite sources by URL at the end.',
        'If the fetched sources are insufficient, say what is missing instead of guessing.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `User request: ${requestText}`,
        '',
        'Fetched source text:',
        sourceBlock,
      ].join('\n'),
    },
  ];

  const reply = await callOpenAiCompatibleChat({
    baseUrl: sunaBaseUrl,
    apiKey: sunaApiKey,
    model: sunaModel,
    messages,
    maxTokens: 1200,
  });

  return {
    reply,
    sources: webContext.sources.map(({ title, url }) => ({ title, url })),
  };
}

async function createWorldCupSpreadsheetFromRequest(payload) {
  const requestText = extractLatestUserMessage(payload).trim();
  if (!isWorldCupResultsRequest(requestText)) {
    return null;
  }

  const sourceResponse = await fetch(worldCupResultsSourceUrl, {
    headers: {
      'User-Agent': 'Suna local data connector/0.1',
    },
  });
  if (!sourceResponse.ok) {
    throw new Error(`World Cup data source failed: ${sourceResponse.status}`);
  }

  const html = await sourceResponse.text();
  const rows = parseWorldCupRows(extractTextLinesFromHtml(html));
  if (rows.length === 0) {
    throw new Error('World Cup data source did not include parseable match rows.');
  }

  const content = rowsToCsv(rows, worldCupResultsSourceUrl);
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-2026-fifa-world-cup-results.csv`;
  const filePath = join(artifactsPath, fileName);

  await mkdir(artifactsPath, { recursive: true });
  await writeFile(filePath, content, 'utf8');

  return {
    fileName,
    filePath,
    kind: 'CSV spreadsheet',
    relativePath: `artifacts/${fileName}`,
    sourceUrl: worldCupResultsSourceUrl,
    rowCount: rows.length,
  };
}

async function createArtifactFromRequest(payload) {
  const requestText = extractLatestUserMessage(payload).trim();
  const artifactRequest = detectArtifactRequest(requestText);
  if (!artifactRequest) {
    return null;
  }

  const promptPayload = {
    ...payload,
    messages: [{ role: 'user', content: buildArtifactPrompt(artifactRequest.kind, requestText) }],
  };
  const generated = await callSuna(promptPayload, 1);
  const content = stripMarkdownFence(generated || fallbackArtifactContent(artifactRequest.extension, requestText));
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${slugifyName(requestText)}.${artifactRequest.extension}`;
  const filePath = join(artifactsPath, fileName);

  await mkdir(artifactsPath, { recursive: true });
  await writeFile(filePath, content, 'utf8');

  return {
    fileName,
    filePath,
    kind: artifactRequest.kind,
    relativePath: `artifacts/${fileName}`,
  };
}

function extractLatestUserMessage(payload) {
  const latestMessage = [...(payload.messages ?? [])].reverse().find((message) => message.role === 'user');
  return latestMessage?.content ?? '';
}

function extractQuestionForFallback(payload) {
  const userMessages = (payload.messages ?? []).filter((message) => message.role === 'user');
  const latestMessage = userMessages.at(-1)?.content?.trim() ?? '';

  if (/^(answer|answer the question|tell me|explain it)$/i.test(latestMessage) && userMessages.length > 1) {
    return userMessages.at(-2)?.content?.trim() ?? latestMessage;
  }

  return latestMessage;
}

function buildSunaSystemPrompt(payload) {
  const chatType = payload.chatType ?? 'general';
  const planName = payload.planName ?? 'Plus';

  return [
    'You are Suna, a concise helpful AI assistant.',
    'Answer normal educational questions directly and concisely.',
    'When giving a numbered list, finish every item in the list and use one short sentence per item unless the user asks for detail.',
    'You can help with code, spreadsheets, documents, files, research, and local workflows.',
    'Ask before external side effects or destructive actions.',
    'If you cannot complete the job, if you detect your own hallucination, or if your result is unreliable, include the exact marker SUNA_SELF_FLAG: failure and briefly explain why.',
    `Chat mode: ${chatType}.`,
    `Subscription plan: ${planName}.`,
  ].join(' ');
}

function buildHermesSystemPrompt(payload) {
  const chatType = payload.chatType ?? 'general';
  const planName = payload.planName ?? 'Plus';

  return [
    'You are Hermes, the reviewer and escalation layer for a private AI workspace.',
    'Suna already attempted the task, self-flagged a failure, threw errors, or was reported by the user.',
    'Analyze what went wrong, what is missing, and what the corrected outcome should be. Then take over the task if enough context exists.',
    'Be direct and produce a useful review, not a long explanation.',
    `Chat mode: ${chatType}.`,
    `Subscription plan: ${planName}.`,
  ].join(' ');
}

function buildFallbackSunaReply(payload, attemptNumber) {
  const latestUserMessage = extractQuestionForFallback(payload) || 'the task';
  const chatType = payload.chatType ?? 'general';
  const lowerMessage = latestUserMessage.toLowerCase();

  if (lowerMessage.includes('html') && (lowerMessage.includes('file') || lowerMessage.includes('page'))) {
    return [
      'Here is a plain HTML file you can use:',
      '',
      '```html',
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      '  <title>About Suna</title>',
      '  <style>',
      '    body { font-family: Arial, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; line-height: 1.6; }',
      '    h1 { color: #111827; }',
      '  </style>',
      '</head>',
      '<body>',
      '  <h1>About Suna</h1>',
      '  <p>Suna is an AI assistant designed to help with everyday work, research, files, code, and automation.</p>',
      '  <p>It can turn requests into useful outputs, keep track of tasks, and hand off difficult reviews when needed.</p>',
      '</body>',
      '</html>',
      '```',
    ].join('\n');
  }

  if (chatType === 'research') {
    return `Here is the short version: ${latestUserMessage}`;
  }

  if (chatType === 'build') {
    return `Here is a starting point for that: ${latestUserMessage}`;
  }

  if (chatType === 'task') {
    return `I will handle this as a task: ${latestUserMessage}`;
  }

  if (/\bwhat is engineering\??$/i.test(latestUserMessage)) {
    return 'Engineering is the practice of using science, math, design, and practical judgment to build things that solve real problems. Engineers create systems, structures, machines, software, processes, and tools, then test and improve them so they work reliably in the real world.';
  }

  const whatIsMatch = latestUserMessage.match(/^what is (.+?)\??$/i);
  if (whatIsMatch) {
    return `${whatIsMatch[1].trim()} is something I can explain, but the local model is not currently giving a full answer. In general, it means understanding what it is, how it works, and why it matters in practical use.`;
  }

  if (latestUserMessage.endsWith('?')) {
    return `Short answer: ${latestUserMessage.replace(/\?$/, '')} is a question that needs a direct explanation. The local model is not fully connected right now, so I am using a simple fallback response instead of escalating.`;
  }

  return `Got it: ${latestUserMessage}`;
}

function buildFallbackHermesReply(payload) {
  const latestUserMessage = extractLatestUserMessage(payload) || 'the task';
  return [
    'Hermes review:',
    `- The task was escalated after Suna could not confidently complete it: ${latestUserMessage}.`,
    '- Check whether the failure came from a tool error, user-reported hallucination, missing context, or unsafe action boundary.',
    '- If this is a recurring workflow, convert the corrected path into a reusable playbook after the next successful run.',
  ].join('\n');
}

async function callOpenAiCompatibleChat({ baseUrl, apiKey, model, messages, maxTokens = maxModelTokens }) {
  if (!baseUrl) {
    return null;
  }

  if (!apiKey && !isLocalModelHost(baseUrl)) {
    throw new Error('Hosted model provider is configured, but its API key is missing.');
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new Error('Model response did not include a reply.');
  }

  return reply;
}

async function callSuna(payload, attemptNumber) {
  const messages = [
    { role: 'system', content: buildSunaSystemPrompt(payload) },
    ...(payload.messages ?? []).slice(-8).map((message) => ({ role: message.role, content: message.content })),
    { role: 'system', content: `Attempt number: ${attemptNumber}.` },
  ];

  try {
    const reply = await callOpenAiCompatibleChat({
      baseUrl: sunaBaseUrl,
      apiKey: sunaApiKey,
      model: sunaModel,
      messages,
    });

    return reply ?? buildFallbackSunaReply(payload, attemptNumber);
  } catch {
    return buildFallbackSunaReply(payload, attemptNumber);
  }
}

async function callHermes(payload) {
  const messages = [
    { role: 'system', content: buildHermesSystemPrompt(payload) },
    ...(payload.messages ?? []).slice(-8).map((message) => ({ role: message.role, content: message.content })),
    { role: 'system', content: 'Suna failed or was corrected too many times. Provide the review and next step.' },
  ];

  try {
    const reply = await callOpenAiCompatibleChat({
      baseUrl: hermesBaseUrl,
      apiKey: hermesApiKey,
      model: hermesModel,
      messages,
    });

    return reply ?? buildFallbackHermesReply(payload);
  } catch {
    return buildFallbackHermesReply(payload);
  }
}

function shouldEscalateImmediately(payload) {
  return Boolean(payload.forceHermes);
}

function detectSunaSelfFlag(reply) {
  return /\bSUNA_SELF_FLAG:\s*failure\b/i.test(reply) || /\b(self-flagged|cannot complete|not confident|unreliable)\b/i.test(reply);
}

function parseJsonObject(value) {
  const trimmed = value.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function decideToolUse(payload) {
  const requestText = extractLatestUserMessage(payload).trim();
  if (!requestText) {
    return null;
  }

  const messages = [
    {
      role: 'system',
      content: [
        'You are Suna deciding whether to use tools before answering.',
        'Available tools:',
        '- web_search: use for current, recent, factual lookup, source-backed data, sports results, prices, schedules, laws, or anything that may have changed.',
        '- direct_answer: use only when the request does not need external/current data.',
        'Return only JSON.',
        'Schema for search: {"tool":"web_search","query":"short search query","output":"answer|csv","reason":"brief"}',
        'Schema for direct answer: {"tool":"direct_answer","reason":"brief"}',
        'If the user asks for a CSV/spreadsheet/table built from external data, choose web_search with output "csv".',
      ].join(' '),
    },
    ...(payload.messages ?? []).slice(-4).map((message) => ({ role: message.role, content: message.content })),
  ];

  const decisionText = await callOpenAiCompatibleChat({
    baseUrl: sunaBaseUrl,
    apiKey: sunaApiKey,
    model: sunaModel,
    messages,
    maxTokens: 350,
  });

  return parseJsonObject(decisionText);
}

async function runToolAgent(payload) {
  const requestText = extractLatestUserMessage(payload).trim();
  const decision = await decideToolUse(payload);
  if (!decision || decision.tool !== 'web_search') {
    return null;
  }

  const webContext = await gatherWebContext(requestText, String(decision.query ?? '').trim());
  if (decision.output === 'csv') {
    const artifact = await createCsvArtifactFromWebContext(requestText, webContext);
    const sourceList = artifact.sources.map((source, index) => `${index + 1}. ${source.title}: ${source.url}`).join('\n');
    return {
      status: 'completed',
      worker: 'suna',
      attempts: [{ attemptNumber: 1, worker: 'suna', tool: 'agent_web_search_csv', decision, artifact }],
      reply: [
        `Done. I actively searched the web and created a ${artifact.kind}: ${artifact.relativePath}`,
        `Rows: ${artifact.rowCount}`,
        'Sources:',
        sourceList,
      ].join('\n'),
      artifact,
      sources: artifact.sources,
    };
  }

  const sourceBlock = webContextForPrompt(webContext, 12000);
  const reply = await callOpenAiCompatibleChat({
    baseUrl: sunaBaseUrl,
    apiKey: sunaApiKey,
    model: sunaModel,
    messages: [
      {
        role: 'system',
        content: 'Answer using only the fetched web source text. Be concise and include source URLs at the end.',
      },
      {
        role: 'user',
        content: [`User request: ${requestText}`, '', 'Fetched source text:', sourceBlock].join('\n'),
      },
    ],
    maxTokens: 1200,
  });

  return {
    status: 'completed',
    worker: 'suna',
    attempts: [{ attemptNumber: 1, worker: 'suna', tool: 'agent_web_search', decision }],
    reply,
    sources: webContext.sources.map(({ title, url }) => ({ title, url })),
  };
}

async function handleTask(request, response) {
  const payload = await readJson(request);
  const maxAttempts = 3;
  const attempts = [];
  const initialFailureCount = Number(payload.failureCount ?? 0);
  const currentUser = await getCurrentUser(request);

  if (authRequired && !currentUser) {
    sendJson(response, 401, {
      status: 'auth_required',
      worker: 'suna',
      attempts,
      reply: 'Please sign in to use Suna.',
      failureDelta: 0,
      resetFailureCount: false,
    });
    return;
  }

  const allowance = await ensureTokenAllowance(currentUser, payload);
  if (!allowance.allowed) {
    sendJson(response, 402, {
      status: 'paywall',
      worker: 'suna',
      attempts,
      reply: 'You have used today\'s tokens for your plan. Upgrade or wait until tokens refresh at midnight UTC.',
      usage: allowance.usage,
      failureDelta: 0,
      resetFailureCount: false,
    });
    return;
  }

  if (allowance.user) {
    payload.user = publicUser(allowance.user);
    payload.planName = payload.user.planName;
    payload.subscription = payload.user.plan;
  }

  if (!isProviderReady(sunaBaseUrl, sunaApiKey)) {
    sendJson(response, 200, {
      status: 'setup_required',
      worker: 'suna',
      attempts,
      reply: 'Groq is selected, but the API key is missing. Paste your Groq key into `.env` as `GROQ_API_KEY=...`, then restart the app.',
      linked: false,
      provider: providerStatus(sunaBaseUrl, sunaApiKey),
      failureDelta: 0,
      resetFailureCount: false,
    });
    return;
  }

  if (shouldEscalateImmediately(payload)) {
    const review = await callHermes(payload).catch(() => buildFallbackHermesReply(payload));
    sendJson(response, 200, {
      status: 'escalated',
      worker: 'hermes',
      attempts,
      review,
      linked: isProviderReady(hermesBaseUrl, hermesApiKey),
      provider: providerStatus(hermesBaseUrl, hermesApiKey),
      failureDelta: 0,
      resetFailureCount: true,
    });
    return;
  }

  const agentResult = await runToolAgent(payload);
  if (agentResult) {
    sendJson(response, 200, {
      ...agentResult,
      linked: isProviderReady(sunaBaseUrl, sunaApiKey),
      provider: providerStatus(sunaBaseUrl, sunaApiKey),
      failureDelta: 0,
      resetFailureCount: true,
      sunaSelfFlaggedFailure: false,
    });
    return;
  }

  const worldCupSpreadsheet = await createWorldCupSpreadsheetFromRequest(payload);
  if (worldCupSpreadsheet) {
    const reply = [
      `Done. I created a ${worldCupSpreadsheet.kind} with ${worldCupSpreadsheet.rowCount} parsed 2026 FIFA World Cup match results: ${worldCupSpreadsheet.relativePath}`,
      `Source: ${worldCupSpreadsheet.sourceUrl}`,
    ].join('\n');
    sendJson(response, 200, {
      status: 'completed',
      worker: 'suna',
      attempts: [{ attemptNumber: 1, worker: 'suna', tool: 'world_cup_results_csv', artifact: worldCupSpreadsheet }],
      reply,
      artifact: worldCupSpreadsheet,
      linked: isProviderReady(sunaBaseUrl, sunaApiKey),
      provider: providerStatus(sunaBaseUrl, sunaApiKey),
      failureDelta: 0,
      resetFailureCount: true,
      sunaSelfFlaggedFailure: false,
    });
    return;
  }

  const researchCsv = await createResearchCsvArtifact(payload);
  if (researchCsv) {
    const sourceList = researchCsv.sources.map((source, index) => `${index + 1}. ${source.title}: ${source.url}`).join('\n');
    const reply = [
      `Done. I searched the web, fetched current sources, and created a ${researchCsv.kind}: ${researchCsv.relativePath}`,
      `Rows: ${researchCsv.rowCount}`,
      'Sources:',
      sourceList,
    ].join('\n');
    sendJson(response, 200, {
      status: 'completed',
      worker: 'suna',
      attempts: [{ attemptNumber: 1, worker: 'suna', tool: 'web_search_fetch_csv', artifact: researchCsv }],
      reply,
      artifact: researchCsv,
      sources: researchCsv.sources,
      linked: isProviderReady(sunaBaseUrl, sunaApiKey),
      provider: providerStatus(sunaBaseUrl, sunaApiKey),
      failureDelta: 0,
      resetFailureCount: true,
      sunaSelfFlaggedFailure: false,
    });
    return;
  }

  const artifact = await createArtifactFromRequest(payload);
  if (artifact) {
    const reply = `Done. I created ${artifact.kind}: ${artifact.relativePath}`;
    sendJson(response, 200, {
      status: 'completed',
      worker: 'suna',
      attempts: [{ attemptNumber: 1, worker: 'suna', tool: 'create_artifact', artifact }],
      reply,
      artifact,
      linked: isProviderReady(sunaBaseUrl, sunaApiKey),
      provider: providerStatus(sunaBaseUrl, sunaApiKey),
      failureDelta: 0,
      resetFailureCount: true,
      sunaSelfFlaggedFailure: false,
    });
    return;
  }

  const webResearch = await answerWithWebResearch(payload);
  if (webResearch) {
    sendJson(response, 200, {
      status: 'completed',
      worker: 'suna',
      attempts: [{ attemptNumber: 1, worker: 'suna', tool: 'web_search_fetch' }],
      reply: webResearch.reply,
      sources: webResearch.sources,
      linked: isProviderReady(sunaBaseUrl, sunaApiKey),
      provider: providerStatus(sunaBaseUrl, sunaApiKey),
      failureDelta: 0,
      resetFailureCount: true,
      sunaSelfFlaggedFailure: false,
    });
    return;
  }

  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    try {
      const reply = await callSuna(payload, attemptNumber);
      const selfFlaggedFailure = detectSunaSelfFlag(reply);
      attempts.push({ attemptNumber, worker: 'suna', reply, selfFlaggedFailure });

      if (selfFlaggedFailure && initialFailureCount + 1 >= 3) {
        const review = await callHermes(payload).catch(() => buildFallbackHermesReply(payload));
        sendJson(response, 200, {
          status: 'escalated',
          worker: 'hermes',
          attempts,
          reply,
          review,
          linked: isProviderReady(sunaBaseUrl, sunaApiKey) || isProviderReady(hermesBaseUrl, hermesApiKey),
          provider: providerStatus(sunaBaseUrl, sunaApiKey),
          failureDelta: 1,
          resetFailureCount: true,
          sunaSelfFlaggedFailure: true,
        });
        return;
      }

      sendJson(response, 200, {
        status: selfFlaggedFailure ? 'self-flagged' : 'completed',
        worker: 'suna',
        attempts,
        reply,
        linked: isProviderReady(sunaBaseUrl, sunaApiKey),
        provider: providerStatus(sunaBaseUrl, sunaApiKey),
        failureDelta: selfFlaggedFailure ? 1 : 0,
        resetFailureCount: !selfFlaggedFailure,
        sunaSelfFlaggedFailure: selfFlaggedFailure,
      });
      return;
    } catch (error) {
      attempts.push({
        attemptNumber,
        worker: 'suna',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      if (initialFailureCount + attempts.length >= 3) {
        const review = await callHermes(payload).catch(() => buildFallbackHermesReply(payload));
        sendJson(response, 200, {
          status: 'escalated',
          worker: 'hermes',
          attempts,
          review,
          linked: isProviderReady(hermesBaseUrl, hermesApiKey),
          provider: providerStatus(hermesBaseUrl, hermesApiKey),
          failureDelta: attempts.length,
          resetFailureCount: true,
        });
        return;
      }
    }
  }

  const review = await callHermes(payload).catch(() => buildFallbackHermesReply(payload));
  sendJson(response, 200, {
    status: 'escalated',
    worker: 'hermes',
    attempts,
    review,
    linked: isProviderReady(hermesBaseUrl, hermesApiKey),
    provider: providerStatus(hermesBaseUrl, hermesApiKey),
    failureDelta: attempts.length,
    resetFailureCount: true,
  });
}

async function handleReport(request, response) {
  const payload = await readJson(request);
  await mkdir(dirname(logsPath), { recursive: true });
  await appendFile(logsPath, `${JSON.stringify({ ...payload, createdAt: new Date().toISOString() })}\n`);

  sendJson(response, 200, { saved: true });
}

async function handleAuthMe(request, response) {
  const user = await getCurrentUser(request);
  sendJson(response, 200, {
    authenticated: Boolean(user),
    authRequired,
    user: publicUser(user),
    providers: {
      microsoft: Boolean(microsoftClientId && microsoftClientSecret),
      mongo: usingMongo(),
      stripe: Boolean(stripe),
    },
    plans: Object.values(planConfigs)
      .filter((plan) => plan.id !== 'admin')
      .map((plan) => ({
        id: plan.id,
        name: plan.name,
        dailyTokens: plan.dailyTokens,
        paid: plan.paid,
        available: !plan.paid || Boolean(stripePriceIds[plan.id]),
      })),
  });
}

async function handleMicrosoftStart(request, response) {
  if (!microsoftClientId || !microsoftClientSecret) {
    sendJson(response, 503, { error: 'Microsoft OAuth is not configured.' });
    return;
  }

  const state = randomBytes(24).toString('base64url');
  const params = new URLSearchParams({
    client_id: microsoftClientId,
    response_type: 'code',
    redirect_uri: microsoftRedirectUri,
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state,
  });
  sendRedirect(
    response,
    `https://login.microsoftonline.com/${microsoftTenant}/oauth2/v2.0/authorize?${params.toString()}`,
    { 'Set-Cookie': cookieHeader('suna_oauth_state', state, { maxAge: 600 }) },
  );
}

async function exchangeMicrosoftCode(code) {
  const body = new URLSearchParams({
    client_id: microsoftClientId,
    client_secret: microsoftClientSecret,
    code,
    redirect_uri: microsoftRedirectUri,
    grant_type: 'authorization_code',
    scope: 'openid profile email User.Read',
  });
  const tokenResponse = await fetch(`https://login.microsoftonline.com/${microsoftTenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokenResponse.ok) {
    throw new Error(`Microsoft token exchange failed: ${tokenResponse.status}`);
  }
  return tokenResponse.json();
}

async function getMicrosoftProfile(accessToken) {
  const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!graphResponse.ok) {
    throw new Error(`Microsoft profile fetch failed: ${graphResponse.status}`);
  }
  const profile = await graphResponse.json();
  return {
    microsoftId: profile.id,
    name: profile.displayName,
    email: profile.mail || profile.userPrincipalName,
  };
}

async function handleMicrosoftCallback(request, response, requestUrl) {
  const state = requestUrl.searchParams.get('state') ?? '';
  const expectedState = parseCookies(request).suna_oauth_state ?? '';
  const stateOk = state && expectedState
    && state.length === expectedState.length
    && timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
  if (!stateOk) {
    sendJson(response, 400, { error: 'Invalid OAuth state.' });
    return;
  }

  const code = requestUrl.searchParams.get('code');
  if (!code) {
    sendJson(response, 400, { error: 'Missing Microsoft OAuth code.' });
    return;
  }

  const tokenData = await exchangeMicrosoftCode(code);
  const profile = await getMicrosoftProfile(tokenData.access_token);
  if (!profile.email) {
    sendJson(response, 400, { error: 'Microsoft profile did not include an email address.' });
    return;
  }

  const user = await upsertUserFromMicrosoft(profile);
  const sessionToken = await createSession(user);
  sendRedirect(response, '/', {
    'Set-Cookie': [
      cookieHeader(sessionCookieName, sessionToken, { maxAge: sessionDays * 24 * 60 * 60 }),
      cookieHeader('suna_oauth_state', '', { maxAge: 0 }),
    ],
  });
}

async function handleLogout(request, response) {
  await destroySession(request);
  sendJsonWithCookie(response, 200, { ok: true }, [cookieHeader(sessionCookieName, '', { maxAge: 0 })]);
}

async function handleCheckout(request, response) {
  const user = await getCurrentUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sign in first.' });
    return;
  }
  if (!stripe) {
    sendJson(response, 503, { error: 'Stripe is not configured.' });
    return;
  }

  const payload = await readJson(request);
  const plan = String(payload.plan ?? '').toLowerCase();
  const price = stripePriceIds[plan];
  if (!price || !planConfigs[plan]?.paid) {
    sendJson(response, 400, { error: 'Unknown or unavailable paid plan.' });
    return;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: user.email,
    line_items: [{ price, quantity: 1 }],
    success_url: `${appBaseUrl}/?billing=success`,
    cancel_url: `${appBaseUrl}/?billing=cancelled`,
    metadata: {
      userId: String(user._id ?? user.id),
      email: user.email,
      plan,
    },
    subscription_data: {
      metadata: {
        userId: String(user._id ?? user.id),
        email: user.email,
        plan,
      },
    },
  });

  sendJson(response, 200, { url: session.url });
}

async function updateUserFromStripeObject(stripeObject) {
  const metadata = stripeObject.metadata ?? {};
  const email = metadata.email || stripeObject.customer_email;
  const plan = metadata.plan;
  if (!email || !planConfigs[plan]) {
    return;
  }

  await updateUser(email, {
    plan,
    subscriptionStatus: stripeObject.status ?? 'active',
    stripeCustomerId: typeof stripeObject.customer === 'string' ? stripeObject.customer : undefined,
    stripeSubscriptionId: typeof stripeObject.subscription === 'string' ? stripeObject.subscription : stripeObject.id,
  });
}

async function handleStripeWebhook(request, response) {
  if (!stripe || !stripeWebhookSecret) {
    sendJson(response, 503, { error: 'Stripe webhook is not configured.' });
    return;
  }

  const rawBody = await readRawBody(request);
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, request.headers['stripe-signature'], stripeWebhookSecret);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid Stripe signature.' });
    return;
  }

  if (event.type === 'checkout.session.completed') {
    await updateUserFromStripeObject(event.data.object);
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const plan = subscription.metadata?.plan;
    const email = subscription.metadata?.email;
    if (email) {
      await updateUser(email, {
        plan: subscription.status === 'active' && planConfigs[plan] ? plan : 'free',
        subscriptionStatus: subscription.status,
        stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : undefined,
        stripeSubscriptionId: subscription.id,
      });
    }
  }

  sendJson(response, 200, { received: true });
}

async function requireAdmin(request, response) {
  const user = await getCurrentUser(request);
  if (!user || user.role !== 'admin') {
    sendJson(response, 403, { error: 'Admin access required.' });
    return null;
  }
  return user;
}

async function handleAdminUsers(request, response) {
  const admin = await requireAdmin(request, response);
  if (!admin) {
    return;
  }

  const db = await getDb();
  let users = [];
  if (db) {
    users = await db.collection('users').find({}).sort({ createdAt: -1 }).limit(200).toArray();
  } else {
    users = [...memoryDb.users.values()];
  }

  sendJson(response, 200, { users: users.map(publicUser) });
}

async function handleAdminUserUpdate(request, response) {
  const admin = await requireAdmin(request, response);
  if (!admin) {
    return;
  }

  const payload = await readJson(request);
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!email) {
    sendJson(response, 400, { error: 'Email is required.' });
    return;
  }

  const updates = {};
  if (payload.role === 'admin' || payload.role === 'user') {
    updates.role = payload.role;
    if (payload.role === 'admin') {
      updates.plan = 'admin';
      updates.subscriptionStatus = 'admin';
    } else {
      updates.plan = 'free';
      updates.subscriptionStatus = 'free';
    }
  }
  if (payload.plan && planConfigs[payload.plan]) {
    updates.plan = payload.plan;
    updates.subscriptionStatus = payload.plan === 'free' ? 'free' : 'admin-granted';
  }

  const user = await updateUser(email, updates);
  if (!user) {
    sendJson(response, 404, { error: 'User not found.' });
    return;
  }

  sendJson(response, 200, { user: publicUser(user) });
}

async function serveStaticApp(requestUrl, response) {
  const rawPath = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
  const requestedPath = normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
  const candidatePath = resolve(distPath, `.${requestedPath}`);
  const resolvedDistPath = resolve(distPath);

  if (!candidatePath.startsWith(resolvedDistPath)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const content = await readFile(candidatePath);
    response.writeHead(200, { 'Content-Type': contentTypeForFile(candidatePath) });
    response.end(content);
  } catch {
    try {
      const content = await readFile(join(distPath, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(content);
    } catch {
      sendJson(response, 404, { error: 'Not found' });
    }
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method === 'GET' && requestUrl.pathname === '/api/auth/me') {
    await handleAuthMe(request, response);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/auth/microsoft/start') {
    await handleMicrosoftStart(request, response);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/auth/microsoft/callback') {
    try {
      await handleMicrosoftCallback(request, response, requestUrl);
    } catch (error) {
      console.error('Microsoft auth callback error:', error);
      sendJson(response, 500, { error: 'Microsoft sign-in failed.' });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/auth/logout') {
    await handleLogout(request, response);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      sunaLinked: isProviderReady(sunaBaseUrl, sunaApiKey),
      hermesLinked: isProviderReady(hermesBaseUrl, hermesApiKey),
      sunaProvider: providerStatus(sunaBaseUrl, sunaApiKey),
      hermesProvider: providerStatus(hermesBaseUrl, hermesApiKey),
      needsApiKey: Boolean((sunaBaseUrl && !sunaApiKey && !isLocalModelHost(sunaBaseUrl)) || (hermesBaseUrl && !hermesApiKey && !isLocalModelHost(hermesBaseUrl))),
      sunaModel,
      hermesModel,
      production: {
        authRequired,
        mongoLinked: usingMongo(),
        microsoftLinked: Boolean(microsoftClientId && microsoftClientSecret),
        stripeLinked: Boolean(stripe),
        webhookLinked: Boolean(stripeWebhookSecret),
      },
    });
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/billing/checkout') {
    try {
      await handleCheckout(request, response);
    } catch (error) {
      console.error('Checkout error:', error);
      sendJson(response, 500, { error: 'Checkout failed.' });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/stripe/webhook') {
    await handleStripeWebhook(request, response);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/admin/users') {
    await handleAdminUsers(request, response);
    return;
  }

  if (request.method === 'PATCH' && requestUrl.pathname === '/api/admin/users') {
    await handleAdminUserUpdate(request, response);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/artifacts/')) {
    const fileName = basename(decodeURIComponent(requestUrl.pathname.replace('/api/artifacts/', '')));
    try {
      const content = await readFile(join(artifactsPath, fileName), 'utf8');
      sendText(response, 200, content, contentTypeForFile(fileName));
    } catch {
      sendJson(response, 404, { error: 'Artifact not found' });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/task') {
    try {
      await handleTask(request, response);
    } catch (error) {
      console.error('Task handler error:', error);
      sendJson(response, 200, {
        status: 'escalated',
        worker: 'hermes',
        attempts: [],
        review: 'Suna is linked, but the local task server hit an unexpected error. Please try again.',
        linked: false,
        provider: 'local-fallback',
      });
    }
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/reports') {
    try {
      await handleReport(request, response);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Failed to save report.' });
    }
    return;
  }

  if (request.method === 'GET') {
    await serveStaticApp(requestUrl, response);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

ensureIndexes()
  .catch((error) => {
    console.error('Mongo index setup failed:', error);
  })
  .finally(() => {
    server.listen(port, () => {
      console.log(`Suna/Hermes API listening on http://127.0.0.1:${port}`);
    });
  });
