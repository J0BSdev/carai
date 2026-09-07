import type { SourceRef } from "./types";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  authority?: SourceRef["authority"];
}

/**
 * Abstraction for later LLM tool-calling.
 * Mock engine does not call this; LlmDiagnosticEngine will.
 */
export interface WebSearchTool {
  search(query: string): Promise<WebSearchResult[]>;
}

/** No-op stub — never used in this milestone. */
export class NoopWebSearchTool implements WebSearchTool {
  async search(query: string): Promise<WebSearchResult[]> {
    void query;
    return [];
  }
}
