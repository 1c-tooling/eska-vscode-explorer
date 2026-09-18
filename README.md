# eska: 1C Explorer

Расширение VS Code для навигации по метаданным 1С в формате Designer XML.
Работает через установленный `eska ide --stdio`; проект определяется по
обязательному `eska.toml`.

Сейчас реализована основа подключения (T76): выбор папки, проверка IDE API 1.0,
открытие проектов и участников workspace, журнал, отключение и перезапуск.
Дерево метаданных, поиск, открытие исходников, фильтр и иконки — следующие задачи
T77–T81. Публикации в Marketplace пока нет, publisher ещё не выбран.

В Explorer нет собственных BSL/SDBL languages, grammar, debugger, форматтера и
диагностики BSL. Расширение не требует bsl-analyzer и не меняет настройки других
расширений, `launch.json` или ассоциации файлов.

## Подключение

1. Откройте папку с `eska.toml` в доверенной рабочей области.
2. Установите совместимый backend eska отдельно. При необходимости укажите
   абсолютный путь в `eska.explorer.executable`; по умолчанию используется `eska`
   из PATH. Аргументы командной строки в этой настройке не поддерживаются.
3. Раскройте представление **eska: 1C Explorer** в проводнике VS Code.

Команды **eska Explorer** позволяют выбрать проект, перезапустить или отключить
подключение и открыть журнал. Из нескольких независимых папок VS Code выбирается
одна. Если это корень workspace eska, backend открывает его участников по
существующим правилам `eska.toml`. При переключении папки старый процесс сначала
завершается. Повторные попытки после ошибки выполняются по команде пользователя.

Если manifest отсутствует, показывается [инструкция настройки](docs/setup.ru.md).
Расширение не запускает `eska init` и не устанавливает executable автоматически.
Изменение настройки пути отключает прежнее подключение; затем используйте команду
перезапуска. Изменения manifest подхватываются при повторном подключении.
Наблюдение за исходниками и обновление дерева относятся к T77.

## Где работает backend

Минимальная версия VS Code API — **1.109.0**. Расширение объявлено как `workspace`:
в Remote SSH, WSL и Dev Containers требуется установить eska на соответствующей
машине/в контейнере. Настройка пути допускает отдельные значения для этих сред.
Виртуальные workspace и web extension host без Node не поддерживаются;
в недоверенной рабочей области расширение отключено.

UI лишь отображает результаты backend: парсер XML, каталог типов и кеш остаются
в eska. При открытии включён дисковый кеш backend. Источник никогда не сканируется
вторым индексатором на TypeScript.

## Разработка

Зависимости закреплены в `bun.lock`: TypeScript 7.0.2, API VS Code 1.109.0,
типы Node 22.20.3. Инструменты проверены 2026-09-18; Bun — 1.4.2.
Production-код не имеет npm runtime-зависимостей и исполняется в Node extension
host VS Code. Bun используется для инструментов проекта.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run --bun check
bun run --bun compile
bun test
```

Для проверки именно Node runtime после компиляции:

```bash
node --test test/*.test.mjs
```

Интеграционная проверка использует существующий бинарник CLI и создаёт только
собственный временный каталог внутри соседнего `eska-playground`:

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
node --test test/integration.test.mjs
```

Без `ESKA_TEST_BINARY` этот тест пропускается; unit/process tests остаются
обязательными. Сборка/выгрузка 1С не запускается. Для ручного запуска после
компиляции: `code --extensionDevelopmentPath="$PWD" <папка-проекта>`.

Проверки T76: Linux, Bun 1.4.2 и Node 22.23.1; реальные stdio-запросы к eska
проверяют четыре типа проектов, workspace из двух участников, ошибки manifest,
перезапуск и отсутствие оставшихся процессов. Smoke-test в Extension Host
VSCodium 1.109.5 (Node 22.21.1) подтвердил активацию, подключение, перезапуск
и отключение с проверкой дочерних процессов. Windows, macOS и Remote пока
не проверены в реальной среде; полная матрица приёмки относится к T81.

## Релизы

Версии, changelog и GitHub Release готовятся автоматически через release PR
с помощью Knope и Bun. Схема, разрешения GitHub и ограничения описаны
в [инструкции релизов](docs/releases.md).

## Устройство

- `protocol.ts`, `framing.ts`: валидация wire-ответов и Content-Length framing.
- `process.ts`: bounded queues, таймауты, stdout/stderr и завершение своего child.
- `connection.ts`: handshake, один discovery context, защита от устаревших ответов.
- `extension.ts`: нативное представление, выбор папки, команды и сообщения RU/EN.

Контракт находится в соседнем репозитории `eska`: `docs/ide-protocol.md`.
Решения API опираются на официальные [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host),
[Remote Development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
и [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).
