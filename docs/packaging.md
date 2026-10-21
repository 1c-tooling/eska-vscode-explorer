# Установочный VSIX

Пакет `1c-tooling.eska-explorer` устанавливается в VS Code ≥ 1.109.0.
Версия берётся из `package.json`; первый опубликованный релиз — `0.0.1`. Версию меняет существующая release automation. VSIX не содержит бинарники backend; они устанавливаются отдельно.

## Установка

Скачайте VSIX из Assets нужного [GitHub Release](https://github.com/1c-tooling/eska-vscode-explorer/releases).

1. Нужен `eska-project` с Metadata API 1.12. Для текущей разработки соберите
   package в рабочей копии ESKA и задайте абсолютный путь в
   `eska.explorer.executable`. [Выбор backend](cli-management.md).
2. В меню Extensions выберите **Install from VSIX…** и укажите собранный пакет.
3. Для прежней полной CLI явно задайте `eska.explorer.backend = "legacy"`;
   пользовательский путь сохраняется, соединение помечается Legacy.
4. Откройте доверенную папку с `eska.toml` и Designer XML; раскройте **ESKA: 1C Explorer**.
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
Bun. `scripts/bundle.mjs` собирает production JS и runtime зависимости
`yauzl`/`pend`, `vscode-languageclient` 10.1.2 и его зависимости в
`out/extension.js` через закреплённый esbuild 0.28.2. Поэтому
`--no-dependencies` сохраняет рабочие установщик и LSP-клиент в установленном VSIX.
`out/THIRD-PARTY-NOTICES.txt` содержит лицензии всех модулей bundle; отсутствие
лицензии останавливает сборку. Upstream license/NOTICE анализатора включены
в `resources/analyzer-notices/` с source/hash provenance. `.vscodeignore` разрешает
только runtime JS, BSL/SDBL-грамматики и language configuration, NLS, документацию,
LICENSE, SVG и PNG-иконку магазина.
В пакет не входят node_modules, TS, тесты, карты исходников, стенды и Git-файлы.
`check-vsix.py` проверяет identity, ZIP CRC, полный список и байты ресурсов.

Расширение распространяется под [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). Файл LICENSE включён
в VSIX, его наличие и содержимое проверяет `check-vsix.py`. GitHub Actions,
публикация, теги и версия этой командой не изменяются. Python нужен только для
проверки архива.

## Изолированная проверка установленного пакета

```sh
ESKA_TEST_BINARY="$(realpath ../eska/target/debug/eska-project)" \
ESKA_TEST_VSIX="$PWD/eska-explorer-0.0.1.vsix" \
VSCODE_EXECUTABLE=codium node test/run-host.mjs test/icons-host.cjs
```

Runner создаёт свои fixture, профиль и каталог расширений внутри соседнего
`eska-playground`, устанавливает VSIX, проверяет список установленных расширений
и запускает код именно из установленного пакета. Только этот экземпляр загружается
в test mode для доступа к provider; production API не добавляется.
Пользовательский профиль не меняется; временные данные удаляются после проверки.
Тем же способом запускаются `test/filter-host.cjs` и `test/extension-host.cjs`.
Для собственного LSP используются `test/language-host.cjs`, `test/grammar-host.cjs`
и переменные из [проверки T86](language-service.md#проверка).
Полный native-сценарий включает клавиатурное сворачивание. Для запуска в фоне
его Quick Pick в тесте имеет `ignoreFocusOut=true`; production-поведение не меняется.

Основание: [официальная инструкция упаковки VSIX](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
