import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  MINI_ME_DOCUMENT_NAMES,
  type MiniMeBelief,
  type MiniMeDocument,
  type MiniMeProfile,
  type MiniMePrediction,
  type MiniMeOutcome,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { enqueueWorkspaceFileUpdate } from "../gateway/server-methods/workspace-fs.js";
import { root, FsSafeError } from "../infra/fs-safe.js";
import { MINI_ME_LIMITS, miniMeEvidenceRevision } from "./learning.js";
import type { MiniMeContentStore } from "./service.types.js";

const HEADER = "<!-- openclaw-mini-me ";
const LEARNED = "\n<!-- openclaw-mini-me learned -->\n";
const END = "\n<!-- /openclaw-mini-me learned -->\n";

/** Delete private projections before ordinary agent cleanup can move a workspace to Trash. */
export async function removeMiniMeDocuments(input: {
  workspaceDir: string;
  assertCurrent(this: void): void;
}): Promise<void> {
  input.assertCurrent();
  let workspace;
  try {
    workspace = await root(input.workspaceDir);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return;
    }
    throw error;
  }
  input.assertCurrent();
  for (const name of MINI_ME_DOCUMENT_NAMES) {
    await enqueueWorkspaceFileUpdate(async () => {
      input.assertCurrent();
      await workspace.remove(name, {
        force: true,
        mutationSymlinks: "reject",
        assertBeforeMutation: input.assertCurrent,
      });
      input.assertCurrent();
    });
  }
}
type DocumentHeader = {
  version: 1;
  miniMeId: string;
  name: string;
  revision: number;
  authoredHash: string;
  learnedHash: string;
};

/** Only the authored portion is a selectable source. Generated evidence never learns from itself. */
export function renderMiniMeDocument(
  profile: MiniMeProfile,
  document: MiniMeDocument,
  beliefs: readonly MiniMeBelief[],
  decisions?: { predictions: readonly MiniMePrediction[]; outcomes: readonly MiniMeOutcome[] },
): string {
  const learnedBeliefs = beliefs
    .filter((belief) => belief.status === "active" && belief.preference.document === document.name)
    .map(
      (belief) =>
        `- [${belief.origin}; ${belief.preference.scope}; ${belief.id}] ${JSON.stringify(belief.preference.statement)}\n` +
        belief.evidence
          .map(
            (evidence) =>
              `  - Source ${evidence.sourceId}@${evidence.sourceRevision}: ${JSON.stringify(evidence.excerpt)}`,
          )
          .join("\n"),
    )
    .join("\n");
  const decisionHistory =
    document.name === "DECISIONS.md" && decisions
      ? decisions.predictions
          .toSorted((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
          .slice(0, 20)
          .toReversed()
          .map((prediction) => {
            const outcomes = decisions.outcomes.filter(
              (outcome) => outcome.predictionId === prediction.id,
            );
            return (
              `- Prediction ${prediction.id}: ${JSON.stringify(prediction.choice.question)}; predicted ${JSON.stringify(prediction.optionId)}; uncertainty ${prediction.uncertainty}; ${prediction.provider}.\n` +
              prediction.evidence
                .slice(0, 2)
                .map(
                  (evidence) =>
                    `  - Evidence excerpt ${evidence.sourceId}@${evidence.sourceRevision}: ${JSON.stringify(evidence.excerpt.slice(0, 240))}`,
                )
                .join("\n") +
              (outcomes.length
                ? "\n" +
                  outcomes
                    .map(
                      (outcome) =>
                        `  - ${outcome.origin === "owner" ? "Genuine owner decision" : "Delegated action"} ${outcome.id}: ${JSON.stringify(outcome.optionId)}; ${outcome.matched ? "matches" : "differs from"} the frozen prediction${outcome.correctionId ? `; correction ${outcome.correctionId}` : ""}.`,
                    )
                    .join("\n")
                : "\n  - Awaiting a genuine owner decision.")
            );
          })
          .join("\n")
      : "";
  const learned = [
    learnedBeliefs,
    decisionHistory
      ? "Recent frozen decisions (up to 20; full history is available in Mini Me):\n" +
        decisionHistory
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const header: DocumentHeader = {
    version: 1,
    miniMeId: profile.id,
    name: document.name,
    revision: document.revision,
    authoredHash: miniMeEvidenceRevision(document.content),
    learnedHash: miniMeEvidenceRevision(learned),
  };
  const output = `${HEADER}${JSON.stringify(header)} -->\n${document.content}${LEARNED}${learned}${END}`;
  if (Buffer.byteLength(output, "utf8") > MINI_ME_LIMITS.documentBytes) {
    throw new Error(
      `${document.name} exceeds its 64 KiB projection limit; narrow or remove learned material`,
    );
  }
  return output;
}

export function inspectMiniMeDocument(
  text: string,
  profile: MiniMeProfile,
  name: string,
): {
  authored: string;
  revision: number;
  authoredChanged: boolean;
} {
  if (Buffer.byteLength(text, "utf8") > MINI_ME_LIMITS.documentBytes || !text.startsWith(HEADER)) {
    throw new Error(
      `${name} has no Mini Me revision header; keep the file and review it before importing`,
    );
  }
  const boundary = text.indexOf(" -->\n");
  const generated = text.lastIndexOf(LEARNED);
  if (boundary < 0 || generated < boundary || !text.endsWith(END)) {
    throw new Error(`${name} has conflicting projection boundaries`);
  }
  const header: unknown = JSON.parse(text.slice(HEADER.length, boundary));
  const authored = text.slice(boundary + 5, generated);
  const learned = text.slice(generated + LEARNED.length, -END.length);
  if (
    !isRecord(header) ||
    header.version !== 1 ||
    header.miniMeId !== profile.id ||
    header.name !== name ||
    typeof header.revision !== "number" ||
    !Number.isSafeInteger(header.revision) ||
    header.revision < 0 ||
    header.learnedHash !== miniMeEvidenceRevision(learned)
  ) {
    throw new Error(`${name} has changed generated material or belongs to another revision owner`);
  }
  return {
    authored,
    revision: header.revision,
    authoredChanged: header.authoredHash !== miniMeEvidenceRevision(authored),
  };
}

export async function projectMiniMeDocuments(input: {
  ownerId: string;
  profile: MiniMeProfile;
  workspaceDir: string;
  store: MiniMeContentStore;
  assertCurrent(this: void): void;
}): Promise<void> {
  const scope = {
    ownerId: input.ownerId,
    miniMeId: input.profile.id,
    agentId: input.profile.agentId,
    generation: input.profile.generation,
  };
  const content = await input.store.readExport(scope);
  const workspace = await root(input.workspaceDir, { symlinks: "reject", hardlinks: "reject" });
  for (const name of MINI_ME_DOCUMENT_NAMES) {
    const document = content.documents.find((entry) => entry.name === name);
    if (!document) {
      throw new Error(`Mini Me document ${name} is missing`);
    }
    const output = renderMiniMeDocument(input.profile, document, content.beliefs, content);
    await enqueueWorkspaceFileUpdate(async () => {
      input.assertCurrent();
      let previous: string | undefined;
      try {
        previous = (
          await workspace.read(name, { maxBytes: MINI_ME_LIMITS.documentBytes })
        ).buffer.toString("utf8");
      } catch (error) {
        if (!(error instanceof FsSafeError) || error.code !== "not-found") {
          throw error;
        }
      }
      if (previous === output) {
        return;
      }
      if (previous !== undefined) {
        try {
          const observed = inspectMiniMeDocument(previous, input.profile, name);
          if (
            (observed.authoredChanged || observed.revision > document.revision) &&
            observed.authored !== document.content
          ) {
            throw new Error(
              `${name} has an external edit. Both versions are preserved; import or resolve that revision first`,
            );
          }
        } catch (error) {
          // Importing an unrecognized file is an explicit owner action. Only its
          // exact reviewed bytes may become the authored content of a new projection.
          if (previous !== document.content) {
            throw error;
          }
        }
      }
      input.assertCurrent();
      await workspace.write(name, output, {
        encoding: "utf8",
        renameIdentity: "strict",
        assertBeforeMutation: input.assertCurrent,
      });
    });
  }
}

/** Disk edits remain visible beside canonical revisions until the owner imports them. */
export async function inspectMiniMeDocuments(input: {
  profile: MiniMeProfile;
  workspaceDir: string;
  documents: MiniMeDocument[];
  assertCurrent(this: void): void;
}): Promise<MiniMeDocument[]> {
  input.assertCurrent();
  const workspace = await root(input.workspaceDir, { symlinks: "reject", hardlinks: "reject" });
  const documents: MiniMeDocument[] = [];
  for (const document of input.documents) {
    input.assertCurrent();
    let text: string;
    try {
      text = (
        await workspace.read(document.name, { maxBytes: MINI_ME_LIMITS.documentBytes })
      ).buffer.toString("utf8");
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "not-found") {
        documents.push(document);
        continue;
      }
      throw error;
    }
    input.assertCurrent();
    try {
      const observed = inspectMiniMeDocument(text, input.profile, document.name);
      documents.push(
        observed.authoredChanged || observed.revision > document.revision
          ? {
              ...document,
              external: { content: observed.authored, baseRevision: observed.revision },
            }
          : document,
      );
    } catch {
      documents.push({ ...document, external: { content: text, baseRevision: null } });
    }
  }
  input.assertCurrent();
  return documents;
}
