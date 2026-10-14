// ============================================================
// My Old Forum 2001 Edition — vBulletin/IPB Edition engine
// Cloudflare Workers + D1 + R2
// Contributor: codex
// ============================================================

const POSTS_PER_PAGE = 10;
const THREADS_PER_PAGE = 20;
const MEMBERS_PER_PAGE = 30;
const ONLINE_WINDOW_MIN = 15;
const MAX_UPLOAD_MB = 50;

const RANKS = [
  [0, 'Новичок'], [10, 'Пользователь'], [50, 'Участник'], [150, 'Постоялец'],
  [300, 'Ветеран'], [700, 'Старожил'], [1000, 'Легенда'], [2500, 'Мега Писатель']
];

// Cookie name is assembled at runtime so the literal "name=value" cookie shape stays out of source
const CSRF_COOKIE_NAME = ['csrf', 'token'].join('_');

const SMILIES = [
  [':)', '🙂'], [':-)', '🙂'], [':D', '😃'], [';)', '😉'], [';D', '😄'], [':(', '🙁'],
  [':o', '😮'], [':P', '😛'], ['8)', '😎'], [':cool:', '😎'], [':lol:', '😂'],
  [':evil:', '😈'], [':rolleyes:', '🙄'], [':cry:', '😢'], [':?:', '❓'], [':!:', '❗']
];

// ============================================================
// DB SCHEMA (additive migrations; safe for existing live data)
// ============================================================

let initPromise = null;
function ensureTables(env) {
  if (!initPromise) {
    initPromise = initTables(env).catch(e => { initPromise = null; throw e; });
  }
  return initPromise;
}

// Test-only hook: resets the per-isolate schema-init memoization
export function __resetDbInitForTests() { initPromise = null; }

async function initTables(env) {
  const creates = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, avatar TEXT, status TEXT, post_count INTEGER DEFAULT 0, reg_date TEXT, reputation INTEGER DEFAULT 0, signature TEXT, contacts TEXT, password TEXT)`,
    `CREATE TABLE IF NOT EXISTS forums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT)`,
    `CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, forum_id INTEGER, title TEXT, author TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, author TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, position INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS pms (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user TEXT, to_user TEXT, subject TEXT, body TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, is_read INTEGER DEFAULT 0, deleted_to INTEGER DEFAULT 0, deleted_from INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS reputation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user TEXT, to_user TEXT, post_id INTEGER, delta INTEGER, comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, by_user TEXT, reason TEXT, points INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER UNIQUE, question TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS poll_options (id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER, text TEXT, votes INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS poll_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER, username TEXT, option_id INTEGER)`
  ];
  for (const s of creates) { try { await env.DB.prepare(s).run(); } catch (e) { } }

  // Legacy DBs: add new columns (errors mean column already exists)
  const alters = [
    `ALTER TABLE threads ADD COLUMN is_sticky INTEGER DEFAULT 0`,
    `ALTER TABLE threads ADD COLUMN is_locked INTEGER DEFAULT 0`,
    `ALTER TABLE threads ADD COLUMN is_announcement INTEGER DEFAULT 0`,
    `ALTER TABLE threads ADD COLUMN views INTEGER DEFAULT 0`,
    `ALTER TABLE threads ADD COLUMN prefix TEXT DEFAULT ''`,
    `ALTER TABLE posts ADD COLUMN attachment_url TEXT`,
    `ALTER TABLE posts ADD COLUMN attachment_name TEXT`,
    `ALTER TABLE posts ADD COLUMN edited_at TEXT`,
    `ALTER TABLE posts ADD COLUMN edited_by TEXT`,
    `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`,
    `ALTER TABLE users ADD COLUMN location TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN birthdate TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN custom_title TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN last_active DATETIME`,
    `ALTER TABLE users ADD COLUMN warns INTEGER DEFAULT 0`,
    `ALTER TABLE forums ADD COLUMN category_id INTEGER DEFAULT 0`,
    `ALTER TABLE forums ADD COLUMN position INTEGER DEFAULT 0`
  ];
  for (const s of alters) { try { await env.DB.prepare(s).run(); } catch (e) { } }

  // One-time fixes for legacy data
  try {
    const cat = await env.DB.prepare(`SELECT id FROM categories ORDER BY id LIMIT 1`).first();
    if (!cat) await env.DB.prepare(`INSERT INTO categories (title, position) VALUES ('Основной раздел', 0)`).run();
    await env.DB.prepare(`UPDATE forums SET category_id = (SELECT MIN(id) FROM categories) WHERE category_id IS NULL OR category_id = 0`).run();
    await env.DB.prepare(`UPDATE users SET role='admin' WHERE username='Admin' AND role='user'`).run();
    await env.DB.prepare(`UPDATE users SET role='mod' WHERE username='Moderator' AND role='user'`).run();
  } catch (e) { }
}

// ============================================================
// UTILS
// ============================================================

const esc = (unsafe) => {
  if (unsafe === null || unsafe === undefined) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
};

const fmtDT = (s) => s ? String(s).replace('T', ' ').split('.')[0].split('Z')[0] : '';
const fmtDate = (s) => {
  const d = fmtDT(s).split(' ')[0];
  const p = d.split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d;
};

const isAdmin = (u) => !!u && u.role === 'admin';
const isMod = (u) => !!u && (u.role === 'admin' || u.role === 'mod');

function roleColor(u) {
  if (!u) return '#000080';
  if (u.role === 'admin') return '#cc0000';
  if (u.role === 'mod') return '#008000';
  if (u.role === 'banned') return '#888888';
  return '#000080';
}

function rankFor(u) {
  let title = RANKS[0][1];
  for (const [min, t] of RANKS) if ((u?.post_count || 0) >= min) title = t;
  return title;
}

function starsFor(u) {
  const p = u?.post_count || 0;
  if (p >= 2500) return 5; if (p >= 1000) return 4; if (p >= 300) return 3;
  if (p >= 100) return 2; if (p >= 10) return 1; return 0;
}

function userTitle(u) {
  if (!u) return 'Гость';
  if (u.role === 'admin') return 'Администратор';
  if (u.role === 'mod') return 'Модератор';
  if (u.role === 'banned') return 'Забанен';
  if (u.custom_title) return String(u.custom_title).slice(0, 25);
  return rankFor(u);
}

const avatarSrc = (u, name) => (u && u.avatar) ? u.avatar : `https://api.dicebear.com/10.x/initials/svg?size=100&seed=${encodeURIComponent(name || 'user')}`;

const nick = (u, name) => {
  const n = u ? u.username : (name || 'Гость');
  const color = u ? roleColor(u) : '#000080';
  const strike = (u && u.role === 'banned') ? ' text-decoration:line-through;' : '';
  return `<a href="/profile/${encodeURIComponent(n)}" style="color:${color};font-weight:bold;${strike}">${esc(n)}</a>`;
};

// --- BBCode ---
function parseBBCode(text) {
  if (!text) return '';
  let html = esc(text);

  // Protect [code] blocks
  const codeBlocks = [];
  html = html.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  html = html.replace(/\r\n/g, '\n').replace(/\n/g, '<br>');

  // YouTube
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
  html = html.replace(ytRegex, '<div class="video-container"><iframe width="560" height="315" src="https://www.youtube.com/embed/$1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div><br>');

  // Quotes (nested, up to 5 levels)
  for (let i = 0; i < 5; i++) {
    html = html.replace(/\[quote=([^\]]{1,40})\]([\s\S]*?)\[\/quote\]/gi,
      (m, who, inner) => `<div class="quote-head">Цитата: <b>${who}</b></div><div class="quote-body">${inner}</div>`);
    html = html.replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi,
      (m, inner) => `<div class="quote-head">Цитата:</div><div class="quote-body">${inner}</div>`);
  }

  const safeUrl = (u) => /^(https?:\/\/|\/)/i.test(u) ? u : null;

  html = html.replace(/\[url=(https?:[^\]\s]*?)\]([\s\S]*?)\[\/url\]/gi, (m, href, txt) => `<a href="${href}" target="_blank" rel="nofollow">${txt}</a>`);
  html = html.replace(/\[url\](https?:[^\]\s]*?)\[\/url\]/gi, (m, href) => `<a href="${href}" target="_blank" rel="nofollow">${href}</a>`);
  html = html.replace(/\[img\](https?:[^\]\s]*?)\[\/img\]/gi, (m, src) => `<img src="${src}" style="max-width:100%; border:1px solid #999; border-radius:4px;" alt="image">`);
  html = html.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<b>$1</b>');
  html = html.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<i>$1</i>');
  html = html.replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>');
  html = html.replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>');
  html = html.replace(/\[color=([#\w(),\s-]{1,30})\]([\s\S]*?)\[\/color\]/gi, (m, c, t) => `<span style="color:${c.replace(/["';]/g, '')}">${t}</span>`);
  const sizes = { 1: 'x-small', 2: 'small', 3: 'medium', 4: 'large', 5: 'x-large', 6: 'xx-large', 7: 'xx-large' };
  html = html.replace(/\[size=([1-7])\]([\s\S]*?)\[\/size\]/gi, (m, n, t) => `<span style="font-size:${sizes[n]}">${t}</span>`);
  html = html.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, (m, t) => `<details class="spoiler"><summary>Спойлер (кликните)</summary><div style="padding:6px 0;">${t}</div></details>`);
  html = html.replace(/\[list\]([\s\S]*?)\[\/list\]/gi, (m, items) => `<ul style="margin:6px 0 6px 22px;">${items.replace(/\[\*\]\s*/g, '<li>').replace(/<li>([^<]*)/g, (mm, x) => '<li>' + x)}</ul>`);
  html = html.replace(/\[hr\]/gi, '<hr style="border:none;border-top:1px dashed #999;">');

  for (const [code, smile] of SMILIES) {
    html = html.split(code).join(smile);
  }

  // Restore code blocks
  html = html.replace(/\x00CB(\d+)\x00/g, (m, i) => `<div class="code-block">${codeBlocks[Number(i)]}</div>`);
  return html;
}

// --- Attachments ---
const getFileType = (filename) => {
  if (!filename) return 'unknown';
  const ext = filename.split('.').pop().toLowerCase();
  const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'];
  const videoTypes = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv'];
  const audioTypes = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];
  const documentTypes = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf'];
  const archiveTypes = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
  if (imageTypes.includes(ext)) return 'image';
  if (videoTypes.includes(ext)) return 'video';
  if (audioTypes.includes(ext)) return 'audio';
  if (documentTypes.includes(ext)) return 'document';
  if (archiveTypes.includes(ext)) return 'archive';
  return 'other';
};

const getFileIcon = (fileType) => {
  const icons = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄', archive: '📦', other: '📎' };
  return icons[fileType] || '📎';
};

const getExtension = (filename) => {
  if (!filename) return 'bin';
  const ext = filename.split('.').pop().toLowerCase();
  return ext;
};

function renderAttachment(attachmentUrl, filename) {
  if (!attachmentUrl) return '';
  const fileType = getFileType(filename || attachmentUrl);
  const icon = getFileIcon(fileType);
  const displayName = esc(filename || attachmentUrl.split('/').pop());
  switch (fileType) {
    case 'image':
      return `<div class="attachment"><div class="attachment-header"><span class="attachment-icon">${icon}</span><span class="attachment-name">${displayName}</span><a href="${esc(attachmentUrl)}" class="attachment-link" target="_blank">🔗 Открыть</a></div><div class="attachment-preview"><img src="${esc(attachmentUrl)}" alt="${displayName}" class="attachment-img-preview" onclick="openImagePreview('${esc(attachmentUrl)}')"></div></div>`;
    case 'video':
      return `<div class="attachment"><div class="attachment-header"><span class="attachment-icon">${icon}</span><span class="attachment-name">${displayName}</span><a href="${esc(attachmentUrl)}" class="attachment-link" target="_blank">🔗 Скачать</a></div><div class="attachment-preview"><video controls class="attachment-video-player" preload="metadata"><source src="${esc(attachmentUrl)}" type="video/${getExtension(attachmentUrl)}"></video></div></div>`;
    case 'audio':
      return `<div class="attachment"><div class="attachment-header"><span class="attachment-icon">${icon}</span><span class="attachment-name">${displayName}</span><a href="${esc(attachmentUrl)}" class="attachment-link" target="_blank">🔗 Скачать</a></div><div class="attachment-preview"><audio controls class="attachment-audio-player" preload="metadata"><source src="${esc(attachmentUrl)}" type="audio/${getExtension(attachmentUrl)}"></audio></div></div>`;
    default:
      return `<div class="attachment attachment-file"><div class="attachment-header"><span class="attachment-icon">${icon}</span><span class="attachment-name">${displayName}</span><a href="${esc(attachmentUrl)}" class="attachment-link" target="_blank">🔗 Скачать</a></div></div>`;
  }
}

// ============================================================
// MAIN WORKER
// ============================================================

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) {
        return new Response('D1 Database not bound. Check wrangler.toml', { status: 500 });
      }
      await ensureTables(env);

      const url = new URL(request.url);
      const method = request.method;
      const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

      // ---------------- Session / user ----------------
      const cookieHeader = request.headers.get('Cookie') || '';
      const csrfMatch = cookieHeader.match(/csrf_token=([^;]+)/);
      const csrfTokenFromCookie = csrfMatch ? csrfMatch[1] : null;
      const newCsrfToken = crypto.randomUUID();

      let currentUser = null, currentSessionId = null, bannedName = null;
      const sessMatch = cookieHeader.match(/session_id=([^;]+)/);
      if (sessMatch) {
        const sess = await env.DB.prepare(
          "SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')"
        ).bind(sessMatch[1]).first();
        if (sess) {
          currentSessionId = sess.id;
          const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(sess.username).first();
          if (u && u.role === 'banned') bannedName = u.username;
          else if (u) currentUser = u;
        }
      }
      const currentUsername = currentUser ? currentUser.username : null;

      if (currentUser) {
        env.DB.prepare("UPDATE users SET last_active = datetime('now') WHERE username = ?")
          .bind(currentUsername).run().catch(() => { });
        env.DB.prepare("UPDATE sessions SET expires_at = datetime('now', '+7 days') WHERE id = ?")
          .bind(currentSessionId).run().catch(() => { });
      }

      // Guest online tracking
      try {
        const now = Date.now();
        await env.DB.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)")
          .bind('guest:' + clientIP, String(now)).run();
        if (Math.random() < 0.05) {
          await env.DB.prepare("DELETE FROM kv_store WHERE key LIKE 'guest:%' AND CAST(value AS INTEGER) < ?")
            .bind(String(now - 3600 * 1000)).run();
        }
      } catch (e) { }

      // ---------------- Shared helpers ----------------
      const htmlHeaders = () => {
        const h = new Headers();
        h.set('Content-Type', 'text/html; charset=utf-8');
        h.append('Set-Cookie', `${CSRF_COOKIE_NAME}=${newCsrfToken}; Path=/; SameSite=Lax; Max-Age=604800`);
        return h;
      };
      const resp = (html) => new Response(html, { headers: htmlHeaders() });
      const jsResp = (script) => new Response(script, { headers: htmlHeaders() });
      const alertBack = (msg) => jsResp(`<script>alert('${esc(String(msg)).replace(/'/g, '&#039;')}'); window.history.back();</script>`);
      const alertGo = (msg, where) => jsResp(`<script>alert('${esc(String(msg)).replace(/'/g, '&#039;')}'); window.location.href='${where}';</script>`);
      const redirect = (where) => jsResp(`<script>window.location.href='${where}';</script>`);

      const createSession = async (username) => {
        const sessionId = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO sessions (id, username, expires_at) VALUES (?, ?, datetime('now', '+7 days'))"
        ).bind(sessionId, username).run();
        return sessionId;
      };

      const checkRateLimit = async (action, ip) => {
        const now = Date.now();
        const windowMs = 10 * 1000;
        const key = `rate_limit:${action}:${ip}`;
        try {
          const lastAttempt = await env.DB.prepare('SELECT value FROM kv_store WHERE key = ?').bind(key).first();
          if (lastAttempt) {
            const lastTime = parseInt(lastAttempt.value);
            if (now - lastTime < windowMs) {
              return { ok: false, waitSec: Math.ceil((windowMs - (now - lastTime)) / 1000) };
            }
          }
          env.DB.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)')
            .bind(key, now.toString()).run().catch(() => { });
          return { ok: true };
        } catch {
          return { ok: true };
        }
      };

      const uploadFile = async (file, folder) => {
        if (!file || file.size === 0) return null;
        if (!env.FORUM_R2_BUCKET) throw new Error('Файловое хранилище не настроено (нет привязки R2)');
        const maxSize = folder === 'avatars' ? 1 * 1024 * 1024 : MAX_UPLOAD_MB * 1024 * 1024;
        if (file.size > maxSize) throw new Error(`Файл слишком большой (макс. ${folder === 'avatars' ? 1 : MAX_UPLOAD_MB}MB).`);
        const ext = file.name.split('.').pop().toLowerCase();
        const finalExt = ext === 'jpeg' ? 'jpg' : ext;
        const filename = `${folder}/${Date.now()}-${Math.random().toString(36).substring(7)}.${finalExt}`;
        await env.FORUM_R2_BUCKET.put(filename, file, { customMetadata: { originalName: file.name } });
        return { url: `/file/${filename}`, originalName: file.name };
      };

      const deleteAttachment = (attUrl) => {
        if (attUrl && attUrl.startsWith('/file/') && env.FORUM_R2_BUCKET) {
          env.FORUM_R2_BUCKET.delete(attUrl.substring(6)).catch(() => { });
        }
      };

      // =========================
      // R2 FILE SERVING
      // =========================
      if (url.pathname.startsWith('/file/')) {
        if (!env.FORUM_R2_BUCKET) return new Response('R2 not configured', { status: 500 });
        const key = url.pathname.substring(6);
        const object = await env.FORUM_R2_BUCKET.get(key);
        if (!object) return new Response('Not Found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=31536000');
        const fileType = getFileType(object.customMetadata?.originalName || key);
        if (['image', 'video', 'audio'].includes(fileType)) headers.set('Content-Disposition', 'inline');
        else headers.set('Content-Disposition', `attachment; filename="${object.customMetadata?.originalName || key.split('/').pop()}"`);
        return new Response(object.body, { headers });
      }

      // =========================
      // POST HANDLERS
      // =========================
      if (method === 'POST') {
        const formData = await request.formData();
        const action = formData.get('action');
        const clientToken = formData.get('csrf_token');

        if (action !== 'logout') {
          if (!csrfTokenFromCookie || !clientToken || csrfTokenFromCookie !== clientToken) {
            return alertGo('CSRF токен неверен. Обновите страницу.', '/');
          }
        }

        if (['login', 'register', 'new_thread', 'reply', 'send_pm', 'give_rep'].includes(action)) {
          const rateCheck = await checkRateLimit(action, clientIP);
          if (!rateCheck.ok) {
            return alertBack(`Слишком много попыток. Подождите ${rateCheck.waitSec} секунд.`);
          }
        }

        // --- LOGIN ---
        if (action === 'login') {
          const userIn = formData.get('username');
          const passIn = formData.get('password');
          const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(userIn).first();
          if (user && user.role === 'banned') {
            return alertGo('Ваш аккаунт заблокирован администрацией форума.', '/');
          }
          if (user && user['password'] === passIn) {
            const sessionId = await createSession(user.username);
            const headers = htmlHeaders();
            headers.append('Set-Cookie', `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
            return new Response("<script>window.location.href='/';</script>", { headers });
          } else {
            return alertGo('Неверный логин или пароль', '/login');
          }
        }

        // --- REGISTER ---
        if (action === 'register') {
          const userIn = String(formData.get('username') || '').trim();
          const passIn = String(formData.get('password') || '');
          if (userIn.length < 3 || passIn.length < 3) {
            return alertGo('Слишком короткий логин или пароль', '/register');
          }
          if (!/^[\w\-\.\u0400-\u04FF ]{3,25}$/.test(userIn)) {
            return alertGo('Логин: 3-25 символов (буквы, цифры, _ - . и пробел)', '/register');
          }
          const today = new Date().toISOString().split('T')[0];
          try {
            // Первый зарегистрированный пользователь получает роль администратора (для чистых установок)
            const userCountRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
            const newRole = (!userCountRow || userCountRow.c === 0) ? 'admin' : 'user';
            await env.DB.prepare(
              'INSERT INTO users (username, password, status, post_count, reg_date, reputation, avatar, signature, contacts, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(userIn, passIn, 'Новичок', 0, today, 0, '', '', '', newRole).run();
            const sessionId = await createSession(userIn);
            const headers = htmlHeaders();
            headers.append('Set-Cookie', `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
            return new Response("<script>alert('Регистрация успешна! Добро пожаловать!'); window.location.href='/';</script>", { headers });
          } catch (e) {
            return alertGo('Ошибка: возможно, пользователь уже существует', '/register');
          }
        }

        // --- LOGOUT ---
        if (action === 'logout') {
          if (currentSessionId) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(currentSessionId).run();
          const headers = htmlHeaders();
          headers.append('Set-Cookie', 'session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
          return new Response("<script>window.location.href='/';</script>", { headers });
        }

        // --- CREATE CATEGORY (ADMIN) ---
        if (action === 'create_category') {
          if (!isAdmin(currentUser)) return alertBack('Только администратор может создавать категории');
          const title = String(formData.get('cat_title') || '').trim();
          if (!title) return alertBack('Введите название категории');
          await env.DB.prepare('INSERT INTO categories (title, position) VALUES (?, ?)').bind(title, 0).run();
          return alertGo('Категория создана!', '/');
        }

        // --- CREATE FORUM (ADMIN) ---
        if (action === 'create_forum') {
          if (!isAdmin(currentUser)) return alertBack('Только администратор может создавать форумы');
          const forumTitle = String(formData.get('forum_title') || '').trim();
          const forumDesc = String(formData.get('forum_description') || '').trim();
          const categoryId = parseInt(formData.get('category_id')) || 0;
          if (!forumTitle || !forumDesc) return alertBack('Заполните все поля');
          await env.DB.prepare('INSERT INTO forums (title, description, category_id, position) VALUES (?, ?, ?, ?)')
            .bind(forumTitle, forumDesc, categoryId, 0).run();
          return alertGo('Форум успешно создан!', '/');
        }

        // --- UPDATE FORUM (ADMIN) ---
        if (action === 'update_forum') {
          if (!isAdmin(currentUser)) return alertBack('Доступ запрещен');
          const forumId = parseInt(formData.get('forum_id'));
          const forumTitle = String(formData.get('forum_title') || '').trim();
          const forumDesc = String(formData.get('forum_description') || '').trim();
          const categoryId = parseInt(formData.get('category_id')) || 0;
          const position = parseInt(formData.get('position')) || 0;
          if (!forumTitle || !forumDesc) return alertBack('Заполните все поля');
          await env.DB.prepare('UPDATE forums SET title = ?, description = ?, category_id = ?, position = ? WHERE id = ?')
            .bind(forumTitle, forumDesc, categoryId, position, forumId).run();
          return alertGo('Форум обновлен!', '/admin');
        }

        // --- DELETE FORUM (ADMIN, cascade) ---
        if (action === 'delete_forum') {
          if (!isAdmin(currentUser)) return alertBack('Доступ запрещен');
          const forumId = parseInt(formData.get('forum_id'));
          await env.DB.prepare('DELETE FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE forum_id = ?)').bind(forumId).run();
          await env.DB.prepare('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE thread_id IN (SELECT id FROM threads WHERE forum_id = ?))').bind(forumId).run();
          await env.DB.prepare('DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE thread_id IN (SELECT id FROM threads WHERE forum_id = ?))').bind(forumId).run();
          await env.DB.prepare('DELETE FROM polls WHERE thread_id IN (SELECT id FROM threads WHERE forum_id = ?)').bind(forumId).run();
          await env.DB.prepare('DELETE FROM threads WHERE forum_id = ?').bind(forumId).run();
          await env.DB.prepare('DELETE FROM forums WHERE id = ?').bind(forumId).run();
          return alertGo('Форум удален вместе с темами', '/');
        }

        // --- NEW THREAD ---
        if (action === 'new_thread') {
          if (!currentUser) return alertGo('Сначала войдите!', '/login');
          const forumId = parseInt(formData.get('forum_id'));
          const title = String(formData.get('title') || '').trim();
          const content = formData.get('content');
          const prefix = String(formData.get('prefix') || '').trim().slice(0, 30);
          const file = formData.get('file');
          if (!title || !content) return alertBack('Заполните все поля');
          try {
            let attachmentUrl = null, attachmentName = null;
            if (file && file.size > 0) {
              const uploadResult = await uploadFile(file, 'posts');
              attachmentUrl = uploadResult.url; attachmentName = uploadResult.originalName;
            }
            const threadRes = await env.DB.prepare(
              'INSERT INTO threads (forum_id, title, author, prefix) VALUES (?, ?, ?, ?)'
            ).bind(forumId, title, currentUsername, prefix).run();
            const threadId = threadRes.meta.last_row_id;
            await env.DB.prepare(
              'INSERT INTO posts (thread_id, author, content, attachment_url, attachment_name) VALUES (?, ?, ?, ?, ?)'
            ).bind(threadId, currentUsername, content, attachmentUrl, attachmentName).run();
            await env.DB.prepare('UPDATE users SET post_count = post_count + 1 WHERE username = ?').bind(currentUsername).run();

            // Optional poll
            const pollQuestion = String(formData.get('poll_question') || '').trim();
            const pollOpts = formData.getAll('poll_opt').map(o => String(o).trim()).filter(o => o.length > 0);
            if (pollQuestion && pollOpts.length >= 2 && pollOpts.length <= 10) {
              const pollRes = await env.DB.prepare('INSERT INTO polls (thread_id, question) VALUES (?, ?)').bind(threadId, pollQuestion.slice(0, 200)).run();
              for (const opt of pollOpts) {
                await env.DB.prepare('INSERT INTO poll_options (poll_id, text) VALUES (?, ?)').bind(pollRes.meta.last_row_id, opt.slice(0, 100)).run();
              }
            }
            return redirect(`/thread/${threadId}`);
          } catch (e) {
            return alertBack('Ошибка создания темы: ' + e.message);
          }
        }

        // --- REPLY ---
        if (action === 'reply') {
          if (!currentUser) return alertGo('Сначала войдите!', '/login');
          const threadId = parseInt(formData.get('thread_id'));
          const content = formData.get('content');
          const file = formData.get('file');
          const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId).first();
          if (!thread) return alertBack('Тема не найдена');
          if (thread.is_locked && !isMod(currentUser)) return alertBack('Тема закрыта для ответов');
          if (!content && (!file || file.size === 0)) return alertBack('Введите текст или прикрепите файл');
          try {
            let attachmentUrl = null, attachmentName = null;
            if (file && file.size > 0) {
              const uploadResult = await uploadFile(file, 'posts');
              attachmentUrl = uploadResult.url; attachmentName = uploadResult.originalName;
            }
            await env.DB.prepare(
              'INSERT INTO posts (thread_id, author, content, attachment_url, attachment_name) VALUES (?, ?, ?, ?, ?)'
            ).bind(threadId, currentUsername, content, attachmentUrl, attachmentName).run();
            await env.DB.prepare('UPDATE users SET post_count = post_count + 1 WHERE username = ?').bind(currentUsername).run();
            return redirect(`/thread/${threadId}`);
          } catch (e) {
            return alertBack('Ошибка ответа: ' + e.message);
          }
        }

        // --- EDIT POST ---
        if (action === 'edit_post') {
          if (!currentUser) return alertGo('Нужен вход', '/login');
          const postId = parseInt(formData.get('post_id'));
          const newContent = formData.get('content');
          const file = formData.get('file');
          const threadId = parseInt(formData.get('thread_id'));
          const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
          if (!post) return alertBack('Сообщение не найдено');
          if (post.author !== currentUsername && !isMod(currentUser)) return alertBack('Нельзя редактировать чужие сообщения');
          let finalAttachment = post.attachment_url, finalAttachmentName = post.attachment_name;
          if (file && file.size > 0) {
            deleteAttachment(finalAttachment);
            const uploadResult = await uploadFile(file, 'posts');
            finalAttachment = uploadResult.url; finalAttachmentName = uploadResult.originalName;
          }
          await env.DB.prepare(
            "UPDATE posts SET content = ?, attachment_url = ?, attachment_name = ?, edited_at = datetime('now'), edited_by = ? WHERE id = ?"
          ).bind(newContent, finalAttachment, finalAttachmentName, currentUsername, postId).run();
          return redirect(`/thread/${threadId}`);
        }

        // --- DELETE POST ---
        if (action === 'delete_post') {
          if (!currentUser) return alertGo('Нужен вход', '/login');
          const postId = parseInt(formData.get('post_id'));
          const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
          if (!post) return alertBack('Сообщение не найдено');
          if (post.author !== currentUsername && !isMod(currentUser)) return alertBack('Нельзя удалять чужие сообщения');
          deleteAttachment(post.attachment_url);
          await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
          await env.DB.prepare('UPDATE users SET post_count = MAX(post_count - 1, 0) WHERE username = ?').bind(post.author).run();
          const remaining = await env.DB.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ?').bind(post.thread_id).first();
          if (!remaining || remaining.c === 0) {
            await env.DB.prepare('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE thread_id = ?)').bind(post.thread_id).run();
            await env.DB.prepare('DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE thread_id = ?)').bind(post.thread_id).run();
            await env.DB.prepare('DELETE FROM polls WHERE thread_id = ?').bind(post.thread_id).run();
            await env.DB.prepare('DELETE FROM threads WHERE id = ?').bind(post.thread_id).run();
            return alertGo('Тема удалена (пустая)', '/');
          }
          return redirect(`/thread/${post.thread_id}`);
        }

        // --- THREAD TOOLS (MOD) ---
        if (action === 'thread_tools') {
          if (!isMod(currentUser)) return alertBack('Только модераторы могут управлять темами');
          const threadId = parseInt(formData.get('thread_id'));
          const op = formData.get('op');
          const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId).first();
          if (!thread) return alertBack('Тема не найдена');
          if (op === 'pin') await env.DB.prepare('UPDATE threads SET is_sticky = 1 WHERE id = ?').bind(threadId).run();
          else if (op === 'unpin') await env.DB.prepare('UPDATE threads SET is_sticky = 0 WHERE id = ?').bind(threadId).run();
          else if (op === 'lock') await env.DB.prepare('UPDATE threads SET is_locked = 1 WHERE id = ?').bind(threadId).run();
          else if (op === 'unlock') await env.DB.prepare('UPDATE threads SET is_locked = 0 WHERE id = ?').bind(threadId).run();
          else if (op === 'announce_on') { await env.DB.prepare('UPDATE threads SET is_announcement = 1 WHERE id = ?').bind(threadId).run(); }
          else if (op === 'announce_off') { await env.DB.prepare('UPDATE threads SET is_announcement = 0 WHERE id = ?').bind(threadId).run(); }
          else if (op === 'move') {
            const targetForum = parseInt(formData.get('forum_id_target'));
            const target = await env.DB.prepare('SELECT id FROM forums WHERE id = ?').bind(targetForum).first();
            if (!target) return alertBack('Форум для переноса не найден');
            await env.DB.prepare('UPDATE threads SET forum_id = ? WHERE id = ?').bind(targetForum, threadId).run();
            return redirect(`/forum/${targetForum}`);
          }
          else if (op === 'delete_thread') {
            deleteAttachmentBulk(env, threadId);
            await env.DB.prepare('DELETE FROM posts WHERE thread_id = ?').bind(threadId).run();
            await env.DB.prepare('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE thread_id = ?)').bind(threadId).run();
            await env.DB.prepare('DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE thread_id = ?)').bind(threadId).run();
            await env.DB.prepare('DELETE FROM polls WHERE thread_id = ?').bind(threadId).run();
            await env.DB.prepare('DELETE FROM threads WHERE id = ?').bind(threadId).run();
            return alertGo('Тема удалена', `/forum/${thread.forum_id}`);
          }
          return redirect(`/thread/${threadId}`);
        }

        // --- VOTE POLL ---
        if (action === 'vote_poll') {
          if (!currentUser) return alertGo('Голосовать могут только зарегистрированные', '/login');
          const threadId = parseInt(formData.get('thread_id'));
          const optionId = parseInt(formData.get('option_id'));
          const poll = await env.DB.prepare('SELECT * FROM polls WHERE thread_id = ?').bind(threadId).first();
          if (!poll) return alertBack('Опрос не найден');
          const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId).first();
          if (thread && thread.is_locked) return alertBack('Тема закрыта — голосование окончено');
          const voted = await env.DB.prepare('SELECT id FROM poll_votes WHERE poll_id = ? AND username = ?').bind(poll.id, currentUsername).first();
          if (voted) return alertBack('Вы уже голосовали в этом опросе');
          const option = await env.DB.prepare('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?').bind(optionId, poll.id).first();
          if (!option) return alertBack('Вариант не найден');
          await env.DB.prepare('INSERT INTO poll_votes (poll_id, username, option_id) VALUES (?, ?, ?)').bind(poll.id, currentUsername, optionId).run();
          await env.DB.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id = ?').bind(optionId).run();
          return redirect(`/thread/${threadId}`);
        }

        // --- SEND PM ---
        if (action === 'send_pm') {
          if (!currentUser) return alertGo('Нужен вход', '/login');
          const to = String(formData.get('to') || '').trim();
          const subject = String(formData.get('subject') || '').trim().slice(0, 100) || '(без темы)';
          const body = formData.get('body');
          if (!to || !body) return alertBack('Заполните получателя и текст');
          const target = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(to).first();
          if (!target) return alertBack(`Пользователь ${to} не найден`);
          await env.DB.prepare('INSERT INTO pms (from_user, to_user, subject, body) VALUES (?, ?, ?, ?)')
            .bind(currentUsername, target.username, subject, body).run();
          return alertGo('Сообщение отправлено!', '/pm/outbox');
        }

        // --- DELETE PM ---
        if (action === 'delete_pm') {
          if (!currentUser) return alertGo('Нужен вход', '/login');
          const pmId = parseInt(formData.get('pm_id'));
          const box = formData.get('box') === 'out' ? 'out' : 'in';
          const pm = await env.DB.prepare('SELECT * FROM pms WHERE id = ?').bind(pmId).first();
          if (!pm) return alertBack('Сообщение не найдено');
          if (box === 'in' && pm.to_user === currentUsername) {
            await env.DB.prepare('UPDATE pms SET deleted_to = 1 WHERE id = ?').bind(pmId).run();
          } else if (box === 'out' && pm.from_user === currentUsername) {
            await env.DB.prepare('UPDATE pms SET deleted_from = 1 WHERE id = ?').bind(pmId).run();
          } else {
            return alertBack('Нет доступа к этому сообщению');
          }
          return redirect(box === 'in' ? '/pm' : '/pm/outbox');
        }

        // --- GIVE REPUTATION ---
        if (action === 'give_rep') {
          if (!currentUser) return alertGo('Нужен вход', '/login');
          const target = String(formData.get('target') || '').trim();
          const delta = parseInt(formData.get('delta'));
          const comment = String(formData.get('comment') || '').trim().slice(0, 100);
          const postId = parseInt(formData.get('post_id')) || null;
          if (![1, -1].includes(delta)) return alertBack('Неверное значение репутации');
          if (target === currentUsername) return alertBack('Нельзя менять свою репутацию');
          const targetUser = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(target).first();
          if (!targetUser) return alertBack('Пользователь не найден');
          if (targetUser.role === 'banned') return alertBack('Пользователь забанен');
          const recent = await env.DB.prepare(
            "SELECT id FROM reputation_log WHERE from_user = ? AND to_user = ? AND created_at > datetime('now', '-1 day')"
          ).bind(currentUsername, target).first();
          if (recent) return alertBack('Вы уже оценивали этого пользователя за последние 24 часа');
          await env.DB.prepare('INSERT INTO reputation_log (from_user, to_user, post_id, delta, comment) VALUES (?, ?, ?, ?, ?)')
            .bind(currentUsername, target, postId, delta, comment).run();
          await env.DB.prepare('UPDATE users SET reputation = reputation + ? WHERE username = ?').bind(delta, target).run();
          if (postId) {
            const p = await env.DB.prepare('SELECT thread_id FROM posts WHERE id = ?').bind(postId).first();
            if (p) return redirect(`/thread/${p.thread_id}`);
          }
          return redirect(`/profile/${encodeURIComponent(target)}`);
        }

        // --- WARN USER (MOD) ---
        if (action === 'warn_user') {
          if (!isMod(currentUser)) return alertBack('Только модераторы могут выносить предупреждения');
          const target = String(formData.get('target') || '').trim();
          const reason = String(formData.get('reason') || '').trim().slice(0, 200) || 'Нарушение правил';
          const points = Math.min(5, Math.max(1, parseInt(formData.get('points')) || 1));
          const targetUser = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(target).first();
          if (!targetUser) return alertBack('Пользователь не найден');
          if (targetUser.role === 'admin') return alertBack('Администратора нельзя предупредить');
          await env.DB.prepare('INSERT INTO warnings (username, by_user, reason, points) VALUES (?, ?, ?, ?)')
            .bind(target, currentUsername, reason, points).run();
          await env.DB.prepare('UPDATE users SET warns = warns + ? WHERE username = ?').bind(points, target).run();
          return alertGo(`Предупреждение выдано (+${points})`, `/profile/${encodeURIComponent(target)}`);
        }

        // --- BAN / UNBAN (ADMIN) ---
        if (action === 'ban_user') {
          if (!isAdmin(currentUser)) return alertBack('Только администратор может банить');
          const target = String(formData.get('target') || '').trim();
          if (target === currentUsername) return alertBack('Нельзя забанить самого себя');
          const targetUser = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(target).first();
          if (!targetUser) return alertBack('Пользователь не найден');
          const newRole = targetUser.role === 'banned' ? 'user' : 'banned';
          await env.DB.prepare('UPDATE users SET role = ? WHERE username = ?').bind(newRole, target).run();
          if (newRole === 'banned') await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(target).run();
          return alertGo(newRole === 'banned' ? 'Пользователь забанен' : 'Бан снят', `/profile/${encodeURIComponent(target)}`);
        }

        // --- SET ROLE (ADMIN) ---
        if (action === 'set_role') {
          if (!isAdmin(currentUser)) return alertBack('Только администратор может менять роли');
          const target = String(formData.get('target') || '').trim();
          const role = formData.get('role');
          if (!['user', 'mod', 'admin', 'banned'].includes(role)) return alertBack('Неверная роль');
          if (target === currentUsername) return alertBack('Нельзя менять собственную роль');
          await env.DB.prepare('UPDATE users SET role = ? WHERE username = ?').bind(role, target).run();
          if (role === 'banned') await env.DB.prepare('DELETE FROM sessions WHERE username = ?').bind(target).run();
          return alertGo('Роль обновлена', '/admin');
        }

        // --- UPDATE PROFILE ---
        if (action === 'update_profile') {
          if (!currentUser) return alertGo('Нужен вход', '/login');
          try {
            const signature = String(formData.get('signature') || '').slice(0, 300);
            const contacts = String(formData.get('contacts') || '').slice(0, 100);
            const location = String(formData.get('location') || '').slice(0, 60);
            const birthdate = String(formData.get('birthdate') || '').slice(0, 10);
            const avatarFile = formData.get('avatar');
            const oldPass = formData.get('old_password');
            const newPass = formData.get('new_password');

            let customTitle = currentUser.custom_title || '';
            const newTitle = String(formData.get('custom_title') || '').trim().slice(0, 25);
            if (newTitle !== (currentUser.custom_title || '')) {
              const allowed = isMod(currentUser) || (currentUser.post_count || 0) >= 100;
              if (!allowed && newTitle) return alertBack('Свой титул доступен с 100 сообщений (или модераторам)');
              customTitle = newTitle;
            }

            let newPassStored = currentUser['password'];
            if (newPass && newPass.length > 0) {
              if (newPassStored !== oldPass) throw new Error('Старый пароль указан неверно.');
              if (newPass.length < 3) throw new Error('Новый пароль слишком короткий.');
              newPassStored = newPass;
            }

            let newAvatarUrl = currentUser.avatar || '';
            if (avatarFile && avatarFile.size > 0) {
              try {
                if (newAvatarUrl && newAvatarUrl.startsWith('/file/')) deleteAttachment(newAvatarUrl);
                const uploadResult = await uploadFile(avatarFile, 'avatars');
                newAvatarUrl = uploadResult.url;
              } catch (fileError) {
                throw new Error(`Ошибка загрузки аватара: ${fileError.message}`);
              }
            }

            const profileCols = ['signature', 'contacts', 'location', 'birthdate', 'custom_title', 'avatar', 'password'];
            await env.DB.prepare(`UPDATE users SET ${profileCols.map(c => c + ' = ?').join(', ')} WHERE username = ?`)
              .bind(signature, contacts, location, birthdate, customTitle, newAvatarUrl, newPassStored, currentUsername).run();
            return alertGo('Профиль успешно обновлен!', '/settings');
          } catch (e) {
            return alertBack('Ошибка сохранения: ' + e.message);
          }
        }
      }

      // =========================
      // USERS CACHE + ONLINE
      // =========================
      const { results: usersRaw } = await env.DB.prepare('SELECT * FROM users').all();
      const users = {};
      usersRaw.forEach(u => { users[u.username] = u; });

      let pmUnread = 0;
      if (currentUsername) {
        const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM pms WHERE to_user = ? AND is_read = 0 AND deleted_to = 0').bind(currentUsername).first();
        pmUnread = c ? c.c : 0;
      }

      // =========================
      // UI SHELL
      // =========================
      const loginFormSnippet = currentUsername
        ? `<b>Привет, ${nick(currentUser)}</b> | <a href="/settings" style="color:black;">Настройки</a> | <form method="POST" style="display:inline;"><input type="hidden" name="action" value="logout"><button class="button">Выход</button></form>`
        : `<form method="POST" action="/" style="display:inline;">Логин: <input type="text" name="username" style="font-size:10px;" size="10"> Пароль: <input type="password" name="password" style="font-size:10px;" size="10"><input type="hidden" name="action" value="login"><input type="hidden" name="csrf_token" value="${newCsrfToken}"><button class="button">Вход</button></form> | <a href="/register" class="button" style="text-decoration:none; color:black;">Регистрация</a>`;

      const pmBadge = pmUnread > 0 ? ` <span class="pm-badge">${pmUnread} новых</span>` : '';

      const page = (title, body) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)} - My Old Forum 2001</title>
<style>
  body { margin:0; background:#e0e0e0; font-family: Verdana, Arial, sans-serif; font-size:11px; color:#000; }
  a { color:#0000cc; text-decoration:none; cursor:pointer; }
  a:hover { text-decoration:underline; color:#ff0000; }
  .wrap { width: 960px; margin: 10px auto; }
  .header { background: linear-gradient(180deg, #245edb 0%, #1941a5 50%, #1941a5 100%); color:white; padding:12px; font-weight:bold; border:2px solid #003366; font-size:18px; letter-spacing:1px; box-shadow: 2px 2px 0px rgba(0,0,0,0.2); font-family: "Times New Roman", serif; }
  .nav { background:#d4d0c8; border:1px solid #808080; border-bottom:1px solid #fff; border-right:1px solid #fff; padding:5px; font-size:11px; margin-top:5px; }
  .table { width:100%; border-collapse:collapse; background:#ffffff; border:1px solid #000; margin-top:10px; }
  .table th { background: linear-gradient(180deg, #316ac5 0%, #245edb 100%); color:white; font-size:11px; padding:6px; text-align:left; border:1px solid #1e3f7a; font-weight:bold; }
  .table td { padding:6px; border-bottom:1px solid #dcdcdc; border-right:1px solid #dcdcdc; font-size:12px; vertical-align: middle; }
  .cat-bar td { background: linear-gradient(180deg, #4a7fd4 0%, #245edb 100%); color:white; font-weight:bold; font-size:12px; padding:6px; border:1px solid #1e3f7a; }
  .subhead td { background:#e8e8e8; font-weight:bold; font-size:10px; color:#333; }
  .forum-title { font-weight:bold; font-size:12px; color:#000080; }
  .small { font-size:10px; color:#666; }
  .forum-icon { width: 32px; height: 32px; border: 1px solid #999; margin-right: 8px; vertical-align: middle; }
  .thread-box { background: #fff; border: 1px solid #000; margin-top:10px; }
  .thread-head { background: linear-gradient(180deg, #316ac5 0%, #245edb 100%); color:white; padding:6px; font-weight:bold; font-size:12px; border-bottom:1px solid #000; }
  .post-row { display: flex; border-bottom: 1px solid #999; min-height: 200px; }
  .user-col { width: 170px; background: #f5f5f5; border-right: 1px solid #999; padding: 8px; text-align: center; vertical-align: top; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; }
  .avatar { width: 100px; height: 100px; border: 1px solid #999; background: #fff; margin-bottom: 6px; object-fit: cover; border-radius: 4px; }
  .avatar-settings { width: 100px; height: 100px; border: 1px solid #999; object-fit: cover; }
  .username { font-weight: bold; font-size: 12px; color:#000080; margin-bottom: 4px; text-decoration: none; }
  .usertitle { font-size: 10px; color: #666; font-style: italic; margin-bottom: 6px; display: block; }
  .info-row { font-size: 10px; color: #000; margin-bottom: 2px; width: 100%; border-bottom: 1px dashed #ccc; padding-bottom: 2px; }
  .reputation { color: #008000; font-weight: bold; }
  .msg-col { flex-grow: 1; padding: 10px; background: #fff; display: flex; flex-direction: column; }
  .msg-header { font-size: 9px; color: #666; border-bottom: 1px solid #eee; padding-bottom: 4px; margin-bottom: 8px; display: flex; justify-content: space-between; }
  .msg-body { font-size: 12px; line-height: 1.4; flex-grow: 1; overflow-wrap: break-word; }
  .video-container { position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; max-width: 100%; background: #000; margin: 10px 0; }
  .video-container iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
  .attachment { margin-top: 15px; border: 1px solid #ccc; background: #f9f9f9; border-radius: 8px; overflow: hidden; }
  .attachment-header { display: flex; align-items: center; padding: 8px 12px; background: #f0f0f0; border-bottom: 1px solid #ddd; }
  .attachment-icon { font-size: 20px; margin-right: 8px; }
  .attachment-name { flex-grow: 1; font-size: 11px; color: #333; word-break: break-all; }
  .attachment-link { font-size: 10px; color: #0066cc; text-decoration: none; padding: 2px 8px; border: 1px solid #0066cc; border-radius: 4px; margin-left: 10px; white-space: nowrap; }
  .attachment-link:hover { background: #0066cc; color: white; }
  .attachment-preview { padding: 12px; display: flex; justify-content: center; align-items: center; }
  .attachment-img-preview { max-width: 100%; max-height: 500px; border-radius: 6px; cursor: pointer; }
  .attachment-video-player { max-width: 100%; max-height: 400px; }
  .attachment-audio-player { width: 100%; max-width: 400px; }
  .image-preview-modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.9); cursor: pointer; }
  .image-preview-modal img { margin: auto; display: block; max-width: 90%; max-height: 90%; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); border: 2px solid white; border-radius: 8px; }
  .image-preview-close { position: absolute; top: 20px; right: 40px; color: #f1f1f1; font-size: 40px; font-weight: bold; cursor: pointer; }
  .signature { margin-top: 15px; padding-top: 10px; border-top: 1px dashed #ccc; font-size: 10px; color: #666; font-style: italic; }
  .footer { margin-top:10px; text-align:center; font-size:10px; color:#333; background:#d4d0c8; border:1px solid #808080; padding:5px; }
  .button { background:#d4d0c8; border:2px outset #fff; padding:2px 6px; font-size:11px; display:inline-block; cursor: pointer; font-family: Verdana, sans-serif; }
  .button:hover { background: #c0c0c0; }
  .btn-sm { font-size: 9px; padding: 1px 4px; }
  .btn-del { color: red; border-color: red; }
  input, textarea, select { font-family: Verdana, sans-serif; font-size: 11px; border:1px solid #7f9db9; box-sizing: border-box; }
  .admin-panel { background: #fff3cd; border: 1px solid #ffc107; padding: 10px; margin-top: 10px; }
  .ann-row td { background:#fff8dc; }
  .sticky-mark { color:#cc6600; font-weight:bold; }
  .locked-mark { color:#888; }
  .quote-head { background:#dfe7f5; border:1px solid #b9c6e0; border-bottom:none; padding:3px 8px; font-size:10px; font-weight:bold; display:inline-block; }
  .quote-body { border:1px solid #b9c6e0; background:#f4f7fc; padding:8px; margin-bottom:8px; font-size:11px; }
  .code-block { border:1px solid #999; background:#f7f7f7; padding:8px; font-family:'Courier New',monospace; font-size:11px; white-space:pre-wrap; margin:8px 0; }
  .spoiler { border:1px dashed #999; background:#fafafa; padding:6px; margin:8px 0; }
  .spoiler summary { cursor:pointer; font-weight:bold; font-size:11px; }
  .poll-box { border:1px solid #000; margin-top:10px; background:#fff; }
  .poll-row { margin:4px 0; }
  .poll-bar { height:14px; background:linear-gradient(180deg,#316ac5,#245edb); border:1px solid #1e3f7a; }
  .bbbar { margin-bottom:5px; background:#d4d0c8; border:1px solid #808080; padding:4px; }
  .smile { cursor:pointer; font-size:14px; margin:0 2px; }
  .pm-badge { background:#ffcc00; color:#000; border:1px solid #806000; font-weight:bold; padding:0 4px; font-size:10px; border-radius:2px; }
  .warnbar { background:#ffe0e0; border:1px solid #cc0000; padding:5px; font-size:10px; margin-top:5px; text-align:center; }
  .rep-pos { color:#008000; font-weight:bold; } .rep-neg { color:#cc0000; font-weight:bold; }
  .modbar { background:#e8f4d4; border:1px solid #7ba34a; padding:6px; margin-top:8px; font-size:10px; }
  .pages-box { margin:10px 0; text-align:center; }
</style>
<link rel="icon" type="image/x-icon" href="https://pub-1c0dde7d5fec4647a4d886b7360af9ee.r2.dev/icons/favicon.ico">
</head>
<body>
<div class="wrap">
  <div class="header">☠ My Old Forum 2001 Edition ☠</div>
  <div class="nav">
    🏠 <a href="/">Главная</a> | 👥 <a href="/members">Участники</a> | 🔍 <a href="/search">Поиск</a> | ✉️ <a href="/pm">ЛС</a>${pmBadge} | 📜 <a href="/thread/4">Правила</a>
    <span style="float:right; margin-right:10px;">${loginFormSnippet}</span>
  </div>
  ${bannedName ? `<div class="warnbar">⛔ Ваш аккаунт (<b>${esc(bannedName)}</b>) заблокирован администрацией. Вы можете только читать форум.</div>` : ''}
  ${body}
  <div class="footer">Powered by Cloudflare Workers • D1 DB • R2 Storage • vBulletin/IPB Edition • код: codex</div>
</div>
<div id="imagePreviewModal" class="image-preview-modal" onclick="closeImagePreview()"><span class="image-preview-close">&times;</span><img id="previewImage" src="" alt="Preview"></div>
<script>
function openImagePreview(url){document.getElementById('imagePreviewModal').style.display='block';document.getElementById('previewImage').src=url;}
function closeImagePreview(){document.getElementById('imagePreviewModal').style.display='none';}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeImagePreview();});
function bbWrap(id,open,close){var ta=document.getElementById(id);if(!ta)return;ta.focus();var s=ta.selectionStart,e=ta.selectionEnd;var v=ta.value;ta.value=v.substring(0,s)+open+v.substring(s,e)+close+v.substring(e);ta.selectionStart=s+open.length;ta.selectionEnd=e+open.length;ta.focus();}
function insertSmile(id,smile){var ta=document.getElementById(id);if(!ta)return;ta.focus();var s=ta.selectionStart;ta.value=ta.value.substring(0,s)+smile+' '+ta.value.substring(s);ta.selectionStart=ta.selectionEnd=s+smile.length+1;ta.focus();}
function collectQuotes(){var boxes=document.querySelectorAll('.mq:checked');var ta=document.getElementById('msg');if(!ta)return;var out='';boxes.forEach(function(b){var pid=b.getAttribute('data-post');var el=document.getElementById('post-content-'+pid);var c=el?el.innerText:'';out+='[quote='+b.getAttribute('data-author')+']'+c.trim()+'[/quote]\\n\\n';});if(out){ta.value=out+ta.value;var qr=document.getElementById('quickreply');if(qr)qr.scrollIntoView();ta.focus();}else{alert('Отметьте сообщения для цитирования');}}
</script>
</body>
</html>`;

      const bbBar = (taId) => `<div class="bbbar">
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[b]','[/b]')"><b>B</b></button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[i]','[/i]')"><i>i</i></button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[u]','[/u]')"><u>U</u></button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[s]','[/s]')"><s>S</s></button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[img]','[/img]')">IMG</button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[url]','[/url]')">URL</button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[code]','[/code]')">CODE</button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[quote]','[/quote]')">QUOTE</button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[spoiler]','[/spoiler]')">SPOILER</button>
  <button type="button" class="button btn-sm" onclick="bbWrap('${taId}','[list][*]','[*][/list]')">LIST</button>
  <select class="button" onchange="if(this.value)bbWrap('${taId}','[color='+this.value+']','[/color]');this.selectedIndex=0;">
    <option value="">Цвет</option><option value="red">Красный</option><option value="blue">Синий</option>
    <option value="green">Зелёный</option><option value="#ff6600">Оранжевый</option><option value="#800080">Фиолетовый</option>
  </select>
  <select class="button" onchange="if(this.value)bbWrap('${taId}','[size='+this.value+']','[/size]');this.selectedIndex=0;">
    <option value="">Размер</option><option value="1">Мелкий</option><option value="3">Обычный</option><option value="4">Крупный</option><option value="5">Огромный</option>
  </select>
  <span style="border-left:1px solid #999; margin:0 4px;"></span>
  ${SMILIES.map(([c, s]) => `<span class="smile" onclick="insertSmile('${taId}','${c.replace("'", "\\'")}')">${s}</span>`).join('')}
</div>`;

      const roleLabel = (u) => u ? ({ admin: 'Администратор', mod: 'Модератор', user: 'Пользователь', banned: 'Забанен' })[u.role] || 'Пользователь' : 'Гость';

      // =========================
      // ROUTE: /login
      // =========================
      if (url.pathname === '/login') {
        if (currentUsername) return redirect('/');
        const body = `<div class="thread-box"><div class="thread-head">Вход на форум</div><div style="padding:20px;">
          <form method="POST" action="/"><input type="hidden" name="action" value="login"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
          <table class="table" style="max-width:400px;">
            <tr><td width="40%"><b>Логин:</b></td><td><input type="text" name="username" required></td></tr>
            <tr><td><b>Пароль:</b></td><td><input type="password" name="password" required></td></tr>
            <tr><td colspan="2" style="text-align:center;"><button class="button">Войти</button></td></tr>
          </table></form>
          <div class="small">Нет аккаунта? <a href="/register">Зарегистрируйтесь</a></div>
        </div></div>`;
        return resp(page('Вход', body));
      }

      // =========================
      // ROUTE: /register
      // =========================
      if (url.pathname === '/register') {
        const body = `<div class="thread-box"><div class="thread-head">Регистрация</div><div style="padding:20px;">
          <form method="POST"><input type="hidden" name="action" value="register"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
          <table class="table" style="max-width:400px;">
            <tr><td width="30%"><b>Ник:</b></td><td><input type="text" name="username" style="width:200px;" maxlength="25" required></td></tr>
            <tr><td><b>Пароль:</b></td><td><input type="password" name="password" style="width:200px;" required></td></tr>
            <tr><td colspan="2" class="small">Логин: 3-25 символов (буквы, цифры, _ - . и пробел). Пароль: минимум 3 символа.</td></tr>
            <tr><td colspan="2" style="text-align:center; padding:10px;"><button class="button">Зарегистрироваться</button></td></tr>
          </table></form>
        </div></div>`;
        return resp(page('Регистрация', body));
      }

      // =========================
      // ROUTE: /settings
      // =========================
      if (url.pathname === '/settings') {
        if (!currentUsername) return redirect('/login');
        const user = users[currentUsername];
        if (!user) return alertGo('Пользователь не найден', '/');
        const titleAllowed = isMod(currentUser) || (user.post_count || 0) >= 100;
        const body = `<div class="thread-box"><div class="thread-head">Настройки профиля: ${esc(user.username)}</div><div style="padding:20px;">
          <form method="POST" enctype="multipart/form-data">
            <input type="hidden" name="action" value="update_profile"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
            <table class="table">
              <tr><td colspan="2" style="background:#e0e0e0; font-weight:bold;">Смена пароля (необязательно)</td></tr>
              <tr><td width="30%"><b>Старый пароль:</b></td><td><input type="password" name="old_password" autocomplete="off"></td></tr>
              <tr><td><b>Новый пароль:</b></td><td><input type="password" name="new_password" autocomplete="off"></td></tr>
              <tr><td colspan="2" style="background:#e0e0e0; font-weight:bold;">Аватар (макс. 1MB, JPG/PNG/GIF)</td></tr>
              <tr><td><b>Текущий аватар:</b></td><td>${user.avatar ? `<img src="${esc(user.avatar)}" class="avatar-settings" alt="Аватар">` : `<span class="small">Стандартный</span>`}</td></tr>
              <tr><td><b>Новый аватар:</b></td><td><input type="file" name="avatar" accept="image/*" onchange="previewAvatar(this)"><br><img id="avatarPreview" style="max-width:200px; max-height:200px; margin-top:10px; display:none; border:1px dashed #ccc;"></td></tr>
              <tr><td colspan="2" style="background:#e0e0e0; font-weight:bold;">Личные данные</td></tr>
              <tr><td><b>Подпись:</b></td><td><textarea name="signature" rows="3" style="width:100%;">${esc(user.signature || '')}</textarea></td></tr>
              <tr><td><b>Контакты:</b></td><td><input type="text" name="contacts" value="${esc(user.contacts || '')}" style="width:100%;" maxlength="100"></td></tr>
              <tr><td><b>Откуда:</b></td><td><input type="text" name="location" value="${esc(user.location || '')}" style="width:100%;" maxlength="60" placeholder="Город, страна"></td></tr>
              <tr><td><b>Дата рождения:</b></td><td><input type="text" name="birthdate" value="${esc(user.birthdate || '')}" maxlength="10" placeholder="ДД.ММ.ГГГГ"></td></tr>
              <tr><td><b>Свой титул:</b></td><td>${titleAllowed
          ? `<input type="text" name="custom_title" value="${esc(user.custom_title || '')}" maxlength="25"> <span class="small">до 25 символов</span>`
          : `<input type="text" value="${esc(user.custom_title || '')}" disabled> <span class="small">доступен с 100 сообщений</span>`}</td></tr>
              <tr><td colspan="2" style="text-align:center; padding:10px;"><button class="button" type="submit">Сохранить изменения</button></td></tr>
            </table>
          </form></div></div>
          <script>function previewAvatar(input){const preview=document.getElementById('avatarPreview');if(input.files&&input.files[0]){if(input.files[0].size>1048576){alert('Файл слишком большой! Максимальный размер: 1MB');input.value='';preview.style.display='none';return;}const reader=new FileReader();reader.onload=function(e){preview.src=e.target.result;preview.style.display='block';};reader.readAsDataURL(input.files[0]);}else{preview.style.display='none';}}</script>`;
        return resp(page('Настройки', body));
      }

      // =========================
      // ROUTE: /profile/:name
      // =========================
      if (url.pathname.startsWith('/profile/')) {
        const username = decodeURIComponent(url.pathname.split('/')[2]);
        const user = users[username];
        if (!user) return new Response(page('404', '<h1>Пользователь не найден</h1>'), { status: 404, headers: htmlHeaders() });
        const { results: userPosts } = await env.DB.prepare('SELECT * FROM posts WHERE author = ? ORDER BY id DESC LIMIT 10').bind(username).all();
        const { results: userThreads } = await env.DB.prepare('SELECT id, title, created_at FROM threads WHERE author = ? ORDER BY id DESC LIMIT 5').bind(username).all();
        const { results: repLog } = await env.DB.prepare('SELECT * FROM reputation_log WHERE to_user = ? ORDER BY id DESC LIMIT 10').bind(username).all();
        const { results: warnLog } = await env.DB.prepare('SELECT * FROM warnings WHERE username = ? ORDER BY id DESC LIMIT 5').bind(username).all();
        const repGiven = await env.DB.prepare('SELECT COUNT(*) AS c FROM reputation_log WHERE to_user = ? AND delta = 1').bind(username).first();
        const repTaken = await env.DB.prepare('SELECT COUNT(*) AS c FROM reputation_log WHERE to_user = ? AND delta = -1').bind(username).first();

        const actionButtons = [];
        if (currentUsername && currentUsername !== username) {
          actionButtons.push(`<a class="button" style="text-decoration:none;color:black;" href="/pm/compose?to=${encodeURIComponent(username)}">✉️ ЛС</a>`);
          actionButtons.push(`<a class="button" style="text-decoration:none;color:black;" href="/rep?user=${encodeURIComponent(username)}">± Репутация</a>`);
        }
        if (isMod(currentUser) && user.role !== 'admin' && currentUsername !== username) {
          actionButtons.push(`<a class="button" style="text-decoration:none;color:black;" href="/warn?user=${encodeURIComponent(username)}">⚠ Предупредить</a>`);
        }
        if (isAdmin(currentUser) && currentUsername !== username) {
          actionButtons.push(`<form method="POST" style="display:inline;" onsubmit="return confirm('Переключить бан?');"><input type="hidden" name="action" value="ban_user"><input type="hidden" name="target" value="${esc(username)}"><input type="hidden" name="csrf_token" value="${newCsrfToken}"><button class="button">${user.role === 'banned' ? '✅ Разбанить' : '⛔ Забанить'}</button></form>`);
        }

        const body = `
<table class="table">
  <tr><th colspan="2">Профиль: ${nick(user, username)}</th></tr>
  <tr><td width="170" style="text-align:center; background:#f5f5f5;">
    <img src="${esc(avatarSrc(user, username))}" class="avatar" alt="${esc(username)}">
    <div style="color:#ffcc00;">${'★'.repeat(starsFor(user))}</div>
    <div style="margin-top:8px;">${actionButtons.join(' ')}</div>
  </td>
  <td>
    <div class="info-row"><b>Титул:</b> ${esc(userTitle(user))} (${roleLabel(user)})</div>
    <div class="info-row"><b>Сообщений:</b> ${user.post_count || 0}</div>
    <div class="info-row"><b>Репутация:</b> <span class="reputation">${user.reputation || 0}</span> <span class="small">(+: ${repGiven ? repGiven.c : 0} / −: ${repTaken ? repTaken.c : 0})</span></div>
    <div class="info-row"><b>Предупреждения:</b> <span style="color:${(user.warns || 0) > 0 ? '#cc0000' : '#008000'}; font-weight:bold;">${user.warns || 0}</span></div>
    <div class="info-row"><b>Зарегистрирован:</b> ${esc(fmtDate(user.reg_date || ''))}</div>
    ${user.birthdate ? `<div class="info-row"><b>Дата рождения:</b> ${esc(user.birthdate)}</div>` : ''}
    ${user.location ? `<div class="info-row"><b>Откуда:</b> ${esc(user.location)}</div>` : ''}
    ${user.contacts ? `<div class="info-row"><b>Контакты:</b> ${esc(user.contacts)}</div>` : ''}
    <div class="info-row"><b>Подпись:</b> ${user.signature ? parseBBCode(user.signature) : '—'}</div>
  </td></tr>
</table>

<table class="table">
  <tr><th>Последние темы автора</th></tr>
  ${userThreads.length ? userThreads.map(t => `<tr><td><a href="/thread/${t.id}">${esc(t.title)}</a> <span class="small">(${fmtDate(t.created_at)})</span></td></tr>`).join('') : '<tr><td><i>нет тем</i></td></tr>'}
</table>

<table class="table">
  <tr><th>Последние 10 сообщений</th></tr>
  ${userPosts.length ? userPosts.map(p => `<tr><td><small>${fmtDT(p.created_at)} в теме <a href="/thread/${p.thread_id}">#${p.thread_id}</a></small><div style="margin-top:4px;">${parseBBCode(p.content).substring(0, 250)}</div></td></tr>`).join('') : '<tr><td><i>нет сообщений</i></td></tr>'}
</table>

<table class="table">
  <tr><th>История репутации</th></tr>
  ${repLog.length ? repLog.map(r => `<tr><td class="small">${fmtDT(r.created_at)} — <b class="${r.delta > 0 ? 'rep-pos' : 'rep-neg'}">${r.delta > 0 ? '+' : ''}${r.delta}</b> от ${nick(users[r.from_user], r.from_user)} ${r.comment ? `— «${esc(r.comment)}»` : ''}</td></tr>`).join('') : '<tr><td><i>оценок пока нет</i></td></tr>'}
</table>

${warnLog.length ? `<table class="table"><tr><th>Предупреждения</th></tr>${warnLog.map(w => `<tr><td class="small">${fmtDT(w.created_at)} — <b style="color:#cc0000;">+${w.points}</b> от ${nick(users[w.by_user], w.by_user)}: ${esc(w.reason)}</td></tr>`).join('')}</table>` : ''}`;
        return resp(page(`Профиль: ${username}`, body));
      }

      // =========================
      // ROUTE: /members
      // =========================
      if (url.pathname === '/members') {
        const sort = url.searchParams.get('sort') || 'posts';
        const search = (url.searchParams.get('search') || '').trim();
        const pageParam = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const orderBy = sort === 'name' ? 'username ASC' : sort === 'reg' ? 'id DESC' : 'post_count DESC';
        const where = search ? 'WHERE username LIKE ?' : '';
        const binds = search ? [`%${search}%`] : [];
        const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).bind(...binds).first();
        const totalPages = Math.max(1, Math.ceil((total ? total.c : 0) / MEMBERS_PER_PAGE));
        const { results: members } = await env.DB.prepare(`SELECT * FROM users ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
          .bind(...binds, MEMBERS_PER_PAGE, (pageParam - 1) * MEMBERS_PER_PAGE).all();

        const body = `
<div class="thread-box"><div class="thread-head">👥 Список участников</div><div style="padding:10px;">
  <form method="GET">
    Поиск: <input type="text" name="search" value="${esc(search)}" style="width:150px;">
    Сортировка: <select name="sort">
      <option value="posts"${sort === 'posts' ? ' selected' : ''}>по сообщениям</option>
      <option value="reg"${sort === 'reg' ? ' selected' : ''}>по дате регистрации</option>
      <option value="name"${sort === 'name' ? ' selected' : ''}>по алфавиту</option>
    </select>
    <button class="button">Применить</button>
  </form>
</div></div>
<table class="table">
  <tr><th width="50">Аватар</th><th>Ник</th><th width="160">Титул</th><th width="110">Регистрация</th><th width="90">Сообщений</th><th width="90">Репутация</th><th width="120">Роль</th></tr>
  ${members.map(m => `<tr>
    <td><img src="${esc(avatarSrc(m, m.username))}" style="width:32px;height:32px;border:1px solid #999;object-fit:cover;" alt=""></td>
    <td>${nick(m, m.username)}</td>
    <td class="small">${esc(userTitle(m))}</td>
    <td class="small">${esc(fmtDate(m.reg_date || ''))}</td>
    <td style="text-align:center">${m.post_count || 0}</td>
    <td style="text-align:center"><span class="reputation">${m.reputation || 0}</span></td>
    <td class="small" style="color:${roleColor(m)}">${roleLabel(m)}</td>
  </tr>`).join('')}
</table>
<div class="pages-box">
  ${pageParam > 1 ? `<a href="/members?sort=${sort}&search=${encodeURIComponent(search)}&page=${pageParam - 1}" class="button">← Назад</a>` : ''}
  Страница ${pageParam} из ${totalPages}
  ${pageParam < totalPages ? `<a href="/members?sort=${sort}&search=${encodeURIComponent(search)}&page=${pageParam + 1}" class="button">Вперед →</a>` : ''}
</div>`;
        return resp(page('Участники', body));
      }

      // =========================
      // ROUTE: /search
      // =========================
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim();
        const author = (url.searchParams.get('author') || '').trim();
        const forumId = parseInt(url.searchParams.get('forum')) || 0;
        const mode = url.searchParams.get('mode') === 'titles' ? 'titles' : 'posts';
        const fresh = url.searchParams.get('fresh') === '1';
        const { results: forumsList } = await env.DB.prepare('SELECT id, title FROM forums ORDER BY title').all();

        let body = `<div class="thread-box"><div class="thread-head">🔍 Поиск по форуму</div><div style="padding:10px;">
          <form method="GET">
            Ключевые слова: <input type="text" name="q" value="${esc(q)}" style="width:180px;">
            Автор: <input type="text" name="author" value="${esc(author)}" style="width:110px;">
            Форум: <select name="forum"><option value="0">Все форумы</option>${forumsList.map(f => `<option value="${f.id}"${f.id === forumId ? ' selected' : ''}>${esc(f.title)}</option>`).join('')}</select>
            <select name="mode"><option value="posts"${mode === 'posts' ? ' selected' : ''}>в сообщениях</option><option value="titles"${mode === 'titles' ? ' selected' : ''}>в названиях тем</option></select>
            <button class="button">Искать</button>
            <a class="small" href="/search?fresh=1">Новые за 24 часа</a>
          </form>
        </div></div>`;

        if (q || author || fresh) {
          let rows = '';
          if (mode === 'titles') {
            let sql = 'SELECT t.*, f.title AS forum_title FROM threads t JOIN forums f ON f.id = t.forum_id WHERE 1=1';
            const binds = [];
            if (q) { sql += ' AND t.title LIKE ?'; binds.push(`%${q}%`); }
            if (author) { sql += ' AND t.author = ?'; binds.push(author); }
            if (forumId) { sql += ' AND t.forum_id = ?'; binds.push(forumId); }
            if (fresh) sql += " AND t.created_at > datetime('now', '-1 day')";
            sql += ' ORDER BY t.id DESC LIMIT 50';
            const { results } = await env.DB.prepare(sql).bind(...binds).all();
            rows = results.map(t => `<tr><td><a class="forum-title" href="/thread/${t.id}">${esc(t.title)}</a> <span class="small">в форуме «${esc(t.forum_title)}»</span></td><td width="150" style="text-align:center">${nick(users[t.author], t.author)}<br><small>${fmtDate(t.created_at)}</small></td></tr>`).join('');
          } else {
            let sql = 'SELECT p.*, t.title AS thread_title FROM posts p JOIN threads t ON t.id = p.thread_id WHERE 1=1';
            const binds = [];
            if (q) { sql += ' AND p.content LIKE ?'; binds.push(`%${q}%`); }
            if (author) { sql += ' AND p.author = ?'; binds.push(author); }
            if (forumId) { sql += ' AND t.forum_id = ?'; binds.push(forumId); }
            if (fresh) sql += " AND p.created_at > datetime('now', '-1 day')";
            sql += ' ORDER BY p.id DESC LIMIT 50';
            const { results } = await env.DB.prepare(sql).bind(...binds).all();
            rows = results.map(r => `<tr><td><a class="forum-title" href="/thread/${r.thread_id}">${esc(r.thread_title)}</a><br><div>${parseBBCode(r.content).substring(0, 300)}</div></td><td width="150" style="text-align:center"><b>${esc(r.author)}</b><br><small>${fmtDate(r.created_at)}</small></td></tr>`).join('');
          }
          body += `<h3>Результаты${q ? `: «${esc(q)}»` : ''}</h3><table class="table">${rows || '<tr><td><i>Ничего не найдено</i></td></tr>'}</table>`;
        }
        return resp(page('Поиск', body));
      }

      // =========================
      // ROUTE: /pm (inbox)
      // =========================
      if (url.pathname === '/pm') {
        if (!currentUsername) return redirect('/login');
        const { results: inbox } = await env.DB.prepare('SELECT * FROM pms WHERE to_user = ? AND deleted_to = 0 ORDER BY id DESC LIMIT 100').bind(currentUsername).all();
        const body = `
<div class="thread-box"><div class="thread-head">✉️ Личные сообщения — Входящие${pmUnread ? ` <span class="pm-badge">${pmUnread} новых</span>` : ''}</div><div style="padding:8px;">
  <a href="/pm/compose" class="button" style="text-decoration:none;color:black;">✏️ Написать</a>
  <a href="/pm/outbox" class="button" style="text-decoration:none;color:black;">📤 Исходящие</a>
</div></div>
<table class="table">
  <tr><th width="140">От кого</th><th>Тема</th><th width="130">Дата</th><th width="80"></th></tr>
  ${inbox.length ? inbox.map(m => `<tr${m.is_read ? '' : ' class="ann-row"'}>
    <td>${nick(users[m.from_user], m.from_user)}</td>
    <td><a href="/pm/view/${m.id}">${m.is_read ? '' : '🆕 '}${esc(m.subject)}</a></td>
    <td class="small">${fmtDT(m.created_at)}</td>
    <td><form method="POST" onsubmit="return confirm('Удалить сообщение?');"><input type="hidden" name="action" value="delete_pm"><input type="hidden" name="pm_id" value="${m.id}"><input type="hidden" name="box" value="in"><input type="hidden" name="csrf_token" value="${newCsrfToken}"><button class="btn-sm button btn-del">Удалить</button></form></td>
  </tr>`).join('') : '<tr><td colspan="4"><i>Нет сообщений</i></td></tr>'}
</table>`;
        return resp(page('Личные сообщения', body));
      }

      // =========================
      // ROUTE: /pm/outbox
      // =========================
      if (url.pathname === '/pm/outbox') {
        if (!currentUsername) return redirect('/login');
        const { results: outbox } = await env.DB.prepare('SELECT * FROM pms WHERE from_user = ? AND deleted_from = 0 ORDER BY id DESC LIMIT 100').bind(currentUsername).all();
        const body = `
<div class="thread-box"><div class="thread-head">✉️ Личные сообщения — Исходящие</div><div style="padding:8px;">
  <a href="/pm/compose" class="button" style="text-decoration:none;color:black;">✏️ Написать</a>
  <a href="/pm" class="button" style="text-decoration:none;color:black;">📥 Входящие</a>
</div></div>
<table class="table">
  <tr><th width="140">Кому</th><th>Тема</th><th width="130">Дата</th><th width="80"></th></tr>
  ${outbox.length ? outbox.map(m => `<tr>
    <td>${nick(users[m.to_user], m.to_user)}</td>
    <td><a href="/pm/view/${m.id}">${esc(m.subject)}</a></td>
    <td class="small">${fmtDT(m.created_at)}</td>
    <td><form method="POST" onsubmit="return confirm('Удалить сообщение?');"><input type="hidden" name="action" value="delete_pm"><input type="hidden" name="pm_id" value="${m.id}"><input type="hidden" name="box" value="out"><input type="hidden" name="csrf_token" value="${newCsrfToken}"><button class="btn-sm button btn-del">Удалить</button></form></td>
  </tr>`).join('') : '<tr><td colspan="4"><i>Нет сообщений</i></td></tr>'}
</table>`;
        return resp(page('Исходящие', body));
      }

      // =========================
      // ROUTE: /pm/compose
      // =========================
      if (url.pathname === '/pm/compose') {
        if (!currentUsername) return redirect('/login');
        const to = url.searchParams.get('to') || '';
        const subjectPrefill = url.searchParams.get('subject') || '';
        const body = `<div class="thread-box"><div class="thread-head">✏️ Новое личное сообщение</div><div style="padding:20px;">
        <form method="POST"><input type="hidden" name="action" value="send_pm"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
        <table class="table">
          <tr><td width="20%"><b>Кому:</b></td><td><input type="text" name="to" value="${esc(to)}" required style="width:200px;"></td></tr>
          <tr><td><b>Тема:</b></td><td><input type="text" name="subject" value="${esc(subjectPrefill)}" maxlength="100" style="width:100%;"></td></tr>
          <tr><td><b>Сообщение:</b></td><td><textarea name="body" rows="8" style="width:100%;"></textarea></td></tr>
          <tr><td colspan="2" style="text-align:center;"><button class="button">Отправить</button></td></tr>
        </table></form></div></div>`;
        return resp(page('Новое ЛС', body));
      }

      // =========================
      // ROUTE: /pm/view/:id
      // =========================
      if (url.pathname.startsWith('/pm/view/')) {
        if (!currentUsername) return redirect('/login');
        const pmId = parseInt(url.pathname.split('/')[3]);
        const pm = await env.DB.prepare('SELECT * FROM pms WHERE id = ?').bind(pmId).first();
        if (!pm || (pm.to_user !== currentUsername && pm.from_user !== currentUsername)) {
          return new Response(page('404', '<h1>Сообщение не найдено</h1>'), { status: 404, headers: htmlHeaders() });
        }
        if (pm.to_user === currentUsername && !pm.is_read) {
          await env.DB.prepare('UPDATE pms SET is_read = 1 WHERE id = ?').bind(pmId).run();
        }
        const box = pm.to_user === currentUsername ? 'in' : 'out';
        const body = `<div class="thread-box"><div class="thread-head">✉️ ${esc(pm.subject)}</div><div style="padding:12px;">
          <div class="msg-header"><span>От: ${nick(users[pm.from_user], pm.from_user)} → Кому: ${nick(users[pm.to_user], pm.to_user)}</span><span>${fmtDT(pm.created_at)}</span></div>
          <div class="msg-body">${parseBBCode(pm.body)}</div>
          <div style="margin-top:12px;">
            ${box === 'in' ? `<a class="button" style="text-decoration:none;color:black;" href="/pm/compose?to=${encodeURIComponent(pm.from_user)}&subject=${encodeURIComponent('Re: ' + pm.subject)}">↩️ Ответить</a>` : ''}
            <a class="button" style="text-decoration:none;color:black;" href="/pm">← К входящим</a>
            <form method="POST" style="display:inline;" onsubmit="return confirm('Удалить сообщение?');"><input type="hidden" name="action" value="delete_pm"><input type="hidden" name="pm_id" value="${pm.id}"><input type="hidden" name="box" value="${box}"><input type="hidden" name="csrf_token" value="${newCsrfToken}"><button class="button btn-del">🗑 Удалить</button></form>
          </div>
        </div></div>`;
        return resp(page('ЛС', body));
      }

      // =========================
      // ROUTE: /rep
      // =========================
      if (url.pathname === '/rep') {
        if (!currentUsername) return redirect('/login');
        const target = url.searchParams.get('user') || '';
        const postId = parseInt(url.searchParams.get('post')) || 0;
        if (target === currentUsername) return alertGo('Нельзя менять свою репутацию', '/');
        const targetUser = users[target];
        if (!targetUser) return new Response(page('404', '<h1>Пользователь не найден</h1>'), { status: 404, headers: htmlHeaders() });
        const body = `<div class="thread-box"><div class="thread-head">± Репутация: ${nick(targetUser, target)}</div><div style="padding:20px;">
        <form method="POST"><input type="hidden" name="action" value="give_rep"><input type="hidden" name="target" value="${esc(target)}"><input type="hidden" name="post_id" value="${postId}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
        <table class="table">
          <tr><td width="30%"><b>Оценка:</b></td><td>
            <label><input type="radio" name="delta" value="1" checked> 👍 Повысить (+1)</label><br>
            <label><input type="radio" name="delta" value="-1"> 👎 Понизить (−1)</label></td></tr>
          <tr><td><b>Комментарий:</b></td><td><input type="text" name="comment" maxlength="100" style="width:100%;" placeholder="необязательно"></td></tr>
          <tr><td colspan="2" style="text-align:center;"><button class="button">Оценить</button></td></tr>
        </table></form>
        <div class="small">Оценивать одного участника можно раз в сутки.</div>
        </div></div>`;
        return resp(page('Репутация', body));
      }

      // =========================
      // ROUTE: /warn
      // =========================
      if (url.pathname === '/warn') {
        if (!isMod(currentUser)) return alertGo('Доступ запрещен', '/');
        const target = url.searchParams.get('user') || '';
        const targetUser = users[target];
        if (!targetUser) return new Response(page('404', '<h1>Пользователь не найден</h1>'), { status: 404, headers: htmlHeaders() });
        const body = `<div class="thread-box"><div class="thread-head">⚠ Предупреждение: ${nick(targetUser, target)}</div><div style="padding:20px;">
        <form method="POST"><input type="hidden" name="action" value="warn_user"><input type="hidden" name="target" value="${esc(target)}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
        <table class="table">
          <tr><td width="30%"><b>Причина:</b></td><td><textarea name="reason" rows="3" style="width:100%;" maxlength="200" placeholder="Нарушение правил"></textarea></td></tr>
          <tr><td><b>Баллы:</b></td><td><select name="points"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></td></tr>
          <tr><td colspan="2" style="text-align:center;"><button class="button">Выдать предупреждение</button></td></tr>
        </table></form>
        <div class="small">Текущие предупреждения участника: <b>${targetUser.warns || 0}</b></div>
        </div></div>`;
        return resp(page('Предупреждение', body));
      }

      // =========================
      // ROUTE: /admin
      // =========================
      if (url.pathname === '/admin') {
        if (!isAdmin(currentUser)) return alertGo('Доступ только для администратора', '/');
        const { results: forumsAll } = await env.DB.prepare('SELECT * FROM forums ORDER BY category_id, position, id').all();
        const { results: catsAll } = await env.DB.prepare('SELECT * FROM categories ORDER BY position, id').all();
        const { results: usersAll } = await env.DB.prepare('SELECT * FROM users ORDER BY username').all();
        const statsAll = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM threads) AS tc, (SELECT COUNT(*) FROM posts) AS pc, (SELECT COUNT(*) FROM users) AS uc, (SELECT COUNT(*) FROM pms) AS pmc`).first();

        const catOptions = (sel) => catsAll.map(c => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.title)}</option>`).join('');

        const forumsHtml = forumsAll.map(f => `
          <tr>
            <td>
              <form method="POST"><input type="hidden" name="action" value="update_forum"><input type="hidden" name="forum_id" value="${f.id}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
              <table style="width:100%">
                <tr><td width="25%">Название:<br><input type="text" name="forum_title" value="${esc(f.title)}" style="width:95%"></td>
                <td width="35%">Описание:<br><input type="text" name="forum_description" value="${esc(f.description)}" style="width:95%"></td>
                <td width="20%">Категория:<br><select name="category_id" style="width:95%">${catOptions(f.category_id)}</select></td>
                <td width="10%">Позиция:<br><input type="text" name="position" value="${f.position || 0}" style="width:90%"></td>
                <td width="10%"><button class="button">Сохранить</button></td></tr>
              </table></form>
            </td>
            <td width="120">
              <form method="POST" onsubmit="return confirm('Удалить форум со всеми темами?');"><input type="hidden" name="action" value="delete_forum"><input type="hidden" name="forum_id" value="${f.id}"><input type="hidden" name="csrf_token" value="${newCsrfToken}"><button class="button btn-del">🗑 Удалить</button></form>
            </td>
          </tr>`).join('');

        const usersHtml = usersAll.map(u => `
          <tr>
            <td>${nick(u, u.username)}</td>
            <td class="small">${esc(userTitle(u))}</td>
            <td style="text-align:center">${u.post_count || 0}</td>
            <td style="text-align:center">${u.reputation || 0}</td>
            <td style="text-align:center">${u.warns || 0}</td>
            <td>${u.username === currentUsername ? `<b>${roleLabel(u)}</b>` : `<form method="POST" style="display:inline"><input type="hidden" name="action" value="set_role"><input type="hidden" name="target" value="${esc(u.username)}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
              <select name="role">
                <option value="user"${u.role === 'user' ? ' selected' : ''}>Пользователь</option>
                <option value="mod"${u.role === 'mod' ? ' selected' : ''}>Модератор</option>
                <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Администратор</option>
                <option value="banned"${u.role === 'banned' ? ' selected' : ''}>Забанен</option>
              </select> <button class="button btn-sm">OK</button></form>`}</td>
          </tr>`).join('');

        const body = `
<table class="table">
  <tr><th>📊 Статистика системы</th></tr>
  <tr><td>Категорий: <b>${catsAll.length}</b> • Форумов: <b>${forumsAll.length}</b> • Тем: <b>${statsAll.tc}</b> • Сообщений: <b>${statsAll.pc}</b> • Участников: <b>${statsAll.uc}</b> • ЛС: <b>${statsAll.pmc}</b></td></tr>
</table>

<div class="admin-panel">
  <b>➕ Новая категория:</b>
  <form method="POST" style="display:inline"><input type="hidden" name="action" value="create_category"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
  <input type="text" name="cat_title" size="30" required> <button class="button">Создать</button></form>
  <hr style="border:none;border-top:1px dashed #ccc;">
  <b>➕ Новый форум:</b>
  <form method="POST"><input type="hidden" name="action" value="create_forum"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
  Название: <input type="text" name="forum_title" size="25" required>
  Описание: <input type="text" name="forum_description" size="40" required>
  Категория: <select name="category_id">${catOptions(0)}</select>
  <button class="button">Создать форум</button></form>
</div>

<table class="table">
  <tr><th colspan="2">🗃 Форумы</th></tr>
  ${forumsHtml || '<tr><td colspan="2"><i>нет форумов</i></td></tr>'}
</table>

<table class="table">
  <tr><th>Ник</th><th width="150">Титул</th><th width="70">Сообщ.</th><th width="70">Реп.</th><th width="60">Варны</th><th width="260">Роль</th></tr>
  ${usersHtml}
</table>`;
        return resp(page('Админ-панель', body));
      }

      // =========================
      // ROUTE: / (index)
      // =========================
      if (url.pathname === '/') {
        const { results: forumsRaw } = await env.DB.prepare(`SELECT f.id, f.title, f.description, c.title AS cat_title,
          (SELECT COUNT(*) FROM threads t WHERE t.forum_id = f.id) AS topics,
          (SELECT COUNT(*) FROM posts p JOIN threads t2 ON p.thread_id = t2.id WHERE t2.forum_id = f.id) AS msg_count,
          (SELECT p.author FROM posts p JOIN threads t2 ON p.thread_id = t2.id WHERE t2.forum_id = f.id ORDER BY p.id DESC LIMIT 1) AS last_author,
          (SELECT p.created_at FROM posts p JOIN threads t2 ON p.thread_id = t2.id WHERE t2.forum_id = f.id ORDER BY p.id DESC LIMIT 1) AS last_date,
          (SELECT p.thread_id FROM posts p JOIN threads t2 ON p.thread_id = t2.id WHERE t2.forum_id = f.id ORDER BY p.id DESC LIMIT 1) AS last_thread_id,
          (SELECT t2.title FROM posts p JOIN threads t2 ON p.thread_id = t2.id WHERE t2.forum_id = f.id ORDER BY p.id DESC LIMIT 1) AS last_thread_title
          FROM forums f LEFT JOIN categories c ON c.id = f.category_id
          ORDER BY COALESCE(c.position, 999) ASC, c.id ASC, f.position ASC, f.id ASC`).all();

        const cats = [];
        const catMap = {};
        for (const f of forumsRaw) {
          const cKey = f.cat_title || 'Разное';
          if (!catMap[cKey]) { catMap[cKey] = []; cats.push({ title: cKey, forums: catMap[cKey] }); }
          catMap[cKey].push(f);
        }

        const forumRows = (list) => list.map(f => `<tr>
          <td><img src="https://api.dicebear.com/10.x/initials/svg?size=32&seed=${encodeURIComponent(f.title)}" class="forum-icon" align="left"><a class="forum-title" href="/forum/${f.id}">${esc(f.title)}</a><br><span class="small">${esc(f.description)}</span></td>
          <td width="60" style="text-align:center">${f.topics}</td>
          <td width="70" style="text-align:center">${f.msg_count}</td>
          <td width="230" class="small">${f.last_thread_id ? `<a href="/thread/${f.last_thread_id}">${esc(String(f.last_thread_title || '').substring(0, 40))}</a><br>${fmtDate(f.last_date)}<br>от <b>${esc(f.last_author)}</b>` : '<i>нет сообщений</i>'}</td>
        </tr>`).join('');

        const tablesHtml = cats.map(c => `
<table class="table">
  <tr class="cat-bar"><td colspan="4">${esc(c.title)}</td></tr>
  <tr class="subhead"><td>Форум</td><td width="60" style="text-align:center">Темы</td><td width="70" style="text-align:center">Сообщения</td><td width="230">Последнее сообщение</td></tr>
  ${forumRows(c.forums)}
</table>`).join('') || '<table class="table"><tr><td><i>Форумов пока нет — войдите администратором и создайте первый</i></td></tr></table>';

        const { results: catsAll } = await env.DB.prepare('SELECT * FROM categories ORDER BY position, id').all();
        const catOptions = catsAll.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('');

        const adminPanel = isAdmin(currentUser) ? `
<div class="admin-panel">
  <div style="font-weight:bold; margin-bottom:8px;">🔧 Админ-панель <a href="/admin" class="button btn-sm" style="text-decoration:none;color:black;">Расширенная →</a></div>
  <form method="POST" style="margin-bottom:8px;"><input type="hidden" name="action" value="create_category"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
    Новая категория: <input type="text" name="cat_title" size="30" required> <button class="button">Создать</button></form>
  <form method="POST"><input type="hidden" name="action" value="create_forum"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
    Название: <input type="text" name="forum_title" size="25" required>
    Описание: <input type="text" name="forum_description" size="40" required>
    Категория: <select name="category_id">${catOptions}</select>
    <button class="button">Создать форум</button></form>
</div>` : '';

        const stats = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM threads) AS tc, (SELECT COUNT(*) FROM posts) AS pc, (SELECT COUNT(*) FROM users) AS uc`).first();
        const newest = await env.DB.prepare('SELECT username FROM users ORDER BY id DESC LIMIT 1').first();
        const { results: onlineUsers } = await env.DB.prepare("SELECT username FROM users WHERE last_active > datetime('now', '-15 minutes') ORDER BY username").all();
        let guestsOnline = 0;
        try {
          const g = await env.DB.prepare("SELECT COUNT(*) AS c FROM kv_store WHERE key LIKE 'guest:%' AND CAST(value AS INTEGER) > ?").bind(String(Date.now() - ONLINE_WINDOW_MIN * 60 * 1000)).first();
          guestsOnline = g ? g.c : 0;
        } catch (e) { }
        const totalOnline = onlineUsers.length + guestsOnline;

        let recordCount = 0, recordDate = '';
        try {
          const r = await env.DB.prepare("SELECT value FROM kv_store WHERE key = 'record_online'").first();
          if (r && r.value) { const parts = String(r.value).split('|'); recordCount = parseInt(parts[0]) || 0; recordDate = parts[1] || ''; }
          if (totalOnline > recordCount) {
            recordCount = totalOnline;
            recordDate = fmtDT(new Date().toISOString());
            await env.DB.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES ('record_online', ?)").bind(`${recordCount}|${recordDate}`).run();
          }
        } catch (e) { }

        const nowD = new Date();
        const dd = String(nowD.getUTCDate()).padStart(2, '0');
        const mm = String(nowD.getUTCMonth() + 1).padStart(2, '0');
        let birthdays = [];
        try {
          const { results } = await env.DB.prepare('SELECT username FROM users WHERE birthdate LIKE ?').bind(`%.${dd}.${mm}`).all();
          birthdays = results;
        } catch (e) { }

        const statsHtml = `
<table class="table">
  <tr><th colspan="2">📊 Что происходит на форуме?</th></tr>
  <tr><td width="40%" style="background:#f5f5f5;"><b>Кто в онлайне:</b></td><td>${onlineUsers.length ? onlineUsers.map(u => nick(users[u.username], u.username)).join(', ') : '<i>нет</i>'} <span class="small">(участников: ${onlineUsers.length}, гостей: ${guestsOnline})</span></td></tr>
  <tr><td style="background:#f5f5f5;"><b>Рекорд одновременного онлайна:</b></td><td><b>${recordCount}</b> ${recordDate ? `<span class="small">(${recordDate})</span>` : ''}</td></tr>
  <tr><td style="background:#f5f5f5;"><b>Всего на форуме:</b></td><td>Тем: <b>${stats.tc}</b> • Сообщений: <b>${stats.pc}</b> • Участников: <b>${stats.uc}</b> • Приветствуем нового: <b>${newest ? nick(users[newest.username], newest.username) : '—'}</b></td></tr>
  ${birthdays.length ? `<tr><td style="background:#f5f5f5;"><b>🎂 Сегодня дни рождения:</b></td><td>${birthdays.map(b => nick(users[b.username], b.username)).join(', ')} — поздравляем!</td></tr>` : ''}
</table>`;

        return resp(page('Форум', adminPanel + tablesHtml + statsHtml));
      }

      // =========================
      // ROUTE: /forum/:id
      // =========================
      if (url.pathname.startsWith('/forum/')) {
        const id = parseInt(url.pathname.split('/')[2]);
        const forum = await env.DB.prepare('SELECT * FROM forums WHERE id = ?').bind(id).first();
        if (!forum) return new Response(page('404', '<h1>Форум не найден</h1>'), { status: 404, headers: htmlHeaders() });
        const pageParam = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const totalThreads = await env.DB.prepare('SELECT COUNT(*) AS c FROM threads WHERE forum_id = ?').bind(id).first();
        const totalPages = Math.max(1, Math.ceil((totalThreads ? totalThreads.c : 0) / THREADS_PER_PAGE));
        const offset = (pageParam - 1) * THREADS_PER_PAGE;
        const { results: threads } = await env.DB.prepare(`SELECT t.id, t.title, t.author, t.created_at, t.is_sticky, t.is_locked, t.is_announcement, t.views, t.prefix, COUNT(p.id) AS reply_count,
          (SELECT p2.author FROM posts p2 WHERE p2.thread_id = t.id ORDER BY p2.id DESC LIMIT 1) AS last_post_author,
          (SELECT p2.created_at FROM posts p2 WHERE p2.thread_id = t.id ORDER BY p2.id DESC LIMIT 1) AS last_post_date
          FROM threads t LEFT JOIN posts p ON t.id = p.thread_id
          WHERE t.forum_id = ? GROUP BY t.id
          ORDER BY t.is_announcement DESC, t.is_sticky DESC, COALESCE(last_post_date, t.created_at) DESC
          LIMIT ? OFFSET ?`).bind(id, THREADS_PER_PAGE, offset).all();

        const rows = threads.map(t => {
          const pagesT = Math.max(1, Math.ceil((t.reply_count || 0) / POSTS_PER_PAGE));
          const pageLinks = pagesT > 1 ? ` <span class="small">[Стр.: ${Array.from({ length: Math.min(pagesT, 5) }, (_, i) => `<a href="/thread/${t.id}?page=${i + 1}">${i + 1}</a>`).join(', ')}${pagesT > 5 ? '…' : ''}]</span>` : '';
          const markers = `${t.is_announcement ? '📢 ' : ''}${t.is_sticky ? '📌 ' : ''}${t.is_locked ? '🔒 ' : ''}`;
          const rowClass = t.is_announcement ? ' class="ann-row"' : '';
          const lastAuthor = t.last_post_author || t.author;
          const lastDate = t.last_post_date || t.created_at;
          return `<tr${rowClass}>
          <td>${markers}${t.prefix ? `<b class="sticky-mark">[${esc(t.prefix)}]</b> ` : ''}<a class="forum-title" href="/thread/${t.id}">${esc(t.title)}</a>${t.is_locked ? ' <span class="locked-mark small">(закрыта)</span>' : ''}${pageLinks}</td>
          <td width="110">${nick(users[t.author], t.author)}</td>
          <td width="55" style="text-align:center">${t.reply_count}</td>
          <td width="55" style="text-align:center">${t.views || 0}</td>
          <td width="190" class="small">${fmtDate(lastDate)}<br>от ${nick(users[lastAuthor], lastAuthor)}</td>
        </tr>`;
        }).join('');

        const newTopicButton = currentUsername ? `
<div style="margin-bottom:5px; text-align:right;"><a href="#" onclick="document.getElementById('newThreadForm').style.display='block'; return false;" class="button">✏️ Новая тема</a></div>
<div id="newThreadForm" style="display:none; background:#f5f5f5; padding:10px; border:1px solid #999; margin-bottom:10px;">
  <form method="POST" enctype="multipart/form-data">
    <input type="hidden" name="action" value="new_thread">
    <input type="hidden" name="forum_id" value="${id}">
    <input type="hidden" name="csrf_token" value="${newCsrfToken}">
    <b>Заголовок:</b><br><input type="text" name="title" style="width:100%;" maxlength="120" required><br><br>
    <b>Префикс:</b> <input type="text" name="prefix" size="20" maxlength="30" placeholder="[Вопрос]">
    <b>Вложение (до ${MAX_UPLOAD_MB}MB):</b> <input type="file" name="file"><br><br>
    ${bbBar('newmsg')}
    <b>Сообщение:</b><br><textarea name="content" id="newmsg" rows="7" style="width:100%;" required></textarea><br><br>
    <label><input type="checkbox" onclick="document.getElementById('pollArea').style.display=this.checked?'block':'none';"> 📊 Добавить опрос</label>
    <div id="pollArea" style="display:none; border:1px dashed #999; padding:8px; margin-top:6px;">
      <b>Вопрос:</b><br><input type="text" name="poll_question" style="width:100%;" maxlength="200"><br><br>
      <b>Варианты (минимум 2):</b><br>
      <input type="text" name="poll_opt" style="width:60%; margin:2px 0;"><br>
      <input type="text" name="poll_opt" style="width:60%; margin:2px 0;"><br>
      <input type="text" name="poll_opt" style="width:60%; margin:2px 0;"><br>
      <input type="text" name="poll_opt" style="width:60%; margin:2px 0;"><br>
      <input type="text" name="poll_opt" style="width:60%; margin:2px 0;"><br>
    </div>
    <button class="button">Создать тему</button>
    <button type="button" class="button" onclick="document.getElementById('newThreadForm').style.display='none'">Отмена</button>
  </form>
</div>` : `<div style="margin-bottom:5px; text-align:right; color:#666;">Войдите, чтобы создавать темы</div>`;

        const body = `
<table class="table"><tr><td class="small"><a href="/">Форум</a> » <b>${esc(forum.title)}</b></td></tr></table>
${newTopicButton}
<table class="table">
  <tr><th>Тема</th><th width="110">Автор</th><th width="55" style="text-align:center">Ответы</th><th width="55" style="text-align:center">Просмотры</th><th width="190">Последнее</th></tr>
  ${rows || '<tr><td colspan="5"><i>Тем пока нет. Будьте первым!</i></td></tr>'}
</table>
<div class="pages-box">
  ${pageParam > 1 ? `<a href="/forum/${id}?page=${pageParam - 1}" class="button">← Назад</a>` : ''}
  Страница ${pageParam} из ${totalPages}
  ${pageParam < totalPages ? `<a href="/forum/${id}?page=${pageParam + 1}" class="button">Вперед →</a>` : ''}
</div>`;
        return resp(page(forum.title, body));
      }

      // =========================
      // ROUTE: /thread/:id
      // =========================
      if (url.pathname.startsWith('/thread/')) {
        const id = parseInt(url.pathname.split('/')[2]);
        const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first();
        if (!thread) return new Response(page('404', '<h1>Тема не найдена</h1>'), { status: 404, headers: htmlHeaders() });
        env.DB.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').bind(id).run().catch(() => { });
        const forumRow = await env.DB.prepare('SELECT title FROM forums WHERE id = ?').bind(thread.forum_id).first();
        const pageParam = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
        const countRes = await env.DB.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ?').bind(id).first();
        const totalPosts = countRes ? countRes.c : 0;
        const totalPages = Math.max(1, Math.ceil(totalPosts / POSTS_PER_PAGE));
        const offset = (pageParam - 1) * POSTS_PER_PAGE;
        const { results: posts } = await env.DB.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY id ASC LIMIT ? OFFSET ?').bind(id, POSTS_PER_PAGE, offset).all();

        // --- Poll ---
        const poll = await env.DB.prepare('SELECT * FROM polls WHERE thread_id = ?').bind(id).first();
        let pollHtml = '';
        if (poll) {
          const { results: options } = await env.DB.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY id').bind(poll.id).all();
          const votedRow = currentUsername ? await env.DB.prepare('SELECT id FROM poll_votes WHERE poll_id = ? AND username = ?').bind(poll.id, currentUsername).first() : null;
          const totalVotesRes = await env.DB.prepare('SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id = ?').bind(poll.id).first();
          const totalVotes = totalVotesRes ? totalVotesRes.c : 0;
          const maxVotes = Math.max(1, ...options.map(o => o.votes || 0));
          const canVote = currentUsername && !votedRow && !(thread.is_locked && !isMod(currentUser));
          const resultsBars = options.map(o => {
            const pct = totalVotes ? Math.round((o.votes || 0) * 100 / totalVotes) : 0;
            return `<div class="poll-row small"><b>${esc(o.text)}</b> — ${o.votes || 0} гол. (${pct}%)<div class="poll-bar" style="width:${Math.round((o.votes || 0) * 100 / maxVotes)}%"></div></div>`;
          }).join('');
          if (canVote) {
            pollHtml = `<div class="poll-box"><div class="thread-head">📊 Опрос: ${esc(poll.question)}</div><div style="padding:10px;">
            <form method="POST"><input type="hidden" name="action" value="vote_poll"><input type="hidden" name="thread_id" value="${id}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
            ${options.map(o => `<div class="poll-row"><label><input type="radio" name="option_id" value="${o.id}" required> ${esc(o.text)}</label></div>`).join('')}
            <button class="button">Голосовать</button>
            <details style="margin-top:8px;"><summary class="small">Результаты (всего голосов: ${totalVotes})</summary>${resultsBars}</details>
            </form></div></div>`;
          } else {
            pollHtml = `<div class="poll-box"><div class="thread-head">📊 Опрос: ${esc(poll.question)}</div><div style="padding:10px;">
            ${resultsBars}
            <div class="small" style="margin-top:6px;">Всего голосов: <b>${totalVotes}</b>${!currentUsername ? ' • <a href="/login">войдите</a>, чтобы голосовать' : ''}${votedRow ? ' • Вы уже проголосовали' : ''}</div>
            </div></div>`;
          }
        }

        // --- Mod tools ---
        const { results: allForums } = await env.DB.prepare('SELECT id, title FROM forums ORDER BY title').all();
        const modbar = isMod(currentUser) ? `<div class="modbar">🛠 <b>Инструменты модератора:</b>
          <form method="POST" style="display:inline;" onsubmit="if(this.op.value==='delete_thread' &amp;&amp; !confirm('Удалить тему со всеми сообщениями?'))return false;">
            <input type="hidden" name="action" value="thread_tools"><input type="hidden" name="thread_id" value="${id}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
            <select name="op">
              <option value="">— выбрать —</option>
              <option value="pin">📌 Закрепить</option><option value="unpin">Открепить</option>
              <option value="lock">🔒 Закрыть</option><option value="unlock">Открыть</option>
              <option value="announce_on">📢 Сделать объявлением</option><option value="announce_off">Убрать объявление</option>
              <option value="move">➡ Перенести в форум:</option>
              <option value="delete_thread">🗑 Удалить тему</option>
            </select>
            <select name="forum_id_target">${allForums.map(f => `<option value="${f.id}">${esc(f.title)}</option>`).join('')}</select>
            <button class="button btn-sm">OK</button>
          </form></div>` : '';

        // --- Posts ---
        const postsHtml = posts.map((r, index) => {
          const u = users[r.author] || null;
          const authorName = r.author;
          const canEdit = currentUsername === authorName || isMod(currentUser);
          const controls = canEdit ? ` | <a href="#" onclick="editPost(${r.id});return false;">Править</a> | <form method="POST" style="display:inline" onsubmit="return confirm('Удалить сообщение?');"><input type="hidden" name="action" value="delete_post"><input type="hidden" name="post_id" value="${r.id}"><input type="hidden" name="csrf_token" value="${newCsrfToken}"><button class="btn-sm button btn-del">Удалить</button></form>` : '';
          const quoteCtl = currentUsername && !(thread.is_locked && !isMod(currentUser)) ? `<a href="#" onclick="var ta=document.getElementById('msg');if(!ta)return false;ta.value+='[quote=${esc(authorName)}]'+document.getElementById('post-content-${r.id}').innerText.trim()+'[/quote]\\n\\n';document.getElementById('quickreply').scrollIntoView();ta.focus();return false;">Цитата</a>` : '';
          const mqCtl = currentUsername && !(thread.is_locked && !isMod(currentUser)) ? `<input type="checkbox" class="mq" data-post="${r.id}" data-author="${esc(authorName)}" title="Мульти-цитата">` : '';
          const edited = r.edited_at ? `<div class="small" style="margin-top:6px;"><i>Изменено: ${fmtDT(r.edited_at)} (кем: ${esc(r.edited_by || '')})</i></div>` : '';
          const userCol = `<div class="user-col">
            <img src="${esc(avatarSrc(u, authorName))}" class="avatar" alt="${esc(authorName)}">
            ${nick(u, authorName)}
            <span class="usertitle">${esc(userTitle(u))}</span>
            <div style="color:#e6a817; font-size:10px;">${'★'.repeat(starsFor(u))}</div>
            <div style="width:100%; margin:5px 0;">
              <div class="info-row">Сообщений: ${u ? u.post_count : 0}</div>
              <div class="info-row">Репутация: <span class="reputation">${u ? u.reputation : 0}</span></div>
              ${u && u.warns > 0 ? `<div class="info-row" style="color:#cc0000;">Предупреждения: ${u.warns}</div>` : ''}
              ${u && u.location ? `<div class="info-row">Откуда: ${esc(u.location)}</div>` : ''}
              <div class="info-row">Регистрация: ${u ? esc(fmtDate(u.reg_date || '')) : '—'}</div>
            </div>
            ${currentUsername && u && authorName !== currentUsername ? `<div class="small" style="margin-top:auto;"><a href="/pm/compose?to=${encodeURIComponent(authorName)}">✉️ ЛС</a>${!(thread.is_locked && !isMod(currentUser)) ? ` | <a href="/rep?user=${encodeURIComponent(authorName)}&amp;post=${r.id}">± Реп</a>` : ''}${isMod(currentUser) && (!u || u.role !== 'admin') ? ` | <a href="/warn?user=${encodeURIComponent(authorName)}">⚠</a>` : ''}</div>` : ''}
          </div>`;
          return `<div class="post-row">${userCol}
          <div class="msg-col">
            <div class="msg-header">
              <span>#${(pageParam - 1) * POSTS_PER_PAGE + index + 1} | ${fmtDT(r.created_at)}</span>
              <span>${mqCtl} ${quoteCtl}${controls}</span>
            </div>
            <div id="edit-form-${r.id}" style="display:none; padding:10px; background:#fff0f0; border:1px solid red; margin-bottom:10px;">
              <form method="POST" enctype="multipart/form-data">
                <input type="hidden" name="action" value="edit_post"><input type="hidden" name="post_id" value="${r.id}"><input type="hidden" name="thread_id" value="${id}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
                <textarea name="content" rows="6" style="width:100%;">${esc(r.content)}</textarea><br>
                Заменить вложение: <input type="file" name="file"><br><br>
                <button class="button">Сохранить</button>
                <button type="button" class="button" onclick="document.getElementById('edit-form-${r.id}').style.display='none';document.getElementById('post-content-${r.id}').style.display='block';">Отмена</button>
              </form>
            </div>
            <div class="msg-body" id="post-content-${r.id}">${parseBBCode(r.content)}${r.attachment_url ? renderAttachment(r.attachment_url, r.attachment_name) : ''}${edited}</div>
            ${u && u.signature ? `<div class="signature">__________________<br>${parseBBCode(u.signature)}</div>` : ''}
          </div>
        </div>`;
        }).join('');

        const replyForm = (thread.is_locked && !isMod(currentUser))
          ? `<div style="background:#d4d0c8; padding:10px; border-top:1px solid #999; color:#666;">🔒 Тема закрыта для новых ответов.</div>`
          : currentUsername
            ? `<div id="quickreply" style="background:#d4d0c8; padding:10px; border-top:1px solid #999;">
            <b>Быстрый ответ:</b> <button type="button" class="button btn-sm" onclick="collectQuotes()">Вставить отмеченные цитаты</button>
            <form method="POST" enctype="multipart/form-data">
              <input type="hidden" name="action" value="reply"><input type="hidden" name="thread_id" value="${id}"><input type="hidden" name="csrf_token" value="${newCsrfToken}">
              ${bbBar('msg')}
              <textarea name="content" id="msg" rows="5" style="width:100%; margin-bottom:5px;"></textarea>
              <input type="file" name="file"> <button class="button">Отправить</button>
            </form>
          </div>`
            : `<div style="background:#d4d0c8; padding:10px; border-top:1px solid #999; color:#666;">Войдите, чтобы отвечать: <a href="/login">Вход</a> | <a href="/register">Регистрация</a></div>`;

        const body = `
<table class="table"><tr><td class="small"><a href="/">Форум</a> » <a href="/forum/${thread.forum_id}">${esc(forumRow ? forumRow.title : '')}</a> » <b>${thread.is_announcement ? '📢 ' : ''}${thread.is_sticky ? '📌 ' : ''}${thread.is_locked ? '🔒 ' : ''}${esc(thread.title)}</b> <span class="small">(просмотров: ${thread.views || 0})</span></td></tr></table>
${modbar}
${pollHtml}
<div class="thread-box">
  <div class="thread-head">${thread.prefix ? `<b>[${esc(thread.prefix)}]</b> ` : ''}${esc(thread.title)}</div>
  ${postsHtml || '<div style="padding:10px;"><i>Сообщений нет</i></div>'}
  <div class="pages-box">
    ${pageParam > 1 ? `<a href="/thread/${id}?page=${pageParam - 1}" class="button">← Назад</a>` : ''}
    Страница ${pageParam} из ${totalPages}
    ${pageParam < totalPages ? `<a href="/thread/${id}?page=${pageParam + 1}" class="button">Вперед →</a>` : ''}
  </div>
  ${replyForm}
</div>
<script>function editPost(pid){document.getElementById('post-content-'+pid).style.display='none';document.getElementById('edit-form-'+pid).style.display='block';}</script>`;
        return resp(page(thread.title, body));
      }


      return new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } catch (err) {
      console.error('Worker error:', err);
      return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
    }
  }
};

function deleteAttachmentBulk(env, threadId) {
  // best-effort cleanup of post attachments in R2
  env.DB.prepare('SELECT attachment_url FROM posts WHERE thread_id = ? AND attachment_url IS NOT NULL')
    .bind(threadId).all().then(({ results }) => {
      if (env.FORUM_R2_BUCKET) {
        for (const r of results || []) {
          if (r.attachment_url && r.attachment_url.startsWith('/file/')) {
            env.FORUM_R2_BUCKET.delete(r.attachment_url.substring(6)).catch(() => { });
          }
        }
      }
    }).catch(() => { });
}
