import type { FailureCode } from "./protocol.js";

const en = {
  disconnected: "Choose a project to connect.", connecting: "Connecting to eska…",
  stopping: "Disconnecting…", ready: "Connected to eska {0}",
  choose: "Select an eska project folder", select: "Choose project", retry: "Restart connection",
  log: "Show log", initialization: "Open setup instructions", logName: "eska Explorer",
  configuration: "Configuration", extension: "Configuration extension", processing: "External processing", report: "External report",
  noFolder: "Open a folder containing an eska project.",
  untrusted: "Trust this workspace before starting eska.",
  unsupportedWorkspace: "This workspace has no filesystem accessible to eska. Open a local folder or a folder in SSH, WSL or a container.",
  invalidExecutable: "Set eska.explorer.executable to an executable name or an absolute path, without arguments.",
  executableMissing: "eska was not found. Install a backend with IDE API 1.0 or configure eska.explorer.executable on the workspace host.",
  spawnFailed: "Could not start eska. Check the executable path, permissions and project folder.",
  connectionLost: "The eska process stopped. Restart the connection to continue.",
  protocolInvalid: "eska returned an invalid IDE response. Check the executable path and backend compatibility.",
  timeout: "eska did not respond in time. The connection was stopped; you can restart it.",
  resourceLimit: "The connection queue is full. Retry the operation.",
  incompatible: "This eska executable does not support IDE API 1.0. Select a compatible backend.",
  manifestMissing: "No eska.toml was found. Set up the project with eska init, then reconnect.",
  manifestInvalid: "Could not read eska.toml. Check its syntax and project type: configuration, extension, processing or report.",
  selectionInvalid: "Could not select workspace members. Check the workspace in eska.toml.",
  sourceInvalid: "Could not open project sources. Check source paths in eska.toml.",
  rootInvalid: "Could not read the root Designer XML. Check the file and its project type against eska.toml.",
  requestFailed: "eska could not complete the request. See the connection log.",
  cleanupFailed: "Could not confirm that the previous eska process stopped. A replacement process was not started.",
} as const;

const ru: Record<keyof typeof en, string> = {
  disconnected: "Выберите проект для подключения.", connecting: "Подключение к eska…",
  stopping: "Отключение…", ready: "Подключено к eska {0}",
  choose: "Выберите папку проекта eska", select: "Выбрать проект", retry: "Перезапустить подключение",
  log: "Показать журнал", initialization: "Открыть инструкцию настройки", logName: "eska Explorer",
  configuration: "Конфигурация", extension: "Расширение конфигурации", processing: "Внешняя обработка", report: "Внешний отчёт",
  noFolder: "Откройте папку с проектом eska.",
  untrusted: "Перед запуском eska предоставьте доверие рабочей области.",
  unsupportedWorkspace: "Файловая система этой рабочей области недоступна eska. Откройте локальную папку или папку через SSH, WSL либо контейнер.",
  invalidExecutable: "Укажите в eska.explorer.executable имя исполняемого файла или абсолютный путь без аргументов.",
  executableMissing: "eska не найден. Установите backend с IDE API 1.0 или задайте eska.explorer.executable на машине проекта.",
  spawnFailed: "Не удалось запустить eska. Проверьте путь к программе, права доступа и папку проекта.",
  connectionLost: "Процесс eska завершился. Перезапустите подключение, чтобы продолжить.",
  protocolInvalid: "eska вернул некорректный ответ IDE. Проверьте путь к программе и совместимость backend.",
  timeout: "eska не ответил вовремя. Подключение остановлено; его можно перезапустить.",
  resourceLimit: "Очередь подключения заполнена. Повторите действие.",
  incompatible: "Этот исполняемый файл eska не поддерживает IDE API 1.0. Выберите совместимый backend.",
  manifestMissing: "Файл eska.toml не найден. Настройте проект командой eska init и подключитесь повторно.",
  manifestInvalid: "Не удалось прочитать eska.toml. Проверьте синтаксис и тип проекта: configuration, extension, processing или report.",
  selectionInvalid: "Не удалось выбрать проекты workspace. Проверьте workspace в eska.toml.",
  sourceInvalid: "Не удалось открыть исходники проекта. Проверьте пути в eska.toml.",
  rootInvalid: "Не удалось прочитать корневой Designer XML. Проверьте файл и соответствие его типа eska.toml.",
  requestFailed: "eska не смог выполнить запрос. Подробности — в журнале подключения.",
  cleanupFailed: "Не удалось подтвердить завершение предыдущего процесса eska. Новый процесс не запущен.",
};

export type MessageKey = keyof typeof en;

/** Both locales share compiler-checked keys; unsupported UI languages fall back to English. */
export function message(language: string, key: MessageKey | FailureCode, ...values: string[]): string {
  const text: string = (language.toLowerCase().startsWith("ru") ? ru : en)[key];
  return text.replace(/\{([0-9]+)\}/g, (_, index: string) => values[Number(index)] ?? "");
}
