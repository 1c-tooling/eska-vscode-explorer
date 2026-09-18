# Версии и GitHub Release

Автоматизация добавлена по запросу пользователя отдельно от T76. Она включится
после попадания workflow в `main`; локальная разработка на `feat/explorer` ничего
не публикует.

## Процесс

1. После изменений в `main` workflow `Release` проверяет TypeScript и запускает
   тесты. Начальная версия `0.0.0` считается неопубликованным каркасом.
2. Knope читает Conventional Commits после последнего тега и готовит изменения
   `package.json` и `CHANGELOG.md`. При отсутствии изменений PR не создаётся.
3. Открывается release PR. После его слияния в `main` workflow повторяет проверки
   и создаёт тег `v<version>` и GitHub Release с соответствующим changelog.

Сейчас релиз содержит исходники, автоматически прикрепляемые GitHub, и описание
из changelog. Установочный VSIX будет включён после выбора publisher и подготовки
упаковки. Публикации в Marketplace, npm и Open VSX в этих workflow нет.

Release PR использует новую ветку `release/eska-explorer-<version>-<base>-<tree>`.
Эта область имён зарезервирована за автоматизацией. Новый PR заменяет предыдущие
открытые release PR; старые закрываются, ветки сохраняются. Повторный запуск для
того же дерева использует существующую ветку. Force push и переписывания истории
нет. Версию вручную при обычной разработке не меняйте.

## Инструменты

- **Knope 0.23.0** — готовый Rust-бинарник для версии, changelog и GitHub Release.
  В отличие от release-plz, умеет работать непосредственно с `package.json`.
- **Bun 1.4.2** — зависимости, запуск компилятора и тестов; зависимости закреплены
  в `bun.lock`, установка выполняется с `--frozen-lockfile --ignore-scripts`.
- **GitHub CLI и Python из runner** — короткая обвязка release PR и его проверок.

Архивы Bun и Knope закреплены версиями и SHA-256 в `scripts/install-tools.sh`.
Rust toolchain не устанавливается, инструменты не компилируются. `setup-node` и
npm в workflow не используются. Стандартный `actions/checkout` использует свой
Node runtime внутри action; он закреплён по commit. Production-код расширения
по-прежнему работает в Node extension host VS Code.

Правила Knope до 1.0: `fix` и `feat` повышают patch, `!`/`BREAKING CHANGE` повышает
minor. После 1.0 действуют обычные patch/minor/major. Сообщения коммитов остаются
на русском с английскими type/scope; их описания входят в changelog.

## Настройка GitHub

Используется штатный `GITHUB_TOKEN`; отдельный PAT не требуется. Репозиторий должен
разрешать GitHub Actions создавать pull requests: Settings → Actions → General →
Workflow permissions → **Allow GitHub Actions to create and approve pull requests**.
Workflow задаёт `contents: write`, `pull-requests: write`, `actions: write` только
для релизного задания. Организационная политика может ограничить эти разрешения.

События PR, созданного через `GITHUB_TOKEN`, могут требовать ручного подтверждения
запуска workflow. Поэтому автоматизация явно запускает `CI` через `workflow_dispatch` на commit
release-ветки. Это позволяет использовать штатный токен без скрытой зависимости
от PAT. Branch protection и обязательные проверки автоматически не меняются.

Повторить после сбоя можно workflow **Release** из `main`. Существующая
опубликованная версия проверяется и повторно не создаётся. Если тег существует,
но GitHub Release отсутствует или остался draft, workflow останавливается:
такое состояние требует отдельного восстановления, теги не перемещаются.

## Проверки

`actionlint` проверяет YAML, `bash -n` — установщик; тесты в `test/release_test.py`
проверяют допустимые файлы PR, запрет локальной публикации, согласованность
версии с changelog, отсутствие изменений, реальное повышение версии через Knope
и повторную подготовку release-ветки с локальным bare origin и подменёнными вызовами GitHub.
Тестовые Git-репозитории создаются только в собственных временных каталогах
`ESKA_TEST_ROOT` внутри соседнего `eska-playground`.

```bash
ESKA_TEST_ROOT="$(realpath ../eska-playground)" \
KNOPE_TEST_BINARY="$(command -v knope)" \
python3 -m unittest discover -s test -p '*_test.py'
```

Создание PR и GitHub Release проверяются после push и слияния workflow; локальные
тесты не выполняют публикацию. В `feat/explorer` ещё не было реального запуска
GitHub Actions. Реальный IDE backend проверяется отдельно через `ESKA_TEST_BINARY`;
CI расширения не собирает соседний Rust-репозиторий и не запускает 1С.

Основания: [Knope: packages](https://knope.tech/reference/config-file/packages/),
[Knope: semantic versioning](https://knope.tech/reference/concepts/semantic-versioning/),
[Knope: Release](https://knope.tech/reference/config-file/steps/release/),
[Bun runtime](https://bun.sh/docs/runtime),
[GitHub: triggering a workflow](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow).
