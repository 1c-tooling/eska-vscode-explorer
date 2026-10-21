# Собственный языковой клиент

T86 подключает `vscode-languageclient` 10.1.2 к опубликованному
`bsl-analyzer-app` 0.3.2 по stdio. Backend project использует Metadata API 1.12;
TypeScript читает его DTO, без собственного разбора `eska.toml` и Designer XML.
Проверенная среда — Linux x64 GNU, VSCodium 1.109.5, Extension Host Node 22.21.1.

## Запуск и контекст

Подсветка BSL/SDBL, комментарии, скобки и отступы принадлежат Explorer и доступны
без анализатора. LSP запускается при первом открытии BSL либо командой
`eska.explorer.restartLanguage`, независимо от видимости дерева. Открытие только
дерева не создаёт конфиг и не запускает индексатор.

До запуска клиент получает контекст, проверяет бинарник, вызывает
`analyzer/configStatus`, `analyzer/configPrepare`, затем `analyzer/acquire`.
Сервер читает обычный `bsl-analyzer.toml` в корне контекста: флаг `--config`
команде `lsp` не передаётся. Конфликт пользовательского или изменённого
управляемого конфига останавливает запуск с объяснением. Для чужого конфига
используется явная миграция ESKA с preview и сохранением оригинала.

`eska.explorer.selectAnalysisContext` запрашивает имя приложения из `eska.toml`;
проверку выполняет backend. При неоднозначности backend предоставляет список
для Quick Pick. Пустая строка использует его выбор по умолчанию. Успешный выбор
хранится в состоянии окна, без изменения манифеста. Параллельный multi-root
анализ не добавляется.

`eska.explorer.languageFeatures = false` останавливает собственный клиент,
сохраняя дерево и грамматики. Legacy backend без контракта конфигурации
объясняет недоступность LSP; ошибки языка не отключают сервер метаданных.
Индикатор Analyzer различает проверенный бинарник, подготовку, соединение,
ошибку и приостановку. Соединение не означает завершённую индексацию или
отсутствие диагностик.

## Возможности и границы

Проверены настоящие BSL hover, definition, document symbols, completion,
semantic tokens и диагностики несохранённого буфера. LSP получает настоящие
`file:` URI; содержимое на диске не заменяется тестовой правкой. Providers
чтения отбрасывают ответы после смены поколения клиента или версии документа.
Для отдельного `.sdbl` заявлена только TextMate-подсветка; семантическая
поддержка отдельного запроса этим этапом не подтверждена.

До T88 отключены format/range/on-type format, rename, code actions и преобразование
серверного WorkspaceEdit. Их включение требует проверки всех целей и атомарного
отказа по policy. Конфликт со сторонним расширением относится к T87, согласование
XML/BSL refresh, контекста и protected URI — к T88. Приёмка на `buhmfo` и сравнение
производительности относятся к T89. Это ещё не результат всей приёмки.

Опубликованный сервер не передаёт версию в push diagnostics. Проверка правки
и восстановления подтверждает конкретный сценарий, но не доказывает отсутствие
устаревших diagnostic при любых быстрых правках; это остаётся проверкой T88.

## Остановка

Каждая сессия владеет клиентом, процессом и config lease. При остановке сначала
завершается LSP и подтверждается выход его процесса, затем освобождается lease,
после чего можно закрывать Metadata API. Отмена подготовки обрабатывает и передачу
уже выданного lease: полученный идентификатор освобождается до нового старта.
Диалоги не удерживают очередь shutdown. Ожидания ограничены; при необходимости
сигналы направляются только созданному процессу. Автоматического цикла
перезапуска после ошибки нет. Бинарник и процессы стороннего клиента не трогаются.

## Проверка

Из checkout Explorer, с собранным соседним project и явным бинарником upstream:

```sh
export ESKA_TEST_ROOT="$(realpath ../eska-playground)"
export ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)"
export ESKA_TEST_ANALYZER_BINARY=/absolute/path/bsl-analyzer-app
export ESKA_TEST_LANGUAGE=1
export ESKA_HOST_SUPPORT_DISABLED=1
export VSCODE_EXECUTABLE=codium
node test/native-language-probe.mjs
node test/run-host.mjs test/grammar-host.cjs
node test/run-host.mjs test/language-host.cjs
ESKA_TEST_PYTHON="$(python3 -c 'import sys; print(sys.executable)')" \
  node test/run-host.mjs test/language-cancellation-host.cjs
```

Support policy в этих языковых профилях отключена явно: защита T88 здесь
не принимается. Runner использует собственные проект, профиль и extensions-dir
в `eska-playground`, после проверки удаляет их. Пользовательские расширения
не подключаются. `ESKA_TEST_VSIX=/absolute/path/package.vsix` включает установку
пакета и запуск именно его runtime. Нативная проверка грамматик использует
TextMate/Oniguruma текущего редактора. Raw LSP probe оставляет свой уникальный
стенд с отчётом для повторной проверки.

Unit/process tests входят в `node --test test/*.test.mjs` и `bun test`.
Результаты T86 и ограничения перечислены в
[отчёте проверки](measurements/t86-language.json).
