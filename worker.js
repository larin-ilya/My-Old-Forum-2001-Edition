export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const method = request.method;

    if (!env.DB) {
      return new Response("D1 Database not bound. Check wrangler.toml", { status: 500 })
    }

    // =========================
    // HELPERS & AUTH
    // =========================

    const cookieHeader = request.headers.get("Cookie") || "";
    const sessionMatch = cookieHeader.match(/session=([^;]+)/);
    const currentUsername = sessionMatch ? decodeURIComponent(sessionMatch[1]) : null;

    // Обработка POST запросов (Создание тем, Ответов, Логин, Регистрация)
    if (method === "POST") {
      const formData = await request.formData();
      const action = formData.get("action");

      // --- ЛОГИН И РЕГИСТРАЦИЯ (без изменений) ---
      if (action === "login") {
        const userIn = formData.get("username");
        const passIn = formData.get("password");
        
        // Загружаем пользователя для проверки пароля
        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(userIn).first();

        if (user && user.password === passIn) {
          return new Response("<script>window.location.href='/';</script>", {
            headers: { 
              "Set-Cookie": `session=${encodeURIComponent(user.username)}; Path=/; HttpOnly; SameSite=Lax`,
              "Content-Type": "text/html"
            }
          });
        } else {
          return new Response("<script>alert('Неверный логин или пароль'); window.location.href='/login';</script>", { headers: { "Content-Type": "text/html" }});
        }
      }

      if (action === "register") {
        const userIn = formData.get("username");
        const passIn = formData.get("password");
        
        if (userIn.length < 3 || passIn.length < 3) {
           return new Response("<script>alert('Слишком короткий логин или пароль'); window.location.href='/register';</script>", { headers: { "Content-Type": "text/html" }});
        }

        const today = new Date().toISOString().split('T')[0];
        try {
          await env.DB.prepare("INSERT INTO users (username, password, status, post_count, reg_date, reputation, avatar, signature, contacts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(userIn, passIn, "Новичок", 0, today, 0, `https://api.dicebear.com/7.x/avataaars/svg?seed=${userIn}`, "", "").run();
          
          return new Response("<script>alert('Регистрация успешна!'); window.location.href='/';</script>", {
             headers: { "Set-Cookie": `session=${encodeURIComponent(userIn)}; Path=/; HttpOnly; SameSite=Lax`, "Content-Type": "text/html" }
          });
        } catch (e) {
          return new Response("<script>alert('Ошибка: Возможно пользователь уже существует'); window.history.back();</script>", { headers: { "Content-Type": "text/html" }});
        }
      }

      if (action === "logout") {
        return new Response("<script>window.location.href='/';</script>", {
          headers: { "Set-Cookie": `session=; Path=/; HttpOnly; Max-Age=0`, "Content-Type": "text/html" }
        });
      }

      // --- НОВАЯ ЛОГИКА: СОЗДАНИЕ ТЕМЫ (в форуме) ---
      if (action === "new_thread") {
        if (!currentUsername) return new Response("<script>alert('Сначала войдите!'); window.location.href='/login';</script>", { headers: { "Content-Type": "text/html" }});

        const forumId = parseInt(formData.get("forum_id"));
        const title = formData.get("title");
        const content = formData.get("content");

        if (!title || !content) return new Response("<script>alert('Заполните все поля'); window.history.back();</script>", { headers: { "Content-Type": "text/html" }});

        try {
          // 1. Создаем тему
          const threadRes = await env.DB.prepare("INSERT INTO threads (forum_id, title, author) VALUES (?, ?, ?)")
            .bind(forumId, title, currentUsername).run();
          
          const threadId = threadRes.meta.last_row_id;

          // 2. Создаем первый пост (само сообщение)
          await env.DB.prepare("INSERT INTO posts (thread_id, author, content) VALUES (?, ?, ?)")
            .bind(threadId, currentUsername, content).run();

          // 3. Обновляем счетчик сообщений юзера
          await env.DB.prepare("UPDATE users SET post_count = post_count + 1 WHERE username = ?")
            .bind(currentUsername).run();

          return new Response(`<script>window.location.href='/thread/${threadId}';</script>`, { headers: { "Content-Type": "text/html" }});

        } catch (e) {
          return new Response(`<script>alert('Ошибка создания темы: ${e.message}'); window.history.back();</script>`, { headers: { "Content-Type": "text/html" }});
        }
      }

      // --- НОВАЯ ЛОГИКА: ОТВЕТ В ТЕМУ ---
      if (action === "reply") {
        if (!currentUsername) return new Response("<script>alert('Сначала войдите!'); window.location.href='/login';</script>", { headers: { "Content-Type": "text/html" }});

        const threadId = parseInt(formData.get("thread_id"));
        const content = formData.get("content");

        if (!content) return new Response("<script>alert('Введите текст сообщения'); window.history.back();</script>", { headers: { "Content-Type": "text/html" }});

        try {
          // 1. Создаем пост
          await env.DB.prepare("INSERT INTO posts (thread_id, author, content) VALUES (?, ?, ?)")
            .bind(threadId, currentUsername, content).run();

          // 2. Обновляем счетчик сообщений юзера
          await env.DB.prepare("UPDATE users SET post_count = post_count + 1 WHERE username = ?")
            .bind(currentUsername).run();

          // Возвращаемся в тему
          return new Response(`<script>window.location.href='/thread/${threadId}';</script>`, { headers: { "Content-Type": "text/html" }});

        } catch (e) {
          return new Response(`<script>alert('Ошибка ответа: ${e.message}'); window.history.back();</script>`, { headers: { "Content-Type": "text/html" }});
        }
      }
    }

    // Загружаем всех пользователей (кэш для рендеринга)
    const { results: usersRaw } = await env.DB.prepare("SELECT * FROM users").all();
    const users = {};
    usersRaw.forEach(u => { users[u.username] = u; });

    // =========================
    // UI COMPONENTS
    // =========================

    const loginFormSnippet = currentUsername 
      ? `<b>Привет, ${currentUsername}</b> | <form method="POST" style="display:inline;"><input type="hidden" name="action" value="logout"><button class="button">Logout</button></form>`
      : `<form method="POST" action="/" style="display:inline;">
           Логин: <input type="text" name="username" style="font-size:10px;"> 
           Пароль: <input type="password" name="password" style="font-size:10px;">
           <input type="hidden" name="action" value="login">
           <button class="button">Вход</button>
         </form> | <a href="/register" class="button" style="text-decoration:none; color:black;">Регистрация</a>`;

    const page = (title, body) => `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin:0; background:#e0e0e0; font-family: Verdana, Arial, sans-serif; font-size:11px; color:#000; }
  a { color:#0000cc; text-decoration:none; cursor:pointer; }
  a:hover { text-decoration:underline; color:#ff0000; }
  .wrap { width: 960px; margin: 10px auto; }
  
  .header {
    background: linear-gradient(180deg, #245edb 0%, #1941a5 50%, #1941a5 100%);
    color:white; padding:12px; font-weight:bold; border:2px solid #003366; font-size:18px;
    letter-spacing:1px; box-shadow: 2px 2px 0px rgba(0,0,0,0.2); font-family: "Times New Roman", serif;
  }
  
  .nav {
    background:#d4d0c8; border:1px solid #808080; border-bottom:1px solid #fff; border-right:1px solid #fff;
    padding:5px; font-size:11px; margin-top:5px;
  }
  
  .table { width:100%; border-collapse:collapse; background:#ffffff; border:1px solid #000; margin-top:10px; }
  .table th {
    background: linear-gradient(180deg, #316ac5 0%, #245edb 100%);
    color:white; font-size:11px; padding:6px; text-align:left; border:1px solid #1e3f7a; font-weight:bold;
  }
  .table td { padding:6px; border-bottom:1px solid #dcdcdc; border-right:1px solid #dcdcdc; font-size:12px; vertical-align: middle; }

  .forum-title { font-weight:bold; font-size:12px; color:#000080; }
  .small { font-size:10px; color:#666; }

  .thread-box { background: #fff; border: 1px solid #000; margin-top:10px; }
  .thread-head {
    background: linear-gradient(180deg, #316ac5 0%, #245edb 100%);
    color:white; padding:6px; font-weight:bold; font-size:12px; border-bottom:1px solid #000;
  }

  /* POST LAYOUT */
  .post-row { display: flex; border-bottom: 1px solid #999; min-height: 200px; }
  .user-col {
    width: 170px; background: #f5f5f5; border-right: 1px solid #999; padding: 8px; text-align: center;
    vertical-align: top; flex-shrink: 0; display: flex; flex-direction: column; align-items: center;
  }
  .avatar { width: 100px; height: 100px; border: 1px solid #999; background: #fff; margin-bottom: 6px; object-fit: contain; }
  .username { font-weight: bold; font-size: 12px; color: #000080; margin-bottom: 4px; text-decoration: none; }
  .usertitle { font-size: 10px; color: #666; font-style: italic; margin-bottom: 6px; display: block; }
  .info-row { font-size: 10px; color: #000; margin-bottom: 2px; width: 100%; border-bottom: 1px dashed #ccc; padding-bottom: 2px; }
  .reputation { color: #008000; font-weight: bold; }
  
  .msg-col { flex-grow: 1; padding: 10px; background: #fff; display: flex; flex-direction: column; }
  .msg-header { font-size: 9px; color: #666; border-bottom: 1px solid #eee; padding-bottom: 4px; margin-bottom: 8px; display: flex; justify-content: space-between; }
  .msg-body { font-size: 12px; line-height: 1.4; flex-grow: 1; }
  .signature { margin-top: 15px; padding-top: 10px; border-top: 1px dashed #ccc; font-size: 10px; color: #666; font-style: italic; }
  
  .footer { margin-top:10px; text-align:center; font-size:10px; color:#333; background:#d4d0c8; border:1px solid #808080; padding:5px; }
  .button {
    background:#d4d0c8; border:2px outset #fff; padding:2px 6px; font-size:11px; display:inline-block; cursor: pointer; font-family: Verdana, sans-serif;
  }
  input, textarea { font-family: Verdana, sans-serif; font-size: 11px; border:1px solid #7f9db9; }
</style>
</head>
<body>
<div class="wrap">
  <div class="header">☠ My Old Forum 2001 Edition ☠</div>
  <div class="nav">
    🏠 <a href="/">Index</a> | 📜 <a href="/thread/4">Rules</a> | 🔍 <a href="/search">Search</a> | 
    <span style="float:right; margin-right:10px;">${loginFormSnippet}</span>
  </div>
  ${body}
  <div class="footer">
    Powered by Cloudflare Workers • D1 DB • ${new Date().toLocaleTimeString()}
  </div>
</div>
</body>
</html>
`

    // =========================
    // ROUTES
    // =========================

    if (url.pathname === "/register") {
      const body = `
        <div class="thread-box">
          <div class="thread-head">Регистрация</div>
          <div style="padding:20px;">
            <form method="POST">
              <input type="hidden" name="action" value="register">
              <table class="table">
                <tr><td width="30%"><b>Ник:</b></td><td><input type="text" name="username" style="width:200px;"></td></tr>
                <tr><td><b>Пароль:</b></td><td><input type="password" name="password" style="width:200px;"></td></tr>
                <tr><td colspan="2" style="text-align:center; padding:10px;">
                  <button class="button">Зарегистрироваться</button>
                </td></tr>
              </table>
            </form>
          </div>
        </div>`;
      return new Response(page("Регистрация", body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // INDEX
    if (url.pathname === "/") {
      const { results: forums } = await env.DB.prepare(`
        SELECT f.id, f.title, f.description, COUNT(t.id) as topic_count
        FROM forums f
        LEFT JOIN threads t ON f.id = t.forum_id
        GROUP BY f.id
        ORDER BY f.id ASC
      `).all();

      const body = `
<table class="table">
  <tr><th width="50%">Forum</th><th width="40%">Description</th><th width="10%">Topics</th></tr>
  ${forums.map(f => `
    <tr>
      <td><img src="https://picsum.photos/seed/${f.id}/32/32" align="left" style="margin-right:8px; border:1px solid #999;">
        <a class="forum-title" href="/forum/${f.id}">${f.title}</a>
      </td>
      <td class="small">${f.description}</td>
      <td style="text-align:center">${f.topic_count}</td>
    </tr>`).join("")}
</table>`;
      return new Response(page("Index", body), { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // FORUM PAGE + ФОРМА НОВОЙ ТЕМЫ
    if (url.pathname.startsWith("/forum/")) {
      const id = parseInt(url.pathname.split("/")[2])
      const forum = await env.DB.prepare("SELECT * FROM forums WHERE id = ?").bind(id).first();
      if (!forum) return new Response(page("404", "<h1>Forum not found</h1>"), { status: 404 });

      const { results: threads } = await env.DB.prepare(`
        SELECT t.id, t.title, t.author, t.created_at, COUNT(p.id) as reply_count
        FROM threads t
        LEFT JOIN posts p ON t.id = p.thread_id
        WHERE t.forum_id = ?
        GROUP BY t.id
        ORDER BY t.id ASC
      `).bind(id).all();

      // Кнопка "Новая тема"
      const newTopicButton = currentUsername 
        ? `<div style="margin-bottom:5px; text-align:right;"><a href="#" onclick="document.getElementById('newThreadForm').style.display='block'; return false;" class="button">Новая тема</a></div>
           <div id="newThreadForm" style="display:none; background:#f5f5f5; padding:10px; border:1px solid #999; margin-bottom:10px;">
             <form method="POST">
               <input type="hidden" name="action" value="new_thread">
               <input type="hidden" name="forum_id" value="${id}">
               <b>Заголовок:</b><br><input type="text" name="title" style="width:100%; box-sizing:border-box;"><br><br>
               <b>Сообщение:</b><br><textarea name="content" rows="5" style="width:100%; box-sizing:border-box;"></textarea><br><br>
               <button class="button">Создать тему</button>
               <button type="button" class="button" onclick="document.getElementById('newThreadForm').style.display='none'">Отмена</button>
             </form>
           </div>`
        : `<div style="margin-bottom:5px; text-align:right; color:#666; font-size:10px;">Войдите, чтобы создавать темы</div>`;

      const body = `
        ${newTopicButton}
        <table class="table">
          <tr><th width="55%">Thread Title</th><th width="20%">Starter</th><th width="5%">Reps</th><th width="20%">Last Post</th></tr>
          ${threads.map(t => `
            <tr>
              <td><a class="forum-title" href="/thread/${t.id}">${t.title}</a></td>
              <td>${t.author}</td>
              <td style="text-align:center">${t.reply_count}</td>
              <td class="small">${t.created_at.split('T')[0]} <br> by ${t.author}</td>
            </tr>`).join("")}
        </table>`;
      return new Response(page(forum.title, body), { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // THREAD PAGE + ФОРМА ОТВЕТА
    if (url.pathname.startsWith("/thread/")) {
      const id = parseInt(url.pathname.split("/")[2])
      const thread = await env.DB.prepare("SELECT * FROM threads WHERE id = ?").bind(id).first();
      if (!thread) return new Response(page("404", "<h1>Thread not found</h1>"), { status: 404 });

      const { results: posts } = await env.DB.prepare("SELECT * FROM posts WHERE thread_id = ? ORDER BY id ASC").bind(id).all();

      // Форма быстрого ответа
      const replyForm = currentUsername
        ? `<div style="background:#d4d0c8; padding:10px; border-top:1px solid #999;">
             <b>Быстрый ответ:</b>
             <form method="POST">
               <input type="hidden" name="action" value="reply">
               <input type="hidden" name="thread_id" value="${id}">
               <textarea name="content" rows="4" style="width:100%; box-sizing:border-box; margin-bottom:5px;"></textarea>
               <button class="button">Отправить</button>
             </form>
           </div>`
        : `<div style="background:#d4d0c8; padding:10px; border-top:1px solid #999; color:#666;">Войдите, чтобы отвечать.</div>`;

      const body = `
<div class="thread-box">
  <div class="thread-head">${thread.title}</div>
  ${posts.map((r, index) => {
    const u = users[r.author] || { username: r.author, avatar: "https://via.placeholder.com/100", status: "Guest", post_count: 0, reg_date: "N/A", reputation: 0, signature: "", contacts: "" };
    return `
    <div class="post-row">
      <div class="user-col">
        <img src="${u.avatar}" class="avatar" alt="${u.username}">
        <a href="#" class="username">${u.username}</a>
        <span class="usertitle">${u.status}</span>
        <div style="width:100%; margin: 5px 0;">
          <div class="info-row">Сообщений: ${u.post_count}</div>
          <div class="info-row">Репутация: <span class="reputation">${u.reputation}</span></div>
          <div class="info-row">Зарегистрирован: <br>${u.reg_date}</div>
        </div>
        ${u.contacts ? `<div class="small" style="margin-top:auto; width:100%;">${u.contacts}</div>` : ''}
      </div>
      <div class="msg-col">
        <div class="msg-header">
          <span>#${index + 1} | ${r.created_at.split('T')[0]}</span>
          <span><a href="#">Quote</a> | <a href="#">Report</a></span>
        </div>
        <div class="msg-body">${r.content}</div>
        ${u.signature ? `<div class="signature">__________________<br>${u.signature}</div>` : ''}
      </div>
    </div>
    `
  }).join("")}
  ${replyForm}
</div>`;
      return new Response(page(thread.title, body), { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    return new Response("404 Not Found", { status: 404 })
  }
}