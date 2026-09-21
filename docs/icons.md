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
| `predefined-item` | `predefined-item.svg` |
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
иконка их типа, кроме перечисленных ниже отдельных образов. Неизвестная группа — `unknown.svg`.
Все десять ролей (`module`, `object`, `manager`, `record-set`, `value-manager`,
`managed-application`, `ordinary-application`, `session`, `external-connection`,
`command`) используют `module.svg`; роль различается подписью. Общий модуль
как объект использует `common-module.svg`.

## Иконка магазина

`resources/icon.png` — общий логотип 1c-tooling, перенесённый из
`assets/1c-tooling-logo.png` сайта проекта. PNG включён в VSIX отдельно от SVG
метаданных и указан в поле `icon` манифеста.

## Различимые группы и проекты

Корень использует `ProjectInfo.type`: `configuration` — прежний жёлтый куб,
`extension` — фиолетовый пазл, `report` — лист с диаграммой,
`processing` — синяя карточка с жёлтой стрелкой. Вложенные объекты
по-прежнему используют `metadataKind`.

Группа реквизитов — три поля цвета элементов. Предопределённые данные —
фиолетовый список, их элементы — поле формы реквизита того же фиолетового цвета.
Табличные части и их элементы — тёмно-зелёные (`#34835b`).
В контрастных темах сохраняются монохромные варианты.

| Группа (`metadataKind`) | SVG |
|---|---|
| `command-group` | `command-group.svg` |
| `common-attribute` | `common-attributes.svg` |
| `common-command` | `common-commands.svg` |
| `common-form` | `common-forms.svg` |
| `common-template` | `common-templates.svg` |
| `defined-type` | `defined-type.svg` |
| `document-journal` | `document-journal.svg` |
| `functional-option-parameter` | `option-parameters.svg` |
| `integration-service` | `integration-service.svg` |
| `sequence` | `sequence.svg` |
| `session-parameter` | `session-parameters.svg` |
| `style-item` | `style-item.svg` |
| `web-service` | `web-service.svg` |
| `web-socket-client` | `web-socket-client.svg` |
| `addressing-attribute` | `addressing-attributes.svg` |
| `attribute` | `attributes.svg` |
| `requisite` | `requisites.svg` |
| `enum-value` | `enum-values.svg` |
| `predefined-item` | `predefined-data.svg` |
| `accounting-flag` | `accounting-flag.svg` |
| `ext-dimension-accounting-flag` | `dimension-flag.svg` |
| `column` | `columns.svg` |
| `url-template` | `url-template.svg` |
| `operation` | `operations.svg` |
| `integration-service-channel` | `integration-channel.svg` |

Элементы `predefined-item` используют `predefined-item.svg`.
