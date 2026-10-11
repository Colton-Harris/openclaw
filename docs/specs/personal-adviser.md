---
title: Mini Me
summary: "Proposed first-class personal agent, delegated decision modes, and separately enabled local Nightly Champion training."
read_when:
  - Reviewing the Mini Me runtime and onboarding proposal
  - Implementing person-scoped preferences, agent attachments, or decision delegation
  - Evaluating optional local-model training without confusing prediction and authority
---

# Mini Me

Status: historical design proposal, October 8, 2026. The first implementation
is governed by the [build contract](/specs/mini-me-build-contract) and described
in the [user guide](/concepts/mini-me); the future-training sections below remain
excluded from that build. The earlier Personal Adviser
plugin scope is superseded. Approval of its welcome mockup was explicitly
withdrawn. The replacement welcome layout concept is approved, with an explicit requirement
to use OpenClaw’s design system. Final styling is a refinement of that approved
layout; this approval is not implementation or acceptance evidence. No feature code, training job, runtime
change, or release is delivered by this document. Source baseline:
`83421e15378489d0ba473a3cd653592bf424b3c0`. Installed behavior is separate;
upstream inclusion still requires maintainer discussion and review.

Mini Me is a named OpenClaw agent representing one person's preferences,
opinions, taste, personality, and values. It has its own workspace and model.
The person can attach it to their main agent/HQ and other selected agents so
those agents consult it while working. The assistant retains its own persona;
Mini Me supplies the owner's perspective with evidence and uncertainty.

This is a first-class source/runtime capability with visible setup, agent
attachments, policy, and management. Provider integrations remain replaceable.
The person's chosen name is presentation metadata, never an owner credential.
No specific person, model vendor, agent name, or fixed `main` binding is required.

**Current first-build scope: Mini Me only.** The owner explicitly deferred
Nightly Champion to a later build. No trainer, nightly job, champion promotion,
or functional training toggle belongs in the first build.

**Nightly Champion is a separate future feature.** It can attach only to a Mini Me
powered by a supported local model with a qualified training backend. It is
off by default and independently controlled. Mini Me's ordinary preference and
correction learning works with Champion off, including on hosted models.

## Complete product contract

1. Offer a dismissible new-feature announcement after the release that actually
   contains Mini Me. **Set up**, **Maybe later**, and close are available.
   Dismissal never creates an agent, imports data, changes prompts or models,
   delegates decisions, or schedules work. Keep a visible Mini Me navigation
   entry so discovery does not depend on a one-time modal.
2. Setup asks for a name, conversational model, selected preference/decision
   sources, and target agent attachments. Show data destinations and a review
   before **Create Mini Me**. Nothing is silently imported. Default decision
   mode is **Don't decide**; training is off. Canceled setup has no active effect.
3. Give Mini Me a dedicated agent identity and workspace with the six named
   documents below. Allow direct conversation and document inspection/editing.
   The owner can begin with one explicit preference; a long questionnaire is
   unnecessary.
4. Attached agents consult Mini Me at relevant choice points through a common
   runtime service, without requiring the person to paste instructions each
   time. Display the recommendation, why it applies, uncertainty, and whether
   a decision was made under an explicit delegation.
5. Automatically learn from owner-selected sources. Apply inferred updates with
   visible provenance and an inspectable, undoable change history; no per-update
   review gate. Explicit corrections take priority. Freeze predictions before
   subsequent genuine owner decisions, compare outcomes, and apply a correction
   to the next comparable choice without overnight training.
6. Provide source selection, evidence inspection, correction, export, detachment,
   disable, and delete. Show attachments and effective decision mode in HQ and
   the Mini Me home. Agent-specific settings can narrow the owner's default.
7. In a separately authorized later build, offer Nightly Champion when local
   training eligibility is verified.
   Its independent toggle, schedule, compute limits, run history, candidate
   evaluation, active champion, and rollback are visible in its own settings.

### Six editable documents

| Artifact         | Meaning                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `SOUL.md`        | The owner's described personality and perspective, as represented by Mini Me. Never overwrite the attached assistant's SOUL. |
| `OPINIONS.md`    | Stated views, their reasons, scope, dates, and revisions. Distinguish owner statements from tentative model inferences.      |
| `PREFERENCES.md` | How the owner likes choices made; conditions, exceptions, and confirmed corrections.                                         |
| `MORALS.md`      | Owner-stated values and boundaries. These constrain recommendations but cannot grant system or action authority.             |
| `TASTE.md`       | Chosen examples and actual reactions; distinguish confirmed taste from reference-only inspiration.                           |
| `DECISIONS.md`   | Inspectable choices, evidence, predictions, genuine outcomes, comparisons, and corrections from the decision ledger.         |

Use a feature-owned document service over revisioned SQLite records. The six
Markdown files are named, editable user artifacts rendered from those records;
they are not six competing databases. Supported editor saves or direct file
edits enter the same revision-checked reconciliation path. Preserve an external
edit as a draft on conflicts and show the diff; never silently overwrite it.
Only authenticated owner input makes an edit an explicit owner correction.
Model-derived updates from selected sources may take effect automatically, but
retain their inferred status and source lineage; they never become human claims. Edits to DECISIONS add a correction event, preserving
what the earlier prediction said. Version the parser and record the semantic diff. Preserve uncertainty for
ambiguous prose instead of silently making it an explicit owner instruction.
Agent tools do not bypass this path. Feature-generated projections and inferred
document revisions are not new learning input. Admit only actual selected source
updates or external edits, preserving their original provenance; one inference
must not trigger another inference by rereading its own output.

Load only an admitted snapshot of the right person's documents in Mini Me runs.
Current bootstrap recognizes AGENTS, SOUL, IDENTITY, USER, BOOTSTRAP, and MEMORY;
extra-file patterns do not admit the five new names. Implement scoped Mini Me
artifact loading explicitly, not a global bootstrap expansion for every agent.
Normal agents receive a bounded, labeled consultation result, not the complete
private profile or a replacement system prompt.

## Runtime attachment and decisions

An attachment binds canonical person, Mini Me agent ID, allowed target agent,
allowed source scopes, and effective delegation revision. One person can attach
the same Mini Me to several agents without copying or forking their personality.
Another person's use of the same host agent does not select this Mini Me.

Proposed runtime flow:

```text
Authenticated person + attached host agent + choice context
    -> validate attachment, selected sources, consent and current revisions
    -> Mini Me's own context: retrieve relevant profile evidence
    -> provider-neutral decision evaluation, including optional Jev
    -> freeze prediction + evidence + uncertainty
    -> host policy checks mode and actual owner delegation
    -> recommend, ask, or execute a permitted action through its existing owner
    -> separately admit a genuine owner decision and any confirmed correction
```

Register the consultation capability in the common runtime preparation seam and
carry authenticated subject/attachment context to supported harnesses. A
model-callable consultation tool is bounded to the current attached run;
configuration and mutation stay owner self-service. Do not rely solely on prompt
reminders. Action admission enforces mode/grant constraints even if a model
skips consultation. Before shipping a harness, prove it consumes the attachment
and preserves the same host authority checks; unsupported paths must visibly
remain advisory or unavailable, never imply runtime coverage they lack.

Consultation is request-bound and budgeted. No recursive Mini Me attachments,
self-spawn loops, hidden all-history reads, or mandatory extra inference on every
message. Missing evidence, unavailable providers, deadline expiry, or ambiguity
produce abstention/owner choice, not a silently authorized action. Disabling the
feature restores ordinary behavior; it must not introduce a permanent dependency
on a running Mini Me process. Already dispatched effects are reported accurately.

### Four decision modes

The labels below are the product direction. The initial operational definitions
are proposals to validate during implementation:

| Mode             | Behavior                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Don't decide** | Recommend and explain; the person makes the choice. No delegated execution from this feature.                                                                                                              |
| **Decide safe**  | Decide only within the owner's explicit grant for host-classified low-impact, reversible actions. Unknown risk or missing evidence asks the owner.                                                         |
| **Decide auto**  | Decide within the owner's explicit grant when evidence, allowed action class, and validated decision criteria support it; otherwise ask. A model confidence number alone is insufficient.                  |
| **Decide all**   | Delegate every supported decision within the scope the owner explicitly grants. The breadth of that grant is shown before enabling; outside it, ask. System policy and nondelegable approvals still apply. |

A mode alone is not an unlimited credential. Grant creation is a separate
owner-authenticated host-policy operation, containing subject, target agents,
permitted action classes/resources, limits, expiry where applicable, and a
revocable revision. Setup can present the mode and exact scope together. A
lower mode immediately narrows effective authority. Raising it cannot expand
scope without an owner-confirmed grant. Attached-agent overrides only narrow.
All effective permissions are intersected with requester, target-agent, tool,
sandbox, and live-run policy.

Keep three record types separate: **prediction**, **delegated decision**, and
**genuine owner decision**. Predictor output always has `authority: none`; no
executor, approval resolver, credential, or caller identity enters its context.
Reject provider extras such as `approved` or tool calls. A host service can make
a delegated decision only after independently checking an existing grant at the
action boundary. Attribute it to Mini Me under delegation, never to a human.
Existing approval paths requiring a real human remain pending; do not synthesize
an owner reply or resolve them from a prediction. Owner decision observations
also grant no action authority. Training cannot edit grants, modes, or tools.

## Owner data, correction, and isolation

For setup and owner edits, derive the subject from the live authenticated
requester via the canonical profile owner. Runtime consultation and automatic
learning carry a host-admitted owner context inherited from that person’s run
or an explicitly authorized owner-bound subscription; revalidate consent,
source access, and lifetime on every operation. A background process is not
a newly authenticated human. Never trust a body-supplied profile ID, display name, assignee,
agent name, recalled prompt, or provider output. Reuse the live connection and
profile preparation in `users-profile-access.ts`. Scheduled Champion work needs
a separate, revocable owner-created service authorization limited to training
on the approved dataset; it cannot impersonate an interactive owner operation.

Partition records, artifacts, caches, jobs, and checkpoint directories by
canonical person and Mini Me identity. Attachment grants determine which target
agents may consult, not which person owns the data. Only expose relevant evidence
in the authorized person's private run. No spill into shared chats, worker
prompts, another user's notifications, or telemetry. Record IDs never substitute
for authorization. Profile relink/merge suspends access pending source review;
shared credentials represent one principal, not isolated individual people.

Initial sources: owner-selected document/manual input, bounded private
conversation imports, and explicitly selected ongoing private conversation
subscriptions. Setup distinguishes one-time history from future-message learning,
shows a bounded preview and processing destination, and starts no unselected
subscription. Automatic learning uses only those admitted sources. Imported examples can ground
advice but cannot retroactively become prediction-accuracy evidence. Assistant,
tool, worker, scheduled, quoted, mixed-participant, and synthetic inputs are not
genuine owner decisions. Unattributed source material may be reference evidence only where explicitly
selected; it cannot become a verified owner statement or a genuine decision.
Do not automatically import root USER/MEMORY, contacts, or connector data.

Each preference has scope, conditions, exclusions, source/revision, and confirmed
or tentative status. Corrections supersede only the selected scope. Conflicting
applicable preferences, missing attributes, or expired evidence cause abstention.
Automatically inferred beliefs may inform recommendations but do not override
explicit statements, corrections, or grants. Undo creates a revocation with a
source/revision fence so the same evidence cannot immediately recreate the
rejected update. New conflicting evidence is visible and remains subordinate
to the explicit correction. Retain prediction
time, alternatives, chosen result or abstention, evidence revisions, provider,
model/rubric version, uncertainty, and later comparison as distinct events.

The minimum learning loop includes a deterministic explicit-preference matcher
as a provider-independent baseline. Show “Based on your stated preference” with
coverage and ambiguity instead of invented percentages. Model-backed choices
can handle richer context, but must cite the evidence actually supplied and
explain applicability without inventing a vendor rationale. Owner feedback
updates the selected context immediately. This is learning from corrections;
it is not a claim that model weights have been trained.

### Storage and lifecycle

Use the existing SQLite worker/writer-broker architecture with one feature owner;
ordinary access uses Kysely, not main-thread SQL or a new JSON journal. Proposed
Mini Me tables cover profiles/consent, attachments, documents/revisions,
evidence, predictions, observed decisions, corrections, and delegation links.
Champion owns separate job/dataset/checkpoint metadata. Review any schema changes
through the database-owner checkpoint before implementation. The core feature
must not misuse plugin-keyed storage or weaken local plugin trust admission.

Use conditional revisions and a consent/data-generation fence across all awaits,
egress, persistence, action admission, and response disclosure. Proposed initial
bounds: 16 selected sources, 8 alternatives per choice, 32 KiB of relevant
inference evidence, and explicit record/artifact retention limits established
before implementation. Reject over-budget work visibly; no silent loss of
correction lineage. Sensitive content remains sensitive when normalized/hashed.

Detach removes consultation access without deleting the owner's Mini Me. Disable
fences new learning, inference, delegated decisions, and attached training jobs;
retained data stays inspectable/deletable. Delete first revokes and fences, waits
for owned work to settle, then erases profile content, learned records, generated
files, feature caches, training datasets, and all affected candidate/champion
adapters. Remove data-dependent trained checkpoints when a contributing source
is deleted; weight-level forgetting is not established by deleting a row.
Switch to a clean approved base or suspend inference until one is available.
A minimal non-content generation tombstone can prevent late resurrection.

Report exclusions clearly: original source conversations/files, downloaded
exports, independently retained backups, and already dispatched provider data
are outside feature-local deletion. Do not claim external deletion without
provider proof. No automatic backup/export of learned data. API isolation is
within OpenClaw's trust boundary; host administrators or agents with general
filesystem access are not adversarial tenants. Separate hosts/Gateways are
needed when that stronger boundary is required.

## Jev integration without a mandatory dependency

Reuse `DecisionRuntimeV1` / `DecisionProviderV1`, typed result validation, and
provider lifecycle. Jev through the existing TypeSafe adapter can be the first
model-backed decision implementation inside Mini Me's runtime. Keep persona
inference, decision evaluation, and optional training as distinct roles. Jev
scores supplied state; DECISIONS.md exposes the feature-owned decision history.
No inspected Jev contract supplies persistent per-user learning or training.

Retain provider-neutral core, with Jev transport/credentials in the TypeSafe
extension. A different conforming Decision provider or the explicit-preference
baseline must complete the correction loop with TypeSafe absent. Consent binds
the real processing destination, including a hosted decision scorer attached to
a local conversational model. Changing that destination requires source/data
review before egress, not silent fallback or global agent model replacement.

The current Jev shadow is useful prior work, not this feature already built:

- `jev-memory-adviser/src/admission.js` and `policy.js`: reuse typed owner
  provenance, stable message identity, span validation, synthetic exclusions,
  and deduplication. Remove fixed single-owner/`main` assumptions in the new owner.
- `store.js`, `engine.js`, and `plugin.js`: reuse cancellation, bounded work,
  atomic admission, and diagnostic principles. Replace the private filesystem
  journal with the source-owned SQLite design; leave existing shadow data intact.
- `adapter.js`: reuse the Decision runtime integration. Existing shadow payloads
  are generic retention enums/booleans; they cannot express personalized choices.
  New semantic egress requires explicit new consent, not expansion in place.

Thirteen existing shadow tests passed in the earlier investigation. Synthetic
probes and genuine assertion-processing receipts establish those bounded paths,
not preference learning or prediction accuracy. Provider distributions are model
estimates, not empirical correctness probabilities. Upstream admission seams
must be tested on the actual target release; source availability is not deployment.

## Separate future Nightly Champion feature

This section preserves future design direction, not work authorized for the
first Mini Me build. Its implementation and acceptance are deferred.

Local inference alone is not training eligibility. Require verified local
execution, accessible compatible weights/adapters, a supported trainer, capacity,
and an owner-selected budget. A local URL proxying to a hosted model does not
qualify. Hosted-only, unsupported, or inference-only Mini Me models show why
Champion is unavailable. Changing to one suspends jobs and promotion. Never
silently download a new model, switch providers, or use cloud training.

Keep Champion off until explicit opt-in. Settings include local timezone/start
window, maximum run duration, memory/GPU allowance, disk budget/checkpoint
retention, and optional idle/AC-power conditions. Prefer the existing scheduler
owner with an independently cancellable job. Never preempt active user work to
meet a nightly target. Off cancels queued work and stops an active trainer safely;
it does not disable Mini Me or silently undo the current accepted champion.
Show active model/adapter and a separate rollback control.

Proposed lifecycle:

1. Freeze an owner-approved dataset snapshot of genuine decisions/corrections.
   Exclude synthetic probes, model predictions, delegated decisions, and test
   fixtures from owner ground truth. Group related choices before splitting to
   prevent paraphrase leakage. Preserve an untouched chronological holdout.
2. Train a candidate local adapter/checkpoint within the compute budget. Never
   train the active champion in place. Missing capacity, insufficient data, or
   failed training produces a visible skipped/failed run with no model change.
3. Compare candidate, current champion, and explicit-preference baseline on
   held-out comparable choices. Report numerator/denominator, coverage,
   abstentions, errors, uncertainty, and latency; do not promise improvement
   every night or fit thresholds after observing the test outcome.
4. Promote only under separately selected automatic-promotion policy or owner
   review, with predefined minimum evidence and nonregression checks. Keep the
   champion on ties/inconclusive evidence. Verify the exact model revision and
   consent generation before promotion; activate between affected Mini Me runs.
5. Save dataset lineage, trainer/version, evaluation, prior champion, and a tested
   rollback. Promotion changes only this person's Mini Me model, never an
   attached assistant's model or decision authority. Recheck eligibility each run.

No named Nightly Champion implementation or complete train/evaluate/promote
pipeline was found in the inspected OpenClaw owners. Ollama/LM Studio inference
support, local TypeSafe/Kev checkpoints, and ONNX checkpoint consumption do not
establish that pipeline. A trainer capability is new work. Select and qualify
one backend before advertising nightly weight training. The base Mini Me release
must remain independently usable while Champion is unavailable or off.

## Source plan and delivery sequence

The [build contract](/specs/mini-me-build-contract) owns implementation packets,
entry/exit evidence, scope-change rules, and remaining readiness gates. This
page remains the product and runtime behavior authority.

All `mini-me` and `nightly-champion` files below are proposed, not current APIs.

| Existing source owner                                                                                                            | Reuse / proposed change                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/zod-schema.agent-entry-base.ts`, `src/agents/agent-scope-config.ts`                                                  | Reuse named agent, separate workspace/model/decision role. Add owner-scoped Mini Me registration, not a special hardcoded agent.                                    |
| `src/agents/workspace-bootstrap-policy.ts`, `workspace.ts`, `bootstrap-files.ts`, `system-prompt-context-files.ts`               | Scoped loading of the six admitted artifacts into Mini Me only; preserve attached assistants' persona.                                                              |
| `src/agents/subagents/spawn/subagent-target-policy.ts`, `subagent-spawn-child-plan.ts`, `src/agents/tools/sessions-send-tool.ts` | Reuse separate target workspace and current transport policy. Attachment does not silently widen spawn or send allowlists.                                          |
| `src/agents/requester-tool-policy.ts`, `tool-policy-pipeline.ts`, `subagents/spawn/subagent-capabilities.ts`                     | Preserve effective policy intersections; add host-enforced attachment/delegation admission at the shared action boundary.                                           |
| `src/agents/prepared-model-runtime*`, harness preparation and prompt owners                                                      | Carry authenticated attachment context and bounded consultation capability across supported runtimes. Qualify harness parity explicitly.                            |
| `src/gateway/server-methods/users-profile-access.ts`, `users-personal-file.ts`                                                   | Reuse canonical live requester/original-person admission; personal USER endpoint is not a universal Mini Me store.                                                  |
| `src/gateway/server-methods/approval.ts`, `approval-request-authority.ts`                                                        | Keep human approval separate; validate actual delegation without converting predictions into approvals.                                                             |
| `src/decisions/{types,runtime,provider-host,validation}.ts`, `extensions/typesafe/src/{decisions,client,schema,transport}.ts`    | Existing neutral evaluation and optional Jev transport; no personal data store or training vendor dependency here.                                                  |
| New `src/mini-me/` plus gateway schemas/methods and schema-owner migrations                                                      | Own consent, documents, attachments, consultation, corrections, comparisons, lifecycle and isolation. Self-service `miniMe.*` RPC names are proposed vocabulary.    |
| `ui/src/pages/profile/profile-page.ts`, UI navigation/agent pages, `ui/src/styles/base.css`, i18n owners                         | New visible Mini Me home, HQ attachment indicator, setup/manage/decision surfaces and release notice; use the approved layout concept with native OpenClaw styling. |
| Existing automation owner plus new `src/nightly-champion/` and trainer adapters                                                  | Separate eligibility, schedules, compute admission, datasets, training, evaluation, promotion and rollback; no hidden Mini Me cron.                                 |

Implementation order:

1. Keep fork-local implementation authority separate from upstream acceptance.
   Follow the current maintainer discussion and storage/authority review route
   before presenting the change as an accepted upstream contribution. The latest
   task authorization governs when a discussion or submission may be posted.
2. Build isolated identity, consent, six-document revision service, attachments,
   and the genuine correction loop. Qualify Jev and a provider-independent path.
3. Integrate consultation and policy in supported runtime/harness paths. Prove
   all four decision modes, isolation, revocation, and real action attribution.
4. Implement the approved onboarding layout using OpenClaw design tokens and
   components, then complete visible onboarding,
   Mini Me home, HQ/agent controls, sources, corrections and deletion. Run genuine
   owner acceptance in the real UI. Keep unchanged deferral behavior verified.
5. Leave Nightly Champion for a separately authorized build, after a local trainer and held-out
   evaluation/promotion/rollback contract pass. Publish eligibility honestly.
6. Release announcement follows actual integrated availability, not this design
   or a local test branch. No active-work restart, core update, or release here.

## Verification and acceptance

The base acceptance is a real owner flow: opt in, supply a preference, receive a
grounded prediction, make a genuine later choice, confirm a correction, and see
that correction applied to a later comparable choice. Example only: prefer
mornings for routine meetings, later correct to afternoons, then verify a new
routine meeting uses the correction while focused-work preferences stay intact.
Freeze each prediction before its owner outcome; never manufacture owner input.
Reopen in a fresh process and inspect the evidence revisions actually consumed.

Required additional evidence:

- **Isolation:** two real authenticated test principals sharing a host agent;
  conflicting preferences remain separate. Test forged subject/record IDs,
  sources, paths, caches, notifications, artifacts, exports and deletion.
- **Attachments:** main/HQ and a second allowed agent consult the same profile;
  an unattached agent cannot. Another user's session cannot inherit it. Main
  persona/model remains unchanged. No recursive consultation.
- **Authority:** favorable/forged approval predictions cannot resolve human
  approvals or run an action without a grant. With a real grant, only the scoped
  action is allowed and attributed as delegated. Test each mode, revocation
  during awaits, narrowed target permissions, and nondelegable approval denial.
- **Learning:** explicit preferences outrank inferences; correction scope,
  exception handling, conflict abstention, immutable earlier predictions,
  external file-edit reconciliation, fresh-process persistence, and prevention
  of recursive learning from generated projections are verified.
- **Lifecycle:** race correction, detach, source removal, disable, deletion and
  model change against extraction, consultation and delegated actions; no late
  output, writes, cross-owner artifacts, duplicate action, or resurrection.
- **Provider neutrality:** complete the loop without TypeSafe; verify Jev's
  actual bounded payload and target-version cancellation/egress admission.
  Unknown accuracy is shown as unknown, never inferred from confidence.
- **Deferral:** Maybe later, close and canceled setup change only notice state;
  no learned state, private reads, agent creation, tools, prompts, schedules,
  provider/model configuration or workflow outcomes change.
- **Future Champion acceptance (excluded from the first build):** hosted/inference-only models are ineligible; off creates no
  training jobs. Supported local training respects budgets, genuine-only data
  and holdout separation. Failures/inconclusive comparisons retain the champion;
  promotion and rollback affect only the right Mini Me. Switching model or
  disabling fences in-flight training and promotion. Verify checkpoint isolation
  and deletion of affected model lineage when a contributing source is removed.
  Ordinary corrections work with training off.

Use focused owner/service/policy tests, real provider contract checks where used,
and a separate genuine UI acceptance receipt. Fixtures establish mechanisms,
not human accuracy. Prospective accuracy reports must include comparable-choice
counts, abstention/coverage and baselines, exclude synthetic/retrospective/
delegated decisions, and separate owners who saw the advice from blind holdouts.
One applied correction demonstrates feedback application, not general accuracy.
No Mini Me or Champion acceptance has run at the design stage.

Official contracts: [Agent workspace](/concepts/agent-workspace),
[Decision models](/concepts/decision-models), [TypeSafe](/plugins/typesafe),
[User model](/concepts/user-model), [Multi-user](/concepts/multi-user),
[Security](/gateway/security), and [Runtime models](/plugins/sdk-runtime/models).
