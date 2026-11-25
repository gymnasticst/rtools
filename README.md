# RTools CLI

RTools — собственный CLI-агент для программирования в стиле Codex CLI: интерактивная сессия,
режим `exec`, подключение любых провайдеров моделей, плагины через MCP и скиллы.

## Установка и запуск

```bash
# one-line install (как у Codex/OpenCode): в ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/YOUR_ORG/rtools/main/install.sh | sh

# конкретная версия / свой префикс:
curl -fsSL .../install.sh | sh -s -- --version v0.1.0 --prefix /usr/local/bin
```

Установщик ставит зависимый от Node 22+ лончер в `~/.local/bin/rtools`
(тарболл релиза → npm registry → git-репозиторий как фолбэки).
Релизы собирает `.github/workflows/release.yml` по тегу `v*`
(GitHub Release + npm publish).

Локальная разработка:

```bash
npm link          # делает команду rtools доступной глобально
rtools --help
rtools            # интерактивная сессия
rtools exec "explain the Makefile"   # one-shot режим
```

Провайдер по умолчанию — OpenAI (`OPENAI_API_KEY`), модель `gpt-5.1`.

## Конфигурация

`~/.rtools/config.toml` (глобально) и `./.rtools/config.toml` (проект, перекрывает глобальный):

```toml
model = "gpt-5.1"
model_provider = "openai"
approval_policy = "untrusted"   # untrusted | never | always

# Кастомный провайдер любого OpenAI-совместимого сервиса
[model_providers.myprovider]
name = "My Provider"
base_url = "https://my-endpoint.example.com/v1"
env_key = "MY_API_KEY"          # имя переменной окружения с API-ключом
wire_api = "chat"               # chat | responses | anthropic

# Ещё пример: Anthropic
[model_providers.anthropic]
wire_api = "anthropic"          # base_url и env_key уже встроены

# Профили: rtools --profile fast
[profile.fast]
model = "gpt-5.1-mini"

# MCP-сервер (плагин) — инструменты появляются у агента автоматически
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
```

## Провайдеры

Три типа wire-протоколов, покрывающие практически любой сервис:

| wire_api    | Протокол                          | Примеры                        |
|-------------|-----------------------------------|--------------------------------|
| `chat`      | OpenAI `/chat/completions` (SSE)  | OpenAI, vLLM, Ollama, OpenRouter, LiteLLM, Azure |
| `responses` | OpenAI `/responses`               | OpenAI Responses API           |
| `anthropic` | Anthropic `/v1/messages`          | Anthropic, прокси с этим API   |

## Встроенные инструменты

- `shell` — запуск команд (с песочницей read-only/workspace/danger)
- `read_file`, `write_file`, `edit` (точечная замена old→new), `ls`
- `grep` (regex по содержимому), `glob` (поиск файлов по маске), `fetch` (URL)
- `apply_patch` — патчи V4A-формата Codex
- `update_plan`, `skill`, `web_search` (при `tools.web_search = true`)
- Все инструменты подключённых MCP-серверов (имена `mcp__<server>__<tool>`)

## Скиллы

Каталоги `~/.rtools/skills/<name>/SKILL.md` и `./.rtools/skills/<name>/SKILL.md`.
Формат как у Codex-скиллов:

```markdown
---
name: my-skill
description: Что делает скилл
---
Инструкции скилла...
```

## Slash-команды в сессии

`/help /model /provider /policy /tools /skills /clear /quit`

## Дорожная карта

Готово (фаза 1): агентский цикл с тул-коллами, 3 wire-протокола, стриминг, MCP-клиент,
скиллы, политики подтверждения, config.toml, REPL + exec.

Готово (фаза 2): `apply_patch` (V4A-формат Codex), sandbox-режимы shell
(read-only / workspace / danger через bubblewrap, если установлен), инструмент
`update_plan` с рендером плана, автосохранение сессий в `~/.rtools/sessions`
и `/resume`, компакция контекста `/compact`, `/status`, `/diff`, `/sandbox`,
профили конфига `[profile.<name>]` + `--profile`.

Подключён РЕАЛЬНЫЙ Codex plugin marketplace: github.com/openai/plugins
(`.agents/plugins/marketplace.json`, манифесты `.codex-plugin/plugin.json`,
`.mcp.json`, каталог skills/). Установка: `rtools plugin install <name>`
(например linear, slack, stripe, superpowers, github); HTTP-MCP серверы
плагинов bridging к stdio через bin/rtools-mcp-proxy.js; скиллы плагина
попадают в ~/.rtools/skills и загружаются агентом. Свои маркетплейсы:
`rtools plugin marketplace add owner/repo`.

Дальше: TUI-рендер, изображения, внешние плагины-пакеты, FAAS-изоляция shell.
