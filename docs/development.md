# Разработка и проверка расширения

[Пользовательское руководство](../README.md) · [Упаковка VSIX](packaging.md)

## Разработка

Зависимости закреплены в `bun.lock`: TypeScript 7.0.2, API VS Code 1.109.0,
типы Node 22.20.3. Инструменты проверены 2026-09-18; Bun — 1.4.2.
Production-код не имеет npm runtime-зависимостей и исполняется в Node extension
host VS Code. Bun используется для инструментов проекта.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run --bun check
bun run --bun compile
mkdir -p ../eska-playground
ESKA_TEST_ROOT="$(realpath ../eska-playground)" bun test
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
node --test test/integration.test.mjs test/tree.test.mjs test/search.test.mjs
```

Без `ESKA_TEST_BINARY` тесты реального backend пропускаются; unit/process tests остаются
обязательными. Сборка/выгрузка 1С не запускается. Для ручного запуска после
компиляции: `code --extensionDevelopmentPath="$PWD" <папка-проекта>`.

Для автоматической проверки нативного дерева в установленном VS Code/VSCodium
нужен рабочий графический сеанс. Тест создаёт отдельный профиль и проект в
playground, проверяет XML/BSL, клавиатурное сворачивание, сохранение выделения,
внешние изменения, повреждение/восстановление XML и смену manifest:

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska)" \
VSCODE_EXECUTABLE=codium bun run test:host
```

Отдельный нативный сценарий фильтра (без команд клавиатурного фокуса):

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/filter-host.cjs
```

Сценарий иконок проверяет четыре темы, вложенные элементы и уровни масштаба:

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/icons-host.cjs
```

Для VS Code используйте `VSCODE_EXECUTABLE=code`. Electron не скачивается.
В обычном CI этот графический тест не запускается; нужен установленный editor
и совместимый backend. Доступ к контроллеру дерева экспортируется только в
режиме тестового Extension Host и не является API расширения.

Проверки T76/T77: Linux, Bun 1.4.2 и Node 22.23.1; реальные stdio-запросы к eska
проверяют четыре типа проектов, workspace из двух участников, ошибки manifest,
перезапуск и отсутствие оставшихся процессов. Smoke-test в Extension Host
VSCodium 1.109.5 (Node 22.21.1) подтвердил активацию, подключение, перезапуск
и отключение с проверкой дочерних процессов. Windows, macOS и Remote пока
не проверены в реальной среде; полная матрица приёмки относится к T81.

## Релизы

Версии, changelog и GitHub Release готовятся автоматически через release PR
с помощью Knope и Bun. Схема, разрешения GitHub и ограничения описаны
в [инструкции релизов](releases.md).

## Устройство

- `protocol.ts`, `framing.ts`: валидация wire-ответов и Content-Length framing.
- `process.ts`: bounded queues, таймауты, stdout/stderr и завершение своего child.
- `connection.ts`: handshake, один discovery context, защита от устаревших ответов.
- `tree.ts`: ленивые ветви, стабильные идентификаторы и проверка поколений/событий.
- `icons.ts`, `resources/icons`: таблица видов/ролей и локальные SVG четырёх тем.
- `filter.ts`: фильтрация по состояниям backend и сохранение выбора каждого проекта.
- `search.ts`, `search-view.ts`: отменяемый поиск, прогресс индекса, проверяемый reveal и Quick Pick.
- `forms.ts`: ленивые узлы источников формы и кеш до изменения ветки.
- `source.ts`: source mapping, проверка существования/границ пути, UTF-8 → UTF-16 координаты.
- `watch.ts`: ограниченные пакеты файловых событий и наблюдение за manifest.
- `extension.ts`: нативное представление, выбор папки, команды и сообщения RU/EN.

Контракт находится в соседнем репозитории `eska`: `docs/ide-protocol.md`.
Решения API опираются на официальные [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host),
[Remote Development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
и [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).

Проверка прямого открытия модулей, вложенности сервисов и источников формы
в нативном Extension Host:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/presentation-host.cjs
```

Проверены Linux/VSCodium: семь объектов с прямым открытием BSL, шесть видов
вложенных элементов, подписи источников формы RU/EN и удаление модуля через
файловый watcher. Это не заменяет приёмку Windows/macOS/Remote.

Нативная проверка предопределённых данных:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/predefined-host.cjs
```

## Проверка файлов рабочей области

`test/workspace-files.test.mjs` проверяет разделение общих/проектных файлов,
исключение исходников, ленивое чтение, инвалидацию снимков и циклы ссылок.
Нативный сценарий использует собственный workspace с двумя проектами:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/workspace-host.cjs
```

Он проверяет открытие файлов, переход по горячей клавише, появление/удаление
README, язык групп, ancestry метаданных, шесть переключений Git-веток и
переподключение. Ветки создаются только внутри собственного fixture; второй
проект должен сохранить кеш. Сборка 1С не нужна.

## Управление глобальной CLI

`installation.ts` отвечает за поиск, handshake и проверку официальных релизов,
`backend-setup.ts` — за UI согласия, задачи установки и переподключение.
Нативный runner добавляет тестовую ESKA в начало отдельного PATH и отключает
фоновые обновления; пользовательская ESKA не меняется. `installation.test.mjs`
проверяет приоритет PATH, stable-only релизы, JSON update и capabilities.
`backend-setup.test.mjs` загружает скомпилированный UI-адаптер с фасадом VS Code
и проверяет согласие/отказ, быстрое завершение задачи, ошибку и переподключение.
Одинаковый набор из 57 тестов проверен в Node и Bun 1.4.2.

После ревью 2026-09-19: 68 Node-тестов с реальным backend; отдельно проверены
native shutdown и освобождение объектов за 20 подключений.
Новые сценарии и ограничения замеров описаны в [отчёте MVP](mvp-review-linux.md).
