# Публикация в Open VSX

Постоянный идентификатор расширения — `1c-tooling.eska-explorer`.
Название — **ESKA: 1C Explorer**, лицензия — Apache-2.0.
Публикуем расширение только в Open VSX; VSIX также доступен в GitHub Releases.
Marketplace не используется. Перед первым выпуском нужно создать namespace
`1c-tooling`; при конфликте имени не меняйте publisher без отдельного решения.

## 1. Настроить издателя Open VSX

1. Войдите через GitHub на [Open VSX](https://open-vsx.org/).
   Создайте и привяжите Eclipse account согласно
   [инструкции издателя](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).
   Publisher Agreement принимает владелец аккаунта самостоятельно.
   Eclipse Contributor Agreement (ECA) для публикации расширения не требуется.
2. Создайте access token в настройках Open VSX. С ним создайте namespace
   `1c-tooling` командой `bun run --bun ovsx create-namespace 1c-tooling`
   из репозитория расширения, передав токен через переменную окружения `OVSX_PAT`.
   Если namespace уже существует, запросите права владельца; не создавайте
   расширение под случайным другим именем.
3. Сохраните токен в GitHub environment `openvsx` как secret `OVSX_PAT`.
   **Первый выпуск** запускайте с `authentication: token`.
4. После появления первой активной версии настройте trusted publisher:
   owner `1c-tooling`, repository `eska-vscode-explorer`,
   workflow `publish-stores.yml`, environment `openvsx`.
   Для этого нужны права владельца namespace. Последующие выпуски могут использовать
   `authentication: oidc`; после успешной проверки удалите ненужный PAT.

У Open VSX trusted publishing требует уже опубликованного расширения.
См. [официальную инструкцию OIDC](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing).
Токены не нужно пересылать в чат или указывать в аргументах команд.

## 2. Подготовить GitHub и релиз

В Settings → Environments создайте `openvsx`, разрешите deployment
только из `main`. При токеновой авторизации положите соответствующий secret
в environment. При OIDC секреты магазинов не нужны; параметры доверия в магазине
должны точно совпадать с репозиторием, workflow и environment.

Слейте подготовку публикации в `main`, затем выпустите новую версию через
существующий [release PR](releases.md). Версию вручную не повышайте.
Предыдущий GitHub-релиз не содержит изменений, сделанных после его тега:
локальный пакет с тем же номером не заменяет опубликованный asset.

Проверьте GitHub Release и его `eska-explorer-<version>.vsix`. Перед первой
публикацией установите этот пакет в IDE и проверьте подключение и дерево.
Фактическая пользовательская проверка выполнена на Linux; Windows, macOS и Remote
пока требуют отдельной приёмки.

## 3. Автоматическая публикация и повторный запуск

После успешного задания `release` workflow `Release` автоматически вызывает
`Publish Open VSX` с номером релиза, `authentication: token` и `dry_run: false`.
Номер передаётся только после успешной загрузки VSIX в GitHub Release.
Используется существующий environment `openvsx` и его secret `OVSX_PAT`.
Отдельный токен GitHub не нужен: это прямой вызов reusable workflow,
а не ожидание события `release`, которое может не запуститься от `GITHUB_TOKEN`.
Если в environment настроено ручное одобрение deployment, GitHub будет ждать его.

Ручной запуск сохранён для проверки и восстановления после сбоя:


Actions → **Publish Open VSX** → Run workflow:

- ветка `main`;
- `version`: номер существующего стабильного GitHub-релиза, без `v`;
- `authentication`: `token` по умолчанию; `oidc` только после настройки доверия;
- сначала `dry_run: true`, затем повторный запуск с `dry_run: false`.

Dry run проверяет релиз, размер и SHA-256 asset (если digest предоставлен GitHub),
identity, версию, manifest и наличие runtime. Он не проверяет права издателя и
не отправляет пакет в магазин. Реальная публикация передаёт те же байты VSIX
из GitHub Release, без повторной упаковки. Локальные исходники не подмешиваются.

При сбое повторите workflow после устранения причины. Уже опубликованная версия
скачивается из Open VSX и сравнивается по SHA-256 с GitHub VSIX. При совпадении
задание завершается успешно без повторной отправки; при разных байтах — ошибка.
Ошибки доступа и сервера не считаются отсутствием версии. Если файлы Open VSX
ещё обрабатываются, повторите запуск позднее. Для изменения пакета нужен новый релиз.

После установки из Open VSX обновления
расширения доставляет IDE согласно её настройкам. CLI ESKA обновляется отдельно.

## Локальная проверка без публикации

С авторизованным GitHub CLI и локальными тегами:

```sh
python3 scripts/publish-stores.py <version>
```

Без `--publish` команда только проверяет пакет. Реальная публикация скриптом
разрешена только в GitHub Actions из `main` указанного репозитория
при `push` или `workflow_dispatch`.
Тесты `test/stores_test.py` используют подменённые вызовы GitHub и магазинов;
они не подтверждают работу реальных учётных записей.
