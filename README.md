# My Old Forum 2001 Edition 🖥️

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![D1 Database](https://img.shields.io/badge/D1-Database-0055FF?style=for-the-badge&logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

Ретро-форум на Cloudflare Workers



### 1. Создайте D1 базу в Cloudflare
https://dash.cloudflare.com/
- Зайдите в Cloudflare Dashboard → D1
- Create database → имя `forum-db`

### 2. Задеплойте инициализатор
- Workers & Pages → Create application , 
- Название: `forum`, шаблон hello word, - В настройках привяжите D1: переменная `DB` → база `forum-db`
- edit code - скопруйте код из `initializatorDB.js`
- Откройте: `https://forum.ваш-сайт.pages.dev/?secret=mysupersecretkey`

### 3. Задеплойте форум
Заменяем код initializator-а на код форума:
- edit code - скопруйте код из  `worker.js`


### 4. Готово! 🎉
Откройте `https://forum.ваш-сайт.pages.dev`



## Тестовые аккаунты
- Admin / admin123
- Moderator / mod123

## Важно
⚠️ Пароли хранятся в открытом виде (стиль 2001 года)
