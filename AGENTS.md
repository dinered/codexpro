Канон правил: http://gitlab.home.arpa/ai/mais (AGENTS.md там же).

## Договорённости с оператором

- ChatGPT в браузере под Playwright — только через выход `FOREIGN_STRICT`
  в Clash Verge (профиль ai/kvn-111). Chrome запускать с
  `--proxy-server=socks5://127.0.0.1:17891` (вход `foreign-shell` → группа
  `FOREIGN`); перед запуском проверить, что `FOREIGN` стоит на
  `FOREIGN_STRICT` (`/proxies/FOREIGN` в API mihomo, сокет
  `/tmp/verge/verge-mihomo.sock`), иначе не запускать. Источник:
  gitlab:ai/codexpro#2, оператор 2026-10-06 — «pw chrome chatgpt надо в
  strict-foreign».
