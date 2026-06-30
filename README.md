# Dialog

Простой мессенджер с групповыми видеозвонками, демонстрацией экрана, обменом медиа и эмодзи-пикером.

## Возможности

- 💬 **Чат по комнатам** — список участников онлайн, индикатор «печатает…», история последних сообщений
- 📹 **Групповые видеозвонки** — mesh WebRTC на несколько участников (perfect negotiation)
- 🖥️ **Демонстрация экрана** — переключение камера ↔ экран во время звонка
- 📎 **Медиа** — фото, видео и гифки прямо в ленте
- 😊 **Эмодзи-пикер** — по категориям
- 🔐 **Регистрация и вход** — пароли хранятся солёным scrypt-хешем, сессии по токену

## Стек

- Бэкенд: Node.js, Express, Socket.IO
- База данных: MySQL 8 (через `mysql2`) — пользователи и история сообщений
- Фронтенд: чистый HTML/CSS/JS + WebRTC
- Аутентификация: `crypto.scrypt`, токены сессий в памяти

## База данных

Нужен MySQL 8. Проще всего через Docker:

```bash
docker compose up -d        # поднимет MySQL на localhost:3306
```

Строка подключения по умолчанию — `mysql://dialog:dialog@localhost:3306/dialog`.
Переопределяется переменной `DATABASE_URL`. Таблицы (`users`, `messages`) создаются
автоматически при старте сервера.

## Запуск

```bash
npm install
docker compose up -d        # база данных
npm start                   # сервер
```

Откройте `https://localhost:3000` (или `http://localhost:3000`, если нет сертификата).

### HTTPS для доступа по сети

Камера, микрофон и демонстрация экрана доступны только на `localhost` или по HTTPS.
Чтобы открывать с других устройств в локальной сети, сгенерируйте самоподписанный сертификат:

```bash
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/key.pem -out certs/cert.pem -days 365 -subj "/CN=Dialog Local"
```

Сервер сам поднимет HTTPS, если найдёт `certs/key.pem` и `certs/cert.pem`.

## Замечания для продакшена

- Самоподписанный сертификат не доверяется браузерами — для интернета нужен реальный домен и сертификат (например, Let's Encrypt).
- Для звонков между пользователями за разными NAT одного STUN недостаточно — нужен **TURN**-сервер.
- Сессии хранятся в памяти и сбрасываются при перезапуске.

## Переменные окружения

- `PORT` — порт сервера (по умолчанию `3000`).
- `DATABASE_URL` — строка подключения к MySQL (по умолчанию `mysql://dialog:dialog@localhost:3306/dialog`).
- `REDIS_URL` — необязательная строка подключения к Redis для кэша сессий и истории
  (напр. `redis://localhost:6379` или `rediss://...` для managed). Не задан — кэш выключен,
  работает чистый MySQL.

## License

Dialog is licensed under the **GNU Affero General Public License v3.0 or later**
(AGPL-3.0-or-later) — see [LICENSE](LICENSE).

In short: you're free to use, study, modify and self-host it, but if you run a
modified version as a network service, you must make your modified source
available to its users under the same license.
