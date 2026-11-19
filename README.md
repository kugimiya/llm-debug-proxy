# lmstudio-api-catcher

Прозрачный HTTP-прокси между клиентом и [LM Studio](https://lmstudio.ai/) (OpenAI-compatible API). Ничего не меняет в протоколе — только пересылает запросы и **сохраняет снимки** в `logs/`, чтобы было видно, что ушло от OpenCode (или другого клиента) и что вернул LM Studio.

Зависимостей нет: один файл `index.js`, Node.js 18+.

## Зачем

При отладке тулинга локальных LLM в [OpenCode](https://opencode.ai/) часто нужно сравнить сырой request/response с тем, что показывает UI. Прокси встаёт посередине: клиент смотрит на catcher, catcher — на LM Studio.

## Быстрый старт (локально)

```bash
npm start
```

По умолчанию:

| | Порт |
|---|------|
| Слушает catcher | **1234** |
| Шлёт на LM Studio | **127.0.0.1:1235** |

Схема под OpenCode, когда LM Studio перенесён на `:1235`, а в настройках провайдера указан `http://127.0.0.1:1234/v1`:

```bash
npm run start:opencode
```

(это те же `1234` → `1235`, просто явно в команде.)

Универсальные переменные:

| Переменная | По умолчанию | Смысл |
|------------|--------------|--------|
| `LISTEN_HOST` | `0.0.0.0` | Интерфейс catcher |
| `LISTEN_PORT` | `1234` | Порт catcher |
| `TARGET_HOST` | `127.0.0.1` | Хост LM Studio |
| `TARGET_PORT` | `1235` | Порт LM Studio |
| `LOG_DIR` | `./logs` | Куда писать дампы |
| `SKIP_LOG_PATHS` | `/api/v1/models` | Пути только проксировать, без папки в логах |

## Docker

```bash
cp .env.example .env   # при необходимости поправить
docker compose up -d --build
```

В контейнере upstream обычно `host.docker.internal:1235` (LM Studio на хосте). Логи монтируются в `./logs`.

Остановка: `docker compose down`.

## Что попадает в логи

На каждый **залогированный** запрос — каталог `logs/YYYYMMDDThhmmss…_<id>/`:

| Файл | Содержимое |
|------|------------|
| `00-client-meta.json` | Метод, URL, откуда пришло соединение |
| `01-request-headers.json` | Заголовки запроса |
| `02-request-body.*` | Тело запроса |
| `03-upstream-meta.json` | Куда ушло upstream |
| `04-response-headers.json` | Заголовки ответа |
| `05-response-body.*` | Сырой ответ (в т.ч. SSE) |
| `05-response-body-parsed.txt` | Для **SSE** (`text/event-stream`): склеенный текст ассистента, reasoning, tool calls, usage |
| `06-summary.json` | Статус, размеры, время |

Шумные опросы вроде **`GET /api/v1/models`** по умолчанию **не дампятся** (см. `SKIP_LOG_PATHS`).

## OpenCode

В LM Studio / local provider укажи base URL на catcher, например:

`http://127.0.0.1:1234/v1`

Убедись, что на машине не крутится **второй** экземпляр catcher на том же порту (Docker + `npm start` одновременно легко путают).

## Разработка

```bash
npm run dev              # с перезапуском при изменении index.js
npm run dev:opencode     # 1234 → 1235
```

## Лицензия

Репозиторий приватный; лицензию добавьте сами, если выложите публично.