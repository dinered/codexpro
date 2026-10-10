import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  BRIDGE_LOCK,
  fileName,
  isFresh,
  newTaskId,
  parseName,
  pulse,
  PULSE_MS,
  readRegular,
  tasksRoot,
  writeAtomic,
  type Kind,
} from "./protocol";

const CAPABILITIES = ["prompt.message"] as const;
const MODELS = [{ id: "chatgpt", label: "ChatGPT (веб, через CodexPro)" }];

interface Session {
  cwd: string;
  dir: string; // папка сессии: <cwd>/.ai-bridge/paseo/<сессия>
  turns: number;
  active: { turnId: string; id: string; timer?: ReturnType<typeof setTimeout> } | null; // id — в именах файлов хода
}

export function createCodexproProvider({ pollMs = 1000, pulseMs = PULSE_MS } = {}): ProviderRegistration {
  return {
    id: "codexpro",
    label: "ChatGPT (CodexPro)",
    description: "Задача уходит файлом в .ai-bridge/, ChatGPT через CodexPro отвечает файлом",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Нужна версия 1 протокола провайдера");
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return createConnection(capabilities, pollMs, pulseMs);
    },
  };
}

function createConnection(capabilities: readonly string[], pollMs: number, pulseMs: number): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };

  // Конец хода: событие в Paseo и уборка всех файлов его id (задача, захват моста, ответ, ошибка).
  function finishTurn(sessionId: string, state: "completed" | "failed" | "canceled", error?: string) {
    const session = sessions.get(sessionId);
    if (!session?.active) return;
    const { turnId, id, timer } = session.active;
    clearTimeout(timer);
    session.active = null;
    emit({ type: "session.turn", sessionId, turnId, state, ...(error && { error: { message: error } }) });
    return sweep(session.dir, (other) => other === id);
  }

  // Ход по протоколу v2 (protocol.ts): task-<id>.md с пульсом → исполнитель → reply-<id>.md или error-<id>.md.
  async function prompt({ sessionId, prompt }: Extract<ProviderInput, { type: "session.prompt" }>) {
    const session = sessions.get(sessionId)!;
    const result = (value: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"]) =>
      emit({ type: "session.prompt_result", sessionId, clientMessageId: prompt.clientMessageId, result: value });
    if (prompt.input.type !== "message") return result({ type: "failed", error: { message: "Только текст" } });
    // #учебно-не-боевое-12 — один ход за раз, только текст, без steer; в бою — очередь сессии, вложения, параллельные ходы
    if (session.active) {
      return result({ type: "failed", error: { message: "Предыдущая задача ещё ждёт ответа ChatGPT" } });
    }

    const text = prompt.input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const turnId = `turn-${++session.turns}`;
    const id = newTaskId();
    session.active = { turnId, id };
    emit({
      type: "timeline.item",
      sessionId,
      item: { type: "user_message", id: `user-${turnId}`, text, clientMessageId: prompt.clientMessageId },
    });
    result({ type: "turn", turnId });
    emit({ type: "session.turn", sessionId, turnId, state: "started" });

    const file = (kind: Kind) => join(session.dir, fileName(kind, id));
    const shown = (kind: Kind) => relative(session.cwd, file(kind)); // в подсказке — от рабочей папки
    let writeError: string | null = null;
    let bridge = false;
    try {
      await mkdir(session.dir, { recursive: true });
      // ровно текст сообщения: его отправляет в ChatGPT мост tools/chatgpt-bridge; куда писать ответ — в подсказке ниже
      await writeAtomic(file("task"), text);
      bridge = await isFresh(join(tasksRoot(session.cwd), BRIDGE_LOCK)); // живой мост пульсирует свой замок
    } catch (error) {
      writeError = `Не удалось записать задачу: ${String(error)}`;
    }
    if (session.active?.turnId !== turnId) return sweep(session.dir, (other) => other === id); // «Стоп» во время записи
    if (writeError) return finishTurn(sessionId, "failed", writeError);

    emit({
      type: "timeline.item",
      sessionId,
      item: {
        type: "assistant_message",
        id: `wait-${turnId}`,
        text: bridge
          ? `Задача ушла мосту в ChatGPT: \`${shown("task")}\``
          : `Задача ждёт ChatGPT: \`${shown("task")}\`. Вставьте в ChatGPT с плагином CodexPro:\n\n` +
            "```text\n" +
            `Use CodexPro Sandbox. Прочитай ${shown("task")} и выполни задачу в этом репозитории. ` +
            `Итоговый ответ запиши одним вызовом write в ${shown("reply")}.\n` +
            "```",
      },
    });

    // ponytail: опрос папки раз в pollMs (fs.watch ненадёжен на томах Docker); ответ виден с задержкой до 2×pollMs
    // #учебно-не-боевое-10 — в бою — подписка на очередь или поток ответа API
    let last: string | null = null;
    let pulsed = Date.now();
    const tick = async () => {
      let failure: string | null = null;
      let answer: string | null = null;
      let gone = false;
      try {
        // файлы чужих id — остатки прошлых ходов; «чужой» — относительно активного хода в момент удаления:
        // опрос, запоздавший после «Стоп», не тронет задачу следующего хода
        await sweep(session.dir, (other) => other !== session.active?.id);
        failure = await readRegular(file("error"));
        answer = await readRegular(file("reply"));
        // пульс, пока ответа нет: исполнитель берёт и держит только задачу со свежим пульсом
        if (!answer && Date.now() - pulsed >= pulseMs) {
          gone = !(await lstat(file("task")).catch(() => null))?.isFile();
          // файл могли удалить и между lstat и пульсом: это тоже «удалён», а не ошибка чтения ответа
          if (!gone) gone = await pulse(file("task")).then(() => false, (error) => (error?.code === "ENOENT" ? true : Promise.reject(error)));
          pulsed = Date.now();
        }
      } catch (error) {
        failure = `Не удалось прочитать ответ: ${String(error)}`;
      }
      if (session.active?.turnId !== turnId) return;
      if (failure !== null) return finishTurn(sessionId, "failed", failure.trim() || "Исполнитель не выполнил задачу");
      if (gone) return finishTurn(sessionId, "failed", "файл задачи удалён");
      // человек или CodexPro пишут ответ не атомарно: берём, когда он не менялся между двумя опросами
      if (answer && answer === last) {
        emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id: `reply-${turnId}`, text: answer } });
        return finishTurn(sessionId, "completed");
      }
      last = answer;
      session.active.timer = setTimeout(tick, pollMs);
    };
    session.active.timer = setTimeout(tick, pollMs);
  }

  // ponytail: без session.persistence — после перезапуска демона ожидающий ход теряется
  // #учебно-не-боевое-11 — состояние хода только в памяти; в бою — в хранилище, с восстановлением после перезапуска
  async function dispatch(input: ProviderInput) {
    switch (input.type) {
      case "catalog":
        emit({ type: "catalog", requestId: input.requestId, catalog: { models: MODELS, modes: [], defaultModel: "chatgpt" } });
        return;
      case "session.open": {
        const dir = join(tasksRoot(input.config.cwd), input.sessionId.replace(/[^\w-]/g, "_"));
        sessions.set(input.sessionId, { cwd: input.config.cwd, dir, turns: 0, active: null });
        const { requestId, sessionId } = input;
        emit({
          type: "session.opened",
          requestId,
          sessionId,
          capabilities,
          restoration: "core",
          title: input.config.title,
          cwd: input.config.cwd,
        });
        emit({
          type: "session.config",
          sessionId,
          config: { model: "chatgpt", models: MODELS, modes: [], thinkingOptions: [], settings: [] },
        });
        emit({ type: "session.ready", requestId, sessionId });
        return;
      }
      case "session.prompt":
        return prompt(input);
      case "session.interrupt": {
        await finishTurn(input.sessionId, "canceled");
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close": {
        const session = sessions.get(input.sessionId)!;
        void finishTurn(input.sessionId, "canceled"); // файлы хода уйдут вместе с папкой ниже
        sessions.delete(input.sessionId);
        await rm(session.dir, { recursive: true, force: true });
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
    }
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Соединение с провайдером закрыто");
      requireProviderCapabilities(capabilities, input);
      if (input.type === "session.open" ? sessions.has(input.sessionId) : "sessionId" in input && !sessions.has(input.sessionId)) {
        throw new Error(`Сессия не подходит для ${input.type}: ${"sessionId" in input ? input.sessionId : ""}`);
      }
      queueMicrotask(() => {
        dispatch(input).catch((error) => {
          if ("requestId" in input) emit({ type: "request.failed", requestId: input.requestId, error: { message: String(error) } });
          else console.error("codexpro-worker:", error);
        });
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) {
        clearTimeout(session.active?.timer);
        session.active = null; // опрос в полёте не перезапустится и не продлит пульс задачи
      }
      sessions.clear();
      listeners.clear();
    },
  };
}

// Удаляет в папке сессии файлы протокола с подходящим id. Best effort: задачу без пульса
// исполнитель не возьмёт, а файлы чужих id плагин не читает.
async function sweep(dir: string, match: (id: string) => boolean) {
  for (const name of await readdir(dir).catch(() => [])) {
    const file = parseName(name);
    if (file && match(file.id)) await unlink(join(dir, name)).catch(() => {});
  }
}
