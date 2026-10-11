import { html, nothing } from "lit";
import type {
  MiniMeEffect,
  MiniMeGrant,
  MiniMeMode,
  MiniMeSnapshot,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { AgentsListResult } from "../../api/types.ts";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { inputField, textField, MINI_ME_MODES, modeLabel, modeDescription } from "./home-view.ts";
import { miniMeInputChecked, miniMeInputValue } from "./input-events.ts";
export type GrantDraft = {
  effect: MiniMeEffect;
  resources: string;
  maxActions: string;
  maxBytes: string;
  expires: string;
};
export function miniMeResourceLabel(resource: string): string {
  if (!resource.startsWith("workspace:")) {
    return resource;
  }
  try {
    const parts: unknown = JSON.parse(resource.slice("workspace:".length));
    if (
      Array.isArray(parts) &&
      parts.length === 2 &&
      parts.every((part) => typeof part === "string")
    ) {
      return parts[1] ?? resource;
    }
  } catch {
    /* Preserve unrecognized resources for inspection. */
  }
  return resource;
}
export type PermissionDraft = {
  agentId: string;
  mode: MiniMeMode;
  revision: number;
  grants: MiniMeGrant[];
  confirmed: boolean;
  grant: GrantDraft;
};
export function emptyPermissionDraft(): PermissionDraft {
  return {
    agentId: "",
    mode: "dont-decide",
    revision: 0,
    grants: [],
    confirmed: false,
    grant: { effect: "workspace.edit", resources: "", maxActions: "1", maxBytes: "", expires: "" },
  };
}
export function renderMiniMePermissions(params: {
  snapshot: MiniMeSnapshot;
  agents: AgentsListResult["agents"];
  draft: PermissionDraft;
  busy: boolean;
  change: (draft: PermissionDraft) => void;
  select: (id: string) => void;
  addGrant: () => void;
  save: () => void;
  detach: (id: string) => void;
}) {
  const { draft, change } = params;
  const updateGrant = (patch: Partial<GrantDraft>) =>
    change({ ...draft, grant: { ...draft.grant, ...patch }, confirmed: false });
  const attachment = params.snapshot.attachments.find((item) => item.agentId === draft.agentId);
  return html`<fieldset class="settings-fieldset settings-stack" ?disabled=${params.busy}>
    ${renderSettingsSection({ title: t("miniMe.permissions"), description: t("miniMe.agentsDescription") }, params.snapshot.attachments.length ? params.snapshot.attachments.map((item) => renderSettingsRow({ title: params.agents.find((agent) => agent.id === item.agentId)?.name ?? item.agentId, description: modeLabel(item.mode), control: html`<button class="btn" @click=${() => params.select(item.agentId)}>${t("miniMe.reviewPermissions")}</button><button class="btn" @click=${() => params.detach(item.agentId)}>${t("miniMe.detach")}</button>` })) : renderSettingsEmpty(t("miniMe.noAttachments")))}
    ${renderSettingsSection(
      { title: t("miniMe.reviewPermissions"), description: t("miniMe.grantDescription") },
      html`
        ${renderSettingsRow({
          title: t("miniMe.agent"),
          control: html`<select
            class="settings-select"
            aria-label=${t("miniMe.agent")}
            .value=${draft.agentId}
            @change=${(event: Event) => params.select(miniMeInputValue(event))}
          >
            <option value="" ?selected=${!draft.agentId}>${t("miniMe.attach")}</option>
            ${params.agents.filter((agent) => agent.id !== params.snapshot.profile?.agentId).map((agent) => html`<option value=${agent.id} ?selected=${draft.agentId === agent.id}>${agent.name ?? agent.identity?.name ?? agent.id}</option>`)}
          </select>`,
        })}
        ${
          draft.agentId
            ? html`
                ${renderSettingsRow({
                  title: t("miniMe.mode"),
                  description: modeDescription(draft.mode),
                  control: html`<select
                    class="settings-select"
                    aria-label=${t("miniMe.mode")}
                    .value=${draft.mode}
                    @change=${(event: Event) => {
                      const mode = MINI_ME_MODES.find((value) => value === miniMeInputValue(event));
                      if (mode) {
                        change({ ...draft, mode, confirmed: false });
                      }
                    }}
                  >
                    ${MINI_ME_MODES.map((mode) => html`<option value=${mode} ?selected=${draft.mode === mode}>${modeLabel(mode)}</option>`)}
                  </select>`,
                })}
                ${
                  draft.grants.length
                    ? draft.grants.map((grant) => {
                        const usage = attachment?.usage.find((item) => item.grantId === grant.id);
                        return renderSettingsRow({
                          title: t(
                            grant.effect === "workspace.edit"
                              ? "miniMe.editEffect"
                              : "miniMe.messageEffect",
                          ),
                          description: html`${grant.resources.map(miniMeResourceLabel).join(" · ")}<br />${t("miniMe.grantUsage", { used: String(usage?.consumed ?? 0), reserved: String(usage?.reserved ?? 0), limit: String(grant.maxActions) })}<br />${new Date(grant.expiresAt).toLocaleString()}`,
                          control: html`<button
                            class="btn"
                            @click=${() => change({ ...draft, grants: draft.grants.filter((item) => item.id !== grant.id), confirmed: false })}
                          >
                            ${t("miniMe.revoke")}
                          </button>`,
                        });
                      })
                    : renderSettingsRow({ title: t("miniMe.noGrants") })
                }
                ${params.snapshot.capabilities.effects.filter((item) => !item.available).map((item) => renderSettingsRow({ title: t(item.effect === "workspace.edit" ? "miniMe.editEffect" : "miniMe.messageEffect"), description: t("miniMe.unsupported", { reason: item.reason }) }))}
                ${
                  params.snapshot.capabilities.effects.some((item) => item.available)
                    ? html`
                        ${renderSettingsRow({
                          title: t("miniMe.effect"),
                          description: params.snapshot.capabilities.effects.find(
                            (item) => item.effect === draft.grant.effect && item.available,
                          )?.reason,
                          control: html`<select
                            class="settings-select"
                            aria-label=${t("miniMe.effect")}
                            .value=${draft.grant.effect}
                            @change=${(event: Event) => updateGrant({ effect: miniMeInputValue(event) === "message.send" ? "message.send" : "workspace.edit" })}
                          >
                            ${params.snapshot.capabilities.effects.filter((item) => item.available).map((item) => html`<option value=${item.effect} ?selected=${draft.grant.effect === item.effect}>${t(item.effect === "workspace.edit" ? "miniMe.editEffect" : "miniMe.messageEffect")}</option>`)}
                          </select>`,
                        })}
                        ${renderSettingsRow({ title: t("miniMe.resources"), description: t("miniMe.resourcesHelp"), stacked: true, control: textField(t("miniMe.resources"), draft.grant.resources, (resources) => updateGrant({ resources })) })}
                        ${renderSettingsRow({ title: t("miniMe.actionLimit"), control: inputField(t("miniMe.actionLimit"), draft.grant.maxActions, (maxActions) => updateGrant({ maxActions }), { type: "number" }) })}
                        ${renderSettingsRow({ title: t("miniMe.byteLimit"), control: inputField(t("miniMe.byteLimit"), draft.grant.maxBytes, (maxBytes) => updateGrant({ maxBytes }), { type: "number" }) })}
                        ${renderSettingsRow({ title: t("miniMe.expires"), control: inputField(t("miniMe.expires"), draft.grant.expires, (expires) => updateGrant({ expires }), { type: "datetime-local" }) })}
                        ${renderSettingsRow({ title: nothing, control: html`<button class="btn" @click=${params.addGrant}>${t("miniMe.addPermission")}</button>` })}
                      `
                    : nothing
                }
                ${renderSettingsRow({ title: t("miniMe.confirmPermissions"), description: t("miniMe.permissionDraft"), control: html`<input type="checkbox" aria-label=${t("miniMe.confirmPermissions")} .checked=${draft.confirmed} @change=${(event: Event) => change({ ...draft, confirmed: miniMeInputChecked(event) })} />` })}
                ${renderSettingsRow({ title: t("miniMe.authority"), control: html`<button class="btn primary" ?disabled=${!draft.confirmed && draft.mode !== "dont-decide"} @click=${params.save}>${t("miniMe.savePermissions")}</button>` })}
              `
            : nothing
        }
      `,
    )}
  </fieldset>`;
}
