// Решения проверок перед подключением моста к Chrome (main.ts) — отдельно, чтобы их проверял тест без docker.

// #внимание-учебно-аналитический-предохранитель — codexpro-sandbox не запущен: контейнеры OrbStack достают до CDP
// Мака (host.docker.internal → 127.0.0.1:9222), а в codexpro-sandbox ChatGPT выполняет команды. При сбое не пропускает:
// проходят только ответы docker «контейнер остановлен» и «такого контейнера нет», остальное — отказ.
// Ответ — `docker --context orbstack inspect -f '{{.State.Running}}' codexpro-sandbox`; null — можно подключаться.
export function sandboxVerdict(error: Error | null, stdout: string, stderr: string): string | null {
  const out = stdout.trim();
  if (!error && out === "false") return null;
  if (error && /no such object/i.test(stderr)) return null;
  if (!error && out === "true") return "запущен codexpro-sandbox, а он видит CDP этого Chrome; остановите: docker stop codexpro-sandbox";
  const why = stderr.trim() || error?.message || `непонятный ответ «${out}»`;
  return `не удалось проверить, что codexpro-sandbox не запущен (docker --context orbstack): ${why} — мост не запускаю`;
}
