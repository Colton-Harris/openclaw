---
summary: "Create a private, named agent that learns your preferences and advises your other agents"
title: "Mini Me"
read_when:
  - Setting up a personal Mini Me
  - Choosing sources, models, or decision permissions
  - Reviewing, correcting, or deleting learned preferences
---

# Mini Me

Mini Me represents your preferences, opinions, values, and taste. Give it a name
and attach it to your main agent and other agents you choose. Your working
agents keep their own personalities; Mini Me supplies your perspective when
there is a choice to make.

These instructions describe the development implementation. They do not imply
that Mini Me is available in an installed release.

## Set up

Open **Mini Me** in the Control UI sidebar, or choose **Set up** on the new-feature
notice. **Maybe later**, close, and canceled setup leave Mini Me unconfigured.
You can return through the sidebar later.

1. Name your Mini Me.
2. Choose model routes and whether it may infer preferences from selected text.
3. Select the sources it may learn from.
4. Attach your main agent and any other working agents you want.
5. Review the selections and create Mini Me. Attachments start in **Don't decide**.

Mini Me requires your authenticated personal profile. Each person's profile,
sources, files, learned preferences, and decisions remain separate. An agent
administrator role does not grant access to another person's Mini Me.

A conversation model is needed to chat with Mini Me or automatically extract
preferences. You can leave it unselected and use manually stated preferences
and corrections with the **Stated-preference matcher**. A separate
[Decision model](/concepts/decision-models), including Jev through TypeSafe AI,
is optional. The selected provider receives the evidence needed for its request;
a hosted model is not local processing. Mini Me does not silently choose a new
provider when a route fails.

## Sources and personal files

Choose among preferences you enter, Mini Me's six personal files, and eligible
private OpenClaw conversations. Conversation selection distinguishes **Import
past messages only** from **Learn from past and future messages**. Shared,
incognito, and other people's conversations are excluded.

| File             | Personal information                                    |
| ---------------- | ------------------------------------------------------- |
| `SOUL.md`        | Self-description and personality                        |
| `OPINIONS.md`    | Views and opinions                                      |
| `PREFERENCES.md` | Preferences for comparable choices                      |
| `MORALS.md`      | Values and personal principles                          |
| `TASTE.md`       | Style and aesthetic preferences                         |
| `DECISIONS.md`   | Frozen predictions, observed decisions, and corrections |

Edit authored text in **Personal files**. Saved revisions and source references
remain inspectable. When you edit a file outside OpenClaw, review and import that
edit in Mini Me before continuing. The generated sections are projections of
learned data; Mini Me does not feed its own generated profile back into learning.

You can also enter a general opinion or value in **What I learned** without
listing specific preferred or avoided choices.

With automatic inference enabled, selected text can create inferred preferences
without a review step. **What I learned** shows the statement, origin, supporting
evidence, and current status. Correct an inaccurate belief or undo it. Explicit
corrections take priority within the same topic. Undo suppresses re-adoption from
the same supporting text, including after unrelated edits to a source; new
source material may still support a new inference.
Removing a source removes its learned influence.

## Predictions and actual choices

In **Decisions**, supply a topic, a question, and distinct options. The topic
connects the choice to comparable preferences. Mini Me saves its prediction,
evidence revisions, uncertainty, and model route before you record your actual
choice. A later correction affects the next comparable prediction without
rewriting the earlier one.

Attached agents also have an **Ask my Mini Me** tool. Eligible single-select
`ask_user` questions consult Mini Me before showing the owner prompt. Advice is
labeled and does not select or submit an answer. Multi-select questions retain
the ordinary question flow. A prediction can abstain or show unavailable evidence;
a provider score is not measured prediction accuracy.

## Decision modes and permissions

Modes apply separately to each attached agent. Changing a mode does not create
a grant or bypass ordinary tool policy, human approval, or the current owner's
authority.

| Mode             | Delegated behavior                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **Don't decide** | Recommendations only                                                                                       |
| **Decide safe**  | Granted, supported actions with explicit evidence, low impact, and a saved recovery copy                   |
| **Decide auto**  | Granted, supported actions with applicable evidence and a qualified effect route                           |
| **Decide all**   | Supported actions within the displayed grant; required details, existing approvals, and limits still apply |

This implementation supports small edits to explicitly selected, existing text
files through the embedded core runtime. Each grant identifies exact workspace
paths, an expiry, an action limit, and a byte limit. Concurrent actions consume
limits atomically. Pending work rechecks revocation before its effect. An action
already dispatched is reported with its actual outcome.

Codex, Copilot, and AgentsAPI harnesses provide advice only. Native or remote
runtime effects, message sending, shell commands, and spending are unavailable
for Mini Me delegation. Ordinary actions authorized independently of Mini Me
continue through their existing policy.

**Saved file versions** lets you download the original bytes retained before a
delegated edit. Compare them with the current file before restoring in your
editor; later edits are not automatically overwritten. A saved copy alone does
not establish that an action completed. Delegated decisions are labeled
separately from actual human decisions, and a predicted approval never grants
authority.

## Control and removal

- **Pause learning** retains existing data and advice while stopping new inference.
- **Detach** removes Mini Me from the chosen working agent.
- **Disable** retains inspectable data while stopping active consultation, learning,
  private file injection, and delegation.
- **Export** downloads your retained Mini Me data.
- **Delete** removes feature-owned learned content and the six projections, revokes
  attachments, and deletes the private agent. Original selected conversations
  and exports you previously downloaded remain yours.

Deletion is logical deletion through the existing storage lifecycle, not a claim
of forensic erasure from backups or storage media.

## Processing bounds

Mini Me accepts up to 16 selected sources, six 64 KiB documents, and eight choice
options. Model extraction uses at most 32 KiB of source evidence per call, with a
30-second deadline and at most eight queued owner jobs. Selected conversations
import in pages of at most 100 entries and 256 KiB of raw transcript data.
Learning commits each page with its progress before continuing. Each admitted run
reads at most 66 pages per source. If more history remains, the source shows a
limit message; pause and resume learning to continue from saved progress.
Concurrent session updates can invalidate a source read. Mini Me may retry from
saved progress twice, with fresh private-source checks and the same owner
authority. A discarded model result may require another bounded model call.
Persistent failure leaves the source unavailable.

A single oversized entry shows a limit message; it is never silently skipped. Use a focused personal
file or a direct preference for oversized material.

Past-only import pins the history present when its first page is read. Ongoing
sources continue from their saved progress. A conversation reset or rewrite
restarts ongoing learning from currently visible history and shows that change;
messages removed before learning cannot be recovered from this source. An
unfinished past-only import asks you to reselect the changed conversation.

At the retained event limit of 10,000, affected ingestion stops with a visible
remediation message. Limits do not silently erase corrections. Errors leave
ordinary owner choice available and do not authorize fallback actions.

Nightly Champion and model training are separate future work. Mini Me setup
starts no training jobs or model downloads.
