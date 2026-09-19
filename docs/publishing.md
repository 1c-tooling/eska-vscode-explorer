# Публикация в VS Code Marketplace и Open VSX

Постоянный идентификатор расширения — `1c-tooling.eska-explorer`.
Название — **ESKA: 1C Explorer**, лицензия — Apache-2.0.
Регистрация издателей и первая публикация ещё предстоят. Доступность имени
`1c-tooling` нужно подтвердить при регистрации; при конфликте не меняйте publisher
в одном workflow — это часть идентификатора устанавливаемого расширения.

## 1. Зарегистрировать издателей

### VS Code Marketplace

1. Войдите в [управление издателями](https://marketplace.visualstudio.com/manage)
   и создайте publisher с ID `1c-tooling`.
2. Настройте для него trusted publishing из GitHub Actions: владелец `1c-tooling`,
   репозиторий `eska-vscode-explorer`, workflow `publish-stores.yml`,
   environment `marketplace`. В workflow выберите `authentication: oidc`.
3. Если trusted publishing пока недоступен для аккаунта, используйте PAT с правом
   **Marketplace → Manage** и сохраните его как environment secret `VSCE_PAT`.
   Выберите `authentication: token`. Токен не добавляется в репозиторий.

`@vscode/vsce` 4.0.0 поддерживает прямой обмен GitHub OIDC через `--oidc`;
Azure login в workflow не нужен. Инструкции:
[vsce: OIDC](https://github.com/microsoft/vscode-vsce/blob/main/README.md),
[публикация расширения](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

### Open VSX

1. Войдите через GitHub на [Open VSX](https://open-vsx.org/).
   Создайте и привяжите Eclipse account согласно
   [инструкции издателя](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).
   Publisher Agreement принимает владелец аккаунта самостоятельно.
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

В Settings → Environments создайте `marketplace` и `openvsx`, разрешите deployment
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

## 3. Опубликовать существующий VSIX

Actions → **Publish extension stores** → Run workflow:

- ветка `main`;
- `version`: номер существующего стабильного GitHub-релиза, без `v`;
- `registry`: `marketplace` или `openvsx`;
- `authentication`: настроенный способ авторизации;
- сначала `dry_run: true`, затем повторный запуск с `dry_run: false`.

Dry run проверяет релиз, размер и SHA-256 asset (если digest предоставлен GitHub),
identity, версию, manifest и наличие runtime. Он не проверяет права издателя и
не отправляет пакет в магазин. Реальная публикация передаёт те же байты VSIX
из GitHub Release, без повторной упаковки. Локальные исходники не подмешиваются.

Для второго магазина запустите workflow отдельно. Если один магазин принял пакет,
а другой вернул ошибку, повторяйте только неудавшийся магазин. Существующая версия
не перезаписывается, ошибка дубликата не скрывается. Для изменения уже опубликованного
пакета нужен следующий релиз.

Workflow `Release` по-прежнему выпускает только GitHub Release и VSIX.
Публикация в магазины запускается вручную; после установки из магазина обновления
расширения доставляет IDE согласно её настройкам. CLI ESKA обновляется отдельно.

## Локальная проверка без публикации

С авторизованным GitHub CLI и локальными тегами:

```sh
python3 scripts/publish-stores.py <version> --registry marketplace
```

Без `--publish` команда только проверяет пакет. Реальная публикация скриптом
разрешена только в ручном GitHub Actions workflow из `main` указанного репозитория.
Тесты `test/stores_test.py` используют подменённые вызовы GitHub и магазинов;
они не подтверждают работу реальных учётных записей.
