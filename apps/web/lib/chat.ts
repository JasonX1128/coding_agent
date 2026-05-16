import { AgentRunResponse, AgentToolStartEvent, AgentToolEvent } from "@coding-agent/shared";

export type ChatLiveToolEvent = AgentToolStartEvent & {
  result?: AgentToolEvent["result"];
  finishedAt?: number;
  durationMs?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  prompt?: string;
  result?: AgentRunResponse;
  toolEvents?: ChatLiveToolEvent[];
  createdAt: number;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
};

export const STORAGE_KEY = "coding-agent-chats";

export function loadChats(): ChatSession[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) : [];
}

export function saveChats(chats: ChatSession[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
}
