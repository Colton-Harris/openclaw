import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state as reactiveState } from "lit/decorators.js";
import type {
  MiniMeBelief,
  MiniMeDocumentName,
  MiniMeModels,
  MiniMeSourcesAvailableResult,
  MiniMeActionsResult,
} from "../../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import {
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsEmpty,
} from "../../components/settings-ui.ts";
import "../../components/modal-dialog.ts";
import "../../styles/settings.css";
import "../../styles/settings-controls.css";
import { t } from "../../i18n/index.ts";
import { registerMiniMeEnglish } from "../../i18n/locales/en-mini-me.ts";
import { miniMeController, type MiniMeController } from "../../lib/mini-me/controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderMiniMeDecisions, type ChoiceDraft } from "./decision-view.ts";
import { renderMiniMeDocuments, type DocumentDraft } from "./documents-view.ts";
import {
  beliefCorrectionDraft,
  choiceFromDraft,
  documentDraftsWithContent,
  documentDraftsWithout,
  grantFromDraft,
  outcomeCorrectionDraft,
  permissionDraftFor,
  rebasedDocumentDrafts,
} from "./draft-inputs.ts";
import { renderMiniMeHome } from "./home-view.ts";
import {
  renderMiniMeLearning,
  emptyPreferenceDraft,
  preferenceFromDraft,
} from "./learning-view.ts";
import { renderMiniMeLifecycle } from "./lifecycle-view.ts";
import {
  miniMeOperationTab,
  renderMiniMeConfirmation,
  renderMiniMeOperationStatus,
  type MiniMeConfirmation,
} from "./operation-view.ts";
import {
  downloadMiniMeBefore,
  exportMiniMeData,
  loadMiniMeActions,
  miniMeOptionsError,
  readMiniMeOptions,
} from "./page-reads.ts";
import { renderMiniMePermissions, emptyPermissionDraft } from "./permissions-view.ts";
import { captureMiniMeProfileRead } from "./profile-reads.ts";
import { renderMiniMeSetup, createMiniMeSetupDraft } from "./setup-view.ts";
import { renderMiniMeSources } from "./sources-view.ts";

registerMiniMeEnglish();
const TABS = [
  "home",
  "learning",
  "files",
  "sources",
  "choices",
  "permissions",
  "settings",
] as const;
export class MiniMePage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true }) private context!: ApplicationContext;
  @property({ attribute: false }) setupRequested = false;
  private setupRequestHandled = false;
  @reactiveState() private tab = "home";
  @reactiveState() private setupOpen = false;
  @reactiveState() private setupStep = 0;
  @reactiveState() private setup = createMiniMeSetupDraft();
  @reactiveState() private catalog: ModelCatalogResult | null = null;
  @reactiveState() private conversations: MiniMeSourcesAvailableResult["conversations"] = [];
  @reactiveState() private optionsError: string | null = null;
  @reactiveState() private localError: string | null = null;
  @reactiveState() private preference = emptyPreferenceDraft();
  @reactiveState() private documentName: MiniMeDocumentName = "SOUL.md";
  @reactiveState() private documents = new Map<MiniMeDocumentName, DocumentDraft>();
  @reactiveState() private conversation = "";
  @reactiveState() private ongoing = false;
  @reactiveState() private choice: ChoiceDraft = { scope: "", question: "", options: "" };
  @reactiveState() private outcomePrediction = "";
  @reactiveState() private outcomeOption = "";
  @reactiveState() private correctingOutcome = false;
  @reactiveState() private outcomeCorrection = emptyPreferenceDraft();
  @reactiveState() private actions: MiniMeActionsResult | null = null;
  private actionsGeneration = 0;
  @reactiveState() private permissions = emptyPermissionDraft();
  @reactiveState() private settingsName = "";
  @reactiveState() private settingsModels: MiniMeModels = {
    conversationModel: null,
    decisionModel: null,
    allowInference: false,
  };
  @reactiveState() private confirmation: MiniMeConfirmation | null = null;
  private controller: MiniMeController | null = null;
  private owner: string | null = null;
  private ownerGateway: string | null = null;
  private optionsGeneration = 0;

  constructor() {
    super();
    new SubscriptionsController(this).effect(
      () => this.context,
      (context) => {
        const controller = miniMeController(context);
        this.controller = controller;
        const stop = controller.subscribe(() => {
          const owner = controller.state.ownerKey;
          const gateway = context.gateway.connection.gatewayUrl;
          if (owner && (owner !== this.owner || gateway !== this.ownerGateway)) {
            this.resetDrafts();
            this.owner = owner;
            this.ownerGateway = gateway;
          }
          this.requestUpdate();
        });
        const agents = context.agents.subscribe(() => this.requestUpdate());
        return () => {
          stop();
          agents();
          this.optionsGeneration += 1;
          this.controller = null;
        };
      },
    );
  }
  protected override updated() {
    const snapshot = this.controller?.state.snapshot;
    if (snapshot && this.setupRequested && !this.setupRequestHandled) {
      this.setupRequestHandled = true;
      if (!snapshot.profile) {
        this.startSetup();
      }
    }
  }
  private resetDrafts() {
    this.actionsGeneration += 1;
    this.actions = null;
    this.optionsGeneration += 1;
    this.setupRequestHandled = false;
    this.setup = createMiniMeSetupDraft();
    this.setupOpen = false;
    this.setupStep = 0;
    this.catalog = null;
    this.conversations = [];
    this.preference = emptyPreferenceDraft();
    this.documents = new Map();
    this.conversation = "";
    this.ongoing = false;
    this.choice = { scope: "", question: "", options: "" };
    this.outcomePrediction = "";
    this.outcomeOption = "";
    this.correctingOutcome = false;
    this.outcomeCorrection = emptyPreferenceDraft();
    this.permissions = emptyPermissionDraft();
    this.settingsName = "";
    this.settingsModels = { conversationModel: null, decisionModel: null, allowInference: false };
    this.localError = null;
    this.optionsError = null;
    this.confirmation = null;
    this.tab = "home";
  }
  private async loadOptions() {
    const client = this.context.gateway.snapshot.client;
    const owner = this.context.gateway.snapshot.selfUser?.id;
    if (!client || !owner) {
      return;
    }
    const generation = ++this.optionsGeneration;
    this.optionsError = null;
    const results = await readMiniMeOptions(client, () => this.context.agents.ensureList());
    if (
      generation !== this.optionsGeneration ||
      this.context.gateway.snapshot.client !== client ||
      this.context.gateway.snapshot.selfUser?.id !== owner ||
      this.context.gateway.snapshot.phase !== "connected"
    ) {
      return;
    }
    if (results[1].status === "fulfilled") {
      this.catalog = results[1].value;
    }
    if (results[2].status === "fulfilled") {
      this.conversations = results[2].value.conversations;
    }
    this.optionsError = miniMeOptionsError(results) ?? this.optionsError;
  }
  private openTab(tab: string) {
    this.tab = tab;
    this.localError = null;
    if (["sources", "permissions", "settings"].includes(tab)) {
      void this.loadOptions();
    }
    const profile = this.controller?.state.snapshot?.profile;
    if (tab === "settings" && profile) {
      this.settingsName = profile.name;
      this.settingsModels = { ...profile.models };
    }
  }
  private startSetup() {
    this.setupOpen = true;
    void this.loadOptions();
  }
  private async create() {
    if (!this.controller || !this.setup.name.trim() || this.setup.name.trim().length > 80) {
      this.localError = t("miniMe.nameRequired");
      return;
    }
    if (
      await this.controller.mutate("miniMe.create", {
        ...this.setup,
        name: this.setup.name.trim(),
        operationId: this.controller.operationId(),
      })
    ) {
      this.setupOpen = false;
      this.tab = "learning";
      this.setup = createMiniMeSetupDraft();
    }
  }
  private async learn() {
    const preference = preferenceFromDraft(this.preference);
    if (!preference || !this.controller) {
      this.localError = t("miniMe.preferenceInvalid");
      return;
    }
    this.localError = null;
    if (
      await this.controller.mutate("miniMe.learn", {
        operationId: this.controller.operationId(),
        preference,
        ...(this.preference.corrects ? { corrects: this.preference.corrects } : {}),
      })
    ) {
      this.preference = emptyPreferenceDraft();
    }
  }
  private correct(belief: MiniMeBelief) {
    this.preference = beliefCorrectionDraft(belief);
  }
  private selectedDocument() {
    return this.controller?.state.snapshot?.documents.find(
      (item) => item.name === this.documentName,
    );
  }
  private changeDocument(content: string) {
    const file = this.selectedDocument();
    if (file) {
      this.documents = documentDraftsWithContent(this.documents, file, content);
    }
  }
  private async saveDocument() {
    const draft = this.documents.get(this.documentName),
      name = this.documentName,
      controller = this.controller;
    if (!draft || !controller) {
      return;
    }
    const saved = await controller.mutate("miniMe.document.set", {
      operationId: controller.operationId(),
      name,
      expectedRevision: draft.revision,
      content: draft.content,
    });
    if (saved) {
      this.documents = documentDraftsWithout(this.documents, name);
    } else if (this.controller === controller) {
      await controller.refresh();
    }
  }
  private rebaseDocument(discard: boolean) {
    const file = this.selectedDocument();
    if (file) {
      this.documents = rebasedDocumentDrafts(this.documents, file, discard);
    }
  }
  private async importExternalDocument() {
    const file = this.selectedDocument();
    if (!this.controller || !file?.external) {
      return;
    }
    await this.controller.mutate("miniMe.document.set", {
      operationId: this.controller.operationId(),
      name: file.name,
      expectedRevision: file.revision,
      content: file.external.content,
    });
    // Keep any unsaved draft. Its old revision now requires an explicit comparison
    // with the imported version before the owner can rebase and save it.
  }
  private async predict() {
    const choice = choiceFromDraft(this.choice);
    if (!this.controller || !choice) {
      this.localError = t("miniMe.choiceInvalid");
      return;
    }
    this.localError = null;
    await this.controller.predict({ operationId: this.controller.operationId(), choice });
  }
  private selectOutcome(predictionId: string, optionId: string) {
    this.outcomePrediction = predictionId;
    this.outcomeOption = optionId;
    this.correctingOutcome = false;
    const prediction = this.controller?.state.snapshot?.predictions.find(
      (item) => item.id === predictionId,
    );
    this.outcomeCorrection = outcomeCorrectionDraft(prediction, optionId);
  }
  private async recordOutcome() {
    if (!this.controller || !this.outcomePrediction || !this.outcomeOption) {
      return;
    }
    const correction = this.correctingOutcome
      ? preferenceFromDraft(this.outcomeCorrection)
      : undefined;
    if (correction === null) {
      this.localError = t("miniMe.preferenceInvalid");
      return;
    }
    if (
      await this.controller.mutate("miniMe.outcome", {
        operationId: this.controller.operationId(),
        predictionId: this.outcomePrediction,
        optionId: this.outcomeOption,
        ...(correction ? { correction } : {}),
      })
    ) {
      this.outcomePrediction = "";
      this.outcomeOption = "";
    }
  }
  private selectPermissions(agentId: string) {
    this.permissions = permissionDraftFor(this.controller?.state.snapshot, agentId);
  }
  private addGrant() {
    const grant = this.controller
      ? grantFromDraft(this.permissions.grant, this.controller.state.snapshot?.capabilities.effects)
      : null;
    if (!this.controller || !grant) {
      this.localError = t("miniMe.grantInvalid");
      return;
    }
    this.localError = null;
    this.permissions = {
      ...this.permissions,
      confirmed: false,
      grants: [...this.permissions.grants, { id: this.controller.operationId(), ...grant }],
      grant: emptyPermissionDraft().grant,
    };
  }
  private async savePermissions() {
    if (
      !this.controller ||
      !this.permissions.agentId ||
      (this.permissions.mode !== "dont-decide" && !this.permissions.confirmed)
    ) {
      return;
    }
    const { agentId, mode, revision, grants } = this.permissions;
    if (
      await this.controller.mutate("miniMe.attach", {
        operationId: this.controller.operationId(),
        agentId,
        mode,
        expectedRevision: revision,
        grants,
      })
    ) {
      this.selectPermissions(agentId);
    }
  }
  private async configure(patch: {
    enabled?: boolean;
    learningPaused?: boolean;
    name?: string;
    models?: MiniMeModels;
  }) {
    const profile = this.controller?.state.snapshot?.profile;
    if (!this.controller || !profile) {
      return;
    }
    await this.controller.mutate("miniMe.configure", {
      operationId: this.controller.operationId(),
      expectedRevision: profile.revision,
      ...patch,
    });
  }
  private readError = (error: string) => {
    this.localError = error;
  };
  private async exportData() {
    await exportMiniMeData(() => this.context.gateway.snapshot, this.readError);
  }
  private captureProfileRead() {
    return captureMiniMeProfileRead(
      () => this.context.gateway.snapshot,
      () => this.controller?.state.snapshot?.profile,
    );
  }
  private async loadActions(more: boolean) {
    const read = this.captureProfileRead();
    if (!read) {
      return;
    }
    const generation = ++this.actionsGeneration;
    const current = () => generation === this.actionsGeneration && read.current();
    await loadMiniMeActions({
      read,
      current,
      more,
      actions: () => this.actions,
      publish: (actions) => {
        this.actions = actions;
      },
      error: this.readError,
    });
  }
  private async downloadBefore(receiptId: string) {
    const read = this.captureProfileRead();
    if (!read) {
      return;
    }
    const generation = this.actionsGeneration;
    const current = () => generation === this.actionsGeneration && read.current();
    await downloadMiniMeBefore(read, current, receiptId, this.readError);
  }
  private renderBody() {
    const controller = this.controller,
      state = controller?.state;
    if (!controller || !state || !state.connected) {
      return renderSettingsEmpty(t("miniMe.offline"));
    }
    if (!state.identified) {
      return renderSettingsEmpty(t("miniMe.unidentified"));
    }
    if (!state.snapshot) {
      return html`<p role="status">${t(state.loading ? "miniMe.loading" : "miniMe.loadFailed")}</p>
        <button class="btn" @click=${() => controller.refresh()}>${t("miniMe.retry")}</button>`;
    }
    const snapshot = state.snapshot,
      profile = snapshot.profile;
    const busy =
      state.busy || !state.canWrite || (state.operationStatus !== null && !state.reviewOperation);
    const agents = this.context.agents.state.agentsList?.agents ?? [];
    if (!profile || profile.lifecycle === "deleted") {
      return this.setupOpen
        ? renderMiniMeSetup({
            draft: this.setup,
            step: this.setupStep,
            busy,
            catalog: this.catalog,
            agents,
            conversations: this.conversations,
            change: (draft) => {
              this.setup = draft;
            },
            stepChange: (step) => {
              this.setupStep = step;
            },
            create: () => void this.create(),
            cancel: () => {
              this.setupOpen = false;
              this.setup = createMiniMeSetupDraft();
              this.setupStep = 0;
            },
          })
        : html`${renderSettingsEmpty(t("miniMe.emptyDescription"))}<button
              class="btn primary"
              ?disabled=${busy}
              @click=${() => this.startSetup()}
            >
              ${t("miniMe.setup")}
            </button>`;
    }
    const content =
      this.tab === "learning"
        ? renderMiniMeLearning({
            snapshot,
            draft: this.preference,
            busy,
            change: (draft) => {
              this.preference = draft;
            },
            save: () => void this.learn(),
            cancel: () => {
              this.preference = emptyPreferenceDraft();
            },
            correct: (belief) => this.correct(belief),
            undo: (beliefId) =>
              void controller.mutate("miniMe.undo", {
                operationId: controller.operationId(),
                beliefId,
              }),
            more: () => void controller.loadMore(),
          })
        : this.tab === "files"
          ? renderMiniMeDocuments({
              snapshot,
              name: this.documentName,
              draft: this.documents.get(this.documentName),
              busy,
              select: (name) => {
                this.documentName = name;
              },
              change: (documentContent) => this.changeDocument(documentContent),
              save: () => void this.saveDocument(),
              reload: () => this.rebaseDocument(true),
              rebase: () => this.rebaseDocument(false),
              importExternal: () => void this.importExternalDocument(),
            })
          : this.tab === "sources"
            ? renderMiniMeSources({
                snapshot,
                available: this.conversations,
                busy,
                conversation: this.conversation,
                ongoing: this.ongoing,
                select: (value) => {
                  this.conversation = value;
                },
                setOngoing: (value) => {
                  this.ongoing = value;
                },
                add: (source) =>
                  void controller.mutate("miniMe.source.add", {
                    operationId: controller.operationId(),
                    source,
                  }),
                remove: (sourceId) => {
                  this.confirmation = {
                    title: t("miniMe.removeSource"),
                    description: t("miniMe.sourceRemoveConfirm"),
                    confirm: t("miniMe.removeSource"),
                    action: () =>
                      controller.mutate("miniMe.source.remove", {
                        operationId: controller.operationId(),
                        sourceId,
                      }),
                  };
                },
              })
            : this.tab === "choices"
              ? renderMiniMeDecisions({
                  snapshot,
                  draft: this.choice,
                  busy,
                  change: (draft) => {
                    this.choice = draft;
                  },
                  predict: () => void this.predict(),
                  predictionId: this.outcomePrediction,
                  optionId: this.outcomeOption,
                  correcting: this.correctingOutcome,
                  correction: this.outcomeCorrection,
                  selectOutcome: (prediction, option) => this.selectOutcome(prediction, option),
                  setCorrecting: (value) => {
                    this.correctingOutcome = value;
                  },
                  changeCorrection: (draft) => {
                    this.outcomeCorrection = draft;
                  },
                  record: () => void this.recordOutcome(),
                  more: () => void controller.loadMore(),
                  actions: this.actions,
                  loadActions: (more) => void this.loadActions(more),
                  downloadBefore: (id) => void this.downloadBefore(id),
                })
              : this.tab === "permissions"
                ? renderMiniMePermissions({
                    snapshot,
                    agents,
                    draft: this.permissions,
                    busy,
                    change: (draft) => {
                      this.permissions = draft;
                    },
                    select: (id) => this.selectPermissions(id),
                    addGrant: () => this.addGrant(),
                    save: () => void this.savePermissions(),
                    detach: (agentId) =>
                      void controller.mutate("miniMe.detach", {
                        operationId: controller.operationId(),
                        agentId,
                      }),
                  })
                : this.tab === "settings"
                  ? renderMiniMeLifecycle({
                      snapshot,
                      name: this.settingsName,
                      models: this.settingsModels,
                      catalog: this.catalog,
                      busy,
                      shutdownBusy: state.busy || !state.canWrite,
                      changeName: (name) => {
                        this.settingsName = name;
                      },
                      changeModels: (models) => {
                        this.settingsModels = models;
                      },
                      save: () =>
                        void this.configure({
                          name: this.settingsName.trim(),
                          models: this.settingsModels,
                        }),
                      pause: () => void this.configure({ learningPaused: !profile.learningPaused }),
                      toggle: () =>
                        void this.configure({ enabled: profile.lifecycle === "disabled" }),
                      export: () => void this.exportData(),
                      remove: () => {
                        this.confirmation = {
                          title: t("miniMe.deleteConfirm", { name: profile.name }),
                          description: t("miniMe.deleteDescription"),
                          confirm: t("miniMe.confirmDelete"),
                          action: () =>
                            controller.mutate("miniMe.delete", {
                              operationId: controller.operationId(),
                              expectedRevision: profile.revision,
                            }),
                        };
                      },
                    })
                  : renderMiniMeHome(snapshot, {
                      open: (tab) => this.openTab(tab),
                      agentName: (id) => agents.find((agent) => agent.id === id)?.name ?? id,
                      chat: () =>
                        this.context.navigate("new-session", {
                          search: `?agent=${encodeURIComponent(profile.agentId)}`,
                        }),
                    });
    return html`${renderHubTabs({ id: "mini-me", active: this.tab, tabs: TABS.map((tab) => ({ value: tab, label: t(`miniMe.${tab}`) })), ariaLabel: t("miniMe.title"), panelId: "mini-me-panel", onSelect: (tab) => this.openTab(tab) })}
      <div
        class="settings-stack"
        id="mini-me-panel"
        role="tabpanel"
        aria-labelledby=${`mini-me-tab-${this.tab}`}
      >
        ${content}
      </div>`;
  }
  private reviewOriginalOperation() {
    const controller = this.controller;
    const method = controller?.state.originalMethod;
    if (!controller || !method) {
      return;
    }
    controller.reviewOriginalInputs();
    if (method === "miniMe.create") {
      this.startSetup();
    } else {
      this.openTab(miniMeOperationTab(method));
    }
  }
  override render() {
    const error = this.localError ?? this.controller?.state.error ?? this.optionsError;
    const controller = this.controller;
    return html`${renderSettingsPageHeader({ title: controller?.state.snapshot?.profile?.name ?? t("miniMe.title"), subtitle: t("miniMe.subtitle") })}${renderSettingsPage(
      html`${controller?.state.identified && !controller.state.canWrite ? html`<p class="callout warn" role="status">${t("miniMe.readOnly")}</p>` : nothing}${error ? html`<p class="callout danger" role="alert">${error}</p>` : nothing}${
        controller?.state.operationStatus
          ? renderMiniMeOperationStatus({
              status: controller.state.operationStatus,
              busy: controller.state.busy,
              reviewOperation: controller.state.reviewOperation,
              needsOriginalInputs: controller.needsOriginalInputs,
              check: () => void this.controller?.checkOperation(),
              review: () => this.reviewOriginalOperation(),
              retry: () => void this.controller?.retryOperation(),
            })
          : nothing
      }${this.renderBody()}`,
    )}${
      this.confirmation
        ? renderMiniMeConfirmation({
            confirmation: this.confirmation,
            cancel: () => {
              this.confirmation = null;
            },
            confirm: () => {
              const action = this.confirmation?.action;
              this.confirmation = null;
              void action?.();
            },
          })
        : nothing
    }`;
  }
}
export const header = true;
export const render = (data: { setup: boolean } | undefined) =>
  html`<openclaw-mini-me-page .setupRequested=${data?.setup === true}></openclaw-mini-me-page>`;
if (!customElements.get("openclaw-mini-me-page")) {
  customElements.define("openclaw-mini-me-page", MiniMePage);
}
