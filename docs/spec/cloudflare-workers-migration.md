# Спецификация: адаптация Mimir к деплою на Cloudflare Workers

Статус: **план (design)**. Дата: 2026-07-01.
Автор процесса: совместная проработка (maintainer + assistant).

Документ описывает полный процесс и все принятые решения по добавлению
Cloudflare Workers как второго таргета деплоя Mimir — **без потери**
существующего Node/Docker-пути.

**Контекст:** это форк, изменения предлагаются в upstream двумя PR; мейнтейнер
основного репозитория дал устное одобрение. Docker остаётся recommended-путём для
всех текущих пользователей, Cloudflare добавляется как новая first-class-опция
(не разворот). См. «Стратегия внесения» в конце раздела 0.

---

## 0. Контекст и цель

Mimir — Flue-приложение (сейчас таргет `node`): GitHub-webhook-канал + три
воркфлоу (`review-pr`, `remember-pr`, `feedback-pr`) + собственное SQLite-хранилище
для дедупа доставок, id summary-комментария и статистики ревью. У Flue есть
first-class-поддержка Cloudflare (каждый воркфлоу → Durable Object), поэтому задача
— не «портировать вручную», а **устранить Node-специфичные точки и добавить
Cloudflare-конфигурацию**, оставив оба таргета рабочими.

Действующий раздел «Cloudflare Workers (experimental)» в [`DEPLOY.md`](../../DEPLOY.md)
честно помечает единственный блокер — `node:sqlite`. Эта спека доводит путь до
production-ready.

### Принятые решения (развилки)

| # | Развилка | Решение | Почему |
|---|----------|---------|--------|
| A | Чем заменить `node:sqlite` на CF | **Cloudflare D1** | SQL переносится почти дословно; лёгкие агрегаты для дашборда; БД инспектируется отдельно через `wrangler`; дедуп-атомарность через `INSERT OR IGNORE` + `meta.changes` |
| B | Судьба Node/Docker-пути | **Docker остаётся recommended + Cloudflare — новая first-class-опция** | Все текущие пользователи на Docker; CF — новая возможность, не разворот. Ноль регрессий Docker — hard gate |
| C | Admission воркфлоу из канала | **Ambient `invoke()`** | Штатный кросс-таргетный механизм Flue; убирает loopback-guard и `INTERNAL_BASE_URL` |
| D | Куда вынести admin-дашборд | **В `app.ts` как обычный роут** | Таргет-независимо; снимает нарушение контракта папки `workflows/`; async-friendly |

### Подтверждённые ограничения платформы (сняли часть пунктов без изменений кода)

1. **`--target cloudflare` переопределяет `flue.config.ts`.**
   [`reference/configuration.md`](../../node_modules/@flue/cli/docs/reference/configuration.md):
   «required unless `--target` is passed». → Два таргета сосуществуют через CLI-флаг,
   `flue.config.ts` оставляем как есть (`target: "node"` — дефолт для Docker-пути).

2. **`process.env.*` работает на Cloudflare** при `nodejs_compat` + свежем
   `compatibility_date` (Cloudflare популяризует `process.env` из vars/secrets
   при `compatibility_date >= 2025-04-01`). → Чтение env в
   [`env.ts`](../../src/lib/env.ts), [`memory.ts`](../../src/lib/memory.ts),
   [`repo-tools.ts`](../../src/lib/repo-tools.ts), воркфлоу — **рефакторить не нужно**.

3. **Биндинги (D1/DO/AI) в `process.env` НЕ попадают** — только через
   `getCloudflareContext().env` из `@flue/runtime/cloudflare`. → Единственная точка,
   которой нужен биндинг (D1), — новый store-адаптер.

4. **Ambient `invoke()` — кросс-таргетный** и не зависит от HTTP-роутов
   ([`routing.md`](../../node_modules/@flue/cli/docs/guide/routing.md),
   [`workflows.md`](../../node_modules/@flue/cli/docs/guide/workflows.md)).

5. **Flue-БД (`db.ts`) ≠ хранилище Mimir.** Flue хранит только собственное состояние
   рантайма (стримы диалогов, записи workflow-run); дедуп/comment-id/статистика —
   application-owned и требуют отдельного бэкенда на любом таргете
   ([`database.md`](../../node_modules/@flue/cli/docs/guide/database.md): «Application-owned
   business data ... Not stored by Flue»). На CF наш стор — это **D1**, а не Durable
   Object SQLite самого Flue.

6. **`Buffer`** (в [`memory.ts`](../../src/lib/memory.ts),
   [`repo-tools.ts`](../../src/lib/repo-tools.ts),
   [`project-context.ts`](../../src/lib/project-context.ts)) доступен на CF через
   `nodejs_compat`. Менять не нужно, но флаг обязателен.

### Стратегия внесения: два PR

Внесение в upstream двумя PR — так security-фикс доезжает до Docker-юзеров быстро,
а спорная для чужого репо часть про новый таргет едет отдельно и не блокирует первый PR.

- **PR #1 — «cleanup + security» (таргет-агностично, ценно само по себе).**
  `invoke()` вместо loopback + удаление публичных `POST /workflows/*` (**чинит
  реальную дыру:** сейчас эти роуты открыты без auth и позволяют триггерить ревью
  против любого доступного `GITHUB_TOKEN`-репо — жечь токены и постить комментарии);
  admin → `app.ts`; `process.exit` → `throw`. Всё проверяемо на Node, без Cloudflare.
- **PR #2 — «add Cloudflare target» (зависит от #1).** Async-стор + split node/d1 +
  D1 + `#app-store` + `wrangler.jsonc` + деп/скрипты + `.dev.vars.example` +
  D1-миграции + CF-тесты + доки (раздел «experimental» → полноценный, **Docker-нарратив
  не переписываем**).

### PR-гигиена (для upstream)

- **Ноль регрессий Docker** — hard gate. Общий код (канал, admin, стор-интерфейс)
  меняем так, чтобы Node-путь вёл себя идентично; каждый PR оставляет `node --test`
  зелёным.
- **Минимум build-магии.** `#app-store` — стандартная Node-фича (subpath imports с
  условием `workerd`), не кастом; в PR прикладываем документированный фолбэк (3.3) и
  показываем, что Node-бандл не тянет `node:sqlite` в CF.
- **Деп-гигиена.** `agents` — `optionalDependencies` (нужен только CF); `wrangler` —
  `devDependencies` (в прод-образ не попадает). Docker-пользователь не платит за CF.
- **Изоляция CF-специфики.** Всё Cloudflare-специфичное — в отдельных файлах
  (`dedup.d1.ts`, `wrangler.jsonc`, `.dev.vars.example`), а не размазано по общему коду.

---

## 1. Инвентаризация Node-специфичных точек

| Точка | Файл | Проблема на CF | Действие |
|-------|------|----------------|----------|
| `node:sqlite`, `node:fs`, `node:path` | [`dedup.ts`](../../src/lib/dedup.ts) | нет в workerd; нет ФС | **Раздел 3** — split node/D1 |
| `process.exit(1)` | [`channels/github.ts:25`](../../src/channels/github.ts) | нет процесса в изоляте | `throw` (**раздел 4**) |
| loopback self-POST + `INTERNAL_BASE_URL` | [`channels/github.ts`](../../src/channels/github.ts) | нет loopback-хоста | `invoke()` (**раздел 5**) |
| admin без `defineWorkflow` | [`workflows/admin.ts`](../../src/workflows/admin.ts) | нарушает контракт `workflows/` | → `app.ts` (**раздел 6**) |
| `node:buffer` / глобальный `Buffer` | memory/repo-tools/project-context | ок при `nodejs_compat` | без изменений |
| `process.env.*` | env/memory/repo-tools/workflows | ок при `nodejs_compat` + compat date | без изменений |

Октокит (`@octokit/rest`) — fetch-based, без Node-native зависимостей
(проверено по `package.json`: `@octokit/core/request/plugin-*`). `@flue/github`
— Fetch + WebCrypto, тестируется на workerd (см. `channels.md` §«Run on Node and
Cloudflare»). Отдельного порта не требуют — только e2e-проверка (**раздел 10**).

---

## 2. Целевая архитектура

```
                         ┌─────────────── Node/Docker target ───────────────┐
                         │  flue build --target node                        │
GitHub webhook ─► channel│  store: SqliteDedupStore (node:sqlite, ./data)   │
   │  (invoke)           │                                                  │
   ▼                     └──────────────────────────────────────────────────┘
 workflow DO (review/remember/feedback)
   │  getStore() ── "#app-store" ──►  выбор реализации по рантайму
   ▼                         ┌─────────────── Cloudflare target ────────────┐
 app-owned store             │  flue build --target cloudflare              │
 (dedup / comment / stats)   │  store: D1Store (env.DB, getCloudflareContext)│
                             │  each workflow → Durable Object (Flue)        │
                             └──────────────────────────────────────────────┘
```

Одна кодовая база; реализация стора выбирается **условным импортом по рантайм-условию
`workerd`** (раздел 3.3). Всё остальное (канал, воркфлоу, skills, octokit, Flue-рантайм)
— общее.

---

## 3. Хранилище: `node:sqlite` → интерфейс + две реализации (D1 + node)

Ключевое и самое ёмкое изменение. [`dedup.ts`](../../src/lib/dedup.ts) уже разделяет
**интерфейсы** (`DedupStore`, `SummaryCommentStore`, `ReviewRunStore`) и **реализацию**
(`SqliteDedupStore`) — это фундамент для двух бэкендов.

### 3.1. Async-ификация интерфейса (breaking, обязательно)

D1 — асинхронный API (`await stmt.run()`), поэтому синхронные сигнатуры больше
не подходят. Меняем интерфейсы на `Promise`-возвращающие:

```ts
export interface DedupStore {
  claim(deliveryId: string): Promise<boolean>;
  release(deliveryId: string): Promise<void>;
}
export interface SummaryCommentStore {
  getSummaryCommentId(prKey: string): Promise<number | undefined>;
  setSummaryCommentId(prKey: string, commentId: number): Promise<void>;
}
export interface ReviewRunStore {
  logReviewRun(record: Omit<ReviewRunRecord, "id" | "createdAt">): Promise<void>;
  getRecentRuns(limit?: number): Promise<ReviewRunRecord[]>;
  getStats(): Promise<{ totalRuns: number; totalCost: number; avgCost: number }>;
}
```

**Волна `await` по call-site'ам** (все существующие вызовы становятся `await`):
- [`channels/github.ts`](../../src/channels/github.ts): `getDedupStore().claim(...)`
  в 4 местах, `store.claim.bind` / `store.release.bind` в `handlePullRequestDelivery`.
- [`workflows/review-pr.ts`](../../src/workflows/review-pr.ts): `getReviewRunStore().logReviewRun(...)`.
- admin-дашборд (раздел 6): `getStats()` / `getRecentRuns()`.
- `handlePullRequestDelivery`: тип `deps.claim` → `(id) => Promise<boolean>`,
  `deps.release` → `(id) => Promise<void>`; `admit` теряет `requestUrl` (раздел 5).

### 3.2. Node-реализация (существующая, вынести в отдельный файл)

`src/lib/dedup.node.ts` — текущая `SqliteDedupStore`, `resolveDbPath`, `mkdirSync`,
`node:sqlite`. Методы становятся `async` (тело синхронное — просто оборачиваем в
`Promise`/`async`, т.к. `node:sqlite` синхронный). Экспортирует фабрику:

```ts
export function createStore(): DedupStore & SummaryCommentStore & ReviewRunStore {
  return new SqliteDedupStore(); // читает process.env.DATABASE_URL как сейчас
}
```

### 3.3. Кросс-рантайм выбор реализации: subpath imports с условием `workerd`

**Критично:** `import { DatabaseSync } from "node:sqlite"` не должен попадать в
CF-бандл (workerd не полифиллит `node:sqlite`). Решение — стандартный
Node subpath-import с условиями рантайма в `package.json`:

```jsonc
{
  "imports": {
    "#app-store": {
      "workerd": "./src/lib/dedup.d1.ts",   // Cloudflare
      "default": "./src/lib/dedup.node.ts"   // Node/Docker
    }
  }
}
```

- [`dedup.ts`](../../src/lib/dedup.ts) остаётся публичным фасадом: держит
  интерфейсы + типы (`ReviewRunRecord`) и фабрики `getDedupStore()/getSummaryCommentStore()/getReviewRunStore()`,
  которые берут `createStore` из `#app-store`. Импортёры (`../lib/dedup.ts`) не меняют
  путь импорта.
- Node резолвит `default` → `dedup.node.ts` (node:sqlite). Workerd/Vite резолвит
  `workerd` → `dedup.d1.ts`. Файл с `node:sqlite` **никогда** не входит в CF-граф.

> ⚠️ **Проверить при имплементации:** Flue собирает CF через Vite/Cloudflare-плагин.
> Нужно убедиться, что `workerd` присутствует в `resolve.conditions` CF-сборки
> (обычно Cloudflare Vite plugin его выставляет). Если нет — **фолбэк**: экспортировать
> `vite` из `flue.config.ts` с `resolve.conditions: ["workerd", ...]` для CF-режима,
> **или** пометить `node:sqlite` как external для CF-сборки (ветка node недостижима
> на CF, поэтому рантайм-ошибки не будет). Оба фолбэка дешёвые.

### 3.4. D1-реализация: `src/lib/dedup.d1.ts`

```ts
import { getCloudflareContext } from "@flue/runtime/cloudflare";
// интерфейсы/типы импортируем из dedup.ts (или общего dedup.types.ts, см. ниже)

class D1Store implements DedupStore, SummaryCommentStore, ReviewRunStore {
  #db() {
    // Биндинг резолвим per-op: getCloudflareContext() валиден только внутри
    // request/DO-хендлера (канал и workflow.run() — оба внутри контекста).
    const db = getCloudflareContext().env.DB as D1Database | undefined;
    if (!db) throw new Error("D1 binding `DB` is not configured (see wrangler.jsonc)");
    return db;
  }

  async claim(deliveryId: string): Promise<boolean> {
    const res = await this.#db()
      .prepare("INSERT OR IGNORE INTO deliveries (id, claimed_at) VALUES (?, ?)")
      .bind(deliveryId, Date.now())
      .run();
    return res.meta.changes === 1; // атомарно: 1 = заклеймили, 0 = уже было
  }
  // release / get|setSummaryCommentId / logReviewRun / getRecentRuns / getStats —
  // тот же SQL, что в node-версии, через .prepare().bind().run()/.all()/.first()
}

export function createStore() { return new D1Store(); }
```

Замечания:
- **Схему НЕ создаём на каждом запросе** (в отличие от node-версии с
  `CREATE TABLE IF NOT EXISTS` в конструкторе). Для D1 используем миграции
  (`wrangler d1 migrations`) — раздел 8.2.
- Кэш-синглтон стора допустим (биндинг стабилен в пределах изолята), но биндинг
  берём через `getCloudflareContext()` **на каждой операции**, т.к. контекст
  request-scoped. Оверхед пренебрежимо мал.
- `getCloudflareContext()` внутри `workflow.run()` (Durable Object) валиден
  ([`targets/cloudflare.md`](../../node_modules/@flue/cli/docs/guide/targets/cloudflare.md#getcloudflarecontext)).
  → **Проверить при имплементации**, что `env.DB` виден из DO воркфлоу (D1-биндинги
  доступны всем DO того же воркера — ожидаемо да).

### 3.5. Общие типы

Чтобы обе реализации и фасад не тянули друг друга по кругу, вынести чистые
интерфейсы/типы (`ReviewRunRecord`, три Store-интерфейса) в `src/lib/dedup.types.ts`.
`dedup.ts`, `dedup.node.ts`, `dedup.d1.ts` импортируют типы оттуда.

### 3.6. Типы D1

Добавить `@cloudflare/workers-types` в devDependencies (или использовать типы из
`wrangler`) для `D1Database`. Подключить в `tsconfig` (`types`/`compilerOptions`)
только для CF-путей либо через тройной slash-reference в `dedup.d1.ts`.

---

## 4. `process.exit(1)` → `throw`

[`channels/github.ts:21-26`](../../src/channels/github.ts): на CF нет процесса,
`process.exit` бессмыслен. Заменяем на проброс, чтобы модуль падал при загрузке
(изолят не поднимется = fail-closed, эквивалент текущему поведению на Node):

```ts
try {
  validateEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  throw err; // было: process.exit(1)
}
```

На Node проброс из top-level модуля канала так же валит старт сервера. Поведение
«не стартовать при отсутствии секрета» сохраняется на обоих таргетах.

> Заметка: `validateEnv()` на CF выполняется при инициализации изолята (top-level
> импорта канала). `process.env` к этому моменту популяризирован из secrets
> (при `nodejs_compat` + свежем compat date). → **Проверить при имплементации**;
> если на конкретной версии рантайма top-level `process.env` окажется пустым,
> перенести `validateEnv()` в ленивую проверку на первом запросе.

---

## 5. Admission: loopback self-POST → ambient `invoke()`

### 5.1. Что удаляем из [`channels/github.ts`](../../src/channels/github.ts)

- `resolveAdmitBase()` + `LOOPBACK_HOSTNAMES` (loopback-guard).
- `admitReview` / `admitFeedback` / `admitRemember` (три `fetch`-обёртки на
  смонтированные роуты).
- зависимость от `INTERNAL_BASE_URL`.

### 5.2. Что вводим

Импортируем **default-экспорты** воркфлоу и вызываем ambient `invoke()`:

```ts
import { invoke } from "@flue/runtime";
import reviewPr from "../workflows/review-pr.ts";
import rememberPr from "../workflows/remember-pr.ts";
import feedbackPr from "../workflows/feedback-pr.ts";

async function admitReview(pr: ReviewPayload) {
  const { runId } = await invoke(reviewPr, { input: pr });
  console.log("[mimir] review admitted", { ...pr, runId });
}
// аналогично admitRemember/admitFeedback
```

- `invoke()` admit'ит durable-ран и **сразу** возвращает `{ runId }` без ожидания —
  свойство «webhook отвечает быстро» сохраняется (GitHub ждёт 2xx ~10s).
- Работает на обоих таргетах; на CF адресует DO воркфлоу.
- `handlePullRequestDelivery(deps, deliveryId, pr)` — убрать параметр `requestUrl`;
  `deps.admit` теперь `(pr) => Promise<void>`.

### 5.3. Роуты воркфлоу: убрать `route`-экспорты

Единственным потребителем HTTP-роутов `POST /workflows/*` был loopback self-call.
С `invoke()` он не нужен → **удалить** `export const route = ...` из
[`review-pr.ts`](../../src/workflows/review-pr.ts),
[`remember-pr.ts`](../../src/workflows/remember-pr.ts),
[`feedback-pr.ts`](../../src/workflows/feedback-pr.ts).

Воркфлоу остаются discovered (default `defineWorkflow`) и на CF по-прежнему
получают DO-класс; `route`/`runs` — опциональная HTTP-экспозиция, на discovery и
на `invoke()` не влияет. **Плюс безопасности:** воркфлоу больше нельзя дёрнуть
внешним POST — только через верифицированный канал.

### 5.4. Правки env/доков

- `env.ts`: удалить `INTERNAL_BASE_URL` из `EnvSchema`.
- `.env.example`, README-таблица, DEPLOY.md (строка troubleshooting про
  `INTERNAL_BASE_URL`) — вычистить.

### 5.5. Тесты канала

[`channels/__tests__/github.test.ts`](../../src/channels/__tests__/github.test.ts):
- удалить блок тестов `resolveAdmitBase` (5 кейсов loopback);
- `handlePullRequestDelivery`: `claim` → async, сигнатура без `requestUrl`,
  `admit` → `(pr) => Promise`.

---

## 6. Admin-дашборд: `workflows/admin.ts` → роут в `app.ts`

### 6.1. Проблема

[`workflows/admin.ts`](../../src/workflows/admin.ts) лежит в `workflows/`, но
экспортирует только `route`, без default `defineWorkflow`. Контракт папки
([`workflows.md`](../../node_modules/@flue/cli/docs/guide/workflows.md): «its default
export must be the value returned by `defineWorkflow()`») нарушен — это существующая
проблема (не CF-специфичная).

> ⚠️ **Проверить при имплементации** на Node ≥22.18: возможно, текущая сборка это
> уже терпит или ругается. В любом случае перенос снимает вопрос на обоих таргетах.
> (Локальный Node здесь 22.13.1 < минимума CLI 22.18 — `flue build` не запускался.)

### 6.2. Решение — `src/app.ts`

```ts
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { getReviewRunStore } from "./lib/dedup.ts";

const app = new Hono();

app.get("/admin", async (c) => {
  const store = getReviewRunStore();
  const stats = await store.getStats();       // теперь async (раздел 3.1)
  const runs = await store.getRecentRuns(20);
  return c.html(renderAdminHtml(stats, runs)); // тот же HTML, что сейчас
});

app.route("/", flue()); // все discovered-ресурсы (канал, воркфлоу) на корне
export default app;
```

- Перенести генерацию HTML в чистую функцию `renderAdminHtml()` (легко тестировать).
- Удалить `src/workflows/admin.ts`.
- **URL меняется:** `/workflows/admin` → `/admin` (**одобрено мейнтейнером**; эндпоинтом
  ещё никто не пользуется — менять безопасно). Обновить README (раздел «Admin
  endpoint») и DEPLOY.
- `app.route("/", flue())` сохраняет пути каналов/воркфлоу как есть
  (`/channels/github/webhook` и т.д.).

### 6.3. Безопасность публичного `/admin` (важно для CF)

На Docker `/admin` за реверс-прокси; на CF воркер публичен (`*.workers.dev`) —
дашборд со стоимостью/статистикой окажется открыт в интернет. **Рекомендация:**
опциональный гейт `ADMIN_TOKEN`:
- если `ADMIN_TOKEN` задан — требовать `Authorization: Bearer <token>` (иначе 401);
- если не задан — вести себя как сейчас (открыто), чтобы не ломать Docker-совместимость.

Добавить `ADMIN_TOKEN` (optional) в `env.ts`, `.env.example`, `.dev.vars.example`,
доки. Альтернатива на CF — Cloudflare Access перед воркером (упомянуть в DEPLOY).

> **Решено:** `ADMIN_TOKEN` опционален; дефолт (открыто без токена) сохраняет текущее
> поведение Docker. Жёсткий обязательный гейт не вводим.

---

## 7. `wrangler.jsonc` (корень проекта)

Flue при сборке читает корневой `wrangler.jsonc` и **мерджит** свои сгенерированные
`FLUE_*` DO-биндинги. Мы авторим: имя, compat, миграции (перечисляя сгенерированные
классы — это как раз наша ответственность) и **application-owned** биндинги (D1).

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "mimir",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "FlueRegistry",
        "FlueReviewPrWorkflow",
        "FlueRememberPrWorkflow",
        "FlueFeedbackPrWorkflow"
      ]
    }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "mimir", "database_id": "<из wrangler d1 create>" }
  ]
}
```

- `FlueRegistry` — внутренний DO Flue (индекс ранов), включаем всегда.
- Имена классов воркфлоу выведены из имён файлов: `review-pr.ts` → `FlueReviewPrWorkflow`
  (биндинг `FLUE_REVIEW_PR_WORKFLOW`), и т.д. **Канал DO-класс не порождает**
  (только `agents/` и `workflows/`).
- **admin убран из `workflows/`** (раздел 6) → его класса в миграциях нет.

> ✅ **Подтверждено (2026-07-01, `flue build --target cloudflare`):** генерируются ровно
> `FlueRegistry`, `FlueReviewPrWorkflow`, `FlueRememberPrWorkflow`, `FlueFeedbackPrWorkflow`
> — список выше финальный. Дополнительно сейчас генерируется временный `FlueAdminWorkflow`
> (admin ещё в `workflows/`); после переноса admin → `app.ts` (раздел 6) он исчезает.
>
> ⚠️ **Правило миграций:** при будущих изменениях не переписывать/не переупорядочивать
> уже задеплоенные записи; новые воркфлоу добавлять новым `tag` через `new_sqlite_classes`.
> Перед фиксацией всегда сверять имена с `dist/mimir/wrangler.json`.

> `nodejs_compat` — обязателен (Flue-рантайм использует Node-API). `compatibility_date`
> ≥ 2025-04-01 нужен для популяции `process.env` из secrets; берём свежий `2026-06-01`
> (как в доках Flue) или новее.

---

## 8. Провижининг ресурсов, секреты, миграции D1

### 8.1. Секреты

- **Локально (CF dev):** `.dev.vars` рядом с `wrangler.jsonc`:
  ```
  OPENROUTER_API_KEY="..."
  GITHUB_WEBHOOK_SECRET="..."
  GITHUB_TOKEN="..."
  ```
  Плюс опциональные (`MODEL_*`, `POST_NITS`, `ADMIN_TOKEN`, ...).
  Создать **`.dev.vars.example`** (аналог `.env.example`).
- **Прод:** `wrangler secret put OPENROUTER_API_KEY` (и остальные), либо в CI
  `wrangler deploy --secrets-file <path>`.
- `.gitignore` / `.dockerignore`: добавить `.dev.vars*` (Docker-образ их не должен
  включать; `.env.*` уже игнорируется), а также CF-артефакты сборки `.flue-vite*` и
  `.wrangler/` (создаются `flue build --target cloudflare`; сейчас НЕ игнорируются —
  подтверждено 2026-07-01).
- Правило Cloudflare: при наличии `.dev.vars` значения `.env` **не** грузятся в
  локальные биндинги воркера — использовать что-то одно. Docker-путь продолжает
  жить на `.env`.

### 8.2. D1: создание и схема

```bash
wrangler d1 create mimir            # получить database_id → в wrangler.jsonc
```

Схему держим в миграциях D1 (а не `CREATE TABLE` на каждом запросе). Директория
`migrations/` (или `d1/migrations/`) c `0001_init.sql`, где три таблицы из
[`dedup.ts`](../../src/lib/dedup.ts): `deliveries`, `pr_summaries`, `review_runs`
(тот же DDL). Применение:

```bash
wrangler d1 migrations apply mimir            # прод
wrangler d1 migrations apply mimir --local    # локальная dev-БД
```

> Node-путь остаётся на `CREATE TABLE IF NOT EXISTS` в конструкторе (файловый SQLite),
> D1-путь — на явных миграциях. Дублирование DDL минимально; при желании вынести DDL
> в общую константу и переиспользовать в обоих (node применяет в конструкторе, D1 —
> генерирует `0001_init.sql`).

---

## 9. `package.json`, скрипты, зависимости

### 9.1. Зависимости

- **optionalDependencies:** `agents` (Cloudflare Agents SDK, `^0.14.2` — нужен только
  CF-таргету; Flue проверяет наличие durability-API в рантайме). Кладём в
  `optionalDependencies` (а не `dependencies`), чтобы Docker-пользователи не тянули
  Cloudflare-SDK впустую.
- **devDependencies:** `wrangler`, `@cloudflare/workers-types` (типы `D1Database`),
  `vitest` + `@cloudflare/vitest-pool-workers` (тесты D1-стора в workerd — раздел 11).

> `agents` не импортируется в Node-бандл; `optionalDependencies` — чтобы он не
> ставился обязательным грузом у Docker-пользователей.

### 9.2. Скрипты (добавить CF-варианты, Node оставить)

```jsonc
{
  "dev": "flue dev --target node",
  "build": "flue build --target node",
  "dev:cf": "flue dev --target cloudflare",
  "build:cf": "flue build --target cloudflare",
  "deploy:cf": "wrangler deploy --config dist/mimir/wrangler.json",
  "cf:dry-run": "wrangler deploy --dry-run --config dist/mimir/wrangler.json",
  "typecheck": "tsc --noEmit",
  "test": "node --test 'src/**/*.test.ts'",
  "test:cf": "vitest run",     // workerd-тесты стора
  "lint": "oxlint",
  "format": "oxfmt"
}
```

### 9.3. `imports`

Добавить блок `"imports": { "#app-store": {...} }` из раздела 3.3.

### 9.4. `flue.config.ts`

Оставить `target: "node"` (дефолт Docker-пути). CF-режим — через `--target cloudflare`
в скриптах. При необходимости фолбэка из 3.3 — добавить сюда экспорт `vite` с
`resolve.conditions` (но только если проверка покажет необходимость).

---

## 10. Развёртывание Cloudflare-пути и деплой

```bash
# 1. Провижининг
wrangler d1 create mimir              # database_id → wrangler.jsonc
wrangler d1 migrations apply mimir    # схема

# 2. Секреты (прод)
wrangler secret put OPENROUTER_API_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_TOKEN
# опционально: MODEL_*, POST_NITS, ADMIN_TOKEN, ...

# 3. Сборка + сухой прогон + деплой
flue build --target cloudflare
wrangler deploy --dry-run --config dist/mimir/wrangler.json
wrangler deploy --config dist/mimir/wrangler.json
```

- Webhook Payload URL: `https://mimir.<subdomain>.workers.dev/channels/github/webhook`.
- **Требуется Workers Paid plan** (Durable Objects) — уже отмечено в DEPLOY.md.
- Локальная проверка: `flue dev --target cloudflare` (порт 3583), прогнать
  тестовый webhook (см. раздел 11 e2e).

---

## 11. Тестирование

| Слой | Инструмент | Что покрываем |
|------|-----------|---------------|
| Чистая логика (diff, ignore, escalation, memory, security-paths, instruction) | `node --test` (как сейчас) | без изменений — рантайм-агностично |
| Node-стор (`dedup.node.ts`) | `node --test` (`:memory:`) | существующие кейсы дедупа/comment-id/stats |
| **D1-стор (`dedup.d1.ts`)** | **`@cloudflare/vitest-pool-workers`** | claim-атомарность, upsert comment-id, агрегаты stats в workerd + тестовый D1-биндинг |
| Канал (`handlePullRequestDelivery`) | `node --test` | обновить под async `claim`/`admit` без `requestUrl` |
| Сборка CF | CI-шаг | `flue build --target cloudflare` + `wrangler deploy --dry-run` |
| E2E | ручной / CI | реальный webhook → `invoke()` → ран → комментарии; проверка подписи `@flue/github` и octokit в workerd |

- `node --test` не может проверять DO/D1 — поэтому для D1-стора отдельный
  vitest-pool-workers конфиг с `d1_databases` в тест-биндингах.
- E2E-цель — эмпирически подтвердить workerd-совместимость `@flue/github`
  (Fetch+WebCrypto верификация подписи) и octokit-путей, а не «по докам».

---

## 12. Документация

- **DEPLOY.md:** переписать раздел «Cloudflare Workers» — убрать «experimental» и
  «known limitation про `node:sqlite`»; расписать D1 (create + migrations), секреты
  (`.dev.vars` vs `wrangler secret`/`--secrets-file`), DO-миграции, Paid plan,
  различие хранилищ Docker (файловый SQLite) vs CF (D1). Удалить troubleshooting-строку
  про `INTERNAL_BASE_URL`.
- **README:** таблица конфигурации — убрать `INTERNAL_BASE_URL`, добавить `ADMIN_TOKEN`
  (опц.), отметить, что на CF хранилище — D1 (`DB`-биндинг), а `DATABASE_URL` —
  только Node/Docker; поправить URL admin `/workflows/admin` → `/admin`; упомянуть
  два таргета в «Design notes».
- **`.dev.vars.example`** — новый файл.
- Эта спека — источник истины по процессу.

---

## 13. План работ: два PR (фазы и порядок)

Внесение двумя PR (см. «Стратегия внесения» в разделе 0). Порядок минимизирует
«сломано между шагами»: сперва таргет-агностичные улучшения (проверяемы на Node,
ценны сами по себе), затем CF-специфика.

**Фаза 0 — тулчейн** (общая): Node ≥22.18/≥23.6 (у мейнтейнера — 22.23.1, ✅ `flue build`
проходит). Внимание: неинтерактивные шеллы/CI могут по умолчанию брать другую nvm-версию
(в этом окружении дефолт был 22.13.1 < минимума) — зафиксировать версию через `.nvmrc`
и `engines`, чтобы CI не собирал на старой.

### PR #1 — cleanup + security (таргет-агностично, проверяемо на Node)

- [ ] `invoke()` вместо loopback; убрать `route` у воркфлоу; вычистить `INTERNAL_BASE_URL` (раздел 5)
- [ ] admin → `app.ts` (URL `/workflows/admin` → `/admin`, одобрено), удалить `workflows/admin.ts`, вынести `renderAdminHtml()` (раздел 6)
- [ ] `process.exit` → `throw` (раздел 4)
- [ ] обновить тесты канала; `node --test` зелёный; Docker-путь без регрессий

> В PR #1 стор остаётся синхронным (node:sqlite как есть). Async-ификация — в PR #2,
> где она мотивирована появлением D1. Канал/admin из-за этого получают `await` во
> втором PR (мелкий двойной тач call-site'ов — осознанный размен ради чистого
> нарратива PR #1: «без новой инфры, чистое улучшение + security»).

### PR #2 — Cloudflare target (зависит от #1)

- [ ] **Async-стор:** async-ификация интерфейсов + волна `await` (раздел 3.1)
- [ ] **Split:** `dedup.types.ts`, `dedup.node.ts`, фасад `dedup.ts`, `#app-store` (разделы 3.2–3.3, 3.5)
- [ ] **D1:** `dedup.d1.ts`, типы D1 (разделы 3.4, 3.6)
- [ ] **CF-конфиг:** `wrangler.jsonc`, `agents`(optional)/`wrangler`/типы, CF-скрипты, `.dev.vars.example`, `.gitignore`/`.dockerignore` (разделы 7, 9)
- [ ] **Провижининг:** `wrangler d1 create`, `migrations/0001_init.sql`, секреты; синхронизировать имена DO-классов из `dist/*/wrangler.json` в миграции (разделы 8, 7)
- [ ] **Тесты CF:** vitest-pool-workers для D1-стора; CI dry-run (раздел 11)
- [ ] **Верификация:** `flue dev --target cloudflare` + реальный webhook e2e; `wrangler deploy --dry-run`; деплой
- [ ] **Доки:** DEPLOY.md (раздел «experimental» → полноценный, Docker-нарратив не трогаем), README, `.dev.vars.example` (раздел 12)

---

## 14. Открытые вопросы / проверить при имплементации

Оставшиеся пункты — эмпирические проверки в момент кодинга, **не** продуктовые
развилки (те закрыты).

1. **`workerd`-условие в Vite-сборке CF** (3.3) — резолвится ли `#app-store` в
   `dedup.d1.ts`; иначе фолбэк (`resolve.conditions` или external `node:sqlite`).
2. **`getCloudflareContext().env.DB` внутри `workflow.run()`** (3.4) — доступность
   D1-биндинга из DO воркфлоу (ожидаемо да).
3. **`process.env` на top-level изолята** для `validateEnv()` (4) — если пусто на
   конкретной версии рантайма, перенести валидацию в первый запрос.

### Проверено эмпирически (2026-07-01, Node 22.23.1)

- **`flue build --target node`** — проходит; **`node --test` — 78/78 зелёные** (baseline PR #1).
- **Генерируемые DO-классы** (снято из `flue build --target cloudflare`):
  `FlueRegistry`, `FlueReviewPrWorkflow`, `FlueRememberPrWorkflow`, `FlueFeedbackPrWorkflow`
  — совпадают с разделом 7. Плюс временно `FlueAdminWorkflow` (admin — файл в `workflows/`);
  после переноса admin → `app.ts` этот класс исчезает, список миграций сходится к четырём.
- **Контракт `workflows/admin.ts`** — сборка НЕ ругается на отсутствие `defineWorkflow`
  (Flue терпит файл только с `route`). Значит перенос — не баг-фикс, а чистка + устранение
  лишнего `FlueAdminWorkflow` на CF.
- **CF-сборка требует пакет `agents`** — падает с `Rolldown failed to resolve import "agents"`
  до его установки (подтверждает раздел 9). Дальше сборка доходит до генерации DO-классов.

**Закрытые развилки:** таргеты — Docker recommended + CF additive (мейнтейнер одобрил
устно); admin-URL `/workflows/admin` → `/admin` (одобрено, ещё не используется);
admin-auth — опциональный `ADMIN_TOKEN` (дефолт открыто, как в Docker); внесение —
двумя PR.
