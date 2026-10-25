// Загрузка селекторов из selectors/<платформа>.yaml — весь адрес и вся привязка
// к вёрстке в одном файле, обновляется без пересборки (birdview §1, §6).
// Самопроверка схемы — на старте моста: нехватка обязательного селектора не пускает мост.

import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface PlatformProfile {
  platform: string;
  domain: string;
  start_url: string;
  /** сетевой стрим как дополнительный сигнал конца ответа (birdview §3, «усиление») */
  network_probe: boolean;
  /** У-1: пути логина через запятую — редирект на них = ограничение (П-6, kind restriction) */
  login_paths?: string;
  selectors: {
    composer: string;
    turn: string;
    answer: string;
    stop_button: string;
    streaming?: string;
    send_button?: string;
    regenerate?: string;
    user_bubble?: string;
    challenge?: string;
  };
}

const REQUIRED_SELECTORS = ["composer", "turn", "answer", "stop_button"] as const;

export async function loadPlatformProfile(path: string): Promise<PlatformProfile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`профиль платформы не читается (${path}): ${error instanceof Error ? error.message : error}`);
  }
  const parsed = parse(raw) as PlatformProfile | null;
  if (!parsed || typeof parsed !== "object") throw new Error(`профиль платформы пуст: ${path}`);
  const problems: string[] = [];
  for (const key of ["platform", "domain", "start_url"] as const) {
    if (typeof parsed[key] !== "string" || !parsed[key]) problems.push(`нет ${key}`);
  }
  if (!parsed.selectors || typeof parsed.selectors !== "object") problems.push("нет selectors");
  else for (const key of REQUIRED_SELECTORS) {
    const value = parsed.selectors[key];
    if (typeof value !== "string" || !value) problems.push(`нет selectors.${key}`);
  }
  if (parsed.login_paths !== undefined && typeof parsed.login_paths !== "string") {
    problems.push("login_paths — строка путей через запятую");
  }
  if (problems.length) throw new Error(`профиль платформы неполон (${path}): ${problems.join(", ")}`);
  return parsed;
}
