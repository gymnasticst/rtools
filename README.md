# RTools CLI

RTools — CLI-агент для программирования: интерактивная сессия в терминале, one-shot режим `exec`, подключение любых провайдеров моделей (OpenAI-совместимых, включая Anthropic wire API), инструменты через MCP-серверы и скиллы.

[![CI](https://github.com/gymnasticst/rtools/actions/workflows/ci.yml/badge.svg)](https://github.com/gymnasticst/rtools/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.1.12-blue)
![Node](https://img.shields.io/badge/node-%E2%89%A522-blue)

## Содержание

- [Установка](#установка)
- [Быстрый старт](#быстрый-старт)
- [Флаги CLI](#флаги-cli)
- [Конфигурация](#конфигурация)
- [Провайдеры моделей](#провайдеры-моделей)
- [Возможности агента](#возможности-агента)
- [Безопасность и песочница](#безопасность-и-песочница)
- [MCP-серверы и плагины](#mcp-серверы-и-плагины)
- [Скиллы](#скиллы)
- [Slash-команды в сессии](#slash-команды-в-сессии)
- [Разработка](#разработка)
- [Лицензия](#лицензия)

## Установка

```bash
curl -fsSL https://raw.githubusercontent.com/gymnasticst/rtools/main/install.sh | sh
```

Требуется Node 22+. Скрипт ставит бинарь в `~/.local/bin` (меняется через `RTOOLS_PREFIX` или `--prefix`), конкретную версию можно зафиксировать: `install.sh --version vX.Y.Z`.

Обновление: `rtools --update`.

Локальная разработка:

```bash
git clone https://github.com/gymnasticst/rtools && cd rtools
npm install
npm link        # делает команду rtools доступной глобально
```

## Быстрый старт

```bash
rtools                          # интерактивная сессия (по умолчанию)
rtools exec "объясни Makefile"  # one-shot запуск без UI
```

При первом запуске создайте `~/.rtools/config.toml` (см. ниже) и задайте ключ провайдера в переменной окружения, указанной в `env_key`.

## Флаги CLI

```
rtools [chat] [промпт]    интерактивная сессия (по умолчанию)
rtools exec "<промпт>"    one-shot запуск без интерфейса
--approval <mode>         untrusted | never | always
--profile <name>          профиль из [profile.<name>]
--add-dir <dir>           дополнительная доступная на запись папка (можно повторять)
--update                  обновление до последнего релиза
--version, --help         версия и справка
```

## Конфигурация

Файлы: `~/.rtools/config.toml` (глобально) и `./.rtools/config.toml` (проект, перекрывает глобальный):

```toml
model = "gpt-5.1"
model_provider = "openai"
approval_policy = "untrusted"   # untrusted | never | always

[model_providers.myprovider]    # любой OpenAI-совместимый сервис
name = "My Provider"
base_url = "https://my-endpoint.example.com/v1"
env_key = "MY_API_KEY"          # переменная окружения с API-ключом
wire_api = "chat"               # chat | responses | anthropic

[profile.fast]                  # rtools --profile fast
model = "gpt-5.1-mini"

[mcp_servers.filesystem]        # MCP-сервер: инструменты у агента
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

## Провайдеры моделей

Любой сервис с OpenAI-совместимым API: достаточно `[model_providers.<name>]` с `base_url`, `env_key` и `wire_api` (`chat`, `responses` или `anthropic`). MCP-серверы с OAuth авторизуются локально: агент поднимает callback-сервер на порту 14778 и ждёт код не дольше 5 минут (переопределяется `RTOOLS_OAUTH_CODE_TIMEOUT_MS`).

## Возможности агента

- Запуск команд shell (с песочницей: read-only / workspace / danger; в Linux — bubblewrap, при его отсутствии fail-closed).
- Чтение, запись и правка файлов (пути строго внутри рабочей директории), поиск по содержимому и по маске, fetch URL с защитой от SSRF.
- Применение патчей (`apply_patch`), планирование работы (`update_plan`), веб-поиск (`tools.web_search = true`, на один вызов можно запросить 1–10 результатов через `max_results`).
- Read-only инструмент `git` (status/diff/log/show/branch/blame/rev-parse; изменяющие команды отклоняются).
- Инструменты всех подключённых MCP-серверов и плагинов.
- Сессии: хранятся последние 50 (`RTOOLS_MAX_SESSIONS`), `/resume last` открывает самую свежую.

## Безопасность и песочница

Режимы approval: `untrusted` (спрашивать перед непроверенными командами), `never`, `always`. Режимы песочницы переключаются в сессии командой `/sandbox`. Запись и правка файлов ограничены рабочей директорией (доп. папки — `--add-dir`), `fetch` повторно проверяет цель после каждого редиректа (включая IPv6 и частные/метаданные-хосты), патчи — только внутри рабочей директории.

## MCP-серверы и плагины

```bash
rtools plugin install <name>                 # например linear, slack, stripe, github
rtools plugin marketplace add owner/repo     # свой маркетплейс скиллов и плагинов
```

## Скиллы

Каталоги `~/.rtools/skills/<name>/SKILL.md` и `./.rtools/skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: Что делает скилл
---
Инструкции скилла...
```

## Slash-команды в сессии

`/help /init /review /plan /model /provider /agent /policy /sandbox /prompts /tools /skills /status /diff /export /compact /resume /settings /effort /verbosity /permissions /usage /stats /smartroute /todos /goal /cron /share /summary /wiki /worktree /remote /language /vim /jobs /undo /checkpoints /trace /copy /find /paste /edit /clear /quit`

`/export [file]` сохраняет сессию в Markdown (чат и вызовы инструментов) — по умолчанию `rtools-session-<id>.md`. При приближении к лимиту контекстного окна (`context_window`, по умолчанию 128k) сессия ужимается автоматически — вручную вызывать `/compact` не нужно.

### Работа с задачами и файлами

```
/usage                    токены (вход/выход) и оценка стоимости за сессию
/stats [days]            статистика по сессиям (токены, стоимость, время) из ~/.rtools/usage.jsonl
/smartroute on|off|simple <model>|strong <model>   авто-роутинг: простые реплики — на дешёвую модель ([smart_routing] в config.toml)
/todos                   список задач, который агент ведёт сам (инструмент todo_write)
/goal <текст>|clear|done  долгоживущая цель сессии: видна агенту в каждом шаге, прогресс — инструментом goal_status
/cron add <имя> <cron> <промпт>|rm|list   запланированные задачи (5 полей), запускаются пока открыт REPL
/share [файл]            выгрузить диалог в markdown
/summary [файл]          структурное саммари сессии (запросы, инструменты, файлы)
/wiki [каталог]          вики по репозиторию: страница на раздел исходников
/worktree enter <имя>|exit <имя>|list     изоляция задачи в git worktree (.rtools-worktrees/)
/remote use <user@host>|exit   shell-инструмент выполняет команды по ssh на удалённой машине
/language en|ru          язык сообщений интерфейса
/vim                     vim-режим ввода (normal/insert, motions w/b/0/$, операторы d/c/y/p)
/undo                     вернуть файл к состоянию до последней правки агента
/checkpoints              список чекпоинтов файлов этого проекта
/jobs start <имя> <cmd>   фоновая задача (тесты, сборка, сервер), переживёт шаг
/jobs [status] /jobs logs <имя> /jobs stop <имя>
/trace on|off             JSONL-лог шагов и инструментов в ~/.rtools/logs
/copy                     последний ответ агента в буфер обмена
/find <текст>             поиск по расшифровке сессии
/paste                    многострочный ввод, завершение строкой "."
/edit                     длинный промпт в $EDITOR (Ctrl+G — то же)
@путь/к/файлу             инлайн содержимого файла в промпт (до 3 файлов)
```

Перед каждой правкой агент сохраняет чекпоинт файла в `~/.rtools/checkpoints`, поэтому `/undo` работает даже вне git. `Ctrl+C` прерывает текущий шаг агента/команду, а не всю сессию.

### Подтверждение с диффом

Перед write/edit/apply_patch показывается unified diff изменений (для shell — команда целиком). Ответы: `y` — разрешить, `n` — отказать, `a` — разрешить этот инструмент до конца задачи, `A` — разрешить всё до конца сессии.

### Провайдеры, модели, агенты

Управление из TUI, выбор сохраняется в `~/.rtools/config.toml`:

```
/model <имя>              сменить модель (или saved-алиас)
/model list               модели провайдера из API + saved-алиасы
/model add <алиас> <id>   сохранить алиас модели
/model rm <алиас>         удалить алиас

/provider <id>            сменить провайдера (built-in или свой)
/provider list            список провайдеров
/provider add <id> <base_url> [env_key] [wire_api]   свой провайдер (wire_api: chat | responses | anthropic)
/provider rm <id>         удалить своего провайдера

/agent list               профили-агенты из [profile.*] в config.toml
/agent add <имя>          сохранить текущие model+provider+effort+verbosity как профиль
/agent use <имя>          применить профиль (модель, провайдер, размышление, verbosity)
/agent rm <имя>           удалить профиль

/effort low|medium|high   тип размышления (сохраняется в конфиг)
```

## Интерфейс (TUI)

Ответы агента рендерятся с Markdown-подсветкой: жирные заголовки, затемнённые блоки кода с рамкой, цветной инлайн-код и буллеты. Цвета отключаются автоматически при пайпе в другой процесс, через `NO_COLOR=1` или `theme = "plain"` в конфиге; `theme` принимает `plain` или цветовую тему по умолчанию.

### Палитра команд и настройки (как в OpenCode)

- **Ctrl+P** — командная палитра: поиск по всем slash-командам, стрелки/Enter — выполнить, Esc — отмена. Пункт «Open settings» открывает настройки.
- **Ctrl+O** — список настроек: все параметры из `config.toml` (модель, провайдер, approval, sandbox, effort, verbosity, temperature, top_p, лимиты токенов, тема, tools и др.). У enum-настроек выбор из вариантов, у toggle — переключение Enter, числа вводятся текстом (`off` = сброс к дефолту).
- После изменения настройка спрашивает «Сохранить в `~/.rtools/config.toml`?» — да сохраняет на диск, нет действует только для сессии. Настройки с пометкой «live» применяются к текущей сессии сразу, остальные — со следующего запуска.
- То же самое доступно командой `/palette`. Ctrl+P открывает единый лаунчер: slash-команды и `@файлы` репозитория в одном поиске.

### Агентные возможности

- **Фоновые задачи** — инструмент `job` (start/status/logs/stop) и `/jobs`: тесты и серверы больше не блокируют шаг.
- **Параллельная команда агентов** — инструмент `team`: 2–4 роли (research/implement/review) работают параллельно с независимым контекстом, отчёты объединяются.
- **Чекпоинты и `/undo`** — каждая правка файла откатывается.
- **Хуки** — `[hooks] pre_tool` / `post_tool` в config.toml: shell-команды на каждый вызов инструмента (ненулевой exit у pre_tool блокирует вызов).
- **Учёт стоимости** — usage из ответов провайдера, `/usage`; цена считается только при заданном `model_pricing`.
- **Новые инструменты агента** — `todo_write` (задачи хода), `monitor` (фоновая команда с пробуждением по паттерну вывода, до 30 мин), `lsp` (hover/definition/references/symbols через установленный language server), `memory` (память проекта с авто-извлечением фактов и лексическим поиском), `goal_status` (прогресс цели).
- **Smart routing** — простые реплики автоматически уходят на дешёвую модель (эвристика: длина, код-блоки, ключевые слова), `[smart_routing]` в config.toml, `/smartroute`.
- **Автокомпакция** — при заполнении контекста (~80%) предупреждение, ~92% — автоматическое сжатие диалога перед следующим ходом.
- **Кастомные кейбиндинги** — `[keybindings]` в config.toml: palette, settings, multiline_editor, copy_last (зарезервированный Ctrl+C переназначить нельзя).
- **`view_image`** — модель может смотреть локальные изображения (`tools.view_image`).
- **Устойчивость цикла** — ретраи при обрыве стрима, прерывание Ctrl+C, лимит шагов сообщает «continue», а не роняет сессию; `/trace` пишет JSONL-лог шагов.

## Разработка

```bash
npm test    # весь тестовый прогон (tests/mcp-proxy.test.mjs)
```

CI (`.github/workflows/ci.yml`) гоняет `npm test` на каждый push в `main` и на PR; релизы — по git-тегам (`.github/workflows/release.yml`). Структура кода: `bin/` — точки входа, `src/` — ядро (агент, инструменты, песочница, MCP, сессии, TUI, конфиг), `tests/` — тесты.

Баги и предложения — через [Issues](https://github.com/gymnasticst/rtools/issues), правки — через Pull Request (см. [CONTRIBUTING.md](CONTRIBUTING.md)).

## История версий

- `v0.1.12` — Fix silent approval bypass in delegate sub-agents (2026-11-25)

- `v0.1.11` — fix(jobs): lines=0 clamp actually clamps; signal whole process group so trapped TERM and children are handled; regression tests (2026-11-25)

- `v0.1.10` — fix(security,jobs): team sub-agents honor session approval policy; graceful SIGTERM for jobs; clamp job log lines (2026-11-25)

- `v0.1.9` — feat(agent): wave 1-3 — diff approvals, checkpoints/undo, background jobs, team agents, hooks, usage, view_image, interrupts, tracing (2026-11-25)

- `v0.1.8` — ci: bump checkout/setup-node to v5 and action-gh-release to v3 (Node 24 runtime) (2026-11-25)

- `v0.1.7` — fix(release): human-readable release notes instead of commit list (2026-11-25)

- `v0.1.6` — feat(tui): OpenCode-style command palette (Ctrl+P) and settings screen (Ctrl+O) (2026-11-25)

- `v0.1.5` — feat(repl,config): provider/model/agent management in TUI, persistent /effort (2026-11-25)

- `v0.1.4` — feat(tui): markdown streaming highlight, plain/color themes (NO_COLOR, theme=plain) (2026-11-25)

- `v0.1.3` — feat(repl,session,web-search): /export markdown, auto-compact near context window, web_search max_results (2026-11-25)

- `v0.1.2` — feat(release): auto-release on every push to main (version bump, install.sh, README changelog) (2026-11-25)

Каждый пуш в `main` автоматически бампает patch-версию, публикует релиз (тарбол и SHASUMS) и обновляет версию в `install.sh` и в этом README.

## Лицензия

[Apache-2.0](LICENSE)
