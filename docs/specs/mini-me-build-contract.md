---
title: Mini Me build contract
summary: "Preimplementation scope, source ownership, decision contracts, milestones, and proof for the first Mini Me build."
read_when:
  - Preparing or authorizing the first Mini Me implementation
  - Assigning bounded source work without expanding scope
  - Reviewing Mini Me completion evidence or a requested scope change
---

# Mini Me build contract

Status: active isolated implementation, October 9, 2026. The owner adopted the
complete build brief and explicitly authorized fork-local schema, storage,
protocol and permission changes while upstream review is pending. No installed
runtime, live configuration, active-work restart, upstream merge or release is
authorized. This contract remains the scope and evidence gate; source completion
and genuine owner acceptance must be reported separately.

## Current implementation boundaries

The implementation follows this contract in an isolated fork. The user guide at
[Mini Me](/concepts/mini-me) describes the implemented controls and processing
limits; test evidence and owner acceptance remain separate qualifications.

- Management and onboarding are Control UI surfaces. Native clients do not yet
  have a Mini Me management screen.
- Automatic consultation runs at structured single-choice `ask_user` questions;
  the `mini_me` tool also lets an attached agent consult at other explicit choices.
- Delegated execution is limited to an exact existing text file in the embedded
  core runtime, under per-agent resource, expiry, action and byte limits. Plugin
  harnesses provide advice only. Message delivery, shell commands and spending
  have no delegated effect implementation in this build.
- Source data lives in canonical shared and per-agent SQLite stores. The six
  named files are revisioned projections. Inferred undo follows normalized
  supporting text per selected source across unrelated source revisions.
- Conversation ingestion commits bounded pages with durable progress; no
  background scan imports unselected conversations. Nightly Champion remains
  a separately scoped future design and has no runtime toggle or scheduler here.

The private agent has one host-written config binding,
`agents.entries.<agentId>.miniMe`, containing `ownerProfileId` and `profileId`. These
three schema paths identify the private agent before content admission; they
are not operator tuning options and grant no authority. Durable lifecycle and
permission state remains in the canonical databases. Setup and deletion own
the binding. The generated config baseline therefore grows by exactly three
core paths for this authorized schema addition; channel and plugin budgets do
not change. Upstream schema review remains required before landing.

## Decisions settled with the owner

- First-class, reusable Mini Me agent in OpenClaw source/runtime, attached to
  main/HQ or selected existing agents. The chosen personal name is configurable.
- Six inspectable/editable artifacts: SOUL, OPINIONS, PREFERENCES, MORALS, TASTE,
  DECISIONS.md. Keep the working assistant's persona independent.
- Automatically learn from selected sources, including inferred preferences;
  show history, correction and undo afterward. No per-learning-update approval.
- Explicit action permissions and limits for each attached agent. Four modes:
  Decide all, Decide auto, Decide safe, Don't decide. Prediction is never human
  approval; actual delegation is explicit and independently enforced.
- Welcome layout concept approved, with OpenClaw design-system styling required.
  Use existing UI tokens/components and verify the actual rendered states.
- **Build Mini Me first. Nightly Champion belongs to a later build.** No training
  service, schedule, model download, checkpoint store, trainer dependency,
  promotion mechanism or functional Champion toggle in this delivery.
- Latest owner direction authorizes a properly prepared eventual upstream
  contribution, with prompt disclosure checked against current project rules.
  Posting is a distinct stage, not a side effect of preparation. Installed core
  updates, live configuration changes and active-work restarts remain excluded.

## Scope that the build instruction will cover

The deliverable is a complete opt-in Mini Me path: create → connect selected
sources and agents → automatically learn → consult at relevant decisions →
recommend or act under a valid grant → observe genuine owner choices → correct/
undo → apply the changed understanding later → inspect/disable/delete.

One active Mini Me per canonical user is the initial product default. Several
host agents may attach to it with different limits; one host agent may serve
several users without mixing their Mini Mes. Multiple personality variants per
person, person-to-person sharing, public profiles and a profile marketplace are
excluded from this build. This default does not hardcode a person or agent ID.

Initial source adapters are manual input, the six named documents, and selected
private OpenClaw conversations. Setup chooses past-only import or an ongoing
subscription per conversation. No general filesystem crawl, email/social
connector ingestion, unselected transcript mining, or migration of existing
shadow data. Those require a later explicit scope change. Existing source access
is checked on every read, and removing a source revokes future reads immediately.

Core and UI changes must stay in the source ownership map below. A code fix in
an existing shared owner is allowed only when necessary for a listed requirement,
with its purpose and focused regression proof recorded. No adjacent refactor,
new provider framework, memory-engine replacement, or unrelated UI redesign.

## Behavior contracts to resolve before implementation

### Learning and undo

Use separate origin fields for direct statement, explicit correction, inferred
belief, reference material and genuine observed decision. Automatic inferred
updates can be active without review, but retain that origin and supporting
source revisions. Model output and selected reference material never become a
human decision merely because they are useful evidence.

Explicit scoped corrections outrank automatic inference. New inference cannot
silently rewrite the person's hard boundaries or grants. Contradictory sources
remain inspectable and reduce certainty. A changed belief produces a revision
and explanation in “What I learned”; earlier predictions keep their original
inputs and results.

Undo reverses the selected learning event and its derived influence. Store a
rejection/suppression bound to normalized supporting text for inferred learning
and the event revision for direct learning, so a replay cannot recreate it.
Later genuinely new evidence can be reconsidered, while an explicit owner
correction continues to win. Deleting a source removes dependent feature records
and caches. DECISIONS.md editing adds corrections without rewriting historical
predictions. Direct file edits and UI edits share the same revision protocol;
concurrent edits produce a recoverable conflict rather than lost work.

Automatic learning runs after an admitted source update settles, with bounded
work and cancellation. Feature-generated document projections, inference output
and their revisions cannot feed back into source ingestion. Only admitted
external source updates/edits trigger learning, retaining their original origin.
One inference must produce no recursive extraction job. It is independent of optional nightly training. Quiet
history updates replace repeated approval dialogs. The owner can pause learning
while continuing to consult already learned data; disabling Mini Me stops both.

### When attachment is consulted

Attach by canonical person + Mini Me ID + host agent ID + source scope + grant
revision. Resolve the person from an admitted host context, not the last person
who used the agent. Interactive runs inherit the actual requester. Owner-created
background runs may inherit a revocable owner-bound authorization; background
messages never count as genuine human learning outcomes.

Automatic consultation happens when the host prepares a structured choice or
an action covered by an attachment. Expose an explicit “Ask my Mini Me” path
for conversational choices. The common host admission layer enforces grants
regardless of whether a model voluntarily calls the consultation tool. Do not
claim every possible implicit thought is intercepted. Avoid extra inference for
ordinary turns with no relevant choice and prevent recursive consultations.

Every result includes choice/abstention, why the evidence applies, source
revisions, uncertainty, and whether a correction affected it. The result is
labeled as Mini Me output. Returned snippets are limited to the current owner's
allowed context, never broadcast to another participant or retained as a
shared agent's system instructions.

### Decision mode matrix

Initial semantics below are proposed engineering definitions of the approved
labels; freeze their examples with the build authorization rather than letting
individual implementations reinterpret them.

| Mode         | What may happen automatically                                                                          | When to ask                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Don't decide | Grounded recommendations only                                                                          | Before an action whose authority would come from Mini Me delegation                                             |
| Decide safe  | Granted actions classified by the host as low-impact and reversible, with a clear supported preference | Unknown effect/undo, conflicts, insufficient evidence, exceeded limits or missing scope                         |
| Decide auto  | Granted action classes that pass evidence/applicability and effect-policy criteria                     | Ambiguous choice, conflicting evidence, unqualified inference route or missing action permission                |
| Decide all   | Every supported choice/action within the expressly shown grant; uncertainty remains visible            | Missing required action details, out-of-scope effects, unsupported authority mapping or nondelegable human gate |

Keep uncertainty reporting independent of action authority. In all modes an
actual tool call is admitted by its existing owner. Changing a mode cannot
expand the underlying grant. Lowering a mode or revoking a permission takes
effect before any still-pending side effect, with action IDs preventing replay.
An effect already dispatched is reported with its real outcome; revocation is
not presented as having recalled it.

An action contract includes a registered effect type, exact target/resource,
parameters, scope/limit consumption, reversibility, pending-decision ID,
owner/agent, grant revision, expiry and idempotency key. Machine-enforceable
fields are required: a prose instruction such as “spend responsibly” is not a
budget. Reserve cumulative limits atomically across simultaneous agents.
Unknown result is not automatically retried as a new action.

Qualify existing typed actions individually. Local file edits require exact
workspace/path bounds; outbound messages require admitted destination/content
and channel policy. Monetary actions require a typed amount/currency and an
existing enforceable payment-tool owner before a budget can be offered.
Arbitrary shell commands cannot inherit those categories by text matching.
Unsupported actions remain unavailable for delegated execution and ask the
owner through the ordinary path. This build adds no payment/channel connectors
and never claims a budget is enforced merely because its UI has an input.

### Models, costs and failure behavior

Keep the conversational model separate from the decision model. Reuse the
existing Decision provider contract with Jev as the first integration candidate;
no mandatory Jev import/credential in core. The deterministic explicit-preference
baseline must complete the learning/correction acceptance with Jev absent.
No silent switch to a paid route or new provider destination. Learning extraction
also needs explicit destination consent; a local persona with a hosted decision
scorer is not presented as entirely local.

Suggested initial bounded defaults: eight options, 16 selected sources, and
32 KiB selected inference evidence. Only relevant slices enter a request. Set
an explicit per-consultation deadline and per-owner background queue limit from
a measured baseline before freezing the implementation packet. Timeout/error
shows unavailable or abstention and returns to ordinary owner choice. No
unbounded retries, unknown-provider fallback, queue growth or UI hang.

Disable must take the same ordinary runtime path as before Mini Me: no private
source reads, consultation/extraction calls, learning job, extra tools, active
document injection or altered decisions. A dismissed feature notice changes
only per-user announcement state. The feature is idle when unused.

## Data and protocol proposal

Proposed names below describe new source, not APIs already available. Generate
validators/types from the repository's canonical protocol schemas; no duplicate
renderer schema, direct renderer SQL, or prompt-only authorization.

| Interface group                        | Minimum contract                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `miniMe.get`, `create`, `configure`    | Self-scoped identity, consent, chosen model routes, revisions, strict unknown-field rejection; setup draft has no runtime effect            |
| `miniMe.sources.*`                     | Source access, preview, selection, past/future scope, ingestion cursor and revocation; never accepts unverified ownership from a body field |
| `miniMe.documents.*`, `learning.*`     | Six artifacts, conditional revision writes, origin/evidence, semantic changes, history, correct/undo and source-replay suppression          |
| `miniMe.attachments.*`, `delegation.*` | Target-agent access, mode, explicit structured grants/limits, current-owner validation and immediate revocation                             |
| `miniMe.predict`, `decisions.*`        | Stable options, frozen evidence, separate prediction/delegated/observed records, comparison and supported action admission                  |
| `miniMe.export`, `disable`, `delete`   | Owner-readable export, admission fence, joined cancellation and fresh-process deletion proof                                                |

Draft store ownership: existing shared state owns profile/agent registration,
attachment/grant metadata and authoritative consent/lifecycle generation;
the Mini Me agent database owns its document revisions and learned decision
records. Reuse existing agent provisioning/deletion lifecycle and tombstones.
No new dedicated database or JSON journal. A crash-consistent creation/deletion
protocol must prevent half-created agents, orphan private files and late writes
across the two owners. This placement is proposed until storage-owner review;
implementers cannot treat cross-database operations as one atomic transaction.

Each retained record needs an owner key, stable ID, origin, source revision,
creation time, applicable scope, active/superseded state and relevant generation.
Prediction includes the frozen model/rubric/evidence revisions. Deletion includes
projections, caches, temporary feature exports and pending jobs. Original source
material and user-downloaded exports stay outside feature-owned deletion.

## Storage and permission review packet

This is the concrete proposal for the repository review checkpoint, not a claim
of maintainer acceptance. Table names and numeric bounds below remain proposed
until that review. The product semantics above are already owner-directed.

| Proposed logical record             | Owning store and invariants                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile/lifecycle                   | Shared state; unique active Mini Me per canonical person; existing agent ID; enabled/learning-paused status; consent and data generations; creation/deletion state                        |
| Attachment                          | Shared state; unique person/Mini Me/target-agent tuple; allowed source scopes; effective mode; revision; revoked time                                                                     |
| Grant and limit reservation         | Existing authority owner with feature-specific data as required; exact effect/resource/agent scope, expiry, revision, atomic counters and action IDs; never credential-bearing model data |
| Source selection/cursor             | Mini Me agent data; source owner/access reference, past/future selection, imported revision/cursor, consent generation; revocation also closes shared-state admission                     |
| Document/evidence/learning revision | Mini Me agent data; canonical text and semantic records, direct/inferred origin, applicability, source lineage, parent/superseded revision, undo/suppression event                        |
| Prediction and outcomes             | Mini Me agent data; frozen options and evidence/model/rubric revisions; distinct delegated versus human outcomes; stable IDs and comparisons                                              |
| Projections                         | Named Markdown artifacts and UI caches; generation/revision labeled, reconstructible; stale files never provide alternate authority                                                       |

Indexes use owner/agent plus stable IDs and active/source/revision lookup keys.
No cross-person global content index is introduced. A record ID lookup always
includes owner and Mini Me identity. All writes use existing worker/writer-broker
owners; migrations follow existing state and agent schema admission.

Initial content bounds for review: 64 KiB per named document, 16 selected
sources, 32 KiB inference context, eight choice options, and 10,000 retained
learning/decision events per Mini Me before requesting owner-directed retention
or export. These are protective proposal defaults, not silent deletion policies
or advertised account quotas. Metadata/current explicit corrections and replay
suppression cannot be silently evicted. At a bound, pause the affected ingestion
and show remediation; continue to serve already admitted data where possible.

Creation proceeds through a durable preparing state, existing agent provisioning,
empty admitted owner store, initial source/model/grant review, and a final
activation transition. Only active profiles can be consulted. Idempotent replay
finishes or compensates an incomplete creation; canceled setup has no active
agent or source subscription. Provisioned artifacts from a failed create are
owned by the same lifecycle and cleaned up with a recorded outcome.

For disable/delete, close feature admission first, increment generation, cancel
owned work, join pending write-capable operations and revoke grants/subscriptions
before reporting success. Worker commit admission and output publication both
check the captured owner generation. Crash recovery sees disabling/deleting
state and resumes cleanup before admitting work. The acknowledgement means no
remaining feature-owned work can resurrect the profile. External data already
dispatched or actions already performed are reported separately, never recalled
by implication. A lost response is reconciled by operation ID, not repeated as
a new mutation.

Files are projections with durable revision metadata. UI saves apply conditional
writes. A selected external edit is ingested as an edit proposal/event with
provenance, then reconciled through the same owner; unknown file authors are not
upgraded to authenticated humans. Two simultaneous edits return a conflict with
both versions available. Owner-confirmed edits to historical decisions append
corrections; earlier prediction bytes remain immutable for evaluation.

Forward-only migrations add the admitted schema through its owner. Older builds
must refuse newer incompatible state; do not invent a destructive down-migration.
Qualification uses fresh isolated state plus a representative copied/synthetic
prior-schema database, migration replay and crash cases, existing preflight,
and restoration of an isolated backup. Live private state is not a test fixture
by default. Disabling a feature is not a schema rollback.

Alternatives considered: a prompt-only Mini Me cannot enforce owner isolation or
action grants; six independent Markdown stores lose conditional history and
concurrency; a separate JSON journal conflicts with source storage policy; a
plugin-only attachment does not satisfy the required first-class runtime scope.
Reuse existing canonical stores and provider/runtime owners, adding only
feature-specific records and explicit lifecycle integration.

The change impacts durable state, retained personal information, protocol and
authorization. Review must accept owner/store placement, limit/retention rules,
source deletion, two-store recovery and grant enforcement before those contracts
are implemented under the repository checkpoint. UI layout approval is not
storage approval. No contacts or public discussion are created by this packet.

## Bounded work packets and ownership

A single integration owner controls shared schemas, lifecycle and interface
changes. Before any later parallel work, each packet receives the same pinned
base, exact owned paths, public contract revision, tests, completion evidence
and stop conditions. Different workers do not independently edit shared owners.
Current planning creates no implementation workers or production services.

| Packet                        | Primary source owners / proposed files                                                                                                                                                       | Required exit evidence                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0: freeze contracts          | This document; `docs/specs/personal-adviser.md`; storage/runtime decision packet                                                                                                             | Requirement IDs, concrete action support list, run/harness matrix, bounded costs, retention/migration/recovery proposal and unresolved gates recorded |
| P1: identity and lifecycle    | `src/mini-me/` (new); `src/state/` owning schema/read/write/worker modules; existing agent provisioning                                                                                      | Atomic/recoverable opt-in; two-person partitioning; cancel, disable/delete and fresh-process readback                                                 |
| P2: protocol and admission    | `packages/gateway-protocol/src/schema/mini-me.ts` (new) and its exports; `src/gateway/server-methods/mini-me.ts` (new); methods registry/scopes; `users-profile-access.ts`                   | Strict request/result validation; live owner checks; ID spoofing denied; stale contexts fenced after awaits                                           |
| P3: learning and documents    | New Mini Me document/source/learning services; `workspace-bootstrap-policy.ts`, `workspace.ts`, `bootstrap-files.ts`, `system-prompt-context-files.ts` only for necessary scoped integration | Six real artifacts; auto-learning from selected sources; inference labeled; correction/undo survives replay and restart                               |
| P4: inference and comparisons | New Mini Me prediction/evidence/decision services; `src/decisions/`; `extensions/typesafe/` only for required adapter fixes                                                                  | Jev payload/source proof; baseline without Jev; frozen prediction compared to actual later human choice                                               |
| P5: attachment and authority  | `prepared-model-runtime*`, admitted run/harness owners, requester/tool policy; approval owner only if required                                                                               | Main and second agent consult correctly; four modes; grant limits, concurrency, expiry, revocation and human-approval boundary                        |
| P6: product UI                | New `ui/src/pages/mini-me/`; UI navigation/agent/profile owners, existing dialog/buttons/tokens and canonical English i18n                                                                   | Complete setup/home/files/sources/history/decision/permissions controls; actual rendered interaction and accessibility states                         |
| P7: integrated acceptance     | Focused feature/runtime/protocol/UI test owners and isolated development runtime                                                                                                             | Genuine owner loop; two users; attached/unattached agents; disabled baseline; restart persistence; rollback receipt                                   |

Paths containing wildcards above identify an owning family, not unrestricted
write permission. P0 must enumerate exact files before assignment. Stop a packet
when it needs a new shared seam, broader source access, an unsupported effect
class, or a changed product promise; report the concrete gap and continue
independent authorized work. Integration owner revises the contract before
resuming that dependent part. Do not paper over gaps with fixtures or broad grants.

## UI state inventory before coding screens

Use the approved welcome layout and native OpenClaw components. Prepare a small
state storyboard for the following groups; reuse components and native behavior
rather than producing an independently styled app.

| Surface              | States that must be designed and tested                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Announcement         | Eligible release; dismissed/seen per user; Set up; Maybe later; close; keyboard focus/escape; reopen from navigation                                   |
| Setup                | Name; model/destination; selected past/future sources; attachment selection; mode/permission review; create/cancel; validation/error recovery          |
| Mini Me home / HQ    | Empty profile; learned profile; attached to main and second agent; disconnected model; disabled; “ask Mini Me” and per-agent mode visibility           |
| Documents / learning | All six artifacts; direct versus inferred origin; edit conflict; new learning; undo; source deleted; export                                            |
| Decision             | Prediction/evidence/uncertainty; abstention; delegated choice; pending human approval; genuine outcome; mismatch; correction; later applied correction |
| Permissions          | Inherited limits; narrower agent override; unsupported actions; limit used up; revoke; in-flight action outcome                                        |
| Lifecycle            | Pause learning; detach; disable; delete confirmation; operation failure/unknown outcome; fresh reload after successful deletion                        |

Verify light/dark/custom tokens, keyboard navigation, focus return, readable
contrast, narrow viewport, long names/content, reduced motion, loading/error
states and i18n extraction. The first build omits the draft Champion control;
a mock toggle must not advertise training functionality that is deferred.

## Acceptance ledger

Each requirement gets a changed-source pointer, focused proof, and its remaining
integration/user evidence. “Passed” requires the stated level of proof, not just
a related unit test. Initial status of every row is unimplemented/unrun.

| ID    | Pass condition                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| MM-01 | Opt in and name a personal agent; cancellation/deferral preserves baseline behavior                                                                |
| MM-02 | All six documents are inspectable/editable and reach the correct Mini Me context                                                                   |
| MM-03 | Selected sources update automatically; unselected/inaccessible sources are never read                                                              |
| MM-04 | Inferred learning is labeled and undoable; explicit correction wins; replay cannot relearn undone evidence; generated projections do not feed back |
| MM-05 | Main/HQ and a second selected agent use the same person; unattached and other-person runs cannot                                                   |
| MM-06 | Grounded prediction cites actual selected evidence and reports uncertainty/abstention                                                              |
| MM-07 | A genuine later owner choice is compared to a frozen prediction; correction changes a subsequent comparable choice                                 |
| MM-08 | Four modes obey explicit per-agent grants; limits across concurrent work cannot be overspent                                                       |
| MM-09 | A fabricated/predicted approval grants no authority; real human approval remains separate                                                          |
| MM-10 | Two-user access/list/export/delete/source/cache isolation survives guessed IDs and forged profile fields                                           |
| MM-11 | Pause/detach/disable/delete fence in-flight work; restart cannot resurrect removed learning                                                        |
| MM-12 | Jev and provider-independent baseline both work; provider absence does not break base Mini Me                                                      |
| MM-13 | Complete real UI flow and state inventory; real rendered tokens, no mock feature controls                                                          |
| MM-14 | Supported runtime/harness matrix passes actual host admission paths, not only embedded-runner fixtures                                             |
| MM-15 | Disabled/unattached baseline has no extra source/model/action effects; enabled latency/queue/resource bounds measured                              |
| MM-16 | Reversible development install/migration preflight/rollback rehearsed in isolated state; live runtime untouched                                    |

The genuine-owner scenario is chosen by the owner during acceptance, not now
invented as their preference. Begin with a harmless choice. Capture an initial
prediction, an actual later decision/correction and a new comparable choice.
Also test a noncomparable choice so the correction is not applied everywhere.
Keep synthetic tests and observed human outcomes in distinct reports.

## Entry gates, review and release boundaries

Source base is pinned for planning. Before implementation, inspect upstream drift
once, choose and record the actual implementation commit, and reuse an isolated
worktree. Preserve other workers' paths. No auto-rebase against a moving main
throughout the build. Refresh installed/source compatibility separately before
any eventual local adoption.

P0 must complete a storage/lifecycle decision record identifying canonical data,
derived files, field bounds, retention, source removal, corruption handling,
concurrency, crash recovery, migrations, downgrade refusal and rollback. Complete
action support and harness parity matrices with the relevant existing owners.
These are engineering obligations, not more product questionnaires for the owner.
A local source prototype and upstream acceptance are separate milestones.

The repository's [material storage change checkpoint](/reference/database-schemas/storage-changes#review-checkpoint-for-material-changes)
requires maintainer discussion/acceptance before public-contract, schema,
retention or permission changes. This feature touches those contracts. Prepare
the concrete review packet locally. The latest owner direction permits relevant
upstream discussion/submission at the contribution stage, following its actual
requirements. Do not claim upstream acceptance merely from that permission: before the
relevant implementation, resolve either the required acceptance or an explicit
owner instruction governing a fork-local prototype under the existing session
instruction hierarchy. Upstream merge acceptance remains separate in either case.

At implementation authorization, freeze requirement IDs, exact file ownership,
model/provider test targets, first-build exclusions, mode/action examples, cost
bounds and acceptance evidence in a dated manifest. Changes to engineering
mechanics inside those contracts need no repeated approval. Changes to product
scope, data access, action authority, public contracts or deferred Champion work
require an explicit recorded scope decision. New ideas go to a later-build list.

The build completion receipt separates source/tests, isolated integration,
genuine UI/owner acceptance, local adoption and public release. Completing one
does not imply the others. Relevant upstream discussion/issue/PR submission is
now expressly authorized for the properly prepared contribution stage. At that
stage verify current contribution and AI prompt/session disclosure requirements;
preserve the actual kickoff and relevant steering without exposing secrets or
unrelated private material. Upstream merge, installed update, credential change,
unrelated owner messages, nightly jobs and active-work restarts remain outside
this scope. This preparation changes only design documents and receipts.
