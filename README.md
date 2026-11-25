# RTools CLI

RTools — CLI-агент для программирования: интерактивная сессия в терминале, one-shot режим `exec`, подключение любых провайдеров моделей (OpenAI-совместимых, включая Anthropic wire API), инструменты через MCP-серверы и скиллы.

[![CI](https://github.com/gymnasticst/rtools/actions/workflows/ci.yml/badge.svg)](https://github.com/gymnasticst/rtools/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.1.4-blue)
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

`/help /init /review /plan /model /provider /policy /sandbox /prompts /tools /skills /status /diff /export /compact /resume /settings /effort /verbosity /permissions /clear /quit`

`/export [file]` сохраняет сессию в Markdown (чат и вызовы инструментов) — по умолчанию `rtools-session-<id>.md`. При приближении к лимиту контекстного окна (`context_window`, по умолчанию 128k) сессия ужимается автоматически — вручную вызывать `/compact` не нужно.

## Интерфейс (TUI)

Ответы агента рендерятся с Markdown-подсветкой: жирные заголовки, затемнённые блоки кода с рамкой, цветной инлайн-код и буллеты. Цвета отключаются автоматически при пайпе в другой процесс, через `NO_COLOR=1` или `theme = "plain"` в конфиге; `theme` принимает `plain` или цветовую тему по умолчанию.

## Разработка

```bash
npm test    # весь тестовый прогон (tests/mcp-proxy.test.mjs)
```

CI (`.github/workflows/ci.yml`) гоняет `npm test` на каждый push в `main` и на PR; релизы — по git-тегам (`.github/workflows/release.yml`). Структура кода: `bin/` — точки входа, `src/` — ядро (агент, инструменты, песочница, MCP, сессии, TUI, конфиг), `tests/` — тесты.

Баги и предложения — через [Issues](https://github.com/gymnasticst/rtools/issues), правки — через Pull Request (см. [CONTRIBUTING.md](CONTRIBUTING.md)).

## История версий

- `v0.1.4` — feat(tui): markdown streaming highlight, plain/color themes (NO_COLOR, theme=plain) (2026-11-25)

- `v0.1.3` — feat(repl,session,web-search): /export markdown, auto-compact near context window, web_search max_results (2026-11-25)

- `v0.1.2` — feat(release): auto-release on every push to main (version bump, install.sh, README changelog) (2026-11-25)

Каждый пуш в `main` автоматически бампает patch-версию, публикует релиз (тарбол и SHASUMS) и обновляет версию в `install.sh` и в этом README.

## Лицензия

[Apache-2.0](LICENSE)
