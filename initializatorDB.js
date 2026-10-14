// ============================================================
// My Old Forum 2001 Edition — Database initializer (v2 schema)
// Cloudflare Workers + D1 — Contributor: codex
// Usage: deploy as worker with DB binding, open /?secret=mysupersecretkey
// ============================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.searchParams.get("secret") !== "mysupersecretkey") {
      return new Response("Access Denied. Add ?secret=mysupersecretkey to URL", { status: 403 });
    }

    if (!env.DB) {
      return new Response("CRITICAL ERROR: env.DB is not defined. Check wrangler.toml bindings.", { status: 500 });
    }

    try {
      // ---- 1. Schema (CREATE IF NOT EXISTS; safe to re-run) ----
      const schema = [
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, avatar TEXT, status TEXT, post_count INTEGER DEFAULT 0, reg_date TEXT, reputation INTEGER DEFAULT 0, signature TEXT, contacts TEXT, password TEXT, role TEXT DEFAULT 'user', location TEXT DEFAULT '', birthdate TEXT DEFAULT '', custom_title TEXT DEFAULT '', last_active DATETIME, warns INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, position INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS forums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, category_id INTEGER DEFAULT 0, position INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, forum_id INTEGER, title TEXT, author TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, is_sticky INTEGER DEFAULT 0, is_locked INTEGER DEFAULT 0, is_announcement INTEGER DEFAULT 0, views INTEGER DEFAULT 0, prefix TEXT DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, author TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, attachment_url TEXT, attachment_name TEXT, edited_at TEXT, edited_by TEXT)`,
        `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`,
        `CREATE TABLE IF NOT EXISTS pms (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user TEXT, to_user TEXT, subject TEXT, body TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, is_read INTEGER DEFAULT 0, deleted_to INTEGER DEFAULT 0, deleted_from INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS reputation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user TEXT, to_user TEXT, post_id INTEGER, delta INTEGER, comment TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, by_user TEXT, reason TEXT, points INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER UNIQUE, question TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
        `CREATE TABLE IF NOT EXISTS poll_options (id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER, text TEXT, votes INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS poll_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER, username TEXT, option_id INTEGER)`
      ];
      for (const s of schema) { await env.DB.prepare(s).run(); }
      console.log("Schema created.");

      // ---- 2. Purge old data ----
      for (const t of ["poll_votes", "poll_options", "polls", "reputation_log", "warnings", "pms", "posts", "threads", "forums", "categories", "sessions", "kv_store", "users"]) {
        await env.DB.prepare(`DELETE FROM ${t}`).run();
      }
      console.log("Old data purged.");

      // ---- 3. Users ----
      const usersData = [
        ["Admin", "https://api.dicebear.com/7.x/avataaars/svg?seed=Admin", "Администратор", 1337, "01.01.2001", 999, "Это лучшее место в интернете.", "admin@forum.com", "admin123", "admin", "Москва", "01.01.1980", "Хозяин форума"],
        ["Moderator", "https://api.dicebear.com/7.x/avataaars/svg?seed=Moderator", "Модератор", 842, "15.02.2001", 150, "Читайте правила!", "mod@forum.com", "mod123", "mod", "Санкт-Петербург", "15.02.1985", ""],
        ["dev", "https://api.dicebear.com/7.x/avataaars/svg?seed=dev", "Пользователь", 56, "10.05.2001", 12, "Code is Life", "", "dev123", "user", "Новосибирск", "10.05.1990", ""],
        ["NeoUser", "https://api.dicebear.com/7.x/avataaars/svg?seed=NeoUser", "Новичок", 1, "20.10.2023", 0, "Ищу Matrix...", "", "user123", "user", "", "", ""]
      ];
      const stmtUser = env.DB.prepare("INSERT INTO users (username, avatar, status, post_count, reg_date, reputation, signature, contacts, password, role, location, birthdate, custom_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const u of usersData) {
        try { await stmtUser.bind(u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7], u[8], u[9], u[10], u[11], u[12]).run(); } catch (e) { }
      }
      console.log("Users inserted.");

      // ---- 4. Categories & forums ----
      const catMain = await env.DB.prepare("INSERT INTO categories (title, position) VALUES (?, ?)").bind("Основные разделы", 0).run();
      const catTech = await env.DB.prepare("INSERT INTO categories (title, position) VALUES (?, ?)").bind("Технологии", 1).run();

      const f1 = await env.DB.prepare("INSERT INTO forums (title, description, category_id, position) VALUES (?, ?, ?, ?)").bind("Главный форум", "Обсуждение всего на свете", catMain.meta.last_row_id, 0).run();
      const f2 = await env.DB.prepare("INSERT INTO forums (title, description, category_id, position) VALUES (?, ?, ?, ?)").bind("Курилка", "Флуд, юмор и оффтоп", catMain.meta.last_row_id, 1).run();
      const f3 = await env.DB.prepare("INSERT INTO forums (title, description, category_id, position) VALUES (?, ?, ?, ?)").bind("Техно чат", "Компьютеры, софт, железо", catTech.meta.last_row_id, 0).run();
      const f4 = await env.DB.prepare("INSERT INTO forums (title, description, category_id, position) VALUES (?, ?, ?, ?)").bind("Веб-разработка", "HTML, CSS, скрипты и серверы", catTech.meta.last_row_id, 1).run();
      console.log("Forums inserted.");

      // ---- 5. Threads ----
      const tAnn = await env.DB.prepare("INSERT INTO threads (forum_id, title, author, is_announcement) VALUES (?, ?, ?, 1)").bind(f1.meta.last_row_id, "📢 ВАЖНО: Обновление форума 2001 Edition (vBulletin/IPB Edition)", "Admin").run();
      const tRules = await env.DB.prepare("INSERT INTO threads (forum_id, title, author, is_sticky, is_locked) VALUES (?, ?, ?, 1, 1)").bind(f1.meta.last_row_id, "Правила поведения на форуме", "Moderator").run();
      const tHello = await env.DB.prepare("INSERT INTO threads (forum_id, title, author, prefix) VALUES (?, ?, ?, ?)").bind(f1.meta.last_row_id, "Приветствуем на форуме!", "Admin", "Новости").run();
      const tPoll = await env.DB.prepare("INSERT INTO threads (forum_id, title, author, prefix) VALUES (?, ?, ?, ?)").bind(f2.meta.last_row_id, "Какой у вас был первый компьютер?", "dev", "Опрос").run();
      const tTech = await env.DB.prepare("INSERT INTO threads (forum_id, title, author) VALUES (?, ?, ?)").bind(f3.meta.last_row_id, "Cloudflare Workers — обсуждение", "dev").run();
      console.log("Threads inserted.");

      // ---- 6. Posts ----
      const stmtPost = env.DB.prepare("INSERT INTO posts (thread_id, author, content) VALUES (?, ?, ?)");
      await stmtPost.bind(tAnn.meta.last_row_id, "Admin", "[b]Внимание, форумчане![/b]\n\nФорум переехал на новый движок в стиле любимых [b]vBulletin[/b] и [b]IPB[/b] из 2001-го!\n\nЧто нового:\n[list][*]Категории и разделы[*]Опросы[*]Личные сообщения[*]Репутация[*]Предупреждения и модерация[*]Смайлы и BBCode[/list]\nПриятного общения! :cool:").run();
      await stmtPost.bind(tRules.meta.last_row_id, "Moderator", "1. Без флуда и оскорблений.\n2. Не постить рекламу.\n3. Уважайте друг друга.\n\n[spoiler]Нарушители получают предупреждения, а затем бан.[/spoiler]").run();
      await stmtPost.bind(tHello.meta.last_row_id, "Admin", "Добро пожаловать в 2001 год! :) Расскажите о себе.").run();
      const pHello2 = await stmtPost.bind(tHello.meta.last_row_id, "NeoUser", "ОГО, как в старых сайтах! Мне нравится! :D").run();
      await stmtPost.bind(tPoll.meta.last_row_id, "dev", "Голосуем! У меня был Pentium III 800 МГц :cool:").run();
      await stmtPost.bind(tPoll.meta.last_row_id, "Moderator", "А у меня Целерон 300. Ностальгия...").run();
      await stmtPost.bind(tTech.meta.last_row_id, "dev", "Edge computing выглядит будущим. Workers + D1 = мощь!\n\n[code]export default { async fetch(r, env) { return new Response('Hello 2001'); } }[/code]").run();

      // Reply with quote demo
      const replyTarget = await env.DB.prepare("SELECT id FROM posts WHERE thread_id = ? ORDER BY id LIMIT 1").bind(tHello.meta.last_row_id).first();
      if (replyTarget) {
        await stmtPost.bind(tHello.meta.last_row_id, "Moderator", `[quote=NeoUser]ОГО, как в старых сайтах! Мне нравится! :D[/quote]\n\nОтлично, осваивайся! Если что — пиши в ЛС.`).run();
      }

      // Sync post counters
      await env.DB.prepare("UPDATE users SET post_count = (SELECT COUNT(*) FROM posts WHERE posts.author = users.username)").run();
      console.log("Posts inserted.");

      // ---- 7. Poll ----
      const poll = await env.DB.prepare("INSERT INTO polls (thread_id, question) VALUES (?, ?)").bind(tPoll.meta.last_row_id, "Какой у вас был первый компьютер?").run();
      const pollOptions = ["Pentium III", "Celeron", "AMD Athlon", "486 DX2", "Спектрум / другой ZX"];
      for (const opt of pollOptions) {
        await env.DB.prepare("INSERT INTO poll_options (poll_id, text, votes) VALUES (?, ?, ?)").bind(poll.meta.last_row_id, opt, 0).run();
      }
      const opt1 = await env.DB.prepare("SELECT id FROM poll_options WHERE poll_id = ? ORDER BY id LIMIT 1").bind(poll.meta.last_row_id).first();
      const opt3 = await env.DB.prepare("SELECT id FROM poll_options WHERE poll_id = ? ORDER BY id LIMIT 1 OFFSET 2").bind(poll.meta.last_row_id).first();
      if (opt1) {
        await env.DB.prepare("INSERT INTO poll_votes (poll_id, username, option_id) VALUES (?, ?, ?)").bind(poll.meta.last_row_id, "dev", opt1.id).run();
        await env.DB.prepare("UPDATE poll_options SET votes = votes + 1 WHERE id = ?").bind(opt1.id).run();
      }
      if (opt3) {
        await env.DB.prepare("INSERT INTO poll_votes (poll_id, username, option_id) VALUES (?, ?, ?)").bind(poll.meta.last_row_id, "Moderator", opt3.id).run();
        await env.DB.prepare("UPDATE poll_options SET votes = votes + 1 WHERE id = ?").bind(opt3.id).run();
      }
      console.log("Poll inserted.");

      // ---- 8. Demo PM & reputation ----
      await env.DB.prepare("INSERT INTO pms (from_user, to_user, subject, body) VALUES (?, ?, ?, ?)").bind("Admin", "NeoUser", "Добро пожаловать!", "Привет! Добро пожаловать на форум. Если будут вопросы — обращайся :cool:").run();
      await env.DB.prepare("INSERT INTO reputation_log (from_user, to_user, post_id, delta, comment) VALUES (?, ?, ?, ?, ?)").bind("Admin", "dev", pHello2 ? pHello2.meta.last_row_id : null, 1, "Отличный пост!").run();
      await env.DB.prepare("UPDATE users SET reputation = reputation + 1 WHERE username = 'dev'").run();
      console.log("PM & reputation inserted.");

      return new Response("<h1>Database initialized successfully! 🚀</h1><p>Schema v2 (vBulletin/IPB Edition). Now deploy the main worker.</p><p>Test accounts: Admin/admin123, Moderator/mod123, dev/dev123</p>");

    } catch (e) {
      console.error("Setup Error:", e);
      return new Response(`Error: <pre>${e.message}</pre>`, { status: 500 });
    }
  }
};
