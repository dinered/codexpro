// Решения командной строки моста (main.ts) — чистые функции, чтобы их проверял тест без docker, Chrome и терминала.

// #внимание-учебно-аналитический-предохранитель — Chrome на 127.0.0.1:9222 тот самый: профиль песочницы и выход
// через вход mihomo 17891 (группа FOREIGN, AGENTS.md). Без этой проверки мост подключился бы к любому Chrome с
// открытым CDP — например, к другому окну оператора с его собственной перепиской в ChatGPT.
// commands — командные строки процессов, слушающих порт (lsof → ps); null — можно подключаться.
export const CHROME_PROXY = "--proxy-server=socks5://127.0.0.1:17891";
export function chromeVerdict(commands: string[], profile: string): string | null {
  if (!commands.length) return "нет Chrome с отладкой на 127.0.0.1:9222 (tools/codexpro-sandbox/README.md, «Chrome для ChatGPT»)";
  const wanted = [`--user-data-dir=${profile}`, CHROME_PROXY];
  if (commands.every((command) => wanted.every((flag) => command.includes(flag)))) return null;
  return `на 127.0.0.1:9222 не тот Chrome: нужны ${wanted.join(" и ")} — мост не подключаю`;
}

// #внимание-учебно-аналитический-предохранитель — codexpro-sandbox не запущен: контейнеры OrbStack достают до CDP
// Мака (host.docker.internal → 127.0.0.1:9222), а в codexpro-sandbox ChatGPT выполняет команды. При сбое не пропускает:
// docker не ответил — отказ. Остальные запущенные контейнеры тоже видят CDP: их мост не запрещает, а называет в журнале
// (чек-лист живого прогона — остановить или принять риск явно).
// Вход — ответ `docker --context orbstack ps -a --format '{{.Names}}\t{{.State}}'`.
export function containersVerdict(error: Error | null, stdout: string, stderr: string): { refusal: string | null; running: string[] } {
  if (error) {
    const why = stderr.trim() || error.message;
    return { refusal: `не удалось проверить контейнеры OrbStack (docker --context orbstack): ${why} — мост не запускаю`, running: [] };
  }
  const running = stdout
    .split("\n")
    .map((line) => line.trim().split("\t"))
    .filter(([name, state]) => name && state === "running")
    .map(([name]) => name);
  if (running.includes("codexpro-sandbox")) {
    return { refusal: "запущен codexpro-sandbox, а он видит CDP этого Chrome; остановите: docker stop codexpro-sandbox", running };
  }
  return { refusal: null, running };
}

// #внимание-учебно-аналитический-предохранитель — остановка оператором. Первый сигнал — мягкая остановка: «Остановить»
// в ChatGPT, ошибка хода, снятый захват. Выйти сразу — только повторным Ctrl+C: при закрытии окна терминала SIGHUP
// приходит дважды (от оболочки и при её выходе), и второй не должен обрывать мягкую остановку.
export function stopSignalAction(signal: "SIGINT" | "SIGTERM" | "SIGHUP", stopping: boolean): "stop" | "exit" | "ignore" {
  if (!stopping) return "stop";
  return signal === "SIGINT" ? "exit" : "ignore";
}

// #модельный-учебно-аналитический-контроль — строка журнала прогона: время UTC (ISO 8601) и событие. По журналу Claude
// сверяет прогон с чек-листом README («Живой прогон»), в том числе паузы между отправками.
export const journalLine = (at: Date, line: string) => `${at.toISOString()} ${line}`;
