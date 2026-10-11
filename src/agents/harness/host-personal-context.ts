import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AdmittedRunContext } from "../admitted-run-context.js";
import type { EmbeddedRunTrigger } from "../run-trigger.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type PersonalContext = Readonly<{
  admittedRunContext: AdmittedRunContext;
  config?: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
  sessionKey?: string;
  trigger?: EmbeddedRunTrigger;
  assertCurrent(): void;
}>;

// Internal host custody only. Plugin attempt types intentionally omit admission;
// carrying their existing host handle cannot manufacture or relabel a source.
const contexts = new WeakMap<AgentHarnessHostCapabilities, PersonalContext>();

export function registerAgentHarnessPersonalContext(
  host: AgentHarnessHostCapabilities,
  context: PersonalContext,
): void {
  contexts.set(host, Object.freeze({ ...context }));
}

export function readAgentHarnessPersonalContext(host: AgentHarnessHostCapabilities) {
  const context = contexts.get(host);
  if (!context) {
    throw new Error("Personal context requires the original admitted host");
  }
  context.assertCurrent();
  return context;
}
