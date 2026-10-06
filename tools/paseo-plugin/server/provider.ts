import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CAPABILITIES = ["prompt.message"] as const;
const MODELS = [{ id: "chatgpt", label: "ChatGPT (веб, через CodexPro)" }];

interface Session {
  cwd: string;
  box: string;
  turns: number;
  active: { turnId: string; timer?: ReturnType<typeof setTimeout> } | null;
}

export function createCodexproProvider({ pollMs = 1000 } = {}): ProviderRegistration {
  return {
    id: "codexpro",
    label: "ChatGPT (CodexPro)",
    description: "Задача уходит файлом в .ai-bridge/, ChatGPT через CodexPro отвечает файлом",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Нужна версия 1 протокола провайдера");
      const capabilities = negotiateProviderCapabilities(request.capabilities, CAPABILITIES);
      return createConnection(capabilities, pollMs);
    },
  };
}

function createConnection(capabilities: readonly string[], pollMs: number): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };

  function finishTurn(sessionId: string, state: "completed" | "failed" | "canceled", error?: string) {
    const session = sessions.get(sessionId);
    if (!session?.active) return;
    const { turnId, timer } = session.active;
    clearTimeout(timer);
    session.active = null;
    emit({ type: "session.turn", sessionId, turnId, state, ...(error && { error: { message: error } }) });
  }

  const clearBox = (session: Session) =>
    Promise.all(["task.md", "reply.md"].map((file) => rm(join(session.cwd, session.box, file), { force: true })));

  async function prompt({ sessionId, prompt }: Extract<ProviderInput, { type: "session.prompt" }>) {
    const session = sessions.get(sessionId)!;
    const result = (value: Extract<ProviderEvent, { type: "session.prompt_result" }>["result"]) =>
      emit({ type: "session.prompt_result", sessionId, clientMessageId: prompt.clientMessageId, result: value });
    if (prompt.input.type !== "message") return result({ type: "failed", error: { message: "Только текст" } });
    if (session.active) {
      return result({ type: "failed", error: { message: "Предыдущая задача ещё ждёт ответа ChatGPT" } });
    }

    const text = prompt.input.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    const turnId = `turn-${++session.turns}`;
    session.active = { turnId };
    emit({
      type: "timeline.item",
      sessionId,
      item: { type: "user_message", id: `user-${turnId}`, text, clientMessageId: prompt.clientMessageId },
    });
    result({ type: "turn", turnId });
    emit({ type: "session.turn", sessionId, turnId, state: "started" });

    const task = join(session.box, "task.md");
    const reply = join(session.box, "reply.md");
    try {
      await mkdir(join(session.cwd, session.box), { recursive: true });
      await rm(join(session.cwd, reply), { force: true });
      // ровно текст сообщения: его отправляет в ChatGPT мост tools/chatgpt-bridge; куда писать ответ — в подсказке ниже
      await writeFile(join(session.cwd, task), text);
    } catch (error) {
      return finishTurn(sessionId, "failed", `Не удалось записать задачу: ${String(error)}`);
    }
    if (session.active?.turnId !== turnId) return clearBox(session);

    emit({
      type: "timeline.item",
      sessionId,
      item: {
        type: "assistant_message",
        id: `wait-${turnId}`,
        text:
          `Задача ждёт ChatGPT: \`${task}\`. Вставьте в ChatGPT с плагином CodexPro:\n\n` +
          "```text\n" +
          `Use CodexPro Sandbox. Прочитай ${task} и выполни задачу в этом репозитории. ` +
          `Итоговый ответ запиши одним вызовом write в ${reply}.\n` +
          "```",
      },
    });

    // ponytail: опрос файла раз в pollMs (fs.watch ненадёжен на томах Docker); ответ виден с задержкой до 2×pollMs
    let lastSize = -1;
    const tick = async () => {
      try {
        const size = await sizeOf(join(session.cwd, reply));
        if (session.active?.turnId !== turnId) return;
        if (size > 0 && size === lastSize) {
          const answer = await readFile(join(session.cwd, reply), "utf8");
          if (session.active?.turnId !== turnId) return;
          emit({ type: "timeline.item", sessionId, item: { type: "assistant_message", id: `reply-${turnId}`, text: answer } });
          finishTurn(sessionId, "completed");
          await clearBox(session);
          return;
        }
        lastSize = size;
        session.active.timer = setTimeout(tick, pollMs);
      } catch (error) {
        finishTurn(sessionId, "failed", `Не удалось прочитать ответ: ${String(error)}`);
      }
    };
    session.active.timer = setTimeout(tick, pollMs);
  }

  // ponytail: без session.persistence — после перезапуска демона ожидающий ход теряется
  async function dispatch(input: ProviderInput) {
    switch (input.type) {
      case "catalog":
        emit({ type: "catalog", requestId: input.requestId, catalog: { models: MODELS, modes: [], defaultModel: "chatgpt" } });
        return;
      case "session.open": {
        const box = join(".ai-bridge", "paseo", input.sessionId.replace(/[^\w-]/g, "_"));
        sessions.set(input.sessionId, { cwd: input.config.cwd, box, turns: 0, active: null });
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
        finishTurn(input.sessionId, "canceled");
        await clearBox(sessions.get(input.sessionId)!);
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      case "session.close": {
        const session = sessions.get(input.sessionId)!;
        finishTurn(input.sessionId, "canceled");
        sessions.delete(input.sessionId);
        await rm(join(session.cwd, session.box), { recursive: true, force: true });
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
      for (const session of sessions.values()) clearTimeout(session.active?.timer);
      sessions.clear();
      listeners.clear();
    },
  };
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return -1;
    throw error;
  }
}
