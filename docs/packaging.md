# Установочный VSIX

Пакет `1c-tooling.eska-explorer` устанавливается в VS Code ≥ 1.109.0.
Версия берётся из `package.json`; первый опубликованный релиз — `0.0.1`. Версию меняет существующая release automation. VSIX не содержит backend eska.

## Установка

Скачайте VSIX из Assets нужного [GitHub Release](https://github.com/1c-tooling/eska-vscode-explorer/releases).

1. Установите совместимый `eska ide --stdio` с IDE API 1.0 отдельно. Для всех иконок
   нужен backend с `Node.metadataKind`; исходный CLI 0.10.0 без IDE недостаточен.
   Для проверки текущей разработки подходит бинарник из ветки `feat/ide`,
   commit `5f2da24` или новее с сохранённым IDE API.
2. В меню Extensions выберите **Install from VSIX…**, укажите файл
   `eska-explorer-0.0.1.vsix` и при необходимости перезагрузите окно.
3. Укажите полный путь к backend в `eska.explorer.executable`, если он не в PATH.
4. Откройте доверенную папку с `eska.toml` и Designer XML; раскройте **eska: 1C Explorer**.
   [Настройка проекта](setup.ru.md). bsl-analyzer необязателен.

Также можно выполнить `code --install-extension /полный/путь/eska-explorer-0.0.1.vsix`.
Для VSCodium замените `code` на `codium`. Установка VSIX не регистрирует publisher
в Marketplace и ничего не публикует. В Remote backend должен находиться на машине
проекта; фактическая приёмка Remote пока не выполнена.

## Сборка пакета

Из корня репозитория расширения, с Bun 1.4.2 в PATH:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run package
python3 scripts/check-vsix.py eska-explorer-0.0.1.vsix
```

Закреплён официальный `@vscode/vsce` 4.0.0; компилятор и упаковщик запускаются через
Bun. `--no-dependencies` допустим, поскольку у расширения нет runtime dependencies;
backend устанавливается отдельно. При появлении такой зависимости пересмотрите
упаковку. `.vscodeignore` разрешает только runtime JS, NLS, документацию, LICENSE и SVG.
В пакет не входят node_modules, TS, тесты, карты исходников, стенды и Git-файлы.
`check-vsix.py` проверяет identity, ZIP CRC, полный список и байты ресурсов.

Расширение распространяется под [Apache-2.0](../LICENSE). Файл LICENSE включён
в VSIX, его наличие и содержимое проверяет `check-vsix.py`. GitHub Actions,
публикация, теги и версия этой командой не изменяются. Python нужен только для
проверки архива.

## Изолированная проверка установленного пакета

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/dist/eska)" \
ESKA_TEST_VSIX="$PWD/eska-explorer-0.0.1.vsix" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/icons-host.cjs
```

Runner создаёт свои fixture, профиль и каталог расширений внутри соседнего
`eska-playground`, устанавливает VSIX, проверяет список установленных расширений
и запускает код именно из установленного пакета. Только этот экземпляр загружается
в test mode для доступа к provider; production API не добавляется.
Пользовательский профиль не меняется; временные данные удаляются после проверки.
Тем же способом запускаются `test/filter-host.cjs` и `test/extension-host.cjs`.
Полный native-сценарий включает клавиатурное сворачивание. Для запуска в фоне
его Quick Pick в тесте имеет `ignoreFocusOut=true`; production-поведение не меняется.

Основание: [официальная инструкция упаковки VSIX](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
