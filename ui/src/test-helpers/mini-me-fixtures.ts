import type { MiniMeSnapshot } from "../../../packages/gateway-protocol/src/schema/mini-me.js";

export const empty: MiniMeSnapshot = {
  profile: null,
  contentRevision: 0,
  documents: [],
  sources: [],
  beliefs: [],
  predictions: [],
  outcomes: [],
  attachments: [],
  historyCursor: null,
  capabilities: {
    effects: [
      { effect: "workspace.edit", available: true, reason: "" },
      { effect: "message.send", available: false, reason: "No qualified sender" },
    ],
    maxSources: 16,
    maxDocumentBytes: 65536,
    maxOptions: 8,
  },
};
export const active: MiniMeSnapshot = {
  ...empty,
  profile: {
    id: "mini-preview",
    agentId: "mini-preview-agent",
    name: "Preview Me",
    lifecycle: "active",
    learningPaused: false,
    generation: 1,
    revision: 1,
    models: { conversationModel: "local/preview", decisionModel: null, allowInference: false },
    createdAt: 1000,
    updatedAt: 1000,
  },
  documents: [
    {
      name: "SOUL.md",
      content: "An explicitly synthetic UI fixture.",
      revision: 1,
      updatedAt: 1000,
    },
    { name: "OPINIONS.md", content: "", revision: 1, updatedAt: 1000 },
    { name: "PREFERENCES.md", content: "", revision: 1, updatedAt: 1000 },
    { name: "MORALS.md", content: "", revision: 1, updatedAt: 1000 },
    { name: "TASTE.md", content: "", revision: 1, updatedAt: 1000 },
    { name: "DECISIONS.md", content: "", revision: 1, updatedAt: 1000 },
  ],
  sources: [
    {
      id: "manual-1",
      selection: { kind: "manual", label: "Preferences you enter" },
      revision: 1,
      status: "ready",
      lastIngestedAt: null,
      detail: null,
    },
  ],
};
export const presenceUsers = [
  {
    self: true,
    id: "profile-preview",
    name: "Preview Owner",
    identity: { type: "profile" as const, id: "profile-preview" },
  },
];
export const baseResponses = {
  "miniMe.sources.available": {
    conversations: [
      {
        sessionKey: "agent:main:private-preview",
        title: "Private preview conversation",
        agentId: "main",
        updatedAt: 1000,
      },
    ],
  },
  "users.prefs.set": { status: "ok" },
  "agents.list": {
    agents: [
      { id: "main", name: "Main" },
      { id: "reviewer", name: "Reviewer" },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  },
};
