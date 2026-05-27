export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Секретный ключ для безопасности
    if (url.searchParams.get("secret") !== "mysupersecretkey") {
      return new Response("Access Denied. Add ?secret=mysupersecretkey to URL", { status: 403 });
    }

    if (!env.DB) {
      return new Response("CRITICAL ERROR: env.DB is not defined. Check wrangler.toml bindings.", { status: 500 });
    }

    try {
      console.log("Starting DB setup...");

      // 1. Создание таблиц (по одной для стабильности)
      await env.DB.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, avatar TEXT, status TEXT, post_count INTEGER DEFAULT 0, reg_date TEXT, reputation INTEGER DEFAULT 0, signature TEXT, contacts TEXT, password TEXT)");
      await env.DB.exec("CREATE TABLE IF NOT EXISTS forums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT)");
      await env.DB.exec("CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, forum_id INTEGER, title TEXT, author TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
      await env.DB.exec("CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, author TEXT, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");

      console.log("Tables created.");

      // 2. Очистка старых данных (для чистоты эксперимента)
      await env.DB.prepare("DELETE FROM posts").run();
      await env.DB.prepare("DELETE FROM threads").run();
      await env.DB.prepare("DELETE FROM forums").run();
      await env.DB.prepare("DELETE FROM users").run();

      console.log("Old data purged.");

      // 3. Заполнение пользователей
      const usersData = [
        ["Admin", "https://api.dicebear.com/7.x/avataaars/svg?seed=Admin", "Администратор", 1337, "01-01-2001", 999, "Это лучшее место в интернете.", "admin@forum.com", "admin123"],
        ["Moderator", "https://api.dicebear.com/7.x/avataaars/svg?seed=Moderator", "Модератор", 842, "15-02-2001", 150, "Читайте правила!", "mod@forum.com", "mod123"],
        ["dev", "https://api.dicebear.com/7.x/avataaars/svg?seed=dev", "Пользователь", 56, "10-05-2001", 12, "Code is Life", "", "dev123"],
        ["NeoUser", "https://api.dicebear.com/7.x/avataaars/svg?seed=NeoUser", "Новичок", 1, "20-10-2023", 0, "Ищу Matrix...", "", "user123"]
      ];

      const stmtUser = env.DB.prepare("INSERT INTO users (username, avatar, status, post_count, reg_date, reputation, signature, contacts, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const u of usersData) {
        try { await stmtUser.bind(u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7], u[8]).run(); } catch(e) {}
      }
      console.log("Users inserted.");

      // 4. Заполнение форумов
      const f1 = await env.DB.prepare("INSERT INTO forums (title, description) VALUES (?, ?)").bind("Главный форум", "Обсуждение всего мира").run();
      const f2 = await env.DB.prepare("INSERT INTO forums (title, description) VALUES (?, ?)").bind("Техно чат", "Компьютеры, софт, железо").run();
      
      const forumId1 = f1.meta.last_row_id;
      const forumId2 = f2.meta.last_row_id;
      console.log("Forums inserted.");

      // 5. Заполнение тем
      const stmtThread = env.DB.prepare("INSERT INTO threads (forum_id, title, author) VALUES (?, ?, ?)");
      
      const t1 = await stmtThread.bind(forumId1, "Приветствуем на форуме", "Admin").run();
      const t2 = await stmtThread.bind(forumId1, "Правила поведения", "Moderator").run();
      const t3 = await stmtThread.bind(forumId2, "Cloudflare Workers обсуждение", "dev").run();
      console.log("Threads inserted.");

      // 6. Заполнение сообщений
      const stmtPost = env.DB.prepare("INSERT INTO posts (thread_id, author, content) VALUES (?, ?, ?)");

      await stmtPost.bind(t1.meta.last_row_id, "Admin", "Добро пожаловать в 2001 😄").run();
      await stmtPost.bind(t1.meta.last_row_id, "NeoUser", "ОГО, как в старых сайтах!").run();
      await stmtPost.bind(t2.meta.last_row_id, "Moderator", "Без флуда и оскорблений.").run();
      await stmtPost.bind(t3.meta.last_row_id, "dev", "Edge computing выглядит будущим.").run();
      console.log("Posts inserted.");

      return new Response("<h1>Database initialized successfully! 🚀</h1><p>Now you can deploy the main worker.</p>");

    } catch (e) {
      console.error("Setup Error:", e);
      return new Response(`Error: <pre>${e.message}</pre>`, { status: 500 });
    }
  }
};