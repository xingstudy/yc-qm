import { marked } from "marked";

export type SetupContent = { type: "text"; text: string } | { type: "setup" | "slack" };

export function setupContent(text: string): SetupContent[] {
  const parts: SetupContent[] = [];
  for (const token of marked.lexer(text)) {
    if (token.type === "paragraph" && ["::connect-apps{}", "::add-to-slack{}"].includes(token.raw.trim())) {
      parts.push({ type: token.raw.trim() === "::add-to-slack{}" ? "slack" : "setup" });
    } else {
      const last = parts.at(-1);
      if (last?.type === "text") last.text += token.raw;
      else parts.push({ type: "text", text: token.raw });
    }
  }
  return parts;
}
