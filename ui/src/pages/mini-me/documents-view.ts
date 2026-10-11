import { html, nothing } from "lit";
import type {
  MiniMeDocumentName,
  MiniMeSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import { renderSettingsRow, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { textField } from "./home-view.ts";
import { miniMeInputValue } from "./input-events.ts";
import { DOCUMENT_NAMES } from "./learning-view.ts";
export type DocumentDraft = { content: string; revision: number; original: string };
export function renderMiniMeDocuments(params: {
  snapshot: MiniMeSnapshot;
  name: MiniMeDocumentName;
  draft?: DocumentDraft;
  busy: boolean;
  select: (name: MiniMeDocumentName) => void;
  change: (content: string) => void;
  save: () => void;
  reload: () => void;
  rebase: () => void;
  importExternal: () => void;
}) {
  const file = params.snapshot.documents.find((document) => document.name === params.name);
  const draft = params.draft;
  const conflict = draft && file && draft.revision !== file.revision;
  return html`<fieldset class="settings-fieldset settings-stack" ?disabled=${params.busy}>
    ${renderSettingsSection(
      { title: t("miniMe.files"), description: t("miniMe.fileDescription") },
      html`
        ${renderSettingsRow({
          title: t("miniMe.document"),
          control: html`<select
            class="settings-select"
            aria-label=${t("miniMe.document")}
            .value=${params.name}
            @change=${(event: Event) => {
              const name = DOCUMENT_NAMES.find((value) => value === miniMeInputValue(event));
              if (name) {
                params.select(name);
              }
            }}
          >
            ${DOCUMENT_NAMES.map((name) => html`<option value=${name} ?selected=${params.name === name}>${name}</option>`)}
          </select>`,
        })}
        ${renderSettingsRow({ title: params.name, description: params.name === "DECISIONS.md" ? t("miniMe.decisionFileDescription") : file ? t("miniMe.fileRevision", { revision: String(file.revision) }) : undefined, stacked: true, control: textField(t("miniMe.fileContent", { name: params.name }), draft?.content ?? file?.content ?? "", params.change, 18) })}
        ${
          file?.external
            ? renderSettingsRow({
                title: t("miniMe.externalFile"),
                description:
                  file.external.baseRevision === null
                    ? t("miniMe.externalRawFile")
                    : t("miniMe.externalFileDescription", {
                        revision: String(file.external.baseRevision),
                      }),
                stacked: true,
                control: html`<div class="settings-stack" role="alert">
                  <details open>
                    <summary>${t("miniMe.externalVersion")}</summary>
                    <pre>${file.external.content}</pre>
                  </details>
                  <button class="btn" @click=${params.importExternal}>
                    ${t("miniMe.importExternal")}
                  </button>
                </div>`,
              })
            : nothing
        }
        ${
          conflict
            ? renderSettingsRow({
                title: t("miniMe.fileConflict"),
                stacked: true,
                control: html`<div role="alert">
                  <details>
                    <summary>${t("miniMe.currentVersion")}</summary>
                    <pre>${file.content}</pre>
                  </details>
                  <button class="btn" @click=${params.rebase}>${t("miniMe.keepDraft")}</button
                  ><button class="btn" @click=${params.reload}>${t("miniMe.discardDraft")}</button>
                </div>`,
              })
            : nothing
        }
        ${renderSettingsRow({ title: draft && draft.content !== draft.original ? t("miniMe.unsaved") : nothing, control: html`<button class="btn primary" ?disabled=${!draft || draft.content === draft.original || Boolean(conflict) || Boolean(file?.external)} @click=${params.save}>${t("miniMe.save")}</button>` })}
      `,
    )}
  </fieldset>`;
}
