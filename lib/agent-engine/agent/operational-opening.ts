import {
  assessOperationalEvidence,
  renderOperationalEvidence,
  type OperationalEvidence,
} from "@/lib/ai/fulfillment/evidence";

/** Dynamic data belongs in the user opening, never in the stable system policy. */
export function appendOperationalEvidence(
  opening: string,
  organizationId: string,
  evidence?: OperationalEvidence,
  now = new Date(),
): string {
  if (!evidence) return opening;
  const report = assessOperationalEvidence(evidence, { organizationId, sku: evidence.sku, now });
  return opening + "\n\n" + renderOperationalEvidence(report);
}
