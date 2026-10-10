// Решения командной строки моста (main.ts) — чистые функции, чтобы их проверял тест без docker, Chrome и терминала.

// #внимание-учебно-аналитический-предохранитель — Chrome на 127.0.0.1:9222 тот самый: профиль песочницы и выход
// через вход mihomo 17891 (группа FOREIGN, AGENTS.md). Без этой проверки мост подключился бы к любому Chrome с
// открытым CDP — например, к другому окну оператора с его собственной перепиской в ChatGPT.
// commands — командные строки процессов, слушающих порт (lsof → ps); null — можно подключаться.
export const CHROME_PROXY = "--proxy-server=socks5://127.0.0.1:17891";
// Флаги, с которыми Chrome ходит мимо --proxy-server, то есть мимо FOREIGN_STRICT.
const PROXY_BYPASS = ["--no-proxy-server", "--proxy-pac-url", "--proxy-auto-detect", "--proxy-bypass-list"];
export function chromeVerdict(commands: string[], profile: string): string | null {
  if (!commands.length) return "нет Chrome с отладкой на 127.0.0.1:9222 (tools/codexpro-sandbox/README.md, «Chrome для ChatGPT»)";
  const wanted = [`--user-data-dir=${profile}`, CHROME_PROXY];
  // Флаги — целыми словами и так, как их разбирает сам Chrome (base::CommandLine): префикс «--» или «-», после слова
  // «--» ключей нет. Подстрока пропустила бы чужой профиль «profile-old» и прокси с откатом напрямую «…:17891,direct://».
  // Но ps склеивает argv через пробел без кавычек, и «--» в его выводе может быть частью значения. Поэтому неоднозначное —
  // в сторону отказа: нужные флаги — до первого «--» и ровно по одному во всей строке (из двух Chrome берёт последний),
  // флагов в обход прокси нет нигде.
  const fits = (command: string) => {
    const words = command.split(/\s+/);
    const end = words.indexOf("--");
    const flags = (list: string[]) => list.filter((word) => word.startsWith("-")).map((word) => `--${word.replace(/^--?/, "")}`);
    const all = flags(words);
    const head = flags(end < 0 ? words : words.slice(0, end));
    const named = (list: string[], name: string) => list.filter((flag) => flag === name || flag.startsWith(`${name}=`));
    const once = (flag: string) => named(head, flag.split("=")[0]).join(" ") === flag && named(all, flag.split("=")[0]).length === 1;
    return wanted.every(once) && PROXY_BYPASS.every((name) => !named(all, name).length);
  };
  if (commands.every(fits)) return null;
  return `на 127.0.0.1:9222 не тот Chrome: нужны ${wanted.join(" и ")}, по одному разу и без флагов в обход прокси — мост не подключаю`;
}

// #внимание-учебно-аналитический-предохранитель — codexpro-sandbox остановлен: контейнеры OrbStack достают до CDP
// Мака (host.docker.internal → 127.0.0.1:9222), а в codexpro-sandbox ChatGPT выполняет команды. При сбое не пропускает:
// docker не ответил — отказ. Остальные живые контейнеры тоже видят CDP: их мост не запрещает, а называет в журнале
// (чек-лист живого прогона — остановить или принять риск явно).
// Вход — ответ `docker --context orbstack ps -a --format '{{.Names}}\t{{.State}}'`.
// Остановлен — created, exited, dead и removing (удаляется уже остановленный). Не остановлен и paused: процессы заморожены,
// но живы, и после `docker unpause` туннель и коннектор снова работают; и restarting: процесс вышел, но Docker сейчас
// запустит контейнер снова. В обоих случаях Docker считает контейнер Running.
const STOPPED = ["created", "exited", "dead", "removing"];
export function containersVerdict(error: Error | null, stdout: string, stderr: string): { refusal: string | null; running: string[] } {
  if (error) {
    const why = stderr.trim() || error.message;
    return { refusal: `не удалось проверить контейнеры OrbStack (docker --context orbstack): ${why} — мост не запускаю`, running: [] };
  }
  const alive = stdout
    .split("\n")
    .map((line) => line.trim().split("\t"))
    .filter(([name, state]) => name && !STOPPED.includes(state));
  const running = alive.map(([name, state]) => (state === "running" ? name : `${name} (${state})`));
  const sandbox = alive.find(([name]) => name === "codexpro-sandbox");
  if (sandbox) {
    const refusal = `codexpro-sandbox не остановлен (${sandbox[1]}), а он видит CDP этого Chrome; остановите: docker --context orbstack stop codexpro-sandbox`;
    return { refusal, running };
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
