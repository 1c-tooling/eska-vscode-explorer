# Разработка и проверка расширения

[Пользовательское руководство](../README.md) · [Упаковка VSIX](packaging.md)

## Разработка

Зависимости закреплены в `bun.lock`: TypeScript 7.0.2, API VS Code 1.109.0,
типы Node 22.20.5. Зависимости обновлены 2026-10-25; Bun — 1.4.4.
Production-код работает в Node Extension Host. `yauzl` 3.4.0, `vscode-languageclient`
11.0.0 и их зависимости включаются в bundle через esbuild 0.28.2; npm modules из checkout
установленному VSIX не нужны. Bun используется для инструментов проекта.

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

### Windows PowerShell

Проверки выполняются в Node Extension Host. Для интеграционных сценариев нужны
собранные `eska-project.exe`, `eska-fmt.exe` и, для языковых функций,
`bsl-analyzer-app.exe`. Каталог playground должен существовать рядом с репозиториями.

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run --bun check
bun run --bun compile
$env:ESKA_TEST_ROOT = (Resolve-Path ../eska-playground).Path
$env:ESKA_TEST_BINARY = (Resolve-Path ../eska/target/debug/eska-project.exe).Path
$env:ESKA_TEST_FMT_BINARY = (Resolve-Path ../eska/target/debug/eska-fmt.exe).Path
node --test --test-concurrency=2 test/*.test.mjs
bun run --bun package
```

Для нативной проверки задайте `VSCODE_EXECUTABLE` абсолютным путём к `Code.exe`,
а `VSCODE_CLI_JS` — к его `resources/app/out/cli.js`. В поставках с каталогом
версии `resources` находится внутри этого каталога. Runner вызывает CLI через
Electron с `ELECTRON_RUN_AS_NODE=1`, а окно IDE запускает отдельно.

```powershell
$env:VSCODE_EXECUTABLE = 'C:/Tools/VSCode/Code.exe' # путь вашей установки
$env:VSCODE_CLI_JS = 'C:/Tools/VSCode/resources/app/out/cli.js' # путь вашей установки
$env:ESKA_TEST_VSIX = (Resolve-Path ./eska-explorer-0.1.5.vsix).Path
$env:ESKA_HOST_LOCALE = 'en'
node test/run-host.mjs test/extension-host.cjs
```

`VSCODE_EXECUTABLE` должен указывать на executable, а не на `code.cmd`.
Для `ru` нужен `ESKA_HOST_LANGUAGE_PACK_VSIX` с русским language pack:
runner установит его в приватный профиль и проверит фактическую локаль IDE.
Для webview-сценариев задайте свободный локальный `ESKA_HOST_DEBUG_PORT`.
Файловые алиасы проверяются через directory junction без прав на создание symlink.
Освобождение backend предшествует удалению его временных каталогов.
Нативные UI-профили запускайте последовательно: окна разделяют OS focus,
поэтому параллельный запуск нарушает проверки QuickPick и dirty-close.
Регистрация language pack подтверждается отдельным read-only startup probe;
тестовый сценарий начинается только в требуемой фактической локали.

Клиент query RPC находится в `src/query/`: планы исходников используют API 1.13,
общее восстановление — API 1.14, устойчивые сессии — API 1.16. Рабочий адаптер
запрашивает 1.33. После явного ответа о поддержке более ранней версии из диапазона
1.12–1.32 подключение согласует доступные capabilities. Пакетная индикация
поддержки использует `supportObjects` из 1.25; без неё сохраняется прежняя
адресная проверка. Обратная навигация и
поиск BSL-владельца требуют `sourceNavigation` из 1.24; клиентского обхода
Designer XML или файлового fallback нет.
Предварительная проверка executable требует минимальный контракт дерева 1.12.
`query/open` всегда получает точный текст и версию редактора: дисковый BOM
не добавляется к `TextDocument.getText()`. Снимок приложения и снимок generated
analyzer config — разные контракты.

`QueryDocument` хранит неизменяемую привязку владельца. Query RPC не повторяются
автоматически после смены поколения метаданных. Большие owner/draft передаются
последовательными UTF-8 chunks по 128 KiB с SHA-256; handles освобождаются также
после отмены и ошибок. План проверяется по диапазонам UTF-8/UTF-16 и хэшу полного
результата до передачи редактору. Клиент не записывает XML/BSL и не запускает
анализатор. Вкладки, сохранение и восстановление T101 проверяются отдельно.
До выделения документа адаптер обрабатывает накопленные файловые события
и ограниченно повторяет только чтение владельца, если между запросами
сменились generation/eventSequence. Создание документа, сессии и изменения
исходников этот retry не охватывает.

Форматирование использует API 1.33 и отдельный `eska-fmt`. Text-only соединение
проходит только initialize, без workspace/open; query-черновик использует процесс
своей source-сессии и подтверждённый checkpoint. Провайдеры анализатора
document/range/on-type не регистрируются. `test/formatting*.test.mjs` проверяют
контракт, Unicode, ограничения, native version/cancellation и реальный процесс;
`test/formatting-host.cjs` — VSCodium, Undo/Redo, сохранение, BOM/CRLF и защиту.

`QueryRecovery` передаёт четыре компонента checkpoint в общий backend:
metadata, полный owner, исходный запрос и черновик. Неизменённые owner/base
переиспользуются по подтверждённым длинам и hashes. Запросы сериализованы в один
upload; быстрая серия правок заменяет pending-текст, сохраняя последний.
Формат файла, квоты, atomic replace, сравнение revision и проверка private
каталога принадлежат Rust. `create` отделён от `save`: запоздалое обновление
закрытой сессии не создаёт checkpoint заново.

Recovery endpoint привязан к экземпляру процесса, без `sessionId` и generation.
Он появляется после initialize и остаётся доступным при ошибке открытия manifest.
Перед остановкой процесса `Connection.beforeStop` дожидается записей. Замена
backend сохраняет прежние подтверждённые revisions: новое окно не выдаёт себе
право перезаписать чужой checkpoint. Закрытия чистых вкладок при отключении
удаляются после подключения с той же проверкой revision. Доменная модель сессии,
временная защита, проверка конфликтов и разрешение Apply принадлежат ESKA.
Адаптер управляет нативными вкладками и применяет проверенный план через Undo/Redo.
BSL Apply включён; он возвращает изменённый несохранённый модуль.

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska/../eska-playground)" \
node --test test/query-client.test.mjs test/query-integration.test.mjs test/query-recovery.test.mjs
```

Процессные проверки включают совместимость 1.12, отмену после выделения handle,
обрыв загрузки и смену поколения. Настоящий backend проверяет обе локали,
dirty XML больше лимита inline, наборы СКД и union, несколько ручных списков,
отсутствие фиктивного автоматического запроса, карты, no-op, планы и внешний
конфликт; файлы создаются только в собственном каталоге playground.
[Результаты клиентской части T101 и нативного save-прототипа](measurements/t101-query-client.json).

Для физического стиля новых строк `QueryDocument.plan` принимает четвёртым
аргументом `{lineEnding: "lf" | "crlf", signal?}`; перед отправкой проверяется
`queryEditing.editorLineEndings`. Стиль берётся из `TextDocument.eol` владельца.
Чистый XML-запрос остаётся LF; CRLF не добавляется к SDBL для управления XML.
Нативная проверка в development host сопоставляет хэш и projected map с реально
изменённым буфером для LF, CRLF и первого перевода строки, затем проверяет BOM:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska/../eska-playground)" \
ESKA_HOST_SUPPORT_DISABLED=1 VSCODE_EXECUTABLE=codium \
node test/run-host.mjs test/query-eol-host.cjs
```

Этот тест использует скомпилированный клиент из checkout; готовые вкладки
и установленный VSIX им не принимаются. Для VS Code замените `codium` на `code`.

`src/query/tabs.ts` предоставляет `eska-query:` и одну сессию на XML-владельца.
`query/recovery.ts` атомарно хранит снимок владельца и обе ревизии SDBL вне
проекта; очередь объединяет ожидающие записи. Открытие и сохранение используют
короткоживущие backend documents, свежие policy/контекст и отдельный хэш
дескриптора. Ошибка не запускает перезапись владельца дисковой копией.

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska/../eska-playground)" \
ESKA_TEST_VSIX="$(realpath ./eska-explorer-0.1.5.vsix)" \
ESKA_HOST_SUPPORT_DISABLED=1 ESKA_HOST_RESTART=1 \
ESKA_HOST_LOCALE=en VSCODE_EXECUTABLE=codium \
node test/run-host.mjs test/query-modal-restore-host.cjs
```

Два обычных запуска установленного VSIX используют один приватный профиль.
Первый оставляет дочерний запрос с сохранённым checkpoint, второй проверяет
восстановление без автоматического применения, блокировку родителя, явное
продолжение, возврат несохранённого BSL и единичный Undo.
Исторический `query-tabs-host.cjs` относится к контракту до модальной замены
родителя: его ожидание одновременного dirty XML и дочернего запроса не является
текущей UI-приёмкой. Сохранение XML, внешние конфликты и сравнение снимков
проверяет `query-modal-host.cjs`, реальные решения Save/Discard/Cancel —
`query-modal-normal-host.cjs` с `ESKA_HOST_NORMAL=1`.
`ESKA_HOST_LOCALE=ru` проверяет фактическую русскую UI-локаль. Для нового профиля
передайте `ESKA_HOST_LANGUAGE_PACK_VSIX` с абсолютным путём к совместимому
русскому языковому пакету. Runner установит его только в приватный профиль
и выполнит отдельный обычный запуск для регистрации переводов. Этот запуск
не считается проверкой ru; оба последующих сценария требуют фактический `ru`.
`ESKA_TEST_VSIX` включает тот же сценарий на установленном пакете;
скрытые модули checkout ему не нужны.

Исторический прототип T102 проверяет публичные команды session-readonly на clean/dirty,
split и повторно открытом native-документе. Это наблюдение API, а не приёмка
готового BSL-редактора:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_HOST_GLOBAL_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_HOST_SUPPORT_DISABLED=1 VSCODE_EXECUTABLE=codium \
node test/run-host.mjs test/query-lock-host.cjs
```

`query-lock-restart-host.cjs` с `ESKA_HOST_RESTART=1` запускается в обычном
development host, внутри первого запуска перезапускает настоящий Extension Host,
затем наблюдает отдельный запуск окна. `passed` означает завершённое наблюдение;
значения `builtinWritableBypassesSessionLock`, `resetClearsPreexistingSessionReadonly`
и `nativeHotExitRetainedOwner` нужно оценивать отдельно. Проверенные способы
ещё не обеспечивают снятие только собственной блокировки с сохранением прежнего
session override пользователя. Пустой `TextEditor.edit`, native `FileStat`
и `isWritableFileSystem` прежний режим не определяют. После перезапуска host
session-readonly сохраняется; автоматическая очистка не является свойством
самой команды. В быстром закрытии development host native hot exit не сохранил
dirty-буфер. Эти прототипы описывают прежние ограничения API, а не текущее
состояние T102. В действующей реализации ESKA хранит проверенный снимок,
а адаптер заменяет вкладки родителя дочерним редактором после нативного решения
Save / Don't Save / Cancel.

`query-lock-overrides-host.cjs` проверяет ещё два исходно редактируемых режима:
наследование пользовательских настроек и явный native Writeable. Проверенные
getter-поля в них совпадают. После временной блокировки Reset теряет прежний
Writeable, а принудительный Writeable теряет наследование будущего read-only
настройки. Это контрпримеры двух вариантов очистки, а не доказательство
невозможности любого публичного механизма. Тест временно меняет только
`files.readonlyInclude` собственного workspace в приватном профиле и в конце
восстанавливает исходные bytes settings; исходник и права ОС остаются прежними.
Запуск аналогичен первому прототипу с заменой имени сценария.

Текущая приёмка модальности — `query-modal-host.cjs`; настоящие решения
Save / Don't Save / Cancel и сохранность native read-only проверяет
`query-modal-normal-host.cjs` с `ESKA_HOST_NORMAL=1` и свободным
`ESKA_HOST_DEBUG_PORT`. Для установленного пакета задайте `ESKA_TEST_VSIX`.
Прежний `query-bsl-host.cjs` ожидает редактируемого dirty-родителя одновременно
с запросом и несовместим с принятым модальным контрактом. Он сохранён как
исторический сценарий и не заменяет эти две проверки.

Интеграционная проверка использует существующий бинарник CLI и создаёт только
собственный временный каталог внутри соседнего `eska-playground`:

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
node --test test/integration.test.mjs test/tree.test.mjs test/search.test.mjs
```

Дополнительный `ESKA_LEGACY_TEST_BINARY` указывает на прежнюю полную CLI
для проверки явного legacy и отсутствия автоматического fallback.
Для native legacy-профиля задайте также `ESKA_TEST_BACKEND=legacy`.
Без `ESKA_TEST_BINARY` тесты реального backend пропускаются; unit/process tests остаются
обязательными. Сборка/выгрузка 1С не запускается. Для ручного запуска после
компиляции: `code --extensionDevelopmentPath="$PWD" <папка-проекта>`.

Для автоматической проверки нативного дерева в установленном VS Code/VSCodium
нужен рабочий графический сеанс. Тест создаёт отдельный профиль и проект в
playground, проверяет XML/BSL, клавиатурное сворачивание, сохранение выделения,
внешние изменения, повреждение/восстановление XML и смену manifest:

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
VSCODE_EXECUTABLE=codium bun run test:host
```

Отдельный нативный сценарий фильтра (без команд клавиатурного фокуса):

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/filter-host.cjs
```

Сценарий иконок проверяет четыре темы, вложенные элементы и уровни масштаба:

```bash
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
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
и отключение с проверкой дочерних процессов. Дополнительная
[серия Windows 11 / Microsoft VS Code](windows-validation.md) выполнена
2026-10-29–31. macOS и Remote требуют отдельной проверки;
полная матрица приёмки относится к T81.

## Релизы

Версии, changelog и GitHub Release готовятся автоматически через release PR
с помощью Knope и Bun. Схема, разрешения GitHub и ограничения описаны
в [инструкции релизов](releases.md).

## Устройство

- `protocol.ts`, `framing.ts`: валидация wire-ответов и Content-Length framing.
- `process.ts`: bounded queues, таймауты, stdout/stderr и завершение своего child.
- `connection.ts`: handshake, один discovery context, защита от устаревших ответов.
- `tree.ts`: ленивые ветви, стабильные идентификаторы и проверка поколений/событий.
- `reveal.ts`: один `metadata/revealSource` и выбор UI-строки из готового пути ESKA.
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

Для замера обратной навигации используйте оптимизированный backend:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/dist/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" node test/reveal-performance.mjs
```

Стенд создаёт только собственные проекты на 100, 2 000 и 10 000 объявлений,
делает пять подключений и по 31 переходу. Первый переход измеряется с пустым
деревом адаптера; запуск процесса и `workspace/open` уже завершены. Вывод JSONL
содержит время, число RPC и удерживаемых узлов; отрисовка VS Code не измеряется.
Нативную команду и сохранность dirty-буфера проверяет `source-navigation-host.cjs`:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/dist/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" VSCODE_EXECUTABLE=codium \
node test/run-host.mjs test/source-navigation-host.cjs
```

`ESKA_HOST_PROJECT_TYPE` выбирает configuration, extension, processing или report;
`ESKA_TEST_VSIX` запускает тот же сценарий из установленного пакета.

Проверка прямого открытия модулей, вложенности сервисов и источников формы
в нативном Extension Host:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/presentation-host.cjs
```

На Linux/VSCodium проверены семь объектов с прямым открытием BSL, шесть видов
вложенных элементов, подписи источников формы RU/EN и удаление модуля через
файловый watcher. Дополнительная Windows-проверка описана в
[отчёте](windows-validation.md); macOS и Remote требуют отдельной приёмки.

Нативная проверка предопределённых данных:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/predefined-host.cjs
```

## Проверка файлов рабочей области

`test/workspace-files.test.mjs` проверяет разделение общих/проектных файлов,
исключение исходников, ленивое чтение, инвалидацию снимков и циклы ссылок.
Нативный сценарий использует собственный workspace с двумя проектами:

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
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


## Вкладки свойств и вложенные значения

`properties.test.mjs` проверяет DTO, обе локали, исходные токены и точные
диапазоны XML. `property-layout.test.mjs` проверяет выбор раскладки без потери
дополнительных полей, поиск и независимость состояния от перевода подписей.
`properties-view.test.mjs` проверяет запоздавшие ответы и клики по старым
снимкам, обновление скрытых вкладок, восстановление после ошибки и число
запросов при переключении фокуса. Действие XML содержит ревизию показанного
снимка; перерисовка дерева без изменения backend-токенов не перечитывает данные.
Модуль `resources/properties/model.mjs` входит в VSIX; архив проверяется
`scripts/check-vsix.py`.

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/properties-host.cjs

ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/properties-layout-host.cjs
```

Приёмка 2026-09-29: 96 Node-тестов с backend, native VSCodium 1.109.5.
Через CDP в изолированном host проверены список 38 возможностей, RU/EN,
поиск по подписи и токену, раскрытие после refresh/смены языка и отсутствие
горизонтального переполнения узкой вкладки. XML-действие выделяет исходный
токен после отображения перевода. Проверка ограничена Linux.

### Открытие свойств по клику

`tree.test.mjs` проверяет выбор свойств у объекта с группой «Модули» при
нуле, одном и нескольких BSL-файлах. Общие модули открывают свой BSL;
объекты без доступного кода открывают свойства. `event-handler.test.mjs`
проверяет сохранение перехода к процедуре подписки на событие.

`extension-host.cjs` проверяет команды реальных узлов: корень, справочники,
реквизит, общий модуль и объект только с двоичным модулем. Проверяются повторное
использование вкладки, свойства общего модуля через контекстное меню и точный
переход к XML. `presentation-host.cjs` покрывает прямое открытие кода сервисов,
команд и перерасчётов, открытие свойств общих форм и форм объектов по названию,
а также их XML/BSL через дочерние узлы. Для справочника и регистра проверяется,
что объект с видимой группой «Модули» открывает свойства. `predefined-host.cjs`
проверяет свойства предопределённых элементов и их XML.

Повторная приёмка форм на Linux/VSCodium 1.109.5: 97 Node-тестов и полный
`presentation-host.cjs` из рабочей копии прошли. При запуске из VSIX проверки
свойств двух видов форм, групп модулей и прямого открытия кода прошли, но затем
сценарий остановился на ожидании события файлового наблюдателя. События внешних
изменений в этом стенде доставляются нестабильно; полный прогон установленного
пакета для данного уточнения поведения форм не подтверждён.

### Проверка после ревью свойств

В ревью 2026-09-29 прошли TypeScript и 103 Node-теста. В установленном VSIX
прошли `properties-host.cjs` и `properties-layout-host.cjs`: отдельные вкладки,
заголовки и язык, переводы вложенных значений, булевы флаги, строковая маска `false`,
явный `xsi:type` с другим XML-префиксом и точный переход к исходнику.
Булевы подсказки поступают из backend; неизвестные и пользовательские строки
не превращаются во флажки по одному совпадению текста.

Повтор `presentation-host.cjs` из VSIX остановился на `native source watcher
is ready` после успешных проверок открытия форм и модулей. Нестабильность
нативных файловых событий остаётся неподтверждённой частью приёмки; её причина
не установлена. Детерминированные проверки обновления вкладок выполняются
в `properties-view.test.mjs`, независимо от файлового наблюдателя VSCodium.


## Установщик компонентов T85

`src/tooling/` содержит контракты, bounded probes/downloads, ZIP и транзакции
T97, независимые состояния двух компонентов и UI. `test/tool-inspection.test.mjs`,
`test/tool-installation.test.mjs` проверяют настоящие бинарники, совместные
receipt и lock с Python CLI, malformed ZIP, rollback и отмену.
`test/tool-setup.test.mjs` проверяет отдельные интервалы/настройки, ручную отмену,
выбранный компонент, custom paths и сохранение приостановки клиента.

```sh
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_ANALYZER_BINARY=/absolute/path/bsl-analyzer-app \
node --test test/tool-*.test.mjs
```

`test/native-tooling-install.mjs` требует также `ESKA_TEST_PROJECT_ARCHIVE`
(абсолютный путь к component ZIP T97), скачивает официальный Analyzer и оставляет
собственный изолированный стенд с `report.json`. Установка и native probes
выполняются при пустом PATH. Полный монолит не вызывается.
Для двух нативных индикаторов запустите `test/run-host.mjs test/tool-status-host.cjs`
с теми же binary variables и `VSCODE_EXECUTABLE=codium`; `ESKA_TEST_VSIX`
переводит проверку на код установленного пакета.

## Языковой клиент T86

`src/language/` владеет контекстом из Metadata API, config lease, LSP-клиентом
и единственным дочерним процессом. Остановка и отмена проверяются настоящими
процессами; [описание и команды](language-service.md#проверка).
Обычные tree-профили runner отключают свой LSP. Для языковых профилей задайте
`ESKA_TEST_LANGUAGE=1` и абсолютный `ESKA_TEST_ANALYZER_BINARY`.
`ESKA_TEST_PYTHON` нужен только сценарию отмены с управляемым тестовым wrapper,
он не является зависимостью расширения.

## Конфликт расширений T87

С binary variables из T86, `ESKA_TEST_LANGUAGE=1`, `ESKA_HOST_SUPPORT_DISABLED=1`
и `VSCODE_EXECUTABLE=codium`:

```sh
ESKA_HOST_ENABLE_EXTENSIONS=1 ESKA_HOST_CONFLICT_FIXTURE=initial \
  node test/run-host.mjs test/language-conflict-host.cjs
ESKA_HOST_ENABLE_EXTENSIONS=1 ESKA_HOST_CONFLICT_FIXTURE=initial \
  ESKA_HOST_CONFLICT_RELOAD=1 \
  node test/run-host.mjs test/language-conflict-reload-host.cjs
ESKA_BSL_EXTENSION=/absolute/path/to/bsl-analyzer-extension \
  ESKA_BSL_BINARY="$ESKA_TEST_ANALYZER_BINARY" \
  node test/run-host.mjs test/language-foreign-host.cjs
```

Первому сценарию нужен также `ESKA_TEST_PYTHON`: он задерживает настоящий config
validator тестовым wrapper. `conflict-fixture.mjs` создаёт и локально упаковывает
собственное неактивное расширение с известным ID в каталоге runner. Fixture
проверяет публичные install/uninstall и реестр, не содержит чужого движка.
Три запуска reload-профиля используют один extensions-dir и startup-флаг
`--disable-extension` только во втором запуске. Внутренние disable-команды
и хранилище редактора не используются. Последний профиль отдельно проверяет
реальное стороннее расширение и его процесс; учёт PID использует Linux `/proc`.
`ESKA_TEST_VSIX` включает проверку установленного пакета.
