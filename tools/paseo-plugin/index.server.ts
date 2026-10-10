import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCodexproProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createCodexproProvider());
  return () => {};
}
