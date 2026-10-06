import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexproProvider } from "./provider";

async function startTurn(text: string) {
  const cwd = await mkdtemp(join(tmpdir(), "codexpro-worker-"));
  const provider = createCodexproProvider({ pollMs: 5 });
  const connection = await provider.connect({ versions: [1], capabilities: ["prompt.message"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({
    type: "session.open",
    requestId: "open-1",
    sessionId: "s1",
    config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: false },
    history: "skip",
  });
  await connection.send({
    type: "session.prompt",
    sessionId: "s1",
    prompt: { clientMessageId: "m1", delivery: "auto", input: { type: "message", content: [{ type: "text", text }] } },
  });
  const box = join(cwd, ".ai-bridge", "paseo", "s1");
  await vi.waitFor(async () => expect(await readFile(join(box, "task.md"), "utf8")).toContain(text));
  return { connection, events, box };
}

const turnStates = (events: ProviderEvent[]) => events.flatMap((e) => (e.type === "session.turn" ? [e.state] : []));

describe("провайдер codexpro", () => {
  it("отдаёт задачу файлом и возвращает ответ ChatGPT из файла", async () => {
    const { connection, events, box } = await startTurn("Добавь README");

    await writeFile(join(box, "reply.md"), "Готово: README добавлен");

    await vi.waitFor(() => expect(turnStates(events)).toEqual(["started", "completed"]));
    expect(events).toContainEqual(
      expect.objectContaining({ item: expect.objectContaining({ type: "assistant_message", text: "Готово: README добавлен" }) }),
    );
    expect(events.filter((e) => e.type === "session.prompt_result")).toHaveLength(1);
    await expect(access(join(box, "task.md"))).rejects.toThrow();
    await connection.close();
  });

  it("«Стоп» отменяет ход и убирает задачу", async () => {
    const { connection, events, box } = await startTurn("Долгая задача");

    await connection.send({ type: "session.interrupt", requestId: "stop-1", sessionId: "s1" });

    await vi.waitFor(() => expect(events).toContainEqual({ type: "request.completed", requestId: "stop-1" }));
    expect(turnStates(events)).toEqual(["started", "canceled"]);
    await expect(access(join(box, "task.md"))).rejects.toThrow();
    await connection.close();
  });
});
