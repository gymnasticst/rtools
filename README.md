# RTools CLI

RTools — CLI-агент для программирования: интерактивная сессия в терминале,
одноразовый режим `exec`, подключение любых провайдеров моделей, плагины через
MCP и скиллы.

## Установка и запуск

```bash
curl -fsSL https://raw.githubusercontent.com/gymnasticst/rtools/main/install.sh | sh
```

Требуется Node 22+. Обновление: `rtools --update`.

Локальная разработка:

```bash
npm link        # делает команду rtools доступной глобально
rtools          # интерактивная сессия
rtools exec "объясни Makefile"   # one-shot режим
```

## Основные флаги

```
rtools chat <промпт>      интерактивная сессия (по умолчанию)
rtools exec <промпт>      one-shot запуск
--approval <mode>         untrusted | never | always
--profile <name>          профиль из [profile.<name>]
--add-dir <dir>           дополнительная доступная на запись папка (можно повторять)
--update                  обновление до последнего релиза
```

## Конфигурация

`~/.rtools/config.toml` (глобально) и `./.rtools/config.toml` (проект,
перекрывает глобальный):

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

## Что умеет агент

- Запуск команд shell (с песочницей: read-only / workspace / danger).
- Чтение, запись и правка файлов, поиск по содержимому и по маске, fetch URL.
- Патчи и план работы (`update_plan`), веб-поиск (`tools.web_search = true`).
- Инструменты всех подключённых MCP-серверов и плагинов.

## Скиллы

Каталоги `~/.rtools/skills/<name>/SKILL.md` и `./.rtools/skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: Что делает скилл
---
Инструкции скилла...
```

## Плагины

```bash
rtools plugin install <name>      # например linear, slack, stripe, github
rtools plugin marketplace add owner/repo   # свой маркетплейс
```

## Slash-команды в сессии

`/help /init /review /plan /model /provider /policy /sandbox /tools /skills
/status /diff /compact /resume /settings /permissions /clear /quit`
