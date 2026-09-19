# Иконки метаданных

Оригинальные SVG eska; пользователь согласовал стиль образца T80.
Ресурсы Material Icon Theme и Конфигуратора не копировались, лицензия проекта не менялась.
Все SVG включены локально в `resources/icons`; загрузки из сети и файловой темы не нужны.
Светлая/тёмная темы используют цвет, обе контрастные — монохромные варианты.
Прорези прозрачны, поэтому выбранная строка и произвольный фон не дают цветных заплаток.

Типы берутся из `Node.metadataKind`, группы и роли — из типизированного `NodeId`.
Неизвестные и отсутствующие типы (старый backend) получают `unknown.svg`; ошибки —
нативный warning. Идентификаторы объектов и XML в расширении не разбираются.

## Типы метаданных

| metadataKind | SVG |
|---|---|
| `configuration` | `configuration.svg` |
| `data-processor` | `data-processor.svg` |
| `report` | `report.svg` |
| `accounting-register` | `accounting-register.svg` |
| `accumulation-register` | `accumulation-register.svg` |
| `bot` | `bot.svg` |
| `business-process` | `business-process.svg` |
| `calculation-register` | `calculation-register.svg` |
| `catalog` | `catalog.svg` |
| `chart-of-accounts` | `accounts.svg` |
| `chart-of-calculation-types` | `calculation-types.svg` |
| `chart-of-characteristic-types` | `characteristic-types.svg` |
| `command-group` | `folder.svg` |
| `common-attribute` | `attribute.svg` |
| `common-command` | `command.svg` |
| `common-form` | `form.svg` |
| `common-module` | `common-module.svg` |
| `common-picture` | `picture.svg` |
| `common-template` | `template.svg` |
| `constant` | `constant.svg` |
| `defined-type` | `parameter.svg` |
| `document` | `document.svg` |
| `document-journal` | `document.svg` |
| `document-numerator` | `number.svg` |
| `enum` | `enum.svg` |
| `event-subscription` | `event.svg` |
| `exchange-plan` | `exchange.svg` |
| `external-data-source` | `external-data-source.svg` |
| `filter-criterion` | `filter.svg` |
| `functional-option` | `option.svg` |
| `functional-option-parameter` | `parameter.svg` |
| `http-service` | `service.svg` |
| `information-register` | `information-register.svg` |
| `integration-service` | `exchange.svg` |
| `language` | `language.svg` |
| `role` | `role.svg` |
| `scheduled-job` | `clock.svg` |
| `sequence` | `exchange.svg` |
| `session-parameter` | `parameter.svg` |
| `settings-storage` | `storage.svg` |
| `style` | `palette.svg` |
| `style-item` | `palette.svg` |
| `subsystem` | `folder.svg` |
| `task` | `check.svg` |
| `web-service` | `service.svg` |
| `web-socket-client` | `exchange.svg` |
| `ws-reference` | `link.svg` |
| `xdto-package` | `package.svg` |
| `form` | `form.svg` |
| `template` | `template.svg` |
| `command` | `command.svg` |
| `addressing-attribute` | `attribute.svg` |
| `attribute` | `attribute.svg` |
| `tabular-section` | `tabular-section.svg` |
| `dimension` | `dimension.svg` |
| `resource` | `resource.svg` |
| `requisite` | `attribute.svg` |
| `enum-value` | `enum.svg` |
| `accounting-flag` | `check.svg` |
| `ext-dimension-accounting-flag` | `check.svg` |
| `recalculation` | `recalculation.svg` |
| `column` | `attribute.svg` |
| `url-template` | `link.svg` |
| `method` | `method.svg` |
| `operation` | `method.svg` |
| `parameter` | `parameter.svg` |
| `integration-service-channel` | `exchange.svg` |

## Группы и модули

«Общие» — `common.svg`, «Модули» — `modules.svg`, metadata-группы —
иконка их типа. Неизвестная группа — `unknown.svg`.
Все десять ролей (`module`, `object`, `manager`, `record-set`, `value-manager`,
`managed-application`, `ordinary-application`, `session`, `external-connection`,
`command`) используют `module.svg`; роль различается подписью. Общий модуль
как объект использует `common-module.svg`.

## Иконка магазина

`resources/icon.png` — общий логотип 1c-tooling, перенесённый из
`assets/1c-tooling-logo.png` сайта проекта. PNG включён в VSIX отдельно от SVG
метаданных и указан в поле `icon` манифеста.
